//! Realm (child V8 Context) creation and stepping.
//!
//! Exposes two synthetic modules:
//!
//! - `internal:realm-bridge` — readable from within a child Realm context;
//!   provides the entry path and termination flag stored in the child's FinoState.
//!
//! - `internal:realm-native` — callable from the parent context; creates child
//!   contexts, steps them, and signals termination.
//!
//! Child Realms each have:
//! - Their own `v8::MicrotaskQueue` (explicit policy, per-context drain).
//! - Their own `FinoState` (own module caches, own loop, own providers map).
//! - A `providers` map that starts as a clone of the parent's map, with
//!   child-specific entries applied on top (provider inheritance).
//! - An `entry_path` — the module to dynamically import after bootstrap.
//! - A `terminated` flag that the parent sets to signal shutdown.
//!
//! ## Deferred context creation
//!
//! `v8::Context::new` requires a `&mut HandleScope<()>` (unbound scope).
//! Inside a JS callback only a bound `HandleScope<Context>` is available;
//! calling `HandleScope::new(isolate)` there panics ("active scope can't be
//! dropped").  To avoid this, `native_create_context` only queues a
//! `PendingRealm` and returns a pre-allocated handle index.  The host loop in
//! `runtime.rs` calls `process_pending_creates` between iterations while the
//! ContextScope is not entered, giving access to the bare `isolate_scope`
//! (`HandleScope<()>`).

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
};

use ::v8;

use ::libc;

use crate::{
    loader, thread_realm,
    state::{
        ChildRealm, ChildRealmSlot, FinoState, PendingRealm, ProviderConfig, get_state,
        root_queue_ptr,
    },
};

// ---------------------------------------------------------------------------
// internal:realm-bridge — read-only view of the current Realm's FinoState
// ---------------------------------------------------------------------------

pub fn create_realm_bridge_module<'s>(
    scope: &mut v8::HandleScope<'s>,
) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["getEntryPath", "isTerminated", "getPort"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();

    let module_name = v8::String::new(scope, "internal:realm-bridge").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, bridge_eval_steps)
}

fn bridge_eval_steps<'a>(
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

    set_fn!("getEntryPath", bridge_get_entry_path);
    set_fn!("isTerminated", bridge_is_terminated);
    set_fn!("getPort", bridge_get_port);

    Some(v8::undefined(scope).into())
}

/// Returns the entry module path stored in the current context's FinoState,
/// or `undefined` if this is the root Realm.
fn bridge_get_entry_path(
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
fn bridge_get_port(
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
fn bridge_is_terminated(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let terminated = state_rc.borrow().terminated;
    rv.set(v8::Boolean::new(scope, terminated).into());
}

// ---------------------------------------------------------------------------
// internal:realm-native — parent-side Realm operations
// ---------------------------------------------------------------------------

pub fn create_realm_native_module<'s>(
    scope: &mut v8::HandleScope<'s>,
) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "createContext",
        "stepContext",
        "terminateChild",
        "createThreadContext",
        "stepThreadContext",
        "threadPortSend",
        "threadPortRecv",
        "getThreadPortWakeReadFd",
    ]
    .iter()
    .map(|n| v8::String::new(scope, n).unwrap())
    .collect();

    let module_name = v8::String::new(scope, "internal:realm-native").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, native_eval_steps)
}

fn native_eval_steps<'a>(
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

    set_fn!("createContext", native_create_context);
    set_fn!("stepContext", native_step_context);
    set_fn!("terminateChild", native_terminate_child);
    set_fn!("createThreadContext", native_create_thread_context);
    set_fn!("stepThreadContext", native_step_thread_context);
    set_fn!("threadPortSend", native_thread_port_send);
    set_fn!("threadPortRecv", native_thread_port_recv);
    set_fn!("getThreadPortWakeReadFd", native_get_thread_port_wake_read_fd);

    Some(v8::undefined(scope).into())
}

/// JS: `createContext(root, entryPath, overrideEntries, blockedSpecifiers[, port]) -> number`
///
/// Queues a pending child-context creation and returns the pre-allocated
/// handle index.  Actual context construction is deferred to
/// `process_pending_creates`, which the host loop calls between iterations
/// when a bare `HandleScope<()>` is available.
///
/// Arguments:
/// - `root` — filesystem root for the child (inherits from parent if empty).
/// - `entryPath` — absolute path to the entry module to import in the child.
/// - `overrideEntries` — `[specifier, code, sourceMap][]` triples that
///   supplement the inherited `providers` map. Empty code = remove entry (use BUILTINS).
/// - `blockedSpecifiers` — `string[]` of module specifiers that user code in
///   the child Realm may not import. Builtins can still import them freely.
/// - `port` (optional) — the child's MessagePort object (created in the parent
///   context). Stored in the child's FinoState and returned by `getPort()`.
fn native_create_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let root_arg = args.get(0);
    let entry_arg = args.get(1);
    let overrides_arg = args.get(2);
    let blocked_arg = args.get(3);
    let port_arg = args.get(4);

    // --- Parse root path ---
    let root: std::path::PathBuf = {
        let s = root_arg
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default();
        if s.is_empty() {
            get_state(scope).borrow().root.clone()
        } else {
            std::path::PathBuf::from(s)
        }
    };

    // --- Parse entry path ---
    let entry_path: String = entry_arg
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();

    // --- Parse override entries: Array<[specifier, code, sourceMap]> ---
    let mut extra_overrides: Vec<(String, String, String)> = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(overrides_arg) {
        for i in 0..arr.length() {
            let idx = v8::Integer::new(scope, i as i32);
            let entry = match arr.get(scope, idx.into()) {
                Some(v) => v,
                None => continue,
            };
            if let Ok(triple) = v8::Local::<v8::Array>::try_from(entry) {
                let specifier = triple
                    .get_index(scope, 0)
                    .and_then(|v| v.to_string(scope))
                    .map(|s| s.to_rust_string_lossy(scope))
                    .unwrap_or_default();
                let code = triple
                    .get_index(scope, 1)
                    .and_then(|v| v.to_string(scope))
                    .map(|s| s.to_rust_string_lossy(scope))
                    .unwrap_or_default();
                let source_map = triple
                    .get_index(scope, 2)
                    .and_then(|v| v.to_string(scope))
                    .map(|s| s.to_rust_string_lossy(scope))
                    .unwrap_or_default();
                if !specifier.is_empty() {
                    extra_overrides.push((specifier, code, source_map));
                }
            }
        }
    }

    // --- Build providers: inherit from parent, apply child-specific entries ---
    let mut child_providers = {
        let parent_state = get_state(scope);
        let st = parent_state.borrow();
        st.providers.clone()
    };
    for (specifier, code, source_map) in extra_overrides {
        if code.is_empty() {
            // Empty code signals "remove this provider entry" — specifier falls
            // through to the compiled-in system default (BUILTINS).
            child_providers.remove(&specifier);
        } else {
            child_providers.insert(specifier, Some(ProviderConfig { code, source_map }));
        }
    }

    let package_map_json = get_state(scope).borrow().package_map_json.clone();

    // --- Parse blocked specifiers: Array<string> → None entries in providers ---
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(blocked_arg) {
        for i in 0..arr.length() {
            let idx = v8::Integer::new(scope, i as i32);
            if let Some(s) = arr.get(scope, idx.into()).and_then(|v| v.to_string(scope)) {
                let spec = s.to_rust_string_lossy(scope);
                if !spec.is_empty() {
                    child_providers.insert(spec, None);
                }
            }
        }
    }

    // --- Capture the optional port object as a Global before borrowing state ---
    let port_global: Option<v8::Global<v8::Value>> = if port_arg.is_undefined() || port_arg.is_null() {
        None
    } else {
        Some(v8::Global::new(scope, port_arg))
    };

    // --- Queue the pending create; pre-allocate a Pending slot ---
    let handle_idx = {
        let state_rc = get_state(scope);
        let mut st = state_rc.borrow_mut();
        let idx = st.child_contexts.len();
        st.child_contexts.push(ChildRealmSlot::Pending);
        st.pending_creates.push(PendingRealm {
            handle_idx: idx,
            root,
            entry_path,
            providers: child_providers,
            package_map_json,
            port: port_global,
        });
        idx
    };

    rv.set(v8::Integer::new(scope, handle_idx as i32).into());
}

/// JS: `stepContext(handle: number): boolean`
///
/// Enters the child context, calls its `loop_step_fn`, services any pending
/// `scheduleSync` call, and drains the child's microtask queue. Returns the
/// bool result of the child's step function (false = child loop exited).
///
/// Returns `true` for `Pending` slots (creation deferred; realm still alive).
/// Returns `false` for `Failed` slots or out-of-range handles.
fn native_step_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;

    let child_context = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        match st.child_contexts.get(handle) {
            Some(ChildRealmSlot::Active(c)) => v8::Local::new(scope, &c.context),
            Some(ChildRealmSlot::Pending) => {
                // Not yet created — report alive so JS keeps waiting.
                rv.set(v8::Boolean::new(scope, true).into());
                return;
            }
            Some(ChildRealmSlot::Failed) | None => {
                rv.set(v8::Boolean::new(scope, false).into());
                return;
            }
        }
    };

    let should_continue = step_child_context(scope, child_context);
    rv.set(v8::Boolean::new(scope, should_continue).into());
}

/// JS: `terminateChild(handle: number): void`
///
/// Sets `terminated = true` on the child's FinoState. The child's `isDone`
/// callback (which calls `isTerminated()`) will return true on the next step,
/// causing the child's loop to exit.  Pending and failed slots are ignored.
fn native_terminate_child(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;

    let child_context = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        match st.child_contexts.get(handle) {
            Some(ChildRealmSlot::Active(c)) => v8::Local::new(scope, &c.context),
            _ => return,
        }
    };

    // Enter the child context briefly to access its FinoState.
    let child_scope = &mut v8::ContextScope::new(scope, child_context);
    let child_state = get_state(child_scope);
    child_state.borrow_mut().terminated = true;
}

// ---------------------------------------------------------------------------
// Thread Realm native functions
// ---------------------------------------------------------------------------

/// JS: `createThreadContext(root, entryPath, overrideEntries, blockedSpecifiers): number`
///
/// Spawns a new OS thread with its own `v8::Isolate` running `_bootstrap.mjs`.
/// Returns a handle index into the parent's `thread_contexts` Vec.
fn native_create_thread_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let root_arg = args.get(0);
    let entry_arg = args.get(1);
    let overrides_arg = args.get(2);
    let blocked_arg = args.get(3);

    // --- Parse root path ---
    let root: std::path::PathBuf = {
        let s = root_arg
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default();
        if s.is_empty() {
            get_state(scope).borrow().root.clone()
        } else {
            std::path::PathBuf::from(s)
        }
    };

    // --- Parse entry path ---
    let entry_path: String = entry_arg
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();

    // --- Build providers map (same logic as native_create_context) ---
    let mut providers = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        st.providers.clone()
    };

    // Apply override entries.
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(overrides_arg) {
        for i in 0..arr.length() {
            let idx = v8::Integer::new(scope, i as i32);
            let entry = match arr.get(scope, idx.into()) {
                Some(v) => v,
                None => continue,
            };
            if let Ok(triple) = v8::Local::<v8::Array>::try_from(entry) {
                let specifier = triple
                    .get_index(scope, 0)
                    .and_then(|v| v.to_string(scope))
                    .map(|s| s.to_rust_string_lossy(scope))
                    .unwrap_or_default();
                let code = triple
                    .get_index(scope, 1)
                    .and_then(|v| v.to_string(scope))
                    .map(|s| s.to_rust_string_lossy(scope))
                    .unwrap_or_default();
                let source_map = triple
                    .get_index(scope, 2)
                    .and_then(|v| v.to_string(scope))
                    .map(|s| s.to_rust_string_lossy(scope))
                    .unwrap_or_default();
                if !specifier.is_empty() {
                    if code.is_empty() {
                        providers.remove(&specifier);
                    } else {
                        providers.insert(specifier, Some(ProviderConfig { code, source_map }));
                    }
                }
            }
        }
    }

    // Apply blocked specifiers as None entries.
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(blocked_arg) {
        for i in 0..arr.length() {
            let idx = v8::Integer::new(scope, i as i32);
            if let Some(s) = arr.get(scope, idx.into()).and_then(|v| v.to_string(scope)) {
                let spec = s.to_rust_string_lossy(scope);
                if !spec.is_empty() {
                    providers.insert(spec, None);
                }
            }
        }
    }

    let package_map_json = get_state(scope).borrow().package_map_json.clone();

    // --- Spawn the thread realm ---
    let spawn_config = thread_realm::SpawnConfig {
        root,
        entry_path,
        providers,
        package_map_json,
    };

    let handle = match thread_realm::spawn_thread_realm(spawn_config) {
        Ok(h) => h,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("createThreadContext: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    // Store handle and return index.
    let idx = {
        let state_rc = get_state(scope);
        let mut st = state_rc.borrow_mut();
        let i = st.thread_contexts.len();
        st.thread_contexts.push(Some(handle));
        i
    };

    rv.set(v8::Integer::new(scope, idx as i32).into());
}

/// JS: `stepThreadContext(handle: number): boolean`
///
/// Returns `true` while the thread is still running, `false` once it exits.
fn native_step_thread_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    let h = st.thread_contexts.get(handle).and_then(|slot| slot.as_ref());
    let still_running = h.map(|h| !h.done.load(std::sync::atomic::Ordering::Acquire)).unwrap_or(false);
    if !still_running {
        // Check for a crash/error message and throw it as a JS exception.
        if let Some(err_msg) = h.and_then(|h| h.error.lock().ok()?.clone()) {
            let msg = v8::String::new(scope, &err_msg).unwrap_or_else(|| {
                v8::String::new(scope, "thread realm error").unwrap()
            });
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    }
    rv.set(v8::Boolean::new(scope, still_running).into());
}

/// JS: `threadPortSend(handle: number, bytes: Uint8Array, stores?: Uint8Array[]): void`
///
/// Sends a serialized message (and optional transfer stores) to the thread
/// realm identified by `handle`.
fn native_thread_port_send(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    use crate::thread_realm::ThreadMessage;

    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let bytes_arg = args.get(1);

    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(bytes_arg) else {
        let msg = v8::String::new(scope, "threadPortSend: second argument must be a Uint8Array").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    // Copy main bytes.
    let data: Vec<u8> = {
        let Some(ab) = u8a.buffer(scope) else { return };
        let Some(data_ptr) = ab.data() else { return };
        let offset = u8a.byte_offset();
        let len = u8a.byte_length();
        // SAFETY: data_ptr into live V8 ArrayBuffer, slice doesn't outlive this frame.
        unsafe {
            std::slice::from_raw_parts((data_ptr.as_ptr() as *const u8).add(offset), len).to_vec()
        }
    };

    // Copy transfer stores (optional third arg — Array of Uint8Array).
    let transfer_stores: Vec<Vec<u8>> =
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(2)) {
            let count = arr.length();
            let mut stores = Vec::with_capacity(count as usize);
            for i in 0..count {
                let idx = v8::Integer::new(scope, i as i32);
                if let Some(elem) = arr.get(scope, idx.into())
                    && let Ok(su8a) = v8::Local::<v8::Uint8Array>::try_from(elem)
                {
                    let Some(sab) = su8a.buffer(scope) else { continue };
                    let Some(sptr) = sab.data() else { continue };
                    let soff = su8a.byte_offset();
                    let slen = su8a.byte_length();
                    // SAFETY: same as above.
                    let raw = unsafe {
                        std::slice::from_raw_parts(
                            (sptr.as_ptr() as *const u8).add(soff),
                            slen,
                        )
                        .to_vec()
                    };
                    stores.push(raw);
                }
            }
            stores
        } else {
            Vec::new()
        };

    // Port transfer infos (optional fourth arg — Array of [handle, wakeReadFd]).
    let transfer_ports = crate::thread_realm::extract_port_infos(scope, args.get(3));

    let thread_msg = ThreadMessage { data, transfer_stores, transfer_ports };

    let (maybe_tx, maybe_wake_write) = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        match st.thread_contexts.get(handle).and_then(|s| s.as_ref()) {
            Some(h) => (Some(h.tx.clone()), Some(h.child_wake_write)),
            None => (None, None),
        }
    };

    if let (Some(tx), Some(wake_write)) = (maybe_tx, maybe_wake_write) {
        let _ = tx.send(thread_msg);
        let byte: [u8; 1] = [1];
        // SAFETY: wake_write is a valid open fd owned by this handle.
        unsafe { libc::write(wake_write, byte.as_ptr() as *const _, 1) };
    }
}

/// JS: `threadPortRecv(handle: number): [Uint8Array, ...Uint8Array[]][]`
///
/// Non-blocking drain of the channel from the thread realm identified by
/// `handle`. Returns a JS Array of inner Arrays: each inner Array has the main
/// bytes at `[0]` and transfer-store bytes at `[1..]`.
fn native_thread_port_recv(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use crate::thread_realm::ThreadMessage;

    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;

    let (messages, maybe_wake_read) = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        match st.thread_contexts.get(handle).and_then(|s| s.as_ref()) {
            Some(h) => {
                let mut msgs: Vec<ThreadMessage> = Vec::new();
                while let Ok(msg) = h.rx.try_recv() {
                    msgs.push(msg);
                }
                (msgs, Some(h.parent_wake_read))
            }
            None => (Vec::new(), None),
        }
    };

    // Drain wake bytes so the fd doesn't stay permanently readable.
    if let Some(wake_read) = maybe_wake_read {
        let mut discard = [0u8; 256];
        // SAFETY: discard is a valid buffer; wake_read is a valid open fd.
        unsafe { libc::read(wake_read, discard.as_mut_ptr() as *mut _, discard.len()) };
    }

    rv.set(crate::transit::build_message_array(scope, messages).into());
}

/// JS: `getThreadPortWakeReadFd(handle: number): number`
///
/// Returns the parent-side wake-pipe read fd for `loop.readable()` registration,
/// or -1 if the handle is not found.
fn native_get_thread_port_wake_read_fd(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    let fd = st
        .thread_contexts
        .get(handle)
        .and_then(|s| s.as_ref())
        .map(|h| h.parent_wake_read)
        .unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

// ---------------------------------------------------------------------------
// Core: create a child V8 context with its own FinoState
// ---------------------------------------------------------------------------

/// Create a child V8 context and bootstrap it.
///
/// Must be called from a bare `HandleScope<()>` (unbound) — i.e. outside any
/// entered context.  The host loop satisfies this by calling
/// `process_pending_creates` between iterations when the `ContextScope` for the
/// current iteration has already been dropped.
fn create_child_context(
    scope: &mut v8::HandleScope<()>,
    root: std::path::PathBuf,
    entry_path: String,
    providers: HashMap<String, Option<ProviderConfig>>,
    package_map_json: Option<String>,
    port: Option<v8::Global<v8::Value>>,
) -> Result<ChildRealm, String> {
    // 1. Create a dedicated microtask queue for the child context.
    let child_queue = v8::MicrotaskQueue::new(scope, v8::MicrotasksPolicy::Explicit);

    // 2. Create the child V8 context, passing the queue via ContextOptions so
    //    V8 does not check whether a context is already entered (it isn't —
    //    we're in a bare HandleScope<()>).
    let child_context = {
        // Safety: child_queue is a UniqueRef we own; we pass a raw pointer for
        // V8's use. The queue is moved into FinoState immediately after context
        // creation, so it outlives the context it is assigned to.
        #[allow(invalid_reference_casting)]
        let queue_ptr = (&*child_queue as *const v8::MicrotaskQueue) as *mut v8::MicrotaskQueue;
        let ctx = v8::Context::new(
            scope,
            v8::ContextOptions {
                microtask_queue: Some(queue_ptr),
                ..Default::default()
            },
        );
        v8::Global::new(scope, ctx)
    };

    // 3. Enter the child context to initialize its FinoState and run bootstrap.
    {
        let child_ctx_local = v8::Local::new(scope, &child_context);
        let child_scope = &mut v8::ContextScope::new(scope, child_ctx_local);

        let state = FinoState {
            root,
            package_map_json,
            slot_count: 0,
            snapshot_store: Vec::new(),
            root_queue: child_queue,
            providers,
            builtin_cache: HashMap::new(),
            fs_cache: HashMap::new(),
            builtin_script_ids: HashSet::new(),
            builtin_specifiers: HashMap::new(),
            module_paths: HashMap::new(),
            source_maps: HashMap::new(),
            resolve_fn: None,
            init_meta_fn: None,
            loop_step_fn: None,
            on_done_fn: None,
            sync_call_fn: None,
            sync_call_resolver: None,
            tla_resolvers: Vec::new(),
            cpu_profiler: None,
            child_contexts: Vec::new(),
            pending_creates: Vec::new(),
            entry_path: Some(entry_path),
            terminated: false,
            port,
            channel_rx: None,
            channel_tx: None,
            wake_read_fd: None,
            wake_write_fd: None,
            thread_contexts: Vec::new(),
        };

        child_ctx_local.set_slot(Rc::new(RefCell::new(state)));

        // 4. Initialize CPED with an empty JS Array (live async-context frame).
        let initial_frame = v8::Array::new(child_scope, 0);
        child_scope.set_continuation_preserved_embedder_data(initial_frame.into());

        // 5. Compile and evaluate _bootstrap.mjs in the child context.
        //    _bootstrap.mts detects it's in a child Realm (entry_path is set),
        //    auto-imports the entry module, and calls driveLoop — so
        //    loop_step_fn is registered by the time pump_and_checkpoint returns.
        let bootstrap_src = include_str!(concat!(env!("OUT_DIR"), "/js/_bootstrap.mjs"));
        let bootstrap_map = include_str!(concat!(env!("OUT_DIR"), "/js/_bootstrap.mjs.map"));

        let bootstrap_module = {
            let tc = &mut v8::TryCatch::new(child_scope);
            loader::register_source_map_from_json(tc, "_bootstrap.mjs", bootstrap_map);
            match loader::compile_source_module(
                tc,
                bootstrap_src,
                "_bootstrap.mjs",
                Some(bootstrap_map),
            ) {
                Some(m) => m,
                None => {
                    let msg = catch_js_message(tc)
                        .unwrap_or_else(|| "Failed to compile _bootstrap.mjs".to_string());
                    return Err(msg);
                }
            }
        };

        // Register as "internal:bootstrap" so resolve_builtin_relative can
        // look up its source path and correctly resolve relative imports
        // like './runtime/loop.mts' within the bootstrap module body.
        loader::register_as_builtin(child_scope, bootstrap_module, "internal:bootstrap");

        {
            let tc = &mut v8::TryCatch::new(child_scope);
            if bootstrap_module
                .instantiate_module(tc, loader::resolve_module_callback)
                .is_none()
            {
                let msg = catch_js_message(tc)
                    .unwrap_or_else(|| "Failed to instantiate _bootstrap.mjs".to_string());
                return Err(msg);
            }
        }

        {
            let tc = &mut v8::TryCatch::new(child_scope);
            if bootstrap_module.evaluate(tc).is_none() {
                let msg = catch_js_message(tc)
                    .unwrap_or_else(|| "Failed to evaluate _bootstrap.mjs".to_string());
                return Err(msg);
            }
        }

        // 6. Pump + checkpoint to run the bootstrap module body.
        pump_and_checkpoint_in(child_scope);

        if bootstrap_module.get_status() == v8::ModuleStatus::Errored {
            let exc = bootstrap_module.get_exception();
            let msg = exc
                .to_string(child_scope)
                .map(|s| s.to_rust_string_lossy(child_scope))
                .unwrap_or_else(|| "Error in _bootstrap.mjs".to_string());
            return Err(msg);
        }
    }

    Ok(ChildRealm {
        context: child_context,
    })
}

// ---------------------------------------------------------------------------
// Deferred pending-realm processing
// ---------------------------------------------------------------------------

/// Drain `FinoState::pending_creates` and create each queued child context.
///
/// Must be called with a bare `HandleScope<()>` — i.e. outside any entered
/// context (the ContextScope for the current host-loop iteration must have
/// already been dropped).  On success the slot is upgraded from `Pending` to
/// `Active`; on failure it becomes `Failed`.
pub fn process_pending_creates(scope: &mut v8::HandleScope<()>, state_rc: &Rc<RefCell<FinoState>>) {
    let pending: Vec<PendingRealm> = std::mem::take(&mut state_rc.borrow_mut().pending_creates);

    for pending_realm in pending {
        let slot = match create_child_context(
            scope,
            pending_realm.root,
            pending_realm.entry_path,
            pending_realm.providers,
            pending_realm.package_map_json,
            pending_realm.port,
        ) {
            Ok(child_realm) => ChildRealmSlot::Active(child_realm),
            Err(e) => {
                eprintln!("fino: failed to create child realm: {e}");
                ChildRealmSlot::Failed
            }
        };
        state_rc.borrow_mut().child_contexts[pending_realm.handle_idx] = slot;
    }
}

// ---------------------------------------------------------------------------
// Stepping a child context
// ---------------------------------------------------------------------------

/// Enter the child context and drive one step of its event loop.
///
/// Mirrors the main host loop in `runtime.rs`:
/// 1. Call `loop_step_fn()` → bool.
/// 2. Service any pending `scheduleSync` call.
/// 3. Pump + checkpoint (drain child microtasks).
///
/// Returns the bool from `loop_step_fn`, or `false` if no step fn is registered.
pub fn step_child_context(
    scope: &mut v8::HandleScope,
    child_context: v8::Local<v8::Context>,
) -> bool {
    let child_scope = &mut v8::ContextScope::new(scope, child_context);

    // Extract loop_step_fn.
    let loop_step_fn = {
        let state_rc = get_state(child_scope);
        state_rc.borrow().loop_step_fn.clone()
    };

    let Some(loop_step_fn) = loop_step_fn else {
        // No step function yet — child bootstrap may still be running.
        pump_and_checkpoint_in(child_scope);
        return true;
    };

    // Call step() → boolean.
    let should_continue = {
        let undef: v8::Local<v8::Value> = v8::undefined(child_scope).into();
        v8::Local::new(child_scope, &loop_step_fn)
            .call(child_scope, undef, &[])
            .map(|v| v.boolean_value(child_scope))
            .unwrap_or(false)
    };

    // Service any pending scheduleSync call (same pattern as runtime.rs host loop).
    {
        let state_rc = get_state(child_scope);
        let (maybe_fn, maybe_resolver) = {
            let mut st = state_rc.borrow_mut();
            (st.sync_call_fn.take(), st.sync_call_resolver.take())
        };

        if let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) {
            let call_result: Result<v8::Global<v8::Value>, v8::Global<v8::Value>> = {
                let undef: v8::Local<v8::Value> = v8::undefined(child_scope).into();
                let tc = &mut v8::TryCatch::new(child_scope);
                let fn_local = v8::Local::new(tc, &fn_ref);
                match fn_local.call(tc, undef, &[]) {
                    Some(result) => Ok(v8::Global::new(tc, result)),
                    None => {
                        let exc = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                        Err(v8::Global::new(tc, exc))
                    }
                }
            };

            match call_result {
                Ok(result_ref) => {
                    let resolver_local = v8::Local::new(child_scope, &resolver_ref);
                    let result_local = v8::Local::new(child_scope, &result_ref);
                    let _ = resolver_local.resolve(child_scope, result_local);
                }
                Err(exc_ref) => {
                    let resolver_local = v8::Local::new(child_scope, &resolver_ref);
                    let exc_local = v8::Local::new(child_scope, &exc_ref);
                    let _ = resolver_local.reject(child_scope, exc_local);
                }
            }

            pump_and_checkpoint_in(child_scope);
        }
    }

    should_continue
}

/// Terminate all child Realms owned by the context at `scope`.
///
/// Sets each child's `terminated` flag, then steps it once so it observes the
/// flag and exits its loop. Called from the host loop in `runtime.rs` after the
/// main loop exits.  `Pending` and `Failed` slots are skipped.
pub fn terminate_all_children(scope: &mut v8::HandleScope) {
    let child_contexts: Vec<v8::Global<v8::Context>> = {
        let state_rc = get_state(scope);
        state_rc
            .borrow()
            .child_contexts
            .iter()
            .filter_map(|slot| {
                if let ChildRealmSlot::Active(r) = slot {
                    Some(r.context.clone())
                } else {
                    None
                }
            })
            .collect()
    };

    for child_global in child_contexts {
        // Set terminated flag.
        {
            let child_ctx = v8::Local::new(scope, &child_global);
            let child_scope = &mut v8::ContextScope::new(scope, child_ctx);
            get_state(child_scope).borrow_mut().terminated = true;
        }
        // Step once so the child observes the flag and calls on_done_fn if any.
        let child_ctx = v8::Local::new(scope, &child_global);
        step_child_context(scope, child_ctx);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn pump_and_checkpoint_in(scope: &mut v8::HandleScope) {
    let platform = v8::V8::get_current_platform();
    while v8::Platform::pump_message_loop(&platform, scope, false) {}
    let state_rc = get_state(scope);
    let queue_ptr = unsafe { root_queue_ptr(&state_rc) };
    let isolate: &mut v8::Isolate = scope.as_mut();
    unsafe { &*queue_ptr }.perform_checkpoint(isolate);
}

fn catch_js_message(tc: &mut v8::TryCatch<v8::HandleScope>) -> Option<String> {
    if !tc.has_caught() {
        return None;
    }
    tc.exception().and_then(|exc| {
        exc.to_object(tc)
            .and_then(|obj| v8::String::new(tc, "stack").and_then(|key| obj.get(tc, key.into())))
            .and_then(|stack| stack.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
            .or_else(|| exc.to_string(tc).map(|s| s.to_rust_string_lossy(tc)))
    })
}
