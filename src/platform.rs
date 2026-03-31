use boa_engine::{
    Context, JsObject, JsResult, JsValue, Module, js_string, module::SyntheticModuleInitializer,
    object::builtins::JsArray,
};

/// Build the `internal:process` synthetic module.
///
/// Exports:
/// - `os`       — `"darwin"`, `"linux"`, etc.
/// - `arch`     — `"aarch64"`, `"x86_64"`, etc.
/// - `args`     — JS string array of `std::env::args()`
/// - `env`      — JS object of environment variable key-value pairs
/// - `execPath` — path to the boats binary
pub fn create_module(context: &mut Context) -> JsResult<Module> {
    // Resolved at compile time via cfg! / consts — both &'static str.
    let os: &'static str = if cfg!(target_os = "macos") {
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

    let arch: &'static str = if cfg!(target_arch = "x86_64") {
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

    let module = Module::synthetic(
        &[
            js_string!("os"),
            js_string!("arch"),
            js_string!("args"),
            js_string!("env"),
            js_string!("execPath"),
        ],
        SyntheticModuleInitializer::from_copy_closure(move |module, context| {
            module.set_export(&js_string!("os"), js_string!(os).into())?;
            module.set_export(&js_string!("arch"), js_string!(arch).into())?;

            // Build args array at runtime — std::env::args() is called here, not captured.
            let js_args = JsArray::new(context);
            for arg in std::env::args() {
                js_args.push(JsValue::from(js_string!(arg.as_str())), context)?;
            }
            module.set_export(&js_string!("args"), js_args.into())?;

            // Build env object from current environment variables.
            let env_obj = JsObject::with_object_proto(context.intrinsics());
            for (key, val) in std::env::vars() {
                env_obj.set(
                    js_string!(key.as_str()),
                    js_string!(val.as_str()),
                    false,
                    context,
                )?;
            }
            module.set_export(&js_string!("env"), env_obj.into())?;

            // Path to the boats binary.
            let exec_path = std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            module.set_export(
                &js_string!("execPath"),
                js_string!(exec_path.as_str()).into(),
            )?;

            Ok(())
        }),
        None,
        None,
        context,
    );

    Ok(module)
}
