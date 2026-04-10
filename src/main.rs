mod async_context;
mod docgen;
mod ffi;
mod library;
mod loader;
mod platform;
mod profiler;
mod protobuf;
mod realm;
mod runtime;
mod serializer;
mod state;
mod thread_realm;
mod types;

fn main() {
    // Use CWD as the module loader root so relative imports work from wherever
    // the user invokes fino. Argument parsing is handled entirely in JS by
    // js/_main.mjs, which reads fino:process.argv.
    let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    if let Err(e) = runtime::run(&root) {
        eprintln!("[error] {e}");
        std::process::exit(1);
    }
}
