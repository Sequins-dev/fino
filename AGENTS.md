# Repository Guidelines

This is the single source of repository guidance for coding agents and human
contributors. Keep tool-specific instruction files as imports of this file
rather than copying these rules elsewhere.

## Project and Design Principles

Fino is a TypeScript runtime for agentic applications, built on V8 through the
Rust `v8` crate. Its public runtime modules use `fino:*` specifiers; private
builtins use `internal:*` and are importable only by other builtins.

### TypeScript first, minimal Rust

Implement everything in TypeScript that conceivably can be implemented there.
This is a hard architectural constraint, not a preference. Rust exists only as
the minimum infrastructure needed to bootstrap and host TypeScript:

- embed V8 and expose V8 APIs that TypeScript cannot access directly;
- load, transpile, and start builtin TypeScript modules;
- provide the irreducible scheduler, isolate, platform, and FFI bridges; and
- expose compile-time or operating-system primitives that cannot safely be
  expressed through the existing TypeScript/FFI layers.

I/O, networking, protocols, standard-library behavior, orchestration, policy,
and other higher-level systems belong in `js/`. Fino deliberately calls system
libraries through `fino:ffi`; needing libc or an OS API is not by itself a
reason to add Rust. Before changing `src/`, prove that the work requires V8,
host bootstrap, or an otherwise impossible primitive. Keep any unavoidable Rust
surface small and generic, then put policy and composition back in TypeScript.

### Compose simple, reusable layers

Always ask whether a system can be generic and reusable. Prefer a stack of
small mechanisms with explicit contracts over one feature-shaped mechanism.
Build specialized behavior by composing those mechanisms. Shared concepts such
as transports, schedulers, capabilities, codecs, providers, lifecycle hooks,
and observability should have one reusable foundation rather than parallel
implementations.

Apply the same test to data structures and algorithms. If a queue, graph,
state machine, cache, index, parser primitive, retry strategy, traversal, or
scheduling algorithm can be expressed in terms of generic values and
operations, implement it independently of the subsystem that first needs it.
Keep protocol names, domain state, side effects, and feature policy in thin
adapters around the reusable core. Test the generic behavior directly, then
test each subsystem's composition with it.

Put unavoidable complexity at the lowest boundary that can own it, behind a
small interface. Higher layers should become easier to explain because they
compose simpler systems. Do not leak one protocol, platform, or call site's
policy into a generic lower layer. At the same time, do not create speculative
abstractions with no clear contract: generalize the stable mechanism evidenced
by current uses and tests.

### Realms are the execution model

Treat Realms as observable, repeatable execution containers, not merely worker
helpers. A Realm owns an isolated V8 context/isolate, global object, module
graph, event-loop state, imports, capabilities, lifecycle, and communication
boundary. Much of Fino is organized around many Realms executing concurrently:
ordinary Realms are movable isolates on the process-wide reactor pool, while
sandbox, process, and remote Realms provide stronger or distributed boundaries.

The long-term aim is for a Realm execution to be reproducible and internally
deterministic given the same inputs. Existing import-map access control,
sandboxing, simulation systems, providers, Facades, messaging, lifecycle
events, and telemetry all advance that model. Design new systems accordingly:

- make time, randomness, I/O, capabilities, and other external effects explicit
  or injectable where practical;
- make important inputs, outputs, transitions, failures, and resource use
  observable without changing semantics;
- define deterministic ordering and cleanup instead of relying on ambient
  process state, global singletons, thread affinity, or timing accidents;
- keep simulation and production implementations behind the same contracts so
  executions can be repeated and inspected;
- preserve capability narrowing: child import rules may not re-grant something
  denied by a parent; and
- consider concurrency, isolation, cancellation, shutdown, and resource
  ownership for every subsystem. Never assume only one Realm exists.

Behavior should remain conceptually consistent across scheduled, sandbox,
process, and remote Realm modes unless a boundary necessarily differs. Make any
such difference explicit and test it.

## Repository Layout and Architecture

- `src/`: minimal Rust host infrastructure: V8 initialization and event-loop
  integration, loader, FFI, async bridges, scheduled-isolate reactor, Realm
  transports, native networking primitives, and profiler bindings.
- `js/`: TypeScript builtin modules, globals, CLI tasks, public guides, and the
  higher-level runtime. `build.rs` strips types with OXC and embeds builtin
  sources in the binary; `src/loader.rs` registers their specifiers.
- `tests/`: `*.test.ts` integration and regression tests grouped by domain,
  plus explicit external-spec suites under `tests/integration/`.
- `benchmarks/`: `*.bench.ts` microbenchmarks and
  `benchmarks/COVERAGE.md`, the public-builtin benchmark inventory.
- `demos/`: runnable TypeScript examples.
- `runtime-builtins.d.ts`: documentation/type declarations for synthetic
  Rust-backed public modules such as `fino:ffi` and `fino:profiler`.
- `scripts/`: specialist protocol dependency and platform sandbox workflows.

Important runtime mechanics:

- V8 uses explicit microtask checkpoints. The Rust host pumps platform work,
  executor resolutions, and microtasks; TypeScript owns the higher-level loop.
- `internal:runtime/loop` abstracts the platform backends implemented in
  TypeScript, including kqueue on macOS and io_uring on Linux.
- The scheduler moves ordinary child isolates across a shared reactor pool.
  Avoid introducing isolate-thread affinity or process-global per-Realm state.
- `fino:*` is public. `internal:*` is restricted by the loader. Preserve that
  boundary and test public surface changes.
- `ImportMap.deny(...)` starts a Realm from deny-all imports, and Facades expose
  narrowly scoped parent functionality to children.

To add a source builtin, create the TypeScript module under `js/`, register the
appropriate `fino:*` or `internal:*` specifier in `src/loader.rs`, add focused
tests, and update public docs and benchmark coverage when applicable. Do not
add a Rust module for TypeScript library behavior.

## Development Commands

Run commands from the repository root. Prefer the already-built binary while
iterating so Cargo does not rebuild before every invocation.

### Build and run

```sh
cargo build
cargo build --release
cargo run -- path/to/script.ts
./target/debug/fino path/to/script.ts
./target/release/fino run path/to/script.ts
```

Debug builds retain symbols and suit development and native profiling. Release
builds are required for meaningful benchmarks and throughput comparisons.

### Tests

```sh
# Rust host tests
cargo test --quiet

# Focused TypeScript test file, directory, name filter, and full suite
./target/debug/fino test tests/net/serve.test.ts
./target/debug/fino test tests/net
./target/debug/fino test --filter websocket tests/net
./target/debug/fino test tests

# Match Linux CI's required optional features when dependencies are installed
FINO_REQUIRE_H2=1 FINO_REQUIRE_H3=1 FINO_REQUIRE_TLS=1 \
  FINO_REQUIRE_SQLITE=1 ./target/debug/fino test tests
```

The Fino runner accepts files, directories, and quoted globs, expands only
`*.test.ts`, emits TAP-13, and returns nonzero on failure. Use
`--show-output=always` while debugging captured output and `--durations` when
investigating slow tests.

Every behavior change needs focused regression coverage in the nearest domain.
Test success, boundary, error, cancellation/cleanup, and relevant concurrency
paths. For parser, protocol, or spec-backed work, map normative requirements and
logical branches to tests rather than relying on a broad happy-path test. Use
deterministic fixtures and injected/simulated effects wherever possible.

Run tests proportionally:

- During development, run the narrowest affected file or filtered case.
- Before handoff, run every directly affected suite and `cargo test --quiet` for
  Rust changes.
- Run `./target/debug/fino test tests` for cross-cutting runtime changes when
  local platform dependencies permit it.
- For networking, include the closest protocol, server/client, socket, Realm,
  and shutdown suites affected by the change.

External specification suites are deliberately gated because they require
additional checkouts or tools:

```sh
FINO_SPEC_TESTS=1 ./target/debug/fino test tests/integration/wpt.test.ts
FINO_SPEC_TESTS=1 ./target/debug/fino test tests/integration/h2spec.test.ts
FINO_SPEC_TESTS=1 ./target/debug/fino test tests/integration/autobahn-websocket.test.ts
```

Use `FINO_WPT_CATEGORY` and `FINO_WPT_PATH` to narrow WPT runs. Read each
suite's preflight comments before running it; missing required harnesses are
expected to fail when spec testing is explicitly enabled.

### Linting, type checking, and formatting

```sh
# Rust
cargo fmt --check
cargo clippy

# TypeScript/JavaScript lint and non-mutating format check
./target/debug/fino lint js tests benchmarks demos
./target/debug/fino fmt --check js tests benchmarks demos

# Project TypeScript compiler check (the package script runs tsc --noEmit)
npm run lint
```

Before committing Rust changes, run `cargo fmt`, review its diff, and verify
`cargo fmt --check`. Before committing TypeScript or JavaScript changes, run
`./target/debug/fino fmt` on each modified source path and review its diff, then
run the linter on the affected paths. Do not format the whole repository as a
substitute for reviewing changed files, and do not pass Markdown files to
`fino fmt`. `fino lint --fix` applies supported safe fixes but does not format.

Use 2-space indentation in TypeScript, `camelCase` for variables/functions,
`PascalCase` for classes/types, and `#privateField` for class internals. Use
standard Rust style and `snake_case`. Prefer small helpers and early exits over
deep nesting. Comments should explain non-obvious reasons or invariants, not
narrate code. Keep hot paths allocation-conscious. Main-thread I/O must be
asynchronous; use the runtime loop or a safe async FFI bridge rather than a
blocking system call. Avoid DOM-only types for server-runtime APIs.

### Documentation

Authored guides live in `js/**/*.md`. Public TypeScript API docs come from
markdown-first `/** */` comments; synthetic Rust-backed APIs are declared in
`runtime-builtins.d.ts`.

```sh
./target/release/fino doc build --format html --types runtime-builtins.d.ts js
./target/release/fino doc test js
./target/release/fino doc show bench.Group.measure
./target/release/fino doc search websocket
./target/release/fino test tests/docs/doc.test.ts
./target/release/fino test tests/docs/map.test.ts
```

Generated `docs/` output is ignored. Update `js/documentation.md` whenever a
guide is added, removed, or moved. Use the `$fino-documentation-standards` skill
when adding or changing public JS exports or generated-doc-visible symbols.
Use markdown-first prose rather than tag-driven JSDoc; reserve `@internal` for
helper exports that must be hidden from public docs.

### Benchmarks and load tests

```sh
# Focused or complete adaptive microbenchmarks
./target/release/fino bench benchmarks/net/http/app.bench.ts
./target/release/fino bench --filter routing benchmarks/net/http
FINO_REQUIRE_SQLITE=1 ./target/release/fino bench benchmarks

# Closed-loop HTTP load against an already-running target
./target/release/fino load --connections 100 --warmup 5s \
  --duration 30s http://127.0.0.1:3000/
./target/release/fino load --protocol h2 --connections 20 --streams 10 \
  --warmup 5s --duration 30s --insecure --json https://localhost:3000/
```

Benchmark only optimized builds. Stabilize machine load, ports, inputs,
dependencies, connection settings, and warmup before comparing results. Record
the exact command and environment. The benchmark runner prints adaptive,
human-readable throughput and is not itself a statistical CI regression gate;
compare repeated runs and investigate variance.

`fino load` supports explicit H1, H2, and H3 workloads, response consumption or
headers-only cancellation, fixed duration or request counts, warmup, timeouts,
and machine-readable `--json` output. Pin the protocol rather than accepting a
silent fallback. Prefer this built-in utility for load generation so the
protocol, response policy, warmup, timing, counters, and output schema are all
explicit and repeatable.

Performance-sensitive changes need a focused benchmark or a documented reason
one is not useful. Test failure/stress behavior as well as steady-state speed.
Never trade determinism, capability safety, cleanup, or correctness for a
microbenchmark result without an explicit, reviewed decision.

### Profiling

Use `fino:profiler` for V8 CPU profiles and symbolized debug binaries for
native investigation. Instrument the narrow workload under investigation with
`startProfiling()` and `stopProfiling()`, write the returned pprof bytes to a
file, and use the built-in load utility to drive HTTP workloads from a separate
process:

```sh
./target/release/fino load --connections 100 --warmup 5s \
  --duration 30s http://127.0.0.1:3000/
go tool pprof profile.pb
```

Keep warmup outside the capture window, use a unique port, verify the workload
reached steady state, and retain the load output alongside the profile. Use
release builds to explain real throughput and debug builds when maximum native
symbol fidelity is needed.

## Coverage and Conformance Analysis

Coverage means more than executing a line. Review the change's requirements,
branches, errors, concurrency, cleanup, platform paths, public surface, docs,
and performance envelope. This repository does not currently configure a
single numeric source-line coverage command, so do not claim a percentage that
was not measured. Use the maintained audits and focused tests instead:

```sh
# Every public builtin has an explicit benchmark coverage row and valid path
./target/debug/fino test tests/internal/benchmark-coverage.test.ts

# Public/internal builtin layout remains intentional
./target/debug/fino test tests/internal/builtin-layout.test.ts

# Documentation guides remain mapped and links remain live
./target/debug/fino test tests/docs/map.test.ts

# Read-only summary of scheduled Web Platform Test coverage
./target/release/fino tests/integration/fixtures/wpt/coverage-summary.ts
```

When adding a public `fino:*` builtin or changing registrations in
`src/loader.rs`, update `benchmarks/COVERAGE.md` in the same change and run the
benchmark coverage test. Add the corresponding benchmark or explicitly record
`not yet benchmarked`; do not silently omit the API. When changing behavior
defined by an external specification, use the `$fino-spec-conformance` skill,
link the authoritative specification in the module's top-level comment, align
the implementation to its relevant sections, and run the focused conformance
suite. Use `$fino-test-coverage-gaps` to audit branches and regression tests for
behavior changes.

## Specialist Platform Workflows

- CI runs debug builds, Rust tests, `cargo fmt --check`, `cargo clippy`, Fino
  lint, full TypeScript tests on Linux and macOS, and the benchmark inventory.
  `.github/workflows/ci.yml` is the authoritative CI recipe.
- `.github/workflows/benchmarks.yml` documents the release benchmark shards and
  their dependency requirements.
- `scripts/install-linux-protocol-deps.sh PREFIX` builds pinned OpenSSL,
  nghttp2, nghttp3, and ngtcp2 dependencies used by CI.
- `scripts/linux-sandbox/run-tests.sh` exercises Linux Landlock, seccomp, and
  cgroup enforcement through Apple's `container` environment; read
  `scripts/linux-sandbox/README.md` before using it.

## Change and Review Standards

Preserve unrelated work in a dirty tree. Keep changes narrow and do not rewrite
generated or third-party fixtures casually. A completed change should include:

- an implementation at the correct layer, TypeScript unless genuinely
  impossible;
- consideration of a smaller generic mechanism and reuse by other layers;
- focused tests that would have failed before the change;
- affected lint, formatting, type, Rust, integration, docs, coverage, benchmark,
  and profiling checks selected in proportion to risk; and
- documentation of any platform dependency, skipped check, known coverage gap,
  performance impact, or intentional Realm-mode difference.

Keep commits logically narrow. Use an imperative subject under 50 characters
when practical, followed by a blank line and a body explaining what changed and
why for nontrivial work. Wrap the body around 72 characters. Pull requests
should summarize affected areas, test evidence, and benchmark/profile evidence
for performance-sensitive work.
