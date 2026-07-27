# Public Builtin Benchmark Coverage

This map tracks every public `fino:*` builtin registered in `src/loader.rs`.
Benchmark paths mirror the corresponding `js/` source path where one exists.
Synthetic Rust-backed builtins use a top-level benchmark file.

| Builtin specifier | Benchmark coverage |
| --- | --- |
| `fino:ffi` | `benchmarks/ffi.bench.ts` |
| `fino:commands/root` | not yet benchmarked |
| `fino:commands/run` | not yet benchmarked |
| `fino:commands/repl` | not yet benchmarked |
| `fino:commands/test` | not yet benchmarked |
| `fino:commands/bench` | not yet benchmarked |
| `fino:commands/task` | not yet benchmarked |
| `fino:commands/init` | not yet benchmarked |
| `fino:commands/install` | not yet benchmarked |
| `fino:commands/doc` | not yet benchmarked |
| `fino:commands/fmt` | not yet benchmarked |
| `fino:commands/lint` | not yet benchmarked |
| `fino:realm` | `benchmarks/realm/index.bench.ts` |
| `fino:module` | `benchmarks/module.bench.ts` |
| `fino:realm/self` | `benchmarks/realm/self.bench.ts` |
| `fino:realm/messaging` | `benchmarks/realm/messaging.bench.ts` |
| `fino:database` | not yet benchmarked |
| `fino:database/sql` | not yet benchmarked |
| `fino:database/migrate` | not yet benchmarked |
| `fino:database/postgres` | not yet benchmarked |
| `fino:database/sqlite` | `benchmarks/database/sqlite.bench.ts` |
| `fino:stream` | `benchmarks/stream.bench.ts` |
| `fino:process` | `benchmarks/process.bench.ts` |
| `fino:context` | `benchmarks/context/index.bench.ts` |
| `fino:ui` | `benchmarks/ui.bench.ts` |
| `fino:ui/jsx-runtime` | `benchmarks/ui.bench.ts` |
| `fino:ui/html` | `benchmarks/ui.bench.ts` |
| `fino:ui/slides` | not yet benchmarked |
| `fino:ui/web` | not yet benchmarked |
| `fino:ui/web/flow` | not yet benchmarked |
| `fino:ui/web/state` | not yet benchmarked |
| `fino:tty` | `benchmarks/tty.bench.ts` |
| `fino:tty/tui` | `benchmarks/tty/tui.bench.ts` |
| `fino:net/socket` | `benchmarks/net/socket.bench.ts` |
| `fino:net/tls` | `benchmarks/net/tls.bench.ts` |
| `fino:net/dns` | `benchmarks/net/dns.bench.ts` |
| `fino:net/mdns` | not yet benchmarked |
| `fino:net/http` | `benchmarks/net/http/index.bench.ts` |
| `fino:net/http/app` | `benchmarks/net/http/app.bench.ts` |
| `fino:net/http/client` | `benchmarks/net/http/client.bench.ts` |
| `fino:net/http/server` | `benchmarks/net/http/server.bench.ts` |
| `fino:net/http/eventsource` | `benchmarks/net/http/eventsource.bench.ts` |
| `fino:net/http/websocket` | `benchmarks/net/http/websocket.bench.ts` |
| `fino:net/http/webtransport` | `benchmarks/net/http/h3.bench.ts` |
| `fino:net/quic` | `benchmarks/net/quic.bench.ts` |
| `fino:net/quic/availability` | `benchmarks/net/quic.bench.ts` |
| `fino:net/quic/connection` | `benchmarks/net/quic.bench.ts` |
| `fino:net/quic/endpoint` | `benchmarks/net/quic.bench.ts` |
| `fino:net/quic/events` | `benchmarks/net/quic.bench.ts` |
| `fino:net/quic/listener` | `benchmarks/net/quic.bench.ts` |
| `fino:net/quic/stream` | `benchmarks/net/quic.bench.ts` |
| `fino:net/quic/types` | `benchmarks/net/quic.bench.ts` |
| `fino:file` | `benchmarks/file/fs.bench.ts` |
| `fino:file/path` | `benchmarks/file/path.bench.ts` |
| `fino:file/watch` | `benchmarks/file/watch.bench.ts` |
| `fino:archive` | `benchmarks/archive.bench.ts` |
| `fino:cluster` | `benchmarks/cluster.bench.ts` |
| `fino:opentelemetry` | `benchmarks/opentelemetry.bench.ts` |
| `fino:opentelemetry/logs` | `benchmarks/opentelemetry/logs.bench.ts` |
| `fino:opentelemetry/metrics` | `benchmarks/opentelemetry/metrics.bench.ts` |
| `fino:opentelemetry/sdk` | `benchmarks/opentelemetry/sdk.bench.ts` |
| `fino:opentelemetry/traces` | `benchmarks/opentelemetry/traces.bench.ts` |
| `fino:parsing/scanner` | `benchmarks/parsing/scanner.bench.ts` |
| `fino:semver` | `benchmarks/semver.bench.ts` |

Internal HTTP protocol driver benchmarks live beside the public HTTP
benchmarks, but they are not public builtin coverage targets:
`benchmarks/net/http/driver.bench.ts`, `benchmarks/net/http/h1.bench.ts`,
`benchmarks/net/http/h2.bench.ts`, and `benchmarks/net/http/h3.bench.ts`.
| `fino:uuid` | `benchmarks/uuid.bench.ts` |
| `fino:format/markdown` | `benchmarks/format/markdown.bench.ts` |
| `fino:format/mdx` | not yet benchmarked |
| `fino:template` | `benchmarks/template.bench.ts` |
| `fino:log` | `benchmarks/log.bench.ts` |
| `fino:validate` | `benchmarks/validate.bench.ts` |
| `fino:config` | `benchmarks/config.bench.ts` |
| `fino:webhooks` | not yet benchmarked |
| `fino:security` | `benchmarks/security/index.bench.ts` |
| `fino:security/oauth` | not yet benchmarked |
| `fino:security/random` | `benchmarks/security/random.bench.ts` |
| `fino:security/headers` | `benchmarks/security/headers.bench.ts` |
| `fino:security/cors` | `benchmarks/security/cors.bench.ts` |
| `fino:security/cookie` | `benchmarks/security/cookie.bench.ts` |
| `fino:security/token` | `benchmarks/security/token.bench.ts` |
| `fino:security/password` | `benchmarks/security/password.bench.ts` |
| `fino:security/jwk` | `benchmarks/security/jwk.bench.ts` |
| `fino:security/jwt` | `benchmarks/security/jwt.bench.ts` |
| `fino:data` | `benchmarks/data/arrow.bench.ts` |
| `fino:data/arrow` | `benchmarks/data/arrow.bench.ts` |
| `fino:data/arrow/cdata` | `benchmarks/data/arrow.bench.ts` |
| `fino:data/parquet` | `benchmarks/data/parquet.bench.ts` |
| `fino:format/csv` | `benchmarks/format/csv.bench.ts` |
| `fino:format/flatbuffers` | `benchmarks/format/flatbuffers.bench.ts` |
| `fino:format/protobuf` | `benchmarks/format/protobuf.bench.ts` |
| `fino:format/typescript` | `benchmarks/format/typescript.bench.ts` |
| `fino:format/toml` | `benchmarks/format/toml.bench.ts` |
| `fino:format/xml` | `benchmarks/format/xml.bench.ts` |
| `fino:format/yaml` | `benchmarks/format/yaml.bench.ts` |
| `fino:test/assert` | `benchmarks/test/assert.bench.ts` |
| `fino:test/test` | `benchmarks/test/test.bench.ts` |
| `fino:test/bench` | `benchmarks/test/bench.bench.ts` |
| `fino:bench` | `benchmarks/test/bench.bench.ts` |
| `fino:test/mock` | `benchmarks/test/mock.bench.ts` |
| `fino:compress` | `benchmarks/compress.bench.ts` |
| `fino:cache` | not yet benchmarked |
| `fino:email` | not yet benchmarked |
| `fino:signals` | not yet benchmarked |
| `fino:storage` | not yet benchmarked |
| `fino:process/argv` | `benchmarks/process/argv.bench.ts` |
| `fino:tty/prompt` | `benchmarks/tty/prompt.bench.ts` |
| `fino:context/topic` | `benchmarks/context/topic.bench.ts` |
| `fino:profiler` | `benchmarks/profiler.bench.ts` |
| `fino:net/http/eventstream` | not yet benchmarked |
| `fino:ai/context` | not yet benchmarked |
| `fino:ai/cache` | not yet benchmarked |
| `fino:ai/budget` | not yet benchmarked |
| `fino:ai/gateway` | not yet benchmarked |
| `fino:ai/sandbox` | not yet benchmarked |
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
| `fino:task/durable` | not yet benchmarked |
| `fino:jobs` | not yet benchmarked |

## Release Stress And Failure Coverage

The table above tracks existence for every public builtin. The release audit
also requires deeper stress/failure lanes for subsystems that were previously
smoke-only:

| Area | Stress/failure benchmark coverage |
| --- | --- |
| Cluster | `benchmarks/cluster.bench.ts` covers loopback lifecycle, remote spawn/call throughput, and worker-loss cleanup. |
| OpenTelemetry | `benchmarks/opentelemetry.bench.ts` and `benchmarks/opentelemetry/sdk.bench.ts` cover runtime instrumentation traffic, processor queue pressure, exporter failure paths, and shutdown drains. |
| Logging sinks | `benchmarks/log.bench.ts` covers JSON, console, OpenTelemetry sink forwarding, and sink level filtering. |
