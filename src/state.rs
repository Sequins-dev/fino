use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex, atomic::AtomicBool},
};

pub use crate::async_rt::bridge::PendingResolution;

use oxc_sourcemap::{SourceMap, Token};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use v8;

pub struct SourceMapCache {
    pub map: SourceMap,
    pub lines: Vec<Vec<Token>>,
}

impl SourceMapCache {
    pub fn new(map: SourceMap) -> Self {
        let mut lines: Vec<Vec<Token>> = Vec::new();
        for token in map.get_tokens() {
            let dst_line = token.get_dst_line() as usize;
            if lines.len() <= dst_line {
                lines.resize_with(dst_line + 1, Vec::new);
            }
            lines[dst_line].push(token);
        }
        Self { map, lines }
    }

    pub fn lookup(&self, line: u32, col: u32) -> Option<(String, u32, u32)> {
        let tokens = self.lines.get(line as usize)?;
        let idx = match tokens.binary_search_by_key(&col, |token| token.get_dst_col()) {
            Ok(mut index) => {
                while index > 0 && tokens[index - 1].get_dst_col() == col {
                    index -= 1;
                }
                index
            }
            Err(index) => index.checked_sub(1)?,
        };
        let token = tokens.get(idx)?;
        let source_id = token.get_source_id()?;
        let source = self.map.get_source(source_id)?.to_string();
        Some((source, token.get_src_line(), token.get_src_col()))
    }
}

/// Virtualised process-level identity for a Realm.
///
/// Collected once from the real environment in `main.rs` and stored on the
/// root `FinoState`. Child and reactor-pooled realms inherit this by default; it can
/// be overridden at creation time to produce fully isolated sandboxes.
#[derive(Clone)]
pub struct ProcessEnv {
    /// Filesystem root used for module resolution (equivalent to CWD).
    pub root: PathBuf,
    /// Command-line arguments (argv).
    pub args: Vec<String>,
    /// Environment variable map.
    pub env_vars: HashMap<String, String>,
    /// Absolute path to the runtime executable.
    pub exec_path: String,
}

// ---------------------------------------------------------------------------
// Import rule system
// ---------------------------------------------------------------------------

/// A module specifier pattern used in import rules.
///
/// `"*"` → `CatchAll`, `"fino:*"` → `Prefix("fino:")`, anything else → `Exact`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportPattern {
    Exact(String),
    /// Stored without the trailing `*`.
    Prefix(String),
    CatchAll,
}

impl ImportPattern {
    pub fn parse(s: &str) -> Self {
        if s == "*" {
            Self::CatchAll
        } else if let Some(prefix) = s.strip_suffix('*') {
            Self::Prefix(prefix.to_string())
        } else {
            Self::Exact(s.to_string())
        }
    }

    pub fn matches(&self, target: &str) -> bool {
        match self {
            Self::Exact(s) => s == target,
            Self::Prefix(p) => target.starts_with(p.as_str()),
            Self::CatchAll => true,
        }
    }
}

impl<'de> Deserialize<'de> for ImportPattern {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Self::parse(&String::deserialize(d)?))
    }
}

impl Serialize for ImportPattern {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Exact(v) => s.serialize_str(v),
            Self::Prefix(p) => s.serialize_str(&format!("{p}*")),
            Self::CatchAll => s.serialize_str("*"),
        }
    }
}

/// Selects the generated stub template for a `SyntheticSpec`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SyntheticMode {
    /// Same-realm direct binding: `export const X = __direct(spec, "X")`.
    Direct,
    /// Cross-realm RPC proxy: `export const X = (...args) => __rpc(spec, "X", args)`.
    #[default]
    Rpc,
}

/// Interface description for a synthetic proxy module.
///
/// `mode == Rpc` is the cross-realm Facade path (original behaviour).
/// `mode == Direct` is the same-realm `SyntheticModule` path (values by identity).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyntheticSpec {
    pub specifier: String,
    /// Scalar exports.
    /// RPC: `export const fn = (...args) => __rpc(...)`.
    /// Direct: `export const X = __direct(spec, "X")`.
    pub exports: Vec<String>,
    /// Read-stream exports (RPC mode only).
    #[serde(default)]
    pub streams: Vec<String>,
    /// Write-stream (sink) exports (RPC mode only).
    #[serde(default)]
    pub sinks: Vec<String>,
    /// Optional custom module body for RPC facades. The loader compiles this
    /// source verbatim, letting a facade expose shapes beyond function stubs.
    #[serde(default)]
    pub source: Option<String>,
    /// Optional registered source builtin used as the facade's module body.
    /// The loader compiles it under `specifier` so `import.meta.url` continues
    /// to identify the facade to parent RPC calls.
    #[serde(default)]
    pub module: Option<String>,
    /// Stub generation mode. Defaults to `Rpc` for backward-compat deserialization.
    #[serde(default)]
    pub mode: SyntheticMode,
}

/// What to do when a module import matches a rule.
///
/// Serialised as a JSON object with a `"type"` discriminator field.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ImportDirective {
    /// Use whatever the parent realm says for this specifier.
    /// In a root realm, this falls through to the static BUILTINS.
    Inherit,
    /// Refuse to resolve — throws ImportError.
    Block,
    /// Resolve as if the import said `target` instead.
    Remap { target: String },
    /// Compile and use this JS source as the module implementation.
    Source { code: String, source_map: String },
    /// Generate a synthetic proxy module (RPC or direct-binding).
    Facade(SyntheticSpec),
    /// The module is already compiled and cached; route resolution to the cache.
    Installed { specifier: String },
}

/// A single rule in a Realm's import rule list.
///
/// Rules are evaluated in declaration order; the **last matching rule wins**.
/// `from` restricts the rule to imports originating from a specific module.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImportRule {
    /// Pattern matching the importing module's specifier. Absent = all modules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<ImportPattern>,
    /// Pattern matching the specifier being imported.
    pub pattern: ImportPattern,
    pub directive: ImportDirective,
}

/// Evaluate the import rule list and return the directive for `(from, spec)`.
///
/// Last-match-wins: iterates all rules, last matching one takes effect.
/// Returns `None` (fall through to BUILTINS) if no rule matches.
pub fn resolve_directive<'a>(
    rules: &'a [ImportRule],
    from: Option<&str>,
    spec: &str,
) -> Option<&'a ImportDirective> {
    let mut last: Option<&ImportDirective> = None;
    for rule in rules {
        let from_ok = rule
            .from
            .as_ref()
            .map_or(true, |p| p.matches(from.unwrap_or("")));
        if from_ok && rule.pattern.matches(spec) {
            last = Some(&rule.directive);
        }
    }
    last
}

/// Default import rules installed in the root Realm.
///
/// `internal:*` is blocked from all importers; `fino:*` and `internal:*`
/// modules are then explicitly re-allowed. This replaces the old
/// `builtin_script_ids` allowlist entirely: any module whose specifier starts
/// with `fino:` or `internal:` can import `internal:*`; everything else
/// (user file-based modules, source overrides with arbitrary specifiers) cannot.
pub fn default_import_rules() -> Vec<ImportRule> {
    vec![
        ImportRule {
            from: None,
            pattern: ImportPattern::Prefix("internal:".to_string()),
            directive: ImportDirective::Block,
        },
        ImportRule {
            from: Some(ImportPattern::Prefix("fino:".to_string())),
            pattern: ImportPattern::Prefix("internal:".to_string()),
            directive: ImportDirective::Inherit,
        },
        ImportRule {
            from: Some(ImportPattern::Prefix("internal:".to_string())),
            pattern: ImportPattern::Prefix("internal:".to_string()),
            directive: ImportDirective::Inherit,
        },
        // The child-realm bootstrap script is trusted runtime code, but its
        // dynamic imports carry the raw resource name (not a builtin
        // specifier), so without this rule its internal:* imports would be
        // blocked where its static ones are not. Public (fino:*) dynamic
        // imports from the bootstrap intentionally remain subject to realm
        // rules.
        ImportRule {
            from: Some(ImportPattern::Exact("internal/bootstrap.mjs".to_string())),
            pattern: ImportPattern::Prefix("internal:".to_string()),
            directive: ImportDirective::Inherit,
        },
    ]
}

/// All per-run state, stored in the V8 context slot so every Rust callback can
/// access it without passing extra arguments.
pub struct FinoState {
    pub process_env: ProcessEnv,
    pub package_map_json: Option<String>,

    // ---------------------------------------------------------------------------
    // Microtask queue
    // ---------------------------------------------------------------------------
    /// The context's single microtask queue.
    pub root_queue: v8::MicrotaskQueueHandle,

    // ---------------------------------------------------------------------------
    // Per-Realm import rule list
    // ---------------------------------------------------------------------------
    /// Ordered import rules for this Realm. Evaluated last-match-wins.
    /// A child Realm's list is the parent's list with the child's overrides
    /// appended, so parent rules are always the baseline and child rules layer
    /// on top. An empty list means all imports fall through to BUILTINS.
    pub import_rules: Vec<ImportRule>,

    // ---------------------------------------------------------------------------
    // Module caches
    // ---------------------------------------------------------------------------
    /// Compiled builtin modules keyed by specifier string.
    /// Uses `String` (not `&'static str`) so dynamic override specifiers can
    /// also be cached alongside static BUILTINS entries.
    pub builtin_cache: HashMap<String, v8::Global<v8::Module>>,
    pub fs_cache: HashMap<PathBuf, v8::Global<v8::Module>>,
    /// Reverse lookup from V8 script id to builtin specifier.
    /// Used for relative-import resolution from builtins (e.g. `./loop.ts`
    /// from `internal:runtime/loop`) and as the `from` specifier for import-rule
    /// matching. Static BUILTINS and dynamic `Source` overrides are both stored.
    pub builtin_specifiers: HashMap<i32, String>,

    // ---------------------------------------------------------------------------
    // Module path tracking (script_id → filesystem path for source modules)
    // ---------------------------------------------------------------------------
    /// Maps V8 script IDs → filesystem path for compiled-from-disk modules.
    /// Used by `init_import_meta` to populate `import.meta.filename` etc.,
    /// and by the resolve callback to find the referrer's directory.
    pub module_paths: HashMap<i32, PathBuf>,
    pub source_maps: HashMap<String, SourceMapCache>,

    // ---------------------------------------------------------------------------
    // JS callbacks registered by `internal:loader`
    // ---------------------------------------------------------------------------
    pub resolve_fn: Option<v8::Global<v8::Function>>,
    pub init_meta_fn: Option<v8::Global<v8::Function>>,
    pub transpile_fn: Option<v8::Global<v8::Function>>,

    // ---------------------------------------------------------------------------
    // V8 event loop callbacks (set by runLoop() from internal/main.ts via internal:async-context)
    // ---------------------------------------------------------------------------
    /// One host-safe loop step callback. Returns true to continue, false to exit.
    pub loop_step_fn: Option<v8::Global<v8::Function>>,
    /// Called by Rust after the event loop exits to run the post-loop error check.
    pub on_done_fn: Option<v8::Global<v8::Function>>,
    /// Process-reactor owner id for this isolate, or zero outside the pool.
    pub scheduler_workload_owner: u32,
    /// Whether readiness registrations are routed through the process loop.
    pub uses_process_readiness: bool,
    /// Reports whether a quiescent scheduled workload still needs polling.
    pub scheduler_polling_fn: Option<v8::Global<v8::Function>>,

    // ---------------------------------------------------------------------------
    // Pending synchronous call (set by JS scheduleSync() from internal:async-context)
    // ---------------------------------------------------------------------------
    /// Function to call from outside the microtask checkpoint (so spin() works).
    pub sync_call_fn: Option<v8::Global<v8::Function>>,
    /// Promise resolver to settle after calling sync_call_fn.
    pub sync_call_resolver: Option<v8::Global<v8::PromiseResolver>>,

    // ---------------------------------------------------------------------------
    // Pending resolutions from Rust async futures (future_to_promise)
    // ---------------------------------------------------------------------------
    /// Futures spawned via `async_rt::bridge::future_to_promise` push
    /// `PendingResolution` entries here when they complete. Drained by
    /// `async_rt::drain_pending_for` with a live scope during each
    /// `pump_and_checkpoint`. Stored as `Rc<RefCell<…>>` so futures can
    /// capture a clone without needing a V8 scope.
    pub pending_resolutions: Rc<RefCell<Vec<PendingResolution>>>,

    // ---------------------------------------------------------------------------
    // Pending TLA (top-level await) dynamic imports
    // ---------------------------------------------------------------------------
    /// Indexed by a u32 id stored as the data value of the fulfill/reject
    /// callbacks. When TLA module evaluation settles, the callback pops the
    /// entry and resolves/rejects the dynamic-import Promise resolver.
    pub tla_resolvers: Vec<Option<(v8::Global<v8::PromiseResolver>, v8::Global<v8::Value>)>>,

    // ---------------------------------------------------------------------------
    // CPU profiler (fino:profiler)
    // ---------------------------------------------------------------------------
    /// Raw pointer to the V8 CpuProfiler, created lazily on first startProfiling
    /// call. Disposed before isolate teardown.
    pub cpu_profiler: Option<*mut std::ffi::c_void>,
    /// Automatic process-profile registration for this Realm. This owns a
    /// separate V8 profiler so the public `fino:profiler` recordings retain
    /// their existing named-profile semantics.
    pub process_profile: Option<crate::profiler::RealmProfileRegistration>,

    // ---------------------------------------------------------------------------
    // Child Realm management
    // ---------------------------------------------------------------------------
    /// Live process realm handles indexed by the JS handle returned from
    /// `createProcessContext`.
    #[allow(dead_code)]
    pub process_contexts: Vec<Option<crate::realm::process::ProcessRealmHandle>>,

    /// Live Linux sandbox Realm handles indexed by the JS handle returned from
    /// `createSandboxContext`.
    pub sandbox_contexts: Vec<Option<crate::realm::thread::ThreadRealmHandle>>,

    /// Entry module path for child Realms. Set by `createContext` before
    /// evaluating `internal/bootstrap.mjs` in the child context. The child's bootstrap
    /// reads this via `internal:realm-bridge.getEntryPath()`.
    pub entry_path: Option<String>,

    /// Termination flag for child Realms. The parent sets this to `true` via
    /// `terminateChild()` from `internal:realm-native`. The child's `isDone`
    /// callback checks this via `internal:realm-bridge.isTerminated()`.
    pub terminated: bool,

    /// Set by `internal:realm-bridge.requestReload()` before `terminated` is
    /// set. The parent observes this to distinguish a reload-exit from a clean
    /// exit and respawns the same child configuration.
    pub reload_requested: bool,

    /// `true` when this realm was started with `watch: true`. Exposed to JS
    /// via `internal:realm-bridge.getWatchMode()` so `internal/bootstrap.ts` can
    /// start the file-watch loop.
    pub watch_mode: bool,

    /// `true` when this realm was started with `repl: true`. Exposed to JS
    /// via `internal:realm-bridge.getReplMode()` so `internal/bootstrap.ts` can
    /// activate the REPL message loop instead of importing an entry module.
    pub repl_mode: bool,

    /// JSON-serialized `RealmOptions.data` payload from the parent, exposed to
    /// JS via `internal:realm-bridge.getRealmData()`. `None` for the root Realm
    /// and for children spawned without `data`.
    pub realm_data: Option<String>,

    /// Runtime-owned bootstrap metadata, separate from `RealmOptions.data`.
    pub realm_bootstrap_data: Option<String>,

    /// Whether this isolate is the dedicated thread owned by a Linux sandbox
    /// Realm. Async FFI must reject work from this context because its global
    /// blocking pool is outside the thread-local sandbox.
    pub sandboxed_thread: bool,

    /// Shared with the parent-side thread handle so the bootstrap can report
    /// the threaded cgroup it joined before Landlock makes cgroupfs
    /// inaccessible. The parent removes the empty cgroup after the thread exits.
    pub sandbox_cgroup_path: Option<Arc<Mutex<Option<String>>>>,

    /// Shared atomic for reactor-pooled realms: `requestReload()` writes `true`
    /// here so the scheduler can observe the reload intent without entering
    /// the child's V8 context. `None` for embedded/process.
    pub reload_requested_signal: Option<Arc<AtomicBool>>,

    /// Error recorded by the child's entry module if it threw at top level.
    /// Set via `internal:realm-bridge.setEntryError()`; read by the parent
    /// in `step_context` to reject `Realm.run()` instead of resolving silently.
    pub entry_error: Option<String>,

    /// The child's MessagePort object, passed by the parent at creation time.
    /// Read-only after bootstrap; accessed via `internal:realm-bridge.getPort()`.
    pub port: Option<v8::Global<v8::Value>>,

    /// V8 inspector state for this realm. Created lazily by `internal:inspector`
    /// on first use. Stored as a raw pointer (pointing to a heap-allocated
    /// `InspectorState`) because inspector objects use C++ vtable-based types
    /// that cannot be held behind a trait object or across `RefCell` borrows.
    /// Disposed in realm teardown (same pattern as `cpu_profiler`).
    pub inspector_state: Option<*mut std::ffi::c_void>,

    // ---------------------------------------------------------------------------
    // Cross-isolate Realm channels
    // ---------------------------------------------------------------------------
    // `allow(dead_code)`: used by thread-realm native send/recv functions.
    #[allow(dead_code)]
    /// Receives serialized messages sent from the partner Isolate.
    pub channel_rx: Option<std::sync::mpsc::Receiver<crate::realm::thread::ThreadMessage>>,
    #[allow(dead_code)]
    /// Sends serialized messages to the partner Isolate.
    pub channel_tx: Option<std::sync::mpsc::Sender<crate::realm::thread::ThreadMessage>>,
    #[allow(dead_code)]
    /// Own wake-pipe read end — registered with the event loop; readable when
    /// the partner has deposited a message in `channel_rx`.
    pub wake_read_fd: Option<std::os::unix::io::RawFd>,
    #[allow(dead_code)]
    /// Partner's wake-pipe write end — write 1 byte here after each
    /// `channel_tx.send()` to unblock the partner's event-loop wait.
    pub wake_write_fd: Option<std::os::unix::io::RawFd>,
}

impl FinoState {
    /// Create Realm state for reactor and sandbox execution.
    /// Module caches and callbacks start empty; host inputs are explicit.
    pub fn new_child(
        process_env: ProcessEnv,
        package_map_json: Option<String>,
        root_queue: v8::MicrotaskQueueHandle,
        import_rules: Vec<ImportRule>,
        entry_path: Option<String>,
        port: Option<v8::Global<v8::Value>>,
        channel_rx: Option<std::sync::mpsc::Receiver<crate::realm::thread::ThreadMessage>>,
        channel_tx: Option<std::sync::mpsc::Sender<crate::realm::thread::ThreadMessage>>,
        wake_read_fd: Option<std::os::unix::io::RawFd>,
        wake_write_fd: Option<std::os::unix::io::RawFd>,
        watch_mode: bool,
        repl_mode: bool,
        realm_data: Option<String>,
        realm_bootstrap_data: Option<String>,
        reload_requested_signal: Option<Arc<AtomicBool>>,
    ) -> Self {
        Self {
            process_env,
            package_map_json,
            root_queue,
            import_rules,
            builtin_cache: HashMap::new(),
            fs_cache: HashMap::new(),
            builtin_specifiers: HashMap::new(),
            module_paths: HashMap::new(),
            source_maps: HashMap::new(),
            resolve_fn: None,
            init_meta_fn: None,
            transpile_fn: None,
            loop_step_fn: None,
            on_done_fn: None,
            scheduler_workload_owner: 0,
            uses_process_readiness: false,
            scheduler_polling_fn: None,
            sync_call_fn: None,
            sync_call_resolver: None,
            pending_resolutions: Rc::new(RefCell::new(Vec::new())),
            tla_resolvers: Vec::new(),
            cpu_profiler: None,
            process_profile: None,
            entry_path,
            terminated: false,
            reload_requested: false,
            watch_mode,
            repl_mode,
            realm_data,
            realm_bootstrap_data,
            sandboxed_thread: false,
            sandbox_cgroup_path: None,
            reload_requested_signal,
            entry_error: None,
            port,
            inspector_state: None,
            channel_rx,
            channel_tx,
            wake_read_fd,
            wake_write_fd,
            process_contexts: Vec::new(),
            sandbox_contexts: Vec::new(),
        }
    }
}

/// Retrieve the state `Rc` from the current V8 isolate's slot.
///
/// # Panics
/// Panics if called before the isolate's `FinoState` has been initialised.
pub fn get_state(scope: &mut v8::PinScope) -> Rc<RefCell<FinoState>> {
    scope
        .get_slot::<Rc<RefCell<FinoState>>>()
        .expect("FinoState not initialised in isolate slot")
        .clone()
}

/// Get a raw pointer to the root microtask queue.
///
/// # Safety
/// See `loop_queue_ptr`.
pub unsafe fn root_queue_ptr(state_rc: &Rc<RefCell<FinoState>>) -> *const v8::MicrotaskQueue {
    let st = state_rc.borrow();
    &*st.root_queue as *const v8::MicrotaskQueue
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(pattern: &str, directive: ImportDirective) -> ImportRule {
        ImportRule {
            from: None,
            pattern: ImportPattern::parse(pattern),
            directive,
        }
    }

    fn rule_from(from: &str, pattern: &str, directive: ImportDirective) -> ImportRule {
        ImportRule {
            from: Some(ImportPattern::parse(from)),
            pattern: ImportPattern::parse(pattern),
            directive,
        }
    }

    // ---------------------------------------------------------------------------
    // ImportPattern::matches
    // ---------------------------------------------------------------------------

    #[test]
    fn pattern_exact_matches_only_that_string() {
        let p = ImportPattern::parse("fino:ffi");
        assert!(p.matches("fino:ffi"));
        assert!(!p.matches("fino:ffi/extra"));
        assert!(!p.matches("fino:"));
    }

    #[test]
    fn pattern_prefix_matches_all_with_prefix() {
        let p = ImportPattern::parse("fino:*");
        assert!(p.matches("fino:ffi"));
        assert!(p.matches("fino:net/socket"));
        assert!(p.matches("fino:"));
        assert!(!p.matches("internal:ffi"));
    }

    #[test]
    fn pattern_catchall_matches_everything() {
        let p = ImportPattern::parse("*");
        assert!(p.matches("fino:ffi"));
        assert!(p.matches("internal:x"));
        assert!(p.matches(""));
    }

    // ---------------------------------------------------------------------------
    // resolve_directive — last-match-wins semantics
    // ---------------------------------------------------------------------------

    #[test]
    fn resolve_returns_none_for_empty_rules() {
        assert!(resolve_directive(&[], None, "fino:ffi").is_none());
    }

    #[test]
    fn resolve_last_match_wins_over_earlier() {
        let rules = vec![
            rule("*", ImportDirective::Block),
            rule("fino:ffi", ImportDirective::Inherit),
        ];
        // Last rule (Exact allow) beats first (wildcard block)
        assert!(matches!(
            resolve_directive(&rules, None, "fino:ffi"),
            Some(ImportDirective::Inherit)
        ));
        // Wildcard applies for unmentioned specifier
        assert!(matches!(
            resolve_directive(&rules, None, "fino:net"),
            Some(ImportDirective::Block)
        ));
    }

    #[test]
    fn resolve_exact_wins_over_prefix_when_later() {
        let rules = vec![
            rule("fino:*", ImportDirective::Inherit),
            rule("fino:ffi", ImportDirective::Block),
        ];
        assert!(matches!(
            resolve_directive(&rules, None, "fino:ffi"),
            Some(ImportDirective::Block)
        ));
        assert!(matches!(
            resolve_directive(&rules, None, "fino:other"),
            Some(ImportDirective::Inherit)
        ));
    }

    #[test]
    fn resolve_from_clause_restricts_to_matching_importer() {
        let rules = vec![
            rule("internal:*", ImportDirective::Block),
            rule_from("fino:*", "internal:*", ImportDirective::Inherit),
        ];
        // fino:* importer — allowed
        assert!(matches!(
            resolve_directive(&rules, Some("fino:realm"), "internal:ffi"),
            Some(ImportDirective::Inherit)
        ));
        // user code importer — still blocked
        assert!(matches!(
            resolve_directive(&rules, Some("/app/main.ts"), "internal:ffi"),
            Some(ImportDirective::Block)
        ));
    }

    #[test]
    fn resolve_from_absent_matches_all_importers() {
        let rules = vec![rule("fino:ffi", ImportDirective::Block)];
        assert!(matches!(
            resolve_directive(&rules, Some("anything"), "fino:ffi"),
            Some(ImportDirective::Block)
        ));
        assert!(matches!(
            resolve_directive(&rules, None, "fino:ffi"),
            Some(ImportDirective::Block)
        ));
    }

    // ---------------------------------------------------------------------------
    // default_import_rules
    // ---------------------------------------------------------------------------

    #[test]
    fn default_rules_block_internal_for_user_code() {
        let rules = default_import_rules();
        assert!(matches!(
            resolve_directive(&rules, Some("/app/main.ts"), "internal:realm-native"),
            Some(ImportDirective::Block)
        ));
    }

    #[test]
    fn default_rules_allow_internal_for_fino_modules() {
        let rules = default_import_rules();
        assert!(matches!(
            resolve_directive(&rules, Some("fino:realm"), "internal:realm-native"),
            Some(ImportDirective::Inherit)
        ));
    }

    #[test]
    fn default_rules_allow_internal_for_internal_modules() {
        let rules = default_import_rules();
        assert!(matches!(
            resolve_directive(&rules, Some("internal:globals/global"), "internal:stream"),
            Some(ImportDirective::Inherit)
        ));
    }

    #[test]
    fn default_rules_do_not_restrict_fino_specifiers() {
        let rules = default_import_rules();
        // fino:* specifiers are not explicitly covered → fall through to BUILTINS
        assert!(resolve_directive(&rules, Some("/app/main.ts"), "fino:file").is_none());
    }

    #[test]
    fn bootstrap_dynamic_internal_import_inherits_by_default() {
        let rules = default_import_rules();
        assert!(matches!(
            resolve_directive(
                &rules,
                Some("internal/bootstrap.mjs"),
                "internal:opentelemetry/bootstrap"
            ),
            Some(&ImportDirective::Inherit)
        ));
        // Other non-builtin referrers stay blocked.
        assert!(matches!(
            resolve_directive(
                &rules,
                Some("/app/main.ts"),
                "internal:opentelemetry/bootstrap"
            ),
            Some(&ImportDirective::Block)
        ));
    }
}
