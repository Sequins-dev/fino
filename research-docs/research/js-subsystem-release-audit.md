# JS Subsystem Release Audit

Release-readiness tracker for the `js/` subsystem. Findings come from source,
test, docs, and benchmark inspection; the test suite was not run for this
audit.

`DONE` means the subsystem looks basically complete for release based on this
inspection. `TODO` means there is visible remaining work for feature
completeness, conformance, docs, or test confidence.

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
Status: TODO

- Regenerate or correct stale docs for DNSSEC and TCP fallback support.
- Add real signed-domain DNSSEC, IPv6 nameserver, `/etc/resolv.conf`, malformed
  TCP fallback, and CNAME + DNSSEC chain tests.
- Replace or document `Math.random()` transaction IDs.

## DNSSEC
Status: TODO

- Add live root-anchor validation.
- Add broader real-world algorithm and negative-response corpus coverage.

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
Status: TODO

- Work down live `h2spec-allowed-failures.json` items across frame errors,
  stream state, flow control, PING, SETTINGS, CONTINUATION, and PUSH_PROMISE.
- Keep existing happy-path and parser tests, but do not treat RFC conformance as
  release-clean yet.

## HTTP/2 Pool
Status: DONE

## HTTP/3
Status: TODO

- Add h3spec/quic interop or real UDP HTTP/3 client/server smoke coverage.
- Expand beyond simulated-pipe tests and availability/function benchmarks.
- Decide whether one-shot client `fetch()` remains experimental release scope.

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
Status: DONE

## Realm Messaging And Self
Status: DONE

## Cluster
Status: DONE

## Test Framework
Status: DONE

## Assertions
Status: DONE

## Fetch Mocking
Status: DONE

## Bench Harness
Status: DONE

## OpenTelemetry API, SDK, Signals
Status: DONE

## OpenTelemetry Instrumentations And Bootstrap
Status: DONE

## Docs And Benchmarks
Status: TODO

- Regenerate or correct stale DNS and HTTP server docs.
- Add stress/failure benchmarks for archive, SQLite, file watch, DNS resolver,
  DNSSEC, TLS, QUIC, and H3 where current benchmarks are surface-level.
