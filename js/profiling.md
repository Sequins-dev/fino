---
weight: 61
---
# Profiling

Fino exposes two profiling paths: native/runtime profiling through normal Rust
debug symbols, and JS CPU profile capture through `fino:profiler`.

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

Build generated API docs with `--types runtime-builtins.d.ts` to include the
synthetic `fino:profiler` reference page.
