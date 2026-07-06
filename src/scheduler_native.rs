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
    state::{
        FinoState, ImportDirective, ImportPattern, ImportRule, ProcessEnv, default_import_rules,
        get_state,
    },
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

struct ParkedWorkload {
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
    /// Pre-serialized `{pumpPending:true}` / `{budgetTerminated:true}` outcome
    /// bytes, computed once while the isolate is healthy. The parked path is hot
    /// (every I/O park returns it) and the terminated path runs on an isolate
    /// whose execution is being unwound — so neither can call the JS serializer.
    pending_bytes: Vec<u8>,
    terminated_bytes: Vec<u8>,
    _state: Rc<RefCell<FinoState>>,
    _module: v8::Global<v8::Module>,
    isolate: v8::OwnedIsolate,
}

struct WorkloadTable(Vec<Option<ParkedWorkload>>);

impl Drop for WorkloadTable {
    fn drop(&mut self) {
        for workload in self.0.drain(..).flatten() {
            drop_parked(workload);
        }
    }
}

thread_local! {
    static WORKLOADS: RefCell<WorkloadTable> = const { RefCell::new(WorkloadTable(Vec::new())) };
}

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "createWorkload",
        "dispatchWorkload",
        "completeHostOperation",
        "terminateWorkload",
        "workloadWakeFd",
        "sweepBudgets",
    ]
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

    set_fn!("createWorkload", create_workload);
    set_fn!("dispatchWorkload", dispatch_workload);
    set_fn!("completeHostOperation", complete_host_operation);
    set_fn!("terminateWorkload", terminate_workload);
    set_fn!("workloadWakeFd", workload_wake_fd);
    set_fn!("sweepBudgets", sweep_budgets_export);

    Some(v8::undefined(scope).into())
}

fn throw_error(scope: &mut v8::HandleScope, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let exc = v8::Exception::error(scope, msg);
    scope.throw_exception(exc);
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

fn scheduler_ops_source() -> String {
    r#"
export function readTextFile(path) {
  return globalThis.__finoSchedulerHostOp('readTextFile', { path });
}

export function writeTextFile(path, text) {
  return globalThis.__finoSchedulerHostOp('writeTextFile', { path, text });
}

export function delay(ms) {
  return globalThis.__finoSchedulerHostOp('delay', { ms });
}
"#
    .to_string()
}

fn scheduler_workload_import_rules() -> Vec<ImportRule> {
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
    rules.push(ImportRule {
        from: None,
        pattern: ImportPattern::Exact("internal:scheduler/ops".to_string()),
        directive: ImportDirective::Source {
            code: scheduler_ops_source(),
            source_map: String::new(),
        },
    });
    // Facade-owned I/O: tenant `fino:file` resolves to the scheduler-backed
    // provider, so all filesystem operations are performed by the scheduler on
    // its own loop rather than by direct FFI in the tenant isolate.
    rules.push(ImportRule {
        from: None,
        pattern: ImportPattern::Exact("fino:file".to_string()),
        directive: ImportDirective::Remap {
            target: "internal:scheduler/file-provider".to_string(),
        },
    });
    rules
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

fn setup_workload(
    entry_path: String,
    process_env: ProcessEnv,
    package_map_json: Option<String>,
    heap_limit_bytes: usize,
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

    let (context_global, dispatch_global, state_rc, module_global, pending_bytes, terminated_bytes) = {
        let isolate_scope = &mut v8::HandleScope::new(&mut isolate);
        let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(isolate_scope, Default::default());
        context.set_microtask_queue(&root_queue);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        let state = FinoState::new_root(
            process_env,
            package_map_json,
            root_queue,
            scheduler_workload_import_rules(),
        );
        context.set_slot(Rc::new(RefCell::new(state)));

        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        let runner = format!(
            "import 'internal:bootstrap';\n\
             import {{ serialize as __finoSerialize, deserialize as __finoDeserialize }} from 'internal:serializer';\n\
             const __entryPromise = import({});\n\
             globalThis.__finoSerializeOutcome = function __finoSerializeOutcome(value) {{\n\
               return __finoSerialize(value)[0];\n\
             }};\n\
             globalThis.__finoSchedulerHostOps = [];\n\
             globalThis.__finoSchedulerHostResolvers = new Map();\n\
             globalThis.__finoSchedulerNextHostOpId = 1;\n\
             globalThis.__finoSchedulerHostOp = function __finoSchedulerHostOp(operation, args) {{\n\
               const id = globalThis.__finoSchedulerNextHostOpId++;\n\
               const promise = new Promise((resolve, reject) => {{\n\
                 globalThis.__finoSchedulerHostResolvers.set(id, {{ resolve, reject }});\n\
               }});\n\
               globalThis.__finoSchedulerHostOps.push({{ id, operation, args }});\n\
               return promise;\n\
             }};\n\
             globalThis.__finoSchedulerAwait = function __finoSchedulerAwait(id) {{\n\
               return new Promise((resolve, reject) => {{\n\
                 globalThis.__finoSchedulerHostResolvers.set(id, {{ resolve, reject }});\n\
               }});\n\
             }};\n\
             globalThis.__finoSchedulerCompleteHostOp = function __finoSchedulerCompleteHostOp(id, ok, bytes) {{\n\
               const entry = globalThis.__finoSchedulerHostResolvers.get(id);\n\
               if (entry === undefined) return;\n\
               globalThis.__finoSchedulerHostResolvers.delete(id);\n\
               const value = __finoDeserialize(bytes);\n\
               if (ok) entry.resolve(value);\n\
               else entry.reject(new Error(value?.message ?? String(value)));\n\
             }};\n\
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

        // Pre-serialize the fixed park/terminate sentinels now, while the isolate
        // is healthy — the pump can't run the JS serializer on these later (the
        // parked path is hot, the terminated path is mid-unwind).
        let pending = sentinel_outcome(scope, "pumpPending");
        let pending_bytes = serialize_outcome(scope, context, pending)?;
        let terminated = sentinel_outcome(scope, "budgetTerminated");
        let terminated_bytes = serialize_outcome(scope, context, terminated)?;

        (
            v8::Global::new(scope, context),
            v8::Global::new(scope, func),
            get_state(scope),
            v8::Global::new(scope, module),
            pending_bytes,
            terminated_bytes,
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
        pending_bytes,
        terminated_bytes,
        _state: state_rc,
        _module: module_global,
    };
    unsafe {
        workload.isolate.exit();
    }
    Ok(workload)
}

fn create_workload(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let entry_path = args
        .get(0)
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if entry_path.is_empty() {
        throw_error(scope, "createWorkload: entry path is required");
        return;
    }
    let heap_limit_bytes = args.get(1).integer_value(scope).unwrap_or(0).max(0) as usize;

    let parent_state = get_state(scope);
    let process_env = parent_state.borrow().process_env.clone();
    let package_map_json = parent_state.borrow().package_map_json.clone();

    let workload = match setup_workload(entry_path, process_env, package_map_json, heap_limit_bytes)
    {
        Ok(workload) => workload,
        Err(err) => {
            throw_error(scope, &format!("createWorkload: {err}"));
            return;
        }
    };
    let handle = WORKLOADS.with(|cell| {
        let mut workloads = cell.borrow_mut();
        if let Some(index) = workloads.0.iter().position(Option::is_none) {
            workloads.0[index] = Some(workload);
            index
        } else {
            let index = workloads.0.len();
            workloads.0.push(Some(workload));
            index
        }
    });

    rv.set(v8::Integer::new(scope, handle as i32).into());
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
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();
    // Optional hard budget for this pump slice, in microseconds. Zero (the
    // default) disables the watchdog. This is the runaway-containment limit, not
    // the cooperative accounting budget the workload sees in its request.
    let hard_budget_micros = args.get(2).integer_value(scope).unwrap_or(0).max(0) as u64;

    let result = WORKLOADS.with(|cell| {
        let mut workloads = cell.borrow_mut();
        match workloads.0.get_mut(handle).and_then(Option::as_mut) {
            Some(workload) => dispatch_parked(workload, &request_json, hard_budget_micros),
            None => Err("dispatchWorkload: invalid workload handle".to_string()),
        }
    });

    match result {
        // The pump outcome crosses back as internal:serializer bytes (a
        // structured clone), so host-op args carrying binary — a tenant's
        // `writeFile(path, bytes)` — travel as bytes rather than base64'd JSON.
        Ok(bytes) => {
            let backing = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
            let array_buffer = v8::ArrayBuffer::with_backing_store(scope, &backing);
            let len = array_buffer.byte_length();
            match v8::Uint8Array::new(scope, array_buffer, 0, len) {
                Some(value) => rv.set(value.into()),
                // Match the completion path: surface allocation failure as a throw
                // rather than silently returning `undefined` (which the shard would
                // then try to `deserialize`, throwing with no useful context).
                None => throw_error(scope, "dispatchWorkload: failed to allocate outcome bytes"),
            }
        }
        Err(err) => throw_error(scope, &err),
    }
}

fn dispatch_parked(
    workload: &mut ParkedWorkload,
    request_json: &str,
    hard_budget_micros: u64,
) -> Result<Vec<u8>, String> {
    // Arm the budget deadline before entering: if this synchronous pump slice
    // overruns its hard budget, the orchestrator's budget-watchdog service (via
    // `sweep_budgets`) terminates the isolate's execution from its own thread.
    // Armed only across the synchronous pump, never across an I/O park, so a
    // workload waiting on facade I/O is never charged for it.
    let budgeted = hard_budget_micros > 0;
    if budgeted {
        // Guard against an absurd budget overflowing the platform `Instant`
        // (which would panic); a deadline that far out is effectively "never".
        let now = Instant::now();
        let deadline = now
            .checked_add(Duration::from_micros(hard_budget_micros))
            .unwrap_or_else(|| now + Duration::from_secs(24 * 60 * 60));
        arm_budget(workload.budget_token, deadline);
    }
    // Swap this isolate's async state into the thread-local so any FFI
    // completions, executor tasks, and wake-pipe traffic during the pump belong
    // to this isolate — not the scheduler's own isolate or a sibling tenant.
    let saved = crate::async_rt::swap_state(workload.async_state.take());
    unsafe {
        workload.isolate.enter();
    }
    let result = dispatch_entered_parked(workload, request_json);
    unsafe {
        workload.isolate.exit();
    }
    workload.async_state = crate::async_rt::swap_state(saved);
    if budgeted {
        // Clear the deadline first so no further sweep can fire, then
        // unconditionally cancel any pending termination. `terminate_execution`
        // posts a stack-guard interrupt bit that persists until execution
        // consumes it or it is cancelled; a sweep that fires in the race window
        // *after* the pump has exited terminates an idle isolate, for which
        // `is_execution_terminating()` reads false (no JS frames on the stack) —
        // so gating the cancel on it would leak the interrupt onto the next
        // dispatch and spuriously kill an innocent workload. `cancel` is a safe
        // no-op when nothing is pending, so always call it.
        clear_budget(workload.budget_token);
        workload.thread_handle.cancel_terminate_execution();
    }
    result
}

fn dispatch_entered_parked(
    workload: &mut ParkedWorkload,
    request_json: &str,
) -> Result<Vec<u8>, String> {
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &workload.context);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);

    if workload.active_promise.is_none() {
        let func = v8::Local::new(scope, &workload.dispatch_fn);
        let arg = v8::String::new(scope, request_json)
            .ok_or_else(|| "failed to allocate request".to_string())?;
        let undef: v8::Local<v8::Value> = v8::undefined(scope).into();

        let value = {
            let tc = &mut v8::TryCatch::new(scope);
            match func.call(tc, undef, &[arg.into()]) {
                Some(value) => value,
                None => {
                    // A terminated (uncatchable) exception means the watchdog
                    // hard-cancelled a synchronous runaway, not an ordinary throw.
                    if tc.has_terminated() {
                        workload.active_promise = None;
                        return Ok(workload.terminated_bytes.clone());
                    }
                    return Err(crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "scheduler workload dispatch threw".to_string()));
                }
            }
        };

        if let Ok(promise) = v8::Local::<v8::Promise>::try_from(value) {
            workload.active_promise = Some(v8::Global::new(scope, promise));
        } else {
            // A synchronous (non-Promise) return settles immediately; disarm the
            // budget before serializing so the outcome isn't charged/terminated.
            clear_budget(workload.budget_token);
            return serialize_outcome(scope, context, value);
        }
    }

    // Run to quiescence — a single fixed-point pump that drains all ready
    // microtasks, executor tasks, and FFI completions, then returns. It does not
    // block waiting for external I/O.
    crate::realm::child::pump_and_checkpoint(scope);

    // Disarm the hard budget now: the pump is the only tenant code this slice,
    // so nothing after it (reading the promise, serializing the outcome) should
    // be charged. Clearing the deadline also stops a watchdog sweep from firing
    // during the outcome serialization below — which would make the serializer
    // call return `None` and misreport a completed result as an error.
    clear_budget(workload.budget_token);

    // If the watchdog terminated a runaway during the pump, surface it as a
    // hard-cancel rather than reading a half-settled promise.
    if scope.is_execution_terminating() {
        workload.active_promise = None;
        return Ok(workload.terminated_bytes.clone());
    }

    // A host operation requested during the pump takes priority: the scheduler
    // performs it and calls back through `completeHostOperation`. The capture is
    // transactional — the ops leave the isolate's queue only once serialized.
    if let Some(host_op) = take_host_operation(scope, context) {
        return host_op;
    }

    let promise_global = workload.active_promise.as_ref().unwrap();
    let promise = v8::Local::new(scope, promise_global);
    match promise.state() {
        v8::PromiseState::Fulfilled => {
            let result = promise.result(scope);
            workload.active_promise = None;
            serialize_outcome(scope, context, result)
        }
        v8::PromiseState::Rejected => {
            let result = promise.result(scope);
            workload.active_promise = None;
            Err(js_string(scope, result))
        }
        // Parked on external I/O (facade op / async FFI / injected completion).
        // Return control to the scheduler, which re-pumps when the isolate's
        // wake pipe signals a completion. No sleeping, no spinning.
        v8::PromiseState::Pending => Ok(workload.pending_bytes.clone()),
    }
}

/// Build a `{ <flag>: true }` control object — the pump's parked/terminated
/// sentinels the scheduler branches on (`pumpPending`, `budgetTerminated`). These
/// travel back inside the serialized outcome rather than as JSON strings.
fn sentinel_outcome<'s>(scope: &mut v8::HandleScope<'s>, flag: &str) -> v8::Local<'s, v8::Value> {
    let obj = v8::Object::new(scope);
    if let Some(key) = v8::String::new(scope, flag) {
        let value = v8::Boolean::new(scope, true);
        obj.set(scope, key.into(), value.into());
    }
    obj.into()
}

/// Serialize a pump-outcome value with `internal:serializer` (via the runner's
/// `__finoSerializeOutcome`), so the outcome — including any host-op args that
/// carry binary — crosses back to the scheduler as structured-clone bytes with
/// no JSON/base64 round trip.
fn serialize_outcome(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
    value: v8::Local<v8::Value>,
) -> Result<Vec<u8>, String> {
    let key = v8::String::new(scope, "__finoSerializeOutcome")
        .ok_or_else(|| "failed to allocate serializer key".to_string())?;
    let func_value = context
        .global(scope)
        .get(scope, key.into())
        .ok_or_else(|| "scheduler outcome serializer missing".to_string())?;
    let func = v8::Local::<v8::Function>::try_from(func_value)
        .map_err(|_| "scheduler outcome serializer is not a function".to_string())?;
    let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
    let result = {
        let tc = &mut v8::TryCatch::new(scope);
        func.call(tc, undef, &[value]).ok_or_else(|| {
            crate::realm::child::catch_message(tc)
                .unwrap_or_else(|| "scheduler outcome serialization threw".to_string())
        })?
    };
    let view = v8::Local::<v8::ArrayBufferView>::try_from(result)
        .map_err(|_| "scheduler outcome serializer did not return bytes".to_string())?;
    let mut buf = vec![0u8; view.byte_length()];
    view.copy_contents(&mut buf);
    Ok(buf)
}

/// Drain every operation a workload queued this pump into a serialized envelope,
/// so a tenant's concurrent facade calls (e.g. `Promise.all([read(a), read(b)])`)
/// are performed in parallel by the scheduler rather than one per pump cycle.
///
/// The capture is transactional: the ops are serialized *before* they are removed
/// from `__finoSchedulerHostOps`. If serialization fails, the ops stay queued and
/// are re-taken next pump — never lost. Dropping them would silently orphan the
/// tenant promises still awaiting them (an unrecoverable hang). Returns `None`
/// when nothing is queued, `Some(Ok(bytes))` on a captured+serialized batch, and
/// `Some(Err(_))` when serialization failed (surfaced to the caller as a throw).
fn take_host_operation(
    scope: &mut v8::HandleScope,
    context: v8::Local<v8::Context>,
) -> Option<Result<Vec<u8>, String>> {
    let key = v8::String::new(scope, "__finoSchedulerHostOps")?;
    let global = context.global(scope);
    let ops_value = global.get(scope, key.into())?;
    let ops = v8::Local::<v8::Array>::try_from(ops_value).ok()?;
    if ops.length() == 0 {
        return None;
    }
    let envelope = v8::Object::new(scope);
    let ops_key = v8::String::new(scope, "hostOperations")?;
    envelope.set(scope, ops_key.into(), ops.into())?;
    // Serialize the still-queued ops first; only on success swap in a fresh queue
    // so subsequent ops accumulate separately. A failed serialize leaves the ops
    // in place to be retaken, rather than orphaning their tenant promises.
    let bytes = match serialize_outcome(scope, context, envelope.into()) {
        Ok(bytes) => bytes,
        Err(err) => return Some(Err(err)),
    };
    let fresh = v8::Array::new(scope, 0);
    global.set(scope, key.into(), fresh.into())?;
    Some(Ok(bytes))
}

fn complete_entered_host_operation(
    workload: &mut ParkedWorkload,
    operation_id: i64,
    ok: bool,
    payload_bytes: &[u8],
) -> Result<(), String> {
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &workload.context);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    let key = v8::String::new(scope, "__finoSchedulerCompleteHostOp").unwrap();
    let value = context
        .global(scope)
        .get(scope, key.into())
        .ok_or_else(|| "scheduler host operation completion function missing".to_string())?;
    let func = v8::Local::<v8::Function>::try_from(value)
        .map_err(|_| "scheduler host operation completion is not a function".to_string())?;
    // Host-op ids can exceed i32 over a long-lived isolate; JS uses f64 keys, so
    // pass a Number rather than truncating to a 32-bit Integer.
    let id = v8::Number::new(scope, operation_id as f64);
    let ok_value = v8::Boolean::new(scope, ok);
    // The result is structured-clone bytes (internal:serializer) rather than a
    // JSON string, so binary payloads (file bytes) cross without base64. Copy the
    // bytes into a fresh Uint8Array in the workload isolate.
    let backing = v8::ArrayBuffer::new_backing_store_from_vec(payload_bytes.to_vec()).make_shared();
    let array_buffer = v8::ArrayBuffer::with_backing_store(scope, &backing);
    let payload = v8::Uint8Array::new(scope, array_buffer, 0, payload_bytes.len())
        .ok_or_else(|| "failed to allocate host operation payload".to_string())?;
    let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
    {
        let tc = &mut v8::TryCatch::new(scope);
        if func
            .call(tc, undef, &[id.into(), ok_value.into(), payload.into()])
            .is_none()
        {
            return Err(crate::realm::child::catch_message(tc)
                .unwrap_or_else(|| "scheduler host operation completion threw".to_string()));
        }
    }
    crate::realm::child::pump_and_checkpoint(scope);
    Ok(())
}

fn complete_parked_host_operation(
    workload: &mut ParkedWorkload,
    operation_id: i64,
    ok: bool,
    payload_bytes: &[u8],
) -> Result<(), String> {
    let saved = crate::async_rt::swap_state(workload.async_state.take());
    unsafe {
        workload.isolate.enter();
    }
    let result = complete_entered_host_operation(workload, operation_id, ok, payload_bytes);
    unsafe {
        workload.isolate.exit();
    }
    workload.async_state = crate::async_rt::swap_state(saved);
    result
}

fn complete_host_operation(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let operation_id = args.get(1).integer_value(scope).unwrap_or(-1);
    let ok = args.get(2).boolean_value(scope);
    // The payload is internal:serializer bytes (a Uint8Array) rather than a JSON
    // string; capture its contents to hand to the workload isolate.
    let payload_bytes = match v8::Local::<v8::ArrayBufferView>::try_from(args.get(3)) {
        Ok(view) => {
            let mut buf = vec![0u8; view.byte_length()];
            view.copy_contents(&mut buf);
            buf
        }
        Err(_) => Vec::new(),
    };

    let result = WORKLOADS.with(|cell| {
        let mut workloads = cell.borrow_mut();
        match workloads.0.get_mut(handle).and_then(Option::as_mut) {
            Some(workload) => {
                complete_parked_host_operation(workload, operation_id, ok, &payload_bytes)
            }
            None => Err("completeHostOperation: invalid workload handle".to_string()),
        }
    });
    if let Err(err) = result {
        throw_error(scope, &err);
    }
}

fn drop_parked(mut workload: ParkedWorkload) {
    unregister_budget_target(workload.budget_token);
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
    WORKLOADS.with(|cell| {
        let mut workloads = cell.borrow_mut();
        if let Some(workload) = workloads.0.get_mut(handle).and_then(Option::take) {
            drop_parked(workload);
        }
    });
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

/// Read end of a workload isolate's wake pipe. The scheduler registers this fd
/// on its own event loop (via `loop.readable`) so a background FFI completion
/// for this isolate wakes the scheduler, which then re-pumps exactly this
/// isolate. Returns -1 for an invalid handle.
fn workload_wake_fd(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let fd = WORKLOADS.with(|cell| {
        cell.borrow()
            .0
            .get(handle)
            .and_then(Option::as_ref)
            .and_then(|w| w.async_state.as_ref())
            .map(|st| st.wake_read)
            .unwrap_or(-1)
    });
    rv.set(v8::Integer::new(scope, fd).into());
}
