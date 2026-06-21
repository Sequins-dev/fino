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
- WebSocket is currently the only HTTP realtime sibling exposed by the app and client helpers.
- Existing uncommitted H3 documentation/comment edits must be preserved.

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

- `tests/net/webtransport.test.mts`
  - standard public API shape
  - URL validation
  - H3 setup and fail-fast unavailable paths
  - `ReadableStream` / `WritableStream` stream wrappers
  - datagram duplex stream
  - protocol negotiation
  - clean close and transport failure promise behavior
- `tests/net/quic-h3.test.mts`
  - SETTINGS negotiation
  - extended CONNECT
  - HTTP Datagram framing
  - concurrent H3 requests plus WebTransport sessions
  - GOAWAY behavior
  - buffering limits
- `tests/net/http-client.test.mts`
  - `HttpClient.webtransport()`
  - `HttpSession.webtransport()`
- `tests/net/http-app.test.mts`
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

## Known Blockers

- The local ngtcp2 library does not expose a reset-at symbol. `QuicStream.resetAt()` and `quicResetStreamAtAvailable` now make that explicit and will use the optional binding when a compatible ngtcp2 is installed.
- nghttp3 supports `enable_connect_protocol`, `h3_datagram`, and `recv_settings2`; draft-15's custom `SETTINGS_WT_ENABLED = 0x2c7cf000` is emitted by patching the local H3 control stream SETTINGS frame and parsed from peer control stream bytes before nghttp3 filters unknown settings.
- nghttp3/H3 DATAGRAM hooks must be confirmed for native callback coverage; QUIC DATAGRAM framing and WebTransport session dispatch are wired through the existing QUIC DATAGRAM events.
- H3 GOAWAY currently remains at the HTTP request/session layer; accepted WebTransport sessions close when the underlying QUIC/H3 connection closes or errors.
- H2 capsule fallback is out of scope for the first implementation.
