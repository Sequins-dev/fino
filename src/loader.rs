use std::{
    cell::RefCell,
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
};

use boa_engine::{
    Context, JsArgs, JsNativeError, JsResult, JsString, JsValue, Module, NativeFunction, js_string,
    module::{ModuleLoader, Referrer, SyntheticModuleInitializer},
    object::{FunctionObjectBuilder, JsObject},
};
use boa_parser::Source;

use crate::{
    async_context::{self, BoatsJobExecutor},
    ffi, platform,
};

// ---------------------------------------------------------------------------
// Built-in module registry
// ---------------------------------------------------------------------------

/// How a `boats:*` or `internal:*` built-in module is produced.
enum BuiltinKind {
    /// Embedded JS source parsed into a module on first import.
    Source(&'static str),
    /// A Rust function that constructs a synthetic module on first import.
    Synthetic(fn(&mut Context) -> JsResult<Module>),
}

/// A built-in entry: `(full specifier, kind)`.
type BuiltinEntry = (&'static str, BuiltinKind);

/// Platform-selected backend source: kqueue on macOS, io_uring on Linux.
/// Used so `boats:runtime/loop` can import the right backend with a static (sync)
/// import rather than `await import(...)`, which would make loop.mjs an
/// async module and trigger a Boa 0.21.1 panic on teardown.
#[cfg(target_os = "macos")]
const LOOP_BACKEND_SRC: &str =
    include_str!(concat!(env!("OUT_DIR"), "/js/internal/runtime/kqueue.mjs"));
#[cfg(not(target_os = "macos"))]
const LOOP_BACKEND_SRC: &str = include_str!(concat!(
    env!("OUT_DIR"),
    "/js/internal/runtime/io_uring.mjs"
));

/// Embeds a JS file at `js/<path>.mjs` as a built-in with the given specifier.
///
/// To add a new built-in:
/// - `boats:net/socket`       → `source_builtin!("boats:net/socket", "net/socket")`
/// - `internal:globals/url`   → `source_builtin!("internal:globals/url", "internal/globals/url")`
///
/// `internal:*` modules can only be imported by other built-in modules
/// (those without a filesystem path, i.e. `boats:*` and `internal:*`).
macro_rules! source_builtin {
    ($specifier:literal, $path:literal) => {
        (
            $specifier,
            BuiltinKind::Source(include_str!(concat!(
                env!("OUT_DIR"),
                "/js/",
                $path,
                ".mjs"
            ))),
        )
    };
}

/// Synthetic module that exposes `registerResolve` and `registerInitMeta`.
///
/// These functions are called by `internal:loader` (a JS module) to install
/// JS callbacks that the `BoatsModuleLoader` uses for filesystem resolution
/// and `import.meta` population. The callbacks are stored on `BoatsJobExecutor`
/// so Boa's GC can trace the `JsObject` references.
fn loader_hooks_module(context: &mut Context) -> JsResult<Module> {
    let module = Module::synthetic(
        &[
            js_string!("registerResolve"),
            js_string!("registerInitMeta"),
        ],
        SyntheticModuleInitializer::from_copy_closure(|module, context| {
            let register_resolve = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let func = args.get_or_undefined(0).as_object();
                    if let Some(exec) = context.downcast_job_executor::<BoatsJobExecutor>() {
                        *exec.resolve_fn.borrow_mut() = func;
                    }
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("registerResolve"))
            .length(1)
            .build();

            let register_init_meta = FunctionObjectBuilder::new(
                context.realm(),
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let func = args.get_or_undefined(0).as_object();
                    if let Some(exec) = context.downcast_job_executor::<BoatsJobExecutor>() {
                        *exec.init_meta_fn.borrow_mut() = func;
                    }
                    Ok(JsValue::undefined())
                }),
            )
            .name(js_string!("registerInitMeta"))
            .length(1)
            .build();

            module.set_export(&js_string!("registerResolve"), register_resolve.into())?;
            module.set_export(&js_string!("registerInitMeta"), register_init_meta.into())?;
            Ok(())
        }),
        None,
        None,
        context,
    );
    Ok(module)
}

/// The complete set of `boats:*` and `internal:*` built-ins.
static BUILTINS: &[BuiltinEntry] = &[
    // Synthetic Rust modules
    ("boats:ffi", BuiltinKind::Synthetic(ffi::create_module)),
    (
        "internal:process",
        BuiltinKind::Synthetic(platform::create_module),
    ),
    (
        "internal:async-context",
        BuiltinKind::Synthetic(async_context::create_module),
    ),
    (
        "internal:loader-hooks",
        BuiltinKind::Synthetic(loader_hooks_module),
    ),
    source_builtin!("internal:loader", "internal/loader"),
    // internal: globals (web spec globals, accessible only via globalThis)
    source_builtin!("internal:globals/encoding", "internal/globals/encoding"),
    source_builtin!("internal:globals/console", "internal/globals/console"),
    source_builtin!(
        "internal:globals/eventtarget",
        "internal/globals/eventtarget"
    ),
    source_builtin!("internal:globals/abort", "internal/globals/abort"),
    source_builtin!("internal:globals/blob", "internal/globals/blob"),
    source_builtin!("internal:globals/url", "internal/globals/url"),
    source_builtin!("internal:globals/urlpattern", "internal/globals/urlpattern"),
    source_builtin!("internal:globals/webstreams", "internal/globals/webstreams"),
    source_builtin!("internal:globals/formdata", "internal/globals/formdata"),
    source_builtin!("internal:globals/crypto", "internal/globals/crypto"),
    source_builtin!("internal:globals/time", "internal/globals/time"),
    source_builtin!("internal:globals/fetch", "internal/globals/fetch"),
    source_builtin!(
        "internal:globals/compression-streams",
        "internal/globals/compression-streams"
    ),
    source_builtin!("internal:globals/global", "internal/globals/global"),
    // internal: stream and openssl
    source_builtin!("internal:stream", "internal/stream"),
    source_builtin!("internal:openssl", "internal/openssl"),
    // internal: file sub-modules
    source_builtin!("internal:file/bindings", "file/bindings"),
    source_builtin!("internal:file/stat", "file/stat"),
    source_builtin!("internal:file/handle", "file/handle"),
    source_builtin!("internal:file/entry", "file/entry"),
    source_builtin!("internal:file/glob", "file/glob"),
    source_builtin!("internal:file/watch-bindings", "file/watch-bindings"),
    // runtime
    source_builtin!("internal:runtime/libc", "internal/runtime/libc"),
    source_builtin!("internal:runtime/kqueue", "internal/runtime/kqueue"),
    source_builtin!("internal:runtime/io_uring", "internal/runtime/io_uring"),
    (
        "internal:runtime/loop-backend",
        BuiltinKind::Source(LOOP_BACKEND_SRC),
    ),
    source_builtin!("boats:runtime/loop", "runtime/loop"),
    source_builtin!("boats:runtime/process", "runtime/process"),
    source_builtin!("boats:runtime/context", "runtime/context"),
    // net
    source_builtin!("boats:net/socket", "net/socket"),
    source_builtin!("boats:net/http", "net/http"),
    source_builtin!("boats:net/tls", "net/tls"),
    source_builtin!("boats:net/dns", "net/dns"),
    source_builtin!("boats:net/serve", "net/serve"),
    source_builtin!("boats:net/eventsource", "net/eventsource"),
    // file
    source_builtin!("boats:file", "file/fs"),
    source_builtin!("boats:file/path", "file/path"),
    source_builtin!("boats:file/watch", "file/watch"),
    // test
    source_builtin!("boats:test/assert", "test/assert"),
    source_builtin!("boats:test/test", "test/test"),
    source_builtin!("boats:test/bench", "test/bench"),
    // util
    source_builtin!("boats:util/compression", "util/compression"),
    source_builtin!("boats:util/topic", "util/topic"),
];

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

/// A module loader that serves both embedded `boats:*` / `internal:*` built-ins
/// Strips TypeScript type annotations from `source_text`, returning plain JS.
///
/// Uses OXC's transformer with only the TypeScript pass enabled — no downleveling,
/// no JSX. The `path` argument is used solely for `SourceType` detection.
fn strip_types(path: &Path, source_text: &str) -> Result<String, String> {
    use oxc_allocator::Allocator;
    use oxc_codegen::Codegen;
    use oxc_parser::Parser;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;
    use oxc_transformer::{TransformOptions, Transformer, TypeScriptOptions};

    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts());

    let ret = Parser::new(&allocator, source_text, source_type).parse();
    if !ret.errors.is_empty() {
        let msgs: Vec<String> = ret.errors.iter().map(|e| e.message.to_string()).collect();
        return Err(msgs.join("\n"));
    }

    let mut program = ret.program;

    let scoping = SemanticBuilder::new()
        .with_excess_capacity(2.0)
        .build(&program)
        .semantic
        .into_scoping();

    let options = TransformOptions {
        typescript: TypeScriptOptions::default(),
        ..TransformOptions::default()
    };

    let transformer_ret =
        Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);

    if !transformer_ret.errors.is_empty() {
        let msgs: Vec<String> = transformer_ret
            .errors
            .iter()
            .map(|e| e.message.to_string())
            .collect();
        return Err(msgs.join("\n"));
    }

    Ok(Codegen::new().build(&program).code)
}

/// Returns true if the path has a TypeScript file extension.
fn is_typescript(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "mts" | "cts")
    )
}

/// Returns true if the path is a JSON file.
fn is_json(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

/// Escape a raw string for embedding as a JS string literal (single-quoted).
fn escape_js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            c => out.push(c),
        }
    }
    out
}

/// and ordinary filesystem modules.
///
/// Specifier resolution:
/// - `boats:<name>`    → looked up in `BUILTINS`, cached after first load
/// - `internal:<name>` → same as above, but restricted to built-in importers
/// - `./foo` / `../foo` → relative to the importing module's directory
/// - `/abs/path`       → absolute
/// - `bare`            → resolved from the entry-point directory (`root`)
pub struct BoatsModuleLoader {
    root: PathBuf,
    /// Parsed / constructed modules for `boats:*` and `internal:*` specifiers.
    /// Keyed by the full specifier string (e.g. `"boats:ffi"`, `"internal:process"`).
    builtin_cache: RefCell<HashMap<&'static str, Module>>,
    /// Parsed modules for filesystem paths.
    fs_cache: RefCell<HashMap<PathBuf, Module>>,
}

impl BoatsModuleLoader {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            builtin_cache: RefCell::new(HashMap::new()),
            fs_cache: RefCell::new(HashMap::new()),
        }
    }

    fn resolve_path(&self, referrer: &Referrer, specifier: &str) -> JsResult<PathBuf> {
        let base = match referrer {
            Referrer::Module(module) => module
                .path()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| self.root.clone()),
            Referrer::Realm(_) | Referrer::Script(_) => self.root.clone(),
        };

        let resolved = if specifier.starts_with("./") || specifier.starts_with("../") {
            base.join(specifier)
        } else if specifier.starts_with('/') {
            PathBuf::from(specifier)
        } else {
            self.root.join(specifier)
        };

        resolved.canonicalize().map_err(|e| {
            JsNativeError::error()
                .with_message(format!("Cannot resolve module '{specifier}': {e}"))
                .into()
        })
    }
}

impl ModuleLoader for BoatsModuleLoader {
    async fn load_imported_module(
        self: Rc<Self>,
        referrer: Referrer,
        specifier: JsString,
        context: &RefCell<&mut Context>,
    ) -> JsResult<Module> {
        let specifier_str = specifier.to_std_string_escaped();

        // ---- boats:* and internal:* built-ins ------------------------------
        if specifier_str.starts_with("boats:") || specifier_str.starts_with("internal:") {
            // `internal:*` modules are restricted to built-in importers.
            // Built-in modules have no filesystem path (parsed from embedded bytes).
            // User filesystem modules have a path set by Source::from_filepath.
            if specifier_str.starts_with("internal:") {
                let allowed = match &referrer {
                    Referrer::Module(m) => m.path().is_none(),
                    _ => false,
                };
                if !allowed {
                    return Err(JsNativeError::error()
                        .with_message(format!(
                            "Cannot import internal module '{specifier_str}' from user code"
                        ))
                        .into());
                }
            }

            // Return cached module if already loaded.
            if let Some(module) = self.builtin_cache.borrow().get(specifier_str.as_str()) {
                return Ok(module.clone());
            }

            // Find the registry entry.
            let entry = BUILTINS
                .iter()
                .find(|(spec, _)| *spec == specifier_str)
                .ok_or_else(|| {
                    JsNativeError::error()
                        .with_message(format!("Unknown built-in: '{specifier_str}'"))
                })?;
            let (spec, kind) = entry;

            let module = match kind {
                BuiltinKind::Source(src) => {
                    let source = Source::from_bytes(src.as_bytes());
                    Module::parse(source, None, *context.borrow_mut())?
                }
                BuiltinKind::Synthetic(factory) => factory(*context.borrow_mut())?,
            };

            // `spec` is `&'static str` so it's safe as a HashMap key.
            self.builtin_cache.borrow_mut().insert(spec, module.clone());
            return Ok(module);
        }

        // ---- Filesystem modules --------------------------------------------

        // Try the JS resolver (registered by `internal:loader` after _main.mjs loads).
        // Falls back to Rust resolution if not yet registered.
        let path = {
            let resolve_fn = context
                .borrow()
                .downcast_job_executor::<BoatsJobExecutor>()
                .and_then(|exec| exec.resolve_fn.borrow().clone());

            if let Some(func) = resolve_fn {
                let referrer_dir = match &referrer {
                    Referrer::Module(m) => m
                        .path()
                        .and_then(|p| p.parent())
                        .map(|p| JsValue::from(js_string!(p.to_string_lossy().as_ref())))
                        .unwrap_or(JsValue::null()),
                    _ => JsValue::null(),
                };
                let root_val = JsValue::from(js_string!(self.root.to_string_lossy().as_ref()));
                let spec_val = JsValue::from(specifier.clone());

                let result = func.call(
                    &JsValue::undefined(),
                    &[spec_val, referrer_dir, root_val],
                    *context.borrow_mut(),
                )?;

                PathBuf::from(
                    result
                        .to_string(*context.borrow_mut())?
                        .to_std_string_escaped(),
                )
            } else {
                self.resolve_path(&referrer, &specifier_str)?
            }
        };

        if let Some(module) = self.fs_cache.borrow().get(&path) {
            return Ok(module.clone());
        }

        let module = if is_json(&path) {
            let json_text = std::fs::read_to_string(&path).map_err(|e| {
                JsNativeError::error()
                    .with_message(format!("Cannot read '{}': {e}", path.display()))
            })?;
            let escaped = escape_js_string(&json_text);
            let src = format!("export default JSON.parse('{escaped}');");
            let source = Source::from_reader(std::io::Cursor::new(src), Some(path.as_path()));
            Module::parse(source, None, *context.borrow_mut())?
        } else if is_typescript(&path) {
            let source_text = std::fs::read_to_string(&path).map_err(|e| {
                JsNativeError::error()
                    .with_message(format!("Cannot read '{}': {e}", path.display()))
            })?;
            let stripped = strip_types(&path, &source_text).map_err(|e| {
                JsNativeError::error()
                    .with_message(format!("TypeScript error in '{}': {e}", path.display()))
            })?;
            let source = Source::from_reader(std::io::Cursor::new(stripped), Some(path.as_path()));
            Module::parse(source, None, *context.borrow_mut())?
        } else {
            let source = Source::from_filepath(&path).map_err(|e| {
                JsNativeError::error()
                    .with_message(format!("Cannot read '{}': {e}", path.display()))
            })?;
            Module::parse(source, None, *context.borrow_mut())?
        };

        self.fs_cache.borrow_mut().insert(path, module.clone());
        Ok(module)
    }

    fn init_import_meta(
        self: Rc<Self>,
        import_meta: &JsObject,
        module: &Module,
        context: &mut Context,
    ) {
        // Builtin modules (boats:*, internal:*) have no filesystem path.
        // Leave import.meta empty for them.
        let Some(path) = module.path() else { return };

        // Delegate to the JS callback registered by `internal:loader` if available.
        let init_meta_fn = context
            .downcast_job_executor::<BoatsJobExecutor>()
            .and_then(|exec| exec.init_meta_fn.borrow().clone());

        if let Some(func) = init_meta_fn {
            let filename = JsValue::from(js_string!(path.to_string_lossy().as_ref()));
            let root_val = JsValue::from(js_string!(self.root.to_string_lossy().as_ref()));
            let _ = func.call(
                &JsValue::undefined(),
                &[JsValue::from(import_meta.clone()), filename, root_val],
                context,
            );
            return;
        }

        // Fallback: Rust implementation (used before internal:loader registers its callback).
        let filename = path.to_string_lossy();
        let url = format!("file://{filename}");

        let _ = import_meta.set(
            js_string!("url"),
            JsValue::from(js_string!(url.as_str())),
            false,
            context,
        );
        let _ = import_meta.set(
            js_string!("filename"),
            JsValue::from(js_string!(filename.as_ref())),
            false,
            context,
        );

        if let Some(dir) = path.parent() {
            let dirname = dir.to_string_lossy();
            let _ = import_meta.set(
                js_string!("dirname"),
                JsValue::from(js_string!(dirname.as_ref())),
                false,
                context,
            );
        }

        // import.meta.resolve(specifier) — resolves relative/absolute paths to file:// URLs.
        // boats:* and internal:* specifiers are returned as-is.
        let base_dir = path.parent().unwrap_or(path).to_path_buf();
        let root = self.root.clone();
        // SAFETY: Captures only PathBuf values, which contain no GC-traced types.
        let resolve_fn = FunctionObjectBuilder::new(context.realm(), unsafe {
            NativeFunction::from_closure(move |_this, args, ctx| {
                let spec = args
                    .get_or_undefined(0)
                    .to_string(ctx)?
                    .to_std_string_escaped();

                if spec.starts_with("boats:") || spec.starts_with("internal:") {
                    return Ok(JsValue::from(js_string!(spec.as_str())));
                }

                let raw = if spec.starts_with("./") || spec.starts_with("../") {
                    base_dir.join(&spec)
                } else if spec.starts_with('/') {
                    PathBuf::from(&spec)
                } else {
                    root.join(&spec)
                };

                let canonical = raw.canonicalize().map_err(|e| {
                    JsNativeError::error().with_message(format!("Cannot resolve '{spec}': {e}"))
                })?;
                let resolved_url = format!("file://{}", canonical.to_string_lossy());
                Ok(JsValue::from(js_string!(resolved_url.as_str())))
            })
        })
        .name(js_string!("resolve"))
        .length(1)
        .build();

        let _ = import_meta.set(
            js_string!("resolve"),
            JsValue::from(resolve_fn),
            false,
            context,
        );
    }
}
