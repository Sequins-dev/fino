# WebTransport over HTTP/3

## Standards Target

- Target: `draft-ietf-webtrans-http3-15`, "WebTransport over HTTP/3".
- Status checked: IETF Datatracker lists revision 15 as an active Internet-Draft, last updated 2026-03-08 with latest revision 2026-03-02, in WG Last Call.
- Related standards:
  - RFC 9000: QUIC transport.
  - RFC 9114: HTTP/3.
  - RFC 9221: QUIC DATAGRAM.
  - RFC 9297: HTTP Datagram.

## Current Repo State

- QUIC stream and DATAGRAM support already exists in `fino:net/quic`.
- HTTP/3 client/server/session code lives under `js/internal/net/http/h3/`.
- Public HTTP APIs live in `js/net/http/`.
- WebTransport is exposed through `fino:net/http/webtransport`,
  `HttpClient.webtransport()`, `HttpSession.webtransport()`, and
  `app.webtransport()`.

## API Plan

- Add `fino:net/http/webtransport`.
- Expose standards-shaped `WebTransport` with:
  - `ready: Promise<void>`, `closed: Promise<WebTransportCloseInfo>`, and `draining: Promise<void>`.
  - `datagrams: WebTransportDatagramDuplexStream`.
  - `incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>`.
  - `incomingUnidirectionalStreams: ReadableStream<WebTransportReceiveStream>`.
  - `createBidirectionalStream()`, `createUnidirectionalStream()`.
  - `close({ closeCode, reason })`.
  - `responseHeaders`, `protocol`, `reliability`, `congestionControl`, and `supportsReliableOnly`.
- Add `IncomingWebTransportRequest` with `incoming.kind === 'webtransport'`.
- Add `app.webtransport(path, ...middleware, handler)` matching `app.websocket()` route/context behavior.
- Add `HttpClient.webtransport()` and `HttpSession.webtransport()` with H3-only enforcement.
- Register `WebTransport` as a runtime global.

## Implementation Phases

1. Public API shape and fail-fast behavior.
2. H3 SETTINGS support:
   - `SETTINGS_WT_ENABLED = 0x2c7cf000`
   - `SETTINGS_ENABLE_CONNECT_PROTOCOL = 0x08`
   - `SETTINGS_H3_DATAGRAM = 0x33`
3. HTTP Datagram payload framing:
   - Quarter Stream ID varint.
   - Application payload.
4. Extended CONNECT routing:
   - `:method = CONNECT`
   - `:protocol = webtransport-h3`
   - CONNECT stream ID becomes the WebTransport session ID.
5. WebTransport stream mapping:
   - Bidirectional stream prefix: varint `0x41`, then varint session ID.
   - Unidirectional stream prefix: varint `0x54`, then varint session ID.
6. Unknown-session bounds and cleanup for streams/datagrams.
7. QUIC `reset_stream_at` transport parameter and stream reset method.
8. Full lifecycle integration for close, error, GOAWAY, buffering limits, and mixed H3 traffic.

## Test Matrix

- `tests/net/webtransport.test.ts`
  - standard public API shape
  - URL validation
  - H3 setup and fail-fast unavailable paths
  - `ReadableStream` / `WritableStream` stream wrappers
  - datagram duplex stream
  - protocol negotiation
  - clean close and transport failure promise behavior
- `tests/net/quic-h3.test.ts`
  - SETTINGS negotiation
  - extended CONNECT
  - HTTP Datagram framing
  - concurrent H3 requests plus WebTransport sessions
  - GOAWAY behavior
  - buffering limits
- `tests/net/http-client.test.ts`
  - `HttpClient.webtransport()`
  - `HttpSession.webtransport()`
- `tests/net/http-app.test.ts`
  - `app.webtransport()` context
  - params
  - middleware/producers
  - 404/reject behavior
  - mixed HTTP/WebTransport serving
- QUIC tests
  - `reset_stream_at` transport parameter exposure
  - reliable-size reset behavior

## Progress Checklist

- [x] Create implementation record.
- [x] Add public WebTransport module.
- [x] Add loader entry and builtin layout coverage.
- [x] Add client fail-fast APIs.
- [x] Add app route API.
- [x] Add draft constants and pure H3 WebTransport framing helpers.
- [x] Add nghttp3 H3 SETTINGS support for Extended CONNECT and H3 DATAGRAM.
- [x] Add nghttp3 peer SETTINGS receive tracking for recognized settings.
- [x] Add `SETTINGS_WT_ENABLED` control-stream emission and parsing around nghttp3.
- [x] Detect WebTransport extended CONNECT in the H3 server and fail fast.
- [x] Add WebTransport extended CONNECT accept/session takeover.
- [x] Wire `HttpClient.webtransport()` / `HttpSession.webtransport()` to H3 CONNECT.
- [x] Wire `serve()` / `App.listen()` H3 WebTransport accept routing.
- [x] Add HTTP Datagram framing and WebTransport session dispatch.
- [x] Add WT stream open/accept routing.
- [x] Replace public session/event API with standards-shaped `WebTransport`.
- [x] Add runtime-global `WebTransport`.
- [x] Add basic closed-promise lifecycle.
- [x] Add transport-driven close/error propagation.
- [x] Add QUIC `reset_stream_at` API gate and optional native binding.
- [x] Add `serverCertificateHashes` validation against the QUIC peer certificate DER.
- [x] Add `exportKeyingMaterial()` through the active QUIC TLS backend.

## Conformance Evidence

| Requirement | Status | Evidence |
| --- | --- | --- |
| draft-15 SETTINGS negotiation and Extended CONNECT | Covered | `tests/net/webtransport-h3-framing.test.ts` and `tests/net/quic-h3.test.ts` assert `SETTINGS_WT_ENABLED = 0x2c7cf000`, `SETTINGS_ENABLE_CONNECT_PROTOCOL = 0x08`, `SETTINGS_H3_DATAGRAM = 0x33`, patched control-stream SETTINGS parsing, incomplete peer SETTINGS rejection, server rejection when client SETTINGS are incomplete, and successful `:method = CONNECT` / `:protocol = webtransport-h3` session takeover. |
| HTTP Datagram quarter-stream-id framing | Covered | `tests/net/webtransport-h3-framing.test.ts` and `tests/net/quic-h3.test.ts` round-trip `encodeHttpDatagram()` / `decodeHttpDatagram()` with quarter stream IDs and reject non-client-initiated bidirectional session stream IDs; the live H3 pair test verifies QUIC DATAGRAM delivery to the accepted WebTransport session. |
| Bidirectional and unidirectional WebTransport stream prefixes | Covered | `tests/net/webtransport-h3-framing.test.ts`, `tests/net/webtransport.test.ts`, and `tests/net/quic-h3.test.ts` assert stream type prefixes `0x41` and `0x54`, decode split prefixes, and route client/server-created bidirectional and unidirectional streams to the owning session. |
| Session takeover and app/client routing | Covered | `tests/net/quic-h3.test.ts`, `tests/net/http-client-webtransport.test.ts`, and `tests/net/webtransport.test.ts` cover H3 `HttpClient` / `HttpSession` helpers, `app.webtransport()` routing, server request context, unavailable paths, and public `WebTransport` lifecycle shape. |
| Certificate hash validation and keying material export | Covered | `tests/net/webtransport.test.ts` validates fake connection hashes and `exportKeyingMaterial()`. `tests/net/quic-h3.test.ts` validates matching and mismatched `serverCertificateHashes` over real H3 and confirms client/server TLS keying material exports match. |
| Close and error propagation | Covered | `tests/net/webtransport.test.ts` covers clean close, transport error propagation to `ready` / `closed`, and stream/datagram close behavior. H3 integration tests close underlying QUIC/H3 connections after accepted sessions and assert pending operations settle. |
| GOAWAY behavior | Covered as H3-session-level behavior | `tests/net/quic-h3.test.ts` covers `closeWhenIdle()` GOAWAY emission, rejection of future requests, and rejection of in-flight requests with stream IDs greater than the received GOAWAY last stream ID. WebTransport sessions inherit underlying QUIC/H3 connection close/error propagation rather than defining a separate GOAWAY surface. |
| `reset_stream_at` support | Optional capability with explicit API gate | `tests/net/quic-streams.test.ts` asserts `QuicStream.resetAt()` is present and fails clearly when the local ngtcp2 does not expose `reset_stream_at`; compatible ngtcp2 builds use the optional native binding. |
| H2 capsule fallback | Intentional limit | Capsule-based WebTransport over HTTP/2 is outside the H3-only implementation. Public helpers fail fast unless the caller uses an H3 session, covered by `tests/net/http-client-webtransport.test.ts`. |
