---
weight: 61
---
# Profiling

Fino exposes two profiling paths: native/runtime profiling through normal Rust
debug symbols, and JS CPU profile capture through either `fino:profiler` or the
process-wide `run --profile` flag.

## Process-wide Realm Profiles

Pass `--profile` before the script positional to capture every Realm executing
inside the Fino process:

```sh
fino run --profile app.ts
go tool pprof profile.pb
```

The runtime starts an isolate-local V8 recording as each Realm bootstraps. When
a Realm terminates, Rust traverses its final V8 snapshot directly into one
shared accumulator. The main Realm writes `profile.pb` only after all other
Realm registrations have finished, so there are no intermediate encoded
profile shards.

Every sample carries a string label named `thread`, with a unique Realm value.
pprof visualizers can therefore separate or filter Realm execution using their
normal thread/tag support. Sandbox and reactor-pooled Realms participate because
they execute in the same process. Process and remote Realms execute beyond that
process boundary and are not part of its CPU profile.

The output follows the upstream [pprof profile schema](https://github.com/google/pprof/blob/main/proto/profile.proto), including its sample-label representation. See the [pprof tag documentation](https://github.com/google/pprof/blob/main/doc/README.md) for filtering and visualization.

## JS CPU Profiles

`fino:profiler` starts and stops V8 CPU profile capture from JavaScript:

```ts no_run
import { startProfiling, stopProfiling } from 'fino:profiler';
import { DiskFileSystem } from 'fino:file';

startProfiling('load');
await runWorkload();
const profile = stopProfiling('load');
await new DiskFileSystem().writeFile('profile.pb', profile);
```

`stopProfiling()` returns serialized profile bytes. Application code chooses
whether to write, upload, or discard them.

## Repository Profiling Fixture

The repository includes `example_profile.ts` for HTTP throughput profiling:

```sh
PORT=3032 cargo run -- example_profile.ts
autocannon -c 100 -d 10 http://127.0.0.1:3032/
curl http://127.0.0.1:3032/stop
go tool pprof profile.pb
```

Use debug builds when native symbol quality matters, and release builds when
measuring throughput. Use unique ports for benchmark and profile runs so stale
servers do not contaminate measurements.

The `fino:profiler` surface is documented in the generated API reference.
