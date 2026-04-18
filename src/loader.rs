//! V8 module loader — resolve callback, import.meta hook, dynamic import,
//! and the `internal:loader-hooks` synthetic module.

use std::path::{Component, Path, PathBuf};

use ::v8;
use oxc_sourcemap::SourceMap;

use crate::{
    async_context, broadcast, docgen, ffi, platform, profiler, realm, serializer, thread_realm,
    transit,
    state::get_state,
};

// ---------------------------------------------------------------------------
// Built-in module registry
// ---------------------------------------------------------------------------

enum BuiltinKind {
    Source {
        code: &'static str,
        source_map: &'static str,
    },
    Synthetic(for<'s> fn(&mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module>),
}

type BuiltinEntry = (&'static str, BuiltinKind);

#[cfg(target_os = "macos")]
const LOOP_BACKEND_SRC: &str =
    include_str!(concat!(env!("OUT_DIR"), "/js/internal/runtime/kqueue.mjs"));
#[cfg(target_os = "macos")]
const LOOP_BACKEND_MAP: &str = include_str!(concat!(
    env!("OUT_DIR"),
    "/js/internal/runtime/kqueue.mjs.map"
));
#[cfg(not(target_os = "macos"))]
const LOOP_BACKEND_SRC: &str = include_str!(concat!(
    env!("OUT_DIR"),
    "/js/internal/runtime/io_uring.mjs"
));
#[cfg(not(target_os = "macos"))]
const LOOP_BACKEND_MAP: &str = include_str!(concat!(
    env!("OUT_DIR"),
    "/js/internal/runtime/io_uring.mjs.map"
));

macro_rules! source_builtin {
    ($specifier:literal, $path:literal) => {
        (
            $specifier,
            BuiltinKind::Source {
                code: include_str!(concat!(env!("OUT_DIR"), "/js/", $path, ".mjs")),
                source_map: include_str!(concat!(env!("OUT_DIR"), "/js/", $path, ".mjs.map")),
            },
        )
    };
}

static BUILTINS: &[BuiltinEntry] = &[
    // Synthetic Rust modules
    (
        "internal:broadcast",
        BuiltinKind::Synthetic(broadcast::create_module),
    ),
    ("fino:ffi", BuiltinKind::Synthetic(ffi::create_module)),
    (
        "internal:serializer",
        BuiltinKind::Synthetic(serializer::create_module),
    ),
    (
        "internal:thread-port",
        BuiltinKind::Synthetic(thread_realm::create_thread_port_module),
    ),
    (
        "internal:transit-port",
        BuiltinKind::Synthetic(transit::create_module),
    ),
    (
        "internal:realm-bridge",
        BuiltinKind::Synthetic(realm::create_realm_bridge_module),
    ),
    (
        "internal:realm-native",
        BuiltinKind::Synthetic(realm::create_realm_native_module),
    ),
    (
        "internal:process",
        BuiltinKind::Synthetic(platform::create_module),
    ),
    (
        "internal:async-context",
        BuiltinKind::Synthetic(async_context::create_module),
    ),
    (
        "internal:docgen",
        BuiltinKind::Synthetic(docgen::create_module),
    ),
    (
        "internal:loader-hooks",
        BuiltinKind::Synthetic(loader_hooks_module),
    ),
    source_builtin!("internal:loader", "internal/loader"),
    source_builtin!("internal:bootstrap", "_bootstrap"),
    source_builtin!("fino:realm", "runtime/realm"),
    source_builtin!("fino:realm/pool", "runtime/realm-pool"),
    source_builtin!("fino:realm/self", "runtime/realm-self"),
    source_builtin!("fino:messaging", "runtime/messaging"),
    source_builtin!(
        "internal:globals/messaging",
        "internal/globals/messaging"
    ),
    // internal: CLI commands
    source_builtin!("internal:commands/root", "commands/root"),
    source_builtin!("internal:commands/test", "commands/test"),
    source_builtin!("internal:commands/bench", "commands/bench"),
    source_builtin!("internal:commands/install", "commands/install"),
    source_builtin!("internal:commands/init", "commands/init"),
    source_builtin!("internal:commands/doc", "commands/doc"),
    source_builtin!("internal:shutdown", "internal/shutdown"),
    source_builtin!("internal:package_manager", "internal/package_manager"),
    // internal: globals (web spec globals)
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
    source_builtin!(
        "internal:globals/broadcast-channel",
        "internal/globals/broadcast-channel"
    ),
    source_builtin!("internal:globals/global", "internal/globals/global"),
    // internal: stream and openssl
    source_builtin!("internal:stream", "internal/stream"),
    source_builtin!("internal:openssl", "internal/openssl"),
    // internal: file sub-modules
    source_builtin!("internal:file/provider", "file/provider"),
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
        BuiltinKind::Source {
            code: LOOP_BACKEND_SRC,
            source_map: LOOP_BACKEND_MAP,
        },
    ),
    source_builtin!("fino:runtime/loop", "runtime/loop"),
    source_builtin!("fino:runtime/process", "runtime/process"),
    source_builtin!("fino:runtime/context", "runtime/context"),
    source_builtin!("fino:tty", "tty"),
    // net
    source_builtin!("internal:net/provider", "net/provider"),
    source_builtin!("internal:net/dns-provider", "net/dns-provider"),
    source_builtin!("fino:net/socket", "net/socket"),
    source_builtin!("fino:net/http", "net/http"),
    source_builtin!("fino:net/tls", "net/tls"),
    source_builtin!("fino:net/dns", "net/dns"),
    source_builtin!("fino:net/serve", "net/serve"),
    source_builtin!("fino:net/eventsource", "net/eventsource"),
    source_builtin!("fino:net/websocket", "net/websocket"),
    // file
    source_builtin!("fino:file", "file/fs"),
    source_builtin!("fino:file/path", "file/path"),
    source_builtin!("fino:file/watch", "file/watch"),
    source_builtin!("fino:archive", "archive"),
    source_builtin!("internal:opentelemetry/core", "opentelemetry/core"),
    source_builtin!("internal:opentelemetry/common", "opentelemetry/common"),
    source_builtin!("internal:opentelemetry/traces", "opentelemetry/traces"),
    source_builtin!("internal:opentelemetry/logs", "opentelemetry/logs"),
    source_builtin!("internal:opentelemetry/metrics", "opentelemetry/metrics"),
    source_builtin!(
        "internal:opentelemetry/exporters",
        "opentelemetry/exporters"
    ),
    source_builtin!(
        "internal:opentelemetry/bootstrap",
        "opentelemetry/bootstrap"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/index",
        "opentelemetry/instrumentations/index"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/http-server",
        "opentelemetry/instrumentations/http-server"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/fetch",
        "opentelemetry/instrumentations/fetch"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/trace-topic",
        "opentelemetry/instrumentations/trace-topic"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/_runtime-client",
        "opentelemetry/instrumentations/_runtime-client"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/dns",
        "opentelemetry/instrumentations/dns"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/socket",
        "opentelemetry/instrumentations/socket"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/tls",
        "opentelemetry/instrumentations/tls"
    ),
    source_builtin!("internal:opentelemetry/sdk", "opentelemetry/sdk"),
    source_builtin!("fino:opentelemetry", "opentelemetry"),
    source_builtin!("fino:semver", "semver"),
    // test
    source_builtin!("fino:test/assert", "test/assert"),
    source_builtin!("fino:test/test", "test/test"),
    source_builtin!("fino:test/bench", "test/bench"),
    source_builtin!("fino:test/mock", "test/mock"),
    // util
    source_builtin!("fino:util/argv", "util/argv"),
    source_builtin!("fino:util/compression", "util/compression"),
    source_builtin!("fino:util/prompt", "util/prompt"),
    source_builtin!("fino:util/topic", "util/topic"),
    // profiler
    (
        "fino:profiler",
        BuiltinKind::Synthetic(profiler::create_module),
    ),
];

fn builtin_source_path(spec: &str) -> Option<&'static str> {
    match spec {
        "_main.mjs" => Some(""),
        "internal:loader" => Some("internal/loader"),
        "internal:bootstrap" => Some("_bootstrap"),
        "fino:realm" => Some("runtime/realm"),
        "fino:realm/pool" => Some("runtime/realm-pool"),
        "fino:realm/self" => Some("runtime/realm-self"),
        "fino:messaging" => Some("runtime/messaging"),
        "internal:globals/messaging" => Some("internal/globals/messaging"),
        "internal:commands/root" => Some("commands/root"),
        "internal:commands/test" => Some("commands/test"),
        "internal:commands/bench" => Some("commands/bench"),
        "internal:commands/install" => Some("commands/install"),
        "internal:commands/init" => Some("commands/init"),
        "internal:commands/doc" => Some("commands/doc"),
        "internal:shutdown" => Some("internal/shutdown"),
        "internal:package_manager" => Some("internal/package_manager"),
        "internal:globals/encoding" => Some("internal/globals/encoding"),
        "internal:globals/console" => Some("internal/globals/console"),
        "internal:globals/eventtarget" => Some("internal/globals/eventtarget"),
        "internal:globals/abort" => Some("internal/globals/abort"),
        "internal:globals/blob" => Some("internal/globals/blob"),
        "internal:globals/url" => Some("internal/globals/url"),
        "internal:globals/urlpattern" => Some("internal/globals/urlpattern"),
        "internal:globals/webstreams" => Some("internal/globals/webstreams"),
        "internal:globals/formdata" => Some("internal/globals/formdata"),
        "internal:globals/crypto" => Some("internal/globals/crypto"),
        "internal:globals/time" => Some("internal/globals/time"),
        "internal:globals/fetch" => Some("internal/globals/fetch"),
        "internal:globals/compression-streams" => Some("internal/globals/compression-streams"),
        "internal:globals/broadcast-channel" => Some("internal/globals/broadcast-channel"),
        "internal:globals/global" => Some("internal/globals/global"),
        "internal:stream" => Some("internal/stream"),
        "internal:openssl" => Some("internal/openssl"),
        "internal:file/provider" => Some("file/provider"),
        "internal:file/bindings" => Some("file/bindings"),
        "internal:file/stat" => Some("file/stat"),
        "internal:file/handle" => Some("file/handle"),
        "internal:file/entry" => Some("file/entry"),
        "internal:file/glob" => Some("file/glob"),
        "internal:file/watch-bindings" => Some("file/watch-bindings"),
        "internal:runtime/libc" => Some("internal/runtime/libc"),
        "internal:runtime/kqueue" => Some("internal/runtime/kqueue"),
        "internal:runtime/io_uring" => Some("internal/runtime/io_uring"),
        "internal:runtime/loop-backend" => Some("internal/runtime/loop-backend"),
        "fino:runtime/loop" => Some("runtime/loop"),
        "fino:runtime/process" => Some("runtime/process"),
        "fino:runtime/context" => Some("runtime/context"),
        "fino:tty" => Some("tty"),
        "internal:net/provider" => Some("net/provider"),
        "internal:net/dns-provider" => Some("net/dns-provider"),
        "fino:net/socket" => Some("net/socket"),
        "fino:net/http" => Some("net/http"),
        "fino:net/tls" => Some("net/tls"),
        "fino:net/dns" => Some("net/dns"),
        "fino:net/serve" => Some("net/serve"),
        "fino:net/eventsource" => Some("net/eventsource"),
        "fino:net/websocket" => Some("net/websocket"),
        "fino:file" => Some("file/fs"),
        "fino:file/path" => Some("file/path"),
        "fino:file/watch" => Some("file/watch"),
        "fino:archive" => Some("archive"),
        "internal:opentelemetry/core" => Some("opentelemetry/core"),
        "internal:opentelemetry/common" => Some("opentelemetry/common"),
        "internal:opentelemetry/traces" => Some("opentelemetry/traces"),
        "internal:opentelemetry/logs" => Some("opentelemetry/logs"),
        "internal:opentelemetry/metrics" => Some("opentelemetry/metrics"),
        "internal:opentelemetry/exporters" => Some("opentelemetry/exporters"),
        "internal:opentelemetry/bootstrap" => Some("opentelemetry/bootstrap"),
        "internal:opentelemetry/instrumentations/index" => {
            Some("opentelemetry/instrumentations/index")
        }
        "internal:opentelemetry/instrumentations/http-server" => {
            Some("opentelemetry/instrumentations/http-server")
        }
        "internal:opentelemetry/instrumentations/fetch" => {
            Some("opentelemetry/instrumentations/fetch")
        }
        "internal:opentelemetry/instrumentations/trace-topic" => {
            Some("opentelemetry/instrumentations/trace-topic")
        }
        "internal:opentelemetry/instrumentations/_runtime-client" => {
            Some("opentelemetry/instrumentations/_runtime-client")
        }
        "internal:opentelemetry/instrumentations/dns" => Some("opentelemetry/instrumentations/dns"),
        "internal:opentelemetry/instrumentations/socket" => {
            Some("opentelemetry/instrumentations/socket")
        }
        "internal:opentelemetry/instrumentations/tls" => Some("opentelemetry/instrumentations/tls"),
        "internal:opentelemetry/sdk" => Some("opentelemetry/sdk"),
        "fino:opentelemetry" => Some("opentelemetry"),
        "fino:semver" => Some("semver"),
        "fino:test/assert" => Some("test/assert"),
        "fino:test/test" => Some("test/test"),
        "fino:test/bench" => Some("test/bench"),
        "fino:test/mock" => Some("test/mock"),
        "fino:util/argv" => Some("util/argv"),
        "fino:util/compression" => Some("util/compression"),
        "fino:util/prompt" => Some("util/prompt"),
        "fino:util/topic" => Some("util/topic"),
        _ => None,
    }
}

fn strip_builtin_extension(path: &str) -> &str {
    for ext in [".mts", ".mjs", ".ts", ".js", ".json"] {
        if let Some(stripped) = path.strip_suffix(ext) {
            return stripped;
        }
    }
    path
}

fn normalize_builtin_path(path: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            Component::RootDir | Component::Prefix(_) => {}
        }
    }
    parts.join("/")
}

fn resolve_builtin_relative(referrer_spec: &str, specifier: &str) -> Option<&'static str> {
    if !specifier.starts_with("./") && !specifier.starts_with("../") {
        return None;
    }
    let referrer_path = builtin_source_path(referrer_spec)?;
    let mut base = PathBuf::from(referrer_path);
    base.pop();
    let resolved = normalize_builtin_path(&base.join(strip_builtin_extension(specifier)));

    BUILTINS.iter().find_map(|(candidate, _)| {
        if builtin_source_path(candidate) == Some(resolved.as_str()) {
            Some(*candidate)
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------------------
// internal:loader-hooks synthetic module
// ---------------------------------------------------------------------------

/// Creates `internal:loader-hooks` — exposes `registerResolve` and
/// `registerInitMeta` so `internal:loader` can install JS callbacks for
/// filesystem resolution and `import.meta` population.
pub fn loader_hooks_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "registerResolve",
        "registerInitMeta",
        "getPackageMap",
        "lookupOriginalPosition",
    ]
    .iter()
    .map(|n| v8::String::new(scope, n).unwrap())
    .collect();
    let name = v8::String::new(scope, "internal:loader-hooks").unwrap();
    v8::Module::create_synthetic_module(scope, name, &export_names, loader_hooks_eval)
}

fn loader_hooks_eval<'a>(
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

    set_fn!("registerResolve", register_resolve);
    set_fn!("registerInitMeta", register_init_meta);
    set_fn!("getPackageMap", get_package_map);
    set_fn!("lookupOriginalPosition", lookup_original_position);

    Some(v8::undefined(scope).into())
}

fn register_resolve(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let func_val: v8::Local<v8::Value> = args.get(0);
    if let Ok(func) = v8::Local::<v8::Function>::try_from(func_val) {
        let global = v8::Global::new(scope, func);
        get_state(scope).borrow_mut().resolve_fn = Some(global);
    }
}

fn register_init_meta(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let func_val: v8::Local<v8::Value> = args.get(0);
    if let Ok(func) = v8::Local::<v8::Function>::try_from(func_val) {
        let global = v8::Global::new(scope, func);
        get_state(scope).borrow_mut().init_meta_fn = Some(global);
    }
}

fn get_package_map(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state = get_state(scope);
    let json = state.borrow().package_map_json.clone();
    match json {
        Some(text) => {
            if let Some(value) = v8::String::new(scope, &text) {
                rv.set(value.into());
            } else {
                rv.set(v8::null(scope).into());
            }
        }
        None => rv.set(v8::null(scope).into()),
    }
}

fn lookup_original_position(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let resource = args
        .get(0)
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope));
    let line = args.get(1).uint32_value(scope);
    let column = args.get(2).uint32_value(scope);

    let (Some(resource), Some(line), Some(column)) = (resource, line, column) else {
        rv.set(v8::null(scope).into());
        return;
    };

    let mapped = {
        let state = get_state(scope);
        let state = state.borrow();
        state
            .source_maps
            .get(&resource)
            .and_then(|cache| cache.lookup(line.saturating_sub(1), column.saturating_sub(1)))
    };

    let Some((source, mapped_line, mapped_column)) = mapped else {
        rv.set(v8::null(scope).into());
        return;
    };

    let obj = v8::Object::new(scope);
    let source_key = v8::String::new(scope, "source").unwrap();
    let line_key = v8::String::new(scope, "line").unwrap();
    let column_key = v8::String::new(scope, "column").unwrap();
    let Some(source_value) = v8::String::new(scope, &source) else {
        rv.set(v8::null(scope).into());
        return;
    };
    let line_value = v8::Integer::new_from_unsigned(scope, mapped_line + 1);
    let column_value = v8::Integer::new_from_unsigned(scope, mapped_column + 1);
    obj.set(scope, source_key.into(), source_value.into());
    obj.set(scope, line_key.into(), line_value.into());
    obj.set(scope, column_key.into(), column_value.into());
    rv.set(obj.into());
}

// ---------------------------------------------------------------------------
// Module resolution callback
// ---------------------------------------------------------------------------

pub fn resolve_module_callback<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _import_attrs: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    let raw_spec = specifier.to_rust_string_lossy(scope);

    // Resolve builtin-relative specifiers (e.g. './loop.mts' from a builtin).
    let state_rc = get_state(scope);
    let builtin_referrer = referrer
        .script_id()
        .and_then(|id| state_rc.borrow().builtin_specifiers.get(&id).copied());
    let spec = if let Some(referrer_spec) = builtin_referrer {
        if let Some(builtin_spec) = resolve_builtin_relative(referrer_spec, &raw_spec) {
            builtin_spec.to_string()
        } else if raw_spec.starts_with("./") || raw_spec.starts_with("../") {
            let msg = v8::String::new(
                scope,
                &format!(
                    "Relative builtin import '{raw_spec}' from '{referrer_spec}' did not match another builtin; use file:// to load disk files"
                ),
            )?;
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return None;
        } else {
            raw_spec
        }
    } else {
        raw_spec
    };

    if spec.starts_with("fino:") || spec.starts_with("internal:") {
        let referrer_is_builtin = match referrer.script_id() {
            None => true,
            Some(id) => state_rc.borrow().builtin_script_ids.contains(&id),
        };
        check_builtin_access(scope, &spec, referrer_is_builtin).ok()?;
        return get_or_load_builtin(scope, &spec);
    }

    let referrer_dir = referrer
        .script_id()
        .and_then(|id| state_rc.borrow().module_paths.get(&id).cloned())
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    let path = resolve_fs_specifier(scope, &spec, referrer_dir.as_deref())?;
    get_or_load_fs_module(scope, &path)
}

// ---------------------------------------------------------------------------
// import.meta callback (registered on the isolate)
// ---------------------------------------------------------------------------

pub unsafe extern "C" fn init_import_meta_callback(
    context: v8::Local<v8::Context>,
    module: v8::Local<v8::Module>,
    meta: v8::Local<v8::Object>,
) {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    let state_rc = get_state(scope);

    let path = {
        let st = state_rc.borrow();
        module
            .script_id()
            .and_then(|id| st.module_paths.get(&id).cloned())
    };
    let Some(path) = path else { return };

    // Delegate to JS callback if registered.
    let init_meta_fn = state_rc
        .borrow()
        .init_meta_fn
        .as_ref()
        .map(|f| v8::Local::new(scope, f));

    if let Some(func) = init_meta_fn {
        let root = state_rc.borrow().process_env.root.clone();
        let Some(filename_val) = v8::String::new(scope, &path.to_string_lossy())
            .map(|s| -> v8::Local<v8::Value> { s.into() })
        else {
            return;
        };
        let Some(root_val) = v8::String::new(scope, &root.to_string_lossy())
            .map(|s| -> v8::Local<v8::Value> { s.into() })
        else {
            return;
        };
        let this = v8::undefined(scope).into();
        let _ = func.call(scope, this, &[meta.into(), filename_val, root_val]);
        return;
    }

    // Rust fallback (before internal:loader registers its callback).
    let filename = path.to_string_lossy();
    let url = format!("file://{filename}");

    if let Some(url_str) = v8::String::new(scope, &url) {
        let key = v8::String::new(scope, "url").unwrap();
        meta.set(scope, key.into(), url_str.into());
    }
    if let Some(fname_str) = v8::String::new(scope, filename.as_ref()) {
        let key = v8::String::new(scope, "filename").unwrap();
        meta.set(scope, key.into(), fname_str.into());
    }
    if let Some(dir) = path.parent() {
        let dirname = dir.to_string_lossy();
        if let Some(dir_str) = v8::String::new(scope, dirname.as_ref()) {
            let key = v8::String::new(scope, "dirname").unwrap();
            meta.set(scope, key.into(), dir_str.into());
        }
    }

    // import.meta.resolve(specifier) — stores base_dir and root in data array.
    let base_dir = path.parent().unwrap_or(&path).to_path_buf();
    let root = state_rc.borrow().process_env.root.clone();
    if let (Some(base_str), Some(root_str)) = (
        v8::String::new(scope, &base_dir.to_string_lossy()),
        v8::String::new(scope, &root.to_string_lossy()),
    ) {
        let data_arr = v8::Array::new(scope, 2);
        data_arr.set_index(scope, 0, base_str.into());
        data_arr.set_index(scope, 1, root_str.into());
        let resolve_tmpl = v8::FunctionTemplate::builder(meta_resolve)
            .data(data_arr.into())
            .build(scope);
        if let Some(resolve_fn) = resolve_tmpl.get_function(scope) {
            let key = v8::String::new(scope, "resolve").unwrap();
            meta.set(scope, key.into(), resolve_fn.into());
        }
    }
}

fn meta_resolve(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let data = args.data();
    let Ok(arr) = v8::Local::<v8::Array>::try_from(data) else {
        return;
    };
    let base_dir = arr
        .get_index(scope, 0)
        .and_then(|v| v.to_string(scope))
        .map(|s| PathBuf::from(s.to_rust_string_lossy(scope)))
        .unwrap_or_default();
    let root = arr
        .get_index(scope, 1)
        .and_then(|v| v.to_string(scope))
        .map(|s| PathBuf::from(s.to_rust_string_lossy(scope)))
        .unwrap_or_default();

    let spec_val: v8::Local<v8::Value> = args.get(0);
    let spec = spec_val
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default();

    if spec.starts_with("fino:") || spec.starts_with("internal:") {
        if let Some(s) = v8::String::new(scope, &spec) {
            rv.set(s.into());
        }
        return;
    }

    let raw = if spec.starts_with("./") || spec.starts_with("../") {
        base_dir.join(&spec)
    } else if spec.starts_with('/') {
        PathBuf::from(&spec)
    } else {
        root.join(&spec)
    };

    match raw.canonicalize() {
        Ok(canonical) => {
            let url = format!("file://{}", canonical.to_string_lossy());
            if let Some(s) = v8::String::new(scope, &url) {
                rv.set(s.into());
            }
        }
        Err(e) => {
            let msg = format!("Cannot resolve '{spec}': {e}");
            if let Some(msg_str) = v8::String::new(scope, &msg) {
                let exc = v8::Exception::error(scope, msg_str);
                scope.throw_exception(exc);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dynamic import callback
// ---------------------------------------------------------------------------

pub fn dynamic_import_callback<'s>(
    scope: &mut v8::HandleScope<'s>,
    host_defined_options: v8::Local<'s, v8::Data>,
    resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::String>,
    _import_attrs: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let promise = resolver.get_promise(scope);
    let raw_spec = specifier.to_rust_string_lossy(scope);
    let referrer_url = referrer_from_hdo(scope, host_defined_options, resource_name);
    let referrer_is_user_code = referrer_url.starts_with("file://");

    // Resolve builtin-relative specifiers (e.g. './loop.mts' from a builtin).
    let builtin_spec = if referrer_is_user_code {
        None
    } else {
        resolve_builtin_relative(&referrer_url, &raw_spec)
    };
    let spec = if let Some(spec) = builtin_spec {
        spec.to_string()
    } else if !referrer_is_user_code && (raw_spec.starts_with("./") || raw_spec.starts_with("../"))
    {
        let msg = v8::String::new(
            scope,
            &format!(
                "Relative builtin import '{raw_spec}' from '{referrer_url}' did not match another builtin; use file:// to load disk files"
            ),
        )?;
        let exc = v8::Exception::error(scope, msg);
        resolver.reject(scope, exc);
        return Some(promise);
    } else {
        raw_spec
    };

    // Derive the referrer's directory for relative-path resolution.
    let referrer_dir: Option<PathBuf> = if referrer_is_user_code {
        PathBuf::from(&referrer_url["file://".len()..])
            .parent()
            .map(|p| p.to_path_buf())
    } else {
        None
    };

    let tc = &mut v8::TryCatch::new(scope);

    let module: Option<v8::Local<v8::Module>> =
        if spec.starts_with("fino:") || spec.starts_with("internal:") {
            if check_builtin_access(tc, &spec, !referrer_is_user_code).is_err() {
                None
            } else {
                get_or_load_builtin(tc, &spec)
            }
        } else {
            resolve_fs_specifier(tc, &spec, referrer_dir.as_deref())
                .and_then(|p| get_or_load_fs_module(tc, &p))
        };

    settle_dynamic_import(tc, module, resolver);
    Some(promise)
}

/// Called when a TLA module's evaluation Promise fulfills (all top-level awaits done).
/// Resolves the dynamic-import Promise with the module namespace.
fn tla_fulfill_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.data().integer_value(scope).unwrap_or(-1) as u32;
    let state_rc = get_state(scope);
    let entry = {
        let mut st = state_rc.borrow_mut();
        st.tla_resolvers.get_mut(id as usize).and_then(|e| e.take())
    };
    if let Some((resolver_global, namespace_global)) = entry {
        let resolver = v8::Local::new(scope, &resolver_global);
        let namespace = v8::Local::new(scope, &namespace_global);
        resolver.resolve(scope, namespace);
    }
}

/// Called when a TLA module's evaluation Promise rejects.
/// Rejects the dynamic-import Promise with the rejection reason.
fn tla_reject_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.data().integer_value(scope).unwrap_or(-1) as u32;
    let state_rc = get_state(scope);
    let entry = {
        let mut st = state_rc.borrow_mut();
        st.tla_resolvers.get_mut(id as usize).and_then(|e| e.take())
    };
    if let Some((resolver_global, _namespace_global)) = entry {
        let resolver = v8::Local::new(scope, &resolver_global);
        let reason = args.get(0);
        resolver.reject(scope, reason);
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Extract the referrer URL from `host_defined_options[0]`.
///
/// `compile_source_module` stores the resource name there as a canonical
/// embedder-controlled identifier. Falls back to `resource_name` for any code
/// compiled outside our loader (e.g. eval, snapshots).
///
/// # Safety
/// V8 always provides a valid `PrimitiveArray` for `host_defined_options` —
/// either the one we set or an empty default — so the unchecked cast is safe
/// and the length check guards the `get()` call.
fn referrer_from_hdo(
    scope: &mut v8::HandleScope,
    hdo: v8::Local<v8::Data>,
    resource_name: v8::Local<v8::Value>,
) -> String {
    let arr = unsafe { v8::Local::<v8::PrimitiveArray>::cast_unchecked(hdo) };
    if arr.length() > 0 {
        arr.get(scope, 0)
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default()
    } else {
        resource_name
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_default()
    }
}

/// Enforce `internal:*` import restrictions and per-Realm blocked providers.
///
/// Returns `Err(())` (with an exception thrown on `scope`) if access is denied.
fn check_builtin_access(
    scope: &mut v8::HandleScope,
    spec: &str,
    referrer_is_builtin: bool,
) -> Result<(), ()> {
    if referrer_is_builtin {
        return Ok(());
    }
    if spec.starts_with("internal:") {
        let msg = v8::String::new(scope, &format!("Cannot import internal module '{spec}' from user code"))
            .ok_or(())?;
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return Err(());
    }
    let is_blocked = {
        let state_rc = get_state(scope);
        state_rc.borrow().providers.get(spec).is_some_and(|v| v.is_none())
    };
    if is_blocked {
        let msg = v8::String::new(scope, &format!("Import of '{spec}' is blocked in this Realm"))
            .ok_or(())?;
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return Err(());
    }
    Ok(())
}

/// Resolve a filesystem specifier to an absolute `PathBuf`.
///
/// Delegates to the JS `resolve_fn` callback if one has been registered by
/// `internal:loader`, otherwise falls back to the Rust `resolve_path` helper.
fn resolve_fs_specifier(
    scope: &mut v8::HandleScope,
    spec: &str,
    referrer_dir: Option<&Path>,
) -> Option<PathBuf> {
    let state_rc = get_state(scope);
    let (resolve_fn, root) = {
        let st = state_rc.borrow();
        let resolve_fn = st.resolve_fn.as_ref().map(|f| v8::Local::new(scope, f));
        let root = st.process_env.root.clone();
        (resolve_fn, root)
    };

    if let Some(func) = resolve_fn {
        let root_str = v8::String::new(scope, &root.to_string_lossy())?;
        let spec_val: v8::Local<v8::Value> = v8::String::new(scope, spec)?.into();
        let this = v8::undefined(scope).into();
        let dir_val: v8::Local<v8::Value> = referrer_dir
            .and_then(|d| v8::String::new(scope, &d.to_string_lossy()))
            .map(|s| s.into())
            .unwrap_or_else(|| v8::null(scope).into());
        func.call(scope, this, &[spec_val, dir_val, root_str.into()])
            .and_then(|r| r.to_string(scope))
            .map(|s| PathBuf::from(s.to_rust_string_lossy(scope)))
    } else {
        match resolve_path(spec, referrer_dir, &root) {
            Ok(p) => Some(p),
            Err(e) => {
                if let Some(msg) = v8::String::new(scope, &e) {
                    let exc = v8::Exception::error(scope, msg);
                    scope.throw_exception(exc);
                }
                None
            }
        }
    }
}

/// Instantiate, evaluate, and settle a dynamic-import promise resolver.
///
/// Handles TLA by storing the resolver in `tla_resolvers` and chaining
/// `.then2()` on the eval promise; non-TLA modules resolve immediately.
fn settle_dynamic_import<'s, 'tc>(
    tc: &mut v8::TryCatch<'tc, v8::HandleScope<'s>>,
    module: Option<v8::Local<'s, v8::Module>>,
    resolver: v8::Local<'s, v8::PromiseResolver>,
) {
    if let Some(m) = module {
        match instantiate_and_evaluate(tc, m) {
            Some(eval_result) if !tc.has_caught() => {
                let namespace = m.get_module_namespace();
                if let Ok(eval_promise) = v8::Local::<v8::Promise>::try_from(eval_result) {
                    // TLA: defer resolution until the eval Promise settles.
                    let state_rc = get_state(tc);
                    let id = {
                        let mut st = state_rc.borrow_mut();
                        let id = st.tla_resolvers.len() as u32;
                        st.tla_resolvers.push(Some((
                            v8::Global::new(tc, resolver),
                            v8::Global::new(tc, namespace),
                        )));
                        id
                    };
                    let id_val: v8::Local<v8::Value> = v8::Integer::new(tc, id as i32).into();
                    let fulfill_tmpl = v8::FunctionTemplate::builder(tla_fulfill_callback)
                        .data(id_val)
                        .build(tc);
                    let reject_tmpl = v8::FunctionTemplate::builder(tla_reject_callback)
                        .data(id_val)
                        .build(tc);
                    if let (Some(fulfill_fn), Some(reject_fn)) =
                        (fulfill_tmpl.get_function(tc), reject_tmpl.get_function(tc))
                    {
                        eval_promise.then2(tc, fulfill_fn, reject_fn);
                    }
                    // Don't resolve yet — the callbacks will settle the resolver.
                } else {
                    // Non-TLA: resolve immediately.
                    resolver.resolve(tc, namespace);
                }
            }
            _ => {
                let exc = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                resolver.reject(tc, exc);
            }
        }
    } else {
        let exc = if tc.has_caught() {
            tc.exception().unwrap_or_else(|| v8::undefined(tc).into())
        } else {
            v8::String::new(tc, "dynamic import failed")
                .map(|s| -> v8::Local<v8::Value> { s.into() })
                .unwrap_or_else(|| v8::undefined(tc).into())
        };
        resolver.reject(tc, exc);
    }
}

fn get_or_load_builtin<'s>(
    scope: &mut v8::HandleScope<'s>,
    spec: &str,
) -> Option<v8::Local<'s, v8::Module>> {
    let state_rc = get_state(scope);

    // 1. Check cache.
    let cached = {
        let st = state_rc.borrow();
        st.builtin_cache.get(spec).map(|m| v8::Local::new(scope, m))
    };
    if let Some(m) = cached {
        return Some(m);
    }

    // 2. Check per-Realm provider configuration before falling back to BUILTINS.
    //    Some(Some(config)) = use this source. Some(None) = blocked (already
    //    checked in the resolve callback for user code; builtins can't reach here
    //    for blocked specifiers either since they bypass the blocked check).
    let provider_source = {
        let st = state_rc.borrow();
        st.providers
            .get(spec)
            .and_then(|v| v.as_ref())
            .map(|o| (o.code.clone(), o.source_map.clone()))
    };

    if let Some((code, source_map)) = provider_source {
        register_source_map_from_json(scope, spec, &source_map);
        let m = compile_source_module(scope, &code, spec, Some(&source_map))?;
        if let Some(id) = m.script_id() {
            // Register as a builtin script so internal: access checks pass.
            state_rc.borrow_mut().builtin_script_ids.insert(id);
            // Note: we do NOT insert into builtin_specifiers here because we
            // have no &'static str for an override specifier. This means
            // override modules cannot use relative imports to other builtins,
            // which is intentional — they should use absolute specifiers.
        }
        let global = v8::Global::new(scope, m);
        state_rc
            .borrow_mut()
            .builtin_cache
            .insert(spec.to_string(), global);
        return Some(m);
    }

    // 3. Fall back to the static BUILTINS registry.
    let entry = BUILTINS.iter().find(|(s, _)| *s == spec)?;
    let (spec_key, kind) = entry;

    let module = match kind {
        BuiltinKind::Source { code, source_map } => {
            register_source_map_from_json(scope, spec, source_map);
            let m = compile_source_module(scope, code, spec, Some(source_map))?;
            if let Some(id) = m.script_id() {
                let mut st = state_rc.borrow_mut();
                st.builtin_script_ids.insert(id);
                st.builtin_specifiers.insert(id, spec_key);
            }
            m
        }
        BuiltinKind::Synthetic(factory) => factory(scope),
    };

    let global = v8::Global::new(scope, module);
    state_rc
        .borrow_mut()
        .builtin_cache
        .insert(spec_key.to_string(), global);
    Some(module)
}

fn get_or_load_fs_module<'s>(
    scope: &mut v8::HandleScope<'s>,
    path: &Path,
) -> Option<v8::Local<'s, v8::Module>> {
    let state_rc = get_state(scope);

    let cached = {
        let st = state_rc.borrow();
        st.fs_cache.get(path).map(|m| v8::Local::new(scope, m))
    };
    if let Some(m) = cached {
        return Some(m);
    }

    let module = load_fs_module_uncached(scope, path)?;

    if let Some(id) = module.script_id() {
        state_rc
            .borrow_mut()
            .module_paths
            .insert(id, path.to_path_buf());
    }

    let global = v8::Global::new(scope, module);
    state_rc
        .borrow_mut()
        .fs_cache
        .insert(path.to_path_buf(), global);
    Some(module)
}

fn load_fs_module_uncached<'s>(
    scope: &mut v8::HandleScope<'s>,
    path: &Path,
) -> Option<v8::Local<'s, v8::Module>> {
    let resource_name = format!("file://{}", path.to_string_lossy());
    let text = std::fs::read_to_string(path).ok()?;

    if is_json(path) {
        let escaped = escape_js_string(&text);
        let src = format!("export default JSON.parse('{escaped}');");
        compile_source_module(scope, &src, &resource_name, None)
    } else if is_typescript(path) {
        let stripped = strip_types(path, &text).ok()?;
        register_source_map(scope, &resource_name, stripped.map.clone());
        compile_source_module(
            scope,
            &stripped.code,
            &resource_name,
            Some(stripped.map.to_json_string().as_str()),
        )
    } else {
        compile_source_module(scope, &text, &resource_name, None)
    }
}

/// Compile a JS string as a V8 ES module with the given resource name (URL).
///
/// Stores `resource_name` in V8's host-defined options (`PrimitiveArray[0]`)
/// so the dynamic-import callback can reliably identify the referrer
/// regardless of how the code was invoked (module, eval, etc.).
pub fn compile_source_module<'s>(
    scope: &mut v8::HandleScope<'s>,
    source_text: &str,
    resource_name: &str,
    source_map_json: Option<&str>,
) -> Option<v8::Local<'s, v8::Module>> {
    let name = v8::String::new(scope, resource_name)?;
    let source_map_url = source_map_json
        .and_then(|json| SourceMap::from_json_string(json).ok())
        .and_then(|map| v8::String::new(scope, &map.to_data_url()))
        .map(|value| value.into());
    let hdo = v8::PrimitiveArray::new(scope, 1);
    hdo.set(scope, 0, name.into());
    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        -1,
        source_map_url,
        false,
        false,
        true,
        Some(hdo.into()),
    );
    let source_str = v8::String::new(scope, source_text)?;
    let mut source = v8::script_compiler::Source::new(source_str, Some(&origin));
    v8::script_compiler::compile_module(scope, &mut source)
}

pub fn register_source_map(scope: &mut v8::HandleScope, resource_name: &str, map: SourceMap) {
    get_state(scope).borrow_mut().source_maps.insert(
        resource_name.to_string(),
        crate::state::SourceMapCache::new(map),
    );
}

pub fn register_source_map_from_json(
    scope: &mut v8::HandleScope,
    resource_name: &str,
    source_map_json: &str,
) {
    if let Ok(map) = SourceMap::from_json_string(source_map_json) {
        register_source_map(scope, resource_name, map);
    }
}

/// Register a module's script_id as a builtin so `internal:*` imports are
/// allowed from it.
pub fn register_as_builtin(
    scope: &mut v8::HandleScope,
    module: v8::Local<v8::Module>,
    spec: &'static str,
) {
    if let Some(id) = module.script_id() {
        let state_rc = get_state(scope);
        let mut st = state_rc.borrow_mut();
        st.builtin_script_ids.insert(id);
        st.builtin_specifiers.insert(id, spec);
    }
}

fn instantiate_and_evaluate<'s>(
    scope: &mut v8::HandleScope<'s>,
    module: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    use v8::ModuleStatus;
    match module.get_status() {
        ModuleStatus::Uninstantiated => {
            module.instantiate_module(scope, resolve_module_callback)?;
            module.evaluate(scope)
        }
        ModuleStatus::Instantiated => module.evaluate(scope),
        ModuleStatus::Evaluated => Some(v8::undefined(scope).into()),
        _ => Some(v8::undefined(scope).into()),
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn resolve_path(
    specifier: &str,
    referrer_dir: Option<&Path>,
    root: &Path,
) -> Result<PathBuf, String> {
    let base = referrer_dir.unwrap_or(root);
    let raw = if specifier.starts_with("./") || specifier.starts_with("../") {
        base.join(specifier)
    } else if let Some(path) = specifier.strip_prefix("file://") {
        PathBuf::from(path)
    } else if specifier.starts_with('/') {
        PathBuf::from(specifier)
    } else {
        root.join(specifier)
    };
    if let Ok(p) = raw.canonicalize() {
        return Ok(p);
    }
    // Extension probing: try TypeScript/JS extensions in order.
    for ext in [".ts", ".mts", ".mjs", ".js", ".json"] {
        let mut probed = raw.as_os_str().to_owned();
        probed.push(ext);
        if let Ok(p) = PathBuf::from(probed).canonicalize() {
            return Ok(p);
        }
    }
    Err(format!(
        "Cannot resolve '{specifier}': No such file or directory"
    ))
}

fn is_typescript(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "mts" | "cts")
    )
}

fn is_json(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

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

struct TranspiledSource {
    code: String,
    map: SourceMap,
}

fn strip_types(path: &Path, source_text: &str) -> Result<TranspiledSource, String> {
    use oxc_allocator::Allocator;
    use oxc_codegen::{Codegen, CodegenOptions};
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

    let generated = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
        .with_source_text(source_text)
        .build(&program);

    Ok(TranspiledSource {
        code: generated.code,
        map: generated.map.expect("source map should be generated"),
    })
}
