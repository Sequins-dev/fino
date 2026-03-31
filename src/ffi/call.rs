use std::ffi::c_void;

use boa_gc::GcRef;
use libffi::middle::{Arg, Ret, arg};

use boa_engine::{
    Context, JsBigInt, JsNativeError, JsResult, JsValue,
    object::builtins::{JsArrayBuffer, JsTypedArray},
};

use crate::ffi::{
    library::FfiSymbol,
    pointer::BoatsPointer,
    types::{NativeType, NativeValue},
};

/// Marshal `js_args` according to `symbol.param_types`, invoke the foreign
/// function, and convert the result back to a `JsValue`.
///
/// # Safety
/// This calls an arbitrary C function pointer. The caller is responsible for
/// supplying a symbol whose declared types match the actual C signature.
pub fn ffi_call(
    symbol: &FfiSymbol,
    js_args: &[JsValue],
    context: &mut Context,
) -> JsResult<JsValue> {
    if js_args.len() != symbol.param_types.len() {
        return Err(JsNativeError::typ()
            .with_message(format!(
                "Expected {} argument(s), got {}",
                symbol.param_types.len(),
                js_args.len()
            ))
            .into());
    }

    // Stack-allocated storage for native argument values.
    let mut storage: Vec<NativeValue> =
        (0..js_args.len()).map(|_| NativeValue::default()).collect();

    // We keep `GcRef` borrows alive for ArrayBuffer/TypedArray args so the GC
    // cannot collect the backing allocation during the call.
    let mut _buffer_pins: Vec<GcRef<'_, [u8]>> = Vec::new();

    for (i, (js_val, native_type)) in js_args.iter().zip(&symbol.param_types).enumerate() {
        storage[i] = js_to_native(js_val, native_type, context, &mut _buffer_pins)
            .map_err(|e| JsNativeError::typ().with_message(format!("Argument {i}: {e}")))?;
    }

    // Build the libffi Arg slice — each element borrows from `storage`.
    let ffi_args: Vec<Arg<'_>> = storage
        .iter()
        .zip(&symbol.param_types)
        .map(|(val, ty)| {
            // SAFETY: we read the union field that corresponds to `ty`.
            unsafe {
                match ty {
                    NativeType::Bool | NativeType::U8 => arg(&val.u8_val),
                    NativeType::I8 => arg(&val.i8_val),
                    NativeType::U16 => arg(&val.u16_val),
                    NativeType::I16 => arg(&val.i16_val),
                    NativeType::U32 => arg(&val.u32_val),
                    NativeType::I32 => arg(&val.i32_val),
                    NativeType::U64 => arg(&val.u64_val),
                    NativeType::I64 => arg(&val.i64_val),
                    NativeType::F32 => arg(&val.f32_val),
                    NativeType::F64 => arg(&val.f64_val),
                    NativeType::USize => arg(&val.usize_val),
                    NativeType::ISize => arg(&val.isize_val),
                    NativeType::Pointer | NativeType::Buffer => arg(&val.ptr_val),
                    NativeType::Void => unreachable!("void is not a valid param type"),
                }
            }
        })
        .collect();

    // SAFETY: we trust the declared types match the actual symbol.
    unsafe { dispatch_and_convert(symbol, &ffi_args, context) }
}

/// Convert a single JS value to a `NativeValue` union entry.
fn js_to_native<'pin>(
    val: &JsValue,
    ty: &NativeType,
    context: &mut Context,
    buffer_pins: &mut Vec<GcRef<'pin, [u8]>>,
) -> JsResult<NativeValue> {
    match ty {
        NativeType::Bool => Ok(NativeValue {
            u8_val: val.to_boolean() as u8,
        }),

        NativeType::U8 => Ok(NativeValue {
            u8_val: js_to_int(val, context)? as u8,
        }),
        NativeType::I8 => Ok(NativeValue {
            i8_val: js_to_int(val, context)? as i8,
        }),
        NativeType::U16 => Ok(NativeValue {
            u16_val: js_to_int(val, context)? as u16,
        }),
        NativeType::I16 => Ok(NativeValue {
            i16_val: js_to_int(val, context)? as i16,
        }),
        NativeType::U32 => Ok(NativeValue {
            u32_val: js_to_int(val, context)? as u32,
        }),
        NativeType::I32 => Ok(NativeValue {
            i32_val: js_to_int(val, context)? as i32,
        }),
        NativeType::F32 => Ok(NativeValue {
            f32_val: val.to_number(context)? as f32,
        }),
        NativeType::F64 => Ok(NativeValue {
            f64_val: val.to_number(context)?,
        }),
        NativeType::USize => Ok(NativeValue {
            usize_val: js_to_int(val, context)? as usize,
        }),
        NativeType::ISize => Ok(NativeValue {
            isize_val: js_to_int(val, context)? as isize,
        }),

        // u64/i64 accept BigInt (preferred) or fall back to number.
        NativeType::U64 => Ok(NativeValue {
            u64_val: js_to_u64(val, context)?,
        }),
        NativeType::I64 => Ok(NativeValue {
            i64_val: js_to_i64(val, context)?,
        }),

        NativeType::Pointer => Ok(NativeValue {
            ptr_val: BoatsPointer::from_js(val)?,
        }),

        NativeType::Buffer => Ok(NativeValue {
            ptr_val: js_buffer_ptr(val, context, buffer_pins)?,
        }),

        NativeType::Void => Err(JsNativeError::typ()
            .with_message("'void' cannot be used as a parameter type")
            .into()),
    }
}

/// Accept either a JS number or a BigInt and return an i128 that can be
/// cast to any integer type. This lets callers pass `8n` for `usize` etc.
fn js_to_int(val: &JsValue, context: &mut Context) -> JsResult<i128> {
    if let Some(bigint) = val.as_bigint() {
        return Ok(bigint.to_i128());
    }
    Ok(val.to_number(context)? as i128)
}

fn js_to_u64(val: &JsValue, context: &mut Context) -> JsResult<u64> {
    if let Some(bigint) = val.as_bigint() {
        return Ok(bigint.to_i128() as u64);
    }
    Ok(val.to_number(context)? as u64)
}

fn js_to_i64(val: &JsValue, context: &mut Context) -> JsResult<i64> {
    if let Some(bigint) = val.as_bigint() {
        return Ok(bigint.to_i128() as i64);
    }
    Ok(val.to_number(context)? as i64)
}

/// Get a `*mut c_void` to the raw backing bytes of an `ArrayBuffer` or typed array.
/// The `GcRef` borrow is pushed to `pins` to keep the data alive during the call.
/// JS `null` is accepted and maps to a C null pointer.
fn js_buffer_ptr<'pin>(
    val: &JsValue,
    context: &mut Context,
    pins: &mut Vec<GcRef<'pin, [u8]>>,
) -> JsResult<*mut c_void> {
    if val.is_null() {
        return Ok(std::ptr::null_mut());
    }

    let obj = val.as_object().ok_or_else(|| {
        JsNativeError::typ()
            .with_message("Expected an ArrayBuffer or TypedArray for 'buffer' argument")
    })?;

    // Try ArrayBuffer first.
    if let Ok(ab) = JsArrayBuffer::from_object(obj.clone()) {
        return borrow_array_buffer(ab, pins);
    }

    // Try TypedArray — extract its backing ArrayBuffer.
    if let Ok(ta) = JsTypedArray::from_object(obj.clone()) {
        let buf_val = ta.buffer(context)?;
        let buf_obj = buf_val.as_object().ok_or_else(|| {
            JsNativeError::typ().with_message("TypedArray has no backing ArrayBuffer")
        })?;
        let ab = JsArrayBuffer::from_object(buf_obj.clone())?;
        return borrow_array_buffer(ab, pins);
    }

    Err(JsNativeError::typ()
        .with_message("Expected an ArrayBuffer or TypedArray for 'buffer' argument")
        .into())
}

fn borrow_array_buffer<'pin>(
    ab: JsArrayBuffer,
    pins: &mut Vec<GcRef<'pin, [u8]>>,
) -> JsResult<*mut c_void> {
    // `data()` returns a GcRef borrow tied to the ArrayBuffer's GcRefCell.
    // We hold it in `pins` so the GC cannot reclaim the backing data during
    // the FFI call. The pointer is valid for as long as `pins` lives.
    let data: GcRef<'_, [u8]> = ab
        .data()
        .ok_or_else(|| JsNativeError::typ().with_message("ArrayBuffer is detached"))?;

    // SAFETY: We are transmuting the lifetime from 'borrow to 'pin.
    // This is sound because `pins` holds the `ab` borrow for the full duration
    // of the call, and we never drop `pins` before the FFI call completes.
    let ptr = data.as_ptr() as *mut c_void;
    let pinned: GcRef<'pin, [u8]> = unsafe { std::mem::transmute(data) };
    pins.push(pinned);
    Ok(ptr)
}

/// Perform the actual libffi call and convert the return value to a `JsValue`.
///
/// # Safety
/// `symbol.code_ptr` must point to a valid C function whose signature matches
/// `symbol.cif` and `symbol.result_type`.
unsafe fn dispatch_and_convert(
    symbol: &FfiSymbol,
    ffi_args: &[Arg<'_>],
    context: &mut Context,
) -> JsResult<JsValue> {
    let cp = symbol.code_ptr;

    Ok(match &symbol.result_type {
        NativeType::Void => {
            unsafe { symbol.cif.call_return_into(cp, ffi_args, Ret::void()) };
            JsValue::undefined()
        }
        NativeType::Bool => {
            let v: u8 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v != 0)
        }
        NativeType::U8 => {
            let v: u8 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v)
        }
        NativeType::I8 => {
            let v: i8 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v)
        }
        NativeType::U16 => {
            let v: u16 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v)
        }
        NativeType::I16 => {
            let v: i16 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v)
        }
        NativeType::U32 => {
            let v: u32 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v)
        }
        NativeType::I32 => {
            let v: i32 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v)
        }
        NativeType::U64 => {
            let v: u64 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(JsBigInt::from(v))
        }
        NativeType::I64 => {
            let v: i64 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(JsBigInt::from(v))
        }
        NativeType::USize => {
            let v: usize = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v as f64)
        }
        NativeType::ISize => {
            let v: isize = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v as f64)
        }
        NativeType::F32 => {
            let v: f32 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(f64::from(v))
        }
        NativeType::F64 => {
            let v: f64 = unsafe { symbol.cif.call(cp, ffi_args) };
            JsValue::from(v)
        }
        NativeType::Pointer => {
            let v: *mut c_void = unsafe { symbol.cif.call(cp, ffi_args) };
            BoatsPointer::into_js(v, context)?
        }
        NativeType::Buffer => {
            return Err(JsNativeError::typ()
                .with_message("'buffer' cannot be used as a return type; use 'pointer' instead")
                .into());
        }
    })
}
