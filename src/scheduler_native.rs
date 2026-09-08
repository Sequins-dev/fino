//! Minimal native substrate for the TypeScript process scheduler.
//!
//! TypeScript owns readiness registration, runnable priority, worker placement,
//! lifecycle, and metrics. Native code is limited to the operations TypeScript
//! cannot perform: moving V8 isolates between OS threads, entering and pumping
//! an isolate, and carrying scalar readiness metadata across isolate boundaries.

use std::{
    cell::RefCell,
    collections::{BinaryHeap, HashMap, VecDeque},
    os::fd::{FromRawFd, OwnedFd, RawFd},
    rc::Rc,
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc,
    },
};

use ::v8;

use crate::fdutil::{WakePipe, create_pipe};
use crate::{
    loader,
    state::{FinoState, ProcessEnv, get_state},
    v8util,
};

struct Workload {
    owner: u32,
    context: v8::Global<v8::Context>,
    state: Rc<RefCell<FinoState>>,
    _module: v8::Global<v8::Module>,
    isolate: v8::SharedIsolate,
    async_state: Option<crate::async_rt::IsolateAsyncState>,
    scheduled: Option<Arc<ScheduledRealmState>>,
    port_fds: Option<(RawFd, RawFd)>,
}

struct TransferWorkload(Workload);

// SAFETY: Workloads cross a thread boundary only while their isolate is exited.
// The receiving worker acquires V8's Locker before entering it, and exactly one
// worker owns the value at a time.
unsafe impl Send for TransferWorkload {}

/// Process-local inputs captured before a reactor constructs the isolate.
///
/// This is deliberately not a network workload format: channels, file
/// descriptors, and completion state are local runtime attachments. Keeping
/// those attachments isolate-free is enough to let any reactor thread claim
/// and initialize the workload.
struct PendingWorkloadInner {
    entry: String,
    process_env: ProcessEnv,
    package_map_json: Option<String>,
    import_rules: Vec<crate::state::ImportRule>,
    channel_rx: Option<mpsc::Receiver<crate::realm::thread::ThreadMessage>>,
    channel_tx: Option<mpsc::Sender<crate::realm::thread::ThreadMessage>>,
    wake_read_fd: Option<RawFd>,
    wake_write_fd: Option<RawFd>,
    watch_mode: bool,
    repl_mode: bool,
    realm_data: Option<String>,
    realm_bootstrap_data: Option<String>,
    reload_requested_signal: Option<Arc<AtomicBool>>,
    scheduled: Option<Arc<ScheduledRealmState>>,
    port_fds: Option<(RawFd, RawFd)>,
    /// Created before submission so the main loop can watch `wakeFd` before a
    /// reactor has initialized the isolate.
    async_pipe: (RawFd, RawFd),
}

struct PendingWorkload {
    owner: u32,
    inner: Option<Box<PendingWorkloadInner>>,
}

impl PendingWorkload {
    /// Construct the isolate on the claiming reactor. On failure, return the
    /// parent-visible completion state so the allocation can be settled.
    fn initialize(mut self) -> Result<Workload, (String, Option<Arc<ScheduledRealmState>>)> {
        let inner = self
            .inner
            .take()
            .expect("pending workload already initialized");
        let scheduled = inner.scheduled.clone();
        setup_workload(*inner, self.owner).map_err(|error| (error, scheduled))
    }
}

impl Drop for PendingWorkload {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else {
            return;
        };
        retire_owner(self.owner);
        if let Some((wake_read, partner_write)) = inner.port_fds {
            unsafe {
                libc::close(wake_read);
                libc::close(partner_write);
            }
        }
        unsafe {
            libc::close(inner.async_pipe.0);
            libc::close(inner.async_pipe.1);
        }
    }
}

struct ActiveWorkload {
    saved_async_state: Option<crate::async_rt::IsolateAsyncState>,
    locker: v8::Locker<'static>,
}

thread_local! {
    static REACTOR_THREADS: RefCell<HashMap<u64, ReactorThread>> = RefCell::new(HashMap::new());
}

/// Allocate a handle that is never reused.
///
/// Handles are looked up in maps rather than indexed into slot tables, so a
/// retired handle is simply absent instead of aliasing whatever object took its
/// slot. Slot reuse made a stale `scheduledRealmSend` after `closeScheduledRealm`
/// address an unrelated realm.
fn next_handle() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Read a handle argument. Handles exceed `u32`, so they cross as `f64`.
fn handle_arg(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> u64 {
    let raw = value.number_value(scope).unwrap_or(0.0);
    if raw.is_finite() && raw >= 0.0 {
        raw as u64
    } else {
        0
    }
}

fn handle_value<'s>(scope: &mut v8::PinScope<'s, '_>, handle: u64) -> v8::Local<'s, v8::Value> {
    v8::Number::new(scope, handle as f64).into()
}

#[derive(Clone)]
enum ScheduledRealmResult {
    Done,
    Reload,
    Error(String),
}

struct ScheduledRealmState {
    owner: u32,
    result: Mutex<Option<ScheduledRealmResult>>,
    parent_wake_write: RawFd,
    /// Cross-thread handle used to interrupt the realm's isolate.
    ///
    /// Cooperative termination asks a realm to stop by posting it a message,
    /// which a realm spinning in synchronous JavaScript never observes — it
    /// holds its reactor thread indefinitely, and enough of them wedge the pool.
    /// This is the escape hatch, and V8 supports calling it from another thread
    /// precisely so a supervisor can use it.
    isolate_handle: Mutex<Option<v8::IsolateHandle>>,
    /// Set when termination was forced, so the resulting unwind is reported as
    /// a deliberate stop rather than as a realm error.
    force_requested: AtomicBool,
}

impl ScheduledRealmState {
    /// Interrupt the realm's JavaScript execution.
    ///
    /// Returns false when the isolate is already gone.
    fn force(&self) -> bool {
        self.force_requested.store(true, Ordering::Release);
        let handle = self.isolate_handle.lock().unwrap().clone();
        let interrupted = match handle {
            Some(handle) => handle.terminate_execution(),
            None => false,
        };
        // V8's interrupt cannot wake a parked reactor worker. The parent port
        // may already be closed after call(), so no control frame can provide
        // that wake either. Queue this owner after publishing the request.
        let pool = owner_pools()
            .lock()
            .unwrap()
            .get(&self.owner)
            .and_then(Weak::upgrade);
        if let Some(pool) = pool {
            pool.signal(self.owner);
        }
        interrupted
    }

    fn was_forced(&self) -> bool {
        self.force_requested.load(Ordering::Acquire)
    }

    fn complete(&self, result: ScheduledRealmResult) {
        *self.result.lock().unwrap() = Some(result);
        crate::fdutil::wake(self.parent_wake_write);
    }
}

impl Drop for ScheduledRealmState {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.parent_wake_write);
        }
    }
}

struct ScheduledRealmHandle {
    tx: mpsc::Sender<crate::realm::thread::ThreadMessage>,
    rx: mpsc::Receiver<crate::realm::thread::ThreadMessage>,
    child_wake_write: RawFd,
    parent_wake_read: RawFd,
    completion_wake_read: RawFd,
    state: Arc<ScheduledRealmState>,
}

impl Drop for ScheduledRealmHandle {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.child_wake_write);
            libc::close(self.parent_wake_read);
            libc::close(self.completion_wake_read);
        }
    }
}

fn scheduled_realms() -> &'static Mutex<HashMap<u64, ScheduledRealmHandle>> {
    static REALMS: std::sync::OnceLock<Mutex<HashMap<u64, ScheduledRealmHandle>>> =
        std::sync::OnceLock::new();
    REALMS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn process_pool() -> &'static Mutex<Option<Arc<PoolShared>>> {
    static POOL: std::sync::OnceLock<Mutex<Option<Arc<PoolShared>>>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| Mutex::new(None))
}

fn owner_pools() -> &'static Mutex<HashMap<u32, Weak<PoolShared>>> {
    static POOLS: std::sync::OnceLock<Mutex<HashMap<u32, Weak<PoolShared>>>> =
        std::sync::OnceLock::new();
    POOLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_owner() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    loop {
        let owner = NEXT.fetch_add(1, Ordering::Relaxed);
        if owner != 0 {
            return owner;
        }
    }
}

// The shared ledger is native only because movable isolates cannot share JS
// objects. It retains scalar metadata, never handles or Realm references.
#[derive(Clone, serde::Serialize)]
struct ReadinessTraceEvent {
    sequence: u64,
    elapsed_us: u64,
    operation: u64,
    owner: u32,
    stage: String,
    ident: f64,
    filter: i32,
    token: f64,
}

#[derive(Clone, Default, serde::Serialize)]
struct WakeDiagnostic {
    operation: u64,
    owner: u32,
    ident: f64,
    ready: u64,
    signalled: u64,
    absent: u64,
    last_ready_us: u64,
    last_signalled_us: u64,
}

#[derive(Default)]
struct ReadinessTrace {
    wake_sources: HashMap<u64, WakeDiagnostic>,
    wake_sources_dropped: u64,
    sequence: u64,
    dropped: u64,
    events: VecDeque<ReadinessTraceEvent>,
}

impl ReadinessTrace {
    fn push(&mut self, mut event: ReadinessTraceEvent, capacity: usize) {
        self.sequence += 1;
        event.sequence = self.sequence;
        if self.events.len() == capacity {
            self.events.pop_front();
            self.dropped += 1;
        }
        self.events.push_back(event);
    }
}

pub(crate) fn readiness_trace_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("FINO_TRACE_READINESS").as_deref() == Ok("1"))
}

fn readiness_trace() -> &'static Mutex<ReadinessTrace> {
    static TRACE: std::sync::OnceLock<Mutex<ReadinessTrace>> = std::sync::OnceLock::new();
    TRACE.get_or_init(|| Mutex::new(ReadinessTrace::default()))
}

fn readiness_trace_elapsed_us() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_micros() as u64
}

fn trace_readiness(operation: u64, owner: u32, stage: &str, ident: f64, filter: i32, token: f64) {
    if !readiness_trace_enabled() || operation == 0 {
        return;
    }
    let mut trace = readiness_trace().lock().unwrap();
    // A level-triggered pipe can remain readable while its owner is busy.
    // Count each notification without letting that traffic erase operation
    // lifecycles from the bounded history before the owner runs again.
    if matches!(
        stage,
        "wake-ready" | "wake-owner-signalled" | "wake-owner-absent"
    ) {
        if trace.wake_sources.len() == 65_536 && !trace.wake_sources.contains_key(&operation) {
            trace.wake_sources_dropped += 1;
            return;
        }
        let wake = trace
            .wake_sources
            .entry(operation)
            .or_insert_with(|| WakeDiagnostic {
                operation,
                owner,
                ident,
                ..Default::default()
            });
        match stage {
            "wake-ready" => {
                wake.ready += 1;
                wake.last_ready_us = readiness_trace_elapsed_us();
            }
            "wake-owner-signalled" => {
                wake.signalled += 1;
                wake.last_signalled_us = readiness_trace_elapsed_us();
            }
            _ => {
                wake.absent += 1;
            }
        }
        return;
    }
    trace.push(
        ReadinessTraceEvent {
            sequence: 0,
            elapsed_us: readiness_trace_elapsed_us(),
            operation,
            owner,
            stage: stage.to_owned(),
            ident,
            filter,
            token,
        },
        65_536,
    );
}

fn record_readiness_trace(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if !readiness_trace_enabled() {
        return;
    }
    let operation = handle_arg(scope, args.get(0));
    let owner = args.get(1).uint32_value(scope).unwrap_or(0);
    let stage = args.get(2).to_rust_string_lossy(scope);
    let ident = args.get(3).number_value(scope).unwrap_or(0.0);
    let filter = args.get(4).int32_value(scope).unwrap_or(0);
    let token = args.get(5).number_value(scope).unwrap_or(0.0);
    trace_readiness(operation, owner, &stage, ident, filter, token);
}

fn readiness_trace_snapshot(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = (!args.get(0).is_undefined()).then(|| args.get(0).uint32_value(scope).unwrap_or(0));
    let json = readiness_snapshot(owner).to_string();
    rv.set(v8::String::new(scope, &json).unwrap().into());
}

fn readiness_snapshot(owner: Option<u32>) -> serde_json::Value {
    let trace = readiness_trace().lock().unwrap();
    let events: Vec<_> = trace
        .events
        .iter()
        .filter(|event| owner.is_none_or(|owner| event.owner == owner))
        .cloned()
        .collect();
    let sequence = trace.sequence;
    let dropped = trace.dropped;
    let wake_sources: Vec<_> = trace
        .wake_sources
        .values()
        .filter(|source| owner.is_none_or(|owner| source.owner == owner))
        .cloned()
        .collect();
    let wake_sources_dropped = trace.wake_sources_dropped;
    drop(trace);
    let realms = realm_diagnostics().lock().unwrap().clone();
    let pool_state = match process_pool().try_lock() {
        Ok(pool) => match pool.as_ref() {
            Some(pool) => match pool.inner.try_lock() {
                Ok(inner) => serde_json::json!({
                    "parked": inner.parked.keys().copied().collect::<Vec<_>>(),
                    "residents": inner.residents,
                    "priorities": inner.priorities,
                    "waiting": inner.waiting,
                    "queuedEvents": inner.events.len(),
                    "readyEntries": inner.ready.len(),
                    "shutdown": inner.shutdown,
                }),
                Err(_) => serde_json::json!({ "unavailable": "pool mutex busy" }),
            },
            None => serde_json::Value::Null,
        },
        Err(_) => serde_json::json!({ "unavailable": "registry mutex busy" }),
    };
    serde_json::json!({ "version": 1, "enabled": readiness_trace_enabled(),
        "pid": std::process::id(), "elapsed_us": readiness_trace_elapsed_us(),
        "capacity": 65_536, "sequence": sequence, "dropped": dropped, "events": events,
        "realms": realms, "pool": pool_state,
        "wakeSources": wake_sources, "wakeSourcesDropped": wake_sources_dropped,
        "nativeWork": crate::async_rt::diagnostics::snapshot(owner) })
}

#[derive(Clone, Default, serde::Serialize)]
struct RealmDiagnostic {
    phase: String,
    updated_us: u64,
    parent: Option<u32>,
    entry: Option<String>,
    observations: HashMap<String, String>,
}

fn realm_diagnostics() -> &'static Mutex<HashMap<u32, RealmDiagnostic>> {
    static STATES: std::sync::OnceLock<Mutex<HashMap<u32, RealmDiagnostic>>> =
        std::sync::OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn realm_created(owner: u32, parent: u32, entry: &str) {
    if !readiness_trace_enabled() {
        return;
    }
    let mut states = realm_diagnostics().lock().unwrap();
    states.insert(
        owner,
        RealmDiagnostic {
            parent: Some(parent),
            entry: Some(entry.to_owned()),
            phase: "queued".to_owned(),
            updated_us: readiness_trace_elapsed_us(),
            ..Default::default()
        },
    );
}

fn realm_phase(owner: u32, phase: &str) {
    if !readiness_trace_enabled() {
        return;
    }
    let mut states = realm_diagnostics().lock().unwrap();
    if phase == "disposed" {
        states.remove(&owner);
        return;
    }
    let state = states.entry(owner).or_default();
    state.phase = phase.to_owned();
    state.updated_us = readiness_trace_elapsed_us();
}

fn record_realm_state(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if !readiness_trace_enabled() {
        return;
    }
    let owner = get_state(scope).borrow().scheduler_workload_owner;
    let name = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1).to_rust_string_lossy(scope);
    // Diagnostic observations cannot grow without bound within one Realm.
    if name.len() > 64 || value.len() > 16_384 {
        return;
    }
    let mut states = realm_diagnostics().lock().unwrap();
    let state = states.entry(owner).or_default();
    if state.observations.len() < 16 || state.observations.contains_key(&name) {
        state.observations.insert(name, value);
    }
}

// A diagnostic reader must survive a blocked main thread, lost reactor wake,
// or isolate disposal deadlock. This thread only copies scalar observations;
// it never enters an isolate, owns its handles, or signals runtime work.
fn start_readiness_recorder() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    if !readiness_trace_enabled() {
        return;
    }
    let Some(directory) = std::env::var_os("FINO_TRACE_DIRECTORY") else {
        return;
    };
    STARTED.call_once(|| {
        std::thread::spawn(move || {
            let directory = std::path::PathBuf::from(directory);
            if let Err(error) = std::fs::create_dir_all(&directory) {
                eprintln!("readiness recorder: {error}");
                return;
            }
            let path = directory.join(format!("readiness-{}.json", std::process::id()));
            let temporary = path.with_extension("tmp");
            loop {
                let snapshot = readiness_snapshot(None).to_string();
                if let Err(error) = std::fs::write(&temporary, snapshot)
                    .and_then(|()| std::fs::rename(&temporary, &path))
                {
                    eprintln!("readiness recorder: {error}");
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        });
    });
}

struct ReadinessChange {
    ident: f64,
    filter: i32,
    flags: u32,
    fflags: u32,
    data: f64,
    udata: f64,
    cancel_owner: Option<u32>,
    scheduler_wake: bool,
    /// Ask the main realm to re-signal `udata`'s owner after `data` ms.
    ///
    /// V8 background tasks and `Atomics.waitAsync` waiters have no pollable
    /// descriptor, so a realm holding one cannot be woken by readiness alone.
    /// Rather than spinning a reactor thread on a timed condvar wait, the
    /// reactor parks the realm and borrows a timer from the thread that is
    /// already sleeping in kqueue/io_uring.
    scheduler_poll: bool,
    borrowed_fd: Option<RawFd>,
    trace_id: u64,
}

impl ReadinessChange {
    /// A change carrying no kernel filter — only a scheduler-level request.
    fn control(udata: f64, data: f64) -> Self {
        Self {
            ident: 0.0,
            filter: 0,
            flags: 0,
            fflags: 0,
            data,
            udata,
            cancel_owner: None,
            scheduler_wake: false,
            scheduler_poll: false,
            borrowed_fd: None,
            trace_id: 0,
        }
    }
}

/// Ask the main realm to re-signal `owner` after `delay_ms`.
///
/// Called from a reactor thread, which has no V8 scope of its own; the mailbox
/// is plain shared state, so the request needs nothing from the isolate it just
/// parked.
fn request_scheduler_poll(owner: u32, delay_ms: f64) {
    let mut change = ReadinessChange::control(owner as f64, delay_ms);
    change.scheduler_poll = true;
    mailbox().inner.lock().unwrap().changes.push(change);
    mailbox().notify();
}

/// Number of `f64` slots per routed readiness completion.
///
/// A completion carries seven readiness scalars and one diagnostic operation ID.
/// It used to cross
/// to its owning realm as a structured clone — a ValueSerializer round trip, a
/// heap allocation, a backing store and a `Uint8Array` per event — to move
/// a few scalars. The fixed layout below removes all of that: the
/// whole batch arrives as one `Float64Array`.
const COMPLETION_SLOTS: usize = 8;

/// One routed readiness completion in fixed layout.
///
/// Slots: ident, filter, flags, fflags, data, udata, installed, trace_id.
type ReadinessCompletion = [f64; COMPLETION_SLOTS];

#[derive(Default)]
struct MailboxInner {
    changes: Vec<ReadinessChange>,
    borrowed_fds: HashMap<RawFd, OwnedFd>,
    events: HashMap<u32, Vec<ReadinessCompletion>>,
}

impl MailboxInner {
    /// A queued registration must name the same open file even if its Realm
    /// closes and reuses the original number before the controller runs.
    fn borrow_fd(&mut self, fd: RawFd) -> std::io::Result<RawFd> {
        let borrowed = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if borrowed < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fcntl returned a fresh descriptor owned by this mailbox.
        self.borrowed_fds
            .insert(borrowed, unsafe { OwnedFd::from_raw_fd(borrowed) });
        Ok(borrowed)
    }
}

struct Mailbox {
    inner: Mutex<MailboxInner>,
    wake: WakePipe,
}

impl Mailbox {
    fn new() -> Self {
        Self {
            inner: Mutex::new(MailboxInner::default()),
            wake: WakePipe::new().expect("wake pipe"),
        }
    }

    fn notify(&self) {
        self.wake.notify();
    }

    fn drain_wake(&self) {
        self.wake.drain();
    }
}

/// Liveness counters published by the readiness controller in the main realm.
///
/// A scheduled realm cannot see the main realm's loop state, and every one of
/// its readiness watches lives there. When reads and timers go silent together
/// the question is whether the controller is still routing at all, so it
/// publishes its registration count and a monotonically increasing routed
/// count here for any realm to read.
static CONTROLLER_REGISTRATIONS: AtomicU64 = AtomicU64::new(0);
static CONTROLLER_ROUTED: AtomicU64 = AtomicU64::new(0);
/// Wakes discarded because the owner was in neither `parked` nor `residents`.
///
/// Every such signal is a readiness event that reached the pool and vanished.
/// The realm it was meant for stays exactly as idle as if it had never fired.
static SIGNALS_DROPPED: AtomicU64 = AtomicU64::new(0);
/// Frames handed to a scheduled realm's queue, and frames its JavaScript has
/// actually taken off that queue. A gap that grows while a realm is supposed to
/// be running means the message never reached its loop, which is a different
/// fault from the realm being woken and then failing to make progress.
static FRAMES_SENT: AtomicU64 = AtomicU64::new(0);
pub(crate) static FRAMES_DRAINED: AtomicU64 = AtomicU64::new(0);

fn set_readiness_heartbeat(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let registrations = args.get(0).uint32_value(scope).unwrap_or(0);
    CONTROLLER_REGISTRATIONS.store(registrations as u64, Ordering::Relaxed);
}

fn mailbox() -> &'static Mailbox {
    static MAILBOX: std::sync::OnceLock<Mailbox> = std::sync::OnceLock::new();
    MAILBOX.get_or_init(Mailbox::new)
}

fn current_workload_owner(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = get_state(scope).borrow().scheduler_workload_owner;
    rv.set(v8::Integer::new_from_unsigned(scope, owner).into());
}

fn uses_process_readiness(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let enabled = get_state(scope).borrow().uses_process_readiness;
    rv.set(v8::Boolean::new(scope, enabled).into());
}

fn set_scheduler_polling_required(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let Ok(function) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        v8util::throw_error(
            scope,
            "setSchedulerPollingRequired: argument must be a function",
        );
        return;
    };
    get_state(scope).borrow_mut().scheduler_polling_fn = Some(v8::Global::new(scope, function));
}

fn setup_workload(inner: PendingWorkloadInner, owner: u32) -> Result<Workload, String> {
    let PendingWorkloadInner {
        entry,
        process_env,
        package_map_json,
        import_rules,
        channel_rx,
        channel_tx,
        wake_read_fd,
        wake_write_fd,
        watch_mode,
        repl_mode,
        realm_data,
        realm_bootstrap_data,
        reload_requested_signal,
        scheduled,
        port_fds,
        async_pipe,
    } = inner;
    crate::runtime::init_v8();
    let params = v8::CreateParams::default()
        .array_buffer_allocator(crate::runtime::shared_allocator().clone());
    let mut isolate = crate::v8_isolate_group::new_isolate(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);
    if let Some(scheduled) = scheduled.as_ref() {
        let handle = isolate.thread_safe_handle();
        *scheduled.isolate_handle.lock().unwrap() = Some(handle.clone());
        // A forced stop may have been requested while this workload was still
        // waiting in the queue and had no isolate handle. Honor it as soon as
        // the handle exists.
        if scheduled.was_forced() {
            handle.terminate_execution();
        }
    }

    let saved_async_state = crate::async_rt::swap_state(Some(
        crate::async_rt::new_state_with_pipe(async_pipe.0, async_pipe.1, Some(owner)),
    ));
    let initialized = (|| {
        if scheduled
            .as_ref()
            .is_some_and(|scheduled| scheduled.was_forced())
        {
            return Err("scheduled Realm was force-terminated during initialization".to_string());
        }
        v8::scope!(let isolate_scope, &mut isolate);
        let queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(
            isolate_scope,
            v8::ContextOptions {
                microtask_queue: Some((&*queue as *const v8::MicrotaskQueue).cast_mut()),
                ..Default::default()
            },
        );
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        let mut state = FinoState::new_child(
            process_env,
            package_map_json,
            queue,
            import_rules,
            (!entry.is_empty()).then_some(entry),
            None,
            channel_rx,
            channel_tx,
            wake_read_fd,
            wake_write_fd,
            watch_mode,
            repl_mode,
            realm_data,
            realm_bootstrap_data,
            reload_requested_signal,
        );
        state.scheduler_workload_owner = owner;
        state.uses_process_readiness = true;
        scope.set_slot(Rc::new(RefCell::new(state)));
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        let source = "import 'internal:bootstrap';";
        let module = {
            v8::tc_scope!(tc, scope);
            loader::compile_source_module(tc, source, "internal:scheduled-realm", None).ok_or_else(
                || {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to compile scheduled realm".to_string())
                },
            )?
        };
        loader::register_as_builtin(scope, module, "internal:scheduled-realm");
        {
            v8::tc_scope!(tc, scope);
            module
                .instantiate_module(tc, loader::resolve_module_callback)
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to instantiate scheduled realm".to_string())
                })?;
        }
        {
            v8::tc_scope!(tc, scope);
            module.evaluate(tc).ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to evaluate scheduled realm".to_string())
            })?;
        }
        if module.get_status() == v8::ModuleStatus::Errored {
            return Err(v8util::js_string(scope, module.get_exception()));
        }
        // An interrupt requested during bootstrap may be consumed by a module
        // evaluation TryCatch. The atomic remains authoritative until setup is
        // complete, so a pending forced stop cannot turn into live user work.
        if scheduled
            .as_ref()
            .is_some_and(|scheduled| scheduled.was_forced())
        {
            return Err("scheduled Realm was force-terminated during initialization".to_string());
        }
        Ok((
            v8::Global::new(scope, context),
            get_state(scope),
            v8::Global::new(scope, module),
        ))
    })();
    let async_state = crate::async_rt::swap_state(saved_async_state);
    let (context, state, module) = match initialized {
        Ok(values) => values,
        Err(error) => {
            // Initialization failure has the same ownership boundary as normal
            // disposal: retire before closing a pipe that the controller may
            // still be watching. Otherwise EOF repeatedly signals a dead owner.
            retire_owner(owner);
            // The detached async state's Drop closes the eagerly-created wake
            // pipe. These port descriptors otherwise become owned by Workload.
            drop(async_state);
            if let Some((wake_read, partner_write)) = port_fds {
                unsafe {
                    libc::close(wake_read);
                    libc::close(partner_write);
                }
            }
            return Err(error);
        }
    };
    // SAFETY: all state attached to scheduled-realm isolates is transferred
    // with the workload and only accessed while its Locker is held.
    let isolate = match unsafe { isolate.try_into_shared() } {
        Ok(isolate) => isolate,
        Err(error) => {
            retire_owner(owner);
            drop(async_state);
            if let Some((wake_read, partner_write)) = port_fds {
                unsafe {
                    libc::close(wake_read);
                    libc::close(partner_write);
                }
            }
            return Err(format!("failed to share scheduled realm isolate: {error}"));
        }
    };
    Ok(Workload {
        owner,
        context,
        state,
        _module: module,
        isolate,
        async_state,
        scheduled,
        port_fds,
    })
}

fn activate(workload: &mut Workload) -> ActiveWorkload {
    let locker = workload.isolate.lock();
    // SAFETY: Locker owns an Arc to the isolate's stable inner allocation.
    // ActiveWorkload is always dropped before its containing Workload, so
    // extending this outer borrow does not permit the SharedIsolate owner to
    // disappear while the guard is live.
    let locker = unsafe { std::mem::transmute::<v8::Locker<'_>, v8::Locker<'static>>(locker) };
    let saved_async_state = crate::async_rt::swap_state(workload.async_state.take());
    ActiveWorkload {
        saved_async_state,
        locker,
    }
}

fn deactivate(workload: &mut Workload, active: ActiveWorkload) {
    let ActiveWorkload {
        saved_async_state,
        locker,
    } = active;
    workload.async_state = crate::async_rt::swap_state(saved_async_state);
    // Locker::drop exits the isolate before releasing V8's Locker. Keep that
    // boundary explicit: once this returns, the workload may cross threads.
    drop(locker);
}

/// How long the main realm waits before re-signalling a realm whose remaining
/// work has no pollable descriptor (V8 background tasks, `Atomics.waitAsync`).
const SCHEDULER_POLL_INTERVAL_MS: f64 = 1.0;

/// Why a reactor worker stopped driving the realm it had entered.
enum Slice {
    /// The realm ran out of work it could complete immediately. Inflight
    /// operations may still be outstanding; a readiness completion signals the
    /// owner when one of them finishes.
    ///
    /// `polling` is set when the realm holds work with no pollable descriptor
    /// (V8 background tasks, `Atomics.waitAsync`) and must be revisited on a
    /// timer rather than purely on signal.
    Quiescent { polling: bool },
    /// The realm still has work, but another realm is ready at a strictly
    /// higher priority and should get the thread.
    Preempted,
    /// The realm finished.
    Settled,
}

/// Drive one realm until it is quiescent, preempted, or finished.
///
/// The realm is stepped for as long as it reports progress. Leaving early is
/// deliberately rare: exiting an isolate and entering another costs a Locker
/// round trip, so a realm that still has completable work keeps the thread
/// unless `shared` reports a strictly higher-priority realm waiting.
fn drive_slice(
    workload: &mut Workload,
    active: &mut ActiveWorkload,
    shared: &PoolShared,
) -> Result<Slice, String> {
    // A previous V8 TryCatch may have consumed the interrupt. The request
    // remains authoritative when this owner is scheduled again.
    if workload
        .scheduled
        .as_ref()
        .is_some_and(|scheduled| scheduled.was_forced())
    {
        return Err("scheduled Realm was force-terminated".to_string());
    }
    let owner = workload.owner;
    realm_phase(owner, "running");
    let context_global = workload.context.clone();
    v8::scope!(let isolate_scope, &mut *active.locker);
    let context = v8::Local::new(isolate_scope, &context_global);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    crate::realm::child::pump_and_checkpoint(scope);
    let loop_step_fn = workload.state.borrow().loop_step_fn.clone();
    let Some(loop_step_fn) = loop_step_fn else {
        // Bootstrap has not registered a step yet. There is no descriptor to
        // wait on, so revisit this realm on a timer rather than parking it.
        return Ok(Slice::Quiescent { polling: true });
    };
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    v8::tc_scope!(tc, scope);
    loop {
        let step = v8::Local::new(tc, &loop_step_fn)
            .call(tc, receiver, &[])
            .ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "scheduled realm loop step threw".to_string())
            })?
            .number_value(tc)
            .unwrap_or(-1.0);
        if step < 0.0 {
            break;
        }
        let mut progress = step > 0.0;
        progress |= crate::realm::child::pump_and_checkpoint(tc);
        if crate::async_rt::service_scheduled_sync_call(tc, &workload.state) {
            crate::realm::child::pump_and_checkpoint(tc);
            // The TypeScript step cannot see a sync call until the host
            // services it here, so its pre-service result is stale. Give the
            // resolved Promise another turn to install handles, finish the
            // realm, or queue more host work.
            progress = true;
        }
        if !progress {
            let polling = workload
                .state
                .borrow()
                .scheduler_polling_fn
                .as_ref()
                .and_then(|polling_fn| {
                    v8::Local::new(tc, polling_fn)
                        .call(tc, receiver, &[])
                        .map(|value| value.boolean_value(tc))
                })
                .unwrap_or(false);
            return Ok(Slice::Quiescent { polling });
        }
        if shared.should_yield(owner) {
            return Ok(Slice::Preempted);
        }
    }

    let on_done = workload.state.borrow().on_done_fn.clone();
    if let Some(on_done) = on_done {
        v8::tc_scope!(tc, tc);
        v8::Local::new(tc, &on_done)
            .call(tc, receiver, &[])
            .ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "scheduled realm completion hook threw".to_string())
            })?;
        crate::realm::child::pump_and_checkpoint(tc);
    }
    if let Some(error) = workload.state.borrow_mut().entry_error.take() {
        return Err(error);
    }
    Ok(Slice::Settled)
}

fn retire_owner(owner: u32) {
    // Make retirement visible before any of this workload's descriptors are
    // closed. A queued kqueue completion can otherwise run after the OS has
    // recycled an async wake fd and re-arm that descriptor for this old owner,
    // replacing the successor owner's filter.
    owner_pools().lock().unwrap().remove(&owner);
    let mut inner = mailbox().inner.lock().unwrap();
    if let Some(events) = inner.events.remove(&owner) {
        for event in events {
            trace_readiness(
                event[7] as u64,
                owner,
                "discarded-owner-retired",
                event[0],
                event[1] as i32,
                event[5],
            );
        }
    }
    let mut change = ReadinessChange::control(0.0, 0.0);
    change.cancel_owner = Some(owner);
    inner.changes.push(change);
    drop(inner);
    mailbox().notify();
}

fn drop_workload(mut workload: Workload) {
    let owner = workload.owner;
    realm_phase(owner, "disposing");
    // Clear any pending interrupt before entering the isolate for teardown, so
    // a forced termination cannot unwind the disposal path itself.
    workload
        .isolate
        .thread_safe_handle()
        .cancel_terminate_execution();
    let active = activate(&mut workload);
    retire_owner(workload.owner);
    crate::profiler::finish_realm_profile(&mut workload.state.borrow_mut());
    if let Some(pointer) = workload.state.borrow_mut().cpu_profiler.take() {
        unsafe { crate::profiler::dispose_profiler(pointer) };
    }
    workload.state.borrow_mut().loop_step_fn = None;
    workload.state.borrow_mut().on_done_fn = None;
    workload.state.borrow_mut().sync_call_fn = None;
    workload.state.borrow_mut().sync_call_resolver = None;
    deactivate(&mut workload, active);
    if let Some((wake_read, partner_write)) = workload.port_fds.take() {
        unsafe {
            libc::close(wake_read);
            libc::close(partner_write);
        }
    }
    drop(workload);
    realm_phase(owner, "disposed");
}

#[derive(Clone, Copy)]
enum PoolEventKind {
    Activated,
    Settled,
    Error,
}

struct PoolEvent {
    kind: PoolEventKind,
    worker: usize,
    owner: u32,
    error: Option<String>,
}

enum PoolWorkload {
    /// Submitted but not yet claimed by a reactor; no isolate exists yet.
    Pending(PendingWorkload),
    /// Initialized isolate, movable between threads only while exited.
    Live(TransferWorkload),
}

struct PoolItem {
    owner: u32,
    workload: PoolWorkload,
}

impl PoolItem {
    fn live_mut(&mut self) -> &mut Workload {
        match &mut self.workload {
            PoolWorkload::Live(workload) => &mut workload.0,
            PoolWorkload::Pending(_) => unreachable!("resident workload has no isolate"),
        }
    }

    fn into_live(self) -> Workload {
        match self.workload {
            PoolWorkload::Live(workload) => workload.0,
            PoolWorkload::Pending(_) => unreachable!("resident workload has no isolate"),
        }
    }
}

struct Resident {
    item: PoolItem,
    active: ActiveWorkload,
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct ReadyEntry {
    priority: usize,
    generation: u64,
    owner: u32,
}

struct PoolSharedInner {
    parked: HashMap<u32, PoolItem>,
    events: VecDeque<PoolEvent>,
    ready: BinaryHeap<ReadyEntry>,
    priorities: HashMap<u32, usize>,
    generations: HashMap<u32, u64>,
    /// Which worker currently has each entered realm. Supersedes a bare set of
    /// active owners: knowing *where* a realm is entered is what lets a signal
    /// wake the one worker that can actually run it.
    residents: HashMap<u32, usize>,
    /// Workers blocked in `claim`, in the order they parked.
    waiting: VecDeque<usize>,
    /// Per-worker wake-ups. All share `inner` as their mutex, so a signal can
    /// name its target instead of waking the whole pool.
    wakes: Vec<Arc<Condvar>>,
    shutdown: bool,
    next_worker: usize,
}

impl PoolSharedInner {
    /// Wake the worker that has `owner` entered, or one arbitrary parked
    /// worker when the realm is not entered anywhere.
    ///
    /// Only the resident worker can run a realm it already holds, so a blanket
    /// wake-up would drag every other worker out of the kernel to discover it
    /// has nothing to do. Measured on an 18-processor host, that cost I/O-bound
    /// realms roughly 2-3x per operation against a single-threaded pool.
    fn wake_for(&mut self, owner: u32) {
        if let Some(worker) = self.wake_target(owner) {
            self.wake_worker(worker);
        }
    }

    /// Which worker, if any, should be woken for `owner` becoming runnable.
    ///
    /// A realm that is entered can only be run by the worker holding it. One
    /// that is not entered can be claimed by whichever worker reaches it first,
    /// so the longest-waiting one is woken. When no worker is waiting, none
    /// needs waking: every worker re-examines the queue before it parks.
    fn wake_target(&self, owner: u32) -> Option<usize> {
        if let Some(worker) = self.residents.get(&owner).copied() {
            return Some(worker);
        }
        self.waiting.front().copied()
    }

    /// Wake one waiting worker, if any is parked.
    ///
    /// A realm nobody has entered can be claimed by whichever worker gets there
    /// first, so a single wake-up suffices. If every worker is busy, none needs
    /// waking: each re-examines the queue before it parks.
    fn wake_any(&mut self) {
        if let Some(worker) = self.waiting.front().copied() {
            self.wake_worker(worker);
        }
    }

    /// Notify one worker, and stop offering it to the next signal.
    ///
    /// A woken worker only takes itself out of `waiting` once it re-acquires
    /// the queue lock inside `claim`. Until then it is still `waiting.front()`,
    /// so a burst of signals would every one of them target the same worker: N
    /// realms become runnable, one worker wakes, it claims one of them, and the
    /// rest sit in the ready heap with every other worker still asleep. Nothing
    /// re-examines the queue until an unrelated signal happens by, which is a
    /// wake-up delayed by however long that takes rather than one that is lost.
    ///
    /// Removing the worker here makes each signal reach a different one.
    /// `claim` already removes itself defensively, so this only moves that
    /// bookkeeping earlier.
    fn wake_worker(&mut self, worker: usize) {
        if let Some(index) = self.waiting.iter().position(|entry| *entry == worker) {
            self.waiting.remove(index);
        }
        if let Some(wake) = self.wakes.get(worker) {
            wake.notify_all();
        }
    }

    fn wake_all(&mut self) {
        for wake in &self.wakes {
            wake.notify_all();
        }
    }
}

struct PoolShared {
    inner: Mutex<PoolSharedInner>,
    wake: WakePipe,
}

impl PoolShared {
    fn new() -> Self {
        let inner = PoolSharedInner {
            parked: HashMap::new(),
            events: VecDeque::new(),
            ready: BinaryHeap::new(),
            priorities: HashMap::new(),
            generations: HashMap::new(),
            residents: HashMap::new(),
            waiting: VecDeque::new(),
            wakes: Vec::new(),
            shutdown: false,
            next_worker: 0,
        };
        Self {
            inner: Mutex::new(inner),
            wake: WakePipe::new().expect("wake pipe"),
        }
    }

    /// Allocate a worker slot and its wake-up.
    fn register_worker(&self) -> (usize, Arc<Condvar>) {
        let mut inner = self.inner.lock().unwrap();
        let worker = inner.next_worker;
        inner.next_worker += 1;
        let wake = Arc::new(Condvar::new());
        inner.wakes.push(Arc::clone(&wake));
        (worker, wake)
    }

    fn submit(self: &Arc<Self>, item: PoolItem) -> u32 {
        let owner = item.owner;
        owner_pools()
            .lock()
            .unwrap()
            .insert(owner, Arc::downgrade(self));
        let mut inner = self.inner.lock().unwrap();
        debug_assert!(!inner.shutdown, "cannot submit work to a stopped reactor");
        debug_assert!(
            !inner.parked.contains_key(&owner) && !inner.residents.contains_key(&owner),
            "workload {owner} is already in the reactor"
        );
        inner.parked.insert(owner, item);
        Self::signal_inner(&mut inner, owner);
        owner
    }

    fn signal_inner(inner: &mut PoolSharedInner, owner: u32) -> bool {
        if !inner.parked.contains_key(&owner) && !inner.residents.contains_key(&owner) {
            SIGNALS_DROPPED.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let priority = inner.priorities.entry(owner).or_default();
        *priority += 1;
        let generation = inner.generations.entry(owner).or_default();
        *generation += 1;
        inner.ready.push(ReadyEntry {
            priority: *priority,
            generation: *generation,
            owner,
        });
        inner.wake_for(owner);
        true
    }

    fn signal(&self, owner: u32) -> bool {
        Self::signal_inner(&mut self.inner.lock().unwrap(), owner)
    }

    /// Re-queue a realm that still has work, without treating that as a new
    /// readiness signal.
    ///
    /// A preempted realm has to stay claimable, but it must not outrank the
    /// realm it is yielding to. Routing this through `signal` would bump its
    /// priority by one every time it yielded, so the realm that just lost the
    /// comparison would immediately win the next one and preemption would never
    /// actually hand the thread over.
    fn mark_runnable(&self, owner: u32) {
        {
            let inner = &mut *self.inner.lock().unwrap();
            if !inner.parked.contains_key(&owner) && !inner.residents.contains_key(&owner) {
                return;
            }
            // A queued entry must carry a priority of at least one. `claim`
            // compares a candidate against the entered realm with `<=` and keeps
            // the incumbent on a tie, re-queueing the candidate — so a
            // priority-zero entry leaves `claim` permanently able to find a
            // candidate it will never take, and it spins instead of ever
            // waiting. Claiming resets the priority to zero, which makes that
            // state reachable for any realm the moment it is preempted.
            let priority = inner.priorities.entry(owner).or_default();
            *priority = (*priority).max(1);
            let priority = *priority;
            let generation = inner.generations.entry(owner).or_default();
            *generation += 1;
            inner.ready.push(ReadyEntry {
                priority,
                generation: *generation,
                owner,
            });
            inner.wake_for(owner);
        }
    }

    /// Report whether a different realm is ready at a strictly higher priority
    /// than the realm a worker currently has entered.
    ///
    /// Discard superseded heap roots just as `claim` does. A busy Realm need
    /// not become quiescent, so deferring stale-entry cleanup until `claim`
    /// could hide another Realm's wake indefinitely.
    fn should_yield(&self, current: u32) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.shutdown {
            return true;
        }
        while let Some(entry) = inner.ready.peek() {
            if inner.generations.get(&entry.owner).copied().unwrap_or(0) != entry.generation
                || inner.priorities.get(&entry.owner).copied().unwrap_or(0) != entry.priority
            {
                inner.ready.pop();
                continue;
            }
            return entry.owner != current
                && entry.priority > inner.priorities.get(&current).copied().unwrap_or(0);
        }
        false
    }

    fn claim(
        &self,
        worker: usize,
        wake: &Condvar,
        current: Option<u32>,
        stop: &AtomicBool,
        current_state: CurrentState,
    ) -> Claim {
        let mut inner = self.inner.lock().unwrap();
        loop {
            if inner.shutdown || stop.load(Ordering::Acquire) {
                return Claim::Shutdown;
            }
            let mut skipped = Vec::new();
            let candidate = loop {
                let Some(entry) = inner.ready.pop() else {
                    break None;
                };
                let current_generation = inner.generations.get(&entry.owner).copied().unwrap_or(0);
                let current_priority = inner.priorities.get(&entry.owner).copied().unwrap_or(0);
                if entry.generation != current_generation || entry.priority != current_priority {
                    continue;
                }
                if inner.residents.contains_key(&entry.owner) && Some(entry.owner) != current {
                    skipped.push(entry);
                    continue;
                }
                break Some(entry);
            };
            for entry in skipped {
                inner.ready.push(entry);
            }

            if let Some(candidate) = candidate {
                let current_priority = current
                    .and_then(|owner| inner.priorities.get(&owner).copied())
                    .unwrap_or(0);
                let owner = if let Some(current) = current {
                    if candidate.owner != current && candidate.priority <= current_priority {
                        current
                    } else {
                        candidate.owner
                    }
                } else {
                    candidate.owner
                };
                inner.priorities.remove(&owner);
                if owner != candidate.owner {
                    // Keeping our own realm leaves the candidate runnable with
                    // nobody assigned to it. Whoever woke us handed over a
                    // single wake-up, so pass it on rather than swallowing it.
                    inner.ready.push(candidate);
                    inner.wake_any();
                }
                if Some(owner) == current {
                    return Claim::Current;
                }
                let Some(item) = inner.parked.remove(&owner) else {
                    continue;
                };
                inner.residents.insert(owner, worker);
                return Claim::Work(item);
            }
            // Nothing is ready. A realm that still has work keeps the thread
            // without blocking; anything else waits to be signalled. Reactor
            // threads never wait on a timeout — every wake-up is a signal.
            if matches!(current_state, CurrentState::Runnable) && current.is_some() {
                return Claim::Current;
            }
            inner.waiting.push_back(worker);
            inner = wake.wait(inner).unwrap();
            if let Some(index) = inner.waiting.iter().position(|entry| *entry == worker) {
                inner.waiting.remove(index);
            }
        }
    }

    fn park(&self, resident: Resident) {
        let Resident { mut item, active } = resident;
        let owner = item.owner;
        deactivate(item.live_mut(), active);
        let mut inner = self.inner.lock().unwrap();
        inner.residents.remove(&owner);
        inner.parked.insert(owner, item);
        // The realm is claimable by anyone now; one worker is enough to take it.
        inner.wake_any();
    }

    fn finish(&self, owner: u32) {
        let mut inner = self.inner.lock().unwrap();
        inner.residents.remove(&owner);
        inner.priorities.remove(&owner);
        inner.generations.remove(&owner);
    }

    fn notify(&self, event: PoolEvent) {
        self.inner.lock().unwrap().events.push_back(event);
        self.wake.notify();
    }

    fn drain_wake(&self) {
        self.wake.drain();
    }
}

struct ReactorThread {
    shared: Arc<PoolShared>,
    stop: Arc<AtomicBool>,
    wake: Arc<Condvar>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl ReactorThread {
    fn shutdown(&mut self) {
        {
            // Publish the stop flag while holding the mutex the worker tests it
            // under. `claim` checks `stop` and then waits without releasing
            // `inner` in between, so setting the flag outside the lock leaves a
            // window where a notification lands after the check but before the
            // wait and is lost — parking the worker forever and deadlocking the
            // join below.
            let _guard = self.shared.inner.lock().unwrap();
            self.stop.store(true, Ordering::Release);
        }
        // Only this worker is stopping, so only this worker needs waking.
        self.wake.notify_all();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for ReactorThread {
    fn drop(&mut self) {
        self.shutdown();
    }
}

enum Claim {
    Current,
    Work(PoolItem),
    Shutdown,
}

/// What the worker's currently entered realm wants from the next `claim`.
#[derive(Clone, Copy)]
enum CurrentState {
    /// Nothing left to do: wait for a readiness signal before running again.
    Idle,
    /// Still has work; only a strictly higher-priority realm should take over.
    Runnable,
}

fn run_worker(worker: usize, shared: Arc<PoolShared>, stop: Arc<AtomicBool>, wake: Arc<Condvar>) {
    let mut current: Option<Resident> = None;
    let mut current_state = CurrentState::Idle;
    loop {
        let current_owner = current.as_ref().map(|resident| resident.item.owner);
        match shared.claim(worker, &wake, current_owner, &stop, current_state) {
            Claim::Shutdown => break,
            Claim::Current => {}
            Claim::Work(mut item) => {
                if let Some(resident) = current.take() {
                    shared.park(resident);
                }
                let owner = item.owner;
                realm_phase(owner, "initializing");
                // Removing the item from `parked` and recording it as resident
                // happens under the queue lock, so only this worker can perform
                // the Pending -> Live transition.
                if let PoolWorkload::Pending(pending) = item.workload {
                    match pending.initialize() {
                        Ok(workload) => {
                            item.workload = PoolWorkload::Live(TransferWorkload(workload));
                        }
                        Err((error, scheduled)) => {
                            let forced = scheduled
                                .as_ref()
                                .is_some_and(|scheduled| scheduled.was_forced());
                            if let Some(scheduled) = scheduled {
                                scheduled.complete(if forced {
                                    ScheduledRealmResult::Done
                                } else {
                                    ScheduledRealmResult::Error(error.clone())
                                });
                            }
                            realm_phase(owner, "disposed");
                            shared.finish(owner);
                            shared.notify(PoolEvent {
                                kind: if forced {
                                    PoolEventKind::Settled
                                } else {
                                    PoolEventKind::Error
                                },
                                worker,
                                owner,
                                error: (!forced).then_some(error),
                            });
                            current_state = CurrentState::Idle;
                            continue;
                        }
                    }
                }
                let active = activate(item.live_mut());
                current = Some(Resident { item, active });
                shared.notify(PoolEvent {
                    kind: PoolEventKind::Activated,
                    worker,
                    owner,
                    error: None,
                });
            }
        }

        let mut resident = current.take().expect("reactor worker claimed no workload");
        let owner = resident.item.owner;
        let outcome = drive_slice(resident.item.live_mut(), &mut resident.active, &shared);
        let (result, event) = match outcome {
            Ok(Slice::Preempted) => {
                realm_phase(owner, "preempted");
                // The realm still has work it could complete immediately, so it
                // has to stay queued. Its readiness completions were already
                // consumed, and nothing else will signal a realm whose
                // remaining work is a resolved promise chain — parking it
                // without a ready entry would strand it forever. Re-queue at
                // the same priority so it does not outrank whoever preempted it.
                shared.mark_runnable(owner);
                current_state = CurrentState::Runnable;
                current = Some(resident);
                continue;
            }
            Ok(Slice::Quiescent { polling }) => {
                realm_phase(owner, if polling { "polling" } else { "waiting" });
                // A realm whose only remaining work is invisible to the kernel
                // has nothing that can signal it. Borrow a timer from the main
                // realm so it is re-signalled like any other readiness event,
                // instead of holding this thread on a timed wait.
                if polling {
                    request_scheduler_poll(owner, SCHEDULER_POLL_INTERVAL_MS);
                }
                current_state = CurrentState::Idle;
                current = Some(resident);
                continue;
            }
            Ok(Slice::Settled) => {
                realm_phase(owner, "settled");
                let result = if resident.item.live_mut().state.borrow().reload_requested {
                    ScheduledRealmResult::Reload
                } else {
                    ScheduledRealmResult::Done
                };
                (result, PoolEventKind::Settled)
            }
            Err(error) => {
                // A forced stop unwinds through the same path as a thrown
                // error. Report it as a deliberate termination rather than as
                // a realm failure, so `terminate({ force: true })` does not
                // surface the interrupt it asked for as a crash.
                let forced = resident
                    .item
                    .live_mut()
                    .scheduled
                    .as_ref()
                    .is_some_and(|scheduled| scheduled.was_forced());
                if forced {
                    (ScheduledRealmResult::Done, PoolEventKind::Settled)
                } else {
                    (ScheduledRealmResult::Error(error), PoolEventKind::Error)
                }
            }
        };
        let error = match &result {
            ScheduledRealmResult::Error(error) => Some(error.clone()),
            _ => None,
        };
        if let Some(scheduled) = resident.item.live_mut().scheduled.as_ref() {
            scheduled.complete(result);
        }
        let Resident { item, active } = resident;
        let mut workload = item.into_live();
        deactivate(&mut workload, active);
        drop_workload(workload);
        shared.finish(owner);
        current_state = CurrentState::Idle;
        shared.notify(PoolEvent {
            kind: event,
            worker,
            owner,
            error,
        });
    }
    if let Some(resident) = current {
        shared.park(resident);
    }
}

fn create_workload(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let entry = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if entry.is_empty() {
        v8util::throw_error(scope, "createWorkload: entry path is required");
        return;
    }
    let parent = get_state(scope);
    let (process_env, package_map_json, import_rules) = {
        let parent = parent.borrow();
        (
            parent.process_env.clone(),
            parent.package_map_json.clone(),
            parent.import_rules.clone(),
        )
    };
    let Some(pool) = process_pool().lock().unwrap().clone() else {
        v8util::throw_error(scope, "createWorkload: process reactor is not running");
        return;
    };
    let owner = next_owner();
    let async_pipe = match create_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            v8util::throw_error(scope, &format!("createWorkload: {error}"));
            return;
        }
    };
    let wake_fd = async_pipe.0;
    realm_created(
        owner,
        get_state(scope).borrow().scheduler_workload_owner,
        &entry,
    );
    let pending = PendingWorkload {
        owner,
        inner: Some(Box::new(PendingWorkloadInner {
            entry,
            process_env,
            package_map_json,
            import_rules,
            channel_rx: None,
            channel_tx: None,
            wake_read_fd: None,
            wake_write_fd: None,
            watch_mode: false,
            repl_mode: false,
            realm_data: None,
            realm_bootstrap_data: None,
            reload_requested_signal: None,
            scheduled: None,
            port_fds: None,
            async_pipe,
        })),
    };
    pool.submit(PoolItem {
        owner,
        workload: PoolWorkload::Pending(pending),
    });
    let result = v8::Object::new(scope);
    for (name, value) in [
        ("owner", v8::Integer::new_from_unsigned(scope, owner).into()),
        ("wakeFd", v8::Integer::new(scope, wake_fd).into()),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

fn create_scheduled_realm(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(pool) = process_pool().lock().unwrap().clone() else {
        v8util::throw_error(
            scope,
            "createScheduledRealm: process reactor is not running",
        );
        return;
    };
    let entry_value = args.get(1);
    let entry = if entry_value.is_null_or_undefined() {
        String::new()
    } else {
        entry_value
            .to_string(scope)
            .map(|value| value.to_rust_string_lossy(scope))
            .unwrap_or_default()
    };
    let repl_mode = args.get(6).boolean_value(scope);
    if entry.is_empty() && !repl_mode {
        v8util::throw_error(scope, "createScheduledRealm: entry path is required");
        return;
    }
    let mut process_env = get_state(scope).borrow().process_env.clone();
    let root = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if !root.is_empty() {
        process_env.root = std::path::PathBuf::from(root);
    }
    let import_rules = match crate::realm::native::parse_and_merge_rules(scope, args.get(2)) {
        Ok(rules) => rules,
        Err(error) => {
            v8util::throw_error(scope, &format!("createScheduledRealm: {error}"));
            return;
        }
    };
    let package_map_json =
        crate::realm::native::resolve_child_package_map(scope, &process_env.root);
    let watch_mode = args.get(3).boolean_value(scope);
    let realm_data = optional_string(scope, args.get(4));
    let realm_bootstrap_data = optional_string(scope, args.get(5));
    let (parent_tx, child_rx) = mpsc::channel();
    let (child_tx, parent_rx) = mpsc::channel();
    let (child_wake_read, child_wake_write) = match create_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            v8util::throw_error(scope, &format!("createScheduledRealm: {error}"));
            return;
        }
    };
    let (parent_wake_read, parent_wake_write) = match create_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            unsafe {
                libc::close(child_wake_read);
                libc::close(child_wake_write);
            }
            v8util::throw_error(scope, &format!("createScheduledRealm: {error}"));
            return;
        }
    };
    let (completion_wake_read, completion_wake_write) = match create_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            unsafe {
                libc::close(child_wake_read);
                libc::close(child_wake_write);
                libc::close(parent_wake_read);
                libc::close(parent_wake_write);
            }
            v8util::throw_error(scope, &format!("createScheduledRealm: {error}"));
            return;
        }
    };
    let async_pipe = match create_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            unsafe {
                libc::close(child_wake_read);
                libc::close(child_wake_write);
                libc::close(parent_wake_read);
                libc::close(parent_wake_write);
                libc::close(completion_wake_read);
                libc::close(completion_wake_write);
            }
            v8util::throw_error(scope, &format!("createScheduledRealm: {error}"));
            return;
        }
    };
    let reload_requested = Arc::new(AtomicBool::new(false));
    let owner = next_owner();
    let scheduled = Arc::new(ScheduledRealmState {
        owner,
        result: Mutex::new(None),
        parent_wake_write: completion_wake_write,
        isolate_handle: Mutex::new(None),
        force_requested: AtomicBool::new(false),
    });
    let wake_fd = async_pipe.0;
    realm_created(
        owner,
        get_state(scope).borrow().scheduler_workload_owner,
        &entry,
    );
    let pending = PendingWorkload {
        owner,
        inner: Some(Box::new(PendingWorkloadInner {
            entry,
            process_env,
            package_map_json,
            import_rules,
            channel_rx: Some(child_rx),
            channel_tx: Some(child_tx),
            wake_read_fd: Some(child_wake_read),
            wake_write_fd: Some(parent_wake_write),
            watch_mode,
            repl_mode,
            realm_data,
            realm_bootstrap_data,
            reload_requested_signal: Some(reload_requested),
            scheduled: Some(Arc::clone(&scheduled)),
            port_fds: Some((child_wake_read, parent_wake_write)),
            async_pipe,
        })),
    };
    let handle = next_handle();
    scheduled_realms().lock().unwrap().insert(
        handle,
        ScheduledRealmHandle {
            tx: parent_tx,
            rx: parent_rx,
            child_wake_write,
            parent_wake_read,
            completion_wake_read,
            state: scheduled,
        },
    );
    pool.submit(PoolItem {
        owner,
        workload: PoolWorkload::Pending(pending),
    });
    let result = v8::Object::new(scope);
    for (name, value) in [
        ("handle", handle_value(scope, handle)),
        ("owner", v8::Integer::new_from_unsigned(scope, owner).into()),
        ("wakeFd", v8::Integer::new(scope, wake_fd).into()),
        (
            "portWakeFd",
            v8::Integer::new(scope, parent_wake_read).into(),
        ),
        (
            "completionFd",
            v8::Integer::new(scope, completion_wake_read).into(),
        ),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

fn optional_string(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<String> {
    if value.is_null_or_undefined() {
        None
    } else if value.is_string() {
        value
            .to_string(scope)
            .map(|value| value.to_rust_string_lossy(scope))
    } else {
        v8::json::stringify(scope, value).map(|value| value.to_rust_string_lossy(scope))
    }
}

fn copy_uint8_array(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    let array = v8::Local::<v8::Uint8Array>::try_from(value).ok()?;
    let buffer = array.buffer(scope)?;
    let data = buffer.data()?;
    Some(
        unsafe {
            std::slice::from_raw_parts(
                (data.as_ptr() as *const u8).add(array.byte_offset()),
                array.byte_length(),
            )
        }
        .to_vec(),
    )
}

fn scheduled_realm_send(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let header = copy_uint8_array(scope, args.get(1)).unwrap_or_default();
    let Some(data) = copy_uint8_array(scope, args.get(2)) else {
        v8util::throw_error(
            scope,
            "scheduledRealmSend: third argument must be a Uint8Array",
        );
        return;
    };
    let transfer_stores = if let Ok(values) = v8::Local::<v8::Array>::try_from(args.get(3)) {
        let mut stores = Vec::new();
        for index in 0..values.length() {
            if let Some(value) = values.get_index(scope, index)
                && let Some(bytes) = copy_uint8_array(scope, value)
            {
                stores.push(bytes);
            }
        }
        stores
    } else {
        Vec::new()
    };
    let transfer_ports = crate::realm::thread::extract_port_infos(scope, args.get(4));
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(&handle) else {
        v8util::throw_error(
            scope,
            &format!("scheduledRealmSend: invalid realm handle {handle}"),
        );
        return;
    };
    FRAMES_SENT.fetch_add(1, Ordering::Relaxed);
    let _ = realm.tx.send(crate::realm::thread::ThreadMessage {
        header,
        data,
        transfer_stores,
        transfer_ports,
    });
    crate::fdutil::wake(realm.child_wake_write);
}

fn scheduled_realm_recv(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(&handle) else {
        v8util::throw_error(
            scope,
            &format!("scheduledRealmRecv: invalid realm handle {handle}"),
        );
        return;
    };
    // Clear the signal before draining the queue. A concurrent send after the
    // drain then leaves its wake byte behind instead of having it consumed
    // underneath the newly queued message.
    crate::fdutil::drain(realm.parent_wake_read);
    let mut messages = Vec::new();
    while let Ok(message) = realm.rx.try_recv() {
        messages.push(message);
    }
    rv.set(crate::realm::transit::build_message_array(scope, messages).into());
}

fn take_scheduled_realm_status(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(&handle) else {
        v8util::throw_error(
            scope,
            &format!("takeScheduledRealmStatus: invalid realm handle {handle}"),
        );
        return;
    };
    crate::fdutil::drain(realm.completion_wake_read);
    let status = realm.state.result.lock().unwrap().clone();
    let result = v8::Object::new(scope);
    let (kind, error) = match status {
        None => ("pending", None),
        Some(ScheduledRealmResult::Done) => ("done", None),
        Some(ScheduledRealmResult::Reload) => ("reload", None),
        Some(ScheduledRealmResult::Error(error)) => ("error", Some(error)),
    };
    let key = v8::String::new(scope, "kind").unwrap();
    let value = v8::String::new(scope, kind).unwrap();
    result.set(scope, key.into(), value.into());
    if let Some(error) = error {
        let key = v8::String::new(scope, "error").unwrap();
        let value = v8::String::new(scope, &error).unwrap();
        result.set(scope, key.into(), value.into());
    }
    rv.set(result.into());
}

/// JS: `forceScheduledRealm(handle) -> boolean`
///
/// Interrupt a reactor-pooled realm's JavaScript execution.
///
/// Cooperative termination cannot reach a realm spinning in synchronous
/// JavaScript, because such a realm never returns to the loop to observe the
/// request. This unwinds it, freeing the reactor thread it was holding.
fn force_scheduled_realm(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let state = scheduled_realms()
        .lock()
        .unwrap()
        .get(&handle)
        .map(|realm| Arc::clone(&realm.state));
    let forced = state.is_some_and(|state| state.force());
    rv.set(v8::Boolean::new(scope, forced).into());
}

fn close_scheduled_realm(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let realm = scheduled_realms().lock().unwrap().remove(&handle);
    if realm.is_none() {
        v8util::throw_error(
            scope,
            &format!("closeScheduledRealm: invalid realm handle {handle}"),
        );
    }
}

/// Start the process-wide reactor pool and return the descriptor its events
/// arrive on.
///
/// There is exactly one pool per process: every realm, wherever it is created,
/// is scheduled on it. Modelling it as a singleton rather than a table of
/// queues removes a generality that never existed — creating a second queue
/// used to silently replace the pool that realms were already submitting to.
fn start_reactor_pool(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    start_readiness_recorder();
    let mut registered = process_pool().lock().unwrap();
    if registered.is_some() {
        v8util::throw_error(
            scope,
            "startReactorPool: process reactor is already running",
        );
        return;
    }
    let shared = Arc::new(PoolShared::new());
    let control_fd = shared.wake.read_fd();
    *registered = Some(shared);
    rv.set(v8::Integer::new(scope, control_fd).into());
}

/// Resolve the process reactor pool, or throw when it is not running.
fn require_pool(scope: &mut v8::PinScope, caller: &str) -> Option<Arc<PoolShared>> {
    let pool = process_pool().lock().unwrap().clone();
    if pool.is_none() {
        v8util::throw_error(scope, &format!("{caller}: process reactor is not running"));
    }
    pool
}

fn create_reactor_thread(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(shared) = require_pool(scope, "createReactorThread") else {
        return;
    };
    let (worker, wake) = shared.register_worker();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_shared = Arc::clone(&shared);
    let thread_stop = Arc::clone(&stop);
    let thread_wake = Arc::clone(&wake);
    let join =
        std::thread::spawn(move || run_worker(worker, thread_shared, thread_stop, thread_wake));
    let reactor = ReactorThread {
        shared,
        stop,
        wake,
        join: Some(join),
    };
    let handle = next_handle();
    REACTOR_THREADS.with(|threads| threads.borrow_mut().insert(handle, reactor));
    rv.set(handle_value(scope, handle));
}

fn close_reactor_thread(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let thread = REACTOR_THREADS.with(|threads| threads.borrow_mut().remove(&handle));
    let Some(mut thread) = thread else {
        v8util::throw_error(
            scope,
            &format!("closeReactorThread: invalid thread {handle}"),
        );
        return;
    };
    thread.shutdown();
}

/// Read-only snapshot of the reactor pool's scheduling state.
///
/// A realm that stops making progress is either parked with nothing queued to
/// wake it, or queued behind work that never drains. Those look identical from
/// TypeScript, which can see neither the parked set nor the ready heap, so this
/// reports both along with the entered realms and the idle worker count.
/// Diagnostic only: it takes the queue lock, copies counters, and mutates
/// nothing.
fn reactor_pool_stats(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let pool = process_pool().lock().unwrap().clone();
    let Some(pool) = pool else {
        rv.set(v8::null(scope).into());
        return;
    };
    let inner = pool.inner.lock().unwrap();
    let object = v8::Object::new(scope);
    for (name, value) in [
        ("parked", inner.parked.len() as f64),
        ("residents", inner.residents.len() as f64),
        ("ready", inner.ready.len() as f64),
        ("waitingWorkers", inner.waiting.len() as f64),
        ("workers", inner.wakes.len() as f64),
        ("queuedEvents", inner.events.len() as f64),
        ("priorities", inner.priorities.len() as f64),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        let number = v8::Number::new(scope, value);
        object.set(scope, key.into(), number.into());
    }
    // Which parked realms have nothing in the ready heap: the set that cannot
    // be claimed by any worker no matter how long it waits.
    let queued: std::collections::HashSet<u32> =
        inner.ready.iter().map(|entry| entry.owner).collect();
    let unclaimable = inner
        .parked
        .keys()
        .filter(|owner| !queued.contains(owner))
        .count();
    let key = v8::String::new(scope, "parkedWithNothingQueued").unwrap();
    let number = v8::Number::new(scope, unclaimable as f64);
    object.set(scope, key.into(), number.into());
    drop(inner);
    // The mailbox is the link between a readiness event and the realm it wakes.
    // Undrained changes mean the controller stopped servicing it; undelivered
    // events mean a realm was signalled but never came back to collect them.
    let mail = mailbox().inner.lock().unwrap();
    for (name, value) in [
        (
            "controllerRegistrations",
            CONTROLLER_REGISTRATIONS.load(Ordering::Relaxed) as f64,
        ),
        (
            "controllerRouted",
            CONTROLLER_ROUTED.load(Ordering::Relaxed) as f64,
        ),
        (
            "signalsDropped",
            SIGNALS_DROPPED.load(Ordering::Relaxed) as f64,
        ),
        ("framesSent", FRAMES_SENT.load(Ordering::Relaxed) as f64),
        (
            "framesDrained",
            FRAMES_DRAINED.load(Ordering::Relaxed) as f64,
        ),
        ("mailboxChanges", mail.changes.len() as f64),
        ("readinessBorrowedFds", mail.borrowed_fds.len() as f64),
        ("mailboxOwnersWithEvents", mail.events.len() as f64),
        (
            "mailboxEvents",
            mail.events.values().map(Vec::len).sum::<usize>() as f64,
        ),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        let number = v8::Number::new(scope, value);
        object.set(scope, key.into(), number.into());
    }
    rv.set(object.into());
}

fn signal_reactor_owner(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    rv.set(v8::Boolean::new(scope, signal_owner(owner)).into());
}

/// Publish native work to its originating scheduled isolate without routing
/// through the process I/O controller. The queue is populated before this call.
pub(crate) fn signal_owner(owner: u32) -> bool {
    let pool = owner_pools()
        .lock()
        .unwrap()
        .get(&owner)
        .and_then(Weak::upgrade);
    pool.is_some_and(|pool| pool.signal(owner))
}

fn take_reactor_events(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(pool) = require_pool(scope, "takeReactorEvents") else {
        return;
    };
    pool.drain_wake();
    let events = pool
        .inner
        .lock()
        .unwrap()
        .events
        .drain(..)
        .collect::<Vec<_>>();
    let result = v8::Array::new(scope, events.len() as i32);
    for (index, event) in events.into_iter().enumerate() {
        let value = v8::Object::new(scope);
        let kind = match event.kind {
            PoolEventKind::Activated => "activated",
            PoolEventKind::Settled => "settled",
            PoolEventKind::Error => "error",
        };
        for (name, field) in [
            ("kind", v8::String::new(scope, kind).unwrap().into()),
            (
                "worker",
                v8::Integer::new_from_unsigned(scope, event.worker as u32).into(),
            ),
            (
                "owner",
                v8::Integer::new_from_unsigned(scope, event.owner).into(),
            ),
        ] {
            let key = v8::String::new(scope, name).unwrap();
            value.set(scope, key.into(), field);
        }
        if let Some(error) = event.error {
            let key = v8::String::new(scope, "error").unwrap();
            let error = v8::String::new(scope, &error).unwrap();
            value.set(scope, key.into(), error.into());
        }
        result.set_index(scope, index as u32, value.into());
    }
    rv.set(result.into());
}

/// Tear down the process reactor pool.
///
/// Every reactor thread must already have been stopped. Validation happens
/// before any mutation so a refused close leaves the pool exactly as it was.
fn stop_reactor_pool(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let attached = process_pool()
        .lock()
        .unwrap()
        .as_ref()
        .map(Arc::strong_count);
    let Some(attached) = attached else {
        v8util::throw_error(scope, "stopReactorPool: process reactor is not running");
        return;
    };
    // Only the registration itself may hold a reference by this point.
    if attached > 1 {
        v8util::throw_error(scope, "stopReactorPool: reactor threads are still attached");
        return;
    }
    let pool = process_pool()
        .lock()
        .unwrap()
        .take()
        .expect("reactor pool disappeared between validation and close");
    {
        let inner = &mut *pool.inner.lock().unwrap();
        inner.shutdown = true;
        inner.wake_all();
    }
    let Ok(pool) = Arc::try_unwrap(pool) else {
        v8util::throw_error(scope, "stopReactorPool: reactor threads are still attached");
        return;
    };
    let parked = std::mem::take(&mut pool.inner.lock().unwrap().parked);
    // This callback runs while the root isolate is entered. A parked workload
    // owns a different SharedIsolate whose Locker therefore cannot be acquired
    // on this thread; dispose the stopped pool's isolates on a clean thread.
    let disposal = std::thread::spawn(move || {
        for item in parked.into_values() {
            match item.workload {
                PoolWorkload::Live(workload) => drop_workload(workload.0),
                PoolWorkload::Pending(pending) => drop(pending),
            }
        }
    });
    if disposal.join().is_err() {
        v8util::throw_error(scope, "stopReactorPool: parked Realm disposal failed");
    }
}

fn readiness_change_from_args(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
) -> ReadinessChange {
    ReadinessChange {
        ident: args.get(0).number_value(scope).unwrap_or(0.0),
        filter: args.get(1).int32_value(scope).unwrap_or(0),
        flags: args.get(2).uint32_value(scope).unwrap_or(0),
        fflags: args.get(3).uint32_value(scope).unwrap_or(0),
        data: args.get(4).number_value(scope).unwrap_or(0.0),
        udata: args.get(5).number_value(scope).unwrap_or(0.0),
        cancel_owner: None,
        scheduler_wake: false,
        scheduler_poll: false,
        borrowed_fd: None,
        trace_id: 0,
    }
}

fn register_process_readiness(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let mut change = readiness_change_from_args(scope, &args);
    if readiness_trace_enabled() {
        change.trace_id = next_handle();
        trace_readiness(
            change.trace_id,
            (change.udata / 4294967296.0) as u32,
            if change.flags & 2 != 0 {
                "cancel-requested"
            } else {
                "registered"
            },
            change.ident,
            change.filter,
            change.udata,
        );
    }
    let mut inner = mailbox().inner.lock().unwrap();
    if change.flags & 1 != 0 && matches!(change.filter, -1 | -2 | -4) {
        match inner.borrow_fd(change.ident as RawFd) {
            Ok(fd) => change.borrowed_fd = Some(fd),
            Err(error) => {
                trace_readiness(
                    change.trace_id,
                    (change.udata / 4294967296.0) as u32,
                    "registration-failed",
                    change.ident,
                    change.filter,
                    change.udata,
                );
                drop(inner);
                v8util::throw_error(
                    scope,
                    &format!("readiness descriptor {}: {error}", change.ident),
                );
                return;
            }
        }
    }
    rv.set(v8::Number::new(scope, change.trace_id as f64).into());
    inner.changes.push(change);
    drop(inner);
    mailbox().notify();
}

fn register_reactor_wake(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    let fd = args.get(1).int32_value(scope).unwrap_or(-1);
    // Retirement removes the owner before closing its wake pipe. Hold the
    // same lock while borrowing it so fast-finishing Realms cannot race us.
    let owners = owner_pools().lock().unwrap();
    if !owners.contains_key(&owner) {
        return;
    }
    let mut change = ReadinessChange::control(owner as f64, 0.0);
    change.ident = fd as f64;
    change.scheduler_wake = true;
    if readiness_trace_enabled() {
        change.trace_id = next_handle();
        trace_readiness(
            change.trace_id,
            owner,
            "wake-registered",
            fd as f64,
            -1,
            owner as f64,
        );
    }
    let mut inner = mailbox().inner.lock().unwrap();
    match inner.borrow_fd(fd) {
        Ok(fd) => change.borrowed_fd = Some(fd),
        Err(error) => {
            drop(inner);
            drop(owners);
            v8util::throw_error(scope, &format!("reactor wake descriptor {fd}: {error}"));
            return;
        }
    }
    inner.changes.push(change);
    drop(inner);
    drop(owners);
    mailbox().notify();
}

fn take_readiness_changes(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    mailbox().drain_wake();
    let changes = std::mem::take(&mut mailbox().inner.lock().unwrap().changes);
    let values = v8::Array::new(scope, changes.len() as i32);
    for (index, change) in changes.into_iter().enumerate() {
        trace_readiness(
            change.trace_id,
            (change.udata / 4294967296.0) as u32,
            "controller-received",
            change.ident,
            change.filter,
            change.udata,
        );
        let tuple = v8::Array::new(scope, 11);
        for (field, value) in [
            v8::Number::new(scope, change.ident).into(),
            v8::Integer::new(scope, change.filter).into(),
            v8::Integer::new_from_unsigned(scope, change.flags).into(),
            v8::Integer::new_from_unsigned(scope, change.fflags).into(),
            v8::Number::new(scope, change.data).into(),
            v8::Number::new(scope, change.udata).into(),
            change
                .cancel_owner
                .map(|value| v8::Integer::new_from_unsigned(scope, value).into())
                .unwrap_or_else(|| v8::null(scope).into()),
            v8::Boolean::new(scope, change.scheduler_wake).into(),
            v8::Boolean::new(scope, change.scheduler_poll).into(),
            change
                .borrowed_fd
                .map(|fd| v8::Integer::new(scope, fd).into())
                .unwrap_or_else(|| v8::null(scope).into()),
            v8::Number::new(scope, change.trace_id as f64).into(),
        ]
        .into_iter()
        .enumerate()
        {
            tuple.set_index(scope, field as u32, value);
        }
        values.set_index(scope, index as u32, tuple.into());
    }
    rv.set(values.into());
}

fn release_readiness_fd(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let fd = args.get(0).int32_value(scope).unwrap_or(-1);
    mailbox().inner.lock().unwrap().borrowed_fds.remove(&fd);
}

fn route_process_readiness(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    let mut completion: ReadinessCompletion = [0.0; COMPLETION_SLOTS];
    for (slot, value) in completion[..7].iter_mut().enumerate() {
        *value = args.get(slot as i32 + 1).number_value(scope).unwrap_or(0.0);
    }
    completion[7] = args.get(9).number_value(scope).unwrap_or(0.0);
    trace_readiness(
        completion[7] as u64,
        owner,
        "routed",
        completion[0],
        completion[1] as i32,
        completion[5],
    );
    CONTROLLER_ROUTED.fetch_add(1, Ordering::Relaxed);
    mailbox()
        .inner
        .lock()
        .unwrap()
        .events
        .entry(owner)
        .or_default()
        .push(completion);
    if args.get(8).boolean_value(scope) {
        let owners = owner_pools().lock().unwrap();
        if let Some(pool) = owners.get(&owner).and_then(Weak::upgrade) {
            pool.signal(owner);
            trace_readiness(
                completion[7] as u64,
                owner,
                "owner-signalled",
                completion[0],
                completion[1] as i32,
                completion[5],
            );
        } else {
            trace_readiness(
                completion[7] as u64,
                owner,
                "owner-absent-at-route",
                completion[0],
                completion[1] as i32,
                completion[5],
            );
        }
    }
}

/// Hand a realm every readiness completion routed to it, as one flat batch.
///
/// The batch is a single `Float64Array` of `COMPLETION_SLOTS` values per event,
/// so a drain costs one allocation regardless of how many completions it
/// carries, and no encoding at all.
fn take_shared_loop_events(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    let events = mailbox()
        .inner
        .lock()
        .unwrap()
        .events
        .remove(&owner)
        .unwrap_or_default();
    for event in &events {
        trace_readiness(
            event[7] as u64,
            owner,
            "mailbox-drained",
            event[0],
            event[1] as i32,
            event[5],
        );
    }
    let slots = events.len() * COMPLETION_SLOTS;
    let bytes = slots * std::mem::size_of::<f64>();
    let store = v8::ArrayBuffer::new_backing_store(scope, bytes);
    if bytes > 0 {
        let target = store.data().unwrap().as_ptr() as *mut f64;
        for (index, completion) in events.iter().enumerate() {
            // SAFETY: `target` owns `slots` f64s and `index` stays within
            // `events.len()`, so each write lands inside the allocation.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    completion.as_ptr(),
                    target.add(index * COMPLETION_SLOTS),
                    COMPLETION_SLOTS,
                );
            }
        }
    }
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store.make_shared());
    match v8::Float64Array::new(scope, buffer, 0, slots) {
        Some(array) => rv.set(array.into()),
        None => rv.set(v8::null(scope).into()),
    }
}

fn process_readiness_control_fd(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Integer::new(scope, mailbox().wake.read_fd()).into());
}

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let names = [
        "currentWorkloadOwner",
        "usesProcessReadiness",
        "setSchedulerPollingRequired",
        "createWorkload",
        "createScheduledRealm",
        "scheduledRealmSend",
        "scheduledRealmRecv",
        "takeScheduledRealmStatus",
        "closeScheduledRealm",
        "forceScheduledRealm",
        "startReactorPool",
        "createReactorThread",
        "closeReactorThread",
        "signalReactorOwner",
        "reactorPoolStats",
        "setReadinessHeartbeat",
        "takeReactorEvents",
        "stopReactorPool",
        "processReadinessControlFd",
        "registerProcessReadiness",
        "registerReactorWake",
        "takeSharedReadinessChanges",
        "releaseSharedReadinessFd",
        "routeProcessReadiness",
        "takeSharedLoopEvents",
        "recordReadinessTrace",
        "readinessTraceSnapshot",
        "recordRealmState",
    ];
    let export_names: Vec<v8::Local<v8::String>> = names
        .iter()
        .map(|name| v8::String::new(scope, name).unwrap())
        .collect();
    let module_name = v8::String::new(scope, "internal:scheduler-native").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    v8::callback_scope!(unsafe let scope, context);
    crate::set_fn!(scope, module, "recordRealmState", record_realm_state);
    crate::set_fn!(
        scope,
        module,
        "currentWorkloadOwner",
        current_workload_owner
    );
    crate::set_fn!(
        scope,
        module,
        "usesProcessReadiness",
        uses_process_readiness
    );
    crate::set_fn!(
        scope,
        module,
        "setSchedulerPollingRequired",
        set_scheduler_polling_required
    );
    crate::set_fn!(scope, module, "createWorkload", create_workload);
    crate::set_fn!(
        scope,
        module,
        "createScheduledRealm",
        create_scheduled_realm
    );
    crate::set_fn!(scope, module, "scheduledRealmSend", scheduled_realm_send);
    crate::set_fn!(scope, module, "scheduledRealmRecv", scheduled_realm_recv);
    crate::set_fn!(
        scope,
        module,
        "takeScheduledRealmStatus",
        take_scheduled_realm_status
    );
    crate::set_fn!(scope, module, "closeScheduledRealm", close_scheduled_realm);
    crate::set_fn!(scope, module, "forceScheduledRealm", force_scheduled_realm);
    crate::set_fn!(scope, module, "startReactorPool", start_reactor_pool);
    crate::set_fn!(scope, module, "createReactorThread", create_reactor_thread);
    crate::set_fn!(scope, module, "closeReactorThread", close_reactor_thread);
    crate::set_fn!(scope, module, "signalReactorOwner", signal_reactor_owner);
    crate::set_fn!(scope, module, "reactorPoolStats", reactor_pool_stats);
    crate::set_fn!(
        scope,
        module,
        "setReadinessHeartbeat",
        set_readiness_heartbeat
    );
    crate::set_fn!(scope, module, "takeReactorEvents", take_reactor_events);
    crate::set_fn!(scope, module, "stopReactorPool", stop_reactor_pool);
    crate::set_fn!(
        scope,
        module,
        "processReadinessControlFd",
        process_readiness_control_fd
    );
    crate::set_fn!(
        scope,
        module,
        "registerProcessReadiness",
        register_process_readiness
    );
    crate::set_fn!(scope, module, "registerReactorWake", register_reactor_wake);
    crate::set_fn!(
        scope,
        module,
        "takeSharedReadinessChanges",
        take_readiness_changes
    );
    crate::set_fn!(
        scope,
        module,
        "releaseSharedReadinessFd",
        release_readiness_fd
    );
    crate::set_fn!(
        scope,
        module,
        "routeProcessReadiness",
        route_process_readiness
    );
    crate::set_fn!(
        scope,
        module,
        "takeSharedLoopEvents",
        take_shared_loop_events
    );
    crate::set_fn!(
        scope,
        module,
        "recordReadinessTrace",
        record_readiness_trace
    );
    crate::set_fn!(
        scope,
        module,
        "readinessTraceSnapshot",
        readiness_trace_snapshot
    );
    Some(v8::undefined(scope).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn native_notifications_target_the_owner_and_stop_at_retirement() {
        let pool = Arc::new(PoolShared::new());
        let (worker, _) = pool.register_worker();
        let owner = next_owner();
        let other = next_owner();
        pool.inner.lock().unwrap().residents.insert(owner, worker);
        owner_pools()
            .lock()
            .unwrap()
            .insert(owner, Arc::downgrade(&pool));
        let (read, write) = create_pipe().unwrap();
        let previous = crate::async_rt::swap_state(Some(crate::async_rt::new_state_with_pipe(
            read,
            write,
            Some(owner),
        )));
        let (_, wake) = crate::async_rt::completion_handle().unwrap();
        drop(crate::async_rt::swap_state(previous));
        // No controller exists in this test. All three queue producers share
        // this handle, which outlives the entered isolate state.
        wake.notify();
        assert_eq!(pool.inner.lock().unwrap().priorities.get(&owner), Some(&1));
        let mut byte = 0_u8;
        assert_eq!(
            unsafe { libc::read(read, (&mut byte as *mut u8).cast(), 1) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EAGAIN)
        );
        pool.finish(owner);
        owner_pools().lock().unwrap().remove(&owner);
        pool.inner.lock().unwrap().residents.insert(other, worker);
        wake.notify();
        assert!(pool.inner.lock().unwrap().priorities.is_empty());
    }

    #[test]
    fn readiness_trace_is_bounded_and_reports_eviction() {
        let mut trace = ReadinessTrace::default();
        for operation in 1..=5 {
            trace.push(
                ReadinessTraceEvent {
                    sequence: 0,
                    elapsed_us: 0,
                    operation,
                    owner: 7,
                    stage: "registered".to_owned(),
                    ident: 9.0,
                    filter: -1,
                    token: 9.0,
                },
                3,
            );
        }
        assert_eq!(trace.sequence, 5);
        assert_eq!(trace.dropped, 2);
        assert_eq!(
            trace
                .events
                .iter()
                .map(|event| event.operation)
                .collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
        assert_eq!(trace.events.front().unwrap().sequence, 3);
    }

    #[test]
    fn readiness_borrow_survives_original_descriptor_reuse() {
        let (read, write) = create_pipe().unwrap();
        let mut mailbox = MailboxInner::default();
        assert!(mailbox.borrow_fd(-1).is_err());
        assert!(mailbox.borrowed_fds.is_empty());
        let borrowed = mailbox.borrow_fd(read).unwrap();
        assert_ne!(borrowed, read);
        unsafe {
            // Replace the original number with the pipe's write endpoint.
            assert_eq!(libc::dup2(write, read), read);
            assert_eq!(libc::write(write, b"x".as_ptr().cast(), 1), 1);
            let mut byte = 0_u8;
            assert_eq!(libc::read(borrowed, (&mut byte as *mut u8).cast(), 1), 1);
            assert_eq!(byte, b'x');
            libc::close(read);
            libc::close(write);
        }
        mailbox.borrowed_fds.remove(&borrowed);
        assert!(mailbox.borrowed_fds.is_empty());
    }

    #[test]
    fn stale_ready_entries_do_not_hide_waiting_work() {
        for (stale_owner, generation) in [(1, 1), (1, 2), (2, 1), (2, 2)] {
            let pool = PoolShared::new();
            {
                let mut inner = pool.inner.lock().unwrap();
                // Claiming a previously signalled Realm resets its priority,
                // leaving older heap entries behind while it keeps running.
                inner.generations.insert(stale_owner, generation);
                inner.ready.push(ReadyEntry {
                    priority: 10,
                    generation: 1,
                    owner: stale_owner,
                });
                inner.priorities.insert(3, 1);
                inner.generations.insert(3, 1);
                inner.ready.push(ReadyEntry {
                    priority: 1,
                    generation: 1,
                    owner: 3,
                });
            }
            assert!(
                pool.should_yield(1),
                "stale entry for owner {stale_owner} must not hide runnable owner 3"
            );
        }
    }

    #[test]
    fn empty_pool_waits_for_work() {
        let pool = Arc::new(PoolShared::new());
        let (worker, wake) = pool.register_worker();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_pool = Arc::clone(&pool);
        let worker_stop = Arc::clone(&stop);
        let worker_wake = Arc::clone(&wake);
        let (result_tx, result_rx) = mpsc::channel();
        let joiner = std::thread::spawn(move || {
            result_tx
                .send(worker_pool.claim(
                    worker,
                    &worker_wake,
                    None,
                    &worker_stop,
                    CurrentState::Idle,
                ))
                .unwrap();
        });

        assert!(
            result_rx.recv_timeout(Duration::from_millis(10)).is_err(),
            "an empty pool must not claim an initial workload"
        );
        {
            let _guard = pool.inner.lock().unwrap();
            stop.store(true, Ordering::Release);
        }
        wake.notify_all();
        assert!(matches!(
            result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Claim::Shutdown
        ));
        joiner.join().unwrap();
    }

    /// A signal must reach only the worker that can act on it: the resident
    /// when the realm is entered, otherwise a single waiting worker.
    #[test]
    fn signals_target_only_the_worker_that_can_act() {
        let pool = PoolShared::new();
        let (worker_a, _wake_a) = pool.register_worker();
        let (worker_b, _wake_b) = pool.register_worker();
        let inner = &mut *pool.inner.lock().unwrap();
        inner.waiting.push_back(worker_a);
        inner.waiting.push_back(worker_b);

        // Entered by B: only B can run it, regardless of who is waiting.
        inner.residents.insert(9, worker_b);
        assert_eq!(inner.wake_target(9), Some(worker_b));

        // Entered nowhere: the longest-waiting worker takes it, and exactly one
        // worker is chosen rather than the whole pool.
        assert_eq!(inner.wake_target(4), Some(worker_a));

        // Nobody waiting: no wake-up is owed, because a running worker always
        // re-examines the queue before parking.
        inner.waiting.clear();
        assert_eq!(inner.wake_target(4), None);
        // A resident is still woken even when it is the only worker left.
        assert_eq!(inner.wake_target(9), Some(worker_b));
    }
}
