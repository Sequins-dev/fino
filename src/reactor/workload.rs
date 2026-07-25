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

use crate::state::{FinoState, get_state};

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

/// Immediately terminate every workload with an in-progress pump, regardless
/// of its deadline. Shutdown uses this before joining reactor threads so a
/// synchronous runaway cannot hold the process open. Idle isolates have no
/// armed deadline and are left alone.
fn terminate_armed_budgets() -> u32 {
    let mut fired = 0;
    let mut registry = lock_registry();
    for target in registry.values_mut() {
        if target.deadline.take().is_some() {
            target.handle.terminate_execution();
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
    /// Route this isolate's background wakes into the current reactor. Moves
    /// intentionally replace the shared route seen by existing producers.
    pub(crate) fn install_wake_notifier(&self, notifier: cherenkov::Notifier, user_data: u64) {
        if let Some(state) = self.async_state.as_ref() {
            state.wake_sink.install_notifier(notifier, user_data);
        }
    }

    pub(crate) fn mark_moved_between_threads(&mut self) {
        self.moved_between_threads = true;
    }

    /// The realm's entry module (main.mjs for the root, bootstrap.mjs for
    /// children), for post-release module-status checks.
    pub(crate) fn module_global(&self) -> v8::Global<v8::Module> {
        self._module.clone()
    }

    /// Run `f` with a context-entered handle scope on this workload's isolate.
    /// The workload must be active (entered) — see `activate_realm_native`.
    pub(crate) fn enter_scope<R>(&mut self, f: impl FnOnce(&mut v8::HandleScope) -> R) -> R {
        let isolate_scope = &mut v8::HandleScope::new(&mut self.isolate);
        let context = v8::Local::new(isolate_scope, &self.context);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        f(scope)
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
    let export_names: Vec<v8::Local<v8::String>> = ["sweepBudgets", "terminateArmedBudgets"]
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
    set_fn!("terminateArmedBudgets", terminate_armed_budgets_export);

    Some(v8::undefined(scope).into())
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

fn setup_workload(
    heap_limit: usize,
    configure: impl FnOnce(&mut v8::OwnedIsolate),
    contain_heap: bool,
    bootstrap: impl FnOnce(
        &mut v8::OwnedIsolate,
    ) -> Result<crate::realm::child::BootstrappedRealm, String>,
) -> Result<ParkedWorkload, String> {
    crate::runtime::init_v8();

    let params = v8::CreateParams::default()
        .heap_limits(0, heap_limit)
        .array_buffer_allocator(crate::runtime::shared_allocator().clone());
    let mut isolate = v8::Isolate::new(params);
    configure(&mut isolate);

    let thread_handle = isolate.thread_safe_handle();
    let budget_token = register_budget_target(thread_handle.clone());
    if contain_heap {
        isolate.add_near_heap_limit_callback(
            heap_limit_callback,
            budget_token as *mut std::ffi::c_void,
        );
    }

    let async_state = crate::async_rt::new_state();
    let saved_state = crate::async_rt::swap_state(Some(async_state));
    let realm = match bootstrap(&mut isolate) {
        Ok(realm) => realm,
        Err(error) => {
            crate::async_rt::swap_state(saved_state);
            unregister_budget_target(budget_token);
            return Err(error);
        }
    };
    let async_state = crate::async_rt::swap_state(saved_state);

    let mut workload = ParkedWorkload {
        isolate,
        context: realm.context,
        async_state,
        thread_handle,
        budget_token,
        _state: realm.state,
        _module: realm.module,
        moved_between_threads: false,
    };
    unsafe {
        workload.isolate.exit();
    }
    Ok(workload)
}

/// Construct a REALM workload: a full child realm (uniform bootstrap, port
/// channel, import-rule inheritance, entry auto-import) hosted as a parked
/// isolate on an engine thread. The realm's `driveLoop` registers native
/// hooks at bootstrap; `pump_realm_native` drives them per slice. This is
/// the same bootstrap used by the process-isolated host; placement and IPC are
/// the only differences.
#[allow(clippy::too_many_arguments)]
pub(crate) fn setup_realm_workload(
    config: crate::realm::RealmExecutionConfig,
) -> Result<ParkedWorkload, String> {
    let heap_limit = if config.heap_limit_bytes == 0 {
        DEFAULT_HEAP_LIMIT_BYTES
    } else {
        config.heap_limit_bytes
    };
    // Containment covers setup too: the full bootstrap is a real heap load,
    // while the root's cap remains process-owned.
    setup_workload(
        heap_limit,
        crate::realm::child::configure_realm_isolate,
        true,
        move |isolate| crate::realm::child::bootstrap_realm(isolate, config),
    )
}

/// Construct the ROOT workload: the process's CLI realm (`internal:main.mjs`,
/// root state, no port channels) parked for a local reactor to drive. The
/// root differs from child realms in isolate policy only: `Atomics.wait` is
/// forbidden (this is the process's primary thread) and there is no
/// near-heap-limit containment — the root's cap is the process's.
pub(crate) fn setup_root_workload(
    process_env: crate::state::ProcessEnv,
) -> Result<ParkedWorkload, String> {
    setup_workload(
        DEFAULT_HEAP_LIMIT_BYTES,
        |isolate| {
            isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
            isolate.set_allow_atomics_wait(false);
            isolate.set_host_import_module_dynamically_callback(
                crate::loader::dynamic_import_callback,
            );
            isolate.set_host_initialize_import_meta_object_callback(
                crate::loader::init_import_meta_callback,
            );
        },
        false,
        move |isolate| crate::runtime::bootstrap_root(isolate, process_env),
    )
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
            // V8 background work (compile/Wasm) posts foreground tasks without
            // touching the reactor — like Atomics.waitAsync it needs a bounded
            // re-pump, or a workload with only that work parks forever.
            if crate::reactor::drive_needs_poll() || scope.has_pending_background_tasks() {
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

pub(crate) fn invoke_reactor_callback(
    scope: &mut v8::HandleScope,
    callback_id: usize,
    fflags: Option<u32>,
) {
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
        dispose_parked_diagnostics(&mut workload);
        let locker = locker.neutralize_for_isolate_dispose();
        drop(workload);
        unsafe {
            locker.free_after_isolate_dispose();
        }
    } else {
        unsafe {
            workload.isolate.enter();
        }
        dispose_parked_diagnostics(&mut workload);
        drop(workload);
    }
}

/// Dispose a released workload's profiler/inspector before its isolate dies.
/// A realm revoked while profiling (or holding an inspector session) must not
/// leak the C++ object — or dispose its isolate underneath one.
fn dispose_parked_diagnostics(workload: &mut ParkedWorkload) {
    let has = {
        let state = workload._state.borrow();
        state.cpu_profiler.is_some() || state.inspector_state.is_some()
    };
    if !has {
        return;
    }
    let state = Rc::clone(&workload._state);
    let isolate_scope = &mut v8::HandleScope::new(&mut workload.isolate);
    let context = v8::Local::new(isolate_scope, &workload.context);
    let _context_scope = v8::ContextScope::new(isolate_scope, context);
    crate::realm::child::dispose_realm_diagnostics(&state);
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

fn terminate_armed_budgets_export(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Integer::new_from_unsigned(scope, terminate_armed_budgets()).into());
}
