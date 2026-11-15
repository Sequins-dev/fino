//! `internal:realm-native` — parent-side Realm operations.
//!
//! Exposes the JS API used by the parent context to create, step, and terminate
//! embedded and process-sandbox child Realms. Reactor-pooled Realms use
//! `internal:scheduler-native`.

use ::libc;
use ::v8;

#[cfg(target_os = "linux")]
use super::thread;
use super::{message, process, transit};
use crate::state::{ImportRule, get_state, resolve_directive};

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        // Linux sandbox realm
        "createSandboxContext",
        "stepSandboxContext",
        "forceSandboxContext",
        "sandboxPortSend",
        "sandboxPortRecv",
        "getSandboxPortWakeReadFd",
        "getSandboxCompletionFd",
        // Process realm
        "createProcessContext",
        "stepProcessContext",
        "processPortSend",
        "processPortRecv",
        "getProcessSocketFd",
        "getProcessCompletionFd",
        "killProcessContext",
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
    v8::callback_scope!(unsafe let scope, context);

    crate::set_fn!(
        scope,
        module,
        "createSandboxContext",
        create_sandbox_context
    );
    crate::set_fn!(scope, module, "stepSandboxContext", step_sandbox_context);
    crate::set_fn!(scope, module, "forceSandboxContext", force_sandbox_context);
    crate::set_fn!(scope, module, "sandboxPortSend", sandbox_port_send);
    crate::set_fn!(scope, module, "sandboxPortRecv", sandbox_port_recv);
    crate::set_fn!(
        scope,
        module,
        "getSandboxPortWakeReadFd",
        get_sandbox_port_wake_read_fd
    );
    crate::set_fn!(
        scope,
        module,
        "getSandboxCompletionFd",
        get_sandbox_completion_fd
    );
    crate::set_fn!(
        scope,
        module,
        "createProcessContext",
        create_process_context
    );
    crate::set_fn!(scope, module, "stepProcessContext", step_process_context);
    crate::set_fn!(scope, module, "processPortSend", process_port_send);
    crate::set_fn!(scope, module, "processPortRecv", process_port_recv);
    crate::set_fn!(scope, module, "getProcessSocketFd", get_process_socket_fd);
    crate::set_fn!(
        scope,
        module,
        "getProcessCompletionFd",
        get_process_completion_fd
    );
    crate::set_fn!(scope, module, "killProcessContext", kill_process_context);

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

/// Intersection of the import map's exact, prefix and catch-all patterns.
fn intersect_pattern(
    a: &crate::state::ImportPattern,
    b: &crate::state::ImportPattern,
) -> Option<crate::state::ImportPattern> {
    use crate::state::ImportPattern::*;
    match (a, b) {
        (CatchAll, _) => Some(b.clone()),
        (_, CatchAll) => Some(a.clone()),
        (Exact(value), _) if b.matches(value) => Some(a.clone()),
        (_, Exact(value)) if a.matches(value) => Some(b.clone()),
        (Prefix(a), Prefix(b)) if a.starts_with(b) => Some(Prefix(a.clone())),
        (Prefix(a), Prefix(b)) if b.starts_with(a) => Some(Prefix(b.clone())),
        _ => None,
    }
}

/// Inherit selects the parent's effective policy, not the host's native module.
/// Clip the parent rule list to this child rule's scope, preserving ordering and
/// referrer restrictions. This also prevents inherit-all from erasing providers.
fn append_inherited(merged: &mut Vec<ImportRule>, parent: &[ImportRule], child: &ImportRule) {
    use crate::state::ImportPattern;
    if child.from.is_none() && matches!(child.pattern, ImportPattern::CatchAll) {
        // This rule supersedes every preceding child rule. Do not duplicate the
        // full parent map at each generation of an ordinary Realm tree.
        *merged = parent.to_vec();
        return;
    }
    merged.push(child.clone());
    for rule in parent {
        let Some(pattern) = intersect_pattern(&child.pattern, &rule.pattern) else {
            continue;
        };
        let Some(from) = intersect_pattern(
            child.from.as_ref().unwrap_or(&ImportPattern::CatchAll),
            rule.from.as_ref().unwrap_or(&ImportPattern::CatchAll),
        ) else {
            continue;
        };
        merged.push(ImportRule {
            pattern,
            from: if matches!(from, ImportPattern::CatchAll) {
                None
            } else {
                Some(from)
            },
            directive: rule.directive.clone(),
        });
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
pub(crate) fn resolve_child_package_map(
    scope: &mut v8::PinScope,
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

/// Parse a child rule array (or the legacy JSON string form) and merge it with
/// the parent's import rules.
///
/// The child's rules are appended after the parent's so that last-match-wins
/// semantics mean the child overrides the parent for any pattern it specifies.
///
/// `Inherit` selects the parent's effective policy within the child rule's scope.
///
/// At merge time, child rules are validated for capability narrowing: a child
/// rule that would grant access to a specifier the parent has blocked is rejected.
pub(crate) fn parse_and_merge_rules(
    scope: &mut v8::PinScope,
    rules_arg: v8::Local<v8::Value>,
) -> Result<Vec<ImportRule>, String> {
    use crate::state::ImportDirective;

    // Get the parent's rules.
    let parent_rules = get_state(scope).borrow().import_rules.clone();

    // Rule objects cross the synthetic-module call directly. JSON is only the
    // local serde conversion into Rust's existing ImportRule representation;
    // no JSON string is carried between isolates or threads.
    let json_str = if rules_arg.is_string() {
        rules_arg
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default()
    } else {
        v8::json::stringify(scope, rules_arg)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default()
    };

    if json_str.is_empty() || json_str == "null" || json_str == "[]" {
        return Ok(parent_rules);
    }

    let child_specific: Vec<ImportRule> =
        serde_json::from_str(&json_str).map_err(|e| format!("invalid import rules JSON: {e}"))?;

    let mut merged = parent_rules.clone();
    for rule in child_specific {
        if matches!(rule.directive, ImportDirective::Inherit) {
            append_inherited(&mut merged, &parent_rules, &rule);
            continue;
        }
        // Capability narrowing: reject non-Block, non-Inherit rules that would
        // grant access to a specifier the parent has blocked.
        // Inherit is exempted: it defers to the parent's rule and cannot escalate.
        if !matches!(
            rule.directive,
            ImportDirective::Block | ImportDirective::Inherit
        ) {
            narrowing_check(&parent_rules, &rule)?;
        }
        merged.push(rule);
    }

    Ok(merged)
}

// ---------------------------------------------------------------------------
// Same-Isolate child realm callbacks
// ---------------------------------------------------------------------------

/// Read an optional string argument: `undefined`/`null` → `None`.
fn optional_string_arg(scope: &mut v8::PinScope, arg: v8::Local<v8::Value>) -> Option<String> {
    if arg.is_undefined() || arg.is_null() {
        None
    } else {
        arg.to_string(scope).map(|s| s.to_rust_string_lossy(scope))
    }
}

// ---------------------------------------------------------------------------
// Linux sandbox realm callbacks
// ---------------------------------------------------------------------------

/// Spawn a fixed-thread Linux sandbox Realm.
fn create_sandbox_context(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (&args, &mut rv);
        let msg =
            v8::String::new(scope, "createSandboxContext: sandbox Realms require Linux").unwrap();
        let exception = v8::Exception::error(scope, msg);
        scope.throw_exception(exception);
    }

    #[cfg(target_os = "linux")]
    {
        let mut process_env = get_state(scope).borrow().process_env.clone();
        let root = args
            .get(0)
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default();
        if !root.is_empty() {
            process_env.root = std::path::PathBuf::from(root);
        }
        let entry_path = args
            .get(1)
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default();
        let import_rules = match parse_and_merge_rules(scope, args.get(2)) {
            Ok(rules) => rules,
            Err(error) => {
                let msg =
                    v8::String::new(scope, &format!("createSandboxContext: {error}")).unwrap();
                let exception = v8::Exception::error(scope, msg);
                scope.throw_exception(exception);
                return;
            }
        };
        let package_map_json = resolve_child_package_map(scope, &process_env.root);
        let realm_data = optional_string_arg(scope, args.get(3));
        let realm_bootstrap_data = optional_string_arg(scope, args.get(4));
        let handle = match thread::spawn_sandbox_realm(thread::SpawnConfig {
            process_env,
            entry_path,
            import_rules,
            package_map_json,
            realm_data,
            realm_bootstrap_data,
        }) {
            Ok(handle) => handle,
            Err(error) => {
                let msg =
                    v8::String::new(scope, &format!("createSandboxContext: {error}")).unwrap();
                let exception = v8::Exception::error(scope, msg);
                scope.throw_exception(exception);
                return;
            }
        };
        let idx = {
            let state_rc = get_state(scope);
            let mut state = state_rc.borrow_mut();
            let idx = state.sandbox_contexts.len();
            state.sandbox_contexts.push(Some(handle));
            idx
        };
        rv.set(v8::Integer::new(scope, idx as i32).into());
    }
}

/// Report whether a sandbox Realm thread is still running.
fn step_sandbox_context(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let (running, error) = {
        let state = state_rc.borrow();
        let realm = state
            .sandbox_contexts
            .get(handle)
            .and_then(|slot| slot.as_ref());
        let running = realm
            .map(|realm| !realm.done.load(std::sync::atomic::Ordering::Acquire))
            .unwrap_or(false);
        let error = if running {
            None
        } else {
            realm.and_then(|realm| realm.error.lock().ok()?.clone())
        };
        (running, error)
    };
    if !running {
        if let Some(slot) = state_rc.borrow_mut().sandbox_contexts.get_mut(handle) {
            *slot = None;
        }
        if let Some(error) = error {
            let msg = v8::String::new(scope, &error)
                .unwrap_or_else(|| v8::String::new(scope, "sandbox realm error").unwrap());
            let exception = v8::Exception::error(scope, msg);
            scope.throw_exception(exception);
            return;
        }
    }
    rv.set(v8::Boolean::new(scope, running).into());
}

/// Force V8 to terminate JavaScript running on a sandbox Realm thread.
fn force_sandbox_context(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let isolate_handle = {
        let state_rc = get_state(scope);
        let state = state_rc.borrow();
        let realm = state
            .sandbox_contexts
            .get(handle)
            .and_then(|slot| slot.as_ref());
        if let Some(realm) = realm {
            realm
                .force_requested
                .store(true, std::sync::atomic::Ordering::Release);
        }
        realm.and_then(|realm| realm.isolate_handle.lock().ok()?.clone())
    };
    if let Some(isolate_handle) = isolate_handle {
        isolate_handle.terminate_execution();
    }
}

fn sandbox_port_send(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let Some(message) = message::build_message_from_args(
        scope,
        "sandboxPortSend",
        args.get(1),
        args.get(2),
        args.get(3),
        args.get(4),
    ) else {
        return;
    };
    let transport = {
        let state_rc = get_state(scope);
        let state = state_rc.borrow();
        state
            .sandbox_contexts
            .get(handle)
            .and_then(|slot| slot.as_ref())
            .map(|realm| message::SendTransport {
                tx: realm.tx.clone(),
                wake_write: Some(realm.child_wake_write),
            })
    };
    if let Some(transport) = transport {
        message::send_message(&transport, message);
    }
}

fn sandbox_port_recv(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let messages = {
        let state_rc = get_state(scope);
        let state = state_rc.borrow();
        let transport = state
            .sandbox_contexts
            .get(handle)
            .and_then(|slot| slot.as_ref())
            .map(|realm| message::RecvTransport {
                rx: &realm.rx,
                wake_read: Some(realm.parent_wake_read),
            });
        transport
            .map(|transport| message::recv_messages(&transport))
            .unwrap_or_default()
    };
    rv.set(transit::build_message_array(scope, messages).into());
}

fn get_sandbox_port_wake_read_fd(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let state = state_rc.borrow();
    let fd = state
        .sandbox_contexts
        .get(handle)
        .and_then(|slot| slot.as_ref())
        .map(|realm| realm.parent_wake_read)
        .unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

// ---------------------------------------------------------------------------
// Process realm callbacks
// ---------------------------------------------------------------------------

/// JS: `createProcessContext(root, entryPath, serializedRules) -> number`
fn create_process_context(
    scope: &mut v8::PinScope,
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

    // Optional watch flag (4th arg), realm data JSON (5th arg), and bootstrap metadata (6th arg)
    let watch_mode = args.get(3).boolean_value(scope);
    let realm_data = optional_string_arg(scope, args.get(4));
    let realm_bootstrap_data = optional_string_arg(scope, args.get(5));

    let spawn_args = process::SpawnArgs {
        process_env,
        entry_path,
        import_rules,
        package_map_json,
        watch_mode,
        realm_data,
        realm_bootstrap_data,
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
    scope: &mut v8::PinScope,
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
            h.map(|h| {
                h.reload_requested
                    .load(std::sync::atomic::Ordering::Acquire)
            })
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

/// JS: `processPortSend(handle, header, bytes, stores?) -> void`
fn process_port_send(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let Some(mut message) = message::build_message_from_args(
        scope,
        "processPortSend",
        args.get(1),
        args.get(2),
        args.get(3),
        v8::undefined(scope).into(),
    ) else {
        return;
    };
    // Process realms do not support port transfer.
    message.transfer_ports = Vec::new();
    let transport = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        st.process_contexts
            .get(handle)
            .and_then(|s| s.as_ref())
            .map(|h| message::SendTransport {
                tx: h.tx.clone(),
                wake_write: None,
            })
    };
    if let Some(transport) = transport {
        message::send_message(&transport, message);
    }
}

/// JS: `processPortRecv(handle: number) -> [Uint8Array, ...Uint8Array[]][]`
fn process_port_recv(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;

    let messages = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        let transport = st
            .process_contexts
            .get(handle)
            .and_then(|s| s.as_ref())
            .map(|h| message::RecvTransport {
                rx: &h.rx,
                wake_read: Some(h.parent_wake_read),
            });
        transport
            .map(|transport| message::recv_messages(&transport))
            .unwrap_or_default()
    };

    rv.set(transit::build_message_array(scope, messages).into());
}

/// JS: `getProcessSocketFd(handle: number) -> number`
fn get_process_socket_fd(
    scope: &mut v8::PinScope,
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

/// JS: `killProcessContext(handle: number): void`
///
/// Force-kills an isolated process Realm. The reader bridge retains ownership
/// of `waitpid`, so the normal step path observes and releases the reaped
/// handle. Missing or already-exited handles are harmless.
/// JS: `getSandboxCompletionFd(handle) -> number`
///
/// Descriptor that becomes readable once a sandbox Realm's thread has finished,
/// so a parent realm waits for completion instead of polling the done flag.
fn get_sandbox_completion_fd(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let fd = state_rc
        .borrow()
        .sandbox_contexts
        .get(handle)
        .and_then(|slot| slot.as_ref())
        .map(|realm| realm.completion_wake_read)
        .unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

/// JS: `getProcessCompletionFd(handle) -> number`
///
/// Descriptor that becomes readable once the child process has exited, so a
/// parent realm can wait for completion instead of polling the done flag.
fn get_process_completion_fd(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let state_rc = get_state(scope);
    let fd = state_rc
        .borrow()
        .process_contexts
        .get(handle)
        .and_then(|slot| slot.as_ref())
        .map(|h| h.completion_wake_read)
        .unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

fn kill_process_context(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let handle = args.get(0).integer_value(scope).unwrap_or(-1) as usize;
    let pid = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        st.process_contexts
            .get(handle)
            .and_then(|slot| slot.as_ref())
            .filter(|process| !process.done.load(std::sync::atomic::Ordering::Acquire))
            .map(|process| process.child_pid)
    };
    if let Some(pid) = pid {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
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
    fn scoped_inherit_keeps_parent_blocks_and_referrer_policy() {
        let mut allowed = rule("service:safe", ImportDirective::Inherit);
        allowed.from = Some(ImportPattern::parse("app:trusted*"));
        let parent = vec![block_rule("service:*"), allowed];
        let mut merged = parent.clone();
        merged.push(block_rule("*"));
        append_inherited(
            &mut merged,
            &parent,
            &rule("service:*", ImportDirective::Inherit),
        );
        assert!(matches!(
            resolve_directive(&merged, Some("app:trusted/worker"), "service:safe"),
            Some(ImportDirective::Inherit)
        ));
        assert!(matches!(
            resolve_directive(&merged, Some("app:other"), "service:safe"),
            Some(ImportDirective::Block)
        ));
        assert!(matches!(
            resolve_directive(&merged, Some("app:trusted/worker"), "service:unsafe"),
            Some(ImportDirective::Block)
        ));
        assert!(matches!(
            resolve_directive(&merged, None, "outside:scope"),
            Some(ImportDirective::Block)
        ));
        append_inherited(&mut merged, &parent, &rule("*", ImportDirective::Inherit));
        assert_eq!(
            merged.len(),
            parent.len(),
            "inherit-all does not grow maps across generations"
        );
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
