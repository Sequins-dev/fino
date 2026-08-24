---
name: fino-test-coverage-gaps
description: Find missing tests for Fino behavior changes. Use when adding or reviewing JS or Rust behavior, auditing logical branches, checking regression coverage, mapping spec requirements to tests, or deciding which focused tests are needed before modifying implementation.
---

# Fino Test Coverage Gaps

Use this skill to turn implementation behavior into a concrete test map. The goal is to prove intended behavior stays stable and unintended behavior does not slip through untested branches.

## Workflow

1. Define the behavior surface.
   - Identify public exports, internal helpers used by public paths, FFI/binding edges, async/resource lifecycles, parser states, protocol states, and platform gates touched by the change.
   - For spec-backed code, use `$fino-spec-conformance` to derive requirements from the spec text before judging coverage.
   - For non-spec code, derive requirements from module comments, exported types, existing tests, call sites, and observable runtime behavior.

2. Map decisions and outcomes.
   - List each logical branch, error path, `null`/empty case, fallback, timeout/cancellation path, resource cleanup path, and security limit.
   - Include cross-boundary behavior such as JS-to-Rust FFI errors, stream closure, socket shutdown, worker/realm messaging, and environment-dependent availability.
   - Treat unsupported behavior as a behavior: it should either be rejected, ignored, skipped, or documented with tests.

3. Compare against existing tests.
   - Search the closest `tests/` domain folder first, then broader suites.
   - Match tests to observable behavior, not just executed lines.
   - Mark each behavior as `covered`, `partial`, `missing`, `not-testable-locally`, `covered-by-contract-suite`, or `covered-by-external-suite`.
   - For multiple implementations of a Fino-owned interface, prefer a shared contract harness and use `$fino-platform-design` to review substitutability. External protocol requirements remain the responsibility of `$fino-spec-conformance`.

4. Fill gaps with focused tests.
   - Prefer small regression tests near the affected domain over broad end-to-end additions.
   - Name tests by the contract they protect.
   - Cover both positive and negative cases where a branch can fail independently.
   - Use fixtures for parser/format cases when the repo already uses fixture-based validation.

5. Select commands deliberately.
   - For JS behavior, run the narrow affected `.test.ts` file with the built runtime used by the repo.
   - For Rust behavior, run `cargo test --quiet` or the narrow relevant Rust test when available.
   - For networking changes, include the closest affected protocol, client/server, socket, Realm, and shutdown suites rather than relying on one broad path.
   - When a test cannot run because of an unavailable library or platform gate, record the skip condition and any alternate evidence.

## Test Runner

Prefer the already-built binary while iterating:

```sh
./target/debug/fino test tests/net/serve.test.ts
./target/debug/fino test tests/net
./target/debug/fino test --filter websocket tests/net
./target/debug/fino test --show-output=always --durations tests/net/serve.test.ts
./target/debug/fino test tests
```

The runner accepts files, directories, and quoted globs, expands only `*.test.ts`, emits TAP-13, and returns nonzero on failure. Run the narrowest affected file or filter during development, every directly affected suite before handoff, and the full suite for cross-cutting runtime changes when local dependencies permit it.

## Coverage Map Format

Use this compact map in notes, review comments, or final responses when coverage is the main task:

```text
Behavior / requirement | Existing test | Status | Action
```

Use `Action` for the exact test to add, the command to run, or the reason no local test is feasible.

## Quality Bar

- Tests should prove externally visible behavior or durable internal contracts.
- A branch is not covered just because a nearby happy path executes.
- Error tests should assert error type, message shape, cleanup, or recovery behavior when those are part of the contract.
- Async tests should prove ordering, disposal, and no lost wakeups/messages where relevant.
- Security-sensitive code should include malformed input, resource-limit, and bypass attempts where feasible.
- Internal conformance tests should exercise the same observable contract against every claimed implementation; implementation-specific happy paths do not prove substitutability.
