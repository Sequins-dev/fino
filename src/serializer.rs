//! `internal:serializer` — V8 ValueSerializer / ValueDeserializer bindings.
//!
//! Exports two functions used by cross-thread message passing:
//!
//! - `serialize(value: any) → Uint8Array`
//!   Serializes any structured-cloneable JS value to a byte buffer using V8's
//!   native wire format (the same format browsers use for postMessage).
//!
//! - `deserialize(bytes: Uint8Array) → any`
//!   Deserializes a byte buffer produced by `serialize` back to a JS value.
//!   Must be called in the destination Isolate — the deserialized value is a
//!   fresh JS object in the current context.
//!
//! ArrayBuffer transfer (zero-copy) is not supported in this initial version.
//! Buffers are copied during serialization like any other value.

use ::v8;

// ---------------------------------------------------------------------------
// Minimal delegate implementations
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
}

struct FinoDeserializer;

impl v8::ValueDeserializerImpl for FinoDeserializer {}

// ---------------------------------------------------------------------------
// Synthetic module
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["serialize", "deserialize"]
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

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// serialize(value: any) → Uint8Array
// ---------------------------------------------------------------------------

fn native_serialize(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let value = args.get(0);
    let context = scope.get_current_context();

    let ser = v8::ValueSerializer::new(scope, Box::new(FinoSerializer));

    use v8::ValueSerializerHelper;
    ser.write_header();

    if ser.write_value(context, value).is_none() {
        // Exception was thrown by the delegate.
        return;
    }

    let bytes = ser.release();
    let len = bytes.len();

    // Create an ArrayBuffer backed by the serialized bytes, then wrap in Uint8Array.
    let store = {
        let bs = v8::ArrayBuffer::new_backing_store(scope, len);
        // SAFETY: backing store is freshly allocated, we own the only reference.
        let store_data = bs.data().unwrap().as_ptr() as *mut u8;
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), store_data, len) };
        bs.make_shared()
    };
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store);
    let Some(u8a) = v8::Uint8Array::new(scope, ab, 0, len) else {
        let msg = v8::String::new(scope, "serialize: failed to create Uint8Array").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    rv.set(u8a.into());
}

// ---------------------------------------------------------------------------
// deserialize(bytes: Uint8Array) → any
// ---------------------------------------------------------------------------

fn native_deserialize(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let buf_arg = args.get(0);
    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(buf_arg) else {
        let msg =
            v8::String::new(scope, "deserialize: argument must be a Uint8Array").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    // Access the underlying bytes directly from the backing store.
    let Some(ab) = u8a.buffer(scope) else {
        let msg = v8::String::new(scope, "deserialize: no backing buffer").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    };
    let Some(data_ptr) = ab.data() else {
        let msg =
            v8::String::new(scope, "deserialize: detached ArrayBuffer").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    let offset = u8a.byte_offset();
    let len = u8a.byte_length();
    // SAFETY: data_ptr points into a live V8 ArrayBuffer we own for this scope;
    // the slice does not outlive this call frame.
    let bytes = unsafe {
        std::slice::from_raw_parts((data_ptr.as_ptr() as *const u8).add(offset), len)
    };

    let context = scope.get_current_context();
    let deser = v8::ValueDeserializer::new(scope, Box::new(FinoDeserializer), bytes);

    use v8::ValueDeserializerHelper;
    if deser.read_header(context).is_none() {
        // Exception thrown or invalid data — propagate.
        return;
    }

    match deser.read_value(context) {
        Some(val) => rv.set(val),
        None => {
            let msg =
                v8::String::new(scope, "deserialize: failed to read value").unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
        }
    }
}
