# Repository Guidelines

This is the single source of durable, always-applicable repository guidance for
coding agents and human contributors. Scenario-specific workflows live in
`.agents/skills/`; keep tool-specific instruction files as imports of this file
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

Source builtins live in `js/` and are registered by `src/loader.rs`; public
registrations use `fino:*` and private registrations use `internal:*`. Keep
TypeScript library behavior out of new Rust modules.

## Core Development Rules

Run project commands from the repository root. Prefer the already-built Fino
binary while iterating so Cargo does not rebuild unnecessarily.

Use 2-space indentation in TypeScript, `camelCase` for variables and functions,
`PascalCase` for classes and types, and `#privateField` for internal class state.
Use standard Rust style and `snake_case`. Prefer small helpers and early exits
over deep nesting. Comments should explain non-obvious reasons or invariants,
not narrate code.

Keep hot paths allocation-conscious. Main-thread I/O must be asynchronous; use
the runtime loop or a safe async FFI bridge rather than a blocking system call.
Avoid DOM-only types for server-runtime APIs.

Every behavior change needs focused regression coverage in the nearest domain.
Test the observable contract, including relevant success, boundary, error,
cancellation, cleanup, ordering, concurrency, and unsupported paths. Use
deterministic fixtures and injected or simulated effects wherever possible.
Coverage means demonstrated behavior, not merely executing a line; do not claim
a numeric coverage percentage that was not measured.

Preserve unrelated work in a dirty tree. Keep changes narrow and do not rewrite
generated or third-party fixtures casually.

## Conditional Workflows

Load the relevant repository skill when a task enters one of these scenarios:

- Use `$fino-platform-design` for new subsystems, shared mechanisms, providers,
  transports, schedulers, state machines, public APIs, or cross-cutting
  refactors. It operationalizes the design principles above without replacing
  them.
- Use `$fino-test-coverage-gaps` when changing behavior or auditing regression
  coverage, logical branches, internal contracts, failure paths, or cleanup.
- Use `$fino-spec-conformance` for behavior governed by an external
  specification, including its documentation links and gated conformance
  suites.
- Use `$fino-documentation-standards` for public JS exports,
  generated-doc-visible symbols, module comments, or authored guide changes.
- Use `$fino-performance-engineering` for benchmarks, load tests, profiling, or
  performance-sensitive design and implementation.
- Use `$fino-change-validation` after implementation, while debugging CI, or
  before handoff to select proportional build, format, lint, type, test,
  builtin-surface, dependency, and platform checks.

These skills own scenario-specific commands and audit procedures. Keep this
file focused on constraints and assumptions that should influence ordinary
work even when no specialist workflow is active.

## Completion Standard

A completed change should have an implementation at the correct layer,
consideration of a smaller reusable mechanism, focused tests that would have
failed before the change, and validation proportional to its risk. Report any
platform dependency, skipped relevant check, known coverage or conformance gap,
performance impact, or intentional Realm-mode difference.
