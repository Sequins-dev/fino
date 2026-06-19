# JS Subsystem Release Audit

Release-readiness tracker for the `js/` subsystem. Findings come from source,
test, docs, and benchmark inspection; the test suite was not run for this
audit.

`DONE` means the subsystem looks basically complete for release based on this
inspection. `TODO` means there is visible remaining work for feature
completeness, conformance, docs, or test confidence.

## Runtime Core, Bootstrap, Main
Status: TODO

- Add focused coverage for `Atomics.waitAsync` keepalive.
- Add shutdown-hook failure path coverage from `internal/main.mts`.
- Add child-realm early `__call` / `__pool_call` replay regression tests.

## Loader, Import Meta, Module
Status: TODO

- Align `import.meta.resolve()` with normal import extension probing.
- Add package-map owner dependency lookup, package resolution failure, bare
  package JSON, and deep-import tests.
- `SyntheticModule` lifecycle coverage looks solid.

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
Status: TODO

- Add directory/glob expansion coverage for `fino test`.
- Add empty-expanded-input behavior tests.

## Fmt, Lint, And Tooling
Status: TODO

- Add parse-diagnostic formatting tests.
- Add directory discovery and ignored hidden/build directory coverage.
- Add `lint --fix` coverage once fixable rules exist.

## Init Command
Status: DONE

## Install And Package Manager
Status: TODO

- Add optional/peer dependency warning coverage.
- Add exports pattern, conditional exports, fallback main/module, and
  deep-import tests.
- Add registry/tarball failure cleanup tests.

## Doc Command
Status: DONE

## REPL
Status: TODO

- Add CLI stdin tests for evaluation, multiline input, `.exit`, Ctrl-D/C, and
  formatted output.
- Add unserializable/object result formatting coverage.

## Process And Process Class
Status: TODO

- Add custom `env` option coverage.
- Add failed spawn cleanup tests.
- Add repeated `wait()` and failed `kill()` behavior coverage or explicit API
  guards.

## Process Argv Parser
Status: DONE

## TTY And Prompt
Status: TODO

- Add prompt `text`/`confirm`/`select` interactive and non-interactive tests.
- Export public prompt option interfaces or hide them from generated public
  signatures.
- Add validation retry and invalid select choice tests.

## Config
Status: DONE

## Context And Topic
Status: DONE

## File System And Paths
Status: DONE

## File Watch
Status: TODO

- Make non-existent path failure semantics explicit.
- Add Linux inotify vs macOS kqueue rename/delete coverage.
- Add recursive watch, fd cleanup, and rapid event burst lifecycle tests.

## Archive
Status: TODO

- Add malformed ZIP/TAR coverage for truncated directories, bad offsets, and bad
  tar checksums.
- Validate ZIP CRCs on read/extract.
- Document or test unsupported ZIP64, data descriptor, PAX, and long-name
  compatibility limits.
- Add extraction policy tests for total size and file-count limits.

## Database SQLite
Status: TODO

- Add readonly open, missing file, closed database/statement, and prepare
  failure tests.
- Expand VFS coverage for WAL/journal/temp files, concurrent connections,
  locking, sync, and truncate errors.
- Test extension loading failures and `vectorsAvailable` probing.
- Add custom filesystem persistence tests across reopen.

## Compression
Status: DONE

## Template
Status: DONE

## Semver
Status: DONE

## Parsing Scanner
Status: DONE

## Validation
Status: TODO

- Expand tests for `nullable`, default clone behavior, `const`, `email`, `uri`,
  and array/object edge cases.
- Document the supported JSON Schema subset.
- Test or document `additionalProperties` schema-value behavior.
- Add invalid schema and refinement/default interaction tests.

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
Status: TODO

- Add direct provider contract tests.
- Either implement or remove/docs-adjust future-only static, virtual, and
  restricted providers.

## Network Provider Interface
Status: TODO

- Add provider conformance tests across implementations.
- Either implement or docs-adjust future-only disk/restricted provider claims.

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
Status: TODO

- Document TextDecoder as UTF-8-only if that is intentional.
- Fix or document ArrayBuffer transfer behavior for fixed buffers.
- Add WPT-style structured clone corpus coverage.

## URL, URLSearchParams, URLPattern
Status: TODO

- Add WPT/corpus coverage for custom URL and URLPattern implementations.
- Replace weak URLPattern repeat-modifier tests with spec-behavior assertions.
- Cover IDNA/punycode, IPv6, special schemes, and percent-encoding matrices.

## Blob And File
Status: DONE

## FormData
Status: TODO

- Add multipart CRLF/header injection tests for field names and filenames.
- Use stronger boundary randomness or document that boundaries are not a
  security primitive.
- Add multipart wire-output escaping tests.

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
Status: TODO

- Add fd read/write error path and partial write coverage.
- Add flush/close idempotence, `readUntil` max/EOF, and `writev` limit tests.

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
Status: TODO

- Add invalid random/token/password option-bound tests.
- Add malformed password-record variants and non-default hash/key/salt tests.

## Security Cookies, Headers, CORS
Status: TODO

- Add CRLF/header-injection tests for cookie attribute values.
- Add denied-origin, wildcard-with-credentials, predicate, and invalid
  header/method CORS tests.
- Add security header option disabling and custom CSP/HSTS/referrer tests.

## Security JWK, JWT, JWE
Status: TODO

- Add RFC vectors and algorithm-confusion cases.
- Add `kid`, `aud` arrays, `nbf`, `iat`, `crit`, wrong key type/use, and
  unsupported algorithm rejection coverage.

## CSV Format
Status: DONE

## TOML Format
Status: DONE

## YAML Format
Status: DONE

## XML Format
Status: DONE

## TypeScript Format
Status: TODO

- Expand smoke tests to JSX/TSX, `.d.ts`, source type matrix, source-map
  validity, formatter options, and lint rules.

## Markdown Format
Status: TODO

- Add raw HTML, nested lists, escaped punctuation, malformed links, reference
  collisions, and sanitizer corpus tests.

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
Status: TODO

- Add runner tests for hooks, skip propagation, nested failures, TAP output, and
  filters.
- Investigate filtered top-level `test()` leaves in `_filterEntries`.
- Add teardown behavior tests after hook failures.

## Assertions
Status: DONE

## Fetch Mocking
Status: DONE

## Bench Harness
Status: TODO

- Add behavioral tests for async measurement, setup/teardown ordering,
  filtering, and teardown-on-throw.
- Keep benchmark-facing coverage, but add unit-level confidence.

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
