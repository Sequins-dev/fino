//! V8 module loader — resolve callback, import.meta hook, dynamic import,
//! and the `internal:loader-hooks` synthetic module.

use std::path::{Component, Path, PathBuf};

use oxc_sourcemap::SourceMap;
use v8;

use crate::{
    async_context, async_runtime_module, ffi, inspector_module, platform, profiler, realm,
    state::ImportDirective, state::ImportPattern, state::ImportRule, state::get_state,
    typescript_format,
};

// ---------------------------------------------------------------------------
// Built-in module registry
// ---------------------------------------------------------------------------

enum BuiltinKind {
    Source {
        code: &'static str,
        source_map: &'static str,
        /// Virtual source path (without extension) used for relative-import
        /// resolution and import.meta.filename. Stored here so the separate
        /// `builtin_source_path` lookup can be derived from BUILTINS directly,
        /// eliminating the duplicate match expression.
        path: &'static str,
    },
    Synthetic(for<'s> fn(&mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module>),
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
const LOOP_BACKEND_SRC: &str =
    include_str!(concat!(env!("OUT_DIR"), "/js/internal/runtime/linux.mjs"));
#[cfg(not(target_os = "macos"))]
const LOOP_BACKEND_MAP: &str = include_str!(concat!(
    env!("OUT_DIR"),
    "/js/internal/runtime/linux.mjs.map"
));

macro_rules! source_builtin {
    ($specifier:literal, $path:literal) => {
        (
            $specifier,
            BuiltinKind::Source {
                code: include_str!(concat!(env!("OUT_DIR"), "/js/", $path, ".mjs")),
                source_map: include_str!(concat!(env!("OUT_DIR"), "/js/", $path, ".mjs.map")),
                path: $path,
            },
        )
    };
}

static BUILTINS: &[BuiltinEntry] = &[
    // Synthetic Rust modules
    (
        "internal:broadcast",
        BuiltinKind::Synthetic(realm::broadcast::create_module),
    ),
    ("fino:ffi", BuiltinKind::Synthetic(ffi::create_module)),
    (
        "internal:serializer",
        BuiltinKind::Synthetic(realm::serializer::create_module),
    ),
    (
        "internal:thread-port",
        BuiltinKind::Synthetic(realm::thread::create_thread_port_module),
    ),
    (
        "internal:transit-port",
        BuiltinKind::Synthetic(realm::transit::create_module),
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
        "internal:synthetic-install",
        BuiltinKind::Synthetic(realm::synthetic::create_install_module),
    ),
    (
        "internal:net-native",
        BuiltinKind::Synthetic(crate::net_native::create_module),
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
        "internal:async-runtime",
        BuiltinKind::Synthetic(async_runtime_module::create_module),
    ),
    (
        "internal:inspector",
        BuiltinKind::Synthetic(inspector_module::create_module),
    ),
    (
        "internal:process-profiler",
        BuiltinKind::Synthetic(profiler::create_process_module),
    ),
    (
        "internal:format/typescript",
        BuiltinKind::Synthetic(typescript_format::create_module),
    ),
    (
        "internal:loader-hooks",
        BuiltinKind::Synthetic(loader_hooks_module),
    ),
    (
        "internal:scheduler-native",
        BuiltinKind::Synthetic(crate::scheduler_native::create_module),
    ),
    source_builtin!("internal:loader", "internal/loader"),
    source_builtin!("internal:bootstrap", "internal/bootstrap"),
    source_builtin!("fino:realm", "realm/index"),
    source_builtin!("fino:module", "module"),
    source_builtin!("fino:realm/self", "realm/self"),
    source_builtin!("fino:realm/messaging", "realm/messaging"),
    source_builtin!("internal:realm/envelope", "internal/realm/envelope"),
    source_builtin!(
        "internal:realm/transport-port",
        "internal/realm/transport-port"
    ),
    source_builtin!("internal:sim/journal", "internal/sim/journal"),
    source_builtin!("internal:globals/messaging", "globals/messaging"),
    // public CLI command tasks, with internal aliases for runtime compatibility
    source_builtin!("fino:commands/root", "commands/root"),
    source_builtin!("fino:commands/test", "commands/test"),
    source_builtin!("fino:commands/coverage", "commands/coverage"),
    source_builtin!("fino:commands/bench", "commands/bench"),
    source_builtin!("fino:commands/load", "commands/load"),
    source_builtin!("fino:commands/run", "commands/run"),
    source_builtin!("fino:commands/install", "commands/install"),
    source_builtin!("fino:commands/init", "commands/init"),
    source_builtin!("fino:commands/doc", "commands/doc"),
    source_builtin!("fino:commands/doc/theme", "commands/doc/theme"),
    source_builtin!("fino:commands/fmt", "commands/fmt"),
    source_builtin!("fino:commands/lint", "commands/lint"),
    source_builtin!("fino:commands/task", "commands/task"),
    source_builtin!("fino:commands/repl", "commands/repl"),
    source_builtin!("internal:commands/root", "commands/root"),
    source_builtin!("internal:commands/test", "commands/test"),
    source_builtin!("internal:commands/coverage", "commands/coverage"),
    source_builtin!("internal:commands/bench", "commands/bench"),
    source_builtin!("internal:commands/load", "commands/load"),
    source_builtin!("internal:commands/run", "commands/run"),
    source_builtin!("internal:commands/install", "commands/install"),
    source_builtin!("internal:commands/init", "commands/init"),
    source_builtin!("internal:commands/doc", "commands/doc"),
    source_builtin!("internal:commands/fmt", "commands/fmt"),
    source_builtin!("internal:commands/lint", "commands/lint"),
    source_builtin!("internal:commands/task", "commands/task"),
    source_builtin!(
        "internal:concurrent-task-channel",
        "internal/concurrent-task-channel"
    ),
    source_builtin!(
        "internal:fixtures/tsx-builtin",
        "internal/fixtures/tsx-builtin"
    ),
    source_builtin!("internal:test-worker", "internal/test-worker"),
    source_builtin!("internal:tooling/files", "internal/tooling/files"),
    source_builtin!("internal:tooling/format", "internal/tooling/format"),
    source_builtin!("internal:tooling/lint", "internal/tooling/lint"),
    source_builtin!("internal:tooling/report", "internal/tooling/report"),
    source_builtin!("internal:bytes", "internal/bytes"),
    source_builtin!("internal:duration", "internal/duration"),
    source_builtin!("internal:process/cwd", "internal/process/cwd"),
    source_builtin!("internal:process/exit", "internal/process/exit"),
    source_builtin!("internal:process/spawn", "internal/process/spawn"),
    source_builtin!("internal:statistics", "internal/statistics"),
    source_builtin!("internal:value/equal", "internal/value/equal"),
    source_builtin!("internal:store/facade", "internal/store/facade"),
    source_builtin!("internal:load", "internal/load"),
    source_builtin!("internal:shutdown", "internal/shutdown"),
    source_builtin!("internal:encoding", "internal/encoding"),
    source_builtin!("internal:package_manager", "internal/package_manager"),
    source_builtin!("internal:repl-handler", "internal/repl/handler"),
    source_builtin!("internal:commands/repl", "commands/repl"),
    source_builtin!("internal:coverage", "internal/coverage"),
    source_builtin!("internal:coverage/model", "internal/coverage/model"),
    // internal: globals (web spec globals)
    source_builtin!("internal:globals/encoding", "globals/encoding"),
    source_builtin!("internal:globals/console", "globals/console"),
    source_builtin!("internal:globals/eventtarget", "globals/eventtarget"),
    source_builtin!("internal:globals/abort", "globals/abort"),
    source_builtin!("internal:globals/blob", "globals/blob"),
    source_builtin!("internal:globals/url", "globals/url"),
    source_builtin!("internal:globals/urlpattern", "globals/urlpattern"),
    source_builtin!("internal:globals/webstreams", "globals/webstreams"),
    source_builtin!("internal:globals/formdata", "globals/formdata"),
    source_builtin!("internal:globals/crypto", "globals/crypto"),
    source_builtin!("internal:globals/time", "globals/time"),
    source_builtin!("internal:globals/fetch", "globals/fetch"),
    source_builtin!("internal:globals/websocket", "globals/websocket"),
    source_builtin!("internal:globals/webtransport", "globals/webtransport"),
    source_builtin!(
        "internal:globals/compression-streams",
        "globals/compression-streams"
    ),
    source_builtin!(
        "internal:globals/broadcast-channel",
        "globals/broadcast-channel"
    ),
    source_builtin!("internal:globals/global", "globals/global"),
    source_builtin!("internal:ui/web/client", "internal/ui/web/client"),
    // internal: compression
    source_builtin!("internal:compress/common", "internal/compress/common"),
    source_builtin!("internal:compress/zlib", "internal/compress/zlib"),
    source_builtin!("internal:compress/brotli", "internal/compress/brotli"),
    source_builtin!("internal:compress/zstd", "internal/compress/zstd"),
    source_builtin!("internal:compress/lz4", "internal/compress/lz4"),
    source_builtin!("internal:compress/snappy", "internal/compress/snappy"),
    // internal: stream and openssl
    source_builtin!("internal:stream", "internal/stream"),
    source_builtin!("fino:stream", "stream"),
    source_builtin!("internal:openssl", "internal/openssl"),
    // sqlite
    source_builtin!(
        "internal:database/sqlite/bindings",
        "internal/database/sqlite/bindings"
    ),
    source_builtin!(
        "internal:database/sqlite/vfs",
        "internal/database/sqlite/vfs"
    ),
    source_builtin!(
        "internal:database/postgres/protocol",
        "internal/database/postgres/protocol"
    ),
    source_builtin!(
        "internal:database/postgres/scram",
        "internal/database/postgres/scram"
    ),
    source_builtin!("fino:database", "database/index"),
    source_builtin!("fino:database/sql", "database/sql"),
    source_builtin!("fino:database/migrate", "database/migrate"),
    source_builtin!("fino:database/postgres", "database/postgres"),
    source_builtin!("fino:database/sqlite", "database/sqlite"),
    // internal: file sub-modules
    source_builtin!("internal:file/provider", "internal/file/provider"),
    source_builtin!("internal:file/constants", "internal/file/constants"),
    source_builtin!("internal:file/bindings", "internal/file/bindings"),
    source_builtin!("internal:file/stat", "internal/file/stat"),
    source_builtin!("internal:file/handle", "internal/file/handle"),
    source_builtin!("internal:file/entry", "internal/file/entry"),
    source_builtin!("internal:file/glob", "internal/file/glob"),
    source_builtin!(
        "internal:file/watch-bindings",
        "internal/file/watch-bindings"
    ),
    // runtime
    source_builtin!("internal:runtime/libc", "internal/runtime/libc"),
    source_builtin!(
        "internal:runtime/output-capture",
        "internal/runtime/output-capture"
    ),
    source_builtin!("internal:parent-rpc", "internal/runtime/parent-rpc"),
    source_builtin!(
        "internal:synthetic-direct",
        "internal/runtime/synthetic-direct"
    ),
    source_builtin!("internal:runtime/kqueue", "internal/runtime/kqueue"),
    source_builtin!("internal:runtime/io_uring", "internal/runtime/io_uring"),
    source_builtin!("internal:runtime/poll", "internal/runtime/poll"),
    source_builtin!("internal:runtime/linux", "internal/runtime/linux"),
    source_builtin!("internal:runtime/clock", "internal/runtime/clock"),
    source_builtin!(
        "internal:runtime/deterministic-effects",
        "internal/runtime/deterministic-effects"
    ),
    source_builtin!("internal:runtime/random", "internal/runtime/random"),
    source_builtin!(
        "internal:runtime/virtual-timers",
        "internal/runtime/virtual-timers"
    ),
    (
        "internal:runtime/loop-backend",
        BuiltinKind::Source {
            code: LOOP_BACKEND_SRC,
            source_map: LOOP_BACKEND_MAP,
            path: "internal/runtime/loop-backend",
        },
    ),
    source_builtin!("internal:runtime/loop", "internal/runtime/loop"),
    source_builtin!("fino:process", "process"),
    source_builtin!("fino:context", "context/index"),
    source_builtin!("fino:signals", "signals"),
    source_builtin!("fino:ui", "ui"),
    source_builtin!("fino:ui/components", "ui/components"),
    source_builtin!("fino:ui/components/html", "ui/components/html"),
    source_builtin!("fino:ui/components/theme", "ui/components/theme"),
    source_builtin!("fino:ui/html", "ui/html"),
    source_builtin!("fino:ui/portable", "ui/portable"),
    source_builtin!("fino:ui/realm", "ui/realm"),
    source_builtin!("fino:ui/web", "ui/web"),
    source_builtin!("fino:ui/web/flow", "ui/web/flow"),
    source_builtin!("fino:ui/web/state", "ui/web/state"),
    source_builtin!("fino:ui/jsx-runtime", "ui/jsx-runtime"),
    source_builtin!("fino:ui/slides", "ui/slides"),
    source_builtin!("fino:tty", "tty"),
    source_builtin!("internal:tty/bindings", "internal/tty/bindings"),
    source_builtin!("fino:tty/style", "tty/style"),
    source_builtin!("fino:tty/frame", "tty/frame"),
    source_builtin!("internal:tty/width", "internal/tty/width"),
    source_builtin!("internal:tty/layout", "internal/tty/layout"),
    source_builtin!("internal:tty/host", "internal/tty/host"),
    source_builtin!("internal:tty/events", "internal/tty/events"),
    source_builtin!("internal:tty/lower", "internal/tty/lower"),
    source_builtin!("internal:tty/vt", "internal/tty/vt"),
    source_builtin!("fino:tty/tui", "tty/tui"),
    source_builtin!(
        "internal:ui/components/html-runtime",
        "ui/components/html-runtime"
    ),
    source_builtin!("internal:ui/components/target", "ui/components/target"),
    source_builtin!("internal:ui/preview", "internal/ui/preview"),
    source_builtin!("internal:ui/components/layout", "ui/components/layout"),
    source_builtin!(
        "internal:ui/components/layout.html",
        "ui/components/layout.html"
    ),
    source_builtin!(
        "internal:ui/components/layout.tui",
        "ui/components/layout.tui"
    ),
    source_builtin!(
        "internal:ui/components/layout.preview",
        "ui/components/layout.preview"
    ),
    source_builtin!(
        "internal:ui/components/typography",
        "ui/components/typography"
    ),
    source_builtin!(
        "internal:ui/components/typography.html",
        "ui/components/typography.html"
    ),
    source_builtin!(
        "internal:ui/components/typography.tui",
        "ui/components/typography.tui"
    ),
    source_builtin!(
        "internal:ui/components/typography.preview",
        "ui/components/typography.preview"
    ),
    source_builtin!("internal:ui/components/icons", "ui/components/icons"),
    source_builtin!(
        "internal:ui/components/icons.html",
        "ui/components/icons.html"
    ),
    source_builtin!(
        "internal:ui/components/icons.tui",
        "ui/components/icons.tui"
    ),
    source_builtin!(
        "internal:ui/components/icons.preview",
        "ui/components/icons.preview"
    ),
    source_builtin!("internal:ui/components/forms", "ui/components/forms"),
    source_builtin!(
        "internal:ui/components/forms.html",
        "ui/components/forms.html"
    ),
    source_builtin!(
        "internal:ui/components/forms.tui",
        "ui/components/forms.tui"
    ),
    source_builtin!(
        "internal:ui/components/forms.preview",
        "ui/components/forms.preview"
    ),
    source_builtin!(
        "internal:ui/components/text-edit",
        "ui/components/text-edit"
    ),
    source_builtin!(
        "internal:ui/components/interaction",
        "ui/components/interaction"
    ),
    source_builtin!(
        "internal:ui/components/disclosure",
        "ui/components/disclosure"
    ),
    source_builtin!(
        "internal:ui/components/disclosure.html",
        "ui/components/disclosure.html"
    ),
    source_builtin!(
        "internal:ui/components/disclosure.tui",
        "ui/components/disclosure.tui"
    ),
    source_builtin!(
        "internal:ui/components/disclosure.preview",
        "ui/components/disclosure.preview"
    ),
    source_builtin!("internal:ui/components/menu", "ui/components/menu"),
    source_builtin!(
        "internal:ui/components/menu.html",
        "ui/components/menu.html"
    ),
    source_builtin!("internal:ui/components/menu.tui", "ui/components/menu.tui"),
    source_builtin!(
        "internal:ui/components/menu.preview",
        "ui/components/menu.preview"
    ),
    source_builtin!(
        "internal:ui/components/navigation",
        "ui/components/navigation"
    ),
    source_builtin!(
        "internal:ui/components/navigation.html",
        "ui/components/navigation.html"
    ),
    source_builtin!(
        "internal:ui/components/navigation.tui",
        "ui/components/navigation.tui"
    ),
    source_builtin!(
        "internal:ui/components/navigation.preview",
        "ui/components/navigation.preview"
    ),
    source_builtin!("internal:ui/components/overlay", "ui/components/overlay"),
    source_builtin!(
        "internal:ui/components/overlay.html",
        "ui/components/overlay.html"
    ),
    source_builtin!(
        "internal:ui/components/overlay.tui",
        "ui/components/overlay.tui"
    ),
    source_builtin!(
        "internal:ui/components/overlay.preview",
        "ui/components/overlay.preview"
    ),
    source_builtin!("internal:ui/components/feedback", "ui/components/feedback"),
    source_builtin!(
        "internal:ui/components/feedback.html",
        "ui/components/feedback.html"
    ),
    source_builtin!(
        "internal:ui/components/feedback.tui",
        "ui/components/feedback.tui"
    ),
    source_builtin!(
        "internal:ui/components/feedback.preview",
        "ui/components/feedback.preview"
    ),
    source_builtin!("internal:ui/components/display", "ui/components/display"),
    source_builtin!(
        "internal:ui/components/display.html",
        "ui/components/display.html"
    ),
    source_builtin!(
        "internal:ui/components/display.tui",
        "ui/components/display.tui"
    ),
    source_builtin!(
        "internal:ui/components/display.preview",
        "ui/components/display.preview"
    ),
    source_builtin!("internal:ui/components/data", "ui/components/data"),
    source_builtin!(
        "internal:ui/components/data.html",
        "ui/components/data.html"
    ),
    source_builtin!("internal:ui/components/data.tui", "ui/components/data.tui"),
    source_builtin!(
        "internal:ui/components/data.preview",
        "ui/components/data.preview"
    ),
    source_builtin!("internal:ui/components/virtual", "ui/components/virtual"),
    source_builtin!(
        "internal:ui/components/virtual.html",
        "ui/components/virtual.html"
    ),
    source_builtin!(
        "internal:ui/components/virtual.tui",
        "ui/components/virtual.tui"
    ),
    source_builtin!(
        "internal:ui/components/virtual.preview",
        "ui/components/virtual.preview"
    ),
    source_builtin!(
        "internal:ui/components/color.tui",
        "ui/components/color.tui"
    ),
    source_builtin!("internal:ui/components/pickers", "ui/components/pickers"),
    source_builtin!(
        "internal:ui/components/pickers.html",
        "ui/components/pickers.html"
    ),
    source_builtin!(
        "internal:ui/components/pickers.tui",
        "ui/components/pickers.tui"
    ),
    source_builtin!(
        "internal:ui/components/pickers.preview",
        "ui/components/pickers.preview"
    ),
    // net
    source_builtin!("internal:net/provider", "internal/net/provider"),
    source_builtin!(
        "internal:net/simulated-provider",
        "internal/net/simulated-provider"
    ),
    source_builtin!("internal:net/dns-provider", "internal/net/dns-provider"),
    source_builtin!("internal:net/dns-wire", "internal/net/dns-wire"),
    source_builtin!("internal:net/dnssec", "internal/net/dnssec"),
    source_builtin!("fino:net/socket", "net/socket"),
    source_builtin!("fino:net/tls", "net/tls"),
    source_builtin!("fino:net/dns", "net/dns"),
    source_builtin!("fino:net/mdns", "net/mdns"),
    source_builtin!("fino:net/http", "net/http"),
    source_builtin!("internal:net/http/wire", "net/http/index"),
    source_builtin!("fino:net/http/app", "net/http/app"),
    source_builtin!("internal:net/http/session", "net/http/session"),
    source_builtin!("internal:net/http/driver", "net/http/driver"),
    source_builtin!("internal:net/http/h1", "net/http/h1"),
    source_builtin!("fino:net/http/client", "net/http/client"),
    source_builtin!("fino:net/http/server", "net/http/server"),
    source_builtin!("internal:net/http/stream", "internal/net/http/stream"),
    source_builtin!(
        "internal:net/http/h2/bindings",
        "internal/net/http/h2/bindings"
    ),
    source_builtin!(
        "internal:net/http/h2/session",
        "internal/net/http/h2/session"
    ),
    source_builtin!("internal:net/http/h2/server", "internal/net/http/h2/server"),
    source_builtin!("internal:net/http/h2/client", "internal/net/http/h2/client"),
    source_builtin!("internal:net/http/h2", "net/http/h2"),
    source_builtin!(
        "internal:net/http/h3/bindings",
        "internal/net/http/h3/bindings"
    ),
    source_builtin!(
        "internal:net/http/h3/session",
        "internal/net/http/h3/session"
    ),
    source_builtin!(
        "internal:net/http/h3/body-queue",
        "internal/net/http/h3/body-queue"
    ),
    source_builtin!("internal:net/http/h3/origin", "internal/net/http/h3/origin"),
    source_builtin!(
        "internal:net/http/h3/resolve",
        "internal/net/http/h3/resolve"
    ),
    source_builtin!(
        "internal:net/http/h3/webtransport",
        "internal/net/http/h3/webtransport"
    ),
    source_builtin!("internal:net/http/h3/server", "internal/net/http/h3/server"),
    source_builtin!("internal:net/http/h3/client", "internal/net/http/h3/client"),
    source_builtin!("internal:net/http/h3", "net/http/h3"),
    source_builtin!("internal:net/http/pool", "internal/net/http/pool"),
    source_builtin!("fino:net/http/eventstream", "net/http/eventstream"),
    source_builtin!("fino:net/http/eventsource", "globals/eventsource"),
    source_builtin!("fino:net/http/websocket", "net/http/websocket"),
    source_builtin!("fino:net/http/webtransport", "net/http/webtransport"),
    source_builtin!(
        "internal:net/quic/ngtcp2/bindings",
        "internal/net/quic/ngtcp2/bindings"
    ),
    source_builtin!(
        "internal:net/quic/ngtcp2/crypto-ossl",
        "internal/net/quic/ngtcp2/crypto-ossl"
    ),
    source_builtin!(
        "internal:net/quic/ngtcp2/crypto-gnutls",
        "internal/net/quic/ngtcp2/crypto-gnutls"
    ),
    source_builtin!(
        "internal:net/quic/ngtcp2/crypto",
        "internal/net/quic/ngtcp2/crypto"
    ),
    source_builtin!("internal:net/quic/core", "internal/net/quic/core"),
    source_builtin!("internal:net/quic/endpoint", "internal/net/quic/endpoint"),
    source_builtin!(
        "internal:net/quic/connection",
        "internal/net/quic/connection"
    ),
    source_builtin!("internal:net/quic/listener", "internal/net/quic/listener"),
    source_builtin!("internal:net/quic/stream", "internal/net/quic/stream"),
    source_builtin!("fino:net/quic/availability", "net/quic/availability"),
    source_builtin!("fino:net/quic/connection", "net/quic/connection"),
    source_builtin!("fino:net/quic/endpoint", "net/quic/endpoint"),
    source_builtin!("fino:net/quic/events", "net/quic/events"),
    source_builtin!("fino:net/quic/listener", "net/quic/listener"),
    source_builtin!("fino:net/quic/stream", "net/quic/stream"),
    source_builtin!("fino:net/quic/types", "net/quic/types"),
    source_builtin!("fino:net/quic", "net/quic/index"),
    // file
    source_builtin!("fino:file", "file/fs"),
    source_builtin!("fino:file/path", "file/path"),
    source_builtin!("fino:file/watch", "file/watch"),
    source_builtin!("fino:file/memory", "file/memory"),
    source_builtin!("fino:archive", "archive"),
    // cluster
    source_builtin!("internal:cluster/protocol", "internal/cluster/protocol"),
    source_builtin!("internal:cluster/transport", "internal/cluster/transport"),
    source_builtin!(
        "internal:cluster/webtransport-framing",
        "internal/cluster/webtransport-framing"
    ),
    source_builtin!(
        "internal:cluster/webtransport-transport",
        "internal/cluster/webtransport-transport"
    ),
    source_builtin!("internal:cluster/registry", "internal/cluster/registry"),
    source_builtin!("internal:cluster/seed", "internal/cluster/seed"),
    source_builtin!("internal:cluster/client", "internal/cluster/client"),
    source_builtin!("fino:cluster", "cluster"),
    source_builtin!("internal:opentelemetry/core", "internal/opentelemetry/core"),
    source_builtin!(
        "internal:opentelemetry/common",
        "internal/opentelemetry/common"
    ),
    source_builtin!(
        "internal:opentelemetry/traces",
        "internal/opentelemetry/traces"
    ),
    source_builtin!("internal:opentelemetry/logs", "internal/opentelemetry/logs"),
    source_builtin!(
        "internal:opentelemetry/metrics",
        "internal/opentelemetry/metrics"
    ),
    source_builtin!(
        "internal:opentelemetry/exporters",
        "internal/opentelemetry/exporters"
    ),
    source_builtin!(
        "internal:opentelemetry/bootstrap",
        "internal/opentelemetry/bootstrap"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/index",
        "internal/opentelemetry/instrumentations/index"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/http-server",
        "internal/opentelemetry/instrumentations/http-server"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/fetch",
        "internal/opentelemetry/instrumentations/fetch"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/trace-topic",
        "internal/opentelemetry/instrumentations/trace-topic"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/_runtime-client",
        "internal/opentelemetry/instrumentations/_runtime-client"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/dns",
        "internal/opentelemetry/instrumentations/dns"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/socket",
        "internal/opentelemetry/instrumentations/socket"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/tls",
        "internal/opentelemetry/instrumentations/tls"
    ),
    source_builtin!(
        "internal:opentelemetry/instrumentations/jobs",
        "internal/opentelemetry/instrumentations/jobs"
    ),
    source_builtin!("internal:opentelemetry/sdk", "internal/opentelemetry/sdk"),
    source_builtin!("fino:opentelemetry", "opentelemetry"),
    source_builtin!("fino:opentelemetry/traces", "opentelemetry/traces"),
    source_builtin!("fino:opentelemetry/metrics", "opentelemetry/metrics"),
    source_builtin!("fino:opentelemetry/logs", "opentelemetry/logs"),
    source_builtin!("fino:opentelemetry/sdk", "opentelemetry/sdk"),
    source_builtin!("fino:parsing/scanner", "parsing/scanner"),
    source_builtin!("fino:semver", "semver"),
    source_builtin!("fino:uuid", "uuid"),
    source_builtin!("fino:format/markdown", "format/markdown"),
    source_builtin!("fino:format/mdx", "format/mdx"),
    source_builtin!("fino:template", "template"),
    source_builtin!("fino:log", "log"),
    source_builtin!("fino:validate", "validate"),
    source_builtin!("fino:config", "config"),
    source_builtin!("fino:webhooks", "webhooks"),
    source_builtin!("fino:store", "store"),
    source_builtin!("fino:cache", "cache"),
    source_builtin!("fino:storage", "storage"),
    source_builtin!("fino:email", "email"),
    source_builtin!("internal:security/encoding", "internal/security/encoding"),
    // Child-process sandbox: self-sandboxing launcher and its supporting modules.
    source_builtin!(
        "internal:security/sandbox/ffi",
        "internal/security/sandbox/ffi"
    ),
    source_builtin!(
        "internal:security/sandbox/frame",
        "internal/security/sandbox/frame"
    ),
    source_builtin!(
        "internal:security/sandbox/cgroup",
        "internal/security/sandbox/cgroup"
    ),
    source_builtin!(
        "internal:security/sandbox/plan",
        "internal/security/sandbox/plan"
    ),
    source_builtin!(
        "internal:security/sandbox/seccomp",
        "internal/security/sandbox/seccomp"
    ),
    source_builtin!(
        "internal:security/sandbox/landlock",
        "internal/security/sandbox/landlock"
    ),
    source_builtin!(
        "internal:security/sandbox/rlimit",
        "internal/security/sandbox/rlimit"
    ),
    source_builtin!(
        "internal:security/sandbox/seatbelt",
        "internal/security/sandbox/seatbelt"
    ),
    source_builtin!(
        "internal:security/sandbox/report",
        "internal/security/sandbox/report"
    ),
    source_builtin!(
        "internal:security/sandbox/launcher",
        "internal/security/sandbox/launcher"
    ),
    source_builtin!(
        "internal:security/sandbox/spawn",
        "internal/security/sandbox/spawn"
    ),
    source_builtin!(
        "internal:security/sandbox/realm",
        "internal/security/sandbox/realm"
    ),
    source_builtin!("fino:security", "security/index"),
    source_builtin!("fino:security/random", "security/random"),
    source_builtin!("fino:security/headers", "security/headers"),
    source_builtin!("fino:security/cors", "security/cors"),
    source_builtin!("fino:security/cookie", "security/cookie"),
    source_builtin!("fino:security/token", "security/token"),
    source_builtin!("fino:security/password", "security/password"),
    source_builtin!("fino:security/jwk", "security/jwk"),
    source_builtin!("fino:security/jwt", "security/jwt"),
    source_builtin!("fino:security/oauth", "security/oauth"),
    // format
    source_builtin!("fino:data", "data"),
    source_builtin!("fino:data/arrow", "data/arrow/index"),
    source_builtin!("internal:data/arrow/errors", "data/arrow/errors"),
    source_builtin!("internal:data/arrow/type", "data/arrow/type"),
    source_builtin!("internal:data/arrow/schema", "data/arrow/schema"),
    source_builtin!("internal:data/arrow/vector", "data/arrow/vector"),
    source_builtin!("internal:data/arrow/batch", "data/arrow/batch"),
    source_builtin!("internal:data/arrow/table", "data/arrow/table"),
    source_builtin!(
        "internal:data/arrow/ipc/metadata",
        "data/arrow/ipc/metadata"
    ),
    source_builtin!("internal:data/arrow/ipc/writer", "data/arrow/ipc/writer"),
    source_builtin!("internal:data/arrow/ipc/reader", "data/arrow/ipc/reader"),
    source_builtin!("fino:data/arrow/cdata", "data/arrow/cdata"),
    source_builtin!("fino:data/dataset", "data/dataset"),
    source_builtin!("fino:data/frame", "data/frame"),
    source_builtin!("fino:data/parquet", "data/parquet/index"),
    source_builtin!("internal:data/parquet/types", "data/parquet/types"),
    source_builtin!("internal:data/parquet/metadata", "data/parquet/metadata"),
    source_builtin!("internal:data/parquet/schema", "data/parquet/schema"),
    source_builtin!("internal:data/parquet/nested", "data/parquet/nested"),
    source_builtin!("internal:data/parquet/convert", "data/parquet/convert"),
    source_builtin!("internal:data/parquet/levels", "data/parquet/levels"),
    source_builtin!("internal:data/parquet/encoding", "data/parquet/encoding"),
    source_builtin!("internal:data/parquet/delta", "data/parquet/delta"),
    source_builtin!(
        "internal:data/parquet/compression",
        "data/parquet/compression"
    ),
    source_builtin!(
        "internal:data/parquet/column-reader",
        "data/parquet/column-reader"
    ),
    source_builtin!("internal:data/parquet/reader", "data/parquet/reader"),
    source_builtin!("internal:data/parquet/writer", "data/parquet/writer"),
    // ml
    source_builtin!("fino:ml/metrics", "ml/metrics/index"),
    source_builtin!("internal:ml/metrics/shared", "ml/metrics/shared"),
    source_builtin!("internal:ml/metrics/confusion", "ml/metrics/confusion"),
    source_builtin!(
        "internal:ml/metrics/classification",
        "ml/metrics/classification"
    ),
    source_builtin!("internal:ml/metrics/regression", "ml/metrics/regression"),
    source_builtin!("internal:ml/metrics/ranking", "ml/metrics/ranking"),
    source_builtin!("internal:ml/metrics/calibration", "ml/metrics/calibration"),
    source_builtin!("internal:ml/metrics/similarity", "ml/metrics/similarity"),
    source_builtin!("internal:ml/metrics/streaming", "ml/metrics/streaming"),
    source_builtin!("fino:model/hub", "model/hub"),
    source_builtin!("internal:model/hub/cache", "internal/model/hub/cache"),
    source_builtin!("internal:model/hub/lockfile", "internal/model/hub/lockfile"),
    source_builtin!("internal:model/hub/download", "internal/model/hub/download"),
    source_builtin!("fino:text/tokenizer", "text/tokenizer"),
    source_builtin!(
        "internal:text/tokenizer/normalized",
        "internal/text/tokenizer/normalized"
    ),
    source_builtin!(
        "internal:text/tokenizer/types",
        "internal/text/tokenizer/types"
    ),
    source_builtin!(
        "internal:text/tokenizer/bytes",
        "internal/text/tokenizer/bytes"
    ),
    source_builtin!(
        "internal:text/tokenizer/normalizers",
        "internal/text/tokenizer/normalizers"
    ),
    source_builtin!(
        "internal:text/tokenizer/pre-tokenizers",
        "internal/text/tokenizer/pre-tokenizers"
    ),
    source_builtin!(
        "internal:text/tokenizer/models",
        "internal/text/tokenizer/models"
    ),
    source_builtin!(
        "internal:text/tokenizer/post-processors",
        "internal/text/tokenizer/post-processors"
    ),
    source_builtin!(
        "internal:text/tokenizer/decoders",
        "internal/text/tokenizer/decoders"
    ),
    source_builtin!(
        "internal:text/tokenizer/added-tokens",
        "internal/text/tokenizer/added-tokens"
    ),
    source_builtin!(
        "internal:text/tokenizer/tiktoken",
        "internal/text/tokenizer/tiktoken"
    ),
    source_builtin!("fino:format/csv", "format/csv"),
    source_builtin!("fino:format/flatbuffers", "format/flatbuffers"),
    source_builtin!("fino:format/protobuf", "format/protobuf"),
    source_builtin!("internal:format/thrift", "internal/format/thrift/index"),
    source_builtin!(
        "internal:format/thrift/types",
        "internal/format/thrift/types"
    ),
    source_builtin!("internal:format/thrift/io", "internal/format/thrift/io"),
    source_builtin!(
        "internal:format/thrift/protocol",
        "internal/format/thrift/protocol"
    ),
    source_builtin!(
        "internal:format/thrift/binary",
        "internal/format/thrift/binary"
    ),
    source_builtin!(
        "internal:format/thrift/compact",
        "internal/format/thrift/compact"
    ),
    source_builtin!("internal:format/thrift/json", "internal/format/thrift/json"),
    source_builtin!(
        "internal:format/thrift/value",
        "internal/format/thrift/value"
    ),
    source_builtin!("fino:format/typescript", "format/typescript"),
    source_builtin!("fino:format/toml", "format/toml"),
    source_builtin!("fino:format/xml", "format/xml"),
    source_builtin!("fino:format/yaml", "format/yaml"),
    // test
    source_builtin!("fino:test/assert", "test/assert"),
    source_builtin!("fino:test/test", "test/test"),
    source_builtin!("fino:test/bench", "test/bench"),
    source_builtin!("fino:test/pty", "test/pty"),
    source_builtin!("fino:bench", "test/bench"),
    source_builtin!("fino:test/mock", "test/mock"),
    // util
    source_builtin!("fino:compress", "compress"),
    source_builtin!("fino:process/argv", "process/argv"),
    source_builtin!("fino:tty/prompt", "tty/prompt"),
    source_builtin!("fino:context/topic", "context/topic"),
    source_builtin!("fino:jsonrpc", "jsonrpc"),
    source_builtin!("fino:workflow", "workflow"),
    source_builtin!("fino:task", "task"),
    source_builtin!("fino:task/durable", "task/durable"),
    source_builtin!("fino:load", "load"),
    // orchestrator + jobs
    source_builtin!("internal:orchestrator", "internal/orchestrator/index"),
    source_builtin!(
        "internal:scheduler/bootstrap",
        "internal/scheduler/bootstrap"
    ),
    source_builtin!("internal:scheduler/reactor", "internal/scheduler/reactor"),
    source_builtin!(
        "internal:scheduler/readiness",
        "internal/scheduler/readiness"
    ),
    source_builtin!("internal:jobs/cron", "internal/jobs/cron"),
    source_builtin!("internal:jobs/store", "internal/jobs/store"),
    source_builtin!("internal:jobs/runner", "internal/jobs/runner"),
    source_builtin!("internal:jobs/service", "internal/jobs/service"),
    source_builtin!("internal:jobs/control", "internal/jobs/control"),
    source_builtin!("fino:jobs", "jobs"),
    // ai
    source_builtin!("fino:ai", "ai"),
    source_builtin!("fino:ai/model", "ai/model"),
    source_builtin!("fino:ai/model/anthropic", "ai/model/anthropic"),
    source_builtin!("fino:ai/model/local", "ai/model/local"),
    source_builtin!("fino:ai/model/openai", "ai/model/openai"),
    source_builtin!("fino:ai/context", "ai/context"),
    source_builtin!("fino:ai/tool", "ai/tool"),
    source_builtin!("fino:ai/runtime", "ai/runtime"),
    source_builtin!("fino:ai/budget", "ai/budget"),
    source_builtin!("fino:ai/gateway", "ai/gateway"),
    source_builtin!("fino:ai/sandbox", "ai/sandbox"),
    source_builtin!("fino:ai/cache", "ai/cache"),
    source_builtin!("fino:ai/agent", "ai/agent"),
    source_builtin!("fino:ai/memory", "ai/memory"),
    source_builtin!("fino:ai/session", "ai/session"),
    source_builtin!("fino:ai/skill", "ai/skill"),
    source_builtin!("fino:ai/eval", "ai/eval"),
    source_builtin!("fino:ai/mcp", "ai/mcp"),
    source_builtin!("fino:ai/acp", "ai/acp"),
    source_builtin!("internal:ai/acp/client", "ai/acp/client"),
    source_builtin!("internal:ai/acp/codec", "ai/acp/codec"),
    source_builtin!("internal:ai/acp/schema", "ai/acp/schema"),
    source_builtin!("internal:ai/acp/server", "ai/acp/server"),
    source_builtin!("internal:ai/acp/storage", "ai/acp/storage"),
    source_builtin!("internal:ai/acp/transport", "ai/acp/transport"),
    source_builtin!("internal:ai/shared", "ai/shared"),
    source_builtin!("internal:ai/runtime", "ai/runtime-internal"),
    source_builtin!("internal:ai/model/anthropic", "ai/model/anthropic"),
    source_builtin!("internal:ai/model/local", "ai/model/local"),
    source_builtin!("internal:ai/model/openai", "ai/model/openai"),
    // profiler
    (
        "fino:profiler",
        BuiltinKind::Synthetic(profiler::create_module),
    ),
];

/// Specifier → virtual source path lookup, derived from the BUILTINS table.
///
/// Previously maintained as a parallel `match` expression; now built once at
/// startup from the `path` field on `BuiltinKind::Source` entries. A handful
/// of specifiers registered outside the BUILTINS slice are handled explicitly.
fn builtin_source_path(spec: &str) -> Option<&'static str> {
    use std::sync::OnceLock;
    static MAP: OnceLock<std::collections::HashMap<&'static str, &'static str>> = OnceLock::new();
    let map = MAP.get_or_init(|| {
        let mut m = std::collections::HashMap::new();
        // Entries registered outside the BUILTINS slice (e.g. internal/main.mjs
        // compiled inline in runtime.rs and re-registered as "internal:main").
        m.insert("internal:main", "internal/main");
        for (specifier, kind) in BUILTINS {
            if let BuiltinKind::Source { path, .. } = kind {
                m.insert(specifier, path);
            }
        }
        m
    });
    map.get(spec).copied()
}

fn strip_builtin_extension(path: &str) -> &str {
    for ext in [".ts", ".mts", ".mjs", ".js", ".json"] {
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

fn source_specifier_path(specifier: &str) -> Option<PathBuf> {
    if specifier.starts_with("file://") {
        return file_url_to_path(specifier).ok();
    }
    if specifier.starts_with('/') {
        return Some(PathBuf::from(specifier));
    }
    None
}

fn builtin_source_override_root(scope: &mut v8::PinScope) -> Option<PathBuf> {
    let state_rc = get_state(scope);
    state_rc
        .borrow()
        .process_env
        .env_vars
        .get("FINO_BUILTIN_SOURCE_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn builtin_source_override_enabled(scope: &mut v8::PinScope, spec: &str) -> bool {
    let state_rc = get_state(scope);
    let state = state_rc.borrow();
    let Some(filter) = state.process_env.env_vars.get("FINO_BUILTIN_SOURCE_FILTER") else {
        return true;
    };
    if filter.is_empty() {
        return true;
    }
    filter.split(',').map(str::trim).any(|pattern| {
        if pattern.is_empty() {
            false
        } else if let Some(prefix) = pattern.strip_suffix('*') {
            spec.starts_with(prefix)
        } else {
            spec == pattern || spec.starts_with(pattern)
        }
    })
}

fn load_builtin_source_override<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    spec: &str,
    path: &str,
) -> Option<v8::Local<'s, v8::Module>> {
    if !builtin_source_override_enabled(scope, spec) {
        return None;
    }
    let root = builtin_source_override_root(scope)?;
    let base = root.join(path);
    let mjs_path = base.with_extension("mjs");
    if let Ok(source) = std::fs::read_to_string(&mjs_path) {
        return compile_source_module(scope, &source, spec, None);
    }

    let mts_path = base.with_extension("mts");
    let source = std::fs::read_to_string(&mts_path).ok()?;
    let stripped = match typescript_format::strip_typescript_module(&mts_path, &source) {
        Ok(stripped) => stripped,
        Err(message) => {
            throw_loader_error(
                scope,
                &format!("TypeScript error in {}: {message}", mts_path.display()),
            );
            return None;
        }
    };
    register_source_map_from_json(scope, spec, &stripped.map);
    compile_source_module(scope, &stripped.code, spec, Some(stripped.map.as_str()))
}

// ---------------------------------------------------------------------------
// internal:loader-hooks synthetic module
// ---------------------------------------------------------------------------

/// Creates `internal:loader-hooks` — exposes `registerResolve` and
/// `registerInitMeta` so `internal:loader` can install JS callbacks for
/// filesystem resolution and `import.meta` population.
pub fn loader_hooks_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "registerResolve",
        "registerInitMeta",
        "registerTranspile",
        "getPackageMap",
        "getSourceMap",
        "lookupOriginalPosition",
        "allowInternalForTests",
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
    v8::callback_scope!(unsafe let scope, context);

    crate::set_fn!(scope, module, "registerResolve", register_resolve);
    crate::set_fn!(scope, module, "registerInitMeta", register_init_meta);
    crate::set_fn!(scope, module, "registerTranspile", register_transpile);
    crate::set_fn!(scope, module, "getPackageMap", get_package_map);
    crate::set_fn!(scope, module, "getSourceMap", get_source_map);
    crate::set_fn!(
        scope,
        module,
        "lookupOriginalPosition",
        lookup_original_position
    );
    crate::set_fn!(
        scope,
        module,
        "allowInternalForTests",
        allow_internal_for_tests
    );

    Some(v8::undefined(scope).into())
}

fn register_resolve(
    scope: &mut v8::PinScope,
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
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let func_val: v8::Local<v8::Value> = args.get(0);
    if let Ok(func) = v8::Local::<v8::Function>::try_from(func_val) {
        let global = v8::Global::new(scope, func);
        get_state(scope).borrow_mut().init_meta_fn = Some(global);
    }
}

fn register_transpile(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let func_val: v8::Local<v8::Value> = args.get(0);
    if let Ok(func) = v8::Local::<v8::Function>::try_from(func_val) {
        let global = v8::Global::new(scope, func);
        get_state(scope).borrow_mut().transpile_fn = Some(global);
    }
}

fn get_package_map(
    scope: &mut v8::PinScope,
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

/// Return the loader-cached source map JSON for a compiled resource.
///
/// Consumers own decoding and position lookup; the loader only exposes data it
/// already retains for stack-trace mapping.
fn get_source_map(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let resource = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope));
    let json = resource.and_then(|resource| {
        get_state(scope)
            .borrow()
            .source_maps
            .get(&resource)
            .map(|cache| cache.map.to_json_string())
    });
    match json {
        Some(json) => match v8::String::new(scope, &json) {
            Some(value) => rv.set(value.into()),
            None => rv.set(v8::null(scope).into()),
        },
        None => rv.set(v8::null(scope).into()),
    }
}

fn allow_internal_for_tests(
    scope: &mut v8::PinScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    get_state(scope).borrow_mut().import_rules.push(ImportRule {
        from: Some(ImportPattern::Prefix("file://".to_string())),
        pattern: ImportPattern::Prefix("internal:".to_string()),
        directive: ImportDirective::Inherit,
    });
}

fn lookup_original_position(
    scope: &mut v8::PinScope,
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
    v8::callback_scope!(unsafe let scope, context);
    let raw_spec = specifier.to_rust_string_lossy(scope);

    // Resolve builtin-relative specifiers (e.g. './loop.ts' from a builtin).
    let state_rc = get_state(scope);
    let builtin_referrer: Option<String> = referrer
        .script_id()
        .and_then(|id| state_rc.borrow().builtin_specifiers.get(&id).cloned());
    let spec = if let Some(ref referrer_spec) = builtin_referrer {
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

    let from_spec = builtin_referrer.clone().or_else(|| {
        referrer
            .script_id()
            .and_then(|id| state_rc.borrow().module_paths.get(&id).cloned())
            .map(|p| file_url_from_path(&p))
    });

    if spec.starts_with("fino:") || spec.starts_with("internal:") {
        return get_or_load_builtin(scope, &spec, from_spec.as_deref());
    }

    // For non-builtin specifiers, check if an import directive (e.g. Remap)
    // routes this spec through the builtin resolver.
    let has_directive = {
        let st = state_rc.borrow();
        let d = crate::state::resolve_directive(&st.import_rules, from_spec.as_deref(), &spec);
        matches!(
            d,
            Some(ImportDirective::Remap { .. })
                | Some(ImportDirective::Source { .. })
                | Some(ImportDirective::Facade(..))
                | Some(ImportDirective::Installed { .. })
        )
    };
    if has_directive {
        return get_or_load_builtin(scope, &spec, from_spec.as_deref());
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
    v8::callback_scope!(unsafe let scope, context);
    let state_rc = get_state(scope);

    let (path, specifier) = {
        let st = state_rc.borrow();
        let id = module.script_id();
        (
            id.and_then(|id| st.module_paths.get(&id).cloned()),
            id.and_then(|id| st.builtin_specifiers.get(&id).cloned()),
        )
    };
    if let Some(specifier) = specifier {
        if let (Some(key), Some(value)) = (
            v8::String::new(scope, "url"),
            v8::String::new(scope, &specifier),
        ) {
            meta.set(scope, key.into(), value.into());
        }
        return;
    }
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
    let url = file_url_from_path(&path);

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
    scope: &mut v8::PinScope,
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
    } else if spec.starts_with("file://") {
        match file_url_to_path(&spec) {
            Ok(path) => path,
            Err(e) => {
                let msg = format!("Cannot resolve '{spec}': {e}");
                if let Some(msg_str) = v8::String::new(scope, &msg) {
                    let exc = v8::Exception::error(scope, msg_str);
                    scope.throw_exception(exc);
                }
                return;
            }
        }
    } else if spec.starts_with('/') {
        PathBuf::from(&spec)
    } else {
        root.join(&spec)
    };

    match raw.canonicalize() {
        Ok(canonical) if canonical.is_file() => {
            let url = file_url_from_path(&canonical);
            if let Some(s) = v8::String::new(scope, &url) {
                rv.set(s.into());
            }
        }
        Ok(_) => {
            let msg = format!("Cannot resolve '{spec}': not a loadable file");
            if let Some(msg_str) = v8::String::new(scope, &msg) {
                let exc = v8::Exception::error(scope, msg_str);
                scope.throw_exception(exc);
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
    scope: &mut v8::PinScope<'s, '_>,
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

    // Resolve builtin-relative specifiers (e.g. './loop.ts' from a builtin).
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
        file_url_to_path(&referrer_url)
            .ok()
            .and_then(|p| p.parent().map(|parent| parent.to_path_buf()))
    } else {
        None
    };

    // Pre-check for blocked builtins WITHOUT creating a TryCatch.
    // Using scope.throw_exception() inside a TryCatch and then calling
    // tc.reset() can leave the isolate in an unexpected state when called
    // from within module evaluation (e.g. during TLA). By checking the
    // directive here and rejecting via a plain error value, we avoid the
    // exception/TryCatch machinery entirely for blocked imports.
    if spec.starts_with("fino:") || spec.starts_with("internal:") {
        let state_rc = crate::state::get_state(scope);
        let is_blocked = {
            let st = state_rc.borrow();
            let is_builtin_ref = referrer_url.starts_with("fino:")
                || referrer_url.starts_with("internal:")
                || st
                    .builtin_specifiers
                    .values()
                    .any(|v| v.as_str() == referrer_url.as_str());
            if is_builtin_ref && spec.starts_with("internal:") {
                false
            } else {
                let dir =
                    crate::state::resolve_directive(&st.import_rules, Some(&referrer_url), &spec);
                matches!(dir, Some(crate::state::ImportDirective::Block))
            }
        };
        if is_blocked {
            let msg_str = format!("Import of '{}' is blocked in this Realm", spec);
            if let Some(msg) = v8::String::new(scope, &msg_str) {
                let exc = v8::Exception::error(scope, msg);
                resolver.reject(scope, exc);
            }
            return Some(promise);
        }
    }

    v8::tc_scope!(tc, scope);

    let module: Option<v8::Local<v8::Module>> = if spec.starts_with("fino:")
        || spec.starts_with("internal:")
    {
        get_or_load_builtin(tc, &spec, Some(&referrer_url))
    } else {
        // For non-builtin specifiers, check if there's an import directive
        // (e.g. Remap) that routes this spec through the builtin resolver.
        let has_directive = {
            let state_rc = crate::state::get_state(tc);
            let st = state_rc.borrow();
            let d = crate::state::resolve_directive(&st.import_rules, Some(&referrer_url), &spec);
            matches!(
                d,
                Some(ImportDirective::Remap { .. })
                    | Some(ImportDirective::Source { .. })
                    | Some(ImportDirective::Facade(..))
                    | Some(ImportDirective::Installed { .. })
            )
        };
        if has_directive {
            get_or_load_builtin(tc, &spec, Some(&referrer_url))
        } else {
            resolve_fs_specifier(tc, &spec, referrer_dir.as_deref())
                .and_then(|p| get_or_load_fs_module(tc, &p))
        }
    };

    settle_dynamic_import(tc, module, resolver);
    Some(promise)
}

/// Called when a TLA module's evaluation Promise fulfills (all top-level awaits done).
/// Resolves the dynamic-import Promise with the module namespace.
fn tla_fulfill_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.data().integer_value(scope).unwrap_or(-1) as u32;
    let state_rc = get_state(scope);
    let entry = {
        let mut st = state_rc.borrow_mut();
        let entry = st.tla_resolvers.get_mut(id as usize).and_then(|e| e.take());
        // Trim trailing None slots to prevent unbounded Vec growth.
        while st.tla_resolvers.last().map_or(false, |e| e.is_none()) {
            st.tla_resolvers.pop();
        }
        entry
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
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = args.data().integer_value(scope).unwrap_or(-1) as u32;
    let state_rc = get_state(scope);
    let entry = {
        let mut st = state_rc.borrow_mut();
        let entry = st.tla_resolvers.get_mut(id as usize).and_then(|e| e.take());
        while st.tla_resolvers.last().map_or(false, |e| e.is_none()) {
            st.tla_resolvers.pop();
        }
        entry
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
    scope: &mut v8::PinScope,
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

/// Resolve a filesystem specifier to an absolute `PathBuf`.
///
/// Delegates to the JS `resolve_fn` callback if one has been registered by
/// `internal:loader`, otherwise falls back to the Rust `resolve_path` helper.
fn resolve_fs_specifier(
    scope: &mut v8::PinScope,
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
fn settle_dynamic_import<'s>(
    tc: &mut v8::PinnedRef<'_, v8::TryCatch<'_, 's, v8::HandleScope<'_>>>,
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
    scope: &mut v8::PinScope<'s, '_>,
    spec: &str,
    from: Option<&str>,
) -> Option<v8::Local<'s, v8::Module>> {
    get_or_load_builtin_inner(scope, spec, from, &mut std::collections::HashSet::new())
}

fn get_or_load_builtin_inner<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    spec: &str,
    from: Option<&str>,
    visited: &mut std::collections::HashSet<String>,
) -> Option<v8::Local<'s, v8::Module>> {
    use crate::state::resolve_directive;

    let state_rc = get_state(scope);

    // 1. Check cache.
    let cached = {
        let st = state_rc.borrow();
        st.builtin_cache.get(spec).map(|m| v8::Local::new(scope, m))
    };
    if let Some(m) = cached {
        return Some(m);
    }

    // 2. Evaluate the import rule list (last-match-wins).
    //    The default rules in the root realm block `internal:*` from all
    //    importers except those whose specifier starts with `fino:` or
    //    `internal:`. Child realms inherit those rules automatically.
    //    Bypass Block rules when the referrer is a builtin (internal:* / fino:*)
    //    because builtins must always be able to import other builtins regardless
    //    of user-specified realm restrictions.
    let directive = {
        let st = state_rc.borrow();
        let d = resolve_directive(&st.import_rules, from, spec).cloned();
        if matches!(d, Some(ImportDirective::Block)) {
            let is_builtin_from = from.map_or(false, |f| {
                f.starts_with("fino:")
                    || f.starts_with("internal:")
                    || st.builtin_specifiers.values().any(|v| v == f)
            });
            if is_builtin_from { None } else { d }
        } else {
            d
        }
    };

    match directive {
        Some(ImportDirective::Block) => {
            let msg = v8::String::new(
                scope,
                &format!("Import of '{spec}' is blocked in this Realm"),
            )?;
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return None;
        }

        Some(ImportDirective::Remap { target }) => {
            const MAX_REMAP_DEPTH: usize = 64;
            if visited.len() >= MAX_REMAP_DEPTH {
                let msg = v8::String::new(
                    scope,
                    &format!("Remap chain for '{spec}' exceeds maximum depth ({MAX_REMAP_DEPTH})"),
                )?;
                let exc = v8::Exception::error(scope, msg);
                scope.throw_exception(exc);
                return None;
            }
            if !visited.insert(spec.to_string()) {
                // Already in the resolution chain — circular Remap detected.
                let msg = v8::String::new(
                    scope,
                    &format!("Import of '{spec}' has a circular Remap rule"),
                )?;
                let exc = v8::Exception::error(scope, msg);
                scope.throw_exception(exc);
                return None;
            }
            return get_or_load_builtin_inner(scope, &target, from, visited);
        }

        Some(ImportDirective::Source { code, source_map }) => {
            register_source_map_from_json(scope, spec, &source_map);
            let m = compile_source_module(scope, &code, spec, Some(&source_map))?;
            if let Some(id) = m.script_id() {
                let mut st = state_rc.borrow_mut();
                if let Some(path) = source_specifier_path(spec) {
                    st.module_paths.insert(id, path);
                } else {
                    // Record the specifier so `from`-clause matching works when
                    // this module imports something else.
                    st.builtin_specifiers.insert(id, spec.to_string());
                }
            }
            let global = v8::Global::new(scope, m);
            state_rc
                .borrow_mut()
                .builtin_cache
                .insert(spec.to_string(), global);
            return Some(m);
        }

        Some(ImportDirective::Facade(synthetic_spec)) => {
            let code = crate::realm::synthetic::create_module_source(&synthetic_spec);
            // Compile with the facade specifier so import-rule `from`-clause
            // matching works. Facade specifiers (e.g. "fino:file") fall under
            // fino:* in the default rules, granting access to internal:* without
            // explicit builtin_specifiers registration.
            let m = compile_source_module(scope, &code, &synthetic_spec.specifier, None)?;
            if let Some(id) = m.script_id() {
                state_rc
                    .borrow_mut()
                    .builtin_specifiers
                    .insert(id, synthetic_spec.specifier.clone());
            }
            let global = v8::Global::new(scope, m);
            state_rc
                .borrow_mut()
                .builtin_cache
                .insert(synthetic_spec.specifier.clone(), global);
            return Some(m);
        }

        Some(ImportDirective::Installed {
            specifier: installed_spec,
        }) => {
            // Module should be in cache (installed via SyntheticModule.install()).
            // Reaching here means the cache check at step 1 missed — the module
            // was uninstalled without removing the directive (shouldn't happen).
            let msg = v8::String::new(
                scope,
                &format!("SyntheticModule '{installed_spec}' is not installed"),
            )?;
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return None;
        }

        Some(ImportDirective::Inherit) | None => {
            // Fall through to BUILTINS below.
        }
    }

    // 3. Fall back to the static BUILTINS registry.
    let entry = BUILTINS.iter().find(|(s, _)| *s == spec)?;
    let (spec_key, kind) = entry;

    let module = match kind {
        BuiltinKind::Source {
            code,
            source_map,
            path,
        } => {
            let m = if let Some(m) = load_builtin_source_override(scope, spec, path) {
                m
            } else {
                register_source_map_from_json(scope, spec, source_map);
                compile_source_module(scope, code, spec, Some(source_map))?
            };
            if let Some(id) = m.script_id() {
                state_rc
                    .borrow_mut()
                    .builtin_specifiers
                    .insert(id, spec_key.to_string());
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
    scope: &mut v8::PinScope<'s, '_>,
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
    scope: &mut v8::PinScope<'s, '_>,
    path: &Path,
) -> Option<v8::Local<'s, v8::Module>> {
    let resource_name = file_url_from_path(path);
    let text = std::fs::read_to_string(path).ok()?;

    if is_json(path) {
        let escaped = escape_js_string(&text);
        let src = format!("export default JSON.parse('{escaped}');");
        compile_source_module(scope, &src, &resource_name, None)
    } else if is_typescript(path) || is_mdx(path) || is_sql(path) {
        let stripped = transpile_typescript(scope, path, &text)?;
        register_source_map_from_json(scope, &resource_name, &stripped.map);
        compile_source_module(
            scope,
            &stripped.code,
            &resource_name,
            Some(stripped.map.as_str()),
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
    scope: &mut v8::PinScope<'s, '_>,
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

pub fn register_source_map(scope: &mut v8::PinScope, resource_name: &str, map: SourceMap) {
    get_state(scope).borrow_mut().source_maps.insert(
        resource_name.to_string(),
        crate::state::SourceMapCache::new(map),
    );
}

pub fn register_source_map_from_json(
    scope: &mut v8::PinScope,
    resource_name: &str,
    source_map_json: &str,
) {
    if let Ok(map) = SourceMap::from_json_string(source_map_json) {
        register_source_map(scope, resource_name, map);
    }
}

/// Register a module's script_id as a builtin so `internal:*` imports are
/// allowed from it.
pub fn register_as_builtin(scope: &mut v8::PinScope, module: v8::Local<v8::Module>, spec: &str) {
    if let Some(id) = module.script_id() {
        get_state(scope)
            .borrow_mut()
            .builtin_specifiers
            .insert(id, spec.to_string());
    }
}

fn instantiate_and_evaluate<'s>(
    scope: &mut v8::PinScope<'s, '_>,
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
    } else if specifier.starts_with("file://") {
        file_url_to_path(specifier).map_err(|e| format!("Cannot resolve '{specifier}': {e}"))?
    } else if specifier.starts_with('/') {
        PathBuf::from(specifier)
    } else {
        root.join(specifier)
    };
    if let Ok(p) = raw.canonicalize()
        && p.is_file()
    {
        return Ok(p);
    }
    // Extension probing: prefer typed sources, then JSX, JS, and data modules.
    for ext in [
        ".ts", ".tsx", ".mts", ".mdx", ".jsx", ".mjs", ".js", ".json",
    ] {
        let mut probed = raw.as_os_str().to_owned();
        probed.push(ext);
        if let Ok(p) = PathBuf::from(probed).canonicalize()
            && p.is_file()
        {
            return Ok(p);
        }
    }
    Err(format!(
        "Cannot resolve '{specifier}': No such file or directory"
    ))
}

fn file_url_to_path(specifier: &str) -> Result<PathBuf, String> {
    let rest = specifier
        .strip_prefix("file://")
        .ok_or_else(|| "Invalid file URL: missing file:// scheme".to_string())?;
    let path = if rest.starts_with('/') {
        rest
    } else if rest.starts_with("localhost/") {
        &rest["localhost".len()..]
    } else {
        return Err("Invalid file URL: non-local hosts are not supported".to_string());
    };
    Ok(PathBuf::from(percent_decode_file_url_path(path)?))
}

fn file_url_from_path(path: &Path) -> String {
    let mut url = String::from("file://");
    for byte in path.to_string_lossy().as_bytes() {
        match *byte {
            b'/' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' | b'-' | b'.' | b'_' | b'~' => {
                url.push(*byte as char);
            }
            _ => {
                url.push('%');
                url.push(hex_digit(byte >> 4));
                url.push(hex_digit(byte & 0x0f));
            }
        }
    }
    url
}

fn percent_decode_file_url_path(path: &str) -> Result<String, String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("Invalid file URL: malformed percent escape".to_string());
            }
            let hi = hex_value(bytes[i + 1])
                .ok_or_else(|| "Invalid file URL: malformed percent escape".to_string())?;
            let lo = hex_value(bytes[i + 2])
                .ok_or_else(|| "Invalid file URL: malformed percent escape".to_string())?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Invalid file URL: decoded path is not UTF-8".to_string())
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'A' + value - 10) as char,
        _ => unreachable!(),
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_typescript(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "tsx" | "mts" | "cts" | "jsx")
    )
}

fn is_json(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

fn is_mdx(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("mdx")
}

fn is_sql(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("sql")
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
    map: String,
}

fn transpile_typescript(
    scope: &mut v8::PinScope,
    path: &Path,
    source_text: &str,
) -> Option<TranspiledSource> {
    let func = {
        let state_rc = get_state(scope);
        let state = state_rc.borrow();
        state
            .transpile_fn
            .as_ref()
            .map(|f| v8::Local::new(scope, f))
    };
    let Some(func) = func else {
        throw_loader_error(
            scope,
            "TypeScript transpile hook is not registered; internal:loader did not initialize",
        );
        return None;
    };

    let source = v8::String::new(scope, source_text)?;
    let filename = v8::String::new(scope, &path.to_string_lossy())?;
    let this = v8::undefined(scope).into();
    let value = func.call(scope, this, &[source.into(), filename.into()])?;
    let object = match v8::Local::<v8::Object>::try_from(value) {
        Ok(object) => object,
        Err(_) => {
            throw_loader_error(
                scope,
                "TypeScript transpile hook returned a non-object value",
            );
            return None;
        }
    };

    let Some(code) = crate::v8util::get_object_string(scope, object, "code") else {
        throw_loader_error(scope, "TypeScript transpile hook did not return code");
        return None;
    };
    let Some(map) = crate::v8util::get_object_string(scope, object, "map") else {
        throw_loader_error(
            scope,
            "TypeScript transpile hook did not return a source map",
        );
        return None;
    };
    Some(TranspiledSource { code, map })
}

fn throw_loader_error(scope: &mut v8::PinScope, message: &str) {
    crate::v8util::throw_error(scope, message);
}
