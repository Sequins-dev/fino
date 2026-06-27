//! `internal:serializer` — V8 ValueSerializer / ValueDeserializer bindings.
//!
//! Exports two functions used by cross-thread message passing:
//!
//! - `serialize(value: any, transferList?: ArrayBuffer[]) → Uint8Array[]`
//!   Serializes any structured-cloneable JS value to a byte buffer using V8's
//!   native wire format (the same format browsers use for postMessage).
//!   Returns a JS Array where `[0]` is the main bytes and `[1..]` are the raw
//!   data bytes of each transferred ArrayBuffer (which is then detached).
//!
//! - `deserialize(bytes: Uint8Array, transferStores?: Uint8Array[]) → any`
//!   Deserializes a byte buffer produced by `serialize` back to a JS value.
//!   Must be called in the destination Isolate — the deserialized value is a
//!   fresh JS object in the current context.  If `transferStores` is provided,
//!   each entry is reconstructed as a fresh ArrayBuffer and wired into the
//!   deserialized value at the corresponding transfer slot.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use ::v8;

// ---------------------------------------------------------------------------
// SharedArrayBuffer registry
//
// Allows SABs to cross thread-Isolate boundaries.  Both Isolates must use the
// same ArrayBufferAllocator (see runtime::shared_allocator()); then the same
// physical memory is accessible from both.
//
// The registry maps:
//   ptr_to_id: data pointer (usize) → stable ID (u32)
//   id_to_bs:  ID (u32) → SharedRef<BackingStore>
//
// IDs are assigned sequentially.  The same SAB always gets the same ID so
// that multiple serializations of the same SAB resolve to the same backing
// store on deserialization.
// ---------------------------------------------------------------------------

/// Newtype so `SharedRef<BackingStore>` can live in a global.
///
/// Safety: SharedArrayBuffer backing stores are designed for cross-thread
/// access — that is the entire point of SAB.  The backing store reference
/// count (shared_ptr) is also thread-safe.
struct SendSyncBs(v8::SharedRef<v8::BackingStore>);
unsafe impl Send for SendSyncBs {}
unsafe impl Sync for SendSyncBs {}

#[derive(Default)]
struct SabRegistry {
    next_id: u32,
    ptr_to_id: HashMap<usize, u32>,
    id_to_bs: HashMap<u32, SendSyncBs>,
}

static SAB_REGISTRY: OnceLock<Mutex<SabRegistry>> = OnceLock::new();

fn sab_registry() -> &'static Mutex<SabRegistry> {
    SAB_REGISTRY.get_or_init(|| Mutex::new(SabRegistry::default()))
}

// ---------------------------------------------------------------------------
// Delegate implementations
// ---------------------------------------------------------------------------

struct FinoSerializer;

impl v8::ValueSerializerImpl for FinoSerializer {
    fn throw_data_clone_error<'s>(
        &self,
        scope: &mut v8::HandleScope<'s>,
        message: v8::Local<'s, v8::String>,
    ) {
        let exc = v8::Exception::error(scope, message);
        scope.throw_exception(exc);
    }

    fn get_shared_array_buffer_id<'s>(
        &self,
        _scope: &mut v8::HandleScope<'s>,
        sab: v8::Local<'s, v8::SharedArrayBuffer>,
    ) -> Option<u32> {
        let bs = sab.get_backing_store();
        // Use the raw data pointer as a stable cross-Isolate identity key.
        let ptr = bs.data().map_or(0usize, |p| p.as_ptr() as usize);
        let mut reg = sab_registry().lock().unwrap();
        if let Some(&id) = reg.ptr_to_id.get(&ptr) {
            return Some(id);
        }
        let id = reg.next_id;
        reg.next_id += 1;
        reg.ptr_to_id.insert(ptr, id);
        reg.id_to_bs.insert(id, SendSyncBs(bs));
        Some(id)
    }
}

struct FinoDeserializer;

impl v8::ValueDeserializerImpl for FinoDeserializer {
    fn get_shared_array_buffer_from_id<'s>(
        &self,
        scope: &mut v8::HandleScope<'s>,
        id: u32,
    ) -> Option<v8::Local<'s, v8::SharedArrayBuffer>> {
        let reg = sab_registry().lock().unwrap();
        let bs = &reg.id_to_bs.get(&id)?.0;
        Some(v8::SharedArrayBuffer::with_backing_store(scope, bs))
    }
}

// ---------------------------------------------------------------------------
// Synthetic module
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> =
        ["serialize", "deserialize", "detachArrayBuffer"]
            .iter()
            .map(|n| v8::String::new(scope, n).unwrap())
            .collect();

    let module_name = v8::String::new(scope, "internal:serializer").unwrap();
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

    set_fn!("serialize", native_serialize);
    set_fn!("deserialize", native_deserialize);
    set_fn!("detachArrayBuffer", native_detach_array_buffer);

    Some(v8::undefined(scope).into())
}

fn native_detach_array_buffer(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(args.get(0)) else {
        let msg =
            v8::String::new(scope, "detachArrayBuffer: argument must be an ArrayBuffer").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };
    rv.set(v8::Boolean::new(scope, ab.detach(None).unwrap_or(false)).into());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Copy raw bytes from a Uint8Array argument into a `Vec<u8>`.
fn u8a_to_vec(scope: &mut v8::HandleScope, u8a: v8::Local<v8::Uint8Array>) -> Vec<u8> {
    let Some(ab) = u8a.buffer(scope) else {
        return Vec::new();
    };
    let Some(data_ptr) = ab.data() else {
        return Vec::new();
    };
    let offset = u8a.byte_offset();
    let len = u8a.byte_length();
    // SAFETY: data_ptr into live V8 ArrayBuffer; slice doesn't outlive this frame.
    unsafe {
        std::slice::from_raw_parts((data_ptr.as_ptr() as *const u8).add(offset), len).to_vec()
    }
}

/// Wrap a `Vec<u8>` in a freshly-allocated `Uint8Array`.
fn vec_to_u8a<'s>(
    scope: &mut v8::HandleScope<'s>,
    bytes: &[u8],
) -> Option<v8::Local<'s, v8::Uint8Array>> {
    let len = bytes.len();
    let bs = v8::ArrayBuffer::new_backing_store(scope, len);
    if !bytes.is_empty() {
        // SAFETY: backing store freshly allocated; we own the only reference.
        let dst = bs.data().unwrap().as_ptr() as *mut u8;
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, len) };
    }
    let ab = v8::ArrayBuffer::with_backing_store(scope, &bs.make_shared());
    v8::Uint8Array::new(scope, ab, 0, len)
}

// ---------------------------------------------------------------------------
// serialize(value: any, transferList?: ArrayBuffer[]) → Uint8Array[]
//
// Returns a JS Array where element [0] is the main serialized bytes and
// elements [1..] are the raw backing-store bytes of each transferred
// ArrayBuffer.  The transferred buffers are detached after extraction.
// ---------------------------------------------------------------------------

fn native_serialize(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let value = args.get(0);
    let context = scope.get_current_context();

    // Extract optional transfer list (Array of ArrayBuffer) before the serializer
    // is created so we can freely use `scope`.
    let transfer_abs: Vec<v8::Local<v8::ArrayBuffer>> =
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
            let count = arr.length();
            let mut abs = Vec::with_capacity(count as usize);
            for i in 0..count {
                let idx = v8::Integer::new(scope, i as i32);
                if let Some(elem) = arr.get(scope, idx.into())
                    && let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(elem)
                {
                    abs.push(ab);
                }
            }
            abs
        } else {
            Vec::new()
        };

    // Create serializer.  `new` only borrows `scope` transiently to get the
    // Isolate pointer; the returned `ValueSerializer<'_>` lifetime is tied to
    // the delegate, not to `scope`.
    let ser = v8::ValueSerializer::new(scope, Box::new(FinoSerializer));

    use v8::ValueSerializerHelper;
    ser.write_header();

    // Register each ArrayBuffer as a transfer (V8 will write a back-reference).
    for (i, &ab) in transfer_abs.iter().enumerate() {
        ser.transfer_array_buffer(i as u32, ab);
    }

    if ser.write_value(context, value).is_none() {
        // Exception was thrown by the delegate.
        return;
    }

    // Save backing-store data BEFORE detaching so we can ship it with the message.
    let transfer_data: Vec<Vec<u8>> = transfer_abs
        .iter()
        .map(|ab| {
            if let Some(ptr) = ab.data() {
                let len = ab.byte_length();
                // SAFETY: pointer into live AB whose lifetime covers this frame.
                unsafe { std::slice::from_raw_parts(ptr.as_ptr() as *const u8, len).to_vec() }
            } else {
                Vec::new()
            }
        })
        .collect();

    let main_bytes = ser.release();

    // Detach each transferred ArrayBuffer (neuter it per transfer semantics).
    for ab in &transfer_abs {
        let _ = ab.detach(None);
    }

    // Build return Array: [mainBytes, store0, store1, ...].
    let total = 1 + transfer_data.len();
    let result = v8::Array::new(scope, total as i32);

    // Index 0 — main bytes.
    if let Some(u8a) = vec_to_u8a(scope, &main_bytes) {
        let zero = v8::Integer::new(scope, 0);
        result.set(scope, zero.into(), u8a.into());
    }

    // Indices 1.. — transfer store bytes.
    for (i, store_bytes) in transfer_data.iter().enumerate() {
        if let Some(u8a) = vec_to_u8a(scope, store_bytes) {
            let idx = v8::Integer::new(scope, (i + 1) as i32);
            result.set(scope, idx.into(), u8a.into());
        }
    }

    rv.set(result.into());
}

// ---------------------------------------------------------------------------
// deserialize(bytes: Uint8Array, transferStores?: Uint8Array[]) → any
//
// Reconstructs a value from bytes produced by `serialize`.  If `transferStores`
// is provided, each element is turned into a fresh ArrayBuffer and registered
// with the deserializer so transferred back-references resolve correctly.
// ---------------------------------------------------------------------------

fn native_deserialize(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let buf_arg = args.get(0);
    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(buf_arg) else {
        let msg = v8::String::new(scope, "deserialize: argument must be a Uint8Array").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    // Build the transfer-store ArrayBuffers BEFORE creating the deserializer so
    // we can freely use `scope`.  Each store is a fresh AB containing a copy of
    // the transferred bytes.
    let transfer_abs: Vec<v8::Local<v8::ArrayBuffer>> =
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
            let count = arr.length();
            let mut abs = Vec::with_capacity(count as usize);
            for i in 0..count {
                let idx = v8::Integer::new(scope, i as i32);
                if let Some(elem) = arr.get(scope, idx.into())
                    && let Ok(store_u8a) = v8::Local::<v8::Uint8Array>::try_from(elem)
                {
                    let raw = u8a_to_vec(scope, store_u8a);
                    let len = raw.len();
                    let bs = v8::ArrayBuffer::new_backing_store(scope, len);
                    if !raw.is_empty() {
                        let dst = bs.data().unwrap().as_ptr() as *mut u8;
                        // SAFETY: freshly allocated backing store.
                        unsafe { std::ptr::copy_nonoverlapping(raw.as_ptr(), dst, len) };
                    }
                    let ab = v8::ArrayBuffer::with_backing_store(scope, &bs.make_shared());
                    abs.push(ab);
                }
            }
            abs
        } else {
            Vec::new()
        };

    // Access the underlying bytes directly from the backing store.
    let Some(ab) = u8a.buffer(scope) else {
        let msg = v8::String::new(scope, "deserialize: no backing buffer").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    };
    let Some(data_ptr) = ab.data() else {
        let msg = v8::String::new(scope, "deserialize: detached ArrayBuffer").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    let offset = u8a.byte_offset();
    let len = u8a.byte_length();
    // SAFETY: data_ptr points into a live V8 ArrayBuffer we own for this scope;
    // the slice does not outlive this call frame.
    let bytes =
        unsafe { std::slice::from_raw_parts((data_ptr.as_ptr() as *const u8).add(offset), len) };

    let context = scope.get_current_context();
    let deser = v8::ValueDeserializer::new(scope, Box::new(FinoDeserializer), bytes);

    use v8::ValueDeserializerHelper;

    // Register each reconstructed ArrayBuffer as a transfer slot.
    for (i, ab) in transfer_abs.iter().enumerate() {
        deser.transfer_array_buffer(i as u32, *ab);
    }

    if deser.read_header(context).is_none() {
        // Exception thrown or invalid data — propagate.
        return;
    }

    match deser.read_value(context) {
        Some(val) => rv.set(val),
        None => {
            let msg = v8::String::new(scope, "deserialize: failed to read value").unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
        }
    }
}
