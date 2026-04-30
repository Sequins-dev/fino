mod async_context;
mod docgen;
mod ffi;
mod loader;
mod platform;
mod profiler;
mod protobuf;
mod realm;
mod runtime;
mod state;

fn main() {
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

    // Normal CLI mode.
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
