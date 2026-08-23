# Native code coverage

Status: implemented (initial release)

## Summary

Fino should collect JavaScript and TypeScript coverage directly from V8 while
running tests. A bare `--coverage` option on `fino test` enables collection and
writes a single canonical artifact to `coverage/coverage.json`. A custom path
can be supplied as `--coverage=<path>`.

The artifact aggregates every participating Realm while preserving enough
Realm attribution to answer both questions:

- Was this source location covered anywhere in the test run?
- Which Realm or Realms covered it?

After the normal TAP output, `fino test` prints a small, grouped TAP comment
block. A separate `fino coverage` command reads the artifact and exposes narrow
subcommands for summaries, files, source lines, functions, branches, Realms,
threshold checks, and LCOV export. Its default text format is deterministic,
compact, and designed to be useful to both humans and language models.

V8's precise-coverage API is the source of execution data. Source maps are not
quite automatic at the coverage-protocol boundary: V8 reports coverage as
UTF-16 offsets in generated JavaScript, while `Debugger.scriptParsed` exposes
the script's `sourceMapURL`. Fino must join those records and map generated
ranges back to original sources. The existing loader already supplies inline
source maps to V8 and caches parsed maps, so this is mostly integration rather
than a second transpilation pipeline.

## Goals

- Add native, low-friction coverage collection to `fino test`.
- Produce one JSON artifact for the complete test run, including child Realms.
- Preserve Realm attribution without counting the same source location more
  than once in aggregate totals.
- Report coverage against original TypeScript/JSX source locations whenever a
  valid source map is available.
- Provide focused exploration commands rather than one verbose report with a
  large collection of display flags.
- Provide stable output and threshold checks suitable for gating
  machine-generated code and tests.
- Keep LCOV as an interoperable derived format rather than the canonical data
  model.
- Write a useful artifact even when tests fail, provided the runtime can still
  complete coverage finalization.

## Non-goals for the first release

- Browser coverage or merging artifacts produced by other runtimes.
- Native Rust coverage.
- Watch-mode accumulation across multiple test runs.
- Discovering and instrumenting files which were never loaded. Initial totals
  describe loaded application code only.
- Perfect original-source coverage for transforms which do not yet emit a
  faithful source map.
- A hosted HTML report. LCOV export allows existing tools to provide one.

## User-facing interface

### Collecting coverage

```console
fino test --coverage tests/
fino test --coverage=artifacts/unit-coverage.json tests/
```

The default output path is `coverage/coverage.json`, resolved from the current
working directory. Parent directories are created when needed. The completed
artifact is written to a sibling temporary file and renamed into place so a
reader never observes a partially written report.

The custom-path spelling deliberately requires `=`. Treating the next token as
an optional option value would make this command ambiguous:

```console
fino test --coverage tests/example.test.ts
```

Here `tests/example.test.ts` must remain a test input, not become the report
path. The shared argument parser therefore needs a general "optional inline
value with an implicit value" option shape. Conceptually, `--coverage` has the
implicit value `coverage/coverage.json`, while `--coverage=<path>` has the
explicit value. `--coverage <path>` should not be accepted.

This parser extension is a public `fino:process/argv` API change and will need
the corresponding API documentation and parser tests during implementation.

### TAP output

Coverage follows the test runner's existing TAP output as one grouped comment
block:

```text
# coverage
#   lines      87.50% (70/80)
#   branches   75.00% (6/8)
#   functions  90.00% (9/10)
#   realms     4 complete, 0 incomplete
#   report     coverage/coverage.json
```

Only the header is named `coverage`; individual lines do not repeat that word.
The block is emitted after coverage has been finalized and the artifact has
been written. It remains valid TAP diagnostic output.

If coverage finalization is incomplete, the block says so and points at the
artifact, whose `warnings` and Realm statuses contain the details. A coverage
error must not replace an earlier test error, although it can make an otherwise
successful coverage run fail when no valid artifact can be produced.

When the test command uses its JSON writer, it does not mix TAP comments into
standard output. The command result includes the coverage path, and the
artifact is finalized after command execution; consumers read the artifact for
the summary, completion status, and warnings.

### Exploring an artifact

`fino coverage` reads `coverage/coverage.json` by default. The common `--input`
option selects another artifact:

```console
fino coverage
fino coverage summary --input artifacts/unit-coverage.json
```

Running the command without a subcommand is an alias for `summary`. The
proposed subcommands are:

```text
fino coverage summary
fino coverage files
fino coverage lines <file>
fino coverage functions [file]
fino coverage branches [file]
fino coverage realms
fino coverage realm <realm-id>
fino coverage check [threshold options]
fino coverage export lcov [--output coverage/lcov.info]
```

Every subcommand reads the common `--input` path. The responsibilities are:

- `summary`: aggregate totals, Realm completeness, and warnings.
- `files`: one compact record per file, sorted by normalized path.
- `lines`: covered and uncovered original line ranges for one file, with a
  concise source excerpt around uncovered lines.
- `functions`: function names, original ranges, and coverage state; optionally
  restricted to one file.
- `branches`: V8 block-derived branch sites and uncovered arms; optionally
  restricted to one file.
- `realms`: Realm identities, relationships, status, entry point, and totals.
- `realm`: summary and contributing files for one Realm.
- `check`: apply aggregate and optionally per-file thresholds, print every
  failed condition, and exit non-zero if any condition fails.
- `export lcov`: derive an LCOV trace file. LCOV is not written by the test
  command unless this export is requested.

Threshold options naturally belong to `check`, and export-format options belong
to `export`. The normal inspection commands should stay narrow instead of
accumulating unrelated mode flags. If repeated threshold configurations become
common, a small checked-in policy file can be added later without changing the
artifact format.

## Output intended for humans and language models

Default command output should use stable labels rather than decorative tables,
terminal color, or prose which changes between runs. For example:

```text
file src/example.ts
lines 18/21 85.71%
uncovered-lines 14,19-20
functions 3/4 75.00%
uncovered-function parseConfig 18:0-22:1
branches 5/6 83.33%
uncovered-branch 19:2-20:15
covered-in realm-0,realm-3
```

Paths are normalized relative to the run root, records are sorted, percentages
use two decimal places, and line/range lists use a canonical compact notation.
Empty categories say `none`. Diagnostics go to stderr, data goes to stdout, and
threshold failure uses a documented non-zero exit status.

This gives an LLM small, explicit answers to focused questions while the JSON
artifact remains available when exact structured data is more appropriate.

## Collection architecture

### V8 interface

Use the public Chrome DevTools Protocol exposed by the existing V8 Inspector
integration, not the private `v8::debug::Coverage` C++ API. Each participating
Isolate uses the existing per-Realm inspector session to send:

1. `Debugger.enable`, to observe script metadata and retrieve generated source.
2. `Profiler.enable`.
3. `Profiler.startPreciseCoverage` with `detailed: true`, `callCount: true`, and
   triggered updates disabled.
4. `Profiler.takePreciseCoverage` during Realm finalization.
5. `Profiler.stopPreciseCoverage` and `Profiler.disable`.

`detailed: true` requests block-level rather than function-only ranges.
`callCount: true` retains useful hit counts in the artifact even though the
primary coverage decision is whether a coverpoint ran at least once.

The coverage protocol payload contains generated script URLs, functions, and
end-exclusive character-offset ranges. The collector also retains
`Debugger.scriptParsed` metadata keyed by script id and obtains the generated
source text using `Debugger.getScriptSource`. Coverage traffic uses the
inspector state's monotonic message ids and removes its own responses from the
shared response buffer. Fino does not create a second inspector for the same
Isolate. Coverage is currently a test-only mode, so simultaneous interactive
REPL coverage is outside this release's scope.

### When collection starts and stops

The test command enables the run before it imports any test modules. Existing
CLI bootstrap modules have already executed by then, but they are runtime code
and excluded from application totals. Any Realm created while the run is active
inherits the coverage-run configuration and starts its Isolate-local collector
after its V8 context is registered but before its bootstrap or user entry module
is evaluated.

Finalization cannot live solely at the end of `js/commands/test.ts`. The
scheduler bootstrap currently runs shutdown hooks after the selected command
returns, and those hooks may execute or terminate child Realms. The process-wide
coverage coordinator should therefore finalize between `runShutdownHooks()` and
the scheduler bootstrap's final error rethrow. This ordering captures shutdown
work, lets child Realms submit their final shards, and still preserves the
original command error.

Each Isolate submits one raw shard before it is disposed. The coordinator waits
for every Realm registered in the coverage run to either submit or reach a
known terminal state. A force-terminated or crashed Realm is marked incomplete;
the coordinator must not wait forever for a shard which cannot arrive.

### Process-wide coordinator

Coverage is enabled in a test workload Isolate, but participating Realms can
run on reactor workers, dedicated threads, or child processes. A run-scoped
coordinator owns:

- the resolved artifact path and run root;
- the next Realm id and Realm descriptor registry;
- expected, received, and incomplete Realm shards;
- canonicalization, source-map remapping, aggregation, and artifact writing;
- the final summary returned to the scheduler bootstrap.

In-process Realms can submit through a shared Rust coordinator or channel.
Process Realms cannot share memory, so their coverage configuration and assigned
Realm id must be included in the child launch configuration. On clean exit they
send a serialized shard through the existing parent bridge or a dedicated
framed control message. The parent process owns the only final artifact writer.
A run-specific temporary shard directory is an acceptable fallback if extending
the control protocol proves substantially more complex, but individual Realms
must never race to overwrite the final JSON path.

### Realm identity

Existing scheduler workload owner ids are not sufficient as coverage Realm
identity: they describe reactor ownership, do not cover every Realm kind, and
are not intended as an artifact contract. Add an explicit, run-scoped Realm id
to `FinoState`, scheduled-workload setup, `ChildConfig`, and process/thread
launch configuration.

Each participating process assigns ids of the form
`realm-<process-id>-<counter>`. They are unique within one artifact but are not
promised to remain the same across runs. Each descriptor contains:

```json
{
  "id": "realm-1",
  "parentId": "realm-0",
  "kind": "thread",
  "entry": "src/workers/parser.ts",
  "status": "complete"
}
```

The initial test workload is a Realm. Spawned scheduled, thread, process, and
sandbox Realms receive their own descriptors and parent relationship. Internal
orchestration contexts which never execute test/application code need not
contribute a shard.

The initial schema uses `complete` and `missing`. Only `complete` means final
counters were received. A placeholder left by an abruptly exited Realm remains
`missing`, with an associated warning. More specific terminal states can be
added in a later schema revision.

## Source-map integration

### What V8 provides

V8 does understand the source-map URL attached through `ScriptOrigin`, and the
Debugger protocol reports it in `Debugger.scriptParsed`. However,
`Profiler.takePreciseCoverage` still reports generated-JavaScript offsets. It
does not return original TypeScript ranges or aggregate original lines for the
runtime. Fino must perform that last mapping step, as tools such as c8 do.

Fino is well positioned for this because the loader already:

- supplies a data-URL source map when compiling transformed modules;
- stores parsed `oxc_sourcemap::SourceMap` values by resource name; and
- uses those maps for original-source stack locations.

The coverage collector uses the loader's parsed map as the authoritative
in-memory source. Every filesystem module supported by the normal loader passes
through this cache, avoiding a second parse of inline maps. A future release
can add a `sourceMapURL` fallback for scripts compiled outside the loader.

### Mapping algorithm

For each covered script:

1. Retrieve its generated source text and build an index from V8 UTF-16 offsets
   to generated line and UTF-16 column.
2. Derive executable generated lines from the smallest enclosing detailed V8
   range, excluding blank and comment-only lines.
3. Map each line's first executable column and each function/block range's
   endpoints to original source positions according to ECMA-426 source-map
   semantics.
4. Drop segments with no original source mapping from application totals, but
   retain a warning/count so gaps are observable.
5. Normalize and merge adjacent original segments only when source, coverage
   count, logical coverpoint, and contributing Realm set agree.
6. Derive original line, function, and block/branch records from the normalized
   segments.

JavaScript strings and source-map columns are counted in UTF-16 code units, not
UTF-8 bytes or Unicode scalar values. Tests must include astral characters
before covered and uncovered ranges to prove columns are not shifted.

Ranges from generated helpers can overlap original mappings. Aggregation uses
coverage union semantics: an original coverpoint is covered if any mapped range
for it has a positive count. Totals must not double-count overlapping ranges or
the same module loaded in several Realms.

A line is in the denominator only when at least one executable mapped range is
attributed to it; blank, comment-only, type-only, and otherwise non-executable
lines are not uncovered lines. A function comes from a V8 function range mapped
to its original declaration. A branch is derived from nested/disjoint detailed
coverage ranges in the same manner as V8-to-Istanbul tooling; it is not a claim
that V8 exposes a source-language AST branch id. These metric definitions must
be recorded in the schema version so later improvements do not silently change
threshold results.

### Transform support

- Plain JavaScript without a map reports directly against its generated/original
  file.
- TypeScript, TSX, JSX, and MTS should be supported initially using the maps
  already emitted by the TypeScript formatter.
- A Realm `source` import directive can participate when it supplies a valid
  map and stable original source name.
- Current MDX mapping needs validation: a map which merely renames an
  intermediate TSX source is not sufficient to claim accurate MDX line
  coverage.
- Generated SQL wrapper code likewise should not be presented as faithful SQL
  statement coverage without a purpose-built map.

Until MDX and SQL maps pass range-level conformance fixtures, those formats are
included only as generated sources or excluded from original-source totals with
an explicit warning. The report must never silently attribute generated helper
execution to an inaccurate original line.

## Canonical JSON artifact

JSON is the source of truth because LCOV cannot preserve Realm relationships,
incomplete-Realm state, warnings, source hashes, or detailed generated-to-
original provenance.

The initial schema is versioned and resembles:

```json
{
  "schemaVersion": 1,
  "tool": { "name": "fino", "version": "0.0.0" },
  "run": {
    "root": "/workspace/project",
    "id": "12345-1787460000000000000",
    "complete": true
  },
  "totals": {
    "lines": { "covered": 18, "total": 21, "percent": 85.71 },
    "functions": { "covered": 3, "total": 4, "percent": 75.0 },
    "branches": { "covered": 5, "total": 6, "percent": 83.33 }
  },
  "realms": [
    {
      "id": "realm-0",
      "parentId": null,
      "kind": "test",
      "entry": "tests/example.test.ts",
      "status": "complete",
      "totals": {
        "lines": { "covered": 12, "total": 21, "percent": 57.14 },
        "functions": { "covered": 2, "total": 4, "percent": 50.0 },
        "branches": { "covered": 3, "total": 6, "percent": 50.0 }
      }
    }
  ],
  "files": [
    {
      "path": "src/example.ts",
      "sourceHash": "fnv64:...",
      "realmIds": ["realm-0", "realm-3"],
      "totals": {
        "lines": { "covered": 18, "total": 21, "percent": 85.71 },
        "functions": { "covered": 3, "total": 4, "percent": 75.0 },
        "branches": { "covered": 5, "total": 6, "percent": 83.33 }
      },
      "lines": [
        { "line": 1, "hits": 2, "coveredIn": ["realm-0", "realm-3"] },
        { "line": 2, "hits": 0, "coveredIn": [] }
      ],
      "functions": [],
      "branches": []
    }
  ],
  "warnings": []
}
```

Function and branch records have a stable id within their file, an original
end-exclusive range, aggregate hits, and sorted `coveredIn` Realm ids. Branches
represent V8 detailed block ranges; they do not claim source-AST branch or arm
identity. Consumers gate on original records rather than generated offsets.

Aggregate totals use union semantics. A line covered in three Realms is one
covered line, not three lines. Per-Realm totals recompute the same denominator
and consider only hits attributed to that Realm, making the contribution of an
isolated worker inspectable.

Files are keyed by normalized path plus a content hash during aggregation. If
two Realms load different contents at the same path, the aggregator must not
silently merge them. The first version should mark the run incomplete and
report the conflicting hashes; a future schema can model multiple file
versions if watch/reload coverage requires it.

Arrays and Realm ids are sorted before serialization. Volatile fields such as
timestamps are kept out of comparisons used by golden tests. Percentages are
derived convenience values; covered and total counts remain authoritative.

### File selection and exclusions

The raw collector sees Fino builtins, test harness code, generated wrappers,
dependencies, and application modules. The initial schema filters these before
aggregation; a later schema may preserve exclusion reasons for auditability.

Initial aggregate totals include loaded filesystem-backed project code and
exclude:

- `fino:` and `internal:` runtime modules;
- files following the supported `.test.*` naming conventions;
- external dependency roots; and
- unmapped generated wrapper code.

Test helpers are included when loaded, because they are not reliably
identifiable from filenames alone. Explicit include/exclude configuration can
be designed separately if projects need a narrower policy.

## LCOV export

`fino coverage export lcov` converts normalized original-source records into
LCOV `SF`, `DA`, `FN`, `FNDA`, and `BRDA` records. It uses aggregate union hit
counts by default. Realm attribution and incomplete-state diagnostics remain
available only in JSON.

Export should fail with a clear diagnostic when the artifact schema is newer
than the exporter understands. Warnings about partially mapped files are
printed, and the LCOV output includes only representable original records.

## Failure and lifecycle behavior

- A normal failing test run still finalizes coverage, writes the artifact, and
  preserves the test failure exit status.
- An abrupt process exit may leave only the previous complete artifact because
  atomic replacement cannot occur. A stale artifact must not be presented as
  the current run; optional run-id metadata in the temporary shard area can aid
  diagnostics.
- A terminated child Realm produces an incomplete descriptor and warning. Its
  last complete shard, if any, may be included but is labeled partial.
- Invalid source maps do not abort all collection. The file is reported as
  generated/unmapped and the warning names the script.
- Failure to write the requested path fails an otherwise passing invocation.
  It does not mask a pre-existing test exception in diagnostic output.
- Empty coverage is valid only when no eligible project module was loaded; the
  summary clearly says `0/0` rather than treating it as 100%.

## Performance considerations

Precise coverage disables some V8 optimizations while active, so `--coverage`
will make tests slower and should remain opt-in. Collection work should stay
off the ordinary test hot path:

- do not initialize an inspector coverage session without `--coverage`;
- normalize each Realm while its loader source-map cache is still alive, then
  aggregate compact original-source shards in the parent;
- fetch generated source only for scripts which survive basic URL filtering;
- parse each distinct source map and source text once per content hash; and
- stream or bound child-process shards rather than retaining duplicate protocol
  JSON indefinitely.

The implementation spike should measure startup, wall-clock, and peak-memory
overhead on the full suite and on Realm-heavy tests. No hard performance budget
is proposed until those baseline measurements exist.

## Implementation outline

### 1. Prove the V8 data path

- Add an isolated prototype around the existing Inspector implementation.
- Start precise coverage, execute plain JavaScript and TypeScript, take a
  snapshot, and verify range/count semantics against known source.
- Capture `scriptParsed`, retrieve generated source, and confirm UTF-16 offset
  behavior with non-BMP characters.
- Confirm a private coverage session can coexist with the REPL inspector
  session.

This spike should be kept small enough to discard if V8 139 exposes an
unexpected protocol limitation.

### 2. Add run and Realm plumbing

- Add the optional-inline-value option shape to `fino:process/argv` and define
  `fino test --coverage[=<path>]`.
- Add a native coverage coordinator, run id, explicit Realm ids, parent ids,
  and status tracking.
- Propagate coverage configuration through scheduled, thread, process, and
  sandbox Realm creation.
- Start collectors before child bootstrap evaluation and submit shards before
  Isolate disposal.
- Finalize after scheduler shutdown hooks while preserving the original test
  result.

### 3. Normalize source and aggregate

- Implement UTF-16 offset indexing, end-exclusive range splitting, source-map
  segment mapping, overlap unioning, content hashing, and deterministic sorting.
- Derive line, function, and V8 block-based branch records.
- Apply and serialize the initial file-selection policy.
- Write the versioned JSON artifact atomically and print the grouped TAP block.

### 4. Add focused inspection and gating

- Register the root `coverage` command and its `summary`, `files`, `lines`,
  `functions`, `branches`, `realms`, `realm`, and `check` subcommands.
- Make `--input` default to `coverage/coverage.json`.
- Stabilize the compact text grammar with golden tests.
- Define aggregate/per-file threshold options and exit behavior for `check`.

### 5. Add interoperability and harden transforms

- Add `coverage export lcov` and round-trip fixtures against a standard LCOV
  consumer.
- Add range-level conformance fixtures for every supported transform.
- Either make MDX and SQL source maps faithful enough for coverage or retain
  their explicit unsupported/unmapped status.
- Benchmark overhead and document known limitations.

## Verification plan and remaining coverage

The initial implementation includes parser, TypeScript original-line,
scheduled/process Realm, CLI exploration/gating, LCOV, UTF-16, and atomic-path
coverage. The broader regression matrix remains:

- Argument parser: bare implicit value, `--coverage=<path>`, positional test
  preservation, help text, and invalid empty path.
- Inspector: function and block ranges, counts, script ids, generated source,
  and session coexistence.
- Source maps: plain JS, TS, TSX/JSX, multiple source files, unmapped segments,
  inline data URLs, malformed maps, UTF-16 columns, and end-exclusive ranges.
- Aggregation: duplicate modules across Realms, union totals, Realm-specific
  totals, conflicting hashes, deterministic ordering, and incomplete shards.
- Realm integration: scheduled, thread, process, sandbox, nested parent ids,
  clean shutdown, forced termination, and crash reporting.
- CLI: default/custom artifact paths, test failure with artifact, grouped TAP
  comments, JSON writer behavior, each inspection subcommand, missing/newer
  artifacts, and threshold exit codes.
- LCOV: line, function, and branch records generated from a known JSON fixture.

The coverage implementation itself should have a small end-to-end fixture with
known uncovered lines, functions, and branches. That fixture guards against a
collector which produces plausible totals while mapping the wrong original
locations.

## Implemented decisions

The implemented defaults in this document are:

1. Custom collection paths use `--coverage=<path>`; a following token is always
   a test input.
2. JSON is canonical and LCOV is explicitly exported.
3. `fino coverage` defaults to `summary` and uses aspect-oriented subcommands.
4. Aggregates use union coverage, with Realm attribution on every coverpoint.
5. Precise coverage records call counts as well as covered/uncovered state.
6. Loaded application code is the initial denominator; unloaded project files
   are outside the first release.
7. Inaccurately mapped transforms are warned about and excluded rather than
   reported against misleading original lines.

Test entry modules are excluded by supported `.test.*` suffix. Loaded helper
modules remain in the denominator; explicit include/exclude policy is deferred.

## References

- [Chrome DevTools Protocol: Profiler](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/)
- [Chrome DevTools Protocol: Debugger.scriptParsed](https://chromedevtools.github.io/devtools-protocol/tot/Debugger/#event-scriptParsed)
- [ECMA-426 source map format](https://tc39.es/ecma426/)
- [c8](https://github.com/bcoe/c8)
- [Current Fino inspector integration](../src/inspector_module.rs)
- [Current Fino source-map registration](../src/loader.rs)
- [Current test command](../js/commands/test.ts)
- [Current scheduler CLI bootstrap](../js/internal/scheduler/bootstrap.ts)
