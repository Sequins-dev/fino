// C++ shim exposing V8's CpuProfiler API to Rust via extern "C" functions.
//
// Naming follows the rusty_v8 convention: v8__ClassName__MethodName.
// The const v8::String* parameters are V8 Local<String> values passed as raw
// pointers; ptr_to_local() (from support.h) reconstructs the Local.

#include "v8-profiler.h"
#include "support.h"

extern "C" {

// ---------------------------------------------------------------------------
// CpuProfiler
// ---------------------------------------------------------------------------

v8::CpuProfiler* v8__CpuProfiler__New(v8::Isolate* isolate) {
  return v8::CpuProfiler::New(isolate,
                               v8::kDebugNaming,
                               v8::kLazyLogging);
}

void v8__CpuProfiler__Dispose(v8::CpuProfiler* profiler) {
  profiler->Dispose();
}

void v8__CpuProfiler__SetSamplingInterval(v8::CpuProfiler* profiler, int us) {
  profiler->SetSamplingInterval(us);
}

// Returns CpuProfilingStatus as int: 0=kStarted, 1=kAlreadyStarted, 2=kErrorTooManyProfilers
int v8__CpuProfiler__StartProfiling(v8::CpuProfiler* profiler,
                                     const v8::String* title,
                                     bool record_samples) {
  return static_cast<int>(
      profiler->StartProfiling(support::ptr_to_local(title), record_samples));
}

// Start a profile and return its stable profiler id. The process-wide
// profiler uses ids rather than titles so application-created named profiles
// cannot stop or replace its recording.
uint32_t v8__CpuProfiler__StartWithId(v8::CpuProfiler* profiler,
                                      const v8::String* title,
                                      bool record_samples) {
  const auto result = profiler->Start(support::ptr_to_local(title),
                                      record_samples);
  return result.status == v8::CpuProfilingStatus::kStarted ? result.id : 0;
}

v8::CpuProfile* v8__CpuProfiler__StopProfiling(v8::CpuProfiler* profiler,
                                                const v8::String* title) {
  return profiler->StopProfiling(support::ptr_to_local(title));
}

v8::CpuProfile* v8__CpuProfiler__StopById(v8::CpuProfiler* profiler,
                                           uint32_t id) {
  return profiler->Stop(id);
}

// ---------------------------------------------------------------------------
// CpuProfile
// ---------------------------------------------------------------------------

void v8__CpuProfile__Delete(v8::CpuProfile* profile) {
  profile->Delete();
}

const v8::CpuProfileNode* v8__CpuProfile__GetTopDownRoot(
    const v8::CpuProfile* profile) {
  return profile->GetTopDownRoot();
}

int v8__CpuProfile__GetSamplesCount(const v8::CpuProfile* profile) {
  return profile->GetSamplesCount();
}

const v8::CpuProfileNode* v8__CpuProfile__GetSample(
    const v8::CpuProfile* profile, int index) {
  return profile->GetSample(index);
}

int64_t v8__CpuProfile__GetSampleTimestamp(const v8::CpuProfile* profile,
                                            int index) {
  return profile->GetSampleTimestamp(index);
}

int64_t v8__CpuProfile__GetStartTime(const v8::CpuProfile* profile) {
  return profile->GetStartTime();
}

int64_t v8__CpuProfile__GetEndTime(const v8::CpuProfile* profile) {
  return profile->GetEndTime();
}

// ---------------------------------------------------------------------------
// CpuProfileNode
// ---------------------------------------------------------------------------

const char* v8__CpuProfileNode__GetFunctionNameStr(
    const v8::CpuProfileNode* node) {
  return node->GetFunctionNameStr();
}

const char* v8__CpuProfileNode__GetScriptResourceNameStr(
    const v8::CpuProfileNode* node) {
  return node->GetScriptResourceNameStr();
}

int v8__CpuProfileNode__GetScriptId(const v8::CpuProfileNode* node) {
  return node->GetScriptId();
}

int v8__CpuProfileNode__GetLineNumber(const v8::CpuProfileNode* node) {
  return node->GetLineNumber();
}

int v8__CpuProfileNode__GetColumnNumber(const v8::CpuProfileNode* node) {
  return node->GetColumnNumber();
}

unsigned v8__CpuProfileNode__GetHitCount(const v8::CpuProfileNode* node) {
  return node->GetHitCount();
}

unsigned v8__CpuProfileNode__GetNodeId(const v8::CpuProfileNode* node) {
  return node->GetNodeId();
}

int v8__CpuProfileNode__GetChildrenCount(const v8::CpuProfileNode* node) {
  return node->GetChildrenCount();
}

const v8::CpuProfileNode* v8__CpuProfileNode__GetChild(
    const v8::CpuProfileNode* node, int index) {
  return node->GetChild(index);
}

const v8::CpuProfileNode* v8__CpuProfileNode__GetParent(
    const v8::CpuProfileNode* node) {
  return node->GetParent();
}

} // extern "C"
