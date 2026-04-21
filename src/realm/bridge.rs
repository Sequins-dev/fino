//! `internal:realm-bridge` — read-only view of the current Realm's FinoState.
//!
//! Readable from within a child Realm context; provides the entry path,
//! termination flag, and MessagePort stored in the child's FinoState.

use ::v8;

use crate::state::get_state;

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["getEntryPath", "isTerminated", "getPort"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();

    let module_name = v8::String::new(scope, "internal:realm-bridge").unwrap();
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

    set_fn!("getEntryPath", get_entry_path);
    set_fn!("isTerminated", is_terminated);
    set_fn!("getPort", get_port);

    Some(v8::undefined(scope).into())
}

/// Returns the entry module path stored in the current context's FinoState,
/// or `undefined` if this is the root Realm.
fn get_entry_path(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    match &st.entry_path {
        Some(p) => {
            let s = v8::String::new(scope, p).unwrap();
            rv.set(s.into());
        }
        None => rv.set(v8::undefined(scope).into()),
    }
}

/// Returns the MessagePort object passed to this child Realm at creation time,
/// or `undefined` if this is the root Realm or no port was provided.
fn get_port(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    match &st.port {
        Some(p) => rv.set(v8::Local::new(scope, p)),
        None => rv.set(v8::undefined(scope).into()),
    }
}

/// Returns `true` if the parent has requested this Realm to terminate.
fn is_terminated(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let terminated = state_rc.borrow().terminated;
    rv.set(v8::Boolean::new(scope, terminated).into());
}
