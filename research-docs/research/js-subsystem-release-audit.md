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
Status: DONE

## DNS Resolver
Status: DONE

## DNSSEC
Status: DONE

## DNS Provider Interface
Status: DONE

## Network Provider Interface
Status: DONE

## Simulated Network Provider
Status: DONE

## HTTP Core
Status: DONE

## HTTP/1
Status: DONE

## HTTP Server
Status: DONE

## HTTP Driver Interfaces
Status: DONE

## HTTP/2
Status: DONE

## HTTP/2 Pool
Status: DONE

## HTTP/3
Status: DONE

## QUIC
Status: DONE

## WebSocket
Status: DONE

## EventSource
Status: DONE

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
Status: DONE

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
