//! Shared V8 isolate bootstrap + host loop for isolated child Realms.
//!
//! Both thread Realms and process Realms run the same sequence: create a fresh
//! V8 Isolate, evaluate `internal/bootstrap.mjs`, drive the host loop, then teardown.
//! This module houses that shared code so neither `thread.rs` nor `process.rs`
//! duplicates it.

use std::{
    cell::RefCell,
    os::unix::io::RawFd,
    rc::Rc,
    sync::{Arc, atomic::AtomicBool, mpsc},
};

use ::v8;

use super::thread::ThreadMessage;
use crate::{
    loader, realm,
    state::{FinoState, ImportRule, ProcessEnv, get_state, root_queue_ptr},
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// All non-V8 inputs needed to bootstrap a child Isolate.
///
/// Callers construct this from their realm-type-specific setup (wake-pipes for
/// thread realms; socket bridge for process realms) and hand it to
/// `run_child_isolate`.
pub struct ChildConfig {
    pub process_env: ProcessEnv,
    pub package_map_json: Option<String>,
    pub import_rules: Vec<ImportRule>,
    pub entry_path: String,
    /// Receives messages sent from the partner (parent).
    pub channel_rx: mpsc::Receiver<ThreadMessage>,
    /// Sends messages to the partner (parent).
    pub channel_tx: mpsc::Sender<ThreadMessage>,
    /// Own wake-pipe/socket read end — registered with the event loop.
    pub wake_read_fd: RawFd,
    /// Partner's wake-pipe write end, or `None` when the send path wakes the
    /// partner via a different mechanism (e.g., writing to a socket).
    pub wake_write_fd: Option<RawFd>,
    /// Label used in `FINO_REALM_TIMING` output (e.g. "thread-realm").
    pub timing_label: &'static str,
    /// Whether the realm was started with watch mode enabled.
    pub watch_mode: bool,
    /// JSON-serialized `RealmOptions.data` payload, if any.
    pub realm_data: Option<String>,
    /// For thread realms: shared atomic that `requestReload()` writes so the
    /// parent can observe the reload intent without a V8 context-scope.
    /// `None` for embedded and process realms.
    pub reload_requested_signal: Option<Arc<AtomicBool>>,
}

// ---------------------------------------------------------------------------
// Shared host loop
// ---------------------------------------------------------------------------

/// Bootstrap a fresh V8 Isolate and run its event loop to completion.
///
/// Handles: isolate creation, `internal/bootstrap.mjs` evaluation, the host loop, and
/// teardown.  The caller is responsible only for setting up the IPC channel and
/// any RAII guards (e.g. `OwnedFd`) before calling here.
pub fn run_child_isolate(config: ChildConfig) -> Result<(), String> {
    use std::time::Instant;

    fn timing_enabled() -> bool {
        static E: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *E.get_or_init(|| std::env::var_os("FINO_REALM_TIMING").is_some())
    }

    crate::runtime::init_v8();

    let label = config.timing_label;
    let total_start = timing_enabled().then(Instant::now);

    let mut params = v8::CreateParams::default();
    params = params.heap_limits(0, 1 << 30);
    params = params.array_buffer_allocator(crate::runtime::shared_allocator().clone());

    let t = timing_enabled().then(Instant::now);
    let isolate = &mut v8::Isolate::new(params);
    if let Some(t) = t {
        eprintln!(
            "[fino:realm-timing] {label}  isolate-new: {:?}",
            t.elapsed()
        );
    }

    // Initialise per-isolate async state for this child isolate's thread.
    crate::async_rt::init();

    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    // Child isolates run on their own OS thread/process — Atomics.wait() is safe.
    isolate.set_allow_atomics_wait(true);
    isolate.set_host_import_module_dynamically_callback(loader::dynamic_import_callback);
    isolate.set_host_initialize_import_meta_object_callback(loader::init_import_meta_callback);

    let isolate_scope = &mut v8::HandleScope::new(isolate);
    let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
    let context = v8::Context::new(isolate_scope, Default::default());
    context.set_microtask_queue(&root_queue);

    let bootstrap_module_global: v8::Global<v8::Module>;
    let state_rc: Rc<RefCell<FinoState>>;

    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        let state = FinoState::new_child(
            config.process_env,
            config.package_map_json,
            root_queue,
            config.import_rules,
            Some(config.entry_path),
            None,
            Some(config.channel_rx),
            Some(config.channel_tx),
            Some(config.wake_read_fd),
            config.wake_write_fd,
            config.watch_mode,
            false, // thread/process realms don't support repl mode
            config.realm_data,
            config.reload_requested_signal,
        );
        context.set_slot(Rc::new(RefCell::new(state)));

        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        let bootstrap_src = include_str!(concat!(env!("OUT_DIR"), "/js/internal/bootstrap.mjs"));
        let bootstrap_map =
            include_str!(concat!(env!("OUT_DIR"), "/js/internal/bootstrap.mjs.map"));

        let t = timing_enabled().then(Instant::now);
        let bootstrap_module = {
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
                    return Err(catch_message(tc).unwrap_or_else(|| {
                        "Failed to compile internal/bootstrap.mjs".to_string()
                    }));
                }
            }
        };
        if let Some(t) = t {
            eprintln!(
                "[fino:realm-timing] {label}  compile:     {:?}",
                t.elapsed()
            );
        }

        loader::register_as_builtin(scope, bootstrap_module, "internal:bootstrap");

        let t = timing_enabled().then(Instant::now);
        {
            let tc = &mut v8::TryCatch::new(scope);
            if bootstrap_module
                .instantiate_module(tc, loader::resolve_module_callback)
                .is_none()
            {
                return Err(catch_message(tc).unwrap_or_else(|| {
                    "Failed to instantiate internal/bootstrap.mjs".to_string()
                }));
            }
        }
        if let Some(t) = t {
            eprintln!(
                "[fino:realm-timing] {label}  instantiate: {:?}",
                t.elapsed()
            );
        }

        let t = timing_enabled().then(Instant::now);
        {
            let tc = &mut v8::TryCatch::new(scope);
            if bootstrap_module.evaluate(tc).is_none() {
                return Err(catch_message(tc)
                    .unwrap_or_else(|| "Failed to evaluate internal/bootstrap.mjs".to_string()));
            }
        }
        pump_and_checkpoint(scope);
        if let Some(t) = t {
            eprintln!(
                "[fino:realm-timing] {label}  evaluate:    {:?}",
                t.elapsed()
            );
        }

        if bootstrap_module.get_status() == v8::ModuleStatus::Errored {
            let exc = bootstrap_module.get_exception();
            return Err(exc
                .to_string(scope)
                .map(|s| s.to_rust_string_lossy(scope))
                .unwrap_or_else(|| "Unknown error in internal/bootstrap.mjs".to_string()));
        }

        state_rc = get_state(scope);
        bootstrap_module_global = v8::Global::new(scope, bootstrap_module);

        if let Some(t) = total_start {
            eprintln!(
                "[fino:realm-timing] {label}  total:       {:?}",
                t.elapsed()
            );
        }
    }

    // -----------------------------------------------------------------------
    // Host loop
    // -----------------------------------------------------------------------
    'main: loop {
        let should_continue = 'step: {
            let scope = &mut v8::ContextScope::new(isolate_scope, context);

            let loop_step_fn = match state_rc.borrow().loop_step_fn.clone() {
                Some(f) => f,
                None => break 'main,
            };

            let should_continue = {
                let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
                v8::Local::new(scope, &loop_step_fn)
                    .call(scope, undef, &[])
                    .map(|v| v.boolean_value(scope))
                    .unwrap_or(false)
            };

            if should_continue {
                // Drain async FFI completions on every iteration (mirrors runtime.rs).
                pump_and_checkpoint(scope);

                let (maybe_fn, maybe_resolver) = {
                    let mut st = state_rc.borrow_mut();
                    (st.sync_call_fn.take(), st.sync_call_resolver.take())
                };

                if let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) {
                    let result: Result<v8::Global<v8::Value>, v8::Global<v8::Value>> = {
                        let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
                        let tc = &mut v8::TryCatch::new(scope);
                        let f = v8::Local::new(tc, &fn_ref);
                        match f.call(tc, undef, &[]) {
                            Some(r) => Ok(v8::Global::new(tc, r)),
                            None => {
                                let exc =
                                    tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                                Err(v8::Global::new(tc, exc))
                            }
                        }
                    };
                    let res_local = v8::Local::new(scope, &resolver_ref);
                    match result {
                        Ok(r) => {
                            let v = v8::Local::new(scope, &r);
                            let _ = res_local.resolve(scope, v);
                        }
                        Err(e) => {
                            let v = v8::Local::new(scope, &e);
                            let _ = res_local.reject(scope, v);
                        }
                    }
                    pump_and_checkpoint(scope);
                }
            }

            break 'step should_continue;
        };

        if !should_continue {
            break 'main;
        }
        realm::process_pending_creates(isolate_scope, &state_rc);
    }

    // -----------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------
    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        realm::terminate_all_children(scope);

        let on_done_fn = state_rc.borrow().on_done_fn.clone();
        if let Some(f) = on_done_fn {
            let undef: v8::Local<v8::Value> = v8::undefined(scope).into();
            v8::Local::new(scope, &f).call(scope, undef, &[]);
            pump_and_checkpoint(scope);
        }

        if let Some(ptr) = state_rc.borrow_mut().cpu_profiler.take() {
            unsafe { crate::profiler::dispose_profiler(ptr) };
        }

        if let Some(ptr) = state_rc.borrow_mut().inspector_state.take() {
            unsafe { crate::inspector_module::dispose_inspector(ptr) };
        }

        // Explicitly release channel_tx before the isolate is disposed. V8 does
        // not run GC on dispose, so the context slot (Rc<FinoState>) — and
        // channel_tx inside it — would otherwise leak.  Dropping it here signals
        // the writer bridge thread (process realm) to exit after flushing.
        state_rc.borrow_mut().channel_tx.take();

        let bm = v8::Local::new(scope, &bootstrap_module_global);
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
