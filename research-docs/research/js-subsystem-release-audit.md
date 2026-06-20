# JS Subsystem Release Audit

Fresh strict-parity release audit for `js/`, related tests, docs, and
benchmarks. This tracker is intended to guide follow-up hardening before
release.

`DONE` means the subsystem looks release-ready from inspection.
`TODO` means visible feature, spec, documentation, CI, benchmark, or test gaps
remain. Entries are intentionally brief and actionable.

## Runtime Core, Bootstrap, Main
Status: TODO
- Define and test unhandled rejection and `reportError` behavior against Web expectations.
- Document runtime-global non-goals such as minimal `navigator` and no Node global `process`.
- Add root CLI coverage for bootstrap error propagation, not only realm paths.

## Loader, Import Meta, Module
Status: TODO
- Add Node ESM parity for package `imports` / `#` specifiers, directory index resolution, and direct package `exports` resolution.
- Enforce or document JSON import attribute behavior against current Node ESM expectations.
- Add file URL edge tests for percent-encoding and malformed URLs.

## Runtime Loop And Backends
Status: TODO
- Publish a backend parity matrix for kqueue, io_uring, and poll fallback.
- Add CI coverage per supported backend; current tests branch around unsupported features.
- Clarify release risk for platform-only APIs such as `proc`, `vnode`, `submit`, and synchronous poll fallback completions.

## Runtime Parent RPC
Status: DONE

## CLI Root And Run Commands
Status: TODO
- Add broader command tests for script argument passthrough and failing glob/directory edge cases.
- Document root/run behavior where it intentionally differs from Node or shell runners.

## Test Command
Status: TODO
- Add coverage for reporter output, filtered runs, hook failure behavior, and CLI exit codes.
- Decide whether Node test parity features belong here or remain out of scope.

## Bench Command
Status: TODO
- Add release tests for filtering, failure output, and machine-readable benchmark results.
- Document timing stability expectations and comparison workflow.

## Fmt, Lint, And Tooling
Status: TODO
- Add project config and ignore-file support, or document the hardcoded discovery contract.
- Add failing glob/directory edge tests for formatter and linter commands.

## Init Command
Status: DONE

## Install And Package Manager
Status: TODO
- Package install is simplified npm support; add or document gaps for lockfiles, auth, lifecycle scripts, offline cache, and full npm resolver parity.
- Add tests for package `exports`, package `imports`, dependency graph edge cases, and integrity failures.

## Doc Command
Status: TODO
- Generated docs still expose noisy private-member stubs that should not ship as polished release docs.
- Add regression coverage for public/private filtering and module-level JSDoc completeness.

## REPL
Status: TODO
- Add Node-like history, completion, raw terminal editing, and richer value inspection, or document the smaller contract.
- Add PTY-backed tests for interactive behavior.

## Process And Process Class
Status: TODO
- `fino:process` is POSIX-oriented, not Node `process` parity; document this prominently.
- Add common child-process options or document gaps for stdio modes, shell, detached, IPC, uid/gid, and Windows support.

## Process Argv Parser
Status: DONE

## TTY And Prompt
Status: TODO
- Add raw mode, terminal size, color capability, cursor controls, and signal-aware input, or document omissions.
- Prompt lacks hidden input, multiline editing, cancellation, choice search, and real TTY integration tests.
- Add PTY-backed release tests; current coverage uses pipes and injected sessions.

## Config
Status: DONE

## Context And Topic
Status: TODO
- Add explicit context propagation tests for timers, I/O callbacks, event listeners, and native callback boundaries.
- Clarify docs where behavior differs from Node `AsyncLocalStorage`.
- Add tests for `execution-flow:error` subscribers and async iterator disposal under queued messages.

## File System And Paths
Status: TODO
- Not Node `fs` / `fs.promises` parity: missing key option shapes, `rm`, recursive mkdir behavior, Buffer/encoding variants, and broader fd APIs.
- Paths are POSIX-first; Windows/path namespace parity is incomplete.

## File Watch
Status: TODO
- Watch API is runtime-specific and lacks Node/Web parity around AbortSignal, persistence, encoding, and recursive guarantees.
- Add platform-specific watch behavior tests for release CI.

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
Status: TODO
- Complete Brotli streaming behavior when Brotli support is available.
- Add decompression output caps for untrusted inputs, or make the release limitation explicit.
- Add advanced options or document gaps for dictionaries, flush strategy, window tuning, and level parity.

## Template
Status: TODO
- Not full Mustache parity: no partials, delimiter changes, standalone trimming, or lambda behavior.
- Make the non-parity contract explicit in release docs.

## Semver
Status: TODO
- Covers core SemVer and common ranges, but not full npm `semver` parity.
- Add or document helpers/options such as loose, coerce, inc, diff, minVersion, intersects, subset, sort, and `includePrerelease`.

## Parsing Scanner
Status: DONE

## Validation
Status: TODO
- JSON Schema support is partial: no `$ref`, `$defs`, `oneOf`, `allOf`, `not`, pattern properties, dependencies, or unevaluated keywords.
- Unknown keywords are ignored, which can hide unsupported schema intent.
- Format validation is limited and should not be presented as full JSON Schema parity.

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
Status: TODO
- Use DOMException-compatible AbortError and TimeoutError reasons.
- Performance is limited to `now`, `timeOrigin`, and `toJSON`; timeline APIs are absent.
- Console table and formatting remain intentionally small and not browser/Node parity.

## Encoding, TextEncoder, Structured Clone
Status: TODO
- TextDecoder is UTF-8 only; legacy WHATWG encodings are unsupported.
- structuredClone transfer is limited to ArrayBuffer; MessagePort and streams are unsupported.
- AggregateError cloning does not preserve `.errors`.

## URL, URLSearchParams, URLPattern
Status: TODO
- URL parser is hand-rolled and still has gaps versus the full WHATWG state machine.
- URLPattern omits the spec encoding callback and strict tokenizer edge behavior.
- Add WPT-derived URL and URLPattern edge fixtures.

## Blob And File
Status: DONE

## FormData
Status: TODO
- Incoming multipart/FormData parsing is outside release scope.
- Verify live iterator mutation behavior against FormData expectations.
- Multipart serialization is eager, so large untrusted bodies remain a release-risk limit.

## Fetch Global
Status: TODO
- Browser policy behavior is incomplete: CORS, credentials, cache, cookies, keepalive, and default referrer handling.
- Add full Fetch/WPT-style coverage beyond local HTTP, redirects, abort, decompression, and integrity tests.
- Cover HTTPS/H2 fetch behavior in release CI.

## Web Streams
Status: TODO
- Transferable and structured-cloneable streams are unsupported.
- `ReadableStream.prototype.values({ preventCancel })` is missing or unverified.
- Add WPT-derived stream conformance fixtures.

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
Status: TODO
- Add official TOML conformance coverage beyond the small fixture corpus.
- Harden date/time and numeric edge-case validation for TOML 1.0.
- Clarify string escaping, array homogeneity, and preservation limitations.

## YAML Format
Status: TODO
- Fixture set explicitly defers cases; add broader YAML test-suite parity.
- Cover custom tags, directives, schema edge cases, indentation/chomping, and complex alias behavior.
- Keep security coverage while improving YAML 1.2 conformance.

## XML Format
Status: TODO
- Streaming parser reparses accumulated input rather than providing true bounded streaming behavior.
- Add XML conformance coverage for DTD/XML 1.0 edge cases.
- Deepen round-trip tests for namespace, prolog, comment, entity, and serializer preservation.

## TypeScript Format
Status: DONE

## Markdown Format
Status: TODO
- Not CommonMark or GFM parity by design.
- Add or document missing nested lists, blockquotes, tables, Setext headings, thematic breaks, HTML blocks, and full emphasis/link grammar.
- Add a CommonMark/GFM fixture corpus or clearly declare the smaller safe-Markdown contract.

## Realm Core
Status: TODO
- Coverage is broad, but messaging transfer still lacks streams and some structured-clone transferables.
- Clarify that realms are not a security boundary.

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
Status: TODO
- Provider config is legacy alongside import rules; clarify policy precedence and safe defaults in release docs.

## Cluster
Status: TODO
- Docs explicitly defer seed election, cluster authentication, P2P `PORT_MSG`, and QUIC transport.
- Add hostile-peer and auth-failure tests.

## Test Framework
Status: TODO
- TAP runner is usable, but not Node test parity: no `only`, `todo`, per-test timeout, concurrency, subtest API, or pluggable reporters.
- `after()` errors are swallowed, which is documented but release-risky for cleanup failures.

## Assertions
Status: TODO
- Deep equality is limited to plain objects/arrays; add Map, Set, Date, RegExp, symbols, typed arrays, and cycle handling.
- Add common assertion APIs such as `match`, `doesNotThrow`, `doesNotReject`, strict aliases, and constructor-based error matching.

## Fetch Mocking
Status: TODO
- Scoped fetch mocking is solid but fetch-only; add or document missing timers, modules, filesystem, and generic spy/stub APIs.
- Add passthrough, network-error, and abort-signal helpers.
- Add nested mock scope and concurrent scope isolation tests.

## Bench Harness
Status: TODO
- Add warmup control, fixed iteration/sample modes, async setup/teardown, machine-readable output, and variance thresholds.
- Complete release comparison workflows and CI regression gates.

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
