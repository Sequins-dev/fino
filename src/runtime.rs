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

    // isolate_scope is a bare HandleScope<()>; the root context is re-entered
    // for each host-loop iteration.
    let isolate_scope = &mut v8::HandleScope::new(isolate);

    // Create root microtask queue.
    let root_queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);

    // Create context and assign the root queue to it.
    let context = v8::Context::new(isolate_scope, Default::default());
    context.set_microtask_queue(&root_queue);

    // Keep a Global for the main module so it survives across ContextScope
    // block boundaries (v8::Local lifetimes are tied to the scope they were
    // created in).
    let main_module_global: v8::Global<v8::Module>;

    // Keep the root state across ContextScope iterations.
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

        context.set_slot(Rc::new(RefCell::new(state)));

        // Initialize the CPED with an empty JS Array — this becomes the live
        // async context frame. Must happen before any JS code runs.
        let initial_frame = v8::Array::new(scope, 0);
        scope.set_continuation_preserved_embedder_data(initial_frame.into());

        // Compile and evaluate internal/main.mjs.
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

        // Register internal/main.mjs so its specifier is known for import-rule `from` matching.
        // Using "internal:main" places it in the internal: namespace so the default
        // rules allow it to import other internal: modules.
        loader::register_as_builtin(scope, main_module, "internal:main");

        // Instantiate.
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

        // Evaluate.  V8 defers the module body to the microtask queue; the actual
        // module code runs during the first perform_checkpoint below.
        {
            let tc = &mut v8::TryCatch::new(scope);
            if main_module.evaluate(tc).is_none() {
                let msg = catch_message(tc)
                    .unwrap_or_else(|| "Failed to evaluate internal/main.mjs".to_string());
                return Err(msg);
            }
        }

        // First pump + checkpoint: runs internal/main.ts module body as a microtask.
        // The module body calls runNativeLoop(...) from internal:async-context,
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
    // Each iteration re-enters the root context and calls its native loop
    // policy hooks. Child realms are owned by scheduler reactors, so the root
    // host has no child-context stepping phase.
    //
    // Using a named loop label so `break` inside the inner block exits here.
    // -----------------------------------------------------------------------
    'main: loop {
        let should_continue = {
            let scope = &mut v8::ContextScope::new(isolate_scope, context);

            // The realm's loop is reactor-backed: Rust owns the pump cadence
            // and calls only thin JS policy hooks. No hooks means bootstrap
            // never called driveLoop (e.g. argv.length < 2) — nothing to run.
            if state_rc.borrow().native_loop.is_none() {
                break 'main;
            }
            native_drive_step(scope, &state_rc)
        }; // ContextScope dropped — isolate_scope is free.

        if !should_continue {
            break 'main;
        }

        // Create any child contexts queued during the JS step.
    }

    // -----------------------------------------------------------------------
    // Teardown: terminate children, call onDone, dispose profiler.
    // -----------------------------------------------------------------------
    {
        let scope = &mut v8::ContextScope::new(isolate_scope, context);

        // Terminate all child Realms (structured concurrency: parent loop done →
        // signal termination to all children, then step each once so they observe
        // the flag and call their on_done_fn if any).

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

        // Dispose the CPU profiler if it was created.
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
    let (maybe_fn, maybe_resolver) = {
        let mut st = state_rc.borrow_mut();
        (st.sync_call_fn.take(), st.sync_call_resolver.take())
    };
    let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) else {
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
    if out.is_none() && std::env::var_os("FINO_LOOP_DEBUG").is_some() {
        let msg = tc
            .exception()
            .and_then(|e| e.to_string(tc))
            .map(|s| s.to_rust_string_lossy(tc))
            .unwrap_or_default();
        eprintln!("[native-drive] policy hook threw: {msg}");
    }
    out
}

/// One iteration of the native host loop for a reactor-backed realm: pump
/// everything ready to a fixed point, run the thin JS policy hooks, decide
/// doneness (§5 of the reactor doc: realm policy done AND reactor quiescent
/// AND no children), then block on the reactor until the next completion.
/// Returns false when the realm is finished (or a policy hook threw).
pub(crate) fn native_drive_step(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    native_drive_step_inner(scope, state_rc, true)
}

/// Native-drive iteration without the trailing reactor wait. Reactor engines
/// use this because the engine owns the thread's wait cadence.
pub(crate) fn native_drive_step_nonblocking(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    let cont = native_drive_step_inner(scope, state_rc, false);
    if !cont && std::env::var_os("FINO_LOOP_DEBUG").is_some() {
        eprintln!(
            "[reload] nonblocking realm step returned false at {:?}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );
    }
    cont
}

fn native_drive_step_inner(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
    wait: bool,
) -> bool {
    use std::time::Duration;

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
    // body queues the next scheduleSync). Blocking with any of it pending
    // would strand the loop — nothing about it wakes the reactor.
    let mut activity = false;
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

        let sync_pending = state_rc.borrow().sync_call_fn.is_some();
        if flushed || serviced || sync_pending {
            activity = true;
            continue;
        }
        break;
    }
    // Sample the exit inputs only now, after the last pump, so a wind-down
    // that completed inside the settle loop is observed.
    let Some(done) = evaluate(scope) else {
        return false;
    };

    let owner = std::rc::Rc::as_ptr(state_rc) as usize;
    let live = crate::reactor::drive_live(owner) || scope.has_pending_background_tasks();
    if std::env::var_os("FINO_LOOP_DEBUG").is_some() {
        eprintln!(
            "[native-drive] done={done} reactor_live={} bg_tasks={} counts={}",
            crate::reactor::drive_live(owner),
            scope.has_pending_background_tasks(),
            crate::reactor::drive_counts_debug(owner),
        );
    }
    if done && !live {
        return false;
    }

    if wait {
        // Block until a completion — the reactor is the wake source for all
        // asynchrony. Bound the wait only where progress can happen without
        // one: Atomics resolutions / V8 background tasks post foreground work
        // without touching the reactor. Bounded waits back off adaptively
        // (hot re-pass while work flows, 25ms once quiet): an embedded child
        // advances one legacy step per iteration, so a multi-turn ladder —
        // e.g. a respawning realm loading its module graph — must not pay a
        // sleep per rung.
        let bounded = crate::reactor::drive_needs_poll() || scope.has_pending_background_tasks();
        let timeout = if bounded {
            let quiet = state_rc.borrow().native_empty_ticks;
            Some(if quiet >= 3 {
                Duration::from_millis(25)
            } else {
                Duration::ZERO
            })
        } else {
            None
        };
        let dispatched = crate::reactor::drive_wait_and_dispatch(scope, timeout);
        let mut st = state_rc.borrow_mut();
        if dispatched > 0 || activity {
            st.native_empty_ticks = 0;
        } else {
            st.native_empty_ticks = st.native_empty_ticks.saturating_add(1);
        }
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
