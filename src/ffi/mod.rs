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
use libffi::middle::CodePtr;

use library::{DynLib, FfiSymbol};
use types::{NativeType, StructField, StructFieldKind, StructLayout, align_to};

use crate::v8util;
use call::{CallScratch, ffi_call};

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "dlopen",
        "ffiFunction",
        "Pointer",
        "FfiCallback",
        "FfiResource",
        "structType",
    ]
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
    v8::callback_scope!(unsafe let scope, context);

    let dlopen_tmpl = v8::FunctionTemplate::new(scope, dlopen_callback);
    let dlopen_fn = dlopen_tmpl.get_function(scope)?;
    let dlopen_key = v8::String::new(scope, "dlopen")?;
    module.set_synthetic_module_export(scope, dlopen_key, dlopen_fn.into())?;

    let ffi_fn_tmpl = v8::FunctionTemplate::new(scope, ffi_function_callback);
    let ffi_fn_fn = ffi_fn_tmpl.get_function(scope)?;
    let ffi_fn_key = v8::String::new(scope, "ffiFunction")?;
    module.set_synthetic_module_export(scope, ffi_fn_key, ffi_fn_fn.into())?;

    let ptr_ns = pointer::namespace(scope);
    let ptr_key = v8::String::new(scope, "Pointer")?;
    module.set_synthetic_module_export(scope, ptr_key, ptr_ns.into())?;

    let cb_tmpl = v8::FunctionTemplate::new(scope, ffi_callback_constructor);
    let cb_fn = cb_tmpl.get_function(scope)?;
    let cb_key = v8::String::new(scope, "FfiCallback")?;
    module.set_synthetic_module_export(scope, cb_key, cb_fn.into())?;

    let resource_fn =
        v8::FunctionTemplate::new(scope, ffi_resource_constructor).get_function(scope)?;
    let resource_key = v8::String::new(scope, "FfiResource")?;
    module.set_synthetic_module_export(scope, resource_key, resource_fn.into())?;

    let struct_tmpl = v8::FunctionTemplate::new(scope, struct_type_callback);
    let struct_fn = struct_tmpl.get_function(scope)?;
    let struct_key = v8::String::new(scope, "structType")?;
    module.set_synthetic_module_export(scope, struct_key, struct_fn.into())?;

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// dlopen
// ---------------------------------------------------------------------------

fn dlopen_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_val: v8::Local<v8::Value> = args.get(0);
    let defs_val: v8::Local<v8::Value> = args.get(1);

    let lib = if path_val.is_null() {
        DynLib::open_self()
    } else if path_val.is_string() {
        let path_str = path_val
            .to_string(scope)
            .expect("string value should convert to string")
            .to_rust_string_lossy(scope);
        DynLib::open(&path_str)
    } else {
        v8util::throw_error(
            scope,
            "dlopen: expected path string or null as first argument",
        );
        return;
    };

    let lib = match lib {
        Ok(l) => l,
        Err(e) => {
            v8util::throw_error(scope, &format!("dlopen: {e}"));
            return;
        }
    };

    let defs_obj = match v8::Local::<v8::Object>::try_from(defs_val) {
        Ok(o) => o,
        Err(_) => {
            v8util::throw_error(scope, "dlopen: expected object as second argument");
            return;
        }
    };

    let prop_names = match defs_obj
        .get_own_property_names(scope, v8::GetPropertyNamesArgsBuilder::new().build())
    {
        Some(names) => names,
        None => {
            v8util::throw_error(scope, "dlopen: could not read definitions");
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
                v8util::throw_error(
                    scope,
                    &format!("dlopen: definition for '{key_str}' must be an object"),
                );
                return;
            }
        };

        // Get the code pointer from the library.
        let code_ptr = {
            let borrow = lib_rc.borrow();
            match borrow.as_ref() {
                Some(lib) => match lib.symbol_ptr(&key_str) {
                    Ok(ptr) => ptr,
                    Err(e) => {
                        v8util::throw_error(scope, &format!("dlopen: symbol '{key_str}': {e}"));
                        return;
                    }
                },
                None => {
                    v8util::throw_error(scope, "dlopen: library already closed");
                    return;
                }
            }
        };

        let sym_fn = match build_symbol_function(
            scope,
            code_ptr,
            def_obj,
            Rc::clone(&lib_rc),
            &format!("dlopen: '{key_str}'"),
        ) {
            Some(f) => f,
            None => return,
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
// Shared symbol construction
// ---------------------------------------------------------------------------

/// Parse one symbol definition (`{ parameters, result, async?, fast?, variadic? }`)
/// and build the callable JS function bound to `code_ptr`.
///
/// `lib_rc` keeps the providing library loaded for as long as the returned
/// function exists. `ffiFunction` passes a permanently-empty cell because the
/// caller owns the code pointer's lifetime.
///
/// `describe` prefixes thrown errors, e.g. `dlopen: 'strlen'` or `ffiFunction`.
/// Returns `None` after throwing.
fn build_symbol_function<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    code_ptr: CodePtr,
    def_obj: v8::Local<v8::Object>,
    lib_rc: Rc<RefCell<Option<DynLib>>>,
    describe: &str,
) -> Option<v8::Local<'s, v8::Function>> {
    let params_key = v8::String::new(scope, "parameters").unwrap();
    let params_val = def_obj
        .get(scope, params_key.into())
        .unwrap_or_else(|| v8::undefined(scope).into());
    let param_types = match parse_type_array(scope, params_val) {
        Ok(t) => t,
        Err(e) => {
            v8util::throw_error(scope, &format!("{describe}.parameters: {e}"));
            return None;
        }
    };

    let result_key = v8::String::new(scope, "result").unwrap();
    let result_val = def_obj
        .get(scope, result_key.into())
        .unwrap_or_else(|| v8::undefined(scope).into());
    let result_type = match parse_native_type(scope, result_val) {
        Ok(t) => t,
        Err(e) => {
            v8util::throw_error(scope, &format!("{describe}.result: {e}"));
            return None;
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

    // Parse optional `fast: false` flag. Some native functions synchronously
    // invoke FFI callbacks back into JS and must use the normal HandleScope
    // path instead of V8 Fast API.
    let fast_enabled = {
        let fast_key = v8::String::new(scope, "fast").unwrap();
        def_obj
            .get(scope, fast_key.into())
            .map(|v| !v.is_boolean() || v.boolean_value(scope))
            .unwrap_or(true)
    };

    // Parse optional `variadic: N` — number of fixed named parameters for
    // variadic C functions (e.g. fcntl has 2 fixed params: fd, cmd).
    // Using the correct variadic CIF (ffi_prep_cif_var) is required on
    // ARM64 macOS to pass the trailing arguments with the right ABI.
    let variadic: Option<usize> = {
        let var_key = v8::String::new(scope, "variadic").unwrap();
        def_obj
            .get(scope, var_key.into())
            .and_then(|v| {
                if v.is_number() {
                    v.integer_value(scope)
                } else {
                    None
                }
            })
            .map(|n| n as usize)
    };

    let mut sym = match FfiSymbol::new(
        code_ptr,
        param_types,
        result_type,
        nonblocking,
        fast_enabled,
        variadic,
    ) {
        Ok(s) => s,
        Err(e) => {
            v8util::throw_error(scope, &format!("{describe}: {e}"));
            return None;
        }
    };

    sym.diagnostic_label = describe.to_owned();
    let sym_data = Box::new(SymbolData {
        symbol: sym,
        scratch: RefCell::new(CallScratch::new()),
        lib_rc,
    });

    // Try to build a V8 Fast API overload for this symbol.
    let fast_cfn = fast::build_fast_cfunction(&sym_data.symbol);

    let sym_ptr = Box::into_raw(sym_data);
    let ext = v8::External::new(scope, sym_ptr as *mut std::ffi::c_void);

    let sym_tmpl = if let Some(cfn) = fast_cfn {
        // V8 retains the overload table for the lifetime of the function
        // template, so rusty_v8 requires static storage here.
        let overloads = Box::leak(Box::new([cfn]));
        v8::FunctionTemplate::builder(symbol_call_callback)
            .data(ext.into())
            .build_fast(scope, overloads)
    } else {
        v8::FunctionTemplate::builder(symbol_call_callback)
            .data(ext.into())
            .build(scope)
    };
    sym_tmpl.get_function(scope)
}

// ---------------------------------------------------------------------------
// ffiFunction
// ---------------------------------------------------------------------------

/// `ffiFunction(pointer, definition)` — bind a code pointer obtained at runtime.
///
/// `dlopen` can only reach symbols by name. Function pointers handed back by
/// native code — `vkGetInstanceProcAddr` results, C struct callback fields,
/// `FfiCallback.pointer` — have no name to look up, so this is the only way to
/// call them.
///
/// The returned function does not keep anything alive: the caller must retain
/// whatever provides the code (library handle, `FfiCallback`) for as long as the
/// function is callable.
fn ffi_function_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let ptr_val: v8::Local<v8::Value> = args.get(0);
    let def_val: v8::Local<v8::Value> = args.get(1);

    // Accept a BigInt address directly as well as a pointer buffer, since
    // `Pointer.addr` and `usizeBig` returns both yield BigInts.
    let raw = if let Ok(big) = v8::Local::<v8::BigInt>::try_from(ptr_val) {
        let (addr, _) = big.u64_value();
        addr as *mut std::ffi::c_void
    } else {
        match pointer::from_js(scope, ptr_val) {
            Some(p) => p,
            None => return,
        }
    };

    if raw.is_null() {
        v8util::throw_error(scope, "ffiFunction: pointer must not be null");
        return;
    }

    let def_obj = match v8::Local::<v8::Object>::try_from(def_val) {
        Ok(o) => o,
        Err(_) => {
            v8util::throw_error(scope, "ffiFunction: expected object as second argument");
            return;
        }
    };

    let code_ptr = CodePtr::from_ptr(raw);
    let lib_rc: Rc<RefCell<Option<DynLib>>> = Rc::new(RefCell::new(None));

    if let Some(f) = build_symbol_function(scope, code_ptr, def_obj, lib_rc, "ffiFunction") {
        rv.set(f.into());
    }
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
    scope: &mut v8::PinScope<'a, '_>,
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
        if crate::state::get_state(scope).borrow().sandboxed_thread {
            v8util::throw_error(
                scope,
                "async FFI is unavailable in a sandbox Realm because the process-global blocking pool is outside its thread-local policy",
            );
            return;
        }
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
    _scope: &mut v8::PinScope,
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
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let def_obj = match v8::Local::<v8::Object>::try_from(args.get(0)) {
        Ok(o) => o,
        Err(_) => {
            v8util::throw_error(
                scope,
                "FfiCallback: expected descriptor object as first argument",
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
            v8util::throw_error(scope, &format!("FfiCallback: parameters: {e}"));
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
            v8util::throw_error(scope, &format!("FfiCallback: result: {e}"));
            return;
        }
    };
    if param_types
        .iter()
        .any(|ty| matches!(ty, NativeType::Struct(_)))
        || matches!(result_type, NativeType::Struct(_))
    {
        v8util::throw_error(
            scope,
            "FfiCallback: struct parameters and returns are not supported yet",
        );
        return;
    }

    let func_local = match v8::Local::<v8::Function>::try_from(args.get(1)) {
        Ok(f) => f,
        Err(_) => {
            v8util::throw_error(scope, "FfiCallback: expected function as second argument");
            return;
        }
    };
    let func_global = v8::Global::new(scope, func_local);

    let (handle_ptr, code_ptr) =
        match closure::new_callback(scope, param_types, result_type, func_global) {
            Ok(pair) => pair,
            Err(e) => {
                v8util::throw_error(scope, &format!("FfiCallback: {e}"));
                return;
            }
        };

    let ext = pointer::into_js(scope, handle_ptr.cast());
    register_owner_cell(
        scope,
        ext,
        Box::new(move || {
            let handle = unsafe { Box::from_raw(handle_ptr) };
            if let Some(inner) = &handle.inner {
                inner.revoke();
            }
        }),
    );
    let close_tmpl = v8::FunctionTemplate::builder(ffi_callback_close)
        .data(ext.into())
        .build(scope);
    let close_fn = match close_tmpl.get_function(scope) {
        Some(f) => f,
        None => return,
    };

    let lease_fn = match v8::FunctionTemplate::builder(ffi_callback_lease)
        .data(ext.into())
        .build(scope)
        .get_function(scope)
    {
        Some(f) => f,
        None => return,
    };
    let block_fn = v8::FunctionTemplate::builder(ffi_callback_block)
        .data(ext.into())
        .build(scope)
        .get_function(scope)
        .unwrap();
    let ptr_val = pointer::into_js(scope, code_ptr);
    let result_obj = v8::Object::new(scope);
    let ptr_key = v8::String::new(scope, "pointer").unwrap();
    let close_key = v8::String::new(scope, "close").unwrap();
    result_obj.set(scope, ptr_key.into(), ptr_val);
    result_obj.set(scope, close_key.into(), close_fn.into());
    let block_key = v8::String::new(scope, "block").unwrap();
    result_obj.set(scope, block_key.into(), block_fn.into());
    let lease_key = v8::String::new(scope, "lease").unwrap();
    result_obj.set(scope, lease_key.into(), lease_fn.into());
    if let Some(dispose_key) = symbol_property(scope, "dispose") {
        result_obj.set(scope, dispose_key, close_fn.into());
    }

    rv.set(result_obj.into());
}

fn symbol_property<'s>(
    scope: &mut v8::PinScope<'s, '_>,
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
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let raw = owned_pointer(scope, args.data(), true);
    if raw.is_null() {
        return;
    }
    let handle = unsafe { &*raw.cast::<closure::CallbackHandle>() };
    if let Some(inner) = &handle.inner {
        inner.revoke();
        crate::async_rt::js_calls::unregister_callback(handle.id);
        crate::async_rt::with_ffi_contexts(|contexts| {
            contexts.remove(&handle.id);
        });
    }
    release_owner_cell(args.data());
}

fn owned_pointer(
    scope: &mut v8::PinScope,
    value: v8::Local<v8::Value>,
    take: bool,
) -> *mut std::ffi::c_void {
    let pointer = pointer::from_js(scope, value).unwrap_or(std::ptr::null_mut());
    if take {
        if let Ok(buffer) = v8::Local::<v8::ArrayBuffer>::try_from(value) {
            if let Some(data) = buffer.data() {
                unsafe {
                    data.as_ptr().cast::<usize>().write_unaligned(0);
                }
            }
        }
    }
    pointer
}

/// A lease may be released only after its native consumer has stopped using
/// the pointer, including returning from its last invocation.
fn ffi_callback_lease(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let raw = owned_pointer(scope, args.data(), false);
    if raw.is_null() {
        v8util::throw_type_error(scope, "FfiCallback is closed");
        return;
    }
    let handle = unsafe { &*raw.cast::<closure::CallbackHandle>() };
    let Some(inner) = handle.inner.as_ref() else {
        v8util::throw_type_error(scope, "FfiCallback is closed");
        return;
    };
    let lease = std::sync::Arc::into_raw(std::sync::Arc::clone(inner));
    let external = pointer::into_js(scope, lease.cast_mut().cast());
    register_owner_cell(
        scope,
        external,
        Box::new(move || unsafe {
            drop(std::sync::Arc::from_raw(lease));
        }),
    );
    let close = v8::FunctionTemplate::builder(ffi_callback_lease_close)
        .data(external.into())
        .build(scope)
        .get_function(scope)
        .unwrap();
    let object = v8::Object::new(scope);
    let ptr = pointer::into_js(scope, handle._code_ptr);
    let key = v8::String::new(scope, "pointer").unwrap();
    object.set(scope, key.into(), ptr);
    let key = v8::String::new(scope, "close").unwrap();
    object.set(scope, key.into(), close.into());
    if let Some(key) = symbol_property(scope, "dispose") {
        object.set(scope, key, close.into());
    }
    rv.set(object.into());
}
fn ffi_callback_lease_close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    owned_pointer(scope, args.data(), true);
    release_owner_cell(args.data());
}

fn register_owner_cell(
    scope: &mut v8::PinScope,
    cell: v8::Local<v8::Value>,
    release: Box<dyn FnOnce()>,
) {
    let cell = v8::Local::<v8::ArrayBuffer>::try_from(cell).unwrap();
    let store = cell.get_backing_store();
    crate::async_rt::register_native_owner(
        cell.data().unwrap().as_ptr() as usize,
        Box::new(move || {
            release();
            drop(store);
        }),
    );
    let _ = scope;
}
fn release_owner_cell(cell: v8::Local<v8::Value>) {
    let cell = v8::Local::<v8::ArrayBuffer>::try_from(cell).unwrap();
    crate::async_rt::release_native_owner(cell.data().unwrap().as_ptr() as usize);
}

fn ffi_resource_constructor(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(pointer) = pointer::from_js(scope, args.get(0)) else {
        return;
    };
    let Some(destructor) = pointer::from_js(scope, args.get(1)) else {
        return;
    };
    if pointer.is_null() || destructor.is_null() {
        v8util::throw_type_error(scope, "FfiResource pointer and destructor must not be null");
        return;
    }
    let cell = pointer::into_js(scope, pointer);
    register_owner_cell(
        scope,
        cell,
        Box::new(move || {
            let release: unsafe extern "C" fn(*mut std::ffi::c_void) =
                unsafe { std::mem::transmute(destructor) };
            unsafe {
                release(pointer);
            }
        }),
    );
    let close = v8::FunctionTemplate::builder(ffi_callback_lease_close)
        .data(cell.into())
        .build(scope)
        .get_function(scope)
        .unwrap();
    let result = v8::Object::new(scope);
    let key = v8::String::new(scope, "pointer").unwrap();
    let pointer = pointer::into_js(scope, pointer);
    result.set(scope, key.into(), pointer);
    let key = v8::String::new(scope, "close").unwrap();
    result.set(scope, key.into(), close.into());
    if let Some(key) = symbol_property(scope, "dispose") {
        result.set(scope, key, close.into());
    }
    rv.set(result.into());
}

fn ffi_callback_block(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&args, &mut rv);
        v8util::throw_type_error(scope, "Objective-C blocks require macOS");
    }
    #[cfg(target_os = "macos")]
    {
        let raw = owned_pointer(scope, args.data(), false);
        if raw.is_null() {
            v8util::throw_type_error(scope, "FfiCallback is closed");
            return;
        }
        let handle = unsafe { &*raw.cast::<closure::CallbackHandle>() };
        let Some(inner) = handle.inner.as_ref().map(std::sync::Arc::clone) else {
            return;
        };
        // Resource getters can re-enter JS and close the callback. Hold native
        // ownership before reading them so that revocation cannot free `inner`.
        // Validate every descriptor before transferring resource ownership.
        let mut resources = Vec::new();
        if !args.get(0).is_null_or_undefined() {
            let Ok(array) = v8::Local::<v8::Array>::try_from(args.get(0)) else {
                v8util::throw_type_error(scope, "block resources must be an array");
                return;
            };
            for i in 0..array.length() {
                let Some(value) = array.get_index(scope, i) else {
                    return;
                };
                let Ok(object) = v8::Local::<v8::Object>::try_from(value) else {
                    v8util::throw_type_error(scope, "block resource must be an object");
                    return;
                };
                let key = v8::String::new(scope, "pointer").unwrap();
                let Some(value) = object.get(scope, key.into()) else {
                    return;
                };
                let Some(pointer) = pointer::from_js(scope, value) else {
                    return;
                };
                let key = v8::String::new(scope, "release").unwrap();
                let Some(value) = object.get(scope, key.into()) else {
                    return;
                };
                let Some(release) = pointer::from_js(scope, value) else {
                    return;
                };
                if release.is_null() {
                    v8util::throw_type_error(scope, "block resource release must not be null");
                    return;
                }
                resources.push((pointer as usize, release as usize));
            }
        }
        let resources = resources
            .into_iter()
            .map(|(pointer, destructor)| closure::blocks::Resource {
                pointer,
                destructor,
            })
            .collect();
        let block = closure::blocks::create(&inner, resources);
        if block.is_null() {
            v8util::throw_error(scope, "could not allocate Objective-C block");
            return;
        }
        let cell = pointer::into_js(scope, block);
        register_owner_cell(
            scope,
            cell,
            Box::new(move || unsafe {
                closure::blocks::release(block);
            }),
        );
        let close = v8::FunctionTemplate::builder(ffi_callback_block_close)
            .data(cell.into())
            .build(scope)
            .get_function(scope)
            .unwrap();
        let result = v8::Object::new(scope);
        let key = v8::String::new(scope, "pointer").unwrap();
        let pointer = pointer::into_js(scope, block);
        result.set(scope, key.into(), pointer);
        let key = v8::String::new(scope, "close").unwrap();
        result.set(scope, key.into(), close.into());
        if let Some(key) = symbol_property(scope, "dispose") {
            result.set(scope, key, close.into());
        }
        rv.set(result.into());
    }
}
#[cfg(target_os = "macos")]
fn ffi_callback_block_close(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    owned_pointer(scope, args.data(), true);
    release_owner_cell(args.data());
}

// ---------------------------------------------------------------------------
// Type parsing
// ---------------------------------------------------------------------------

fn parse_type_array(
    scope: &mut v8::PinScope,
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
    scope: &mut v8::PinScope,
    val: v8::Local<v8::Value>,
) -> Result<NativeType, String> {
    if let Some(layout) = struct_layout_from_value(scope, val) {
        return Ok(NativeType::Struct(layout));
    }
    let s = val
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .ok_or_else(|| "expected a string type name".to_string())?;
    NativeType::from_str(&s)
}

// ---------------------------------------------------------------------------
// structType
// ---------------------------------------------------------------------------

struct StructTypeData {
    layout: std::sync::Arc<StructLayout>,
}

fn struct_type_marker<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::String> {
    v8::String::new(scope, "__finoFfiStructType").unwrap()
}

fn struct_layout_from_value(
    scope: &mut v8::PinScope,
    val: v8::Local<v8::Value>,
) -> Option<std::sync::Arc<StructLayout>> {
    let obj = v8::Local::<v8::Object>::try_from(val).ok()?;
    let marker = struct_type_marker(scope);
    let ext_val = obj.get(scope, marker.into())?;
    let ext = v8::Local::<v8::External>::try_from(ext_val).ok()?;
    let data = unsafe { &*(ext.value() as *const StructTypeData) };
    Some(std::sync::Arc::clone(&data.layout))
}

fn struct_type_callback(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let fields = match parse_struct_fields(scope, args.get(0), args.get(1)) {
        Ok(layout) => layout,
        Err(e) => {
            v8util::throw_error(scope, &format!("structType: {e}"));
            return;
        }
    };
    let layout = std::sync::Arc::new(fields);
    let data = Box::new(StructTypeData {
        layout: std::sync::Arc::clone(&layout),
    });
    let data_ptr = Box::into_raw(data);
    let ext = v8::External::new(scope, data_ptr as *mut std::ffi::c_void);

    let obj = v8::Object::new(scope);
    let marker = struct_type_marker(scope);
    obj.set(scope, marker.into(), ext.into());

    set_number_prop(scope, obj, "size", layout.size as f64);
    set_number_prop(scope, obj, "align", layout.align as f64);
    set_fields_prop(scope, obj, &layout);
    set_struct_method(scope, obj, "alloc", struct_alloc);
    set_struct_method(scope, obj, "get", struct_get);
    set_struct_method(scope, obj, "set", struct_set);
    set_struct_method(scope, obj, "offsetOf", struct_offset_of);
    rv.set(obj.into());
}

fn set_number_prop(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, name: &str, value: f64) {
    let key = v8::String::new(scope, name).unwrap();
    let value = v8::Number::new(scope, value);
    obj.set(scope, key.into(), value.into());
}

fn set_fields_prop(scope: &mut v8::PinScope, obj: v8::Local<v8::Object>, layout: &StructLayout) {
    let arr = v8::Array::new(scope, layout.fields.len() as i32);
    for (i, field) in layout.fields.iter().enumerate() {
        let f = v8::Object::new(scope);
        let name_key = v8::String::new(scope, "name").unwrap();
        let name = v8::String::new(scope, &field.name).unwrap();
        f.set(scope, name_key.into(), name.into());
        set_number_prop(scope, f, "offset", field.offset as f64);
        set_number_prop(scope, f, "size", field.size as f64);
        arr.set_index(scope, i as u32, f.into());
    }
    let key = v8::String::new(scope, "fields").unwrap();
    obj.set(scope, key.into(), arr.into());
}

fn set_struct_method(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
    name: &str,
    cb: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let tmpl = v8::FunctionTemplate::new(scope, cb);
    let func = tmpl.get_function(scope).expect("struct method");
    let key = v8::String::new(scope, name).unwrap();
    obj.set(scope, key.into(), func.into());
}

fn parse_struct_fields(
    scope: &mut v8::PinScope,
    fields_val: v8::Local<v8::Value>,
    opts_val: v8::Local<v8::Value>,
) -> Result<StructLayout, String> {
    let arr = v8::Local::<v8::Array>::try_from(fields_val)
        .map_err(|_| "fields must be an array".to_string())?;
    let mut fields = Vec::new();
    let mut offset = 0usize;
    let mut max_align = 1usize;
    for i in 0..arr.length() {
        let val = arr
            .get_index(scope, i)
            .ok_or_else(|| format!("field {i} is missing"))?;
        let field =
            parse_struct_field(scope, val, &mut offset).map_err(|e| format!("field {i}: {e}"))?;
        max_align = max_align.max(field.align);
        fields.push(field);
    }

    let (size_override, align_override) = parse_struct_opts(scope, opts_val)?;
    let align = align_override.unwrap_or(max_align);
    let mut size = align_to(offset, align);
    if let Some(explicit) = size_override {
        if explicit < offset {
            return Err("opts.size is smaller than the last field".to_string());
        }
        size = explicit;
    }
    Ok(StructLayout {
        fields,
        size,
        align,
    })
}

fn parse_struct_opts(
    scope: &mut v8::PinScope,
    opts_val: v8::Local<v8::Value>,
) -> Result<(Option<usize>, Option<usize>), String> {
    if opts_val.is_undefined() || opts_val.is_null() {
        return Ok((None, None));
    }
    let obj = v8::Local::<v8::Object>::try_from(opts_val)
        .map_err(|_| "opts must be an object".to_string())?;
    Ok((
        get_usize_prop(scope, obj, "size")?,
        get_usize_prop(scope, obj, "align")?,
    ))
}

fn parse_struct_field<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    val: v8::Local<'s, v8::Value>,
    next_offset: &mut usize,
) -> Result<StructField, String> {
    let (name, ty_val, explicit_offset, padding_size) =
        if let Ok(tuple) = v8::Local::<v8::Array>::try_from(val) {
            if tuple.length() != 2 {
                return Err("tuple fields must be [name, type]".to_string());
            }
            let name = tuple
                .get_index(scope, 0)
                .and_then(|v| v.to_string(scope))
                .map(|s| s.to_rust_string_lossy(scope))
                .ok_or_else(|| "tuple name must be a string".to_string())?;
            let ty = tuple
                .get_index(scope, 1)
                .ok_or_else(|| "tuple type is missing".to_string())?;
            (name, ty, None, None)
        } else {
            let obj = v8::Local::<v8::Object>::try_from(val)
                .map_err(|_| "field must be a tuple or object".to_string())?;
            let name = get_string_prop(scope, obj, "name")?
                .ok_or_else(|| "object field requires name".to_string())?;
            let ty = get_required_prop(scope, obj, "type")?;
            let explicit_offset = get_usize_prop(scope, obj, "offset")?;
            let padding_size = get_usize_prop(scope, obj, "size")?;
            (name, ty, explicit_offset, padding_size)
        };

    let ty_name = type_name(scope, ty_val);
    let kind = if ty_name == "bytes" {
        StructFieldKind::Padding
    } else {
        StructFieldKind::Value
    };
    let (size, align, ty) = if kind == StructFieldKind::Padding {
        let size = padding_size.ok_or_else(|| "'bytes' padding requires size".to_string())?;
        (size, 1, NativeType::U8)
    } else {
        let ty = parse_native_type(scope, ty_val)?;
        if matches!(ty, NativeType::Void) {
            return Err("'void' cannot be used as a struct field".to_string());
        }
        (ty.size(), ty.align(), ty)
    };
    let offset = explicit_offset.unwrap_or_else(|| align_to(*next_offset, align));
    if offset < *next_offset {
        return Err("explicit offset overlaps a previous field".to_string());
    }
    *next_offset = offset + size;
    Ok(StructField {
        name,
        ty,
        offset,
        size,
        align,
        kind,
    })
}

fn type_name(scope: &mut v8::PinScope, val: v8::Local<v8::Value>) -> String {
    val.to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default()
}

fn get_required_prop<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<'s, v8::Object>,
    name: &str,
) -> Result<v8::Local<'s, v8::Value>, String> {
    let key = v8::String::new(scope, name).unwrap();
    obj.get(scope, key.into())
        .ok_or_else(|| format!("missing property {name}"))
}

fn get_string_prop(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
    name: &str,
) -> Result<Option<String>, String> {
    let key = v8::String::new(scope, name).unwrap();
    let val = match obj.get(scope, key.into()) {
        Some(v) if !v.is_undefined() && !v.is_null() => v,
        _ => return Ok(None),
    };
    val.to_string(scope)
        .map(|s| Some(s.to_rust_string_lossy(scope)))
        .ok_or_else(|| format!("{name} must be a string"))
}

fn get_usize_prop(
    scope: &mut v8::PinScope,
    obj: v8::Local<v8::Object>,
    name: &str,
) -> Result<Option<usize>, String> {
    let key = v8::String::new(scope, name).unwrap();
    let val = match obj.get(scope, key.into()) {
        Some(v) if !v.is_undefined() && !v.is_null() => v,
        _ => return Ok(None),
    };
    let n = val
        .integer_value(scope)
        .ok_or_else(|| format!("{name} must be an integer"))?;
    if n < 0 {
        return Err(format!("{name} must be non-negative"));
    }
    Ok(Some(n as usize))
}

fn struct_data_from_this<'a, 's>(
    scope: &mut v8::PinScope<'s, '_>,
    this: v8::Local<'s, v8::Object>,
) -> Option<&'a StructTypeData> {
    let marker = struct_type_marker(scope);
    let ext_val = this.get(scope, marker.into())?;
    let ext = v8::Local::<v8::External>::try_from(ext_val).ok()?;
    Some(unsafe { &*(ext.value() as *const StructTypeData) })
}

fn struct_alloc<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    mut rv: v8::ReturnValue,
) {
    let Some(data) = struct_data_from_this(scope, args.this()) else {
        return;
    };
    rv.set(v8::ArrayBuffer::new(scope, data.layout.size).into());
}

fn struct_offset_of<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    mut rv: v8::ReturnValue,
) {
    let Some(data) = struct_data_from_this(scope, args.this()) else {
        return;
    };
    let Some(name) = args.get(0).to_string(scope) else {
        v8util::throw_error(scope, "offsetOf: expected field name");
        return;
    };
    let name = name.to_rust_string_lossy(scope);
    let Some(field) = data.layout.field(&name) else {
        v8util::throw_error(scope, &format!("offsetOf: unknown field '{name}'"));
        return;
    };
    rv.set(v8::Integer::new_from_unsigned(scope, field.offset as u32).into());
}

fn struct_get<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    mut rv: v8::ReturnValue,
) {
    let Some(data) = struct_data_from_this(scope, args.this()) else {
        return;
    };
    let Some((base, available, _pin)) = js_buffer_bytes(scope, args.get(0)) else {
        return;
    };
    let Some(name) = args.get(1).to_string(scope) else {
        v8util::throw_error(scope, "get: expected field name");
        return;
    };
    let name = name.to_rust_string_lossy(scope);
    let Some(field) = data.layout.field(&name) else {
        v8util::throw_error(scope, &format!("get: unknown field '{name}'"));
        return;
    };
    if available < field.offset + field.size {
        v8util::throw_error(scope, "get: buffer is too small for struct field");
        return;
    }
    unsafe {
        let ptr = base.add(field.offset);
        match &field.ty {
            NativeType::Bool => rv.set(v8::Boolean::new(scope, *ptr != 0).into()),
            NativeType::U8 => rv.set(v8::Integer::new_from_unsigned(scope, *ptr as u32).into()),
            NativeType::I8 => rv.set(v8::Integer::new(scope, *(ptr as *const i8) as i32).into()),
            NativeType::U16 => rv.set(
                v8::Integer::new_from_unsigned(
                    scope,
                    std::ptr::read_unaligned(ptr as *const u16) as u32,
                )
                .into(),
            ),
            NativeType::I16 => rv.set(
                v8::Integer::new(scope, std::ptr::read_unaligned(ptr as *const i16) as i32).into(),
            ),
            NativeType::U32 => rv.set(
                v8::Integer::new_from_unsigned(scope, std::ptr::read_unaligned(ptr as *const u32))
                    .into(),
            ),
            NativeType::I32 => {
                rv.set(v8::Integer::new(scope, std::ptr::read_unaligned(ptr as *const i32)).into())
            }
            NativeType::U64 => rv.set(
                v8::BigInt::new_from_u64(scope, std::ptr::read_unaligned(ptr as *const u64)).into(),
            ),
            NativeType::I64 => rv.set(
                v8::BigInt::new_from_i64(scope, std::ptr::read_unaligned(ptr as *const i64)).into(),
            ),
            NativeType::USize | NativeType::USizeBig => rv.set(
                v8::BigInt::new_from_u64(
                    scope,
                    std::ptr::read_unaligned(ptr as *const usize) as u64,
                )
                .into(),
            ),
            NativeType::ISize | NativeType::ISizeBig => rv.set(
                v8::BigInt::new_from_i64(
                    scope,
                    std::ptr::read_unaligned(ptr as *const isize) as i64,
                )
                .into(),
            ),
            NativeType::F32 => rv.set(
                v8::Number::new(scope, std::ptr::read_unaligned(ptr as *const f32) as f64).into(),
            ),
            NativeType::F64 => {
                rv.set(v8::Number::new(scope, std::ptr::read_unaligned(ptr as *const f64)).into())
            }
            NativeType::Pointer | NativeType::IgnoredPointer | NativeType::Buffer => {
                rv.set(pointer::into_js(
                    scope,
                    std::ptr::read_unaligned(ptr as *const *mut std::ffi::c_void),
                ))
            }
            NativeType::Struct(layout) => {
                let ab = v8::ArrayBuffer::new(scope, layout.size);
                if let Some(dst) = ab.get_backing_store().data() {
                    std::ptr::copy_nonoverlapping(ptr, dst.as_ptr() as *mut u8, layout.size);
                }
                rv.set(ab.into());
            }
            NativeType::Void => rv.set(v8::undefined(scope).into()),
        }
    }
}

fn struct_set<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    args: v8::FunctionCallbackArguments<'s>,
    _rv: v8::ReturnValue,
) {
    let Some(data) = struct_data_from_this(scope, args.this()) else {
        return;
    };
    let Some((base, available, _pin)) = js_buffer_bytes(scope, args.get(0)) else {
        return;
    };
    let Some(name) = args.get(1).to_string(scope) else {
        v8util::throw_error(scope, "set: expected field name");
        return;
    };
    let name = name.to_rust_string_lossy(scope);
    let Some(field) = data.layout.field(&name) else {
        v8util::throw_error(scope, &format!("set: unknown field '{name}'"));
        return;
    };
    if available < field.offset + field.size {
        v8util::throw_error(scope, "set: buffer is too small for struct field");
        return;
    }
    let value = args.get(2);
    unsafe {
        let ptr = base.add(field.offset);
        match &field.ty {
            NativeType::Bool => *ptr = value.boolean_value(scope) as u8,
            NativeType::U8 => *ptr = value.integer_value(scope).unwrap_or(0) as u8,
            NativeType::I8 => *(ptr as *mut i8) = value.integer_value(scope).unwrap_or(0) as i8,
            NativeType::U16 => std::ptr::write_unaligned(
                ptr as *mut u16,
                value.integer_value(scope).unwrap_or(0) as u16,
            ),
            NativeType::I16 => std::ptr::write_unaligned(
                ptr as *mut i16,
                value.integer_value(scope).unwrap_or(0) as i16,
            ),
            NativeType::U32 => std::ptr::write_unaligned(
                ptr as *mut u32,
                value.integer_value(scope).unwrap_or(0) as u32,
            ),
            NativeType::I32 => std::ptr::write_unaligned(
                ptr as *mut i32,
                value.integer_value(scope).unwrap_or(0) as i32,
            ),
            NativeType::U64 => std::ptr::write_unaligned(
                ptr as *mut u64,
                value.integer_value(scope).unwrap_or(0) as u64,
            ),
            NativeType::I64 => {
                std::ptr::write_unaligned(ptr as *mut i64, value.integer_value(scope).unwrap_or(0))
            }
            NativeType::USize | NativeType::USizeBig => std::ptr::write_unaligned(
                ptr as *mut usize,
                value.integer_value(scope).unwrap_or(0) as usize,
            ),
            NativeType::ISize | NativeType::ISizeBig => std::ptr::write_unaligned(
                ptr as *mut isize,
                value.integer_value(scope).unwrap_or(0) as isize,
            ),
            NativeType::F32 => std::ptr::write_unaligned(
                ptr as *mut f32,
                value.number_value(scope).unwrap_or(0.0) as f32,
            ),
            NativeType::F64 => {
                std::ptr::write_unaligned(ptr as *mut f64, value.number_value(scope).unwrap_or(0.0))
            }
            NativeType::Pointer | NativeType::IgnoredPointer | NativeType::Buffer => {
                std::ptr::write_unaligned(
                    ptr as *mut *mut std::ffi::c_void,
                    pointer::from_js(scope, value).unwrap_or(std::ptr::null_mut()),
                )
            }
            NativeType::Struct(layout) => {
                let Some((src, src_len, _src_pin)) = js_buffer_bytes(scope, value) else {
                    return;
                };
                if src_len < layout.size {
                    v8util::throw_error(scope, "set: nested struct buffer is too small");
                    return;
                }
                std::ptr::copy_nonoverlapping(src, ptr, layout.size);
            }
            NativeType::Void => {}
        }
    }
}

fn js_buffer_bytes<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    val: v8::Local<'s, v8::Value>,
) -> Option<(*mut u8, usize, v8::SharedRef<v8::BackingStore>)> {
    let (ab, offset, len) = if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(val) {
        let len = ab.byte_length();
        (ab, 0, len)
    } else if let Ok(view) = v8::Local::<v8::ArrayBufferView>::try_from(val) {
        let len = view.byte_length();
        (view.buffer(scope)?, view.byte_offset(), len)
    } else {
        v8util::throw_error(scope, "expected an ArrayBuffer or TypedArray");
        return None;
    };
    let bs = ab.get_backing_store();
    let ptr = bs
        .data()
        .map(|p| unsafe { (p.as_ptr() as *mut u8).add(offset) })
        .unwrap_or(std::ptr::null_mut());
    Some((ptr, len, bs))
}
