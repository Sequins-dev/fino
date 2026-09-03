//! Shared V8 host-runtime helpers.
//!
//! These are the small primitives every synthetic-module `eval_steps` and
//! native callback needs: exporting functions from a synthetic module,
//! throwing typed exceptions, and converting JS values to Rust strings.
//!
//! They exist as a module because the same handful of functions were
//! copy-pasted into a dozen files (`set_fn` inside every `eval_steps`,
//! `throw_error`/`throw_type_error` per subsystem, `js_string` per scheduler).
//! Keep them here so behavior — especially the exception *kind* each helper
//! throws — stays consistent across the runtime.

/// Export a native function on a synthetic module under `name`.
///
/// Evaluates to `Option<()>` so `?` inside `eval_steps` propagates V8
/// allocation failures the same way the per-file macros did.
#[macro_export]
macro_rules! set_fn {
    ($scope:expr, $module:expr, $name:expr, $cb:expr) => {{
        let tmpl = ::v8::FunctionTemplate::new($scope, $cb);
        let func = tmpl.get_function($scope)?;
        let key = ::v8::String::new($scope, $name)?;
        $module.set_synthetic_module_export($scope, key, func.into())?
    }};
}

/// Export a plain integer value on a synthetic module under `name`.
#[macro_export]
macro_rules! set_int {
    ($scope:expr, $module:expr, $name:expr, $value:expr) => {{
        let key = ::v8::String::new($scope, $name)?;
        let value = ::v8::Integer::new($scope, $value);
        $module.set_synthetic_module_export($scope, key, value.into())?
    }};
}

/// Set a numeric property on an object under `name`.
#[macro_export]
macro_rules! set_num_prop {
    ($scope:expr, $object:expr, $name:expr, $value:expr) => {{
        let key = ::v8::String::new($scope, $name).unwrap();
        let value = ::v8::Number::new($scope, $value as f64);
        $object.set($scope, key.into(), value.into());
    }};
}

/// Throw a JS `Error` with `message` on `scope`.
pub fn throw_error(scope: &mut v8::PinScope, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        let exception = v8::Exception::error(scope, message);
        scope.throw_exception(exception);
    }
}

/// Throw a JS `TypeError` with `message` on `scope`.
pub fn throw_type_error(scope: &mut v8::PinScope, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        let exception = v8::Exception::type_error(scope, message);
        scope.throw_exception(exception);
    }
}

/// Convert a JS value to a Rust string, falling back to a placeholder when
/// conversion fails (e.g. the value is a terminated-execution sentinel).
pub fn js_string(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> String {
    value
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "unknown exception".to_string())
}

/// Read a string property `name` off a JS object, if present and non-nullish.
pub fn get_object_string(
    scope: &mut v8::PinScope,
    object: v8::Local<v8::Object>,
    name: &str,
) -> Option<String> {
    let key = v8::String::new(scope, name)?;
    let value = object.get(scope, key.into())?;
    if value.is_null_or_undefined() {
        return None;
    }
    value
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
}
