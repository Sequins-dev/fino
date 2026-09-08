---
weight: 33
---
# test

`fino test` runs tests written for Fino's built-in test framework. Use it for
runtime integration tests, module-level regression tests, and API behavior that
needs to execute inside Fino instead of Node or another JavaScript host:

```sh
fino test tests/app.test.ts
fino test tests/net
fino test 'tests/**/*.test.ts'
fino test --parallel tests
fino test --coverage tests/app.test.ts
```

Quote glob arguments so Fino performs recursive expansion itself. In shells
where `globstar` is disabled, an unquoted `tests/**.test.ts` is expanded before
Fino starts and may select only files exactly one directory below `tests/`.

Direct file inputs are imported as given. Directory inputs expand to descendant
`.test.ts` files. Glob inputs are resolved from the current working directory.
If expansion includes `.test.ts` files, non-test helper modules are ignored, so
`fino test tests/net` imports test files without also importing helpers that sit
beside them. Results are emitted as TAP-13, which is readable in a terminal and
can be consumed by TAP tooling.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `files...` | strings | Required. Test files, directories, or glob patterns to import and run. |
| `--filter` | string | Run only registered tests whose full path contains the filter text. |
| `--timeout` | number | Per-test deadline in milliseconds. Defaults to `60000`; `0` waits forever. |
| `--show-output` | `failures`, `always`, or `never` | Control captured console output. Defaults to `failures`. |
| `--durations` | boolean | Add TAP duration metadata to result lines. |
| `--parallel` | boolean | Run each test file in an isolated Realm, with bounded top-level group concurrency. |
| `--ordered` | boolean | Emit parallel groups in deterministic registration order instead of completion order. |
| `--coverage[=<path>]` | path | Collect native V8 coverage. A bare flag writes `coverage/coverage.json`; a custom path must use `=`. |

Console output is captured by default and printed for failures. Use
`--show-output=always` for live debugging output or `--show-output=never` to
suppress captured output in failure details.

## Deadlines

Every test body runs under a deadline. A test that exceeds it fails with a
`TestTimeoutError` naming the limit, so a hang is reported as one failing test
rather than a run that never finishes. The default is 60 seconds; `--timeout`
changes it for the whole run and `--timeout 0` disables it.

A test that is legitimately slower than the run-wide limit can raise its own
without loosening the default for everything else:

```ts no_run
it('replays the full cassette', { timeout: 300_000 }, async (t) => {
  // ...
});
```

Under `--parallel` the coordinator derives its own deadlines from this value.
Each test or lifecycle-hook transition renews the worker deadline. It uses the
current test’s timeout (including an override or `0`) plus 30 seconds of slack;
a group of healthy tests can therefore run longer than one test’s limit. Hooks
use the run default. Console output and unrelated timers do not renew it. A
worker that stops reporting progress, or fails to exit within the stall threshold,
is reported as a named lifecycle failure.

## Parallel files

`--parallel` runs every matched test file in its own Realm. The command defaults
to ten executing top-level test groups per configured reactor thread. Set
`FINO_TEST_CONCURRENCY` to a positive integer to change that per-reactor amount,
or `FINO_REACTOR_THREADS` to control the underlying reactor pool. The reactor
pool defaults to one fewer than the host's online processor count, reserving a
processor for main-thread coordination while retaining at least two reactors on
multi-processor hosts. At most one group executes in a given file Realm so its
shared module state retains serial semantics.

Files enter a rolling live-Realm window in discovery order. Each module's top
level registers its groups, then their closures wait for group admission. When
all groups in a file settle and its Realm exits, the next file enters the
window. This bounds retained Realm state by the concurrency setting rather than
the total file count. Groups from different file Realms overlap; groups from
the same file remain sequential. Results are returned to the parent as
structured data, then merged into the ordinary top-level TAP stream in
completion order by default. Each completed group emits as one atomic block, so
output stays responsive without interleaving. Pass `--ordered` to hold completed
groups until every earlier registered group has settled and emit in
deterministic registration order. The aggregate `1..N` plan is emitted at the
end after every rolling registration is known, as permitted by TAP 13. File
names are not added as wrapper subtests. Failure details are held until the
final aggregate summary. In parallel mode, `--show-output=always` includes a
group's console output as TAP comments when its result is emitted; it is not
live. Raw stdout and stderr from test Realms and their child processes are
captured at the process boundary and suppressed so they cannot corrupt the TAP
stream.

A top-level group that measures process-global state or strict latency can pass
`{ exclusive: true }` to `test`, `suite`, `describe`, or a nested `it`. The
containing root group waits for all admitted work, reserves the channel's full
capacity while it runs, and releases ordinary parallel admission immediately
when it settles.

Use `--filter` when a suite is large but the registered test path has a stable
name:

```sh
fino test --filter websocket tests/net
```

The command throws when no files are supplied or expansion finds no test files.
It is not a Node `node:test` compatibility command.

## Coverage

Coverage is collected from V8 in every participating Realm and remapped to
original TypeScript locations with the source maps already produced by Fino's
loader. The TAP stream ends with one grouped `# coverage` comment block. The
canonical JSON artifact preserves aggregate totals and the Realm ids which
covered each line, function, and branch.

Use [`fino coverage`](./coverage.md) to inspect that artifact, apply thresholds,
or export LCOV.

### Inspect readiness delivery

Run `FINO_TRACE_READINESS=1 fino test --parallel tests` to retain the most recent
65,536 readiness transitions across scheduled Realms. A failed parallel suite or
coordinator deadline prints a `# readiness trace:` JSON recording and a reduced
`# readiness analysis:` report. The first failed group snapshots immediately
when its result is received for output, so later groups cannot overwrite that
recording. Save the output to a file; from a source checkout,
`fino run scripts/analyze-readiness.ts test.log` analyzes the last recording again.

Each registration has a process-local operation ID and destination Realm owner.
The recording distinguishes controller receipt, controller installation, routing,
owner signalling, mailbox draining, resolver invocation, cancellation, replacement,
and late completion discards. `controller-installed` means the controller created
its local watch; it is not a kernel installation receipt. `resolved` records the
resolver invocation, before the subsequent Promise continuation runs. A generation
mismatch records an old completion meeting a newer registration with the same token.

The ledger retains metadata only and does not hold resources alive. Collection is
disabled unless the environment variable is set before startup. Enabled tracing
adds synchronization and allocation and can affect timing. Its `dropped` count and
analysis `incompleteHistory` flag identify overwritten history; absence from a
truncated recording does not prove that an operation never existed. Pending entries
are observed waits, including healthy persistent watches, and do not by themselves
prove a hang.

The `nativeWork` section retains active asynchronous FFI calls and cross-thread
callbacks separately from the rolling readiness history. It distinguishes queued
native work, executing native calls, queued completions, callback invocation, and
callbacks awaiting JavaScript promises. Each entry includes its originating owner
and timestamps. At most 65,536 active entries and 512 completed entries are retained;
its separate `dropped` count reports new operations omitted at capacity. Resolver
consumption does not establish that the following Promise continuation ran.

Native producers signal scheduled Realm owners directly through the reactor
scheduler. Independently pumped isolates use pipe notifications. Compare the
`nativeWork` stages with the owner's scheduler state to distinguish queued native
work from a resolver that has already consumed its result.

Pipe wake registrations also record readiness and owner signalling.
The `wakeSources` section counts repeated notifications and retains their last
timestamps separately, so a pipe that remains readable cannot erase the bounded
operation history. `wakeSourcesDropped` reports observations omitted after the
65,536-source limit; source counters can remain after their Realm exits.
At a test deadline, a `readiness timeout trace:` snapshot is captured before the
runner advances to another leaf; it appears with the failing test's captured
output. These tools do not trace every Promise continuation or RPC message. The
broader application diagnostics API is still a design proposal.

To inspect a process that hangs without reporting a test failure, also set
`FINO_TRACE_DIRECTORY=/absolute/path/to/recordings`. An independent native reader
atomically replaces `readiness-PID.json` every two seconds. It does not enter or
signal any Realm, so it can record a stalled main thread or reactor. The same
analysis command accepts these JSON files. Child processes inherit the setting
and write separate files. Files remain after exit; the last periodic snapshot
can predate final cleanup.

From a source checkout, `python3 scripts/capture-runtime-stall.py /absolute/path/to/recordings`
preserves snapshots and process counters for tests that remain active. Add
`--native-stacks` on Linux to attach GDB. Stack capture pauses the target and can
cause a test deadline to expire; artifacts include `debuggerWallSeconds` so that
cost is visible. CI workflow dispatch exposes this separately as `native_stacks`;
`readiness_trace` alone records without attaching a debugger.

These snapshots include parent owners, entry paths, scheduler phases, the pool's
resident and parked owners, and the last loop handle counts reported by each
Realm. Test workers also report their file and lifecycle stage. Observations are
last-known state, not a simultaneous inspection of live isolates. A busy pool
mutex is reported as unavailable rather than blocking the recorder. Recordings
contain local paths and consume disk space; remove the directory after analysis.
