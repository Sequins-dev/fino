# Contributing

This guide is for people working on the Fino runtime repository. For a
product-level overview, start with [README.md](./README.md).

## Requirements

- Rust toolchain
- Supported UNIX-like environment
- Release build for most CLI verification and benchmarks

## Build

```sh
cargo build
cargo build --release
```

Use debug builds for symbolized native profiling. Use release builds for
throughput measurements and most CLI verification.

## Run

Run a script through Cargo:

```sh
cargo run -- path/to/script.ts
```

After a release build:

```sh
./target/release/fino run path/to/script.ts
./target/release/fino path/to/script.ts
```

Run tests and benchmarks:

```sh
./target/release/fino test tests/net/serve.test.ts
./target/release/fino bench benchmarks
```

Build generated docs locally:

```sh
./target/release/fino doc build --types runtime-builtins.d.ts js
```

`docs/` is generated output and is ignored by git.

## Project Layout

- `src/`: Rust host runtime, V8 embedding, loader, FFI, async/runtime bridges,
  profiler, and platform integration.
- `js/`: built-in runtime modules, public guides, globals, CLI command tasks,
  and higher-level standard-library behavior.
- `tests/`: `.test.ts` integration tests grouped by runtime area.
- `benchmarks/`: `.bench.ts` and `.bench.mjs` microbenchmarks.
- `runtime-builtins.d.ts`: declaration docs for synthetic Rust-backed public
  modules such as `fino:ffi` and `fino:profiler`.
- `research-docs/`: design and research notes.

## Documentation Workflow

Authored guides live in `js/**/*.md`. Public JavaScript API documentation is
generated from markdown-first comments in `js/**/*.ts` and declarations in
`runtime-builtins.d.ts`.

Use the generated docs command when changing public docs or API comments:

```sh
./target/release/fino doc build --format html --types runtime-builtins.d.ts js
```

Useful guide entry points:

- `js/getting-started.md`
- `js/runtime-model.md`
- `js/ai.md`
- `js/realm.md`
- `js/net.md`

## Focused Checks

Useful focused checks while developing:

```sh
cargo test --quiet
./target/release/fino test tests/internal/builtin-layout.test.ts
./target/release/fino test tests/runtime/doc.test.ts
./target/release/fino test tests/net/serve.test.ts
./target/release/fino test tests/net/socket-class.test.ts
```

For server or networking work, run the closest affected JS suite. For behavior
changes in Rust-hosted features, also run the relevant Rust tests.

## Performance and Profiling

Benchmark with unique ports to avoid stale local servers:

```sh
PORT=3031 cargo run -- example.ts
autocannon -c 100 -d 10 http://127.0.0.1:3031/
curl http://127.0.0.1:3031/stop
```

Use `example_profile.ts` when collecting a JS CPU profile:

```sh
PORT=3032 cargo run -- example_profile.ts
autocannon -c 100 -d 10 http://127.0.0.1:3032/
curl http://127.0.0.1:3032/stop
go tool pprof profile.pb
```

Keep profiling runs separate from general local testing, and prefer release
builds for throughput measurements.
