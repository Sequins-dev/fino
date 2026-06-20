# JS Subsystem Release Audit

Fresh strict-parity release audit for `js/`, related tests, docs, and
benchmarks. This tracker is intended to guide follow-up hardening before
release.

`DONE` means the subsystem looks release-ready from inspection. DONE entries
contain only `Status: DONE`.
`TODO` means visible feature, spec, documentation, CI, benchmark, or test gaps
remain. TODO entries are intentionally brief and actionable.

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
Status: TODO
- Require live validation coverage instead of relying only on `FINO_DNS_LIVE=1` optional tests.
- Define root trust anchor rollover/update policy.
- Unsupported algorithms and digests reject safely, but this is not full DNSSEC ecosystem parity.

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
Status: TODO
- Add origin pooling/reuse for public `fetch()` or document one-shot behavior.
- Verify hostname DNS resolution in public H3 fetch; URL hosts appear to be passed as IP-shaped QUIC addresses.
- Track deferred WebTransport, Capsule, H3 DATAGRAM, CONNECT tunnels, and external H3 interop.

## QUIC
Status: TODO
- Complete advanced parity for external DATAGRAM interop, resumed-session interop, active migration, and version negotiation.
- Close backend-specific TLS gaps between OpenSSL and GnuTLS.
- Require gated interop lanes beyond local simulator and loopback tests.

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
Status: TODO
- Browser policy behavior is incomplete: CORS, credentials, cache, cookies, keepalive, and default referrer handling.
- Add full Fetch/WPT-style coverage beyond local HTTP, redirects, abort, decompression, and integrity tests.
- Cover HTTPS/H2 fetch behavior in release CI.

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
Status: TODO
- Built-ins cover HTTP server, fetch, DNS, socket, TLS, and trace topics only.
- CLI bootstrap is tied to `--otlp-endpoint`; standard `OTEL_*` env handling is incomplete.
- Add release-hardening tests for instrumentation config, suppression, filtering, and broader runtime domains.

## Docs And Benchmarks
Status: TODO
- Benchmark inventory exists for requested public builtins, but release comparison workflows and CI gates are incomplete.
- Clean generated docs that expose private-member stubs.
- Convert coverage maps into explicit release notes for JOSE, CORS/cookie, OpenTelemetry, cluster, and other intentional non-parity areas.
