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
| Web globals | `js/globals/**`, `js/realm/messaging.mts` | DOM, HTML, Fetch, URL, Streams, Encoding, WebCrypto, File API, RFC 6455 | `tests/internal/globals/**`, `tests/messaging/**`, `tests/realm/**`, `tests/net/eventsource.test.mts`, `tests/net/websocket.test.mts` | Gaps WEB-001 and WEB-003 |
| Networking | `js/net/**`, `js/internal/net/**`, `js/security/cors.mts` | HTTP RFCs, QUIC RFCs, DNS/DNSSEC, TLS, Fetch CORS, WebTransport H3 draft | `tests/net/**`, `tests/integration/h2spec*` | Gaps NET-001 to NET-004 |
| File/format/security | `js/file/**`, `js/archive.mts`, `js/compress.mts`, `js/format/**`, `js/security/**`, `js/uuid.mts`, `js/semver.mts`, `js/validate.mts` | POSIX, ZIP/tar/gzip, compression RFCs, CSV/TOML/YAML/XML, JOSE, UUID, SemVer, JSON Schema | `tests/file/**`, `tests/archive/**`, `tests/format/**`, `tests/security/**`, utility tests | No open gaps |
| Runtime/ecosystem | `js/process*`, `js/module.mts`, `js/internal/loader.mts`, `js/internal/package_manager.mts`, `js/opentelemetry/**`, `js/database/**`, `js/cluster/**`, `js/realm/**` | POSIX, ESM/package/SRI, OpenTelemetry, SQLite, WebTransport, WHATWG messaging | runtime, internal, OTel, SQLite, cluster, realm tests | No open gaps |

Existing release notes already document broad intentional non-parity areas:
server-side Fetch/CORS/cookie behavior, Fino-native OpenTelemetry instead of
upstream package parity, trusted cluster assumptions, gated DNSSEC live coverage,
HTTP/3/WebTransport scope, QUIC external interop gates, WebSocket extensions,
and non-browser runtime behaviors. Those are treated as accepted divergences
unless a finding below calls out missing documentation or contradictory tests.

## Findings

### WEB-001: Event handler properties run outside `EventTarget` dispatch

- Files: `js/globals/broadcast-channel.mts`, `js/globals/eventsource.mts`,
  `js/globals/websocket.mts`
- Spec target: DOM `EventTarget` dispatch and HTML/WebSocket/EventSource event
  handler attributes.
- Expected behavior: `onmessage`, `onopen`, `onerror`, and similar handler
  properties should behave like listener-list event handler attributes, with
  `currentTarget`, `target`, `eventPhase`, ordering, and removal semantics
  matching dispatch.
- Current behavior: these classes dispatch an event and then manually invoke the
  handler property, so callbacks can observe post-dispatch event state and a
  separate ordering path.
- Coverage gap: no tests assert handler/listener ordering, `currentTarget`,
  `target`, or `eventPhase` for these handler properties.
- Priority: P1
- Follow-up: implement handler slots as listener-list entries and add parity
  tests for BroadcastChannel, EventSource, and WebSocket.

### WEB-003: Transferred ports are not reconstructed inside `event.data`

- Files: `js/globals/messaging.mts`
- Spec target: HTML structured serialize with transfer.
- Expected behavior: if a transferred `MessagePort` appears inside the message
  graph, the receiver should observe the transferred endpoint in `event.data`.
- Current behavior: the implementation exposes transferred ports through
  `MessageEvent.ports`; the global structured clone path rejects MessagePort
  values inside the data graph.
- Coverage gap: no browser-parity test for `{ port }` plus `[port]`.
- Priority: P2
- Follow-up: decide whether message-graph port transfer is release scope; if so,
  add an internal transfer map for `MessagePort.postMessage()`.

### NET-001: HTTP/3 request pseudo-header validation is incomplete

- Files: `js/internal/net/http/h3/server.mts`
- Spec target: RFC 9114 request pseudo-headers, RFC 9110 request control data,
  and extended CONNECT rules.
- Expected behavior: non-CONNECT requests require valid `:method`, `:scheme`,
  and `:path`; `:protocol` applies only to extended CONNECT; duplicates,
  pseudo-after-regular, and context-invalid pseudo-headers should reject the
  stream before handler dispatch.
- Current behavior: dispatch rejects missing method/path, but missing `:scheme`
  falls back to `https`, and `:protocol` can be accepted on ordinary requests.
- Coverage gap: no raw H3 malformed pseudo-header tests comparable to H2.
- Priority: P1
- Follow-up: validate in H3 end-headers before dispatch and add raw malformed H3
  tests.

### NET-002: WebTransport over H3 does not enforce peer SETTINGS readiness

- Files: `js/internal/net/http/h3/session.mts`,
  `js/internal/net/http/h3/client.mts`, `js/internal/net/http/h3/server.mts`,
  `js/internal/net/http/h3/webtransport.mts`
- Spec target: WebTransport over HTTP/3 draft-15, RFC 9220, RFC 9297.
- Expected behavior: WebTransport sessions should be established only after the
  peer advertises required settings for extended CONNECT, H3 DATAGRAM, and
  WebTransport enablement.
- Current behavior: peer settings are tracked, but client/server setup does not
  appear to gate success on complete readiness.
- Coverage gap: no negative tests for missing/partial peer settings.
- Priority: P1
- Follow-up: gate setup on complete peer settings or explicitly document a
  temporary interop mode.

### NET-003: Incoming WebTransport unidirectional streams are not H3-routed

- Files: `js/internal/net/http/h3/server.mts`,
  `js/internal/net/http/h3/client.mts`, `js/net/http/webtransport.mts`
- Spec target: WebTransport over HTTP/3 stream mapping.
- Expected behavior: incoming bidirectional and unidirectional QUIC streams
  should be demultiplexed by WebTransport stream type/session ID and delivered
  to the correct WebTransport stream queues.
- Current behavior: public WebTransport can route both kinds once handed a stream,
  but H3 client/server paths appear to route only bidirectional WebTransport
  streams; remote unidirectional streams are passed to nghttp3 as H3/QPACK/control
  input.
- Coverage gap: no end-to-end H3 tests where either peer creates a WebTransport
  unidirectional stream and the other reads it from `incomingUnidirectionalStreams`.
- Priority: P1
- Follow-up: maintain a session map in H3 client/server drivers and demux
  unidirectional streams before nghttp3 processing.

### NET-004: HTTP/2 content-length mismatch can reach handlers before rejection

- Files: `js/internal/net/http/h2/server.mts`,
  `tests/integration/h2spec-allowed-failures.json`
- Spec target: RFC 9113/RFC 7540 request validity.
- Expected behavior: mismatched `content-length` and DATA length should reject
  without exposing a successful request body to application logic.
- Current behavior: source inspection suggests the handler is invoked before EOF
  validation; tests assert wire reset but not handler isolation. The h2spec
  allowlist rationale says the handler is not invoked, which appears inconsistent.
- Coverage gap: no regression test verifies handler non-invocation.
- Priority: P2
- Follow-up: decide whether early streaming is intentional; fix behavior or
  update documentation and tests.

## Test Coverage Priorities

- P1 web platform: event-handler attribute dispatch parity.
- P1 networking: H3 malformed pseudo-header tests, WebTransport missing SETTINGS
  rejection, and end-to-end WebTransport unidirectional stream routing.

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
