//! Native per-thread reactor engine.
//!
//! A reactor thread hosts N realm workloads and pumps them in priority order.
//! Every workload — tenant or full child realm — is constructed through the one
//! realm bootstrap (`scheduler_native::setup_realm_workload`) and driven through
//! its native loop hooks; tenant activations arrive as `__tenant_dispatch`
//! messages over the workload's port, not as a separate dispatch protocol.
//!
//! The orchestrator (main thread, TS) drives a pool of these threads through a
//! cross-thread control/report channel: an mpsc for the messages, cherenkov
//! Notifier posts for the wakes (control pokes post into the engine's reactor;
//! reports wake the orchestrator through its isolate wake sink). Control:
//! place / revoke / shutdown. Reports: released / sync-heavy / load.
//!
//! Isolate-tagged direct I/O (replacing the facade) layers on top of this loop —
//! see `reactor/io.rs` — so a parked isolate's reactor I/O completions mark it
//! runnable here. This module owns the execution + scheduling half.

use std::cell::Cell;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;

/// Notifier post tags for the engine's reactor: ops use a monotonic counter
/// with bit 63 clear; posts set bit 63. Bit 62 distinguishes a per-workload
/// wake (low bits = workload id, a JS number ≤ 2^53) from a control poke.
const POST_FLAG: u64 = 1 << 63;
const POST_WAKE_BIT: u64 = 1 << 62;
const POST_CONTROL: u64 = POST_FLAG;

/// The post tag a tenant's background FFI wakes carry into the engine reactor.
fn post_wake(workload_id: u64) -> u64 {
    POST_FLAG | POST_WAKE_BIT | workload_id
}

use crate::state::{ImportDirective, ImportPattern, ImportRule, ProcessEnv, default_import_rules};

/// Per-thread reactor configuration (all cold-path, set at spawn).
#[derive(Clone)]
pub struct ReactorConfig {
    /// Hard runaway budget per synchronous pump slice (µs, 0 = disabled).
    pub hard_budget_micros: u64,
    /// A synchronous slice over this (µs) emits a rate-limited blocking report.
    pub sync_slice_micros: u64,
    /// Per-tenant old-generation heap cap (bytes, 0 = default 1 GiB).
    pub heap_limit_bytes: usize,
    /// Process env shared by tenant isolates on this thread.
    pub process_env: ProcessEnv,
    /// Package map JSON shared by tenant isolates on this thread.
    pub package_map_json: Option<String>,
    /// Relative OS scheduling class for this reactor thread.
    pub reactor_class: ReactorClass,
}

#[derive(Clone, Copy)]
pub enum ReactorClass {
    Latency,
    Batch,
}

impl ReactorClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Latency => "latency",
            Self::Batch => "batch",
        }
    }
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
    // (No loop remap needed: the loader aliases `internal:runtime/loop` to
    // the reactor-backed implementation for every realm unconditionally.)
    rules
}

/// Control messages: orchestrator (main thread) → reactor thread.
pub(crate) enum Control {
    /// Create + place a REALM workload on this thread and mark it runnable:
    /// a full child realm (uniform bootstrap, port channel, rule
    /// inheritance) whose native loop hooks the engine pumps.
    PlaceRealm {
        workload_id: u64,
        entry_path: String,
        /// The realm's complete serialized import rules (parent-inherited).
        rules_json: String,
        /// JSON-serialized RealmOptions.data, if any.
        realm_data: Option<String>,
        /// Runtime-owned bootstrap metadata, if any.
        realm_bootstrap_data: Option<String>,
        priority_class: u8,
        /// The child-side channel half (transit handle + wake-pipe read fd).
        port_half: (u32, i32),
    },
    /// Terminate + release a workload.
    Revoke { workload_id: u64, reason: String },
    /// Detach an exited isolate and ship exclusive ownership to another
    /// reactor thread. Existing source-hosted operations forward completions.
    Move {
        workload_id: u64,
        destination_tx: mpsc::Sender<Control>,
        destination_notify: cherenkov::Notifier,
    },
    /// Attach an isolate detached by another reactor.
    Attach { workload: imp::TransferWorkload },
    /// Completion of an operation still draining on a prior reactor.
    ForwardCompletion {
        workload_id: u64,
        resolver_id: usize,
        result: f64,
    },
    /// Background wake posted through the isolate's previous wake sink.
    ForwardWake { workload_id: u64 },
    /// Stop the reactor loop and dispose all hosted isolates.
    Shutdown,
}

/// Report messages: reactor thread → orchestrator (main thread).
pub enum Report {
    /// A workload reached a terminal state (settled terminal / rejected / revoked).
    Released { workload_id: u64, reason: String },
    /// A live isolate was attached after moving from another reactor.
    Moved { workload_id: u64 },
    /// The source has no remaining operations or wake routes for a moved realm.
    Detached { workload_id: u64 },
    /// Reactor startup and best-effort OS-priority result.
    Started {
        reactor_class: ReactorClass,
        priority_applied: bool,
    },
    /// A synchronous slice exceeded the soft threshold — migrate to a batch thread.
    SyncHeavy { workload_id: u64, cpu_micros: f64 },
    /// Coarse load signature changed (held : runnable : debt-band).
    Load {
        held: u32,
        runnable: u32,
        debt_band: u32,
        debt_micros: f64,
    },
}

/// Orchestrator-side handle to a spawned reactor thread. `join` is held for the
/// thread's lifetime (dropping it would detach the thread).
#[allow(dead_code)]
pub struct ReactorHandle {
    pub control_tx: mpsc::Sender<Control>,
    /// Posted (`POST_CONTROL`) after a control send to break the reactor's wait.
    pub control_notify: cherenkov::Notifier,
    pub report_rx: mpsc::Receiver<Report>,
    /// Bumped by the engine thread once per queued report — and once at thread
    /// exit, so a dead engine still wakes its report pump. The orchestrator's
    /// drain hook resolves `report_waiter` whenever it advances past
    /// `report_seen`.
    pub report_seq: Arc<AtomicU64>,
    /// Last `report_seq` value a resolved `nextReport()` consumed.
    pub report_seen: Cell<u64>,
    /// The armed `nextReport()` resolver, if the report pump is parked.
    pub report_waiter: RefCell<Option<v8::Global<v8::PromiseResolver>>>,
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
    pub buffer: Option<v8::SharedRef<v8::BackingStore>>,
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
    SetTimerRef {
        timer_id: u64,
        referenced: bool,
    },
    CancelTimer {
        timer_id: u64,
    },
    /// Abandon the pending read-side watch on `fd` (loop `removeRead`): the
    /// promise is never settled, and the engine's armed op is canceled so a
    /// reused fd number can arm a fresh watch.
    RemoveRead {
        fd: i32,
    },
    /// Abandon the pending write-side watch on `fd` (loop `removeWrite`).
    RemoveWrite {
        fd: i32,
    },
}

thread_local! {
    /// `Some` only on a reactor engine thread; tenants push registrations here
    /// during a pump, and the engine drains them right after.
    static ENGINE_IO: RefCell<Option<Vec<EngineReg>>> = const { RefCell::new(None) };
    /// Monotonic timer id source for engine-mode timers.
    static ENGINE_TIMER_SEQ: RefCell<u64> = const { RefCell::new(1) };
    /// The pumping workload's engine-held handle counts `(io, timers)`,
    /// snapshotted before each pump so the loop's `alive()` introspection can
    /// answer for the CURRENT realm rather than for the thread.
    static ENGINE_CURRENT_COUNTS: Cell<(u32, u32)> = const { Cell::new((0, 0)) };
}

/// The pumping workload's engine-held `(io, timers)` counts plus the net
/// effect of registrations queued during the current pump. Zero off-engine.
pub(crate) fn engine_current_counts() -> (u32, u32) {
    let (mut io, mut timers) = ENGINE_CURRENT_COUNTS.with(|c| c.get());
    ENGINE_IO.with(|c| {
        if let Some(regs) = c.borrow().as_ref() {
            for reg in regs {
                match reg {
                    EngineReg::Io(_) => io += 1,
                    EngineReg::Timer { .. } => timers += 1,
                    EngineReg::CancelTimer { .. } => timers = timers.saturating_sub(1),
                    EngineReg::SetTimerRef { referenced, .. } => {
                        if *referenced {
                            timers += 1;
                        } else {
                            timers = timers.saturating_sub(1);
                        }
                    }
                    EngineReg::RemoveRead { .. } | EngineReg::RemoveWrite { .. } => {
                        io = io.saturating_sub(1)
                    }
                }
            }
        }
    });
    (io, timers)
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
        ParkedWorkload, PumpOutcome, drop_parked, pump_realm_native, setup_realm_workload,
    };
    use cherenkov::{CURRENT_POS, Completion, Op, Reactor, Source};
    use std::collections::{HashMap, HashSet};
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
            _buffer: Option<v8::SharedRef<v8::BackingStore>>,
            fd: RawFd,
            /// Read-direction op (fused read / read-readiness) vs writability.
            dir_read: bool,
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
            _buffer: Option<v8::SharedRef<v8::BackingStore>>,
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
            deadline: Instant,
            referenced: bool,
        },
        /// A realm-workload poll tick: just re-mark the owner runnable
        /// (progress may have happened on a child's own thread).
        RePoll { owner: u64 },
    }

    /// A hosted isolate plus the scheduling state the run-queue orders by.
    pub(super) struct EngineWorkload {
        id: u64,
        inner: ParkedWorkload,
        /// A realm workload: pumped through its native loop hooks rather than
        /// the tenant dispatch protocol.
        priority_class: u8,
        debt_micros: f64,
        sequence: u64,
        last_sync_heavy_report: Option<Instant>,
        /// Reactor I/O completions landed while parked (resolver_id, result),
        /// resolved at the start of the next pump.
        ready_io: Vec<(usize, f64)>,
    }

    /// Exclusive ownership of an exited isolate while it crosses a native
    /// channel. `ParkedWorkload` is intentionally !Send in rusty_v8; this is
    /// the single audited boundary that moves it after all V8 scopes are gone.
    pub(crate) struct TransferWorkload {
        workload: EngineWorkload,
        operations: Vec<TransferredOp>,
    }

    enum TransferredOp {
        Readiness {
            resolver_id: usize,
            fd: i32,
            dir_read: bool,
        },
        Timer {
            resolver_id: usize,
            timer_id: u64,
            deadline: Instant,
            referenced: bool,
        },
        RePoll,
    }

    // SAFETY: the source removes the workload from its maps before constructing
    // this value and never accesses it again. The destination marks the isolate
    // as cross-thread before entering it under V8's Locker.
    unsafe impl Send for TransferWorkload {}

    #[derive(Clone)]
    struct ForwardRoute {
        tx: mpsc::Sender<Control>,
        notify: cherenkov::Notifier,
    }

    impl ForwardRoute {
        fn send(&self, message: Control) {
            if self.tx.send(message).is_ok() {
                self.notify.post(POST_CONTROL, 0);
            }
        }
    }

    struct ReactorThread {
        config: ReactorConfig,
        /// The single completion reactor for this thread (cherenkov: io_uring on
        /// Linux, kqueue-emulating-completions on macOS, IOCP on Windows). The
        /// only I/O primitive the engine touches.
        reactor: Reactor,
        control_rx: mpsc::Receiver<Control>,
        report_tx: mpsc::Sender<Report>,
        /// Bumped once per queued report; the orchestrator's drain hook turns
        /// an advance into a `nextReport()` resolution.
        report_seq: Arc<AtomicU64>,
        /// The orchestrator isolate's wake sink — the same channel background
        /// FFI threads use, so a report wakes either loop flavor.
        orch_wake: crate::async_rt::WakeSink,
        workloads: HashMap<u64, EngineWorkload>,
        /// Routes retained while this reactor drains operations submitted before
        /// their owning isolate moved to another thread.
        forwarded: HashMap<u64, ForwardRoute>,
        /// Workloads with work ready to run (fresh wake, or a completion landed).
        runnable: HashSet<u64>,
        /// Every outstanding op (tenant I/O and timers), keyed by the
        /// `user_data` the reactor echoes on completion. Control pokes and
        /// per-workload wakes are Notifier posts, not ops — they route by tag.
        ops: HashMap<u64, OpRecord>,
        /// Canceled ops whose records carry pointers (tenant buffers): the
        /// reactor contract keeps every submitted pointer alive until the op's
        /// completion is harvested, cancellation included, so these are parked
        /// here until their CANCELED completion arrives.
        doomed: HashMap<u64, OpRecord>,
        /// Latest armed read-side / write-side op per fd — the loop allows
        /// one watch per direction per fd, superseded by the newest waiter.
        read_ud_by_fd: HashMap<i32, u64>,
        write_ud_by_fd: HashMap<i32, u64>,
        /// Tenant timer id → its op's `user_data`, so `CancelTimer` can find and
        /// cancel the outstanding timeout.
        timer_to_op: HashMap<u64, u64>,
        /// Monotonic source of `user_data` values.
        next_op_id: u64,
        next_sequence: u64,
        last_load_signature: (u32, u32, u32),
        /// When the last Load report was posted (coalescing floor).
        last_load_report: Instant,
        running: bool,
        /// Reusable completion buffer for `Reactor::wait`.
        scratch: Vec<Completion>,
    }

    pub(super) fn run(
        config: ReactorConfig,
        control_rx: mpsc::Receiver<Control>,
        report_tx: mpsc::Sender<Report>,
        report_seq: Arc<AtomicU64>,
        orch_wake: crate::async_rt::WakeSink,
        reactor: Reactor,
    ) {
        let priority_applied = apply_thread_priority(config.reactor_class);
        crate::runtime::init_v8();
        // Mark this as an engine thread so tenant internal:io ops register here.
        ENGINE_IO.with(|c| *c.borrow_mut() = Some(Vec::new()));
        let mut engine = ReactorThread {
            config,
            reactor,
            control_rx,
            report_tx,
            report_seq,
            orch_wake,
            workloads: HashMap::new(),
            forwarded: HashMap::new(),
            runnable: HashSet::new(),
            ops: HashMap::new(),
            doomed: HashMap::new(),
            read_ud_by_fd: HashMap::new(),
            write_ud_by_fd: HashMap::new(),
            timer_to_op: HashMap::new(),
            next_op_id: 1,
            next_sequence: 1,
            last_load_signature: (u32::MAX, u32::MAX, u32::MAX),
            last_load_report: Instant::now(),
            running: true,
            scratch: Vec::new(),
        };
        engine.report(Report::Started {
            reactor_class: engine.config.reactor_class,
            priority_applied,
        });
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

    #[cfg(target_os = "macos")]
    fn apply_thread_priority(class: ReactorClass) -> bool {
        let qos = match class {
            ReactorClass::Latency => libc::qos_class_t::QOS_CLASS_USER_INITIATED,
            ReactorClass::Batch => libc::qos_class_t::QOS_CLASS_UTILITY,
        };
        unsafe { libc::pthread_set_qos_class_self_np(qos, 0) == 0 }
    }

    #[cfg(target_os = "linux")]
    fn apply_thread_priority(class: ReactorClass) -> bool {
        let nice = match class {
            ReactorClass::Latency => 0,
            ReactorClass::Batch => 10,
        };
        unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, nice) == 0 }
    }

    #[cfg(windows)]
    fn apply_thread_priority(class: ReactorClass) -> bool {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
            THREAD_PRIORITY_NORMAL,
        };
        let priority = match class {
            ReactorClass::Latency => THREAD_PRIORITY_NORMAL,
            ReactorClass::Batch => THREAD_PRIORITY_BELOW_NORMAL,
        };
        unsafe { SetThreadPriority(GetCurrentThread(), priority) != 0 }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    fn apply_thread_priority(_class: ReactorClass) -> bool {
        false
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

        fn drain_control(&mut self) {
            // A POST_CONTROL completion broke the wait; the messages are in
            // the mpsc, nothing to drain but the channel itself.
            while let Ok(msg) = self.control_rx.try_recv() {
                self.handle_control(msg);
            }
        }

        fn handle_control(&mut self, msg: Control) {
            match msg {
                Control::PlaceRealm {
                    workload_id,
                    entry_path,
                    rules_json,
                    realm_data,
                    realm_bootstrap_data,
                    priority_class,
                    port_half,
                } => self.place_realm(
                    workload_id,
                    entry_path,
                    rules_json,
                    realm_data,
                    realm_bootstrap_data,
                    priority_class,
                    port_half,
                ),
                Control::Revoke {
                    workload_id,
                    reason,
                } => {
                    if self.workloads.contains_key(&workload_id) {
                        self.release(workload_id, reason);
                    }
                }
                Control::Move {
                    workload_id,
                    destination_tx,
                    destination_notify,
                } => self.move_workload(workload_id, destination_tx, destination_notify),
                Control::Attach { mut workload } => {
                    workload.workload.inner.mark_moved_between_threads();
                    let workload_id = workload.workload.id;
                    workload
                        .workload
                        .inner
                        .install_wake_notifier(self.reactor.notifier(), post_wake(workload_id));
                    self.workloads.insert(workload_id, workload.workload);
                    self.attach_operations(workload_id, workload.operations);
                    self.report(Report::Moved { workload_id });
                }
                Control::ForwardCompletion {
                    workload_id,
                    resolver_id,
                    result,
                } => self.deliver_completion(workload_id, resolver_id, result),
                Control::ForwardWake { workload_id } => {
                    if self.workloads.contains_key(&workload_id) {
                        self.runnable.insert(workload_id);
                    }
                }
                Control::Shutdown => self.running = false,
            }
        }

        fn move_workload(
            &mut self,
            workload_id: u64,
            destination_tx: mpsc::Sender<Control>,
            destination_notify: cherenkov::Notifier,
        ) {
            let Some(workload) = self.workloads.remove(&workload_id) else {
                return;
            };
            self.runnable.remove(&workload_id);
            let operations = self.detach_transferable_operations(workload_id);
            let route = ForwardRoute {
                tx: destination_tx,
                notify: destination_notify,
            };
            self.forwarded.insert(workload_id, route.clone());
            route.send(Control::Attach {
                workload: TransferWorkload {
                    workload,
                    operations,
                },
            });
            self.finish_forwarding_if_drained(workload_id);
        }

        fn detach_transferable_operations(&mut self, owner: u64) -> Vec<TransferredOp> {
            let ids: Vec<u64> = self
                .ops
                .iter()
                .filter_map(|(id, record)| match record {
                    OpRecord::Io {
                        owner: id_owner,
                        _buffer: None,
                        ..
                    }
                    | OpRecord::Timer {
                        owner: id_owner, ..
                    }
                    | OpRecord::RePoll { owner: id_owner }
                        if *id_owner == owner =>
                    {
                        Some(*id)
                    }
                    _ => None,
                })
                .collect();
            let mut transferred = Vec::with_capacity(ids.len());
            for id in ids {
                self.reactor.cancel(id);
                let Some(record) = self.ops.remove(&id) else {
                    continue;
                };
                match record {
                    OpRecord::Io {
                        resolver_id,
                        fd,
                        dir_read,
                        ..
                    } => {
                        let index = if dir_read {
                            &mut self.read_ud_by_fd
                        } else {
                            &mut self.write_ud_by_fd
                        };
                        if index.get(&fd) == Some(&id) {
                            index.remove(&fd);
                        }
                        transferred.push(TransferredOp::Readiness {
                            resolver_id,
                            fd,
                            dir_read,
                        });
                    }
                    OpRecord::Timer {
                        resolver_id,
                        timer_id,
                        deadline,
                        referenced,
                        ..
                    } => {
                        self.timer_to_op.remove(&timer_id);
                        transferred.push(TransferredOp::Timer {
                            resolver_id,
                            timer_id,
                            deadline,
                            referenced,
                        });
                    }
                    OpRecord::RePoll { .. } => transferred.push(TransferredOp::RePoll),
                    OpRecord::Write { .. } => unreachable!(),
                }
            }
            transferred
        }

        fn attach_operations(&mut self, owner: u64, operations: Vec<TransferredOp>) {
            for operation in operations {
                let id = self.next_op();
                match operation {
                    TransferredOp::Readiness {
                        resolver_id,
                        fd,
                        dir_read,
                    } => {
                        let op = if dir_read {
                            Op::PollIn {
                                src: Source::fd(fd),
                            }
                        } else {
                            Op::PollOut {
                                src: Source::fd(fd),
                            }
                        };
                        unsafe { self.reactor.submit(id, op) };
                        if dir_read {
                            self.read_ud_by_fd.insert(fd, id);
                        } else {
                            self.write_ud_by_fd.insert(fd, id);
                        }
                        self.ops.insert(
                            id,
                            OpRecord::Io {
                                owner,
                                resolver_id,
                                _buffer: None,
                                fd,
                                dir_read,
                            },
                        );
                    }
                    TransferredOp::Timer {
                        resolver_id,
                        timer_id,
                        deadline,
                        referenced,
                    } => {
                        let remaining = deadline
                            .saturating_duration_since(Instant::now())
                            .as_millis() as u64;
                        self.reactor.submit_timeout(id, remaining);
                        self.ops.insert(
                            id,
                            OpRecord::Timer {
                                owner,
                                resolver_id,
                                timer_id,
                                deadline,
                                referenced,
                            },
                        );
                        self.timer_to_op.insert(timer_id, id);
                    }
                    TransferredOp::RePoll => {
                        self.reactor.submit_timeout(id, 25);
                        self.ops.insert(id, OpRecord::RePoll { owner });
                    }
                }
            }
        }

        #[allow(clippy::too_many_arguments)]
        fn place_realm(
            &mut self,
            workload_id: u64,
            entry_path: String,
            rules_json: String,
            realm_data: Option<String>,
            realm_bootstrap_data: Option<String>,
            priority_class: u8,
            port_half: (u32, i32),
        ) {
            // Realm placements ship their complete parent-merged ruleset;
            // tenant workloads ship none and get the tenant sandbox.
            let import_rules: Vec<crate::state::ImportRule> = if rules_json.is_empty() {
                super::tenant_import_rules()
            } else {
                match serde_json::from_str(&rules_json) {
                    Ok(rules) => rules,
                    Err(err) => {
                        self.report(Report::Released {
                            workload_id,
                            reason: format!("setup_failed: bad rules: {err}"),
                        });
                        return;
                    }
                }
            };
            let inner = match setup_realm_workload(
                entry_path,
                self.config.process_env.clone(),
                self.config.package_map_json.clone(),
                self.config.heap_limit_bytes,
                import_rules,
                realm_data,
                realm_bootstrap_data,
                port_half,
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
            let seq = self.next_sequence;
            self.next_sequence += 1;
            inner.install_wake_notifier(self.reactor.notifier(), post_wake(workload_id));
            self.workloads.insert(
                workload_id,
                EngineWorkload {
                    id: workload_id,
                    inner,
                    priority_class,
                    debt_micros: 0.0,
                    sequence: seq,
                    last_sync_heavy_report: None,
                    ready_io: Vec::new(),
                },
            );
            // The realm's bootstrap armed its port watch and wake source
            // during setup — claim those registrations before another
            // workload's pump sweeps the thread-local.
            self.collect_io_registrations(workload_id);
            // A realm runs immediately: its entry import is already pending.
            self.runnable.insert(workload_id);
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

        fn set_current_counts(&self, id: u64) {
            let mut io = 0u32;
            let mut timers = 0u32;
            for rec in self.ops.values() {
                match rec {
                    OpRecord::Io { owner, .. } | OpRecord::Write { owner, .. } if *owner == id => {
                        io += 1
                    }
                    OpRecord::Timer {
                        owner,
                        referenced: true,
                        ..
                    } if *owner == id => timers += 1,
                    _ => {}
                }
            }
            ENGINE_CURRENT_COUNTS.with(|c| c.set((io, timers)));
        }

        fn pump_one(&mut self, id: u64) {
            self.set_current_counts(id);
            let hard = self.config.hard_budget_micros;
            let io_completions: Vec<(usize, f64)> = {
                let w = match self.workloads.get_mut(&id) {
                    Some(w) => w,
                    None => return,
                };
                std::mem::take(&mut w.ready_io)
            };
            let t0 = Instant::now();
            let outcome = {
                let w = self.workloads.get_mut(&id).unwrap();
                pump_realm_native(&mut w.inner, hard, &io_completions)
            };
            let slice_micros = t0.elapsed().as_micros() as f64;
            self.collect_io_registrations(id);
            {
                let w = self.workloads.get_mut(&id).unwrap();
                w.debt_micros += slice_micros;
                let report_due = w
                    .last_sync_heavy_report
                    .map(|last| last.elapsed() >= Duration::from_millis(250))
                    .unwrap_or(true);
                if report_due && slice_micros > self.config.sync_slice_micros as f64 {
                    w.last_sync_heavy_report = Some(Instant::now());
                    self.report(Report::SyncHeavy {
                        workload_id: id,
                        cpu_micros: slice_micros,
                    });
                }
            }
            match outcome {
                PumpOutcome::Pending => {}
                PumpOutcome::PendingPoll => {
                    // A dedicated-thread child's progress posts nothing here:
                    // re-pump this realm on a short cadence while it waits.
                    let ud = self.next_op();
                    self.reactor.submit_timeout(ud, 25);
                    self.ops.insert(ud, OpRecord::RePoll { owner: id });
                }
                PumpOutcome::Settled { result } => self.release(id, result),
                PumpOutcome::Terminated => self.release(id, "terminated".to_string()),
                PumpOutcome::Rejected(msg) => self.release(id, format!("failed: {msg}")),
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
                                self.write_ud_by_fd.insert(io.fd, ud);
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
                                let dir_read = !matches!(io.kind, IoKind::Writable);
                                // Supersede: the newest bare-readiness waiter
                                // owns the fd's watch — cancel a previous POLL
                                // op (its promise never settles; a stale one
                                // may even be a ghost of a closed fd number).
                                // Fused ops with kernel-owned buffers are not
                                // superseded.
                                let index = if dir_read {
                                    &mut self.read_ud_by_fd
                                } else {
                                    &mut self.write_ud_by_fd
                                };
                                if let Some(old) = index.get(&io.fd).copied()
                                    && matches!(
                                        self.ops.get(&old),
                                        Some(OpRecord::Io { _buffer: None, .. })
                                    )
                                {
                                    self.reactor.cancel(old);
                                    self.ops.remove(&old);
                                }
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
                                if dir_read {
                                    self.read_ud_by_fd.insert(io.fd, ud);
                                } else {
                                    self.write_ud_by_fd.insert(io.fd, ud);
                                }
                                self.ops.insert(
                                    ud,
                                    OpRecord::Io {
                                        owner: id,
                                        resolver_id: io.resolver_id,
                                        _buffer: io.buffer,
                                        fd: io.fd,
                                        dir_read,
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
                                deadline: Instant::now() + Duration::from_millis(ms.max(0) as u64),
                                referenced: true,
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
                    EngineReg::SetTimerRef {
                        timer_id,
                        referenced,
                    } => {
                        if let Some(ud) = self.timer_to_op.get(&timer_id) {
                            if let Some(OpRecord::Timer {
                                referenced: current,
                                ..
                            }) = self.ops.get_mut(ud)
                            {
                                *current = referenced;
                            }
                        }
                    }
                    EngineReg::RemoveRead { fd } => self.remove_watch(fd, true),
                    EngineReg::RemoveWrite { fd } => self.remove_watch(fd, false),
                }
            }
        }

        /// Abandon the indexed watch on `fd` (loop removeRead/removeWrite):
        /// cancel the armed op; pointer-carrying records are doomed until
        /// their CANCELED completion is harvested.
        fn remove_watch(&mut self, fd: i32, dir_read: bool) {
            let index = if dir_read {
                &mut self.read_ud_by_fd
            } else {
                &mut self.write_ud_by_fd
            };
            let Some(ud) = index.remove(&fd) else { return };
            self.reactor.cancel(ud);
            if let Some(rec) = self.ops.remove(&ud) {
                let has_pointers = match &rec {
                    OpRecord::Io { _buffer, .. } => _buffer.is_some(),
                    OpRecord::Write { .. } => true,
                    _ => false,
                };
                if has_pointers {
                    self.doomed.insert(ud, rec);
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
            let owner_for_drain = match &rec {
                OpRecord::Io { owner, .. }
                | OpRecord::Write { owner, .. }
                | OpRecord::Timer { owner, .. }
                | OpRecord::RePoll { owner } => *owner,
            };
            match rec {
                OpRecord::Io {
                    owner,
                    resolver_id,
                    _buffer,
                    fd,
                    dir_read,
                } => {
                    let index = if dir_read {
                        &mut self.read_ud_by_fd
                    } else {
                        &mut self.write_ud_by_fd
                    };
                    if index.get(&fd) == Some(&user_data) {
                        index.remove(&fd);
                    }
                    self.deliver_completion(owner, resolver_id, res as f64);
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
                        self.deliver_completion(owner, resolver_id, res as f64);
                    } else {
                        let new_done = done + res as u32;
                        if new_done >= len {
                            // Buffer fully drained: resolve with the total written.
                            self.deliver_completion(owner, resolver_id, new_done as f64);
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
                    ..
                } => {
                    self.timer_to_op.remove(&timer_id);
                    self.deliver_completion(owner, resolver_id, 0.0);
                }
                OpRecord::RePoll { owner } => {
                    if self.workloads.contains_key(&owner) {
                        self.runnable.insert(owner);
                    } else if let Some(route) = self.forwarded.get(&owner) {
                        route.send(Control::ForwardWake { workload_id: owner });
                    }
                }
            }
            self.finish_forwarding_if_drained(owner_for_drain);
        }

        fn deliver_completion(&mut self, owner: u64, resolver_id: usize, result: f64) {
            if let Some(workload) = self.workloads.get_mut(&owner) {
                workload.ready_io.push((resolver_id, result));
                self.runnable.insert(owner);
            } else if let Some(route) = self.forwarded.get(&owner) {
                route.send(Control::ForwardCompletion {
                    workload_id: owner,
                    resolver_id,
                    result,
                });
            }
        }

        fn finish_forwarding_if_drained(&mut self, owner: u64) {
            if !self.forwarded.contains_key(&owner) {
                return;
            }
            let pending = self.ops.values().any(|record| match record {
                OpRecord::Io { owner: id, .. }
                | OpRecord::Write { owner: id, .. }
                | OpRecord::Timer { owner: id, .. }
                | OpRecord::RePoll { owner: id } => *id == owner,
            }) || self.doomed.values().any(|record| match record {
                OpRecord::Io { owner: id, .. }
                | OpRecord::Write { owner: id, .. }
                | OpRecord::Timer { owner: id, .. }
                | OpRecord::RePoll { owner: id } => *id == owner,
            });
            if !pending {
                self.forwarded.remove(&owner);
                self.report(Report::Detached { workload_id: owner });
            }
        }

        /// Route one harvest: Notifier posts by tag, ops through their record.
        fn route(&mut self, user_data: u64, res: i32) {
            if user_data & POST_FLAG != 0 {
                if user_data & POST_WAKE_BIT != 0 {
                    // A tenant's background wake: mark it runnable. Stale posts
                    // for released workloads fall through harmlessly.
                    let id = user_data & !(POST_FLAG | POST_WAKE_BIT);
                    if self.workloads.contains_key(&id) {
                        self.runnable.insert(id);
                    } else if let Some(route) = self.forwarded.get(&id) {
                        route.send(Control::ForwardWake { workload_id: id });
                    }
                }
                // POST_CONTROL: the wait broke; drain_control() at the top of
                // the loop empties the mpsc.
                return;
            }
            self.on_completion(user_data, res);
        }

        /// Cancel every op this workload owns. Pointer-free records (timers,
        /// readiness) are dropped eagerly — their CANCELED completion finds no
        /// record and is ignored. Pointer-carrying records (fused reads,
        /// writes) retain the tenant's ArrayBuffer and move to `doomed`: the
        /// reactor may still hand their pointers to the kernel until the
        /// CANCELED completion is harvested, so the buffer — and the isolate
        /// that owns its memory — must stay alive until then.
        fn cancel_owned(&mut self, id: u64) {
            let owned: Vec<u64> = self
                .ops
                .iter()
                .filter(|(_, rec)| match rec {
                    OpRecord::Io { owner, .. }
                    | OpRecord::Write { owner, .. }
                    | OpRecord::Timer { owner, .. }
                    | OpRecord::RePoll { owner } => *owner == id,
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
                    self.route(c.user_data, c.res);
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
                self.route(c.user_data, c.res);
            }
            self.scratch = buf;
        }

        fn report_load_if_changed(&mut self) {
            let held = self.workloads.len() as u32;
            let runnable = self.runnable.len() as u32;
            let debt_micros = self
                .workloads
                .values()
                .map(|workload| workload.debt_micros)
                .sum::<f64>();
            let debt_band = (debt_micros / 10_000.0).min(u32::MAX as f64) as u32;
            let sig = (held, runnable, debt_band);
            if sig == self.last_load_signature {
                return;
            }
            // Load is advisory telemetry, and `runnable` oscillates on every
            // hot pump — unthrottled, each flip posts a wake that spins the
            // orchestrator's report pump (the legacy 25ms poll absorbed this
            // by accident). Coalesce to ≥10ms unless `held` changed, which
            // placement decisions actually depend on.
            let held_changed = held != self.last_load_signature.0;
            if !held_changed && self.last_load_report.elapsed() < Duration::from_millis(10) {
                return;
            }
            self.last_load_signature = sig;
            self.last_load_report = Instant::now();
            self.report(Report::Load {
                held,
                runnable,
                debt_band,
                debt_micros,
            });
        }

        fn report(&mut self, report: Report) {
            let _ = self.report_tx.send(report);
            // Wake the orchestrator's loop so it drains the report promptly:
            // bump the sequence its drain hook compares, then wake its sink.
            self.report_seq.fetch_add(1, Ordering::Release);
            self.orch_wake.wake();
        }
    }
}

// ===========================================================================
// Public spawn API + shared tenant setup.
// ===========================================================================

/// Spawn a reactor thread and return the orchestrator-side handle. The
/// reactor is created here (on the spawning thread) so its Notifier exists
/// before the thread runs, then moved in — it is `Send` by design.
pub fn spawn_reactor(config: ReactorConfig) -> Result<ReactorHandle, String> {
    let (control_tx, control_rx) = mpsc::channel::<Control>();
    let (report_tx, report_rx) = mpsc::channel::<Report>();
    let reactor =
        cherenkov::Reactor::new().map_err(|e| format!("reactor engine: init failed: {e}"))?;
    let control_notify = reactor.notifier();
    let report_seq = Arc::new(AtomicU64::new(0));
    let orch_wake = crate::async_rt::wake_sink()
        .ok_or_else(|| "reactor engine: async runtime not initialised".to_string())?;

    let thread_seq = Arc::clone(&report_seq);
    let thread_wake = orch_wake.clone();
    let join = std::thread::Builder::new()
        .name("reactor".to_string())
        .spawn(move || {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                imp::run(
                    config,
                    control_rx,
                    report_tx,
                    Arc::clone(&thread_seq),
                    thread_wake.clone(),
                    reactor,
                );
            }));
            // Death signal (normal exit or panic): one final bump + wake so
            // the orchestrator's report pump re-checks reactorAlive.
            thread_seq.fetch_add(1, Ordering::Release);
            thread_wake.wake();
        })
        .map_err(|e| format!("failed to spawn reactor thread: {e}"))?;

    Ok(ReactorHandle {
        control_tx,
        control_notify,
        report_rx,
        report_seq,
        report_seen: Cell::new(0),
        report_waiter: RefCell::new(None),
        join,
    })
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
        "placeRealm",
        "moveRealm",
        "isEngineThread",
        "revoke",
        "shutdown",
        "nextReport",
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
    export!("placeRealm", cb_place_realm);
    export!("moveRealm", cb_move_realm);
    export!("isEngineThread", cb_is_engine_thread);
    export!("revoke", cb_revoke);
    export!("shutdown", cb_shutdown);
    export!("nextReport", cb_next_report);
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
        // A missing key reads as `undefined`, and ToInteger(undefined) is 0 —
        // which would silently zero the default. Absent means default.
        .filter(|v| !v.is_null_or_undefined())
        .and_then(|v| v.integer_value(scope))
        .map(|n| n.max(0) as u64)
        .unwrap_or(default)
}

fn obj_string(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    key: &str,
) -> Option<String> {
    let key = v8::String::new(scope, key)?;
    let value = obj.get(scope, key.into())?;
    if value.is_null_or_undefined() {
        return None;
    }
    value
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
}

fn with_reactor<R>(id: usize, f: impl FnOnce(&ReactorHandle) -> R) -> Option<R> {
    REACTORS.with(|r| r.borrow().get(id).and_then(|h| h.as_ref()).map(f))
}

/// Send a control message and post into the reactor so it acts promptly.
fn send_control(id: usize, msg: Control) {
    with_reactor(id, |h| {
        if h.control_tx.send(msg).is_ok() {
            h.control_notify.post(POST_CONTROL, 0);
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
    let reactor_class = match cfg_obj
        .and_then(|object| obj_string(scope, object, "reactorClass"))
        .as_deref()
    {
        Some("batch") => ReactorClass::Batch,
        _ => ReactorClass::Latency,
    };

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
        reactor_class,
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

/// JS: `isEngineThread(): boolean` — whether this realm is hosted on an
/// engine (scheduler) thread. Engine-hosted realms must not spawn reactors
/// of their own; the allocator uses this to fall back to dedicated threads.
fn cb_is_engine_thread(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Boolean::new(scope, engine_io_active()).into());
}

/// JS: `placeRealm(reactorId, workloadId, entryPath, rulesJson, realmData |
/// '', bootstrapData | '', priorityClass) → { portHandle, portWakeFd }`
///
/// Creates the realm's channel pair on the calling (orchestrator) thread,
/// ships the child half to the engine thread inside the PlaceRealm control,
/// and returns the parent half — the caller constructs the Realm's port
/// over it exactly as it would for a dedicated-thread realm.
fn cb_place_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    let entry_path = arg_str(scope, &args, 2);
    let rules_json = arg_str(scope, &args, 3);
    let realm_data = {
        let s = arg_str(scope, &args, 4);
        if s.is_empty() { None } else { Some(s) }
    };
    let realm_bootstrap_data = {
        let s = arg_str(scope, &args, 5);
        if s.is_empty() { None } else { Some(s) }
    };
    let priority_class = arg_u64(scope, &args, 6) as u8;

    let (parent_half, child_half) = match crate::realm::transit::create_halves() {
        Ok(pair) => pair,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("placeRealm: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };
    let parent_wake_fd = parent_half.wake_read_fd;
    let child_wake_fd = child_half.wake_read_fd;
    let parent_handle = crate::realm::transit::register_half(parent_half);
    let child_handle = crate::realm::transit::register_half(child_half);

    send_control(
        id,
        Control::PlaceRealm {
            workload_id,
            entry_path,
            rules_json,
            realm_data,
            realm_bootstrap_data,
            priority_class,
            port_half: (child_handle, child_wake_fd),
        },
    );

    let obj = v8::Object::new(scope);
    let k = v8::String::new(scope, "portHandle").unwrap();
    let v = v8::Number::new(scope, parent_handle as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "portWakeFd").unwrap();
    let v = v8::Number::new(scope, parent_wake_fd as f64);
    obj.set(scope, k.into(), v.into());
    rv.set(obj.into());
}

/// JS: `moveRealm(sourceReactorId, destinationReactorId, workloadId)`.
/// Detachment and attachment happen asynchronously on the two reactor loops;
/// the destination emits a `moved` report once it owns the isolate.
fn cb_move_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let source_id = arg_u64(scope, &args, 0) as usize;
    let destination_id = arg_u64(scope, &args, 1) as usize;
    let workload_id = arg_u64(scope, &args, 2);
    let destination = with_reactor(destination_id, |handle| {
        (handle.control_tx.clone(), handle.control_notify.clone())
    });
    let Some((destination_tx, destination_notify)) = destination else {
        let message = v8::String::new(scope, "moveRealm: destination reactor not found").unwrap();
        let exception = v8::Exception::error(scope, message);
        scope.throw_exception(exception);
        return;
    };
    send_control(
        source_id,
        Control::Move {
            workload_id,
            destination_tx,
            destination_notify,
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

fn cb_shutdown(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    send_control(id, Control::Shutdown);
}

/// `nextReport(reactorId)`: a promise resolved when the reactor thread posts
/// its next load report — or immediately, if reports (or the thread's death)
/// arrived while unarmed, so no wake is ever lost. Replaces the report wake
/// pipe the orchestrator used to `readable()` on.
fn cb_next_report(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());
    let resolve_now = REACTORS.with(|r| {
        let borrow = r.borrow();
        let Some(h) = borrow.get(id).and_then(|h| h.as_ref()) else {
            // Unknown reactor: resolve so the caller's loop re-checks and exits.
            return true;
        };
        let seq = h.report_seq.load(Ordering::Acquire);
        if seq != h.report_seen.get() || h.join.is_finished() {
            h.report_seen.set(seq);
            true
        } else {
            *h.report_waiter.borrow_mut() = Some(v8::Global::new(scope, resolver));
            false
        }
    });
    if resolve_now {
        let undef = v8::undefined(scope).into();
        resolver.resolve(scope, undef);
    }
}

/// Resolve armed `nextReport()` waiters whose reactors have advanced (a new
/// report, or thread death). Called from `async_rt::drain_all` on every pump —
/// cheap on non-orchestrator threads (their registry is empty).
pub(crate) fn drain_report_wakes(scope: &mut v8::HandleScope) -> bool {
    let waiters: Vec<v8::Global<v8::PromiseResolver>> = REACTORS.with(|r| {
        let borrow = r.borrow();
        let mut out = Vec::new();
        for h in borrow.iter().flatten() {
            let seq = h.report_seq.load(Ordering::Acquire);
            if (seq != h.report_seen.get() || h.join.is_finished())
                && let Some(g) = h.report_waiter.borrow_mut().take()
            {
                // Only consume the advance when a waiter is armed — otherwise
                // the next nextReport() resolves immediately off the delta.
                h.report_seen.set(seq);
                out.push(g);
            }
        }
        out
    });
    if waiters.is_empty() {
        return false;
    }
    for g in &waiters {
        let resolver = v8::Local::new(scope, g);
        let undef = v8::undefined(scope).into();
        resolver.resolve(scope, undef);
    }
    true
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
    let reports: Vec<Report> = REACTORS.with(|r| {
        let borrow = r.borrow();
        let handle = match borrow.get(id).and_then(|h| h.as_ref()) {
            Some(h) => h,
            None => return Vec::new(),
        };
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

fn set_bool(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, val: bool) {
    let k = v8::String::new(scope, key).unwrap();
    let v = v8::Boolean::new(scope, val);
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
        Report::Moved { workload_id } => {
            set_str(scope, obj, "type", "moved");
            set_num(scope, obj, "workloadId", workload_id as f64);
        }
        Report::Detached { workload_id } => {
            set_str(scope, obj, "type", "detached");
            set_num(scope, obj, "workloadId", workload_id as f64);
        }
        Report::Started {
            reactor_class,
            priority_applied,
        } => {
            set_str(scope, obj, "type", "started");
            set_str(scope, obj, "reactorClass", reactor_class.as_str());
            set_bool(scope, obj, "priorityApplied", priority_applied);
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
            debt_micros,
        } => {
            set_str(scope, obj, "type", "load");
            set_num(scope, obj, "held", held as f64);
            set_num(scope, obj, "runnable", runnable as f64);
            set_num(scope, obj, "debtBand", debt_band as f64);
            set_num(scope, obj, "debtMicros", debt_micros);
        }
    }
    obj
}
