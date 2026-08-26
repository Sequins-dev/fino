use v8;

use crate::state::get_state;

/// Build the `internal:process` synthetic module.
///
/// Exports: `os`, `arch`, `args`, `env`, `execPath`, `version`.
pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> =
        ["os", "arch", "args", "env", "execPath", "version"]
            .iter()
            .map(|n| v8::String::new(scope, n).unwrap())
            .collect();

    let module_name = v8::String::new(scope, "internal:process").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    v8::callback_scope!(unsafe let scope, context);

    let os: &str = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else {
        "unknown"
    };

    let arch: &str = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else if cfg!(target_arch = "arm") {
        "arm"
    } else {
        "unknown"
    };

    let os_str = v8::String::new(scope, os)?;
    set_export(scope, module, "os", os_str.into())?;
    let arch_str = v8::String::new(scope, arch)?;
    set_export(scope, module, "arch", arch_str.into())?;

    let state_rc = get_state(scope);
    let state = state_rc.borrow();
    let process_env = &state.process_env;

    // args array
    let args_arr = v8::Array::new(scope, 0);
    for (i, arg) in process_env.args.iter().enumerate() {
        let v = v8::String::new(scope, arg)?;
        args_arr.set_index(scope, i as u32, v.into());
    }
    set_export(scope, module, "args", args_arr.into())?;

    // env object
    let env_obj = v8::Object::new(scope);
    for (k, v) in &process_env.env_vars {
        let key = v8::String::new(scope, k)?;
        let val = v8::String::new(scope, v)?;
        env_obj.set(scope, key.into(), val.into());
    }
    set_export(scope, module, "env", env_obj.into())?;

    // execPath
    let exec_val = v8::String::new(scope, &process_env.exec_path.clone())?;
    set_export(scope, module, "execPath", exec_val.into())?;

    let version = v8::String::new(scope, env!("CARGO_PKG_VERSION"))?;
    set_export(scope, module, "version", version.into())?;

    Some(v8::undefined(scope).into())
}

fn set_export<'a>(
    scope: &mut v8::PinScope<'a, '_>,
    module: v8::Local<'a, v8::Module>,
    name: &str,
    value: v8::Local<'a, v8::Value>,
) -> Option<bool> {
    let key = v8::String::new(scope, name)?;
    module.set_synthetic_module_export(scope, key, value)
}
