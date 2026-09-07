//! Process Realm infrastructure.
//!
//! Spawns a separate OS process with its own `v8::Isolate` for hard crash
//! isolation.  A child crash cannot corrupt the parent's heap; the OS enforces
//! I/O separation.
//!
//! ## IPC
//!
//! A close-on-exec Unix socketpair gives a bidirectional channel. Parent keeps
//! `fd[0]` (non-blocking, registered with the event loop). The pre-exec child
//! sweep closes every unrelated descriptor and preserves only `fd[1]`, which a
//! bridge thread reads into an mpsc channel so `native_recv` works unchanged.
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
    os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
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

fn set_cloexec(fd: RawFd, enabled: bool) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let next = if enabled {
        flags | libc::FD_CLOEXEC
    } else {
        flags & !libc::FD_CLOEXEC
    };
    if unsafe { libc::fcntl(fd, libc::F_SETFD, next) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn set_nonblocking(fd: RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn close_fds(fds: &[RawFd]) {
    for &fd in fds {
        if fd >= 0 {
            unsafe { libc::close(fd) };
        }
    }
}

fn create_cloexec_socketpair() -> std::io::Result<[RawFd; 2]> {
    let mut fds = [-1; 2];
    #[cfg(target_os = "linux")]
    let socket_type = libc::SOCK_STREAM | libc::SOCK_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let socket_type = libc::SOCK_STREAM;
    if unsafe { libc::socketpair(libc::AF_UNIX, socket_type, 0, fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(not(target_os = "linux"))]
    for &fd in &fds {
        if let Err(error) = set_cloexec(fd, true) {
            close_fds(&fds);
            return Err(error);
        }
    }
    Ok(fds)
}

fn create_cloexec_pipe() -> std::io::Result<[RawFd; 2]> {
    let mut fds = [-1; 2];
    #[cfg(target_os = "linux")]
    let result = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
    #[cfg(not(target_os = "linux"))]
    let result = unsafe { libc::pipe(fds.as_mut_ptr()) };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    #[cfg(not(target_os = "linux"))]
    for &fd in &fds {
        if let Err(error) = set_cloexec(fd, true) {
            close_fds(&fds);
            return Err(error);
        }
    }
    Ok(fds)
}

fn mark_open_fds_cloexec(max_fd: RawFd) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let result = unsafe {
            libc::syscall(
                libc::SYS_close_range,
                3u32,
                u32::MAX,
                libc::CLOSE_RANGE_CLOEXEC,
            )
        };
        if result == 0 {
            return Ok(());
        }
    }
    for fd in 3..max_fd {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EBADF) {
                continue;
            }
            return Err(error);
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

fn prepare_child_exec_fds(child_fd: RawFd, max_fd: RawFd) -> std::io::Result<()> {
    mark_open_fds_cloexec(max_fd)?;
    set_cloexec(child_fd, false)
}

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
    let hl = check_u32(msg.header.len(), "process realm IPC header length")?;
    payload.extend_from_slice(&hl.to_be_bytes());
    payload.extend_from_slice(&msg.header);
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

    let hl = u32_at!();
    let header = p[pos..pos + hl].to_vec();
    pos += hl;
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
        header,
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
                    let mut pfd = libc::pollfd {
                        fd,
                        events: libc::POLLIN,
                        revents: 0,
                    };
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
    #[serde(default)]
    pub realm_data: Option<String>,
    #[serde(default)]
    pub realm_bootstrap_data: Option<String>,
}

// ---------------------------------------------------------------------------
// Parent-side handle
// ---------------------------------------------------------------------------

pub struct ProcessRealmHandle {
    /// PID of the isolated child, used for fail-closed forced termination.
    pub child_pid: libc::pid_t,
    /// Shared with the bridge threads so their descriptor cannot be recycled
    /// before they stop using it. Dropping the handle shuts down the socket.
    socket: Arc<OwnedFd>,
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
    /// Completion-pipe read end — becomes readable once the child has exited.
    ///
    /// Separate from `parent_wake_read` on purpose. Message arrival and process
    /// exit are watched by different parts of the parent realm, and a realm can
    /// only hold one readiness watch per descriptor, so sharing one pipe would
    /// make the two waiters displace each other.
    pub completion_wake_read: RawFd,
}

impl Drop for ProcessRealmHandle {
    fn drop(&mut self) {
        unsafe {
            // close alone does not wake a poll already holding the socket,
            // and bridge threads must never read a recycled descriptor.
            libc::shutdown(self.socket.as_raw_fd(), libc::SHUT_RDWR);
            libc::close(self.parent_wake_read);
            libc::close(self.completion_wake_read);
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
    pub realm_data: Option<String>,
    pub realm_bootstrap_data: Option<String>,
}

/// Spawn a new process realm and return the parent-side handle.
pub fn spawn_process_realm(args: SpawnArgs) -> Result<ProcessRealmHandle, String> {
    use std::os::unix::process::CommandExt;

    let fds = create_cloexec_socketpair().map_err(|error| format!("socketpair: {error}"))?;
    let (parent_fd, child_fd) = (fds[0], fds[1]);

    // Wake-pipe for the parent (reader bridge writes here on each message).
    let wfds = create_cloexec_pipe().map_err(|error| {
        close_fds(&fds);
        format!("process realm wake pipe: {error}")
    })?;
    let (parent_wake_read, parent_wake_write) = (wfds[0], wfds[1]);
    let cfds = create_cloexec_pipe().map_err(|error| {
        close_fds(&fds);
        close_fds(&wfds);
        format!("process realm completion pipe: {error}")
    })?;
    let (completion_wake_read, completion_wake_write) = (cfds[0], cfds[1]);
    for fd in [
        completion_wake_read,
        completion_wake_write,
        parent_wake_read,
        parent_wake_write,
    ] {
        if let Err(error) = set_nonblocking(fd) {
            close_fds(&fds);
            close_fds(&wfds);
            close_fds(&cfds);
            return Err(format!("process realm nonblocking pipe: {error}"));
        }
    }

    // Serialise spawn config.
    let cfg = SpawnConfig {
        entry_path: args.entry_path,
        import_rules: args.import_rules,
        root: args.process_env.root.to_string_lossy().into_owned(),
        args: args.process_env.args.clone(),
        watch_mode: args.watch_mode,
        realm_data: args.realm_data,
        realm_bootstrap_data: args.realm_bootstrap_data,
        env_vars: args.process_env.env_vars.clone(),
        exec_path: args.process_env.exec_path.clone(),
        package_map_json: args.package_map_json,
    };
    let config_json = serde_json::to_string(&cfg).map_err(|error| {
        close_fds(&fds);
        close_fds(&wfds);
        close_fds(&cfds);
        error.to_string()
    })?;
    let config_msg = ThreadMessage {
        header: Vec::new(),
        data: config_json.into_bytes(),
        transfer_stores: Vec::new(),
        transfer_ports: Vec::new(),
    };

    // Spawn child process.
    let exe = std::env::current_exe().map_err(|error| {
        close_fds(&fds);
        close_fds(&wfds);
        close_fds(&cfds);
        error.to_string()
    })?;
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--realm-child").arg(child_fd.to_string());

    // A process Realm receives exactly one inherited runtime descriptor: its
    // transport socket. Mark every other descriptor close-on-exec in the forked
    // child, including descriptors owned by concurrently running Realms.
    let configured_max_fd = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    let max_fd = if configured_max_fd > 3 {
        RawFd::try_from(configured_max_fd).unwrap_or(65_536)
    } else {
        65_536
    };
    unsafe {
        cmd.pre_exec(move || prepare_child_exec_fds(child_fd, max_fd));
    }

    let mut child = cmd.spawn().map_err(|error| {
        close_fds(&fds);
        close_fds(&wfds);
        close_fds(&cfds);
        format!("spawn: {error}")
    })?;
    let child_pid = child.id() as libc::pid_t;

    // Parent closes the child's fd.
    unsafe { libc::close(child_fd) };

    // Write spawn config while parent_fd is still blocking — the child may not
    // be reading yet and a non-blocking write could EAGAIN on a fresh socket.
    if let Err(error) = write_message(parent_fd, &config_msg) {
        close_fds(&[parent_fd]);
        close_fds(&wfds);
        close_fds(&cfds);
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("write config: {error}"));
    }

    // Now switch parent_fd to non-blocking for the async event-loop phase.
    if let Err(error) = set_nonblocking(parent_fd) {
        close_fds(&[parent_fd]);
        close_fds(&wfds);
        close_fds(&cfds);
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("process realm socket nonblocking: {error}"));
    }
    std::mem::forget(child); // reaping is handled by the reader thread
    // All bridge access retains this descriptor. Shutdown belongs to the Realm
    // handle, while the final close waits for both bridge threads to finish.
    let socket = Arc::new(unsafe { OwnedFd::from_raw_fd(parent_fd) });

    // Bridge threads.
    let (reader_tx, parent_rx) = mpsc::channel::<ThreadMessage>();
    let (parent_tx, writer_rx) = mpsc::channel::<ThreadMessage>();
    let done = Arc::new(AtomicBool::new(false));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let reload_requested = Arc::new(AtomicBool::new(false));

    // Reader: socket → mpsc + wake pipe; also reaps the child process.
    {
        let socket = Arc::clone(&socket);
        let done = done.clone();
        let error = error.clone();
        let reload_requested = reload_requested.clone();
        std::thread::spawn(move || {
            loop {
                match read_message(socket.as_raw_fd()) {
                    Ok(msg) => {
                        // Check for a child-side entry-error sentinel.
                        if msg.data.starts_with(ENTRY_ERROR_PREFIX) {
                            let err_msg =
                                String::from_utf8_lossy(&msg.data[ENTRY_ERROR_PREFIX.len()..])
                                    .into_owned();
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
            // Final wake so a pending drain sees the last message, then signal
            // exit on the completion pipe so the parent is woken rather than
            // having to poll for the flag.
            let b = [1u8];
            unsafe {
                libc::write(parent_wake_write, b.as_ptr() as _, 1);
                libc::write(completion_wake_write, b.as_ptr() as _, 1);
                libc::close(parent_wake_write);
                libc::close(completion_wake_write);
            }
        });
    }

    // Writer: mpsc → socket.
    {
        let socket = Arc::clone(&socket);
        let error = error.clone();
        std::thread::spawn(move || {
            while let Ok(msg) = writer_rx.recv() {
                if let Err(e) = write_message(socket.as_raw_fd(), &msg) {
                    *error.lock().unwrap() = Some(format!("process realm write: {e}"));
                    break;
                }
            }
        });
    }

    Ok(ProcessRealmHandle {
        child_pid,
        socket,
        done,
        error,
        reload_requested,
        rx: parent_rx,
        tx: parent_tx,
        parent_wake_read,
        completion_wake_read,
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
    let wfds = create_cloexec_pipe().map_err(|error| format!("child wake pipe: {error}"))?;
    let (wake_read, wake_write) = (wfds[0], wfds[1]);
    for fd in wfds {
        if let Err(error) = set_nonblocking(fd) {
            close_fds(&wfds);
            return Err(format!("child wake pipe nonblocking: {error}"));
        }
    }

    std::thread::spawn(move || {
        loop {
            match read_message(socket_fd) {
                Ok(msg) => {
                    let _ = reader_tx.send(msg);
                    let b = [1u8];
                    unsafe { libc::write(wake_write, b.as_ptr() as _, 1) };
                }
                Err(_) => {
                    unsafe { libc::close(wake_write) };
                    break;
                }
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
        realm_data: config.realm_data,
        realm_bootstrap_data: config.realm_bootstrap_data,
        sandboxed_thread: false,
        sandbox_cgroup_path: None,
        isolate_handle: None,
        force_requested: None,
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
            header: Vec::new(),
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
            header: Vec::new(),
            data: data.to_vec(),
            transfer_stores: Vec::new(),
            transfer_ports: Vec::new(),
        }
    }

    fn make_msg_with_stores(data: &[u8], stores: Vec<Vec<u8>>) -> ThreadMessage {
        ThreadMessage {
            header: Vec::new(),
            data: data.to_vec(),
            transfer_stores: stores,
            transfer_ports: Vec::new(),
        }
    }

    #[test]
    fn dropping_handle_shuts_down_a_retained_bridge_endpoint() {
        let (parent, child) = socketpair_fds();
        // A blocked poll retains the open socket even after another thread
        // closes its descriptor. Dup models that retained reference without
        // depending on a thread reaching poll at a particular instant.
        let retained = unsafe { libc::dup(parent) };
        assert!(retained >= 0);
        set_nonblocking(retained).unwrap();
        let (_, rx) = mpsc::channel();
        let (tx, _) = mpsc::channel();
        let handle = ProcessRealmHandle {
            child_pid: -1,
            socket: Arc::new(unsafe { OwnedFd::from_raw_fd(parent) }),
            done: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
            reload_requested: Arc::new(AtomicBool::new(false)),
            rx,
            tx,
            parent_wake_read: -1,
            completion_wake_read: -1,
        };
        drop(handle);
        let mut byte = 0u8;
        let result = unsafe { libc::read(retained, (&mut byte as *mut u8).cast(), 1) };
        let error = std::io::Error::last_os_error();
        close_fds(&[retained, child]);
        assert_eq!(
            result, 0,
            "bridge must see shutdown, not wait forever: {error}"
        );
    }

    #[test]
    fn bridge_retains_its_descriptor_after_handle_shutdown() {
        let (parent, child) = socketpair_fds();
        let (_, rx) = mpsc::channel();
        let (tx, _) = mpsc::channel();
        let handle = ProcessRealmHandle {
            child_pid: -1,
            socket: Arc::new(unsafe { OwnedFd::from_raw_fd(parent) }),
            done: Arc::new(AtomicBool::new(false)),
            error: Arc::new(Mutex::new(None)),
            reload_requested: Arc::new(AtomicBool::new(false)),
            rx,
            tx,
            parent_wake_read: -1,
            completion_wake_read: -1,
        };
        let bridge = Arc::clone(&handle.socket);
        drop(handle);
        let valid = unsafe { libc::fcntl(bridge.as_raw_fd(), libc::F_GETFD) };
        let mut byte = 0u8;
        let read = unsafe { libc::read(bridge.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
        let (other_read, other_write) = socketpair_fds();
        assert_ne!(
            other_read,
            bridge.as_raw_fd(),
            "another Realm cannot reuse the bridge fd"
        );
        assert_ne!(other_write, bridge.as_raw_fd());
        close_fds(&[child, other_read, other_write]);
        assert!(
            valid >= 0,
            "bridge retains a valid descriptor until it exits"
        );
        assert_eq!(read, 0, "the retained socket reports shutdown");
    }

    /// The envelope header must survive the process-realm wire format intact,
    /// since it is what tells the far side whether a frame is a call, a result,
    /// or ordinary application traffic.
    #[test]
    fn round_trip_preserves_envelope_header() {
        let (a, b) = socketpair_fds();
        let msg = ThreadMessage {
            header: vec![1, 4, 9, 16],
            data: b"payload".to_vec(),
            transfer_stores: vec![b"store".to_vec()],
            transfer_ports: Vec::new(),
        };
        write_message(a, &msg).unwrap();
        let got = read_message(b).unwrap();
        assert_eq!(got.header, vec![1, 4, 9, 16]);
        assert_eq!(got.data, b"payload".to_vec());
        assert_eq!(got.transfer_stores, vec![b"store".to_vec()]);
        unsafe {
            libc::close(a);
            libc::close(b);
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
