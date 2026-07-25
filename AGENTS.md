# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the Rust host runtime, FFI layer, loader, and profiler integration. `js/` contains the built-in JS runtime modules exposed by `fino:*` and `internal:*`, including networking, streams, file APIs, and globals. `tests/` contains `.test.ts` integration tests grouped by area (`tests/net`, `tests/runtime`, `tests/file`, etc.). `benchmarks/` holds `.bench.mjs` microbenchmarks, and `example.ts` plus `example_profile.ts` are the main local throughput/profiling entry points.

## Build, Test, and Development Commands
- `cargo build` builds the debug binary with symbols.
- `cargo build --release` builds the optimized runtime used for benchmarks.
- `cargo test --quiet` runs Rust-side tests.
- `./target/release/fino test tests/net/serve.test.ts` runs a specific JS test file.
- `PORT=3001 cargo run -- example.ts` starts the benchmark server on a custom port.
- `PORT=3002 cargo run -- example_profile.ts` starts the profiled server and writes `profile.pb` on `/stop`.

## Coding Style & Naming Conventions
Use 2-space indentation in `.ts` files and standard Rust formatting conventions in `src/`. Prefer clear, small helpers over deeply nested logic. Use `camelCase` for JS variables/functions, `PascalCase` for classes/types, and `snake_case` for Rust functions/modules. Keep hot-path code allocation-conscious; this runtime is performance-sensitive. Prefer ASCII unless a file already uses Unicode.

## JS Documentation Comments
Use the `$fino-documentation-standards` skill when adding or changing public JS
APIs or generated-doc-visible symbols. Comments should be markdown-formatted
`/** */` blocks rather than tag-driven JSDoc prose, with `@internal` reserved
for helper exports that need it.

## Testing Guidelines
Add or update tests with every behavior change, especially for networking, parsing, and FFI paths. Name JS tests `*.test.ts` and place them in the closest domain folder. Favor focused regression tests over broad end-to-end additions. For server work, run at least the affected suite, for example `tests/net/serve.test.ts` and `tests/net/socket-class.test.ts`.

## Commit & Pull Request Guidelines
Keep commits narrow and logically grouped. Write commit messages with a concise
imperative subject, a blank line, and a descriptive body when the change is not
trivial. Keep the subject under 50 characters when possible and wrap body lines
at about 72 characters. The body should explain what changed and why, not repeat
the diff. PRs should include a short summary, affected areas, test coverage, and
benchmark or profiling notes for performance-sensitive changes.

Before every commit, format all modified source files with the repository
formatters and verify the corresponding format checks pass. Run `cargo fmt` for
Rust changes and `fino fmt` on every changed JavaScript and TypeScript path; do
not rely on focused tests to catch formatting drift. Review changed Markdown
separately because `fino fmt` does not process it.

When adding a public `fino:*` builtin or changing which builtins are registered
in `src/loader.rs`, update `benchmarks/COVERAGE.md` in the same change so every
public builtin has a coverage-table row. Run
`fino test tests/internal/benchmark-coverage.test.ts` before committing.

## Performance & Profiling Notes
Benchmark with unique ports to avoid stale local servers: `PORT=3031 cargo run -- example.ts` plus `autocannon -c 100 -d 10 http://127.0.0.1:3031/`. Use debug builds for symbolized native profiling and `example_profile.ts` for built-in JS pprof output.
