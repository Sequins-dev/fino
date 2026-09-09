#[cfg(unix)]
extern crate libc;

mod async_context;
mod async_rt;
mod async_runtime_module;
mod fdutil;
mod ffi;
mod inspector_module;
mod loader;
mod native_io;
mod net_native;
mod platform;
mod profiler;
mod protobuf;
mod realm;
mod runtime;
mod scheduler_native;
mod state;
mod typescript_format;
mod v8_isolate_group;
mod v8util;

fn main() {
    use std::io::Write;
    use std::os::fd::FromRawFd;
    // Keep a close-on-exec copy for fatal host errors. Runtime-wide output
    // capture may have redirected fd 2, and a broken main loop cannot drain it.
    let error_fd = unsafe { libc::fcntl(libc::STDERR_FILENO, libc::F_DUPFD_CLOEXEC, 0) };
    let mut fatal_stderr = if error_fd >= 0 {
        Some(unsafe { std::fs::File::from_raw_fd(error_fd) })
    } else {
        None
    };

    // Server processes must not die on broken-pipe writes. Network connections
    // can be reset by the remote at any time; SIGPIPE would kill the process.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    // Linux signalfd only receives signals that are blocked in the receiving
    // thread. Block signals used by persistent JS watches before V8/runtime
    // worker threads are created so the mask is inherited process-wide; JS
    // signal() then creates signalfds for the selected signal numbers.
    #[cfg(target_os = "linux")]
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGUSR1);
        libc::sigaddset(&mut set, libc::SIGUSR2);
        libc::sigaddset(&mut set, libc::SIGWINCH);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }

    let args: Vec<String> = std::env::args().collect();

    // Check for the process-realm child mode before any other initialisation.
    // When spawned by a parent realm, the binary is invoked as:
    //   fino --realm-child <socket_fd>
    if let Some(pos) = args.iter().position(|a| a == "--realm-child") {
        let fd: i32 = args.get(pos + 1).and_then(|s| s.parse().ok()).unwrap_or(-1);
        if fd < 0 {
            eprintln!("fino: --realm-child requires a valid file descriptor");
            std::process::exit(1);
        }
        match realm::process::read_spawn_config(fd) {
            Err(e) => {
                eprintln!("fino: failed to read spawn config: {e}");
                std::process::exit(1);
            }
            Ok(config) => {
                if let Err(e) = realm::process::run_process_child(fd, config) {
                    eprintln!("[process-realm error] {e}");
                    std::process::exit(1);
                }
            }
        }
        return;
    }

    let process_env = state::ProcessEnv {
        root: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        args,
        env_vars: std::env::vars().collect(),
        exec_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };

    if let Err(e) = runtime::run(process_env) {
        if let Some(output) = fatal_stderr.as_mut() {
            let _ = writeln!(output, "[error] {e}");
        } else {
            eprintln!("[error] {e}");
        }
        std::process::exit(1);
    }
}
