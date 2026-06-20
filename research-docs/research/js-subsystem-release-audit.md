# JS Subsystem Release Audit

Static release-readiness tracker for `js/`, related tests, docs, and
benchmarks. This audit is intended to guide follow-up hardening work before
release.

`DONE` means the subsystem looks basically release-ready from inspection.
`TODO` means visible feature, spec, documentation, CI, benchmark, or test gaps
remain. Keep entries brief and actionable.

## Runtime Core, Bootstrap, Main
Status: DONE

## Loader, Import Meta, Module
Status: DONE

## Runtime Loop And Backends
Status: DONE

## Runtime Parent RPC
Status: DONE

## CLI Root And Run Commands
Status: DONE

## Test And Bench Commands
Status: DONE

## Fmt, Lint, And Tooling
Status: DONE

## Init Command
Status: DONE

## Install And Package Manager
Status: DONE

## Doc Command
Status: DONE

## REPL
Status: DONE

## Process And Process Class
Status: DONE

## Process Argv Parser
Status: DONE

## TTY And Prompt
Status: DONE

## Config
Status: DONE

## Context And Topic
Status: DONE

## File System And Paths
Status: DONE

## File Watch
Status: DONE

## Archive
Status: DONE

## Database SQLite
Status: DONE

## Compression
Status: DONE

## Template
Status: DONE

## Semver
Status: DONE

## Parsing Scanner
Status: DONE

## Validation
Status: DONE

## Logging
Status: DONE

## Socket
Status: DONE

## TLS
Status: TODO
- Add broader TLS policy docs/tests for cipher/protocol selection, session
  reuse, and server-side client certificates outside QUIC.
- Require or document an OpenSSL-enabled release CI lane.

## DNS Resolver
Status: DONE

## DNSSEC
Status: DONE

## DNS Provider Interface
Status: DONE

## Network Provider Interface
Status: TODO
- Add OS-backed provider conformance coverage; current direct contract tests
  focus on the simulated provider.

## Simulated Network Provider
Status: DONE

## HTTP Core
Status: DONE

## HTTP/1
Status: TODO
- Optional release hardening: add external HTTP/1 compliance or fuzz baseline.

## HTTP Server
Status: DONE

## HTTP Driver Interfaces
Status: DONE

## HTTP/2
Status: TODO
- Finish h2spec regressions and keep the allowlist current.
- Remove or justify h2spec sections 6.6/6.9 harness omissions.

## HTTP/2 Pool
Status: TODO
- Add end-to-end global `fetch()` H2 pool tests for origin keying, reuse after
  TLS ALPN, GOAWAY/close eviction, and trailers over pooled fetch.

## HTTP/3
Status: TODO
- Define release stance for optional `libnghttp3` skip path.
- Track gaps for external H3 interop/conformance, connection reuse,
  WebTransport/Capsule, and CONNECT tunnel support.

## QUIC
Status: TODO
- Require or document external interop lanes for ngtcp2 HQ tools and
  `NODE_QUIC_BIN`.
- Keep optional advanced features and backend requirements explicit.

## WebSocket
Status: TODO
- Add direct low-level frame violation tests for documented RFC cases:
  fragmented control, RSV, reserved opcodes, invalid UTF-8, oversized frame,
  and bad mask direction.
- Document no extension negotiation if that remains intentional.

## EventSource
Status: TODO
- Add redirect handling and TLS EventSource coverage.
- Document credentials/CORS parity boundaries.

## HTTP App
Status: DONE

## Global Registry
Status: DONE

## EventTarget, Abort, Timers, Console
Status: DONE

## Encoding, TextEncoder, Structured Clone
Status: DONE

## URL, URLSearchParams, URLPattern
Status: DONE

## Blob And File
Status: DONE
- In-memory subset is complete; document no lazy/file-backed large-blob
  behavior.

## FormData
Status: DONE

## Fetch Global
Status: DONE

## Web Streams
Status: DONE

## Internal Reader And Writer Streams
Status: DONE

## Compression Streams
Status: DONE
- Optional hardening: add abort/cancel propagation and backpressure tests.

## Messaging And BroadcastChannel
Status: DONE

## WebCrypto Global
Status: DONE

## UUID
Status: DONE

## Security Random, Password, Tokens
Status: DONE

## Security Cookies, Headers, CORS
Status: DONE

## Security JWK, JWT, JWE
Status: DONE

## CSV Format
Status: DONE

## TOML Format
Status: DONE

## YAML Format
Status: DONE

## XML Format
Status: DONE

## TypeScript Format
Status: DONE

## Markdown Format
Status: DONE

## Realm Core
Status: TODO
- Add remote realm tests for `terminate()`, bootstrap/call errors,
  facade/stream/sink behavior, and import-rule/provider parity.
- Document remote/cluster isolation tradeoffs and limits.

## Realm Pool
Status: TODO
- Add stress/throughput benchmarks and any missing remote/pool failure cases.

## Realm Messaging And Self
Status: DONE

## Cluster
Status: TODO
- Add guide/spec docs for heartbeat timeouts, spawn routing, failure
  propagation, active remote realm ownership, and shutdown expectations.
- Add public integration tests for remote realm exit/terminate propagation and
  worker/seed failure cases.

## Test Framework
Status: DONE

## Assertions
Status: DONE

## Fetch Mocking
Status: DONE

## Bench Harness
Status: DONE

## OpenTelemetry API, SDK, Signals
Status: TODO
- Define stable public API versus internal helper/runtime event types.
- Add task-oriented setup recipes beyond generated API listings.

## OpenTelemetry Instrumentations And Bootstrap
Status: TODO
- Add stress/failure benchmarks for exporter batching, backpressure, and
  instrumented runtime traffic.

## Docs And Benchmarks
Status: TODO
- Benchmark coverage exists for every public builtin, but many files are smoke
  benchmarks; add targeted stress/failure benchmarks for cluster, OTel,
  logging sinks, and realm remote/pool throughput.
