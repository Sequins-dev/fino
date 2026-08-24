---
name: fino-change-validation
description: Select and run proportionate build, format, lint, type, test, builtin-surface, and platform checks for a Fino change. Use after implementation, while debugging CI, or before handoff; skip read-only exploration with no changed files.
---

# Fino Change Validation

Validate the behavior and boundaries actually changed. Inspect the diff first, run narrow checks while iterating, then expand according to cross-cutting risk. Do not claim checks that were not run, and report platform or dependency gates precisely.

Run commands from the repository root. Prefer an already-built `./target/debug/fino` while iterating; rebuild when source embedding or Rust changes make it stale.

```sh
cargo build
./target/debug/fino path/to/script.ts
./target/release/fino run path/to/script.ts
```

Debug builds suit ordinary development and native symbol inspection. Use release builds for meaningful performance measurements.

## Core Commands

### TypeScript and JavaScript

Format each modified source path, review the diff, then lint the affected paths:

```sh
./target/debug/fino fmt <modified-paths>
./target/debug/fino fmt --check <modified-paths>
./target/debug/fino lint <modified-paths>
npm run lint
```

Do not pass Markdown to `fino fmt` or format the whole repository as a substitute for reviewing changed files. `fino lint --fix` applies supported safe fixes but does not format.

Use `$fino-test-coverage-gaps` to choose and run behavior tests. Run every directly affected suite before handoff; use the full `./target/debug/fino test tests` suite for cross-cutting runtime work when local dependencies permit it.

### Rust

For Rust changes, use:

```sh
cargo fmt
cargo fmt --check
cargo clippy
cargo test --quiet
```

Review formatting changes. Rust should expose only the smallest generic host primitive; validate the TypeScript composition separately when both layers changed.

## Conditional Audits

- Public JS or generated-doc-visible changes: use `$fino-documentation-standards`.
- External specification behavior: use `$fino-spec-conformance`.
- Performance-sensitive changes: use `$fino-performance-engineering`.
- New or changed public `fino:*` registrations: update `benchmarks/COVERAGE.md` with a benchmark path or the explicit `not yet benchmarked` marker, then run:

  ```sh
  ./target/debug/fino test tests/internal/benchmark-coverage.test.ts
  ./target/debug/fino test tests/internal/builtin-layout.test.ts
  ```

- Added, removed, or moved guides: update `js/documentation.md` and run `./target/debug/fino test tests/docs/map.test.ts`.
- Networking changes: include the closest affected protocol, client/server, socket, Realm, and shutdown suites rather than assuming one broad happy path proves composition.
- Platform sandbox changes: read `scripts/linux-sandbox/README.md` before using `scripts/linux-sandbox/run-tests.sh`.
- CI parity investigations: treat `.github/workflows/ci.yml` as authoritative. `.github/workflows/benchmarks.yml` defines release benchmark shards, and `scripts/install-linux-protocol-deps.sh PREFIX` builds the pinned Linux protocol dependencies.

When optional libraries are installed and the change depends on them, the Linux CI-equivalent test environment is:

```sh
FINO_REQUIRE_H2=1 FINO_REQUIRE_H3=1 FINO_REQUIRE_TLS=1 \
  FINO_REQUIRE_SQLITE=1 ./target/debug/fino test tests
```

## Handoff

List exact commands and results. Explain every skipped relevant check, unavailable dependency or platform, known coverage gap, intentional Realm-mode difference, and unmeasured performance impact.

When the task includes a commit or pull request, keep commits logically narrow. Prefer an imperative subject under 50 characters and, for nontrivial work, a body explaining what changed and why. Pull requests should summarize affected areas, test evidence, and benchmark or profile evidence when performance-sensitive.
