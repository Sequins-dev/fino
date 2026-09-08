use std::ffi::c_void;

use libffi::middle::{Cif, CodePtr};
use libloading::Library;

use super::types::NativeType;
use crate::ffi::fast::{self, FastCallKind};

/// A loaded shared library. Kept alive by `Rc` in all symbol closures so
/// the library is only unloaded when every reference is gone (or `close()` is
/// called explicitly).
pub struct DynLib {
    pub lib: Library,
}

impl DynLib {
    pub fn open(path: &str) -> Result<Self, String> {
        // SAFETY: loading a library runs its init code; the caller controls
        // which library path is supplied.
        let lib = unsafe { Library::new(path) }
            .map_err(|e| format!("dlopen failed for '{path}': {e}"))?;
        Ok(Self { lib })
    }

    #[cfg(unix)]
    pub fn open_self() -> Result<Self, String> {
        Ok(Self {
            lib: libloading::os::unix::Library::this().into(),
        })
    }

    #[cfg(windows)]
    pub fn open_self() -> Result<Self, String> {
        let lib = libloading::os::windows::Library::this()
            .map_err(|e| format!("failed to open current process: {e}"))?;
        Ok(Self { lib: lib.into() })
    }

    /// Look up `name` in the library and return a raw code pointer.
    pub fn symbol_ptr(&self, name: &str) -> Result<CodePtr, String> {
        // Append null terminator to avoid an allocation inside libloading.
        let mut name_z: Vec<u8> = name.as_bytes().to_vec();
        name_z.push(0);

        unsafe {
            let sym: libloading::Symbol<*const c_void> = self
                .lib
                .get(&name_z)
                .map_err(|e| format!("Symbol '{name}' not found: {e}"))?;
            Ok(CodePtr::from_ptr(*sym))
        }
    }
}

/// A resolved FFI symbol: a function pointer paired with its pre-built `Cif`
/// and the declared JS-level parameter / return types.
///
/// The `Cif` is built once at `dlopen` time and reused on every call.
pub struct FfiSymbol {
    pub diagnostic_label: String,
    pub code_ptr: CodePtr,
    pub cif: Cif,
    pub param_types: Vec<NativeType>,
    pub result_type: NativeType,
    pub fast_call_kind: FastCallKind,
    /// When `true`, calls are dispatched to the blocking thread pool and
    /// return a JS `Promise`. Buffer params pin their backing stores in
    /// `AsyncFfiWork`; pointer params are raw addresses and callers must ensure
    /// the pointed-to memory outlives the call.
    pub nonblocking: bool,
}

impl FfiSymbol {
    pub fn new(
        code_ptr: CodePtr,
        param_types: Vec<NativeType>,
        result_type: NativeType,
        nonblocking: bool,
        fast_enabled: bool,
        variadic: Option<usize>,
    ) -> Result<Self, String> {
        // Validate: void may only appear as the return type.
        for ty in &param_types {
            if !ty.is_param_type() {
                return Err("'void' cannot be used as a parameter type".to_string());
            }
        }

        if let Some(n) = variadic {
            if n >= param_types.len() {
                return Err(format!(
                    "'variadic' count ({n}) must be less than total param count ({})",
                    param_types.len()
                ));
            }
        }

        let ffi_params: Vec<_> = param_types.iter().map(|t| t.to_ffi_type()).collect();
        let ffi_result = result_type.to_ffi_type();
        let cif = if let Some(n) = variadic {
            Cif::new_variadic(ffi_params, n, ffi_result)
        } else {
            Cif::new(ffi_params, ffi_result)
        };

        Ok(Self {
            diagnostic_label: String::new(),
            code_ptr,
            cif,
            fast_call_kind: if !fast_enabled || nonblocking || variadic.is_some() {
                // Async symbols: Promise return can't be a scalar fast-call return.
                // Variadic symbols: call_direct uses non-variadic extern-C fn types
                // which misplace variadic args on ARM64 and other platforms.
                fast::FastCallKind::None
            } else {
                fast::classify_fast_call(&param_types, &result_type)
            },
            param_types,
            result_type,
            nonblocking,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_scalar_fast_symbols() {
        let sym = FfiSymbol::new(
            CodePtr::from_ptr(std::ptr::null()),
            vec![NativeType::I32, NativeType::U32, NativeType::USize],
            NativeType::I32,
            false,
            true,
            None,
        )
        .unwrap();

        assert!(matches!(
            sym.fast_call_kind,
            crate::ffi::fast::FastCallKind::Scalar
        ));
    }

    #[test]
    fn classifies_pointer_fast_symbols() {
        let sym = FfiSymbol::new(
            CodePtr::from_ptr(std::ptr::null()),
            vec![NativeType::I32, NativeType::Buffer],
            NativeType::I32,
            false,
            true,
            None,
        )
        .unwrap();

        assert!(matches!(
            sym.fast_call_kind,
            crate::ffi::fast::FastCallKind::Pointer
        ));
    }

    #[test]
    fn rejects_non_fast_symbols() {
        let sym = FfiSymbol::new(
            CodePtr::from_ptr(std::ptr::null()),
            vec![NativeType::F64],
            NativeType::I32,
            false,
            true,
            None,
        )
        .unwrap();

        assert!(matches!(
            sym.fast_call_kind,
            crate::ffi::fast::FastCallKind::None
        ));
    }

    #[test]
    fn variadic_forces_no_fast_call() {
        let sym = FfiSymbol::new(
            CodePtr::from_ptr(std::ptr::null()),
            vec![NativeType::I32, NativeType::I32, NativeType::I32],
            NativeType::I32,
            false,
            true,
            Some(2),
        )
        .unwrap();

        assert!(matches!(
            sym.fast_call_kind,
            crate::ffi::fast::FastCallKind::None
        ));
    }

    #[test]
    fn explicit_fast_disable_forces_no_fast_call() {
        let sym = FfiSymbol::new(
            CodePtr::from_ptr(std::ptr::null()),
            vec![NativeType::Pointer, NativeType::USize],
            NativeType::I32,
            false,
            false,
            None,
        )
        .unwrap();

        assert!(matches!(
            sym.fast_call_kind,
            crate::ffi::fast::FastCallKind::None
        ));
    }
}
