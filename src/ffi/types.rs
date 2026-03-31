use std::ffi::c_void;

use libffi::middle::Type as FfiType;

use boa_engine::{JsNativeError, JsResult};

/// The set of C types that can cross the FFI boundary.
#[derive(Debug, Clone, PartialEq)]
pub enum NativeType {
    Void,
    Bool,
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
    USize,
    ISize,
    F32,
    F64,
    /// Opaque C pointer (`void*`). Represented in JS as a `BoatsPointer` object or `null`.
    Pointer,
    /// A JS `ArrayBuffer` / typed array passed as a `void*` to its backing data.
    Buffer,
}

impl NativeType {
    pub fn from_str(s: &str) -> JsResult<Self> {
        match s {
            "void" => Ok(Self::Void),
            "bool" => Ok(Self::Bool),
            "u8" => Ok(Self::U8),
            "i8" => Ok(Self::I8),
            "u16" => Ok(Self::U16),
            "i16" => Ok(Self::I16),
            "u32" => Ok(Self::U32),
            "i32" => Ok(Self::I32),
            "u64" => Ok(Self::U64),
            "i64" => Ok(Self::I64),
            "usize" => Ok(Self::USize),
            "isize" => Ok(Self::ISize),
            "f32" => Ok(Self::F32),
            "f64" => Ok(Self::F64),
            "pointer" => Ok(Self::Pointer),
            "buffer" => Ok(Self::Buffer),
            _ => Err(JsNativeError::typ()
                .with_message(format!("Unknown FFI type: '{s}'"))
                .into()),
        }
    }

    pub fn to_ffi_type(&self) -> FfiType {
        match self {
            Self::Void => FfiType::void(),
            Self::Bool | Self::U8 => FfiType::u8(),
            Self::I8 => FfiType::i8(),
            Self::U16 => FfiType::u16(),
            Self::I16 => FfiType::i16(),
            Self::U32 => FfiType::u32(),
            Self::I32 => FfiType::i32(),
            Self::U64 => FfiType::u64(),
            Self::I64 => FfiType::i64(),
            Self::USize => FfiType::usize(),
            Self::ISize => FfiType::isize(),
            Self::F32 => FfiType::f32(),
            Self::F64 => FfiType::f64(),
            // Both pointer and buffer are passed as a C pointer.
            Self::Pointer | Self::Buffer => FfiType::pointer(),
        }
    }

    /// Whether this type is valid as a function parameter (not void).
    pub fn is_param_type(&self) -> bool {
        !matches!(self, Self::Void)
    }
}

/// Stack-allocated union that can hold any native FFI value.
/// Fields are accessed unsafely based on the corresponding `NativeType`.
#[repr(C)]
pub union NativeValue {
    pub u8_val: u8,
    pub i8_val: i8,
    pub u16_val: u16,
    pub i16_val: i16,
    pub u32_val: u32,
    pub i32_val: i32,
    pub u64_val: u64,
    pub i64_val: i64,
    pub f32_val: f32,
    pub f64_val: f64,
    pub usize_val: usize,
    pub isize_val: isize,
    pub ptr_val: *mut c_void,
}

impl Default for NativeValue {
    fn default() -> Self {
        // SAFETY: zero-initialising a union of numeric types is valid.
        unsafe { std::mem::zeroed() }
    }
}
