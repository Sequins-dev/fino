//! Apple Blocks ABI ownership adapter. Copy/dispose helpers must execute in
//! native code: a JS disposal handler would itself still be on the native stack
//! when trying to free its libffi trampoline.
//! https://clang.llvm.org/docs/Block-ABI-Apple.html
use super::*;

unsafe extern "C" {
    static _NSConcreteStackBlock: u8;
    fn _Block_copy(block: *const c_void) -> *mut c_void;
    fn _Block_release(block: *const c_void);
}

/// A native-owned resource; destructor is a synchronous C `void(void*)` function.
pub struct Resource {
    pub pointer: usize,
    pub destructor: usize,
}
impl Drop for Resource {
    fn drop(&mut self) {
        let release: unsafe extern "C" fn(*mut c_void) =
            unsafe { std::mem::transmute(self.destructor) };
        unsafe { release(self.pointer as *mut c_void) };
    }
}
struct Context {
    _callback: Arc<FfiCallbackInner>,
    _resources: Vec<Resource>,
}
#[repr(C)]
struct Descriptor {
    reserved: usize,
    size: usize,
    copy: unsafe extern "C" fn(*mut Literal, *const Literal),
    dispose: unsafe extern "C" fn(*const Literal),
}
#[repr(C)]
struct Literal {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: *const c_void,
    descriptor: *const Descriptor,
    context: *const Context,
}
static DESCRIPTOR: Descriptor = Descriptor {
    reserved: 0,
    size: std::mem::size_of::<Literal>(),
    copy,
    dispose,
};
unsafe extern "C" fn copy(_destination: *mut Literal, source: *const Literal) {
    unsafe { Arc::increment_strong_count((*source).context) };
}
unsafe extern "C" fn dispose(block: *const Literal) {
    unsafe { Arc::decrement_strong_count((*block).context) };
}
unsafe extern "C" fn invoke(
    cif: &ffi_cif,
    result: &mut c_void,
    args: *const *const c_void,
    data: &CallbackData,
) {
    // Blocks insert their own pointer before the declared callback arguments.
    unsafe { trampoline(cif, result, args.add(1), data) };
}

pub fn create(callback: &Arc<FfiCallbackInner>, resources: Vec<Resource>) -> *mut c_void {
    let data = Arc::clone(&callback.data);
    let mut parameters = vec![NativeType::Pointer.to_ffi_type()];
    parameters.extend(data.param_types.iter().map(NativeType::to_ffi_type));
    let cif = Cif::new(parameters.into_iter(), data.result_type.to_ffi_type());
    let closure = Closure::new(cif, invoke as Callback<CallbackData, c_void>, unsafe {
        &*Arc::as_ptr(&data)
    });
    let code = *closure.code_ptr() as *const c_void;
    let owned = Arc::new(FfiCallbackInner {
        _closure: closure,
        data,
    });
    let context = Arc::new(Context {
        _callback: owned,
        _resources: resources,
    });
    let literal = Literal {
        isa: std::ptr::addr_of!(_NSConcreteStackBlock).cast(),
        flags: 1 << 25, // BLOCK_HAS_COPY_DISPOSE; no aggregate returns supported.
        reserved: 0,
        invoke: code,
        descriptor: &DESCRIPTOR,
        context: Arc::as_ptr(&context),
    };
    // The runtime copy invokes our copy helper and owns its own Arc reference.
    unsafe { _Block_copy((&literal as *const Literal).cast()) }
}
pub unsafe fn release(block: *mut c_void) {
    unsafe { _Block_release(block) };
}
