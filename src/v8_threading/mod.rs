//! Narrow binding for V8's cross-thread isolate locking contract.

use std::ffi::c_void;

unsafe extern "C" {
    fn fino__V8Locker__New(isolate: *mut v8::Isolate) -> *mut c_void;
    fn fino__V8Locker__Delete(locker: *mut c_void);
    fn fino__V8Locker__IsLocked(isolate: *mut v8::Isolate) -> bool;
}

pub(crate) struct IsolateLocker {
    raw: *mut c_void,
}

impl IsolateLocker {
    pub(crate) fn new(isolate: &mut v8::Isolate) -> Self {
        let raw = unsafe { fino__V8Locker__New(isolate) };
        assert!(!raw.is_null(), "V8 Locker allocation failed");
        debug_assert!(unsafe { fino__V8Locker__IsLocked(isolate) });
        Self { raw }
    }
}

impl Drop for IsolateLocker {
    fn drop(&mut self) {
        unsafe { fino__V8Locker__Delete(self.raw) };
    }
}
