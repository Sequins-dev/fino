//! Native per-thread reactor engine.
//!
//! A reactor thread hosts N tenant isolates and pumps them in priority order,
//! owning the scheduling loop that used to live in `js/internal/scheduler/shard.ts`.
//! It replaces the TS `ShardScheduler`: instead of a thread realm running JS that
//! calls `dispatchWorkload` once per slice, the reactor loop drives
//! `scheduler_native::pump_native` directly and classifies outcomes natively —
//! no per-slice `internal:serializer` round trip.
//!
//! The orchestrator (main thread, TS) drives a pool of these threads through a
//! cross-thread control/report channel (mpsc + wake pipe, mirroring
//! `src/realm/thread.rs`). Control: place / wake / revoke / drain / shutdown.
//! Reports: released / sync-heavy / load / drained.
//!
//! Isolate-tagged direct I/O (replacing the facade) layers on top of this loop —
//! see `reactor/io.rs` — so a parked isolate's reactor I/O completions mark it
//! runnable here. This module owns the execution + scheduling half.

use std::os::fd::RawFd;
use std::sync::mpsc;
use std::thread::JoinHandle;

use crate::state::{ImportDirective, ImportPattern, ImportRule, ProcessEnv, default_import_rules};

/// Per-thread reactor configuration (all cold-path, set at spawn).
#[derive(Clone)]
pub struct ReactorConfig {
    /// Hard runaway budget per synchronous pump slice (µs, 0 = disabled).
    pub hard_budget_micros: u64,
    /// A synchronous slice over this (µs) flags the workload sync-heavy once.
    pub sync_slice_micros: u64,
    /// Per-tenant old-generation heap cap (bytes, 0 = default 1 GiB).
    pub heap_limit_bytes: usize,
    /// Process env shared by tenant isolates on this thread.
    pub process_env: ProcessEnv,
    /// Package map JSON shared by tenant isolates on this thread.
    pub package_map_json: Option<String>,
}

/// Import rules for a direct-I/O tenant isolate: block `fino:*` for the entry,
/// but let builtins (`internal:*`/`fino:*` importers and the bootstrap) import
/// `fino:*` so the runtime stitches itself together. Unlike the facade rules, it
/// does NOT remap `fino:file` — tenant I/O bottoms out in the reactor directly
/// (isolate-tagged `internal:io`), enforced by the OS sandbox + open()-capability.
pub(crate) fn tenant_import_rules() -> Vec<ImportRule> {
    let mut rules = default_import_rules();
    rules.push(ImportRule {
        from: None,
        pattern: ImportPattern::Prefix("fino:".to_string()),
        directive: ImportDirective::Block,
    });
    rules.push(ImportRule {
        from: Some(ImportPattern::Prefix("internal:".to_string())),
        pattern: ImportPattern::Prefix("fino:".to_string()),
        directive: ImportDirective::Inherit,
    });
    rules.push(ImportRule {
        from: Some(ImportPattern::Prefix("fino:".to_string())),
        pattern: ImportPattern::Prefix("fino:".to_string()),
        directive: ImportDirective::Inherit,
    });
    rules.push(ImportRule {
        from: Some(ImportPattern::Exact("internal/bootstrap.mjs".to_string())),
        pattern: ImportPattern::Prefix("fino:".to_string()),
        directive: ImportDirective::Inherit,
    });
    // Grant the tenant entry direct file + network capability (the facade path
    // remapped these away; direct I/O grants them, enforced by the OS sandbox +
    // open()-time capability). Exact/prefix rules pushed after the fino:* block
    // win under last-match-wins.
    rules.push(ImportRule {
        from: None,
        pattern: ImportPattern::Exact("fino:file".to_string()),
        directive: ImportDirective::Inherit,
    });
    rules.push(ImportRule {
        from: None,
        pattern: ImportPattern::Prefix("fino:net".to_string()),
        directive: ImportDirective::Inherit,
    });
    // Route all tenant I/O through the reactor: remap the event loop to the
    // reactor-backed drop-in, so fino:file/fino:net readiness + fused read/write
    // register with this engine thread (isolate-tagged) rather than a JS loop the
    // engine never drives.
    rules.push(ImportRule {
        from: None,
        pattern: ImportPattern::Exact("internal:runtime/loop".to_string()),
        directive: ImportDirective::Remap {
            target: "fino:net/loop-reactor".to_string(),
        },
    });
    rules
}

/// A tenant wake delivered by the orchestrator (why the workload should run).
/// `reason`/`source_id` carry wake identity for coalescing/consumption — used by
/// the wake-ordering path landing with direct I/O; retained now to keep the
/// control wire shape stable.
#[derive(Clone)]
#[allow(dead_code)]
pub struct Wake {
    pub reason: String,
    pub source_id: String,
}

/// Control messages: orchestrator (main thread) → reactor thread.
#[allow(dead_code)] // `wake` payloads are consumed by the wake-ordering path (direct-I/O increment)
pub enum Control {
    /// Create + place a tenant isolate on this thread and mark it runnable.
    Place {
        workload_id: u64,
        entry_path: String,
        /// The tenant `request.data` payload as JSON (passed to the entry fn).
        data_json: String,
        /// Priority class: 0 interactive, 1 service, 2 background.
        priority_class: u8,
        wake: Wake,
        /// A migration snapshot (mailbox JSON) handed to the first activation as
        /// `request.handoff`, or `None` for a fresh placement.
        handoff_json: Option<String>,
    },
    /// Deliver a wake to an already-placed workload (marks it runnable).
    Wake { workload_id: u64, wake: Wake },
    /// Terminate + release a workload.
    Revoke { workload_id: u64, reason: String },
    /// Drain a workload to quiescence and hand its snapshot back (migration).
    Drain { workload_id: u64 },
    /// Stop the reactor loop and dispose all hosted isolates.
    Shutdown,
}

/// Report messages: reactor thread → orchestrator (main thread).
#[allow(dead_code)] // `snapshot` carries the migration payload (migration v2)
pub enum Report {
    /// A workload reached a terminal state (settled terminal / rejected / revoked).
    Released { workload_id: u64, reason: String },
    /// A synchronous slice exceeded the soft threshold — migrate to a batch thread.
    SyncHeavy { workload_id: u64, cpu_micros: f64 },
    /// Coarse load signature changed (held : runnable : debt-band).
    Load {
        held: u32,
        runnable: u32,
        debt_band: u32,
    },
    /// A drain completed; the snapshot bytes carry the migrated mailbox/state.
    Drained { workload_id: u64, snapshot: Vec<u8> },
}

/// Orchestrator-side handle to a spawned reactor thread. `join` is held for the
/// thread's lifetime (dropping it would detach the thread).
#[allow(dead_code)]
pub struct ReactorHandle {
    pub control_tx: mpsc::Sender<Control>,
    /// Written (1 byte) after a control send to break the reactor's poll block.
    pub control_wake_write: RawFd,
    pub report_rx: mpsc::Receiver<Report>,
    /// Read end the orchestrator registers on its own loop; readable when a
    /// report is queued.
    pub report_wake_read: RawFd,
    pub join: JoinHandle<()>,
}

// ===========================================================================
// Engine-mode direct I/O registration.
//
// When a tenant runs on a reactor thread, its `internal:io` readAsync/writeAsync
// ops (on a would-block) register here instead of on the per-thread inline
// reactor. The reactor thread drains these after each pump and submits them to
// its completion `Poller` (io_uring performs the transfer in-kernel; the kqueue
// backend synthesizes it on readiness), then resolves the tenant's promise
// during the tenant's next pump (isolate entered).
//
// The buffer is realm-provided (the tenant's ArrayBuffer) — the reactor never
// allocates the data buffer, only the small fixed-shape registration record.
// ===========================================================================

/// What a fd-keyed reactor op does on readiness.
pub(crate) enum IoKind {
    /// Fused read: perform `read(2)` into `buf` off-isolate, resolve byte count.
    Read,
    /// Fused write: drain the remaining bytes of `buf`, resolve total written.
    Write,
    /// Bare readiness: resolve with the bytes-available hint (no syscall).
    Readable,
    /// Bare write-readiness: resolve (value ignored).
    Writable,
}

/// One outstanding fd-keyed reactor op registered by a tenant during a pump.
pub(crate) struct PendingIoReg {
    pub fd: i32,
    pub kind: IoKind,
    pub resolver_id: usize,
    /// Retains the realm-provided buffer (fused ops) so the GC can't collect it
    /// mid-flight. Held for its `Drop` (RAII liveness), never read directly.
    #[allow(dead_code)]
    pub buffer: Option<v8::Global<v8::ArrayBuffer>>,
    /// Stable backing-store pointer at the op's byte offset (null for readiness).
    pub buf_ptr: *mut u8,
    pub len: usize,
    /// For a partial write already drained on the fast path, resume from here.
    pub written: usize,
}

/// A registration a tenant hands the engine during a pump.
pub(crate) enum EngineReg {
    Io(PendingIoReg),
    Timer {
        timer_id: u64,
        ms: i64,
        resolver_id: usize,
    },
    CancelTimer {
        timer_id: u64,
    },
}

thread_local! {
    /// `Some` only on a reactor engine thread; tenants push registrations here
    /// during a pump, and the engine drains them right after.
    static ENGINE_IO: RefCell<Option<Vec<EngineReg>>> = const { RefCell::new(None) };
    /// Monotonic timer id source for engine-mode timers.
    static ENGINE_TIMER_SEQ: RefCell<u64> = const { RefCell::new(1) };
}

/// Whether the current thread is a reactor engine thread (so `internal:io` ops
/// register with the engine rather than the inline per-thread reactor).
pub(crate) fn engine_io_active() -> bool {
    ENGINE_IO.with(|c| c.borrow().is_some())
}

/// Register an outstanding reactor op (called from an `internal:io` op during a
/// pump). The engine picks it up after the pump.
pub(crate) fn engine_io_register(reg: EngineReg) {
    ENGINE_IO.with(|c| {
        if let Some(v) = c.borrow_mut().as_mut() {
            v.push(reg);
        }
    });
}

/// Allocate a fresh engine-mode timer id.
pub(crate) fn engine_next_timer_id() -> u64 {
    ENGINE_TIMER_SEQ.with(|c| {
        let mut v = c.borrow_mut();
        let id = *v;
        *v += 1;
        id
    })
}

// ===========================================================================
// The reactor loop. Platform-independent: all I/O goes through the cherenkov
// completion `Reactor` (io_uring on Linux, kqueue-emulating-completions on
// macOS, IOCP on Windows).
// ===========================================================================
mod imp {
    use super::*;
    use crate::scheduler_native::{
        ParkedWorkload, PumpOutcome, drop_parked, pump_drain_native, pump_native, setup_workload,
    };
    use cherenkov::{CURRENT_POS, Completion, Op, Reactor, Source, err};
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::time::{Duration, Instant};

    /// What a reactor completion resolves to. Every outstanding op — a tenant
    /// read/write/readiness, a timer, the control pipe, or a per-workload wake
    /// pipe — is keyed in `ops` by the `user_data` the `Poller` echoes back.
    enum OpRecord {
        /// A tenant read or bare readiness: resolve `resolver_id` with the
        /// completion `res`. A short read is a valid result (the caller reads
        /// what's available), so this resolves on the first completion. `_buffer`
        /// keeps the realm's ArrayBuffer alive until the kernel is done with it.
        Io {
            owner: u64,
            resolver_id: usize,
            _buffer: Option<v8::Global<v8::ArrayBuffer>>,
        },
        /// A tenant write. `writeAsync`'s contract (`stream.ts` `doFlush`) is to
        /// write the *whole* buffer before resolving — the caller does not loop
        /// on partial writes. So a partial completion re-submits the remainder
        /// (from `base + done`) and only a full drain, error, resolves the
        /// promise (with the total bytes written). `base`/`len` are the original
        /// buffer; `done` is how much has landed so far.
        Write {
            owner: u64,
            resolver_id: usize,
            _buffer: Option<v8::Global<v8::ArrayBuffer>>,
            fd: RawFd,
            base: u64,
            len: u32,
            done: u32,
        },
        /// A tenant timer: resolve `resolver_id` (value ignored).
        Timer {
            owner: u64,
            resolver_id: usize,
            timer_id: u64,
        },
        /// The control wake pipe: drain it, re-arm; `drain_control` does the work.
        Control { fd: RawFd },
        /// A workload's wake pipe (background FFI completion): drain, mark the
        /// workload runnable, re-arm.
        Wake { workload: u64, fd: RawFd },
    }

    /// A hosted isolate plus the scheduling state the run-queue orders by.
    struct EngineWorkload {
        id: u64,
        inner: ParkedWorkload,
        priority_class: u8,
        debt_micros: f64,
        sequence: u64,
        /// A dispatch activation is in flight (continue with an empty request).
        mid: bool,
        /// Pending data for a fresh dispatch (consumed on first pump).
        data_json: String,
        sync_heavy_reported: bool,
        /// Reactor I/O completions landed while parked (resolver_id, result),
        /// resolved at the start of the next pump.
        ready_io: Vec<(usize, f64)>,
        /// Queued wakes not yet serviced, each `(reason, source_id)`. A fresh
        /// activation pops one and passes it as `request.wake`, so N wakes still
        /// produce N activations (a resident tenant handles one message per wake).
        wakes: VecDeque<(String, String)>,
        /// A handoff snapshot (mailbox JSON) to hand the first activation after a
        /// migration, as `request.handoff`. Consumed on the first fresh dispatch.
        handoff_json: Option<String>,
    }

    struct ReactorThread {
        config: ReactorConfig,
        /// The single completion reactor for this thread (cherenkov: io_uring on
        /// Linux, kqueue-emulating-completions on macOS, IOCP on Windows). The
        /// only I/O primitive the engine touches.
        reactor: Reactor,
        control_rx: mpsc::Receiver<Control>,
        control_wake_read: RawFd,
        report_tx: mpsc::Sender<Report>,
        report_wake_write: RawFd,
        workloads: HashMap<u64, EngineWorkload>,
        /// Workloads with work ready to run (fresh wake, or a completion landed).
        runnable: HashSet<u64>,
        /// Every outstanding op, keyed by the `user_data` the reactor echoes on
        /// completion. Covers tenant I/O, timers, the control pipe, and per-
        /// workload wake pipes — a completion looks up its record here to route.
        ops: HashMap<u64, OpRecord>,
        /// Canceled ops whose records carry pointers (tenant buffers): the
        /// reactor contract keeps every submitted pointer alive until the op's
        /// completion is harvested, cancellation included, so these are parked
        /// here until their CANCELED completion arrives.
        doomed: HashMap<u64, OpRecord>,
        /// Tenant timer id → its op's `user_data`, so `CancelTimer` can find and
        /// cancel the outstanding timeout.
        timer_to_op: HashMap<u64, u64>,
        /// Monotonic source of `user_data` values.
        next_op_id: u64,
        next_sequence: u64,
        last_load_signature: (u32, u32, u32),
        running: bool,
        /// Reusable completion buffer for `Reactor::wait`.
        scratch: Vec<Completion>,
    }

    pub(super) fn run(
        config: ReactorConfig,
        control_rx: mpsc::Receiver<Control>,
        control_wake_read: RawFd,
        report_tx: mpsc::Sender<Report>,
        report_wake_write: RawFd,
    ) {
        crate::runtime::init_v8();
        // Mark this as an engine thread so tenant internal:io ops register here.
        ENGINE_IO.with(|c| *c.borrow_mut() = Some(Vec::new()));
        let reactor = match Reactor::new() {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut engine = ReactorThread {
            config,
            reactor,
            control_rx,
            control_wake_read,
            report_tx,
            report_wake_write,
            workloads: HashMap::new(),
            runnable: HashSet::new(),
            ops: HashMap::new(),
            doomed: HashMap::new(),
            timer_to_op: HashMap::new(),
            next_op_id: 1,
            next_sequence: 1,
            last_load_signature: (u32::MAX, u32::MAX, u32::MAX),
            running: true,
            scratch: Vec::new(),
        };
        // Arm a persistent readiness op on the control wake pipe so a control
        // send breaks the poll; it re-arms itself on every completion.
        engine.arm_control();
        engine.loop_forever();
        // Teardown: quiesce every in-flight op (tenant buffers must outlive
        // their completions), then dispose every hosted isolate.
        let ids: Vec<u64> = engine.workloads.keys().copied().collect();
        for id in ids {
            engine.cancel_owned(id);
        }
        engine.drain_doomed();
        for (_, w) in engine.workloads.drain() {
            drop_parked(w.inner);
        }
    }

    impl ReactorThread {
        fn loop_forever(&mut self) {
            while self.running {
                self.drain_control();
                if !self.running {
                    break;
                }
                self.pump_runnable();
                self.report_load_if_changed();
                if !self.running {
                    break;
                }
                // Nothing runnable: block until a wake pipe / completion fd fires.
                self.poll_block();
            }
        }

        /// Next `user_data`, monotonic per thread.
        fn next_op(&mut self) -> u64 {
            let id = self.next_op_id;
            self.next_op_id += 1;
            id
        }

        /// Arm (or re-arm) a readiness op on the control wake pipe.
        fn arm_control(&mut self) {
            let fd = self.control_wake_read;
            let ud = self.next_op();
            self.reactor.submit_poll_in(ud, Source::fd(fd));
            self.ops.insert(ud, OpRecord::Control { fd });
        }

        /// Arm (or re-arm) a readiness op on a workload's wake pipe.
        fn arm_wake(&mut self, workload: u64, fd: RawFd) {
            let ud = self.next_op();
            self.reactor.submit_poll_in(ud, Source::fd(fd));
            self.ops.insert(ud, OpRecord::Wake { workload, fd });
        }

        fn drain_control(&mut self) {
            // Empty the control wake pipe (its readiness op already re-armed on
            // completion; this drains the bytes so it doesn't fire immediately).
            drain_pipe(self.control_wake_read);
            while let Ok(msg) = self.control_rx.try_recv() {
                self.handle_control(msg);
            }
        }

        fn handle_control(&mut self, msg: Control) {
            match msg {
                Control::Place {
                    workload_id,
                    entry_path,
                    data_json,
                    priority_class,
                    wake: _,
                    handoff_json,
                } => self.place(
                    workload_id,
                    entry_path,
                    data_json,
                    priority_class,
                    handoff_json,
                ),
                Control::Wake { workload_id, wake } => {
                    if let Some(w) = self.workloads.get_mut(&workload_id) {
                        w.wakes.push_back((wake.reason, wake.source_id));
                        self.runnable.insert(workload_id);
                    }
                }
                Control::Revoke {
                    workload_id,
                    reason,
                } => {
                    if self.workloads.contains_key(&workload_id) {
                        self.release(workload_id, reason);
                    }
                }
                Control::Drain { workload_id } => {
                    // Drain-to-snapshot: pump a `{drain:true}` request so the tenant
                    // serializes its mailbox, capture that JSON as the migration
                    // snapshot, then terminate. The destination reconstructs from it.
                    // (The live-migration completion-forwarding model layers on later.)
                    if let Some(mut w) = self.workloads.remove(&workload_id) {
                        self.runnable.remove(&workload_id);
                        let hard = self.config.hard_budget_micros;
                        let snapshot = pump_drain_native(&mut w.inner, "{\"drain\":true}", hard)
                            .unwrap_or_else(|| "[]".to_string());
                        // Quiesce outstanding ops before disposing the isolate
                        // that owns their buffers.
                        self.cancel_owned(workload_id);
                        self.drain_doomed();
                        drop_parked(w.inner);
                        self.report(Report::Drained {
                            workload_id,
                            snapshot: snapshot.into_bytes(),
                        });
                    }
                }
                Control::Shutdown => self.running = false,
            }
        }

        fn place(
            &mut self,
            workload_id: u64,
            entry_path: String,
            data_json: String,
            priority_class: u8,
            handoff_json: Option<String>,
        ) {
            let inner = match setup_workload(
                entry_path,
                self.config.process_env.clone(),
                self.config.package_map_json.clone(),
                self.config.heap_limit_bytes,
                super::tenant_import_rules(),
            ) {
                Ok(w) => w,
                Err(err) => {
                    self.report(Report::Released {
                        workload_id,
                        reason: format!("setup_failed: {err}"),
                    });
                    return;
                }
            };
            let wake_fd = inner.wake_read_fd();
            let seq = self.next_sequence;
            self.next_sequence += 1;
            // Watch the isolate's wake pipe so background completions re-pump it.
            if wake_fd >= 0 {
                self.arm_wake(workload_id, wake_fd);
            }
            self.workloads.insert(
                workload_id,
                EngineWorkload {
                    id: workload_id,
                    inner,
                    priority_class,
                    debt_micros: 0.0,
                    sequence: seq,
                    mid: false,
                    data_json,
                    sync_heavy_reported: false,
                    ready_io: Vec::new(),
                    wakes: VecDeque::new(),
                    handoff_json,
                },
            );
            // Placed but parked: the orchestrator sends an explicit Wake to run it
            // (each activation corresponds to a wake, matching SchedulerNode).
        }

        fn pump_runnable(&mut self) {
            loop {
                let mut batch: Vec<u64> = self.runnable.iter().copied().collect();
                if batch.is_empty() {
                    break;
                }
                // Priority order: class → debt → sequence → id (compareRunnable).
                batch.sort_by(|a, b| self.compare_runnable(*a, *b));
                self.runnable.clear();
                for id in batch {
                    if !self.running {
                        return;
                    }
                    self.pump_one(id);
                }
                // Loop again: pumps may have re-marked workloads runnable (settled
                // with more work). New completions arrive via poll, not here.
            }
        }

        fn compare_runnable(&self, a: u64, b: u64) -> std::cmp::Ordering {
            let wa = &self.workloads[&a];
            let wb = &self.workloads[&b];
            wa.priority_class
                .cmp(&wb.priority_class)
                .then(wa.debt_micros.total_cmp(&wb.debt_micros))
                .then(wa.sequence.cmp(&wb.sequence))
                .then(wa.id.cmp(&wb.id))
        }

        fn pump_one(&mut self, id: u64) {
            let request = {
                let w = match self.workloads.get_mut(&id) {
                    Some(w) => w,
                    None => return,
                };
                if w.mid {
                    "{}".to_string()
                } else {
                    w.mid = true;
                    // A fresh activation: hand it the migration snapshot if this is
                    // the first run after a handoff, else the next queued wake.
                    if let Some(mailbox) = w.handoff_json.take() {
                        format!(
                            "{{\"workloadId\":{},\"data\":{},\"handoff\":{{\"mailbox\":{}}}}}",
                            id, w.data_json, mailbox
                        )
                    } else if let Some((reason, source_id)) = w.wakes.pop_front() {
                        format!(
                            "{{\"workloadId\":{},\"data\":{},\"wake\":{{\"reason\":{},\"sourceId\":{}}}}}",
                            id,
                            w.data_json,
                            json_string(&reason),
                            json_string(&source_id)
                        )
                    } else {
                        format!("{{\"workloadId\":{},\"data\":{}}}", id, w.data_json)
                    }
                }
            };
            let hard = self.config.hard_budget_micros;
            let io_completions: Vec<(usize, f64)> = {
                let w = self.workloads.get_mut(&id).unwrap();
                std::mem::take(&mut w.ready_io)
            };
            let t0 = Instant::now();
            let outcome = {
                let w = self.workloads.get_mut(&id).unwrap();
                pump_native(&mut w.inner, &request, hard, &io_completions)
            };
            let slice_micros = t0.elapsed().as_micros() as f64;

            // Pick up any reactor I/O ops the tenant registered during this pump.
            self.collect_io_registrations(id);

            // Sync-heavy: a slice never awaits, so wall-clock == on-CPU time.
            {
                let w = self.workloads.get_mut(&id).unwrap();
                if !w.sync_heavy_reported && slice_micros > self.config.sync_slice_micros as f64 {
                    w.sync_heavy_reported = true;
                    let cpu = slice_micros;
                    self.report(Report::SyncHeavy {
                        workload_id: id,
                        cpu_micros: cpu,
                    });
                }
            }

            match outcome {
                PumpOutcome::Pending => {
                    // Parked on outstanding async work; wake pipe / reactor I/O
                    // completion will re-mark it runnable via poll.
                }
                PumpOutcome::Settled {
                    result,
                    cost_micros,
                } => {
                    let (terminal, rerun) = {
                        let w = self.workloads.get_mut(&id).unwrap();
                        w.mid = false;
                        if result == "idle" {
                            // Paid down debt; the wake this activation served was
                            // already dequeued at request-build. Re-run if more remain.
                            w.debt_micros = (w.debt_micros - cost_micros).max(0.0);
                            (false, !w.wakes.is_empty())
                        } else {
                            w.debt_micros += cost_micros;
                            (true, false)
                        }
                    };
                    if terminal {
                        self.release(id, result);
                    } else if rerun {
                        // More queued wakes: run the next activation.
                        self.runnable.insert(id);
                    }
                }
                PumpOutcome::Terminated => self.release(id, "terminated".to_string()),
                PumpOutcome::Rejected(_msg) => self.release(id, "failed".to_string()),
            }
        }

        /// Drain the tenant's just-registered reactor ops and submit them to the
        /// poller as completion-based operations. A fused read/write submits the
        /// actual transfer (the kernel does it on io_uring; the kqueue backend
        /// synthesizes it on readiness); a bare readiness submits a poll; a timer
        /// submits a timeout. Every op is keyed in `ops` by its `user_data`.
        fn collect_io_registrations(&mut self, id: u64) {
            let regs: Vec<EngineReg> = ENGINE_IO
                .with(|c| c.borrow_mut().as_mut().map(std::mem::take))
                .unwrap_or_default();
            for reg in regs {
                match reg {
                    EngineReg::Io(io) => {
                        let ud = self.next_op();
                        match io.kind {
                            IoKind::Write => {
                                // Drain from where the sync fast path stopped.
                                let base = io.buf_ptr as u64;
                                let done = io.written as u32;
                                let len = io.len as u32;
                                // SAFETY: the tenant's ArrayBuffer is retained in
                                // the OpRecord (`_buffer`) until this op's
                                // completion is harvested, so the pointer stays
                                // valid for the kernel's whole use of it.
                                unsafe {
                                    self.reactor.submit(
                                        ud,
                                        Op::Write {
                                            src: Source::fd(io.fd),
                                            buf: (base + done as u64) as *const u8,
                                            len: len - done,
                                            off: CURRENT_POS,
                                        },
                                    );
                                }
                                self.ops.insert(
                                    ud,
                                    OpRecord::Write {
                                        owner: id,
                                        resolver_id: io.resolver_id,
                                        _buffer: io.buffer,
                                        fd: io.fd,
                                        base,
                                        len,
                                        done,
                                    },
                                );
                            }
                            _ => {
                                let op = match io.kind {
                                    IoKind::Read => Op::Read {
                                        src: Source::fd(io.fd),
                                        buf: io.buf_ptr,
                                        len: io.len as u32,
                                        off: CURRENT_POS,
                                    },
                                    IoKind::Readable => Op::PollIn {
                                        src: Source::fd(io.fd),
                                    },
                                    IoKind::Writable => Op::PollOut {
                                        src: Source::fd(io.fd),
                                    },
                                    IoKind::Write => unreachable!(),
                                };
                                // SAFETY: fused-read buffers are retained in the
                                // OpRecord until harvest; readiness ops carry no
                                // pointers.
                                unsafe { self.reactor.submit(ud, op) };
                                self.ops.insert(
                                    ud,
                                    OpRecord::Io {
                                        owner: id,
                                        resolver_id: io.resolver_id,
                                        _buffer: io.buffer,
                                    },
                                );
                            }
                        }
                    }
                    EngineReg::Timer {
                        timer_id,
                        ms,
                        resolver_id,
                    } => {
                        let ud = self.next_op();
                        self.reactor.submit_timeout(ud, ms.max(0) as u64);
                        self.ops.insert(
                            ud,
                            OpRecord::Timer {
                                owner: id,
                                resolver_id,
                                timer_id,
                            },
                        );
                        self.timer_to_op.insert(timer_id, ud);
                    }
                    EngineReg::CancelTimer { timer_id } => {
                        if let Some(ud) = self.timer_to_op.remove(&timer_id) {
                            // Timer records carry no pointers, so eager removal
                            // is safe; the CANCELED completion finds no record
                            // and is ignored.
                            self.reactor.cancel(ud);
                            self.ops.remove(&ud);
                        }
                    }
                }
            }
        }

        /// Route one completion to its owner. `res` is the operation result: a
        /// byte count for read/write, a bytes-available hint for readiness, or
        /// (for a bare `PollOut`) 0; a negative value is `-errno`. The tenant's
        /// promise resolver gets it verbatim during the next pump.
        fn on_completion(&mut self, user_data: u64, res: i32) {
            // A doomed op's completion (CANCELED or a racing result) only exists
            // to release the record — the buffer it retained is now safe to drop.
            if self.doomed.remove(&user_data).is_some() {
                return;
            }
            let rec = match self.ops.remove(&user_data) {
                Some(r) => r,
                None => return, // cancelled or belonged to a released workload
            };
            match rec {
                OpRecord::Io {
                    owner,
                    resolver_id,
                    _buffer,
                } => {
                    if let Some(w) = self.workloads.get_mut(&owner) {
                        w.ready_io.push((resolver_id, res as f64));
                    }
                    self.runnable.insert(owner);
                }
                OpRecord::Write {
                    owner,
                    resolver_id,
                    _buffer,
                    fd,
                    base,
                    len,
                    done,
                } => {
                    // Would-block (readiness lied / buffer filled between): re-arm
                    // the same remainder rather than surfacing a spurious error.
                    // Resubmitting after harvest is slot-legal: the completed
                    // op's (fd, direction) slot was released at harvest.
                    if res == -libc::EAGAIN {
                        let ud = self.next_op();
                        // SAFETY: `_buffer` moves into the new record, keeping
                        // the tenant's ArrayBuffer alive until the new harvest.
                        unsafe {
                            self.reactor.submit(
                                ud,
                                Op::Write {
                                    src: Source::fd(fd),
                                    buf: (base + done as u64) as *const u8,
                                    len: len - done,
                                    off: CURRENT_POS,
                                },
                            );
                        }
                        self.ops.insert(
                            ud,
                            OpRecord::Write {
                                owner,
                                resolver_id,
                                _buffer,
                                fd,
                                base,
                                len,
                                done,
                            },
                        );
                    } else if res < 0 {
                        // Real error: hand the tenant -errno.
                        if let Some(w) = self.workloads.get_mut(&owner) {
                            w.ready_io.push((resolver_id, res as f64));
                        }
                        self.runnable.insert(owner);
                    } else {
                        let new_done = done + res as u32;
                        if new_done >= len {
                            // Buffer fully drained: resolve with the total written.
                            if let Some(w) = self.workloads.get_mut(&owner) {
                                w.ready_io.push((resolver_id, new_done as f64));
                            }
                            self.runnable.insert(owner);
                        } else {
                            // Partial write: submit the remainder, keep draining.
                            let ud = self.next_op();
                            // SAFETY: `_buffer` moves into the new record,
                            // keeping the buffer alive until the new harvest.
                            unsafe {
                                self.reactor.submit(
                                    ud,
                                    Op::Write {
                                        src: Source::fd(fd),
                                        buf: (base + new_done as u64) as *const u8,
                                        len: len - new_done,
                                        off: CURRENT_POS,
                                    },
                                );
                            }
                            self.ops.insert(
                                ud,
                                OpRecord::Write {
                                    owner,
                                    resolver_id,
                                    _buffer,
                                    fd,
                                    base,
                                    len,
                                    done: new_done,
                                },
                            );
                        }
                    }
                }
                OpRecord::Timer {
                    owner,
                    resolver_id,
                    timer_id,
                } => {
                    self.timer_to_op.remove(&timer_id);
                    if let Some(w) = self.workloads.get_mut(&owner) {
                        w.ready_io.push((resolver_id, 0.0));
                    }
                    self.runnable.insert(owner);
                }
                OpRecord::Control { fd } => {
                    // A BUSY completion means something else already watches this
                    // fd — re-arming would spin on BUSY forever.
                    if res == err::BUSY {
                        return;
                    }
                    drain_pipe(fd);
                    self.arm_control(); // handled by drain_control at loop top
                }
                OpRecord::Wake { workload, fd } => {
                    if res == err::BUSY {
                        return;
                    }
                    drain_pipe(fd);
                    if self.workloads.contains_key(&workload) {
                        self.runnable.insert(workload);
                        self.arm_wake(workload, fd);
                    }
                }
            }
        }

        /// Cancel every op this workload owns. Pointer-free records (timers,
        /// readiness, wake watches) are dropped eagerly — their CANCELED
        /// completion finds no record and is ignored. Pointer-carrying records
        /// (fused reads, writes) retain the tenant's ArrayBuffer and move to
        /// `doomed`: the reactor may still hand their pointers to the kernel
        /// until the CANCELED completion is harvested, so the buffer — and the
        /// isolate that owns its memory — must stay alive until then.
        fn cancel_owned(&mut self, id: u64) {
            let owned: Vec<u64> = self
                .ops
                .iter()
                .filter(|(_, rec)| match rec {
                    OpRecord::Io { owner, .. }
                    | OpRecord::Write { owner, .. }
                    | OpRecord::Timer { owner, .. } => *owner == id,
                    OpRecord::Wake { workload, .. } => *workload == id,
                    OpRecord::Control { .. } => false,
                })
                .map(|(ud, _)| *ud)
                .collect();
            for ud in owned {
                self.reactor.cancel(ud);
                let rec = self.ops.remove(&ud).unwrap();
                let has_pointers = match &rec {
                    OpRecord::Io { _buffer, .. } => _buffer.is_some(),
                    OpRecord::Write { .. } => true,
                    _ => false,
                };
                if has_pointers {
                    self.doomed.insert(ud, rec);
                }
            }
            let ops = &self.ops;
            self.timer_to_op.retain(|_, ud| ops.contains_key(ud));
        }

        /// Wait until every doomed op's completion has been harvested (so its
        /// retained buffer can be dropped with its isolate still alive).
        /// Cancellation completes promptly on every backend; the deadline is a
        /// defensive bound, not an expected path.
        fn drain_doomed(&mut self) {
            let deadline = Instant::now() + Duration::from_secs(1);
            while !self.doomed.is_empty() {
                if Instant::now() >= deadline {
                    eprintln!(
                        "reactor engine: {} canceled op(s) unharvested at teardown",
                        self.doomed.len()
                    );
                    self.doomed.clear();
                    break;
                }
                let mut buf = std::mem::take(&mut self.scratch);
                buf.clear();
                let _ = self.reactor.wait(Some(Duration::from_millis(10)), &mut buf);
                for c in &buf {
                    self.on_completion(c.user_data, c.res);
                }
                self.scratch = buf;
            }
        }

        fn release(&mut self, id: u64, reason: String) {
            // Quiesce this workload's outstanding ops BEFORE disposing the
            // isolate their buffers belong to.
            self.cancel_owned(id);
            self.drain_doomed();
            if let Some(w) = self.workloads.remove(&id) {
                self.runnable.remove(&id);
                drop_parked(w.inner);
                self.report(Report::Released {
                    workload_id: id,
                    reason,
                });
            }
        }

        fn poll_block(&mut self) {
            // Block on the reactor only when nothing is runnable; otherwise reap
            // whatever completions are already available and return so the pump
            // loop keeps making progress. Newly submitted ops are flushed to the
            // kernel inside `wait`.
            let timeout = if self.runnable.is_empty() {
                None
            } else {
                Some(Duration::ZERO)
            };
            let mut buf = std::mem::take(&mut self.scratch);
            buf.clear();
            let _ = self.reactor.wait(timeout, &mut buf);
            for c in &buf {
                self.on_completion(c.user_data, c.res);
            }
            self.scratch = buf;
        }

        fn report_load_if_changed(&mut self) {
            let held = self.workloads.len() as u32;
            let runnable = self.runnable.len() as u32;
            let debt_band = if runnable == 0 { 0 } else { 1 };
            let sig = (held, runnable, debt_band);
            if sig != self.last_load_signature {
                self.last_load_signature = sig;
                self.report(Report::Load {
                    held,
                    runnable,
                    debt_band,
                });
            }
        }

        fn report(&mut self, report: Report) {
            let _ = self.report_tx.send(report);
            // Wake the orchestrator's loop so it drains the report promptly.
            let byte = [1u8];
            unsafe {
                libc::write(self.report_wake_write, byte.as_ptr() as *const _, 1);
            }
        }
    }

    fn drain_pipe(fd: RawFd) {
        if fd < 0 {
            return;
        }
        let mut buf = [0u8; 64];
        loop {
            let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut _, buf.len()) };
            if n <= 0 {
                break;
            }
        }
    }
}

// ===========================================================================
// Public spawn API + shared tenant setup.
// ===========================================================================

/// Spawn a reactor thread and return the orchestrator-side handle.
pub fn spawn_reactor(config: ReactorConfig) -> Result<ReactorHandle, String> {
    let (control_tx, control_rx) = mpsc::channel::<Control>();
    let (report_tx, report_rx) = mpsc::channel::<Report>();
    let (control_wake_read, control_wake_write) = create_pipe()?;
    let (report_wake_read, report_wake_write) = create_pipe()?;

    let join = std::thread::Builder::new()
        .name("reactor".to_string())
        .spawn(move || {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                imp::run(
                    config,
                    control_rx,
                    control_wake_read,
                    report_tx,
                    report_wake_write,
                );
            }));
            unsafe {
                libc::close(control_wake_read);
                libc::close(report_wake_write);
            }
        })
        .map_err(|e| format!("failed to spawn reactor thread: {e}"))?;

    Ok(ReactorHandle {
        control_tx,
        control_wake_write,
        report_rx,
        report_wake_read,
        join,
    })
}

fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if ret != 0 {
        return Err(format!(
            "pipe() failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }
    Ok((fds[0], fds[1]))
}

// ===========================================================================
// internal:reactor-engine — the orchestrator-facing synthetic module.
//
// The orchestrator (main thread, TS) spawns and drives a pool of reactor threads
// through these callbacks. Handles live in a main-thread-local registry keyed by
// a small integer id.
// ===========================================================================

use std::cell::RefCell;

thread_local! {
    static REACTORS: RefCell<Vec<Option<ReactorHandle>>> = const { RefCell::new(Vec::new()) };
}

/// Build the `internal:reactor-engine` synthetic module.
pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let names = [
        "spawnReactor",
        "place",
        "wake",
        "revoke",
        "drain",
        "shutdown",
        "reportFd",
        "drainReports",
        "reactorAlive",
    ];
    let export_names: Vec<v8::Local<v8::String>> = names
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();
    let module_name = v8::String::new(scope, "internal:reactor-engine").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    macro_rules! export {
        ($name:literal, $cb:path) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }
    export!("spawnReactor", cb_spawn_reactor);
    export!("place", cb_place);
    export!("wake", cb_wake);
    export!("revoke", cb_revoke);
    export!("drain", cb_drain);
    export!("shutdown", cb_shutdown);
    export!("reportFd", cb_report_fd);
    export!("drainReports", cb_drain_reports);
    export!("reactorAlive", cb_reactor_alive);
    Some(v8::undefined(scope).into())
}

fn arg_u64(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments, i: i32) -> u64 {
    args.get(i).integer_value(scope).unwrap_or(0).max(0) as u64
}

fn arg_str(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments, i: i32) -> String {
    args.get(i)
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default()
}

fn obj_u64(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    key: &str,
    default: u64,
) -> u64 {
    v8::String::new(scope, key)
        .and_then(|k| obj.get(scope, k.into()))
        .and_then(|v| v.integer_value(scope))
        .map(|n| n.max(0) as u64)
        .unwrap_or(default)
}

fn with_reactor<R>(id: usize, f: impl FnOnce(&ReactorHandle) -> R) -> Option<R> {
    REACTORS.with(|r| r.borrow().get(id).and_then(|h| h.as_ref()).map(f))
}

/// Send a control message and poke the reactor's wake pipe so it acts promptly.
fn send_control(id: usize, msg: Control) {
    with_reactor(id, |h| {
        if h.control_tx.send(msg).is_ok() {
            let b = [1u8];
            unsafe {
                libc::write(h.control_wake_write, b.as_ptr() as *const _, 1);
            }
        }
    });
}

fn cb_spawn_reactor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let cfg_obj = v8::Local::<v8::Object>::try_from(args.get(0)).ok();
    let hard_budget_micros = cfg_obj
        .map(|o| obj_u64(scope, o, "hardBudgetMicros", 5_000_000))
        .unwrap_or(5_000_000);
    let sync_slice_micros = cfg_obj
        .map(|o| obj_u64(scope, o, "syncSliceMicros", 50_000))
        .unwrap_or(50_000);
    let heap_limit_bytes = cfg_obj
        .map(|o| obj_u64(scope, o, "heapLimitBytes", 0))
        .unwrap_or(0) as usize;

    let state = crate::state::get_state(scope);
    let (process_env, package_map_json) = {
        let st = state.borrow();
        (st.process_env.clone(), st.package_map_json.clone())
    };

    let config = ReactorConfig {
        hard_budget_micros,
        sync_slice_micros,
        heap_limit_bytes,
        process_env,
        package_map_json,
    };
    match spawn_reactor(config) {
        Ok(handle) => {
            let id = REACTORS.with(|r| {
                let mut v = r.borrow_mut();
                let id = v.len();
                v.push(Some(handle));
                id
            });
            rv.set(v8::Integer::new(scope, id as i32).into());
        }
        Err(err) => {
            let msg = v8::String::new(scope, &err).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
        }
    }
}

fn cb_place(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    let entry_path = arg_str(scope, &args, 2);
    let data_json = arg_str(scope, &args, 3);
    let priority_class = arg_u64(scope, &args, 4) as u8;
    let reason = arg_str(scope, &args, 5);
    let source_id = arg_str(scope, &args, 6);
    // Optional arg 7: a migration snapshot (mailbox JSON) for the first activation.
    // Absent on a fresh placement (only present on a reclaimed handoff).
    let handoff_json = if args.get(7).is_string() {
        let s = arg_str(scope, &args, 7);
        if s.is_empty() { None } else { Some(s) }
    } else {
        None
    };
    send_control(
        id,
        Control::Place {
            workload_id,
            entry_path,
            data_json,
            priority_class,
            wake: Wake { reason, source_id },
            handoff_json,
        },
    );
}

fn cb_wake(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    let reason = arg_str(scope, &args, 2);
    let source_id = arg_str(scope, &args, 3);
    send_control(
        id,
        Control::Wake {
            workload_id,
            wake: Wake { reason, source_id },
        },
    );
}

fn cb_revoke(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    let reason = arg_str(scope, &args, 2);
    send_control(
        id,
        Control::Revoke {
            workload_id,
            reason,
        },
    );
}

fn cb_drain(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    send_control(id, Control::Drain { workload_id });
}

fn cb_shutdown(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    send_control(id, Control::Shutdown);
}

fn cb_report_fd(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let fd = with_reactor(id, |h| h.report_wake_read).unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

fn cb_reactor_alive(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let alive = with_reactor(id, |h| !h.join.is_finished()).unwrap_or(false);
    rv.set_bool(alive);
}

fn cb_drain_reports(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    // Drain the report pipe (level) and collect queued reports.
    let reports: Vec<Report> = REACTORS.with(|r| {
        let borrow = r.borrow();
        let handle = match borrow.get(id).and_then(|h| h.as_ref()) {
            Some(h) => h,
            None => return Vec::new(),
        };
        // Empty the wake pipe so the next report re-arms the orchestrator's watch.
        let mut buf = [0u8; 64];
        loop {
            let n =
                unsafe { libc::read(h_report_fd(handle), buf.as_mut_ptr() as *mut _, buf.len()) };
            if n <= 0 {
                break;
            }
        }
        let mut out = Vec::new();
        while let Ok(report) = handle.report_rx.try_recv() {
            out.push(report);
        }
        out
    });

    let arr = v8::Array::new(scope, reports.len() as i32);
    for (i, report) in reports.into_iter().enumerate() {
        let obj = report_to_js(scope, report);
        arr.set_index(scope, i as u32, obj.into());
    }
    rv.set(arr.into());
}

fn h_report_fd(handle: &ReactorHandle) -> RawFd {
    handle.report_wake_read
}

/// Encode `s` as a JSON string literal (quotes + minimal escaping) for splicing
/// into a hand-built request object.
pub(crate) fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn set_str(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, val: &str) {
    let k = v8::String::new(scope, key).unwrap();
    let v = v8::String::new(scope, val).unwrap();
    obj.set(scope, k.into(), v.into());
}

fn set_num(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, val: f64) {
    let k = v8::String::new(scope, key).unwrap();
    let v = v8::Number::new(scope, val);
    obj.set(scope, k.into(), v.into());
}

fn report_to_js<'s>(scope: &mut v8::HandleScope<'s>, report: Report) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    match report {
        Report::Released {
            workload_id,
            reason,
        } => {
            set_str(scope, obj, "type", "released");
            set_num(scope, obj, "workloadId", workload_id as f64);
            set_str(scope, obj, "reason", &reason);
        }
        Report::SyncHeavy {
            workload_id,
            cpu_micros,
        } => {
            set_str(scope, obj, "type", "syncHeavy");
            set_num(scope, obj, "workloadId", workload_id as f64);
            set_num(scope, obj, "cpuMicros", cpu_micros);
        }
        Report::Load {
            held,
            runnable,
            debt_band,
        } => {
            set_str(scope, obj, "type", "load");
            set_num(scope, obj, "held", held as f64);
            set_num(scope, obj, "runnable", runnable as f64);
            set_num(scope, obj, "debtBand", debt_band as f64);
        }
        Report::Drained {
            workload_id,
            snapshot,
        } => {
            set_str(scope, obj, "type", "drained");
            set_num(scope, obj, "workloadId", workload_id as f64);
            // The snapshot is UTF-8 mailbox JSON; hand it back as a string so the
            // orchestrator can carry it to the destination's `handoff` request.
            set_str(scope, obj, "snapshot", &String::from_utf8_lossy(&snapshot));
        }
    }
    obj
}
