mod async_context;
mod ffi;
mod loader;
mod platform;
mod runtime;

fn main() {
    // Use CWD as the module loader root so relative imports work from wherever
    // the user invokes boats. Argument parsing is handled entirely in JS by
    // js/_main.mjs, which reads boats:process.argv.
    let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));

    if let Err(e) = runtime::run(&root) {
        eprintln!("[error] {e}");
        std::process::exit(1);
    }
}
