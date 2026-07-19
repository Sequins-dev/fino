//! Reactor-owned V8 workload lifecycle and execution-budget containment.
//!
//! This module constructs, enters, pumps, parks, moves, and disposes isolates.
//! Scheduling policy and reactor-thread control live in [`super::engine`]; I/O
//! ownership and Cherenkov integration live in [`super::io`].

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
/// A realm isolate is pumped synchronously on its reactor thread; an
/// unbounded synchronous loop in realm code would otherwise block that thread
/// forever, and only V8 `terminate_execution` fired from *another* thread can
/// break it. This registry is the minimal native glue that makes that possible:
/// it holds each workload's thread-safe `IsolateHandle` and its currently-armed
/// pump deadline (if any). The reactor thread arms a deadline just before a
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
    /// Containment fired (budget sweep or heap-limit callback). The pump
    /// classifies the slice as Terminated from this — V8 delivers and
    /// auto-cancels a termination that lands inside a microtask checkpoint,
    /// so the terminating flag is not observable afterwards.
    killed: bool,
}

fn budget_registry() -> &'static Mutex<HashMap<u64, BudgetTarget>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, BudgetTarget>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lock the process-global budget registry, tolerating poisoning. The registry
/// holds only plain data (`IsolateHandle` + deadline), so a panic that poisoned
/// it while held cannot have left a torn invariant worth propagating — recover
/// the guard instead of unwrapping, so a single failure on one reactor thread
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
            killed: false,
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

/// Whether containment killed this workload since the last check (consumed).
fn take_killed(token: u64) -> bool {
    lock_registry()
        .get_mut(&token)
        .map(|t| std::mem::take(&mut t.killed))
        .unwrap_or(false)
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
            target.killed = true;
            fired += 1;
        }
    }
    fired
}

pub(crate) struct ParkedWorkload {
    context: v8::Global<v8::Context>,
    /// This isolate's own async state (executor + FFI-completion queue + wake
    /// pipe). Swapped into the thread-local around every enter/pump so the
    /// isolate's async work never mixes with the orchestrator's isolate or
    /// sibling realm isolates on the same thread.
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
    /// Set after the isolate crosses an OS-thread boundary. Subsequent entries
    /// use V8's Locker to signal and serialize thread ownership.
    moved_between_threads: bool,
}

/// Thread-local ownership retained while a reactor keeps one workload entered.
/// Pump-local V8 scopes are still created and dropped for every slice; this
/// token owns only the cross-slice async-state swap and optional V8 lock.
pub(crate) struct ActiveWorkload {
    saved_async_state: Option<crate::async_rt::IsolateAsyncState>,
    _locker: Option<crate::v8_threading::IsolateLocker>,
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

    pub(crate) fn mark_moved_between_threads(&mut self) {
        self.moved_between_threads = true;
    }

    /// Return the thread-affine facility that currently prevents a live move.
    pub(crate) fn move_blocker(&self) -> Option<&'static str> {
        let state = self._state.borrow();
        if state.cpu_profiler.is_some() {
            return Some("cpu-profiler-active");
        }
        if state.inspector_state.is_some() {
            return Some("inspector-active");
        }
        None
    }
}

/// The classified result of pumping a workload one slice, returned by
/// `pump_realm_native` for the reactor engine to route (release / park / re-run).
pub(crate) enum PumpOutcome {
    /// The realm ran to completion; `result` describes how it exited.
    Settled { result: String },
    /// Still awaiting outstanding async work; the isolate stays parked.
    Pending,
    /// V8 has work that does not provide a Cherenkov wake source (currently
    /// Atomics.waitAsync), so the engine must perform a bounded re-pump.
    PendingPoll,
    /// Execution was terminated (budget kill or heap-limit containment).
    Terminated,
    /// The activation rejected; the string carries the error message.
    Rejected(String),
}

/// A Cherenkov completion routed back to the isolate that owns its JS state.
pub(crate) enum ReactorEvent {
    Resolve {
        resolver_id: usize,
        result: f64,
    },
    Callback {
        callback_id: usize,
        fflags: Option<u32>,
    },
}

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    // Only `sweepBudgets` remains: the reactor engine drives isolate execution
    // through `setup_realm_workload`/`pump_realm_native` in Rust directly, so
    // the old TS-facing workload ops (createWorkload/dispatchWorkload/…) are
    // gone. The budget watchdog still sweeps runaway isolates through this
    // export.
    let export_names: Vec<v8::Local<v8::String>> = ["sweepBudgets"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();

    let module_name = v8::String::new(scope, "internal:reactor/workload").unwrap();
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
    if let Some(target) = lock_registry().get_mut(&token) {
        target.handle.terminate_execution();
        target.killed = true;
    }
    current + (current / 2).max(16 * 1024 * 1024)
}

/// Construct a REALM workload: a full child realm (uniform bootstrap, port
/// channel, import-rule inheritance, entry auto-import) hosted as a parked
/// isolate on an engine thread. The realm's `driveLoop` registers native
/// hooks at bootstrap; `pump_realm_native` drives them per slice. This is
/// the same bootstrap used by the process-isolated host; placement and IPC are
/// the only differences.
#[allow(clippy::too_many_arguments)]
pub(crate) fn setup_realm_workload(
    entry_path: String,
    process_env: ProcessEnv,
    package_map_json: Option<String>,
    heap_limit_bytes: usize,
    import_rules: Vec<ImportRule>,
    realm_data: Option<String>,
    realm_bootstrap_data: Option<String>,
    watch_mode: bool,
    repl_mode: bool,
    port_half: (u32, i32),
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

    // Containment must cover setup too: the full bootstrap is a real heap
    // load, and nearing the cap without a callback is a process-fatal OOM
    // (or a GC thrash that freezes the whole shard).
    let thread_handle = isolate.thread_safe_handle();
    let budget_token = register_budget_target(thread_handle.clone());
    isolate
        .add_near_heap_limit_callback(heap_limit_callback, budget_token as *mut std::ffi::c_void);

    // The realm's bootstrap starts its entry import during evaluation —
    // FFI callbacks, async calls, and the wake pipe must find THIS
    // workload's async state, not whatever the engine thread had.
    let async_state = crate::async_rt::new_state();
    let saved_state = crate::async_rt::swap_state(Some(async_state));

    let (context_global, state_rc, module_global) = {
        let isolate_scope = &mut v8::HandleScope::new(&mut isolate);
        let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(isolate_scope, Default::default());
        context.set_microtask_queue(&root_queue);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        let state = FinoState::new_child(
            process_env,
            package_map_json,
            root_queue,
            import_rules,
            Some(entry_path),
            Some(port_half),
            watch_mode,
            repl_mode,
            realm_data,
            realm_bootstrap_data,
        );
        context.set_slot(Rc::new(RefCell::new(state)));

        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        let bootstrap_src = include_str!(concat!(env!("OUT_DIR"), "/js/internal/bootstrap.mjs"));
        let bootstrap_map =
            include_str!(concat!(env!("OUT_DIR"), "/js/internal/bootstrap.mjs.map"));
        let module = {
            let tc = &mut v8::TryCatch::new(scope);
            loader::register_source_map_from_json(tc, "internal/bootstrap.mjs", bootstrap_map);
            match loader::compile_source_module(
                tc,
                bootstrap_src,
                "internal/bootstrap.mjs",
                Some(bootstrap_map),
            ) {
                Some(m) => m,
                None => {
                    crate::async_rt::swap_state(saved_state);
                    return Err(crate::realm::child::catch_message(tc)
                        .unwrap_or_else(|| "failed to compile realm bootstrap".to_string()));
                }
            }
        };
        loader::register_as_builtin(scope, module, "internal:bootstrap");
        {
            let tc = &mut v8::TryCatch::new(scope);
            if module
                .instantiate_module(tc, loader::resolve_module_callback)
                .is_none()
            {
                crate::async_rt::swap_state(saved_state);
                return Err(crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to instantiate realm bootstrap".to_string()));
            }
        }
        {
            let tc = &mut v8::TryCatch::new(scope);
            if module.evaluate(tc).is_none() {
                crate::async_rt::swap_state(saved_state);
                return Err(crate::realm::child::catch_message(tc)
                    .unwrap_or_else(|| "failed to evaluate realm bootstrap".to_string()));
            }
        }
        crate::realm::child::pump_and_checkpoint(scope);
        if module.get_status() == v8::ModuleStatus::Errored {
            let exc = module.get_exception();
            let msg = js_string(scope, exc);
            crate::async_rt::swap_state(saved_state);
            return Err(msg);
        }

        (
            v8::Global::new(scope, context),
            get_state(scope),
            v8::Global::new(scope, module),
        )
    };

    let async_state = crate::async_rt::swap_state(saved_state);

    let mut workload = ParkedWorkload {
        isolate,
        context: context_global,
        async_state,
        thread_handle,
        budget_token,
        _state: state_rc,
        _module: module_global,
        moved_between_threads: false,
    };
    unsafe {
        workload.isolate.exit();
    }
    Ok(workload)
}

/// Pump a realm workload one slice: resolve parked engine-I/O completions,
/// then drive the realm's native loop hooks once without blocking (the engine
/// owns the thread's wait cadence). `Pending` while the
/// realm continues; `Settled` when its policy hooks report done (with the
/// entry error as `Rejected` if one was recorded).
pub(crate) fn activate_realm_native(workload: &mut ParkedWorkload) -> ActiveWorkload {
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

pub(crate) fn deactivate_realm_native(workload: &mut ParkedWorkload, active: ActiveWorkload) {
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

pub(crate) fn pump_realm_native(
    workload: &mut ParkedWorkload,
    hard_budget_micros: u64,
    reactor_events: &[ReactorEvent],
) -> PumpOutcome {
    let budgeted = hard_budget_micros > 0;
    if budgeted {
        let now = Instant::now();
        let deadline = now
            .checked_add(Duration::from_micros(hard_budget_micros))
            .unwrap_or_else(|| now + Duration::from_secs(24 * 60 * 60));
        arm_budget(workload.budget_token, deadline);
    }
    let budget_token = workload.budget_token;
    let outcome = {
        let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
        let context = v8::Local::new(isolate_scope, &workload.context);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        for event in reactor_events {
            match *event {
                ReactorEvent::Resolve {
                    resolver_id,
                    result,
                } => crate::async_rt::resolve_io_completion(scope, resolver_id, result),
                ReactorEvent::Callback {
                    callback_id,
                    fflags,
                } => invoke_reactor_callback(scope, callback_id, fflags),
            }
        }
        let state_rc = get_state(scope);
        let cont = crate::runtime::native_drive_step_nonblocking(scope, &state_rc);
        let terminated = std::mem::take(&mut state_rc.borrow_mut().saw_termination)
            || scope.is_execution_terminating()
            || take_killed(budget_token);
        if terminated {
            // Budget kill or heap-limit containment landed mid-slice.
            PumpOutcome::Terminated
        } else if cont {
            if crate::reactor::drive_needs_poll() {
                PumpOutcome::PendingPoll
            } else {
                PumpOutcome::Pending
            }
        } else {
            let state = state_rc.borrow();
            if state.reload_requested {
                return PumpOutcome::Settled {
                    result: "reload".to_string(),
                };
            }
            let err = state.entry_error.clone();
            match err {
                Some(e) => PumpOutcome::Rejected(e),
                None => PumpOutcome::Settled {
                    result: "exited".to_string(),
                },
            }
        }
    };
    if budgeted {
        clear_budget(workload.budget_token);
        workload.thread_handle.cancel_terminate_execution();
    }
    outcome
}

fn invoke_reactor_callback(scope: &mut v8::HandleScope, callback_id: usize, fflags: Option<u32>) {
    let callback = crate::async_rt::with_callback_table(|table| {
        table
            .get(callback_id)
            .and_then(|slot| slot.as_ref())
            .cloned()
    });
    let Some(callback) = callback else { return };
    let tc = &mut v8::TryCatch::new(scope);
    let function = v8::Local::new(tc, &callback);
    let receiver = v8::undefined(tc).into();
    let mut args = Vec::with_capacity(fflags.is_some() as usize);
    if let Some(fflags) = fflags {
        let event = v8::Object::new(tc);
        let key = v8::String::new(tc, "fflags").unwrap();
        let value = v8::Number::new(tc, fflags as f64);
        event.set(tc, key.into(), value.into());
        args.push(event.into());
    }
    if function.call(tc, receiver, &args).is_none() && tc.has_caught() {
        let message = tc
            .exception()
            .map(|error| error.to_rust_string_lossy(tc))
            .unwrap_or_else(|| "unknown exception".to_string());
        eprintln!("fino: reactor callback threw: {message}");
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
    // `OwnedIsolate::drop` combines exit + Rust annex cleanup + V8 disposal.
    // Once an isolate has crossed threads, V8 requires its final enter/exit to
    // hold a Locker. The Locker destructor itself dereferences the isolate, so
    // neutralize it before dropping the owner and free only its allocation
    // after V8 has disposed the isolate.
    if workload.moved_between_threads {
        let locker = crate::v8_threading::IsolateLocker::new(&mut workload.isolate);
        unsafe {
            workload.isolate.enter();
        }
        let locker = locker.neutralize_for_isolate_dispose();
        drop(workload);
        unsafe {
            locker.free_after_isolate_dispose();
        }
    } else {
        unsafe {
            workload.isolate.enter();
        }
        drop(workload);
    }
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
