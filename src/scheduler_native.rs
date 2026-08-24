//! Minimal native substrate for the TypeScript process scheduler.
//!
//! TypeScript owns readiness registration, runnable priority, worker placement,
//! lifecycle, and metrics. Native code is limited to the operations TypeScript
//! cannot perform: moving V8 isolates between OS threads, entering and pumping
//! an isolate, and carrying scalar readiness metadata across isolate boundaries.

use std::{
    cell::RefCell,
    collections::{BinaryHeap, HashMap, VecDeque},
    os::unix::io::RawFd,
    rc::Rc,
    sync::{
        Arc, Condvar, Mutex, Weak,
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
fn handle_arg(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> u64 {
    let raw = value.number_value(scope).unwrap_or(0.0);
    if raw.is_finite() && raw >= 0.0 {
        raw as u64
    } else {
        0
    }
}

fn handle_value<'s>(scope: &mut v8::HandleScope<'s>, handle: u64) -> v8::Local<'s, v8::Value> {
    v8::Number::new(scope, handle as f64).into()
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
        match handle {
            Some(handle) => handle.terminate_execution(),
            None => false,
        }
    }

    fn was_forced(&self) -> bool {
        self.force_requested.load(Ordering::Acquire)
    }

    fn complete(&self, result: ScheduledRealmResult) {
        *self.result.lock().unwrap() = Some(result);
        WakePipe::signal(self.parent_wake_write);
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

/// A non-blocking self-pipe used to make a descriptor readable on demand.
///
/// Every cross-thread hand-off in the scheduler needs the same thing: mark a
/// descriptor readable so a poll-based loop notices, and drain it once the
/// reader has caught up. The payload carries no information — the queue behind
/// the pipe does — so `notify` deliberately ignores its write result. A failed
/// write means either the reader is gone, or the pipe is already full of
/// undrained bytes; in both cases the descriptor is already readable and the
/// reader will wake, so there is nothing to recover.
struct WakePipe {
    read: RawFd,
    write: RawFd,
}

impl WakePipe {
    fn new() -> Self {
        let (read, write) = create_pipe().expect("wake pipe");
        Self { read, write }
    }

    fn notify(&self) {
        Self::signal(self.write);
    }

    /// Mark a raw write descriptor readable, for owners that hand the write end
    /// to another structure.
    fn signal(write: RawFd) {
        let byte = [1u8];
        unsafe {
            libc::write(write, byte.as_ptr().cast(), byte.len());
        }
    }

    fn drain(&self) {
        Self::consume(self.read);
    }

    /// Drain a raw read descriptor that a caller owns directly.
    fn consume(read: RawFd) {
        let mut bytes = [0u8; 64];
        while unsafe { libc::read(read, bytes.as_mut_ptr().cast(), bytes.len()) } > 0 {}
    }
}

impl Drop for WakePipe {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.read);
            libc::close(self.write);
        }
    }
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
    /// Ask the main realm to re-signal `udata`'s owner after `data` ms.
    ///
    /// V8 background tasks and `Atomics.waitAsync` waiters have no pollable
    /// descriptor, so a realm holding one cannot be woken by readiness alone.
    /// Rather than spinning a reactor thread on a timed condvar wait, the
    /// reactor parks the realm and borrows a timer from the thread that is
    /// already sleeping in kqueue/io_uring.
    scheduler_poll: bool,
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
/// A completion is seven scalars the kernel already produced. It used to cross
/// to its owning realm as a structured clone — a ValueSerializer round trip, a
/// heap allocation, a backing store and a `Uint8Array` per event — to move
/// fifty-six bytes of numbers. The fixed layout below removes all of that: the
/// whole batch arrives as one `Float64Array`.
const COMPLETION_SLOTS: usize = 7;

/// One routed readiness completion in fixed layout.
///
/// Slots: ident, filter, flags, fflags, data, udata, installed.
type ReadinessCompletion = [f64; COMPLETION_SLOTS];

#[derive(Default)]
struct MailboxInner {
    changes: Vec<ReadinessChange>,
    events: HashMap<u32, Vec<ReadinessCompletion>>,
}

struct Mailbox {
    inner: Mutex<MailboxInner>,
    wake: WakePipe,
}

impl Mailbox {
    fn new() -> Self {
        Self {
            inner: Mutex::new(MailboxInner::default()),
            wake: WakePipe::new(),
        }
    }

    fn notify(&self) {
        self.wake.notify();
    }

    fn drain_wake(&self) {
        self.wake.drain();
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
    let mut isolate = v8::Isolate::new(params);
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
        crate::async_rt::new_state_with_pipe(async_pipe.0, async_pipe.1),
    ));
    let initialized = (|| {
        if scheduled
            .as_ref()
            .is_some_and(|scheduled| scheduled.was_forced())
        {
            return Err("scheduled Realm was force-terminated during initialization".to_string());
        }
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
fn drive_slice(workload: &mut Workload, shared: &PoolShared) -> Result<Slice, String> {
    let owner = workload.owner;
    let context_global = workload.context.clone();
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
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
    let tc = &mut v8::TryCatch::new(scope);
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
        if service_scheduled_sync_call(tc, &workload.state) {
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
    Ok(Slice::Settled)
}

fn retire_owner(owner: u32) {
    let mut inner = mailbox().inner.lock().unwrap();
    inner.events.remove(&owner);
    let mut change = ReadinessChange::control(0.0, 0.0);
    change.cancel_owner = Some(owner);
    inner.changes.push(change);
    drop(inner);
    mailbox().notify();
}

fn drop_workload(mut workload: Workload) {
    // Clear any pending interrupt before entering the isolate for teardown, so
    // a forced termination cannot unwind the disposal path itself.
    workload.isolate.cancel_terminate_execution();
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

    fn wake_worker(&mut self, worker: usize) {
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
            wake: WakePipe::new(),
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

    fn signal_inner(inner: &mut PoolSharedInner, owner: u32) {
        if !inner.parked.contains_key(&owner) && !inner.residents.contains_key(&owner) {
            return;
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
    }

    fn signal(&self, owner: u32) {
        Self::signal_inner(&mut self.inner.lock().unwrap(), owner);
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
    /// Deliberately conservative: it inspects only the heap root and never
    /// mutates the queue, so a superseded root, or a root belonging to the
    /// running realm, simply reports "no reason to switch". Both are transient,
    /// and `claim` re-evaluates the whole queue at the next quiescence. Being
    /// wrong here costs a slightly late preemption, never a lost workload.
    fn should_yield(&self, current: u32) -> bool {
        let inner = self.inner.lock().unwrap();
        if inner.shutdown {
            return true;
        }
        let Some(entry) = inner.ready.peek() else {
            return false;
        };
        if entry.owner == current {
            return false;
        }
        if inner.generations.get(&entry.owner).copied().unwrap_or(0) != entry.generation {
            return false;
        }
        if inner.priorities.get(&entry.owner).copied().unwrap_or(0) != entry.priority {
            return false;
        }
        entry.priority > inner.priorities.get(&current).copied().unwrap_or(0)
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
        drop(inner);
        owner_pools().lock().unwrap().remove(&owner);
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
        let outcome = drive_slice(resident.item.live_mut(), &shared);
        let (result, event) = match outcome {
            Ok(Slice::Preempted) => {
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
    let Some(pool) = process_pool().lock().unwrap().clone() else {
        throw_error(scope, "createWorkload: process reactor is not running");
        return;
    };
    let owner = next_owner();
    let async_pipe = match create_pipe() {
        Ok(pipe) => pipe,
        Err(error) => {
            throw_error(scope, &format!("createWorkload: {error}"));
            return;
        }
    };
    let wake_fd = async_pipe.0;
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
        isolate_handle: Mutex::new(None),
        force_requested: AtomicBool::new(false),
    });
    let owner = next_owner();
    let wake_fd = async_pipe.0;
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
    let handle = handle_arg(scope, args.get(0));
    let header = copy_uint8_array(scope, args.get(1)).unwrap_or_default();
    let Some(data) = copy_uint8_array(scope, args.get(2)) else {
        throw_error(
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
        throw_error(
            scope,
            &format!("scheduledRealmSend: invalid realm handle {handle}"),
        );
        return;
    };
    let _ = realm.tx.send(crate::realm::thread::ThreadMessage {
        header,
        data,
        transfer_stores,
        transfer_ports,
    });
    WakePipe::signal(realm.child_wake_write);
}

fn scheduled_realm_recv(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(&handle) else {
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
    WakePipe::consume(realm.parent_wake_read);
    rv.set(crate::realm::transit::build_message_array(scope, messages).into());
}

fn take_scheduled_realm_status(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let realms = scheduled_realms().lock().unwrap();
    let Some(realm) = realms.get(&handle) else {
        throw_error(
            scope,
            &format!("takeScheduledRealmStatus: invalid realm handle {handle}"),
        );
        return;
    };
    WakePipe::consume(realm.completion_wake_read);
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
    scope: &mut v8::HandleScope,
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
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let realm = scheduled_realms().lock().unwrap().remove(&handle);
    if realm.is_none() {
        throw_error(
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
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let mut registered = process_pool().lock().unwrap();
    if registered.is_some() {
        throw_error(
            scope,
            "startReactorPool: process reactor is already running",
        );
        return;
    }
    let shared = Arc::new(PoolShared::new());
    let control_fd = shared.wake.read;
    *registered = Some(shared);
    rv.set(v8::Integer::new(scope, control_fd).into());
}

/// Resolve the process reactor pool, or throw when it is not running.
fn require_pool(scope: &mut v8::HandleScope, caller: &str) -> Option<Arc<PoolShared>> {
    let pool = process_pool().lock().unwrap().clone();
    if pool.is_none() {
        throw_error(scope, &format!("{caller}: process reactor is not running"));
    }
    pool
}

fn create_reactor_thread(
    scope: &mut v8::HandleScope,
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
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = handle_arg(scope, args.get(0));
    let thread = REACTOR_THREADS.with(|threads| threads.borrow_mut().remove(&handle));
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
/// Every reactor thread must already have been stopped: the pool is dropped
/// here, and its parked realms disposed on this thread. Validation happens
/// before any mutation so a refused close leaves the pool exactly as it was.
fn stop_reactor_pool(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let attached = process_pool()
        .lock()
        .unwrap()
        .as_ref()
        .map(Arc::strong_count);
    let Some(attached) = attached else {
        throw_error(scope, "stopReactorPool: process reactor is not running");
        return;
    };
    // Only the registration itself may hold a reference by this point.
    if attached > 1 {
        throw_error(scope, "stopReactorPool: reactor threads are still attached");
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
        throw_error(scope, "stopReactorPool: reactor threads are still attached");
        return;
    };
    let parked = std::mem::take(&mut pool.inner.lock().unwrap().parked);
    for item in parked.into_values() {
        match item.workload {
            PoolWorkload::Live(workload) => drop_workload(workload.0),
            PoolWorkload::Pending(pending) => {
                retire_owner(item.owner);
                drop(pending);
            }
        }
    }
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
        scheduler_poll: false,
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

fn register_reactor_wake(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    let fd = args.get(1).int32_value(scope).unwrap_or(-1);
    let mut change = ReadinessChange::control(owner as f64, 0.0);
    change.ident = fd as f64;
    change.scheduler_wake = true;
    mailbox().inner.lock().unwrap().changes.push(change);
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
            v8::Boolean::new(scope, change.scheduler_poll).into(),
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
    let mut completion: ReadinessCompletion = [0.0; COMPLETION_SLOTS];
    for (slot, value) in completion.iter_mut().enumerate() {
        *value = args.get(slot as i32 + 1).number_value(scope).unwrap_or(0.0);
    }
    mailbox()
        .inner
        .lock()
        .unwrap()
        .events
        .entry(owner)
        .or_default()
        .push(completion);
    if args.get(COMPLETION_SLOTS as i32 + 1).boolean_value(scope)
        && let Some(pool) = owner_pools()
            .lock()
            .unwrap()
            .get(&owner)
            .and_then(Weak::upgrade)
    {
        pool.signal(owner);
    }
}

/// Hand a realm every readiness completion routed to it, as one flat batch.
///
/// The batch is a single `Float64Array` of `COMPLETION_SLOTS` values per event,
/// so a drain costs one allocation regardless of how many completions it
/// carries, and no encoding at all.
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
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Integer::new(scope, mailbox().wake.read).into());
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
        "forceScheduledRealm",
        "startReactorPool",
        "createReactorThread",
        "closeReactorThread",
        "signalReactorOwner",
        "takeReactorEvents",
        "stopReactorPool",
        "processReadinessControlFd",
        "registerProcessReadiness",
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
    set_fn!("forceScheduledRealm", force_scheduled_realm);
    set_fn!("startReactorPool", start_reactor_pool);
    set_fn!("createReactorThread", create_reactor_thread);
    set_fn!("closeReactorThread", close_reactor_thread);
    set_fn!("signalReactorOwner", signal_reactor_owner);
    set_fn!("takeReactorEvents", take_reactor_events);
    set_fn!("stopReactorPool", stop_reactor_pool);
    set_fn!("processReadinessControlFd", process_readiness_control_fd);
    set_fn!("registerProcessReadiness", register_process_readiness);
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
