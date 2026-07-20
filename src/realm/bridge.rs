//! `internal:realm-bridge` — read-only view of the current Realm's FinoState.
//!
//! Readable from within a child Realm context; provides the entry path,
//! termination flag, and transit-port coordinates stored in the child's
//! FinoState.

use std::sync::atomic::Ordering;

use ::v8;

use crate::state::get_state;

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "getEntryPath",
        "isTerminated",
        "getPortInfo",
        "getAllocationPortInfo",
        "setEntryError",
        "getLoadedFsPaths",
        "requestReload",
        "getWatchMode",
        "getReplMode",
        "getRealmData",
        "getRealmBootstrapData",
    ]
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
    set_fn!("getPortInfo", get_port_info);
    set_fn!("getAllocationPortInfo", get_allocation_port_info);
    set_fn!("setEntryError", set_entry_error);
    set_fn!("getLoadedFsPaths", get_loaded_fs_paths);
    set_fn!("requestReload", request_reload);
    set_fn!("getWatchMode", get_watch_mode);
    set_fn!("getReplMode", get_repl_mode);
    set_fn!("getRealmData", get_realm_data);
    set_fn!("getRealmBootstrapData", get_realm_bootstrap_data);

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

/// Returns the JSON-serialized `RealmOptions.data` string passed at creation
/// time, or `undefined` when none was provided (or for the root Realm).
fn get_realm_data(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    match &st.realm_data {
        Some(d) => {
            let s = v8::String::new(scope, d).unwrap();
            rv.set(s.into());
        }
        None => rv.set(v8::undefined(scope).into()),
    }
}

/// Returns the JSON-serialized runtime bootstrap metadata string passed at
/// creation time, or `undefined` when none was provided.
fn get_realm_bootstrap_data(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    match &st.realm_bootstrap_data {
        Some(d) => {
            let s = v8::String::new(scope, d).unwrap();
            rv.set(s.into());
        }
        None => rv.set(v8::undefined(scope).into()),
    }
}

/// Returns this realm's own channel half — `{ handle, wakeReadFd }` for the
/// transit-registry half its realmPort messages through — or `undefined` in
/// the root realm.
fn get_port_info(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let info = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        st.port_transit_handle
            .and_then(|h| st.port_wake_read_fd.map(|fd| (h, fd)))
    };
    let Some((handle, fd)) = info else {
        rv.set(v8::undefined(scope).into());
        return;
    };
    let obj = v8::Object::new(scope);
    let k = v8::String::new(scope, "handle").unwrap();
    let v = v8::Number::new(scope, handle as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "wakeReadFd").unwrap();
    let v = v8::Number::new(scope, fd as f64);
    obj.set(scope, k.into(), v.into());
    rv.set(obj.into());
}

/// Returns the private allocator-control channel half for a reactor realm, or
/// `undefined` outside reactor-hosted child contexts.
fn get_allocation_port_info(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let info = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        st.allocation_transit_handle
            .and_then(|handle| st.allocation_wake_read_fd.map(|fd| (handle, fd)))
    };
    let Some((handle, fd)) = info else {
        rv.set(v8::undefined(scope).into());
        return;
    };
    let obj = v8::Object::new(scope);
    let key = v8::String::new(scope, "handle").unwrap();
    let value = v8::Number::new(scope, handle as f64);
    obj.set(scope, key.into(), value.into());
    let key = v8::String::new(scope, "wakeReadFd").unwrap();
    let value = v8::Number::new(scope, fd as f64);
    obj.set(scope, key.into(), value.into());
    rv.set(obj.into());
}

/// Records an entry-module error string in the realm's FinoState.
/// Called from `_onChildEntryError` in `internal/bootstrap.ts` so that the parent
/// can retrieve the error and reject `Realm.run()` instead of resolving it.
fn set_entry_error(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let msg = args
        .get(0)
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();
    get_state(scope).borrow_mut().entry_error = Some(msg);
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

/// Returns an Array of absolute path strings for every filesystem module this
/// Realm has imported so far (the keys of `state.fs_cache`).
fn get_loaded_fs_paths(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let paths: Vec<String> = state_rc
        .borrow()
        .fs_cache
        .keys()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    let arr = v8::Array::new(scope, paths.len() as i32);
    for (i, p) in paths.iter().enumerate() {
        if let Some(s) = v8::String::new(scope, p) {
            let idx = v8::Integer::new(scope, i as i32);
            arr.set(scope, idx.into(), s.into());
        }
    }
    rv.set(arr.into());
}

/// Signals that this Realm wants to reload: sets `reload_requested` and
/// `terminated` on the local FinoState, writes the shared atomic for thread
/// realms, and sets the process-global flag for process realms so the parent
/// process exits with code 75.
fn request_reload(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let mut st = state_rc.borrow_mut();
    st.reload_requested = true;
    st.terminated = true;
    // For process realm children: set the process-wide flag so run_process_child
    // exits with code 75.  This is a no-op in the parent process.
    crate::realm::process::CHILD_RELOAD_REQUESTED.store(true, Ordering::Release);
}

/// Returns `true` if this Realm was started with `watch: true`.
fn get_watch_mode(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let watch_mode = state_rc.borrow().watch_mode;
    rv.set(v8::Boolean::new(scope, watch_mode).into());
}

/// Returns `true` if this Realm was started with `repl: true`.
fn get_repl_mode(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let repl_mode = state_rc.borrow().repl_mode;
    rv.set(v8::Boolean::new(scope, repl_mode).into());
}
