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
