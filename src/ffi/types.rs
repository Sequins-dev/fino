use std::ffi::c_void;
use std::sync::Arc;

use libffi::middle::Type as FfiType;

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
    /// Pointer-sized unsigned integer marshalled as a JS `BigInt` in both
    /// directions. ABI-identical to `USize`; use when the full 64-bit range
    /// matters and `USize`'s `number` (f64) return would lose precision.
    USizeBig,
    /// Pointer-sized signed integer marshalled as a JS `BigInt`. ABI-identical
    /// to `ISize`; the `BigInt` counterpart of `ISize`.
    ISizeBig,
    F32,
    F64,
    /// Opaque C pointer (`void*`). Represented in JS as a `FinoPointer` object or `null`.
    Pointer,
    /// Callback-only pointer parameter that is intentionally not materialized in JS.
    IgnoredPointer,
    /// A JS `ArrayBuffer` / typed array passed as a `void*` to its backing data.
    Buffer,
    /// A C aggregate passed or returned by value.
    Struct(Arc<StructLayout>),
}

impl NativeType {
    pub fn from_str(s: &str) -> Result<Self, String> {
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
            "usizeBig" => Ok(Self::USizeBig),
            "isizeBig" => Ok(Self::ISizeBig),
            "f32" => Ok(Self::F32),
            "f64" => Ok(Self::F64),
            "pointer" => Ok(Self::Pointer),
            "ignoredPointer" => Ok(Self::IgnoredPointer),
            "buffer" => Ok(Self::Buffer),
            _ => Err(format!("Unknown FFI type: '{s}'")),
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
            Self::USize | Self::USizeBig => FfiType::usize(),
            Self::ISize | Self::ISizeBig => FfiType::isize(),
            Self::F32 => FfiType::f32(),
            Self::F64 => FfiType::f64(),
            // Both pointer and buffer are passed as a C pointer.
            Self::Pointer | Self::IgnoredPointer | Self::Buffer => FfiType::pointer(),
            Self::Struct(layout) => layout.to_ffi_type(),
        }
    }

    pub fn size(&self) -> usize {
        match self {
            Self::Void => 0,
            Self::Bool | Self::U8 | Self::I8 => 1,
            Self::U16 | Self::I16 => 2,
            Self::U32 | Self::I32 | Self::F32 => 4,
            Self::U64 | Self::I64 | Self::F64 => 8,
            Self::USize
            | Self::ISize
            | Self::USizeBig
            | Self::ISizeBig
            | Self::Pointer
            | Self::IgnoredPointer
            | Self::Buffer => std::mem::size_of::<usize>(),
            Self::Struct(layout) => layout.size,
        }
    }

    pub fn align(&self) -> usize {
        match self {
            Self::Void | Self::Bool | Self::U8 | Self::I8 => 1,
            Self::U16 | Self::I16 => 2,
            Self::U32 | Self::I32 | Self::F32 => 4,
            Self::U64 | Self::I64 | Self::F64 => 8,
            Self::USize
            | Self::ISize
            | Self::USizeBig
            | Self::ISizeBig
            | Self::Pointer
            | Self::IgnoredPointer
            | Self::Buffer => std::mem::align_of::<usize>(),
            Self::Struct(layout) => layout.align,
        }
    }

    /// Whether this type is valid as a function parameter (not void).
    pub fn is_param_type(&self) -> bool {
        !matches!(self, Self::Void)
    }

    /// Whether this type can be used as a V8 Fast API call parameter.
    /// Excludes floats (different register class) and void.
    pub fn is_fast_param(&self) -> bool {
        !matches!(
            self,
            Self::Void | Self::IgnoredPointer | Self::F32 | Self::F64 | Self::Struct(_)
        )
    }

    /// Whether this type can be used as a V8 Fast API call return type.
    /// Excludes floats, buffer, and pointer. Pointer returns an ArrayBuffer
    /// which cannot be expressed as a scalar fast-call return value.
    pub fn is_fast_return(&self) -> bool {
        !matches!(
            self,
            Self::Buffer
                | Self::Pointer
                | Self::IgnoredPointer
                | Self::F32
                | Self::F64
                | Self::Struct(_)
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StructLayout {
    pub fields: Vec<StructField>,
    pub size: usize,
    pub align: usize,
}

impl StructLayout {
    pub fn field(&self, name: &str) -> Option<&StructField> {
        self.fields.iter().find(|field| field.name == name)
    }

    pub fn to_ffi_type(&self) -> FfiType {
        let mut cursor = 0usize;
        let mut ffi_fields = Vec::new();
        for field in &self.fields {
            if field.offset > cursor {
                for _ in 0..(field.offset - cursor) {
                    ffi_fields.push(FfiType::u8());
                }
            }
            if matches!(field.kind, StructFieldKind::Padding) {
                for _ in 0..field.size {
                    ffi_fields.push(FfiType::u8());
                }
            } else {
                ffi_fields.push(field.ty.to_ffi_type());
            }
            cursor = field.offset.saturating_add(field.size);
        }
        if self.size > cursor {
            for _ in 0..(self.size - cursor) {
                ffi_fields.push(FfiType::u8());
            }
        }
        FfiType::structure(ffi_fields)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StructField {
    pub name: String,
    pub ty: NativeType,
    pub offset: usize,
    pub size: usize,
    pub align: usize,
    pub kind: StructFieldKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StructFieldKind {
    Value,
    Padding,
}

pub fn align_to(offset: usize, align: usize) -> usize {
    if align <= 1 {
        offset
    } else {
        (offset + align - 1) & !(align - 1)
    }
}

/// Stack-allocated union that can hold any native FFI value.
/// Fields are accessed unsafely based on the corresponding `NativeType`.
#[repr(C)]
#[derive(Clone, Copy)]
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
