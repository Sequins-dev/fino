#[cfg(unix)]
extern crate libc;

mod async_context;
mod async_rt;
mod async_runtime_module;
mod ffi;
mod inspector_module;
mod loader;
mod net_native;
mod platform;
mod profiler;
mod protobuf;
mod realm;
mod runtime;
mod scheduler_native;
mod state;
mod typescript_format;
mod v8_threading;

fn main() {
    // Server processes must not die on broken-pipe writes. Network connections
    // can be reset by the remote at any time; SIGPIPE would kill the process.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    // Linux signalfd only receives signals that are blocked in the receiving
    // thread. Block them before V8/runtime worker threads are created so the
    // mask is inherited process-wide; JS signal() then creates signalfds for
    // the selected signal numbers.
    //
    // Only signals whose default action is "ignore" are blocked here. Those
    // are safe to mask unconditionally: a program that never calls signal()
    // behaves identically either way. Signals that terminate by default
    // (SIGINT, SIGTERM, ...) are deliberately left unblocked so the runtime
    // does not silently swallow them for programs that never handle them.
    #[cfg(target_os = "linux")]
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGUSR1);
        libc::sigaddset(&mut set, libc::SIGUSR2);
        // Without this, SIGWINCH is discarded before signalfd ever sees it
        // and terminal resize never reaches JS.
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
        eprintln!("[error] {e}");
        std::process::exit(1);
    }
}
