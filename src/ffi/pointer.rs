use std::ffi::c_void;

use boa_engine::{
    Context, JsBigInt, JsData, JsNativeError, JsObject, JsResult, JsValue, NativeFunction,
    js_string, object::FunctionObjectBuilder, object::builtins::JsArrayBuffer,
};
use boa_gc::{Finalize, Trace};

/// An opaque C pointer exposed to JS. JS code cannot dereference it directly;
/// it is passed through FFI calls that expect a `pointer` argument.
#[derive(Debug, Trace, Finalize)]
pub struct BoatsPointer {
    #[unsafe_ignore_trace]
    pub ptr: *mut c_void,
}

impl JsData for BoatsPointer {}

impl BoatsPointer {
    pub fn new(ptr: *mut c_void) -> Self {
        Self { ptr }
    }

    /// Wrap a raw pointer in a JS object. Null pointers become JS `null`.
    pub fn into_js(ptr: *mut c_void, context: &mut Context) -> JsResult<JsValue> {
        if ptr.is_null() {
            return Ok(JsValue::null());
        }
        let obj = JsObject::from_proto_and_data(
            context.intrinsics().constructors().object().prototype(),
            Self::new(ptr),
        );
        Ok(JsValue::from(obj))
    }

    /// Extract a raw pointer from a JS value that is a `BoatsPointer` object,
    /// or `null` → null pointer.
    pub fn from_js(val: &JsValue) -> JsResult<*mut c_void> {
        if val.is_null() {
            return Ok(std::ptr::null_mut());
        }
        let obj = val.as_object().ok_or_else(|| {
            JsNativeError::typ()
                .with_message("Expected a Pointer object or null for 'pointer' argument")
        })?;
        let borrow = obj.downcast_ref::<BoatsPointer>().ok_or_else(|| {
            JsNativeError::typ()
                .with_message("Expected a Pointer object or null for 'pointer' argument")
        })?;
        Ok(borrow.ptr)
    }

    /// Build the `Pointer` namespace object exported from `boats:ffi`.
    pub fn namespace(context: &mut Context) -> JsResult<JsObject> {
        let obj = JsObject::with_object_proto(context.intrinsics());

        // -----------------------------------------------------------------
        // Pointer.null() — returns a null pointer
        // -----------------------------------------------------------------
        add_fn(&obj, context, "null", 0, |_, _, context| {
            BoatsPointer::into_js(std::ptr::null_mut(), context)
        })?;

        // -----------------------------------------------------------------
        // Pointer.offset(ptr, bytes) — arithmetic
        // -----------------------------------------------------------------
        add_fn(&obj, context, "offset", 2, |_, args, context| {
            let ptr = BoatsPointer::from_js(args.first().unwrap_or(&JsValue::undefined()))?;
            let bytes = args
                .get(1)
                .unwrap_or(&JsValue::undefined())
                .to_index(context)? as usize;
            BoatsPointer::into_js(
                unsafe { (ptr as *mut u8).add(bytes) as *mut c_void },
                context,
            )
        })?;

        // -----------------------------------------------------------------
        // Pointer.of(arrayBuffer) — get a pointer to the backing data
        // -----------------------------------------------------------------
        add_fn(&obj, context, "of", 1, |_, args, context| {
            let undef = JsValue::undefined();
            let val = args.first().unwrap_or(&undef);
            let obj = val.as_object().ok_or_else(|| {
                JsNativeError::typ()
                    .with_message("Pointer.of: expected an ArrayBuffer or TypedArray")
            })?;

            // Try ArrayBuffer first, then TypedArray.
            let ab = if let Ok(ab) = JsArrayBuffer::from_object(obj.clone()) {
                ab
            } else {
                let ta = boa_engine::object::builtins::JsTypedArray::from_object(obj.clone())
                    .map_err(|_| {
                        JsNativeError::typ()
                            .with_message("Pointer.of: expected an ArrayBuffer or TypedArray")
                    })?;
                let buf_val = ta.buffer(context)?;
                let buf_obj = buf_val.as_object().ok_or_else(|| {
                    JsNativeError::typ().with_message("Pointer.of: TypedArray has no buffer")
                })?;
                JsArrayBuffer::from_object(buf_obj.clone())?
            };

            let data = ab.data().ok_or_else(|| {
                JsNativeError::typ().with_message("Pointer.of: ArrayBuffer is detached")
            })?;
            let ptr = data.as_ptr() as *mut c_void;
            // SAFETY: We return the raw pointer. The caller is responsible for
            // keeping the ArrayBuffer alive while the pointer is in use.
            BoatsPointer::into_js(ptr, context)
        })?;

        // -----------------------------------------------------------------
        // Pointer.toAddress(ptr) — returns the address as a BigInt
        // -----------------------------------------------------------------
        add_fn(&obj, context, "toAddress", 1, |_, args, _context| {
            let ptr = BoatsPointer::from_js(args.first().unwrap_or(&JsValue::undefined()))?;
            let addr = ptr as usize as u64;
            Ok(JsValue::from(JsBigInt::from(addr)))
        })?;

        // -----------------------------------------------------------------
        // Pointer.fromAddress(bigint) — wraps a raw numeric address
        // -----------------------------------------------------------------
        add_fn(&obj, context, "fromAddress", 1, |_, args, context| {
            let undef = JsValue::undefined();
            let val = args.first().unwrap_or(&undef);
            let addr: u64 = if let Some(bi) = val.as_bigint() {
                bi.to_i128() as u64
            } else {
                val.to_number(context)? as u64
            };
            BoatsPointer::into_js(addr as *mut c_void, context)
        })?;

        // -----------------------------------------------------------------
        // Read methods — Pointer.readU8(ptr, offset), etc.
        // -----------------------------------------------------------------
        add_fn(&obj, context, "readU8", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: u8 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const u8) };
            Ok(JsValue::from(v))
        })?;
        add_fn(&obj, context, "readI8", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: i8 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const i8) };
            Ok(JsValue::from(v))
        })?;
        add_fn(&obj, context, "readU16", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: u16 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const u16) };
            Ok(JsValue::from(v))
        })?;
        add_fn(&obj, context, "readI16", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: i16 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const i16) };
            Ok(JsValue::from(v))
        })?;
        add_fn(&obj, context, "readU32", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: u32 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const u32) };
            Ok(JsValue::from(v))
        })?;
        add_fn(&obj, context, "readI32", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: i32 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const i32) };
            Ok(JsValue::from(v))
        })?;
        add_fn(&obj, context, "readU64", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: u64 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const u64) };
            Ok(JsValue::from(JsBigInt::from(v)))
        })?;
        add_fn(&obj, context, "readI64", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: i64 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const i64) };
            Ok(JsValue::from(JsBigInt::from(v)))
        })?;
        add_fn(&obj, context, "readF32", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: f32 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const f32) };
            Ok(JsValue::from(f64::from(v)))
        })?;
        add_fn(&obj, context, "readF64", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: f64 = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const f64) };
            Ok(JsValue::from(v))
        })?;
        add_fn(&obj, context, "readPointer", 2, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v: *mut c_void =
                unsafe { std::ptr::read_unaligned(ptr.add(off) as *const *mut c_void) };
            BoatsPointer::into_js(v, context)
        })?;

        // -----------------------------------------------------------------
        // Write methods — Pointer.writeU8(ptr, offset, value), etc.
        // -----------------------------------------------------------------
        add_fn(&obj, context, "writeU8", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_int(args.get(2), context)? as u8;
            unsafe { std::ptr::write_unaligned(ptr.add(off), v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeI8", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_int(args.get(2), context)? as i8;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut i8, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeU16", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_int(args.get(2), context)? as u16;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut u16, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeI16", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_int(args.get(2), context)? as i16;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut i16, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeU32", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_int(args.get(2), context)? as u32;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut u32, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeI32", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_int(args.get(2), context)? as i32;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut i32, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeU64", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_u64(args.get(2), context)?;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut u64, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeI64", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = val_to_i64(args.get(2), context)?;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut i64, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeF32", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = args
                .get(2)
                .unwrap_or(&JsValue::undefined())
                .to_number(context)? as f32;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut f32, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writeF64", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = args
                .get(2)
                .unwrap_or(&JsValue::undefined())
                .to_number(context)?;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut f64, v) };
            Ok(JsValue::undefined())
        })?;
        add_fn(&obj, context, "writePointer", 3, |_, args, context| {
            let (ptr, off) = ptr_and_offset(args, context)?;
            let v = BoatsPointer::from_js(args.get(2).unwrap_or(&JsValue::undefined()))?;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut *mut c_void, v) };
            let _ = context;
            Ok(JsValue::undefined())
        })?;

        Ok(obj)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Register a native function as a property on `obj`.
fn add_fn(
    obj: &JsObject,
    context: &mut Context,
    name: &str,
    length: usize,
    f: fn(&JsValue, &[JsValue], &mut Context) -> JsResult<JsValue>,
) -> JsResult<()> {
    let js_name = JsValue::from(js_string!(name));
    let name_str = js_name.to_string(context)?;
    let func = FunctionObjectBuilder::new(context.realm(), NativeFunction::from_fn_ptr(f))
        .name(name_str)
        .length(length)
        .build();
    obj.set(js_string!(name), func, false, context)?;
    Ok(())
}

/// Extract `(*mut u8, usize)` from `(ptr_arg, offset_arg)`.
fn ptr_and_offset(args: &[JsValue], context: &mut Context) -> JsResult<(*mut u8, usize)> {
    let ptr = BoatsPointer::from_js(args.first().unwrap_or(&JsValue::undefined()))?;
    let off = args
        .get(1)
        .unwrap_or(&JsValue::undefined())
        .to_index(context)? as usize;
    Ok((ptr as *mut u8, off))
}

/// Accept number or BigInt, return i128.
fn val_to_int(val: Option<&JsValue>, context: &mut Context) -> JsResult<i128> {
    let undef = JsValue::undefined();
    let v = val.unwrap_or(&undef);
    if let Some(bi) = v.as_bigint() {
        return Ok(bi.to_i128());
    }
    Ok(v.to_number(context)? as i128)
}

fn val_to_u64(val: Option<&JsValue>, context: &mut Context) -> JsResult<u64> {
    let undef = JsValue::undefined();
    let v = val.unwrap_or(&undef);
    if let Some(bi) = v.as_bigint() {
        return Ok(bi.to_i128() as u64);
    }
    Ok(v.to_number(context)? as u64)
}

fn val_to_i64(val: Option<&JsValue>, context: &mut Context) -> JsResult<i64> {
    let undef = JsValue::undefined();
    let v = val.unwrap_or(&undef);
    if let Some(bi) = v.as_bigint() {
        return Ok(bi.to_i128() as i64);
    }
    Ok(v.to_number(context)? as i64)
}
