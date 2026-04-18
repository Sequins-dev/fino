use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    path::PathBuf,
    rc::Rc,
};

use ::v8;
use oxc_sourcemap::{SourceMap, Token};

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

/// An owned child Realm (V8 Context) running in the same Isolate.
///
/// The parent's `FinoState.child_contexts` owns these. When the parent's
/// loop exits, it terminates all children before calling `on_done_fn`.
pub struct ChildRealm {
    pub context: v8::Global<v8::Context>,
}

/// Virtualised process-level identity for a Realm.
///
/// Collected once from the real environment in `main.rs` and stored on the
/// root `FinoState`. Child and thread realms inherit this by default; it can
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

/// A deferred request to create a child Realm.
///
/// `native_create_context` queues one of these instead of calling
/// `create_child_context` directly, because context creation requires a
/// `HandleScope<()>` (unbound) which is unavailable inside a JS callback.
/// The host loop drains `pending_creates` between iterations where
/// `isolate_scope` (`HandleScope<()>`) is accessible.
pub struct PendingRealm {
    /// Pre-allocated slot index in `FinoState::child_contexts`.
    pub handle_idx: usize,
    pub process_env: ProcessEnv,
    pub entry_path: String,
    pub providers: HashMap<String, Option<ProviderConfig>>,
    pub package_map_json: Option<String>,
    /// The child's MessagePort object (created in parent context).
    /// Stored here so it can be set into the child's FinoState after context
    /// creation, and later read via `internal:realm-bridge.getPort()`.
    pub port: Option<v8::Global<v8::Value>>,
}

/// Slot in the parent's `child_contexts` Vec.
pub enum ChildRealmSlot {
    /// Creation queued but not yet processed by `process_pending_creates`.
    Pending,
    /// Created and running — step returns the child's loop bool.
    Active(ChildRealm),
    /// Creation failed — `stepContext` immediately returns false.
    Failed,
}

/// The source code for a specific provider module in a Realm.
///
/// `FinoState::providers` maps specifiers to their configured provider.
/// `Some(ProviderConfig)` means use this source for the specifier.
/// `None` means the specifier is blocked for user code in this Realm.
/// Specifiers not in the map fall through to the static `BUILTINS` array.
#[derive(Clone)]
pub struct ProviderConfig {
    pub code: String,
    pub source_map: String,
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
    pub root_queue: v8::UniqueRef<v8::MicrotaskQueue>,

    // ---------------------------------------------------------------------------
    // Per-Realm provider configuration
    // ---------------------------------------------------------------------------
    /// Authoritative provider map for this Realm. Each entry is the definitive
    /// provider for that specifier:
    ///   `Some(ProviderConfig)` — use this source as the module implementation.
    ///   `None` — specifier is blocked for user code in this Realm.
    /// Specifiers absent from the map fall through to the static BUILTINS array.
    /// Children inherit the parent's full map and can override individual entries.
    pub providers: HashMap<String, Option<ProviderConfig>>,

    // ---------------------------------------------------------------------------
    // Module caches
    // ---------------------------------------------------------------------------
    /// Compiled builtin modules keyed by specifier string.
    /// Uses `String` (not `&'static str`) so dynamic override specifiers can
    /// also be cached alongside static BUILTINS entries.
    pub builtin_cache: HashMap<String, v8::Global<v8::Module>>,
    pub fs_cache: HashMap<PathBuf, v8::Global<v8::Module>>,
    /// Script IDs of source builtin modules (for `internal:*` access restriction).
    /// Synthetic modules return `None` from `module.script_id()` and are never
    /// the referrer in a resolve callback.
    pub builtin_script_ids: HashSet<i32>,
    /// Reverse lookup from V8 script id to builtin specifier for source builtins.
    pub builtin_specifiers: HashMap<i32, &'static str>,

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

    // ---------------------------------------------------------------------------
    // V8 event loop callbacks (set by runLoop() from _main.mts via internal:async-context)
    // ---------------------------------------------------------------------------
    /// One host-safe loop step callback. Returns true to continue, false to exit.
    pub loop_step_fn: Option<v8::Global<v8::Function>>,
    /// Called by Rust after the event loop exits to run the post-loop error check.
    pub on_done_fn: Option<v8::Global<v8::Function>>,

    // ---------------------------------------------------------------------------
    // Pending synchronous call (set by JS scheduleSync() from internal:async-context)
    // ---------------------------------------------------------------------------
    /// Function to call from outside the microtask checkpoint (so spin() works).
    pub sync_call_fn: Option<v8::Global<v8::Function>>,
    /// Promise resolver to settle after calling sync_call_fn.
    pub sync_call_resolver: Option<v8::Global<v8::PromiseResolver>>,

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

    // ---------------------------------------------------------------------------
    // Child Realm management
    // ---------------------------------------------------------------------------
    /// Child Realm slot table. Indexed by the handle returned to JS.
    ///
    /// - `Pending` — slot allocated by `native_create_context`; the host loop
    ///   will call `process_pending_creates` to upgrade it to `Active`.
    /// - `Active` — context created and running.
    /// - `Failed` — creation failed; `stepContext` returns false immediately.
    pub child_contexts: Vec<ChildRealmSlot>,

    /// Deferred context-creation requests drained between host-loop iterations
    /// when a bare `HandleScope<()>` is available.
    pub pending_creates: Vec<PendingRealm>,

    /// Live thread realm handles indexed by the JS handle returned from
    /// `createThreadContext`. Slot is `None` when the thread has exited and the
    /// handle has been reaped.
    // `allow(dead_code)`: used by `realm.rs` native functions via `crate::state`.
    #[allow(dead_code)]
    pub thread_contexts: Vec<Option<crate::thread_realm::ThreadRealmHandle>>,

    /// Entry module path for child Realms. Set by `createContext` before
    /// evaluating `_bootstrap.mjs` in the child context. The child's bootstrap
    /// reads this via `internal:realm-bridge.getEntryPath()`.
    pub entry_path: Option<String>,

    /// Termination flag for child Realms. The parent sets this to `true` via
    /// `terminateChild()` from `internal:realm-native`. The child's `isDone`
    /// callback checks this via `internal:realm-bridge.isTerminated()`.
    pub terminated: bool,

    /// The child's MessagePort object, passed by the parent at creation time.
    /// Read-only after bootstrap; accessed via `internal:realm-bridge.getPort()`.
    pub port: Option<v8::Global<v8::Value>>,

    // ---------------------------------------------------------------------------
    // Thread Realm channels (populated only in thread-realm Isolates)
    // ---------------------------------------------------------------------------
    // `allow(dead_code)`: used by Phase 3 native send/recv functions.
    #[allow(dead_code)]
    /// Receives serialized messages sent from the partner Isolate.
    pub channel_rx: Option<std::sync::mpsc::Receiver<crate::thread_realm::ThreadMessage>>,
    #[allow(dead_code)]
    /// Sends serialized messages to the partner Isolate.
    pub channel_tx: Option<std::sync::mpsc::Sender<crate::thread_realm::ThreadMessage>>,
    #[allow(dead_code)]
    /// Own wake-pipe read end — registered with the event loop; readable when
    /// the partner has deposited a message in `channel_rx`.
    pub wake_read_fd: Option<std::os::unix::io::RawFd>,
    #[allow(dead_code)]
    /// Partner's wake-pipe write end — write 1 byte here after each
    /// `channel_tx.send()` to unblock the partner's event-loop wait.
    pub wake_write_fd: Option<std::os::unix::io::RawFd>,
}

/// Retrieve the state `Rc` from the current V8 context's slot.
///
/// # Panics
/// Panics if called outside a scope that has a context with an initialised
/// `FinoState`.
pub fn get_state(scope: &mut v8::HandleScope) -> Rc<RefCell<FinoState>> {
    scope
        .get_current_context()
        .get_slot::<RefCell<FinoState>>()
        .expect("FinoState not initialised in context slot")
}

/// Get a raw pointer to the root microtask queue.
///
/// # Safety
/// See `loop_queue_ptr`.
pub unsafe fn root_queue_ptr(state_rc: &Rc<RefCell<FinoState>>) -> *const v8::MicrotaskQueue {
    let st = state_rc.borrow();
    &*st.root_queue as *const v8::MicrotaskQueue
}
