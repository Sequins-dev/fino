//! Async context propagation for Fino on V8 via ContinuationPreservedEmbedderData.
//!
//! Exposes `internal:async-context` as a synthetic V8 module. The slot management
//! logic (COW array manipulation, snapshot/restore) lives entirely in JavaScript
//! (`js/context/index.ts`). This module only provides:
//!
//! - `getCPED` / `setCPED`: V8 Torque builtins extracted from the extras binding
//!   object. These compile to direct CPED memory loads/stores on the V8 isolate
//!   and can be inlined by TurboFan/Maglev — no native barrier crossing.
//! - `drainMicrotasks`, `hasPendingV8Tasks`, `hasPendingNativeTasks`,
//!   `scheduleSync`, `runLoop`: host loop
//!   primitives that must remain in Rust.

use ::v8;

use crate::state::{get_state, root_queue_ptr};

fn loop_debug_enabled() -> bool {
    std::env::var_os("FINO_LOOP_DEBUG").is_some()
}

// ---------------------------------------------------------------------------
// internal:async-context synthetic module
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "getCPED",
        "setCPED",
        "drainMicrotasks",
        "hasPendingV8Tasks",
        "hasPendingNativeTasks",
        "scheduleSync",
        "runLoop",
    ]
    .iter()
    .map(|n| v8::String::new(scope, n).unwrap())
    .collect();

    let module_name = v8::String::new(scope, "internal:async-context").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    v8::callback_scope!(unsafe let scope, context);

    // Extract getContinuationPreservedEmbedderData / setContinuationPreservedEmbedderData
    // from the V8 extras binding object. These are Torque builtins that compile to
    // direct CPED memory loads/stores on the V8 isolate — callable from JS without
    // crossing the native barrier. TurboFan/Maglev can inline them at call sites.
    let extras = context.get_extras_binding_object(scope);
    let get_cped_key = v8::String::new(scope, "getContinuationPreservedEmbedderData")?;
    let set_cped_key = v8::String::new(scope, "setContinuationPreservedEmbedderData")?;
    let get_cped_fn: v8::Local<v8::Function> =
        extras.get(scope, get_cped_key.into())?.try_into().ok()?;
    let set_cped_fn: v8::Local<v8::Function> =
        extras.get(scope, set_cped_key.into())?.try_into().ok()?;

    let key = v8::String::new(scope, "getCPED")?;
    module.set_synthetic_module_export(scope, key, get_cped_fn.into())?;
    let key = v8::String::new(scope, "setCPED")?;
    module.set_synthetic_module_export(scope, key, set_cped_fn.into())?;

    crate::set_fn!(scope, module, "drainMicrotasks", drain_microtasks);
    crate::set_fn!(scope, module, "hasPendingV8Tasks", has_pending_v8_tasks);
    crate::set_fn!(
        scope,
        module,
        "hasPendingNativeTasks",
        has_pending_native_tasks
    );
    crate::set_fn!(scope, module, "scheduleSync", schedule_sync);
    crate::set_fn!(scope, module, "runLoop", run_loop);

    Some(v8::undefined(scope).into())
}

fn drain_microtasks(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut _rv: v8::ReturnValue,
) {
    // Drain V8 platform foreground tasks first (e.g. WASM background
    // compilation callbacks). These post promise resolutions, which in turn
    // enqueue microtasks, so foreground tasks must run before the checkpoint.
    let platform = v8::V8::get_current_platform();
    while v8::Platform::pump_message_loop(&platform, scope, false) {}

    let state_rc = get_state(scope);
    let queue_ptr = unsafe { root_queue_ptr(&state_rc) };
    let isolate: &mut v8::Isolate = scope.as_mut();
    unsafe { &*queue_ptr }.perform_checkpoint(isolate);
}

/// Returns true if V8 has pending background tasks (e.g. WASM compilation in
/// flight). JS uses this to keep the event loop alive while V8 background
/// work is in progress, even when no I/O is registered.
///
/// Foreground task pumping (draining completion callbacks from background
/// threads) is handled by `drainMicrotasks()` — not here. Calling
/// `pump_message_loop` here would cause infinite loops because V8 continuously
/// posts JIT/TurboFan optimization tasks.
fn has_pending_v8_tasks(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set_bool(scope.has_pending_background_tasks());
}

/// Returns true while a native async call still owns a Promise resolver for
/// this isolate. The Realm may park and migrate while its completion is in flight.
fn has_pending_native_tasks(
    _scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set_bool(crate::async_rt::has_pending_resolvers());
}

/// Schedule `fn` to be called from Rust outside any microtask checkpoint.
///
/// V8's `PerformCheckpoint` is a no-op when called re-entrantly from within a
/// running microtask, so `drainMicrotasks()` → `spin()` deadlocks when invoked
/// from an async test callback.  This function stores `fn` in `FinoState` so
/// that the Rust event loop calls it between `perform_checkpoint` invocations,
/// where `is_running_microtasks_` is false and `drainMicrotasks()` works.
///
/// Returns a Promise that resolves (or rejects) with the return value of `fn`.
fn schedule_sync(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let fn_val: v8::Local<v8::Value> = args.get(0);
    let Some(fn_obj) = v8::Local::<v8::Function>::try_from(fn_val).ok() else {
        return;
    };

    let Some(resolver) = v8::PromiseResolver::new(scope) else {
        return;
    };
    let promise = resolver.get_promise(scope);

    let state_rc = get_state(scope);
    let mut st = state_rc.borrow_mut();
    st.sync_call_fn = Some(v8::Global::new(scope, fn_obj));
    st.sync_call_resolver = Some(v8::Global::new(scope, resolver));
    if loop_debug_enabled() {
        eprintln!("[async-context] scheduleSync queued");
    }

    rv.set(promise.into());
}

/// Called by `driveLoop` with `(step, onDone)` to hand off host-safe loop
/// stepping to Rust. JS owns scheduling policy; Rust only calls `step()`
/// outside checkpoints and services deferred sync work between calls.
///
/// `step()` returns a progress count: negative means the realm is finished,
/// zero means it is alive but quiescent, and positive means it did work. The
/// reactor scheduler in `scheduler_native` uses that distinction to park a
/// realm instead of spinning on it.
fn run_loop(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let state_rc = get_state(scope);
    let mut st = state_rc.borrow_mut();
    st.loop_step_fn = v8::Local::<v8::Function>::try_from(args.get(0))
        .ok()
        .map(|f| v8::Global::new(scope, f));
    st.on_done_fn = v8::Local::<v8::Function>::try_from(args.get(1))
        .ok()
        .map(|f| v8::Global::new(scope, f));
}
