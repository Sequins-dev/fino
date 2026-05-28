//! Unified synthetic-module source generation and runtime installation.
//!
//! Two modes share the same Rust substrate:
//!
//! - `SyntheticMode::Direct` — same-realm `SyntheticModule`: each export is bound
//!   once at evaluation time by calling `__direct(specifier, name)` from
//!   `internal:synthetic-direct`. No transport, no RPC.
//!
//! - `SyntheticMode::Rpc` — cross-realm Facade: each export becomes an RPC stub
//!   `(...args) => __rpc(specifier, name, args)` via `internal:parent-rpc`.
//!   Streams and sinks are also supported.
//!
//! The `internal:synthetic-install` Rust module (exposed here) provides the
//! privileged primitive that `fino:module` calls to install/uninstall Direct
//! modules into the current realm's builtin cache.

use ::v8;

use crate::state::{ImportDirective, ImportPattern, ImportRule, SyntheticMode, SyntheticSpec, get_state};

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

/// Generate the JS source for a synthetic stub module.
pub fn create_module_source(spec: &SyntheticSpec) -> String {
    match spec.mode {
        SyntheticMode::Direct => create_direct_source(spec),
        SyntheticMode::Rpc => create_rpc_source(spec),
    }
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{}\"", s))
}

fn create_direct_source(spec: &SyntheticSpec) -> String {
    let spec_json = json_str(&spec.specifier);
    let mut lines = vec![
        "import { __direct } from 'internal:synthetic-direct';".to_string(),
        format!("const __s = {spec_json};"),
    ];
    for name in &spec.exports {
        let name_json = json_str(name);
        lines.push(format!("export const {name} = __direct(__s, {name_json});"));
    }
    lines.join("\n")
}

fn create_rpc_source(spec: &SyntheticSpec) -> String {
    let spec_json = json_str(&spec.specifier);
    let has_streams = !spec.streams.is_empty();
    let has_sinks = !spec.sinks.is_empty();

    let import_line = match (has_streams, has_sinks) {
        (true,  true)  => "import { call as __rpc, callStream as __rpcStream, callSink as __rpcSink } from 'internal:parent-rpc';",
        (true,  false) => "import { call as __rpc, callStream as __rpcStream } from 'internal:parent-rpc';",
        (false, true)  => "import { call as __rpc, callSink as __rpcSink } from 'internal:parent-rpc';",
        (false, false) => "import { call as __rpc } from 'internal:parent-rpc';",
    };

    let mut lines = vec![
        import_line.to_string(),
        format!("const __s = {spec_json};"),
    ];
    for name in &spec.exports {
        let name_json = json_str(name);
        lines.push(format!(
            "export const {name} = (...args) => __rpc(__s, {name_json}, args);"
        ));
    }
    for name in &spec.streams {
        let name_json = json_str(name);
        lines.push(format!(
            "export const {name} = (...args) => __rpcStream(__s, {name_json}, args);"
        ));
    }
    for name in &spec.sinks {
        let name_json = json_str(name);
        lines.push(format!(
            "export const {name} = (...args) => __rpcSink(__s, {name_json}, args);"
        ));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Install / uninstall (Direct mode only — called by internal:synthetic-install)
// ---------------------------------------------------------------------------

pub fn install_synthetic_module(
    scope: &mut v8::HandleScope,
    spec: &SyntheticSpec,
) -> Result<(), String> {
    let state_rc = get_state(scope);

    if state_rc.borrow().builtin_cache.contains_key(&spec.specifier) {
        return Err(format!("SyntheticModule already installed: {}", spec.specifier));
    }

    let code = create_module_source(spec);
    let module = crate::loader::compile_source_module(scope, &code, &spec.specifier, None)
        .ok_or_else(|| format!("Failed to compile synthetic module: {}", spec.specifier))?;

    if let Some(id) = module.script_id() {
        state_rc
            .borrow_mut()
            .builtin_specifiers
            .insert(id, spec.specifier.clone());
    }

    let global = v8::Global::new(scope, module);
    state_rc
        .borrow_mut()
        .builtin_cache
        .insert(spec.specifier.clone(), global);

    state_rc.borrow_mut().import_rules.push(ImportRule {
        from: None,
        pattern: ImportPattern::Exact(spec.specifier.clone()),
        directive: ImportDirective::Installed {
            specifier: spec.specifier.clone(),
        },
    });

    Ok(())
}

pub fn uninstall_synthetic_module(
    scope: &mut v8::HandleScope,
    specifier: &str,
) -> Result<(), String> {
    let state_rc = get_state(scope);
    let mut st = state_rc.borrow_mut();

    if st.builtin_cache.remove(specifier).is_none() {
        return Err(format!("SyntheticModule not installed: {specifier}"));
    }

    st.builtin_specifiers.retain(|_, v| v.as_str() != specifier);
    st.import_rules.retain(|rule| {
        !matches!(&rule.directive, ImportDirective::Installed { specifier: s } if s == specifier)
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// internal:synthetic-install — privileged Rust-backed module
// ---------------------------------------------------------------------------

pub fn create_install_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let names: Vec<v8::Local<v8::String>> = ["_installSyntheticModule", "_uninstallSyntheticModule"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();
    let mod_name = v8::String::new(scope, "internal:synthetic-install").unwrap();
    v8::Module::create_synthetic_module(scope, mod_name, &names, install_module_eval)
}

fn install_module_eval<'a>(
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

    set_fn!("_installSyntheticModule", js_install);
    set_fn!("_uninstallSyntheticModule", js_uninstall);

    Some(v8::undefined(scope).into())
}

/// `_installSyntheticModule(specifier: string, exports: string[]): void`
fn js_install(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let spec_val = args.get(0);
    let exports_val = args.get(1);

    let specifier = match spec_val.to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => return,
    };

    let exports_arr = match v8::Local::<v8::Array>::try_from(exports_val) {
        Ok(a) => a,
        Err(_) => {
            throw_str(scope, "_installSyntheticModule: second argument must be an Array");
            return;
        }
    };

    let mut exports = Vec::with_capacity(exports_arr.length() as usize);
    for i in 0..exports_arr.length() {
        let item = exports_arr.get_index(scope, i).unwrap_or_else(|| v8::undefined(scope).into());
        if let Some(s) = item.to_string(scope) {
            exports.push(s.to_rust_string_lossy(scope));
        }
    }

    let spec = SyntheticSpec {
        specifier,
        exports,
        streams: vec![],
        sinks: vec![],
        mode: SyntheticMode::Direct,
    };

    if let Err(e) = install_synthetic_module(scope, &spec) {
        throw_str(scope, &e);
    }
}

/// `_uninstallSyntheticModule(specifier: string): void`
fn js_uninstall(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let spec_val = args.get(0);
    let specifier = match spec_val.to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => return,
    };

    if let Err(e) = uninstall_synthetic_module(scope, &specifier) {
        throw_str(scope, &e);
    }
}

fn throw_str(scope: &mut v8::HandleScope, msg: &str) {
    if let Some(s) = v8::String::new(scope, msg) {
        let exc = v8::Exception::error(scope, s);
        scope.throw_exception(exc);
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{SyntheticMode, SyntheticSpec};

    fn rpc_spec(specifier: &str, exports: &[&str], streams: &[&str], sinks: &[&str]) -> SyntheticSpec {
        SyntheticSpec {
            specifier: specifier.to_string(),
            exports: exports.iter().map(|s| s.to_string()).collect(),
            streams: streams.iter().map(|s| s.to_string()).collect(),
            sinks: sinks.iter().map(|s| s.to_string()).collect(),
            mode: SyntheticMode::Rpc,
        }
    }

    fn direct_spec(specifier: &str, exports: &[&str]) -> SyntheticSpec {
        SyntheticSpec {
            specifier: specifier.to_string(),
            exports: exports.iter().map(|s| s.to_string()).collect(),
            streams: vec![],
            sinks: vec![],
            mode: SyntheticMode::Direct,
        }
    }

    #[test]
    fn rpc_no_exports_emits_only_header() {
        let spec = rpc_spec("fino:empty", &[], &[], &[]);
        let src = create_module_source(&spec);
        assert!(src.contains("import { call as __rpc } from 'internal:parent-rpc';"));
        assert!(!src.contains("callStream"));
        assert!(src.contains(r#"const __s = "fino:empty";"#));
        assert!(!src.contains("export const"));
    }

    #[test]
    fn rpc_single_export_generates_forwarding_function() {
        let spec = rpc_spec("fino:file", &["readFile"], &[], &[]);
        let src = create_module_source(&spec);
        assert!(src.contains(r#"export const readFile = (...args) => __rpc(__s, "readFile", args);"#));
        assert!(!src.contains("callStream"));
    }

    #[test]
    fn rpc_streaming_export_uses_call_stream() {
        let spec = rpc_spec("fino:file", &["stat"], &["read"], &[]);
        let src = create_module_source(&spec);
        assert!(src.contains("callStream as __rpcStream"));
        assert!(src.contains(r#"export const stat = (...args) => __rpc(__s, "stat", args);"#));
        assert!(src.contains(r#"export const read = (...args) => __rpcStream(__s, "read", args);"#));
    }

    #[test]
    fn rpc_sink_export_uses_call_sink() {
        let spec = rpc_spec("fino:file", &["stat"], &[], &["write"]);
        let src = create_module_source(&spec);
        assert!(src.contains("callSink as __rpcSink"));
        assert!(!src.contains("callStream"));
        assert!(src.contains(r#"export const write = (...args) => __rpcSink(__s, "write", args);"#));
    }

    #[test]
    fn rpc_all_three_kinds_emit_correct_imports() {
        let spec = rpc_spec("svc:fs", &["stat"], &["read"], &["write"]);
        let src = create_module_source(&spec);
        assert!(src.contains("callStream as __rpcStream"));
        assert!(src.contains("callSink as __rpcSink"));
    }

    #[test]
    fn rpc_specifier_with_special_chars_is_json_escaped() {
        let spec = rpc_spec(r#"fino:has"quote"#, &["fn"], &[], &[]);
        let src = create_module_source(&spec);
        assert!(src.contains(r#"const __s = "fino:has\"quote";"#));
    }

    #[test]
    fn direct_exports_use_direct_dispatch() {
        let spec = direct_spec("appConfig", &["API_KEY", "PORT"]);
        let src = create_module_source(&spec);
        assert!(src.contains("import { __direct } from 'internal:synthetic-direct';"));
        assert!(src.contains(r#"const __s = "appConfig";"#));
        assert!(src.contains(r#"export const API_KEY = __direct(__s, "API_KEY");"#));
        assert!(src.contains(r#"export const PORT = __direct(__s, "PORT");"#));
        assert!(!src.contains("__rpc"));
    }

    #[test]
    fn direct_no_streams_or_sinks() {
        let spec = direct_spec("myMod", &["foo"]);
        let src = create_module_source(&spec);
        assert!(!src.contains("callStream"));
        assert!(!src.contains("callSink"));
    }
}
