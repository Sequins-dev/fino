pub mod call;
pub mod library;
pub mod pointer;
pub mod types;

use std::{cell::RefCell, rc::Rc};

use boa_engine::{
    Context, JsNativeError, JsObject, JsResult, JsValue, Module, NativeFunction, js_string,
    module::SyntheticModuleInitializer, object::FunctionObjectBuilder,
};
use boa_gc::{Finalize, Trace};

use library::{DynLib, FfiSymbol};
use pointer::BoatsPointer;
use types::NativeType;

use crate::ffi::call::ffi_call;

/// Build the `boats:ffi` synthetic module.
///
/// Exports:
/// - `dlopen(path, definitions)` → `{ symbols, close }`
/// - `Pointer` → object with `.null()` static method
pub fn create_module(context: &mut Context) -> JsResult<Module> {
    let module = Module::synthetic(
        &[js_string!("dlopen"), js_string!("Pointer")],
        SyntheticModuleInitializer::from_copy_closure(|module, context| {
            // dlopen
            let dlopen_fn =
                FunctionObjectBuilder::new(context.realm(), NativeFunction::from_fn_ptr(dlopen))
                    .name(js_string!("dlopen"))
                    .length(2)
                    .build();
            module.set_export(&js_string!("dlopen"), dlopen_fn.into())?;

            // Pointer namespace object  { null() }
            let pointer_obj = BoatsPointer::namespace(context)?;
            module.set_export(&js_string!("Pointer"), pointer_obj.into())?;

            Ok(())
        }),
        None,
        None,
        context,
    );

    Ok(module)
}

// ---------------------------------------------------------------------------
// Captures for GC-traced closures
// ---------------------------------------------------------------------------

/// GC-safe handle that keeps a `DynLib` alive via `Rc<RefCell<Option<DynLib>>>`.
/// Wrapping in `Option` allows explicit `close()` to drop the library early.
#[derive(Trace, Finalize, Clone)]
struct LibHandle {
    #[unsafe_ignore_trace]
    inner: Rc<RefCell<Option<DynLib>>>,
}

impl LibHandle {
    fn new(lib: DynLib) -> Self {
        Self {
            inner: Rc::new(RefCell::new(Some(lib))),
        }
    }

    fn close(&self) {
        self.inner.borrow_mut().take();
    }
}

/// Captures for a single symbol's `NativeFunction` closure.
#[derive(Trace, Finalize, Clone)]
struct SymbolCapture {
    /// Keeps the library alive for the lifetime of this symbol closure.
    #[allow(dead_code)]
    lib: LibHandle,
    #[unsafe_ignore_trace]
    symbol: Rc<FfiSymbol>,
}

// ---------------------------------------------------------------------------
// dlopen implementation
// ---------------------------------------------------------------------------

/// `dlopen(path, definitions) -> { symbols, close }`
///
/// `definitions` is an object of the form:
/// ```js
/// {
///   symbolName: { parameters: ["i32", "i32"], result: "i32" },
///   ...
/// }
/// ```
fn dlopen(_this: &JsValue, args: &[JsValue], context: &mut Context) -> JsResult<JsValue> {
    let path = args
        .first()
        .ok_or_else(|| JsNativeError::typ().with_message("dlopen requires a path argument"))?
        .to_string(context)?
        .to_std_string_escaped();

    let defs_val = args
        .get(1)
        .ok_or_else(|| {
            JsNativeError::typ().with_message("dlopen requires a symbol definitions argument")
        })?
        .clone();

    let defs_obj = defs_val.as_object().ok_or_else(|| {
        JsNativeError::typ().with_message("dlopen: symbol definitions must be an object")
    })?;

    // Open the library.
    let lib = DynLib::open(&path)?;
    let lib_handle = LibHandle::new(lib);

    // Build the symbols object.
    let symbols_obj = JsObject::with_object_proto(context.intrinsics());

    let def_keys = defs_obj.own_property_keys(context)?;
    for key in def_keys {
        let name = match &key {
            boa_engine::property::PropertyKey::String(s) => s.to_std_string_escaped(),
            boa_engine::property::PropertyKey::Symbol(_) => continue,
            boa_engine::property::PropertyKey::Index(i) => i.get().to_string(),
        };

        let def = defs_obj
            .get(key.clone(), context)?
            .as_object()
            .ok_or_else(|| {
                JsNativeError::typ()
                    .with_message(format!("Definition for '{name}' must be an object"))
            })?
            .clone();

        let (param_types, result_type) = parse_symbol_def(&def, &name, context)?;

        let code_ptr = {
            let inner = lib_handle.inner.borrow();
            let dynlib = inner
                .as_ref()
                .ok_or_else(|| JsNativeError::error().with_message("Library has been closed"))?;
            dynlib.symbol_ptr(&name)?
        };

        let arity = param_types.len();
        let ffi_symbol = Rc::new(FfiSymbol::new(code_ptr, param_types, result_type)?);

        let capture = SymbolCapture {
            lib: lib_handle.clone(),
            symbol: ffi_symbol,
        };

        let sym_fn = FunctionObjectBuilder::new(
            context.realm(),
            NativeFunction::from_copy_closure_with_captures(
                |_this, args, capture, context| ffi_call(&capture.symbol, args, context),
                capture,
            ),
        )
        .name(js_string!(name.as_str()))
        .length(arity)
        .build();

        symbols_obj.set(js_string!(name.as_str()), sym_fn, false, context)?;
    }

    // Build the library object returned to JS.
    let lib_obj = JsObject::with_object_proto(context.intrinsics());

    lib_obj.set(js_string!("symbols"), symbols_obj, false, context)?;

    // close() drops the library.
    let close_handle = lib_handle.clone();
    let close_fn = FunctionObjectBuilder::new(
        context.realm(),
        NativeFunction::from_copy_closure_with_captures(
            |_this, _args, handle, _context| {
                handle.close();
                Ok(JsValue::undefined())
            },
            close_handle,
        ),
    )
    .name(js_string!("close"))
    .length(0)
    .build();

    lib_obj.set(js_string!("close"), close_fn, false, context)?;

    Ok(JsValue::from(lib_obj))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_symbol_def(
    def: &JsObject,
    name: &str,
    context: &mut Context,
) -> JsResult<(Vec<NativeType>, NativeType)> {
    let result_str = def
        .get(js_string!("result"), context)?
        .to_string(context)?
        .to_std_string_escaped();
    let result_type = NativeType::from_str(&result_str)?;

    let params_val = def.get(js_string!("parameters"), context)?;
    let mut param_types = Vec::new();

    if !params_val.is_undefined() {
        let params_obj = params_val.as_object().ok_or_else(|| {
            JsNativeError::typ().with_message(format!("'{name}.parameters' must be an array"))
        })?;

        let len = params_obj
            .get(js_string!("length"), context)?
            .to_u32(context)?;

        for i in 0..len {
            let ty_str = params_obj
                .get(i, context)?
                .to_string(context)?
                .to_std_string_escaped();
            param_types.push(NativeType::from_str(&ty_str)?);
        }
    }

    Ok((param_types, result_type))
}
