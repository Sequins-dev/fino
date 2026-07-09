#![allow(dead_code)]
//! Thread Realm infrastructure.
//!
//! Spawns a separate OS thread with its own `v8::Isolate`, bootstrapping
//! `internal/bootstrap.mjs` and running a full host loop.  Bidirectional messaging
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
//! 3. The thread bootstraps its own `v8::Isolate`, evaluates `internal/bootstrap.mjs`
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
    },
};

use ::v8;

use crate::state::ImportRule;

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
    pub watch_mode: bool,
    pub realm_data: Option<String>,
    pub realm_bootstrap_data: Option<String>,
}

/// Returned to the parent after a thread realm is spawned.
///
/// The parent holds the send/receive ends for messaging the child and
/// registers `parent_wake_read` with its own event loop to detect inbound
/// messages.
pub struct ThreadRealmHandle {
    /// Transit-registry handle of the parent-side channel half. The parent's
    /// ThreadPort messages through `transitSend`/`transitRecv` with it — the
    /// same mechanism transferred MessagePorts use.
    pub port_handle: u32,
    /// The parent half's wake-pipe read fd (registered with the parent loop).
    pub port_wake_read_fd: RawFd,
    /// Set to `true` by the child thread just before it exits (including panics).
    pub done: Arc<AtomicBool>,
    /// Error message if the thread exited due to an error or panic. `None` = clean exit.
    pub error: Arc<Mutex<Option<String>>>,
    /// Set to `true` by the child thread via `requestReload()` before it exits.
    /// The parent reads this in `step_thread_context` to distinguish reload from clean exit.
    pub reload_requested: Arc<AtomicBool>,
    /// Thread join handle — resolves when the child loop exits.
    pub join: std::thread::JoinHandle<()>,
}

impl Drop for ThreadRealmHandle {
    fn drop(&mut self) {
        // Drop the parent-side half if JS has not already closed the port —
        // removal closes its pipe ends. Idempotent.
        drop(super::transit::remove_half(self.port_handle));
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
    /// Child-side channel half: transit handle + its wake-pipe read fd.
    port_half: (u32, RawFd),
    watch_mode: bool,
    realm_data: Option<String>,
    realm_bootstrap_data: Option<String>,
    /// Shared with `ThreadRealmHandle.reload_requested`; child writes it on reload.
    reload_requested: Arc<AtomicBool>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Spawn a new thread realm and return the parent-side handle.
///
/// Creates one transit channel (two registered halves) and launches
/// `run_thread_isolate` on a new OS thread with the child half.
pub fn spawn_thread_realm(config: SpawnConfig) -> Result<ThreadRealmHandle, String> {
    let (parent_half, child_half) = super::transit::create_halves()?;
    let parent_wake_read = parent_half.wake_read_fd;
    let child_wake_read = child_half.wake_read_fd;
    let parent_handle = super::transit::register_half(parent_half);
    let child_handle = super::transit::register_half(child_half);

    let done_flag = Arc::new(AtomicBool::new(false));
    let done_for_thread = done_flag.clone();
    let error_flag: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let error_for_thread = error_flag.clone();
    let reload_flag = Arc::new(AtomicBool::new(false));
    let reload_for_thread = reload_flag.clone();

    let iso_config = IsolateConfig {
        process_env: config.process_env,
        entry_path: config.entry_path,
        import_rules: config.import_rules,
        package_map_json: config.package_map_json,
        port_half: (child_handle, child_wake_read),
        watch_mode: config.watch_mode,
        realm_data: config.realm_data,
        realm_bootstrap_data: config.realm_bootstrap_data,
        reload_requested: reload_for_thread,
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
        port_handle: parent_handle,
        port_wake_read_fd: parent_wake_read,
        done: done_flag,
        error: error_flag,
        reload_requested: reload_flag,
        join,
    })
}

// ---------------------------------------------------------------------------
// Thread-local V8 host loop
// ---------------------------------------------------------------------------

/// Bootstrap a V8 Isolate on the calling thread and run its event loop.
fn run_thread_isolate(config: IsolateConfig) -> Result<(), String> {
    super::child::run_child_isolate(super::child::ChildConfig {
        process_env: config.process_env,
        package_map_json: config.package_map_json,
        import_rules: config.import_rules,
        entry_path: config.entry_path,
        port_half: config.port_half,
        timing_label: "thread-realm",
        watch_mode: config.watch_mode,
        realm_data: config.realm_data,
        realm_bootstrap_data: config.realm_bootstrap_data,
        reload_requested_signal: Some(config.reload_requested),
    })
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
