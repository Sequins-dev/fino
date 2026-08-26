//! fino:profiler — V8 CpuProfiler API exposed to JS with pprof output.
//!
//! Exports two functions to JS:
//!   - `startProfiling(title?)` — begin sampling the V8 call stack
//!   - `stopProfiling(title?)` — stop sampling, return pprof bytes as Uint8Array

mod pprof;

use std::{
    collections::HashMap,
    ffi::{CStr, c_char, c_int, c_void},
    sync::{Arc, Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

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
    fn v8__CpuProfiler__StartWithId(
        profiler: *mut c_void,
        title: *const v8::String,
        record_samples: bool,
    ) -> u32;
    fn v8__CpuProfiler__StopProfiling(
        profiler: *mut c_void,
        title: *const v8::String,
    ) -> *const c_void;
    fn v8__CpuProfiler__StopById(profiler: *mut c_void, id: u32) -> *const c_void;

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
// Process-wide profiling session
// ---------------------------------------------------------------------------

static PROCESS_PROFILE: OnceLock<Mutex<Option<Arc<ProcessProfileSession>>>> = OnceLock::new();

fn process_profile_slot() -> &'static Mutex<Option<Arc<ProcessProfileSession>>> {
    PROCESS_PROFILE.get_or_init(|| Mutex::new(None))
}

struct ProcessProfileSession {
    started_at_nanos: i64,
    started: Instant,
    inner: Mutex<ProcessProfileSessionInner>,
}

struct ProcessProfileSessionInner {
    accepting: bool,
    active_realms: usize,
    next_realm_id: u64,
    accumulator: Option<ProfileAccumulator>,
}

impl ProcessProfileSession {
    fn new() -> Self {
        Self {
            started_at_nanos: unix_time_nanos(),
            started: Instant::now(),
            inner: Mutex::new(ProcessProfileSessionInner {
                accepting: true,
                active_realms: 0,
                next_realm_id: 1,
                accumulator: Some(ProfileAccumulator::new()),
            }),
        }
    }

    fn register(&self, name: &str) -> Option<String> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.accepting {
            return None;
        }
        let id = inner.next_realm_id;
        inner.next_realm_id += 1;
        inner.active_realms += 1;
        Some(format!("realm-{id}: {name}"))
    }

    fn merge(&self, profile: *const c_void, thread: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(accumulator) = inner.accumulator.as_mut() {
            accumulator.merge_profile(profile, Some(thread));
        }
        inner.active_realms = inner.active_realms.saturating_sub(1);
    }

    fn abandon(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.active_realms = inner.active_realms.saturating_sub(1);
    }

    fn close(&self) {
        self.inner.lock().unwrap().accepting = false;
    }

    fn encode(&self) -> Result<Vec<u8>, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.active_realms != 0 {
            return Err(format!(
                "cannot finish process profile while {} Realm profile(s) are active",
                inner.active_realms
            ));
        }
        let accumulator = inner
            .accumulator
            .take()
            .ok_or_else(|| "process profile has already been encoded".to_string())?;
        let duration_nanos = self.started.elapsed().as_nanos().min(i64::MAX as u128) as i64;
        Ok(accumulator.encode(self.started_at_nanos, duration_nanos))
    }
}

/// Per-Realm registration for an automatic process profile.
///
/// The V8 profiler remains isolate-owned. Only its final snapshot is traversed
/// into the shared Rust accumulator, on the Realm's owning isolate thread.
pub(crate) struct RealmProfileRegistration {
    session: Arc<ProcessProfileSession>,
    profiler: *mut c_void,
    profiler_id: u32,
    thread: String,
    completed: bool,
}

impl Drop for RealmProfileRegistration {
    fn drop(&mut self) {
        if !self.completed {
            self.session.abandon();
        }
    }
}

/// Stop and merge the automatic profile attached to a Realm, if present.
///
/// This must run while the Realm isolate is entered. It is intentionally
/// separate from `cpu_profiler`, which backs the public TypeScript API.
pub(crate) fn finish_realm_profile(state: &mut crate::state::FinoState) {
    let Some(mut registration) = state.process_profile.take() else {
        return;
    };
    let profile =
        unsafe { v8__CpuProfiler__StopById(registration.profiler, registration.profiler_id) };
    if profile.is_null() {
        registration.session.abandon();
    } else {
        registration.session.merge(profile, &registration.thread);
        unsafe { v8__CpuProfile__Delete(profile) };
    }
    registration.completed = true;
    unsafe { v8__CpuProfiler__Dispose(registration.profiler) };
}

fn realm_profile_name(state: &crate::state::FinoState) -> String {
    state
        .entry_path
        .as_deref()
        .filter(|entry| !entry.is_empty())
        .unwrap_or("main")
        .to_string()
}

fn start_realm_profile(scope: &mut v8::HandleScope) -> Result<(), String> {
    let session = process_profile_slot().lock().unwrap().clone();
    let Some(session) = session else {
        return Ok(());
    };
    let state_rc = get_state(scope);
    if state_rc.borrow().process_profile.is_some() {
        return Ok(());
    }
    let name = realm_profile_name(&state_rc.borrow());
    let Some(thread) = session.register(&name) else {
        return Ok(());
    };

    let isolate: *mut v8::Isolate = scope.as_mut();
    let profiler = unsafe { v8__CpuProfiler__New(isolate) };
    if profiler.is_null() {
        session.abandon();
        return Err("failed to create process CpuProfiler".to_string());
    }
    unsafe { v8__CpuProfiler__SetSamplingInterval(profiler, 1000) };
    let Some(title) = v8::String::new(scope, &thread) else {
        unsafe { v8__CpuProfiler__Dispose(profiler) };
        session.abandon();
        return Err("failed to allocate process profile title".to_string());
    };
    let profiler_id = unsafe { v8__CpuProfiler__StartWithId(profiler, &*title, true) };
    if profiler_id == 0 {
        unsafe { v8__CpuProfiler__Dispose(profiler) };
        session.abandon();
        return Err("failed to start process CpuProfiler".to_string());
    }

    state_rc.borrow_mut().process_profile = Some(RealmProfileRegistration {
        session,
        profiler,
        profiler_id,
        thread,
        completed: false,
    });
    Ok(())
}

fn throw_error(scope: &mut v8::HandleScope, message: &str) {
    let message = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::error(scope, message);
    scope.throw_exception(exception);
}

// ---------------------------------------------------------------------------
// Synthetic module: internal:process-profiler
// ---------------------------------------------------------------------------

pub fn create_process_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names: Vec<v8::Local<v8::String>> = [
        "beginProcessProfiling",
        "registerRealmProfiling",
        "finishProcessProfiling",
    ]
    .iter()
    .map(|name| v8::String::new(scope, name).unwrap())
    .collect();
    let module_name = v8::String::new(scope, "internal:process-profiler").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, process_eval_steps)
}

fn process_eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    macro_rules! set_fn {
        ($name:expr, $callback:expr) => {{
            let template = v8::FunctionTemplate::new(scope, $callback);
            let function = template.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, function.into())?;
        }};
    }
    set_fn!("beginProcessProfiling", begin_process_profiling);
    set_fn!("registerRealmProfiling", register_realm_profiling);
    set_fn!("finishProcessProfiling", finish_process_profiling);
    Some(v8::undefined(scope).into())
}

fn begin_process_profiling(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let session = Arc::new(ProcessProfileSession::new());
    {
        let mut slot = process_profile_slot().lock().unwrap();
        if slot.is_some() {
            throw_error(scope, "process profiling has already started");
            return;
        }
        *slot = Some(Arc::clone(&session));
    }
    if let Err(error) = start_realm_profile(scope) {
        process_profile_slot().lock().unwrap().take();
        session.close();
        throw_error(scope, &error);
    }
}

fn register_realm_profiling(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if let Err(error) = start_realm_profile(scope) {
        throw_error(scope, &error);
    }
}

fn finish_process_profiling(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let session = {
        let mut slot = process_profile_slot().lock().unwrap();
        let Some(session) = slot.take() else {
            throw_error(scope, "process profiling has not started");
            return;
        };
        session.close();
        session
    };

    let state_rc = get_state(scope);
    finish_realm_profile(&mut state_rc.borrow_mut());
    let bytes = match session.encode() {
        Ok(bytes) => bytes,
        Err(error) => {
            // Keep the closed session available for a later retry after the
            // remaining Realm teardown hooks have merged their snapshots.
            *process_profile_slot().lock().unwrap() = Some(session);
            throw_error(scope, &error);
            return;
        }
    };
    let len = bytes.len();
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes);
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &store.make_shared());
    let array = v8::Uint8Array::new(scope, buffer, 0, len).unwrap();
    rv.set(array.into());
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
    let start_time = unsafe { v8__CpuProfile__GetStartTime(profile) };
    let end_time = unsafe { v8__CpuProfile__GetEndTime(profile) };
    let duration_nanos = (end_time - start_time).max(0).saturating_mul(1000);

    // V8 timestamps are monotonic µs (not unix epoch). Anchor to wall clock:
    // time_nanos = now_ns - duration_ns gives the approximate profile start time.
    let mut accumulator = ProfileAccumulator::new();
    accumulator.merge_profile(profile, None);
    accumulator.encode(
        unix_time_nanos().saturating_sub(duration_nanos),
        duration_nanos,
    )
}

/// Shared semantic profile representation. V8 snapshots are traversed into
/// this structure without producing intermediate protobuf shards.
struct ProfileAccumulator {
    encoder: pprof::ProfileEncoder,
    function_map: HashMap<(u64, u64, i64), u64>,
    location_map: HashMap<(u64, i64), u64>,
    sample_map: HashMap<(u64, Vec<u64>), [i64; 2]>,
    thread_key: Option<u64>,
    wall_type: u64,
    microseconds_unit: u64,
}

impl ProfileAccumulator {
    fn new() -> Self {
        use pprof::{ProfileEncoder, ValueType};
        let mut encoder = ProfileEncoder::new();
        let samples = encoder.strings.intern("samples");
        let count = encoder.strings.intern("count");
        let wall = encoder.strings.intern("wall");
        let microseconds = encoder.strings.intern("microseconds");
        encoder.value_types.push(ValueType {
            r#type: samples,
            unit: count,
        });
        encoder.value_types.push(ValueType {
            r#type: wall,
            unit: microseconds,
        });
        Self {
            encoder,
            function_map: HashMap::new(),
            location_map: HashMap::new(),
            sample_map: HashMap::new(),
            thread_key: None,
            wall_type: wall,
            microseconds_unit: microseconds,
        }
    }

    fn function(&mut self, name: &str, filename: &str, start_line: i64) -> u64 {
        use pprof::Function;
        let name = self.encoder.strings.intern(name);
        let filename = self.encoder.strings.intern(filename);
        let key = (name, filename, start_line);
        if let Some(id) = self.function_map.get(&key) {
            return *id;
        }
        let id = self.encoder.functions.len() as u64 + 1;
        self.encoder.functions.push(Function {
            id,
            name,
            system_name: name,
            filename,
            start_line,
        });
        self.function_map.insert(key, id);
        id
    }

    fn location(&mut self, function_id: u64, line: i64) -> u64 {
        use pprof::{Line, Location};
        let key = (function_id, line);
        if let Some(id) = self.location_map.get(&key) {
            return *id;
        }
        let id = self.encoder.locations.len() as u64 + 1;
        self.encoder.locations.push(Location {
            id,
            lines: vec![Line { function_id, line }],
        });
        self.location_map.insert(key, id);
        id
    }

    fn merge_profile(&mut self, profile: *const c_void, thread: Option<&str>) {
        use pprof::Sample;
        let sample_count = unsafe { v8__CpuProfile__GetSamplesCount(profile) } as usize;
        let end_time = unsafe { v8__CpuProfile__GetEndTime(profile) };
        if thread.is_some() && self.thread_key.is_none() {
            self.thread_key = Some(self.encoder.strings.intern("thread"));
        }
        let thread = thread.map(|value| self.encoder.strings.intern(value));
        for index in 0..sample_count {
            let node = unsafe { v8__CpuProfile__GetSample(profile, index as c_int) };
            let timestamp = unsafe { v8__CpuProfile__GetSampleTimestamp(profile, index as c_int) };
            let wall_us = if index + 1 < sample_count {
                unsafe {
                    v8__CpuProfile__GetSampleTimestamp(profile, (index + 1) as c_int) - timestamp
                }
            } else {
                end_time - timestamp
            }
            .max(0);

            // Walk leaf to root, excluding V8's synthetic root node.
            let mut location_ids = Vec::new();
            let mut current = node;
            loop {
                if current.is_null() {
                    break;
                }
                let parent = unsafe { v8__CpuProfileNode__GetParent(current) };
                if parent.is_null() {
                    break;
                }

                let name = unsafe {
                    let pointer = v8__CpuProfileNode__GetFunctionNameStr(current);
                    if pointer.is_null() {
                        ""
                    } else {
                        CStr::from_ptr(pointer).to_str().unwrap_or("")
                    }
                };
                let filename = unsafe {
                    let pointer = v8__CpuProfileNode__GetScriptResourceNameStr(current);
                    if pointer.is_null() {
                        ""
                    } else {
                        CStr::from_ptr(pointer).to_str().unwrap_or("")
                    }
                };
                let line = unsafe { v8__CpuProfileNode__GetLineNumber(current) } as i64;
                let display_name = if name.is_empty() { "(anonymous)" } else { name };
                let function_id = self.function(display_name, filename, line);
                location_ids.push(self.location(function_id, line));
                current = parent;
            }

            if !location_ids.is_empty() {
                if let Some(thread) = thread {
                    let values = self
                        .sample_map
                        .entry((thread, location_ids))
                        .or_insert([0, 0]);
                    values[0] += 1;
                    values[1] += wall_us;
                } else {
                    self.encoder.samples.push(Sample {
                        location_ids,
                        values: vec![1, wall_us],
                        labels: Vec::new(),
                    });
                }
            }
        }
    }

    fn encode(mut self, time_nanos: i64, duration_nanos: i64) -> Vec<u8> {
        use pprof::{Label, Sample};
        let mut samples: Vec<_> = self.sample_map.drain().collect();
        samples.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        for ((thread, location_ids), values) in samples {
            self.encoder.samples.push(Sample {
                location_ids,
                values: values.to_vec(),
                labels: vec![Label {
                    key: self.thread_key.unwrap(),
                    str: thread,
                }],
            });
        }
        self.encoder.time_nanos = time_nanos;
        self.encoder.duration_nanos = duration_nanos;
        self.encoder.period_type = pprof::ValueType {
            r#type: self.wall_type,
            unit: self.microseconds_unit,
        };
        self.encoder.period = 1000;
        self.encoder.encode()
    }
}

fn unix_time_nanos() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
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

#[cfg(test)]
mod tests {
    use super::ProcessProfileSession;

    #[test]
    fn process_session_waits_for_every_realm_registration() {
        let session = ProcessProfileSession::new();
        let first = session.register("entry.ts").unwrap();
        let second = session.register("entry.ts").unwrap();
        assert_ne!(first, second);

        session.close();
        assert!(session.register("late.ts").is_none());
        assert!(session.encode().unwrap_err().contains("2 Realm profile(s)"));

        session.abandon();
        session.abandon();
        assert!(!session.encode().unwrap().is_empty());
    }
}
