//! Facade proxy source generation.
//!
//! When the import rule system resolves a specifier to a `Facade` directive, the
//! loader calls `create_facade_source` to generate a thin JS proxy module that
//! forwards every exported function call to the parent realm via
//! `internal:parent-rpc`.
//!
//! The generated source is compiled and cached exactly like a `Source` directive,
//! but WITHOUT insertion into `builtin_script_ids` — the proxy module's specifier
//! (e.g. `"fino:file"`) already falls under the `fino:*` pattern in the default
//! import rules, granting it access to `internal:*` without special-casing.

use crate::state::FacadeSpec;

/// Generate the JS source code for a facade proxy module.
///
/// For `FacadeSpec { specifier: "fino:file", exports: ["readFile", "writeFile"] }`
/// the output is:
///
/// ```js
/// import { call as __rpc } from 'internal:parent-rpc';
/// const __s = "fino:file";
/// export const readFile  = (...args) => __rpc(__s, "readFile",  args);
/// export const writeFile = (...args) => __rpc(__s, "writeFile", args);
/// ```
///
/// Returns `(source_code, source_map_json)`.  The source map is empty for now
/// since the generated code is trivial and has no user-visible line numbers.
pub fn create_facade_source(spec: &FacadeSpec) -> (String, String) {
    let spec_json = serde_json::to_string(&spec.specifier)
        .unwrap_or_else(|_| format!("\"{}\"", spec.specifier));

    let mut lines = vec![
        "import { call as __rpc } from 'internal:parent-rpc';".to_string(),
        format!("const __s = {spec_json};"),
    ];

    for name in &spec.exports {
        let name_json = serde_json::to_string(name).unwrap_or_else(|_| format!("\"{}\"", name));
        lines.push(format!(
            "export const {name} = (...args) => __rpc(__s, {name_json}, args);"
        ));
    }

    (lines.join("\n"), String::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::FacadeSpec;

    #[test]
    fn no_exports_emits_only_header() {
        let spec = FacadeSpec {
            specifier: "fino:empty".to_string(),
            exports: vec![],
        };
        let (src, map) = create_facade_source(&spec);
        assert!(src.contains("import { call as __rpc } from 'internal:parent-rpc';"));
        assert!(src.contains(r#"const __s = "fino:empty";"#));
        assert!(!src.contains("export const"));
        assert!(map.is_empty());
    }

    #[test]
    fn single_export_generates_forwarding_function() {
        let spec = FacadeSpec {
            specifier: "fino:file".to_string(),
            exports: vec!["readFile".to_string()],
        };
        let (src, _) = create_facade_source(&spec);
        assert!(
            src.contains(r#"export const readFile = (...args) => __rpc(__s, "readFile", args);"#)
        );
    }

    #[test]
    fn multiple_exports_each_get_a_line() {
        let spec = FacadeSpec {
            specifier: "svc:auth".to_string(),
            exports: vec![
                "login".to_string(),
                "logout".to_string(),
                "refresh".to_string(),
            ],
        };
        let (src, _) = create_facade_source(&spec);
        assert!(src.contains(r#"export const login = "#));
        assert!(src.contains(r#"export const logout = "#));
        assert!(src.contains(r#"export const refresh = "#));
        // Specifier string in header
        assert!(src.contains(r#"const __s = "svc:auth";"#));
    }

    #[test]
    fn specifier_with_special_chars_is_json_escaped() {
        let spec = FacadeSpec {
            // Contains a quote — must be JSON-escaped
            specifier: r#"fino:has"quote"#.to_string(),
            exports: vec!["fn".to_string()],
        };
        let (src, _) = create_facade_source(&spec);
        // The specifier must be JSON-encoded, so the quote becomes \"
        assert!(src.contains(r#"const __s = "fino:has\"quote";"#));
    }
}
