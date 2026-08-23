//! Minimal native support for TypeScript-owned V8 coverage.
//!
//! TypeScript owns the inspector protocol, offset normalization, source-map
//! policy, shard publication, aggregation, and artifact I/O. Native code only
//! coordinates coverage identity across Isolates/processes, creates a missing
//! shard before user code can run, and exposes the loader's parsed source-map
//! cache in batches.

use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};

use crate::state::get_state;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoverageRunConfig {
    output_path: PathBuf,
    shard_dir: PathBuf,
    root: PathBuf,
    run_id: String,
    owner_pid: u32,
}

struct ActiveRun {
    config: CoverageRunConfig,
    next_realm: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RealmDescriptor<'a> {
    id: &'a str,
    parent_id: Option<&'a str>,
    kind: &'a str,
    entry: Option<&'a str>,
    status: &'a str,
    totals: EmptyTotals,
}

#[derive(Clone, Copy, Serialize)]
struct EmptyMetric {
    covered: u8,
    total: u8,
    percent: f64,
}

#[derive(Clone, Copy, Serialize)]
struct EmptyTotals {
    lines: EmptyMetric,
    functions: EmptyMetric,
    branches: EmptyMetric,
}

const EMPTY_METRIC: EmptyMetric = EmptyMetric {
    covered: 0,
    total: 0,
    percent: 0.0,
};
const EMPTY_TOTALS: EmptyTotals = EmptyTotals {
    lines: EMPTY_METRIC,
    functions: EMPTY_METRIC,
    branches: EMPTY_METRIC,
};

fn active_run() -> &'static Mutex<Option<ActiveRun>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveRun>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

/// Return the active run configuration so child processes can inherit it.
pub(crate) fn current_run_config() -> Option<CoverageRunConfig> {
    active_run()
        .lock()
        .ok()
        .and_then(|run| run.as_ref().map(|run| run.config.clone()))
}

/// Install a run inherited by a process Realm before its Isolate is created.
pub(crate) fn configure_process_child(config: Option<CoverageRunConfig>) {
    let Some(config) = config else { return };
    if let Ok(mut active) = active_run().lock() {
        *active = Some(ActiveRun {
            config,
            next_realm: 0,
        });
    }
}

/// Start coverage for a newly created child Realm when a run is active.
pub(crate) fn start_realm_if_active(
    scope: &mut v8::HandleScope,
    kind: &str,
    parent_id: Option<String>,
) {
    if current_run_config().is_none() {
        return;
    }
    if let Err(error) = start_realm(scope, kind, parent_id) {
        eprintln!("[coverage] unable to register {kind} Realm: {error}");
    }
}

fn start_run(scope: &mut v8::HandleScope, config: CoverageRunConfig) -> Result<String, String> {
    {
        let mut active = active_run()
            .lock()
            .map_err(|_| "coverage coordinator lock is poisoned".to_string())?;
        if active.is_some() {
            return Err("a coverage run is already active".to_string());
        }
        *active = Some(ActiveRun {
            config,
            next_realm: 0,
        });
    }
    match start_realm(scope, "test", None) {
        Ok(id) => Ok(id),
        Err(error) => {
            if let Ok(mut active) = active_run().lock() {
                *active = None;
            }
            Err(error)
        }
    }
}

fn start_realm(
    scope: &mut v8::HandleScope,
    kind: &str,
    parent_id: Option<String>,
) -> Result<String, String> {
    if let Some(id) = get_state(scope).borrow().coverage_realm_id.clone() {
        return Ok(id);
    }
    let (config, id) = {
        let mut active = active_run()
            .lock()
            .map_err(|_| "coverage coordinator lock is poisoned".to_string())?;
        let run = active
            .as_mut()
            .ok_or_else(|| "no coverage run is active".to_string())?;
        let id = format!("realm-{}-{}", std::process::id(), run.next_realm);
        run.next_realm += 1;
        (run.config.clone(), id)
    };
    let entry = get_state(scope).borrow().entry_path.clone();
    write_placeholder(
        &config,
        &RealmDescriptor {
            id: &id,
            parent_id: parent_id.as_deref(),
            kind,
            entry: entry.as_deref(),
            status: "missing",
            totals: EMPTY_TOTALS,
        },
    )?;
    let state = get_state(scope);
    let mut state = state.borrow_mut();
    state.coverage_realm_id = Some(id.clone());
    state.coverage_parent_id = parent_id;
    state.coverage_realm_kind = Some(kind.to_string());
    Ok(id)
}

fn write_placeholder(
    config: &CoverageRunConfig,
    realm: &RealmDescriptor<'_>,
) -> Result<(), String> {
    #[derive(Serialize)]
    struct Placeholder<'a> {
        realm: &'a RealmDescriptor<'a>,
        files: [(); 0],
        warnings: [&'static str; 1],
    }
    let path = config.shard_dir.join(format!("{}.json", realm.id));
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec(&Placeholder {
        realm,
        files: [],
        warnings: ["Realm did not submit a final coverage snapshot"],
    })
    .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| {
        format!(
            "write coverage placeholder {}: {error}",
            temporary.display()
        )
    })?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("publish coverage placeholder {}: {error}", path.display()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedPosition {
    line: u32,
    column: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginalPosition {
    source: String,
    line: u32,
    column: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionMap {
    has_map: bool,
    positions: Vec<Option<OriginalPosition>>,
}

fn map_positions(
    scope: &mut v8::HandleScope,
    script_url: &str,
    positions: Vec<GeneratedPosition>,
) -> PositionMap {
    let state = get_state(scope);
    let state = state.borrow();
    let Some(source_map) = state.source_maps.get(script_url) else {
        return PositionMap {
            has_map: false,
            positions: vec![],
        };
    };
    PositionMap {
        has_map: true,
        positions: positions
            .into_iter()
            .map(|position| {
                source_map
                    .lookup(position.line, position.column)
                    .map(|(source, line, column)| OriginalPosition {
                        source,
                        line,
                        column,
                    })
            })
            .collect(),
    }
}

fn realm_context(scope: &mut v8::HandleScope) -> Option<String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Context<'a> {
        run: &'a CoverageRunConfig,
        realm: RealmDescriptor<'a>,
        tool_version: &'static str,
    }
    let config = current_run_config()?;
    let state = get_state(scope);
    let state = state.borrow();
    let id = state.coverage_realm_id.as_deref()?;
    serde_json::to_string(&Context {
        run: &config,
        realm: RealmDescriptor {
            id,
            parent_id: state.coverage_parent_id.as_deref(),
            kind: state.coverage_realm_kind.as_deref().unwrap_or("realm"),
            entry: state.entry_path.as_deref(),
            status: "missing",
            totals: EMPTY_TOTALS,
        },
        tool_version: env!("CARGO_PKG_VERSION"),
    })
    .ok()
}

fn complete_realm(scope: &mut v8::HandleScope) {
    let state = get_state(scope);
    let mut state = state.borrow_mut();
    state.coverage_realm_id = None;
    state.coverage_parent_id = None;
    state.coverage_realm_kind = None;
}

fn finish_run() -> Option<CoverageRunConfig> {
    let mut active = active_run().lock().ok()?;
    if active.as_ref()?.config.owner_pid != std::process::id() {
        return None;
    }
    active.take().map(|run| run.config)
}

// ---------------------------------------------------------------------------
// internal:coverage/bindings synthetic module
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names = [
        "startCoverageRun",
        "coverageRealmContext",
        "mapCoveragePositions",
        "completeCoverageRealm",
        "finishCoverageRun",
        "coverageActive",
    ]
    .iter()
    .map(|name| v8::String::new(scope, name).unwrap())
    .collect::<Vec<_>>();
    let name = v8::String::new(scope, "internal:coverage/bindings").unwrap();
    v8::Module::create_synthetic_module(scope, name, &export_names, coverage_eval)
}

fn coverage_eval<'a>(
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
    set_fn!("startCoverageRun", start_coverage_run_cb);
    set_fn!("coverageRealmContext", coverage_realm_context_cb);
    set_fn!("mapCoveragePositions", map_coverage_positions_cb);
    set_fn!("completeCoverageRealm", complete_coverage_realm_cb);
    set_fn!("finishCoverageRun", finish_coverage_run_cb);
    set_fn!("coverageActive", coverage_active_cb);
    Some(v8::undefined(scope).into())
}

fn string_arg(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> Option<String> {
    value
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
}

fn set_json_return<T: Serialize>(scope: &mut v8::HandleScope, value: &T, mut rv: v8::ReturnValue) {
    match serde_json::to_string(value) {
        Ok(json) => {
            if let Some(value) = v8::String::new(scope, &json) {
                rv.set(value.into());
            }
        }
        Err(error) => throw_error(scope, &error.to_string()),
    }
}

fn start_coverage_run_cb(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let Some(config) = string_arg(scope, args.get(0)) else {
        throw_error(scope, "coverage run configuration must be JSON text");
        return;
    };
    let config = match serde_json::from_str::<CoverageRunConfig>(&config) {
        Ok(config) => config,
        Err(error) => {
            throw_error(
                scope,
                &format!("invalid coverage run configuration: {error}"),
            );
            return;
        }
    };
    match start_run(scope, config) {
        Ok(id) => {
            if let Some(value) = v8::String::new(scope, &id) {
                rv.set(value.into());
            }
        }
        Err(error) => throw_error(scope, &error),
    }
}

fn coverage_realm_context_cb(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match realm_context(scope) {
        Some(context) => {
            if let Some(value) = v8::String::new(scope, &context) {
                rv.set(value.into());
            }
        }
        None => rv.set(v8::null(scope).into()),
    }
}

fn map_coverage_positions_cb(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    let Some(script_url) = string_arg(scope, args.get(0)) else {
        throw_error(scope, "coverage script URL must be text");
        return;
    };
    let Some(positions) = string_arg(scope, args.get(1)) else {
        throw_error(scope, "coverage positions must be JSON text");
        return;
    };
    let positions = match serde_json::from_str::<Vec<GeneratedPosition>>(&positions) {
        Ok(positions) => positions,
        Err(error) => {
            throw_error(scope, &format!("invalid coverage positions: {error}"));
            return;
        }
    };
    let mapped = map_positions(scope, &script_url, positions);
    set_json_return(scope, &mapped, rv);
}

fn complete_coverage_realm_cb(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    complete_realm(scope);
}

fn finish_coverage_run_cb(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match finish_run() {
        Some(config) => set_json_return(scope, &config, rv),
        None => rv.set(v8::null(scope).into()),
    }
}

fn coverage_active_cb(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let active = get_state(scope).borrow().coverage_realm_id.is_some();
    rv.set(v8::Boolean::new(scope, active).into());
}

fn throw_error(scope: &mut v8::HandleScope, error: &str) {
    let message = v8::String::new(scope, error).unwrap();
    let exception = v8::Exception::error(scope, message);
    scope.throw_exception(exception);
}
