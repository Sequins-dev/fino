//! Async context propagation for Fino on V8 via ContinuationPreservedEmbedderData.
//!
//! The live async-context frame is stored as a JS Array in V8's CPED slot.
//! V8 automatically captures the CPED reference when a continuation is enqueued
//! and restores it before each `.then()` callback fires — no promise hook needed.
//!
//! **COW invariant**: `setSlot()` and `clearSlot()` always create a NEW array
//! (shallow copy + modification) rather than mutating in place. V8 holds a
//! reference to the array at enqueue time; in-place mutation would corrupt
//! previously-captured frames.
//!
//! `createSlot()` is the only exception: it runs during synchronous module init
//! and simply pushes `undefined` at a new index, which is safe because no
//! continuation has yet captured the array.

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
        "createSlot",
        "getSlot",
        "setSlot",
        "clearSlot",
        "snapshot",
        "restore",
        "drainMicrotasks",
        "hasPendingV8Tasks",
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
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    macro_rules! set_fn {
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }

    set_fn!("createSlot", create_slot);
    set_fn!("getSlot", get_slot);
    set_fn!("setSlot", set_slot);
    set_fn!("clearSlot", clear_slot);
    set_fn!("snapshot", snapshot);
    set_fn!("restore", restore);
    set_fn!("drainMicrotasks", drain_microtasks);
    set_fn!("hasPendingV8Tasks", has_pending_v8_tasks);
    set_fn!("scheduleSync", schedule_sync);
    set_fn!("runLoop", run_loop);

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// Slot functions
// ---------------------------------------------------------------------------

fn create_slot(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let id = {
        let mut st = state_rc.borrow_mut();
        let id = st.slot_count;
        st.slot_count += 1;
        id
    };

    // Extend the live CPED array in place with `undefined` at the new index.
    // This is safe: createSlot only runs during synchronous module init, so no
    // continuation has captured the current array yet.
    let frame = scope.get_continuation_preserved_embedder_data();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(frame) {
        let undef = v8::undefined(scope);
        arr.set_index(scope, id, undef.into());
    }

    rv.set(v8::Number::new(scope, id as f64).into());
}

fn get_slot(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = match get_u32_arg(scope, &args, 0, "getSlot") {
        Ok(v) => v,
        Err(()) => return,
    };

    let frame = scope.get_continuation_preserved_embedder_data();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(frame)
        && id < arr.length()
        && let Some(val) = arr.get_index(scope, id)
    {
        rv.set(val);
        return;
    }
    rv.set(v8::undefined(scope).into());
}

fn set_slot(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut _rv: v8::ReturnValue,
) {
    let id = match get_u32_arg(scope, &args, 0, "setSlot") {
        Ok(v) => v,
        Err(()) => return,
    };
    let value: v8::Local<v8::Value> = args.get(1);

    let state_rc = get_state(scope);
    let slot_count = state_rc.borrow().slot_count;

    // COW: create a new array, copy current frame, write new value at id.
    let len = slot_count;
    let new_arr = v8::Array::new(scope, len as i32);
    let frame = scope.get_continuation_preserved_embedder_data();
    if let Ok(old) = v8::Local::<v8::Array>::try_from(frame) {
        for i in 0..len {
            let v = old
                .get_index(scope, i)
                .unwrap_or_else(|| v8::undefined(scope).into());
            new_arr.set_index(scope, i, v);
        }
    }
    new_arr.set_index(scope, id, value);
    scope.set_continuation_preserved_embedder_data(new_arr.into());
}

fn clear_slot(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut _rv: v8::ReturnValue,
) {
    let id = match get_u32_arg(scope, &args, 0, "clearSlot") {
        Ok(v) => v,
        Err(()) => return,
    };

    let state_rc = get_state(scope);
    let slot_count = state_rc.borrow().slot_count;

    // COW: create a new array with `undefined` at index id.
    let len = slot_count;
    let new_arr = v8::Array::new(scope, len as i32);
    let undef = v8::undefined(scope);
    let frame = scope.get_continuation_preserved_embedder_data();
    if let Ok(old) = v8::Local::<v8::Array>::try_from(frame) {
        for i in 0..len {
            let v = old.get_index(scope, i).unwrap_or_else(|| undef.into());
            new_arr.set_index(scope, i, v);
        }
    }
    new_arr.set_index(scope, id, undef.into());
    scope.set_continuation_preserved_embedder_data(new_arr.into());
}

fn snapshot(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let frame = scope.get_continuation_preserved_embedder_data();
    let global = v8::Global::new(scope, frame);

    let state_rc = get_state(scope);
    let id = {
        let mut st = state_rc.borrow_mut();
        let id = st.snapshot_store.len() as u32;
        st.snapshot_store.push(global);
        id
    };

    rv.set(v8::Number::new(scope, id as f64).into());
}

fn restore(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut _rv: v8::ReturnValue,
) {
    let id = match get_u32_arg(scope, &args, 0, "restore") {
        Ok(v) => v,
        Err(()) => return,
    };

    let state_rc = get_state(scope);
    let (maybe_global, slot_count) = {
        let st = state_rc.borrow();
        let g = st.snapshot_store.get(id as usize).cloned();
        (g, st.slot_count)
    };

    if let Some(global) = maybe_global {
        let stored = v8::Local::new(scope, &global);
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(stored) {
            if arr.length() >= slot_count {
                // Array is at least as long as current slot count — use directly.
                scope.set_continuation_preserved_embedder_data(arr.into());
            } else {
                // New slots were created after this snapshot; extend with undefined.
                let new_arr = v8::Array::new(scope, slot_count as i32);
                let undef = v8::undefined(scope);
                for i in 0..slot_count {
                    let v = if i < arr.length() {
                        arr.get_index(scope, i).unwrap_or_else(|| undef.into())
                    } else {
                        undef.into()
                    };
                    new_arr.set_index(scope, i, v);
                }
                scope.set_continuation_preserved_embedder_data(new_arr.into());
            }
        }
    }
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
    st.sync_call_fn = Some(v8::Global::new(scope, fn_obj));
    st.sync_call_resolver = Some(v8::Global::new(scope, resolver));
    if loop_debug_enabled() {
        eprintln!("[async-context] scheduleSync queued");
    }

    rv.set(promise.into());
}

/// Called by `_main.mts` with `(step, onDone)` to hand off host-safe loop
/// stepping to Rust. JS owns scheduling policy; Rust only calls `step()`
/// outside checkpoints and services deferred sync work between calls.
fn run_loop(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let mut st = state_rc.borrow_mut();
    st.loop_step_fn = v8::Local::<v8::Function>::try_from(args.get(0))
        .ok()
        .map(|f| v8::Global::new(scope, f));
    st.on_done_fn = v8::Local::<v8::Function>::try_from(args.get(1))
        .ok()
        .map(|f| v8::Global::new(scope, f));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn get_u32_arg(
    scope: &mut v8::HandleScope,
    args: &v8::FunctionCallbackArguments,
    index: i32,
    fn_name: &str,
) -> Result<u32, ()> {
    let val: v8::Local<v8::Value> = args.get(index);
    if val.is_number() {
        Ok(val.number_value(scope).unwrap_or(0.0) as u32)
    } else {
        let msg = v8::String::new(scope, &format!("{fn_name}: expected u32 argument")).unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        Err(())
    }
}
