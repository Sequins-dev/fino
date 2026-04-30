//! Realm (child V8 Context) creation and stepping.
//!
//! Exposes two synthetic modules:
//!
//! - `internal:realm-bridge` — readable from within a child Realm context;
//!   provides the entry path and termination flag stored in the child's FinoState.
//!
//! - `internal:realm-native` — callable from the parent context; creates child
//!   contexts, steps them, and signals termination.
//!
//! Child Realms each have:
//! - Their own `v8::MicrotaskQueue` (explicit policy, per-context drain).
//! - Their own `FinoState` (own module caches, own loop, own providers map).
//! - A `providers` map that starts as a clone of the parent's map, with
//!   child-specific entries applied on top (provider inheritance).
//! - An `entry_path` — the module to dynamically import after bootstrap.
//! - A `terminated` flag that the parent sets to signal shutdown.
//!
//! ## Deferred context creation
//!
//! `v8::Context::new` requires a `&mut HandleScope<()>` (unbound scope).
//! Inside a JS callback only a bound `HandleScope<Context>` is available;
//! calling `HandleScope::new(isolate)` there panics ("active scope can't be
//! dropped").  To avoid this, `native::create_context` only queues a
//! `PendingRealm` and returns a pre-allocated handle index.  The host loop in
//! `runtime.rs` calls `process_pending_creates` between iterations while the
//! ContextScope is not entered, giving access to the bare `isolate_scope`
//! (`HandleScope<()>`).

pub mod broadcast;
pub mod bridge;
pub mod native;
pub mod serializer;
pub mod thread;
pub mod transit;

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::OnceLock,
    time::Instant,
};

use ::v8;

use crate::{
    loader,
    state::{ChildRealm, ChildRealmSlot, FinoState, PendingRealm, get_state, root_queue_ptr},
};

// Public re-exports used by loader.rs (BUILTINS registry).
pub use bridge::create_module as create_realm_bridge_module;
pub use native::create_module as create_realm_native_module;

// ---------------------------------------------------------------------------
// Deferred pending-realm processing
// ---------------------------------------------------------------------------

/// Drain `FinoState::pending_creates` and create each queued child context.
///
/// Must be called with a bare `HandleScope<()>` — i.e. outside any entered
/// context (the ContextScope for the current host-loop iteration must have
/// already been dropped).  On success the slot is upgraded from `Pending` to
/// `Active`; on failure it becomes `Failed`.
pub fn process_pending_creates(
    scope: &mut v8::HandleScope<()>,
    state_rc: &Rc<RefCell<FinoState>>,
) {
    let pending: Vec<PendingRealm> =
        std::mem::take(&mut state_rc.borrow_mut().pending_creates);

    for pending_realm in pending {
        let slot = match create_child_context(
            scope,
            pending_realm.process_env,
            pending_realm.entry_path,
            pending_realm.providers,
            pending_realm.package_map_json,
            pending_realm.port,
        ) {
            Ok(child_realm) => ChildRealmSlot::Active(child_realm),
            Err(e) => {
                eprintln!("fino: failed to create child realm: {e}");
                ChildRealmSlot::Failed
            }
        };
        state_rc.borrow_mut().child_contexts[pending_realm.handle_idx] = slot;
    }
}

// ---------------------------------------------------------------------------
// Stepping a child context
// ---------------------------------------------------------------------------

/// Enter the child context and drive one step of its event loop.
///
/// Mirrors the main host loop in `runtime.rs`:
/// 1. Call `loop_step_fn()` → bool.
/// 2. Service any pending `scheduleSync` call.
/// 3. Pump + checkpoint (drain child microtasks).
///
/// Returns the bool from `loop_step_fn`, or `false` if no step fn is registered.
pub fn step_child_context(
    scope: &mut v8::HandleScope,
    child_context: v8::Local<v8::Context>,
) -> bool {
    let child_scope = &mut v8::ContextScope::new(scope, child_context);

    // Extract loop_step_fn.
    let loop_step_fn = {
        let state_rc = get_state(child_scope);
        state_rc.borrow().loop_step_fn.clone()
    };

    let Some(loop_step_fn) = loop_step_fn else {
        // No step function yet — child bootstrap may still be running.
        pump_and_checkpoint_in(child_scope);
        return true;
    };

    // Call step() → boolean.
    let should_continue = {
        let undef: v8::Local<v8::Value> = v8::undefined(child_scope).into();
        v8::Local::new(child_scope, &loop_step_fn)
            .call(child_scope, undef, &[])
            .map(|v| v.boolean_value(child_scope))
            .unwrap_or(false)
    };

    // Service any pending scheduleSync call (same pattern as runtime.rs host loop).
    {
        let state_rc = get_state(child_scope);
        let (maybe_fn, maybe_resolver) = {
            let mut st = state_rc.borrow_mut();
            (st.sync_call_fn.take(), st.sync_call_resolver.take())
        };

        if let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) {
            let call_result: Result<v8::Global<v8::Value>, v8::Global<v8::Value>> = {
                let undef: v8::Local<v8::Value> = v8::undefined(child_scope).into();
                let tc = &mut v8::TryCatch::new(child_scope);
                let fn_local = v8::Local::new(tc, &fn_ref);
                match fn_local.call(tc, undef, &[]) {
                    Some(result) => Ok(v8::Global::new(tc, result)),
                    None => {
                        let exc = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                        Err(v8::Global::new(tc, exc))
                    }
                }
            };

            match call_result {
                Ok(result_ref) => {
                    let resolver_local = v8::Local::new(child_scope, &resolver_ref);
                    let result_local = v8::Local::new(child_scope, &result_ref);
                    let _ = resolver_local.resolve(child_scope, result_local);
                }
                Err(exc_ref) => {
                    let resolver_local = v8::Local::new(child_scope, &resolver_ref);
                    let exc_local = v8::Local::new(child_scope, &exc_ref);
                    let _ = resolver_local.reject(child_scope, exc_local);
                }
            }

            pump_and_checkpoint_in(child_scope);
        }
    }

    should_continue
}

/// Terminate all child Realms owned by the context at `scope`.
///
/// Sets each child's `terminated` flag, then steps it once so it observes the
/// flag and exits its loop. Called from the host loop in `runtime.rs` after the
/// main loop exits. `Pending` and `Failed` slots are skipped.
pub fn terminate_all_children(scope: &mut v8::HandleScope) {
    let child_contexts: Vec<v8::Global<v8::Context>> = {
        let state_rc = get_state(scope);
        state_rc
            .borrow()
            .child_contexts
            .iter()
            .filter_map(|slot| {
                if let ChildRealmSlot::Active(r) = slot {
                    Some(r.context.clone())
                } else {
                    None
                }
            })
            .collect()
    };

    for child_global in child_contexts {
        // Set terminated flag.
        {
            let child_ctx = v8::Local::new(scope, &child_global);
            let child_scope = &mut v8::ContextScope::new(scope, child_ctx);
            get_state(child_scope).borrow_mut().terminated = true;
        }
        // Step once so the child observes the flag and calls on_done_fn if any.
        let child_ctx = v8::Local::new(scope, &child_global);
        step_child_context(scope, child_ctx);
    }
}

// ---------------------------------------------------------------------------
// Realm creation timing (shared with thread.rs via FINO_REALM_TIMING=1)
// ---------------------------------------------------------------------------

fn realm_timing_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("FINO_REALM_TIMING").is_some())
}

// ---------------------------------------------------------------------------
// Core: create a child V8 context with its own FinoState
// ---------------------------------------------------------------------------

/// Create a child V8 context and bootstrap it.
///
/// Must be called from a bare `HandleScope<()>` (unbound) — i.e. outside any
/// entered context. The host loop satisfies this by calling
/// `process_pending_creates` between iterations when the `ContextScope` for the
/// current iteration has already been dropped.
fn create_child_context(
    scope: &mut v8::HandleScope<()>,
    process_env: crate::state::ProcessEnv,
    entry_path: String,
    providers: HashMap<String, Option<crate::state::ProviderConfig>>,
    package_map_json: Option<String>,
    port: Option<v8::Global<v8::Value>>,
) -> Result<ChildRealm, String> {
    let total_start = if realm_timing_enabled() { Some(Instant::now()) } else { None };

    // 1. Create a dedicated microtask queue for the child context.
    let child_queue = v8::MicrotaskQueue::new(scope, v8::MicrotasksPolicy::Explicit);

    // 2. Create the child V8 context, passing the queue via ContextOptions so
    //    V8 does not check whether a context is already entered (it isn't —
    //    we're in a bare HandleScope<()>).
    let child_context = {
        // Safety: child_queue is a UniqueRef we own; we pass a raw pointer for
        // V8's use. The queue is moved into FinoState immediately after context
        // creation, so it outlives the context it is assigned to.
        #[allow(invalid_reference_casting)]
        let queue_ptr = (&*child_queue as *const v8::MicrotaskQueue) as *mut v8::MicrotaskQueue;
        let ctx = v8::Context::new(
            scope,
            v8::ContextOptions {
                microtask_queue: Some(queue_ptr),
                ..Default::default()
            },
        );
        v8::Global::new(scope, ctx)
    };

    // 3. Enter the child context to initialize its FinoState and run bootstrap.
    {
        let child_ctx_local = v8::Local::new(scope, &child_context);
        let child_scope = &mut v8::ContextScope::new(scope, child_ctx_local);

        let state = FinoState {
            process_env,
            package_map_json,
            root_queue: child_queue,
            providers,
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
            child_contexts: Vec::new(),
            pending_creates: Vec::new(),
            entry_path: Some(entry_path),
            terminated: false,
            port,
            channel_rx: None,
            channel_tx: None,
            wake_read_fd: None,
            wake_write_fd: None,
            thread_contexts: Vec::new(),
        };

        child_ctx_local.set_slot(Rc::new(RefCell::new(state)));

        // 4. Initialize CPED with an empty JS Array (live async-context frame).
        let initial_frame = v8::Array::new(child_scope, 0);
        child_scope.set_continuation_preserved_embedder_data(initial_frame.into());

        // 5. Compile and evaluate _bootstrap.mjs in the child context.
        //    _bootstrap.mts detects it's in a child Realm (entry_path is set),
        //    auto-imports the entry module, and calls driveLoop — so
        //    loop_step_fn is registered by the time pump_and_checkpoint returns.
        let bootstrap_src = include_str!(concat!(env!("OUT_DIR"), "/js/_bootstrap.mjs"));
        let bootstrap_map = include_str!(concat!(env!("OUT_DIR"), "/js/_bootstrap.mjs.map"));

        let compile_start = if realm_timing_enabled() { Some(Instant::now()) } else { None };
        let bootstrap_module = {
            let tc = &mut v8::TryCatch::new(child_scope);
            loader::register_source_map_from_json(tc, "_bootstrap.mjs", bootstrap_map);
            match loader::compile_source_module(
                tc,
                bootstrap_src,
                "_bootstrap.mjs",
                Some(bootstrap_map),
            ) {
                Some(m) => m,
                None => {
                    let msg = catch_js_message(tc)
                        .unwrap_or_else(|| "Failed to compile _bootstrap.mjs".to_string());
                    return Err(msg);
                }
            }
        };
        if let Some(t) = compile_start {
            eprintln!("[fino:realm-timing] embedded-realm  compile:     {:?}", t.elapsed());
        }

        // Register as "internal:bootstrap" so resolve_builtin_relative can
        // look up its source path and correctly resolve relative imports
        // like './runtime/loop.mts' within the bootstrap module body.
        loader::register_as_builtin(child_scope, bootstrap_module, "internal:bootstrap");

        let instantiate_start = if realm_timing_enabled() { Some(Instant::now()) } else { None };
        {
            let tc = &mut v8::TryCatch::new(child_scope);
            if bootstrap_module
                .instantiate_module(tc, loader::resolve_module_callback)
                .is_none()
            {
                let msg = catch_js_message(tc)
                    .unwrap_or_else(|| "Failed to instantiate _bootstrap.mjs".to_string());
                return Err(msg);
            }
        }
        if let Some(t) = instantiate_start {
            eprintln!("[fino:realm-timing] embedded-realm  instantiate: {:?}", t.elapsed());
        }

        let evaluate_start = if realm_timing_enabled() { Some(Instant::now()) } else { None };
        {
            let tc = &mut v8::TryCatch::new(child_scope);
            if bootstrap_module.evaluate(tc).is_none() {
                let msg = catch_js_message(tc)
                    .unwrap_or_else(|| "Failed to evaluate _bootstrap.mjs".to_string());
                return Err(msg);
            }
        }

        // 6. Pump + checkpoint to run the bootstrap module body.
        pump_and_checkpoint_in(child_scope);
        if let Some(t) = evaluate_start {
            eprintln!("[fino:realm-timing] embedded-realm  evaluate:    {:?}", t.elapsed());
        }

        if bootstrap_module.get_status() == v8::ModuleStatus::Errored {
            let exc = bootstrap_module.get_exception();
            let msg = exc
                .to_string(child_scope)
                .map(|s| s.to_rust_string_lossy(child_scope))
                .unwrap_or_else(|| "Error in _bootstrap.mjs".to_string());
            return Err(msg);
        }
    }

    if let Some(t) = total_start {
        eprintln!("[fino:realm-timing] embedded-realm  total:       {:?}", t.elapsed());
    }

    Ok(ChildRealm {
        context: child_context,
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn pump_and_checkpoint_in(scope: &mut v8::HandleScope) {
    let platform = v8::V8::get_current_platform();
    while v8::Platform::pump_message_loop(&platform, scope, false) {}
    let state_rc = get_state(scope);
    let queue_ptr = unsafe { root_queue_ptr(&state_rc) };
    let isolate: &mut v8::Isolate = scope.as_mut();
    unsafe { &*queue_ptr }.perform_checkpoint(isolate);
}

fn catch_js_message(tc: &mut v8::TryCatch<v8::HandleScope>) -> Option<String> {
    if !tc.has_caught() {
        return None;
    }
    tc.exception().and_then(|exc| {
        exc.to_object(tc)
            .and_then(|obj| {
                v8::String::new(tc, "stack").and_then(|key| obj.get(tc, key.into()))
            })
            .and_then(|stack| stack.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
            .or_else(|| exc.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
    })
}
