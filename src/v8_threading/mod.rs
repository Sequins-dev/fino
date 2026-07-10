//! Narrow binding for V8's cross-thread isolate locking contract.

use std::ffi::c_void;

unsafe extern "C" {
    fn fino__V8Locker__New(isolate: *mut v8::Isolate) -> *mut c_void;
    fn fino__V8Locker__Delete(locker: *mut c_void);
    fn fino__V8Locker__FreeAfterIsolateDispose(locker: *mut c_void);
    fn fino__V8Locker__IsLocked(isolate: *mut v8::Isolate) -> bool;
}

/// A scoped V8 lock. It contains only the C++ locker; entering and exiting the
/// isolate remains explicit in the caller so no V8 scope can outlive it.
pub(crate) struct IsolateLocker {
    raw: *mut c_void,
}

/// A locker whose destructor was deliberately suppressed so its isolate can be
/// disposed while holding the final exclusive V8 lock.
pub(crate) struct NeutralizedIsolateLocker {
    raw: *mut c_void,
}

impl IsolateLocker {
    /// Acquire the lock required before an isolate is entered after it has been
    /// used by another operating-system thread.
    pub(crate) fn new(isolate: &mut v8::Isolate) -> Self {
        let raw = unsafe { fino__V8Locker__New(isolate) };
        assert!(!raw.is_null(), "V8 Locker allocation failed");
        debug_assert!(unsafe { fino__V8Locker__IsLocked(isolate) });
        Self { raw }
    }

    /// Keep the lock held but suppress the C++ destructor, which would
    /// dereference the isolate after `OwnedIsolate::drop` frees it.
    pub(crate) fn neutralize_for_isolate_dispose(self) -> NeutralizedIsolateLocker {
        let locker = std::mem::ManuallyDrop::new(self);
        NeutralizedIsolateLocker { raw: locker.raw }
    }
}

impl NeutralizedIsolateLocker {
    /// Free the neutralized C++ locker allocation after its isolate is gone.
    ///
    /// # Safety
    /// The isolate protected by this locker must already have been disposed.
    pub(crate) unsafe fn free_after_isolate_dispose(self) {
        unsafe { fino__V8Locker__FreeAfterIsolateDispose(self.raw) };
    }
}

impl Drop for IsolateLocker {
    fn drop(&mut self) {
        unsafe { fino__V8Locker__Delete(self.raw) };
    }
}

#[cfg(test)]
mod tests {
    use super::NeutralizedIsolateLocker;

    #[test]
    fn neutralized_locker_does_not_run_the_cpp_destructor() {
        assert!(!std::mem::needs_drop::<NeutralizedIsolateLocker>());
    }
}
