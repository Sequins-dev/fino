//! Process Realm infrastructure.
//!
//! Spawns a separate OS process with its own `v8::Isolate` for hard crash
//! isolation.  A child crash cannot corrupt the parent's heap; the OS enforces
//! I/O separation.
//!
//! ## IPC
//!
//! `socketpair(AF_UNIX, SOCK_STREAM, 0)` gives a bidirectional channel.
//! Parent keeps `fd[0]` (non-blocking, registered with the event loop).
//! Child keeps `fd[1]` (used as the channel source; a bridge thread reads it
//! and feeds an mpsc channel so `native_recv` works unchanged).
//!
//! ## Message framing
//!
//! ```text
//! [u32 be: total_payload_len]
//! [u32 be: data_len][data bytes]
//! [u32 be: num_stores]
//!   ([u32 be: store_len][store bytes]) × num_stores
//! ```
//!
//! Port transfer across process boundaries is not supported.
//!
//! ## Bootstrap flow
//!
//! Parent writes the serialised `SpawnConfig` as the first framed message
//! immediately after `fork+exec`.  The child reads it (blocking) before
//! entering the event loop.  Subsequent messages are normal `ThreadMessage`
//! frames exchanged via the bridge.

use std::{
    os::unix::io::RawFd,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use serde::{Deserialize, Serialize};

use super::thread::ThreadMessage;
use crate::state::ImportRule;

/// Magic prefix that marks an entry-error sentinel IPC message sent by the
/// child before it exits. The parent reader strips this and stores the real
/// error message without forwarding the frame to JS.
const ENTRY_ERROR_PREFIX: &[u8] = b"\x00FINO_ENTRY_ERROR\x00";

/// Process-global flag set by `requestReload()` inside a child process.
/// When set, `run_process_child` exits with code 75 (EX_TEMPFAIL) instead
/// of 0, and the parent's reader thread maps that to `reload_requested`.
/// Safe as a static because each child process runs exactly one realm.
pub static CHILD_RELOAD_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/// Write one length-prefixed `ThreadMessage` to a file descriptor (blocking).
pub fn write_message(fd: RawFd, msg: &ThreadMessage) -> std::io::Result<()> {
    // Guard against u32 truncation: individual fields and total payload must
    // fit in u32 (4 GiB). Messages this large are pathological but the cast
    // would silently corrupt the framing on the reader side.
    let check_u32 = |n: usize, label: &'static str| -> std::io::Result<u32> {
        u32::try_from(n).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{label} exceeds 4 GiB limit"),
            )
        })
    };

    let mut payload = Vec::new();
    let dl = check_u32(msg.data.len(), "process realm IPC data length")?;
    payload.extend_from_slice(&dl.to_be_bytes());
    payload.extend_from_slice(&msg.data);
    let ns = check_u32(msg.transfer_stores.len(), "transfer store count")?;
    payload.extend_from_slice(&ns.to_be_bytes());
    for s in &msg.transfer_stores {
        let sl = check_u32(s.len(), "transfer store length")?;
        payload.extend_from_slice(&sl.to_be_bytes());
        payload.extend_from_slice(s);
    }
    let total = check_u32(payload.len(), "total IPC payload length")?;
    write_all(fd, &total.to_be_bytes())?;
    write_all(fd, &payload)
}

/// Read one length-prefixed `ThreadMessage` from a file descriptor (blocking).
pub fn read_message(fd: RawFd) -> std::io::Result<ThreadMessage> {
    let mut hdr = [0u8; 4];
    read_exact(fd, &mut hdr)?;
    let total = u32::from_be_bytes(hdr) as usize;
    let mut p = vec![0u8; total];
    read_exact(fd, &mut p)?;
    let mut pos = 0usize;

    macro_rules! u32_at {
        () => {{
            let v = u32::from_be_bytes(p[pos..pos + 4].try_into().unwrap());
            pos += 4;
            v as usize
        }};
    }

    let dl = u32_at!();
    let data = p[pos..pos + dl].to_vec();
    pos += dl;
    let ns = u32_at!();
    let mut stores = Vec::with_capacity(ns);
    for _ in 0..ns {
        let sl = u32_at!();
        stores.push(p[pos..pos + sl].to_vec());
        pos += sl;
    }
    Ok(ThreadMessage {
        data,
        transfer_stores: stores,
        transfer_ports: Vec::new(),
    })
}

fn write_all(fd: RawFd, buf: &[u8]) -> std::io::Result<()> {
    let mut w = 0;
    while w < buf.len() {
        let n = unsafe { libc::write(fd, buf.as_ptr().add(w) as _, buf.len() - w) };
        if n <= 0 {
            return Err(std::io::Error::last_os_error());
        }
        w += n as usize;
    }
    Ok(())
}

fn read_exact(fd: RawFd, buf: &mut [u8]) -> std::io::Result<()> {
    let mut r = 0;
    while r < buf.len() {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().add(r) as _, buf.len() - r) };
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "socket closed",
            ));
        }
        if n < 0 {
            let e = std::io::Error::last_os_error();
            match e.kind() {
                std::io::ErrorKind::Interrupted => continue,
                std::io::ErrorKind::WouldBlock => {
                    // fd is O_NONBLOCK; wait for it to become readable.
                    let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
                    unsafe { libc::poll(&mut pfd, 1, -1) };
                    continue;
                }
                _ => return Err(e),
            }
        }
        r += n as usize;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Spawn config (sent as first message from parent to child)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
pub struct SpawnConfig {
    pub entry_path: String,
    pub import_rules: Vec<ImportRule>,
    pub root: String,
    pub args: Vec<String>,
    pub env_vars: std::collections::HashMap<String, String>,
    pub exec_path: String,
    pub package_map_json: Option<String>,
    #[serde(default)]
    pub watch_mode: bool,
}

// ---------------------------------------------------------------------------
// Parent-side handle
// ---------------------------------------------------------------------------

pub struct ProcessRealmHandle {
    /// Parent's end of the socketpair (non-blocking).
    pub socket_fd: RawFd,
    /// Set `true` once the child exits (set by reader thread).
    pub done: Arc<AtomicBool>,
    /// Populated if the child exited with an error.
    pub error: Arc<Mutex<Option<String>>>,
    /// Set `true` when the child exited with code 75 (reload requested).
    pub reload_requested: Arc<AtomicBool>,
    /// Receives messages from the child.
    pub rx: mpsc::Receiver<ThreadMessage>,
    /// Sends messages to the child (queued for the writer bridge thread).
    pub tx: mpsc::Sender<ThreadMessage>,
    /// Wake-pipe read end — receives a byte after each inbound message.
    pub parent_wake_read: RawFd,
}

impl Drop for ProcessRealmHandle {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.socket_fd);
            libc::close(self.parent_wake_read);
        }
    }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

pub struct SpawnArgs {
    pub process_env: crate::state::ProcessEnv,
    pub entry_path: String,
    pub import_rules: Vec<ImportRule>,
    pub package_map_json: Option<String>,
    pub watch_mode: bool,
}

/// Spawn a new process realm and return the parent-side handle.
pub fn spawn_process_realm(args: SpawnArgs) -> Result<ProcessRealmHandle, String> {
    use std::os::unix::process::CommandExt;

    // Socketpair.
    let mut fds = [0i32; 2];
    if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) } != 0 {
        return Err(format!("socketpair: {}", std::io::Error::last_os_error()));
    }
    let (parent_fd, child_fd) = (fds[0], fds[1]);
    unsafe {
        // child_fd: clear FD_CLOEXEC so child inherits it. parent_fd stays blocking
        // until after the config write (set non-blocking below, after write).
        libc::fcntl(child_fd, libc::F_SETFD, 0);
    }

    // Wake-pipe for the parent (reader bridge writes here on each message).
    let mut wfds = [0i32; 2];
    if unsafe { libc::pipe(wfds.as_mut_ptr()) } != 0 {
        unsafe {
            libc::close(parent_fd);
            libc::close(child_fd);
        }
        return Err(format!("pipe: {}", std::io::Error::last_os_error()));
    }
    let (parent_wake_read, parent_wake_write) = (wfds[0], wfds[1]);
    unsafe {
        libc::fcntl(parent_wake_read, libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(parent_wake_write, libc::F_SETFL, libc::O_NONBLOCK);
    }

    // Serialise spawn config.
    let cfg = SpawnConfig {
        entry_path: args.entry_path,
        import_rules: args.import_rules,
        root: args.process_env.root.to_string_lossy().into_owned(),
        args: args.process_env.args.clone(),
        watch_mode: args.watch_mode,
        env_vars: args.process_env.env_vars.clone(),
        exec_path: args.process_env.exec_path.clone(),
        package_map_json: args.package_map_json,
    };
    let config_msg = ThreadMessage {
        data: serde_json::to_string(&cfg)
            .map_err(|e| e.to_string())?
            .into_bytes(),
        transfer_stores: Vec::new(),
        transfer_ports: Vec::new(),
    };

    // Spawn child process.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--realm-child").arg(child_fd.to_string());

    // In pre_exec: close fds the child doesn't own.
    let close_in_child = [parent_fd, parent_wake_read, parent_wake_write];
    unsafe {
        cmd.pre_exec(move || {
            for &fd in &close_in_child {
                libc::close(fd);
            }
            Ok(())
        });
    }

    let child = cmd.spawn().map_err(|e| format!("spawn: {e}"))?;
    let child_pid = child.id() as libc::pid_t;
    std::mem::forget(child); // reaping is handled by the reader thread

    // Parent closes the child's fd.
    unsafe { libc::close(child_fd) };

    // Write spawn config while parent_fd is still blocking — the child may not
    // be reading yet and a non-blocking write could EAGAIN on a fresh socket.
    write_message(parent_fd, &config_msg).map_err(|e| format!("write config: {e}"))?;

    // Now switch parent_fd to non-blocking for the async event-loop phase.
    unsafe { libc::fcntl(parent_fd, libc::F_SETFL, libc::O_NONBLOCK); };

    // Bridge threads.
    let (reader_tx, parent_rx) = mpsc::channel::<ThreadMessage>();
    let (parent_tx, writer_rx) = mpsc::channel::<ThreadMessage>();
    let done = Arc::new(AtomicBool::new(false));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let reload_requested = Arc::new(AtomicBool::new(false));

    // Reader: socket → mpsc + wake pipe; also reaps the child process.
    {
        let done = done.clone();
        let error = error.clone();
        let reload_requested = reload_requested.clone();
        std::thread::spawn(move || {
            loop {
                match read_message(parent_fd) {
                    Ok(msg) => {
                        // Check for a child-side entry-error sentinel.
                        if msg.data.starts_with(ENTRY_ERROR_PREFIX) {
                            let err_msg = String::from_utf8_lossy(
                                &msg.data[ENTRY_ERROR_PREFIX.len()..],
                            ).into_owned();
                            *error.lock().unwrap() = Some(err_msg);
                            continue;
                        }
                        let _ = reader_tx.send(msg);
                        let b = [1u8];
                        unsafe { libc::write(parent_wake_write, b.as_ptr() as _, 1) };
                    }
                    Err(e) => {
                        if e.kind() != std::io::ErrorKind::UnexpectedEof {
                            *error.lock().unwrap() = Some(format!("process realm: {e}"));
                        }
                        break;
                    }
                }
            }
            // Reap child.
            let mut status = 0i32;
            unsafe { libc::waitpid(child_pid, &mut status, 0) };
            // Only set the exit-code error if no specific error was already captured.
            {
                let mut guard = error.lock().unwrap();
                if guard.is_none() {
                    if libc::WIFEXITED(status) {
                        let code = libc::WEXITSTATUS(status);
                        if code == 75 {
                            // Child requested reload; not an error.
                            reload_requested.store(true, Ordering::Release);
                        } else if code != 0 {
                            *guard = Some(format!("process realm exited: code {}", code));
                        }
                    } else if libc::WIFSIGNALED(status) {
                        *guard = Some(format!(
                            "process realm killed: signal {}",
                            libc::WTERMSIG(status)
                        ));
                    }
                }
            }
            done.store(true, Ordering::Release);
            // Final wake so the parent notices exit on the next step.
            let b = [1u8];
            unsafe { libc::write(parent_wake_write, b.as_ptr() as _, 1) };
        });
    }

    // Writer: mpsc → socket.
    {
        let error = error.clone();
        std::thread::spawn(move || {
            while let Ok(msg) = writer_rx.recv() {
                if let Err(e) = write_message(parent_fd, &msg) {
                    *error.lock().unwrap() = Some(format!("process realm write: {e}"));
                    break;
                }
            }
        });
    }

    Ok(ProcessRealmHandle {
        socket_fd: parent_fd,
        done,
        error,
        reload_requested,
        rx: parent_rx,
        tx: parent_tx,
        parent_wake_read,
    })
}

// ---------------------------------------------------------------------------
// Child-side entry point
// ---------------------------------------------------------------------------

/// Read the spawn config from the socket (blocking; first message).
pub fn read_spawn_config(fd: RawFd) -> Result<SpawnConfig, String> {
    let msg = read_message(fd).map_err(|e| format!("read spawn config: {e}"))?;
    serde_json::from_slice(&msg.data).map_err(|e| format!("parse spawn config: {e}"))
}

/// Bootstrap a V8 Isolate inside the child process and run its event loop.
pub fn run_process_child(socket_fd: RawFd, config: SpawnConfig) -> Result<(), String> {
    // Prevent grandchildren from inheriting the socket.
    unsafe { libc::fcntl(socket_fd, libc::F_SETFD, libc::FD_CLOEXEC) };

    // Bridge: socket ↔ mpsc + wake pipe (so native_recv / native_send work unchanged).
    let (reader_tx, channel_rx) = mpsc::channel::<ThreadMessage>();
    let (channel_tx, writer_rx) = mpsc::channel::<ThreadMessage>();
    let mut wfds = [0i32; 2];
    unsafe { libc::pipe(wfds.as_mut_ptr()) };
    let (wake_read, wake_write) = (wfds[0], wfds[1]);
    unsafe {
        libc::fcntl(wake_read, libc::F_SETFL, libc::O_NONBLOCK);
        libc::fcntl(wake_write, libc::F_SETFL, libc::O_NONBLOCK);
    }

    std::thread::spawn(move || {
        loop {
            match read_message(socket_fd) {
                Ok(msg) => {
                    let _ = reader_tx.send(msg);
                    let b = [1u8];
                    unsafe { libc::write(wake_write, b.as_ptr() as _, 1) };
                }
                Err(_) => break,
            }
        }
    });

    let writer_handle = std::thread::spawn(move || {
        while let Ok(msg) = writer_rx.recv() {
            if write_message(socket_fd, &msg).is_err() {
                break;
            }
        }
    });

    let result = super::child::run_child_isolate(super::child::ChildConfig {
        process_env: crate::state::ProcessEnv {
            root: std::path::PathBuf::from(&config.root),
            args: config.args,
            env_vars: config.env_vars,
            exec_path: config.exec_path,
        },
        package_map_json: config.package_map_json,
        import_rules: config.import_rules,
        entry_path: config.entry_path,
        channel_rx,
        channel_tx,
        wake_read_fd: wake_read,
        wake_write_fd: None, // parent wakes via the socket; bridge handles it
        timing_label: "process-realm",
        watch_mode: config.watch_mode,
        reload_requested_signal: None, // process realm uses exit code 75
    });

    // channel_tx dropped (inside FinoState) when run_child_isolate returned.
    // Join the writer bridge so all queued outbound messages (e.g. the call
    // result) are fully written to the socket before the process exits.
    let _ = writer_handle.join();

    // If the child called requestReload(), exit with EX_TEMPFAIL (75) so the
    // parent's reader thread maps this back to reload_requested.
    if CHILD_RELOAD_REQUESTED.load(std::sync::atomic::Ordering::Acquire) {
        std::process::exit(75);
    }

    // If the entry module threw, send the error to the parent before exiting.
    if let Err(ref msg) = result {
        let mut data = ENTRY_ERROR_PREFIX.to_vec();
        data.extend_from_slice(msg.as_bytes());
        let sentinel = ThreadMessage {
            data,
            transfer_stores: Vec::new(),
            transfer_ports: Vec::new(),
        };
        let _ = write_message(socket_fd, &sentinel);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn socketpair_fds() -> (RawFd, RawFd) {
        let mut fds = [0i32; 2];
        let rc = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        assert_eq!(rc, 0, "socketpair failed");
        (fds[0], fds[1])
    }

    fn make_msg(data: &[u8]) -> ThreadMessage {
        ThreadMessage {
            data: data.to_vec(),
            transfer_stores: Vec::new(),
            transfer_ports: Vec::new(),
        }
    }

    fn make_msg_with_stores(data: &[u8], stores: Vec<Vec<u8>>) -> ThreadMessage {
        ThreadMessage {
            data: data.to_vec(),
            transfer_stores: stores,
            transfer_ports: Vec::new(),
        }
    }

    #[test]
    fn round_trip_empty_data() {
        let (a, b) = socketpair_fds();
        let msg = make_msg(&[]);
        write_message(a, &msg).unwrap();
        let got = read_message(b).unwrap();
        assert_eq!(got.data, msg.data);
        assert!(got.transfer_stores.is_empty());
        unsafe {
            libc::close(a);
            libc::close(b);
        }
    }

    #[test]
    fn round_trip_small_payload() {
        let (a, b) = socketpair_fds();
        let payload = b"hello world from fino process realm";
        write_message(a, &make_msg(payload)).unwrap();
        let got = read_message(b).unwrap();
        assert_eq!(got.data, payload);
        unsafe {
            libc::close(a);
            libc::close(b);
        }
    }

    #[test]
    fn round_trip_with_transfer_stores() {
        let (a, b) = socketpair_fds();
        let stores = vec![b"store-0".to_vec(), b"store-1-longer".to_vec()];
        let msg = make_msg_with_stores(b"main-data", stores.clone());
        write_message(a, &msg).unwrap();
        let got = read_message(b).unwrap();
        assert_eq!(got.data, b"main-data");
        assert_eq!(got.transfer_stores, stores);
        unsafe {
            libc::close(a);
            libc::close(b);
        }
    }

    #[test]
    fn multiple_messages_in_sequence() {
        let (a, b) = socketpair_fds();
        for i in 0u8..5 {
            write_message(a, &make_msg(&[i, i, i])).unwrap();
        }
        for i in 0u8..5 {
            let got = read_message(b).unwrap();
            assert_eq!(got.data, vec![i, i, i]);
        }
        unsafe {
            libc::close(a);
            libc::close(b);
        }
    }

    #[test]
    fn read_on_closed_fd_returns_error() {
        let (a, b) = socketpair_fds();
        unsafe {
            libc::close(a);
        }
        let result = read_message(b);
        assert!(result.is_err());
        unsafe {
            libc::close(b);
        }
    }
}
