# JS Spec Conformance Audit

Documentation-only research pass over `js/` subsystems that claim, mirror, or
depend on external specifications. This audit reviews the current working tree
as-is and records material deviations, incomplete areas, missing conformance
coverage, and accepted subset boundaries. It does not include source fixes.

## Baseline

- WebTransport over HTTP/3 target: IETF `draft-ietf-webtrans-http3-15`:
  https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
- HTTP target: RFC 9110 semantics, RFC 9112 HTTP/1.1, RFC 9113 HTTP/2,
  RFC 9114 HTTP/3, RFC 7541 HPACK, RFC 9208 QPACK, RFC 9297 HTTP Datagrams,
  and QUIC RFCs 9000, 9001, 9002, and 9221.
- Web platform target: WHATWG/W3C Fetch, DOM, HTML messaging, Streams, URL,
  Encoding, Web Crypto, File API, WebSocket, and Server-Sent Events.
- Formats and security targets: RFC 4180 CSV, TOML 1.0.0, YAML 1.2.2 core
  schema, XML 1.0, Namespaces in XML, ZIP APPNOTE, POSIX ustar/pax tar,
  RFCs 1950/1951/1952/7932 compression, JOSE RFCs 7515/7516/7517/7519/7638,
  RFC 9562 UUID, SemVer 2.0.0, JSON Schema, and Subresource Integrity.
- Runtime and ecosystem targets: POSIX/SUS command-line conventions, ECMA
  module semantics where claimed by the loader, npm package metadata, SQLite C
  and VFS APIs, OpenTelemetry specs, W3C Trace Context, and W3C Baggage.

## Inventory

| Area | Files | Classification | Specs | Coverage reviewed | Result |
| --- | --- | --- | --- | --- | --- |
| Web globals | `js/globals/**`, `js/stream.mts`, `js/realm/messaging.mts` | Spec-backed web APIs plus Fino adapters | Fetch, DOM, HTML messaging, Streams, URL, Encoding, WebCrypto, File API, RFC 6455 | `tests/internal/globals/**`, `tests/messaging/**`, `tests/realm/**`, `tests/net/eventsource.test.mts`, `tests/net/websocket.test.mts` | Finding `JS-SPEC-002` |
| Networking protocols | `js/net/**`, `js/internal/net/**`, `js/security/cors.mts` | Spec-backed protocols; provider internals are spec-adjacent | HTTP RFCs, QUIC RFCs, DNS/DNSSEC, TLS, Fetch CORS, WebTransport H3 draft | `tests/net/**`, `tests/integration/h2spec*`, QUIC research docs | Finding `JS-SPEC-005` |
| Formats, files, archives, compression | `js/format/**`, `js/file/**`, `js/archive.mts`, `js/compress.mts` | Format parsers are spec-backed; file helpers are POSIX-adjacent | CSV, TOML, YAML, XML, ZIP, tar, compression RFCs, POSIX | `tests/format/**`, `tests/archive/**`, `tests/compress.test.mts`, `tests/file/**` | No open findings |
| Security, crypto, identifiers, validation | `js/security/**`, `js/globals/crypto.mts`, `js/uuid.mts`, `js/validate.mts` | Spec-backed crypto/security formats with documented subsets | WebCrypto, JOSE/JWK/JWT/JWE, UUID, JSON Schema, Fetch CORS | `tests/internal/globals/crypto*.test.mts`, `tests/security/**`, `tests/uuid.test.mts`, `tests/validate.test.mts` | Finding `JS-SPEC-012` |
| Runtime, modules, process, packaging | `js/process*`, `js/module.mts`, `js/internal/loader.mts`, `js/internal/package_manager.mts`, `js/tty/**` | Spec-adjacent runtime APIs and package metadata | POSIX/SUS CLI, ECMA modules, npm metadata, SRI | `tests/process/**`, `tests/runtime/**`, `tests/internal/package-manager-integrity.test.mts`, `tests/tty.test.mts` | No open findings |
| Observability, database, cluster, realm | `js/opentelemetry/**`, `js/database/**`, `js/cluster/**`, `js/realm/**` | Spec-backed where protocol/wire/API claims exist; Fino orchestration is spec-adjacent | OpenTelemetry, W3C Trace Context/Baggage, SQLite C/VFS, WebTransport, HTML messaging | `tests/opentelemetry*`, `tests/sqlite*`, `tests/cluster/**`, `tests/realm/**` | No open findings |

## Findings

### JS-SPEC-002

- Subsystem/files: Web globals, `js/globals/webstreams.mts`, `js/stream.mts`.
- Spec target and section: WHATWG Streams default reader, BYOB reader,
  backpressure, tee, pipe, transfer, and queuing strategy algorithms.
- Expected behavior: Supported stream surfaces should match locking, promise
  timing, cancellation, close/error propagation, BYOB view handling, and
  backpressure algorithms for the claimed API subset.
- Observed implementation/test gap: The implementation is broad and includes
  BYOB, transform, queuing strategies, and pipe operations, but the documented
  conformance evidence is local focused tests rather than a section-by-section
  Streams map. Transfer and structured clone are explicitly unsupported, but
  remaining algorithmic differences such as microtask timing and BYOB detached
  buffer behavior are not enumerated.
- Priority: P1.
- Suggested follow-up: Build a Streams requirement map from the WHATWG spec and
  add focused tests for promise timing, release-lock behavior, BYOB edge cases,
  pipe abort/prevent flags, and tee cancellation.

### JS-SPEC-005

- Subsystem/files: Networking, `js/internal/net/http/h2/**`,
  `tests/integration/h2spec-allowed-failures.json`.
- Spec target and section: RFC 9113 HTTP/2 framing, stream state, SETTINGS,
  and request header validation.
- Expected behavior: External h2spec cases should pass or have narrowly
  justified, tracked release exceptions that still prove equivalent wire
  behavior locally.
- Observed implementation/test gap: The allowed-failures file still contains
  many h2spec cases across preface, frame size, stream states, SETTINGS, PING,
  CONTINUATION, pseudo-header validation, and content-length mismatch behavior.
  Several entries cite timing-sensitive EOF before GOAWAY/RST frames. Local raw
  tests cover representative cases, but the external conformance lane still
  reports visible failures.
- Priority: P0.
- Suggested follow-up: Keep each allowed h2spec failure as an open conformance
  item until either h2spec passes or the external harness records the exact
  expected frame before close. Group the failures by RFC 9113 section in the
  h2spec audit so release gates can burn them down independently.

### JS-SPEC-012

- Subsystem/files: Security/crypto, `js/globals/crypto.mts`,
  `tests/internal/globals/crypto*.test.mts`.
- Spec target and section: W3C Web Cryptography API algorithm normalization,
  key import/export, usages, and DOMException error names.
- Expected behavior: For every supported algorithm, WebCrypto should match the
  spec's normalization, key usage checks, extractability checks, error names,
  and input conversions.
- Observed implementation/test gap: The module documents a useful subset and
  explicitly excludes AES-CTR, AES-KW, full WPT coverage, and full algorithm
  parity. However, several unsupported paths throw generic `Error` in code
  paths while the module-level contract says unsupported algorithms and key
  formats reject with `NotSupportedError`, malformed key material with
  `DataError`, and backend failures with `OperationError`.
- Priority: P0.
- Suggested follow-up: Audit every `throw new Error` in `SubtleCrypto` methods
  against WebCrypto error names and add tests asserting named errors for
  unsupported algorithms, invalid key usages, non-extractable export/wrap, and
  malformed import material.

## Test Coverage Priorities

| Priority | Subsystem | Coverage to add or strengthen |
| --- | --- | --- |
| P0 | HTTP/2 | Burn down `tests/integration/h2spec-allowed-failures.json`; capture exact GOAWAY/RST behavior for timing-sensitive failures. |
| P0 | WebCrypto | Assert WebCrypto named errors and key-usage checks for every supported algorithm and unsupported path. |
| P1 | Web Streams | Add WHATWG Streams algorithm coverage for BYOB, lock release, promise timing, `tee()`, and pipe abort/prevent flags. |

## Accepted Divergences And Non-Goals

- `fetch()` and `EventSource` are server-side transports, not browser policy
  engines. Browser CORS enforcement, implicit cookies, opaque responses, cache
  modes, and default credential/referrer behavior are intentionally absent.
- WebSocket extensions and RFC 8441 WebSocket-over-H2/H3 are deferred.
- `TextDecoder` is UTF-8-only in the current release scope.
- Streams and `MessagePort` transfer through global `structuredClone()` are not
  general-purpose transferable surfaces in this runtime.
- ZIP64, ZIP data descriptors, tar PAX/GNU long-name entries, tar symlink and
  hardlink restoration, and streaming archive APIs are outside the archive
  baseline.
- YAML custom tags/object construction, YAML directives, TOML style
  preservation, XML validation/prolog round-tripping, and JSON Schema advanced
  keywords are outside the current parser baselines.
- OpenTelemetry is Fino-native with OTLP/HTTP JSON export, not strict upstream
  package, OTLP protobuf, or OTLP/gRPC parity.
- Cluster assumes one trusted seed. Authentication, seed election,
  hostile-peer behavior, and direct peer-to-peer port delivery are deferred.
- QUIC optional peer lanes, advanced peer-controlled migration/VN, and some
  backend-specific TLS parity remain gated or deferred where existing research
  docs say so.
