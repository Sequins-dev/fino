//! `FfiCallback` — expose a JS function as a C-callable function pointer.
//!
//! Creates a libffi `Closure` that, when invoked by C code on a **non-V8
//! thread**, marshals the C arguments across to the V8 thread, invokes the JS
//! function (which may return a Promise), and blocks the calling C thread
//! until the JS function settles.
//!
//! # Limitation
//! Calling an `FfiCallback` from the V8 thread itself is not supported for
//! the first version — it would require a re-entrant scope, which is
//! non-trivial. Use `FfiCallback` with `async: true` FFI symbols (where the
//! C function runs on the blocking pool) or with C libraries that call
//! callbacks from their own threads.

use std::ffi::c_void;
use std::os::unix::io::RawFd;
use std::sync::{Arc, Condvar, Mutex};

use libffi::low::Callback;
use libffi::middle::{Cif, Closure};
use libffi::raw::ffi_cif;

use crate::async_rt::js_calls::{self, JsCallRequest, SendArg};
use crate::ffi::types::NativeType;

// ---------------------------------------------------------------------------
// Per-callback userdata — stored in a `Box` that is leaked to give `'static`.
// Freed explicitly in `FfiCallbackInner::drop`.
// ---------------------------------------------------------------------------

struct CallbackData {
    callback_id: usize,
    param_types: Vec<NativeType>,
    result_type: NativeType,
    js_call_requests: Arc<Mutex<Vec<JsCallRequest>>>,
    wake_write: RawFd,
}

// SAFETY: only primitive types and Arc (Send).
unsafe impl Send for CallbackData {}
unsafe impl Sync for CallbackData {}

// ---------------------------------------------------------------------------
// The libffi trampoline (called by C code on whatever thread it uses)
// ---------------------------------------------------------------------------

unsafe extern "C" fn trampoline(
    _cif: &ffi_cif,
    result: &mut c_void,
    args: *const *const c_void,
    userdata: &CallbackData,
) {
    let data = userdata;
    let result_ptr: *mut c_void = result as *mut c_void;

    // Guard: if called from the V8 thread, a condvar wait would deadlock.
    if crate::async_rt::is_v8_thread() {
        eprintln!(
            "FfiCallback: called from V8 thread — same-thread callbacks are not yet \
             supported. Returning zero/void."
        );
        if !result_ptr.is_null() {
            unsafe { std::ptr::write_bytes(result_ptr as *mut u8, 0, 8) };
        }
        return;
    }

    // Read C arguments.
    let send_args: Vec<SendArg> = data
        .param_types
        .iter()
        .enumerate()
        .map(|(i, ty)| {
            let arg_ptr: *const c_void = unsafe { *args.add(i) };
            unsafe { js_calls::read_c_arg(arg_ptr, ty) }
        })
        .collect();

    // Create a condvar slot for the result.
    let slot: Arc<(Mutex<Option<Result<js_calls::CallResult, String>>>, Condvar)> =
        Arc::new((Mutex::new(None), Condvar::new()));

    let request = JsCallRequest {
        callback_id: data.callback_id,
        args: send_args,
        param_types: data.param_types.clone(),
        result_slot: Arc::clone(&slot),
    };

    // Submit to the V8 thread queue and wake the event loop.
    data.js_call_requests.lock().unwrap().push(request);
    unsafe {
        libc::write(data.wake_write, b"\x01".as_ptr() as *const c_void, 1);
    }

    // Block until the V8 thread fills the slot.
    let (lock, cvar) = slot.as_ref();
    let mut guard = lock.lock().unwrap();
    while guard.is_none() {
        guard = cvar.wait(guard).unwrap();
    }
    let outcome = guard.take().unwrap();

    // Write the result into C's return-value buffer.
    unsafe { js_calls::write_c_result(result_ptr, &data.result_type, outcome) };
}

// ---------------------------------------------------------------------------
// Public handle — stores the Closure and manages its lifetime
// ---------------------------------------------------------------------------

/// Holds a libffi `Closure` and its associated `CallbackData`.
///
/// Dropped explicitly by `close()`. The function pointer is valid as long as
/// this struct is alive.
pub struct FfiCallbackInner {
    // `Drop::drop` runs before field drops. We free `userdata_ptr` there;
    // the closure is still technically alive at that point, but no C code
    // can reach it after close() is called, so this is safe.
    closure: Closure<'static>,
    userdata_ptr: *mut CallbackData,
}

// SAFETY: FfiCallbackInner is only accessed from the V8 thread.
unsafe impl Send for FfiCallbackInner {}

impl Drop for FfiCallbackInner {
    fn drop(&mut self) {
        if !self.userdata_ptr.is_null() {
            unsafe { drop(Box::from_raw(self.userdata_ptr)) };
        }
        // `closure` drops automatically after this impl returns.
    }
}

/// Opaque handle stored as a `v8::External` on the JS object.
pub struct CallbackHandle {
    /// `Some` when open, `None` after `close()`.
    pub inner: Option<FfiCallbackInner>,
    pub id: usize,
    /// Raw function pointer for passing to C as a `pointer` argument.
    pub code_ptr: *mut c_void,
}

// ---------------------------------------------------------------------------
// Constructor (called from src/ffi/mod.rs)
// ---------------------------------------------------------------------------

/// Build a new `FfiCallback`.
///
/// Returns `(handle_ptr, code_ptr)` where `handle_ptr` is a
/// `Box::into_raw(Box<CallbackHandle>)` to store as a `v8::External`.
///
/// # Errors
/// Returns a human-readable error string on failure.
pub fn new_callback(
    param_types: Vec<NativeType>,
    result_type: NativeType,
    func_global: v8::Global<v8::Function>,
) -> Result<(*mut CallbackHandle, *mut c_void), String> {
    let (js_call_requests, wake_write) = crate::async_rt::js_call_handle()
        .ok_or("FfiCallback: runtime not initialised")?;

    let callback_id = js_calls::register_callback(func_global);

    // Build the libffi CIF.
    let ffi_params: Vec<_> = param_types.iter().map(|t| t.to_ffi_type()).collect();
    let ffi_result = result_type.to_ffi_type();
    let cif = Cif::new(ffi_params.into_iter(), ffi_result);

    // Leak the userdata so the closure can hold a `'static` reference.
    let userdata = Box::new(CallbackData {
        callback_id,
        param_types: param_types.clone(),
        result_type,
        js_call_requests,
        wake_write,
    });
    let userdata_ptr: *mut CallbackData = Box::into_raw(userdata);
    let userdata_ref: &'static CallbackData = unsafe { &*userdata_ptr };

    // Create the libffi closure.
    let closure: Closure<'static> = Closure::new(
        cif,
        trampoline as Callback<CallbackData, c_void>,
        userdata_ref,
    );

    // Extract the callable function pointer (valid as long as closure lives).
    let code_ptr = *closure.code_ptr() as usize as *mut c_void;

    let inner = FfiCallbackInner { closure, userdata_ptr };
    let handle = Box::new(CallbackHandle {
        inner: Some(inner),
        id: callback_id,
        code_ptr,
    });
    Ok((Box::into_raw(handle), code_ptr))
}
