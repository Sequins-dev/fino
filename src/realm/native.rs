//! `internal:realm-native` — parent-side Realm operations.
//!
//! Exposes the JS API used by the parent context to create, step, and terminate
//! child Realms (both same-Isolate and thread-based).

use ::v8;
use ::libc;

use crate::{
    state::{ChildRealmSlot, ProviderConfig, get_state},
};
use super::{thread, transit};

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
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

    set_fn!("createContext", create_context);
    set_fn!("stepContext", step_context);
    set_fn!("terminateChild", terminate_child);
    set_fn!("createThreadContext", create_thread_context);
    set_fn!("stepThreadContext", step_thread_context);
    set_fn!("threadPortSend", thread_port_send);
    set_fn!("threadPortRecv", thread_port_recv);
    set_fn!("getThreadPortWakeReadFd", get_thread_port_wake_read_fd);

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// Same-Isolate child realm callbacks
// ---------------------------------------------------------------------------

/// JS: `createContext(root, entryPath, overrideEntries, blockedSpecifiers[, port]) -> number`
///
/// Queues a pending child-context creation and returns the pre-allocated
/// handle index. Actual context construction is deferred to
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
fn create_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use crate::state::PendingRealm;

    let root_arg = args.get(0);
    let entry_arg = args.get(1);
    let overrides_arg = args.get(2);
    let blocked_arg = args.get(3);
    let port_arg = args.get(4);

    // --- Build process_env: inherit from parent, override root if provided ---
    let mut process_env = get_state(scope).borrow().process_env.clone();
    {
        let s = root_arg
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default();
        if !s.is_empty() {
            process_env.root = std::path::PathBuf::from(s);
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
    let port_global: Option<v8::Global<v8::Value>> =
        if port_arg.is_undefined() || port_arg.is_null() {
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
            process_env,
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
fn step_context(
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

    let should_continue = super::step_child_context(scope, child_context);
    rv.set(v8::Boolean::new(scope, should_continue).into());
}

/// JS: `terminateChild(handle: number): void`
///
/// Sets `terminated = true` on the child's FinoState. The child's `isDone`
/// callback (which calls `isTerminated()`) will return true on the next step,
/// causing the child's loop to exit. Pending and failed slots are ignored.
fn terminate_child(
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
// Thread realm callbacks
// ---------------------------------------------------------------------------

/// JS: `createThreadContext(root, entryPath, overrideEntries, blockedSpecifiers): number`
///
/// Spawns a new OS thread with its own `v8::Isolate` running `_bootstrap.mjs`.
/// Returns a handle index into the parent's `thread_contexts` Vec.
fn create_thread_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let root_arg = args.get(0);
    let entry_arg = args.get(1);
    let overrides_arg = args.get(2);
    let blocked_arg = args.get(3);

    // --- Build process_env: inherit from parent, override root if provided ---
    let mut process_env = get_state(scope).borrow().process_env.clone();
    {
        let s = root_arg
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default();
        if !s.is_empty() {
            process_env.root = std::path::PathBuf::from(s);
        }
    };

    // --- Parse entry path ---
    let entry_path: String = entry_arg
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();

    // --- Build providers map (same logic as create_context) ---
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
    let spawn_config = thread::SpawnConfig {
        process_env,
        entry_path,
        providers,
        package_map_json,
    };

    let handle = match thread::spawn_thread_realm(spawn_config) {
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
fn step_thread_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    let h = st.thread_contexts.get(handle).and_then(|slot| slot.as_ref());
    let still_running = h
        .map(|h| !h.done.load(std::sync::atomic::Ordering::Acquire))
        .unwrap_or(false);
    if !still_running {
        // Check for a crash/error message and throw it as a JS exception.
        if let Some(err_msg) = h.and_then(|h| h.error.lock().ok()?.clone()) {
            let msg = v8::String::new(scope, &err_msg)
                .unwrap_or_else(|| v8::String::new(scope, "thread realm error").unwrap());
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
fn thread_port_send(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    use thread::ThreadMessage;

    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let bytes_arg = args.get(1);

    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(bytes_arg) else {
        let msg = v8::String::new(
            scope,
            "threadPortSend: second argument must be a Uint8Array",
        )
        .unwrap();
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
    let transfer_ports = thread::extract_port_infos(scope, args.get(3));

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
fn thread_port_recv(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use thread::ThreadMessage;

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

    rv.set(transit::build_message_array(scope, messages).into());
}

/// JS: `getThreadPortWakeReadFd(handle: number): number`
///
/// Returns the parent-side wake-pipe read fd for `loop.readable()` registration,
/// or -1 if the handle is not found.
fn get_thread_port_wake_read_fd(
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
