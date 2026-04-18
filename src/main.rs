mod async_context;
mod broadcast;
mod docgen;
mod ffi;
mod loader;
mod platform;
mod profiler;
mod protobuf;
mod realm;
mod runtime;
mod serializer;
mod state;
mod thread_realm;
mod transit;

fn main() {
    // Capture the real process environment once here so every Realm can be
    // virtualised against these values instead of reading globals directly.
    let process_env = state::ProcessEnv {
        root: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        args: std::env::args().collect(),
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
