//! V8 Fast API trampolines for generic FFI dispatch.
//!
//! Registers a fast-call overload for eligible FFI symbols so that TurboFan
//! can call the native function without HandleScope creation or JS→Rust
//! argument marshaling.
//!
//! # Design
//!
//! A small set of pre-compiled trampoline functions (one per arity, 0–16)
//! handle all fast-eligible signatures.  At `dlopen` time a `CFunctionInfo`
//! is built dynamically with the exact V8 types for each symbol, paired with
//! the appropriate arity trampoline.
//!
//! Inside each trampoline:
//!  1. The `SymbolData` pointer is retrieved from `FastApiCallbackOptions.data`.
//!  2. Each `u64` argument is reinterpreted according to the `NativeType`
//!     metadata and placed into a `NativeValue` union.
//!  3. The call goes through libffi's `cif.call()` — correct ABI handling for
//!     all types, including floats and structs.
//!  4. The result is returned as `u64`; V8 narrows it per the declared return
//!     type in `CFunctionInfo`.
//!
//! # Fast-eligibility
//!
//! Eligible when:
//!  - All params are integer/pointer/buffer types (no f32/f64 — different
//!    register class incompatible with the `u64` trampolines).
//!  - Return type is integer/pointer/void (no buffer/f32/f64).
//!  - Arity ≤ 16.
//!
//! Ineligible symbols fall back to the normal slow callback unchanged.

use std::ffi::c_void;

use ::v8;
use v8::fast_api::{
    CFunction, CFunctionInfo, CTypeInfo, FastApiCallbackOptions, Flags, Int64Representation, Type,
};

use super::SymbolData;
use super::library::FfiSymbol;
use super::types::NativeType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FastCallKind {
    None,
    Scalar,
    Pointer,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Build a `CFunction` for `sym` if it is fast-eligible.
///
/// The returned `CFunction` references leaked `CFunctionInfo` and `CTypeInfo`
/// data that lives for the process lifetime — same lifetime policy as the
/// `SymbolData` itself (leaked via `Box::into_raw`).
pub fn build_fast_cfunction(sym: &FfiSymbol) -> Option<CFunction> {
    let arity = sym.param_types.len();
    if matches!(sym.fast_call_kind, FastCallKind::None) || arity > 16 {
        return None;
    }

    // Build CTypeInfo slice: [V8Value(recv), ...params..., CallbackOptions]
    let mut arg_infos: Vec<CTypeInfo> = Vec::with_capacity(arity + 2);
    arg_infos.push(Type::V8Value.as_info()); // receiver (always first)
    for ty in &sym.param_types {
        arg_infos.push(native_to_ctype(ty));
    }
    arg_infos.push(Type::CallbackOptions.as_info());

    let arg_infos_slice: &'static [CTypeInfo] = Box::leak(arg_infos.into_boxed_slice());

    let ret_info = native_to_ctype(&sym.result_type);
    let cfi: &'static CFunctionInfo = Box::leak(Box::new(CFunctionInfo::new(
        ret_info,
        arg_infos_slice,
        Int64Representation::BigInt,
    )));

    let is_void = sym.result_type == NativeType::Void;
    let trampoline = select_trampoline(arity, is_void)?;

    Some(CFunction::new(trampoline, cfi))
}

pub fn classify_fast_call(param_types: &[NativeType], result_type: &NativeType) -> FastCallKind {
    if param_types.len() > 16 || !result_type.is_fast_return() {
        return FastCallKind::None;
    }

    let mut kind = FastCallKind::Scalar;
    for ty in param_types {
        if !ty.is_fast_param() {
            return FastCallKind::None;
        }
        if matches!(ty, NativeType::Pointer | NativeType::Buffer) {
            kind = FastCallKind::Pointer;
        }
    }

    kind
}

// ---------------------------------------------------------------------------
// NativeType → V8 CTypeInfo mapping
// ---------------------------------------------------------------------------

fn native_to_ctype(ty: &NativeType) -> CTypeInfo {
    let t = match ty {
        NativeType::Void => Type::Void,
        NativeType::Bool => Type::Bool,
        // Small ints → Int32 (accepted as JS Number by V8)
        NativeType::U8 | NativeType::I8 | NativeType::U16 | NativeType::I16 | NativeType::I32 => {
            Type::Int32
        }
        NativeType::U32 => Type::Uint32,
        // 64-bit int types → Uint64/Int64 (BigInt in JS)
        NativeType::U64 | NativeType::USize => Type::Uint64,
        NativeType::I64 | NativeType::ISize => Type::Int64,
        // Buffer and Pointer → V8Value (raw Local<Value> pointer passed in-register).
        // For Buffer: V8 passes a TypedArray/ArrayBuffer; we extract the backing store ptr.
        // For Pointer: V8 passes an 8-byte ArrayBuffer; we read its contents as a u64 address.
        NativeType::Buffer | NativeType::Pointer | NativeType::IgnoredPointer => Type::V8Value,
        // Floats and structs are not fast-eligible — should not reach here.
        NativeType::F32 | NativeType::F64 | NativeType::Struct(_) => Type::Void,
    };
    CTypeInfo::new(t, Flags::empty())
}

// ---------------------------------------------------------------------------
// Trampoline selection
// ---------------------------------------------------------------------------

fn select_trampoline(arity: usize, is_void: bool) -> Option<*const c_void> {
    Some(if is_void {
        match arity {
            0 => trampoline_void_0 as _,
            1 => trampoline_void_1 as _,
            2 => trampoline_void_2 as _,
            3 => trampoline_void_3 as _,
            4 => trampoline_void_4 as _,
            5 => trampoline_void_5 as _,
            6 => trampoline_void_6 as _,
            7 => trampoline_void_7 as _,
            8 => trampoline_void_8 as _,
            9 => trampoline_void_9 as _,
            10 => trampoline_void_10 as _,
            11 => trampoline_void_11 as _,
            12 => trampoline_void_12 as _,
            13 => trampoline_void_13 as _,
            14 => trampoline_void_14 as _,
            15 => trampoline_void_15 as _,
            16 => trampoline_void_16 as _,
            _ => return None,
        }
    } else {
        match arity {
            0 => trampoline_0 as _,
            1 => trampoline_1 as _,
            2 => trampoline_2 as _,
            3 => trampoline_3 as _,
            4 => trampoline_4 as _,
            5 => trampoline_5 as _,
            6 => trampoline_6 as _,
            7 => trampoline_7 as _,
            8 => trampoline_8 as _,
            9 => trampoline_9 as _,
            10 => trampoline_10 as _,
            11 => trampoline_11 as _,
            12 => trampoline_12 as _,
            13 => trampoline_13 as _,
            14 => trampoline_14 as _,
            15 => trampoline_15 as _,
            16 => trampoline_16 as _,
            _ => return None,
        }
    })
}

// ---------------------------------------------------------------------------
// Core dispatch
// ---------------------------------------------------------------------------

/// Retrieve `SymbolData` from `FastApiCallbackOptions.data`.
///
/// # Safety
/// The data must be a `v8::External` wrapping a valid `*const SymbolData`.
#[inline(always)]
unsafe fn get_symbol_data(opts: *mut FastApiCallbackOptions) -> &'static SymbolData {
    let data = unsafe { (*opts).data };
    // SAFETY: we set this external up in dlopen_callback; it's valid for
    // the process lifetime (leaked via Box::into_raw).
    let ext = unsafe { v8::Local::<v8::External>::cast_unchecked(data) };
    unsafe { &*(ext.value() as *const SymbolData) }
}

/// Extract a C pointer from a raw `u64` that V8 passed as `Type::V8Value`.
///
/// Used for `NativeType::Buffer` params: extracts the address of the
/// ArrayBuffer/TypedArray's backing store (the data pointer itself).
/// `ArrayBufferView::data()` correctly applies the view's `byteOffset`.
///
/// # Safety
/// `raw` must be a valid `v8::Local<v8::Value>` as passed by V8's JIT.
#[inline(always)]
unsafe fn v8value_to_ptr(raw: u64) -> *mut c_void {
    // SAFETY: V8 guarantees `raw` is a valid in-heap Local<Value> pointer
    // for the duration of this call.
    let local: v8::Local<v8::Value> = unsafe { std::mem::transmute(raw) };
    if local.is_null_or_undefined() {
        return std::ptr::null_mut();
    }
    // Check ArrayBufferView first: the common case is a TypedArray (e.g. Uint8Array),
    // so checking ArrayBuffer first would always fail, wasting an out-of-line V8 call.
    // ArrayBufferView::data() includes byteOffset — no scope required.
    if let Ok(abv) = v8::Local::<v8::ArrayBufferView>::try_from(local) {
        return abv.data();
    }
    if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(local) {
        return ab
            .data()
            .map(|p| p.as_ptr())
            .unwrap_or(std::ptr::null_mut());
    }
    std::ptr::null_mut()
}

/// Read the *contents* of an 8-byte pointer buffer passed as `Type::V8Value`.
///
/// Used for `NativeType::Pointer` params: the JS value is an 8-byte
/// `ArrayBuffer` whose bytes are the target address (little-endian u64),
/// or JS `null` (→ C null pointer).
///
/// # Safety
/// `raw` must be a valid `v8::Local<v8::Value>` as passed by V8's JIT.
#[inline(always)]
unsafe fn v8value_to_ptr_contents(raw: u64) -> *mut c_void {
    let local: v8::Local<v8::Value> = unsafe { std::mem::transmute(raw) };
    if local.is_null_or_undefined() {
        return std::ptr::null_mut();
    }
    // ArrayBuffer: read the first 8 bytes as a u64 address.
    if let Ok(ab) = v8::Local::<v8::ArrayBuffer>::try_from(local) {
        if let Some(data) = ab.data() {
            return unsafe { std::ptr::read_unaligned(data.as_ptr() as *const *mut c_void) };
        }
        return std::ptr::null_mut();
    }
    // ArrayBufferView: data() applies byteOffset, then read 8 bytes.
    if let Ok(abv) = v8::Local::<v8::ArrayBufferView>::try_from(local) {
        let p = abv.data();
        if !p.is_null() {
            return unsafe { std::ptr::read_unaligned(p as *const *mut c_void) };
        }
    }
    std::ptr::null_mut()
}

/// Dispatch through the symbol's native code pointer without libffi.
///
/// On ARM64 (AAPCS64) and x86-64 (SysV AMD64), all integer/pointer-class
/// arguments map 1-to-1 to general-purpose argument registers and then stack
/// slots. Calling a C function that expects fewer
/// or differently-sized integer args is safe: the callee reads only the low
/// bits it declared; unused registers/stack slots are harmless. Fast-eligible
/// symbols never have float params, so the GPR-only calling convention holds.
///
/// # Safety
/// `sym` must be a valid, live `FfiSymbol` with a correct `code_ptr`.
#[inline(always)]
unsafe fn fast_dispatch(sym: &FfiSymbol, args: &[u64]) -> u64 {
    let r = match sym.fast_call_kind {
        FastCallKind::Scalar => unsafe { fast_dispatch_scalar(sym, args) },
        FastCallKind::Pointer => unsafe { fast_dispatch_pointer(sym, args) },
        FastCallKind::None => 0,
    };

    match &sym.result_type {
        NativeType::Void => 0,
        NativeType::Bool | NativeType::U8 => r as u8 as u64,
        NativeType::I8 => r as u8 as i8 as i64 as u64,
        NativeType::U16 => r as u16 as u64,
        NativeType::I16 => r as u16 as i16 as i64 as u64,
        NativeType::U32 => r as u32 as u64,
        NativeType::I32 => r as u32 as i32 as i64 as u64,
        NativeType::U64 | NativeType::USize => r,
        NativeType::I64 | NativeType::ISize => r,
        NativeType::Pointer
        | NativeType::IgnoredPointer
        | NativeType::Buffer
        | NativeType::F32
        | NativeType::F64
        | NativeType::Struct(_) => 0,
    }
}

#[inline(always)]
unsafe fn fast_dispatch_scalar(sym: &FfiSymbol, args: &[u64]) -> u64 {
    unsafe { call_direct(sym.code_ptr.0, args) }
}

#[inline(always)]
unsafe fn fast_dispatch_pointer(sym: &FfiSymbol, args: &[u64]) -> u64 {
    let n = args.len();
    let mut raw = [0u64; 16];
    for i in 0..n {
        raw[i] = match sym.param_types[i] {
            NativeType::Buffer => (unsafe { v8value_to_ptr(args[i]) }) as u64,
            NativeType::Pointer | NativeType::IgnoredPointer => {
                (unsafe { v8value_to_ptr_contents(args[i]) }) as u64
            }
            _ => args[i],
        };
    }

    unsafe { call_direct(sym.code_ptr.0, &raw[..n]) }
}

#[inline(always)]
unsafe fn call_direct(code_ptr: *mut c_void, args: &[u64]) -> u64 {
    match args.len() {
        0 => {
            let f: unsafe extern "C" fn() -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe { f() }
        }
        1 => {
            let f: unsafe extern "C" fn(u64) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe { f(args[0]) }
        }
        2 => {
            let f: unsafe extern "C" fn(u64, u64) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe { f(args[0], args[1]) }
        }
        3 => {
            let f: unsafe extern "C" fn(u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe { f(args[0], args[1], args[2]) }
        }
        4 => {
            let f: unsafe extern "C" fn(u64, u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe { f(args[0], args[1], args[2], args[3]) }
        }
        5 => {
            let f: unsafe extern "C" fn(u64, u64, u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe { f(args[0], args[1], args[2], args[3], args[4]) }
        }
        6 => {
            let f: unsafe extern "C" fn(u64, u64, u64, u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe { f(args[0], args[1], args[2], args[3], args[4], args[5]) }
        }
        7 => {
            let f: unsafe extern "C" fn(u64, u64, u64, u64, u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6],
                )
            }
        }
        8 => {
            let f: unsafe extern "C" fn(u64, u64, u64, u64, u64, u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                )
            }
        }
        9 => {
            let f: unsafe extern "C" fn(u64, u64, u64, u64, u64, u64, u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8],
                )
            }
        }
        10 => {
            let f: unsafe extern "C" fn(u64, u64, u64, u64, u64, u64, u64, u64, u64, u64) -> u64 =
                unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                    args[8], args[9],
                )
            }
        }
        11 => {
            let f: unsafe extern "C" fn(
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
            ) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                    args[8], args[9], args[10],
                )
            }
        }
        12 => {
            let f: unsafe extern "C" fn(
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
            ) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                    args[8], args[9], args[10], args[11],
                )
            }
        }
        13 => {
            let f: unsafe extern "C" fn(
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
            ) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                    args[8], args[9], args[10], args[11], args[12],
                )
            }
        }
        14 => {
            let f: unsafe extern "C" fn(
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
            ) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                    args[8], args[9], args[10], args[11], args[12], args[13],
                )
            }
        }
        15 => {
            let f: unsafe extern "C" fn(
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
            ) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                    args[8], args[9], args[10], args[11], args[12], args[13], args[14],
                )
            }
        }
        16 => {
            let f: unsafe extern "C" fn(
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
                u64,
            ) -> u64 = unsafe { std::mem::transmute(code_ptr) };
            unsafe {
                f(
                    args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7],
                    args[8], args[9], args[10], args[11], args[12], args[13], args[14], args[15],
                )
            }
        }
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// Per-arity trampolines — non-void return (u64)
// ---------------------------------------------------------------------------

macro_rules! trampoline {
    ($name:ident, $($param:ident),*) => {
        unsafe extern "C" fn $name(
            _recv: v8::Local<v8::Object>,
            $($param: u64,)*
            opts: *mut FastApiCallbackOptions,
        ) -> u64 {
            let sym_data = unsafe { get_symbol_data(opts) };
            unsafe { fast_dispatch(&sym_data.symbol, &[$($param,)*]) }
        }
    };
}

trampoline!(trampoline_0,);
trampoline!(trampoline_1, a0);
trampoline!(trampoline_2, a0, a1);
trampoline!(trampoline_3, a0, a1, a2);
trampoline!(trampoline_4, a0, a1, a2, a3);
trampoline!(trampoline_5, a0, a1, a2, a3, a4);
trampoline!(trampoline_6, a0, a1, a2, a3, a4, a5);
trampoline!(trampoline_7, a0, a1, a2, a3, a4, a5, a6);
trampoline!(trampoline_8, a0, a1, a2, a3, a4, a5, a6, a7);
trampoline!(trampoline_9, a0, a1, a2, a3, a4, a5, a6, a7, a8);
trampoline!(trampoline_10, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
trampoline!(trampoline_11, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10);
trampoline!(
    trampoline_12,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11
);
trampoline!(
    trampoline_13,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12
);
trampoline!(
    trampoline_14,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12,
    a13
);
trampoline!(
    trampoline_15,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12,
    a13,
    a14
);
trampoline!(
    trampoline_16,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12,
    a13,
    a14,
    a15
);

// ---------------------------------------------------------------------------
// Per-arity trampolines — void return
// ---------------------------------------------------------------------------

macro_rules! trampoline_void {
    ($name:ident, $($param:ident),*) => {
        unsafe extern "C" fn $name(
            _recv: v8::Local<v8::Object>,
            $($param: u64,)*
            opts: *mut FastApiCallbackOptions,
        ) {
            let sym_data = unsafe { get_symbol_data(opts) };
            unsafe { fast_dispatch(&sym_data.symbol, &[$($param,)*]); }
        }
    };
}

trampoline_void!(trampoline_void_0,);
trampoline_void!(trampoline_void_1, a0);
trampoline_void!(trampoline_void_2, a0, a1);
trampoline_void!(trampoline_void_3, a0, a1, a2);
trampoline_void!(trampoline_void_4, a0, a1, a2, a3);
trampoline_void!(trampoline_void_5, a0, a1, a2, a3, a4);
trampoline_void!(trampoline_void_6, a0, a1, a2, a3, a4, a5);
trampoline_void!(trampoline_void_7, a0, a1, a2, a3, a4, a5, a6);
trampoline_void!(trampoline_void_8, a0, a1, a2, a3, a4, a5, a6, a7);
trampoline_void!(trampoline_void_9, a0, a1, a2, a3, a4, a5, a6, a7, a8);
trampoline_void!(trampoline_void_10, a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);
trampoline_void!(
    trampoline_void_11,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10
);
trampoline_void!(
    trampoline_void_12,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11
);
trampoline_void!(
    trampoline_void_13,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12
);
trampoline_void!(
    trampoline_void_14,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12,
    a13
);
trampoline_void!(
    trampoline_void_15,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12,
    a13,
    a14
);
trampoline_void!(
    trampoline_void_16,
    a0,
    a1,
    a2,
    a3,
    a4,
    a5,
    a6,
    a7,
    a8,
    a9,
    a10,
    a11,
    a12,
    a13,
    a14,
    a15
);
