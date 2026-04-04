//! V8 runtime entry point.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    path::Path,
    rc::Rc,
    sync::OnceLock,
};

use ::v8;

use crate::{loader, state::FinoState};

static V8_INIT: OnceLock<()> = OnceLock::new();

fn init_v8() {
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
}

pub fn run(root: &Path) -> Result<(), String> {
    init_v8();

    let mut params = v8::CreateParams::default();
    params = params.heap_limits(0, 1 << 30);

    let isolate = &mut v8::Isolate::new(params);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    let isolate_scope = &mut v8::HandleScope::new(isolate);

    // Create root microtask queue.
    let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);

    // Create context and assign the root queue to it.
    let context = v8::Context::new(isolate_scope, Default::default());
    context.set_microtask_queue(&root_queue);

    // Initialise FinoState.
    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        let state = FinoState {
            root: root.to_path_buf(),
            package_map_json: std::fs::read_to_string(root.join(".fino/package-map.json")).ok(),
            slot_count: 0,
            snapshot_store: Vec::new(),
            root_queue,
            builtin_cache: HashMap::new(),
            fs_cache: HashMap::new(),
            builtin_script_ids: HashSet::new(),
            builtin_specifiers: HashMap::new(),
            module_paths: HashMap::new(),
            source_maps: HashMap::new(),
            resolve_fn: None,
            init_meta_fn: None,
            loop_step_fn: None,
            on_done_fn: None,
            sync_call_fn: None,
            sync_call_resolver: None,
            tla_resolvers: Vec::new(),
            cpu_profiler: None,
        };

        context.set_slot(Rc::new(RefCell::new(state)));

        // Initialize the CPED with an empty JS Array — this becomes the live
        // async context frame. Must happen before any JS code runs.
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());
    }

    let scope = &mut v8::ContextScope::new(isolate_scope, context);

    // Compile and evaluate _main.mjs.
    let main_src = include_str!(concat!(env!("OUT_DIR"), "/js/_main.mjs"));
    let main_map = include_str!(concat!(env!("OUT_DIR"), "/js/_main.mjs.map"));

    let main_module = {
        let tc = &mut v8::TryCatch::new(scope);
        loader::register_source_map_from_json(tc, "_main.mjs", main_map);
        match loader::compile_source_module(tc, main_src, "_main.mjs", Some(main_map)) {
            Some(m) => m,
            None => {
                let msg =
                    catch_message(tc).unwrap_or_else(|| "Failed to compile _main.mjs".to_string());
                return Err(msg);
            }
        }
    };

    // Register _main.mjs as a builtin (allows it to import internal:* modules).
    loader::register_as_builtin(scope, main_module, "_main.mjs");

    // Instantiate.
    {
        let tc = &mut v8::TryCatch::new(scope);
        if main_module
            .instantiate_module(tc, loader::resolve_module_callback)
            .is_none()
        {
            let msg =
                catch_message(tc).unwrap_or_else(|| "Failed to instantiate _main.mjs".to_string());
            return Err(msg);
        }
    }

    // Evaluate.  V8 defers the module body to the microtask queue; the actual
    // module code runs during the first perform_checkpoint below.
    {
        let tc = &mut v8::TryCatch::new(scope);
        if main_module.evaluate(tc).is_none() {
            let msg =
                catch_message(tc).unwrap_or_else(|| "Failed to evaluate _main.mjs".to_string());
            return Err(msg);
        }
    }

    // First pump + checkpoint: runs _main.mts module body as a microtask.
    // The module body calls runLoop(step, onDone) from internal:async-context,
    // storing those callbacks in FinoState for the loop below.
    pump_and_checkpoint(scope);

    // Surface any synchronous error that occurred in the module body.
    if main_module.get_status() == v8::ModuleStatus::Errored {
        let exc = main_module.get_exception();
        let msg = exc
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_else(|| "Unknown error in _main.mjs".to_string());
        return Err(msg);
    }

    // Host loop. JS owns scheduling policy via one step callback; Rust only
    // provides the safe re-entry point outside microtask checkpoints and
    // services deferred scheduleSync() work between steps.
    loop {
        // Extract stored JS callbacks without holding the borrow during calls.
        let loop_step_fn = {
            let state_rc = crate::state::get_state(scope);
            let st = state_rc.borrow();
            st.loop_step_fn.clone()
        };

        // If _main.mts never called runLoop (e.g. argv.length < 2),
        // there is nothing to loop over.
        let Some(loop_step_fn) = loop_step_fn else {
            break;
        };

        // step() -> boolean
        let should_continue = {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            v8::Local::new(scope, &loop_step_fn)
                .call(scope, undef, &[])
                .map(|v| v.boolean_value(scope))
                .unwrap_or(false)
        };

        if !should_continue {
            break;
        }

        // Handle any pending synchronous call scheduled by JS via scheduleSync() (internal:async-context).
        // We call the function here (outside perform_checkpoint) so that is_running_microtasks_
        // is false, allowing spin() → drainMicrotasks() to actually drain the queue.
        {
            let state_rc = crate::state::get_state(scope);
            let (maybe_fn, maybe_resolver) = {
                let mut st = state_rc.borrow_mut();
                (st.sync_call_fn.take(), st.sync_call_resolver.take())
            };

            if let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) {
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

                // Resolve or reject the promise resolver (requires scope, now free).
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

                // Drain foreground tasks + microtasks produced by resolving the scheduleSync() promise.
                pump_and_checkpoint(scope);
            }
        }
    }

    // Call onDone() — runs the post-loop error check from _main.mts (e.g.
    // `if (caughtError) { exit(1); }`).  If onDone calls exit(), we never
    // return from here; otherwise it returns normally.
    let on_done_fn = {
        let state_rc = crate::state::get_state(scope);
        state_rc.borrow().on_done_fn.clone()
    };
    if let Some(f) = on_done_fn {
        let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
        v8::Local::new(scope, &f).call(scope, undef, &[]);
        // Drain foreground tasks + microtasks enqueued by onDone.
        pump_and_checkpoint(scope);
    }

    // Dispose the CPU profiler if it was created.
    {
        let state_rc = crate::state::get_state(scope);
        if let Some(ptr) = state_rc.borrow_mut().cpu_profiler.take() {
            unsafe { crate::profiler::dispose_profiler(ptr) };
        }
    }

    // Check for a deferred module evaluation error.
    match main_module.get_status() {
        v8::ModuleStatus::Errored => {
            let exc = main_module.get_exception();
            let msg = exc
                .to_string(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "Unknown error in _main.mjs".to_string());
            Err(msg)
        }
        _ => Ok(()),
    }
}

/// Pump V8 platform foreground tasks then drain the microtask queue.
///
/// Foreground tasks are callbacks posted by V8 background threads (e.g. WASM
/// compilation) that must run on the main thread. They resolve JS Promises,
/// which enqueue microtasks, so foreground tasks must be drained first.
fn pump_and_checkpoint(scope: &mut v8::HandleScope) {
    let platform = v8::V8::get_current_platform();
    while v8::Platform::pump_message_loop(&platform, scope, false) {}
    let state_rc = crate::state::get_state(scope);
    let queue_ptr = unsafe { crate::state::root_queue_ptr(&state_rc) };
    let isolate: &mut v8::Isolate = scope.as_mut();
    unsafe { &*queue_ptr }.perform_checkpoint(isolate);
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
