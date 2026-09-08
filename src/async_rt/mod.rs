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
pub mod diagnostics;
pub mod js_calls;

use std::{
    cell::RefCell,
    os::fd::{FromRawFd, OwnedFd, RawFd},
    rc::Rc,
    sync::{Arc, Mutex},
};

use ::v8;

use crate::{fdutil::WakePipe, state::FinoState};

pub use bridge::PendingResolution;

// ---------------------------------------------------------------------------
// FFI completion (from background threads)
// ---------------------------------------------------------------------------

/// A completed async FFI call waiting to be converted to a JS Promise resolution.
/// Uses a `resolver_id` instead of `v8::Global` so this type is `Send`.
pub struct FfiCompletion {
    pub trace_id: u64,
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

/// A native producer retains both its origin queue and its notification pipe.
pub type NativeQueueHandle<T> = (Arc<Mutex<Vec<T>>>, Arc<WakePipe>);

/// Store a resolver and return its slot index.
///
/// The table belongs to the active isolate state rather than the OS thread so
/// a parked isolate can resume an FFI completion after moving to another pool
/// worker.
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

/// Take a resolver by its slot index while draining the active isolate.
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
    /// Shared with native completion producers and external-buffer finalizers.
    /// Both endpoints survive until the final borrower stops using the pipe.
    wake: Arc<WakePipe>,
    /// Promise resolvers for FFI completions submitted by this isolate.
    resolver_table: Vec<Option<v8::Global<v8::PromiseResolver>>>,
    /// JS callbacks registered by this isolate for native invocation.
    callback_table: Vec<Option<v8::Global<v8::Function>>>,
}

thread_local! {
    static STATE: RefCell<Option<IsolateAsyncState>> = const { RefCell::new(None) };
}

/// Build a detached async state for a parked isolate.
///
/// A scheduler swaps this state into the thread-local slot while it pumps the
/// owning isolate, keeping executors, completions, and wake pipes separate
/// between isolates that share one OS thread.
pub fn new_state() -> IsolateAsyncState {
    let mut fds = [0i32; 2];
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    assert_eq!(ret, 0, "pipe(2) failed");

    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }

    new_state_with_pipe(fds[0], fds[1])
}

/// Build a detached async state around an existing wake pipe.
///
/// Deferred workload initialization creates the pipe before the isolate so the
/// process loop can watch it immediately. Ownership of both descriptors moves
/// to the returned state.
pub fn new_state_with_pipe(wake_read: RawFd, wake_write: RawFd) -> IsolateAsyncState {
    IsolateAsyncState {
        executor: async_executor::LocalExecutor::new(),
        completions: Arc::new(Mutex::new(Vec::new())),
        js_call_requests: Arc::new(Mutex::new(Vec::new())),
        view_releases: Arc::new(Mutex::new(Vec::new())),
        // SAFETY: ownership of both fresh descriptors moves into this state.
        wake: Arc::new(WakePipe::from_owned_fds(
            unsafe { OwnedFd::from_raw_fd(wake_read) },
            unsafe { OwnedFd::from_raw_fd(wake_write) },
        )),
        resolver_table: Vec::new(),
        callback_table: Vec::new(),
    }
}

pub(crate) fn with_callback_table<R>(
    callback: impl FnOnce(&mut Vec<Option<v8::Global<v8::Function>>>) -> R,
) -> R {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        callback(
            &mut state
                .as_mut()
                .expect("async_rt::init() not called")
                .callback_table,
        )
    })
}

/// Install a parked isolate's async state and return the previous state.
pub fn swap_state(new: Option<IsolateAsyncState>) -> Option<IsolateAsyncState> {
    STATE.with(|state| std::mem::replace(&mut *state.borrow_mut(), new))
}

/// Initialize the per-isolate async state. Call once per isolate, before the
/// event loop starts. Returns the wake-pipe read fd to expose to JS.
pub fn init() -> RawFd {
    let state = new_state();
    let wake_read = state.wake.read_fd();
    STATE.with(|slot| *slot.borrow_mut() = Some(state));
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
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| st.wake.read_fd())
            .unwrap_or(-1)
    })
}

#[cfg(test)]
mod wake_lifetime_tests {
    #[test]
    fn completion_borrower_retains_wake_descriptor_after_realm_shutdown() {
        let previous = super::swap_state(Some(super::new_state()));
        let (_, wake) = super::completion_handle().unwrap();
        let (_, callback_wake) = super::js_call_handle().unwrap();
        let (_, release_wake) = super::release_handle().unwrap();
        drop(super::swap_state(previous));
        assert!(
            unsafe { libc::fcntl(wake.read_fd(), libc::F_GETFD) } >= 0,
            "a late native completion must not write through a recycled descriptor"
        );
        let successor = crate::fdutil::WakePipe::new().unwrap();
        wake.notify();
        callback_wake.notify();
        release_wake.notify();
        let mut bytes = [0u8; 3];
        assert_eq!(
            unsafe { libc::read(wake.read_fd(), bytes.as_mut_ptr().cast(), bytes.len()) },
            3,
            "all native producers still notify the original pipe"
        );
        assert_eq!(
            unsafe { libc::read(successor.read_fd(), bytes.as_mut_ptr().cast(), bytes.len()) },
            -1,
            "late notifications must not reach a successor"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EAGAIN)
        );
        let lifetime = std::sync::Arc::downgrade(&wake);
        drop((wake, callback_wake, release_wake));
        assert!(
            lifetime.upgrade().is_none(),
            "the final borrower releases the pipe"
        );
    }
}

/// Get the completions queue + retained wake pipe (for submitting async FFI work).
/// Returns None if `init()` hasn't been called on this thread.
pub fn completion_handle() -> Option<NativeQueueHandle<FfiCompletion>> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.completions), Arc::clone(&st.wake)))
    })
}

/// Get the JS-call-request queue + retained wake pipe (for `FfiCallback` trampolines).
/// Returns None if `init()` hasn't been called on this thread.
pub fn js_call_handle() -> Option<NativeQueueHandle<js_calls::JsCallRequest>> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.js_call_requests), Arc::clone(&st.wake)))
    })
}

/// Get the view-release queue + retained wake pipe (for `Pointer.view` backing-store
/// deleters). Returns None if `init()` hasn't been called on this thread.
pub fn release_handle() -> Option<NativeQueueHandle<ViewRelease>> {
    STATE.with(|s| {
        s.borrow()
            .as_ref()
            .map(|st| (Arc::clone(&st.view_releases), Arc::clone(&st.wake)))
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
    scope: &mut v8::PinScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    let mut progress = false;
    progress |= drain_ffi_completions(scope);
    progress |= drain_js_call_requests(scope);
    progress |= drain_view_releases(scope);
    progress |= drain_pending_resolutions(scope, state_rc);
    progress
}

/// Invoke `onRelease` callbacks for external views whose backing stores were
/// freed, and roll back their external-memory accounting.
fn drain_view_releases(scope: &mut v8::PinScope) -> bool {
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
        v8::tc_scope!(tc, scope);
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
fn drain_js_call_requests(scope: &mut v8::PinScope) -> bool {
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
fn drain_ffi_completions(scope: &mut v8::PinScope) -> bool {
    // Drain the wake pipe (non-blocking; ignore errors if empty).
    STATE.with(|s| {
        if let Some(st) = s.borrow().as_ref() {
            let mut buf = [0u8; 64];
            unsafe { libc::read(st.wake.read_fd(), buf.as_mut_ptr() as *mut _, 64) };
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
            None => {
                diagnostics::finish(completion.trace_id, "resolver-missing");
                continue;
            }
        };
        diagnostics::finish(completion.trace_id, "resolver-consumed");
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

/// Drain pending_resolutions for the realm that owns this isolate.
///
/// Every realm is its own isolate under the reactor scheduler, so a realm's
/// resolutions are always reachable from its own context slot.
fn drain_pending_resolutions(
    scope: &mut v8::PinScope,
    state_rc: &std::rc::Rc<std::cell::RefCell<crate::state::FinoState>>,
) -> bool {
    drain_pending_for(scope, state_rc)
}

/// Drain pending_resolutions from a single realm's FinoState.
fn drain_pending_for(
    scope: &mut v8::PinScope,
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
    scope: &mut v8::PinScope<'s, '_>,
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

// ---------------------------------------------------------------------------
// Scheduled sync-call servicing (shared by all host event loops)
// ---------------------------------------------------------------------------

/// Service one pending synchronous call scheduled by JS via `scheduleSync()`
/// (internal:async-context).
///
/// Takes `sync_call_fn`/`sync_call_resolver` from `state`, calls the function
/// under a fresh `TryCatch`, and resolves or rejects the stored promise
/// resolver with the result. Returns `true` when a call was serviced, `false`
/// when nothing was pending.
///
/// This is shared by the main-realm loop (`runtime.rs`), the child-isolate
/// loop (`realm/child.rs`), and the reactor scheduler (`scheduler_native.rs`)
/// so the call/settle ordering stays identical everywhere.
pub fn service_scheduled_sync_call(
    scope: &mut v8::PinScope,
    state: &Rc<RefCell<FinoState>>,
) -> bool {
    let (maybe_fn, maybe_resolver) = {
        let mut state = state.borrow_mut();
        (state.sync_call_fn.take(), state.sync_call_resolver.take())
    };
    let (Some(fn_ref), Some(resolver_ref)) = (maybe_fn, maybe_resolver) else {
        return false;
    };
    let call_result: Result<v8::Global<v8::Value>, v8::Global<v8::Value>> = {
        let receiver: v8::Local<v8::Value> = v8::undefined(scope).into();
        v8::tc_scope!(tc, scope);
        let function = v8::Local::new(tc, &fn_ref);
        match function.call(tc, receiver, &[]) {
            Some(result) => Ok(v8::Global::new(tc, result)),
            None => {
                let exception = tc.exception().unwrap_or_else(|| v8::undefined(tc).into());
                Err(v8::Global::new(tc, exception))
            }
        }
    };
    let resolver = v8::Local::new(scope, &resolver_ref);
    match call_result {
        Ok(result) => {
            let result = v8::Local::new(scope, &result);
            let _ = resolver.resolve(scope, result);
        }
        Err(exception) => {
            let exception = v8::Local::new(scope, &exception);
            let _ = resolver.reject(scope, exception);
        }
    }
    true
}
