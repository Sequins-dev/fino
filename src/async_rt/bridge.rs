//! Bidirectional bridge between Rust `Future`s and V8 JS `Promise`s.
#![allow(dead_code)]
//!
//! # Direction 1 — `future_to_promise`
//! Spawns a Rust future on the isolate's `LocalExecutor`. When the future
//! resolves, pushes a `PendingResolution` into the originating realm's queue;
//! `async_rt::drain_all` picks it up during the next `pump_and_checkpoint` and
//! resolves the JS `Promise`.
//!
//! # Direction 2 — `promise_to_future`
//! Installs `.then(onFulfilled, onRejected)` callbacks on a JS `Promise`. Each
//! callback sends the settled value through a `oneshot` channel. The returned
//! `Future` awaits the channel; the `LocalExecutor`'s `try_tick` drives it
//! forward after each microtask checkpoint.

use std::rc::Rc;

use ::v8;

// ---------------------------------------------------------------------------
// JsValueRepr — a JS value that can cross an await boundary without a scope
// ---------------------------------------------------------------------------

/// A JS value serialised to a Rust type so it can be held across `await`
/// points (where no V8 `HandleScope` is available).
///
/// Converted back to a `v8::Local` in `drain_pending_for` where a live scope
/// is always available.
pub enum JsValueRepr {
    Undefined,
    Null,
    Bool(bool),
    I32(i32),
    U32(u32),
    F64(f64),
    BigIntI64(i64),
    BigIntU64(u64),
    String(String),
    Bytes(Vec<u8>),
    /// Pass-through for values that can't be trivially represented.
    /// Holding a `v8::Global` keeps the underlying object alive until it is
    /// resolved by the drain.
    Global(v8::Global<v8::Value>),
}

impl JsValueRepr {
    /// Convert to a `v8::Local` with a live scope.
    pub fn into_v8<'s>(self, scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Value> {
        match self {
            Self::Undefined => v8::undefined(scope).into(),
            Self::Null => v8::null(scope).into(),
            Self::Bool(b) => v8::Boolean::new(scope, b).into(),
            Self::I32(n) => v8::Integer::new(scope, n).into(),
            Self::U32(n) => v8::Integer::new_from_unsigned(scope, n).into(),
            Self::F64(f) => v8::Number::new(scope, f).into(),
            Self::BigIntI64(n) => v8::BigInt::new_from_i64(scope, n).into(),
            Self::BigIntU64(n) => v8::BigInt::new_from_u64(scope, n).into(),
            Self::String(s) => v8::String::new(scope, &s)
                .map(|s| s.into())
                .unwrap_or_else(|| v8::undefined(scope).into()),
            Self::Bytes(b) => {
                let len = b.len();
                let ab = v8::ArrayBuffer::new(scope, len);
                if let Some(bs) = ab.get_backing_store().data() {
                    let dst =
                        unsafe { std::slice::from_raw_parts_mut(bs.as_ptr() as *mut u8, len) };
                    dst.copy_from_slice(&b);
                }
                v8::Uint8Array::new(scope, ab, 0, len)
                    .map(|a| a.into())
                    .unwrap_or_else(|| v8::undefined(scope).into())
            }
            Self::Global(g) => v8::Local::new(scope, g),
        }
    }

    /// Build from a `v8::Local` at a point where a scope is available (e.g.,
    /// inside `promise_to_future` callbacks). Prefers lightweight reprs; falls
    /// back to `Global` for objects.
    pub fn from_v8<'s>(scope: &mut v8::HandleScope<'s>, val: v8::Local<'s, v8::Value>) -> Self {
        if val.is_undefined() {
            return Self::Undefined;
        }
        if val.is_null() {
            return Self::Null;
        }
        if val.is_boolean() {
            return Self::Bool(val.boolean_value(scope));
        }
        if let Ok(bi) = v8::Local::<v8::BigInt>::try_from(val) {
            let (v, fits) = bi.i64_value();
            if fits {
                return Self::BigIntI64(v);
            }
            let (v, fits) = bi.u64_value();
            if fits {
                return Self::BigIntU64(v);
            }
        }
        if val.is_number() {
            if let Some(n) = val.number_value(scope) {
                let i = n as i32;
                if i as f64 == n {
                    return Self::I32(i);
                }
                let u = n as u32;
                if u as f64 == n {
                    return Self::U32(u);
                }
                return Self::F64(n);
            }
        }
        if let Ok(s) = v8::Local::<v8::String>::try_from(val) {
            return Self::String(s.to_rust_string_lossy(scope));
        }
        // Fall back to a global for anything else (objects, arrays, etc.).
        Self::Global(v8::Global::new(scope, val))
    }
}

/// A JS error value — either a repr or a raw error local.
pub type BridgeError = JsValueRepr;

// ---------------------------------------------------------------------------
// IntoJsValueRepr — convert a Rust value to JsValueRepr without a scope
// ---------------------------------------------------------------------------

pub trait IntoJsValueRepr {
    fn into_js_repr(self) -> JsValueRepr;
}

impl IntoJsValueRepr for () {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::Undefined
    }
}
impl IntoJsValueRepr for bool {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::Bool(self)
    }
}
impl IntoJsValueRepr for i32 {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::I32(self)
    }
}
impl IntoJsValueRepr for u32 {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::U32(self)
    }
}
impl IntoJsValueRepr for i64 {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::BigIntI64(self)
    }
}
impl IntoJsValueRepr for u64 {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::BigIntU64(self)
    }
}
impl IntoJsValueRepr for f64 {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::F64(self)
    }
}
impl IntoJsValueRepr for String {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::String(self)
    }
}
impl IntoJsValueRepr for Vec<u8> {
    fn into_js_repr(self) -> JsValueRepr {
        JsValueRepr::Bytes(self)
    }
}
impl IntoJsValueRepr for JsValueRepr {
    fn into_js_repr(self) -> JsValueRepr {
        self
    }
}

// ---------------------------------------------------------------------------
// FromV8 — convert a v8::Local to a Rust type
// ---------------------------------------------------------------------------

pub trait FromV8: Sized {
    fn from_v8<'s>(
        scope: &mut v8::HandleScope<'s>,
        val: v8::Local<'s, v8::Value>,
    ) -> Result<Self, BridgeError>;
}

impl FromV8 for JsValueRepr {
    fn from_v8<'s>(
        scope: &mut v8::HandleScope<'s>,
        val: v8::Local<'s, v8::Value>,
    ) -> Result<Self, BridgeError> {
        Ok(JsValueRepr::from_v8(scope, val))
    }
}

impl FromV8 for f64 {
    fn from_v8<'s>(
        scope: &mut v8::HandleScope<'s>,
        val: v8::Local<'s, v8::Value>,
    ) -> Result<Self, BridgeError> {
        val.number_value(scope)
            .ok_or_else(|| JsValueRepr::String("expected number".to_string()))
    }
}

impl FromV8 for i32 {
    fn from_v8<'s>(
        scope: &mut v8::HandleScope<'s>,
        val: v8::Local<'s, v8::Value>,
    ) -> Result<Self, BridgeError> {
        val.int32_value(scope)
            .ok_or_else(|| JsValueRepr::String("expected i32".to_string()))
    }
}

impl FromV8 for String {
    fn from_v8<'s>(
        scope: &mut v8::HandleScope<'s>,
        val: v8::Local<'s, v8::Value>,
    ) -> Result<Self, BridgeError> {
        v8::Local::<v8::String>::try_from(val)
            .map(|s| s.to_rust_string_lossy(scope))
            .map_err(|_| JsValueRepr::String("expected string".to_string()))
    }
}

// ---------------------------------------------------------------------------
// PendingResolution — queued promise settlement from a completed future
// ---------------------------------------------------------------------------

/// A completed future waiting to be resolved into a JS Promise.
/// Drained by `async_rt::drain_pending_for` with a live scope.
pub struct PendingResolution {
    pub resolver: v8::Global<v8::PromiseResolver>,
    pub result: Result<JsValueRepr, JsValueRepr>,
}

// ---------------------------------------------------------------------------
// future_to_promise — spawn a Rust Future, get a JS Promise
// ---------------------------------------------------------------------------

/// Spawn `fut` on the current isolate's `LocalExecutor` and return a JS
/// `Promise` that resolves when the future completes.
///
/// The future must be `'static` (no borrows). It does not need to be `Send`
/// because `LocalExecutor` is single-threaded.
///
/// `T` and `E` must implement `IntoJsValueRepr` so the result can be stored
/// without a scope across the `await` point.
pub fn future_to_promise<'s, F, T, E>(
    scope: &mut v8::HandleScope<'s>,
    fut: F,
) -> v8::Local<'s, v8::Promise>
where
    F: std::future::Future<Output = Result<T, E>> + 'static,
    T: IntoJsValueRepr + 'static,
    E: IntoJsValueRepr + 'static,
{
    let resolver = match v8::PromiseResolver::new(scope) {
        Some(r) => r,
        None => {
            // Couldn't create a resolver — last-ditch: create a new resolver and reject it.
            let r2 = v8::PromiseResolver::new(scope).expect("failed to create PromiseResolver");
            let msg = v8::String::new(scope, "future_to_promise: failed to create resolver")
                .unwrap_or_else(|| v8::String::new(scope, "error").unwrap());
            let exc = v8::Exception::error(scope, msg);
            let _ = r2.reject(scope, exc);
            return r2.get_promise(scope);
        }
    };
    let promise = resolver.get_promise(scope);
    let global_resolver = v8::Global::new(scope, resolver);

    // Clone the pending_resolutions Rc for the future to push into.
    let pending_rc = {
        let state_rc = crate::state::get_state(scope);
        Rc::clone(&state_rc.borrow().pending_resolutions)
    };

    super::spawn(async move {
        let result = fut.await;
        let repr = match result {
            Ok(val) => Ok(val.into_js_repr()),
            Err(err) => Err(err.into_js_repr()),
        };
        pending_rc.borrow_mut().push(PendingResolution {
            resolver: global_resolver,
            result: repr,
        });
    });

    promise
}

// ---------------------------------------------------------------------------
// promise_to_future — convert a JS Promise into a Rust Future
// ---------------------------------------------------------------------------

/// Convert a V8 JS `Promise` into a Rust `Future<Output = Result<T, BridgeError>>`.
///
/// Installs `.then(onFulfilled, onRejected)` callbacks that complete a
/// `oneshot` channel when the promise settles. The future must be polled by the
/// isolate's `LocalExecutor` (via `async_rt::spawn`) so that `try_tick` drives
/// it after each microtask checkpoint.
/// Convert a JS `Promise` into a Rust `Future<Output = Result<JsValueRepr, BridgeError>>`.
///
/// To convert the settled value to a concrete Rust type, convert the
/// `JsValueRepr` at the call site where a V8 `HandleScope` is available.
pub fn promise_to_future(
    scope: &mut v8::HandleScope,
    promise: v8::Local<v8::Promise>,
) -> impl std::future::Future<Output = Result<JsValueRepr, BridgeError>> + 'static {
    let (tx, rx) = futures_channel::oneshot::channel::<Result<JsValueRepr, JsValueRepr>>();

    // Box the sender so we can store it as External data.
    // The callback takes ownership via Box::from_raw.
    let tx_ptr = Box::into_raw(Box::new(tx));

    // on_fulfilled callback
    let on_fulfilled = {
        let ext = v8::External::new(scope, tx_ptr as *mut std::ffi::c_void);
        let tmpl = v8::FunctionTemplate::builder(settle_fulfilled_cb)
            .data(ext.into())
            .build(scope);
        tmpl.get_function(scope).unwrap()
    };

    // on_rejected callback — reuses the same tx pointer (only one will fire)
    let on_rejected = {
        let ext = v8::External::new(scope, tx_ptr as *mut std::ffi::c_void);
        let tmpl = v8::FunctionTemplate::builder(settle_rejected_cb)
            .data(ext.into())
            .build(scope);
        tmpl.get_function(scope).unwrap()
    };

    promise.then2(scope, on_fulfilled, on_rejected);

    async move {
        match rx.await {
            Ok(Ok(repr)) => JsValueRepr::from_v8_repr(repr),
            Ok(Err(repr)) => Err(repr),
            Err(_) => Err(JsValueRepr::String(
                "promise_to_future: channel dropped".into(),
            )),
        }
    }
}

/// Helper trait so `T::from_v8_repr(repr)` works in the async block.
/// Only `JsValueRepr` is supported for v1 — callers receive the repr and
/// convert to a concrete type at the call site where a scope is available.
trait FromJsValueRepr: Sized {
    fn from_v8_repr(repr: JsValueRepr) -> Result<Self, BridgeError>;
}

impl FromJsValueRepr for JsValueRepr {
    fn from_v8_repr(repr: JsValueRepr) -> Result<Self, BridgeError> {
        Ok(repr)
    }
}

// ---------------------------------------------------------------------------
// .then() callbacks
// ---------------------------------------------------------------------------

type TxType = futures_channel::oneshot::Sender<Result<JsValueRepr, JsValueRepr>>;

fn settle_fulfilled_cb<'s>(
    scope: &mut v8::HandleScope<'s>,
    args: v8::FunctionCallbackArguments<'s>,
    _rv: v8::ReturnValue,
) {
    let Ok(ext) = v8::Local::<v8::External>::try_from(args.data()) else {
        return;
    };
    let tx_ptr = ext.value() as *mut TxType;
    if tx_ptr.is_null() {
        return;
    }
    let tx = unsafe { Box::from_raw(tx_ptr) };
    let val = JsValueRepr::from_v8(scope, args.get(0));
    let _ = tx.send(Ok(val));
}

fn settle_rejected_cb<'s>(
    scope: &mut v8::HandleScope<'s>,
    args: v8::FunctionCallbackArguments<'s>,
    _rv: v8::ReturnValue,
) {
    let Ok(ext) = v8::Local::<v8::External>::try_from(args.data()) else {
        return;
    };
    let tx_ptr = ext.value() as *mut TxType;
    if tx_ptr.is_null() {
        return;
    }
    let tx = unsafe { Box::from_raw(tx_ptr) };
    let val = JsValueRepr::from_v8(scope, args.get(0));
    let _ = tx.send(Err(val));
}
