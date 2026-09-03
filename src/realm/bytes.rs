//! Shared Uint8Array ↔ byte-vector conversion helpers for the realm layer.
//!
//! Cross-realm messaging (thread, sandbox, process, transit, broadcast) all
//! copy JS `Uint8Array` payloads into owned `Vec<u8>` buffers and wrap reply
//! bytes back into fresh `Uint8Array`s. This module is the single owner of
//! those unsafe conversions so the SAFETY reasoning lives in one place.

/// Copy the bytes of a `Uint8Array` argument into an owned vector.
///
/// Returns `None` when `value` is not a `Uint8Array`, has no buffer, or the
/// buffer has no data pointer.
pub fn u8a_to_vec(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    let array = v8::Local::<v8::Uint8Array>::try_from(value).ok()?;
    u8a_slice_to_vec(scope, array)
}

/// Copy the bytes of an already-typed `Uint8Array` into an owned vector.
pub fn u8a_slice_to_vec(
    scope: &mut v8::PinScope,
    u8a: v8::Local<v8::Uint8Array>,
) -> Option<Vec<u8>> {
    let buffer = u8a.buffer(scope)?;
    let data = buffer.data()?;
    let offset = u8a.byte_offset();
    let len = u8a.byte_length();
    // SAFETY: `data` points into a live V8 ArrayBuffer owned for this scope;
    // the slice does not outlive the frame.
    Some(unsafe {
        std::slice::from_raw_parts((data.as_ptr() as *const u8).add(offset), len).to_vec()
    })
}

/// Copy an Array of `Uint8Array` elements into owned vectors.
///
/// Non-`Uint8Array` elements are skipped, matching the previous per-caller
/// behavior. Returns an empty vector when the argument is not an Array.
pub fn copy_transfer_stores(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Vec<Vec<u8>> {
    let Ok(arr) = v8::Local::<v8::Array>::try_from(value) else {
        return Vec::new();
    };
    let count = arr.length();
    let mut stores = Vec::with_capacity(count as usize);
    for i in 0..count {
        let idx = v8::Integer::new(scope, i as i32);
        if let Some(elem) = arr.get(scope, idx.into())
            && let Some(raw) = u8a_to_vec(scope, elem)
        {
            stores.push(raw);
        }
    }
    stores
}

/// Wrap a byte slice in a freshly-allocated `Uint8Array`.
///
/// Returns `None` when V8 cannot allocate the backing store or array.
pub fn vec_to_u8a<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    bytes: &[u8],
) -> Option<v8::Local<'s, v8::Uint8Array>> {
    let len = bytes.len();
    let bs = v8::ArrayBuffer::new_backing_store(scope, len);
    if !bytes.is_empty() {
        let dst = bs.data()?.as_ptr() as *mut u8;
        // SAFETY: freshly allocated backing store, exclusive access.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, len) };
    }
    let ab = v8::ArrayBuffer::with_backing_store(scope, &bs.make_shared());
    v8::Uint8Array::new(scope, ab, 0, len)
}
