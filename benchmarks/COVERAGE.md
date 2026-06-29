# Public Builtin Benchmark Coverage

This map tracks every public `fino:*` builtin registered in `src/loader.rs`.
Benchmark paths mirror the corresponding `js/` source path where one exists.
Synthetic Rust-backed builtins use a top-level benchmark file.

| Builtin specifier | Benchmark coverage |
| --- | --- |
| `fino:ffi` | `benchmarks/ffi.bench.mts` |
| `fino:realm` | `benchmarks/realm/index.bench.mts` |
| `fino:module` | `benchmarks/module.bench.mts` |
| `fino:realm/pool` | `benchmarks/realm/pool.bench.mts` |
| `fino:realm/self` | `benchmarks/realm/self.bench.mts` |
| `fino:realm/messaging` | `benchmarks/realm/messaging.bench.mts` |
| `fino:database/sqlite` | `benchmarks/database/sqlite.bench.mts` |
| `fino:stream` | `benchmarks/stream.bench.mts` |
| `fino:process` | `benchmarks/process.bench.mts` |
| `fino:context` | `benchmarks/context/index.bench.mts` |
| `fino:ui` | `benchmarks/ui.bench.mts` |
| `fino:ui/jsx-runtime` | `benchmarks/ui.bench.mts` |
| `fino:tty` | `benchmarks/tty.bench.mts` |
| `fino:tty/tui` | `benchmarks/tty/tui.bench.mts` |
| `fino:net/socket` | `benchmarks/net/socket.bench.mts` |
| `fino:net/tls` | `benchmarks/net/tls.bench.mts` |
| `fino:net/dns` | `benchmarks/net/dns.bench.mts` |
| `fino:net/http` | `benchmarks/net/http/index.bench.mts` |
| `fino:net/http/app` | `benchmarks/net/http/app.bench.mts` |
| `fino:net/http/client` | `benchmarks/net/http/client.bench.mts` |
| `fino:net/http/server` | `benchmarks/net/http/server.bench.mts` |
| `fino:net/http/eventsource` | `benchmarks/net/http/eventsource.bench.mts` |
| `fino:net/http/websocket` | `benchmarks/net/http/websocket.bench.mts` |
| `fino:net/http/webtransport` | `benchmarks/net/http/h3.bench.mts` |
| `fino:net/quic` | `benchmarks/net/quic.bench.mts` |
| `fino:file` | `benchmarks/file/fs.bench.mts` |
| `fino:file/path` | `benchmarks/file/path.bench.mts` |
| `fino:file/watch` | `benchmarks/file/watch.bench.mts` |
| `fino:archive` | `benchmarks/archive.bench.mts` |
| `fino:cluster` | `benchmarks/cluster.bench.mts` |
| `fino:opentelemetry` | `benchmarks/opentelemetry.bench.mts` |
| `fino:opentelemetry/logs` | `benchmarks/opentelemetry/logs.bench.mts` |
| `fino:opentelemetry/metrics` | `benchmarks/opentelemetry/metrics.bench.mts` |
| `fino:opentelemetry/sdk` | `benchmarks/opentelemetry/sdk.bench.mts` |
| `fino:opentelemetry/traces` | `benchmarks/opentelemetry/traces.bench.mts` |
| `fino:parsing/scanner` | `benchmarks/parsing/scanner.bench.mts` |
| `fino:semver` | `benchmarks/semver.bench.mts` |

Internal HTTP protocol driver benchmarks live beside the public HTTP
benchmarks, but they are not public builtin coverage targets:
`benchmarks/net/http/driver.bench.mts`, `benchmarks/net/http/h1.bench.mts`,
`benchmarks/net/http/h2.bench.mts`, and `benchmarks/net/http/h3.bench.mts`.
| `fino:uuid` | `benchmarks/uuid.bench.mts` |
| `fino:format/markdown` | `benchmarks/format/markdown.bench.mts` |
| `fino:template` | `benchmarks/template.bench.mts` |
| `fino:log` | `benchmarks/log.bench.mts` |
| `fino:validate` | `benchmarks/validate.bench.mts` |
| `fino:config` | `benchmarks/config.bench.mts` |
| `fino:security` | `benchmarks/security/index.bench.mts` |
| `fino:security/random` | `benchmarks/security/random.bench.mts` |
| `fino:security/headers` | `benchmarks/security/headers.bench.mts` |
| `fino:security/cors` | `benchmarks/security/cors.bench.mts` |
| `fino:security/cookie` | `benchmarks/security/cookie.bench.mts` |
| `fino:security/token` | `benchmarks/security/token.bench.mts` |
| `fino:security/password` | `benchmarks/security/password.bench.mts` |
| `fino:security/jwk` | `benchmarks/security/jwk.bench.mts` |
| `fino:security/jwt` | `benchmarks/security/jwt.bench.mts` |
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
| `fino:process/argv` | `benchmarks/process/argv.bench.mts` |
| `fino:tty/prompt` | `benchmarks/tty/prompt.bench.mts` |
| `fino:context/topic` | `benchmarks/context/topic.bench.mts` |
| `fino:profiler` | `benchmarks/profiler.bench.mts` |
| `fino:net/http/eventstream` | not yet benchmarked |
| `fino:ai/context` | not yet benchmarked |
| `fino:ai` | not yet benchmarked |
| `fino:ai/model` | not yet benchmarked |
| `fino:ai/model/anthropic` | not yet benchmarked |
| `fino:ai/model/local` | not yet benchmarked |
| `fino:ai/model/openai` | not yet benchmarked |
| `fino:ai/tool` | not yet benchmarked |
| `fino:ai/harness` | not yet benchmarked |
| `fino:ai/runtime` | not yet benchmarked |
| `fino:ai/agent` | not yet benchmarked |
| `fino:ai/memory` | not yet benchmarked |
| `fino:ai/session` | not yet benchmarked |
| `fino:ai/workflow` | not yet benchmarked |
| `fino:ai/skill` | not yet benchmarked |
| `fino:ai/eval` | not yet benchmarked |
| `fino:jsonrpc` | not yet benchmarked |
| `fino:ai/mcp` | not yet benchmarked |
| `fino:workflow` | not yet benchmarked |
| `fino:task` | not yet benchmarked |

## Release Stress And Failure Coverage

The table above tracks existence for every public builtin. The release audit
also requires deeper stress/failure lanes for subsystems that were previously
smoke-only:

| Area | Stress/failure benchmark coverage |
| --- | --- |
| Cluster | `benchmarks/cluster.bench.mts` covers loopback lifecycle, remote spawn/call throughput, and worker-loss cleanup. |
| Realm remote/pool | `benchmarks/realm/pool.bench.mts` covers warm call batches, concurrent dispatch, timeout cleanup, and close drain timeout cleanup. |
| OpenTelemetry | `benchmarks/opentelemetry.bench.mts` and `benchmarks/opentelemetry/sdk.bench.mts` cover runtime instrumentation traffic, processor queue pressure, exporter failure paths, and shutdown drains. |
| Logging sinks | `benchmarks/log.bench.mts` covers JSON, console, OpenTelemetry sink forwarding, and sink level filtering. |
