//! Minimal native substrate for the TypeScript process scheduler.
//!
//! TypeScript owns readiness registration, runnable priority, worker placement,
//! lifecycle, and metrics. Native code is limited to the operations TypeScript
//! cannot perform: moving V8 isolates between OS threads, entering and pumping
//! an isolate, and carrying scalar readiness metadata across isolate boundaries.

use std::{
    cell::RefCell,
    collections::{BinaryHeap, HashMap, HashSet, VecDeque},
    os::unix::io::RawFd,
    rc::Rc,
    sync::{
        Arc, Condvar, Mutex, RwLock, Weak,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc,
    },
};

use ::v8;

use crate::{
    loader,
    state::{FinoState, ProcessEnv, get_state},
};

struct Workload {
    owner: u32,
    context: v8::Global<v8::Context>,
    state: Rc<RefCell<FinoState>>,
    _module: v8::Global<v8::Module>,
    isolate: v8::OwnedIsolate,
    async_state: Option<crate::async_rt::IsolateAsyncState>,
    scheduled: Option<Arc<ScheduledRealmState>>,
    port_fds: Option<(RawFd, RawFd)>,
}

struct TransferWorkload(Workload);

// SAFETY: Workloads cross a thread boundary only while their isolate is exited.
// The receiving worker acquires V8's Locker before entering it, and exactly one
// worker owns the value at a time.
unsafe impl Send for TransferWorkload {}

/// Everything needed to construct a workload's isolate, captured at submission
/// time. Until a reactor first claims it, a workload is pure data — movable
/// between threads (and eventually serializable across nodes) with no V8
/// involvement. The isolate is constructed on the claiming reactor's thread.
struct WorkloadSpecInner {
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
    /// Wake pipe created at submission so the parent can watch `wakeFd`
    /// before the isolate exists; ownership moves into the isolate's async
    /// state at initialization.
    async_pipe: (RawFd, RawFd),
}

struct WorkloadSpec {
    owner: u32,
    class: u8,
    inner: Option<Box<WorkloadSpecInner>>,
}

impl WorkloadSpec {
    fn wake_read_fd(&self) -> RawFd {
        self.inner
            .as_ref()
            .map(|inner| inner.async_pipe.0)
            .unwrap_or(-1)
    }

    /// Construct the isolate on the calling thread. Consumes the spec; on
    /// failure the completion channel is returned so the allocation settles.
    fn initialize(mut self) -> Result<Workload, (String, Option<Arc<ScheduledRealmState>>)> {
        let inner = self
            .inner
            .take()
            .expect("workload spec already initialized");
        let scheduled = inner.scheduled.clone();
        setup_workload(*inner, self.owner).map_err(|error| (error, scheduled))
    }
}

impl Drop for WorkloadSpec {
    fn drop(&mut self) {
        let Some(inner) = self.inner.take() else {
            return;
        };
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
    _locker: crate::v8_threading::IsolateLocker,
}

thread_local! {
    static WORKLOADS: RefCell<Vec<Option<WorkloadSpec>>> = const { RefCell::new(Vec::new()) };
    static REACTOR_QUEUES: RefCell<Vec<Option<Arc<PoolShared>>>> = const { RefCell::new(Vec::new()) };
    static REACTOR_THREADS: RefCell<Vec<Option<ReactorThread>>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone)]
enum ScheduledRealmResult {
    Done,
    Reload,
    Error(String),
}

struct ScheduledRealmState {
    result: Mutex<Option<ScheduledRealmResult>>,
    parent_wake_write: RawFd,
}

impl ScheduledRealmState {
    fn complete(&self, result: ScheduledRealmResult) {
        *self.result.lock().unwrap() = Some(result);
        let byte = [1u8];
        unsafe {
            libc::write(self.parent_wake_write, byte.as_ptr().cast(), byte.len());
        }
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

fn scheduled_realms() -> &'static Mutex<Vec<Option<ScheduledRealmHandle>>> {
    static REALMS: std::sync::OnceLock<Mutex<Vec<Option<ScheduledRealmHandle>>>> =
        std::sync::OnceLock::new();
    REALMS.get_or_init(|| Mutex::new(Vec::new()))
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

fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [-1; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(format!(
            "pipe() failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    for fd in fds {
        unsafe {
            libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK);
        }
    }
    Ok((fds[0], fds[1]))
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

struct ReadinessChange {
    ident: f64,
    filter: i32,
    flags: u32,
    fflags: u32,
    data: f64,
    udata: f64,
    cancel_owner: Option<u32>,
    scheduler_wake: bool,
    acknowledgement: Option<u64>,
}

struct ReadinessAcknowledgement {
    installed: Mutex<bool>,
    changed: Condvar,
}

#[derive(Default)]
struct MailboxInner {
    changes: Vec<ReadinessChange>,
    events: HashMap<u32, VecDeque<Vec<u8>>>,
    acknowledgements: HashMap<u64, Arc<ReadinessAcknowledgement>>,
}

struct Mailbox {
    inner: Mutex<MailboxInner>,
    wake_read: i32,
    wake_write: i32,
}

impl Mailbox {
    fn new() -> Self {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        for fd in fds {
            unsafe {
                libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK);
            }
        }
        Self {
            inner: Mutex::new(MailboxInner::default()),
            wake_read: fds[0],
            wake_write: fds[1],
        }
    }

    fn notify(&self) {
        let byte = [1u8];
        unsafe {
            libc::write(self.wake_write, byte.as_ptr().cast(), byte.len());
        }
    }

    fn drain_wake(&self) {
        let mut bytes = [0u8; 64];
        while unsafe { libc::read(self.wake_read, bytes.as_mut_ptr().cast(), bytes.len()) } > 0 {}
    }
}

fn mailbox() -> &'static Mailbox {
    static MAILBOX: std::sync::OnceLock<Mailbox> = std::sync::OnceLock::new();
    MAILBOX.get_or_init(Mailbox::new)
}

fn throw_error(scope: &mut v8::HandleScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::error(scope, message);
    scope.throw_exception(exception);
}

fn js_string(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> String {
    value
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "unknown exception".to_string())
}

fn current_workload_owner(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = get_state(scope).borrow().scheduler_workload_owner;
    rv.set(v8::Integer::new_from_unsigned(scope, owner).into());
}

fn uses_process_readiness(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let enabled = get_state(scope).borrow().uses_process_readiness;
    rv.set(v8::Boolean::new(scope, enabled).into());
}

fn set_scheduler_polling_required(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let Ok(function) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        throw_error(
            scope,
            "setSchedulerPollingRequired: argument must be a function",
        );
        return;
    };
    get_state(scope).borrow_mut().scheduler_polling_fn = Some(v8::Global::new(scope, function));
}

fn setup_workload(inner: WorkloadSpecInner, owner: u32) -> Result<Workload, String> {
    let WorkloadSpecInner {
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
    let mut isolate = v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    let saved_async_state = crate::async_rt::swap_state(Some(
        crate::async_rt::new_state_with_pipe(async_pipe.0, async_pipe.1),
    ));
    let initialized = (|| {
        let isolate_scope = &mut v8::HandleScope::new(&mut isolate);
        let queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(isolate_scope, Default::default());
        context.set_microtask_queue(&queue);
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
        context.set_slot(Rc::new(RefCell::new(state)));
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        let source = "import 'internal:bootstrap';";
        let module = {
            let tc = &mut v8::TryCatch::new(scope);
            loader::compile_source_module(tc, source, "internal:scheduled-realm", None).ok_or_else(
                || {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to compile scheduled realm".to_string())
                },
            )?
        };
        loader::register_as_builtin(scope, module, "internal:scheduled-realm");
        {
            let tc = &mut v8::TryCatch::new(scope);
            module
                .instantiate_module(tc, loader::resolve_module_callback)
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to instantiate scheduled realm".to_string())
                })?;
        }
        {
            let tc = &mut v8::TryCatch::new(scope);
            module.evaluate(tc).ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to evaluate scheduled realm".to_string())
            })?;
        }
        if module.get_status() == v8::ModuleStatus::Errored {
            return Err(js_string(scope, module.get_exception()));
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
            // The async state's Drop closes the pre-created wake pipe; the
            // port fds are only reachable from here once the spec is consumed.
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
    unsafe {
        isolate.exit();
    }
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
    let locker = crate::v8_threading::IsolateLocker::new(&mut workload.isolate);
    unsafe {
        workload.isolate.enter();
    }
    let saved_async_state = crate::async_rt::swap_state(workload.async_state.take());
    ActiveWorkload {
        saved_async_state,
        _locker: locker,
    }
}

fn deactivate(workload: &mut Workload, active: ActiveWorkload) {
    workload.async_state = crate::async_rt::swap_state(active.saved_async_state);
    unsafe {
        workload.isolate.exit();
    }
}

fn service_scheduled_sync_call(
    scope: &mut v8::HandleScope,
    state: &Rc<RefCell<FinoState>>,
) -> bool {
    let (maybe_fn, maybe_resolver) = {
        let mut state = state.borrow_mut();
        (state.sync_call_fn.take(), state.sync_call_resolver.take())
    };
    let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) else {
        return false;
    };
    let call_result: Result<v8::Global<v8::Value>, v8::Global<v8::Value>> = {
        let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
        let tc = &mut v8::TryCatch::new(scope);
        let function = v8::Local::new(tc, &fn_ref);
        match function.call(tc, receiver, &[]) {
            Some(result) => Ok(v8::Global::new(tc, result)),
            None => {
                let exception = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                Err(v8::Global::new(tc, exception))
            }
        }
    };
    let resolver = v8::Local::new(scope, &resolver_ref);
    match call_result {
        Ok(result) => {
            let result = v8::Local::new(scope, &result);
            let _ = resolver.resolve(scope, result);
        }
        Err(exception) => {
            let exception = v8::Local::new(scope, &exception);
            let _ = resolver.reject(scope, exception);
        }
    }
    true
}

enum Slice {
    Runnable,
    Quiescent(bool),
    Settled,
}

fn drive_slice(workload: &mut Workload) -> Result<(Slice, u64), String> {
    let context_global = workload.context.clone();
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &context_global);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    crate::realm::child::pump_and_checkpoint(scope);
    let loop_step_fn = workload.state.borrow().loop_step_fn.clone();
    let Some(loop_step_fn) = loop_step_fn else {
        return Ok((Slice::Quiescent(true), 1));
    };
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let tc = &mut v8::TryCatch::new(scope);
    let mut loop_turns = 0;
    let mut should_continue = true;
    let mut serviced_sync_call = false;
    // Run a bounded batch before reconsidering pool priority. This is large
    // enough to drain deeply chained Promise continuations while still giving
    // another ready realm a frequent opportunity to preempt at quiescence.
    while should_continue && loop_turns < 64 {
        should_continue = v8::Local::new(tc, &loop_step_fn)
            .call(tc, receiver, &[])
            .ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "scheduled realm loop step threw".to_string())
            })?
            .boolean_value(tc);
        crate::realm::child::pump_and_checkpoint(tc);
        serviced_sync_call = service_scheduled_sync_call(tc, &workload.state);
        if serviced_sync_call {
            crate::realm::child::pump_and_checkpoint(tc);
            // The TypeScript step cannot see a sync call until the host
            // services it here. Its pre-service liveness result is therefore
            // stale: always give the resolved Promise one more loop turn to
            // install handles, finish the workload, or queue more host work.
            should_continue = true;
        }
        loop_turns += 1;
    }
    if should_continue {
        // A synchronous call completed on the final turn, so its Promise
        // continuation still needs at least one more host-loop step. Revisit
        // pool priority without parking this runnable workload.
        if serviced_sync_call {
            return Ok((Slice::Runnable, loop_turns));
        }
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
        return Ok((Slice::Quiescent(polling), loop_turns));
    }

    if let Some(on_done) = workload.state.borrow().on_done_fn.clone() {
        let tc = &mut v8::TryCatch::new(tc);
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
    Ok((Slice::Settled, loop_turns))
}

fn retire_owner(owner: u32) {
    let mut inner = mailbox().inner.lock().unwrap();
    inner.events.remove(&owner);
    inner.changes.push(ReadinessChange {
        ident: 0.0,
        filter: 0,
        flags: 0,
        fflags: 0,
        data: 0.0,
        udata: 0.0,
        cancel_owner: Some(owner),
        scheduler_wake: false,
        acknowledgement: None,
    });
    drop(inner);
    mailbox().notify();
}

fn drop_workload(mut workload: Workload) {
    let active = activate(&mut workload);
    retire_owner(workload.owner);
    workload.state.borrow_mut().loop_step_fn = None;
    workload.state.borrow_mut().on_done_fn = None;
    workload.state.borrow_mut().sync_call_fn = None;
    workload.state.borrow_mut().sync_call_resolver = None;
    deactivate(&mut workload, active);
    // OwnedIsolate requires itself to be current during Drop. The Locker must
    // already be gone because its destructor reads isolate-owned thread state.
    unsafe {
        workload.isolate.enter();
    }
    if let Some((wake_read, partner_write)) = workload.port_fds.take() {
        unsafe {
            libc::close(wake_read);
            libc::close(partner_write);
        }
    }
    drop(workload);
}

#[derive(Clone, Copy)]
enum PoolEventKind {
    /// A workload entered the queue. The main realm's sizing policy scales
    /// reactor threads to demand from these (threads = workloads, capped at
    /// available parallelism).
    Submitted,
    Activated,
    Settled,
    Error,
}

struct PoolEvent {
    kind: PoolEventKind,
    worker: usize,
    owner: u32,
    previous: Option<u32>,
    error: Option<String>,
    loop_turns: u64,
}

enum PoolWorkload {
    /// Submitted but not yet claimed by a reactor: no isolate exists.
    Pending(WorkloadSpec),
    /// Isolate constructed; movable between threads only while exited.
    Live(TransferWorkload),
}

fn pool_trace_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("FINO_POOL_TRACE").is_some())
}

macro_rules! pool_trace {
    ($($arg:tt)*) => {
        if pool_trace_enabled() {
            eprintln!($($arg)*);
        }
    };
}

/// Ordinary application realms.
const CLASS_APP: u8 = 0;
/// The node's system realm: outranks every app realm whenever it has
/// unserviced readiness signals, and (having no heap entry) costs nothing
/// when it has none. Never eligible for shedding.
const CLASS_SYSTEM: u8 = 1;

struct PoolItem {
    owner: u32,
    class: u8,
    workload: PoolWorkload,
}

impl PoolItem {
    fn live_mut(&mut self) -> &mut Workload {
        match &mut self.workload {
            PoolWorkload::Live(workload) => &mut workload.0,
            PoolWorkload::Pending(_) => unreachable!("resident workload has no isolate"),
        }
    }
}

struct Resident {
    item: PoolItem,
    active: ActiveWorkload,
}

// Field order defines the derived ordering: class dominates, then signal
// count, then recency.
#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct ReadyEntry {
    class: u8,
    priority: usize,
    generation: u64,
    owner: u32,
}

/// Accumulated load attribution for one workload, drained by the sampling
/// API. All values are deltas since the previous sample.
#[derive(Default, Clone, Copy)]
struct LoadCounters {
    /// Wall time spent inside `drive_slice` for this workload.
    busy_micros: u64,
    slices: u64,
    loop_turns: u64,
    /// Runnable delay: signal-to-activation, summed over `activations`.
    activation_delay_micros: u64,
    activations: u64,
}

struct PoolQueue {
    ready: BinaryHeap<ReadyEntry>,
    priorities: HashMap<u32, usize>,
    generations: HashMap<u32, u64>,
    classes: HashMap<u32, u8>,
    /// Pre-init specs with an in-flight shed offer. Still claimable by local
    /// reactors — a local claim clears the mark, and the shed commit fails.
    shedding: HashSet<u32>,
    active: HashSet<u32>,
    shutdown: bool,
    load: HashMap<u32, LoadCounters>,
    /// Earliest unserviced signal per owner, for runnable-delay attribution.
    signaled_at: HashMap<u32, std::time::Instant>,
}

/// The read/keep decision a claim can make without touching the write lock.
enum PeekOutcome {
    /// The best candidate does not beat the resident workload: keep it.
    KeepCurrent,
    /// Nothing is claimable; wait for a wake.
    NoWork,
    /// The queue must change (take work, consume a signal, clean stale
    /// entries, or skip an active owner): escalate to the write lock.
    Escalate,
}

struct PoolShared {
    /// Queue state. Reads dominate — most claims compare the best candidate
    /// against the resident workload and keep the resident, which never
    /// mutates. Every mutation (dequeue, enqueue, shed, reclaim) takes the
    /// write lock, so head-pulls and tail-takes cannot race.
    queue: RwLock<PoolQueue>,
    /// Parked workload payloads. Locked ONLY while holding the `queue` write
    /// lock — this is a field of the same lock domain, not a second one; it
    /// is a `Mutex` because workload payloads are `Send` but not `Sync`, and
    /// the read path never inspects them.
    parked: Mutex<HashMap<u32, PoolItem>>,
    /// Worker parking. `Condvar` pairs with a `Mutex`, so sleep/wake lives
    /// beside the queue lock rather than under it. Writers bump `epoch` after
    /// mutating and notify while briefly holding `sleep`; waiters snapshot
    /// `epoch` before peeking and re-check it under `sleep` before waiting,
    /// so a wake between peek and wait is never lost — and the fast path
    /// pays only an atomic load.
    sleep: Mutex<()>,
    epoch: AtomicU64,
    changed: Condvar,
    events: Mutex<VecDeque<PoolEvent>>,
    next_worker: std::sync::atomic::AtomicUsize,
    wake_read: i32,
    wake_write: i32,
}

impl PoolShared {
    fn new() -> Self {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        for fd in fds {
            unsafe {
                libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK);
            }
        }
        let queue = PoolQueue {
            ready: BinaryHeap::new(),
            priorities: HashMap::new(),
            generations: HashMap::new(),
            classes: HashMap::new(),
            shedding: HashSet::new(),
            active: HashSet::new(),
            shutdown: false,
            load: HashMap::new(),
            signaled_at: HashMap::new(),
        };
        Self {
            queue: RwLock::new(queue),
            parked: Mutex::new(HashMap::new()),
            sleep: Mutex::new(()),
            epoch: AtomicU64::new(0),
            changed: Condvar::new(),
            events: Mutex::new(VecDeque::new()),
            next_worker: std::sync::atomic::AtomicUsize::new(0),
            wake_read: fds[0],
            wake_write: fds[1],
        }
    }

    fn wake_all(&self) {
        self.epoch.fetch_add(1, Ordering::Release);
        // Passing through the sleep mutex orders this wake after any waiter's
        // epoch re-check, so the notify cannot land in its check-to-wait gap.
        drop(self.sleep.lock().unwrap());
        self.changed.notify_all();
    }

    fn submit(self: &Arc<Self>, item: PoolItem) -> u32 {
        let owner = item.owner;
        owner_pools()
            .lock()
            .unwrap()
            .insert(owner, Arc::downgrade(self));
        {
            let mut queue = self.queue.write().unwrap();
            let mut parked = self.parked.lock().unwrap();
            debug_assert!(!queue.shutdown, "cannot submit work to a stopped reactor");
            debug_assert!(
                !parked.contains_key(&owner) && !queue.active.contains(&owner),
                "workload {owner} is already in the reactor"
            );
            queue.classes.insert(owner, item.class);
            parked.insert(owner, item);
            Self::signal_present(&mut queue, owner);
        }
        pool_trace!("pool: submit owner={owner}");
        self.notify(PoolEvent {
            kind: PoolEventKind::Submitted,
            worker: 0,
            owner,
            previous: None,
            error: None,
            loop_turns: 0,
        });
        self.wake_all();
        owner
    }

    /// Push a ready entry for an owner known to be parked or active.
    fn signal_present(queue: &mut PoolQueue, owner: u32) {
        let class = queue.classes.get(&owner).copied().unwrap_or(CLASS_APP);
        let priority = queue.priorities.entry(owner).or_default();
        *priority += 1;
        let generation = queue.generations.entry(owner).or_default();
        *generation += 1;
        queue.ready.push(ReadyEntry {
            class,
            priority: *priority,
            generation: *generation,
            owner,
        });
        queue
            .signaled_at
            .entry(owner)
            .or_insert_with(std::time::Instant::now);
    }

    /// Fold one finished slice into the owner's load counters.
    fn record_slice(&self, owner: u32, busy_micros: u64, loop_turns: u64) {
        let mut queue = self.queue.write().unwrap();
        let counters = queue.load.entry(owner).or_default();
        counters.busy_micros += busy_micros;
        counters.slices += 1;
        counters.loop_turns += loop_turns;
    }

    /// Record signal-to-activation delay when a claim takes an owner.
    fn record_activation(queue: &mut PoolQueue, owner: u32) {
        let delay = queue
            .signaled_at
            .remove(&owner)
            .map(|since| since.elapsed().as_micros() as u64)
            .unwrap_or(0);
        let counters = queue.load.entry(owner).or_default();
        counters.activation_delay_micros += delay;
        counters.activations += 1;
    }

    /// Drain every owner's accumulated load counters (delta sampling).
    fn take_load_sample(&self) -> Vec<(u32, LoadCounters)> {
        let mut queue = self.queue.write().unwrap();
        queue.load.drain().collect()
    }

    fn signal(&self, owner: u32) {
        {
            let mut queue = self.queue.write().unwrap();
            let parked = self.parked.lock().unwrap();
            if !parked.contains_key(&owner) && !queue.active.contains(&owner) {
                pool_trace!("pool: signal owner={owner} absent");
                return;
            }
            drop(parked);
            Self::signal_present(&mut queue, owner);
        }
        pool_trace!("pool: signal owner={owner}");
        self.wake_all();
    }

    /// The read-only claim decision. The dominant outcome under load is
    /// `KeepCurrent` — the resident workload stays — which must not serialize
    /// concurrent reactors, so it peeks without consuming signals or cleaning
    /// stale entries; those are deferred to the write path.
    fn peek_claim(queue: &PoolQueue, current: Option<u32>) -> PeekOutcome {
        let Some(entry) = queue.ready.peek() else {
            return PeekOutcome::NoWork;
        };
        let live_generation = queue.generations.get(&entry.owner).copied().unwrap_or(0);
        let live_priority = queue.priorities.get(&entry.owner).copied().unwrap_or(0);
        if entry.generation != live_generation || entry.priority != live_priority {
            // A stale top can hide real candidates beneath it.
            return PeekOutcome::Escalate;
        }
        if queue.active.contains(&entry.owner) {
            // Another worker's resident (skip) or the caller's own pending
            // signal (consume): both mutate the heap.
            return PeekOutcome::Escalate;
        }
        let Some(current) = current else {
            return PeekOutcome::Escalate;
        };
        let current_key = (
            queue.classes.get(&current).copied().unwrap_or(CLASS_APP),
            queue.priorities.get(&current).copied().unwrap_or(0),
        );
        // Strictly-less only: an equal-priority candidate must go through the
        // write path, which consumes the resident's signal count as it keeps
        // it — that decay is what lets an equal waiter win the next round.
        // Treating equality as a read-only keep starves the waiter forever.
        if (entry.class, entry.priority) < current_key {
            PeekOutcome::KeepCurrent
        } else {
            PeekOutcome::Escalate
        }
    }

    /// The mutating claim path: the previous single-lock algorithm, minus the
    /// wait states. `None` means no candidate survived — the caller waits.
    fn claim_write(&self, current: Option<u32>) -> Option<Claim> {
        let mut queue = self.queue.write().unwrap();
        loop {
            if queue.shutdown {
                return Some(Claim::Shutdown);
            }
            let mut skipped = Vec::new();
            let candidate = loop {
                let Some(entry) = queue.ready.pop() else {
                    break None;
                };
                let live_generation = queue.generations.get(&entry.owner).copied().unwrap_or(0);
                let live_priority = queue.priorities.get(&entry.owner).copied().unwrap_or(0);
                if entry.generation != live_generation || entry.priority != live_priority {
                    continue;
                }
                if queue.active.contains(&entry.owner) && Some(entry.owner) != current {
                    skipped.push(entry);
                    continue;
                }
                break Some(entry);
            };
            for entry in skipped {
                queue.ready.push(entry);
            }

            let Some(candidate) = candidate else {
                return None;
            };
            let owner = if let Some(current) = current {
                let current_key = (
                    queue.classes.get(&current).copied().unwrap_or(CLASS_APP),
                    queue.priorities.get(&current).copied().unwrap_or(0),
                );
                if candidate.owner != current
                    && (candidate.class, candidate.priority) <= current_key
                {
                    current
                } else {
                    candidate.owner
                }
            } else {
                candidate.owner
            };
            queue.priorities.remove(&owner);
            if owner != candidate.owner {
                queue.ready.push(candidate);
            }
            if Some(owner) == current {
                return Some(Claim::Current);
            }
            let Some(item) = self.parked.lock().unwrap().remove(&owner) else {
                pool_trace!("pool: claim owner={owner} not parked, retrying");
                continue;
            };
            // A local claim always wins over an in-flight shed offer.
            queue.shedding.remove(&owner);
            queue.active.insert(owner);
            Self::record_activation(&mut queue, owner);
            pool_trace!("pool: claim owner={owner}");
            return Some(Claim::Work(item));
        }
    }

    fn claim(
        &self,
        current: Option<u32>,
        stop: &AtomicBool,
        current_state: CurrentState,
        force_write: bool,
    ) -> Claim {
        loop {
            if stop.load(Ordering::Acquire) {
                return Claim::Shutdown;
            }
            // Snapshot the wake epoch before inspecting the queue so a signal
            // arriving after the peek is caught before sleeping.
            let epoch = self.epoch.load(Ordering::Acquire);
            let outcome = {
                let queue = self.queue.read().unwrap();
                if queue.shutdown {
                    return Claim::Shutdown;
                }
                match Self::peek_claim(&queue, current) {
                    // A long run of read-only keeps must periodically pass
                    // through the write path so the resident's signal count
                    // decays and strictly-lower waiters cannot starve.
                    PeekOutcome::KeepCurrent if force_write => PeekOutcome::Escalate,
                    outcome => outcome,
                }
            };
            match outcome {
                PeekOutcome::KeepCurrent => return Claim::Current,
                PeekOutcome::Escalate => {
                    if let Some(claim) = self.claim_write(current) {
                        return claim;
                    }
                    // No claimable candidate under the write lock — the top
                    // entries belong to owners active elsewhere (or were
                    // stale). Fall through and wait; spinning here would burn
                    // a core until that owner parks. The epoch check below
                    // catches any signal that arrived since the snapshot.
                }
                PeekOutcome::NoWork => {}
            }
            if current.is_some() {
                match current_state {
                    CurrentState::Runnable => return Claim::Current,
                    CurrentState::Polling => {
                        let sleep = self.sleep.lock().unwrap();
                        if self.epoch.load(Ordering::Acquire) != epoch {
                            continue;
                        }
                        let (guard, timeout) = self
                            .changed
                            .wait_timeout(sleep, std::time::Duration::from_millis(1))
                            .unwrap();
                        drop(guard);
                        if timeout.timed_out() {
                            return Claim::Current;
                        }
                    }
                    CurrentState::Parked => {
                        let sleep = self.sleep.lock().unwrap();
                        if self.epoch.load(Ordering::Acquire) != epoch {
                            continue;
                        }
                        drop(self.changed.wait(sleep).unwrap());
                    }
                }
            } else {
                let sleep = self.sleep.lock().unwrap();
                if self.epoch.load(Ordering::Acquire) != epoch {
                    continue;
                }
                drop(self.changed.wait(sleep).unwrap());
            }
        }
    }

    fn park(&self, resident: Resident) {
        let Resident { mut item, active } = resident;
        let owner = item.owner;
        deactivate(item.live_mut(), active);
        {
            let mut queue = self.queue.write().unwrap();
            queue.active.remove(&owner);
            self.parked.lock().unwrap().insert(owner, item);
        }
        pool_trace!("pool: park owner={owner}");
        self.wake_all();
    }

    fn finish(&self, owner: u32) {
        {
            let mut queue = self.queue.write().unwrap();
            queue.active.remove(&owner);
            queue.priorities.remove(&owner);
            queue.generations.remove(&owner);
            queue.classes.remove(&owner);
            queue.shedding.remove(&owner);
            queue.signaled_at.remove(&owner);
        }
        owner_pools().lock().unwrap().remove(&owner);
        pool_trace!("pool: finish owner={owner}");
        self.wake_all();
    }

    /// Pick the lowest-priority pre-init app workload as a shed candidate and
    /// mark it. Comparative order: least signal count first, oldest first —
    /// if everything is high priority, the least-high item is still chosen.
    fn mark_shedding_lowest(&self) -> u32 {
        let mut queue = self.queue.write().unwrap();
        let parked = self.parked.lock().unwrap();
        let mut best: Option<(usize, u64, u32)> = None;
        for (owner, item) in parked.iter() {
            if !matches!(item.workload, PoolWorkload::Pending(_)) {
                continue;
            }
            if item.class != CLASS_APP || queue.shedding.contains(owner) {
                continue;
            }
            let priority = queue.priorities.get(owner).copied().unwrap_or(0);
            let generation = queue.generations.get(owner).copied().unwrap_or(0);
            let key = (priority, generation, *owner);
            if best.is_none_or(|current| key < current) {
                best = Some(key);
            }
        }
        drop(parked);
        match best {
            Some((_, _, owner)) => {
                queue.shedding.insert(owner);
                owner
            }
            None => 0,
        }
    }

    /// Commit a shed: remove the marked spec from the queue. Fails (returns
    /// `None`) if a local reactor claimed the workload since it was marked —
    /// local execution always wins.
    fn take_shed(&self, owner: u32) -> Option<(WorkloadSpec, usize, u8)> {
        let (spec, priority, class) = {
            let mut queue = self.queue.write().unwrap();
            let mut parked = self.parked.lock().unwrap();
            if !queue.shedding.remove(&owner) {
                return None;
            }
            match parked.get(&owner) {
                Some(item) if matches!(item.workload, PoolWorkload::Pending(_)) => {}
                _ => return None,
            }
            let item = parked.remove(&owner).unwrap();
            let priority = queue.priorities.remove(&owner).unwrap_or(0);
            queue.generations.remove(&owner);
            queue.classes.remove(&owner);
            let PoolWorkload::Pending(spec) = item.workload else {
                unreachable!("checked above");
            };
            (spec, priority, item.class)
        };
        owner_pools().lock().unwrap().remove(&owner);
        Some((spec, priority, class))
    }

    fn clear_shedding(&self, owner: u32) -> bool {
        self.queue.write().unwrap().shedding.remove(&owner)
    }

    /// Return a shed spec to the queue, restoring its accumulated priority so
    /// a rejected offer does not lose its position.
    fn resubmit(self: &Arc<Self>, spec: WorkloadSpec, priority: usize, class: u8) -> u32 {
        let owner = spec.owner;
        owner_pools()
            .lock()
            .unwrap()
            .insert(owner, Arc::downgrade(self));
        {
            let mut queue = self.queue.write().unwrap();
            debug_assert!(!queue.shutdown, "cannot submit work to a stopped reactor");
            queue.classes.insert(owner, class);
            self.parked.lock().unwrap().insert(
                owner,
                PoolItem {
                    owner,
                    class,
                    workload: PoolWorkload::Pending(spec),
                },
            );
            if priority > 1 {
                queue.priorities.insert(owner, priority - 1);
            }
            Self::signal_present(&mut queue, owner);
        }
        self.notify(PoolEvent {
            kind: PoolEventKind::Submitted,
            worker: 0,
            owner,
            previous: None,
            error: None,
            loop_turns: 0,
        });
        self.wake_all();
        owner
    }

    fn notify(&self, event: PoolEvent) {
        self.events.lock().unwrap().push_back(event);
        let byte = [1u8];
        unsafe {
            libc::write(self.wake_write, byte.as_ptr().cast(), byte.len());
        }
    }

    fn drain_wake(&self) {
        let mut bytes = [0u8; 64];
        while unsafe { libc::read(self.wake_read, bytes.as_mut_ptr().cast(), bytes.len()) } > 0 {}
    }
}

impl Drop for PoolShared {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.wake_read);
            libc::close(self.wake_write);
        }
    }
}

struct ReactorThread {
    shared: Arc<PoolShared>,
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl ReactorThread {
    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.shared.wake_all();
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

#[derive(Clone, Copy)]
enum CurrentState {
    Parked,
    Polling,
    Runnable,
}

/// Read-only keep decisions allowed before a claim is forced through the
/// write path to decay the resident's signal count (see `peek_claim`).
const MAX_READ_KEEPS: u32 = 8;

fn run_worker(worker: usize, shared: Arc<PoolShared>, stop: Arc<AtomicBool>) {
    let mut current: Option<Resident> = None;
    let mut current_state = CurrentState::Parked;
    let mut kept = 0u32;
    loop {
        let current_owner = current.as_ref().map(|resident| resident.item.owner);
        match shared.claim(current_owner, &stop, current_state, kept >= MAX_READ_KEEPS) {
            Claim::Shutdown => break,
            Claim::Current => {
                kept = if kept >= MAX_READ_KEEPS { 0 } else { kept + 1 };
            }
            Claim::Work(item) => {
                kept = 0;
                let previous = current_owner;
                if let Some(resident) = current.take() {
                    shared.park(resident);
                }
                let owner = item.owner;
                let class = item.class;
                let workload = match item.workload {
                    PoolWorkload::Live(TransferWorkload(workload)) => workload,
                    // First claim constructs the isolate here, on the claiming
                    // reactor's thread. A failure settles the allocation the
                    // same way a runtime error in a live workload would.
                    PoolWorkload::Pending(spec) => match spec.initialize() {
                        Ok(workload) => workload,
                        Err((error, scheduled)) => {
                            if let Some(scheduled) = scheduled {
                                scheduled.complete(ScheduledRealmResult::Error(error.clone()));
                            }
                            retire_owner(owner);
                            shared.finish(owner);
                            current_state = CurrentState::Parked;
                            shared.notify(PoolEvent {
                                kind: PoolEventKind::Error,
                                worker,
                                owner,
                                previous: None,
                                error: Some(error),
                                loop_turns: 0,
                            });
                            continue;
                        }
                    },
                };
                let mut item = PoolItem {
                    owner,
                    class,
                    workload: PoolWorkload::Live(TransferWorkload(workload)),
                };
                let active = activate(item.live_mut());
                current = Some(Resident { item, active });
                shared.notify(PoolEvent {
                    kind: PoolEventKind::Activated,
                    worker,
                    owner,
                    previous,
                    error: None,
                    loop_turns: 0,
                });
            }
        }

        let owner = current
            .as_ref()
            .expect("reactor worker claimed no workload")
            .item
            .owner;
        let mut resident = current.take().unwrap();
        let slice_started = std::time::Instant::now();
        let outcome = drive_slice(resident.item.live_mut());
        let busy_micros = slice_started.elapsed().as_micros() as u64;
        let slice_turns = match &outcome {
            Ok((_, loop_turns)) => *loop_turns,
            Err(_) => 0,
        };
        shared.record_slice(owner, busy_micros, slice_turns);
        match outcome {
            Ok((Slice::Runnable, _)) => {
                current_state = CurrentState::Runnable;
                current = Some(resident);
            }
            Ok((Slice::Quiescent(polling), _)) => {
                current_state = if polling {
                    CurrentState::Polling
                } else {
                    CurrentState::Parked
                };
                current = Some(resident);
            }
            Ok((Slice::Settled, loop_turns)) => {
                let Resident { item, active } = resident;
                let PoolWorkload::Live(TransferWorkload(mut workload)) = item.workload else {
                    unreachable!("resident workload has no isolate");
                };
                if let Some(scheduled) = workload.scheduled.as_ref() {
                    let result = if workload.state.borrow().reload_requested {
                        ScheduledRealmResult::Reload
                    } else {
                        ScheduledRealmResult::Done
                    };
                    scheduled.complete(result);
                }
                deactivate(&mut workload, active);
                drop_workload(workload);
                shared.finish(owner);
                current_state = CurrentState::Parked;
                shared.notify(PoolEvent {
                    kind: PoolEventKind::Settled,
                    worker,
                    owner,
                    previous: None,
                    error: None,
                    loop_turns,
                });
            }
            Err(error) => {
                let Resident { item, active } = resident;
                let PoolWorkload::Live(TransferWorkload(mut workload)) = item.workload else {
                    unreachable!("resident workload has no isolate");
                };
                if let Some(scheduled) = workload.scheduled.as_ref() {
                    scheduled.complete(ScheduledRealmResult::Error(error.clone()));
                }
                deactivate(&mut workload, active);
                drop_workload(workload);
                shared.finish(owner);
                current_state = CurrentState::Parked;
                shared.notify(PoolEvent {
                    kind: PoolEventKind::Error,
                    worker,
                    owner,
                    previous: None,
                    error: Some(error),
                    loop_turns: 0,
                });
            }
        }
    }
    if let Some(resident) = current {
        shared.park(resident);
    }
}

fn take_workload(handle: usize) -> Result<WorkloadSpec, String> {
    WORKLOADS.with(|workloads| {
        workloads
            .borrow_mut()
            .get_mut(handle)
            .and_then(Option::take)
            .ok_or_else(|| format!("invalid workload handle {handle}"))
    })
}

fn create_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let entry = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if entry.is_empty() {
        throw_error(scope, "createWorkload: entry path is required");
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
    let owner = next_owner();
    let async_pipe = match create_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            throw_error(scope, &format!("createWorkload: {error}"));
            return;
        }
    };
    let class = if args.get(1).boolean_value(scope) {
        CLASS_SYSTEM
    } else {
        CLASS_APP
    };
    let spec = WorkloadSpec {
        owner,
        class,
        inner: Some(Box::new(WorkloadSpecInner {
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
    let handle = WORKLOADS.with(|workloads| {
        let mut workloads = workloads.borrow_mut();
        if let Some((index, slot)) = workloads
            .iter_mut()
            .enumerate()
            .find(|(_, workload)| workload.is_none())
        {
            *slot = Some(spec);
            index
        } else {
            workloads.push(Some(spec));
            workloads.len() - 1
        }
    });
    rv.set(v8::Integer::new_from_unsigned(scope, handle as u32).into());
}

fn create_scheduled_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(pool) = process_pool().lock().unwrap().clone() else {
        throw_error(
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
        throw_error(scope, "createScheduledRealm: entry path is required");
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
            throw_error(scope, &format!("createScheduledRealm: {error}"));
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
            throw_error(scope, &format!("createScheduledRealm: {error}"));
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
            throw_error(scope, &format!("createScheduledRealm: {error}"));
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
            throw_error(scope, &format!("createScheduledRealm: {error}"));
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
            throw_error(scope, &format!("createScheduledRealm: {error}"));
            return;
        }
    };
    let reload_requested = Arc::new(AtomicBool::new(false));
    let scheduled = Arc::new(ScheduledRealmState {
        result: Mutex::new(None),
        parent_wake_write: completion_wake_write,
    });
    let owner = next_owner();
    let wake_fd = async_pipe.0;
    let class = if args.get(7).boolean_value(scope) {
        CLASS_SYSTEM
    } else {
        CLASS_APP
    };
    let spec = WorkloadSpec {
        owner,
        class,
        inner: Some(Box::new(WorkloadSpecInner {
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
    let handle = {
        let mut realms = scheduled_realms().lock().unwrap();
        let value = ScheduledRealmHandle {
            tx: parent_tx,
            rx: parent_rx,
            child_wake_write,
            parent_wake_read,
            completion_wake_read,
            state: scheduled,
        };
        if let Some((index, slot)) = realms
            .iter_mut()
            .enumerate()
            .find(|(_, realm)| realm.is_none())
        {
            *slot = Some(value);
            index
        } else {
            realms.push(Some(value));
            realms.len() - 1
        }
    };
    pool.submit(PoolItem {
        owner,
        class,
        workload: PoolWorkload::Pending(spec),
    });
    let result = v8::Object::new(scope);
    for (name, value) in [
        (
            "handle",
            v8::Integer::new_from_unsigned(scope, handle as u32).into(),
        ),
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

fn optional_string(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> Option<String> {
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

fn copy_uint8_array(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
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
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let Some(data) = copy_uint8_array(scope, args.get(1)) else {
        throw_error(
            scope,
            "scheduledRealmSend: second argument must be a Uint8Array",
        );
        return;
    };
    let transfer_stores = if let Ok(values) = v8::Local::<v8::Array>::try_from(args.get(2)) {
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
    let transfer_ports = crate::realm::thread::extract_port_infos(scope, args.get(3));
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(handle).and_then(Option::as_ref) else {
        throw_error(
            scope,
            &format!("scheduledRealmSend: invalid realm handle {handle}"),
        );
        return;
    };
    let _ = realm.tx.send(crate::realm::thread::ThreadMessage {
        data,
        transfer_stores,
        transfer_ports,
    });
    let byte = [1u8];
    unsafe {
        libc::write(realm.child_wake_write, byte.as_ptr().cast(), byte.len());
    }
}

fn scheduled_realm_recv(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(handle).and_then(Option::as_ref) else {
        throw_error(
            scope,
            &format!("scheduledRealmRecv: invalid realm handle {handle}"),
        );
        return;
    };
    let mut messages = Vec::new();
    while let Ok(message) = realm.rx.try_recv() {
        messages.push(message);
    }
    let mut discard = [0u8; 256];
    while unsafe {
        libc::read(
            realm.parent_wake_read,
            discard.as_mut_ptr().cast(),
            discard.len(),
        )
    } > 0
    {}
    rv.set(crate::realm::transit::build_message_array(scope, messages).into());
}

fn take_scheduled_realm_status(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(handle).and_then(Option::as_ref) else {
        throw_error(
            scope,
            &format!("takeScheduledRealmStatus: invalid realm handle {handle}"),
        );
        return;
    };
    let mut discard = [0u8; 64];
    while unsafe {
        libc::read(
            realm.completion_wake_read,
            discard.as_mut_ptr().cast(),
            discard.len(),
        )
    } > 0
    {}
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

fn close_scheduled_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let realm = scheduled_realms()
        .lock()
        .unwrap()
        .get_mut(handle)
        .and_then(Option::take);
    if realm.is_none() {
        throw_error(
            scope,
            &format!("closeScheduledRealm: invalid realm handle {handle}"),
        );
    }
}

fn create_reactor_queue(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let shared = Arc::new(PoolShared::new());
    // Standalone queues (install=false) exist for tests and tooling; only an
    // installed queue receives the process's scheduled realms.
    let install = args.get(0).is_undefined() || args.get(0).boolean_value(scope);
    if install {
        *process_pool().lock().unwrap() = Some(Arc::clone(&shared));
    }
    let control_fd = shared.wake_read;
    let handle = REACTOR_QUEUES.with(|queues| {
        let mut queues = queues.borrow_mut();
        if let Some((index, slot)) = queues
            .iter_mut()
            .enumerate()
            .find(|(_, queue)| queue.is_none())
        {
            *slot = Some(shared);
            index
        } else {
            queues.push(Some(shared));
            queues.len() - 1
        }
    });
    let result = v8::Object::new(scope);
    for (name, value) in [
        (
            "handle",
            v8::Integer::new_from_unsigned(scope, handle as u32).into(),
        ),
        ("controlFd", v8::Integer::new(scope, control_fd).into()),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

fn submit_reactor_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let shared = REACTOR_QUEUES.with(|queues| {
        queues
            .borrow()
            .get(queue_handle)
            .and_then(Option::as_ref)
            .cloned()
    });
    let Some(shared) = shared else {
        throw_error(
            scope,
            &format!("submitReactorWorkload: invalid queue {queue_handle}"),
        );
        return;
    };
    let workload_handle = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let spec = match take_workload(workload_handle) {
        Ok(spec) => spec,
        Err(error) => {
            throw_error(scope, &format!("submitReactorWorkload: {error}"));
            return;
        }
    };
    let owner = shared.submit(PoolItem {
        owner: spec.owner,
        class: spec.class,
        workload: PoolWorkload::Pending(spec),
    });
    rv.set(v8::Integer::new_from_unsigned(scope, owner).into());
}

/// A spec taken off a queue's tail by the balancer, parked here until the
/// offer resolves: resubmitted on rejection, dropped on successful transfer.
struct ShedWorkload {
    spec: WorkloadSpec,
    priority: usize,
    class: u8,
}

fn shed_workloads() -> &'static Mutex<Vec<Option<ShedWorkload>>> {
    static SHED: std::sync::OnceLock<Mutex<Vec<Option<ShedWorkload>>>> = std::sync::OnceLock::new();
    SHED.get_or_init(|| Mutex::new(Vec::new()))
}

/// Resolve a queue argument: a numeric handle names a queue created on this
/// thread; undefined/null names the installed process pool, so realms other
/// than the main realm (the system realm in particular) can operate on it —
/// queue handles are main-realm thread-locals and do not travel.
fn reactor_queue_arg(
    scope: &mut v8::HandleScope,
    value: v8::Local<v8::Value>,
) -> Option<Arc<PoolShared>> {
    if value.is_null_or_undefined() {
        return process_pool().lock().unwrap().clone();
    }
    let handle = value.uint32_value(scope).unwrap_or(u32::MAX) as usize;
    reactor_queue(handle)
}

fn reactor_queue(handle: usize) -> Option<Arc<PoolShared>> {
    REACTOR_QUEUES.with(|queues| {
        queues
            .borrow()
            .get(handle)
            .and_then(Option::as_ref)
            .cloned()
    })
}

fn mark_shedding_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_arg = args.get(0);
    let Some(shared) = reactor_queue_arg(scope, queue_arg) else {
        throw_error(
            scope,
            "markSheddingWorkload: no such queue and no process reactor is running",
        );
        return;
    };
    rv.set(v8::Integer::new_from_unsigned(scope, shared.mark_shedding_lowest()).into());
}

fn take_shed_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_arg = args.get(0);
    let owner = args.get(1).uint32_value(scope).unwrap_or(0);
    let Some(shared) = reactor_queue_arg(scope, queue_arg) else {
        throw_error(
            scope,
            "takeShedWorkload: no such queue and no process reactor is running",
        );
        return;
    };
    let Some((spec, priority, class)) = shared.take_shed(owner) else {
        rv.set(v8::null(scope).into());
        return;
    };
    let entry = ShedWorkload {
        spec,
        priority,
        class,
    };
    let handle = {
        let mut shed = shed_workloads().lock().unwrap();
        if let Some((index, slot)) = shed.iter_mut().enumerate().find(|(_, slot)| slot.is_none()) {
            *slot = Some(entry);
            index
        } else {
            shed.push(Some(entry));
            shed.len() - 1
        }
    };
    rv.set(v8::Integer::new_from_unsigned(scope, handle as u32).into());
}

fn clear_shedding_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_arg = args.get(0);
    let owner = args.get(1).uint32_value(scope).unwrap_or(0);
    let Some(shared) = reactor_queue_arg(scope, queue_arg) else {
        throw_error(
            scope,
            "clearSheddingWorkload: no such queue and no process reactor is running",
        );
        return;
    };
    rv.set(v8::Boolean::new(scope, shared.clear_shedding(owner)).into());
}

fn resubmit_shed_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_arg = args.get(0);
    let shed_handle = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let Some(shared) = reactor_queue_arg(scope, queue_arg) else {
        throw_error(
            scope,
            "resubmitShedWorkload: no such queue and no process reactor is running",
        );
        return;
    };
    let entry = shed_workloads()
        .lock()
        .unwrap()
        .get_mut(shed_handle)
        .and_then(Option::take);
    let Some(entry) = entry else {
        throw_error(
            scope,
            &format!("resubmitShedWorkload: invalid shed workload {shed_handle}"),
        );
        return;
    };
    let owner = shared.resubmit(entry.spec, entry.priority, entry.class);
    rv.set(v8::Integer::new_from_unsigned(scope, owner).into());
}

/// The serializable half of a shed spec: everything a destination node needs
/// to reconstruct an equivalent workload. Rules serialize to the same
/// `ImportRule[]` JSON that `createScheduledRealm` accepts, so the claimable
/// unit and the network-transferable unit share one shape (the port plumbing
/// is per-node and is rebuilt at the destination).
fn shed_workload_config(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let shed_handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let shed = shed_workloads().lock().unwrap();
    let Some(entry) = shed.get(shed_handle).and_then(Option::as_ref) else {
        throw_error(
            scope,
            &format!("shedWorkloadConfig: invalid shed workload {shed_handle}"),
        );
        return;
    };
    let inner = entry
        .spec
        .inner
        .as_ref()
        .expect("shed workload spec is pre-initialization");
    let rules_json = serde_json::to_string(&inner.import_rules).unwrap_or_else(|_| "[]".into());
    let root = inner.process_env.root.to_string_lossy();
    let result = v8::Object::new(scope);
    fn optional<'s>(
        scope: &mut v8::HandleScope<'s>,
        value: &Option<String>,
    ) -> v8::Local<'s, v8::Value> {
        match value {
            Some(value) => v8::String::new(scope, value).unwrap().into(),
            None => v8::null(scope).into(),
        }
    }
    let data = optional(scope, &inner.realm_data);
    let bootstrap_data = optional(scope, &inner.realm_bootstrap_data);
    for (name, value) in [
        (
            "entry",
            v8::String::new(scope, &inner.entry).unwrap().into(),
        ),
        ("root", v8::String::new(scope, &root).unwrap().into()),
        ("rules", v8::String::new(scope, &rules_json).unwrap().into()),
        ("watch", v8::Boolean::new(scope, inner.watch_mode).into()),
        ("repl", v8::Boolean::new(scope, inner.repl_mode).into()),
        ("data", data),
        ("bootstrapData", bootstrap_data),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

fn drop_shed_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let shed_handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let entry = shed_workloads()
        .lock()
        .unwrap()
        .get_mut(shed_handle)
        .and_then(Option::take);
    let Some(entry) = entry else {
        throw_error(
            scope,
            &format!("dropShedWorkload: invalid shed workload {shed_handle}"),
        );
        return;
    };
    retire_owner(entry.spec.owner);
    drop(entry);
}

fn create_reactor_thread(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let shared = reactor_queue(queue_handle);
    let Some(shared) = shared else {
        throw_error(
            scope,
            &format!("createReactorThread: invalid queue {queue_handle}"),
        );
        return;
    };
    let worker = shared.next_worker.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_shared = Arc::clone(&shared);
    let thread_stop = Arc::clone(&stop);
    let join = std::thread::spawn(move || run_worker(worker, thread_shared, thread_stop));
    let reactor = ReactorThread {
        shared,
        stop,
        join: Some(join),
    };
    let handle = REACTOR_THREADS.with(|threads| {
        let mut threads = threads.borrow_mut();
        if let Some((index, slot)) = threads
            .iter_mut()
            .enumerate()
            .find(|(_, thread)| thread.is_none())
        {
            *slot = Some(reactor);
            index
        } else {
            threads.push(Some(reactor));
            threads.len() - 1
        }
    });
    let result = v8::Object::new(scope);
    for (name, value) in [
        (
            "handle",
            v8::Integer::new_from_unsigned(scope, handle as u32).into(),
        ),
        (
            "worker",
            v8::Integer::new_from_unsigned(scope, worker as u32).into(),
        ),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

fn close_reactor_thread(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let thread =
        REACTOR_THREADS.with(|threads| threads.borrow_mut().get_mut(handle).and_then(Option::take));
    let Some(mut thread) = thread else {
        throw_error(
            scope,
            &format!("closeReactorThread: invalid thread {handle}"),
        );
        return;
    };
    thread.shutdown();
}

fn signal_reactor_owner(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    if let Some(pool) = owner_pools()
        .lock()
        .unwrap()
        .get(&owner)
        .and_then(Weak::upgrade)
    {
        pool.signal(owner);
    }
}

fn take_reactor_events(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let events = REACTOR_QUEUES.with(|queues| {
        let queues = queues.borrow();
        let queue = queues
            .get(handle)
            .and_then(Option::as_ref)
            .ok_or_else(|| format!("invalid reactor queue {handle}"))?;
        queue.drain_wake();
        Ok::<_, String>(queue.events.lock().unwrap().drain(..).collect::<Vec<_>>())
    });
    let events = match events {
        Ok(events) => events,
        Err(error) => {
            throw_error(scope, &format!("takeReactorEvents: {error}"));
            return;
        }
    };
    let result = v8::Array::new(scope, events.len() as i32);
    for (index, event) in events.into_iter().enumerate() {
        let value = v8::Object::new(scope);
        let kind = match event.kind {
            PoolEventKind::Submitted => "submitted",
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
            (
                "loopTurns",
                v8::Number::new(scope, event.loop_turns as f64).into(),
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
        if let Some(previous) = event.previous {
            let key = v8::String::new(scope, "previous").unwrap();
            let previous = v8::Integer::new_from_unsigned(scope, previous);
            value.set(scope, key.into(), previous.into());
        }
        result.set_index(scope, index as u32, value.into());
    }
    rv.set(result.into());
}

fn close_reactor_queue(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let queue =
        REACTOR_QUEUES.with(|queues| queues.borrow_mut().get_mut(handle).and_then(Option::take));
    let Some(queue) = queue else {
        throw_error(
            scope,
            &format!("closeReactorQueue: invalid queue handle {handle}"),
        );
        return;
    };
    queue.queue.write().unwrap().shutdown = true;
    queue.wake_all();
    {
        let mut registered = process_pool().lock().unwrap();
        if registered
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &queue))
        {
            *registered = None;
        }
    }
    let Ok(queue) = Arc::try_unwrap(queue) else {
        throw_error(
            scope,
            "closeReactorQueue: reactor threads are still attached",
        );
        return;
    };
    let parked = {
        let _queue = queue.queue.write().unwrap();
        std::mem::take(&mut *queue.parked.lock().unwrap())
    };
    for item in parked.into_values() {
        match item.workload {
            PoolWorkload::Live(TransferWorkload(workload)) => drop_workload(workload),
            PoolWorkload::Pending(spec) => {
                retire_owner(item.owner);
                drop(spec);
            }
        }
    }
}

fn terminate_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let spec = WORKLOADS.with(|workloads| {
        workloads
            .borrow_mut()
            .get_mut(handle)
            .and_then(Option::take)
    });
    if let Some(spec) = spec {
        retire_owner(spec.owner);
        drop(spec);
    }
}

fn workload_wake_fd(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let fd = WORKLOADS.with(|workloads| {
        workloads
            .borrow()
            .get(handle)
            .and_then(Option::as_ref)
            .map(WorkloadSpec::wake_read_fd)
            .unwrap_or(-1)
    });
    rv.set(v8::Integer::new(scope, fd).into());
}

fn workload_owner(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let owner = WORKLOADS.with(|workloads| {
        workloads
            .borrow()
            .get(handle)
            .and_then(Option::as_ref)
            .map(|workload| workload.owner)
            .unwrap_or(0)
    });
    rv.set(v8::Integer::new_from_unsigned(scope, owner).into());
}

fn readiness_change_from_args(
    scope: &mut v8::HandleScope,
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
        acknowledgement: None,
    }
}

fn register_process_readiness(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let change = readiness_change_from_args(scope, &args);
    mailbox().inner.lock().unwrap().changes.push(change);
    mailbox().notify();
}

fn register_process_persistent_readiness(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    static NEXT_ACKNOWLEDGEMENT: AtomicU64 = AtomicU64::new(1);
    let acknowledgement_id = NEXT_ACKNOWLEDGEMENT.fetch_add(1, Ordering::Relaxed);
    let acknowledgement = Arc::new(ReadinessAcknowledgement {
        installed: Mutex::new(false),
        changed: Condvar::new(),
    });
    let mut change = readiness_change_from_args(scope, &args);
    change.acknowledgement = Some(acknowledgement_id);
    {
        let mut inner = mailbox().inner.lock().unwrap();
        inner
            .acknowledgements
            .insert(acknowledgement_id, acknowledgement.clone());
        inner.changes.push(change);
    }
    mailbox().notify();
    let mut installed = acknowledgement.installed.lock().unwrap();
    while !*installed {
        installed = acknowledgement.changed.wait(installed).unwrap();
    }
}

fn acknowledge_process_readiness(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let acknowledgement_id = args.get(0).number_value(scope).unwrap_or(0.0) as u64;
    let acknowledgement = mailbox()
        .inner
        .lock()
        .unwrap()
        .acknowledgements
        .remove(&acknowledgement_id);
    if let Some(acknowledgement) = acknowledgement {
        *acknowledgement.installed.lock().unwrap() = true;
        acknowledgement.changed.notify_one();
    }
}

fn register_reactor_wake(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    let fd = args.get(1).int32_value(scope).unwrap_or(-1);
    mailbox()
        .inner
        .lock()
        .unwrap()
        .changes
        .push(ReadinessChange {
            ident: fd as f64,
            filter: -1,
            flags: 0,
            fflags: 0,
            data: 0.0,
            udata: owner as f64,
            cancel_owner: None,
            scheduler_wake: true,
            acknowledgement: None,
        });
    mailbox().notify();
}

fn take_readiness_changes(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    mailbox().drain_wake();
    let changes = std::mem::take(&mut mailbox().inner.lock().unwrap().changes);
    let values = v8::Array::new(scope, changes.len() as i32);
    for (index, change) in changes.into_iter().enumerate() {
        let tuple = v8::Array::new(scope, 9);
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
            change
                .acknowledgement
                .map(|value| v8::Number::new(scope, value as f64).into())
                .unwrap_or_else(|| v8::null(scope).into()),
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

fn route_process_readiness(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    let Some(event) = copy_uint8_array(scope, args.get(1)) else {
        throw_error(
            scope,
            "routeProcessReadiness: second argument must be a Uint8Array",
        );
        return;
    };
    mailbox()
        .inner
        .lock()
        .unwrap()
        .events
        .entry(owner)
        .or_default()
        .push_back(event);
    if args.get(2).boolean_value(scope)
        && let Some(pool) = owner_pools()
            .lock()
            .unwrap()
            .get(&owner)
            .and_then(Weak::upgrade)
    {
        pool.signal(owner);
    }
}

fn take_shared_loop_events(
    scope: &mut v8::HandleScope,
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
    let values = v8::Array::new(scope, events.len() as i32);
    for (index, event) in events.into_iter().enumerate() {
        let len = event.len();
        let store = v8::ArrayBuffer::new_backing_store(scope, len);
        if !event.is_empty() {
            let target = store.data().unwrap().as_ptr() as *mut u8;
            unsafe {
                std::ptr::copy_nonoverlapping(event.as_ptr(), target, len);
            }
        }
        let buffer = v8::ArrayBuffer::with_backing_store(scope, &store.make_shared());
        if let Some(array) = v8::Uint8Array::new(scope, buffer, 0, len) {
            values.set_index(scope, index as u32, array.into());
        }
    }
    rv.set(values.into());
}

fn process_readiness_control_fd(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Integer::new(scope, mailbox().wake_read).into());
}

fn available_parallelism(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let parallelism = std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(1);
    rv.set(v8::Integer::new_from_unsigned(scope, parallelism).into());
}

/// Drain per-workload load counters accumulated since the previous call.
/// The stats module samples this on a timer; values are deltas.
fn take_reactor_load_sample(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_arg = args.get(0);
    let Some(shared) = reactor_queue_arg(scope, queue_arg) else {
        throw_error(
            scope,
            "takeReactorLoadSample: no such queue and no process reactor is running",
        );
        return;
    };
    let sample = shared.take_load_sample();
    let result = v8::Array::new(scope, sample.len() as i32);
    for (index, (owner, counters)) in sample.into_iter().enumerate() {
        let value = v8::Object::new(scope);
        for (name, field) in [
            ("owner", v8::Number::new(scope, owner as f64)),
            (
                "busyMicros",
                v8::Number::new(scope, counters.busy_micros as f64),
            ),
            ("slices", v8::Number::new(scope, counters.slices as f64)),
            (
                "loopTurns",
                v8::Number::new(scope, counters.loop_turns as f64),
            ),
            (
                "activationDelayMicros",
                v8::Number::new(scope, counters.activation_delay_micros as f64),
            ),
            (
                "activations",
                v8::Number::new(scope, counters.activations as f64),
            ),
        ] {
            let key = v8::String::new(scope, name).unwrap();
            value.set(scope, key.into(), field.into());
        }
        result.set_index(scope, index as u32, value.into());
    }
    rv.set(result.into());
}

/// A point-in-time queue-pressure snapshot: parked pre-init specs, parked
/// live isolates, and workloads active on reactors.
fn reactor_queue_depth(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_arg = args.get(0);
    let Some(shared) = reactor_queue_arg(scope, queue_arg) else {
        throw_error(
            scope,
            "reactorQueueDepth: no such queue and no process reactor is running",
        );
        return;
    };
    let (pending_specs, parked_live, active) = {
        let queue = shared.queue.write().unwrap();
        let parked = shared.parked.lock().unwrap();
        let pending_specs = parked
            .values()
            .filter(|item| matches!(item.workload, PoolWorkload::Pending(_)))
            .count();
        (
            pending_specs,
            parked.len() - pending_specs,
            queue.active.len(),
        )
    };
    let result = v8::Object::new(scope);
    for (name, value) in [
        ("pendingSpecs", pending_specs),
        ("parkedLive", parked_live),
        ("active", active),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        let value = v8::Number::new(scope, value as f64);
        result.set(scope, key.into(), value.into());
    }
    rv.set(result.into());
}

/// Heap statistics for the calling isolate, so every realm can self-report.
fn isolate_heap_statistics(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let stats = scope.get_heap_statistics();
    let result = v8::Object::new(scope);
    for (name, value) in [
        ("totalHeapSize", stats.total_heap_size()),
        ("usedHeapSize", stats.used_heap_size()),
        ("heapSizeLimit", stats.heap_size_limit()),
        ("mallocedMemory", stats.malloced_memory()),
        ("externalMemory", stats.external_memory()),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        let value = v8::Number::new(scope, value as f64);
        result.set(scope, key.into(), value.into());
    }
    rv.set(result.into());
}

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
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
        "createReactorQueue",
        "submitReactorWorkload",
        "markSheddingWorkload",
        "takeShedWorkload",
        "clearSheddingWorkload",
        "resubmitShedWorkload",
        "shedWorkloadConfig",
        "dropShedWorkload",
        "createReactorThread",
        "availableParallelism",
        "takeReactorLoadSample",
        "reactorQueueDepth",
        "isolateHeapStatistics",
        "closeReactorThread",
        "signalReactorOwner",
        "takeReactorEvents",
        "closeReactorQueue",
        "terminateWorkload",
        "workloadWakeFd",
        "workloadOwner",
        "processReadinessControlFd",
        "registerProcessReadiness",
        "registerProcessPersistentReadiness",
        "acknowledgeProcessReadiness",
        "registerReactorWake",
        "takeSharedReadinessChanges",
        "routeProcessReadiness",
        "takeSharedLoopEvents",
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
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    macro_rules! set_fn {
        ($name:literal, $function:path) => {{
            let function = v8::FunctionTemplate::new(scope, $function).get_function(scope)?;
            let name = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, name, function.into())?;
        }};
    }
    set_fn!("currentWorkloadOwner", current_workload_owner);
    set_fn!("usesProcessReadiness", uses_process_readiness);
    set_fn!(
        "setSchedulerPollingRequired",
        set_scheduler_polling_required
    );
    set_fn!("createWorkload", create_workload);
    set_fn!("createScheduledRealm", create_scheduled_realm);
    set_fn!("scheduledRealmSend", scheduled_realm_send);
    set_fn!("scheduledRealmRecv", scheduled_realm_recv);
    set_fn!("takeScheduledRealmStatus", take_scheduled_realm_status);
    set_fn!("closeScheduledRealm", close_scheduled_realm);
    set_fn!("createReactorQueue", create_reactor_queue);
    set_fn!("submitReactorWorkload", submit_reactor_workload);
    set_fn!("markSheddingWorkload", mark_shedding_workload);
    set_fn!("takeShedWorkload", take_shed_workload);
    set_fn!("clearSheddingWorkload", clear_shedding_workload);
    set_fn!("resubmitShedWorkload", resubmit_shed_workload);
    set_fn!("shedWorkloadConfig", shed_workload_config);
    set_fn!("dropShedWorkload", drop_shed_workload);
    set_fn!("createReactorThread", create_reactor_thread);
    set_fn!("availableParallelism", available_parallelism);
    set_fn!("takeReactorLoadSample", take_reactor_load_sample);
    set_fn!("reactorQueueDepth", reactor_queue_depth);
    set_fn!("isolateHeapStatistics", isolate_heap_statistics);
    set_fn!("closeReactorThread", close_reactor_thread);
    set_fn!("signalReactorOwner", signal_reactor_owner);
    set_fn!("takeReactorEvents", take_reactor_events);
    set_fn!("closeReactorQueue", close_reactor_queue);
    set_fn!("terminateWorkload", terminate_workload);
    set_fn!("workloadWakeFd", workload_wake_fd);
    set_fn!("workloadOwner", workload_owner);
    set_fn!("processReadinessControlFd", process_readiness_control_fd);
    set_fn!("registerProcessReadiness", register_process_readiness);
    set_fn!(
        "registerProcessPersistentReadiness",
        register_process_persistent_readiness
    );
    set_fn!("acknowledgeProcessReadiness", acknowledge_process_readiness);
    set_fn!("registerReactorWake", register_reactor_wake);
    set_fn!("takeSharedReadinessChanges", take_readiness_changes);
    set_fn!("routeProcessReadiness", route_process_readiness);
    set_fn!("takeSharedLoopEvents", take_shared_loop_events);
    Some(v8::undefined(scope).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn empty_pool_waits_for_work() {
        let pool = Arc::new(PoolShared::new());
        let stop = Arc::new(AtomicBool::new(false));
        let worker_pool = Arc::clone(&pool);
        let worker_stop = Arc::clone(&stop);
        let (result_tx, result_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            result_tx
                .send(worker_pool.claim(None, &worker_stop, CurrentState::Parked, false))
                .unwrap();
        });

        assert!(
            result_rx.recv_timeout(Duration::from_millis(10)).is_err(),
            "an empty pool must not claim an initial workload"
        );
        stop.store(true, Ordering::Release);
        pool.wake_all();
        assert!(matches!(
            result_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Claim::Shutdown
        ));
        worker.join().unwrap();
    }

    #[test]
    fn system_class_dominates_ready_ordering() {
        let app = ReadyEntry {
            class: CLASS_APP,
            priority: 100,
            generation: 5,
            owner: 1,
        };
        let system = ReadyEntry {
            class: CLASS_SYSTEM,
            priority: 1,
            generation: 1,
            owner: 2,
        };
        assert!(
            system > app,
            "a signaled system realm outranks any app priority"
        );
        let quieter_app = ReadyEntry {
            class: CLASS_APP,
            priority: 3,
            generation: 9,
            owner: 3,
        };
        assert!(
            app > quieter_app,
            "within a class, signal count still decides"
        );
    }
}
