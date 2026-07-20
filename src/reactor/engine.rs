//! Native per-thread reactor engine.
//!
//! A reactor thread hosts N realm workloads and pumps them in priority order.
//! Every assigned realm is constructed through the same bootstrap
//! (`workload::setup_realm_workload`) and driven through its native loop hooks.
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock, mpsc};
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

/// A stable message-passing route whose physical Cherenkov target can be
/// replaced without changing the logical reactor handle held by orchestration
/// or peer reactors.
#[derive(Clone)]
pub(crate) struct ReactorNotifier(Arc<RwLock<cherenkov::Notifier>>);

impl ReactorNotifier {
    fn new(notifier: cherenkov::Notifier) -> Self {
        Self(Arc::new(RwLock::new(notifier)))
    }

    fn replace(&self, notifier: cherenkov::Notifier) {
        *self.0.write().unwrap_or_else(|error| error.into_inner()) = notifier;
    }

    fn current(&self) -> cherenkov::Notifier {
        self.0
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn post(&self, user_data: u64, result: i32) -> bool {
        self.0
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .post(user_data, result)
    }
}

use crate::state::ProcessEnv;

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
        watch_mode: bool,
        repl_mode: bool,
        priority_class: u8,
        /// The child-side channel half (transit handle + wake-pipe read fd).
        port_half: (u32, i32),
        /// Private parent/child allocator-control channel half.
        allocation_half: (u32, i32),
    },
    /// Terminate + release a workload.
    Revoke { workload_id: u64, reason: String },
    /// Detach an exited isolate and ship exclusive ownership to another
    /// reactor thread. Existing source-hosted operations forward completions.
    Move {
        workload_id: u64,
        destination_tx: mpsc::Sender<Control>,
        destination_notify: ReactorNotifier,
    },
    /// Pre-announce a move before its wake route can target the destination.
    ExpectAttach { workload_id: u64 },
    /// Withdraw a pre-announcement after a failed attach send.
    CancelAttach { workload_id: u64 },
    /// Attach an isolate detached by another reactor.
    Attach { workload: imp::TransferWorkload },
    /// Completion of an operation still draining on a prior reactor.
    ForwardCompletion {
        workload_id: u64,
        resolver_id: usize,
        result: f64,
    },
    /// Test-only fault injection: panic when this workload next enters its
    /// pump boundary. The panic exercises the same recovery path as an
    /// unexpected unwind from isolate execution.
    CrashRealm { workload_id: u64 },
    /// Stop the reactor loop and dispose all hosted isolates.
    Shutdown,
}

/// Report messages: reactor thread → orchestrator (main thread).
pub enum Report {
    /// A workload reached a terminal state (settled terminal / rejected / revoked).
    Released { workload_id: u64, reason: String },
    /// A live isolate was attached after moving from another reactor.
    Moved { workload_id: u64 },
    /// A live move was refused because the isolate owns thread-affine state.
    MoveRejected {
        workload_id: u64,
        reason: &'static str,
    },
    /// A synchronous slice exceeded the soft threshold — migrate to a batch thread.
    SyncHeavy { workload_id: u64, cpu_micros: f64 },
    /// Coarse load signature changed (held : runnable : debt-band).
    Load {
        held: u32,
        runnable: u32,
        debt_micros: f64,
    },
}

/// Orchestrator-side handle to a spawned reactor thread. `join` is held for the
/// thread's lifetime (dropping it would detach the thread).
#[allow(dead_code)]
pub struct ReactorHandle {
    pub control_tx: mpsc::Sender<Control>,
    /// Posted (`POST_CONTROL`) after a control send to break the reactor's wait.
    pub(crate) control_notify: ReactorNotifier,
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
    /// Logical liveness spans physical worker replacement.
    pub alive: Arc<AtomicBool>,
    /// Physical worker generation, starting at one.
    pub generation: Arc<AtomicU64>,
    pub join: JoinHandle<()>,
}

// ===========================================================================
// Workload-to-engine I/O registration.
//
// A realm's `internal:io` operations register directly with the engine's shared
// `RuntimeIo`. Completions carry workload-local resolver identifiers and are
// delivered during that realm's next pump.
//
// The buffer is realm-provided (the workload's ArrayBuffer) — the reactor never
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

/// One outstanding fd-keyed reactor op registered by a workload during a pump.
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

/// A registration a workload hands the engine during a pump.
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
    Proc {
        pid: u32,
        resolver_id: usize,
    },
    /// A persistent generic wake pipe: drain on readability and re-arm.
    WakeSource {
        fd: i32,
    },
    AddVnode {
        fd: i32,
        path: std::path::PathBuf,
        callback_id: usize,
    },
    RemoveVnode {
        fd: i32,
    },
    AddSignal {
        signo: i32,
        callback_id: usize,
    },
    RemoveSignal {
        signo: i32,
    },
}

thread_local! {
    /// Direct access to the engine thread's I/O resources while a workload is
    /// entered. `EngineResources` is boxed so this pointer remains stable;
    /// callbacks touch only this disjoint allocation, never the borrowed
    /// workload map.
    static ENGINE_CONTEXT: Cell<(*mut imp::EngineResources, u64)> = const {
        Cell::new((std::ptr::null_mut(), 0))
    };
    /// Monotonic timer id source for engine-mode timers.
    static ENGINE_TIMER_SEQ: RefCell<u64> = const { RefCell::new(1) };
}

#[derive(Clone, Copy)]
pub(crate) struct EngineCounts {
    pub reads: u32,
    pub writes: u32,
    pub timers: u32,
    pub procs: u32,
    pub vnodes: u32,
}

impl EngineCounts {
    const ZERO: Self = Self {
        reads: 0,
        writes: 0,
        timers: 0,
        procs: 0,
        vnodes: 0,
    };

    pub fn total(self) -> u32 {
        self.reads + self.writes + self.timers + self.procs + self.vnodes
    }
}

/// The pumping workload's engine-held handle counts. Zero off-engine.
pub(crate) fn engine_current_counts() -> EngineCounts {
    ENGINE_CONTEXT.with(|context| {
        let (resources, owner) = context.get();
        if resources.is_null() || owner == 0 {
            EngineCounts::ZERO
        } else {
            // SAFETY: `run` installs the stable address of its boxed resources
            // for this thread and clears it before that allocation is dropped.
            unsafe { (*resources).counts(owner) }
        }
    })
}

/// Whether the current thread is a reactor engine thread, so `internal:io`
/// operations register with its shared reactor resources.
pub(crate) fn engine_io_active() -> bool {
    ENGINE_CONTEXT.with(|context| !context.get().0.is_null())
}

/// Register an outstanding reactor op (called from an `internal:io` op during a
/// pump). Registration is immediate so watches are armed before JavaScript can
/// trigger them later in the same pump.
pub(crate) fn engine_io_register(reg: EngineReg) {
    ENGINE_CONTEXT.with(|context| {
        let (resources, owner) = context.get();
        assert!(
            !resources.is_null() && owner != 0,
            "engine registration outside a workload pump"
        );
        // SAFETY: see `engine_current_counts`; the active pump borrows the
        // separate workloads field, not `resources`.
        unsafe { (*resources).apply_registration(owner, reg) };
    });
}

/// Select which workload owns registrations made by the currently entered
/// isolate. The engine resource pointer remains unchanged for the thread.
fn set_engine_owner(owner: u64) {
    ENGINE_CONTEXT.with(|context| {
        let (resources, _) = context.get();
        context.set((resources, owner));
    });
}

/// Restores the previous workload owner whenever an isolate-facing operation
/// returns or unwinds.
struct EngineOwnerScope {
    previous: u64,
}

impl EngineOwnerScope {
    fn enter(owner: u64) -> Self {
        let previous = ENGINE_CONTEXT.with(|context| {
            let (resources, previous) = context.get();
            context.set((resources, owner));
            previous
        });
        Self { previous }
    }
}

impl Drop for EngineOwnerScope {
    fn drop(&mut self) {
        set_engine_owner(self.previous);
    }
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
    use crate::reactor::workload::{
        ActiveWorkload, ParkedWorkload, PumpOutcome, activate_realm_native,
        deactivate_realm_native, drop_parked, pump_realm_native, setup_realm_workload,
    };
    use cherenkov::{Completion, Reactor, WatchId, err, fs_event};
    use std::collections::{HashMap, HashSet};
    use std::time::{Duration, Instant};

    pub(super) fn select_next_id(
        runnable: &HashSet<u64>,
        mut compare: impl FnMut(u64, u64) -> std::cmp::Ordering,
    ) -> Option<u64> {
        runnable.iter().copied().min_by(|a, b| compare(*a, *b))
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
        ready_events: Vec<crate::reactor::workload::ReactorEvent>,
        /// Internal fault-injection latch used by the recovery integration
        /// test. It is consumed inside the isolate pump boundary.
        crash_on_next_pump: bool,
    }

    /// Exclusive ownership of an exited isolate while it crosses a native
    /// channel. `ParkedWorkload` is intentionally !Send in rusty_v8; this is
    /// the single audited boundary that moves it after all V8 scopes are gone.
    pub(crate) struct TransferWorkload {
        workload: EngineWorkload,
        operations: Vec<crate::reactor::io::Transfer>,
    }

    // SAFETY: the source removes the workload from its maps before constructing
    // this value and never accesses it again. The destination marks the isolate
    // as cross-thread before entering it under V8's Locker.
    unsafe impl Send for TransferWorkload {}

    /// A complete logical-reactor working set crossing from a failed physical
    /// worker to its replacement. Every surviving isolate is parked and no V8
    /// scope is live when this value is constructed.
    pub(super) struct RecoveryWorkset(ReactorThread);

    // SAFETY: `recover_failed_workload` removes and disposes the only entered
    // isolate before constructing this value. The remaining isolates obey the
    // same parked-isolate transfer invariant as `TransferWorkload`; RuntimeIo
    // is exclusively owned and its old Cherenkov backend is canceled and
    // replaced before any survivor resumes.
    unsafe impl Send for RecoveryWorkset {}

    #[derive(Clone)]
    struct ForwardRoute {
        tx: mpsc::Sender<Control>,
        notify: ReactorNotifier,
    }

    impl ForwardRoute {
        fn send(&self, message: Control) -> Result<(), Control> {
            self.tx.send(message).map_err(|error| error.0)?;
            self.notify.post(POST_CONTROL, 0);
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    enum ExternalRecord {
        Proc {
            owner: u64,
            pid: u32,
            resolver_id: usize,
        },
        VnodeNext {
            owner: u64,
            fd: i32,
            /// The WatchId this op was armed on. Validated at delivery so a
            /// stale in-flight event (or its re-arm) from a closed fd cannot
            /// route to the fresh watch a reused fd number now keys.
            watch: WatchId,
        },
        SignalNext {
            owner: u64,
            signo: i32,
            watch: WatchId,
        },
        RePoll {
            owner: u64,
        },
        WakeSource {
            owner: u64,
            fd: i32,
        },
    }

    struct VnodeEntry {
        owner: u64,
        watch: WatchId,
        path: std::path::PathBuf,
        callback_id: usize,
    }

    struct SignalEntry {
        owner: u64,
        watch: WatchId,
        callback_id: usize,
    }

    /// What an external-record completion delivers to its owner.
    pub(super) enum ExternalDelivery {
        ProcExit {
            resolver_id: usize,
        },
        Callback {
            callback_id: usize,
            fflags: Option<u32>,
        },
        Repoll,
        /// A wake pipe fired (and was drained + re-armed): nothing to
        /// deliver, but the owner should re-check its queues.
        Wake,
    }

    /// A completion harvested inside a workload's in-pump `tick()` that
    /// belongs to another owner (or to the drive loop). The drive loop routes
    /// these after the pump returns.
    pub(super) enum Deferred {
        /// A notifier post (wake or control poke).
        Post {
            user_data: u64,
            res: i32,
        },
        Resolve {
            owner: u64,
            resolver_id: usize,
            result: f64,
        },
        Event {
            owner: u64,
            event: crate::reactor::workload::ReactorEvent,
        },
        Runnable {
            owner: u64,
        },
    }

    pub(super) struct EngineResources {
        io: crate::reactor::io::RuntimeIo,
        external: HashMap<u64, ExternalRecord>,
        vnodes: HashMap<(u64, i32), VnodeEntry>,
        signals: HashMap<(u64, i32), SignalEntry>,
        /// Foreign completions harvested by an in-pump `tick()`; drained by
        /// the drive loop between pumps.
        deferred: Vec<Deferred>,
    }

    impl EngineResources {
        pub(super) fn counts(&self, owner: u64) -> EngineCounts {
            let counts = self.io.counts(crate::reactor::io::Owner::Workload(owner));
            EngineCounts {
                reads: counts.reads,
                writes: counts.writes,
                timers: counts.timers,
                procs: self
                    .external
                    .values()
                    .filter(|record| {
                        matches!(record, ExternalRecord::Proc { owner: id, .. } if *id == owner)
                    })
                    .count() as u32,
                vnodes: self
                    .vnodes
                    .values()
                    .filter(|entry| entry.owner == owner)
                    .count() as u32,
            }
        }

        pub(super) fn apply_registration(&mut self, owner_id: u64, reg: EngineReg) {
            let owner = crate::reactor::io::Owner::Workload(owner_id);
            match reg {
                EngineReg::Io(io) => {
                    let target = crate::reactor::io::Target::Workload {
                        id: owner_id,
                        resolver_id: io.resolver_id,
                    };
                    match io.kind {
                        IoKind::Read => self.io.submit_read(
                            owner,
                            target,
                            io.buffer.expect("engine read missing backing store"),
                            io.fd,
                            io.buf_ptr,
                            io.len,
                        ),
                        IoKind::Write => self.io.submit_write(
                            owner,
                            target,
                            io.buffer.expect("engine write missing backing store"),
                            io.fd,
                            io.buf_ptr,
                            io.len,
                            io.written,
                        ),
                        IoKind::Readable => self.io.submit_readiness(owner, target, io.fd, true),
                        IoKind::Writable => self.io.submit_readiness(owner, target, io.fd, false),
                    }
                }
                EngineReg::Timer {
                    timer_id,
                    ms,
                    resolver_id,
                } => self.io.submit_timer(
                    owner,
                    crate::reactor::io::Target::Workload {
                        id: owner_id,
                        resolver_id,
                    },
                    timer_id,
                    ms.max(0) as u64,
                    true,
                ),
                EngineReg::CancelTimer { timer_id } => self.io.cancel_timer(timer_id),
                EngineReg::SetTimerRef {
                    timer_id,
                    referenced,
                } => self.io.set_timer_ref(timer_id, referenced),
                EngineReg::RemoveRead { fd } => self.io.remove_read(fd),
                EngineReg::RemoveWrite { fd } => self.io.remove_write(fd),
                EngineReg::Proc { pid, resolver_id } => {
                    let op = self.io.next_external_id();
                    self.io.submit_proc_exit(op, pid);
                    self.external.insert(
                        op,
                        ExternalRecord::Proc {
                            owner: owner_id,
                            pid,
                            resolver_id,
                        },
                    );
                }
                EngineReg::WakeSource { fd } => self.arm_wake_source(owner_id, fd),
                EngineReg::AddVnode {
                    fd,
                    path,
                    callback_id,
                } => self.add_vnode(owner_id, fd, path, callback_id),
                EngineReg::RemoveVnode { fd } => self.remove_vnode(owner_id, fd),
                EngineReg::AddSignal { signo, callback_id } => {
                    self.add_signal(owner_id, signo, callback_id)
                }
                EngineReg::RemoveSignal { signo } => self.remove_signal(owner_id, signo),
            }
        }

        fn add_vnode(&mut self, owner: u64, fd: i32, path: std::path::PathBuf, callback_id: usize) {
            self.remove_vnode(owner, fd);
            let Ok(watch) = self.io.add_fs_watch(&path, fs_event::ALL) else {
                crate::async_rt::js_calls::unregister_callback(callback_id);
                return;
            };
            let op = self.io.next_external_id();
            self.io.submit_watch_next(op, watch);
            self.external
                .insert(op, ExternalRecord::VnodeNext { owner, fd, watch });
            self.vnodes.insert(
                (owner, fd),
                VnodeEntry {
                    owner,
                    watch,
                    path,
                    callback_id,
                },
            );
        }

        fn remove_vnode(&mut self, owner: u64, fd: i32) {
            if let Some(entry) = self.vnodes.remove(&(owner, fd)) {
                let _ = self.io.remove_kernel_watch(entry.watch);
                crate::async_rt::js_calls::unregister_callback(entry.callback_id);
            }
        }

        fn add_signal(&mut self, owner: u64, signo: i32, callback_id: usize) {
            self.remove_signal(owner, signo);
            let Ok(watch) = self.io.add_signal_watch(signo) else {
                crate::async_rt::js_calls::unregister_callback(callback_id);
                return;
            };
            let op = self.io.next_external_id();
            self.io.submit_watch_next(op, watch);
            self.external.insert(
                op,
                ExternalRecord::SignalNext {
                    owner,
                    signo,
                    watch,
                },
            );
            self.signals.insert(
                (owner, signo),
                SignalEntry {
                    owner,
                    watch,
                    callback_id,
                },
            );
        }

        fn remove_signal(&mut self, owner: u64, signo: i32) {
            if let Some(entry) = self.signals.remove(&(owner, signo)) {
                let _ = self.io.remove_kernel_watch(entry.watch);
                crate::async_rt::js_calls::unregister_callback(entry.callback_id);
            }
        }

        fn arm_wake_source(&mut self, owner: u64, fd: i32) {
            let op = self.io.next_external_id();
            self.io.submit_external(
                op,
                cherenkov::Op::PollIn {
                    src: cherenkov::Source::fd(fd),
                },
            );
            self.external
                .insert(op, ExternalRecord::WakeSource { owner, fd });
        }

        /// Route one `Dispatch::External` completion through its record:
        /// tear down errored watches, re-arm surviving ones, and return what
        /// (if anything) to deliver to which owner. Shared by the drive
        /// loop's `on_completion` and the in-pump `engine_tick`.
        pub(super) fn route_external(
            &mut self,
            user_data: u64,
            res: i32,
        ) -> Option<(u64, ExternalDelivery)> {
            let record = self.external.remove(&user_data)?;
            match record {
                ExternalRecord::Proc {
                    owner, resolver_id, ..
                } => Some((owner, ExternalDelivery::ProcExit { resolver_id })),
                ExternalRecord::VnodeNext { owner, fd, watch } => {
                    if res == err::CANCELED || res == err::BUSY {
                        return None;
                    }
                    // A reused fd number keys a FRESH watch: a stale
                    // completion armed on the old watch must neither tear it
                    // down nor deliver to it.
                    let live = self
                        .vnodes
                        .get(&(owner, fd))
                        .is_some_and(|entry| entry.watch == watch);
                    if !live {
                        return None;
                    }
                    if res < 0 {
                        self.vnodes.remove(&(owner, fd));
                        return None;
                    }
                    let entry = self.vnodes.get(&(owner, fd))?;
                    let callback_id = entry.callback_id;
                    let op = self.io.next_external_id();
                    self.io.submit_watch_next(op, watch);
                    self.external
                        .insert(op, ExternalRecord::VnodeNext { owner, fd, watch });
                    Some((
                        owner,
                        ExternalDelivery::Callback {
                            callback_id,
                            fflags: Some(super::super::imp::fs_to_note(res)),
                        },
                    ))
                }
                ExternalRecord::SignalNext {
                    owner,
                    signo,
                    watch,
                } => {
                    let live = self
                        .signals
                        .get(&(owner, signo))
                        .is_some_and(|entry| entry.watch == watch);
                    if res < 0 {
                        if live && res != err::CANCELED && res != err::BUSY {
                            self.signals.remove(&(owner, signo));
                        }
                        return None;
                    }
                    if !live {
                        return None;
                    }
                    let entry = self.signals.get(&(owner, signo))?;
                    let callback_id = entry.callback_id;
                    let op = self.io.next_external_id();
                    self.io.submit_watch_next(op, watch);
                    self.external.insert(
                        op,
                        ExternalRecord::SignalNext {
                            owner,
                            signo,
                            watch,
                        },
                    );
                    Some((
                        owner,
                        ExternalDelivery::Callback {
                            callback_id,
                            fflags: None,
                        },
                    ))
                }
                ExternalRecord::RePoll { owner } => Some((owner, ExternalDelivery::Repoll)),
                ExternalRecord::WakeSource { owner, fd } => {
                    if res < 0 {
                        // Canceled or errored: drop the wake source.
                        return None;
                    }
                    // Drain the pipe; EOF (write end closed) retires the
                    // source — re-arming a drained-EOF fd would
                    // complete-readable forever.
                    let mut buf = [0u8; 64];
                    let eof = loop {
                        let n = unsafe {
                            libc::read(fd, buf.as_mut_ptr() as *mut std::ffi::c_void, buf.len())
                        };
                        if n == 0 {
                            break true;
                        }
                        if n < 0 {
                            break false;
                        }
                    };
                    if !eof {
                        self.arm_wake_source(owner, fd);
                    }
                    Some((owner, ExternalDelivery::Wake))
                }
            }
        }

        fn replace_reactor(&mut self, reactor: Reactor) {
            self.io.replace_reactor(reactor);

            let mut invalid_vnodes = Vec::new();
            for (key, entry) in &mut self.vnodes {
                match self.io.add_fs_watch(&entry.path, fs_event::ALL) {
                    Ok(watch) => entry.watch = watch,
                    Err(_) => invalid_vnodes.push(*key),
                }
            }
            for key in invalid_vnodes {
                if let Some(entry) = self.vnodes.remove(&key) {
                    crate::async_rt::js_calls::unregister_callback(entry.callback_id);
                }
                self.external.retain(|_, record| {
                    !matches!(record, ExternalRecord::VnodeNext { owner, fd, .. } if (*owner, *fd) == key)
                });
            }

            let mut invalid_signals = Vec::new();
            for (key, entry) in &mut self.signals {
                match self.io.add_signal_watch(key.1) {
                    Ok(watch) => entry.watch = watch,
                    Err(_) => invalid_signals.push(*key),
                }
            }
            for key in invalid_signals {
                if let Some(entry) = self.signals.remove(&key) {
                    crate::async_rt::js_calls::unregister_callback(entry.callback_id);
                }
                self.external.retain(|_, record| {
                    !matches!(record, ExternalRecord::SignalNext { owner, signo, .. } if (*owner, *signo) == key)
                });
            }

            for (&id, record) in self.external.iter_mut() {
                match record {
                    ExternalRecord::Proc { pid, .. } => self.io.submit_proc_exit(id, *pid),
                    ExternalRecord::VnodeNext { owner, fd, watch } => {
                        // The rebuilt watch has a fresh WatchId; the armed
                        // record must carry it or delivery validation would
                        // treat every event as stale.
                        if let Some(entry) = self.vnodes.get(&(*owner, *fd)) {
                            *watch = entry.watch;
                            self.io.submit_watch_next(id, entry.watch);
                        }
                    }
                    ExternalRecord::SignalNext {
                        owner,
                        signo,
                        watch,
                    } => {
                        if let Some(entry) = self.signals.get(&(*owner, *signo)) {
                            *watch = entry.watch;
                            self.io.submit_watch_next(id, entry.watch);
                        }
                    }
                    ExternalRecord::RePoll { .. } => self.io.submit_external_timeout(id, 25),
                    ExternalRecord::WakeSource { fd, .. } => self.io.submit_external(
                        id,
                        cherenkov::Op::PollIn {
                            src: cherenkov::Source::fd(*fd),
                        },
                    ),
                }
            }
        }
    }

    struct ReactorThread {
        config: ReactorConfig,
        /// The single completion reactor for this thread (cherenkov: io_uring on
        /// Linux, kqueue-emulating-completions on macOS, IOCP on Windows). The
        /// only I/O primitive the engine touches.
        resources: Box<EngineResources>,
        control_rx: mpsc::Receiver<Control>,
        report_tx: mpsc::Sender<Report>,
        /// Bumped once per queued report; the orchestrator's drain hook turns
        /// an advance into a `nextReport()` resolution.
        report_seq: Arc<AtomicU64>,
        /// The orchestrator isolate's wake sink — the same channel background
        /// FFI threads use, so a report wakes either loop flavor. `None` on a
        /// local reactor (no orchestrator; reports are suppressed).
        orch_wake: Option<crate::async_rt::WakeSink>,
        workloads: HashMap<u64, EngineWorkload>,
        /// The isolate currently entered on this thread. It stays active across
        /// slices and waits until a different workload actually wins scheduling.
        active: Option<(u64, ActiveWorkload)>,
        /// Routes retained while this reactor drains operations submitted before
        /// their owning isolate moved to another thread.
        forwarded: HashMap<u64, ForwardRoute>,
        /// Workloads with work ready to run (fresh wake, or a completion landed).
        runnable: HashSet<u64>,
        /// Workload ids pre-announced by a move source but not attached yet.
        incoming: HashSet<u64>,
        /// Wakes that arrived after pre-announcement but before attachment.
        early_wakes: HashSet<u64>,
        next_sequence: u64,
        last_load_signature: (u32, u32, u32),
        /// When the last Load report was posted (coalescing floor).
        last_load_report: Instant,
        running: bool,
        /// Reusable completion buffer for `Reactor::wait`.
        scratch: Vec<Completion>,
        /// Workload whose isolate boundary unwound unexpectedly.
        crashed_workload: Option<u64>,
        /// Local mode: this reactor runs inline on its caller's thread (the
        /// process root), hosting exactly one workload. Its release stops the
        /// loop and hands the parked isolate back instead of disposing it.
        local_root: Option<u64>,
        /// The local root's parked isolate + release reason, captured by
        /// `release` for `run_local` to run teardown on.
        local_released: Option<(ParkedWorkload, String)>,
    }

    fn new_thread(
        config: ReactorConfig,
        control_rx: mpsc::Receiver<Control>,
        report_tx: mpsc::Sender<Report>,
        report_seq: Arc<AtomicU64>,
        orch_wake: Option<crate::async_rt::WakeSink>,
        reactor: Reactor,
    ) -> ReactorThread {
        ReactorThread {
            config,
            resources: Box::new(EngineResources {
                io: crate::reactor::io::RuntimeIo::new(reactor),
                external: HashMap::new(),
                vnodes: HashMap::new(),
                signals: HashMap::new(),
                deferred: Vec::new(),
            }),
            control_rx,
            report_tx,
            report_seq,
            orch_wake,
            workloads: HashMap::new(),
            active: None,
            forwarded: HashMap::new(),
            runnable: HashSet::new(),
            incoming: HashSet::new(),
            early_wakes: HashSet::new(),
            next_sequence: 1,
            last_load_signature: (u32::MAX, u32::MAX, u32::MAX),
            last_load_report: Instant::now(),
            running: true,
            scratch: Vec::new(),
            crashed_workload: None,
            local_root: None,
            local_released: None,
        }
    }

    pub(super) fn run(
        config: ReactorConfig,
        control_rx: mpsc::Receiver<Control>,
        report_tx: mpsc::Sender<Report>,
        report_seq: Arc<AtomicU64>,
        orch_wake: crate::async_rt::WakeSink,
        reactor: Reactor,
    ) -> Option<RecoveryWorkset> {
        drive(new_thread(
            config,
            control_rx,
            report_tx,
            report_seq,
            Some(orch_wake),
            reactor,
        ))
    }

    /// The workload id of a local (caller-thread) reactor's single realm.
    pub(super) const LOCAL_ROOT_ID: u64 = 1;

    /// Bounded in-pump harvest backing JS `tick()`/`spin()`: wait on THIS
    /// engine's reactor and dispatch the current workload's completions
    /// inline (the scope is live), deferring everything else to the drive
    /// loop. Only meaningful from JS running inside a workload pump — a
    /// synchronous frame cannot leave the pump, so without this a spinning
    /// workload could never observe its own reactor completions.
    pub(super) fn engine_tick(scope: &mut v8::HandleScope, timeout: Option<Duration>) -> i32 {
        let (resources, owner) = ENGINE_CONTEXT.with(|context| context.get());
        if resources.is_null() || owner == 0 {
            return 0;
        }
        // SAFETY: same contract as `apply_registration` — the boxed
        // EngineResources is disjoint from the borrowed workload map, and
        // every reference below is dropped before JS runs.
        let mut buf: Vec<Completion> = Vec::new();
        {
            let r = unsafe { &mut *resources };
            let _ = r.io.wait(timeout, &mut buf);
        }
        enum Inline {
            Resolve {
                resolver_id: usize,
                result: f64,
            },
            Callback {
                callback_id: usize,
                fflags: Option<u32>,
            },
            /// A drained wake for the current workload — counted, no action.
            Wake,
        }
        let mut dispatched = 0i32;
        for c in &buf {
            let (user_data, res) = (c.user_data, c.res);
            if user_data & POST_FLAG != 0 {
                let own_wake = user_data & POST_WAKE_BIT != 0
                    && (user_data & !(POST_FLAG | POST_WAKE_BIT)) == owner;
                if own_wake {
                    // Already awake; the spin's microtask drain empties the
                    // queues this wake announced.
                    dispatched += 1;
                } else {
                    let r = unsafe { &mut *resources };
                    r.deferred.push(Deferred::Post { user_data, res });
                }
                continue;
            }
            let inline = {
                let r = unsafe { &mut *resources };
                match r.io.dispatch(user_data, res) {
                    crate::reactor::io::Dispatch::Resolved(resolved) => {
                        let crate::reactor::io::Target::Workload { id, resolver_id } =
                            resolved.target
                        else {
                            unreachable!("host completion on reactor engine")
                        };
                        if id == owner {
                            Some(Inline::Resolve {
                                resolver_id,
                                result: resolved.result,
                            })
                        } else {
                            r.deferred.push(Deferred::Resolve {
                                owner: id,
                                resolver_id,
                                result: resolved.result,
                            });
                            None
                        }
                    }
                    crate::reactor::io::Dispatch::Handled => None,
                    crate::reactor::io::Dispatch::External => {
                        match r.route_external(user_data, res) {
                            Some((own, ExternalDelivery::ProcExit { resolver_id }))
                                if own == owner =>
                            {
                                Some(Inline::Resolve {
                                    resolver_id,
                                    result: 0.0,
                                })
                            }
                            Some((
                                own,
                                ExternalDelivery::Callback {
                                    callback_id,
                                    fflags,
                                },
                            )) if own == owner => Some(Inline::Callback {
                                callback_id,
                                fflags,
                            }),
                            Some((own, ExternalDelivery::Repoll)) => {
                                if own != owner {
                                    r.deferred.push(Deferred::Runnable { owner: own });
                                }
                                None
                            }
                            Some((own, ExternalDelivery::Wake)) => {
                                if own == owner {
                                    Some(Inline::Wake)
                                } else {
                                    r.deferred.push(Deferred::Runnable { owner: own });
                                    None
                                }
                            }
                            Some((own, ExternalDelivery::ProcExit { resolver_id })) => {
                                r.deferred.push(Deferred::Resolve {
                                    owner: own,
                                    resolver_id,
                                    result: 0.0,
                                });
                                None
                            }
                            Some((
                                own,
                                ExternalDelivery::Callback {
                                    callback_id,
                                    fflags,
                                },
                            )) => {
                                r.deferred.push(Deferred::Event {
                                    owner: own,
                                    event: crate::reactor::workload::ReactorEvent::Callback {
                                        callback_id,
                                        fflags,
                                    },
                                });
                                None
                            }
                            None => None,
                        }
                    }
                }
            };
            match inline {
                Some(Inline::Resolve {
                    resolver_id,
                    result,
                }) => {
                    dispatched += 1;
                    crate::async_rt::resolve_io_completion(scope, resolver_id, result);
                }
                Some(Inline::Callback {
                    callback_id,
                    fflags,
                }) => {
                    dispatched += 1;
                    crate::reactor::workload::invoke_reactor_callback(scope, callback_id, fflags);
                }
                Some(Inline::Wake) => dispatched += 1,
                None => {}
            }
        }
        dispatched
    }

    /// Run a reactor inline on the current thread, hosting the workload built
    /// by `setup` as its only realm — the same drive loop pool reactors run,
    /// minus the thread, the supervisor, and the report channel. `setup` runs
    /// with this reactor installed and the workload's owner entered, so
    /// bootstrap-time I/O registrations land here (mirroring `place_realm`).
    /// When the workload releases, `on_release` runs teardown with the isolate
    /// entered and this reactor still installed (so teardown JS can register
    /// engine I/O), then the workload is quiesced and disposed. A panic at the
    /// pump boundary is fatal for a local reactor: the workload is disposed
    /// and `Err` returned.
    pub(super) fn run_local(
        config: ReactorConfig,
        setup: impl FnOnce() -> Result<ParkedWorkload, String>,
        on_release: impl FnOnce(&mut ParkedWorkload, &str) -> Result<(), String>,
    ) -> Result<(), String> {
        let reactor = Reactor::new().map_err(|e| format!("reactor engine: init failed: {e}"))?;
        // Local mode has no orchestrator: the control/report channels exist
        // only to satisfy the shared loop. Keep the far ends alive so sends
        // stay cheap successes for the loop's lifetime.
        let (_control_tx, control_rx) = mpsc::channel::<Control>();
        let (report_tx, _report_rx) = mpsc::channel::<Report>();
        let report_seq = Arc::new(AtomicU64::new(0));
        let mut engine = new_thread(config, control_rx, report_tx, report_seq, None, reactor);

        let id = LOCAL_ROOT_ID;
        engine.local_root = Some(id);

        ENGINE_CONTEXT.with(|context| {
            context.set((&mut *engine.resources, 0));
        });
        let result = (|| {
            let seed = {
                let _owner = EngineOwnerScope::enter(id);
                setup()
            };
            let seed = match seed {
                Ok(seed) => seed,
                Err(error) => {
                    engine.cancel_owned(id);
                    engine.drain_doomed();
                    return Err(error);
                }
            };
            seed.install_wake_notifier(engine.resources.io.notifier(), post_wake(id));
            engine.workloads.insert(
                id,
                EngineWorkload {
                    id,
                    inner: seed,
                    priority_class: 1,
                    debt_micros: 0.0,
                    sequence: 0,
                    last_sync_heavy_report: None,
                    ready_events: Vec::new(),
                    crash_on_next_pump: false,
                },
            );
            engine.runnable.insert(id);
            engine.loop_forever();
            if engine.crashed_workload.take().is_some() {
                set_engine_owner(0);
                // Same containment sequencing as pool recovery (release
                // deactivates, quiesces, and captures), but local mode has no
                // replacement worker — dispose and fail.
                if engine.workloads.contains_key(&id) {
                    engine.release(id, "reactor-workload-panicked".to_string());
                }
                if let Some((workload, _)) = engine.local_released.take() {
                    drop_parked(workload);
                }
                return Err("fino: realm execution panicked".to_string());
            }
            let Some((mut workload, reason)) = engine.local_released.take() else {
                return Err(
                    "reactor engine: local loop exited without releasing its workload".to_string(),
                );
            };
            // Teardown runs as a live engine workload: isolate entered, owner
            // set, this reactor still current — so onDone/checkpoint JS can
            // register I/O that the quiesce below then cancels and harvests.
            let active = activate_realm_native(&mut workload);
            let outcome = {
                let _owner = EngineOwnerScope::enter(id);
                on_release(&mut workload, &reason)
            };
            deactivate_realm_native(&mut workload, active);
            engine.cancel_owned(id);
            engine.drain_doomed();
            drop_parked(workload);
            outcome
        })();
        ENGINE_CONTEXT.with(|context| context.set((std::ptr::null_mut(), 0)));
        result
    }

    /// Resume an intact reactor working set on a replacement physical worker.
    pub(super) fn resume(workset: RecoveryWorkset, reactor: Reactor) -> Option<RecoveryWorkset> {
        let RecoveryWorkset(mut engine) = workset;
        engine.replace_physical_reactor(reactor);
        drive(engine)
    }

    fn drive(mut engine: ReactorThread) -> Option<RecoveryWorkset> {
        ENGINE_CONTEXT.with(|context| {
            context.set((&mut *engine.resources, 0));
        });
        let _ = apply_thread_priority(engine.config.reactor_class);
        crate::runtime::init_v8();
        engine.loop_forever();
        if let Some(workload_id) = engine.crashed_workload.take() {
            set_engine_owner(0);
            engine.recover_failed_workload(workload_id);
            ENGINE_CONTEXT.with(|context| context.set((std::ptr::null_mut(), 0)));
            return Some(RecoveryWorkset(engine));
        }
        engine.deactivate_active();
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
        ENGINE_CONTEXT.with(|context| context.set((std::ptr::null_mut(), 0)));
        None
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
                if !self.running || self.crashed_workload.is_some() {
                    break;
                }
                self.pump_runnable();
                if self.crashed_workload.is_some() {
                    break;
                }
                self.report_load_if_changed();
                if !self.running {
                    break;
                }
                // Nothing runnable: block until a wake pipe / completion fd fires.
                self.poll_block();
            }
        }

        fn drain_control(&mut self) {
            // A POST_CONTROL completion broke the wait; the messages are in
            // the mpsc, nothing to drain but the channel itself.
            while self.crashed_workload.is_none()
                && let Ok(msg) = self.control_rx.try_recv()
            {
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
                    watch_mode,
                    repl_mode,
                    priority_class,
                    port_half,
                    allocation_half,
                } => {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        self.place_realm(
                            workload_id,
                            entry_path,
                            rules_json,
                            realm_data,
                            realm_bootstrap_data,
                            watch_mode,
                            repl_mode,
                            priority_class,
                            port_half,
                            allocation_half,
                        );
                    }));
                    if result.is_err() {
                        set_engine_owner(0);
                        self.crashed_workload = Some(workload_id);
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
                Control::Move {
                    workload_id,
                    destination_tx,
                    destination_notify,
                } => self.move_workload(workload_id, destination_tx, destination_notify),
                Control::ExpectAttach { workload_id } => {
                    self.incoming.insert(workload_id);
                }
                Control::CancelAttach { workload_id } => {
                    self.incoming.remove(&workload_id);
                    self.early_wakes.remove(&workload_id);
                }
                Control::Attach { mut workload } => {
                    workload.workload.inner.mark_moved_between_threads();
                    let workload_id = workload.workload.id;
                    workload.workload.inner.install_wake_notifier(
                        self.resources.io.notifier(),
                        post_wake(workload_id),
                    );
                    self.workloads.insert(workload_id, workload.workload);
                    self.resources
                        .io
                        .attach_workload(workload_id, workload.operations);
                    self.incoming.remove(&workload_id);
                    if self.early_wakes.remove(&workload_id) {
                        self.runnable.insert(workload_id);
                    }
                    self.report(Report::Moved { workload_id });
                }
                Control::ForwardCompletion {
                    workload_id,
                    resolver_id,
                    result,
                } => self.deliver_completion(workload_id, resolver_id, result),
                Control::CrashRealm { workload_id } => {
                    if let Some(workload) = self.workloads.get_mut(&workload_id) {
                        workload.crash_on_next_pump = true;
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
            destination_notify: ReactorNotifier,
        ) {
            if let Some(reason) = self
                .workloads
                .get(&workload_id)
                .and_then(|workload| workload.inner.move_blocker())
            {
                self.report(Report::MoveRejected {
                    workload_id,
                    reason,
                });
                return;
            }
            if self.resources.external.values().any(|record| match record {
                ExternalRecord::Proc { owner, .. }
                | ExternalRecord::VnodeNext { owner, .. }
                | ExternalRecord::SignalNext { owner, .. }
                | ExternalRecord::RePoll { owner }
                | ExternalRecord::WakeSource { owner, .. } => *owner == workload_id,
            }) {
                self.report(Report::MoveRejected {
                    workload_id,
                    reason: "reactor-watch-active",
                });
                return;
            }
            let route = ForwardRoute {
                tx: destination_tx,
                notify: destination_notify.clone(),
            };
            if route.send(Control::ExpectAttach { workload_id }).is_err() {
                self.report(Report::MoveRejected {
                    workload_id,
                    reason: "destination-unavailable",
                });
                return;
            }
            if self.active_id() == Some(workload_id) {
                self.deactivate_active();
            }
            let Some(workload) = self.workloads.remove(&workload_id) else {
                let _ = route.send(Control::CancelAttach { workload_id });
                self.report(Report::MoveRejected {
                    workload_id,
                    reason: "realm-not-found",
                });
                return;
            };
            self.runnable.remove(&workload_id);
            let operations = self.resources.io.detach_workload(workload_id);
            let source_notify = self.resources.io.notifier();
            workload
                .inner
                .install_wake_notifier(destination_notify.current(), post_wake(workload_id));
            let attach = Control::Attach {
                workload: TransferWorkload {
                    workload,
                    operations,
                },
            };
            if let Err(Control::Attach { workload }) = route.send(attach) {
                let TransferWorkload {
                    workload,
                    operations,
                } = workload;
                let _ = route.send(Control::CancelAttach { workload_id });
                workload
                    .inner
                    .install_wake_notifier(source_notify, post_wake(workload_id));
                self.resources.io.attach_workload(workload_id, operations);
                self.workloads.insert(workload_id, workload);
                self.runnable.insert(workload_id);
                self.report(Report::MoveRejected {
                    workload_id,
                    reason: "destination-unavailable",
                });
                return;
            }
            self.forwarded.insert(workload_id, route);
            self.finish_forwarding_if_drained(workload_id);
        }

        #[allow(clippy::too_many_arguments)]
        fn place_realm(
            &mut self,
            workload_id: u64,
            entry_path: String,
            rules_json: String,
            realm_data: Option<String>,
            realm_bootstrap_data: Option<String>,
            watch_mode: bool,
            repl_mode: bool,
            priority_class: u8,
            port_half: (u32, i32),
            allocation_half: (u32, i32),
        ) {
            let import_rules: Vec<crate::state::ImportRule> =
                match serde_json::from_str(&rules_json) {
                    Ok(rules) => rules,
                    Err(err) => {
                        self.report(Report::Released {
                            workload_id,
                            reason: format!("setup_failed: bad rules: {err}"),
                        });
                        return;
                    }
                };
            let setup = {
                let _owner = EngineOwnerScope::enter(workload_id);
                setup_realm_workload(crate::realm::RealmExecutionConfig {
                    entry_path,
                    process_env: self.config.process_env.clone(),
                    package_map_json: self.config.package_map_json.clone(),
                    heap_limit_bytes: self.config.heap_limit_bytes,
                    import_rules,
                    realm_data,
                    realm_bootstrap_data,
                    watch_mode,
                    repl_mode,
                    port_half,
                    allocation_half: Some(allocation_half),
                    timing_label: "reactor-realm",
                })
            };
            let inner = match setup {
                Ok(w) => w,
                Err(err) => {
                    self.cancel_owned(workload_id);
                    self.drain_doomed();
                    self.report(Report::Released {
                        workload_id,
                        reason: format!("setup_failed: {err}"),
                    });
                    return;
                }
            };
            let seq = self.next_sequence;
            self.next_sequence += 1;
            inner.install_wake_notifier(self.resources.io.notifier(), post_wake(workload_id));
            self.workloads.insert(
                workload_id,
                EngineWorkload {
                    id: workload_id,
                    inner,
                    priority_class,
                    debt_micros: 0.0,
                    sequence: seq,
                    last_sync_heavy_report: None,
                    ready_events: Vec::new(),
                    crash_on_next_pump: false,
                },
            );
            // A realm runs immediately: its entry import is already pending.
            self.runnable.insert(workload_id);
        }

        fn pump_runnable(&mut self) {
            while self.running {
                // Select before changing V8 ownership. If the current isolate
                // still wins, activation is a no-op and the next slice avoids
                // an exit/lock/enter round trip.
                let selected = select_next_id(&self.runnable, |a, b| self.compare_runnable(a, b));
                let Some(id) = selected else {
                    break;
                };
                self.runnable.remove(&id);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.activate(id);
                    self.pump_one(id);
                }));
                if result.is_err() {
                    set_engine_owner(0);
                    self.crashed_workload = Some(id);
                    break;
                }
                // An in-pump tick() may have harvested completions belonging
                // to other workloads; route them before selecting again.
                self.drain_deferred();
            }
        }

        fn active_id(&self) -> Option<u64> {
            self.active.as_ref().map(|(id, _)| *id)
        }

        fn activate(&mut self, id: u64) {
            if self.active_id() == Some(id) {
                return;
            }
            self.deactivate_active();
            let Some(workload) = self.workloads.get_mut(&id) else {
                return;
            };
            let active = activate_realm_native(&mut workload.inner);
            self.active = Some((id, active));
        }

        fn deactivate_active(&mut self) {
            let Some((id, active)) = self.active.take() else {
                return;
            };
            let workload = self
                .workloads
                .get_mut(&id)
                .expect("active workload missing from reactor ownership");
            deactivate_realm_native(&mut workload.inner, active);
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
            debug_assert_eq!(self.active_id(), Some(id));
            if self
                .workloads
                .get_mut(&id)
                .is_some_and(|workload| std::mem::take(&mut workload.crash_on_next_pump))
            {
                panic!("reactor workload fault injection");
            }
            let hard = self.config.hard_budget_micros;
            let reactor_events = {
                let w = match self.workloads.get_mut(&id) {
                    Some(w) => w,
                    None => return,
                };
                std::mem::take(&mut w.ready_events)
            };
            let t0 = Instant::now();
            let outcome = {
                let _owner = EngineOwnerScope::enter(id);
                let w = self.workloads.get_mut(&id).unwrap();
                pump_realm_native(&mut w.inner, hard, &reactor_events)
            };
            let slice_micros = t0.elapsed().as_micros() as f64;
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
                PumpOutcome::PendingPoll => self.arm_repoll(id),
                PumpOutcome::Settled { result } => self.release(id, result),
                PumpOutcome::Terminated => self.release(id, "terminated".to_string()),
                PumpOutcome::Rejected(msg) => self.release(id, format!("failed: {msg}")),
            }
        }

        fn recover_failed_workload(&mut self, workload_id: u64) {
            if self.workloads.contains_key(&workload_id) {
                self.release(workload_id, "reactor-workload-panicked".to_string());
            } else {
                self.cancel_owned(workload_id);
                self.drain_doomed();
                self.report(Report::Released {
                    workload_id,
                    reason: "reactor-workload-panicked".to_string(),
                });
            }
            for workload in self.workloads.values_mut() {
                workload.inner.mark_moved_between_threads();
            }
            self.running = true;
            self.last_load_signature = (u32::MAX, u32::MAX, u32::MAX);
        }

        /// Retarget the logical reactor to a fresh Cherenkov instance. All
        /// message-passing wake sinks move first, then the old backend is
        /// canceled and fully harvested before survivor operations are
        /// re-armed on the new backend.
        fn replace_physical_reactor(&mut self, reactor: Reactor) {
            let notifier = reactor.notifier();
            for workload in self.workloads.values() {
                workload
                    .inner
                    .install_wake_notifier(notifier.clone(), post_wake(workload.id));
            }

            // Run at least one harvest even when no submitted operation is
            // pending: a background WakeSink may have posted to the old
            // notifier immediately before its shared route was replaced.
            let mut first_harvest = true;
            while first_harvest || self.resources.io.pending() > 0 {
                first_harvest = false;
                self.resources.io.cancel_all();
                for id in self.resources.external.keys().copied().collect::<Vec<_>>() {
                    self.resources.io.cancel_external(id);
                }
                let mut completions = std::mem::take(&mut self.scratch);
                completions.clear();
                let timeout = (self.resources.io.pending() == 0).then_some(Duration::ZERO);
                let _ = self.resources.io.wait(timeout, &mut completions);
                for completion in &completions {
                    let canceled_live = completion.res == err::CANCELED
                        && (self.resources.io.is_live_record(completion.user_data)
                            || self.resources.external.contains_key(&completion.user_data));
                    if !canceled_live {
                        self.route(completion.user_data, completion.res);
                    }
                }
                self.scratch = completions;
            }
            self.resources.replace_reactor(reactor);
        }

        fn arm_repoll(&mut self, owner: u64) {
            let op = self.resources.io.next_external_id();
            self.resources.io.submit_external_timeout(op, 25);
            self.resources
                .external
                .insert(op, ExternalRecord::RePoll { owner });
        }

        /// Route one completion to its owner. `res` is the operation result: a
        /// byte count for read/write, a bytes-available hint for readiness, or
        /// (for a bare `PollOut`) 0; a negative value is `-errno`. The tenant's
        /// promise resolver gets it verbatim during the next pump.
        fn on_completion(&mut self, user_data: u64, res: i32) {
            match self.resources.io.dispatch(user_data, res) {
                crate::reactor::io::Dispatch::Resolved(resolved) => {
                    let crate::reactor::io::Target::Workload { id, resolver_id } = resolved.target
                    else {
                        unreachable!("host completion on reactor engine")
                    };
                    self.deliver_completion(id, resolver_id, resolved.result);
                    self.finish_forwarding_if_drained(id);
                }
                crate::reactor::io::Dispatch::Handled => {}
                crate::reactor::io::Dispatch::External => {
                    match self.resources.route_external(user_data, res) {
                        Some((owner, ExternalDelivery::ProcExit { resolver_id })) => {
                            self.deliver_completion(owner, resolver_id, 0.0);
                        }
                        Some((
                            owner,
                            ExternalDelivery::Callback {
                                callback_id,
                                fflags,
                            },
                        )) => {
                            self.deliver_event(
                                owner,
                                crate::reactor::workload::ReactorEvent::Callback {
                                    callback_id,
                                    fflags,
                                },
                            );
                        }
                        Some((owner, ExternalDelivery::Repoll | ExternalDelivery::Wake)) => {
                            if self.workloads.contains_key(&owner) {
                                self.runnable.insert(owner);
                            }
                        }
                        None => {}
                    }
                }
            }
        }

        /// Route the foreign completions an in-pump `tick()` set aside.
        fn drain_deferred(&mut self) {
            while !self.resources.deferred.is_empty() {
                let deferred = std::mem::take(&mut self.resources.deferred);
                for item in deferred {
                    match item {
                        Deferred::Post { user_data, res } => self.route(user_data, res),
                        Deferred::Resolve {
                            owner,
                            resolver_id,
                            result,
                        } => self.deliver_completion(owner, resolver_id, result),
                        Deferred::Event { owner, event } => self.deliver_event(owner, event),
                        Deferred::Runnable { owner } => {
                            if self.workloads.contains_key(&owner) {
                                self.runnable.insert(owner);
                            }
                        }
                    }
                }
            }
        }

        fn deliver_completion(&mut self, owner: u64, resolver_id: usize, result: f64) {
            if let Some(workload) = self.workloads.get_mut(&owner) {
                workload
                    .ready_events
                    .push(crate::reactor::workload::ReactorEvent::Resolve {
                        resolver_id,
                        result,
                    });
                self.runnable.insert(owner);
            } else if let Some(route) = self.forwarded.get(&owner) {
                let _ = route.send(Control::ForwardCompletion {
                    workload_id: owner,
                    resolver_id,
                    result,
                });
            }
        }

        fn deliver_event(&mut self, owner: u64, event: crate::reactor::workload::ReactorEvent) {
            if let Some(workload) = self.workloads.get_mut(&owner) {
                workload.ready_events.push(event);
                self.runnable.insert(owner);
            }
        }

        fn finish_forwarding_if_drained(&mut self, owner: u64) {
            if !self.forwarded.contains_key(&owner) {
                return;
            }
            let pending = self
                .resources
                .io
                .has_owner(crate::reactor::io::Owner::Workload(owner));
            if !pending {
                self.forwarded.remove(&owner);
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
                    } else if self.incoming.contains(&id) {
                        self.early_wakes.insert(id);
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
            self.resources
                .io
                .cancel_owner(crate::reactor::io::Owner::Workload(id));
            let external: Vec<u64> = self
                .resources
                .external
                .iter()
                .filter_map(|(op, record)| match record {
                    ExternalRecord::Proc { owner, .. }
                    | ExternalRecord::VnodeNext { owner, .. }
                    | ExternalRecord::SignalNext { owner, .. }
                    | ExternalRecord::RePoll { owner }
                    | ExternalRecord::WakeSource { owner, .. }
                        if *owner == id =>
                    {
                        Some(*op)
                    }
                    _ => None,
                })
                .collect();
            for op in external {
                self.resources.io.cancel_external(op);
                self.resources.external.remove(&op);
            }
            let vnode_keys: Vec<(u64, i32)> = self
                .resources
                .vnodes
                .keys()
                .filter(|(owner, _)| *owner == id)
                .copied()
                .collect();
            for key in vnode_keys {
                if let Some(entry) = self.resources.vnodes.remove(&key) {
                    let _ = self.resources.io.remove_kernel_watch(entry.watch);
                }
            }
            let signals: Vec<(u64, i32)> = self
                .resources
                .signals
                .iter()
                .filter_map(|(key, entry)| (entry.owner == id).then_some(*key))
                .collect();
            for key in signals {
                if let Some(entry) = self.resources.signals.remove(&key) {
                    let _ = self.resources.io.remove_kernel_watch(entry.watch);
                }
            }
        }

        /// Wait until every doomed op's completion has been harvested (so its
        /// retained buffer can be dropped with its isolate still alive).
        /// Cancellation completes promptly on every backend; the deadline is a
        /// defensive bound, not an expected path.
        fn drain_doomed(&mut self) {
            let deadline = Instant::now() + Duration::from_secs(1);
            while !self.resources.io.doomed_is_empty() {
                if Instant::now() >= deadline {
                    eprintln!(
                        "reactor engine: {} canceled op(s) unharvested at teardown",
                        self.resources.io.doomed_len()
                    );
                    self.resources.io.discard_doomed();
                    break;
                }
                let mut buf = std::mem::take(&mut self.scratch);
                buf.clear();
                let _ = self
                    .resources
                    .io
                    .wait(Some(Duration::from_millis(10)), &mut buf);
                for c in &buf {
                    self.route(c.user_data, c.res);
                }
                self.scratch = buf;
            }
        }

        fn release(&mut self, id: u64, reason: String) {
            if self.active_id() == Some(id) {
                self.deactivate_active();
            }
            // Quiesce this workload's outstanding ops BEFORE disposing the
            // isolate their buffers belong to.
            self.cancel_owned(id);
            self.drain_doomed();
            if let Some(w) = self.workloads.remove(&id) {
                self.runnable.remove(&id);
                if self.local_root == Some(id) {
                    // The local root's isolate outlives the loop: `run_local`
                    // runs caller teardown on it before disposing.
                    self.local_released = Some((w.inner, reason));
                    self.running = false;
                    return;
                }
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
            let _ = self.resources.io.wait(timeout, &mut buf);
            // Control messages are already in the mpsc when their notifier
            // post wakes this wait. Apply pre-announced attaches before
            // routing workload wakes harvested in the same batch.
            self.drain_control();
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
                debt_micros,
            });
        }

        fn report(&mut self, report: Report) {
            // A local reactor has no orchestrator; a report's wake would only
            // re-mark its own workload runnable (the sink is the root's) and
            // spin the idle loop.
            if self.local_root.is_some() {
                return;
            }
            let _ = self.report_tx.send(report);
            // Wake the orchestrator's loop so it drains the report promptly:
            // bump the sequence its drain hook compares, then wake its sink.
            self.report_seq.fetch_add(1, Ordering::Release);
            if let Some(wake) = &self.orch_wake {
                wake.wake();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::imp::select_next_id;
    use super::{ENGINE_CONTEXT, EngineOwnerScope};
    use std::cmp::Ordering;
    use std::collections::HashSet;

    #[test]
    fn keeps_active_workload_when_it_still_has_priority() {
        let runnable = HashSet::from([7, 11]);
        let selected = select_next_id(&runnable, |a, b| a.cmp(&b));

        assert_eq!(selected, Some(7));
    }

    #[test]
    fn selects_a_different_workload_only_when_it_outranks_active() {
        let runnable = HashSet::from([7, 11]);
        let selected = select_next_id(&runnable, |a, b| a.cmp(&b));

        assert_eq!(selected, Some(7));
    }

    #[test]
    fn leaves_idle_active_workload_entered_until_another_is_runnable() {
        let runnable = HashSet::new();
        let selected = select_next_id(&runnable, |_a, _b| Ordering::Equal);

        assert_eq!(selected, None);
    }

    #[test]
    fn engine_owner_scope_restores_the_previous_owner() {
        ENGINE_CONTEXT.with(|context| context.set((std::ptr::null_mut(), 7)));
        {
            let _scope = EngineOwnerScope::enter(11);
            ENGINE_CONTEXT.with(|context| assert_eq!(context.get().1, 11));
        }
        ENGINE_CONTEXT.with(|context| assert_eq!(context.get().1, 7));
        ENGINE_CONTEXT.with(|context| context.set((std::ptr::null_mut(), 0)));
    }
}

// ===========================================================================
// Public spawn API + shared tenant setup.
// ===========================================================================

/// In-pump reactor harvest for the currently entered workload; backs the JS
/// `tick()` used by `spin()`. See `imp::engine_tick`.
pub(crate) fn engine_tick(
    scope: &mut v8::HandleScope,
    timeout: Option<std::time::Duration>,
) -> i32 {
    imp::engine_tick(scope, timeout)
}

/// Run a reactor inline on the current thread with the workload built by
/// `setup` as its only realm — the process root's drive loop. See
/// `imp::run_local`.
pub(crate) fn run_local(
    config: ReactorConfig,
    setup: impl FnOnce() -> Result<crate::reactor::workload::ParkedWorkload, String>,
    on_release: impl FnOnce(&mut crate::reactor::workload::ParkedWorkload, &str) -> Result<(), String>,
) -> Result<(), String> {
    imp::run_local(config, setup, on_release)
}

/// Spawn a reactor thread and return the orchestrator-side handle. The
/// reactor is created here (on the spawning thread) so its Notifier exists
/// before the thread runs, then moved in — it is `Send` by design.
pub fn spawn_reactor(config: ReactorConfig) -> Result<ReactorHandle, String> {
    let (control_tx, control_rx) = mpsc::channel::<Control>();
    let (report_tx, report_rx) = mpsc::channel::<Report>();
    let reactor =
        cherenkov::Reactor::new().map_err(|e| format!("reactor engine: init failed: {e}"))?;
    let control_notify = ReactorNotifier::new(reactor.notifier());
    let report_seq = Arc::new(AtomicU64::new(0));
    let alive = Arc::new(AtomicBool::new(true));
    let generation = Arc::new(AtomicU64::new(1));
    let orch_wake = crate::async_rt::wake_sink()
        .ok_or_else(|| "reactor engine: async runtime not initialised".to_string())?;

    let supervisor_seq = Arc::clone(&report_seq);
    let supervisor_wake = orch_wake.clone();
    let supervisor_alive = Arc::clone(&alive);
    let supervisor_generation = Arc::clone(&generation);
    let supervisor_control_notify = control_notify.clone();
    let join = std::thread::Builder::new()
        .name("reactor-supervisor".to_string())
        .spawn(move || {
            enum WorkerStart {
                Fresh {
                    config: ReactorConfig,
                    control_rx: mpsc::Receiver<Control>,
                    report_tx: mpsc::Sender<Report>,
                    reactor: cherenkov::Reactor,
                },
                Recovery {
                    workset: imp::RecoveryWorkset,
                    reactor: cherenkov::Reactor,
                },
            }
            let mut start = WorkerStart::Fresh {
                config,
                control_rx,
                report_tx,
                reactor,
            };
            loop {
                let replacing = matches!(start, WorkerStart::Recovery { .. });
                let worker_seq = Arc::clone(&supervisor_seq);
                let worker_wake = supervisor_wake.clone();
                let worker = std::thread::Builder::new()
                    .name("reactor".to_string())
                    .spawn(move || match start {
                        WorkerStart::Recovery { workset, reactor } => imp::resume(workset, reactor),
                        WorkerStart::Fresh {
                            config,
                            control_rx,
                            report_tx,
                            reactor,
                        } => imp::run(
                            config,
                            control_rx,
                            report_tx,
                            worker_seq,
                            worker_wake,
                            reactor,
                        ),
                    });
                let Ok(worker) = worker else {
                    break;
                };
                if replacing {
                    supervisor_generation.fetch_add(1, Ordering::Release);
                }
                match worker.join() {
                    Ok(Some(workset)) => {
                        let Ok(reactor) = cherenkov::Reactor::new() else {
                            break;
                        };
                        supervisor_control_notify.replace(reactor.notifier());
                        start = WorkerStart::Recovery { workset, reactor };
                    }
                    Ok(None) | Err(_) => break,
                }
            }
            supervisor_alive.store(false, Ordering::Release);
            // Logical death signal: one final bump + wake so the
            // orchestrator's report pump re-checks reactorAlive.
            supervisor_seq.fetch_add(1, Ordering::Release);
            supervisor_wake.wake();
        })
        .map_err(|e| format!("failed to spawn reactor thread: {e}"))?;

    Ok(ReactorHandle {
        control_tx,
        control_notify,
        report_rx,
        report_seq,
        report_seen: Cell::new(0),
        report_waiter: RefCell::new(None),
        alive,
        generation,
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
        "joinReactor",
        "nextReport",
        "drainReports",
        "reactorAlive",
        "reactorGeneration",
        "crashRealm",
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
    export!("joinReactor", cb_join_reactor);
    export!("nextReport", cb_next_report);
    export!("drainReports", cb_drain_reports);
    export!("reactorAlive", cb_reactor_alive);
    export!("reactorGeneration", cb_reactor_generation);
    export!("crashRealm", cb_crash_realm);
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

fn obj_bool(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str) -> bool {
    v8::String::new(scope, key)
        .and_then(|key| obj.get(scope, key.into()))
        .is_some_and(|value| value.boolean_value(scope))
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

/// JS: `placeRealm(reactorId, placement) → { portHandle, portWakeFd }`
///
/// Creates the realm's channel pair on the calling (orchestrator) thread,
/// ships the child half to the engine thread inside the PlaceRealm control,
/// and returns the parent half — the caller constructs the Realm's port
/// over it through the standard reactor-realm transport.
fn cb_place_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let Ok(placement) = v8::Local::<v8::Object>::try_from(args.get(1)) else {
        let message = v8::String::new(scope, "placeRealm requires a placement object").unwrap();
        let exception = v8::Exception::type_error(scope, message);
        scope.throw_exception(exception);
        return;
    };
    let workload_id = obj_u64(scope, placement, "realmId", 0);
    let entry_path = obj_string(scope, placement, "entryPath").unwrap_or_default();
    let rules_json = obj_string(scope, placement, "rulesJson").unwrap_or_default();
    let realm_data = obj_string(scope, placement, "data");
    let realm_bootstrap_data = obj_string(scope, placement, "bootstrapData");
    let priority_class = obj_u64(scope, placement, "priority", 1) as u8;
    let watch_mode = obj_bool(scope, placement, "watch");
    let repl_mode = obj_bool(scope, placement, "repl");

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
    let (allocation_parent, allocation_child) = match crate::realm::transit::create_halves() {
        Ok(pair) => pair,
        Err(e) => {
            drop(crate::realm::transit::remove_half(parent_handle));
            drop(crate::realm::transit::remove_half(child_handle));
            let msg = v8::String::new(scope, &format!("placeRealm allocation port: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };
    let allocation_parent_wake_fd = allocation_parent.wake_read_fd;
    let allocation_child_wake_fd = allocation_child.wake_read_fd;
    let allocation_parent_handle = crate::realm::transit::register_half(allocation_parent);
    let allocation_child_handle = crate::realm::transit::register_half(allocation_child);

    send_control(
        id,
        Control::PlaceRealm {
            workload_id,
            entry_path,
            rules_json,
            realm_data,
            realm_bootstrap_data,
            watch_mode,
            repl_mode,
            priority_class,
            port_half: (child_handle, child_wake_fd),
            allocation_half: (allocation_child_handle, allocation_child_wake_fd),
        },
    );

    let obj = v8::Object::new(scope);
    let k = v8::String::new(scope, "portHandle").unwrap();
    let v = v8::Number::new(scope, parent_handle as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "portWakeFd").unwrap();
    let v = v8::Number::new(scope, parent_wake_fd as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "allocationPortHandle").unwrap();
    let v = v8::Number::new(scope, allocation_parent_handle as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "allocationPortWakeFd").unwrap();
    let v = v8::Number::new(scope, allocation_parent_wake_fd as f64);
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

fn cb_join_reactor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let handle = REACTORS.with(|reactors| reactors.borrow_mut().get_mut(id).and_then(Option::take));
    let joined = handle.is_some_and(|handle| handle.join.join().is_ok());
    rv.set_bool(joined);
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
        if seq != h.report_seen.get() || !h.alive.load(Ordering::Acquire) {
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
            if (seq != h.report_seen.get() || !h.alive.load(Ordering::Acquire))
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
    let alive = with_reactor(id, |h| h.alive.load(Ordering::Acquire)).unwrap_or(false);
    rv.set_bool(alive);
}

fn cb_reactor_generation(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let generation = with_reactor(id, |h| h.generation.load(Ordering::Acquire)).unwrap_or(0);
    rv.set(v8::Number::new(scope, generation as f64).into());
}

fn cb_crash_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    send_control(id, Control::CrashRealm { workload_id });
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
        Report::MoveRejected {
            workload_id,
            reason,
        } => {
            set_str(scope, obj, "type", "moveRejected");
            set_num(scope, obj, "workloadId", workload_id as f64);
            set_str(scope, obj, "reason", reason);
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
            debt_micros,
        } => {
            set_str(scope, obj, "type", "load");
            set_num(scope, obj, "held", held as f64);
            set_num(scope, obj, "runnable", runnable as f64);
            set_num(scope, obj, "debtMicros", debt_micros);
        }
    }
    obj
}
