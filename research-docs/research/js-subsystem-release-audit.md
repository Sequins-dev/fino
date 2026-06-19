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
Status: TODO

- Add direct coverage for vnode watches, wake sources, `submit()`, and
  io_uring completions.
- Add replacement and double-registration tests for read/write watchers.
- Backend portability risk remains high.

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

- Add ALPN client behavior, custom CA success, hostname mismatch, and
  `upgrade()` ownership/failure tests.
- Ensure CI cannot silently skip TLS coverage when OpenSSL is expected.

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
Status: TODO

- Correct stale module header text about H2 dispatch.
- Add explicit IPv6 bind, TLS ALPN fallback through `serve()`, and close during
  active TLS/H2 request tests.

## HTTP Driver Interfaces
Status: DONE

## HTTP/2
Status: TODO

- Work down live `h2spec-allowed-failures.json` items across frame errors,
  stream state, flow control, PING, SETTINGS, CONTINUATION, and PUSH_PROMISE.
- Keep existing happy-path and parser tests, but do not treat RFC conformance as
  release-clean yet.

## HTTP/2 Pool
Status: TODO

- Add idle timeout tests.
- Add peer GOAWAY `lastStreamId` handling tests.
- Add active-stream transport failure and global `fetch()` retry/eviction
  integration tests.

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
Status: TODO

- Prevent or explicitly document `Cookie`/`Cookie2` leakage on cross-origin
  redirects.
- Clarify non-enforced `mode`, `credentials`, `cache`, and `keepalive` options.
- Add streaming request body/duplex, HTTPS/H2 fetch, trailer, and redirect
  cookie tests.

## Web Streams
Status: TODO

- Add WHATWG Streams WPT corpus coverage.
- Expand negative tests for BYOB semantics, tee cancellation, released locks,
  and transform backpressure failures.

## Internal Reader And Writer Streams
Status: DONE

## Compression Streams
Status: DONE

## Messaging And BroadcastChannel
Status: DONE

## WebCrypto Global
Status: TODO

- Add a release matrix that fails when expected OpenSSL-backed algorithms are
  unavailable.
- Add WPT/RFC vectors for wrap/unwrap, ECDH, RSA-OAEP/PSS, JWK rejection, and
  key-usage enforcement.

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

- Add remote `run()`, `terminate()`, error propagation, and remote exit tests.
- Add remote transfer coverage for `ArrayBuffer` and `MessagePort`.
- Add process-realm facade parity tests.

## Realm Pool
Status: DONE

## Realm Messaging And Self
Status: DONE

## Cluster
Status: TODO

- Add real WebSocket multi-worker tests for routing, peer down, failover, and
  remote exit cascade.
- Add heartbeat timeout tests with controlled timers.
- Add pending remote spawn timeout coverage or explicit behavior.
- Add cluster port transfer tests for buffers and message ports.

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

- Add live-path tests for DNS, socket, and TLS instrumentations.
- Add CLI/bootstrap startup, shutdown flush, env/options wiring, and disposal
  coverage.
- Add exporter tests for 4xx non-retry, 429 retry, `Retry-After`, and non-gzip
  compression payloads.

## Docs And Benchmarks
Status: TODO

- Regenerate or correct stale DNS and HTTP server docs.
- Add stress/failure benchmarks for archive, SQLite, file watch, DNS resolver,
  DNSSEC, TLS, QUIC, and H3 where current benchmarks are surface-level.
