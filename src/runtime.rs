//! V8 runtime entry point.

use std::{cell::RefCell, rc::Rc, sync::OnceLock};

use ::v8;

use crate::{
    loader,
    realm::child::{catch_message, pump_and_checkpoint},
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

pub fn run(process_env: ProcessEnv) -> Result<(), String> {
    init_v8();

    let mut params = v8::CreateParams::default();
    params = params.heap_limits(0, 1 << 30);
    params = params.array_buffer_allocator(shared_allocator());

    let isolate = &mut v8::Isolate::new(params);

    // Initialise per-isolate async state (executor + blocking pool wake pipe).
    crate::async_rt::init();

    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    // Atomics.wait() blocks the thread — not safe on the main event-loop thread.
    isolate.set_allow_atomics_wait(false);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    // isolate_scope is a bare HandleScope<()>; we re-enter context via
    // ContextScope on each loop iteration.
    v8::scope!(let isolate_scope, isolate);

    // Create root microtask queue.
    let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);

    // Create context and assign the root queue to it.
    let context = v8::Context::new(
        isolate_scope,
        v8::ContextOptions {
            microtask_queue: Some((&*root_queue as *const v8::MicrotaskQueue).cast_mut()),
            ..Default::default()
        },
    );

    // Keep a Global for the main module so it survives across ContextScope
    // block boundaries (v8::Local lifetimes are tied to the scope they were
    // created in).
    let main_module_global: v8::Global<v8::Module>;

    // Keep a clone of state_rc so we can call process_pending_creates between
    // iterations without re-entering the context.
    let state_rc: Rc<RefCell<FinoState>>;

    // -----------------------------------------------------------------------
    // Setup: initialise FinoState, compile+evaluate internal/main.mjs, first pump.
    // -----------------------------------------------------------------------
    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        let package_map_json =
            std::fs::read_to_string(process_env.root.join(".fino/package-map.json")).ok();
        let state = FinoState::new_root(
            process_env,
            package_map_json,
            root_queue,
            crate::state::default_import_rules(),
        );

        scope.set_slot(Rc::new(RefCell::new(state)));
        // Initialize the CPED with an empty JS Array — this becomes the live
        // async context frame. Must happen before any JS code runs.
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        // Compile and evaluate internal/main.mjs.
        let main_src = include_str!(concat!(env!("OUT_DIR"), "/js/internal/main.mjs"));
        let main_map = include_str!(concat!(env!("OUT_DIR"), "/js/internal/main.mjs.map"));

        let main_module = {
            v8::tc_scope!(tc, scope);
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

        // Register internal/main.mjs so its specifier is known for import-rule `from` matching.
        // Using "internal:main" places it in the internal: namespace so the default
        // rules allow it to import other internal: modules.
        loader::register_as_builtin(scope, main_module, "internal:main");

        // Instantiate.
        {
            v8::tc_scope!(tc, scope);
            if main_module
                .instantiate_module(tc, loader::resolve_module_callback)
                .is_none()
            {
                let msg = catch_message(tc)
                    .unwrap_or_else(|| "Failed to instantiate internal/main.mjs".to_string());
                return Err(msg);
            }
        }

        // Evaluate.  V8 defers the module body to the microtask queue; the actual
        // module code runs during the first perform_checkpoint below.
        {
            v8::tc_scope!(tc, scope);
            if main_module.evaluate(tc).is_none() {
                let msg = catch_message(tc)
                    .unwrap_or_else(|| "Failed to evaluate internal/main.mjs".to_string());
                return Err(msg);
            }
        }

        // First pump + checkpoint: runs internal/main.ts module body as a microtask.
        // The module body calls runLoop(step, onDone) from internal:async-context,
        // storing those callbacks in FinoState for the loop below.
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

        state_rc = crate::state::get_state(scope);
        main_module_global = v8::Global::new(scope, main_module);
    } // ContextScope dropped — isolate_scope is free again.

    // -----------------------------------------------------------------------
    // Host loop.
    //
    // Each iteration re-enters the root context (ContextScope) and calls the JS
    // step fn, then drops the ContextScope so isolate_scope is free again.
    //
    // Using a named loop label so `break` inside the inner block exits here.
    // -----------------------------------------------------------------------
    'main: loop {
        let should_continue = 'step: {
            let scope = &mut v8::ContextScope::new(isolate_scope, context);

            // Extract stored JS step callback without holding the borrow during call.
            let loop_step_fn = match state_rc.borrow().loop_step_fn.clone() {
                Some(f) => f,
                // internal/main.ts never called runLoop (e.g. argv.length < 2).
                None => break 'main,
            };

            // step() -> progress count; negative means the realm is finished.
            // The orchestration realm has no scheduler to preempt it, so the
            // magnitude is ignored here and only the sign matters.
            let should_continue = {
                let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
                v8::Local::new(scope, &loop_step_fn)
                    .call(scope, undef, &[])
                    .and_then(|v| v.number_value(scope))
                    .is_some_and(|progress| progress >= 0.0)
            };

            if should_continue {
                // Drain any completed async FFI calls on every loop iteration.
                // The wake pipe wakes kqueue, but we drain here (not via a
                // JS-level readable() handler) to avoid keeping the loop alive.
                pump_and_checkpoint(scope);

                // Handle any pending synchronous call scheduled by JS via
                // scheduleSync() (internal:async-context). We call the function
                // here (outside perform_checkpoint) so that
                // is_running_microtasks_ is false, allowing spin() →
                // drainMicrotasks() to actually drain the queue.
                if crate::async_rt::service_scheduled_sync_call(scope, &state_rc) {
                    // Drain foreground tasks + microtasks produced by resolving the promise.
                    pump_and_checkpoint(scope);
                }
            }

            break 'step should_continue;
        }; // ContextScope dropped — isolate_scope is free.

        if !should_continue {
            break 'main;
        }
    }

    // -----------------------------------------------------------------------
    // Teardown: call onDone, dispose profiler.
    // -----------------------------------------------------------------------
    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        // Call onDone() — runs the post-loop error check from internal/main.ts (e.g.
        // `if (caughtError) { exit(1); }`).  If onDone calls exit(), we never
        // return from here; otherwise it returns normally.
        let on_done_fn = state_rc.borrow().on_done_fn.clone();
        if let Some(f) = on_done_fn {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            v8::Local::new(scope, &f).call(scope, undef, &[]);
            // Drain foreground tasks + microtasks enqueued by onDone.
            pump_and_checkpoint(scope);
        }

        crate::profiler::finish_realm_profile(&mut state_rc.borrow_mut());

        // Dispose the public CPU profiler if it was created.
        if let Some(ptr) = state_rc.borrow_mut().cpu_profiler.take() {
            unsafe { crate::profiler::dispose_profiler(ptr) };
        }

        // Dispose the V8 inspector if it was created.
        if let Some(ptr) = state_rc.borrow_mut().inspector_state.take() {
            unsafe { crate::inspector_module::dispose_inspector(ptr) };
        }

        // Check for a deferred module evaluation error.
        let main_module = v8::Local::new(scope, &main_module_global);
        if main_module.get_status() == v8::ModuleStatus::Errored {
            let exc = main_module.get_exception();
            let msg = exc
                .to_string(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "Unknown error in internal/main.mjs".to_string());
            return Err(msg);
        }
    }

    Ok(())
}
