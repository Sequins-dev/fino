//! V8 precise code coverage collection and cross-Realm aggregation.
//!
//! Coverage is opt-in and run-scoped. Each participating Isolate starts V8's
//! precise block coverage, normalizes its generated offsets while its loader
//! source-map cache is still alive, and writes a uniquely named shard. The
//! test Realm merges those shards into the canonical JSON artifact after
//! shutdown hooks have completed.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::state::{SourceMapCache, get_state};

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

fn active_run() -> &'static Mutex<Option<ActiveRun>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveRun>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metric {
    pub covered: u64,
    pub total: u64,
    pub percent: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Totals {
    pub lines: Metric,
    pub functions: Metric,
    pub branches: Metric,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealmDescriptor {
    id: String,
    parent_id: Option<String>,
    kind: String,
    entry: Option<String>,
    status: String,
    #[serde(default)]
    totals: Totals,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRange {
    start_line: u32,
    start_column: u32,
    end_line: u32,
    end_column: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalLine {
    line: u32,
    hits: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalFunction {
    name: String,
    range: SourceRange,
    hits: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalBranch {
    range: SourceRange,
    hits: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalFile {
    path: String,
    source_hash: String,
    lines: Vec<LocalLine>,
    functions: Vec<LocalFunction>,
    branches: Vec<LocalBranch>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RealmShard {
    realm: RealmDescriptor,
    files: Vec<LocalFile>,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageLine {
    line: u32,
    hits: u64,
    covered_in: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageFunction {
    id: String,
    name: String,
    range: SourceRange,
    hits: u64,
    covered_in: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageBranch {
    id: String,
    range: SourceRange,
    hits: u64,
    covered_in: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageFile {
    path: String,
    source_hash: String,
    realm_ids: Vec<String>,
    totals: Totals,
    lines: Vec<CoverageLine>,
    functions: Vec<CoverageFunction>,
    branches: Vec<CoverageBranch>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolInfo {
    name: String,
    version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunInfo {
    root: String,
    id: String,
    complete: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoverageArtifact {
    schema_version: u32,
    tool: ToolInfo,
    run: RunInfo,
    totals: Totals,
    realms: Vec<RealmDescriptor>,
    files: Vec<CoverageFile>,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoverageSummary {
    path: String,
    complete: bool,
    totals: Totals,
    realm_count: usize,
    incomplete_realm_count: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRange {
    start_offset: u32,
    end_offset: u32,
    count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFunction {
    function_name: String,
    ranges: Vec<RawRange>,
    is_block_coverage: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawScript {
    script_id: String,
    url: String,
    functions: Vec<RawFunction>,
}

/// Return the active run configuration so child-process launchers can inherit it.
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

fn run_config() -> Option<CoverageRunConfig> {
    current_run_config()
}

fn absolute_path(root: &Path, path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

/// Start a new coverage run in the current test Realm.
pub(crate) fn start_run(scope: &mut v8::HandleScope, path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("--coverage path must not be empty".to_string());
    }
    let root = get_state(scope).borrow().process_env.root.clone();
    let output_path = absolute_path(&root, path);
    let parent = output_path
        .parent()
        .ok_or_else(|| format!("invalid coverage path {}", output_path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create coverage directory {}: {error}", parent.display()))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let run_id = format!("{}-{now}", std::process::id());
    let shard_dir = parent.join(format!(".fino-coverage-{run_id}"));
    std::fs::create_dir_all(&shard_dir)
        .map_err(|error| format!("create coverage shard directory: {error}"))?;
    let config = CoverageRunConfig {
        output_path,
        shard_dir,
        root,
        run_id,
        owner_pid: std::process::id(),
    };
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

/// Start coverage for a newly created child Realm when a run is active.
pub(crate) fn start_realm_if_active(
    scope: &mut v8::HandleScope,
    kind: &str,
    parent_id: Option<String>,
) {
    if run_config().is_none() {
        return;
    }
    if let Err(error) = start_realm(scope, kind, parent_id) {
        eprintln!("[coverage] unable to start {kind} Realm coverage: {error}");
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
    let descriptor = RealmDescriptor {
        id: id.clone(),
        parent_id: parent_id.clone(),
        kind: kind.to_string(),
        entry: entry
            .as_deref()
            .and_then(|entry| normalize_entry(&config.root, entry)),
        status: "missing".to_string(),
        totals: Totals::default(),
    };
    write_shard(
        &config,
        &RealmShard {
            realm: descriptor,
            files: Vec::new(),
            warnings: vec!["Realm did not submit a final coverage snapshot".to_string()],
        },
    )?;
    let state = get_state(scope);
    let mut state = state.borrow_mut();
    state.coverage_realm_id = Some(id.clone());
    state.coverage_parent_id = parent_id;
    state.coverage_realm_kind = Some(kind.to_string());
    Ok(id)
}

/// Normalize a TypeScript-collected V8 snapshot and replace this Realm's placeholder shard.
fn submit_realm_snapshot(scope: &mut v8::HandleScope, snapshot: &Value) -> Result<(), String> {
    let (id, parent_id, kind, entry) = {
        let state = get_state(scope);
        let mut state = state.borrow_mut();
        let Some(id) = state.coverage_realm_id.take() else {
            return Ok(());
        };
        (
            id,
            state.coverage_parent_id.take(),
            state
                .coverage_realm_kind
                .take()
                .unwrap_or_else(|| "realm".to_string()),
            state.entry_path.clone(),
        )
    };
    let Some(config) = run_config() else {
        return Ok(());
    };
    let (files, warnings, final_status) = match normalize_snapshot(scope, &config, snapshot) {
        Ok((files, warnings)) => (files, warnings, "complete".to_string()),
        Err(error) => (
            Vec::new(),
            vec![format!("unable to normalize coverage: {error}")],
            "missing".to_string(),
        ),
    };
    write_shard(
        &config,
        &RealmShard {
            realm: RealmDescriptor {
                id,
                parent_id,
                kind,
                entry: entry
                    .as_deref()
                    .and_then(|entry| normalize_entry(&config.root, entry)),
                status: final_status,
                totals: Totals::default(),
            },
            files,
            warnings,
        },
    )
}

/// Finish the owning test Realm and write the aggregate artifact.
pub(crate) fn finish_run(_scope: &mut v8::HandleScope) -> Result<Option<CoverageSummary>, String> {
    let Some(config) = run_config() else {
        return Ok(None);
    };
    if config.owner_pid != std::process::id() {
        return Ok(None);
    }
    let result = (|| {
        wait_for_final_shards(&config)?;
        let artifact = aggregate_shards(&config)?;
        write_artifact(&config.output_path, &artifact)?;
        let incomplete_realm_count = artifact
            .realms
            .iter()
            .filter(|realm| realm.status != "complete")
            .count();
        Ok(CoverageSummary {
            path: display_path(&config.root, &config.output_path),
            complete: artifact.run.complete,
            totals: artifact.totals.clone(),
            realm_count: artifact.realms.len(),
            incomplete_realm_count,
            warnings: artifact.warnings.clone(),
        })
    })();
    if let Ok(mut active) = active_run().lock() {
        *active = None;
    }
    if result.as_ref().is_ok_and(|summary| summary.complete) {
        let _ = std::fs::remove_dir_all(&config.shard_dir);
    }
    result.map(Some)
}

/// Give already-registered child Realms a bounded opportunity to replace their
/// placeholder shards. A crashed or force-terminated Realm remains `missing`
/// and is represented as such in the final artifact instead of blocking the
/// test process indefinitely.
fn wait_for_final_shards(config: &CoverageRunConfig) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        let mut pending = false;
        for entry in std::fs::read_dir(&config.shard_dir)
            .map_err(|error| format!("read coverage shards: {error}"))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let bytes = std::fs::read(entry.path()).map_err(|error| error.to_string())?;
            let shard: RealmShard =
                serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
            pending |= shard.realm.status == "missing";
        }
        if !pending || std::time::Instant::now() >= deadline {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn normalize_snapshot(
    scope: &mut v8::HandleScope,
    config: &CoverageRunConfig,
    snapshot: &Value,
) -> Result<(Vec<LocalFile>, Vec<String>), String> {
    let scripts: Vec<RawScript> = serde_json::from_value(
        snapshot
            .get("result")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )
    .map_err(|error| error.to_string())?;
    let sources = snapshot
        .get("sources")
        .and_then(Value::as_object)
        .ok_or_else(|| "coverage snapshot omitted generated sources".to_string())?;
    let state = get_state(scope);
    let state = state.borrow();
    let mut files: BTreeMap<String, LocalFile> = BTreeMap::new();
    let mut warnings = Vec::new();
    for script in scripts {
        let Some(generated_path) = file_url_to_path(&script.url) else {
            continue;
        };
        if !eligible_path(&config.root, &generated_path) {
            continue;
        }
        let extension = generated_path.extension().and_then(|value| value.to_str());
        if matches!(extension, Some("mdx" | "sql")) {
            warnings.push(format!(
                "excluded {} because original-source coverage for .{} transforms is not yet validated",
                generated_path.display(),
                extension.unwrap_or_default()
            ));
            continue;
        }
        let Some(source) = sources.get(&script.script_id).and_then(Value::as_str) else {
            warnings.push(format!("missing generated source for {}", script.url));
            continue;
        };
        let source_map = state.source_maps.get(&script.url);
        if matches!(extension, Some("ts" | "tsx" | "mts" | "jsx")) && source_map.is_none() {
            warnings.push(format!(
                "excluded {} because its transform has no valid source map",
                generated_path.display()
            ));
            continue;
        }
        normalize_script(
            config,
            &generated_path,
            source,
            source_map,
            script.functions,
            &mut files,
            &mut warnings,
        );
    }
    Ok((files.into_values().collect(), warnings))
}

fn normalize_script(
    config: &CoverageRunConfig,
    generated_path: &Path,
    source: &str,
    source_map: Option<&SourceMapCache>,
    functions: Vec<RawFunction>,
    files: &mut BTreeMap<String, LocalFile>,
    warnings: &mut Vec<String>,
) {
    let initial_file_count = files.len();
    let lines = generated_lines(source);
    let mut ranges = functions
        .iter()
        .flat_map(|function| function.ranges.iter())
        .collect::<Vec<_>>();
    ranges.sort_by_key(|range| std::cmp::Reverse(range.end_offset - range.start_offset));
    let mut generated_hits = vec![None; lines.len()];
    for range in ranges {
        for (index, line) in lines.iter().enumerate() {
            if range.start_offset <= line.start && range.end_offset >= line.end {
                generated_hits[index] = Some(range.count);
            }
        }
    }

    for (line, hits) in lines.iter().zip(generated_hits) {
        let Some(hits) = hits else { continue };
        if line.text.trim().is_empty() || line.text.trim_start().starts_with("//") {
            continue;
        }
        let first_column = line
            .text
            .chars()
            .take_while(|character| character.is_whitespace())
            .map(char::len_utf16)
            .sum::<usize>() as u32;
        let Some(position) = map_position(
            config,
            generated_path,
            source_map,
            line.number,
            first_column,
        ) else {
            continue;
        };
        let file = local_file(files, &config.root, &position.path);
        match file
            .lines
            .binary_search_by_key(&position.line, |line| line.line)
        {
            Ok(index) => file.lines[index].hits = file.lines[index].hits.max(hits),
            Err(index) => file.lines.insert(
                index,
                LocalLine {
                    line: position.line,
                    hits,
                },
            ),
        }
    }

    for function in functions {
        let Some(first) = function.ranges.first() else {
            continue;
        };
        if !function.function_name.is_empty()
            && let Some((path, range)) = map_range(
                config,
                generated_path,
                source,
                source_map,
                first.start_offset,
                first.end_offset,
            )
        {
            local_file(files, &config.root, &path)
                .functions
                .push(LocalFunction {
                    name: function.function_name.clone(),
                    range,
                    hits: first.count,
                });
        }
        if function.is_block_coverage {
            for branch in function.ranges {
                if let Some((path, range)) = map_range(
                    config,
                    generated_path,
                    source,
                    source_map,
                    branch.start_offset,
                    branch.end_offset,
                ) {
                    local_file(files, &config.root, &path)
                        .branches
                        .push(LocalBranch {
                            range,
                            hits: branch.count,
                        });
                }
            }
        }
    }

    if source_map.is_some() && files.len() == initial_file_count {
        warnings.push(format!(
            "source map for {} did not produce project source locations",
            generated_path.display()
        ));
    }
}

#[derive(Clone, Debug)]
struct GeneratedLine<'a> {
    number: u32,
    start: u32,
    end: u32,
    text: &'a str,
}

fn generated_lines(source: &str) -> Vec<GeneratedLine<'_>> {
    let mut result = Vec::new();
    let mut byte_start = 0usize;
    let mut utf16_start = 0u32;
    for (index, piece) in source.split_inclusive('\n').enumerate() {
        let without_newline = piece.strip_suffix('\n').unwrap_or(piece);
        let text = without_newline
            .strip_suffix('\r')
            .unwrap_or(without_newline);
        let text_len = text.encode_utf16().count() as u32;
        result.push(GeneratedLine {
            number: index as u32,
            start: utf16_start,
            end: utf16_start + text_len,
            text,
        });
        byte_start += piece.len();
        utf16_start += piece.encode_utf16().count() as u32;
    }
    if byte_start < source.len() || source.is_empty() {
        let text = &source[byte_start..];
        result.push(GeneratedLine {
            number: result.len() as u32,
            start: utf16_start,
            end: utf16_start + text.encode_utf16().count() as u32,
            text,
        });
    }
    result
}

#[derive(Clone, Debug)]
struct MappedPosition {
    path: PathBuf,
    line: u32,
    column: u32,
}

fn map_position(
    config: &CoverageRunConfig,
    generated_path: &Path,
    source_map: Option<&SourceMapCache>,
    line: u32,
    column: u32,
) -> Option<MappedPosition> {
    match source_map {
        Some(source_map) => {
            let (source, line, column) = source_map.lookup(line, column)?;
            let path = resolve_source_path(generated_path, &source)?;
            eligible_path(&config.root, &path).then_some(MappedPosition {
                path,
                line: line + 1,
                column,
            })
        }
        None => eligible_path(&config.root, generated_path).then(|| MappedPosition {
            path: generated_path.to_path_buf(),
            line: line + 1,
            column,
        }),
    }
}

fn map_range(
    config: &CoverageRunConfig,
    generated_path: &Path,
    source: &str,
    source_map: Option<&SourceMapCache>,
    start: u32,
    end: u32,
) -> Option<(PathBuf, SourceRange)> {
    let (start_line, start_column) = offset_to_line_column(source, start);
    let end_offset = end.saturating_sub(1);
    let (end_line, end_column) = offset_to_line_column(source, end_offset);
    let start = map_position(config, generated_path, source_map, start_line, start_column)?;
    let end = map_position(config, generated_path, source_map, end_line, end_column)?;
    if start.path != end.path {
        return None;
    }
    let end_column = if end.line == start.line {
        end.column.saturating_add(1)
    } else {
        end.column
    };
    Some((
        start.path,
        SourceRange {
            start_line: start.line,
            start_column: start.column,
            end_line: end.line,
            end_column,
        },
    ))
}

fn offset_to_line_column(source: &str, target: u32) -> (u32, u32) {
    let mut offset = 0u32;
    let mut line = 0u32;
    let mut column = 0u32;
    for character in source.chars() {
        if offset >= target {
            break;
        }
        let width = character.len_utf16() as u32;
        if offset + width > target {
            break;
        }
        offset += width;
        if character == '\n' {
            line += 1;
            column = 0;
        } else {
            column += width;
        }
    }
    (line, column)
}

fn resolve_source_path(generated_path: &Path, source: &str) -> Option<PathBuf> {
    if source.starts_with("file://") {
        return file_url_to_path(source);
    }
    let source = PathBuf::from(source);
    if source.is_absolute() {
        Some(source)
    } else {
        generated_path.parent().map(|parent| parent.join(source))
    }
}

fn local_file<'a>(
    files: &'a mut BTreeMap<String, LocalFile>,
    root: &Path,
    path: &Path,
) -> &'a mut LocalFile {
    let display = display_path(root, path);
    files.entry(display.clone()).or_insert_with(|| LocalFile {
        path: display,
        source_hash: source_hash(path),
        ..LocalFile::default()
    })
}

fn eligible_path(root: &Path, path: &Path) -> bool {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let display = relative.to_string_lossy();
    if display.starts_with(".fino/") || display.contains("/node_modules/") {
        return false;
    }
    ![
        ".test.ts",
        ".test.tsx",
        ".test.mts",
        ".test.js",
        ".test.mjs",
    ]
    .iter()
    .any(|suffix| display.ends_with(suffix))
}

fn display_path(root: &Path, path: &Path) -> String {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path.strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_entry(root: &Path, entry: &str) -> Option<String> {
    if entry.starts_with("internal:") || entry.starts_with("fino:") {
        return Some(entry.to_string());
    }
    let path = file_url_to_path(entry).unwrap_or_else(|| absolute_path(root, entry));
    Some(display_path(root, &path))
}

fn source_hash(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv64:{hash:016x}")
}

fn file_url_to_path(url: &str) -> Option<PathBuf> {
    let encoded = url.strip_prefix("file://")?;
    let encoded = encoded.strip_prefix("localhost").unwrap_or(encoded);
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = hex(bytes[index + 1])?;
            let low = hex(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok().map(PathBuf::from)
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn shard_path(config: &CoverageRunConfig, realm_id: &str) -> PathBuf {
    config.shard_dir.join(format!("{realm_id}.json"))
}

fn write_shard(config: &CoverageRunConfig, shard: &RealmShard) -> Result<(), String> {
    let path = shard_path(config, &shard.realm.id);
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let bytes = serde_json::to_vec(shard).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("write coverage shard {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("publish coverage shard {}: {error}", path.display()))
}

#[derive(Default)]
struct AggregatedLine {
    hits: u64,
    covered_in: BTreeSet<String>,
}

#[derive(Default)]
struct AggregatedPoint {
    hits: u64,
    covered_in: BTreeSet<String>,
}

#[derive(Default)]
struct AggregatedFile {
    source_hash: String,
    realm_ids: BTreeSet<String>,
    lines: BTreeMap<u32, AggregatedLine>,
    functions: BTreeMap<(String, u32, u32, u32, u32), AggregatedPoint>,
    branches: BTreeMap<(u32, u32, u32, u32), AggregatedPoint>,
}

fn aggregate_shards(config: &CoverageRunConfig) -> Result<CoverageArtifact, String> {
    let mut shards = Vec::new();
    for entry in std::fs::read_dir(&config.shard_dir)
        .map_err(|error| format!("read coverage shards: {error}"))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(entry.path()).map_err(|error| error.to_string())?;
        let shard: RealmShard =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        shards.push(shard);
    }
    shards.sort_by(|a, b| a.realm.id.cmp(&b.realm.id));

    let mut aggregate: BTreeMap<String, AggregatedFile> = BTreeMap::new();
    let mut warnings = Vec::new();
    for shard in &shards {
        warnings.extend(
            shard
                .warnings
                .iter()
                .map(|warning| format!("{}: {warning}", shard.realm.id)),
        );
        for file in &shard.files {
            let target = aggregate.entry(file.path.clone()).or_default();
            if target.source_hash.is_empty() {
                target.source_hash = file.source_hash.clone();
            } else if target.source_hash != file.source_hash {
                warnings.push(format!(
                    "{} was loaded with conflicting source hashes {} and {}",
                    file.path, target.source_hash, file.source_hash
                ));
            }
            target.realm_ids.insert(shard.realm.id.clone());
            for line in &file.lines {
                let aggregate = target.lines.entry(line.line).or_default();
                aggregate.hits = aggregate.hits.saturating_add(line.hits);
                if line.hits > 0 {
                    aggregate.covered_in.insert(shard.realm.id.clone());
                }
            }
            for function in &file.functions {
                let key = (
                    function.name.clone(),
                    function.range.start_line,
                    function.range.start_column,
                    function.range.end_line,
                    function.range.end_column,
                );
                let aggregate = target.functions.entry(key).or_default();
                aggregate.hits = aggregate.hits.saturating_add(function.hits);
                if function.hits > 0 {
                    aggregate.covered_in.insert(shard.realm.id.clone());
                }
            }
            for branch in &file.branches {
                let key = (
                    branch.range.start_line,
                    branch.range.start_column,
                    branch.range.end_line,
                    branch.range.end_column,
                );
                let aggregate = target.branches.entry(key).or_default();
                aggregate.hits = aggregate.hits.saturating_add(branch.hits);
                if branch.hits > 0 {
                    aggregate.covered_in.insert(shard.realm.id.clone());
                }
            }
        }
    }

    let files = aggregate
        .into_iter()
        .map(|(path, file)| {
            let lines = file
                .lines
                .into_iter()
                .map(|(line, value)| CoverageLine {
                    line,
                    hits: value.hits,
                    covered_in: value.covered_in.into_iter().collect(),
                })
                .collect::<Vec<_>>();
            let functions = file
                .functions
                .into_iter()
                .enumerate()
                .map(
                    |(index, ((name, start_line, start_column, end_line, end_column), value))| {
                        CoverageFunction {
                            id: format!("function-{index}"),
                            name,
                            range: SourceRange {
                                start_line,
                                start_column,
                                end_line,
                                end_column,
                            },
                            hits: value.hits,
                            covered_in: value.covered_in.into_iter().collect(),
                        }
                    },
                )
                .collect::<Vec<_>>();
            let branches = file
                .branches
                .into_iter()
                .enumerate()
                .map(
                    |(index, ((start_line, start_column, end_line, end_column), value))| {
                        CoverageBranch {
                            id: format!("branch-{index}"),
                            range: SourceRange {
                                start_line,
                                start_column,
                                end_line,
                                end_column,
                            },
                            hits: value.hits,
                            covered_in: value.covered_in.into_iter().collect(),
                        }
                    },
                )
                .collect::<Vec<_>>();
            let totals = totals_for(&lines, &functions, &branches, None);
            CoverageFile {
                path,
                source_hash: file.source_hash,
                realm_ids: file.realm_ids.into_iter().collect(),
                totals,
                lines,
                functions,
                branches,
            }
        })
        .collect::<Vec<_>>();
    let totals = artifact_totals(&files, None);
    let mut realms = shards
        .iter()
        .map(|shard| {
            let mut realm = shard.realm.clone();
            realm.totals = artifact_totals(&files, Some(&realm.id));
            realm
        })
        .collect::<Vec<_>>();
    realms.sort_by(|a, b| a.id.cmp(&b.id));
    let complete = realms.iter().all(|realm| realm.status == "complete")
        && !warnings
            .iter()
            .any(|warning| warning.contains("conflicting source hashes"));
    Ok(CoverageArtifact {
        schema_version: 1,
        tool: ToolInfo {
            name: "fino".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        },
        run: RunInfo {
            root: config.root.to_string_lossy().into_owned(),
            id: config.run_id.clone(),
            complete,
        },
        totals,
        realms,
        files,
        warnings,
    })
}

fn metric(covered: u64, total: u64) -> Metric {
    Metric {
        covered,
        total,
        percent: if total == 0 {
            0.0
        } else {
            ((covered as f64 / total as f64) * 10_000.0).round() / 100.0
        },
    }
}

fn totals_for(
    lines: &[CoverageLine],
    functions: &[CoverageFunction],
    branches: &[CoverageBranch],
    realm: Option<&str>,
) -> Totals {
    let covered_line = |line: &&CoverageLine| match realm {
        Some(realm) => line.covered_in.iter().any(|id| id == realm),
        None => line.hits > 0,
    };
    let covered_function = |function: &&CoverageFunction| match realm {
        Some(realm) => function.covered_in.iter().any(|id| id == realm),
        None => function.hits > 0,
    };
    let covered_branch = |branch: &&CoverageBranch| match realm {
        Some(realm) => branch.covered_in.iter().any(|id| id == realm),
        None => branch.hits > 0,
    };
    Totals {
        lines: metric(
            lines.iter().filter(covered_line).count() as u64,
            lines.len() as u64,
        ),
        functions: metric(
            functions.iter().filter(covered_function).count() as u64,
            functions.len() as u64,
        ),
        branches: metric(
            branches.iter().filter(covered_branch).count() as u64,
            branches.len() as u64,
        ),
    }
}

fn artifact_totals(files: &[CoverageFile], realm: Option<&str>) -> Totals {
    let line_total = files.iter().map(|file| file.lines.len() as u64).sum();
    let function_total = files.iter().map(|file| file.functions.len() as u64).sum();
    let branch_total = files.iter().map(|file| file.branches.len() as u64).sum();
    let line_covered = files
        .iter()
        .flat_map(|file| &file.lines)
        .filter(|line| match realm {
            Some(realm) => line.covered_in.iter().any(|id| id == realm),
            None => line.hits > 0,
        })
        .count() as u64;
    let function_covered = files
        .iter()
        .flat_map(|file| &file.functions)
        .filter(|function| match realm {
            Some(realm) => function.covered_in.iter().any(|id| id == realm),
            None => function.hits > 0,
        })
        .count() as u64;
    let branch_covered = files
        .iter()
        .flat_map(|file| &file.branches)
        .filter(|branch| match realm {
            Some(realm) => branch.covered_in.iter().any(|id| id == realm),
            None => branch.hits > 0,
        })
        .count() as u64;
    Totals {
        lines: metric(line_covered, line_total),
        functions: metric(function_covered, function_total),
        branches: metric(branch_covered, branch_total),
    }
}

fn write_artifact(path: &Path, artifact: &CoverageArtifact) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid coverage path {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
    let mut bytes = serde_json::to_vec_pretty(artifact).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    std::fs::write(&temporary, bytes)
        .map_err(|error| format!("write coverage artifact {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path)
        .map_err(|error| format!("publish coverage artifact {}: {error}", path.display()))
}

// ---------------------------------------------------------------------------
// internal:coverage/bindings synthetic module
// ---------------------------------------------------------------------------

pub fn create_module<'s>(scope: &mut v8::HandleScope<'s>) -> v8::Local<'s, v8::Module> {
    let export_names = [
        "startCoverageRun",
        "submitRealmCoverage",
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
    set_fn!("submitRealmCoverage", submit_realm_coverage_cb);
    set_fn!("finishCoverageRun", finish_coverage_run_cb);
    set_fn!("coverageActive", coverage_active_cb);
    Some(v8::undefined(scope).into())
}

fn start_coverage_run_cb(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
        .unwrap_or_default();
    match start_run(scope, &path) {
        Ok(id) => {
            if let Some(value) = v8::String::new(scope, &id) {
                rv.set(value.into());
            }
        }
        Err(error) => throw_error(scope, &error),
    }
}

fn submit_realm_coverage_cb(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let Some(snapshot) = args
        .get(0)
        .to_string(scope)
        .map(|value| value.to_rust_string_lossy(scope))
    else {
        throw_error(scope, "coverage snapshot must be JSON text");
        return;
    };
    let snapshot: Value = match serde_json::from_str(&snapshot) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            throw_error(scope, &format!("invalid coverage snapshot: {error}"));
            return;
        }
    };
    if let Err(error) = submit_realm_snapshot(scope, &snapshot) {
        throw_error(scope, &error);
    }
}

fn finish_coverage_run_cb(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    match finish_run(scope) {
        Ok(Some(summary)) => match serde_json::to_string(&summary) {
            Ok(summary) => {
                if let Some(value) = v8::String::new(scope, &summary) {
                    rv.set(value.into());
                }
            }
            Err(error) => throw_error(scope, &error.to_string()),
        },
        Ok(None) => rv.set(v8::null(scope).into()),
        Err(error) => throw_error(scope, &error),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_count_astral_characters_as_two_units() {
        let source = "const fire = '🔥';\nreturn fire;";
        let offset = "const fire = '🔥';\n".encode_utf16().count() as u32;
        assert_eq!(offset_to_line_column(source, offset), (1, 0));
    }

    #[test]
    fn generated_line_ranges_exclude_line_terminators() {
        let lines = generated_lines("a🔥\r\nb\n");
        assert_eq!((lines[0].start, lines[0].end, lines[0].text), (0, 3, "a🔥"));
        assert_eq!((lines[1].start, lines[1].end, lines[1].text), (5, 6, "b"));
    }

    #[test]
    fn file_urls_decode_percent_escapes() {
        assert_eq!(
            file_url_to_path("file:///tmp/coverage%20fixture.ts"),
            Some(PathBuf::from("/tmp/coverage fixture.ts"))
        );
    }

    #[test]
    fn percentages_are_stable_to_two_decimal_places() {
        assert_eq!(metric(2, 3).percent, 66.67);
        assert_eq!(metric(0, 0).percent, 0.0);
    }
}
