//! `internal:scheduler-native` — parked workload isolates for scheduler shards.

use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use crate::{
    loader,
    state::{FinoState, ImportRule, ProcessEnv, get_state},
};

/// Process-global registry of budget targets, keyed by an opaque token.
///
/// A tenant isolate is pumped synchronously on its scheduler thread; an
/// unbounded synchronous loop in tenant code would otherwise block that thread
/// forever, and only V8 `terminate_execution` fired from *another* thread can
/// break it. This registry is the minimal native glue that makes that possible:
/// it holds each workload's thread-safe `IsolateHandle` and its currently-armed
/// pump deadline (if any). The scheduler thread arms a deadline just before a
/// synchronous pump and clears it just after (cheap, in-process, no messaging).
///
/// The *policy* — when to check, how often, what to do — lives in the TypeScript
/// budget-watchdog system service on the orchestrator thread. It drives this
/// registry through {@link sweep_budgets}, which terminates every workload whose
/// deadline has elapsed. No native thread and no per-pump cross-thread traffic.
struct BudgetTarget {
    handle: v8::IsolateHandle,
    /// Deadline for the in-progress synchronous pump slice, or `None` when the
    /// workload is idle or waiting on I/O (and so must never be terminated).
    deadline: Option<Instant>,
}

fn budget_registry() -> &'static Mutex<HashMap<u64, BudgetTarget>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, BudgetTarget>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lock the process-global budget registry, tolerating poisoning. The registry
/// holds only plain data (`IsolateHandle` + deadline), so a panic that poisoned
/// it while held cannot have left a torn invariant worth propagating — recover
/// the guard instead of unwrapping, so a single failure on one scheduler thread
/// cannot cascade into every `arm`/`clear`/`sweep` on all threads panicking.
fn lock_registry() -> std::sync::MutexGuard<'static, HashMap<u64, BudgetTarget>> {
    budget_registry().lock().unwrap_or_else(|e| e.into_inner())
}

fn next_budget_token() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Register a workload's isolate as a budget target and return its token.
fn register_budget_target(handle: v8::IsolateHandle) -> u64 {
    let token = next_budget_token();
    lock_registry().insert(
        token,
        BudgetTarget {
            handle,
            deadline: None,
        },
    );
    token
}

fn unregister_budget_target(token: u64) {
    lock_registry().remove(&token);
}

fn arm_budget(token: u64, deadline: Instant) {
    if let Some(target) = lock_registry().get_mut(&token) {
        target.deadline = Some(deadline);
    }
}

fn clear_budget(token: u64) {
    if let Some(target) = lock_registry().get_mut(&token) {
        target.deadline = None;
    }
}

/// Terminate the execution of every workload whose armed pump deadline has
/// elapsed, and return how many were terminated. Called by the TypeScript
/// budget-watchdog service on the orchestrator thread; safe to call from any
/// thread because `terminate_execution` is thread-safe.
fn sweep_budgets() -> u32 {
    let now = Instant::now();
    let mut fired = 0;
    let mut registry = lock_registry();
    for target in registry.values_mut() {
        if let Some(deadline) = target.deadline
            && deadline <= now
        {
            target.handle.terminate_execution();
            target.deadline = None;
            fired += 1;
        }
    }
    fired
}

pub(crate) struct ParkedWorkload {
    context: v8::Global<v8::Context>,
    dispatch_fn: v8::Global<v8::Function>,
    active_promise: Option<v8::Global<v8::Promise>>,
    /// This isolate's own async state (executor + FFI-completion queue + wake
    /// pipe). Swapped into the thread-local around every enter/pump so the
    /// isolate's async work never mixes with the scheduler's own isolate or
    /// sibling tenant isolates on the same thread.
    async_state: Option<crate::async_rt::IsolateAsyncState>,
    /// Thread-safe handle to this isolate. Used locally to clear a stray
    /// termination flag after a budget kill; the budget registry holds a clone
    /// for the watchdog to terminate with. Cheap `Arc` clone; safe post-dispose.
    thread_handle: v8::IsolateHandle,
    /// This workload's key in the process-global budget registry.
    budget_token: u64,
    _state: Rc<RefCell<FinoState>>,
    _module: v8::Global<v8::Module>,
    isolate: v8::OwnedIsolate,
}

impl ParkedWorkload {
    /// Route this isolate's background wakes (FFI completions, callback
    /// trampolines, view releases) into a reactor as Notifier posts tagged
    /// `user_data`. First install wins; returns false if already claimed.
    pub(crate) fn install_wake_notifier(
        &self,
        notifier: cherenkov::Notifier,
        user_data: u64,
    ) -> bool {
        self.async_state
            .as_ref()
            .map(|st| st.wake_sink.install_notifier(notifier, user_data))
            .unwrap_or(false)
    }
}

/// The classified result of pumping a workload one slice, returned by
/// `pump_native` for the reactor engine to route (release / park / re-run).
pub(crate) enum PumpOutcome {
    /// The activation settled: `result` is the tenant's `result` field
    /// (`idle`/`terminated`/…) and `cost_micros` its self-reported CPU cost.
    Settled { result: String, cost_micros: f64 },
    /// Still awaiting outstanding async work; the isolate stays parked.
    Pending,
    /// Execution was terminated (budget kill or heap-limit containment).
    Terminated,
    /// The activation rejected; the string carries the error message.
    Rejected(String),
}

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    // Only `sweepBudgets` remains: the reactor engine drives isolate execution
    // through `setup_workload`/`pump_native` in Rust directly, so the old
    // TS-facing workload ops (createWorkload/dispatchWorkload/…) are gone. The
    // budget watchdog still sweeps runaway isolates through this export.
    let export_names: Vec<v8::Local<v8::String>> = ["sweepBudgets"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
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
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }

    set_fn!("sweepBudgets", sweep_budgets_export);

    Some(v8::undefined(scope).into())
}

fn js_string(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> String {
    value
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "unknown exception".to_string())
}

fn json_quote(input: &str) -> String {
    serde_json::to_string(input).unwrap_or_else(|_| "\"\"".to_string())
}

/// Default per-workload old-generation heap cap when the caller does not set one.
const DEFAULT_HEAP_LIMIT_BYTES: usize = 1 << 30;

/// Fired by V8 when a workload's heap nears its cap. Terminates the offending
/// isolate (contained the same way a runaway is) and bumps the limit just enough
/// that the current GC can finish before the termination lands at the next
/// safepoint — returning `current` unchanged would OOM the whole process.
unsafe extern "C" fn heap_limit_callback(
    data: *mut std::ffi::c_void,
    current: usize,
    _initial: usize,
) -> usize {
    let token = data as usize as u64;
    if let Some(target) = lock_registry().get(&token) {
        target.handle.terminate_execution();
    }
    current + (current / 2).max(16 * 1024 * 1024)
}

pub(crate) fn setup_workload(
    entry_path: String,
    process_env: ProcessEnv,
    package_map_json: Option<String>,
    heap_limit_bytes: usize,
    import_rules: Vec<ImportRule>,
) -> Result<ParkedWorkload, String> {
    crate::runtime::init_v8();

    let heap_limit = if heap_limit_bytes == 0 {
        DEFAULT_HEAP_LIMIT_BYTES
    } else {
        heap_limit_bytes
    };
    let mut params = v8::CreateParams::default();
    params = params.heap_limits(0, heap_limit);
    params = params.array_buffer_allocator(crate::runtime::shared_allocator().clone());

    let mut isolate = v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    let (context_global, dispatch_global, state_rc, module_global) = {
        let isolate_scope = &mut v8::HandleScope::new(&mut isolate);
        let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(isolate_scope, Default::default());
        context.set_microtask_queue(&root_queue);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        let state = FinoState::new_root(process_env, package_map_json, root_queue, import_rules);
        context.set_slot(Rc::new(RefCell::new(state)));

        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        let runner = format!(
            "import 'internal:bootstrap';\n\
             const __entryPromise = import({});\n\
             globalThis.__finoSchedulerDispatch = async function __finoSchedulerDispatch(json) {{\n\
               const __entry = await __entryPromise;\n\
               const __target = __entry.default;\n\
               if (typeof __target !== 'function') throw new Error('scheduler workload entry must default-export a function');\n\
               return await __target(JSON.parse(json));\n\
             }};\n",
            json_quote(&entry_path)
        );

        let module = {
            let tc = &mut v8::TryCatch::new(scope);
            match loader::compile_source_module(tc, &runner, "internal:scheduler-workload", None) {
                Some(m) => m,
                None => {
                    return Err(crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to compile scheduler workload".to_string()));
                }
            }
        };
        loader::register_as_builtin(scope, module, "internal:scheduler-workload");

        {
            let tc = &mut v8::TryCatch::new(scope);
            if module
                .instantiate_module(tc, loader::resolve_module_callback)
                .is_none()
            {
                return Err(crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to instantiate scheduler workload".to_string()));
            }
        }
        {
            let tc = &mut v8::TryCatch::new(scope);
            if module.evaluate(tc).is_none() {
                return Err(crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to evaluate scheduler workload".to_string()));
            }
        }
        crate::realm::child::pump_and_checkpoint(scope);

        if module.get_status() == v8::ModuleStatus::Errored {
            let exc = module.get_exception();
            return Err(js_string(scope, exc));
        }

        let key = v8::String::new(scope, "__finoSchedulerDispatch").unwrap();
        let value = context
            .global(scope)
            .get(scope, key.into())
            .ok_or_else(|| "scheduler workload dispatch function missing".to_string())?;
        let func = v8::Local::<v8::Function>::try_from(value)
            .map_err(|_| "scheduler workload dispatch is not a function".to_string())?;

        (
            v8::Global::new(scope, context),
            v8::Global::new(scope, func),
            get_state(scope),
            v8::Global::new(scope, module),
        )
    };

    let thread_handle = isolate.thread_safe_handle();
    let budget_token = register_budget_target(thread_handle.clone());
    // Contain per-tenant heap growth: when this isolate nears its cap, the
    // callback terminates it (keyed by its budget token) rather than OOMing the
    // process.
    isolate
        .add_near_heap_limit_callback(heap_limit_callback, budget_token as *mut std::ffi::c_void);
    let mut workload = ParkedWorkload {
        isolate,
        context: context_global,
        dispatch_fn: dispatch_global,
        active_promise: None,
        async_state: Some(crate::async_rt::new_state()),
        thread_handle,
        budget_token,
        _state: state_rc,
        _module: module_global,
    };
    unsafe {
        workload.isolate.exit();
    }
    Ok(workload)
}

/// Pump an entered/parked workload one slice and classify the outcome natively.
/// This is the engine's equivalent of `dispatch_parked` + `dispatch_entered_parked`,
/// but returns a `PumpOutcome` enum (no serialization, no host-op capture — engine
/// tenants do direct I/O). `request_json` is the dispatch argument for a fresh
/// activation (ignored while an `active_promise` is in flight).
pub(crate) fn pump_native(
    workload: &mut ParkedWorkload,
    request_json: &str,
    hard_budget_micros: u64,
    io_completions: &[(usize, f64)],
) -> PumpOutcome {
    let budgeted = hard_budget_micros > 0;
    if budgeted {
        let now = Instant::now();
        let deadline = now
            .checked_add(Duration::from_micros(hard_budget_micros))
            .unwrap_or_else(|| now + Duration::from_secs(24 * 60 * 60));
        arm_budget(workload.budget_token, deadline);
    }
    let saved = crate::async_rt::swap_state(workload.async_state.take());
    unsafe {
        workload.isolate.enter();
    }
    let outcome = pump_entered_native(workload, request_json, io_completions);
    unsafe {
        workload.isolate.exit();
    }
    workload.async_state = crate::async_rt::swap_state(saved);
    if budgeted {
        clear_budget(workload.budget_token);
        workload.thread_handle.cancel_terminate_execution();
    }
    outcome
}

/// Drive a `{drain:true}` dispatch to completion and return the tenant's
/// serialized migration snapshot — the JSON of the settled value's `mailbox`
/// field. Used by the reactor engine when handing a live workload to another
/// thread: the tenant's drain path returns `{result:'drained', mailbox:[...]}`,
/// and that mailbox JSON is what the destination replays as `request.handoff`.
/// Returns `None` if the workload doesn't settle with a mailbox.
pub(crate) fn pump_drain_native(
    workload: &mut ParkedWorkload,
    request_json: &str,
    hard_budget_micros: u64,
) -> Option<String> {
    let budgeted = hard_budget_micros > 0;
    if budgeted {
        let now = Instant::now();
        let deadline = now
            .checked_add(Duration::from_micros(hard_budget_micros))
            .unwrap_or_else(|| now + Duration::from_secs(24 * 60 * 60));
        arm_budget(workload.budget_token, deadline);
    }
    let saved = crate::async_rt::swap_state(workload.async_state.take());
    unsafe {
        workload.isolate.enter();
    }
    let snapshot = drain_entered(workload, request_json);
    unsafe {
        workload.isolate.exit();
    }
    workload.async_state = crate::async_rt::swap_state(saved);
    if budgeted {
        clear_budget(workload.budget_token);
        workload.thread_handle.cancel_terminate_execution();
    }
    snapshot
}

fn drain_entered(workload: &mut ParkedWorkload, request_json: &str) -> Option<String> {
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &workload.context);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);

    // Fresh dispatch of `{drain:true}` — the drain path never awaits I/O.
    let func = v8::Local::new(scope, &workload.dispatch_fn);
    let arg = v8::String::new(scope, request_json)?;
    let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
    let value = {
        let tc = &mut v8::TryCatch::new(scope);
        func.call(tc, undef, &[arg.into()])?
    };
    let settled = if let Ok(promise) = v8::Local::<v8::Promise>::try_from(value) {
        crate::realm::child::pump_and_checkpoint(scope);
        clear_budget(workload.budget_token);
        if promise.state() != v8::PromiseState::Fulfilled {
            return None;
        }
        promise.result(scope)
    } else {
        clear_budget(workload.budget_token);
        value
    };

    // Extract the `mailbox` field and JSON-encode it as the snapshot.
    let obj = v8::Local::<v8::Object>::try_from(settled).ok()?;
    let key = v8::String::new(scope, "mailbox")?;
    let mailbox = obj.get(scope, key.into())?;
    let json = v8::json::stringify(scope, mailbox)?;
    Some(json.to_rust_string_lossy(scope))
}

fn read_dispatch_result(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> (String, f64) {
    let mut result = "idle".to_string();
    let mut cost = 0.0;
    if let Ok(obj) = v8::Local::<v8::Object>::try_from(value) {
        if let Some(key) = v8::String::new(scope, "result")
            && let Some(v) = obj.get(scope, key.into())
            && v.is_string()
        {
            result = v.to_rust_string_lossy(scope);
        }
        if let Some(key) = v8::String::new(scope, "costMicros")
            && let Some(v) = obj.get(scope, key.into())
        {
            cost = v.number_value(scope).unwrap_or(0.0);
        }
    }
    (result, cost)
}

fn pump_entered_native(
    workload: &mut ParkedWorkload,
    request_json: &str,
    io_completions: &[(usize, f64)],
) -> PumpOutcome {
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &workload.context);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);

    // Resolve any reactor I/O completions that landed while this isolate was
    // parked, before pumping — so the promises the tenant awaited are settled and
    // their continuations run in the fixed-point pump below. Only meaningful once
    // an activation is in flight (I/O can't be outstanding before the first pump).
    if workload.active_promise.is_some() {
        for &(resolver_id, result) in io_completions {
            crate::async_rt::resolve_io_completion(scope, resolver_id, result);
        }
    }

    if workload.active_promise.is_none() {
        let func = v8::Local::new(scope, &workload.dispatch_fn);
        let arg = match v8::String::new(scope, request_json) {
            Some(s) => s,
            None => return PumpOutcome::Rejected("failed to allocate request".to_string()),
        };
        let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
        let value = {
            let tc = &mut v8::TryCatch::new(scope);
            match func.call(tc, undef, &[arg.into()]) {
                Some(value) => value,
                None => {
                    if tc.has_terminated() {
                        workload.active_promise = None;
                        return PumpOutcome::Terminated;
                    }
                    return PumpOutcome::Rejected(
                        crate::realm::child::catch_message(tc)
                            .unwrap_or_else(|| "workload dispatch threw".to_string()),
                    );
                }
            }
        };
        if let Ok(promise) = v8::Local::<v8::Promise>::try_from(value) {
            workload.active_promise = Some(v8::Global::new(scope, promise));
        } else {
            clear_budget(workload.budget_token);
            let (result, cost_micros) = read_dispatch_result(scope, value);
            return PumpOutcome::Settled {
                result,
                cost_micros,
            };
        }
    }

    crate::realm::child::pump_and_checkpoint(scope);
    clear_budget(workload.budget_token);

    if scope.is_execution_terminating() {
        workload.active_promise = None;
        return PumpOutcome::Terminated;
    }

    let promise_global = workload.active_promise.as_ref().unwrap();
    let promise = v8::Local::new(scope, promise_global);
    match promise.state() {
        v8::PromiseState::Fulfilled => {
            let result_value = promise.result(scope);
            workload.active_promise = None;
            let (result, cost_micros) = read_dispatch_result(scope, result_value);
            PumpOutcome::Settled {
                result,
                cost_micros,
            }
        }
        v8::PromiseState::Rejected => {
            let result_value = promise.result(scope);
            workload.active_promise = None;
            PumpOutcome::Rejected(js_string(scope, result_value))
        }
        v8::PromiseState::Pending => PumpOutcome::Pending,
    }
}

pub(crate) fn drop_parked(mut workload: ParkedWorkload) {
    // Unregister from the budget registry BEFORE disposing the isolate. A
    // concurrent `sweep_budgets` on the watchdog thread holds the registry lock
    // while it calls `terminate_execution`; unregistering under that same lock
    // guarantees the sweep either terminates a still-live isolate or finds the
    // entry already gone — never terminates one mid-dispose. This ordering is
    // load-bearing (it also keeps the near-heap-limit callback, keyed by the same
    // token, from firing on a freed isolate).
    unregister_budget_target(workload.budget_token);
    // `Isolate::new` leaves the isolate entered on the creating thread and
    // `setup_workload` exits it once; `OwnedIsolate::drop` must run from the
    // entered state to exit + dispose cleanly, so re-enter before dropping.
    unsafe {
        workload.isolate.enter();
    }
    drop(workload);
}

/// `sweepBudgets()` — terminate every workload whose armed pump deadline has
/// elapsed and return the count. Driven by the TypeScript budget-watchdog
/// service on the orchestrator thread.
fn sweep_budgets_export(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let fired = sweep_budgets();
    rv.set(v8::Integer::new(scope, fired as i32).into());
}
