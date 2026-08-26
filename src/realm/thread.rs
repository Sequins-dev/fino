//! Dedicated sandbox Realm threads and cross-isolate transport primitives.
//!
//! Ordinary local Realms are movable workloads owned by `scheduler_native`.
//! Linux sandbox Realms are deliberately different: each owns one fixed OS
//! thread so cgroup v2 threaded controls, Landlock, and seccomp can be applied
//! without constraining the regular workload queue.

use std::{
    os::unix::io::RawFd,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use ::v8;

use crate::state::get_state;
#[cfg(target_os = "linux")]
use crate::state::{ImportRule, ProcessEnv};

/// Copy a `Uint8Array` argument into an owned byte vector.
pub fn copy_u8a(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    let array = v8::Local::<v8::Uint8Array>::try_from(value).ok()?;
    let buffer = array.buffer(scope)?;
    let data = buffer.data()?;
    let offset = array.byte_offset();
    let len = array.byte_length();
    // SAFETY: `data` points into a live V8 ArrayBuffer owned for this scope.
    Some(unsafe {
        std::slice::from_raw_parts((data.as_ptr() as *const u8).add(offset), len).to_vec()
    })
}

/// Info shipped alongside a message for each transferred MessagePort.
///
/// The receiver uses `handle` to look up the Q-half transit channel and
/// `wake_read_fd` to register with the event loop via `loop.readable()`.
#[derive(Debug)]
pub struct TransferredPortInfo {
    pub handle: u32,
    pub wake_read_fd: i32,
}

/// A message transmitted across cross-isolate Realm boundaries.
///
/// `header` carries envelope metadata — what kind of message this is and which
/// request it correlates with — encoded independently of the payload. Keeping it
/// beside `data` rather than inside it is deliberate: the payload is an opaque
/// clone of a user value, so control information nested in it could be forged by
/// any realm that can post a plain object, and a relay would have to deserialize
/// every message just to discover what it was looking at.
///
/// `data` is the V8 ValueSerializer wire format for the message value.
/// `transfer_stores` holds raw bytes for each transferred ArrayBuffer.
/// `transfer_ports` carries transit channel info for each transferred
/// MessagePort so the receiver can reconstruct a live cross-thread port.
#[derive(Debug)]
pub struct ThreadMessage {
    pub header: Vec<u8>,
    pub data: Vec<u8>,
    pub transfer_stores: Vec<Vec<u8>>,
    pub transfer_ports: Vec<TransferredPortInfo>,
}

/// Configuration for a Linux sandbox Realm's dedicated thread.
#[cfg(target_os = "linux")]
pub struct SpawnConfig {
    pub process_env: ProcessEnv,
    pub entry_path: String,
    pub import_rules: Vec<ImportRule>,
    pub package_map_json: Option<String>,
    pub realm_data: Option<String>,
    pub realm_bootstrap_data: Option<String>,
}

/// Parent-side ownership and transport for a Linux sandbox Realm.
pub struct ThreadRealmHandle {
    pub tx: mpsc::Sender<ThreadMessage>,
    pub child_wake_write: RawFd,
    pub rx: mpsc::Receiver<ThreadMessage>,
    pub parent_wake_read: RawFd,
    /// Becomes readable once the sandbox thread has finished.
    ///
    /// Separate from `parent_wake_read`: message arrival and realm completion
    /// are watched by different parts of the parent realm, and a realm can hold
    /// only one readiness watch per descriptor, so sharing one pipe would make
    /// the two waiters displace each other.
    pub completion_wake_read: RawFd,
    pub done: Arc<AtomicBool>,
    pub error: Arc<Mutex<Option<String>>>,
    pub cgroup_path: Arc<Mutex<Option<String>>>,
    pub isolate_handle: Arc<Mutex<Option<v8::IsolateHandle>>>,
    pub force_requested: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ThreadRealmHandle {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.child_wake_write);
            libc::close(self.parent_wake_read);
            libc::close(self.completion_wake_read);
        }
        if self.done.load(Ordering::Acquire)
            && let Some(join) = self.join.take()
        {
            let _ = join.join();
        }
        if let Ok(mut path) = self.cgroup_path.lock()
            && let Some(path) = path.take()
        {
            let _ = std::fs::remove_dir(path);
        }
    }
}

#[cfg(target_os = "linux")]
struct OwnedFd(RawFd);

#[cfg(target_os = "linux")]
impl Drop for OwnedFd {
    fn drop(&mut self) {
        if self.0 >= 0 {
            unsafe { libc::close(self.0) };
        }
    }
}

#[cfg(target_os = "linux")]
fn create_pipe() -> Result<(RawFd, RawFd), String> {
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(format!(
            "pipe() failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    unsafe {
        libc::fcntl(fds[0], libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(fds[1], libc::F_SETFL, libc::O_NONBLOCK);
    }
    Ok((fds[0], fds[1]))
}

/// Spawn a fixed OS thread for a Linux sandbox Realm.
#[cfg(target_os = "linux")]
pub fn spawn_sandbox_realm(config: SpawnConfig) -> Result<ThreadRealmHandle, String> {
    let (parent_tx, child_rx) = mpsc::channel::<ThreadMessage>();
    let (child_tx, parent_rx) = mpsc::channel::<ThreadMessage>();
    let (child_wake_read, child_wake_write) = create_pipe()?;
    let (parent_wake_read, parent_wake_write) = create_pipe()?;

    let (completion_wake_read, completion_wake_write) = create_pipe()?;
    let done = Arc::new(AtomicBool::new(false));
    let done_for_thread = done.clone();
    let error = Arc::new(Mutex::new(None));
    let error_for_thread = error.clone();
    let cgroup_path = Arc::new(Mutex::new(None));
    let cgroup_path_for_thread = cgroup_path.clone();
    let isolate_handle = Arc::new(Mutex::new(None));
    let isolate_handle_for_thread = isolate_handle.clone();
    let force_requested = Arc::new(AtomicBool::new(false));
    let force_requested_for_thread = force_requested.clone();

    let join = std::thread::Builder::new()
        .name("fino-sandbox-realm".to_string())
        .spawn(move || {
            let _wake_read_guard = OwnedFd(child_wake_read);
            let _partner_write_guard = OwnedFd(parent_wake_write);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                super::child::run_child_isolate(super::child::ChildConfig {
                    process_env: config.process_env,
                    package_map_json: config.package_map_json,
                    import_rules: config.import_rules,
                    entry_path: config.entry_path,
                    channel_rx: child_rx,
                    channel_tx: child_tx,
                    wake_read_fd: child_wake_read,
                    wake_write_fd: Some(parent_wake_write),
                    timing_label: "sandbox-realm",
                    watch_mode: false,
                    realm_data: config.realm_data,
                    realm_bootstrap_data: config.realm_bootstrap_data,
                    sandboxed_thread: true,
                    sandbox_cgroup_path: Some(cgroup_path_for_thread),
                    isolate_handle: Some(isolate_handle_for_thread),
                    force_requested: Some(force_requested_for_thread),
                    reload_requested_signal: None,
                })
            }));
            let message = match result {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(payload) => {
                    let detail = payload
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "sandbox realm panicked".to_string());
                    Some(format!("sandbox realm panicked: {detail}"))
                }
            };
            if let Some(message) = message
                && let Ok(mut slot) = error_for_thread.lock()
            {
                *slot = Some(message);
            }
            done_for_thread.store(true, Ordering::Release);
            // Signal completion so the parent is woken rather than polling the
            // flag, then release the write end so the pipe reports EOF.
            let byte = [1u8];
            unsafe {
                libc::write(completion_wake_write, byte.as_ptr().cast(), byte.len());
                libc::close(completion_wake_write);
            }
        })
        .map_err(|error| format!("failed to spawn sandbox realm thread: {error}"))?;

    Ok(ThreadRealmHandle {
        tx: parent_tx,
        child_wake_write,
        rx: parent_rx,
        parent_wake_read,
        completion_wake_read,
        done,
        error,
        cgroup_path,
        isolate_handle,
        force_requested,
        join: Some(join),
    })
}

// ---------------------------------------------------------------------------
// internal:thread-port — native channel send/recv for cross-isolate realms
// ---------------------------------------------------------------------------

/// Create the `internal:thread-port` synthetic module.
///
/// Exports:
/// - `nativeSend(bytes: Uint8Array): void` — serializes bytes via the mpsc
///   channel and wakes the partner Isolate's event loop.
/// - `nativeRecv(): Uint8Array[]` — drains all buffered messages from the
///   channel and returns them as an Array of Uint8Arrays.
/// - `getWakeReadFd(): number` — returns the own wake-pipe read fd (or -1 if
///   this is not a cross-isolate realm), for registration with `loop.readable()`.
pub fn create_thread_port_module<'s>(
    scope: &mut v8::PinScope<'s, '_>,
) -> v8::Local<'s, v8::Module> {
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
    v8::callback_scope!(unsafe let scope, context);

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

/// JS: `nativeSend(header: Uint8Array, bytes: Uint8Array, stores?: Uint8Array[],
/// ports?: [handle,wakeReadFd][]): void`
///
/// Sends the envelope header and byte payload (plus optional transfer stores and
/// port transfer infos) to the partner Isolate via mpsc, then writes 1 byte to
/// the partner's wake pipe. The header is carried separately so a receiver can
/// classify a message without deserializing the payload it describes.
fn native_send(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let header = copy_u8a(scope, args.get(0)).unwrap_or_default();
    let bytes_arg = args.get(1);
    let Ok(u8a) = v8::Local::<v8::Uint8Array>::try_from(bytes_arg) else {
        let msg =
            v8::String::new(scope, "nativeSend: second argument must be a Uint8Array").unwrap();
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

    // Copy transfer stores (optional third arg — Array of Uint8Array).
    let transfer_stores: Vec<Vec<u8>> =
        if let Ok(arr) = v8::Local::<v8::Array>::try_from(args.get(2)) {
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

    // Port transfer infos (optional fourth arg — Array of [handle, wakeReadFd]).
    let transfer_ports = extract_port_infos(scope, args.get(3));

    let msg = ThreadMessage {
        header,
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
        // Reactor-pooled realms write a wake byte so the partner loop unblocks.
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
    scope: &mut v8::PinScope,
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
/// or -1 if this context does not have a cross-isolate transport.
fn native_get_wake_read_fd(
    scope: &mut v8::PinScope,
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
    scope: &mut v8::PinScope,
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
