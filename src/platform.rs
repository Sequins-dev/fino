use std::ffi::c_void;

use v8;

use crate::state::get_state;
use crate::v8util;

/// Build the `internal:process` synthetic module.
///
/// Exports: `os`, `arch`, `args`, `env`, `execPath`, `version`, and the
/// allocation-free sandbox launcher finalization primitive.
pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "os",
        "arch",
        "args",
        "env",
        "execPath",
        "version",
        "finalizeSandboxExec",
    ]
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

    let finalize = v8::Function::new(scope, finalize_sandbox_exec)?;
    set_export(scope, module, "finalizeSandboxExec", finalize.into())?;

    Some(v8::undefined(scope).into())
}

fn buffer_parts<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> Option<(*mut u8, usize, v8::SharedRef<v8::BackingStore>)> {
    let (buffer, offset, length) = if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value)
    {
        let length = buffer.byte_length();
        (buffer, 0, length)
    } else if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(value) {
        let length = view.byte_length();
        (view.buffer(scope)?, view.byte_offset(), length)
    } else {
        v8util::throw_type_error(scope, "finalizeSandboxExec expects buffer arguments");
        return None;
    };
    let backing = buffer.get_backing_store();
    let pointer = backing
        .data()
        .map(|pointer| unsafe { (pointer.as_ptr() as *mut u8).add(offset) })
        .unwrap_or(std::ptr::null_mut());
    Some((pointer, length, backing))
}

#[cfg(all(unix, target_os = "linux"))]
unsafe fn last_errno() -> i32 {
    unsafe { libc::__errno_location().read() }
}

#[cfg(all(unix, any(target_os = "macos", target_os = "freebsd")))]
unsafe fn last_errno() -> i32 {
    unsafe { libc::__error().read() }
}

/// Finish the self-sandboxing launcher without returning to V8 after applying
/// an address-space limit. V8 may allocate while returning from an ordinary FFI
/// call, so `setrlimit(RLIMIT_AS)` and `execve()` cannot safely be separate
/// JavaScript operations when the payload limit is below V8's reserved cage.
///
/// TypeScript still prepares every argument, policy, report frame, and seccomp
/// program. This callback only pins those buffers and performs the final
/// allocation-free syscall sequence. Any syscall failure hard-exits the
/// short-lived launcher; returning to V8 could itself violate the new limit.
#[cfg(unix)]
fn finalize_sandbox_exec<'a>(
    scope: &mut v8::PinScope<'a, '_>,
    args: v8::FunctionCallbackArguments<'a>,
    _rv: v8::ReturnValue,
) {
    let fd = args.get(0).integer_value(scope).unwrap_or(-1) as i32;
    let Some((report, report_len, _report_pin)) = buffer_parts(scope, args.get(1)) else {
        return;
    };
    let Some((command, _, _command_pin)) = buffer_parts(scope, args.get(2)) else {
        return;
    };
    let Some((argv, _, _argv_pin)) = buffer_parts(scope, args.get(3)) else {
        return;
    };
    let Some((envp, _, _envp_pin)) = buffer_parts(scope, args.get(4)) else {
        return;
    };
    let memory_bytes = args.get(5).integer_value(scope).unwrap_or(0) as libc::rlim_t;
    let pids = args.get(6).integer_value(scope).unwrap_or(0) as libc::rlim_t;
    let seccomp = if args.get(7).is_null_or_undefined() {
        None
    } else {
        let Some(parts) = buffer_parts(scope, args.get(7)) else {
            return;
        };
        Some(parts)
    };
    let seccomp_filters = if args.get(8).is_null_or_undefined() {
        None
    } else {
        let Some(parts) = buffer_parts(scope, args.get(8)) else {
            return;
        };
        Some(parts)
    };

    unsafe {
        if pids > 0 {
            let limit = libc::rlimit {
                rlim_cur: pids,
                rlim_max: pids,
            };
            if libc::setrlimit(libc::RLIMIT_NPROC, &limit) != 0 {
                libc::_exit(126);
            }
        }
        if memory_bytes > 0 {
            let limit = libc::rlimit {
                rlim_cur: memory_bytes,
                rlim_max: memory_bytes,
            };
            if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 {
                libc::_exit(126);
            }
        }

        let mut written = 0usize;
        while written < report_len {
            let count = libc::write(
                fd,
                report.add(written).cast::<c_void>(),
                report_len - written,
            );
            if count > 0 {
                written += count as usize;
                continue;
            }
            if count < 0 && last_errno() == libc::EINTR {
                continue;
            }
            libc::_exit(126);
        }

        #[cfg(target_os = "linux")]
        if let Some((program, _, _program_pin)) = seccomp {
            let _filters_pin = seccomp_filters;
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::prctl(libc::PR_SET_SECCOMP, 2, program, 0, 0) != 0
            {
                libc::_exit(126);
            }
        }

        libc::execve(
            command.cast::<libc::c_char>(),
            argv.cast::<*const libc::c_char>().cast_const(),
            envp.cast::<*const libc::c_char>().cast_const(),
        );
        libc::_exit(127);
    }
}

#[cfg(not(unix))]
fn finalize_sandbox_exec<'a>(
    scope: &mut v8::PinScope<'a, '_>,
    _args: v8::FunctionCallbackArguments<'a>,
    _rv: v8::ReturnValue,
) {
    v8util::throw_type_error(scope, "finalizeSandboxExec is only available on Unix");
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
