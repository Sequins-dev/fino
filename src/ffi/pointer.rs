//! V8 representation of an opaque C pointer exposed to JS.
//!
//! Pointers are represented as an 8-byte `ArrayBuffer` whose contents are the
//! raw memory address as a little-endian `u64`. Null pointers are JS `null`.
//! This lets JS callers read the address as a pair of `Uint32`s (or via
//! `DataView.getBigUint64`) without any BigInt arithmetic on hot paths.

use std::ffi::c_void;

use ::v8;

// ---------------------------------------------------------------------------
// Create / unwrap a pointer value
// ---------------------------------------------------------------------------

/// Convert a raw C pointer to an 8-byte JS `ArrayBuffer` containing the
/// address as a little-endian `u64`. Null pointers become JS `null`.
pub fn into_js<'s>(scope: &mut v8::HandleScope<'s>, ptr: *mut c_void) -> v8::Local<'s, v8::Value> {
    if ptr.is_null() {
        return v8::null(scope).into();
    }
    let ab = v8::ArrayBuffer::new(scope, 8);
    let bs = ab.get_backing_store();
    if let Some(data) = bs.data() {
        // SAFETY: data points to 8 bytes we just allocated; no aliasing.
        unsafe {
            std::ptr::write_unaligned(data.as_ptr() as *mut u64, ptr as u64);
        }
    }
    ab.into()
}

/// Convert a JS pointer value back to a raw C pointer.
///
/// Accepts:
///   - `null` / `undefined` → C null pointer
///   - An 8-byte `ArrayBuffer` → read `u64` from backing store
///   - An `ArrayBufferView` into an ≥8-byte buffer (offset applied)
///
/// Returns `None` and throws a `TypeError` for any other value.
pub fn from_js(scope: &mut v8::HandleScope, val: v8::Local<v8::Value>) -> Option<*mut c_void> {
    if val.is_null_or_undefined() {
        return Some(std::ptr::null_mut());
    }

    let (base_ptr, available): (*const u8, usize) =
        if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(val) {
            let bs = ab.get_backing_store();
            let len = bs.byte_length();
            let p = bs
                .data()
                .map(|d| d.as_ptr() as *const u8)
                .unwrap_or(std::ptr::null());
            (p, len)
        } else if let Ok(abv) = v8::Local::<v8::ArrayBufferView>::try_from(val) {
            // abv.data() already applies byteOffset.
            let p = abv.data() as *const u8;
            let len = abv.byte_length();
            (p, len)
        } else {
            throw_type_error(scope, "Expected a pointer buffer (ArrayBuffer) or null");
            return None;
        };

    if available < 8 {
        throw_type_error(scope, "Pointer buffer must be at least 8 bytes");
        return None;
    }

    // SAFETY: we've verified at least 8 bytes are available.
    let addr: u64 = unsafe { std::ptr::read_unaligned(base_ptr as *const u64) };
    Some(addr as *mut c_void)
}

// ---------------------------------------------------------------------------
// Pointer namespace object
// ---------------------------------------------------------------------------

pub fn namespace<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);

    macro_rules! set_method {
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope).expect("get_function");
            let key = v8::String::new(scope, $name).unwrap();
            obj.set(scope, key.into(), func.into());
        }};
    }

    set_method!("null", ptr_null);
    set_method!("addr", ptr_addr);
    set_method!("offset", ptr_offset);
    set_method!("of", ptr_of);
    set_method!("readU8", read_u8);
    set_method!("readI8", read_i8);
    set_method!("readU16", read_u16);
    set_method!("readI16", read_i16);
    set_method!("readU32", read_u32);
    set_method!("readI32", read_i32);
    set_method!("readU64", read_u64);
    set_method!("readI64", read_i64);
    set_method!("readF32", read_f32);
    set_method!("readF64", read_f64);
    set_method!("readPointer", read_pointer);
    set_method!("writeU8", write_u8);
    set_method!("writeI8", write_i8);
    set_method!("writeU16", write_u16);
    set_method!("writeI16", write_i16);
    set_method!("writeU32", write_u32);
    set_method!("writeI32", write_i32);
    set_method!("writeU64", write_u64);
    set_method!("writeI64", write_i64);
    set_method!("writeF32", write_f32);
    set_method!("writeF64", write_f64);
    set_method!("writePointer", write_pointer);
    set_method!("copyFrom", copy_from);
    set_method!("copyFromInto", copy_from_into);
    set_method!("copyTo", copy_to);
    set_method!("view", ptr_view);

    obj
}

// ---------------------------------------------------------------------------
// Zero-copy external views over native memory
// ---------------------------------------------------------------------------

/// Deleter context for a `Pointer.view` backing store. Boxed and handed to V8
/// as `deleter_data`; reclaimed exactly once when the deleter runs.
struct ViewCtx {
    releases: crate::async_rt::ViewReleaseQueue,
    wake_write: std::os::unix::io::RawFd,
    callback_id: Option<usize>,
    byte_length: usize,
}

/// Backing-store deleter for `Pointer.view` buffers. V8 may invoke this on any
/// thread (GC or background), so it must not touch V8: it enqueues a release
/// record and wakes the event loop, where `drain_view_releases` runs the JS
/// `onRelease` callback.
unsafe extern "C" fn view_deleter(
    _data: *mut c_void,
    _byte_length: usize,
    deleter_data: *mut c_void,
) {
    if deleter_data.is_null() {
        return;
    }
    // SAFETY: deleter_data is the Box<ViewCtx> we leaked in ptr_view; V8 calls
    // the deleter exactly once per backing store.
    let ctx = unsafe { Box::from_raw(deleter_data as *mut ViewCtx) };
    if let Ok(mut queue) = ctx.releases.lock() {
        queue.push(crate::async_rt::ViewRelease {
            callback_id: ctx.callback_id,
            byte_length: ctx.byte_length,
        });
    }
    // SAFETY: wake_write is the isolate's self-pipe; a failed write (e.g.
    // during shutdown) is harmless because the drain also runs unconditionally.
    unsafe { libc::write(ctx.wake_write, b"\x01".as_ptr() as *const c_void, 1) };
}

/// `Pointer.view(ptr, len, opts?)` — create an `ArrayBuffer` that aliases the
/// native memory at `[ptr, ptr + len)` without copying.
///
/// The caller must guarantee the native allocation outlives the buffer unless
/// `opts.onRelease` owns freeing it: the callback fires exactly once on the JS
/// thread after V8 frees the backing store (GC of the buffer, or transfer/
/// detach). Structured clone copies the bytes; transfer detaches and triggers
/// release.
fn ptr_view(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(ptr) = from_js(scope, args.get(0)) else {
        return;
    };
    if ptr.is_null() {
        throw_type_error(scope, "Pointer.view: pointer must not be null");
        return;
    }

    let raw_len = args.get(1).integer_value(scope).unwrap_or(-1);
    if raw_len < 0 {
        throw_type_error(scope, "Pointer.view: length must be a non-negative integer");
        return;
    }
    let len = raw_len as usize;

    let mut callback_id: Option<usize> = None;
    let opts_val = args.get(2);
    if !opts_val.is_null_or_undefined() {
        let Ok(opts) = v8::Local::<v8::Object>::try_from(opts_val) else {
            throw_type_error(scope, "Pointer.view: options must be an object");
            return;
        };
        let key = v8::String::new(scope, "onRelease").unwrap();
        if let Some(cb_val) = opts.get(scope, key.into())
            && !cb_val.is_null_or_undefined()
        {
            let Ok(func) = v8::Local::<v8::Function>::try_from(cb_val) else {
                throw_type_error(scope, "Pointer.view: onRelease must be a function");
                return;
            };
            let global = v8::Global::new(scope, func);
            callback_id = Some(crate::async_rt::js_calls::register_callback(global));
        }
    }

    let Some((releases, wake_write)) = crate::async_rt::release_handle() else {
        if let Some(id) = callback_id {
            crate::async_rt::js_calls::unregister_callback(id);
        }
        throw_type_error(scope, "Pointer.view: async runtime not initialized");
        return;
    };

    let ctx = Box::new(ViewCtx {
        releases,
        wake_write,
        callback_id,
        byte_length: len,
    });
    // SAFETY: ptr/len describe caller-owned native memory; the deleter runs
    // exactly once and reclaims the leaked ViewCtx.
    let store = unsafe {
        v8::ArrayBuffer::new_backing_store_from_ptr(
            ptr,
            len,
            view_deleter,
            Box::into_raw(ctx) as *mut c_void,
        )
    };
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store.make_shared());
    scope.adjust_amount_of_external_allocated_memory(len as i64);
    rv.set(ab.into());
}

// ---------------------------------------------------------------------------
// Bulk copy helpers for VFS / large buffer transfers
// ---------------------------------------------------------------------------

/// `Pointer.copyFrom(ptr, len)` — copy `len` bytes from the address in `ptr`
/// into a new `Uint8Array` and return it.
fn copy_from(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(ptr) = from_js(scope, args.get(0)) else {
        return;
    };
    let len = args.get(1).integer_value(scope).unwrap_or(0) as usize;
    if len == 0 {
        let ab = v8::ArrayBuffer::new(scope, 0);
        if let Some(ta) = v8::Uint8Array::new(scope, ab, 0, 0) {
            rv.set(ta.into());
        }
        return;
    }
    let ab = v8::ArrayBuffer::new(scope, len);
    let bs = ab.get_backing_store();
    if let Some(dst) = bs.data() {
        // SAFETY: ptr is a valid C pointer, dst points to freshly-allocated
        // ArrayBuffer backing store. No aliasing.
        unsafe {
            std::ptr::copy_nonoverlapping(ptr as *const u8, dst.as_ptr() as *mut u8, len);
        }
    }
    if let Some(ta) = v8::Uint8Array::new(scope, ab, 0, len) {
        rv.set(ta.into());
    }
}

/// `Pointer.copyTo(ptr, src)` — copy bytes from `src` (Uint8Array or
/// ArrayBuffer) into the C buffer at the address stored in `ptr`.
fn copy_to(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let Some(ptr) = from_js(scope, args.get(0)) else {
        return;
    };
    let src_val = args.get(1);
    let (src_ptr, len): (*const u8, usize) =
        if let Ok(ta) = v8::Local::<v8::TypedArray>::try_from(src_val) {
            (ta.data() as *const u8, ta.byte_length())
        } else if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(src_val) {
            let bs = ab.get_backing_store();
            let p = bs
                .data()
                .map(|d| d.as_ptr() as *const u8)
                .unwrap_or(std::ptr::null());
            (p, bs.byte_length())
        } else {
            throw_type_error(
                scope,
                "Pointer.copyTo: expected Uint8Array or ArrayBuffer as second argument",
            );
            return;
        };
    if len > 0 && !src_ptr.is_null() && !ptr.is_null() {
        // SAFETY: caller guarantees ptr is a valid C buffer of at least `len` bytes.
        unsafe { std::ptr::copy_nonoverlapping(src_ptr, ptr as *mut u8, len) };
    }
}

/// `Pointer.copyFromInto(dest, ptr, len?)` — copy bytes from the address in
/// `ptr` into an existing ArrayBuffer or ArrayBufferView.
fn copy_from_into(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let dest_val = args.get(0);
    let (dest_ptr, dest_len): (*mut u8, usize) =
        if let Ok(abv) = v8::Local::<v8::ArrayBufferView>::try_from(dest_val) {
            (abv.data() as *mut u8, abv.byte_length())
        } else if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(dest_val) {
            let bs = ab.get_backing_store();
            let p = bs
                .data()
                .map(|d| d.as_ptr() as *mut u8)
                .unwrap_or(std::ptr::null_mut());
            (p, bs.byte_length())
        } else {
            throw_type_error(
                scope,
                "Pointer.copyFromInto: expected ArrayBuffer or ArrayBufferView as first argument",
            );
            return;
        };

    let Some(src_ptr) = from_js(scope, args.get(1)) else {
        return;
    };

    let len = if args.get(2).is_undefined() {
        dest_len
    } else {
        let raw = args.get(2).integer_value(scope).unwrap_or(0);
        if raw < 0 {
            throw_type_error(scope, "Pointer.copyFromInto: length must be non-negative");
            return;
        }
        raw as usize
    };

    if len > dest_len {
        throw_type_error(scope, "Pointer.copyFromInto: destination too small");
        return;
    }

    if len > 0 {
        if dest_ptr.is_null() || src_ptr.is_null() {
            throw_type_error(scope, "Pointer.copyFromInto: null pointer");
            return;
        }
        // SAFETY: destination bounds are checked above; caller guarantees
        // source points to at least `len` readable bytes.
        unsafe { std::ptr::copy_nonoverlapping(src_ptr as *const u8, dest_ptr, len) };
    }
}

// ---------------------------------------------------------------------------
// Pointer methods
// ---------------------------------------------------------------------------

fn ptr_null(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::null(scope).into());
}

fn ptr_addr(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let src_val: v8::Local<v8::Value> = args.get(0);
    let src_ptr: u64 = if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(src_val) {
        ab.get_backing_store()
            .data()
            .map(|p| p.as_ptr() as u64)
            .unwrap_or(0)
    } else if let Ok(abv) = v8::Local::<v8::ArrayBufferView>::try_from(src_val) {
        abv.data() as u64
    } else {
        throw_type_error(
            scope,
            "Pointer.addr: expected an ArrayBuffer or ArrayBufferView",
        );
        return;
    };

    rv.set(v8::BigInt::new_from_u64(scope, src_ptr).into());
}

fn ptr_offset(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(ptr) = from_js(scope, args.get(0)) else {
        return;
    };
    let bytes = args.get(1).integer_value(scope).unwrap_or(0) as usize;
    let new_ptr = unsafe { (ptr as *mut u8).add(bytes) as *mut c_void };
    rv.set(into_js(scope, new_ptr));
}

/// `Pointer.of(source)` — returns a fresh 8-byte `ArrayBuffer` containing the
/// backing-store address of `source`. For an `ArrayBufferView` (TypedArray /
/// DataView), `byteOffset` is included so the address points at element 0.
///
/// `Pointer.of(source, arena, byteOffset)` — arena path: writes the address
/// directly into `arena` at `byteOffset` without allocating a new buffer.
/// Returns `undefined`. Use this when the caller owns a reusable arena and
/// wants zero per-call allocation.
fn ptr_of(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // Extract the backing-store address of source.
    let src_val: v8::Local<v8::Value> = args.get(0);
    let src_ptr: u64 = if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(src_val) {
        ab.get_backing_store()
            .data()
            .map(|p| p.as_ptr() as u64)
            .unwrap_or(0)
    } else if let Ok(abv) = v8::Local::<v8::ArrayBufferView>::try_from(src_val) {
        // data() applies byteOffset — correct for TypedArray views.
        abv.data() as u64
    } else {
        throw_type_error(
            scope,
            "Pointer.of: expected an ArrayBuffer or ArrayBufferView",
        );
        return;
    };

    // Arena path: if a dest buffer is provided, write there and return undefined.
    let dest_val: v8::Local<v8::Value> = args.get(1);
    if !dest_val.is_undefined() {
        let (dest_base, dest_len): (*mut u8, usize) =
            if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(dest_val) {
                let bs = ab.get_backing_store();
                let p = bs
                    .data()
                    .map(|d| d.as_ptr() as *mut u8)
                    .unwrap_or(std::ptr::null_mut());
                (p, bs.byte_length())
            } else if let Ok(abv) = v8::Local::<v8::ArrayBufferView>::try_from(dest_val) {
                (abv.data() as *mut u8, abv.byte_length())
            } else {
                throw_type_error(
                    scope,
                    "Pointer.of: dest must be an ArrayBuffer or ArrayBufferView",
                );
                return;
            };
        let byte_off = args.get(2).integer_value(scope).unwrap_or(0) as usize;
        if dest_len < byte_off + 8 {
            throw_type_error(scope, "Pointer.of: dest too small");
            return;
        }
        // SAFETY: bounds checked above; dest is pinned for the call duration.
        unsafe { std::ptr::write_unaligned(dest_base.add(byte_off) as *mut u64, src_ptr) };
        return; // return undefined
    }

    // No arena: allocate a fresh 8-byte ArrayBuffer.
    rv.set(into_js(scope, src_ptr as *mut c_void));
}

// ---------------------------------------------------------------------------
// Read methods
// ---------------------------------------------------------------------------

macro_rules! read_int {
    ($name:ident, $ty:ty, $conv:expr) => {
        fn $name(
            scope: &mut v8::HandleScope,
            args: v8::FunctionCallbackArguments,
            mut rv: v8::ReturnValue,
        ) {
            let Some((ptr, off)) = ptr_and_offset(scope, &args) else {
                return;
            };
            let v: $ty = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const $ty) };
            rv.set($conv(scope, v));
        }
    };
}

read_int!(read_u8, u8, |scope, v: u8| v8::Number::new(scope, v as f64)
    .into());
read_int!(read_i8, i8, |scope, v: i8| v8::Number::new(scope, v as f64)
    .into());
read_int!(read_u16, u16, |scope, v: u16| v8::Number::new(
    scope, v as f64
)
.into());
read_int!(read_i16, i16, |scope, v: i16| v8::Number::new(
    scope, v as f64
)
.into());
read_int!(read_u32, u32, |scope, v: u32| v8::Number::new(
    scope, v as f64
)
.into());
read_int!(read_i32, i32, |scope, v: i32| v8::Number::new(
    scope, v as f64
)
.into());
read_int!(read_u64, u64, |scope, v: u64| -> v8::Local<v8::Value> {
    v8::BigInt::new_from_u64(scope, v).into()
});
read_int!(read_i64, i64, |scope, v: i64| -> v8::Local<v8::Value> {
    v8::BigInt::new_from_i64(scope, v).into()
});
read_int!(read_f32, f32, |scope, v: f32| v8::Number::new(
    scope, v as f64
)
.into());
read_int!(read_f64, f64, |scope, v: f64| v8::Number::new(scope, v)
    .into());

fn read_pointer(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some((ptr, off)) = ptr_and_offset(scope, &args) else {
        return;
    };
    let v: *mut c_void = unsafe { std::ptr::read_unaligned(ptr.add(off) as *const *mut c_void) };
    rv.set(into_js(scope, v));
}

// ---------------------------------------------------------------------------
// Write methods
// ---------------------------------------------------------------------------

macro_rules! write_int {
    ($name:ident, $ty:ty) => {
        fn $name(
            scope: &mut v8::HandleScope,
            args: v8::FunctionCallbackArguments,
            _rv: v8::ReturnValue,
        ) {
            let Some((ptr, off)) = ptr_and_offset(scope, &args) else {
                return;
            };
            let v = val_to_i128(scope, args.get(2)) as $ty;
            unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut $ty, v) };
        }
    };
}

write_int!(write_u8, u8);
write_int!(write_i8, i8);
write_int!(write_u16, u16);
write_int!(write_i16, i16);
write_int!(write_u32, u32);
write_int!(write_i32, i32);
write_int!(write_u64, u64);
write_int!(write_i64, i64);

fn write_f32(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let Some((ptr, off)) = ptr_and_offset(scope, &args) else {
        return;
    };
    let v = args.get(2).number_value(scope).unwrap_or(0.0) as f32;
    unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut f32, v) };
}

fn write_f64(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let Some((ptr, off)) = ptr_and_offset(scope, &args) else {
        return;
    };
    let v = args.get(2).number_value(scope).unwrap_or(0.0);
    unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut f64, v) };
}

fn write_pointer(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let Some((ptr, off)) = ptr_and_offset(scope, &args) else {
        return;
    };
    let Some(v) = from_js(scope, args.get(2)) else {
        return;
    };
    unsafe { std::ptr::write_unaligned(ptr.add(off) as *mut *mut c_void, v) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn ptr_and_offset(
    scope: &mut v8::HandleScope,
    args: &v8::FunctionCallbackArguments,
) -> Option<(*mut u8, usize)> {
    let ptr = from_js(scope, args.get(0))? as *mut u8;
    let off = args.get(1).integer_value(scope).unwrap_or(0) as usize;
    Some((ptr, off))
}

fn val_to_i128(scope: &mut v8::HandleScope, val: v8::Local<v8::Value>) -> i128 {
    if let Ok(bi) = v8::Local::<v8::BigInt>::try_from(val) {
        return bi.i64_value().0 as i128;
    }
    val.number_value(scope).unwrap_or(0.0) as i128
}

fn throw_type_error(scope: &mut v8::HandleScope, msg: &str) {
    if let Some(msg_str) = v8::String::new(scope, msg) {
        let exc = v8::Exception::type_error(scope, msg_str);
        scope.throw_exception(exc);
    }
}
