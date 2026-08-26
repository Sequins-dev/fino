// IsolateGroup allocation shim for rusty_v8.
//
// rusty_v8 performs essential Rust-side initialization after its C++
// v8__Isolate__New call. A thread-local one-shot selects the grouped V8
// overload while leaving that initialization and OwnedIsolate ownership
// unchanged.

#include <cstdlib>
#include <memory>

#include "v8-isolate.h"

namespace {

thread_local bool create_in_fresh_group = false;

v8::Isolate* NewIsolate(const v8::Isolate::CreateParams& params) {
  if (!create_in_fresh_group) {
    return v8::Isolate::New(params);
  }

  create_in_fresh_group = false;
  if (!v8::IsolateGroup::CanCreateNewGroups()) {
    std::abort();
  }
  auto group = v8::IsolateGroup::Create();
  auto grouped_params = params;
#ifdef V8_ENABLE_SANDBOX
  // Sandboxed builds require backing stores to be allocated inside the
  // group's sandbox. Non-sandboxed builds can retain Fino's shared allocator,
  // avoiding an allocator allocation per realm and preserving SAB sharing.
  auto allocator = std::shared_ptr<v8::ArrayBuffer::Allocator>(
      v8::ArrayBuffer::Allocator::NewDefaultAllocator(group));
  grouped_params.array_buffer_allocator = allocator.get();
  grouped_params.array_buffer_allocator_shared = std::move(allocator);
#endif
  return v8::Isolate::New(group, grouped_params);
}

}  // namespace

extern "C" {

void fino__V8IsolateGroup__BeginNewIsolate() {
  if (create_in_fresh_group) {
    std::abort();
  }
  create_in_fresh_group = true;
}

void fino__V8IsolateGroup__CancelNewIsolate() {
  create_in_fresh_group = false;
}

bool fino__V8IsolateGroup__CanCreateNewGroups() {
  return v8::IsolateGroup::CanCreateNewGroups();
}

bool fino__V8IsolateGroup__UsesDefault(v8::Isolate* isolate) {
  return isolate->GetGroup() == v8::IsolateGroup::GetDefault();
}

bool fino__V8IsolateGroup__SameGroup(v8::Isolate* left,
                                    v8::Isolate* right) {
  return left->GetGroup() == right->GetGroup();
}

v8::Isolate* v8__Isolate__New(const v8::Isolate::CreateParams& params) {
  return NewIsolate(params);
}

}  // extern "C"
