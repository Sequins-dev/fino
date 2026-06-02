# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the Rust host runtime, FFI layer, loader, and profiler integration. `js/` contains the built-in JS runtime modules exposed by `fino:*` and `internal:*`, including networking, streams, file APIs, and globals. `tests/` contains `.test.mts` integration tests grouped by area (`tests/net`, `tests/runtime`, `tests/file`, etc.). `benchmarks/` holds `.bench.mjs` microbenchmarks, and `example.mts` plus `example_profile.mts` are the main local throughput/profiling entry points.

## Build, Test, and Development Commands
- `cargo build` builds the debug binary with symbols.
- `cargo build --release` builds the optimized runtime used for benchmarks.
- `cargo test --quiet` runs Rust-side tests.
- `./target/release/fino --test tests/net/serve.test.mts` runs a specific JS test file.
- `PORT=3001 cargo run -- example.mts` starts the benchmark server on a custom port.
- `PORT=3002 cargo run -- example_profile.mts` starts the profiled server and writes `profile.pb` on `/stop`.

## Coding Style & Naming Conventions
Use 2-space indentation in `.mts` files and standard Rust formatting conventions in `src/`. Prefer clear, small helpers over deeply nested logic. Use `camelCase` for JS variables/functions, `PascalCase` for classes/types, and `snake_case` for Rust functions/modules. Keep hot-path code allocation-conscious; this runtime is performance-sensitive. Prefer ASCII unless a file already uses Unicode.

## JS Documentation Comments
Add JSDoc comments for JS module headers, exported functions, classes,
interfaces, types, and generated-doc-visible class members. Module-level
comments should be in-depth: explain what the module does, when to use it,
important defaults or safety limits, short examples, and relevant learning
links such as protocol or file-format specifications. Symbol comments should
describe behavior, defaults, return shape, failure or `null` cases, and security
caveats where relevant. Use `@internal` for helper exports that support public
APIs but are not application-facing.

## Testing Guidelines
Add or update tests with every behavior change, especially for networking, parsing, and FFI paths. Name JS tests `*.test.mts` and place them in the closest domain folder. Favor focused regression tests over broad end-to-end additions. For server work, run at least the affected suite, for example `tests/net/serve.test.mts` and `tests/net/socket-class.test.mts`.

## Commit & Pull Request Guidelines
Keep commits narrow and logically grouped. Write commit messages with a concise
imperative subject, a blank line, and a descriptive body when the change is not
trivial. Keep the subject under 50 characters when possible and wrap body lines
at about 72 characters. The body should explain what changed and why, not repeat
the diff. PRs should include a short summary, affected areas, test coverage, and
benchmark or profiling notes for performance-sensitive changes.

## Performance & Profiling Notes
Benchmark with unique ports to avoid stale local servers: `PORT=3031 cargo run -- example.mts` plus `autocannon -c 100 -d 10 http://127.0.0.1:3031/`. Use debug builds for symbolized native profiling and `example_profile.mts` for built-in JS pprof output.
