# JS Subsystem Release Audit

Fresh release-readiness tracker for `js/`, related tests, docs, and
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

## Test Command
Status: DONE

## Bench Command
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
Status: TODO
- Retire or explicitly reclassify the live h2spec allowlisted failures before
  calling full conformance complete.
- Keep release signoff explicit for omitted h2spec sections `http2/6.6` and
  `http2/6.9`.

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
Status: TODO
- Decide release scope for structured clone gaps: URL, URLSearchParams,
  CryptoKey, DOMException, streams, and port transfer.
- Implement true ArrayBuffer detachment for transfer or document the current
  zero-fill non-conformance publicly.

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

## Realm Process, Thread, Remote Modes
Status: DONE

## Realm Import And Provider Policies
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
Status: DONE
