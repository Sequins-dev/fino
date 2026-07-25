//! `internal:reactor-engine` — the orchestrator-facing synthetic module.
//!
//! The orchestrator (TS) spawns and drives a pool of reactor threads through
//! these callbacks. Handles live in a thread-local registry keyed by a small
//! integer id, owned by whichever realm's thread spawned them.

use super::*;

use std::cell::RefCell;

thread_local! {
    static REACTORS: RefCell<Vec<Option<ReactorHandle>>> = const { RefCell::new(Vec::new()) };
}

/// Build the `internal:reactor-engine` synthetic module.
pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let names = [
        "spawnReactor",
        "placeRealm",
        "moveRealm",
        "isEngineThread",
        "revoke",
        "shutdown",
        "joinReactor",
        "nextReport",
        "drainReports",
        "reactorAlive",
        "reactorGeneration",
        "crashRealm",
    ];
    let export_names: Vec<v8::Local<v8::String>> = names
        .iter()
        .map(|n| v8::String::new(scope, n).unwrap())
        .collect();
    let module_name = v8::String::new(scope, "internal:reactor-engine").unwrap();
    v8::Module::create_synthetic_module(scope, module_name, &export_names, eval_steps)
}

fn eval_steps<'a>(
    context: v8::Local<'a, v8::Context>,
    module: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Value>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };
    macro_rules! export {
        ($name:literal, $cb:path) => {{
            let tmpl = v8::FunctionTemplate::new(scope, $cb);
            let func = tmpl.get_function(scope)?;
            let key = v8::String::new(scope, $name)?;
            module.set_synthetic_module_export(scope, key, func.into())?;
        }};
    }
    export!("spawnReactor", cb_spawn_reactor);
    export!("placeRealm", cb_place_realm);
    export!("moveRealm", cb_move_realm);
    export!("isEngineThread", cb_is_engine_thread);
    export!("revoke", cb_revoke);
    export!("shutdown", cb_shutdown);
    export!("joinReactor", cb_join_reactor);
    export!("nextReport", cb_next_report);
    export!("drainReports", cb_drain_reports);
    export!("reactorAlive", cb_reactor_alive);
    export!("reactorGeneration", cb_reactor_generation);
    export!("crashRealm", cb_crash_realm);
    Some(v8::undefined(scope).into())
}

fn arg_u64(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments, i: i32) -> u64 {
    args.get(i).integer_value(scope).unwrap_or(0).max(0) as u64
}

fn arg_str(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments, i: i32) -> String {
    args.get(i)
        .to_string(scope)
        .map(|s| s.to_rust_string_lossy(scope))
        .unwrap_or_default()
}

fn obj_u64(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    key: &str,
    default: u64,
) -> u64 {
    v8::String::new(scope, key)
        .and_then(|k| obj.get(scope, k.into()))
        // A missing key reads as `undefined`, and ToInteger(undefined) is 0 —
        // which would silently zero the default. Absent means default.
        .filter(|v| !v.is_null_or_undefined())
        .and_then(|v| v.integer_value(scope))
        .map(|n| n.max(0) as u64)
        .unwrap_or(default)
}

fn obj_string(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    key: &str,
) -> Option<String> {
    let key = v8::String::new(scope, key)?;
    let value = obj.get(scope, key.into())?;
    if value.is_null_or_undefined() {
        return None;
    }
    value
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
}

fn obj_bool(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str) -> bool {
    v8::String::new(scope, key)
        .and_then(|key| obj.get(scope, key.into()))
        .is_some_and(|value| value.boolean_value(scope))
}

fn with_reactor<R>(id: usize, f: impl FnOnce(&ReactorHandle) -> R) -> Option<R> {
    REACTORS.with(|r| r.borrow().get(id).and_then(|h| h.as_ref()).map(f))
}

/// Send a control message and post into the reactor so it acts promptly.
fn send_control(id: usize, msg: Control) {
    with_reactor(id, |h| {
        let _ = h.control.send(msg);
    });
}

fn cb_spawn_reactor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let cfg_obj = v8::Local::<v8::Object>::try_from(args.get(0)).ok();
    let hard_budget_micros = cfg_obj
        .map(|o| obj_u64(scope, o, "hardBudgetMicros", 5_000_000))
        .unwrap_or(5_000_000);
    let sync_slice_micros = cfg_obj
        .map(|o| obj_u64(scope, o, "syncSliceMicros", 50_000))
        .unwrap_or(50_000);
    let heap_limit_bytes = cfg_obj
        .map(|o| obj_u64(scope, o, "heapLimitBytes", 0))
        .unwrap_or(0) as usize;
    let reactor_class = match cfg_obj
        .and_then(|object| obj_string(scope, object, "reactorClass"))
        .as_deref()
    {
        Some("batch") => ReactorClass::Batch,
        _ => ReactorClass::Latency,
    };

    let state = crate::state::get_state(scope);
    let (process_env, package_map_json) = {
        let st = state.borrow();
        (st.process_env.clone(), st.package_map_json.clone())
    };

    let config = ReactorConfig {
        hard_budget_micros,
        sync_slice_micros,
        heap_limit_bytes,
        process_env,
        package_map_json,
        reactor_class,
    };
    match spawn_reactor(config) {
        Ok(handle) => {
            let id = REACTORS.with(|r| {
                let mut v = r.borrow_mut();
                let id = v.len();
                v.push(Some(handle));
                id
            });
            rv.set(v8::Integer::new(scope, id as i32).into());
        }
        Err(err) => {
            let msg = v8::String::new(scope, &err).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
        }
    }
}

/// JS: `isEngineThread(): boolean` — whether this realm is hosted on an
/// engine (scheduler) thread. Engine-hosted realms must not spawn reactors
/// of their own; the allocator uses this to fall back to dedicated threads.
fn cb_is_engine_thread(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    rv.set(v8::Boolean::new(scope, engine_io_active()).into());
}

/// JS: `placeRealm(reactorId, placement) → { portHandle, portWakeFd }`
///
/// Creates the realm's channel pair on the calling (orchestrator) thread,
/// ships the child half to the engine thread inside the PlaceRealm control,
/// and returns the parent half — the caller constructs the Realm's port
/// over it through the standard reactor-realm transport.
fn cb_place_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let Ok(placement) = v8::Local::<v8::Object>::try_from(args.get(1)) else {
        let message = v8::String::new(scope, "placeRealm requires a placement object").unwrap();
        let exception = v8::Exception::type_error(scope, message);
        scope.throw_exception(exception);
        return;
    };
    let workload_id = obj_u64(scope, placement, "realmId", 0);
    let entry_path = obj_string(scope, placement, "entryPath").unwrap_or_default();
    let rules_json = obj_string(scope, placement, "rulesJson").unwrap_or_default();
    let realm_data = obj_string(scope, placement, "data");
    let realm_bootstrap_data = obj_string(scope, placement, "bootstrapData");
    let priority_class = obj_u64(scope, placement, "priority", 1) as u8;
    let watch_mode = obj_bool(scope, placement, "watch");
    let repl_mode = obj_bool(scope, placement, "repl");

    let (parent_handle, child_handle, parent_wake_fd, child_wake_fd) =
        match crate::realm::transit::create_transit_pair() {
            Ok(pair) => pair,
            Err(e) => {
                let msg = v8::String::new(scope, &format!("placeRealm: {e}")).unwrap();
                let exc = v8::Exception::error(scope, msg);
                scope.throw_exception(exc);
                return;
            }
        };
    let (
        allocation_parent_handle,
        allocation_child_handle,
        allocation_parent_wake_fd,
        allocation_child_wake_fd,
    ) = match crate::realm::transit::create_transit_pair() {
        Ok(pair) => pair,
        Err(e) => {
            drop(crate::realm::transit::remove_half(parent_handle));
            drop(crate::realm::transit::remove_half(child_handle));
            let msg = v8::String::new(scope, &format!("placeRealm allocation port: {e}")).unwrap();
            let exc = v8::Exception::error(scope, msg);
            scope.throw_exception(exc);
            return;
        }
    };

    send_control(
        id,
        Control::PlaceRealm(RealmPlacement {
            workload_id,
            entry_path,
            rules_json,
            realm_data,
            realm_bootstrap_data,
            watch_mode,
            repl_mode,
            priority_class,
            port_half: (child_handle, child_wake_fd),
            allocation_half: (allocation_child_handle, allocation_child_wake_fd),
        }),
    );

    let obj = v8::Object::new(scope);
    let k = v8::String::new(scope, "portHandle").unwrap();
    let v = v8::Number::new(scope, parent_handle as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "portWakeFd").unwrap();
    let v = v8::Number::new(scope, parent_wake_fd as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "allocationPortHandle").unwrap();
    let v = v8::Number::new(scope, allocation_parent_handle as f64);
    obj.set(scope, k.into(), v.into());
    let k = v8::String::new(scope, "allocationPortWakeFd").unwrap();
    let v = v8::Number::new(scope, allocation_parent_wake_fd as f64);
    obj.set(scope, k.into(), v.into());
    rv.set(obj.into());
}

/// JS: `moveRealm(sourceReactorId, destinationReactorId, workloadId)`.
/// Detachment and attachment happen asynchronously on the two reactor loops;
/// the destination emits a `moved` report once it owns the isolate.
fn cb_move_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let source_id = arg_u64(scope, &args, 0) as usize;
    let destination_id = arg_u64(scope, &args, 1) as usize;
    let workload_id = arg_u64(scope, &args, 2);
    let destination = with_reactor(destination_id, |handle| handle.control.clone());
    let Some(destination) = destination else {
        let message = v8::String::new(scope, "moveRealm: destination reactor not found").unwrap();
        let exception = v8::Exception::error(scope, message);
        scope.throw_exception(exception);
        return;
    };
    send_control(
        source_id,
        Control::Move {
            workload_id,
            destination,
        },
    );
}

fn cb_revoke(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    let reason = arg_str(scope, &args, 2);
    send_control(
        id,
        Control::Revoke {
            workload_id,
            reason,
        },
    );
}

fn cb_shutdown(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    send_control(id, Control::Shutdown);
}

fn cb_join_reactor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let handle = REACTORS.with(|reactors| reactors.borrow_mut().get_mut(id).and_then(Option::take));
    let joined = handle.is_some_and(|handle| handle.join.join().is_ok());
    rv.set_bool(joined);
}

/// `nextReport(reactorId)`: a promise resolved when the reactor thread posts
/// its next load report — or immediately, if reports (or the thread's death)
/// arrived while unarmed, so no wake is ever lost. Replaces the report wake
/// pipe the orchestrator used to `readable()` on.
fn cb_next_report(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());
    let resolve_now = REACTORS.with(|r| {
        let borrow = r.borrow();
        let Some(h) = borrow.get(id).and_then(|h| h.as_ref()) else {
            // Unknown reactor: resolve so the caller's loop re-checks and exits.
            return true;
        };
        let seq = h.report_seq.load(Ordering::Acquire);
        if seq != h.report_seen.get() || !h.alive.load(Ordering::Acquire) {
            h.report_seen.set(seq);
            true
        } else {
            *h.report_waiter.borrow_mut() = Some(v8::Global::new(scope, resolver));
            false
        }
    });
    if resolve_now {
        let undef = v8::undefined(scope).into();
        resolver.resolve(scope, undef);
    }
}

/// Resolve armed `nextReport()` waiters whose reactors have advanced (a new
/// report, or thread death). Called from `async_rt::drain_all` on every pump —
/// cheap on non-orchestrator threads (their registry is empty).
pub(crate) fn drain_report_wakes(scope: &mut v8::HandleScope) -> bool {
    let waiters: Vec<v8::Global<v8::PromiseResolver>> = REACTORS.with(|r| {
        let borrow = r.borrow();
        let mut out = Vec::new();
        for h in borrow.iter().flatten() {
            let seq = h.report_seq.load(Ordering::Acquire);
            if (seq != h.report_seen.get() || !h.alive.load(Ordering::Acquire))
                && let Some(g) = h.report_waiter.borrow_mut().take()
            {
                // Only consume the advance when a waiter is armed — otherwise
                // the next nextReport() resolves immediately off the delta.
                h.report_seen.set(seq);
                out.push(g);
            }
        }
        out
    });
    if waiters.is_empty() {
        return false;
    }
    for g in &waiters {
        let resolver = v8::Local::new(scope, g);
        let undef = v8::undefined(scope).into();
        resolver.resolve(scope, undef);
    }
    true
}

fn cb_reactor_alive(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let alive = with_reactor(id, |h| h.alive.load(Ordering::Acquire)).unwrap_or(false);
    rv.set_bool(alive);
}

fn cb_reactor_generation(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let generation = with_reactor(id, |h| h.generation.load(Ordering::Acquire)).unwrap_or(0);
    rv.set(v8::Number::new(scope, generation as f64).into());
}

fn cb_crash_realm(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let workload_id = arg_u64(scope, &args, 1);
    send_control(id, Control::CrashRealm { workload_id });
}

fn cb_drain_reports(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let id = arg_u64(scope, &args, 0) as usize;
    let reports: Vec<Report> = REACTORS.with(|r| {
        let borrow = r.borrow();
        let handle = match borrow.get(id).and_then(|h| h.as_ref()) {
            Some(h) => h,
            None => return Vec::new(),
        };
        let mut out = Vec::new();
        while let Ok(report) = handle.report_rx.try_recv() {
            out.push(report);
        }
        out
    });

    let arr = v8::Array::new(scope, reports.len() as i32);
    for (i, report) in reports.into_iter().enumerate() {
        let obj = report_to_js(scope, report);
        arr.set_index(scope, i as u32, obj.into());
    }
    rv.set(arr.into());
}

fn set_str(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, val: &str) {
    let k = v8::String::new(scope, key).unwrap();
    let v = v8::String::new(scope, val).unwrap();
    obj.set(scope, k.into(), v.into());
}

fn set_num(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str, val: f64) {
    let k = v8::String::new(scope, key).unwrap();
    let v = v8::Number::new(scope, val);
    obj.set(scope, k.into(), v.into());
}

fn report_to_js<'s>(scope: &mut v8::HandleScope<'s>, report: Report) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);
    match report {
        Report::Released {
            workload_id,
            reason,
        } => {
            set_str(scope, obj, "type", "released");
            set_num(scope, obj, "workloadId", workload_id as f64);
            set_str(scope, obj, "reason", &reason);
        }
        Report::Moved { workload_id } => {
            set_str(scope, obj, "type", "moved");
            set_num(scope, obj, "workloadId", workload_id as f64);
        }
        Report::MoveRejected {
            workload_id,
            reason,
        } => {
            set_str(scope, obj, "type", "moveRejected");
            set_num(scope, obj, "workloadId", workload_id as f64);
            set_str(scope, obj, "reason", reason);
        }
        Report::SyncHeavy {
            workload_id,
            cpu_micros,
        } => {
            set_str(scope, obj, "type", "syncHeavy");
            set_num(scope, obj, "workloadId", workload_id as f64);
            set_num(scope, obj, "cpuMicros", cpu_micros);
        }
        Report::Load {
            held,
            runnable,
            debt_micros,
        } => {
            set_str(scope, obj, "type", "load");
            set_num(scope, obj, "held", held as f64);
            set_num(scope, obj, "runnable", runnable as f64);
            set_num(scope, obj, "debtMicros", debt_micros);
        }
    }
    obj
}
