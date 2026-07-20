//! Async context propagation for Fino on V8 via ContinuationPreservedEmbedderData.
//!
//! Exposes `internal:async-context` as a synthetic V8 module. The slot management
//! logic (COW array manipulation, snapshot/restore) lives entirely in JavaScript
//! (`js/context/index.ts`). This module only provides:
//!
//! - `getCPED` / `setCPED`: V8 Torque builtins extracted from the extras binding
//!   object. These compile to direct CPED memory loads/stores on the V8 isolate
//!   and can be inlined by TurboFan/Maglev — no native barrier crossing.
//! - `drainMicrotasks`, `hasPendingV8Tasks`, `scheduleSync`, `runNativeLoop`: host loop
//!   primitives that must remain in Rust.

use ::v8;

use crate::state::{get_state, root_queue_ptr};

fn loop_debug_enabled() -> bool {
    std::env::var_os("FINO_LOOP_DEBUG").is_some()
}

// ---------------------------------------------------------------------------
// internal:async-context synthetic module
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "getCPED",
        "setCPED",
        "drainMicrotasks",
        "hasPendingV8Tasks",
        "scheduleSync",
        "runNativeLoop",
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
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    macro_rules! set_fn {
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }

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

    set_fn!("drainMicrotasks", drain_microtasks);
    set_fn!("hasPendingV8Tasks", has_pending_v8_tasks);
    set_fn!("scheduleSync", schedule_sync);
    set_fn!("runNativeLoop", run_native_loop);

    Some(v8::undefined(scope).into())
}

fn drain_microtasks(
    scope: &mut v8::HandleScope,
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
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set_bool(scope.has_pending_background_tasks());
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
    scope: &mut v8::HandleScope,
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
    let fn_global = v8::Global::new(scope, fn_obj);
    let resolver_global = v8::Global::new(scope, resolver);
    st.sync_calls.push_back((fn_global, resolver_global));
    if loop_debug_enabled() {
        eprintln!("[async-context] scheduleSync queued");
    }

    rv.set(promise.into());
}

/// Called by the bootstrap with `(isDone, onDone, hooks?)` when the realm's
/// loop module is reactor-backed: the Rust host loop drives the reactor itself
/// (wait → dispatch → pump to quiescence → reclassify) and calls only these
/// thin policy callbacks. `hooks` may provide a `flushPorts` function.
fn run_native_loop(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let Ok(is_done) = v8::Local::<v8::Function>::try_from(args.get(0)) else {
        return;
    };
    let on_done = v8::Local::<v8::Function>::try_from(args.get(1)).ok();

    let mut flush_ports_fn = None;
    if let Ok(hooks) = v8::Local::<v8::Object>::try_from(args.get(2)) {
        let hook = |scope: &mut v8::HandleScope, name: &str| {
            v8::String::new(scope, name)
                .and_then(|k| hooks.get(scope, k.into()))
                .and_then(|v| v8::Local::<v8::Function>::try_from(v).ok())
                .map(|f| v8::Global::new(scope, f))
        };
        flush_ports_fn = hook(scope, "flushPorts");
    }

    let state_rc = get_state(scope);
    let mut st = state_rc.borrow_mut();
    st.native_loop = Some(crate::state::NativeLoopHooks {
        is_done_fn: v8::Global::new(scope, is_done),
        flush_ports_fn,
    });
    st.on_done_fn = on_done.map(|f| v8::Global::new(scope, f));
    if loop_debug_enabled() {
        eprintln!("[async-context] runNativeLoop registered");
    }
}
