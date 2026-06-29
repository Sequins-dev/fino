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
| Web globals | `js/globals/**`, `js/stream.ts`, `js/realm/messaging.ts` | Spec-backed web APIs plus Fino adapters | Fetch, DOM, HTML messaging, Streams, URL, Encoding, WebCrypto, File API, RFC 6455 | `tests/internal/globals/**`, `tests/messaging/**`, `tests/realm/**`, `tests/net/eventsource.test.ts`, `tests/net/websocket.test.ts` | No open findings |
| Networking protocols | `js/net/**`, `js/internal/net/**`, `js/security/cors.ts` | Spec-backed protocols; provider internals are spec-adjacent | HTTP RFCs, QUIC RFCs, DNS/DNSSEC, TLS, Fetch CORS, WebTransport H3 draft | `tests/net/**`, `tests/integration/h2spec*`, QUIC research docs | No open findings |
| Formats, files, archives, compression | `js/format/**`, `js/file/**`, `js/archive.ts`, `js/compress.ts` | Format parsers are spec-backed; file helpers are POSIX-adjacent | CSV, TOML, YAML, XML, ZIP, tar, compression RFCs, POSIX | `tests/format/**`, `tests/archive/**`, `tests/compress.test.ts`, `tests/file/**` | No open findings |
| Security, crypto, identifiers, validation | `js/security/**`, `js/globals/crypto.ts`, `js/uuid.ts`, `js/validate.ts` | Spec-backed crypto/security formats with documented subsets | WebCrypto, JOSE/JWK/JWT/JWE, UUID, JSON Schema, Fetch CORS | `tests/internal/globals/crypto*.test.ts`, `tests/security/**`, `tests/uuid.test.ts`, `tests/validate.test.ts` | No open findings |
| Runtime, modules, process, packaging | `js/process*`, `js/module.ts`, `js/internal/loader.ts`, `js/internal/package_manager.ts`, `js/tty/**` | Spec-adjacent runtime APIs and package metadata | POSIX/SUS CLI, ECMA modules, npm metadata, SRI | `tests/process/**`, `tests/runtime/**`, `tests/internal/package-manager-integrity.test.ts`, `tests/tty.test.ts` | No open findings |
| Observability, database, cluster, realm | `js/opentelemetry/**`, `js/database/**`, `js/cluster/**`, `js/realm/**` | Spec-backed where protocol/wire/API claims exist; Fino orchestration is spec-adjacent | OpenTelemetry, W3C Trace Context/Baggage, SQLite C/VFS, WebTransport, HTML messaging | `tests/opentelemetry*`, `tests/sqlite*`, `tests/cluster/**`, `tests/realm/**` | No open findings |

## Closed Conformance Evidence

### Web Streams

The WHATWG Streams release subset is covered by a focused conformance map
against the Streams Standard living specification. `js/globals/webstreams.ts`
links the authoritative spec and documents the supported implementation model:
readable, writable, transform, byte/BYOB, queuing strategy, pipe, tee, and
non-transferable stream behavior.

| Spec area | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| Readable streams, default readers, locking, cancellation, and async iteration | `ReadableStream`, `ReadableStreamDefaultReader` | `tests/internal/globals/webstreams.test.ts`: basics, cancellation, lock errors, invalid receivers, released-reader errors, closed promise timing | Covered |
| Byte streams and BYOB readers | `ReadableByteStreamController`, `ReadableStreamBYOBReader`, `ReadableStreamBYOBRequest` | `tests/internal/globals/webstreams.test.ts`: BYOB reads, `byobRequest`, pending read release, cancel behavior, detached view rejection | Covered |
| Writable streams, writers, close/abort, backpressure, and `ready` | `WritableStream`, `WritableStreamDefaultWriter`, `WritableStreamDefaultController` | `tests/internal/globals/webstreams.test.ts`: serialized writes, abort, close, desired size, `ready`, released-writer promise behavior | Covered |
| Transform streams and controllers | `TransformStream`, `TransformStreamDefaultController` | `tests/internal/globals/webstreams.test.ts`: transform, flush, terminate, error propagation, `pipeThrough` | Covered |
| Piping, prevent flags, abort signals, and tee cancellation | `pipeTo()`, `pipeThrough()`, `tee()` | `tests/internal/globals/webstreams.test.ts`: locked-stream rejection, preventClose/preventAbort/preventCancel, already-aborted signals, composite tee cancellation | Covered |
| Queuing strategies and backpressure | `CountQueuingStrategy`, `ByteLengthQueuingStrategy` | `tests/internal/globals/webstreams.test.ts`: highWaterMark, size algorithms, desiredSize, pull scheduling | Covered |
| Transferable streams | Structured clone and realm messaging integration | `tests/internal/globals/encoding.test.ts`, `tests/realm/transfer.test.ts`; audit non-goal says streams are not general-purpose transferable surfaces | Intentional limit |

## Test Coverage Priorities

| Priority | Subsystem | Coverage to add or strengthen |
| --- | --- | --- |
| P1 | Cross-subsystem conformance | Keep external protocol suites and focused raw-wire regressions running as spec-backed behavior changes. |

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
