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
Status: TODO
- Add Node ESM parity for package `imports` / `#` specifiers, directory index resolution, and direct package `exports` resolution.
- Enforce or document JSON import attribute behavior against current Node ESM expectations.
- Add file URL edge tests for percent-encoding and malformed URLs.

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
Status: TODO
- Package install is simplified npm support; add or document gaps for lockfiles, auth, lifecycle scripts, offline cache, and full npm resolver parity.
- Add tests for package `exports`, package `imports`, dependency graph edge cases, and integrity failures.

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
Status: TODO
- Add common ZIP/TAR features: ZIP64, data descriptors, tar PAX/GNU long names, symlinks, and hardlinks.
- Archive operations are not streaming-oriented and may be risky for large release inputs.
- Add compatibility tests against real-world archives.

## Database SQLite
Status: TODO
- Require SQLite-enabled release CI so tests cannot silently skip.
- Add parity for backup, serialize/deserialize, busy timeout, and broader concurrency/WAL behavior, or document omissions.
- Strengthen custom VFS documentation and provider compatibility tests.

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
- Add Node-like TLS policy knobs: min/max protocol, cipher suites, session reuse, and mTLS/client-cert API.
- Require an OpenSSL-enabled release CI lane for TLS tests.

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
Status: TODO
- Add `Expect: 100-continue` handling and server-side request/header timeout controls.
- Clarify one-shot H1 client behavior versus pooled/retry/redirect expectations.

## HTTP Server
Status: TODO
- Verify and fix IPv6 serving parity; `serve()` appears to build an IPv4 socket address even for IPv6 hostnames.
- Add backlog/reuse controls and request/header/idle timeout policy.
- Expose or document graceful close drain deadlines.

## HTTP Driver Interfaces
Status: DONE

## HTTP/2
Status: TODO
- Resolve the checked-in h2spec allowed-failure list before strict parity.
- Add coverage or explicit release rationale for omitted h2spec sections `6.6` and `6.9`.
- Replace buffered request/response body paths with streaming behavior, or document the limit.

## HTTP/2 Pool
Status: TODO
- Pool buffers request/response bodies; expose streaming responses or document the limit.
- Add retry behavior for eligible refused streams after GOAWAY.
- Require a libnghttp2-enabled release CI lane.

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
Status: TODO
- Add extension negotiation, including permessage-deflate, or document the omission.
- Add RFC 8441 WebSocket over HTTP/2 or HTTP/3 support, or explicitly defer.
- Add broader Web Platform style conformance tests.

## EventSource
Status: TODO
- Browser credential modes, cookie integration, and CORS enforcement are absent.
- Client uses direct socket/TLS HTTP/1 flow rather than shared fetch/H2/H3 transport behavior.
- Add WPT-style EventSource conformance coverage.

## HTTP App
Status: DONE

## Global Registry
Status: DONE

## EventTarget, Abort, Timers, Console
Status: DONE

## Encoding, TextEncoder, Structured Clone
Status: DONE

## URL, URLSearchParams, URLPattern
Status: TODO
- URL parser is hand-rolled and still has gaps versus the full WHATWG state machine.
- URLPattern omits the spec encoding callback and strict tokenizer edge behavior.
- Add WPT-derived URL and URLPattern edge fixtures.

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
Status: TODO
- WebCrypto is a useful subset, not full API parity.
- Track or document missing algorithms such as AES-CTR and AES-KW.
- Require an OpenSSL-enabled release CI lane for crypto tests.

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
Status: TODO
- Add support or explicit release exclusions for streams and remaining structured-clone transferables.
- Add more cross-mode transfer and failure-path coverage.

## Realm Process, Thread, Remote Modes
Status: TODO
- Remote realms depend on the current unauthenticated WebSocket cluster.
- Add hostile-peer/auth-failure coverage once cluster authentication exists.

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
