//! Cross-thread JS callback invocation bridge.
//!
//! Blocking threads (e.g. the sqlite DB thread) can invoke JS callback
//! functions registered via [`register_callback`] and block until the JS
//! function resolves. The JS function may return a Promise — the bridge
//! awaits it on the LocalExecutor and wakes the blocking thread when done.

use std::ffi::c_void;
use std::sync::{Arc, Condvar, Mutex};

use ::v8;
use smallvec::SmallVec;

use crate::async_rt::bridge::{JsValueRepr, promise_to_future};
use crate::ffi::types::NativeType;

macro_rules! caught_exception_message {
    ($scope:expr) => {{
        if let Some(exception) = (&mut *$scope).exception() {
            if let Ok(obj) = v8::Local::<v8::Object>::try_from(exception) {
                if let Some(key) = v8::String::new(&mut *$scope, "stack") {
                    if let Some(stack) = obj.get(&mut *$scope, key.into()) {
                        if !stack.is_null_or_undefined() {
                            if let Some(stack) = stack.to_string(&mut *$scope) {
                                stack.to_rust_string_lossy(&mut *$scope)
                            } else {
                                exception.to_rust_string_lossy(&mut *$scope)
                            }
                        } else {
                            exception.to_rust_string_lossy(&mut *$scope)
                        }
                    } else {
                        exception.to_rust_string_lossy(&mut *$scope)
                    }
                } else {
                    exception.to_rust_string_lossy(&mut *$scope)
                }
            } else {
                exception.to_rust_string_lossy(&mut *$scope)
            }
        } else {
            "unknown exception".into()
        }
    }};
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A scalar return value that is `Send` (no V8 handles).
pub enum CallResult {
    Void,
    Bool(bool),
    I32(i32),
    U32(u32),
    I64(i64),
    U64(u64),
    F64(f64),
    // The payload is captured for symmetry with the other reprs, but string
    // returns currently coerce to 0 at the FFI word boundary.
    String(#[allow(dead_code)] String),
    Bytes(Vec<u8>),
}

/// An argument value serialised from the C trampoline thread for the V8 thread.
pub enum SendArg {
    Integer(i64),
    Float(f64),
    /// Raw pointer address; converted to a fino pointer ArrayBuffer on the V8 thread.
    Pointer(usize),
    /// Native pointer argument intentionally omitted from the JS callback.
    Ignored,
}

/// A pending JS callback invocation.
pub struct JsCallRequest {
    pub callback_id: usize,
    pub args: Vec<SendArg>,
    pub param_types: Vec<NativeType>,
    /// Filled by the V8 thread; the blocking thread waits on the condvar.
    pub result_slot: Arc<(Mutex<Option<Result<CallResult, String>>>, Condvar)>,
}

// ---------------------------------------------------------------------------
// Thread-local callback table (V8 thread only)
// ---------------------------------------------------------------------------

/// Register a JS function and return its slot index. Called from the V8 thread.
pub fn register_callback(func: v8::Global<v8::Function>) -> usize {
    crate::async_rt::with_callback_table(|table| {
        // Reuse a freed slot if available.
        for (i, slot) in table.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(func);
                return i;
            }
        }
        let id = table.len();
        table.push(Some(func));
        id
    })
}

/// Take a callback out of the table, freeing its slot. Called from the V8
/// thread by fire-and-forget consumers that invoke the callback exactly once
/// (e.g. `Pointer.view` release draining).
pub fn take_callback(id: usize) -> Option<v8::Global<v8::Function>> {
    crate::async_rt::with_callback_table(|table| table.get_mut(id)?.take())
}

/// Release a callback registration. Called from the V8 thread.
pub fn unregister_callback(id: usize) {
    crate::async_rt::with_callback_table(|table| {
        if let Some(slot) = table.get_mut(id) {
            *slot = None;
        }
    });
}

// ---------------------------------------------------------------------------
// Drain — called from pump_and_checkpoint via drain_all
// ---------------------------------------------------------------------------

/// Process all pending JS call requests. Returns true if any were handled.
pub fn process_requests(scope: &mut v8::HandleScope, requests: Vec<JsCallRequest>) -> bool {
    if requests.is_empty() {
        return false;
    }

    for req in requests {
        let func_local = crate::async_rt::with_callback_table(|table| {
            table
                .get(req.callback_id)
                .and_then(|o| o.as_ref())
                .map(|g| v8::Local::new(scope, g))
        });

        let Some(func) = func_local else {
            fill_slot(
                &req.result_slot,
                Err("FfiCallback: callback has been closed".into()),
            );
            continue;
        };

        let js_args: Vec<v8::Local<v8::Value>> = req
            .args
            .iter()
            .zip(req.param_types.iter())
            .map(|(arg, ty)| send_arg_to_v8(scope, arg, ty))
            .collect();

        let this: v8::Local<v8::Value> = v8::undefined(scope).into();

        let tc = &mut v8::TryCatch::new(scope);
        let call_result = func.call(tc, this, &js_args);

        if tc.has_caught() {
            let msg = caught_exception_message!(tc);
            tc.reset();
            fill_slot(&req.result_slot, Err(format!("FfiCallback: {msg}")));
            continue;
        }

        let val = call_result.unwrap_or_else(|| v8::undefined(tc).into());

        if let Ok(promise) = v8::Local::<v8::Promise>::try_from(val) {
            let slot = Arc::clone(&req.result_slot);
            let fut = promise_to_future(tc, promise);
            crate::async_rt::spawn(async move {
                let result = match fut.await {
                    Ok(repr) => repr_to_call_result(repr),
                    Err(repr) => Err(repr_to_error_string(repr)),
                };
                fill_slot(&slot, result);
            });
        } else {
            fill_slot(&req.result_slot, Ok(local_to_call_result(tc, val)));
        }
    }

    true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Invoke a registered callback immediately from raw libffi C argument slots.
///
/// Same-thread callbacks are common for synchronous FFI calls that invoke C
/// libraries with JS callback hooks. This avoids first serialising arguments
/// into a temporary [`SendArg`] vector only to immediately turn them back into
/// V8 values on the same stack.
///
/// # Safety
/// `args` must be the libffi callback argument array for `param_types`.
pub unsafe fn invoke_registered_callback_sync_from_c_args(
    scope: &mut v8::HandleScope,
    func_global: &v8::Global<v8::Function>,
    args: *const *const c_void,
    param_types: &[NativeType],
) -> Result<CallResult, String> {
    let mut js_args: SmallVec<[v8::Local<v8::Value>; 8]> = SmallVec::new();
    for (i, ty) in param_types.iter().enumerate() {
        let arg_ptr = unsafe { *args.add(i) };
        js_args.push(unsafe { c_arg_to_v8(scope, arg_ptr, ty) });
    }

    call_global_callback_sync(scope, func_global, &js_args)
}

fn call_global_callback_sync(
    scope: &mut v8::HandleScope,
    func_global: &v8::Global<v8::Function>,
    js_args: &[v8::Local<v8::Value>],
) -> Result<CallResult, String> {
    let func = v8::Local::new(scope, func_global);
    call_local_callback_sync(scope, func, js_args)
}

fn call_local_callback_sync(
    scope: &mut v8::HandleScope,
    func: v8::Local<v8::Function>,
    js_args: &[v8::Local<v8::Value>],
) -> Result<CallResult, String> {
    let this: v8::Local<v8::Value> = v8::undefined(scope).into();
    let tc = &mut v8::TryCatch::new(scope);
    let call_result = func.call(tc, this, js_args);

    if tc.has_caught() {
        let msg = caught_exception_message!(tc);
        tc.reset();
        return Err(format!("FfiCallback: {msg}"));
    }

    let val = call_result.unwrap_or_else(|| v8::undefined(tc).into());
    if v8::Local::<v8::Promise>::try_from(val).is_ok() {
        return Err(
            "FfiCallback: Promise return is not supported for same-thread callbacks".into(),
        );
    }

    Ok(local_to_call_result(tc, val))
}

fn fill_slot(
    slot: &Arc<(Mutex<Option<Result<CallResult, String>>>, Condvar)>,
    result: Result<CallResult, String>,
) {
    let (lock, cvar) = slot.as_ref();
    *lock.lock().unwrap() = Some(result);
    cvar.notify_one();
}

fn send_arg_to_v8<'s>(
    scope: &mut v8::HandleScope<'s>,
    arg: &SendArg,
    ty: &NativeType,
) -> v8::Local<'s, v8::Value> {
    match arg {
        SendArg::Integer(n) => int_to_v8(scope, *n, ty),
        SendArg::Float(f) => v8::Number::new(scope, *f).into(),
        SendArg::Pointer(addr) => crate::ffi::pointer::into_js(scope, *addr as *mut c_void),
        SendArg::Ignored => v8::undefined(scope).into(),
    }
}

unsafe fn c_arg_to_v8<'s>(
    scope: &mut v8::HandleScope<'s>,
    arg_ptr: *const c_void,
    ty: &NativeType,
) -> v8::Local<'s, v8::Value> {
    match ty {
        NativeType::Void => v8::undefined(scope).into(),
        NativeType::Bool => {
            let value = unsafe { *(arg_ptr as *const u8) } != 0;
            v8::Boolean::new(scope, value).into()
        }
        NativeType::U8 => {
            let value = unsafe { *(arg_ptr as *const u8) };
            v8::Number::new(scope, value as f64).into()
        }
        NativeType::I8 => {
            let value = unsafe { *(arg_ptr as *const i8) };
            v8::Number::new(scope, value as f64).into()
        }
        NativeType::U16 => {
            let value = unsafe { *(arg_ptr as *const u16) };
            v8::Number::new(scope, value as f64).into()
        }
        NativeType::I16 => {
            let value = unsafe { *(arg_ptr as *const i16) };
            v8::Number::new(scope, value as f64).into()
        }
        NativeType::U32 => {
            let value = unsafe { *(arg_ptr as *const u32) };
            v8::Number::new(scope, value as f64).into()
        }
        NativeType::I32 => {
            let value = unsafe { *(arg_ptr as *const i32) };
            v8::Number::new(scope, value as f64).into()
        }
        NativeType::U64 => {
            let value = unsafe { *(arg_ptr as *const u64) };
            v8::BigInt::new_from_u64(scope, value).into()
        }
        NativeType::I64 => {
            let value = unsafe { *(arg_ptr as *const i64) };
            v8::BigInt::new_from_i64(scope, value).into()
        }
        NativeType::USize | NativeType::USizeBig => {
            let value = unsafe { *(arg_ptr as *const usize) };
            v8::BigInt::new_from_u64(scope, value as u64).into()
        }
        NativeType::ISize | NativeType::ISizeBig => {
            let value = unsafe { *(arg_ptr as *const isize) };
            v8::BigInt::new_from_i64(scope, value as i64).into()
        }
        NativeType::F32 => {
            let value = unsafe { *(arg_ptr as *const f32) };
            v8::Number::new(scope, value as f64).into()
        }
        NativeType::F64 => {
            let value = unsafe { *(arg_ptr as *const f64) };
            v8::Number::new(scope, value).into()
        }
        NativeType::Pointer | NativeType::Buffer => {
            let ptr_val = unsafe { *(arg_ptr as *const *const c_void) };
            crate::ffi::pointer::into_js(scope, ptr_val as *mut c_void)
        }
        NativeType::IgnoredPointer => v8::undefined(scope).into(),
        NativeType::Struct(_) => v8::undefined(scope).into(),
    }
}

fn int_to_v8<'s>(
    scope: &mut v8::HandleScope<'s>,
    n: i64,
    ty: &NativeType,
) -> v8::Local<'s, v8::Value> {
    match ty {
        NativeType::Bool => v8::Boolean::new(scope, n != 0).into(),
        NativeType::U8 => v8::Number::new(scope, (n as u8) as f64).into(),
        NativeType::I8 => v8::Number::new(scope, (n as i8) as f64).into(),
        NativeType::U16 => v8::Number::new(scope, (n as u16) as f64).into(),
        NativeType::I16 => v8::Number::new(scope, (n as i16) as f64).into(),
        NativeType::U32 => v8::Number::new(scope, (n as u32) as f64).into(),
        NativeType::I32 => v8::Number::new(scope, (n as i32) as f64).into(),
        NativeType::U64 | NativeType::USize | NativeType::USizeBig => {
            v8::BigInt::new_from_u64(scope, n as u64).into()
        }
        NativeType::I64 | NativeType::ISize | NativeType::ISizeBig => {
            v8::BigInt::new_from_i64(scope, n).into()
        }
        _ => v8::Number::new(scope, n as f64).into(),
    }
}

fn local_to_call_result(scope: &mut v8::HandleScope, val: v8::Local<v8::Value>) -> CallResult {
    if val.is_null_or_undefined() {
        return CallResult::Void;
    }
    if val.is_boolean() {
        return CallResult::Bool(val.boolean_value(scope));
    }
    if let Ok(bi) = v8::Local::<v8::BigInt>::try_from(val) {
        let (v, fits) = bi.i64_value();
        if fits {
            return CallResult::I64(v);
        }
        let (v, _) = bi.u64_value();
        return CallResult::U64(v);
    }
    if let Ok(n) = v8::Local::<v8::Number>::try_from(val) {
        let f = n.value();
        let i = f as i32;
        if (i as f64) == f {
            return CallResult::I32(i);
        }
        let u = f as u32;
        if (u as f64) == f {
            return CallResult::U32(u);
        }
        return CallResult::F64(f);
    }
    if let Ok(s) = v8::Local::<v8::String>::try_from(val) {
        return CallResult::String(s.to_rust_string_lossy(scope));
    }
    // TypedArray / ArrayBuffer — copy bytes out.
    if let Ok(ta) = v8::Local::<v8::TypedArray>::try_from(val) {
        if let Some(buf) = ta.buffer(scope) {
            let bs = buf.get_backing_store();
            let offset = ta.byte_offset();
            let len = ta.byte_length();
            let mut bytes = vec![0u8; len];
            if let Some(data) = bs.data() {
                let src = unsafe {
                    std::slice::from_raw_parts((data.as_ptr() as *const u8).add(offset), len)
                };
                bytes.copy_from_slice(src);
            }
            return CallResult::Bytes(bytes);
        }
    }
    if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(val) {
        let bs = ab.get_backing_store();
        let len = bs.byte_length();
        let mut bytes = vec![0u8; len];
        if let Some(data) = bs.data() {
            let src = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, len) };
            bytes.copy_from_slice(src);
        }
        return CallResult::Bytes(bytes);
    }
    CallResult::Void
}

fn repr_to_call_result(repr: JsValueRepr) -> Result<CallResult, String> {
    Ok(match repr {
        JsValueRepr::Undefined | JsValueRepr::Null => CallResult::Void,
        JsValueRepr::Bool(b) => CallResult::Bool(b),
        JsValueRepr::I32(n) => CallResult::I32(n),
        JsValueRepr::U32(n) => CallResult::U32(n),
        JsValueRepr::F64(f) => CallResult::F64(f),
        JsValueRepr::BigIntI64(n) => CallResult::I64(n),
        JsValueRepr::BigIntU64(n) => CallResult::U64(n),
        JsValueRepr::String(s) => CallResult::String(s),
        JsValueRepr::Bytes(b) => CallResult::Bytes(b),
        JsValueRepr::Global(_) => {
            return Err(
                "FfiCallback: complex JS return value not supported (use scalars, strings, or Uint8Array)".into(),
            );
        }
    })
}

fn repr_to_error_string(repr: JsValueRepr) -> String {
    match repr {
        JsValueRepr::String(s) => s,
        JsValueRepr::Undefined => "undefined".into(),
        JsValueRepr::Null => "null".into(),
        JsValueRepr::Bool(b) => b.to_string(),
        JsValueRepr::I32(n) => n.to_string(),
        JsValueRepr::U32(n) => n.to_string(),
        JsValueRepr::F64(f) => f.to_string(),
        JsValueRepr::BigIntI64(n) => n.to_string(),
        JsValueRepr::BigIntU64(n) => n.to_string(),
        JsValueRepr::Bytes(_) => "[bytes]".into(),
        JsValueRepr::Global(_) => "[object]".into(),
    }
}

// ---------------------------------------------------------------------------
// C arg reading / result writing (used by the libffi trampoline in closure.rs)
// ---------------------------------------------------------------------------

/// Read a C argument value at `arg_ptr` (which points to the argument value,
/// as libffi supplies it) and convert it to a [`SendArg`].
///
/// # Safety
/// `arg_ptr` must point to a value of the correct C type for `ty`.
pub unsafe fn read_c_arg(arg_ptr: *const c_void, ty: &NativeType) -> SendArg {
    unsafe {
        match ty {
            NativeType::Void => SendArg::Integer(0),
            NativeType::Bool | NativeType::U8 => SendArg::Integer(*(arg_ptr as *const u8) as i64),
            NativeType::I8 => SendArg::Integer(*(arg_ptr as *const i8) as i64),
            NativeType::U16 => SendArg::Integer(*(arg_ptr as *const u16) as i64),
            NativeType::I16 => SendArg::Integer(*(arg_ptr as *const i16) as i64),
            NativeType::U32 => SendArg::Integer(*(arg_ptr as *const u32) as i64),
            NativeType::I32 => SendArg::Integer(*(arg_ptr as *const i32) as i64),
            NativeType::U64 => SendArg::Integer(*(arg_ptr as *const u64) as i64),
            NativeType::I64 => SendArg::Integer(*(arg_ptr as *const i64)),
            NativeType::USize | NativeType::USizeBig => {
                SendArg::Integer(*(arg_ptr as *const usize) as i64)
            }
            NativeType::ISize | NativeType::ISizeBig => {
                SendArg::Integer(*(arg_ptr as *const isize) as i64)
            }
            NativeType::F32 => SendArg::Float(*(arg_ptr as *const f32) as f64),
            NativeType::F64 => SendArg::Float(*(arg_ptr as *const f64)),
            NativeType::Pointer | NativeType::Buffer => {
                // arg_ptr points to a *const c_void (the pointer value itself).
                let ptr_val = *(arg_ptr as *const *const c_void);
                SendArg::Pointer(ptr_val as usize)
            }
            NativeType::IgnoredPointer => SendArg::Ignored,
            NativeType::Struct(_) => SendArg::Integer(0),
        }
    }
}

/// Write a [`CallResult`] into the C return-value buffer at `result_ptr`.
///
/// # Safety
/// `result_ptr` must point to writable memory of the correct size for `ty`.
pub unsafe fn write_c_result(
    result_ptr: *mut c_void,
    ty: &NativeType,
    outcome: Result<CallResult, String>,
) {
    let call_result = outcome.unwrap_or_else(|msg| {
        eprintln!("FfiCallback error: {msg}");
        CallResult::I32(0)
    });

    unsafe {
        match ty {
            NativeType::Void => {}
            NativeType::Bool | NativeType::U8 => {
                *(result_ptr as *mut u8) = call_result_to_i64(&call_result) as u8;
            }
            NativeType::I8 => {
                *(result_ptr as *mut i8) = call_result_to_i64(&call_result) as i8;
            }
            NativeType::U16 => {
                *(result_ptr as *mut u16) = call_result_to_i64(&call_result) as u16;
            }
            NativeType::I16 => {
                *(result_ptr as *mut i16) = call_result_to_i64(&call_result) as i16;
            }
            NativeType::U32 => {
                *(result_ptr as *mut u32) = call_result_to_i64(&call_result) as u32;
            }
            NativeType::I32 => {
                *(result_ptr as *mut i32) = call_result_to_i64(&call_result) as i32;
            }
            NativeType::U64 | NativeType::USize | NativeType::USizeBig => {
                *(result_ptr as *mut u64) = call_result_to_i64(&call_result) as u64;
            }
            NativeType::I64 | NativeType::ISize | NativeType::ISizeBig => {
                *(result_ptr as *mut i64) = call_result_to_i64(&call_result);
            }
            NativeType::F32 => {
                *(result_ptr as *mut f32) = call_result_to_f64(&call_result) as f32;
            }
            NativeType::F64 => {
                *(result_ptr as *mut f64) = call_result_to_f64(&call_result);
            }
            NativeType::Pointer | NativeType::IgnoredPointer | NativeType::Buffer => {
                let ptr = match &call_result {
                    CallResult::Bytes(bytes) if bytes.len() >= 8 => {
                        let mut raw = [0u8; 8];
                        raw.copy_from_slice(&bytes[..8]);
                        u64::from_le_bytes(raw) as usize
                    }
                    _ => 0,
                };
                *(result_ptr as *mut usize) = ptr;
            }
            NativeType::Struct(_) => {}
        }
    }
}

fn call_result_to_i64(r: &CallResult) -> i64 {
    match r {
        CallResult::Void => 0,
        CallResult::Bool(b) => *b as i64,
        CallResult::I32(n) => *n as i64,
        CallResult::U32(n) => *n as i64,
        CallResult::I64(n) => *n,
        CallResult::U64(n) => *n as i64,
        CallResult::F64(f) => *f as i64,
        CallResult::String(_) | CallResult::Bytes(_) => 0,
    }
}

fn call_result_to_f64(r: &CallResult) -> f64 {
    match r {
        CallResult::F64(f) => *f,
        other => call_result_to_i64(other) as f64,
    }
}
