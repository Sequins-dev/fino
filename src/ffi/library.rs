use std::ffi::c_void;

use libffi::middle::{Cif, CodePtr};
use libloading::Library;

use boa_engine::{JsNativeError, JsResult};

use crate::ffi::types::NativeType;

/// A loaded shared library. Kept alive by `Rc` in all symbol closures so
/// the library is only unloaded when every reference is gone (or `close()` is
/// called explicitly).
pub struct DynLib {
    pub lib: Library,
}

impl DynLib {
    pub fn open(path: &str) -> JsResult<Self> {
        // SAFETY: loading a library runs its init code; the caller controls
        // which library path is supplied.
        let lib = unsafe { Library::new(path) }.map_err(|e| {
            JsNativeError::error().with_message(format!("dlopen failed for '{path}': {e}"))
        })?;
        Ok(Self { lib })
    }

    /// Look up `name` in the library and return a raw code pointer.
    pub fn symbol_ptr(&self, name: &str) -> JsResult<CodePtr> {
        // Append null terminator to avoid an allocation inside libloading.
        let mut name_z: Vec<u8> = name.as_bytes().to_vec();
        name_z.push(0);

        unsafe {
            let sym: libloading::Symbol<*const c_void> = self.lib.get(&name_z).map_err(|e| {
                JsNativeError::error().with_message(format!("Symbol '{name}' not found: {e}"))
            })?;
            Ok(CodePtr::from_ptr(*sym))
        }
    }
}

/// A resolved FFI symbol: a function pointer paired with its pre-built `Cif`
/// and the declared JS-level parameter / return types.
///
/// The `Cif` is built once at `dlopen` time and reused on every call.
pub struct FfiSymbol {
    pub code_ptr: CodePtr,
    pub cif: Cif,
    pub param_types: Vec<NativeType>,
    pub result_type: NativeType,
}

impl FfiSymbol {
    pub fn new(
        code_ptr: CodePtr,
        param_types: Vec<NativeType>,
        result_type: NativeType,
    ) -> JsResult<Self> {
        // Validate: void may only appear as the return type.
        for ty in &param_types {
            if !ty.is_param_type() {
                return Err(JsNativeError::typ()
                    .with_message("'void' cannot be used as a parameter type")
                    .into());
            }
        }

        let ffi_params: Vec<_> = param_types.iter().map(|t| t.to_ffi_type()).collect();
        let ffi_result = result_type.to_ffi_type();
        let cif = Cif::new(ffi_params, ffi_result);

        Ok(Self {
            code_ptr,
            cif,
            param_types,
            result_type,
        })
    }
}
