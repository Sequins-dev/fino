use std::{path::Path, rc::Rc};

use boa_engine::{Context, JsError, Module, Source, builtins::promise::PromiseState};

use crate::{
    async_context::{AsyncContextStore, BoatsJobExecutor},
    loader::BoatsModuleLoader,
};

/// Evaluate the embedded `js/_main.mjs` entrypoint with `root` as the module
/// loader's base directory. `_main.mjs` reads process args from `boats:process`
/// and drives the event loop internally, so this function returns only when all
/// work is complete.
pub fn run(root: &Path) -> Result<(), String> {
    let loader = Rc::new(BoatsModuleLoader::new(root));
    let store = Rc::new(AsyncContextStore::new());
    let executor = Rc::new(BoatsJobExecutor::new(store));

    let mut context = Context::builder()
        .module_loader(loader)
        .job_executor(executor)
        .build()
        .map_err(|e| format!("Failed to build context: {e}"))?;

    // The entrypoint is embedded at compile time so there is no file to open.
    let entrypoint = include_str!(concat!(env!("OUT_DIR"), "/js/_main.mjs"));
    let source = Source::from_bytes(entrypoint.as_bytes());

    let module = Module::parse(source, None, &mut context)
        .map_err(|e| format!("Parse error: {}", format_js_error(&e, &mut context)))?;

    let promise = module.load_link_evaluate(&mut context);

    // `_main.mjs` is a synchronous module: its while-loop drives I/O and
    // microtasks to completion before returning. A single run_jobs() flushes
    // any remaining promise reactions after the module body finishes.
    context.run_jobs().map_err(|e| format!("Job error: {e}"))?;

    match promise.state() {
        PromiseState::Fulfilled(_) => Ok(()),
        PromiseState::Rejected(reason) => {
            let msg = reason
                .to_string(&mut context)
                .map(|s| s.to_std_string_escaped())
                .unwrap_or_else(|_| "Unknown error".to_string());
            Err(msg)
        }
        PromiseState::Pending => Err("Module evaluation did not complete".to_string()),
    }
}

fn format_js_error(err: &JsError, context: &mut Context) -> String {
    if let Some(native) = err.as_native() {
        format!("{native}")
    } else {
        err.to_opaque(context)
            .to_string(context)
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_else(|_| "Unknown error".to_string())
    }
}
