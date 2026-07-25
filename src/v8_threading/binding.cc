// Minimal V8 Locker shim used when a parked isolate changes reactor threads.

#include "v8-locker.h"

#include <new>

extern "C" {

void* fino__V8Locker__New(v8::Isolate* isolate) {
  return new v8::Locker(isolate);
}

void fino__V8Locker__Delete(void* locker) {
  delete static_cast<v8::Locker*>(locker);
}

// The isolate was disposed while this Locker held its final exclusive lock.
// Its destructor dereferences the isolate, so only release the allocation.
void fino__V8Locker__FreeAfterIsolateDispose(void* locker) {
  ::operator delete(locker);
}

bool fino__V8Locker__IsLocked(v8::Isolate* isolate) {
  return v8::Locker::IsLocked(isolate);
}

}  // extern "C"
