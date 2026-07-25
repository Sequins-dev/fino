//! V8 runtime entry point.

use std::{cell::RefCell, rc::Rc, sync::OnceLock};

use ::v8;

use crate::{
    loader,
    state::{FinoState, ProcessEnv},
};

static V8_INIT: OnceLock<()> = OnceLock::new();

/// Newtype wrapper so `SharedPtr<Allocator>` can be stored in a global.
///
/// The V8 default allocator is thread-safe (malloc/free under the hood) and
/// is designed to be shared across Isolates for SharedArrayBuffer support.
struct SharedAllocator(v8::SharedPtr<v8::Allocator>);
unsafe impl Send for SharedAllocator {}
unsafe impl Sync for SharedAllocator {}

static SHARED_ALLOCATOR: OnceLock<SharedAllocator> = OnceLock::new();

/// Return a clone of the global shared allocator.
///
/// Both the main Isolate and every thread Isolate use the same allocator so
/// that SharedArrayBuffer backing stores are accessible across Isolates.
pub(crate) fn shared_allocator() -> v8::SharedPtr<v8::Allocator> {
    SHARED_ALLOCATOR
        .get()
        .expect("shared_allocator() called before init_v8()")
        .0
        .clone()
}

pub(crate) fn init_v8() {
    V8_INIT.get_or_init(|| {
        let mut flags = "--turbo_fast_api_calls".to_string();
        if std::env::var_os("FINO_ALLOW_NATIVES_SYNTAX").is_some() {
            flags.push_str(" --allow_natives_syntax");
        }
        v8::V8::set_flags_from_string(&flags);
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
    // Initialize the shared allocator once V8 is up.  Multiple calls are safe.
    SHARED_ALLOCATOR.get_or_init(|| SharedAllocator(v8::new_default_allocator().into()));
}

/// Run the process's CLI realm to completion. The main thread IS a reactor:
/// the same drive loop the orchestrator's pool runs, hosting the root realm
/// as its only workload.
pub fn run(process_env: ProcessEnv) -> Result<(), String> {
    init_v8();

    let config = crate::reactor::engine::ReactorConfig {
        // The root is uncontained: no pump budget, no sync-slice reports
        // (there is no orchestrator to migrate it anywhere).
        hard_budget_micros: 0,
        sync_slice_micros: u64::MAX,
        heap_limit_bytes: 0,
        process_env: process_env.clone(),
        package_map_json: None,
        reactor_class: crate::reactor::engine::ReactorClass::Latency,
    };

    crate::reactor::engine::run_local(
        config,
        move || crate::reactor::workload::setup_root_workload(process_env),
        |workload, _reason| {
            let module = workload.module_global();
            workload.enter_scope(|scope| {
                let state_rc = crate::state::get_state(scope);

                // Call onDone() — runs the post-loop error check from
                // internal/main.ts (e.g. `if (caughtError) { exit(1); }`).
                // If onDone calls exit(), we never return from here.
                let on_done_fn = state_rc.borrow().on_done_fn.clone();
                if let Some(f) = on_done_fn {
                    let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
                    v8::Local::new(scope, &f).call(scope, undef, &[]);
                    // Drain foreground tasks + microtasks enqueued by onDone.
                    pump_and_checkpoint(scope);
                }

                crate::realm::child::dispose_realm_diagnostics(&state_rc);

                // Check for a deferred module evaluation error.
                let main_module = v8::Local::new(scope, &module);
                if main_module.get_status() == v8::ModuleStatus::Errored {
                    let exc = main_module.get_exception();
                    let msg = exc
                        .to_string(scope)
                        .map(|s| s.to_rust_string_lossy(scope))
                        .unwrap_or_else(|| "Unknown error in internal/main.mjs".to_string());
                    return Err(msg);
                }
                Ok(())
            })
        },
    )
}

/// Construct the root realm inside `isolate`: FinoState, CPED frame, and the
/// evaluated `internal:main.mjs` module (whose body registers the native loop
/// hooks the drive loop pumps).
pub(crate) fn bootstrap_root(
    isolate: &mut v8::OwnedIsolate,
    process_env: ProcessEnv,
) -> Result<crate::realm::child::BootstrappedRealm, String> {
    let isolate_scope = &mut v8::HandleScope::new(isolate);
    let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
    let context = v8::Context::new(isolate_scope, Default::default());
    context.set_microtask_queue(&root_queue);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);

    let package_map_json =
        std::fs::read_to_string(process_env.root.join(".fino/package-map.json")).ok();
    let state = FinoState::new_root(
        process_env,
        package_map_json,
        root_queue,
        crate::state::default_import_rules(),
    );
    context.set_slot(Rc::new(RefCell::new(state)));

    // Initialize the CPED with an empty JS Array — this becomes the live
    // async context frame. Must happen before any JS code runs.
    let initial_frame = v8::Array::new(scope, 0);
    scope.set_continuation_preserved_embedder_data(initial_frame.into());

    let main_src = include_str!(concat!(env!("OUT_DIR"), "/js/internal/main.mjs"));
    let main_map = include_str!(concat!(env!("OUT_DIR"), "/js/internal/main.mjs.map"));

    let main_module = {
        let tc = &mut v8::TryCatch::new(scope);
        loader::register_source_map_from_json(tc, "internal:main", main_map);
        match loader::compile_source_module(tc, main_src, "internal:main", Some(main_map)) {
            Some(m) => m,
            None => {
                let msg = catch_message(tc)
                    .unwrap_or_else(|| "Failed to compile internal/main.mjs".to_string());
                return Err(msg);
            }
        }
    };

    // Register internal/main.mjs so its specifier is known for import-rule
    // `from` matching. Using "internal:main" places it in the internal:
    // namespace so the default rules allow it to import other internal: modules.
    loader::register_as_builtin(scope, main_module, "internal:main");

    {
        let tc = &mut v8::TryCatch::new(scope);
        if main_module
            .instantiate_module(tc, loader::resolve_module_callback)
            .is_none()
        {
            let msg = catch_message(tc)
                .unwrap_or_else(|| "Failed to instantiate internal/main.mjs".to_string());
            return Err(msg);
        }
    }

    // Evaluate. V8 defers the module body to the microtask queue; the actual
    // module code runs during the first perform_checkpoint below.
    {
        let tc = &mut v8::TryCatch::new(scope);
        if main_module.evaluate(tc).is_none() {
            let msg = catch_message(tc)
                .unwrap_or_else(|| "Failed to evaluate internal/main.mjs".to_string());
            return Err(msg);
        }
    }

    // First pump + checkpoint: runs internal/main.ts module body as a
    // microtask. The module body calls runNativeLoop(...), storing the
    // policy hooks the drive loop pumps.
    pump_and_checkpoint(scope);

    // Surface any synchronous error that occurred in the module body.
    if main_module.get_status() == v8::ModuleStatus::Errored {
        let exc = main_module.get_exception();
        let msg = exc
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_else(|| "Unknown error in internal/main.mjs".to_string());
        return Err(msg);
    }

    Ok(crate::realm::child::BootstrappedRealm {
        context: v8::Global::new(scope, context),
        state: crate::state::get_state(scope),
        module: v8::Global::new(scope, main_module),
    })
}

/// Pump V8 platform foreground tasks then drain the microtask queue.
///
/// Fixed-point loop: Rust executor → drain completions/pending → microtask
/// checkpoint. Repeats until quiescent so Rust futures awaiting JS Promises
/// (and vice-versa) always converge in one call.
fn pump_and_checkpoint(scope: &mut v8::HandleScope) {
    let platform = v8::V8::get_current_platform();
    while v8::Platform::pump_message_loop(&platform, scope, false) {}
    let state_rc = crate::state::get_state(scope);
    loop {
        let mut progress = false;
        while crate::async_rt::try_tick() {
            progress = true;
        }
        progress |= crate::async_rt::drain_all(scope, &state_rc);
        {
            let queue_ptr = unsafe { crate::state::root_queue_ptr(&state_rc) };
            let isolate: &mut v8::Isolate = scope.as_mut();
            unsafe { &*queue_ptr }.perform_checkpoint(isolate);
        }
        if !progress {
            break;
        }
    }
}

/// Service a pending synchronous call scheduled by JS via `scheduleSync()`
/// (internal:async-context). The function runs here — outside any microtask
/// checkpoint — so `is_running_microtasks_` is false and a re-entrant
/// `drainMicrotasks()` inside it actually drains the queue.
pub(crate) fn service_sync_call(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    let Some((fn_ref, resolver_ref)) = state_rc.borrow_mut().sync_calls.pop_front() else {
        return false;
    };
    // Call fn() and capture result/exception as globals so TryCatch can drop.
    let call_result: Result<v8::Global<v8::Value>, v8::Global<v8::Value>> = {
        let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
        let tc = &mut v8::TryCatch::new(scope);
        let fn_local = v8::Local::new(tc, &fn_ref);
        match fn_local.call(tc, undef, &[]) {
            Some(result) => Ok(v8::Global::new(tc, result)),
            None => {
                let exc = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                Err(v8::Global::new(tc, exc))
            }
        }
    }; // TryCatch dropped here, borrow on scope released
    match call_result {
        Ok(result_ref) => {
            let resolver_local = v8::Local::new(scope, &resolver_ref);
            let result_local = v8::Local::new(scope, &result_ref);
            let _ = resolver_local.resolve(scope, result_local);
        }
        Err(exc_ref) => {
            let resolver_local = v8::Local::new(scope, &resolver_ref);
            let exc_local = v8::Local::new(scope, &exc_ref);
            let _ = resolver_local.reject(scope, exc_local);
        }
    }
    // Drain foreground tasks + microtasks produced by resolving the promise.
    pump_and_checkpoint(scope);
    true
}

/// Call a no-arg JS policy hook; `None` means it threw (the loop should exit,
/// matching the legacy behavior where a throwing step() ended the loop).
fn call_hook(scope: &mut v8::HandleScope, g: &v8::Global<v8::Function>) -> Option<bool> {
    let tc = &mut v8::TryCatch::new(scope);
    let undef: v8::Local<v8::Value> = v8::undefined(tc).into();
    let f = v8::Local::new(tc, g);
    let out = f.call(tc, undef, &[]).map(|v| v.boolean_value(tc));
    if out.is_none() && tc.has_terminated() {
        // Budget/heap containment killed execution; record it — the flag on
        // the isolate clears once the stack unwinds, but the engine's pump
        // must classify this slice as Terminated.
        crate::state::get_state(tc).borrow_mut().saw_termination = true;
    }
    out
}

/// One pump slice of a reactor-hosted realm: settle everything ready to a
/// fixed point, run the thin JS policy hooks, and decide doneness (§5 of the
/// reactor doc: realm policy done AND reactor quiescent). The engine owns the
/// thread's wait cadence, so there is no trailing reactor wait here.
/// Returns false when the realm is finished (or a policy hook threw).
pub(crate) fn native_drive_step_nonblocking(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    let (is_done, flush_ports) = {
        let st = state_rc.borrow();
        let Some(h) = st.native_loop.as_ref() else {
            return false;
        };
        (h.is_done_fn.clone(), h.flush_ports_fn.clone())
    };
    let evaluate = |scope: &mut v8::HandleScope| call_hook(scope, &is_done);

    // Settle to true quiescence before deciding anything: the policy hooks
    // and scheduleSync'd functions each run JS that can schedule more work
    // (`isDone()`'s first true-ward call starts wind-down microtasks; a test
    // body queues the next scheduleSync). Parking with any of it pending
    // would strand the realm — nothing about it wakes the reactor.
    loop {
        pump_and_checkpoint(scope);
        // Port deliveries are macrotasks.
        // Same-isolate port queues never touch the reactor, so the flush hook
        // reports delivery and the settle loop re-passes while it progresses.
        let mut flushed = false;
        if let Some(f) = &flush_ports {
            match call_hook(scope, f) {
                Some(d) => flushed = d,
                None => return false,
            }
        }
        pump_and_checkpoint(scope);

        // Deferred sync work (scheduleSync) runs outside any checkpoint.
        let serviced = service_sync_call(scope, state_rc);

        // Evaluated for its side effects: isDone()'s first true-ward call
        // starts wind-down work whose microtasks the next pump absorbs.
        if evaluate(scope).is_none() {
            return false;
        }
        pump_and_checkpoint(scope);

        let sync_pending = !state_rc.borrow().sync_calls.is_empty();
        if flushed || serviced || sync_pending {
            continue;
        }
        break;
    }
    // Sample the exit inputs only now, after the last pump, so a wind-down
    // that completed inside the settle loop is observed.
    let Some(done) = evaluate(scope) else {
        return false;
    };

    // Atomics.waitAsync waiters settle cross-thread with no reactor
    // registration, and V8 background work posts foreground tasks the same
    // way — both must hold the realm open. Reactor-handle liveness is the JS
    // policy hook's concern (loop alive()).
    let live = crate::reactor::drive_needs_poll() || scope.has_pending_background_tasks();
    if done && !live {
        return false;
    }
    true
}

fn catch_message(tc: &mut v8::TryCatch<v8::HandleScope>) -> Option<String> {
    if !tc.has_caught() {
        return None;
    }
    tc.exception().and_then(|exc| {
        exc.to_object(tc)
            .and_then(|obj| v8::String::new(tc, "stack").and_then(|key| obj.get(tc, key.into())))
            .and_then(|stack| stack.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
            .or_else(|| exc.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
    })
}
