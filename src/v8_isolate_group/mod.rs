//! Narrow binding for creating a V8 isolate in a fresh isolate group.

unsafe extern "C" {
    fn fino__V8IsolateGroup__BeginNewIsolate();
    fn fino__V8IsolateGroup__CancelNewIsolate();
    fn fino__V8IsolateGroup__CanCreateNewGroups() -> bool;
    fn fino__V8IsolateGroup__UsesDefault(isolate: v8::UnsafeRawIsolatePtr) -> bool;
    #[cfg(test)]
    fn fino__V8IsolateGroup__SameGroup(
        left: v8::UnsafeRawIsolatePtr,
        right: v8::UnsafeRawIsolatePtr,
    ) -> bool;
}

struct PendingGroupedIsolate;

impl PendingGroupedIsolate {
    fn begin() -> Self {
        unsafe { fino__V8IsolateGroup__BeginNewIsolate() };
        Self
    }
}

impl Drop for PendingGroupedIsolate {
    fn drop(&mut self) {
        unsafe { fino__V8IsolateGroup__CancelNewIsolate() };
    }
}

/// Create an isolate in a new group while preserving rusty_v8's normal
/// `OwnedIsolate` initialization and ownership path.
pub(crate) fn new_isolate(params: v8::CreateParams) -> v8::OwnedIsolate {
    assert!(
        unsafe { fino__V8IsolateGroup__CanCreateNewGroups() },
        "V8 does not support multiple isolate groups; build rusty_v8 with pointer compression and v8_enable_pointer_compression_shared_cage=false"
    );

    let pending = PendingGroupedIsolate::begin();
    let isolate = v8::Isolate::new(params);
    drop(pending);

    assert!(
        !unsafe { fino__V8IsolateGroup__UsesDefault(isolate.as_raw_isolate_ptr()) },
        "grouped isolate was created in V8's default isolate group"
    );
    isolate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exercise_module(isolate: &mut v8::Isolate) {
        v8::scope!(let isolate_scope, isolate);
        let queue = v8::MicrotaskQueue::new(isolate_scope, v8::MicrotasksPolicy::Explicit);
        let context = v8::Context::new(
            isolate_scope,
            v8::ContextOptions {
                microtask_queue: Some((&*queue as *const v8::MicrotaskQueue).cast_mut()),
                ..Default::default()
            },
        );
        let scope = &mut v8::ContextScope::new(isolate_scope, context);
        let module = crate::loader::compile_source_module(
            scope,
            "await Promise.resolve(42);",
            "internal:isolate-group-test",
            None,
        )
        .unwrap();
        module
            .instantiate_module(scope, crate::loader::resolve_module_callback)
            .unwrap();
        module.evaluate(scope).unwrap();
        queue.perform_checkpoint(scope);
        assert_eq!(module.get_status(), v8::ModuleStatus::Evaluated);
    }

    #[test]
    fn grouped_isolates_are_fresh_and_default_creation_stays_default() {
        crate::runtime::init_v8();

        let params = || {
            v8::CreateParams::default()
                .array_buffer_allocator(crate::runtime::shared_allocator().clone())
        };
        let mut default = v8::Isolate::new(params());
        let default_ptr = unsafe { default.as_raw_isolate_ptr() };
        assert!(unsafe { fino__V8IsolateGroup__UsesDefault(default_ptr) });
        {
            v8::scope!(let scope, &mut default);
            assert_eq!(
                v8::String::new(scope, "default")
                    .unwrap()
                    .to_rust_string_lossy(scope),
                "default"
            );

            let mut nested = new_isolate(params());
            exercise_module(&mut nested);
            let nested = unsafe { nested.try_into_shared() }.unwrap();
            assert_eq!(
                v8::String::new(scope, "resumed")
                    .unwrap()
                    .to_rust_string_lossy(scope),
                "resumed"
            );
            drop(nested);
        }
        exercise_module(&mut default);

        let mut first = new_isolate(params());
        let first_ptr = unsafe { first.as_raw_isolate_ptr() };
        {
            v8::scope!(let scope, &mut first);
            assert_eq!(
                v8::String::new(scope, "grouped")
                    .unwrap()
                    .to_rust_string_lossy(scope),
                "grouped"
            );
        }
        exercise_module(&mut first);
        let second = new_isolate(params());

        assert!(!unsafe {
            fino__V8IsolateGroup__SameGroup(first_ptr, second.as_raw_isolate_ptr())
        });
        assert!(!unsafe { fino__V8IsolateGroup__SameGroup(default_ptr, first_ptr) });

        drop(second);
        drop(first);
        drop(default);
    }
}
