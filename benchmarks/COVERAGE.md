# Public Builtin Benchmark Coverage

This map tracks every public `fino:*` builtin registered in `src/loader.rs`.
Benchmark paths mirror the corresponding `js/` source path where one exists.
Synthetic Rust-backed builtins use a top-level benchmark file.

| Builtin specifier | Benchmark coverage |
| --- | --- |
| `fino:ffi` | `benchmarks/ffi.bench.mts` |
| `fino:realm` | `benchmarks/runtime/realm/index.bench.mts` |
| `fino:module` | `benchmarks/runtime/module.bench.mts` |
| `fino:realm/pool` | `benchmarks/runtime/realm/pool.bench.mts` |
| `fino:realm/self` | `benchmarks/runtime/realm/self.bench.mts` |
| `fino:messaging` | `benchmarks/runtime/messaging.bench.mts` |
| `fino:database/sqlite` | `benchmarks/database/sqlite.bench.mts` |
| `fino:runtime/loop` | No direct benchmark; the event loop is benchmark infrastructure used by `fino:bench` and direct timer/poll measurements are intentionally omitted. |
| `fino:runtime/process` | `benchmarks/runtime/process.bench.mts` |
| `fino:context` | `benchmarks/context/index.bench.mts` |
| `fino:tty` | `benchmarks/tty.bench.mts` |
| `fino:net/socket` | `benchmarks/net/socket.bench.mts` |
| `fino:net/tls` | `benchmarks/net/tls.bench.mts` |
| `fino:net/dns` | `benchmarks/net/dns.bench.mts` |
| `fino:net/http` | `benchmarks/net/http/index.bench.mts` |
| `fino:net/http/driver` | `benchmarks/net/http/driver.bench.mts` |
| `fino:net/http/h1` | `benchmarks/net/http/h1.bench.mts` |
| `fino:net/http/server` | `benchmarks/net/http/server.bench.mts` |
| `fino:net/http/h2` | `benchmarks/net/http/h2.bench.mts` |
| `fino:net/http/eventsource` | `benchmarks/net/http/eventsource.bench.mts` |
| `fino:net/http/websocket` | `benchmarks/net/http/websocket.bench.mts` |
| `fino:file` | `benchmarks/file/fs.bench.mts` |
| `fino:file/path` | `benchmarks/file/path.bench.mts` |
| `fino:file/watch` | `benchmarks/file/watch.bench.mts` |
| `fino:archive` | `benchmarks/archive.bench.mts` |
| `fino:cluster` | `benchmarks/runtime/cluster.bench.mts` |
| `fino:opentelemetry` | `benchmarks/opentelemetry/index.bench.mts` |
| `fino:parsing/scanner` | `benchmarks/parsing/scanner.bench.mts` |
| `fino:semver` | `benchmarks/semver.bench.mts` |
| `fino:uuid` | `benchmarks/uuid.bench.mts` |
| `fino:format/markdown` | `benchmarks/format/markdown.bench.mts` |
| `fino:template` | `benchmarks/template.bench.mts` |
| `fino:log` | `benchmarks/log.bench.mts` |
| `fino:validate` | `benchmarks/validate.bench.mts` |
| `fino:config` | `benchmarks/config.bench.mts` |
| `fino:format/csv` | `benchmarks/format/csv.bench.mts` |
| `fino:format/typescript` | `benchmarks/format/typescript.bench.mts` |
| `fino:format/toml` | `benchmarks/format/toml.bench.mts` |
| `fino:format/xml` | `benchmarks/format/xml.bench.mts` |
| `fino:format/yaml` | `benchmarks/format/yaml.bench.mts` |
| `fino:test/assert` | `benchmarks/test/assert.bench.mts` |
| `fino:test/test` | `benchmarks/test/test.bench.mts` |
| `fino:test/bench` | `benchmarks/test/bench.bench.mts` |
| `fino:bench` | `benchmarks/test/bench.bench.mts` |
| `fino:test/mock` | `benchmarks/test/mock.bench.mts` |
| `fino:compress` | `benchmarks/compress.bench.mts` |
| `fino:util/argv` | `benchmarks/util/argv.bench.mts` |
| `fino:util/prompt` | `benchmarks/util/prompt.bench.mts` |
| `fino:context/topic` | `benchmarks/context/topic.bench.mts` |
| `fino:profiler` | `benchmarks/profiler.bench.mts` |
