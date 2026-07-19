//! `internal:realm-native` — parent-side Realm operations.
//!
//! Exposes import-rule merging plus process-isolated Realm creation, lifecycle,
//! and transport setup. Ordinary realms are owned directly by reactor engines.

use ::v8;

use super::process;
use crate::state::{ImportRule, get_state, resolve_directive};

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "mergeChildRules",
        // Process realm
        "createProcessContext",
        "stepProcessContext",
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

    set_fn!("mergeChildRules", merge_child_rules);
    set_fn!("createProcessContext", create_process_context);
    set_fn!("stepProcessContext", step_process_context);

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
        if !matches!(
            rule.directive,
            ImportDirective::Block | ImportDirective::Inherit
        ) {
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

/// Read an optional string argument: `undefined`/`null` → `None`.
fn optional_string_arg(scope: &mut v8::HandleScope, arg: v8::Local<v8::Value>) -> Option<String> {
    if arg.is_undefined() || arg.is_null() {
        None
    } else {
        arg.to_string(scope).map(|s| s.to_rust_string_lossy(scope))
    }
}

/// JS: `mergeChildRules(rulesJson: string): string`
///
/// Merge child-specific import rules into the calling realm's own rules —
/// defaults included — with the capability-narrowing check applied. Scheduler
/// placement ships the merged result because the hosting engine has no parent
/// context to merge against. Throws on a narrowing violation.
fn merge_child_rules(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let merged = match parse_and_merge_rules(scope, args.get(0)) {
        Ok(rules) => rules,
        Err(e) => {
            let msg = v8::String::new(scope, &e).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };
    match serde_json::to_string(&merged) {
        Ok(json) => {
            let out = v8::String::new(scope, &json).unwrap();
            rv.set(out.into());
        }
        Err(e) => {
            let msg = v8::String::new(scope, &format!("mergeChildRules: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
        }
    }
}

// ---------------------------------------------------------------------------
// Process realm callbacks
// ---------------------------------------------------------------------------

/// JS: `createProcessContext(root, entryPath, serializedRules) -> { handle, portHandle, portWakeFd }`
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

    let port_handle = handle.port_handle;
    let port_wake_read = handle.port_wake_read;
    let idx = {
        let state_rc = get_state(scope);
        let mut st = state_rc.borrow_mut();
        let i = st.process_contexts.len();
        st.process_contexts.push(Some(handle));
        i
    };
    let result = v8::Object::new(scope);
    for (key, value) in [
        ("handle", idx as i32),
        ("portHandle", port_handle as i32),
        ("portWakeFd", port_wake_read),
    ] {
        let key = v8::String::new(scope, key).unwrap();
        let value = v8::Integer::new(scope, value);
        result.set(scope, key.into(), value.into());
    }
    rv.set(result.into());
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
        // Release the status handle. Socket bridge threads own their duplicated
        // descriptors and finish independently; the JS port owns the transit half.
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
