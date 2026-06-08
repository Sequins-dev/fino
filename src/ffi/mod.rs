//! V8 `fino:ffi` synthetic module.

pub mod call;
pub mod closure;
pub mod fast;
pub mod library;
pub mod pointer;
pub mod types;

use std::cell::RefCell;
use std::rc::Rc;

use ::v8;

use library::{DynLib, FfiSymbol};
use types::NativeType;

use call::{CallScratch, ffi_call};

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["dlopen", "Pointer", "FfiCallback"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();
    let name = v8::String::new(scope, "fino:ffi").unwrap();
    v8::Module::create_synthetic_module(scope, name, &export_names, ffi_eval)
}

fn ffi_eval<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    let dlopen_tmpl = v8::FunctionTemplate::new(scope, dlopen_callback);
    let dlopen_fn = dlopen_tmpl.get_function(scope)?;
    let dlopen_key = v8::String::new(scope, "dlopen")?;
    module.set_synthetic_module_export(scope, dlopen_key, dlopen_fn.into())?;

    let ptr_ns = pointer::namespace(scope);
    let ptr_key = v8::String::new(scope, "Pointer")?;
    module.set_synthetic_module_export(scope, ptr_key, ptr_ns.into())?;

    let cb_tmpl = v8::FunctionTemplate::new(scope, ffi_callback_constructor);
    let cb_fn = cb_tmpl.get_function(scope)?;
    let cb_key = v8::String::new(scope, "FfiCallback")?;
    module.set_synthetic_module_export(scope, cb_key, cb_fn.into())?;

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// dlopen
// ---------------------------------------------------------------------------

fn dlopen_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_val: v8::Local<v8::Value> = args.get(0);
    let defs_val: v8::Local<v8::Value> = args.get(1);

    let path_str = match path_val.to_string(scope) {
        Some(s) => s.to_rust_string_lossy(scope),
        None => {
            throw_error(scope, "dlopen: expected path string as first argument");
            return;
        }
    };

    let lib = match DynLib::open(&path_str) {
        Ok(l) => l,
        Err(e) => {
            throw_error(scope, &format!("dlopen: {e}"));
            return;
        }
    };

    let defs_obj = match v8::Local::<v8::Object>::try_from(defs_val) {
        Ok(o) => o,
        Err(_) => {
            throw_error(scope, "dlopen: expected object as second argument");
            return;
        }
    };

    let prop_names = match defs_obj
        .get_own_property_names(scope, v8::GetPropertyNamesArgsBuilder::new().build())
    {
        Some(names) => names,
        None => {
            throw_error(scope, "dlopen: could not read definitions");
            return;
        }
    };

    let lib_rc: Rc<RefCell<Option<DynLib>>> = Rc::new(RefCell::new(Some(lib)));
    let symbols_obj = v8::Object::new(scope);
    let pointers_obj = v8::Object::new(scope);
    let n = prop_names.length();

    for i in 0..n {
        let key_val: v8::Local<v8::Value> = match prop_names.get_index(scope, i) {
            Some(v) => v,
            None => continue,
        };
        let key_str = match key_val.to_string(scope) {
            Some(s) => s.to_rust_string_lossy(scope),
            None => continue,
        };

        let def_val = match defs_obj.get(scope, key_val) {
            Some(v) => v,
            None => continue,
        };
        let def_obj = match v8::Local::<v8::Object>::try_from(def_val) {
            Ok(o) => o,
            Err(_) => {
                throw_error(
                    scope,
                    &format!("dlopen: definition for '{key_str}' must be an object"),
                );
                return;
            }
        };

        let params_key = v8::String::new(scope, "parameters").unwrap();
        let params_val = def_obj
            .get(scope, params_key.into())
            .unwrap_or_else(|| v8::undefined(scope).into());
        let param_types = match parse_type_array(scope, params_val) {
            Ok(t) => t,
            Err(e) => {
                throw_error(scope, &format!("dlopen: '{key_str}'.parameters: {e}"));
                return;
            }
        };

        let result_key = v8::String::new(scope, "result").unwrap();
        let result_val = def_obj
            .get(scope, result_key.into())
            .unwrap_or_else(|| v8::undefined(scope).into());
        let result_type = match parse_native_type(scope, result_val) {
            Ok(t) => t,
            Err(e) => {
                throw_error(scope, &format!("dlopen: '{key_str}'.result: {e}"));
                return;
            }
        };

        // Parse optional `async: true` flag.
        let nonblocking = {
            let async_key = v8::String::new(scope, "async").unwrap();
            def_obj
                .get(scope, async_key.into())
                .map(|v| v.boolean_value(scope))
                .unwrap_or(false)
        };

        // Parse optional `variadic: N` — number of fixed named parameters for
        // variadic C functions (e.g. fcntl has 2 fixed params: fd, cmd).
        // Using the correct variadic CIF (ffi_prep_cif_var) is required on
        // ARM64 macOS to pass the trailing arguments with the right ABI.
        let variadic: Option<usize> = {
            let var_key = v8::String::new(scope, "variadic").unwrap();
            def_obj
                .get(scope, var_key.into())
                .and_then(|v| if v.is_number() { v.integer_value(scope) } else { None })
                .map(|n| n as usize)
        };

        // Validate: async symbols may not use pointer/buffer params (GC safety).
        if nonblocking {
            use types::NativeType;
            for ty in &param_types {
                if matches!(ty, NativeType::Buffer) {
                    throw_error(
                        scope,
                        &format!(
                            "dlopen: '{key_str}': async symbols cannot use 'buffer' \
                             parameters (GC may collect the ArrayBuffer before the \
                             background thread reads it); use 'pointer' instead"
                        ),
                    );
                    return;
                }
            }
        }

        // Get the code pointer from the library.
        let code_ptr = {
            let borrow = lib_rc.borrow();
            match borrow.as_ref() {
                Some(lib) => match lib.symbol_ptr(&key_str) {
                    Ok(ptr) => ptr,
                    Err(e) => {
                        throw_error(scope, &format!("dlopen: symbol '{key_str}': {e}"));
                        return;
                    }
                },
                None => {
                    throw_error(scope, "dlopen: library already closed");
                    return;
                }
            }
        };

        let sym = match FfiSymbol::new(code_ptr, param_types, result_type, nonblocking, variadic) {
            Ok(s) => s,
            Err(e) => {
                throw_error(scope, &format!("dlopen: symbol '{key_str}': {e}"));
                return;
            }
        };

        let sym_data = Box::new(SymbolData {
            symbol: sym,
            scratch: RefCell::new(CallScratch::new()),
            lib_rc: Rc::clone(&lib_rc),
        });

        // Try to build a V8 Fast API overload for this symbol.
        let fast_cfn = fast::build_fast_cfunction(&sym_data.symbol);

        let sym_ptr = Box::into_raw(sym_data);
        let ext = v8::External::new(scope, sym_ptr as *mut std::ffi::c_void);

        let sym_tmpl = if let Some(cfn) = fast_cfn {
            v8::FunctionTemplate::builder(symbol_call_callback)
                .data(ext.into())
                .build_fast(scope, &[cfn])
        } else {
            v8::FunctionTemplate::builder(symbol_call_callback)
                .data(ext.into())
                .build(scope)
        };
        let sym_fn = match sym_tmpl.get_function(scope) {
            Some(f) => f,
            None => continue,
        };

        let name_key = v8::String::new(scope, &key_str).unwrap();
        let ptr_val = pointer::into_js(scope, code_ptr.as_ptr() as *mut std::ffi::c_void);
        pointers_obj.set(scope, name_key.into(), ptr_val);
        symbols_obj.set(scope, name_key.into(), sym_fn.into());
    }

    let close_data = Box::new(CloseData {
        lib_rc: Rc::clone(&lib_rc),
    });
    let close_ptr = Box::into_raw(close_data);
    let close_ext = v8::External::new(scope, close_ptr as *mut std::ffi::c_void);
    let close_tmpl = v8::FunctionTemplate::builder(close_callback)
        .data(close_ext.into())
        .build(scope);
    let close_fn = close_tmpl.get_function(scope).expect("close fn");

    let result_obj = v8::Object::new(scope);
    let sym_key = v8::String::new(scope, "symbols").unwrap();
    let pointers_key = v8::String::new(scope, "pointers").unwrap();
    let close_key = v8::String::new(scope, "close").unwrap();
    result_obj.set(scope, sym_key.into(), symbols_obj.into());
    result_obj.set(scope, pointers_key.into(), pointers_obj.into());
    result_obj.set(scope, close_key.into(), close_fn.into());

    rv.set(result_obj.into());
}

// ---------------------------------------------------------------------------
// Per-symbol state
// ---------------------------------------------------------------------------

pub(super) struct SymbolData {
    pub symbol: FfiSymbol,
    pub scratch: RefCell<CallScratch>,
    #[allow(dead_code)]
    pub lib_rc: Rc<RefCell<Option<DynLib>>>,
}

struct CloseData {
    lib_rc: Rc<RefCell<Option<DynLib>>>,
}

fn symbol_call_callback<'a>(
    scope: &mut v8::HandleScope<'a>,
    args: v8::FunctionCallbackArguments<'a>,
    mut rv: v8::ReturnValue,
) {
    let ext = match v8::Local::<v8::External>::try_from(args.data()) {
        Ok(e) => e,
        Err(_) => return,
    };
    let sym_data = unsafe { &*(ext.value() as *const SymbolData) };
    let count = args.length() as usize;
    let js_args: Vec<v8::Local<v8::Value>> = (0..count).map(|i| args.get(i as i32)).collect();

    if sym_data.symbol.nonblocking {
        // Async path: offload to blocking pool, return a Promise.
        if let Some(promise) = call::ffi_call_async(scope, &sym_data.symbol, &js_args) {
            rv.set(promise.into());
        }
    } else {
        // Sync path (unchanged).
        let mut scratch = sym_data.scratch.borrow_mut();
        if let Some(result) = ffi_call(scope, &sym_data.symbol, &js_args, &mut scratch) {
            rv.set(result);
        }
    }
}

fn close_callback(
    _scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let ext = match v8::Local::<v8::External>::try_from(args.data()) {
        Ok(e) => e,
        Err(_) => return,
    };
    let close_data = unsafe { &*(ext.value() as *const CloseData) };
    *close_data.lib_rc.borrow_mut() = None;
}

// ---------------------------------------------------------------------------
// FfiCallback
// ---------------------------------------------------------------------------

fn ffi_callback_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let def_obj = match v8::Local::<v8::Object>::try_from(args.get(0)) {
        Ok(o) => o,
        Err(_) => {
            throw_error(scope, "FfiCallback: expected descriptor object as first argument");
            return;
        }
    };

    let params_key = v8::String::new(scope, "parameters").unwrap();
    let params_val = def_obj
        .get(scope, params_key.into())
        .unwrap_or_else(|| v8::undefined(scope).into());
    let param_types = match parse_type_array(scope, params_val) {
        Ok(t) => t,
        Err(e) => {
            throw_error(scope, &format!("FfiCallback: parameters: {e}"));
            return;
        }
    };

    let result_key = v8::String::new(scope, "result").unwrap();
    let result_val = def_obj
        .get(scope, result_key.into())
        .unwrap_or_else(|| v8::undefined(scope).into());
    let result_type = match parse_native_type(scope, result_val) {
        Ok(t) => t,
        Err(e) => {
            throw_error(scope, &format!("FfiCallback: result: {e}"));
            return;
        }
    };

    let func_local = match v8::Local::<v8::Function>::try_from(args.get(1)) {
        Ok(f) => f,
        Err(_) => {
            throw_error(scope, "FfiCallback: expected function as second argument");
            return;
        }
    };
    let func_global = v8::Global::new(scope, func_local);

    let (handle_ptr, code_ptr) =
        match closure::new_callback(scope, param_types, result_type, func_global) {
            Ok(pair) => pair,
            Err(e) => {
                throw_error(scope, &format!("FfiCallback: {e}"));
                return;
            }
        };

    let ext = v8::External::new(scope, handle_ptr as *mut std::ffi::c_void);
    let close_tmpl = v8::FunctionTemplate::builder(ffi_callback_close)
        .data(ext.into())
        .build(scope);
    let close_fn = match close_tmpl.get_function(scope) {
        Some(f) => f,
        None => return,
    };

    let ptr_val = pointer::into_js(scope, code_ptr);
    let result_obj = v8::Object::new(scope);
    let ptr_key = v8::String::new(scope, "pointer").unwrap();
    let close_key = v8::String::new(scope, "close").unwrap();
    result_obj.set(scope, ptr_key.into(), ptr_val);
    result_obj.set(scope, close_key.into(), close_fn.into());
    if let Some(dispose_key) = symbol_property(scope, "dispose") {
        result_obj.set(scope, dispose_key, close_fn.into());
    }

    rv.set(result_obj.into());
}

fn symbol_property<'s>(
    scope: &mut v8::HandleScope<'s>,
    name: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    let context = scope.get_current_context();
    let global = context.global(scope);
    let symbol_key = v8::String::new(scope, "Symbol")?;
    let symbol_obj =
        v8::Local::<v8::Object>::try_from(global.get(scope, symbol_key.into())?).ok()?;
    let name_key = v8::String::new(scope, name)?;
    let symbol = symbol_obj.get(scope, name_key.into())?;
    if symbol.is_symbol() {
        Some(symbol)
    } else {
        None
    }
}

fn ffi_callback_close(
    _scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let ext = match v8::Local::<v8::External>::try_from(args.data()) {
        Ok(e) => e,
        Err(_) => return,
    };
    let handle = unsafe { &mut *(ext.value() as *mut closure::CallbackHandle) };
    if let Some(_inner) = handle.inner.take() {
        crate::async_rt::js_calls::unregister_callback(handle.id);
        // _inner drops here, freeing the Closure and CallbackData
    }
}

// ---------------------------------------------------------------------------
// Type parsing
// ---------------------------------------------------------------------------

fn parse_type_array(
    scope: &mut v8::HandleScope,
    val: v8::Local<v8::Value>,
) -> Result<Vec<NativeType>, String> {
    let arr = v8::Local::<v8::Array>::try_from(val).map_err(|_| "expected an array".to_string())?;
    let mut types = Vec::with_capacity(arr.length() as usize);
    for i in 0..arr.length() {
        let elem = arr
            .get_index(scope, i)
            .ok_or_else(|| format!("index {i} is missing"))?;
        types.push(parse_native_type(scope, elem)?);
    }
    Ok(types)
}

fn parse_native_type(
    scope: &mut v8::HandleScope,
    val: v8::Local<v8::Value>,
) -> Result<NativeType, String> {
    let s = val
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .ok_or_else(|| "expected a string type name".to_string())?;
    NativeType::from_str(&s)
}

fn throw_error(scope: &mut v8::HandleScope, msg: &str) {
    if let Some(msg_str) = v8::String::new(scope, msg) {
        let exc = v8::Exception::error(scope, msg_str);
        scope.throw_exception(exc);
    }
}
