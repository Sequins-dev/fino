//! Per-isolate async executor + thread-pool offload for blocking FFI calls.
//!
//! Architecture:
//! - One `LocalExecutor` per V8 isolate (stored in a thread-local). Same-thread
//!   embedded child realms share the executor — they're cooperative and can't
//!   run in parallel anyway.
//! - A process-global blocking pool (`blocking` crate) for sync→async FFI offload.
//! - A self-pipe per isolate: background threads write 1 byte when FFI work
//!   completes; JS registers the read end with `loop.readable(fd)` so kqueue
//!   wakes up immediately rather than waiting for a timeout.
//! - Per-realm `pending_resolutions` (in `FinoState`): futures push completed
//!   `JsValueRepr` + resolver here; `drain_pending` converts + resolves them
//!   with a live scope.

pub mod blocking;
pub mod bridge;
pub mod js_calls;

use std::{
    cell::RefCell,
    os::unix::io::RawFd,
    sync::{Arc, Mutex},
};

use ::v8;

pub use bridge::PendingResolution;

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
// Thread-local resolver table — bridges non-Send v8::Global across threads
// ---------------------------------------------------------------------------

thread_local! {
    /// Stores `v8::Global<PromiseResolver>` values by index. The background
    /// thread stores only the index (a plain `usize`) in `FfiCompletion`; the
    /// main thread retrieves and consumes the resolver when draining.
    static RESOLVER_TABLE: RefCell<Vec<Option<v8::Global<v8::PromiseResolver>>>> =
        const { RefCell::new(Vec::new()) };
}

/// Store a resolver and return its slot index (called from the main thread).
pub fn push_resolver(resolver: v8::Global<v8::PromiseResolver>) -> usize {
    RESOLVER_TABLE.with(|t| {
        let mut table = t.borrow_mut();
        let id = table.len();
        table.push(Some(resolver));
        id
    })
}

/// Take a resolver by its slot index (called from the main thread during drain).
fn take_resolver(id: usize) -> Option<v8::Global<v8::PromiseResolver>> {
    RESOLVER_TABLE.with(|t| t.borrow_mut().get_mut(id)?.take())
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
    /// Read end of the self-pipe. JS registers this with `loop.readable(fd)`
    /// so kqueue/io_uring wakes when an async FFI call completes.
    pub wake_read: RawFd,
    /// Write end of the self-pipe. Background threads write here on FFI completion.
    pub wake_write: RawFd,
}

impl Drop for IsolateAsyncState {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.wake_read);
            libc::close(self.wake_write);
        }
    }
}

thread_local! {
    static STATE: RefCell<Option<IsolateAsyncState>> = const { RefCell::new(None) };
}

/// Initialize the per-isolate async state. Call once per isolate, before the
/// event loop starts. Returns the wake-pipe read fd to expose to JS.
pub fn init() -> RawFd {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(ret, 0, "pipe(2) failed");

    // Set O_NONBLOCK on both ends so reads/writes never block.
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }

    let wake_read = fds[0];
    let wake_write = fds[1];

    STATE.with(|s| {
        *s.borrow_mut() = Some(IsolateAsyncState {
            executor: async_executor::LocalExecutor::new(),
            completions: Arc::new(Mutex::new(Vec::new())),
            js_call_requests: Arc::new(Mutex::new(Vec::new())),
            wake_read,
            wake_write,
        });
    });

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

/// Get the completions queue + write fd (for submitting async FFI work).
/// Returns None if `init()` hasn't been called on this thread.
pub fn completion_handle() -> Option<(Arc<Mutex<Vec<FfiCompletion>>>, RawFd)> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.completions), st.wake_write))
    })
}

/// Get the JS-call-request queue + write fd (for `FfiCallback` trampolines).
/// Returns None if `init()` hasn't been called on this thread.
pub fn js_call_handle() -> Option<(Arc<Mutex<Vec<js_calls::JsCallRequest>>>, RawFd)> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.js_call_requests), st.wake_write))
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
    progress |= drain_pending_resolutions(scope, state_rc);
    progress
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
    // Drain the wake pipe (non-blocking; ignore errors if empty).
    STATE.with(|s| {
        if let Some(st) = s.borrow().as_ref() {
            let mut buf = [0u8; 64];
            unsafe { libc::read(st.wake_read, buf.as_mut_ptr() as *mut _, 64) };
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

/// Drain pending_resolutions from the root realm and all embedded children.
fn drain_pending_resolutions(
    scope: &mut v8::HandleScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    let mut progress = false;
    progress |= drain_pending_for(scope, state_rc);
    // Walk embedded child contexts.
    let child_count = state_rc.borrow().child_contexts.len();
    for i in 0..child_count {
        let maybe_ctx = {
            let st = state_rc.borrow();
            match &st.child_contexts[i] {
                crate::state::ChildRealmSlot::Active(child) => {
                    Some(v8::Local::new(scope, &child.context))
                }
                _ => None,
            }
        };
        if let Some(ctx) = maybe_ctx {
            let child_scope = &mut v8::ContextScope::new(scope, ctx);
            let child_state = crate::state::get_state(child_scope);
            progress |= drain_pending_for(child_scope, &child_state);
        }
    }
    progress
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
        NativeType::USize => {
            let v = usize::from_le_bytes(b);
            v8::BigInt::new_from_u64(scope, v as u64).into()
        }
        NativeType::ISize => {
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
