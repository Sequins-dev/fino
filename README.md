![fino logo](./logo.svg)

# fino

Fino is an experimental JavaScript runtime built around a thin Rust host and a large JS standard library/runtime layer. The core design is simple: Rust provides V8 embedding, module loading, FFI plumbing, and low-level event-loop integration; most runtime behavior is implemented in JavaScript on top of that foundation.

The project is focused on:

- web-standard APIs such as `fetch`, `Request`, `Response`, `URL`, streams, timers, and crypto
- low-level UNIX I/O through an FFI-first architecture
- a JS-owned runtime model, including HTTP serving, parsing, and stream handling
- performance work around FFI, batching, and event-loop efficiency

## Current Status

Fino is usable for local scripts, tests, benchmarks, and simple servers. The runtime currently includes:

- module loading for local files and built-in `fino:*` / `internal:*` modules
- a Rust-driven event loop using `kqueue` on macOS and `io_uring` on Linux
- file, process, stream, DNS, socket, TLS, HTTP, and profiler modules
- a test runner and benchmark runner
- a built-in FFI layer designed for direct native interop

This is still an actively changing project. Expect rough edges and incomplete ecosystem compatibility.

## Building

Requirements:

- Rust toolchain
- a supported UNIX-like environment

Build commands:

```sh
cargo build
cargo build --release
```

The debug build is better for symbolized native profiling. The release build is what you want for throughput measurements.

## Running Scripts

Run a script:

```sh
cargo run -- path/to/script.mts
```

Run tests:

```sh
./target/release/fino test tests/net/serve.test.mts
```

Run benchmarks:

```sh
./target/release/fino --bench benchmarks/http.bench.mjs
```

## Example HTTP Server

The repository includes a minimal HTTP benchmark server:

```sh
PORT=3001 cargo run -- example.mts
```

Then benchmark it:

```sh
autocannon -c 100 -d 10 http://127.0.0.1:3001/
curl http://127.0.0.1:3001/stop
```

There is also a profiling variant:

```sh
PORT=3002 cargo run -- example_profile.mts
autocannon -c 100 -d 10 http://127.0.0.1:3002/
curl http://127.0.0.1:3002/stop
go tool pprof profile.pb
```

## Project Layout

- `src/`: Rust runtime, loader, profiler, and FFI implementation
- `js/`: built-in JS runtime modules and platform APIs
- `tests/`: `.test.mts` integration tests
- `benchmarks/`: `.bench.mjs` performance microbenchmarks
- `docs/roadmap.md`: planned compatibility and runtime work

## Architecture Notes

Fino is intentionally not a “Rust implements everything” runtime. The low-level layer is small on purpose. Higher-level facilities such as HTTP parsing/serialization, serving, stream composition, and much of the platform API surface live in JavaScript. That makes performance work different from most runtimes: improvements often come from reducing FFI overhead, cutting allocations in JS hot paths, and batching I/O more effectively.

## Development Notes

Useful commands:

```sh
cargo test --quiet
./target/release/fino test tests/net/socket-class.test.mts
./target/release/fino test tests/net/serve.test.mts
```

If you are working on performance-sensitive code, prefer benchmarking on a unique port and keep profiling runs separate from general local testing.
