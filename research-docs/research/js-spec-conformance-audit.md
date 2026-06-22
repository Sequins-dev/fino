# JS Spec Conformance Audit

Documentation-only research pass over `js/` subsystems that claim, mirror, or
depend on external specifications. This audit reviews the current working tree
as-is and records deviations, incomplete areas, and missing test coverage for
prioritization. It does not include source fixes.

## Baseline

- WebTransport over HTTP/3 target: IETF
  `draft-ietf-webtrans-http3-15`, latest revision 2026-03-02, active Internet
  Draft in WG Last Call as of 2026-06-22:
  https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
- HTTP target: RFC 9110 semantics, RFC 9112 HTTP/1.1, RFC 9113 HTTP/2,
  RFC 9114 HTTP/3, RFC 7541 HPACK, RFC 9208 QPACK, and related QUIC RFCs:
  https://www.rfc-editor.org/rfc/rfc9110
- Web platform target: WHATWG/W3C living standards such as Fetch, DOM, HTML,
  Streams, URL, Encoding, Web Crypto, File API, and WebSocket:
  https://fetch.spec.whatwg.org/
- OpenTelemetry target: official OpenTelemetry specification 1.57.0:
  https://opentelemetry.io/docs/specs/otel/
- Other targets include POSIX/SUS, ZIP APPNOTE, ustar/pax tar, RFC 1950/1951/1952,
  RFC 7932, TOML 1.0.0, YAML 1.2.2, XML 1.0 and Namespaces in XML, JOSE RFCs,
  RFC 9562 UUID, SemVer 2.0.0, JSON Schema subset, SQLite C/VFS APIs, W3C Trace
  Context, npm package metadata, and Subresource Integrity.

## Inventory

| Area | Files | Specs | Current coverage | Result |
| --- | --- | --- | --- | --- |
| Web globals | `js/globals/**`, `js/realm/messaging.mts` | DOM, HTML, Fetch, URL, Streams, Encoding, WebCrypto, File API, RFC 6455 | `tests/internal/globals/**`, `tests/messaging/**`, `tests/realm/**`, `tests/net/eventsource.test.mts`, `tests/net/websocket.test.mts` | No open gaps |
| Networking | `js/net/**`, `js/internal/net/**`, `js/security/cors.mts` | HTTP RFCs, QUIC RFCs, DNS/DNSSEC, TLS, Fetch CORS, WebTransport H3 draft | `tests/net/**`, `tests/integration/h2spec*` | No open gaps |
| File/format/security | `js/file/**`, `js/archive.mts`, `js/compress.mts`, `js/format/**`, `js/security/**`, `js/uuid.mts`, `js/semver.mts`, `js/validate.mts` | POSIX, ZIP/tar/gzip, compression RFCs, CSV/TOML/YAML/XML, JOSE, UUID, SemVer, JSON Schema | `tests/file/**`, `tests/archive/**`, `tests/format/**`, `tests/security/**`, utility tests | No open gaps |
| Runtime/ecosystem | `js/process*`, `js/module.mts`, `js/internal/loader.mts`, `js/internal/package_manager.mts`, `js/opentelemetry/**`, `js/database/**`, `js/cluster/**`, `js/realm/**` | POSIX, ESM/package/SRI, OpenTelemetry, SQLite, WebTransport, WHATWG messaging | runtime, internal, OTel, SQLite, cluster, realm tests | No open gaps |

Existing release notes already document broad intentional non-parity areas:
server-side Fetch/CORS/cookie behavior, Fino-native OpenTelemetry instead of
upstream package parity, trusted cluster assumptions, gated DNSSEC live coverage,
HTTP/3/WebTransport scope, QUIC external interop gates, WebSocket extensions,
and non-browser runtime behaviors. Those are treated as accepted divergences
unless a finding below calls out missing documentation or contradictory tests.

## Findings

No open gaps.

## Test Coverage Priorities

No open priorities.

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
- YAML custom tags/object construction, TOML style preservation, XML prolog/node
  preservation, and JSON Schema advanced keywords are outside the current parser
  baselines.
- OpenTelemetry is Fino-native with OTLP/HTTP JSON export, not strict upstream
  package, OTLP protobuf, or OTLP/gRPC parity.
- Cluster assumes one trusted seed. Authentication, seed election, hostile-peer
  behavior, and direct peer-to-peer port delivery are deferred.
- QUIC external interop, advanced peer-controlled migration/VN, and some
  backend-specific TLS parity remain gated or deferred where existing research
  docs say so.
