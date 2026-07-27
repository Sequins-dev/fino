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

struct ActiveWorkload {
    saved_async_state: Option<crate::async_rt::IsolateAsyncState>,
    _locker: crate::v8_threading::IsolateLocker,
}

thread_local! {
    static WORKLOADS: RefCell<Vec<Option<Workload>>> = const { RefCell::new(Vec::new()) };
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

fn setup_workload(
    entry: String,
    process_env: ProcessEnv,
    package_map_json: Option<String>,
    import_rules: Vec<crate::state::ImportRule>,
    owner: u32,
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
) -> Result<Workload, String> {
    crate::runtime::init_v8();
    let params = v8::CreateParams::default()
        .array_buffer_allocator(crate::runtime::shared_allocator().clone());
    let mut isolate = v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    let saved_async_state = crate::async_rt::swap_state(Some(crate::async_rt::new_state()));
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
    let (context, state, module) = initialized?;
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

struct PoolItem {
    workload: TransferWorkload,
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
    active: HashSet<u32>,
    shutdown: bool,
    next_worker: usize,
}

struct PoolShared {
    inner: Mutex<PoolSharedInner>,
    changed: Condvar,
    wake_read: i32,
    wake_write: i32,
}

impl PoolShared {
    fn new(parked: HashMap<u32, PoolItem>) -> Self {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        for fd in fds {
            unsafe {
                libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK);
            }
        }
        let mut inner = PoolSharedInner {
            parked,
            events: VecDeque::new(),
            ready: BinaryHeap::new(),
            priorities: HashMap::new(),
            generations: HashMap::new(),
            active: HashSet::new(),
            shutdown: false,
            next_worker: 0,
        };
        for owner in inner.parked.keys().copied().collect::<Vec<_>>() {
            Self::signal_inner(&mut inner, owner);
        }
        Self {
            inner: Mutex::new(inner),
            changed: Condvar::new(),
            wake_read: fds[0],
            wake_write: fds[1],
        }
    }

    fn signal_inner(inner: &mut PoolSharedInner, owner: u32) {
        if !inner.parked.contains_key(&owner) && !inner.active.contains(&owner) {
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
    }

    fn signal(&self, owner: u32) {
        Self::signal_inner(&mut self.inner.lock().unwrap(), owner);
        self.changed.notify_all();
    }

    fn claim(&self, current: Option<u32>, stop: &AtomicBool, current_state: CurrentState) -> Claim {
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
                if inner.active.contains(&entry.owner) && Some(entry.owner) != current {
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
                    inner.ready.push(candidate);
                }
                if Some(owner) == current {
                    return Claim::Current;
                }
                let Some(item) = inner.parked.remove(&owner) else {
                    continue;
                };
                inner.active.insert(owner);
                return Claim::Work(item);
            }
            if current.is_some() {
                match current_state {
                    CurrentState::Runnable => return Claim::Current,
                    CurrentState::Polling => {
                        let (next, timeout) = self
                            .changed
                            .wait_timeout(inner, std::time::Duration::from_millis(1))
                            .unwrap();
                        inner = next;
                        if timeout.timed_out() {
                            return Claim::Current;
                        }
                    }
                    CurrentState::Parked => {
                        inner = self.changed.wait(inner).unwrap();
                    }
                }
            } else {
                inner = self.changed.wait(inner).unwrap();
            }
        }
    }

    fn park(&self, mut resident: Resident) {
        let owner = resident.item.workload.0.owner;
        deactivate(&mut resident.item.workload.0, resident.active);
        let mut inner = self.inner.lock().unwrap();
        inner.active.remove(&owner);
        inner.parked.insert(owner, resident.item);
        drop(inner);
        self.changed.notify_all();
    }

    fn finish(&self, owner: u32) {
        let mut inner = self.inner.lock().unwrap();
        inner.active.remove(&owner);
        inner.priorities.remove(&owner);
        inner.generations.remove(&owner);
        drop(inner);
        owner_pools().lock().unwrap().remove(&owner);
        self.changed.notify_all();
    }

    fn notify(&self, event: PoolEvent) {
        self.inner.lock().unwrap().events.push_back(event);
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
        self.shared.changed.notify_all();
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

fn run_worker(worker: usize, shared: Arc<PoolShared>, stop: Arc<AtomicBool>) {
    let mut current: Option<Resident> = None;
    let mut current_state = CurrentState::Parked;
    loop {
        let current_owner = current
            .as_ref()
            .map(|resident| resident.item.workload.0.owner);
        match shared.claim(current_owner, &stop, current_state) {
            Claim::Shutdown => break,
            Claim::Current => {}
            Claim::Work(mut item) => {
                let previous = current_owner;
                if let Some(resident) = current.take() {
                    shared.park(resident);
                }
                let owner = item.workload.0.owner;
                let active = activate(&mut item.workload.0);
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
            .workload
            .0
            .owner;
        let mut resident = current.take().unwrap();
        match drive_slice(&mut resident.item.workload.0) {
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
                if let Some(scheduled) = resident.item.workload.0.scheduled.as_ref() {
                    let result = if resident.item.workload.0.state.borrow().reload_requested {
                        ScheduledRealmResult::Reload
                    } else {
                        ScheduledRealmResult::Done
                    };
                    scheduled.complete(result);
                }
                deactivate(&mut resident.item.workload.0, resident.active);
                drop_workload(resident.item.workload.0);
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
                if let Some(scheduled) = resident.item.workload.0.scheduled.as_ref() {
                    scheduled.complete(ScheduledRealmResult::Error(error.clone()));
                }
                deactivate(&mut resident.item.workload.0, resident.active);
                drop_workload(resident.item.workload.0);
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

fn take_workload(handle: usize) -> Result<Workload, String> {
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
    let workload = match setup_workload(
        entry,
        process_env,
        package_map_json,
        import_rules,
        owner,
        None,
        None,
        None,
        None,
        false,
        false,
        None,
        None,
        None,
        None,
        None,
    ) {
        Ok(workload) => workload,
        Err(error) => {
            throw_error(scope, &format!("createWorkload: {error}"));
            return;
        }
    };
    let handle = WORKLOADS.with(|workloads| {
        let mut workloads = workloads.borrow_mut();
        if let Some((index, slot)) = workloads
            .iter_mut()
            .enumerate()
            .find(|(_, workload)| workload.is_none())
        {
            *slot = Some(workload);
            index
        } else {
            workloads.push(Some(workload));
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
    let reload_requested = Arc::new(AtomicBool::new(false));
    let scheduled = Arc::new(ScheduledRealmState {
        result: Mutex::new(None),
        parent_wake_write: completion_wake_write,
    });
    let owner = next_owner();
    let workload = match setup_workload(
        entry,
        process_env,
        package_map_json,
        import_rules,
        owner,
        Some(child_rx),
        Some(child_tx),
        Some(child_wake_read),
        Some(parent_wake_write),
        watch_mode,
        repl_mode,
        realm_data,
        realm_bootstrap_data,
        Some(reload_requested),
        Some(Arc::clone(&scheduled)),
        Some((child_wake_read, parent_wake_write)),
    ) {
        Ok(workload) => workload,
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
    let wake_fd = workload
        .async_state
        .as_ref()
        .map(|state| state.wake_read)
        .unwrap_or(-1);
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
    {
        pool.inner.lock().unwrap().parked.insert(
            owner,
            PoolItem {
                workload: TransferWorkload(workload),
            },
        );
        owner_pools()
            .lock()
            .unwrap()
            .insert(owner, Arc::downgrade(&pool));
        pool.signal(owner);
    }
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
    let Ok(handles) = v8::Local::<v8::Array>::try_from(args.get(0)) else {
        throw_error(scope, "createReactorQueue: handles must be an array");
        return;
    };
    if handles.length() == 0 {
        throw_error(
            scope,
            "createReactorQueue: at least one workload is required",
        );
        return;
    }
    let mut parked = HashMap::new();
    let mut owners = Vec::new();
    for index in 0..handles.length() {
        let handle = handles
            .get_index(scope, index)
            .and_then(|value| value.uint32_value(scope))
            .unwrap_or(u32::MAX) as usize;
        let workload = match take_workload(handle) {
            Ok(workload) => workload,
            Err(error) => {
                throw_error(scope, &format!("createReactorQueue: {error}"));
                return;
            }
        };
        owners.push(workload.owner);
        parked.insert(
            workload.owner,
            PoolItem {
                workload: TransferWorkload(workload),
            },
        );
    }

    let shared = Arc::new(PoolShared::new(parked));
    {
        *process_pool().lock().unwrap() = Some(Arc::clone(&shared));
        let mut pools = owner_pools().lock().unwrap();
        for owner in &owners {
            pools.insert(*owner, Arc::downgrade(&shared));
        }
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
    let owners_array = v8::Array::new(scope, owners.len() as i32);
    for (index, owner) in owners.into_iter().enumerate() {
        let owner = v8::Integer::new_from_unsigned(scope, owner);
        owners_array.set_index(scope, index as u32, owner.into());
    }
    for (name, value) in [
        (
            "handle",
            v8::Integer::new_from_unsigned(scope, handle as u32).into(),
        ),
        ("owners", owners_array.into()),
        ("controlFd", v8::Integer::new(scope, control_fd).into()),
    ] {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

fn create_reactor_thread(
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
            &format!("createReactorThread: invalid queue {queue_handle}"),
        );
        return;
    };
    let worker = {
        let mut inner = shared.inner.lock().unwrap();
        let worker = inner.next_worker;
        inner.next_worker += 1;
        worker
    };
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

fn add_queue_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let queue_handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let workload_handle = args.get(1).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let workload = match take_workload(workload_handle) {
        Ok(workload) => workload,
        Err(error) => {
            throw_error(scope, &format!("addReactorWorkload: {error}"));
            return;
        }
    };
    let owner = workload.owner;
    let result = REACTOR_QUEUES.with(|queues| {
        let queues = queues.borrow();
        let queue = queues
            .get(queue_handle)
            .and_then(Option::as_ref)
            .ok_or_else(|| format!("invalid reactor queue {queue_handle}"))?;
        queue.inner.lock().unwrap().parked.insert(
            owner,
            PoolItem {
                workload: TransferWorkload(workload),
            },
        );
        owner_pools()
            .lock()
            .unwrap()
            .insert(owner, Arc::downgrade(queue));
        queue.signal(owner);
        Ok::<_, String>(())
    });
    if let Err(error) = result {
        throw_error(scope, &format!("addReactorWorkload: {error}"));
        return;
    }
    rv.set(v8::Integer::new_from_unsigned(scope, owner).into());
}

fn signal_reactor_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let queue_handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let owner = args.get(1).uint32_value(scope).unwrap_or(0);
    let result = REACTOR_QUEUES.with(|queues| {
        let queues = queues.borrow();
        let queue = queues
            .get(queue_handle)
            .and_then(Option::as_ref)
            .ok_or_else(|| format!("invalid reactor queue {queue_handle}"))?;
        queue.signal(owner);
        Ok::<_, String>(())
    });
    if let Err(error) = result {
        throw_error(scope, &format!("signalReactorWorkload: {error}"));
    }
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
        Ok::<_, String>(
            queue
                .inner
                .lock()
                .unwrap()
                .events
                .drain(..)
                .collect::<Vec<_>>(),
        )
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
    {
        let mut inner = queue.inner.lock().unwrap();
        inner.shutdown = true;
    }
    queue.changed.notify_all();
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
    let parked = std::mem::take(&mut queue.inner.lock().unwrap().parked);
    for item in parked.into_values() {
        drop_workload(item.workload.0);
    }
}

fn terminate_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).uint32_value(scope).unwrap_or(u32::MAX) as usize;
    let workload = WORKLOADS.with(|workloads| {
        workloads
            .borrow_mut()
            .get_mut(handle)
            .and_then(Option::take)
    });
    if let Some(workload) = workload {
        drop_workload(workload);
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
            .and_then(|workload| workload.async_state.as_ref())
            .map(|state| state.wake_read)
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

fn route_shared_loop_event(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    route_process_readiness(scope, args, rv);
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
        "createReactorThread",
        "closeReactorThread",
        "addReactorWorkload",
        "signalReactorWorkload",
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
        "routeSharedLoopEvent",
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
    set_fn!("createReactorThread", create_reactor_thread);
    set_fn!("closeReactorThread", close_reactor_thread);
    set_fn!("addReactorWorkload", add_queue_workload);
    set_fn!("signalReactorWorkload", signal_reactor_workload);
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
    set_fn!("routeSharedLoopEvent", route_shared_loop_event);
    set_fn!("takeSharedLoopEvents", take_shared_loop_events);
    Some(v8::undefined(scope).into())
}
