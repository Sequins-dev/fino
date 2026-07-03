![fino logo](./logo.svg)

# fino

Fino is an experimental JavaScript runtime with a thin Rust host and a large
JavaScript standard-library layer. Rust embeds V8, owns low-level runtime
integration, exposes synthetic native modules such as `fino:ffi` and
`fino:profiler`, and loads built-in JS modules. Most user-facing behavior lives
in JavaScript under `js/`.

The runtime is aimed at scripts, services, tests, benchmarks, tools, agents, and
local-first workloads that benefit from built-in web APIs, explicit runtime
modules, and reusable task-based command surfaces.

## Current Surface

- Web-style globals: `fetch`, `Request`, `Response`, `Headers`, `URL`, timers,
  Web Streams, `Blob`, `FormData`, `crypto`, `MessageChannel`, and related APIs.
- Built-in `fino:*` modules for HTTP, sockets, TLS, DNS, QUIC, files, archives,
  formats, config, validation, SQLite/Postgres, jobs, workflows, security,
  OpenTelemetry, AI, UI, TTY, processes, realms, and tasks.
- A CLI built from reusable `Task` objects exposed through `fino:commands/*`.
- A package installer that resolves npm packages into `.fino/` and writes a
  loader package map.
- Native interop through `fino:ffi` and JS CPU profiling through
  `fino:profiler`.

This project is still actively changing. Expect rough edges and incomplete
Node/npm ecosystem compatibility.

## Build

Requirements:

- Rust toolchain
- Supported UNIX-like environment

```sh
cargo build
cargo build --release
```

Use debug builds for symbolized native profiling. Use release builds for
throughput measurements and most CLI verification.

## Run

Run a script:

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

## Example HTTP Server

```ts
import { serveHttp } from 'fino:net/http/server';

const server = serveHttp({ port: Number(process.env.PORT ?? 3000) }, () => {
  return new Response('hello from fino\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
});

console.log(`listening on http://127.0.0.1:${server.port}`);
```

Run the repository benchmark server:

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

## Documentation

Start with the authored guides in `js/`:

- `js/getting-started.md`
- `js/runtime-model.md`
- `js/cli.md`
- `js/modules-and-packages.md`
- `js/net/guide.md`
- `js/net/http/guide.md`
- `js/process/guide.md`
- `js/native-ffi.md`
- `js/profiling.md`
- `js/testing-and-benchmarking.md`

Generated API docs are produced from the same `js/` tree and
`runtime-builtins.d.ts` with `fino doc build`.

## Development Notes

Useful focused checks:

```sh
cargo test --quiet
./target/release/fino test tests/internal/builtin-layout.test.ts
./target/release/fino test tests/runtime/doc.test.ts
./target/release/fino test tests/net/serve.test.ts
./target/release/fino test tests/net/socket-class.test.ts
```

For performance work, use unique ports and keep profiling runs separate from
general local testing.
