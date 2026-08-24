//! `internal:async-runtime` synthetic V8 module.
//!
//! Exports:
//! - `wakeFd: number`    — read end of the per-isolate self-pipe. JS registers
//!                          this with `loop.readable(fd)` so kqueue/io_uring
//!                          wakes immediately when async FFI work completes.
//! - `drainWakes(): void` — read all pending bytes from the pipe and tell the
//!                          Rust layer to drain async FFI completions on the
//!                          next `pump_and_checkpoint`. Called by JS after
//!                          `loop.readable(wakeFd)` resolves.

use ::v8;

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["wakeFd", "drainWakes"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();

    let module_name = v8::String::new(scope, "internal:async-runtime").unwrap();

    // The synthetic module callback must be a zero-sized fn pointer (no captures).
    // We read the wake fd directly from the thread-local async state inside eval_steps.
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    v8::callback_scope!(unsafe let scope, context);

    // Read the wake fd from the per-isolate async state (thread-local).
    let wake_fd = crate::async_rt::get_wake_read_fd();

    // Export wakeFd as an integer.
    let fd_val = v8::Integer::new(scope, wake_fd);
    let fd_key = v8::String::new(scope, "wakeFd")?;
    module.set_synthetic_module_export(scope, fd_key, fd_val.into())?;

    // Export drainWakes — JS calls this after readable(wakeFd) fires.
    // The actual draining happens in pump_and_checkpoint; this function
    // is a no-op (the drain happens automatically). It exists so JS can
    // call it explicitly for clarity and future extensibility.
    let drain_tmpl = v8::FunctionTemplate::new(scope, drain_wakes_cb);
    let drain_fn = drain_tmpl.get_function(scope)?;
    let drain_key = v8::String::new(scope, "drainWakes")?;
    module.set_synthetic_module_export(scope, drain_key, drain_fn.into())?;

    Some(v8::undefined(scope).into())
}

fn drain_wakes_cb(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    // Eagerly drain async FFI completions so the Promises resolve in the
    // same event-loop tick that the wake pipe fired, without waiting for the
    // next scheduleSync checkpoint. This keeps async FFI Promise resolution
    // latency at "one kqueue wakeup" regardless of test-framework mechanics.
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
