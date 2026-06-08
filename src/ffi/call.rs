//! V8 FFI call dispatch — marshals V8 `Local<Value>` arguments to native
//! types, invokes the foreign function via libffi, and converts the return
//! value back to a `Local<Value>`.
//!
//! Buffer arguments pin their backing store for the duration of the call by
//! holding a `SharedRef<BackingStore>` in `_store_pins`.

use std::ffi::c_void;

use ::v8;
use libffi::middle::{Arg, Ret, arg};
use libffi::middle::{Cif, CodePtr};
use smallvec::SmallVec;

/// Everything a background thread needs to execute one async FFI call.
/// Declared as a named struct (not a tuple) to prevent the compiler from
/// decomposing it and exposing the non-Send inner types to the `Send` check.
struct AsyncFfiWork {
    cif: Cif,
    code_ptr: CodePtr,
    result_type: NativeType,
    owned_args: Vec<OwnedScalarArg>,
    _store_pins: SmallVec<[v8::SharedRef<v8::BackingStore>; 4]>,
}
// SAFETY: Cif / CodePtr are immutable read-only ABI metadata used only on the
// background thread during the call. BackingStore references are thread-safe
// handles used only to keep ArrayBuffer storage alive until the C call returns.
unsafe impl Send for AsyncFfiWork {}

impl AsyncFfiWork {
    /// Execute the FFI call on the calling (background) thread.
    /// Consuming `self` via a method keeps the captured variable as
    /// `AsyncFfiWork` (not decomposed into individual non-Send fields).
    fn execute(self) -> Result<crate::async_rt::RawFfiResult, String> {
        call_scalar_sync(
            &self.cif,
            self.code_ptr,
            &self.result_type,
            &self.owned_args,
        )
    }
}

use super::library::FfiSymbol;
use super::pointer;
use super::types::{NativeType, NativeValue};

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

// ---------------------------------------------------------------------------
// Async dispatch — offload to the blocking thread pool
// ---------------------------------------------------------------------------

/// Owned scalar argument value (Send + 'static so it can be sent to a thread).
/// Buffer params are kept alive by `AsyncFfiWork::_store_pins`; pointer params
/// are raw addresses copied as integers.
#[derive(Clone)]
pub(crate) struct OwnedScalarArg {
    bytes: [u8; 8],
    ty: NativeType,
}

impl OwnedScalarArg {
    fn from_native(val: NativeValue, ty: &NativeType) -> Self {
        let mut bytes = [0u8; 8];
        unsafe {
            match ty {
                NativeType::Void => {}
                NativeType::Bool | NativeType::U8 => bytes[0] = val.u8_val,
                NativeType::I8 => bytes[0] = val.i8_val as u8,
                NativeType::U16 => bytes[..2].copy_from_slice(&val.u16_val.to_le_bytes()),
                NativeType::I16 => bytes[..2].copy_from_slice(&val.i16_val.to_le_bytes()),
                NativeType::U32 => bytes[..4].copy_from_slice(&val.u32_val.to_le_bytes()),
                NativeType::I32 => bytes[..4].copy_from_slice(&val.i32_val.to_le_bytes()),
                NativeType::U64 => bytes.copy_from_slice(&val.u64_val.to_le_bytes()),
                NativeType::I64 => bytes.copy_from_slice(&val.i64_val.to_le_bytes()),
                NativeType::USize => bytes.copy_from_slice(&val.usize_val.to_le_bytes()),
                NativeType::ISize => bytes.copy_from_slice(&val.isize_val.to_le_bytes()),
                NativeType::F32 => bytes[..4].copy_from_slice(&val.f32_val.to_le_bytes()),
                NativeType::F64 => bytes.copy_from_slice(&val.f64_val.to_le_bytes()),
                NativeType::Pointer | NativeType::Buffer => {
                    bytes.copy_from_slice(&(val.ptr_val as usize).to_le_bytes());
                }
            }
        }
        Self {
            bytes,
            ty: ty.clone(),
        }
    }

    fn to_native_value(&self) -> NativeValue {
        let b = self.bytes;
        match self.ty {
            NativeType::Void => NativeValue { u8_val: 0 },
            NativeType::Pointer | NativeType::Buffer => NativeValue {
                ptr_val: usize::from_le_bytes(b) as *mut c_void,
            },
            NativeType::Bool | NativeType::U8 => NativeValue { u8_val: b[0] },
            NativeType::I8 => NativeValue { i8_val: b[0] as i8 },
            NativeType::U16 => NativeValue {
                u16_val: u16::from_le_bytes([b[0], b[1]]),
            },
            NativeType::I16 => NativeValue {
                i16_val: i16::from_le_bytes([b[0], b[1]]),
            },
            NativeType::U32 => NativeValue {
                u32_val: u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            },
            NativeType::I32 => NativeValue {
                i32_val: i32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            },
            NativeType::U64 => NativeValue {
                u64_val: u64::from_le_bytes(b),
            },
            NativeType::I64 => NativeValue {
                i64_val: i64::from_le_bytes(b),
            },
            NativeType::USize => NativeValue {
                usize_val: usize::from_le_bytes(b),
            },
            NativeType::ISize => NativeValue {
                isize_val: isize::from_le_bytes(b),
            },
            NativeType::F32 => NativeValue {
                f32_val: f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            },
            NativeType::F64 => NativeValue {
                f64_val: f64::from_le_bytes(b),
            },
        }
    }
}

// SAFETY: OwnedScalarArg contains only primitive bytes — no raw pointers.
unsafe impl Send for OwnedScalarArg {}

/// Dispatch an async FFI call. Marshals scalar arguments, submits the call to
/// the blocking thread pool, and returns a JS Promise that resolves when the
/// thread completes.
pub fn ffi_call_async<'s>(
    scope: &mut v8::HandleScope<'s>,
    symbol: &FfiSymbol,
    js_args: &[v8::Local<'s, v8::Value>],
) -> Option<v8::Local<'s, v8::Promise>> {
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

    // Marshal args to owned scalars (no scope needed after this point).
    let mut owned_args = Vec::with_capacity(js_args.len());
    let mut store_pins: SmallVec<[v8::SharedRef<v8::BackingStore>; 4]> = SmallVec::new();
    for (val, ty) in js_args.iter().zip(&symbol.param_types) {
        let nv = js_to_native(scope, *val, ty, &mut store_pins)?;
        owned_args.push(OwnedScalarArg::from_native(nv, ty));
    }
    // Create the JS Promise resolver.
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    let global_resolver = v8::Global::new(scope, resolver);

    // Get the completion queue and wake pipe from the isolate async state.
    let (completions, wake_write) = match crate::async_rt::completion_handle() {
        Some(h) => h,
        None => {
            let msg = v8::String::new(scope, "async FFI: runtime not initialised")?;
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return None;
        }
    };

    // Store the resolver in the thread-local table; send only the usize ID.
    let resolver_id = crate::async_rt::push_resolver(global_resolver);

    let work = AsyncFfiWork {
        cif: symbol.cif.clone(),
        code_ptr: symbol.code_ptr,
        result_type: symbol.result_type.clone(),
        owned_args,
        _store_pins: store_pins,
    };

    // Submit to the shared blocking pool (see src/async_rt/blocking.rs).
    // The closure captures `work: AsyncFfiWork` (not its individual fields) so
    // the closure type is Send despite Cif/CodePtr not being Send.
    crate::async_rt::blocking::spawn(move || {
        let result = work.execute();
        completions
            .lock()
            .unwrap()
            .push(crate::async_rt::FfiCompletion {
                resolver_id,
                result,
            });
        // Wake the main thread's event loop (kqueue/io_uring readable on pipe).
        unsafe { libc::write(wake_write, b"\x01".as_ptr() as *const c_void, 1) };
    });

    Some(promise)
}

/// Execute a synchronous libffi call on the calling (background) thread.
/// Returns the raw result bytes or an error string.
fn call_scalar_sync(
    cif: &Cif,
    code_ptr: CodePtr,
    result_type: &NativeType,
    owned_args: &[OwnedScalarArg],
) -> Result<crate::async_rt::RawFfiResult, String> {
    // Rebuild NativeValues from owned scalars.
    let native_vals: Vec<NativeValue> = owned_args.iter().map(|a| a.to_native_value()).collect();

    // Build libffi args.
    let ffi_args: Vec<Arg<'_>> = native_vals
        .iter()
        .zip(owned_args.iter().map(|a| &a.ty))
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
                NativeType::Pointer => arg(&val.ptr_val),
                NativeType::Buffer | NativeType::Void => {
                    arg(&val.u8_val) // unreachable: buffer blocked at dlopen, void not a param
                }
            }
        })
        .collect();

    let mut bytes = [0u8; 8];
    unsafe {
        match result_type {
            NativeType::Void => {
                cif.call_return_into(code_ptr, &ffi_args, Ret::void());
            }
            NativeType::Bool | NativeType::U8 => {
                let v: u8 = cif.call(code_ptr, &ffi_args);
                bytes[0] = v;
            }
            NativeType::I8 => {
                let v: i8 = cif.call(code_ptr, &ffi_args);
                bytes[0] = v as u8;
            }
            NativeType::U16 => {
                let v: u16 = cif.call(code_ptr, &ffi_args);
                bytes[..2].copy_from_slice(&v.to_le_bytes());
            }
            NativeType::I16 => {
                let v: i16 = cif.call(code_ptr, &ffi_args);
                bytes[..2].copy_from_slice(&v.to_le_bytes());
            }
            NativeType::U32 => {
                let v: u32 = cif.call(code_ptr, &ffi_args);
                bytes[..4].copy_from_slice(&v.to_le_bytes());
            }
            NativeType::I32 => {
                let v: i32 = cif.call(code_ptr, &ffi_args);
                bytes[..4].copy_from_slice(&v.to_le_bytes());
            }
            NativeType::U64 => {
                let v: u64 = cif.call(code_ptr, &ffi_args);
                bytes.copy_from_slice(&v.to_le_bytes());
            }
            NativeType::I64 => {
                let v: i64 = cif.call(code_ptr, &ffi_args);
                bytes.copy_from_slice(&v.to_le_bytes());
            }
            NativeType::USize => {
                let v: usize = cif.call(code_ptr, &ffi_args);
                bytes.copy_from_slice(&v.to_le_bytes());
            }
            NativeType::ISize => {
                let v: isize = cif.call(code_ptr, &ffi_args);
                bytes.copy_from_slice(&v.to_le_bytes());
            }
            NativeType::F32 => {
                let v: f32 = cif.call(code_ptr, &ffi_args);
                bytes[..4].copy_from_slice(&v.to_le_bytes());
            }
            NativeType::F64 => {
                let v: f64 = cif.call(code_ptr, &ffi_args);
                bytes.copy_from_slice(&v.to_le_bytes());
            }
            NativeType::Pointer | NativeType::Buffer => {
                return Err("pointer/buffer return type not supported for async FFI".to_string());
            }
        }
    }

    Ok(crate::async_rt::RawFfiResult {
        result_type: result_type.clone(),
        bytes,
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
