# JS Subsystem Release Audit

Fresh strict-parity release audit for `js/`, related tests, docs, and
benchmarks. This tracker is intended to guide follow-up hardening before
release.

`DONE` means the subsystem looks release-ready from inspection.
`TODO` means visible feature, spec, documentation, CI, benchmark, or test gaps
remain. Entries are intentionally brief and actionable.

## Runtime Core, Bootstrap, Main
Status: DONE
- Release baseline covers bootstrap-installed globals, `self`, minimal
  writable/configurable `navigator`, absence of a Node global `process`, and
  absence of browser rejection-event globals.
- `reportError()` writes an unhandled-error diagnostic without failing the
  process by itself; root script top-level throws and top-level await
  rejections propagate to the CLI as nonzero exits.
- Runtime docs state the current global-surface non-goals: no Node global
  `process`, no broad browser `navigator`, and no browser
  `unhandledrejection` / `rejectionhandled` event parity in this baseline.

## Loader, Import Meta, Module
Status: DONE
- Release baseline covers local and `file://` module resolution, percent-decoded
  file URL paths, malformed and non-local file URL rejection, JSON default
  exports, package-map bare imports, and package-map exported subpaths.
- Package `imports` / `#` specifiers, direct `node_modules` or package.json
  traversal, direct Node-style package `exports` resolution, and directory
  index probing are outside this baseline.
- JSON imports do not require Node-style import attributes in this baseline;
  strict JSON import-attribute enforcement is outside scope.

## Runtime Loop And Backends
Status: DONE
- Release baseline documents the backend matrix: macOS kqueue, Linux
  io_uring, and Linux poll fallback when `io_uring_setup(2)` is unavailable.
- Coverage locks the common readiness/timer/wait backend surface, explicit
  platform constants, Linux fallback kind reporting, readable/writable
  replacement, wake sources, vnode and submit platform behavior, synchronous
  `spin()` / `run()`, timer cancellation, and abort handling.
- Platform-specific CI lanes for every backend remain release infrastructure
  work; `proc`, `vnode`, `submit`, and poll fallback completions are documented
  as platform/backing-backend-specific rather than broad portability promises.

## Runtime Parent RPC
Status: DONE

## CLI Root And Run Commands
Status: DONE
- Release baseline covers root script fallback, explicit `run`, script argument
  visibility through `fino:process.argv`, `--watch`, and `--otlp-endpoint`.
- Option-like script arguments are passed after `--`; options before the stop
  marker belong to the Fino command parser.
- Root/run inputs are single module specifiers and do not expand directories or
  glob patterns.

## Test Command
Status: DONE
- Release baseline covers direct file, directory, and glob `.test.mts` inputs,
  TAP-13 output, substring filters, hook failure exit codes, and captured
  output modes.
- The command delegates to Fino's test framework and is not a Node `node:test`
  compatibility surface.

## Bench Command
Status: DONE
- Release baseline covers direct file, directory, and glob `.bench.mts` inputs,
  filtering, async setup/teardown behavior, teardown on measurement failure,
  failure output, and human comparison text.
- Benchmark output is benc.h-style human text; the command does not emit JSON
  or machine-readable result objects.
- Stable-machine comparison guidance is documented. CI regression gates and
  release comparison workflows remain outside the command contract.

## Fmt, Lint, And Tooling
Status: DONE
- Release baseline documents the hardcoded discovery contract: supported
  JavaScript/TypeScript extensions only, recursive directory scanning,
  sorted/de-duplicated inputs, and built-in ignored hidden/dependency/build
  directories.
- Project config, per-project ignore files, formatter options, and linter rule
  configuration are outside this baseline.
- CLI coverage includes explicit missing directory/glob failures and no-write
  behavior, plus discovery filtering, recursion, ordering, and de-duplication.

## Init Command
Status: DONE

## Install And Package Manager
Status: DONE
- Release baseline covers package-map generation from npm packuments, package
  `exports` strings, condition objects, and simple patterns, `module` / `main`
  fallback, dependency graph selection, optional and peer dependency warnings,
  corrupt archive cleanup, and no lifecycle script execution.
- Integrity coverage locks SRI parsing, unsupported or malformed SRI handling,
  legacy shasum fallback, multi-token first-token behavior, and mismatch
  failures when OpenSSL is available.
- Package `imports` / `#` specifiers remain unsupported even when present in
  installed package metadata. Separate lockfiles, registry auth, lifecycle
  scripts, persistent offline cache, and full npm resolver parity are outside
  this baseline.

## Doc Command
Status: DONE
- Release baseline covers Markdown, HTML, JSON, sqlite search, guide rendering,
  source-path mirroring, re-export behavior, examples, and stale-output cleanup.
- Public docs exclude private class fields/methods, TypeScript private members,
  `@internal` members, and file-level internal modules by default; these are
  available only through the maintainer-oriented `--include-private` flag.
- Full release-site polish, generated release notes, and broader documentation
  publishing workflows remain outside the command contract.

## REPL
Status: DONE
- Release baseline documents the smaller Fino REPL contract: embedded child
  realm evaluation, top-level await, heuristic multiline input, JSON-compatible
  value printing, error continuation, and `.exit` / Ctrl-C / Ctrl-D / EOF
  shutdown.
- Node-like history, completion, raw terminal editing, pluggable writers,
  PTY-specific behavior guarantees, and Node `repl` module parity are outside
  this baseline.
- Coverage locks CLI stdin behavior and embedded realm REPL mode, including
  rejection with `thread`, `process`, `remote`, and `watch`.

## Process And Process Class
Status: DONE
- Release baseline documents `fino:process` as POSIX-oriented metadata and
  child process spawning, not Node `process` or `child_process` parity.
- Child process coverage locks piped stdin/stdout/stderr, replaced `env`,
  `cwd`, single-use `wait()`, `kill()`, spawn failure cleanup, and high-volume
  stdout/stderr draining.
- Node-style stdio mode matrices, shell execution, detached children, IPC,
  uid/gid switching, Windows behavior, and Node process event APIs are outside
  this baseline.

## Process Argv Parser
Status: DONE

## TTY And Prompt
Status: DONE
- Release baseline documents the POSIX-oriented, line-based terminal contract:
  stdio TTY snapshots, direct `isatty(3)` checks, one-line stdin reads, and
  UTF-8 stdout/stderr writes.
- Prompt coverage locks text, confirm, and select behavior with validation
  retries, defaults, exact label/value and numeric selection, and
  non-interactive failure when no default exists.
- Raw mode, terminal sizing, color capability detection, cursor controls,
  signal-aware input, hidden input, multiline editing, cancellation, fuzzy
  choice search, and PTY-specific guarantees are outside this baseline.

## Config
Status: DONE

## Context And Topic
Status: DONE

## File System And Paths
Status: DONE
- Release baseline documents explicit `DiskFileSystem` usage and POSIX-first
  path semantics. Windows drive and namespace path parity is outside scope.
- Coverage locks whole-file string/byte reads and writes, errno-backed
  failures, handle lifecycle, directory entries, glob traversal, symlinks,
  hardlinks, metadata operations, and non-recursive `mkdir`.
- Node `fs` / `fs.promises` parity, global `fs`/`Buffer`, `rm()`, recursive
  remove helpers, recursive mkdir option shapes, and read/write encoding
  option matrices are outside this baseline.

## File Watch
Status: DONE

## Archive
Status: DONE
- Release baseline covers ZIP stored and deflate entries, tar and tar.gz
  regular files and directories, whole-archive in-memory mutation/extraction,
  extraction traversal protection, CRC validation, decompressed size limits,
  explicit extraction entry and total-byte limits, and compatibility-style ZIP
  and TAR fixtures with directory entries and metadata.
- ZIP64 records, ZIP data descriptors, tar PAX headers, GNU long-name records,
  symlink restoration, hardlink restoration, and streaming archive APIs are not
  supported in this baseline.
- Tar symlink and hardlink entries are skipped during extraction rather than
  restored.

## Database SQLite
Status: DONE
- Release baseline requires SQLite-enabled CI with `FINO_REQUIRE_SQLITE=1` so
  `libsqlite3` absence fails the lane instead of silently skipping coverage.
- Baseline covers core connection, statement, type mapping, transaction,
  extension-loading failure, vector-helper, and custom VFS-backed file I/O
  behavior, including persistence through the same provider and deterministic
  VFS file-control behavior.
- Backup, serialize/deserialize, busy-timeout convenience helpers, and broader
  WAL/concurrency parity are outside this baseline. SQLite-native behavior
  available through SQL or PRAGMA, such as `PRAGMA busy_timeout`, remains the
  supported path.

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
- Release baseline requires an OpenSSL-enabled CI lane with `FINO_REQUIRE_TLS=1`
  so TLS tests cannot silently skip in release coverage.
- Baseline covers TCP connect/upgrade, default certificate verification,
  `rejectUnauthorized`, custom CA trust, hostname mismatch rejection, ALPN
  negotiation, split reader/writer I/O, close behavior, and failed-upgrade socket
  ownership.
- Minimum/maximum protocol version knobs, cipher-suite policy knobs, public
  session reuse/cache APIs, and `TlsSocket` mTLS/client-certificate APIs are
  outside this baseline. Higher-level server or QUIC integrations document any
  mTLS support they expose separately.

## DNS Resolver
Status: TODO
- Missing Node resolver parity for broader RR helpers/options, TTL-return APIs, search domains, `ndots`, and resolv.conf options.
- Add IDNA handling and an explicit DNS cache policy beyond DNSSEC internals.
- DNS-over-TLS/HTTPS are not implemented.

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
Status: TODO
- HTTP parser/serializer coverage is strong, but Fetch/Web API parity is not WPT-level.
- Add broad conformance tests for full `Request`/`Response`/Body clone and form/body edge cases.

## HTTP/1
Status: DONE
- Release baseline covers HTTP/1 parser/serializer framing, keep-alive,
  pipelining order, request body draining after handler failures,
  `Expect: 100-continue`, unsupported expectation rejection, and
  server-side header and keep-alive idle timeout controls.
- The low-level H1 client driver is one-shot over an already-connected
  reader/writer pair; DNS, TCP/TLS setup, redirects, retries, pooling, and
  body wrapping belong to `fetch()` or the caller.

## HTTP Server
Status: DONE
- Release baseline covers IPv4 default binds, IPv6 literal inference,
  explicit IPv6 wildcard binds, backlog/reuse listener options, TLS ALPN
  dispatch, h2c upgrade dispatch, keep-alive, pipelining, and graceful close.
- `hostname` is a numeric bind address, not DNS resolution. `close()` stops
  accepting and waits for in-flight accepted connections without imposing a
  drain deadline.
- HTTP/1 header and keep-alive idle timeout controls are exposed through
  `serve()`; broader per-request cancellation policy remains application-owned.

## HTTP Driver Interfaces
Status: DONE

## HTTP/2
Status: DONE
- Release baseline requires a libnghttp2-enabled CI lane with
  `FINO_REQUIRE_H2=1` so HTTP/2 tests cannot silently skip release coverage.
- h2spec coverage runs against the runnable RFC 7540/7541 sections with a live
  allowlist baseline, duplicate overlapping cases are aggregated by final pass
  state, and omitted sections `6.6` and `6.9` have explicit release rationale
  plus deterministic local coverage.
- Server push/PUSH_PROMISE is outside this baseline, and request/response
  bodies remain buffered at the public `Request`/`Response` boundary.

## HTTP/2 Pool
Status: DONE
- Release baseline shares the `FINO_REQUIRE_H2=1` libnghttp2 CI lane used by
  HTTP/2 core tests.
- Baseline covers one reusable H2 entry per origin, multiplexed streams, TLS
  ALPN `fetch()` integration, origin-keyed reuse, idle eviction, trailers, and
  GOAWAY handling.
- Request and response bodies are buffered in memory, and GOAWAY/refused
  streams are surfaced to callers instead of retried automatically.

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
- Release baseline covers RFC 6455 client/server handshakes, subprotocol
  negotiation, masking rules, fragmentation, close validation, ping/pong,
  payload limits, UTF-8 validation, raw protocol violations, and the WHATWG
  `WebSocket` facade.
- Extension negotiation is intentionally absent: the server does not advertise
  `Sec-WebSocket-Extensions`, the client rejects extension offers, and RSV bits
  close with `1002`.
- RFC 8441 WebSocket over HTTP/2 and WebSocket over HTTP/3 are deferred; this
  baseline is HTTP/1.1 Upgrade only.

## EventSource
Status: DONE
- Release baseline covers EventSourceReader and EventSourceWriter SSE
  wire-format parsing/formatting, direct HTTP/1 socket/TLS EventSource
  connections, redirects, retry handling, Last-Event-ID resumption, and
  EventTarget dispatch.
- This is a runtime/server-side SSE client, not browser EventSource parity:
  browser credential modes, implicit cookie jars, and browser CORS enforcement
  are absent. `Set-Cookie` response headers are not retained; explicit
  caller-provided `Cookie` and authorization headers are supported.
- The client uses direct socket/TLS HTTP/1 flow rather than shared `fetch()`
  pooling or HTTP/2/HTTP/3 transport behavior.

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
- Release baseline covers common WHATWG URL behavior, URL property mutation,
  relative path/query/hash resolution, default port stripping, percent-encoding
  through setters, IDNA/Punycode hostnames, normalized IPv6, numeric IPv4 forms,
  file URL host/path serialization, and special versus non-special path shapes.
- URLSearchParams coverage locks construction forms, duplicate handling,
  two-argument `delete()` / `has()`, stable sorting, live iterator mutation,
  and URL/searchParams synchronization.
- URLPattern baseline is routing-oriented: object and string constructors,
  baseURL resolution, component matching, named parameters, wildcards, regexp
  groups, repeat modifiers, escaped literals, `hasRegExpGroups`, and
  percent-encoding boundaries are covered.
- Full WHATWG URL state-machine/tokenizer parity, the complete invalid-host
  matrix, and the URLPattern encoding callback / strict tokenizer edge behavior
  are explicit exclusions.

## Blob And File
Status: DONE

## FormData
Status: DONE
- Incoming multipart/FormData parsing is outside release scope.
- Live iterator mutation behavior is covered for entries, keys, values, default iteration, and forEach.
- Multipart serialization is eager, so large untrusted bodies remain a release-risk limit.

## Fetch Global
Status: TODO
- Browser policy behavior is incomplete: CORS, credentials, cache, cookies, keepalive, and default referrer handling.
- Add full Fetch/WPT-style coverage beyond local HTTP, redirects, abort, decompression, and integrity tests.
- Cover HTTPS/H2 fetch behavior in release CI.

## Web Streams
Status: DONE
- Release baseline covers readable, writable, transform, BYOB, tee,
  pipeTo/pipeThrough, queuing strategies, lock release, cancellation, and
  async iterator edges.
- `ReadableStream.prototype.values({ preventCancel })` is implemented and
  `[Symbol.asyncIterator]()` delegates to `values()` so early iterator return
  cancels by default.
- Transferable and structured-cloneable streams remain explicitly unsupported
  in this runtime; stream transfer parity is outside the release contract.

## Internal Reader And Writer Streams
Status: DONE

## Compression Streams
Status: DONE

## Messaging And BroadcastChannel
Status: DONE

## WebCrypto Global
Status: DONE
- Release baseline is an OpenSSL-backed WebCrypto subset gated by
  `cryptoAvailable`; release CI requires an OpenSSL-enabled lane so crypto tests
  exercise real backend behavior instead of skipping.
- Baseline covers digest, HMAC, AES-GCM, AES-CBC, RSA, ECDSA, ECDH, Ed25519,
  PBKDF2, HKDF, wrapping through supported AES-GCM paths, named WebCrypto error
  classes, and key-usage/JWK rejection edges.
- AES-CTR, AES-KW, full WPT coverage, and full WebCrypto algorithm parity are
  outside this baseline and reject with `NotSupportedError`.

## UUID
Status: DONE

## Security Random, Password, Tokens
Status: DONE

## Security Cookies, Headers, CORS
Status: DONE

## Security JWK, JWT, JWE
Status: TODO
- JWE is compact-only and narrow: missing JSON serialization, ECDH-ES, A192GCM, CBC-HS, PBES2, RSA-OAEP-384/512, and compression.
- JWT validation lacks algorithm allowlists and common registered-claim controls such as max age, required claims, `typ`, `jti`, and replay guidance.
- Harden JWK thumbprint/canonicalization for RFC 7638 parity, especially for private/symmetric key inputs.
- Add external JOSE vectors and cross-library interoperability tests.

## CSV Format
Status: DONE

## TOML Format
Status: DONE
- Release baseline covers TOML 1.0 scalar, array, table, inline table,
  array-of-table, datetime, corpus, and structural round-trip behavior.
- Parser hardening rejects invalid date/time ranges, malformed numeric tokens,
  unknown string escapes, duplicate keys/tables, and integer overflow unless
  `{ bigint: true }` is enabled.
- Stringification is normalized and does not preserve comments, original
  quoting style, or source ordering between scalar values and tables.
  Heterogeneous arrays are accepted as Fino values.

## YAML Format
Status: DONE
- Release baseline covers Fino's YAML 1.2 core-schema subset: scalars,
  mappings, sequences, flow styles, block scalars, document markers, anchors,
  aliases, merge keys, explicit core tags, complex keys, and corpus fixtures.
- Security contract rejects directives, local/custom tags, arbitrary object
  construction tags, undefined aliases, duplicate tag/anchor properties, and
  alias expansion beyond configured limits.
- Stringification emits normalized YAML and does not preserve comments,
  document markers, merge syntax, source anchor names, or text-exact shape.
  Broader yaml-test-suite parity remains outside this release baseline.

## XML Format
Status: DONE
- Release baseline covers XML tree parsing, namespace resolution and
  `namespaces: false`, internal entity expansion, external entity rejection by
  default, resolver opt-in behavior, expansion/depth limits, parseStream chunk
  behavior, corpus fixtures, and security fixtures.
- Serializer behavior is normalized and structural: prolog nodes, trailing
  comments/processing instructions, original entity spelling, and namespace
  declaration attributes consumed during namespace resolution are not preserved.
- `parseStream()` remains an accumulated-buffer SAX-style convenience API, not
  a true bounded-memory streaming parser. Broader validating DTD behavior and
  full XML 1.0 conformance-suite parity remain outside this release baseline.

## TypeScript Format
Status: DONE

## Markdown Format
Status: DONE

## Realm Core
Status: DONE
- Release baseline covers embedded lifecycle, `terminate()`,
  `[Symbol.dispose]`, `Realm.fromSource()`, caller import-rule preservation,
  and top-level error propagation across embedded, thread, and process realms.
- Core transfer coverage locks ArrayBuffer copy/transfer behavior, MessagePort
  transfer where supported, and explicit rejection of stream transfer entries
  on thread/process transport ports.
- Realm docs clarify that realms shape isolation and capabilities but are not a
  complete security boundary by themselves.

## Realm Pool
Status: DONE

## Realm Messaging And Self
Status: DONE
- Release baseline covers parent/child `realm.port` messaging plus child-side
  port visibility across embedded, thread, and process realms.
- Transfer coverage locks ArrayBuffer copy/transfer behavior, same-isolate and
  thread MessagePort transfer, process MessagePort rejection or explicit
  fallback behavior, ReadableStream transfer rejection, and unsupported
  structured-clone payload failures.
- Realm docs state that stream transfer and remaining structured-clone
  transferables are explicit exclusions in this baseline.

## Realm Process, Thread, Remote Modes
Status: DONE
- Release baseline covers thread and process realm lifecycle, messaging,
  `run()` / `call()` behavior, termination, top-level errors, serialization
  round-trips, import-rule/facade parity, and watch-mode coverage for local
  thread/process children.
- Remote realms are a trusted-cluster feature over the current WebSocket
  `fino:cluster` transport. Coverage locks active-cluster requirement,
  remote call/run/terminate behavior, import-rule/provider serialization, and
  facade scalar/read-stream/write-stream propagation.
- `thread`, `process`, and `remote` are mutually exclusive constructor modes;
  multiple isolated mode flags reject instead of silently applying precedence.
- Remote `watch` and `repl` modes are excluded. Hostile-peer and auth-failure
  coverage is deferred until cluster authentication exists.

## Realm Import And Provider Policies
Status: DONE
- Release baseline documents explicit `overrides` as the preferred policy API.
  Legacy `providers` and `blocked` are compatibility-only and are converted
  into import rules only when `overrides` is absent.
- Import-rule coverage locks `overrides` precedence, legacy provider/blocked
  fallback, `ImportMap.deny`, `ImportMap.inherit`, last-match-wins ordering,
  and provider config serialization/import-rule conversion.
- Realm docs state that realms are not a complete security boundary by
  themselves; import rules, facades, execution mode, privileges, placement, and
  authentication must be considered together for untrusted workloads.

## Cluster
Status: DONE
- Release baseline documents the trusted single-seed WebSocket cluster: one
  active connection per process, seed-backed spawn routing, seed-forwarded
  `PORT_MSG`, worker-loss propagation, remote call/run/terminate behavior, and
  idempotent `leaveCluster()`.
- Protocol and routing coverage locks JSON message validation, realm registry
  ownership cascades, spawn acknowledgement success/failure, node-down cleanup,
  pending spawn rejection, and ArrayBuffer-only cluster port transfer stores.
- Seed election, cluster authentication, hostile-peer handling, direct
  peer-to-peer `PORT_MSG`, and QUIC transport are outside this baseline.

## Test Framework
Status: DONE
- Release baseline covers TAP output, filters, skip reasons, lifecycle hooks,
  and captured stdout/stderr for failure diagnostics.
- `after()` errors are reported as failures with captured output, while
  `after()` still runs after body and setup failures.
- This is not Node test parity: `only`, `todo`, per-test timeout,
  concurrency, assertion-object subtests, and pluggable reporters are outside
  the release contract.

## Assertions
Status: DONE
- Deep equality covers Map, Set, Date, RegExp, enumerable symbol keys, typed arrays, and cyclic object graphs.
- Common assertion APIs include `match`, `doesNotThrow`, `doesNotReject`, strict aliases, and constructor-based error matching.

## Fetch Mocking
Status: DONE
- Scoped fetch mocking is explicitly fetch-only; timers, modules, filesystem, and generic spy/stub APIs are outside this release baseline.
- Passthrough, network-error, and abort behavior are covered by expectation helpers.
- Nested mock scopes and concurrent async scope isolation are covered.

## Bench Harness
Status: DONE
- Release baseline covers the current benc.h-style adaptive harness: sync and
  async measurements, setup/teardown outside the measured body, filtering,
  teardown on measurement failure, and human comparison output.
- Output is TAP-adjacent human text and `run()` does not return
  machine-readable benchmark data.
- Public warmup, fixed-iteration, fixed-sample, variance-threshold, JSON,
  pluggable reporter, CI regression gate, and release comparison workflows are
  outside this harness contract.

## OpenTelemetry API, SDK, Signals
Status: TODO
- Public API is Fino-native, not strict `@opentelemetry/api` / SDK parity.
- W3C baggage propagation is absent.
- OTLP support is HTTP JSON only; protobuf/gRPC and full standard env configuration are missing.
- Add semantic convention and upstream compatibility coverage.

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
