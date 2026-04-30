#![allow(dead_code)]
//! Thread Realm infrastructure.
//!
//! Spawns a separate OS thread with its own `v8::Isolate`, bootstrapping
//! `_bootstrap.mjs` and running a full host loop.  Bidirectional messaging
//! uses `mpsc` channels paired with POSIX wake pipes for kqueue/io_uring
//! integration: after each `channel_tx.send()` the sender writes 1 byte to
//! the receiver's wake pipe, which the receiver's event loop watches via
//! `EVFILT_READ` / `io_uring POLL`.
//!
//! ## Lifecycle
//!
//! 1. Parent calls `spawn_thread_realm(config)`.
//! 2. `spawn_thread_realm` creates two mpsc channel pairs and two wake pipes,
//!    packages everything into `IsolateConfig`, and spawns a thread that runs
//!    `run_thread_isolate`.
//! 3. The thread bootstraps its own `v8::Isolate`, evaluates `_bootstrap.mjs`
//!    (same as same-Isolate child realms), and runs its own host loop.
//! 4. When the thread's loop exits it returns `Ok(())` (or `Err(msg)` on error).
//! 5. The parent retains a `ThreadRealmHandle` with the send half of the
//!    channel and the child's wake-pipe write end for sending messages, plus
//!    the receive half and parent wake-pipe read end for receiving.

use std::{
    os::unix::io::RawFd,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use ::v8;

use crate::state::{ImportRule, get_state};

/// Info shipped alongside a message for each transferred MessagePort.
///
/// The receiver uses `handle` to look up the Q-half transit channel and
/// `wake_read_fd` to register with the event loop via `loop.readable()`.
#[derive(Debug)]
pub struct TransferredPortInfo {
    pub handle: u32,
    pub wake_read_fd: i32,
}

/// A message transmitted across thread-realm boundaries.
///
/// `data` is the V8 ValueSerializer wire format for the message value.
/// `transfer_stores` holds raw bytes for each transferred ArrayBuffer.
/// `transfer_ports` carries transit channel info for each transferred
/// MessagePort so the receiver can reconstruct a live cross-thread port.
#[derive(Debug)]
pub struct ThreadMessage {
    pub data: Vec<u8>,
    pub transfer_stores: Vec<Vec<u8>>,
    pub transfer_ports: Vec<TransferredPortInfo>,
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Caller-supplied configuration for a new thread realm.
pub struct SpawnConfig {
    pub process_env: crate::state::ProcessEnv,
    pub entry_path: String,
    pub import_rules: Vec<ImportRule>,
    pub package_map_json: Option<String>,
}

/// Returned to the parent after a thread realm is spawned.
///
/// The parent holds the send/receive ends for messaging the child and
/// registers `parent_wake_read` with its own event loop to detect inbound
/// messages.
pub struct ThreadRealmHandle {
    /// Send serialized messages to the child.
    pub tx: mpsc::Sender<ThreadMessage>,
    /// Write to wake the child after sending (1 byte is sufficient).
    pub child_wake_write: RawFd,
    /// Receive serialized messages from the child.
    pub rx: mpsc::Receiver<ThreadMessage>,
    /// Register with the parent's kqueue/io_uring to detect child messages.
    pub parent_wake_read: RawFd,
    /// Set to `true` by the child thread just before it exits (including panics).
    pub done: Arc<AtomicBool>,
    /// Error message if the thread exited due to an error or panic. `None` = clean exit.
    pub error: Arc<Mutex<Option<String>>>,
    /// Thread join handle — resolves when the child loop exits.
    pub join: std::thread::JoinHandle<()>,
}

impl Drop for ThreadRealmHandle {
    fn drop(&mut self) {
        // Close the fds this side owns: the write end toward the child and
        // the read end on the parent side.  The child closes its own fds
        // when `run_thread_isolate` returns (see `OwnedFd` wrapper below).
        unsafe {
            libc::close(self.child_wake_write);
            libc::close(self.parent_wake_read);
        }
    }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/// Configuration threaded through the OS thread boundary into
/// `run_thread_isolate`.
struct IsolateConfig {
    process_env: crate::state::ProcessEnv,
    entry_path: String,
    import_rules: Vec<ImportRule>,
    package_map_json: Option<String>,
    /// Receives messages sent from the parent.
    channel_rx: mpsc::Receiver<ThreadMessage>,
    /// Sends messages to the parent.
    channel_tx: mpsc::Sender<ThreadMessage>,
    /// Own wake-pipe read end — register with child event loop.
    wake_read_fd: RawFd,
    /// Parent's wake-pipe write end — write here after each send.
    partner_wake_write_fd: RawFd,
}

/// RAII wrapper that closes a file descriptor on drop.
struct OwnedFd(RawFd);

impl Drop for OwnedFd {
    fn drop(&mut self) {
        if self.0 >= 0 {
            unsafe { libc::close(self.0) };
        }
    }
}

// ---------------------------------------------------------------------------
// Realm creation timing (FINO_REALM_TIMING=1)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pipe creation
// ---------------------------------------------------------------------------

/// Create a non-blocking POSIX pipe. Returns `(read_fd, write_fd)`.
fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [0i32; 2];
    // SAFETY: fds is a valid 2-element i32 array; pipe() is a standard call.
    let ret = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if ret != 0 {
        return Err(format!(
            "pipe() failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // Set O_NONBLOCK so reads/writes never block the event loop.
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }
    Ok((fds[0], fds[1]))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Spawn a new thread realm and return the parent-side handle.
///
/// Creates two mpsc channel pairs (parent→child, child→parent) and two
/// wake pipes (one per direction), then launches `run_thread_isolate` on a
/// new OS thread.
pub fn spawn_thread_realm(config: SpawnConfig) -> Result<ThreadRealmHandle, String> {
    let (parent_tx, child_rx) = mpsc::channel::<ThreadMessage>();
    let (child_tx, parent_rx) = mpsc::channel::<ThreadMessage>();

    let (child_wake_read, child_wake_write) = create_pipe()?;
    let (parent_wake_read, parent_wake_write) = create_pipe()?;

    let done_flag = Arc::new(AtomicBool::new(false));
    let done_for_thread = done_flag.clone();
    let error_flag: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let error_for_thread = error_flag.clone();

    let iso_config = IsolateConfig {
        process_env: config.process_env,
        entry_path: config.entry_path,
        import_rules: config.import_rules,
        package_map_json: config.package_map_json,
        channel_rx: child_rx,
        channel_tx: child_tx,
        wake_read_fd: child_wake_read,
        partner_wake_write_fd: parent_wake_write,
    };

    let join = std::thread::spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_thread_isolate(iso_config)
        }));
        // Always set done so the parent's polling loop exits.
        done_for_thread.store(true, Ordering::Release);
        let msg = match result {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(payload) => {
                let desc = payload
                    .downcast_ref::<String>()
                    .map(|s| s.to_owned())
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "thread realm panicked".to_string());
                Some(format!("thread realm panicked: {desc}"))
            }
        };
        if let Some(msg) = msg {
            *error_for_thread.lock().unwrap() = Some(msg);
        }
    });

    Ok(ThreadRealmHandle {
        tx: parent_tx,
        child_wake_write,
        rx: parent_rx,
        parent_wake_read,
        done: done_flag,
        error: error_flag,
        join,
    })
}

// ---------------------------------------------------------------------------
// Thread-local V8 host loop
// ---------------------------------------------------------------------------

/// Bootstrap a V8 Isolate on the calling thread and run its event loop.
fn run_thread_isolate(config: IsolateConfig) -> Result<(), String> {
    // Close the pipe fds this thread owns when the function returns.
    let _wake_read_guard = OwnedFd(config.wake_read_fd);
    let _partner_write_guard = OwnedFd(config.partner_wake_write_fd);

    super::child::run_child_isolate(super::child::ChildConfig {
        process_env: config.process_env,
        package_map_json: config.package_map_json,
        import_rules: config.import_rules,
        entry_path: config.entry_path,
        channel_rx: config.channel_rx,
        channel_tx: config.channel_tx,
        wake_read_fd: config.wake_read_fd,
        wake_write_fd: Some(config.partner_wake_write_fd),
        timing_label: "thread-realm",
    })
}

// ---------------------------------------------------------------------------
// internal:thread-port — native channel send/recv for thread realms
// ---------------------------------------------------------------------------

/// Create the `internal:thread-port` synthetic module.
///
/// Exports:
/// - `nativeSend(bytes: Uint8Array): void` — serializes bytes via the mpsc
///   channel and wakes the partner Isolate's event loop.
/// - `nativeRecv(): Uint8Array[]` — drains all buffered messages from the
///   channel and returns them as an Array of Uint8Arrays.
/// - `getWakeReadFd(): number` — returns the own wake-pipe read fd (or -1 if
///   this is not a thread realm), for registration with `loop.readable()`.
pub fn create_thread_port_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["nativeSend", "nativeRecv", "getWakeReadFd"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();

    let module_name = v8::String::new(scope, "internal:thread-port").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, thread_port_eval_steps)
}

fn thread_port_eval_steps<'a>(
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

    set_fn!("nativeSend", native_send);
    set_fn!("nativeRecv", native_recv);
    set_fn!("getWakeReadFd", native_get_wake_read_fd);

    Some(v8::undefined(scope).into())
}

/// JS: `nativeSend(bytes: Uint8Array, stores?: Uint8Array[], ports?: [handle,wakeReadFd][]): void`
///
/// Sends the byte payload (and optional transfer stores + port transfer infos)
/// to the partner Isolate via mpsc and writes 1 byte to the partner's wake pipe.
fn native_send(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let bytes_arg = args.get(0);
    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(bytes_arg) else {
        let msg =
            v8::String::new(scope, "nativeSend: first argument must be a Uint8Array").unwrap();
        let exc = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exc);
        return;
    };

    // Copy main bytes.
    let data: Vec<u8> = {
        let Some(ab) = u8a.buffer(scope) else { return };
        let Some(data_ptr) = ab.data() else { return };
        let offset = u8a.byte_offset();
        let len = u8a.byte_length();
        // SAFETY: data_ptr points into a live V8 ArrayBuffer owned for this scope.
        unsafe {
            std::slice::from_raw_parts((data_ptr.as_ptr() as *const u8).add(offset), len).to_vec()
        }
    };

    // Copy transfer stores (optional second arg — Array of Uint8Array).
    let transfer_stores: Vec<Vec<u8>> =
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(1)) {
            let count = arr.length();
            let mut stores = Vec::with_capacity(count as usize);
            for i in 0..count {
                let idx = v8::Integer::new(scope, i as i32);
                if let Some(elem) = arr.get(scope, idx.into())
                    && let Ok(su8a) = v8::Local::<v8::Uint8Array>::try_from(elem)
                {
                    let Some(sab) = su8a.buffer(scope) else {
                        continue;
                    };
                    let Some(sptr) = sab.data() else { continue };
                    let soff = su8a.byte_offset();
                    let slen = su8a.byte_length();
                    // SAFETY: same as above.
                    let raw = unsafe {
                        std::slice::from_raw_parts((sptr.as_ptr() as *const u8).add(soff), slen)
                            .to_vec()
                    };
                    stores.push(raw);
                }
            }
            stores
        } else {
            Vec::new()
        };

    // Port transfer infos (optional third arg — Array of [handle, wakeReadFd]).
    let transfer_ports = extract_port_infos(scope, args.get(2));

    let msg = ThreadMessage {
        data,
        transfer_stores,
        transfer_ports,
    };

    // Extract tx and wake_write_fd without holding the borrow during send.
    let state_rc = get_state(scope);
    let (maybe_tx, maybe_wake_write) = {
        let st = state_rc.borrow();
        (st.channel_tx.clone(), st.wake_write_fd)
    };

    if let Some(tx) = maybe_tx {
        let _ = tx.send(msg);
        // Thread realms write a wake byte so the partner's event loop unblocks.
        // Process realms (wake_write_fd = None) wake the partner via the socket
        // write in their bridge thread — no explicit wake byte needed here.
        if let Some(wake_write) = maybe_wake_write {
            let byte: [u8; 1] = [1];
            // SAFETY: wake_write is a valid open fd owned by this runtime.
            unsafe { libc::write(wake_write, byte.as_ptr() as *const _, 1) };
        }
    }
}

/// JS: `nativeRecv(): [Uint8Array, ...Uint8Array[]][]`
///
/// Non-blocking drain of `channel_rx`. Returns all currently buffered messages
/// as a JS Array of inner Arrays. Each inner Array has the main bytes at `[0]`
/// and transfer-store bytes at `[1..]`. Also drains wake bytes from the read
/// pipe so the next `loop.readable()` arms cleanly.
fn native_recv(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // Drain the channel first (before any V8 allocations).
    let (messages, maybe_wake_read) = {
        let state_rc = get_state(scope);
        let st = state_rc.borrow();
        let msgs: Vec<ThreadMessage> = if let Some(rx) = st.channel_rx.as_ref() {
            let mut v = Vec::new();
            while let Ok(msg) = rx.try_recv() {
                v.push(msg);
            }
            v
        } else {
            Vec::new()
        };
        (msgs, st.wake_read_fd)
    };

    // Drain wake bytes so the fd doesn't remain permanently readable.
    if let Some(wake_read) = maybe_wake_read {
        let mut discard = [0u8; 256];
        // Non-blocking; EAGAIN means no more bytes — ignore error.
        // SAFETY: discard is a valid buffer; wake_read is a valid open fd.
        unsafe { libc::read(wake_read, discard.as_mut_ptr() as *mut _, discard.len()) };
    }

    rv.set(crate::realm::transit::build_message_array(scope, messages).into());
}

/// JS: `getWakeReadFd(): number`
///
/// Returns the own wake-pipe read fd (≥ 0) for use with `loop.readable()`,
/// or -1 if this context is not a thread realm.
fn native_get_wake_read_fd(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let state_rc = get_state(scope);
    let fd = state_rc.borrow().wake_read_fd.unwrap_or(-1);
    rv.set(v8::Integer::new(scope, fd).into());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract `[[handle: number, wakeReadFd: number], ...]` from a JS value.
pub(crate) fn extract_port_infos(
    scope: &mut v8::HandleScope,
    val: v8::Local<v8::Value>,
) -> Vec<TransferredPortInfo> {
    let Ok(arr) = v8::Local::<v8::Array>::try_from(val) else {
        return Vec::new();
    };
    let count = arr.length();
    let mut infos = Vec::with_capacity(count as usize);
    for i in 0..count {
        let idx = v8::Integer::new(scope, i as i32);
        let Some(elem) = arr.get(scope, idx.into()) else {
            continue;
        };
        let Ok(pair) = v8::Local::<v8::Array>::try_from(elem) else {
            continue;
        };
        let zero = v8::Integer::new(scope, 0);
        let one = v8::Integer::new(scope, 1);
        let Some(h_val) = pair.get(scope, zero.into()) else {
            continue;
        };
        let Some(fd_val) = pair.get(scope, one.into()) else {
            continue;
        };
        let handle = h_val.integer_value(scope).unwrap_or(-1) as u32;
        let wake_read_fd = fd_val.integer_value(scope).unwrap_or(-1) as i32;
        infos.push(TransferredPortInfo {
            handle,
            wake_read_fd,
        });
    }
    infos
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that `done` is set and `error` is populated even when the thread
    /// body panics — i.e. that `catch_unwind` properly contains the panic.
    #[test]
    fn catch_unwind_sets_done_and_error_on_panic() {
        let done = Arc::new(AtomicBool::new(false));
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let done_clone = done.clone();
        let error_clone = error.clone();

        let handle = std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                panic!("deliberate test panic");
            }));
            done_clone.store(true, Ordering::Release);
            let msg = match result {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(payload) => {
                    let desc = payload
                        .downcast_ref::<String>()
                        .map(|s| s.clone())
                        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "panicked".to_string());
                    Some(format!("thread realm panicked: {desc}"))
                }
            };
            if let Some(msg) = msg {
                *error_clone.lock().unwrap() = Some(msg);
            }
        });
        handle.join().unwrap();

        assert!(
            done.load(Ordering::Acquire),
            "done flag must be set even after a panic"
        );
        let err = error.lock().unwrap();
        assert!(err.is_some(), "error should be populated after a panic");
        assert!(
            err.as_ref().unwrap().contains("deliberate test panic"),
            "error message should contain the panic description"
        );
    }

    /// Verify that a clean return also sets done but leaves error as None.
    #[test]
    fn catch_unwind_clean_exit_no_error() {
        let done = Arc::new(AtomicBool::new(false));
        let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let done_clone = done.clone();
        let error_clone = error.clone();

        let handle = std::thread::spawn(move || {
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Ok::<(), String>(())));
            done_clone.store(true, Ordering::Release);
            let msg: Option<String> = match result {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(_) => Some("panicked".to_string()),
            };
            if let Some(msg) = msg {
                *error_clone.lock().unwrap() = Some(msg);
            }
        });
        handle.join().unwrap();

        assert!(
            done.load(Ordering::Acquire),
            "done flag must be set on clean exit"
        );
        assert!(
            error.lock().unwrap().is_none(),
            "error should be None on clean exit"
        );
    }
}
