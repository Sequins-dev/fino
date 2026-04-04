//! V8 FFI call dispatch — marshals V8 `Local<Value>` arguments to native
//! types, invokes the foreign function via libffi, and converts the return
//! value back to a `Local<Value>`.
//!
//! Buffer arguments pin their backing store for the duration of the call by
//! holding a `SharedRef<BackingStore>` in `_store_pins`.

use std::ffi::c_void;

use ::v8;
use libffi::middle::{Arg, Ret, arg};
use smallvec::SmallVec;

use super::pointer;
use crate::library::FfiSymbol;
use crate::types::{NativeType, NativeValue};

pub struct CallScratch {
    storage: SmallVec<[NativeValue; 8]>,
    store_pins: SmallVec<[v8::SharedRef<v8::BackingStore>; 4]>,
}

impl CallScratch {
    pub fn new() -> Self {
        Self {
            storage: SmallVec::new(),
            store_pins: SmallVec::new(),
        }
    }

    fn prepare(&mut self, len: usize) {
        self.storage.clear();
        self.storage.resize(len, NativeValue::default());
        self.store_pins.clear();
    }
}

/// Marshal `js_args` according to `symbol.param_types`, invoke the foreign
/// function, and convert the result back to a JS value.
///
/// # Safety
/// This calls an arbitrary C function pointer.  The caller is responsible for
/// supplying a symbol whose declared types match the actual C signature.
pub fn ffi_call<'s>(
    scope: &mut v8::HandleScope<'s>,
    symbol: &FfiSymbol,
    js_args: &[v8::Local<'s, v8::Value>],
    scratch: &mut CallScratch,
) -> Option<v8::Local<'s, v8::Value>> {
    if js_args.len() != symbol.param_types.len() {
        let msg = v8::String::new(
            scope,
            &format!(
                "Expected {} argument(s), got {}",
                symbol.param_types.len(),
                js_args.len()
            ),
        )?;
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return None;
    }

    scratch.prepare(js_args.len());

    for (i, (val, ty)) in js_args.iter().zip(&symbol.param_types).enumerate() {
        match js_to_native(scope, *val, ty, &mut scratch.store_pins) {
            Some(nv) => scratch.storage[i] = nv,
            None => {
                // js_to_native threw an exception.
                return None;
            }
        }
    }

    let ffi_args: SmallVec<[Arg<'_>; 8]> = scratch
        .storage
        .iter()
        .zip(&symbol.param_types)
        .map(|(val, ty)| unsafe {
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
        })
        .collect();

    unsafe { dispatch_and_convert(scope, symbol, &ffi_args) }
}

fn js_to_native<'s>(
    scope: &mut v8::HandleScope<'s>,
    val: v8::Local<'s, v8::Value>,
    ty: &NativeType,
    store_pins: &mut SmallVec<[v8::SharedRef<v8::BackingStore>; 4]>,
) -> Option<NativeValue> {
    Some(match ty {
        NativeType::Bool => NativeValue {
            u8_val: val.boolean_value(scope) as u8,
        },
        NativeType::U8 => NativeValue {
            u8_val: js_to_i128(scope, val)? as u8,
        },
        NativeType::I8 => NativeValue {
            i8_val: js_to_i128(scope, val)? as i8,
        },
        NativeType::U16 => NativeValue {
            u16_val: js_to_i128(scope, val)? as u16,
        },
        NativeType::I16 => NativeValue {
            i16_val: js_to_i128(scope, val)? as i16,
        },
        NativeType::U32 => NativeValue {
            u32_val: js_to_i128(scope, val)? as u32,
        },
        NativeType::I32 => NativeValue {
            i32_val: js_to_i128(scope, val)? as i32,
        },
        NativeType::U64 => NativeValue {
            u64_val: js_to_i128(scope, val)? as u64,
        },
        NativeType::I64 => NativeValue {
            i64_val: js_to_i128(scope, val)? as i64,
        },
        NativeType::F32 => NativeValue {
            f32_val: val.number_value(scope)? as f32,
        },
        NativeType::F64 => NativeValue {
            f64_val: val.number_value(scope)?,
        },
        NativeType::USize => NativeValue {
            usize_val: js_to_i128(scope, val)? as usize,
        },
        NativeType::ISize => NativeValue {
            isize_val: js_to_i128(scope, val)? as isize,
        },
        NativeType::Pointer => NativeValue {
            ptr_val: pointer::from_js(scope, val)?,
        },
        NativeType::Buffer => NativeValue {
            ptr_val: js_buffer_ptr(scope, val, store_pins)?,
        },
        NativeType::Void => {
            let msg = v8::String::new(scope, "'void' cannot be used as a parameter type")?;
            let exc = v8::Exception::type_error(scope, msg);
            scope.throw_exception(exc);
            return None;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::CallScratch;

    #[test]
    fn call_scratch_reuses_storage() {
        let mut scratch = CallScratch::new();
        scratch.prepare(4);
        let initial_capacity = scratch.storage.capacity();
        scratch.prepare(2);
        assert_eq!(scratch.storage.len(), 2);
        assert!(scratch.storage.capacity() >= initial_capacity);
    }

    #[test]
    fn call_scratch_clears_pins_between_calls() {
        let mut scratch = CallScratch::new();
        scratch.store_pins.reserve(2);
        scratch.prepare(1);
        assert!(scratch.store_pins.is_empty());
    }
}

/// Get a raw pointer to the backing bytes of an `ArrayBuffer` or TypedArray.
/// Null is accepted and maps to a C null pointer.
/// The BackingStore ref is pushed to `pins` to keep it alive during the call.
fn js_buffer_ptr<'s>(
    scope: &mut v8::HandleScope<'s>,
    val: v8::Local<'s, v8::Value>,
    pins: &mut SmallVec<[v8::SharedRef<v8::BackingStore>; 4]>,
) -> Option<*mut c_void> {
    if val.is_null() {
        return Some(std::ptr::null_mut());
    }

    // For a TypedArray, track the byte_offset so we can adjust the pointer.
    let (ab, byte_offset): (v8::Local<v8::ArrayBuffer>, usize) =
        if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(val) {
            (ab, 0)
        } else if let Ok(ta) = v8::Local::<v8::TypedArray>::try_from(val) {
            let offset = ta.byte_offset();
            (ta.buffer(scope)?, offset)
        } else {
            let msg = v8::String::new(
                scope,
                "Expected an ArrayBuffer or TypedArray for 'buffer' argument",
            )?;
            let exc = v8::Exception::type_error(scope, msg);
            scope.throw_exception(exc);
            return None;
        };

    let bs: v8::SharedRef<v8::BackingStore> = ab.get_backing_store();
    let base = bs
        .data()
        .map(|p: std::ptr::NonNull<std::ffi::c_void>| p.as_ptr() as *mut u8)
        .unwrap_or(std::ptr::null_mut());
    let ptr = if base.is_null() {
        std::ptr::null_mut()
    } else {
        // SAFETY: byte_offset is within the backing store (V8 guarantees this).
        unsafe { base.add(byte_offset) as *mut c_void }
    };
    pins.push(bs);
    Some(ptr)
}

/// Convert a V8 number or BigInt to i128.
fn js_to_i128(scope: &mut v8::HandleScope, val: v8::Local<v8::Value>) -> Option<i128> {
    if let Ok(bi) = v8::Local::<v8::BigInt>::try_from(val) {
        return Some(bi.i64_value().0 as i128);
    }
    Some(val.number_value(scope)? as i128)
}

/// Perform the actual libffi call and convert the return value to a V8 value.
///
/// # Safety
/// `symbol.code_ptr` must point to a valid C function matching `symbol.cif`.
unsafe fn dispatch_and_convert<'s>(
    scope: &mut v8::HandleScope<'s>,
    symbol: &FfiSymbol,
    ffi_args: &[Arg<'_>],
) -> Option<v8::Local<'s, v8::Value>> {
    let cp = symbol.code_ptr;

    Some(match &symbol.result_type {
        NativeType::Void => {
            unsafe { symbol.cif.call_return_into(cp, ffi_args, Ret::void()) };
            v8::undefined(scope).into()
        }
        NativeType::Bool => {
            let v: u8 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Boolean::new(scope, v != 0).into()
        }
        NativeType::U8 => {
            let v: u8 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::I8 => {
            let v: i8 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::U16 => {
            let v: u16 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::I16 => {
            let v: i16 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::U32 => {
            let v: u32 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::I32 => {
            let v: i32 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::U64 => {
            let v: u64 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::BigInt::new_from_u64(scope, v).into()
        }
        NativeType::I64 => {
            let v: i64 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::BigInt::new_from_i64(scope, v).into()
        }
        NativeType::USize => {
            let v: usize = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::ISize => {
            let v: isize = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::F32 => {
            let v: f32 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::F64 => {
            let v: f64 = unsafe { symbol.cif.call(cp, ffi_args) };
            v8::Number::new(scope, v).into()
        }
        NativeType::Pointer => {
            let v: *mut c_void = unsafe { symbol.cif.call(cp, ffi_args) };
            pointer::into_js(scope, v)
        }
        NativeType::Buffer => {
            let msg = v8::String::new(
                scope,
                "'buffer' cannot be used as a return type; use 'pointer' instead",
            )?;
            let exc = v8::Exception::type_error(scope, msg);
            scope.throw_exception(exc);
            return None;
        }
    })
}
