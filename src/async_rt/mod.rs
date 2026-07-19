//! Per-isolate async executor + thread-pool offload for blocking FFI calls.
//!
//! Architecture:
//! - One `LocalExecutor` per V8 isolate, swapped into thread-local ownership
//!   whenever a reactor activates that isolate.
//! - A process-global blocking pool (`blocking` crate) for sync→async FFI offload.
//! - A [`WakeSink`] per isolate: background threads call `wake()` when FFI work
//!   completes. Root/process hosts may use a self-pipe byte; reactor realms
//!   upgrade the sink in place to
//!   a cherenkov Notifier post — no pipe traffic at all.
//! - Per-realm `pending_resolutions` (in `FinoState`): futures push completed
//!   `JsValueRepr` + resolver here; `drain_pending` converts + resolves them
//!   with a live scope.

pub mod blocking;
pub mod bridge;
pub mod js_calls;

use std::{
    cell::RefCell,
    os::unix::io::RawFd,
    sync::{Arc, Mutex, RwLock},
};

use ::v8;

pub use bridge::PendingResolution;

// ---------------------------------------------------------------------------
// Wake sink — the one cross-thread wake channel for an isolate
// ---------------------------------------------------------------------------

/// How a background thread wakes an isolate's event loop. Every isolate starts
/// with its self-pipe as the sink; a reactor-backed realm upgrades it once to a
/// cherenkov [`Notifier`](cherenkov::Notifier) post — clones already captured
/// by background threads pick the upgrade up through the shared `OnceLock`.
#[derive(Clone)]
pub struct WakeSink(Arc<WakeSinkInner>);

struct WakeSinkInner {
    /// Write end of the isolate's self-pipe, owned here (closed on last drop)
    /// so background threads holding clones can never write a recycled fd.
    pipe_write: RawFd,
    /// Current reactor route. A parked isolate may replace it when it moves.
    notifier: RwLock<Option<(cherenkov::Notifier, u64)>>,
}

impl Drop for WakeSinkInner {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.pipe_write);
        }
    }
}

impl WakeSink {
    fn new(pipe_write: RawFd) -> WakeSink {
        WakeSink(Arc::new(WakeSinkInner {
            pipe_write,
            notifier: RwLock::new(None),
        }))
    }

    /// Wake the isolate's loop. Callable from any thread. A post into a
    /// dropped reactor returns false and falls back to the pipe byte — the
    /// same shutdown-race envelope the raw pipe write always had (SIGPIPE is
    /// ignored process-wide; a failed write is harmless).
    pub fn wake(&self) {
        if let Some((notifier, user_data)) = self.0.notifier.read().unwrap().as_ref()
            && notifier.post(*user_data, 0)
        {
            return;
        }
        unsafe {
            libc::write(self.0.pipe_write, b"\x01".as_ptr() as *const _, 1);
        }
    }

    /// Route the sink to a reactor Notifier post. Replacing the route is safe:
    /// background producers hold this shared cell rather than a notifier copy.
    pub fn install_notifier(&self, notifier: cherenkov::Notifier, user_data: u64) -> bool {
        *self.0.notifier.write().unwrap() = Some((notifier, user_data));
        true
    }

    pub fn notifier_installed(&self) -> bool {
        self.0.notifier.read().unwrap().is_some()
    }
}

// ---------------------------------------------------------------------------
// FFI completion (from background threads)
// ---------------------------------------------------------------------------

/// A completed async FFI call waiting to be converted to a JS Promise resolution.
/// Uses a `resolver_id` instead of `v8::Global` so this type is `Send`.
pub struct FfiCompletion {
    /// Index into the thread-local `RESOLVER_TABLE` on the isolate's thread.
    pub resolver_id: usize,
    pub result: Result<RawFfiResult, String>,
}

// FfiCompletion is fully Send: resolver_id is usize, RawFfiResult is all Copy.

/// The raw return value from an async FFI call (stored as bytes + type tag).
pub struct RawFfiResult {
    pub result_type: crate::ffi::types::NativeType,
    /// Raw 8-byte return value. For types smaller than 8 bytes only the
    /// low bytes are used; for pointer types this holds a `usize`.
    pub bytes: [u8; 8],
    /// Raw aggregate return bytes for by-value struct results.
    pub aggregate: Option<Vec<u8>>,
}

// ---------------------------------------------------------------------------
// External-view release (from backing-store deleters, any thread)
// ---------------------------------------------------------------------------

/// A released `Pointer.view` external ArrayBuffer. Backing-store deleters run
/// on arbitrary threads (GC, background), so they enqueue one of these and
/// wake the loop; the V8 thread invokes the `onRelease` callback during drain.
pub struct ViewRelease {
    /// Slot in the `js_calls` callback table for the JS `onRelease` function,
    /// if one was supplied to `Pointer.view`.
    pub callback_id: Option<usize>,
    /// Byte length of the released view, for external-memory accounting.
    pub byte_length: usize,
}

/// Shared queue of pending view releases, cloned into backing-store deleters.
pub type ViewReleaseQueue = Arc<Mutex<Vec<ViewRelease>>>;

// ---------------------------------------------------------------------------
// Isolate-owned resolver table — background work carries only numeric ids
// ---------------------------------------------------------------------------

/// Store a resolver and return its slot index (called from the main thread).
pub fn push_resolver(resolver: v8::Global<v8::PromiseResolver>) -> usize {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let table = &mut state
            .as_mut()
            .expect("async_rt::init() not called")
            .resolver_table;
        let id = table.len();
        table.push(Some(resolver));
        id
    })
}

/// Take a resolver by its slot index (called from the main thread during drain).
fn take_resolver(id: usize) -> Option<v8::Global<v8::PromiseResolver>> {
    STATE.with(|state| {
        state
            .borrow_mut()
            .as_mut()?
            .resolver_table
            .get_mut(id)?
            .take()
    })
}

/// Resolve a reactor-engine I/O completion: take the resolver stored by
/// `push_resolver` and settle its promise with `result` (a byte count, negative
/// for `-errno`). Called by the engine during a pump with the owning isolate
/// entered. A no-op if the resolver was already taken (double completion).
pub(crate) fn resolve_io_completion(scope: &mut v8::HandleScope, resolver_id: usize, result: f64) {
    if let Some(g) = take_resolver(resolver_id) {
        let resolver = v8::Local::new(scope, &g);
        let val = v8::Number::new(scope, result);
        resolver.resolve(scope, val.into());
    }
}

// ---------------------------------------------------------------------------
// Per-isolate async state (thread-local)
// ---------------------------------------------------------------------------

/// State associated with one V8 isolate / thread.
pub struct IsolateAsyncState {
    /// Single-threaded async executor. Only polled from the main thread via
    /// `try_tick()`. Drives `promise_to_future` futures.
    pub executor: async_executor::LocalExecutor<'static>,
    /// Completed async FFI calls waiting to be resolved into JS promises.
    pub completions: Arc<Mutex<Vec<FfiCompletion>>>,
    /// Pending cross-thread JS callback invocations (from `FfiCallback` trampolines).
    pub js_call_requests: Arc<Mutex<Vec<js_calls::JsCallRequest>>>,
    /// Released `Pointer.view` external buffers awaiting their `onRelease`
    /// callback (fire-and-forget; deleters never block or touch V8).
    pub view_releases: Arc<Mutex<Vec<ViewRelease>>>,
    /// Read end of the self-pipe. JS registers this with `loop.readable(fd)`
    /// so kqueue/io_uring wakes when an async FFI call completes.
    pub wake_read: RawFd,
    /// The cross-thread wake channel: background threads call `wake()` on a
    /// clone (pipe byte by default, Notifier post once a reactor claims it).
    /// Owns the pipe's write end.
    pub wake_sink: WakeSink,
    /// Promise resolvers belong to the isolate, not the OS thread currently
    /// pumping it. Keeping the table here lets a parked isolate migrate.
    resolver_table: Vec<Option<v8::Global<v8::PromiseResolver>>>,
    /// FFI callback handles follow the isolate for the same reason.
    callback_table: Vec<Option<v8::Global<v8::Function>>>,
}

impl Drop for IsolateAsyncState {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.wake_read);
        }
        // wake_write closes when the last WakeSink clone drops.
    }
}

thread_local! {
    static STATE: RefCell<Option<IsolateAsyncState>> = const { RefCell::new(None) };
}

/// Build a fresh, detached `IsolateAsyncState` (its own self-pipe + executor +
/// queues) without installing it as the current thread-local state.
///
/// Used to give a reactor-hosted realm isolate its *own* async state, stored
/// alongside its isolate handle. The reactor swaps it into the thread-local
/// (via [`swap_state`]) around each pump so the isolate's FFI completions,
/// executor, and wake pipe stay with that isolate — never shared with the
/// reactor's own state or sibling realm isolates on the same thread.
pub fn new_state() -> IsolateAsyncState {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(ret, 0, "pipe(2) failed");

    // Set O_NONBLOCK on both ends so reads/writes never block.
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }

    IsolateAsyncState {
        executor: async_executor::LocalExecutor::new(),
        completions: Arc::new(Mutex::new(Vec::new())),
        js_call_requests: Arc::new(Mutex::new(Vec::new())),
        view_releases: Arc::new(Mutex::new(Vec::new())),
        wake_read: fds[0],
        wake_sink: WakeSink::new(fds[1]),
        resolver_table: Vec::new(),
        callback_table: Vec::new(),
    }
}

pub(crate) fn with_callback_table<R>(
    f: impl FnOnce(&mut Vec<Option<v8::Global<v8::Function>>>) -> R,
) -> R {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        f(&mut state
            .as_mut()
            .expect("async_rt::init() not called")
            .callback_table)
    })
}

/// Swap the current thread-local async state, returning the previous one.
///
/// The scheduler pumps a tenant isolate by entering it and swapping in that
/// isolate's state (`swap_state(Some(tenant))`), pumping, then restoring its own
/// (`swap_state(saved)`). Every `STATE.with(...)` accessor below then transparently
/// resolves to whichever isolate is currently active.
pub fn swap_state(new: Option<IsolateAsyncState>) -> Option<IsolateAsyncState> {
    STATE.with(|s| std::mem::replace(&mut *s.borrow_mut(), new))
}

/// Initialize the per-isolate async state. Call once per isolate, before the
/// event loop starts. Returns the wake-pipe read fd to expose to JS.
pub fn init() -> RawFd {
    let state = new_state();
    let wake_read = state.wake_read;
    STATE.with(|s| *s.borrow_mut() = Some(state));
    wake_read
}

/// Tear down the per-isolate async state (pipes closed via Drop).
#[allow(dead_code)]
pub fn shutdown() {
    STATE.with(|s| {
        *s.borrow_mut() = None;
    });
}

/// Returns true when called from the V8 isolate thread (i.e. `init()` has been called here).
/// Used by `FfiCallback` trampolines to detect same-thread calls that would deadlock.
pub fn is_v8_thread() -> bool {
    STATE.with(|s| s.borrow().is_some())
}

/// Get the wake-pipe read fd (for `internal:async-runtime` to export as `wakeFd`).
pub fn get_wake_read_fd() -> i32 {
    STATE.with(|s| s.borrow().as_ref().map(|st| st.wake_read).unwrap_or(-1))
}

/// Get the completions queue + wake sink (for submitting async FFI work).
/// Returns None if `init()` hasn't been called on this thread.
pub fn completion_handle() -> Option<(Arc<Mutex<Vec<FfiCompletion>>>, WakeSink)> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.completions), st.wake_sink.clone()))
    })
}

/// Get the JS-call-request queue + wake sink (for `FfiCallback` trampolines).
/// Returns None if `init()` hasn't been called on this thread.
pub fn js_call_handle() -> Option<(Arc<Mutex<Vec<js_calls::JsCallRequest>>>, WakeSink)> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.js_call_requests), st.wake_sink.clone()))
    })
}

/// Get the view-release queue + wake sink (for `Pointer.view` backing-store
/// deleters). Returns None if `init()` hasn't been called on this thread.
pub fn release_handle() -> Option<(ViewReleaseQueue, WakeSink)> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.view_releases), st.wake_sink.clone()))
    })
}

/// The current isolate's wake sink (for waking this isolate from another
/// thread — e.g. reactor-engine load reports waking the orchestrator).
pub fn wake_sink() -> Option<WakeSink> {
    STATE.with(|s| s.borrow().as_ref().map(|st| st.wake_sink.clone()))
}

/// Upgrade the current isolate's wake sink to a reactor Notifier post.
/// Returns false if a reactor already claimed it.
pub fn install_wake_notifier(notifier: cherenkov::Notifier, user_data: u64) -> bool {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| st.wake_sink.install_notifier(notifier, user_data))
            .unwrap_or(false)
    })
}

/// Whether the current isolate's wakes already post into a reactor.
pub fn wake_notifier_installed() -> bool {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| st.wake_sink.notifier_installed())
            .unwrap_or(false)
    })
}

/// Poll the executor once. Returns true if a task ran.
pub fn try_tick() -> bool {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| st.executor.try_tick())
            .unwrap_or(false)
    })
}

/// Spawn a future on the current isolate's executor.
pub fn spawn<F>(fut: F)
where
    F: std::future::Future<Output = ()> + 'static,
{
    STATE.with(|s| {
        let borrow = s.borrow();
        let st = borrow.as_ref().expect("async_rt::init() not called");
        st.executor.spawn(fut).detach();
    });
}

// ---------------------------------------------------------------------------
// Drain loop — called from pump_and_checkpoint
// ---------------------------------------------------------------------------

/// Drain all async FFI completions, JS call requests, and per-realm pending
/// resolutions for the given scope. Returns true if anything was drained.
pub fn drain_all(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    let mut progress = false;
    progress |= drain_ffi_completions(scope);
    progress |= drain_js_call_requests(scope);
    progress |= drain_view_releases(scope);
    progress |= drain_pending_resolutions(scope, state_rc);
    progress |= crate::reactor::engine::drain_report_wakes(scope);
    progress
}

/// Invoke `onRelease` callbacks for external views whose backing stores were
/// freed, and roll back their external-memory accounting.
fn drain_view_releases(scope: &mut v8::HandleScope) -> bool {
    let releases: Vec<ViewRelease> = STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| {
                let mut q = st.view_releases.lock().unwrap();
                std::mem::take(&mut *q)
            })
            .unwrap_or_default()
    });

    if releases.is_empty() {
        return false;
    }

    for release in releases {
        scope.adjust_amount_of_external_allocated_memory(-(release.byte_length as i64));
        let Some(id) = release.callback_id else {
            continue;
        };
        let Some(global) = js_calls::take_callback(id) else {
            continue;
        };
        let func = v8::Local::new(scope, &global);
        let recv: v8::Local<v8::Value> = v8::undefined(scope).into();
        let tc = &mut v8::TryCatch::new(scope);
        if func.call(tc, recv, &[]).is_none() && tc.has_caught() {
            let msg = tc
                .exception()
                .map(|e| e.to_rust_string_lossy(tc))
                .unwrap_or_else(|| "unknown exception".into());
            eprintln!("fino: Pointer.view onRelease callback threw: {msg}");
        }
    }
    true
}

/// Take all pending JS call requests from the queue and process them.
fn drain_js_call_requests(scope: &mut v8::HandleScope) -> bool {
    let requests: Vec<js_calls::JsCallRequest> = STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| {
                let mut q = st.js_call_requests.lock().unwrap();
                std::mem::take(&mut *q)
            })
            .unwrap_or_default()
    });
    js_calls::process_requests(scope, requests)
}

/// Read all bytes from the wake pipe (non-blocking) and drain the FfiCompletion
/// queue, resolving each promise with the FFI result.
fn drain_ffi_completions(scope: &mut v8::HandleScope) -> bool {
    // Drain the wake pipe until empty (non-blocking; ignore errors if empty).
    STATE.with(|s| {
        if let Some(st) = s.borrow().as_ref() {
            let mut buf = [0u8; 64];
            loop {
                let n = unsafe { libc::read(st.wake_read, buf.as_mut_ptr() as *mut _, 64) };
                if n <= 0 {
                    break;
                }
            }
        }
    });

    let completions: Vec<FfiCompletion> = STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| {
                let mut q = st.completions.lock().unwrap();
                std::mem::take(&mut *q)
            })
            .unwrap_or_default()
    });

    if completions.is_empty() {
        return false;
    }

    for completion in completions {
        let global = match take_resolver(completion.resolver_id) {
            Some(g) => g,
            None => continue,
        };
        let resolver = v8::Local::new(scope, &global);
        match completion.result {
            Ok(raw) => {
                if let Some(val) = raw_to_v8(scope, &raw) {
                    let _ = resolver.resolve(scope, val);
                }
            }
            Err(msg) => {
                if let Some(msg_str) = v8::String::new(scope, &msg) {
                    let exc = v8::Exception::error(scope, msg_str);
                    let _ = resolver.reject(scope, exc);
                }
            }
        }
    }
    true
}

/// Drain pending resolutions for one reactor-hosted realm.
fn drain_pending_resolutions(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    drain_pending_for(scope, state_rc)
}

/// Drain pending_resolutions from a single realm's FinoState.
fn drain_pending_for(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    let pending: Vec<PendingResolution> = {
        let st = state_rc.borrow();
        let mut inner = st.pending_resolutions.borrow_mut();
        std::mem::take(&mut *inner)
    };
    if pending.is_empty() {
        return false;
    }
    for res in pending {
        let resolver = v8::Local::new(scope, &res.resolver);
        match res.result {
            Ok(repr) => {
                let val = repr.into_v8(scope);
                let _ = resolver.resolve(scope, val);
            }
            Err(repr) => {
                let val = repr.into_v8(scope);
                let _ = resolver.reject(scope, val);
            }
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Raw FFI result → v8::Local<v8::Value>
// ---------------------------------------------------------------------------

fn raw_to_v8<'s>(
    scope: &mut v8::HandleScope<'s>,
    raw: &RawFfiResult,
) -> Option<v8::Local<'s, v8::Value>> {
    use crate::ffi::types::NativeType;
    let b = raw.bytes;
    Some(match raw.result_type {
        NativeType::Void => v8::undefined(scope).into(),
        NativeType::Bool => v8::Boolean::new(scope, b[0] != 0).into(),
        NativeType::U8 => v8::Integer::new_from_unsigned(scope, b[0] as u32).into(),
        NativeType::I8 => v8::Integer::new(scope, b[0] as i8 as i32).into(),
        NativeType::U16 => {
            v8::Integer::new_from_unsigned(scope, u16::from_le_bytes([b[0], b[1]]) as u32).into()
        }
        NativeType::I16 => v8::Integer::new(scope, i16::from_le_bytes([b[0], b[1]]) as i32).into(),
        NativeType::U32 => {
            v8::Integer::new_from_unsigned(scope, u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .into()
        }
        NativeType::I32 => {
            v8::Integer::new(scope, i32::from_le_bytes([b[0], b[1], b[2], b[3]])).into()
        }
        NativeType::U64 => {
            let v = u64::from_le_bytes(b);
            v8::BigInt::new_from_u64(scope, v).into()
        }
        NativeType::I64 => {
            let v = i64::from_le_bytes(b);
            v8::BigInt::new_from_i64(scope, v).into()
        }
        NativeType::USize | NativeType::USizeBig => {
            let v = usize::from_le_bytes(b);
            v8::BigInt::new_from_u64(scope, v as u64).into()
        }
        NativeType::ISize | NativeType::ISizeBig => {
            let v = isize::from_le_bytes(b);
            v8::BigInt::new_from_i64(scope, v as i64).into()
        }
        NativeType::F32 => {
            let v = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            v8::Number::new(scope, v as f64).into()
        }
        NativeType::F64 => {
            let v = f64::from_le_bytes(b);
            v8::Number::new(scope, v).into()
        }
        NativeType::Struct(_) => {
            let bytes = raw.aggregate.as_deref().unwrap_or(&[]);
            let ab = v8::ArrayBuffer::new(scope, bytes.len());
            if let Some(dst) = ab.get_backing_store().data() {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        bytes.as_ptr(),
                        dst.as_ptr() as *mut u8,
                        bytes.len(),
                    );
                }
            }
            ab.into()
        }
        NativeType::Pointer | NativeType::IgnoredPointer => {
            let v = usize::from_le_bytes(b) as *mut std::ffi::c_void;
            crate::ffi::pointer::into_js(scope, v)
        }
        // Buffer not supported as an async return type.
        NativeType::Buffer => {
            eprintln!("fino async_rt: buffer return type not supported for async FFI");
            v8::undefined(scope).into()
        }
    })
}
