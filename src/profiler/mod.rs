//! fino:profiler — V8 CpuProfiler API exposed to JS with pprof output.
//!
//! Exports two functions to JS:
//!   - `startProfiling(title?)` — begin sampling the V8 call stack
//!   - `stopProfiling(title?)` — stop sampling, return pprof bytes as Uint8Array

mod pprof;

use std::ffi::{CStr, c_char, c_int, c_void};

use ::v8;

use crate::state::get_state;

// ---------------------------------------------------------------------------
// extern "C" declarations matching src/profiler/binding.cc
// ---------------------------------------------------------------------------

unsafe extern "C" {
    fn v8__CpuProfiler__New(isolate: v8::UnsafeRawIsolatePtr) -> *mut c_void;
    fn v8__CpuProfiler__Dispose(profiler: *mut c_void);
    fn v8__CpuProfiler__SetSamplingInterval(profiler: *mut c_void, us: c_int);
    fn v8__CpuProfiler__StartProfiling(
        profiler: *mut c_void,
        title: *const v8::String,
        record_samples: bool,
    ) -> c_int;
    fn v8__CpuProfiler__StopProfiling(
        profiler: *mut c_void,
        title: *const v8::String,
    ) -> *const c_void;

    fn v8__CpuProfile__Delete(profile: *const c_void);
    fn v8__CpuProfile__GetSamplesCount(profile: *const c_void) -> c_int;
    fn v8__CpuProfile__GetSample(profile: *const c_void, index: c_int) -> *const c_void;
    fn v8__CpuProfile__GetSampleTimestamp(profile: *const c_void, index: c_int) -> i64;
    fn v8__CpuProfile__GetStartTime(profile: *const c_void) -> i64;
    fn v8__CpuProfile__GetEndTime(profile: *const c_void) -> i64;

    fn v8__CpuProfileNode__GetFunctionNameStr(node: *const c_void) -> *const c_char;
    fn v8__CpuProfileNode__GetScriptResourceNameStr(node: *const c_void) -> *const c_char;
    fn v8__CpuProfileNode__GetLineNumber(node: *const c_void) -> c_int;
    fn v8__CpuProfileNode__GetParent(node: *const c_void) -> *const c_void;
}

// ---------------------------------------------------------------------------
// Public dispose helper (called from runtime.rs on isolate teardown)
// ---------------------------------------------------------------------------

/// Dispose a CpuProfiler created by `v8__CpuProfiler__New`.
///
/// # Safety
/// Must only be called once, with a valid profiler pointer, before the V8
/// isolate is destroyed.
pub unsafe fn dispose_profiler(ptr: *mut c_void) {
    unsafe { v8__CpuProfiler__Dispose(ptr) };
}

// ---------------------------------------------------------------------------
// Synthetic module: fino:profiler
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = ["startProfiling", "stopProfiling"]
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();

    let module_name = v8::String::new(scope, "fino:profiler").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    v8::callback_scope!(unsafe let scope, context);

    macro_rules! set_fn {
        ($name:expr, $cb:expr) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }

    set_fn!("startProfiling", start_profiling);
    set_fn!("stopProfiling", stop_profiling);

    Some(v8::undefined(scope).into())
}

// ---------------------------------------------------------------------------
// startProfiling(title?: string)
// ---------------------------------------------------------------------------

fn start_profiling(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let title = get_title(scope, &args, 0);
    let title_local = title
        .as_ref()
        .map(|s| s.as_local(scope))
        .unwrap_or_else(|| v8::String::new(scope, "").unwrap());

    let state_rc = get_state(scope);

    // Lazily create the CpuProfiler.
    {
        let mut st = state_rc.borrow_mut();
        if st.cpu_profiler.is_none() {
            let isolate = unsafe { scope.as_raw_isolate_ptr() };
            let profiler = unsafe { v8__CpuProfiler__New(isolate) };
            if profiler.is_null() {
                let msg =
                    v8::String::new(scope, "startProfiling: failed to create CpuProfiler").unwrap();
                let exc = v8::Exception::error(scope, msg);
                scope.throw_exception(exc);
                return;
            }
            // Default 1ms sampling interval.
            unsafe { v8__CpuProfiler__SetSamplingInterval(profiler, 1000) };
            st.cpu_profiler = Some(profiler);
        }
    }

    let profiler = state_rc.borrow().cpu_profiler.unwrap();
    let title_ptr: *const v8::String = &*title_local;
    unsafe { v8__CpuProfiler__StartProfiling(profiler, title_ptr, true) };
}

// ---------------------------------------------------------------------------
// stopProfiling(title?: string) -> Uint8Array
// ---------------------------------------------------------------------------

fn stop_profiling(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let title = get_title(scope, &args, 0);
    let title_local = title
        .as_ref()
        .map(|s| s.as_local(scope))
        .unwrap_or_else(|| v8::String::new(scope, "").unwrap());

    let state_rc = get_state(scope);
    let profiler = match state_rc.borrow().cpu_profiler {
        Some(p) => p,
        None => {
            let msg = v8::String::new(scope, "stopProfiling: no profiler started").unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    let title_ptr: *const v8::String = &*title_local;
    let profile = unsafe { v8__CpuProfiler__StopProfiling(profiler, title_ptr) };
    if profile.is_null() {
        let msg = v8::String::new(scope, "stopProfiling: no matching profile found").unwrap();
        let exc = v8::Exception::error(scope, msg);
        scope.throw_exception(exc);
        return;
    }

    let bytes = convert_to_pprof(profile);
    unsafe { v8__CpuProfile__Delete(profile) };

    // Create an ArrayBuffer backed by the encoded bytes and wrap in Uint8Array.
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes);
    let ab = v8::ArrayBuffer::with_backing_store(scope, &store.make_shared());
    let u8arr = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
    rv.set(u8arr.into());
}

// ---------------------------------------------------------------------------
// V8 CpuProfile → pprof conversion
// ---------------------------------------------------------------------------

fn convert_to_pprof(profile: *const c_void) -> Vec<u8> {
    use pprof::{Function, Line, Location, ProfileEncoder, Sample, ValueType};
    use std::collections::HashMap;

    let mut enc = ProfileEncoder::new();

    // Pre-intern the value type strings.
    let samples_idx = enc.strings.intern("samples");
    let count_idx = enc.strings.intern("count");
    let wall_idx = enc.strings.intern("wall");
    let us_idx = enc.strings.intern("microseconds");

    enc.value_types.push(ValueType {
        r#type: samples_idx,
        unit: count_idx,
    });
    enc.value_types.push(ValueType {
        r#type: wall_idx,
        unit: us_idx,
    });

    let start_time = unsafe { v8__CpuProfile__GetStartTime(profile) };
    let end_time = unsafe { v8__CpuProfile__GetEndTime(profile) };
    let sample_count = unsafe { v8__CpuProfile__GetSamplesCount(profile) } as usize;

    let duration_us = end_time - start_time;
    let duration_ns = duration_us * 1000;

    // V8 timestamps are monotonic µs (not unix epoch). Anchor to wall clock:
    // time_nanos = now_ns - duration_ns gives the approximate profile start time.
    let now_ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0);
    enc.time_nanos = now_ns - duration_ns;
    enc.duration_nanos = duration_ns;
    enc.period_type = ValueType {
        r#type: wall_idx,
        unit: us_idx,
    };
    enc.period = 1000; // default 1ms sampling interval

    // Dedup maps: (name_idx, filename_idx, start_line) → function_id
    //             (function_id, line) → location_id
    let mut function_map: HashMap<(u64, u64, i64), u64> = HashMap::new();
    let mut location_map: HashMap<(u64, i64), u64> = HashMap::new();

    let mut get_or_create_function =
        |enc: &mut ProfileEncoder, name: &str, filename: &str, start_line: i64| -> u64 {
            let name_idx = enc.strings.intern(name);
            let file_idx = enc.strings.intern(filename);
            let key = (name_idx, file_idx, start_line);
            if let Some(&id) = function_map.get(&key) {
                return id;
            }
            let id = (enc.functions.len() as u64) + 1;
            enc.functions.push(Function {
                id,
                name: name_idx,
                system_name: name_idx,
                filename: file_idx,
                start_line,
            });
            function_map.insert(key, id);
            id
        };

    let mut get_or_create_location =
        |enc: &mut ProfileEncoder, function_id: u64, line: i64| -> u64 {
            let key = (function_id, line);
            if let Some(&id) = location_map.get(&key) {
                return id;
            }
            let id = (enc.locations.len() as u64) + 1;
            enc.locations.push(Location {
                id,
                lines: vec![Line { function_id, line }],
            });
            location_map.insert(key, id);
            id
        };

    for i in 0..sample_count {
        let node = unsafe { v8__CpuProfile__GetSample(profile, i as c_int) };
        let ts = unsafe { v8__CpuProfile__GetSampleTimestamp(profile, i as c_int) };
        let wall_us = if i + 1 < sample_count {
            unsafe { v8__CpuProfile__GetSampleTimestamp(profile, (i + 1) as c_int) - ts }
        } else {
            end_time - ts
        }
        .max(0);

        // Walk leaf → root via GetParent(), skipping the synthetic root node.
        let mut location_ids = Vec::new();
        let mut current = node;
        loop {
            if current.is_null() {
                break;
            }
            let parent = unsafe { v8__CpuProfileNode__GetParent(current) };
            // Skip the root node (it has no parent).
            if parent.is_null() {
                break;
            }

            let name = unsafe {
                let ptr = v8__CpuProfileNode__GetFunctionNameStr(current);
                if ptr.is_null() {
                    ""
                } else {
                    CStr::from_ptr(ptr).to_str().unwrap_or("")
                }
            };
            let filename = unsafe {
                let ptr = v8__CpuProfileNode__GetScriptResourceNameStr(current);
                if ptr.is_null() {
                    ""
                } else {
                    CStr::from_ptr(ptr).to_str().unwrap_or("")
                }
            };
            let line = unsafe { v8__CpuProfileNode__GetLineNumber(current) } as i64;

            // Use display name "(anonymous)" for anonymous functions.
            let display_name = if name.is_empty() { "(anonymous)" } else { name };

            let fn_id = get_or_create_function(&mut enc, display_name, filename, line);
            let loc_id = get_or_create_location(&mut enc, fn_id, line);
            location_ids.push(loc_id);

            current = parent;
        }

        // Only emit non-empty samples (some samples hit the root directly).
        if !location_ids.is_empty() {
            enc.samples.push(Sample {
                location_ids,
                values: vec![1, wall_us],
            });
        }
    }

    enc.encode()
}

// ---------------------------------------------------------------------------
// Helper: extract an optional string argument
// ---------------------------------------------------------------------------

/// Holds a v8::Global<v8::String> and lets callers get a Local from it.
struct OwnedTitle(v8::Global<v8::String>);

impl OwnedTitle {
    fn as_local<'s>(&self, scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::String> {
        v8::Local::new(scope, &self.0)
    }
}

fn get_title(
    scope: &mut v8::PinScope,
    args: &v8::FunctionCallbackArguments,
    index: i32,
) -> Option<OwnedTitle> {
    let val: v8::Local<v8::Value> = args.get(index);
    if val.is_string() {
        let s = val.to_string(scope)?;
        Some(OwnedTitle(v8::Global::new(scope, s)))
    } else {
        None
    }
}
