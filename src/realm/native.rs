//! `internal:realm-native` — parent-side Realm operations.
//!
//! Exposes the JS API used by the parent context to create, step, and terminate
//! child Realms (both same-Isolate and thread-based).

use ::libc;
use ::v8;

use super::{process, thread, transit};
use crate::state::{ChildRealmSlot, ImportRule, get_state, resolve_directive};

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
        // Process realm
        "createProcessContext",
        "stepProcessContext",
        "processPortSend",
        "processPortRecv",
        "getProcessSocketFd",
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
    set_fn!("createProcessContext", create_process_context);
    set_fn!("stepProcessContext", step_process_context);
    set_fn!("processPortSend", process_port_send);
    set_fn!("processPortRecv", process_port_recv);
    set_fn!("getProcessSocketFd", get_process_socket_fd);

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// Shared helper: parse and merge import rules from JSON
// ---------------------------------------------------------------------------

/// Returns true if `child_pattern` could match `spec`.
fn child_covers(child_pattern: &crate::state::ImportPattern, spec: &str) -> bool {
    use crate::state::ImportPattern;
    match child_pattern {
        ImportPattern::CatchAll => true,
        ImportPattern::Prefix(p) => spec.starts_with(p.as_str()),
        ImportPattern::Exact(e) => e == spec,
    }
}

/// Capability-narrowing check for a single child rule.
///
/// For every parent `Block` rule, derive a representative specifier and test
/// whether the child's pattern would cover it. If the parent's last-match-wins
/// resolution is still `Block` for that specifier, the child is attempting to
/// escalate — return an error.
///
/// Covers all three pattern shapes (Exact, Prefix, CatchAll) in the child.
fn narrowing_check(
    parent_rules: &[crate::state::ImportRule],
    child_rule: &crate::state::ImportRule,
) -> Result<(), String> {
    use crate::state::ImportDirective;

    // Check 1: pattern-based escalation (child pattern overlaps a blocked specifier).
    for parent_rule in parent_rules {
        if !matches!(parent_rule.directive, ImportDirective::Block) {
            continue;
        }
        // Choose a representative specifier for this blocked parent pattern.
        let repr: &str = match &parent_rule.pattern {
            crate::state::ImportPattern::Exact(s) => s.as_str(),
            crate::state::ImportPattern::Prefix(p) => p.as_str(),
            // CatchAll blocks everything; any literal works as representative.
            crate::state::ImportPattern::CatchAll => "internal:__cap_check__",
        };
        if child_covers(&child_rule.pattern, repr) {
            // Confirm the parent's effective (last-match-wins) resolution is Block.
            let parent_dir = resolve_directive(parent_rules, None, repr);
            if matches!(parent_dir, Some(ImportDirective::Block)) {
                return Err(format!(
                    "child import rule ({:?}) escalates past parent block on '{repr}'",
                    child_rule.pattern
                ));
            }
        }
    }

    // Check 2: Remap target escalation — the target of a Remap must not itself
    // resolve to a parent-blocked specifier.
    if let ImportDirective::Remap { target } = &child_rule.directive {
        let target_dir = resolve_directive(parent_rules, None, target);
        if matches!(target_dir, Some(ImportDirective::Block)) {
            return Err(format!(
                "child Remap to '{target}' escalates past parent block on that specifier"
            ));
        }
    }

    Ok(())
}

/// Resolve the package map JSON for a child realm.
///
/// If the child's root differs from the parent's, re-read `.fino/package-map.json`
/// from the child's root. Otherwise inherit the parent's already-loaded value.
fn resolve_child_package_map(
    scope: &mut v8::HandleScope,
    child_root: &std::path::Path,
) -> Option<String> {
    let parent_root = get_state(scope).borrow().process_env.root.clone();
    if child_root != parent_root {
        let map_path = child_root.join(".fino/package-map.json");
        std::fs::read_to_string(&map_path).ok()
    } else {
        get_state(scope).borrow().package_map_json.clone()
    }
}

/// Parse `serializedRules` (a JS string containing a JSON array of ImportRule
/// objects) and merge with the parent's import rules.
///
/// The child's rules are appended after the parent's so that last-match-wins
/// semantics mean the child overrides the parent for any pattern it specifies.
///
/// `Inherit` directives from the child-specific rules are dropped — the parent's
/// rule already covers those specifiers via the merged list.
///
/// At merge time, child rules are validated for capability narrowing: a child
/// rule that would grant access to a specifier the parent has blocked is rejected.
fn parse_and_merge_rules(
    scope: &mut v8::HandleScope,
    rules_arg: v8::Local<v8::Value>,
) -> Result<Vec<ImportRule>, String> {
    use crate::state::ImportDirective;

    // Get the parent's rules.
    let parent_rules = get_state(scope).borrow().import_rules.clone();

    // Parse the child-specific JSON rules.
    let json_str = rules_arg
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();

    if json_str.is_empty() || json_str == "null" || json_str == "[]" {
        return Ok(parent_rules);
    }

    let child_specific: Vec<ImportRule> =
        serde_json::from_str(&json_str).map_err(|e| format!("invalid import rules JSON: {e}"))?;

    let mut merged = parent_rules.clone();
    for rule in child_specific {
        // Capability narrowing: reject non-Block, non-Inherit rules that would
        // grant access to a specifier the parent has blocked.
        // Inherit is exempted: it defers to the parent's rule and cannot escalate.
        if !matches!(rule.directive, ImportDirective::Block | ImportDirective::Inherit) {
            narrowing_check(&parent_rules, &rule)?;
        }
        // Include ALL child rules — even Inherit ones. An explicit Inherit
        // rule from the child is an intentional "re-allow" that must override
        // any preceding Block rule (last-match-wins semantics).
        merged.push(rule);
    }

    Ok(merged)
}

// ---------------------------------------------------------------------------
// Same-Isolate child realm callbacks
// ---------------------------------------------------------------------------

/// JS: `createContext(root, entryPath, serializedRules[, port]) -> number`
///
/// Queues a pending child-context creation and returns the pre-allocated
/// handle index. Actual context construction is deferred to
/// `process_pending_creates`, which the host loop calls between iterations
/// when a bare `HandleScope<()>` is available.
///
/// Arguments:
/// - `root` — filesystem root for the child (inherits from parent if empty).
/// - `entryPath` — absolute path to the entry module to import in the child.
/// - `serializedRules` — JSON string: `ImportRule[]` (child-specific rules to
///   merge with the parent's rules). Empty/null = inherit parent's rules as-is.
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
    let rules_arg = args.get(2);
    let port_arg = args.get(3);

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

    // --- Parse and merge import rules ---
    let import_rules = match parse_and_merge_rules(scope, rules_arg) {
        Ok(r) => r,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("createContext: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    let package_map_json = resolve_child_package_map(scope, &process_env.root);

    // --- Capture the optional port object as a Global before borrowing state ---
    let port_global: Option<v8::Global<v8::Value>> =
        if port_arg.is_undefined() || port_arg.is_null() {
            None
        } else {
            Some(v8::Global::new(scope, port_arg))
        };

    // --- Parse optional watch flag (5th arg) ---
    let watch_mode = args.get(4).boolean_value(scope);

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
            import_rules,
            package_map_json,
            port: port_global,
            watch_mode,
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
            Some(ChildRealmSlot::Failed(maybe_msg)) => {
                // Throw a JS Error so _stepChildren propagates it via child.reject().
                if let Some(msg) = maybe_msg.as_deref() {
                    let s = v8::String::new(scope, msg).unwrap_or_else(|| {
                        v8::String::new(scope, "child realm creation failed").unwrap()
                    });
                    let exc = v8::Exception::error(scope, s);
                    scope.throw_exception(exc);
                }
                rv.set(v8::Boolean::new(scope, false).into());
                return;
            }
            None => {
                rv.set(v8::Boolean::new(scope, false).into());
                return;
            }
        }
    };

    let should_continue = super::step_child_context(scope, child_context);

    // When the child exits, check entry error and reload flag.
    // - entry_error present → throw (Realm.run() rejects)
    // - reload_requested → return null (signals JS to respawn)
    // - otherwise → return false (clean exit)
    if !should_continue {
        let (entry_error, reload_requested) = {
            let child_scope = &mut v8::ContextScope::new(scope, child_context);
            let st = get_state(child_scope);
            let st = st.borrow();
            (st.entry_error.clone(), st.reload_requested)
        };
        if let Some(msg) = entry_error {
            if let Some(s) = v8::String::new(scope, &msg) {
                let exc = v8::Exception::error(scope, s);
                scope.throw_exception(exc);
                return;
            }
        }
        if reload_requested {
            rv.set(v8::null(scope).into());
            return;
        }
    }

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

/// JS: `createThreadContext(root, entryPath, serializedRules): number`
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
    let rules_arg = args.get(2);

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

    // --- Parse and merge import rules ---
    let import_rules = match parse_and_merge_rules(scope, rules_arg) {
        Ok(r) => r,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("createThreadContext: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    let package_map_json = resolve_child_package_map(scope, &process_env.root);

    // --- Parse optional watch flag (4th arg) ---
    let watch_mode = args.get(3).boolean_value(scope);

    // --- Spawn the thread realm ---
    let spawn_config = thread::SpawnConfig {
        process_env,
        entry_path,
        import_rules,
        package_map_json,
        watch_mode,
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

    // Read done/reload/error under a short immutable borrow.
    let (still_running, reload_requested, maybe_err) = {
        let st = state_rc.borrow();
        let h = st.thread_contexts.get(handle).and_then(|s| s.as_ref());
        let running = h
            .map(|h| !h.done.load(std::sync::atomic::Ordering::Acquire))
            .unwrap_or(false);
        let reload = if !running {
            h.map(|h| h.reload_requested.load(std::sync::atomic::Ordering::Acquire))
                .unwrap_or(false)
        } else {
            false
        };
        let err = if !running {
            h.and_then(|h| h.error.lock().ok()?.clone())
        } else {
            None
        };
        (running, reload, err)
    };

    if !still_running {
        // Release the handle slot so the ThreadRealmHandle is dropped (joins the thread).
        if let Some(slot) = state_rc.borrow_mut().thread_contexts.get_mut(handle) {
            *slot = None;
        }
        if let Some(err_msg) = maybe_err {
            let msg = v8::String::new(scope, &err_msg)
                .unwrap_or_else(|| v8::String::new(scope, "thread realm error").unwrap());
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
        if reload_requested {
            rv.set(v8::null(scope).into());
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
                    let Some(sab) = su8a.buffer(scope) else {
                        continue;
                    };
                    let Some(sptr) = sab.data() else { continue };
                    let soff = su8a.byte_offset();
                    let slen = su8a.byte_length();
                    // SAFETY: same as above.
                    let raw = unsafe {
                        std::slice::from_raw_parts((sptr.as_ptr() as *const u8).add(soff), slen)
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

    let thread_msg = ThreadMessage {
        data,
        transfer_stores,
        transfer_ports,
    };

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

// ---------------------------------------------------------------------------
// Process realm callbacks
// ---------------------------------------------------------------------------

/// JS: `createProcessContext(root, entryPath, serializedRules) -> number`
fn create_process_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let root_arg = args.get(0);
    let entry_arg = args.get(1);
    let rules_arg = args.get(2);

    let mut process_env = get_state(scope).borrow().process_env.clone();
    let root_s = root_arg
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();
    if !root_s.is_empty() {
        process_env.root = std::path::PathBuf::from(root_s);
    }

    let entry_path = entry_arg
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();

    let import_rules = match parse_and_merge_rules(scope, rules_arg) {
        Ok(r) => r,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("createProcessContext: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    let package_map_json = resolve_child_package_map(scope, &process_env.root);

    // Optional watch flag (4th arg)
    let watch_mode = args.get(3).boolean_value(scope);

    let spawn_args = process::SpawnArgs {
        process_env,
        entry_path,
        import_rules,
        package_map_json,
        watch_mode,
    };
    let handle = match process::spawn_process_realm(spawn_args) {
        Ok(h) => h,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("createProcessContext: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    let idx = {
        let state_rc = get_state(scope);
        let mut st = state_rc.borrow_mut();
        let i = st.process_contexts.len();
        st.process_contexts.push(Some(handle));
        i
    };
    rv.set(v8::Integer::new(scope, idx as i32).into());
}

/// JS: `stepProcessContext(handle: number) -> boolean`
fn step_process_context(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);

    let (still_running, reload_requested, maybe_err) = {
        let st = state_rc.borrow();
        let h = st.process_contexts.get(handle).and_then(|s| s.as_ref());
        let running = h
            .map(|h| !h.done.load(std::sync::atomic::Ordering::Acquire))
            .unwrap_or(false);
        let reload = if !running {
            h.map(|h| h.reload_requested.load(std::sync::atomic::Ordering::Acquire))
                .unwrap_or(false)
        } else {
            false
        };
        let err = if !running {
            h.and_then(|h| h.error.lock().ok()?.clone())
        } else {
            None
        };
        (running, reload, err)
    };

    if !still_running {
        // Release the handle slot so ProcessRealmHandle is dropped (closes socket, waitpid).
        if let Some(slot) = state_rc.borrow_mut().process_contexts.get_mut(handle) {
            *slot = None;
        }
        if let Some(err_msg) = maybe_err {
            let msg = v8::String::new(scope, &err_msg)
                .unwrap_or_else(|| v8::String::new(scope, "process realm error").unwrap());
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
        if reload_requested {
            rv.set(v8::null(scope).into());
            return;
        }
    }
    rv.set(v8::Boolean::new(scope, still_running).into());
}

/// JS: `processPortSend(handle, bytes, stores?) -> void`
fn process_port_send(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    use thread::ThreadMessage;

    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let bytes_arg = args.get(1);
    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(bytes_arg) else {
        return;
    };

    let data: Vec<u8> = {
        let Some(ab) = u8a.buffer(scope) else { return };
        let Some(ptr) = ab.data() else { return };
        let off = u8a.byte_offset();
        let len = u8a.byte_length();
        unsafe { std::slice::from_raw_parts((ptr.as_ptr() as *const u8).add(off), len).to_vec() }
    };

    let transfer_stores: Vec<Vec<u8>> = if let Ok(arr) =
        v8::Local::<v8::Array>::try_from(args.get(2))
    {
        let mut stores = Vec::with_capacity(arr.length() as usize);
        for i in 0..arr.length() {
            let idx = v8::Integer::new(scope, i as i32);
            if let Some(elem) = arr.get(scope, idx.into())
                && let Ok(su8a) = v8::Local::<v8::Uint8Array>::try_from(elem)
            {
                let Some(sab) = su8a.buffer(scope) else {
                    continue;
                };
                let Some(sptr) = sab.data() else { continue };
                let soff = su8a.byte_offset();
                let slen = su8a.byte_length();
                unsafe {
                    stores.push(
                        std::slice::from_raw_parts((sptr.as_ptr() as *const u8).add(soff), slen)
                            .to_vec(),
                    );
                }
            }
        }
        stores
    } else {
        Vec::new()
    };

    let msg = ThreadMessage {
        data,
        transfer_stores,
        transfer_ports: Vec::new(),
    };

    let maybe_tx = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        st.process_contexts
            .get(handle)
            .and_then(|s| s.as_ref())
            .map(|h| h.tx.clone())
    };
    if let Some(tx) = maybe_tx {
        let _ = tx.send(msg);
    }
}

/// JS: `processPortRecv(handle: number) -> [Uint8Array, ...Uint8Array[]][]`
fn process_port_recv(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    use thread::ThreadMessage;

    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;

    let (messages, maybe_wake_read) = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        match st.process_contexts.get(handle).and_then(|s| s.as_ref()) {
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

    if let Some(wake_read) = maybe_wake_read {
        let mut discard = [0u8; 256];
        unsafe { libc::read(wake_read, discard.as_mut_ptr() as *mut _, discard.len()) };
    }

    rv.set(transit::build_message_array(scope, messages).into());
}

/// JS: `getProcessSocketFd(handle: number) -> number`
fn get_process_socket_fd(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let st = state_rc.borrow();
    let fd = st
        .process_contexts
        .get(handle)
        .and_then(|s| s.as_ref())
        .map(|h| h.parent_wake_read)
        .unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ImportDirective, ImportPattern, ImportRule};

    fn rule(pattern: &str, directive: ImportDirective) -> ImportRule {
        ImportRule {
            from: None,
            pattern: ImportPattern::parse(pattern),
            directive,
        }
    }

    fn remap_rule(pattern: &str, target: &str) -> ImportRule {
        rule(
            pattern,
            ImportDirective::Remap {
                target: target.to_string(),
            },
        )
    }

    fn block_rule(pattern: &str) -> ImportRule {
        rule(pattern, ImportDirective::Block)
    }

    #[test]
    fn remap_to_blocked_exact_is_rejected() {
        let parent = vec![block_rule("internal:realm-native")];
        let child = remap_rule("fino:my-module", "internal:realm-native");
        assert!(narrowing_check(&parent, &child).is_err());
    }

    #[test]
    fn remap_to_blocked_prefix_target_is_rejected() {
        let parent = vec![block_rule("internal:*")];
        let child = remap_rule("fino:alias", "internal:foo");
        assert!(narrowing_check(&parent, &child).is_err());
    }

    #[test]
    fn remap_to_unblocked_target_is_allowed() {
        let parent = vec![block_rule("internal:realm-native")];
        let child = remap_rule("fino:alias", "fino:ffi");
        assert!(narrowing_check(&parent, &child).is_ok());
    }

    #[test]
    fn catchall_remap_to_blocked_target_is_rejected() {
        let parent = vec![block_rule("internal:*")];
        let child = ImportRule {
            from: None,
            pattern: ImportPattern::CatchAll,
            directive: ImportDirective::Remap {
                target: "internal:anything".to_string(),
            },
        };
        assert!(narrowing_check(&parent, &child).is_err());
    }

    #[test]
    fn catchall_covers_everything() {
        assert!(child_covers(&ImportPattern::CatchAll, "fino:ffi"));
        assert!(child_covers(&ImportPattern::CatchAll, "internal:x"));
    }

    #[test]
    fn prefix_covers_matching_prefix() {
        let p = ImportPattern::parse("fino:*");
        assert!(child_covers(&p, "fino:ffi"));
        assert!(!child_covers(&p, "internal:x"));
    }

    #[test]
    fn exact_covers_only_itself() {
        let p = ImportPattern::parse("fino:ffi");
        assert!(child_covers(&p, "fino:ffi"));
        assert!(!child_covers(&p, "fino:ffi/extra"));
        assert!(!child_covers(&p, "internal:x"));
    }
}
