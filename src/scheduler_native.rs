//! Parked V8 isolates and readiness scheduling.
//!
//! Native code owns isolate transitions and the scalar readiness boundary:
//! the legacy path shares one kqueue/io_uring per thread, while the process
//! pool routes owner-tagged registrations through a dedicated TypeScript
//! reactor. Ready metadata is dispatched back into the owning isolate.
//! Promise state, actual reads and writes, buffers, retries, and protocol
//! policy remain in TypeScript.

use std::{
    cell::{Cell, RefCell},
    collections::{BinaryHeap, HashMap, HashSet, VecDeque},
    rc::Rc,
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
    },
};

use ::v8;

use crate::{
    loader,
    state::{FinoState, ProcessEnv, default_import_rules, get_state},
};

struct ParkedWorkload {
    owner_id: u32,
    context: v8::Global<v8::Context>,
    dispatch_fn: v8::Global<v8::Function>,
    take_ops_fn: v8::Global<v8::Function>,
    complete_fn: v8::Global<v8::Function>,
    settled_fn: v8::Global<v8::Function>,
    tick_fn: v8::Global<v8::Function>,
    flush_fn: v8::Global<v8::Function>,
    readiness_fn: v8::Global<v8::Function>,
    active_promise: Option<v8::Global<v8::Promise>>,
    async_state: Option<crate::async_rt::IsolateAsyncState>,
    _state: Rc<RefCell<FinoState>>,
    _module: v8::Global<v8::Module>,
    isolate: v8::OwnedIsolate,
    moved_between_threads: bool,
    process_readiness: bool,
}

struct WorkloadTable(Vec<Option<ParkedWorkload>>);

struct TransferWorkload(ParkedWorkload);

// SAFETY: a transfer is constructed only after the isolate has been exited and
// all V8 scopes have been dropped. Exactly one worker owns the wrapper, and
// every cross-thread entry is protected by V8's Locker.
unsafe impl Send for TransferWorkload {}

struct ActiveWorkload {
    saved_async_state: Option<crate::async_rt::IsolateAsyncState>,
    _locker: Option<crate::v8_threading::IsolateLocker>,
}

#[derive(Clone, Copy, Eq, Ord, PartialEq, PartialOrd)]
struct ReadinessPriority {
    signals: usize,
    generation: u64,
    owner: u32,
}

#[derive(Default)]
struct ReadinessPriorityQueue {
    heap: BinaryHeap<ReadinessPriority>,
    pending: HashMap<u32, usize>,
    generations: HashMap<u32, u64>,
    queued: HashSet<u32>,
}

impl ReadinessPriorityQueue {
    fn record(&mut self, owner: u32) {
        let signals = self.pending.entry(owner).or_default();
        *signals += 1;
        let generation = self.generations.entry(owner).or_default();
        *generation += 1;
        self.queued.insert(owner);
        self.heap.push(ReadinessPriority {
            signals: *signals,
            generation: *generation,
            owner,
        });
    }

    fn pending(&self, owner: u32) -> usize {
        self.pending.get(&owner).copied().unwrap_or(0)
    }

    #[cfg(test)]
    fn queued_len(&self) -> usize {
        self.queued.len()
    }

    fn claim_higher_than(&mut self, current_owner: u32, current_signals: usize) -> Option<u32> {
        loop {
            let candidate = *self.heap.peek()?;
            let current_generation = self.generations.get(&candidate.owner).copied().unwrap_or(0);
            if !self.queued.contains(&candidate.owner)
                || candidate.generation != current_generation
                || candidate.signals != self.pending(candidate.owner)
            {
                self.heap.pop();
                continue;
            }
            if candidate.owner == current_owner || candidate.signals <= current_signals {
                return None;
            }
            self.heap.pop();
            self.queued.remove(&candidate.owner);
            return Some(candidate.owner);
        }
    }

    fn remove(&mut self, owner: u32) {
        self.queued.remove(&owner);
    }

    fn enqueue(&mut self, owner: u32) {
        let signals = self.pending(owner);
        if signals == 0 {
            return;
        }
        let generation = self.generations.get(&owner).copied().unwrap_or(0);
        self.queued.insert(owner);
        self.heap.push(ReadinessPriority {
            signals,
            generation,
            owner,
        });
    }

    fn consume(&mut self, owner: u32) -> usize {
        self.queued.remove(&owner);
        self.pending.remove(&owner).unwrap_or(0)
    }
}

#[derive(Default)]
struct SharedReadinessInner {
    events: HashMap<u32, VecDeque<RoutedLoopEvent>>,
    priorities: ReadinessPriorityQueue,
    process_changes: Vec<ReadinessChange>,
    resident_workers: HashMap<u32, usize>,
    retired: HashSet<u32>,
    version: u64,
}

struct SharedReadiness {
    inner: Mutex<SharedReadinessInner>,
    changed: Condvar,
    wake_read: i32,
    wake_write: i32,
}

impl SharedReadiness {
    fn new() -> Self {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        for fd in fds {
            unsafe {
                libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK);
            }
        }
        Self {
            inner: Mutex::new(SharedReadinessInner::default()),
            changed: Condvar::new(),
            wake_read: fds[0],
            wake_write: fds[1],
        }
    }

    fn notify(&self) {
        self.changed.notify_all();
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

fn shared_readiness() -> &'static SharedReadiness {
    static SHARED: OnceLock<SharedReadiness> = OnceLock::new();
    SHARED.get_or_init(SharedReadiness::new)
}

struct SharedLoopDescriptor {
    json: String,
    fd: i32,
    kind: SharedLoopKind,
}

#[derive(Clone, Copy)]
enum SharedLoopKind {
    Kqueue,
    IoUring,
}

#[derive(Clone, Copy)]
enum WorkloadReadiness {
    Delegated,
    ThreadShared,
    ProcessShared,
    Local,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RoutedLoopEvent {
    ident: f64,
    filter: i32,
    flags: u32,
    fflags: Option<u32>,
    data: Option<f64>,
    res: Option<i32>,
    udata: Option<f64>,
    #[serde(default)]
    routed: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(serde::Serialize)]
struct ReadinessChange {
    ident: u64,
    filter: i16,
    flags: u16,
    fflags: u32,
    data: i64,
    udata: u64,
    #[serde(rename = "cancelOwner", skip_serializing_if = "Option::is_none")]
    cancel_owner: Option<u32>,
}

impl Drop for SharedLoopDescriptor {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

impl Drop for WorkloadTable {
    fn drop(&mut self) {
        for workload in self.0.drain(..).flatten() {
            drop_parked(workload);
        }
    }
}

thread_local! {
    static WORKLOADS: RefCell<WorkloadTable> = const { RefCell::new(WorkloadTable(Vec::new())) };
    static SHARED_LOOP_DESCRIPTOR: RefCell<Option<SharedLoopDescriptor>> = const { RefCell::new(None) };
    static NEXT_SHARED_POLL_ID: Cell<u64> = const { Cell::new(1 << 32) };
    static SHARED_POLLS: RefCell<HashMap<u64, u64>> = RefCell::new(HashMap::new());
    static READINESS_CHANGES: RefCell<Vec<ReadinessChange>> = const { RefCell::new(Vec::new()) };
}

fn next_workload_owner() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |owner| {
        owner.checked_add(1)
    })
    .expect("workload owner id overflow")
}

pub(crate) fn configure_reactor_workload(scope: &mut v8::HandleScope) -> Result<u32, String> {
    let owner_id = next_workload_owner();
    install_reactor_workload(scope, owner_id, false)?;
    Ok(owner_id)
}

fn install_reactor_workload(
    scope: &mut v8::HandleScope,
    owner_id: u32,
    process_shared: bool,
) -> Result<(), String> {
    let owner_key = v8::String::new(scope, "__finoSchedulerWorkloadId")
        .ok_or_else(|| "failed to allocate scheduler owner marker".to_string())?;
    let owner_value = v8::Integer::new_from_unsigned(scope, owner_id);
    context_global(scope)
        .set(scope, owner_key.into(), owner_value.into())
        .ok_or_else(|| "failed to install scheduler owner marker".to_string())?;
    if !process_shared {
        let key = v8::String::new(scope, "__finoSchedulerSharesReadiness")
            .ok_or_else(|| "failed to allocate shared readiness marker".to_string())?;
        let value = v8::Boolean::new(scope, true);
        context_global(scope)
            .set(scope, key.into(), value.into())
            .ok_or_else(|| "failed to install shared readiness marker".to_string())?;
    }
    if process_shared || cfg!(target_os = "macos") {
        let key = v8::String::new(scope, "__finoNativeReadinessRegistration")
            .ok_or_else(|| "failed to allocate native readiness marker".to_string())?;
        let value = v8::Boolean::new(scope, true);
        context_global(scope)
            .set(scope, key.into(), value.into())
            .ok_or_else(|| "failed to install native readiness marker".to_string())?;
    }
    if process_shared {
        let key = v8::String::new(scope, "__finoProcessReadiness")
            .ok_or_else(|| "failed to allocate process readiness marker".to_string())?;
        let value = v8::Boolean::new(scope, true);
        context_global(scope)
            .set(scope, key.into(), value.into())
            .ok_or_else(|| "failed to install process readiness marker".to_string())?;
    }
    Ok(())
}

fn context_global<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Object> {
    scope.get_current_context().global(scope)
}

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "createWorkload",
        "dispatchWorkload",
        "driveResidentWorkload",
        "driveSharedResidentWorkloads",
        "drivePooledResidentWorkloads",
        "completeHostOperation",
        "terminateWorkload",
        "workloadWakeFd",
        "workloadOwner",
        "sharedLoopDescriptor",
        "routeSharedLoopEvent",
        "routeProcessReadiness",
        "takeSharedLoopEvents",
        "registerSharedPoll",
        "takeSharedPoll",
        "cancelSharedPoll",
        "registerSharedReadiness",
        "registerProcessReadiness",
        "takeSharedReadinessChanges",
        "pollSharedReactor",
    ]
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
        ($name:literal, $callback:path) => {{
            let template = v8::FunctionTemplate::new(scope, $callback);
            let function = template.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, function.into())?;
        }};
    }

    set_fn!("createWorkload", create_workload);
    set_fn!("dispatchWorkload", dispatch_workload);
    set_fn!("driveResidentWorkload", drive_resident_workload);
    set_fn!(
        "driveSharedResidentWorkloads",
        drive_shared_resident_workloads
    );
    set_fn!(
        "drivePooledResidentWorkloads",
        drive_pooled_resident_workloads
    );
    set_fn!("completeHostOperation", complete_host_operation);
    set_fn!("terminateWorkload", terminate_workload);
    set_fn!("workloadWakeFd", workload_wake_fd);
    set_fn!("workloadOwner", workload_owner);
    set_fn!("sharedLoopDescriptor", shared_loop_descriptor);
    set_fn!("routeSharedLoopEvent", route_shared_loop_event);
    set_fn!("routeProcessReadiness", route_process_readiness);
    set_fn!("takeSharedLoopEvents", take_shared_loop_events);
    set_fn!("registerSharedPoll", register_shared_poll);
    set_fn!("takeSharedPoll", take_shared_poll);
    set_fn!("cancelSharedPoll", cancel_shared_poll);
    set_fn!("registerSharedReadiness", register_shared_readiness);
    set_fn!("registerProcessReadiness", register_process_readiness);
    set_fn!("takeSharedReadinessChanges", take_shared_readiness_changes);
    set_fn!("pollSharedReactor", poll_shared_reactor);
    Some(v8::undefined(scope).into())
}

fn register_shared_readiness(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    READINESS_CHANGES.with(|changes| {
        changes
            .borrow_mut()
            .push(readiness_change_from_args(scope, &args));
    });
}

fn register_process_readiness(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let readiness = shared_readiness();
    {
        let mut inner = readiness.inner.lock().unwrap();
        inner
            .process_changes
            .push(readiness_change_from_args(scope, &args));
    }
    readiness.notify();
}

fn readiness_change_from_args(
    scope: &mut v8::HandleScope,
    args: &v8::FunctionCallbackArguments,
) -> ReadinessChange {
    ReadinessChange {
        ident: args.get(0).integer_value(scope).unwrap_or(0) as u64,
        filter: args.get(1).int32_value(scope).unwrap_or(0) as i16,
        flags: args.get(2).uint32_value(scope).unwrap_or(0) as u16,
        fflags: args.get(3).uint32_value(scope).unwrap_or(0),
        data: args.get(4).integer_value(scope).unwrap_or(0),
        udata: args.get(5).integer_value(scope).unwrap_or(0) as u64,
        cancel_owner: None,
    }
}

fn take_shared_readiness_changes(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let readiness = shared_readiness();
    readiness.drain_wake();
    let changes = {
        let mut inner = readiness.inner.lock().unwrap();
        std::mem::take(&mut inner.process_changes)
    };
    match serde_json::to_string(&changes) {
        Ok(json) => {
            if let Some(value) = v8::String::new(scope, &json) {
                rv.set(value.into());
            }
        }
        Err(error) => throw_error(
            scope,
            &format!("failed to encode readiness registrations: {error}"),
        ),
    }
}

fn poll_shared_reactor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let timeout_ms = if args.get(0).is_null() {
        -1
    } else {
        args.get(0).int32_value(scope).unwrap_or(0)
    };
    match wait_for_reactor(timeout_ms) {
        Ok(ready) => rv.set(v8::Boolean::new(scope, ready).into()),
        Err(error) => throw_error(scope, &error),
    }
}

fn register_shared_poll(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    const FIRST_POLL_ID: u64 = 1 << 32;
    const LAST_POLL_ID: u64 = (1 << 48) - 1;

    let user_data = args.get(0).integer_value(scope).unwrap_or(0) as u64;
    let poll_id = NEXT_SHARED_POLL_ID.with(|next| {
        SHARED_POLLS.with(|polls| {
            let mut polls = polls.borrow_mut();
            loop {
                let candidate = next.get();
                next.set(if candidate == LAST_POLL_ID {
                    FIRST_POLL_ID
                } else {
                    candidate + 1
                });
                if let std::collections::hash_map::Entry::Vacant(entry) = polls.entry(candidate) {
                    entry.insert(user_data);
                    return candidate;
                }
            }
        })
    });
    rv.set(v8::Number::new(scope, poll_id as f64).into());
}

fn take_shared_poll(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let poll_id = args.get(0).integer_value(scope).unwrap_or(-1) as u64;
    let user_data = SHARED_POLLS.with(|polls| polls.borrow_mut().remove(&poll_id));
    if let Some(user_data) = user_data {
        rv.set(v8::Number::new(scope, user_data as f64).into());
    } else {
        rv.set(v8::null(scope).into());
    }
}

fn cancel_shared_poll(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let poll_id = args.get(0).integer_value(scope).unwrap_or(-1) as u64;
    SHARED_POLLS.with(|polls| {
        polls.borrow_mut().remove(&poll_id);
    });
}

fn route_shared_loop_event(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    let json = args
        .get(1)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_default();
    let event = match serde_json::from_str::<RoutedLoopEvent>(&json) {
        Ok(event) => event,
        Err(error) => {
            throw_error(scope, &format!("invalid routed loop event: {error}"));
            return;
        }
    };
    queue_routed_event(owner, event);
}

fn route_process_readiness(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    queue_routed_event(
        owner,
        RoutedLoopEvent {
            ident: args.get(1).number_value(scope).unwrap_or(0.0),
            filter: args.get(2).int32_value(scope).unwrap_or(0),
            flags: args.get(3).uint32_value(scope).unwrap_or(0),
            fflags: Some(args.get(4).uint32_value(scope).unwrap_or(0)),
            data: Some(args.get(5).number_value(scope).unwrap_or(0.0)),
            res: None,
            udata: Some(args.get(6).number_value(scope).unwrap_or(0.0)),
            routed: true,
        },
    );
}

fn queue_routed_event(owner: u32, event: RoutedLoopEvent) {
    let readiness = shared_readiness();
    {
        let mut inner = readiness.inner.lock().unwrap();
        if inner.retired.contains(&owner) {
            return;
        }
        inner.events.entry(owner).or_default().push_back(event);
        inner.priorities.record(owner);
        if inner.resident_workers.contains_key(&owner) {
            inner.priorities.remove(owner);
        }
        inner.version = inner.version.wrapping_add(1);
    }
    readiness.changed.notify_all();
}

fn retire_process_readiness_owner(owner: u32) {
    let readiness = shared_readiness();
    {
        let mut inner = readiness.inner.lock().unwrap();
        inner.retired.insert(owner);
        inner.resident_workers.remove(&owner);
        inner.priorities.consume(owner);
        inner.events.remove(&owner);
        inner.process_changes.push(ReadinessChange {
            ident: 0,
            filter: 0,
            flags: 0,
            fflags: 0,
            data: 0,
            udata: 0,
            cancel_owner: Some(owner),
        });
        inner.version = inner.version.wrapping_add(1);
    }
    readiness.notify();
}

fn mark_workload_runnable(owner: u32) {
    let readiness = shared_readiness();
    {
        let mut inner = readiness.inner.lock().unwrap();
        inner.priorities.record(owner);
        inner.version = inner.version.wrapping_add(1);
    }
    readiness.changed.notify_all();
}

fn mark_workload_resident(owner: u32, worker: usize) {
    let mut inner = shared_readiness().inner.lock().unwrap();
    inner.resident_workers.insert(owner, worker);
    inner.priorities.remove(owner);
}

fn mark_workload_parked(owner: u32) {
    let readiness = shared_readiness();
    {
        let mut inner = readiness.inner.lock().unwrap();
        inner.resident_workers.remove(&owner);
        inner.priorities.enqueue(owner);
        inner.version = inner.version.wrapping_add(1);
    }
    readiness.changed.notify_all();
}

fn pending_readiness(owner: u32) -> usize {
    shared_readiness()
        .inner
        .lock()
        .unwrap()
        .priorities
        .pending(owner)
}

fn consume_scheduling_token(owner: u32) {
    shared_readiness()
        .inner
        .lock()
        .unwrap()
        .priorities
        .consume(owner);
}

fn claim_higher_priority_workload(current_owner: u32, current_signals: usize) -> Option<u32> {
    shared_readiness()
        .inner
        .lock()
        .unwrap()
        .priorities
        .claim_higher_than(current_owner, current_signals)
}

fn signal_scheduler_change() {
    let readiness = shared_readiness();
    {
        let mut inner = readiness.inner.lock().unwrap();
        inner.version = inner.version.wrapping_add(1);
    }
    readiness.notify();
}

fn take_ready_workload(preferred: u32) -> Option<u32> {
    let mut inner = shared_readiness().inner.lock().unwrap();
    if inner.priorities.pending(preferred) > 0 {
        inner.priorities.remove(preferred);
        Some(preferred)
    } else {
        inner.priorities.claim_higher_than(preferred, 0)
    }
}

fn remove_ready_workload(owner: u32) {
    shared_readiness()
        .inner
        .lock()
        .unwrap()
        .priorities
        .remove(owner);
}

fn reactor_routes_completions() -> bool {
    #[cfg(target_os = "macos")]
    {
        SHARED_LOOP_DESCRIPTOR.with(|slot| {
            slot.borrow()
                .as_ref()
                .is_some_and(|descriptor| matches!(descriptor.kind, SharedLoopKind::Kqueue))
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub(crate) fn clear_ready_workloads() {
    shared_readiness().inner.lock().unwrap().priorities = ReadinessPriorityQueue::default();
}

fn take_shared_loop_events(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let owner = args.get(0).uint32_value(scope).unwrap_or(0);
    remove_ready_workload(owner);
    let events = {
        let mut inner = shared_readiness().inner.lock().unwrap();
        inner.priorities.consume(owner);
        inner
            .events
            .remove(&owner)
            .map(VecDeque::into_iter)
            .map(Iterator::collect::<Vec<_>>)
            .unwrap_or_default()
    };
    match serde_json::to_string(&events) {
        Ok(json) => {
            if let Some(value) = v8::String::new(scope, &json) {
                rv.set(value.into());
            }
        }
        Err(error) => throw_error(
            scope,
            &format!("failed to encode routed loop events: {error}"),
        ),
    }
}

fn shared_loop_descriptor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let candidate = if args.get(0).is_string() {
        args.get(0)
            .to_string(scope)
            .map(|value| value.to_rust_string_lossy(scope))
    } else {
        None
    };
    let descriptor = SHARED_LOOP_DESCRIPTOR.with(|slot| -> Result<Option<String>, String> {
        let mut slot = slot.borrow_mut();
        if let Some(descriptor) = slot.as_ref() {
            return Ok(Some(descriptor.json.clone()));
        }
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        let mut value: serde_json::Value = serde_json::from_str(&candidate)
            .map_err(|error| format!("invalid shared loop descriptor: {error}"))?;
        let fd_key = if value.get("ringFd").is_some() {
            "ringFd"
        } else {
            "fd"
        };
        let kind = match value.get("kind").and_then(serde_json::Value::as_str) {
            Some("kqueue") => SharedLoopKind::Kqueue,
            Some("io_uring") => SharedLoopKind::IoUring,
            Some(kind) => return Err(format!("unsupported shared loop kind: {kind}")),
            None => return Err("shared loop descriptor is missing its kind".to_string()),
        };
        let fd = value
            .get(fd_key)
            .and_then(serde_json::Value::as_i64)
            .and_then(|fd| i32::try_from(fd).ok())
            .ok_or_else(|| "shared loop descriptor is missing its fd".to_string())?;
        let shared_fd = unsafe { libc::dup(fd) };
        if shared_fd < 0 {
            return Err(format!(
                "failed to retain shared loop fd: {}",
                std::io::Error::last_os_error()
            ));
        }
        value[fd_key] = serde_json::Value::from(shared_fd);
        let json = serde_json::to_string(&value)
            .map_err(|error| format!("failed to encode shared loop descriptor: {error}"))?;
        *slot = Some(SharedLoopDescriptor {
            json: json.clone(),
            fd: shared_fd,
            kind,
        });
        Ok(Some(json))
    });
    match descriptor {
        Err(error) => throw_error(scope, &error),
        Ok(Some(descriptor)) => {
            if let Some(value) = v8::String::new(scope, &descriptor) {
                rv.set(value.into());
            }
        }
        Ok(None) => rv.set(v8::null(scope).into()),
    }
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

fn json_quote(input: &str) -> String {
    serde_json::to_string(input).unwrap_or_else(|_| "\"\"".to_string())
}

fn global_function(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    name: &str,
) -> Result<v8::Global<v8::Function>, String> {
    let key =
        v8::String::new(scope, name).ok_or_else(|| format!("failed to allocate {name} key"))?;
    let value = context
        .global(scope)
        .get(scope, key.into())
        .ok_or_else(|| format!("{name} is missing"))?;
    let function = v8::Local::<v8::Function>::try_from(value)
        .map_err(|_| format!("{name} is not a function"))?;
    Ok(v8::Global::new(scope, function))
}

fn setup_workload(
    entry_path: String,
    process_env: ProcessEnv,
    package_map_json: Option<String>,
    readiness: WorkloadReadiness,
    owner_id: u32,
) -> Result<ParkedWorkload, String> {
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
        let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(isolate_scope, Default::default());
        context.set_microtask_queue(&root_queue);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        let state = FinoState::new_root(
            process_env,
            package_map_json,
            root_queue,
            default_import_rules(),
        );
        context.set_slot(Rc::new(RefCell::new(state)));
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());
        match readiness {
            WorkloadReadiness::Delegated => {
                let marker_key = v8::String::new(scope, "__finoSchedulerDelegatesReadiness")
                    .ok_or_else(|| "failed to allocate scheduler marker".to_string())?;
                let marker_value = v8::Boolean::new(scope, true);
                context
                    .global(scope)
                    .set(scope, marker_key.into(), marker_value.into());
                let owner_key = v8::String::new(scope, "__finoSchedulerWorkloadId")
                    .ok_or_else(|| "failed to allocate scheduler owner marker".to_string())?;
                let owner_value = v8::Integer::new_from_unsigned(scope, owner_id);
                context
                    .global(scope)
                    .set(scope, owner_key.into(), owner_value.into());
            }
            WorkloadReadiness::ThreadShared => {
                install_reactor_workload(scope, owner_id, false)?;
            }
            WorkloadReadiness::ProcessShared => {
                install_reactor_workload(scope, owner_id, true)?;
            }
            WorkloadReadiness::Local => {}
        }

        let delegates_readiness = matches!(readiness, WorkloadReadiness::Delegated);
        let runner = format!(
            "import 'internal:bootstrap';\n\
             import {{ configureWorkload }} from 'internal:scheduler/workload';\n\
             configureWorkload(import({}), {});\n",
            json_quote(&entry_path),
            delegates_readiness
        );

        let module = {
            let tc = &mut v8::TryCatch::new(scope);
            loader::compile_source_module(tc, &runner, "internal:scheduler-workload", None)
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to compile scheduler workload".to_string())
                })?
        };
        loader::register_as_builtin(scope, module, "internal:scheduler-workload");
        {
            let tc = &mut v8::TryCatch::new(scope);
            module
                .instantiate_module(tc, loader::resolve_module_callback)
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to instantiate scheduler workload".to_string())
                })?;
        }
        {
            let tc = &mut v8::TryCatch::new(scope);
            module.evaluate(tc).ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to evaluate scheduler workload".to_string())
            })?;
        }
        crate::realm::child::pump_and_checkpoint(scope);
        if module.get_status() == v8::ModuleStatus::Errored {
            return Err(js_string(scope, module.get_exception()));
        }

        Ok((
            v8::Global::new(scope, context),
            global_function(scope, context, "__finoSchedulerDispatch")?,
            global_function(scope, context, "__finoSchedulerTakeHostOps")?,
            global_function(scope, context, "__finoSchedulerCompleteHostOp")?,
            global_function(scope, context, "__finoSchedulerSettled")?,
            global_function(scope, context, "__finoSchedulerTick")?,
            global_function(scope, context, "__finoSchedulerFlush")?,
            global_function(scope, context, "__finoSchedulerCompleteReadiness")?,
            get_state(scope),
            v8::Global::new(scope, module),
        ))
    })();
    let workload_async_state = crate::async_rt::swap_state(saved_async_state);
    let (
        context,
        dispatch_fn,
        take_ops_fn,
        complete_fn,
        settled_fn,
        tick_fn,
        flush_fn,
        readiness_fn,
        state,
        module,
    ) = initialized?;

    let mut workload = ParkedWorkload {
        owner_id,
        context,
        dispatch_fn,
        take_ops_fn,
        complete_fn,
        settled_fn,
        tick_fn,
        flush_fn,
        readiness_fn,
        active_promise: None,
        async_state: workload_async_state,
        _state: state,
        _module: module,
        isolate,
        moved_between_threads: false,
        process_readiness: matches!(readiness, WorkloadReadiness::ProcessShared),
    };
    unsafe {
        workload.isolate.exit();
    }
    Ok(workload)
}

fn drive_typescript_reactor_entered(workload: &mut ParkedWorkload) -> Result<(), String> {
    let context_global = workload.context.clone();
    let dispatch_fn = workload.dispatch_fn.clone();
    let tick_fn = workload.tick_fn.clone();
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &context_global);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    let input = v8::Object::new(scope);
    let key = v8::String::new(scope, "controlFd").unwrap();
    let value = v8::Integer::new(scope, shared_readiness().wake_read);
    input.set(scope, key.into(), value.into());
    let function = v8::Local::new(scope, &dispatch_fn);
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let promise = {
        let tc = &mut v8::TryCatch::new(scope);
        let value = function
            .call(tc, receiver, &[input.into()])
            .ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "process readiness reactor threw".to_string())
            })?;
        let promise = v8::Local::<v8::Promise>::try_from(value)
            .map_err(|_| "process readiness reactor did not return a promise".to_string())?;
        v8::Global::new(tc, promise)
    };
    workload.active_promise = Some(promise);
    loop {
        crate::realm::child::pump_and_checkpoint(scope);
        let promise = v8::Local::new(scope, workload.active_promise.as_ref().unwrap());
        match promise.state() {
            v8::PromiseState::Pending => {
                let timeout: v8::Local<v8::Value> = v8::null(scope).into();
                call_number_function(scope, &tick_fn, &[timeout])?;
            }
            v8::PromiseState::Fulfilled => {
                return Err("process readiness reactor exited unexpectedly".to_string());
            }
            v8::PromiseState::Rejected => {
                let value = promise.result(scope);
                return Err(js_string(scope, value));
            }
        }
    }
}

fn run_process_readiness_reactor(mut transfer: TransferWorkload) {
    let active = activate_workload(&mut transfer.0);
    if let Err(error) = drive_typescript_reactor_entered(&mut transfer.0) {
        eprintln!("fino: process readiness reactor stopped: {error}");
    }
    deactivate_workload(&mut transfer.0, active);
    drop_parked(transfer.0);
}

fn ensure_process_readiness_reactor(
    process_env: ProcessEnv,
    package_map_json: Option<String>,
) -> Result<(), String> {
    static STARTED: OnceLock<Mutex<bool>> = OnceLock::new();
    let started = STARTED.get_or_init(|| Mutex::new(false));
    let mut started = started.lock().unwrap();
    if *started {
        return Ok(());
    }
    let mut workload = setup_workload(
        "internal:scheduler/reactor".to_string(),
        process_env,
        package_map_json,
        WorkloadReadiness::Local,
        0,
    )?;
    workload.moved_between_threads = true;
    let transfer = TransferWorkload(workload);
    std::thread::Builder::new()
        .name("fino-process-readiness".to_string())
        .spawn(move || run_process_readiness_reactor(transfer))
        .map_err(|error| format!("failed to spawn process readiness reactor: {error}"))?;
    *started = true;
    Ok(())
}

fn create_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let entry_path = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if entry_path.is_empty() {
        throw_error(scope, "createWorkload: entry path is required");
        return;
    }
    let parent_state = get_state(scope);
    let delegates_readiness = args.get(1).is_undefined() || args.get(1).boolean_value(scope);
    let process_shared = args.get(2).boolean_value(scope);
    let owner_id = next_workload_owner();
    let (process_env, package_map_json) = {
        let state = parent_state.borrow();
        (state.process_env.clone(), state.package_map_json.clone())
    };
    if process_shared
        && let Err(error) =
            ensure_process_readiness_reactor(process_env.clone(), package_map_json.clone())
    {
        throw_error(scope, &format!("createWorkload: {error}"));
        return;
    }
    let readiness = if delegates_readiness {
        WorkloadReadiness::Delegated
    } else if process_shared {
        WorkloadReadiness::ProcessShared
    } else {
        WorkloadReadiness::ThreadShared
    };
    let workload = match setup_workload(
        entry_path,
        process_env,
        package_map_json,
        readiness,
        owner_id,
    ) {
        Ok(workload) => workload,
        Err(error) => {
            throw_error(scope, &format!("createWorkload: {error}"));
            return;
        }
    };
    let handle = WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        if let Some(index) = table.0.iter().position(Option::is_none) {
            table.0[index] = Some(workload);
            index
        } else {
            let index = table.0.len();
            table.0.push(Some(workload));
            index
        }
    });
    rv.set(v8::Integer::new(scope, handle as i32).into());
}

fn call_string_function(
    scope: &mut v8::HandleScope,
    function: &v8::Global<v8::Function>,
    args: &[v8::Local<v8::Value>],
) -> Result<String, String> {
    let function = v8::Local::new(scope, function);
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let tc = &mut v8::TryCatch::new(scope);
    let value = function.call(tc, receiver, args).ok_or_else(|| {
        crate::realm::child::catch_message(tc)
            .unwrap_or_else(|| "scheduler helper threw".to_string())
    })?;
    value
        .to_string(tc)
        .map(|value| value.to_rust_string_lossy(tc))
        .ok_or_else(|| "scheduler helper did not return a string".to_string())
}

fn take_host_operations(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    take_ops_fn: &v8::Global<v8::Function>,
) -> Result<Option<String>, String> {
    let key = v8::String::new(scope, "__finoSchedulerHostOps")
        .ok_or_else(|| "failed to allocate host operation key".to_string())?;
    let value = context
        .global(scope)
        .get(scope, key.into())
        .ok_or_else(|| "host operation queue is missing".to_string())?;
    let operations = v8::Local::<v8::Array>::try_from(value)
        .map_err(|_| "host operation queue is not an array".to_string())?;
    if operations.length() == 0 {
        return Ok(None);
    }
    let json = call_string_function(scope, take_ops_fn, &[])?;
    Ok(Some(format!(
        "{{\"kind\":\"hostOperations\",\"operations\":{json}}}"
    )))
}

fn dispatch_entered(workload: &mut ParkedWorkload, request_json: &str) -> Result<String, String> {
    let context_global = workload.context.clone();
    let dispatch_fn = workload.dispatch_fn.clone();
    let take_ops_fn = workload.take_ops_fn.clone();
    let settled_fn = workload.settled_fn.clone();
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &context_global);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);

    if workload.active_promise.is_none() {
        let function = v8::Local::new(scope, &dispatch_fn);
        let request = v8::String::new(scope, request_json)
            .ok_or_else(|| "failed to allocate workload request".to_string())?;
        let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
        let promise = {
            let tc = &mut v8::TryCatch::new(scope);
            let value = function
                .call(tc, receiver, &[request.into()])
                .ok_or_else(|| {
                    crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "scheduler workload dispatch threw".to_string())
                })?;
            let promise = v8::Local::<v8::Promise>::try_from(value)
                .map_err(|_| "scheduler workload dispatch did not return a promise".to_string())?;
            v8::Global::new(tc, promise)
        };
        workload.active_promise = Some(promise);
    }

    crate::realm::child::pump_and_checkpoint(scope);
    if let Some(operations) = take_host_operations(scope, context, &take_ops_fn)? {
        return Ok(operations);
    }

    let promise = v8::Local::new(scope, workload.active_promise.as_ref().unwrap());
    match promise.state() {
        v8::PromiseState::Pending => Ok("{\"kind\":\"pending\"}".to_string()),
        v8::PromiseState::Fulfilled => {
            let value = promise.result(scope);
            workload.active_promise = None;
            call_string_function(scope, &settled_fn, &[value])
        }
        v8::PromiseState::Rejected => {
            let value = promise.result(scope);
            workload.active_promise = None;
            Err(js_string(scope, value))
        }
    }
}

fn with_entered_workload<T>(
    workload: &mut ParkedWorkload,
    callback: impl FnOnce(&mut ParkedWorkload) -> Result<T, String>,
) -> Result<T, String> {
    let saved_async_state = crate::async_rt::swap_state(workload.async_state.take());
    unsafe {
        workload.isolate.enter();
    }
    let result = callback(workload);
    unsafe {
        workload.isolate.exit();
    }
    workload.async_state = crate::async_rt::swap_state(saved_async_state);
    result
}

fn activate_workload(workload: &mut ParkedWorkload) -> ActiveWorkload {
    let locker = workload
        .moved_between_threads
        .then(|| crate::v8_threading::IsolateLocker::new(&mut workload.isolate));
    let saved_async_state = crate::async_rt::swap_state(workload.async_state.take());
    unsafe {
        workload.isolate.enter();
    }
    ActiveWorkload {
        saved_async_state,
        _locker: locker,
    }
}

fn deactivate_workload(workload: &mut ParkedWorkload, active: ActiveWorkload) {
    unsafe {
        workload.isolate.exit();
    }
    let ActiveWorkload {
        saved_async_state,
        _locker,
    } = active;
    workload.async_state = crate::async_rt::swap_state(saved_async_state);
    drop(_locker);
}

fn dispatch_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let request_json = args
        .get(1)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "{}".to_string());
    let result = WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        let workload = table
            .0
            .get_mut(handle)
            .and_then(Option::as_mut)
            .ok_or_else(|| "dispatchWorkload: invalid workload handle".to_string())?;
        with_entered_workload(workload, |workload| {
            dispatch_entered(workload, &request_json)
        })
    });
    match result {
        Ok(json) => {
            if let Some(value) = v8::String::new(scope, &json) {
                rv.set(value.into());
            }
        }
        Err(error) => throw_error(scope, &error),
    }
}

fn drive_resident_entered(
    workload: &mut ParkedWorkload,
    request_bytes: &[u8],
) -> Result<(Vec<u8>, u64), String> {
    let routes_completions = workload.process_readiness || reactor_routes_completions();
    let context_global = workload.context.clone();
    let dispatch_fn = workload.dispatch_fn.clone();
    let tick_fn = workload.tick_fn.clone();
    let flush_fn = workload.flush_fn.clone();
    let readiness_fn = workload.readiness_fn.clone();
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &context_global);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    if workload.active_promise.is_some() {
        return Err("resident workload already has an active dispatch".to_string());
    }
    let function = v8::Local::new(scope, &dispatch_fn);
    let request = crate::realm::serializer::deserialize_value(scope, request_bytes)?;
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let promise = {
        let tc = &mut v8::TryCatch::new(scope);
        let value = function.call(tc, receiver, &[request]).ok_or_else(|| {
            crate::realm::child::catch_message(tc)
                .unwrap_or_else(|| "resident workload dispatch threw".to_string())
        })?;
        let promise = v8::Local::<v8::Promise>::try_from(value)
            .map_err(|_| "resident workload dispatch did not return a promise".to_string())?;
        v8::Global::new(tc, promise)
    };
    workload.active_promise = Some(promise);

    let mut loop_turns = 0u64;
    loop {
        crate::realm::child::pump_and_checkpoint(scope);
        let promise = v8::Local::new(scope, workload.active_promise.as_ref().unwrap());
        match promise.state() {
            v8::PromiseState::Pending => {
                if !routes_completions {
                    call_number_function(scope, &flush_fn, &[])?;
                }
                if take_ready_workload(workload.owner_id).is_none() {
                    wait_for_reactor(-1)?;
                }
                if routes_completions {
                    remove_ready_workload(workload.owner_id);
                    dispatch_ready_events(scope, workload.owner_id, &readiness_fn)?;
                } else {
                    let function = v8::Local::new(scope, &tick_fn);
                    let timeout = v8::Number::new(scope, 0.0);
                    let tc = &mut v8::TryCatch::new(scope);
                    function
                        .call(tc, receiver, &[timeout.into()])
                        .ok_or_else(|| {
                            crate::realm::child::catch_message(tc)
                                .unwrap_or_else(|| "resident workload loop tick threw".to_string())
                        })?;
                }
                loop_turns += 1;
            }
            v8::PromiseState::Fulfilled => {
                let result = promise.result(scope);
                workload.active_promise = None;
                let bytes = crate::realm::serializer::serialize_value(scope, result)?;
                return Ok((bytes, loop_turns));
            }
            v8::PromiseState::Rejected => {
                let value = promise.result(scope);
                workload.active_promise = None;
                return Err(js_string(scope, value));
            }
        }
    }
}

fn drive_resident_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let request_bytes = match crate::realm::serializer::serialize_value(scope, args.get(1)) {
        Ok(bytes) => bytes,
        Err(error) => {
            throw_error(scope, &format!("driveResidentWorkload: {error}"));
            return;
        }
    };
    let result = WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        let workload = table
            .0
            .get_mut(handle)
            .and_then(Option::as_mut)
            .ok_or_else(|| "driveResidentWorkload: invalid workload handle".to_string())?;
        with_entered_workload(workload, |workload| {
            drive_resident_entered(workload, &request_bytes)
        })
    });
    match result {
        Ok((bytes, loop_turns)) => {
            let value = match crate::realm::serializer::deserialize_value(scope, &bytes) {
                Ok(value) => value,
                Err(error) => {
                    throw_error(scope, &format!("driveResidentWorkload: {error}"));
                    return;
                }
            };
            let result = v8::Object::new(scope);
            for (name, value) in [
                ("value", value),
                (
                    "loopTurns",
                    v8::Number::new(scope, loop_turns as f64).into(),
                ),
                ("isolateEntries", v8::Integer::new(scope, 1).into()),
                ("isolateExits", v8::Integer::new(scope, 1).into()),
            ] {
                let Some(key) = v8::String::new(scope, name) else {
                    throw_error(
                        scope,
                        "driveResidentWorkload: failed to allocate result key",
                    );
                    return;
                };
                if result.set(scope, key.into(), value).is_none() {
                    throw_error(scope, "driveResidentWorkload: failed to build result");
                    return;
                }
            }
            rv.set(result.into());
        }
        Err(error) => throw_error(scope, &error),
    }
}

enum ResidentSliceOutcome {
    Pending,
    Switch(u32),
    Settled(Vec<u8>),
}

fn call_number_function(
    scope: &mut v8::HandleScope,
    function: &v8::Global<v8::Function>,
    args: &[v8::Local<v8::Value>],
) -> Result<i64, String> {
    let function = v8::Local::new(scope, function);
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    let tc = &mut v8::TryCatch::new(scope);
    let value = function.call(tc, receiver, args).ok_or_else(|| {
        crate::realm::child::catch_message(tc)
            .unwrap_or_else(|| "scheduler numeric helper threw".to_string())
    })?;
    value
        .integer_value(tc)
        .ok_or_else(|| "scheduler numeric helper did not return a number".to_string())
}

fn dispatch_ready_events(
    scope: &mut v8::HandleScope,
    owner: u32,
    readiness_fn: &v8::Global<v8::Function>,
) -> Result<usize, String> {
    let events = {
        let mut inner = shared_readiness().inner.lock().unwrap();
        inner.priorities.consume(owner);
        inner
            .events
            .remove(&owner)
            .map(VecDeque::into_iter)
            .map(Iterator::collect::<Vec<_>>)
            .unwrap_or_default()
    };
    let function = v8::Local::new(scope, readiness_fn);
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    for event in &events {
        let args: [v8::Local<v8::Value>; 7] = [
            v8::Number::new(scope, event.ident).into(),
            v8::Integer::new(scope, event.filter).into(),
            v8::Integer::new_from_unsigned(scope, event.flags).into(),
            v8::Integer::new_from_unsigned(scope, event.fflags.unwrap_or(0)).into(),
            v8::Number::new(scope, event.data.unwrap_or(0.0)).into(),
            v8::Integer::new(scope, event.res.unwrap_or(0)).into(),
            v8::Number::new(scope, event.udata.unwrap_or(event.ident)).into(),
        ];
        let tc = &mut v8::TryCatch::new(scope);
        function.call(tc, receiver, &args).ok_or_else(|| {
            crate::realm::child::catch_message(tc)
                .unwrap_or_else(|| "readiness completion callback threw".to_string())
        })?;
    }
    Ok(events.len())
}

pub(crate) fn wait_for_reactor(timeout_ms: i32) -> Result<bool, String> {
    let descriptor = SHARED_LOOP_DESCRIPTOR
        .with(|slot| slot.borrow().as_ref().map(|value| (value.fd, value.kind)));
    let Some((fd, kind)) = descriptor else {
        if timeout_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(timeout_ms as u64));
        }
        return Ok(false);
    };
    #[cfg(target_os = "macos")]
    if matches!(kind, SharedLoopKind::Kqueue) {
        return wait_for_kqueue(fd, timeout_ms);
    }
    let _ = kind;
    let mut poll_fd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    loop {
        let result = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
        if result > 0 {
            return Ok(true);
        }
        if result == 0 {
            return Ok(false);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(format!("thread reactor poll failed: {error}"));
        }
    }
}

#[cfg(target_os = "macos")]
fn wait_for_kqueue(fd: i32, timeout_ms: i32) -> Result<bool, String> {
    const MAX_EVENTS: usize = 256;
    const EV_ERROR: u16 = 0x4000;
    let mut events: [libc::kevent; MAX_EVENTS] = unsafe { std::mem::zeroed() };
    let timeout = libc::timespec {
        tv_sec: i64::from(timeout_ms.max(0) / 1000),
        tv_nsec: i64::from(timeout_ms.max(0) % 1000) * 1_000_000,
    };
    let timeout_ptr = if timeout_ms < 0 {
        std::ptr::null()
    } else {
        &timeout
    };
    let changes = READINESS_CHANGES.with(|changes| {
        std::mem::take(&mut *changes.borrow_mut())
            .into_iter()
            .map(|change| libc::kevent {
                ident: change.ident as usize,
                filter: change.filter,
                flags: change.flags,
                fflags: change.fflags,
                data: change.data as isize,
                udata: change.udata as usize as *mut libc::c_void,
            })
            .collect::<Vec<_>>()
    });
    let change_ptr = if changes.is_empty() {
        std::ptr::null()
    } else {
        changes.as_ptr()
    };
    let count = loop {
        let count = unsafe {
            libc::kevent(
                fd,
                change_ptr,
                changes.len() as i32,
                events.as_mut_ptr(),
                MAX_EVENTS as i32,
                timeout_ptr,
            )
        };
        if count >= 0 {
            break count as usize;
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(format!("thread reactor kevent failed: {error}"));
        }
    };
    for event in &events[..count] {
        if event.flags & EV_ERROR != 0 {
            let errno = event.data as i32;
            if errno == libc::ENOENT || errno == libc::EBADF {
                continue;
            }
            let ident = event.ident;
            let filter = event.filter;
            return Err(format!(
                "thread reactor kevent change failed: errno={errno} ident={} filter={}",
                ident, filter
            ));
        }
        let token = event.udata as usize as u64;
        let owner = (token >> 32) as u32;
        queue_routed_event(
            owner,
            RoutedLoopEvent {
                ident: event.ident as f64,
                filter: i32::from(event.filter),
                flags: u32::from(event.flags),
                fflags: Some(event.fflags),
                data: Some(event.data as f64),
                res: None,
                udata: Some(token as f64),
                routed: true,
            },
        );
    }
    Ok(count > 0)
}

fn drive_resident_slice_entered(
    workload: &mut ParkedWorkload,
    request_bytes: Option<&[u8]>,
    wait: bool,
) -> Result<(ResidentSliceOutcome, u64), String> {
    let routes_completions = workload.process_readiness || reactor_routes_completions();
    let context_global = workload.context.clone();
    let dispatch_fn = workload.dispatch_fn.clone();
    let tick_fn = workload.tick_fn.clone();
    let flush_fn = workload.flush_fn.clone();
    let readiness_fn = workload.readiness_fn.clone();
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &context_global);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();

    let continuing = request_bytes.is_none();
    if let Some(request_bytes) = request_bytes {
        if workload.active_promise.is_some() {
            return Err("resident workload already has an active dispatch".to_string());
        }
        let function = v8::Local::new(scope, &dispatch_fn);
        let request = crate::realm::serializer::deserialize_value(scope, request_bytes)?;
        let promise = {
            let tc = &mut v8::TryCatch::new(scope);
            let value = function.call(tc, receiver, &[request]).ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "resident workload dispatch threw".to_string())
            })?;
            let promise = v8::Local::<v8::Promise>::try_from(value)
                .map_err(|_| "resident workload dispatch did not return a promise".to_string())?;
            v8::Global::new(tc, promise)
        };
        workload.active_promise = Some(promise);
    } else if workload.active_promise.is_none() {
        return Err("resident workload has no active dispatch".to_string());
    }

    let mut loop_turns = 0u64;
    let mut foreign_owner = -1i64;
    if continuing && routes_completions {
        remove_ready_workload(workload.owner_id);
        if dispatch_ready_events(scope, workload.owner_id, &readiness_fn)? > 0 {
            loop_turns += 1;
        }
    } else if continuing && wait {
        if !routes_completions {
            let timeout: v8::Local<v8::Value> = v8::Number::new(scope, 0.0).into();
            foreign_owner = call_number_function(scope, &tick_fn, &[timeout])?;
        }
        loop_turns += 1;
    }
    loop {
        crate::realm::child::pump_and_checkpoint(scope);
        let promise = v8::Local::new(scope, workload.active_promise.as_ref().unwrap());
        match promise.state() {
            v8::PromiseState::Fulfilled => {
                let result = promise.result(scope);
                workload.active_promise = None;
                let bytes = crate::realm::serializer::serialize_value(scope, result)?;
                return Ok((ResidentSliceOutcome::Settled(bytes), loop_turns));
            }
            v8::PromiseState::Rejected => {
                let value = promise.result(scope);
                workload.active_promise = None;
                return Err(js_string(scope, value));
            }
            v8::PromiseState::Pending => {
                if foreign_owner >= 0 {
                    if !routes_completions {
                        call_number_function(scope, &flush_fn, &[])?;
                    }
                    return Ok((
                        ResidentSliceOutcome::Switch(foreign_owner as u32),
                        loop_turns,
                    ));
                }
                if !wait {
                    if !routes_completions {
                        call_number_function(scope, &flush_fn, &[])?;
                    }
                    return Ok((ResidentSliceOutcome::Pending, loop_turns));
                }
                if !routes_completions {
                    call_number_function(scope, &flush_fn, &[])?;
                }
                if let Some(owner) = take_ready_workload(workload.owner_id) {
                    if owner != workload.owner_id {
                        return Ok((ResidentSliceOutcome::Switch(owner), loop_turns));
                    }
                    if routes_completions {
                        dispatch_ready_events(scope, workload.owner_id, &readiness_fn)?;
                    } else {
                        let timeout: v8::Local<v8::Value> = v8::Number::new(scope, 0.0).into();
                        foreign_owner = call_number_function(scope, &tick_fn, &[timeout])?;
                    }
                    loop_turns += 1;
                    continue;
                }
                wait_for_reactor(-1)?;
                if routes_completions {
                    continue;
                }
                let timeout: v8::Local<v8::Value> = v8::Number::new(scope, 0.0).into();
                foreign_owner = call_number_function(scope, &tick_fn, &[timeout])?;
                loop_turns += 1;
            }
        }
    }
}

fn drive_shared_resident_workloads(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Ok(handles_array) = v8::Local::<v8::Array>::try_from(args.get(0)) else {
        throw_error(
            scope,
            "driveSharedResidentWorkloads: handles must be an array",
        );
        return;
    };
    let Ok(inputs_array) = v8::Local::<v8::Array>::try_from(args.get(1)) else {
        throw_error(
            scope,
            "driveSharedResidentWorkloads: inputs must be an array",
        );
        return;
    };
    if handles_array.length() != inputs_array.length() {
        throw_error(
            scope,
            "driveSharedResidentWorkloads: handles and inputs must have equal length",
        );
        return;
    }
    let mut handles = Vec::with_capacity(handles_array.length() as usize);
    let mut requests = Vec::with_capacity(inputs_array.length() as usize);
    for index in 0..handles_array.length() {
        let Some(handle) = handles_array.get_index(scope, index) else {
            throw_error(scope, "driveSharedResidentWorkloads: missing handle");
            return;
        };
        handles.push(handle.integer_value(scope).unwrap_or(-1) as usize);
        let Some(input) = inputs_array.get_index(scope, index) else {
            throw_error(scope, "driveSharedResidentWorkloads: missing input");
            return;
        };
        let bytes = match crate::realm::serializer::serialize_value(scope, input) {
            Ok(bytes) => bytes,
            Err(error) => {
                throw_error(scope, &format!("driveSharedResidentWorkloads: {error}"));
                return;
            }
        };
        requests.push(bytes);
    }

    let driven = WORKLOADS.with(|table| -> Result<_, String> {
        let mut table = table.borrow_mut();
        let mut owner_to_position = HashMap::new();
        for (position, handle) in handles.iter().copied().enumerate() {
            let workload = table
                .0
                .get(handle)
                .and_then(Option::as_ref)
                .ok_or_else(|| {
                    format!("driveSharedResidentWorkloads: invalid workload handle {handle}")
                })?;
            owner_to_position.insert(workload.owner_id, position);
        }

        let mut values: Vec<Option<Vec<u8>>> = vec![None; handles.len()];
        let mut pending = vec![true; handles.len()];
        let mut isolate_entries = 0u64;
        let mut isolate_exits = 0u64;
        let mut loop_turns = 0u64;
        let mut workload_switches = 0u64;

        for (position, handle) in handles.iter().copied().enumerate() {
            let workload = table
                .0
                .get_mut(handle)
                .and_then(Option::as_mut)
                .ok_or_else(|| {
                    format!("driveSharedResidentWorkloads: invalid workload handle {handle}")
                })?;
            isolate_entries += 1;
            let outcome = with_entered_workload(workload, |workload| {
                drive_resident_slice_entered(workload, Some(requests[position].as_slice()), false)
            });
            isolate_exits += 1;
            let (outcome, turns) = outcome?;
            loop_turns += turns;
            match outcome {
                ResidentSliceOutcome::Settled(value) => {
                    values[position] = Some(value);
                    pending[position] = false;
                }
                ResidentSliceOutcome::Pending => {}
                ResidentSliceOutcome::Switch(_) => {
                    return Err(
                        "driveSharedResidentWorkloads: initial dispatch requested a switch"
                            .to_string(),
                    );
                }
            }
        }

        let mut current = pending.iter().position(|pending| *pending);
        let mut previous = None;
        while let Some(position) = current {
            if previous.is_some_and(|previous| previous != position) {
                workload_switches += 1;
            }
            previous = Some(position);
            let handle = handles[position];
            let workload = table
                .0
                .get_mut(handle)
                .and_then(Option::as_mut)
                .ok_or_else(|| {
                    format!("driveSharedResidentWorkloads: invalid workload handle {handle}")
                })?;
            isolate_entries += 1;
            let outcome = with_entered_workload(workload, |workload| {
                drive_resident_slice_entered(workload, None, true)
            });
            isolate_exits += 1;
            let (outcome, turns) = outcome?;
            loop_turns += turns;
            current = match outcome {
                ResidentSliceOutcome::Settled(value) => {
                    values[position] = Some(value);
                    pending[position] = false;
                    pending.iter().position(|pending| *pending)
                }
                ResidentSliceOutcome::Switch(owner) => {
                    let next = owner_to_position.get(&owner).copied().ok_or_else(|| {
                        format!(
                            "driveSharedResidentWorkloads: readiness targets unknown owner {owner}"
                        )
                    })?;
                    if !pending[next] {
                        return Err(format!(
                            "driveSharedResidentWorkloads: readiness targets settled owner {owner}"
                        ));
                    }
                    Some(next)
                }
                ResidentSliceOutcome::Pending => {
                    return Err(
                        "driveSharedResidentWorkloads: blocking slice returned pending".to_string(),
                    );
                }
            };
        }

        let values = values
            .into_iter()
            .map(|value| {
                value.ok_or_else(|| {
                    "driveSharedResidentWorkloads: workload result is missing".to_string()
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok((
            values,
            workload_switches,
            isolate_entries,
            isolate_exits,
            loop_turns,
        ))
    });

    let (values, workload_switches, isolate_entries, isolate_exits, loop_turns) = match driven {
        Ok(result) => result,
        Err(error) => {
            throw_error(scope, &error);
            return;
        }
    };
    let result = v8::Object::new(scope);
    let values_array = v8::Array::new(scope, values.len() as i32);
    for (index, bytes) in values.iter().enumerate() {
        let value = match crate::realm::serializer::deserialize_value(scope, bytes) {
            Ok(value) => value,
            Err(error) => {
                throw_error(scope, &format!("driveSharedResidentWorkloads: {error}"));
                return;
            }
        };
        values_array.set_index(scope, index as u32, value);
    }
    let fields: [(&str, v8::Local<v8::Value>); 5] = [
        ("values", values_array.into()),
        (
            "workloadSwitches",
            v8::Number::new(scope, workload_switches as f64).into(),
        ),
        (
            "isolateEntries",
            v8::Number::new(scope, isolate_entries as f64).into(),
        ),
        (
            "isolateExits",
            v8::Number::new(scope, isolate_exits as f64).into(),
        ),
        (
            "loopTurns",
            v8::Number::new(scope, loop_turns as f64).into(),
        ),
    ];
    for (name, value) in fields {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

struct PoolItem {
    workload: TransferWorkload,
    position: usize,
    request: Option<Vec<u8>>,
    last_worker: Option<usize>,
}

struct PoolResident {
    item: PoolItem,
    active: ActiveWorkload,
}

struct PoolInner {
    parked: HashMap<u32, PoolItem>,
    values: Vec<Option<Result<Vec<u8>, String>>>,
    remaining: usize,
    aborted: bool,
    fatal: Option<String>,
    workload_switches: u64,
    workload_migrations: u64,
    isolate_entries: u64,
    isolate_exits: u64,
    loop_turns: u64,
}

struct PoolState {
    inner: Mutex<PoolInner>,
    changed: Condvar,
}

fn pool_finished(state: &PoolState) -> bool {
    let inner = state.inner.lock().unwrap();
    inner.remaining == 0 || inner.aborted
}

fn pool_take_item(state: &PoolState, owner: u32) -> Option<PoolItem> {
    state.inner.lock().unwrap().parked.remove(&owner)
}

fn activate_pool_item(worker: usize, state: &PoolState, mut item: PoolItem) -> PoolResident {
    let owner = item.workload.0.owner_id;
    let migrated = item
        .last_worker
        .is_some_and(|last_worker| last_worker != worker);
    item.last_worker = Some(worker);
    item.workload.0.moved_between_threads = true;
    mark_workload_resident(owner, worker);
    let active = activate_workload(&mut item.workload.0);
    let mut inner = state.inner.lock().unwrap();
    inner.isolate_entries += 1;
    if migrated {
        inner.workload_migrations += 1;
    }
    drop(inner);
    PoolResident { item, active }
}

fn park_pool_resident(state: &PoolState, mut resident: PoolResident, switched: bool) {
    let owner = resident.item.workload.0.owner_id;
    deactivate_workload(&mut resident.item.workload.0, resident.active);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.isolate_exits += 1;
        if switched {
            inner.workload_switches += 1;
        }
        inner.parked.insert(owner, resident.item);
    }
    mark_workload_parked(owner);
}

fn finish_pool_resident(
    state: &PoolState,
    mut resident: PoolResident,
    result: Result<Vec<u8>, String>,
    loop_turns: u64,
) {
    let owner = resident.item.workload.0.owner_id;
    deactivate_workload(&mut resident.item.workload.0, resident.active);
    retire_process_readiness_owner(owner);
    let position = resident.item.position;
    drop_parked(resident.item.workload.0);
    {
        let mut inner = state.inner.lock().unwrap();
        inner.isolate_exits += 1;
        inner.loop_turns += loop_turns;
        inner.values[position] = Some(result);
        inner.remaining -= 1;
    }
    state.changed.notify_all();
    signal_scheduler_change();
}

fn wait_for_pool_change(version: u64) {
    let readiness = shared_readiness();
    let inner = readiness.inner.lock().unwrap();
    if inner.version == version {
        drop(readiness.changed.wait(inner).unwrap());
    }
}

fn run_pool_worker(worker: usize, state: Arc<PoolState>) {
    let mut current: Option<PoolResident> = None;
    loop {
        if state.inner.lock().unwrap().aborted {
            if let Some(resident) = current.take() {
                park_pool_resident(&state, resident, false);
            }
            return;
        }

        let version = shared_readiness().inner.lock().unwrap().version;
        let current_owner = current
            .as_ref()
            .map(|resident| resident.item.workload.0.owner_id)
            .unwrap_or(0);
        let current_signals = current
            .as_ref()
            .map(|_| pending_readiness(current_owner))
            .unwrap_or(0);

        if let Some(owner) = claim_higher_priority_workload(current_owner, current_signals) {
            let Some(next) = pool_take_item(&state, owner) else {
                continue;
            };
            if let Some(resident) = current.take() {
                park_pool_resident(&state, resident, true);
            }
            current = Some(activate_pool_item(worker, &state, next));
            continue;
        }

        let Some(mut resident) = current.take() else {
            if pool_finished(&state) {
                return;
            }
            wait_for_pool_change(version);
            continue;
        };

        if current_signals == 0 {
            current = Some(resident);
            wait_for_pool_change(version);
            continue;
        }

        let request = resident.item.request.take();
        if request.is_some() {
            consume_scheduling_token(current_owner);
        }
        let driven =
            drive_resident_slice_entered(&mut resident.item.workload.0, request.as_deref(), false);
        match driven {
            Ok((ResidentSliceOutcome::Settled(value), turns)) => {
                finish_pool_resident(&state, resident, Ok(value), turns);
            }
            Ok((ResidentSliceOutcome::Pending, turns)) => {
                state.inner.lock().unwrap().loop_turns += turns;
                current = Some(resident);
            }
            Ok((ResidentSliceOutcome::Switch(_), turns)) => {
                finish_pool_resident(
                    &state,
                    resident,
                    Err("pooled non-blocking slice requested an internal switch".to_string()),
                    turns,
                );
            }
            Err(error) => finish_pool_resident(&state, resident, Err(error), 0),
        }
    }
}

fn drive_pooled_resident_workloads(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Ok(handles_array) = v8::Local::<v8::Array>::try_from(args.get(0)) else {
        throw_error(
            scope,
            "drivePooledResidentWorkloads: handles must be an array",
        );
        return;
    };
    let Ok(inputs_array) = v8::Local::<v8::Array>::try_from(args.get(1)) else {
        throw_error(
            scope,
            "drivePooledResidentWorkloads: inputs must be an array",
        );
        return;
    };
    if handles_array.length() != inputs_array.length() {
        throw_error(
            scope,
            "drivePooledResidentWorkloads: handles and inputs must have equal length",
        );
        return;
    }

    let default_threads = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    let worker_count = args
        .get(2)
        .uint32_value(scope)
        .map(|count| count as usize)
        .filter(|count| *count > 0)
        .unwrap_or(default_threads)
        .min(default_threads.max(1));
    let mut handles = Vec::with_capacity(handles_array.length() as usize);
    let mut requests = Vec::with_capacity(inputs_array.length() as usize);
    for index in 0..handles_array.length() {
        let Some(handle) = handles_array.get_index(scope, index) else {
            throw_error(scope, "drivePooledResidentWorkloads: missing handle");
            return;
        };
        handles.push(handle.integer_value(scope).unwrap_or(-1) as usize);
        let Some(input) = inputs_array.get_index(scope, index) else {
            throw_error(scope, "drivePooledResidentWorkloads: missing input");
            return;
        };
        match crate::realm::serializer::serialize_value(scope, input) {
            Ok(bytes) => requests.push(bytes),
            Err(error) => {
                throw_error(scope, &format!("drivePooledResidentWorkloads: {error}"));
                return;
            }
        }
    }
    if handles.iter().copied().collect::<HashSet<_>>().len() != handles.len() {
        throw_error(
            scope,
            "drivePooledResidentWorkloads: duplicate workload handle",
        );
        return;
    }

    let workloads = WORKLOADS.with(|table| -> Result<Vec<PoolItem>, String> {
        let mut table = table.borrow_mut();
        for handle in &handles {
            if table.0.get(*handle).and_then(Option::as_ref).is_none() {
                return Err(format!(
                    "drivePooledResidentWorkloads: invalid workload handle {handle}"
                ));
            }
        }
        handles
            .iter()
            .copied()
            .zip(requests)
            .enumerate()
            .map(|(position, (handle, request))| {
                let workload = table.0[handle]
                    .take()
                    .ok_or_else(|| "workload disappeared during pool transfer".to_string())?;
                Ok(PoolItem {
                    workload: TransferWorkload(workload),
                    position,
                    request: Some(request),
                    last_worker: None,
                })
            })
            .collect()
    });
    let workloads = match workloads {
        Ok(workloads) => workloads,
        Err(error) => {
            throw_error(scope, &error);
            return;
        }
    };

    let workload_count = workloads.len();
    let mut parked = HashMap::with_capacity(workload_count);
    for item in workloads {
        let owner = item.workload.0.owner_id;
        parked.insert(owner, item);
        mark_workload_runnable(owner);
    }
    let state = Arc::new(PoolState {
        inner: Mutex::new(PoolInner {
            parked,
            values: (0..workload_count).map(|_| None).collect(),
            remaining: workload_count,
            aborted: false,
            fatal: None,
            workload_switches: 0,
            workload_migrations: 0,
            isolate_entries: 0,
            isolate_exits: 0,
            loop_turns: 0,
        }),
        changed: Condvar::new(),
    });

    let mut workers = Vec::with_capacity(worker_count);
    for worker in 0..worker_count {
        let state = Arc::clone(&state);
        workers.push(std::thread::spawn(move || run_pool_worker(worker, state)));
    }

    {
        let mut inner = state.inner.lock().unwrap();
        while inner.remaining > 0 && !inner.aborted {
            inner = state.changed.wait(inner).unwrap();
        }
    }
    for worker in workers {
        if worker.join().is_err() {
            let mut inner = state.inner.lock().unwrap();
            inner
                .fatal
                .get_or_insert_with(|| "pool worker panicked".to_string());
        }
    }

    let mut inner = state.inner.lock().unwrap();
    if let Some(error) = inner.fatal.take() {
        let parked = std::mem::take(&mut inner.parked);
        drop(inner);
        for item in parked.into_values() {
            drop_parked(item.workload.0);
        }
        throw_error(scope, &format!("drivePooledResidentWorkloads: {error}"));
        return;
    }
    let values = std::mem::take(&mut inner.values);
    let metrics = (
        inner.workload_switches,
        inner.workload_migrations,
        inner.isolate_entries,
        inner.isolate_exits,
        inner.loop_turns,
    );
    drop(inner);

    let result = v8::Object::new(scope);
    let values_array = v8::Array::new(scope, values.len() as i32);
    for (index, value) in values.into_iter().enumerate() {
        let bytes = match value {
            Some(Ok(bytes)) => bytes,
            Some(Err(error)) => {
                throw_error(scope, &format!("drivePooledResidentWorkloads: {error}"));
                return;
            }
            None => {
                throw_error(
                    scope,
                    "drivePooledResidentWorkloads: workload result is missing",
                );
                return;
            }
        };
        let value = match crate::realm::serializer::deserialize_value(scope, &bytes) {
            Ok(value) => value,
            Err(error) => {
                throw_error(scope, &format!("drivePooledResidentWorkloads: {error}"));
                return;
            }
        };
        values_array.set_index(scope, index as u32, value);
    }
    let fields: [(&str, v8::Local<v8::Value>); 7] = [
        ("values", values_array.into()),
        (
            "workloadSwitches",
            v8::Number::new(scope, metrics.0 as f64).into(),
        ),
        (
            "workloadMigrations",
            v8::Number::new(scope, metrics.1 as f64).into(),
        ),
        (
            "isolateEntries",
            v8::Number::new(scope, metrics.2 as f64).into(),
        ),
        (
            "isolateExits",
            v8::Number::new(scope, metrics.3 as f64).into(),
        ),
        ("loopTurns", v8::Number::new(scope, metrics.4 as f64).into()),
        (
            "workerThreads",
            v8::Number::new(scope, worker_count as f64).into(),
        ),
    ];
    for (name, value) in fields {
        let key = v8::String::new(scope, name).unwrap();
        result.set(scope, key.into(), value);
    }
    rv.set(result.into());
}

fn complete_entered(
    workload: &mut ParkedWorkload,
    operation_id: i64,
    ok: bool,
    result_json: &str,
) -> Result<(), String> {
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &workload.context);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    let function = v8::Local::new(scope, &workload.complete_fn);
    let id = v8::Number::new(scope, operation_id as f64);
    let ok = v8::Boolean::new(scope, ok);
    let json = v8::String::new(scope, result_json)
        .ok_or_else(|| "failed to allocate host operation result".to_string())?;
    let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
    {
        let tc = &mut v8::TryCatch::new(scope);
        function
            .call(tc, receiver, &[id.into(), ok.into(), json.into()])
            .ok_or_else(|| {
                crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "host operation completion threw".to_string())
            })?;
    }
    crate::realm::child::pump_and_checkpoint(scope);
    Ok(())
}

fn complete_host_operation(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let operation_id = args.get(1).integer_value(scope).unwrap_or(-1);
    let ok = args.get(2).boolean_value(scope);
    let result_json = args
        .get(3)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "null".to_string());
    let result = WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        let workload = table
            .0
            .get_mut(handle)
            .and_then(Option::as_mut)
            .ok_or_else(|| "completeHostOperation: invalid workload handle".to_string())?;
        with_entered_workload(workload, |workload| {
            complete_entered(workload, operation_id, ok, &result_json)
        })
    });
    if let Err(error) = result {
        throw_error(scope, &error);
    }
}

fn drop_parked(mut workload: ParkedWorkload) {
    if workload.moved_between_threads {
        let locker = crate::v8_threading::IsolateLocker::new(&mut workload.isolate);
        unsafe {
            workload.isolate.enter();
            workload.isolate.exit();
        }
        // Locker::~Locker reads the isolate's ThreadManager, so it must run
        // before OwnedIsolate disposes that state. TransferWorkload still gives
        // this thread exclusive ownership during the final unguarded enter; it
        // is only needed because OwnedIsolate's Drop expects the isolate current.
        drop(locker);
    }
    unsafe {
        workload.isolate.enter();
    }
    drop(workload);
}

fn terminate_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    WORKLOADS.with(|table| {
        let mut table = table.borrow_mut();
        if let Some(workload) = table.0.get_mut(handle).and_then(Option::take) {
            let owner_id = workload.owner_id;
            SHARED_POLLS.with(|polls| {
                polls
                    .borrow_mut()
                    .retain(|_, user_data| (*user_data >> 32) as u32 != owner_id);
            });
            drop_parked(workload);
        }
    });
}

fn workload_wake_fd(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let fd = WORKLOADS.with(|table| {
        table
            .borrow()
            .0
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
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let owner = WORKLOADS.with(|table| {
        table
            .borrow()
            .0
            .get(handle)
            .and_then(Option::as_ref)
            .map(|workload| workload.owner_id)
            .unwrap_or(0)
    });
    rv.set(v8::Integer::new_from_unsigned(scope, owner).into());
}

#[cfg(test)]
mod tests {
    use super::{ReadinessPriorityQueue, next_workload_owner};
    use std::collections::HashSet;

    #[test]
    fn entered_workload_wins_a_readiness_tie() {
        let mut queue = ReadinessPriorityQueue::default();
        queue.record(2);

        assert_eq!(queue.claim_higher_than(1, 1), None);
        assert_eq!(queue.pending(2), 1);
    }

    #[test]
    fn parked_workload_with_more_readiness_is_claimed() {
        let mut queue = ReadinessPriorityQueue::default();
        queue.record(2);
        queue.record(2);

        assert_eq!(queue.claim_higher_than(1, 1), Some(2));
        assert_eq!(queue.pending(2), 2);
    }

    #[test]
    fn repeated_readiness_updates_one_priority_entry() {
        let mut queue = ReadinessPriorityQueue::default();
        queue.record(7);
        queue.record(7);
        queue.record(7);

        assert_eq!(queue.queued_len(), 1);
        assert_eq!(queue.claim_higher_than(1, 0), Some(7));
        assert_eq!(queue.claim_higher_than(1, 0), None);
    }

    #[test]
    fn workload_owners_are_unique_across_threads() {
        let owners = (0..8)
            .map(|_| std::thread::spawn(next_workload_owner))
            .map(|thread| thread.join().unwrap())
            .collect::<HashSet<_>>();

        assert_eq!(owners.len(), 8);
        assert!(!owners.contains(&0));
    }
}
