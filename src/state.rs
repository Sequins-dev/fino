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

/// All per-run state, stored in the V8 context slot so every Rust callback can
/// access it without passing extra arguments.
pub struct FinoState {
    pub root: PathBuf,
    pub package_map_json: Option<String>,

    // ---------------------------------------------------------------------------
    // Async context slots (CPED-based)
    // ---------------------------------------------------------------------------
    /// Number of allocated slots. The live frame is the JS Array stored as CPED.
    pub slot_count: u32,
    /// Snapshot store: index = handle, value = a captured frame array.
    pub snapshot_store: Vec<v8::Global<v8::Value>>,

    // ---------------------------------------------------------------------------
    // Microtask queue
    // ---------------------------------------------------------------------------
    /// The context's single microtask queue.
    pub root_queue: v8::UniqueRef<v8::MicrotaskQueue>,

    // ---------------------------------------------------------------------------
    // Module caches
    // ---------------------------------------------------------------------------
    pub builtin_cache: HashMap<&'static str, v8::Global<v8::Module>>,
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
