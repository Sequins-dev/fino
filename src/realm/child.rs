//! V8 isolate bootstrap and host loop for process-isolated Realms.

use std::{cell::RefCell, rc::Rc};

use ::v8;

use crate::{
    loader,
    realm::RealmExecutionConfig,
    state::{FinoState, get_state, root_queue_ptr},
};

/// Placement-independent result of bootstrapping one Realm inside an isolate.
pub(crate) struct BootstrappedRealm {
    pub context: v8::Global<v8::Context>,
    pub state: Rc<RefCell<FinoState>>,
    pub module: v8::Global<v8::Module>,
}

/// Install the callbacks and isolate policy shared by every Realm host.
pub(crate) fn configure_realm_isolate(isolate: &mut v8::OwnedIsolate) {
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);
}

/// Construct the context, state, continuation frame, and bootstrap module
/// shared by process and reactor hosts.
pub(crate) fn bootstrap_realm(
    isolate: &mut v8::OwnedIsolate,
    config: RealmExecutionConfig,
) -> Result<BootstrappedRealm, String> {
    let isolate_scope = &mut v8::HandleScope::new(isolate);
    let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
    let context = v8::Context::new(isolate_scope, Default::default());
    context.set_microtask_queue(&root_queue);
    let scope = &mut v8::ContextScope::new(isolate_scope, context);
    let state = FinoState::new_child(
        config.process_env,
        config.package_map_json,
        root_queue,
        config.import_rules,
        Some(config.entry_path),
        Some(config.port_half),
        config.allocation_half,
        config.watch_mode,
        config.repl_mode,
        config.realm_data,
        config.realm_bootstrap_data,
    );
    context.set_slot(Rc::new(RefCell::new(state)));

    let initial_frame = v8::Array::new(scope, 0);
    scope.set_continuation_preserved_embedder_data(initial_frame.into());
    let source = include_str!(concat!(env!("OUT_DIR"), "/js/internal/bootstrap.mjs"));
    let source_map = include_str!(concat!(env!("OUT_DIR"), "/js/internal/bootstrap.mjs.map"));
    let module = {
        let tc = &mut v8::TryCatch::new(scope);
        loader::register_source_map_from_json(tc, "internal/bootstrap.mjs", source_map);
        loader::compile_source_module(tc, source, "internal/bootstrap.mjs", Some(source_map))
            .ok_or_else(|| {
                catch_message(tc).unwrap_or_else(|| "failed to compile realm bootstrap".to_string())
            })?
    };
    loader::register_as_builtin(scope, module, "internal:bootstrap");
    {
        let tc = &mut v8::TryCatch::new(scope);
        module
            .instantiate_module(tc, loader::resolve_module_callback)
            .ok_or_else(|| {
                catch_message(tc)
                    .unwrap_or_else(|| "failed to instantiate realm bootstrap".to_string())
            })?;
    }
    {
        let tc = &mut v8::TryCatch::new(scope);
        module.evaluate(tc).ok_or_else(|| {
            catch_message(tc).unwrap_or_else(|| "failed to evaluate realm bootstrap".to_string())
        })?;
    }
    pump_and_checkpoint(scope);
    if module.get_status() == v8::ModuleStatus::Errored {
        let exception = module.get_exception();
        return Err(exception
            .to_string(scope)
            .map(|value| value.to_rust_string_lossy(scope))
            .unwrap_or_else(|| "unknown error in realm bootstrap".to_string()));
    }

    Ok(BootstrappedRealm {
        context: v8::Global::new(scope, context),
        state: get_state(scope),
        module: v8::Global::new(scope, module),
    })
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared host loop
// ---------------------------------------------------------------------------

/// Bootstrap a fresh V8 Isolate and run its event loop to completion.
///
/// Handles: isolate creation, `internal/bootstrap.mjs` evaluation, the host loop, and
/// teardown.  The caller is responsible only for setting up the IPC channel and
/// any RAII guards (e.g. `OwnedFd`) before calling here.
pub fn run_child_isolate(config: RealmExecutionConfig) -> Result<(), String> {
    use std::time::Instant;

    fn timing_enabled() -> bool {
        static E: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *E.get_or_init(|| std::env::var_os("FINO_REALM_TIMING").is_some())
    }

    crate::runtime::init_v8();

    let label = config.timing_label;
    let total_start = timing_enabled().then(Instant::now);

    let mut params = v8::CreateParams::default();
    params = params.heap_limits(0, config.heap_limit_bytes.max(1 << 30));
    params = params.array_buffer_allocator(crate::runtime::shared_allocator().clone());

    let t = timing_enabled().then(Instant::now);
    let mut isolate = v8::Isolate::new(params);
    if let Some(t) = t {
        eprintln!(
            "[fino:realm-timing] {label}  isolate-new: {:?}",
            t.elapsed()
        );
    }

    // Initialise per-isolate async state for this child isolate's thread.
    crate::async_rt::init();

    configure_realm_isolate(&mut isolate);
    let realm = bootstrap_realm(&mut isolate, config)?;
    if let Some(t) = total_start {
        eprintln!(
            "[fino:realm-timing] {label}  total:       {:?}",
            t.elapsed()
        );
    }

    // -----------------------------------------------------------------------
    // Host loop
    // -----------------------------------------------------------------------
    'main: loop {
        let should_continue = {
            let isolate_scope = &mut v8::HandleScope::new(&mut isolate);
            let context = v8::Local::new(isolate_scope, &realm.context);
            let scope = &mut v8::ContextScope::new(isolate_scope, context);

            // The realm's loop is reactor-backed: Rust owns the pump cadence
            // and calls only thin JS policy hooks. No hooks means bootstrap
            // never called driveLoop — nothing to run.
            if realm.state.borrow().native_loop.is_none() {
                break 'main;
            }
            crate::runtime::native_drive_step(scope, &realm.state)
        };

        if !should_continue {
            break 'main;
        }
    }

    // -----------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------
    {
        let isolate_scope = &mut v8::HandleScope::new(&mut isolate);
        let context = v8::Local::new(isolate_scope, &realm.context);
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        let on_done_fn = realm.state.borrow().on_done_fn.clone();
        if let Some(f) = on_done_fn {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            v8::Local::new(scope, &f).call(scope, undef, &[]);
            pump_and_checkpoint(scope);
        }

        if let Some(ptr) = realm.state.borrow_mut().cpu_profiler.take() {
            unsafe { crate::profiler::dispose_profiler(ptr) };
        }

        if let Some(ptr) = realm.state.borrow_mut().inspector_state.take() {
            unsafe { crate::inspector_module::dispose_inspector(ptr) };
        }

        // Drop this realm's channel half before the isolate is disposed:
        // removal closes its pipe ends and hangs up the mpsc, which is how
        // the partner (parent port, or a process realm's writer bridge
        // thread) observes disconnection.
        if let Some(handle) = realm.state.borrow_mut().port_transit_handle.take() {
            drop(crate::realm::transit::remove_half(handle));
        }

        let bm = v8::Local::new(scope, &realm.module);
        if bm.get_status() == v8::ModuleStatus::Errored {
            let exc = bm.get_exception();
            return Err(exc
                .to_string(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "Unknown error in internal/bootstrap.mjs".to_string()));
        }

        // If the entry module threw at top-level, propagate the error so the
        // parent can reject Realm.run() instead of resolving it silently.
        if let Some(err) = get_state(scope).borrow().entry_error.clone() {
            return Err(err);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers (also pub so thread.rs / process.rs don't need their own copies)
// ---------------------------------------------------------------------------

pub fn pump_and_checkpoint(scope: &mut v8::HandleScope) {
    let platform = v8::V8::get_current_platform();
    while v8::Platform::pump_message_loop(&platform, scope, false) {}
    let state_rc = get_state(scope);
    loop {
        let mut progress = false;
        while crate::async_rt::try_tick() {
            progress = true;
        }
        progress |= crate::async_rt::drain_all(scope, &state_rc);
        {
            let queue_ptr = unsafe { root_queue_ptr(&state_rc) };
            let isolate: &mut v8::Isolate = scope.as_mut();
            unsafe { &*queue_ptr }.perform_checkpoint(isolate);
        }
        if !progress {
            break;
        }
    }
}

pub fn catch_message(tc: &mut v8::TryCatch<v8::HandleScope>) -> Option<String> {
    if !tc.has_caught() {
        return None;
    }
    tc.exception().and_then(|exc| {
        exc.to_object(tc)
            .and_then(|o| v8::String::new(tc, "stack").and_then(|k| o.get(tc, k.into())))
            .and_then(|s| s.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
            .or_else(|| exc.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
    })
}
