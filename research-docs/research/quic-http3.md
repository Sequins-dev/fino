# QUIC and HTTP/3 Research Plan

> Status: research and project tracker. This document records the current
> design intent for QUIC and HTTP/3 in fino. It is not an implementation
> commitment for every item at once; Phase 1 is deliberately scoped to QUIC.

## 1. Goal

Build a JS-first QUIC and HTTP/3 stack using thin FFI bindings to ngtcp2 and
nghttp3. The long-term outcome is one coherent HTTP system across HTTP/1.1,
HTTP/2, and HTTP/3, with a friendly Fetch-shaped default API and a lower-level
session/stream API for advanced users.

Primary goals:

- Provide `fino:net/quic` for low-level QUIC networking.
- Build `fino:net/http/h3` on top of QUIC for HTTP/3.
- Eventually unify H1, H2, and H3 around shared HTTP session and stream
  concepts.
- Preserve the platform ethos: implement as much as possible in JavaScript
  through thin dynamic FFI; use Rust only for bootstrap/module infrastructure or
  a proven hard boundary.

Current default decisions:

- **Phase 1 delivers QUIC only.** No HTTP/3 in the first implementation phase.
- **OpenSSL 3.5+ is the first TLS backend** through `ngtcp2_crypto_ossl`.
- **JS FFI is the default boundary.** Native Rust/C++ shims are fallback only.
- **High-level request/response remains the default developer experience.**
- **Stream/session APIs are public enough for advanced use**, but app routing
  should not force transport details onto ordinary handlers.

## 2. Sources and Standards

Primary upstream references:

- ngtcp2 programmers guide: https://nghttp2.org/ngtcp2/programmers-guide.html
- ngtcp2 repository and build requirements: https://github.com/ngtcp2/ngtcp2
- nghttp3 programmers guide: https://nghttp2.org/nghttp3/programmers-guide.html
- nghttp3 types/options: https://nghttp2.org/nghttp3/types.html
- OpenSSL QUIC guide: https://docs.openssl.org/3.5/man7/ossl-guide-quic-introduction/

Relevant RFCs and drafts:

- QUIC transport, RFC 9000: https://www.rfc-editor.org/rfc/rfc9000.html
- QUIC TLS integration, RFC 9001: https://www.rfc-editor.org/rfc/rfc9001.html
- HTTP/3, RFC 9114: https://www.rfc-editor.org/rfc/rfc9114.html
- QUIC DATAGRAM, RFC 9221: https://www.rfc-editor.org/rfc/rfc9221.html
- HTTP/3 WebSockets, RFC 9220: https://www.rfc-editor.org/rfc/rfc9220.html
- HTTP Datagrams and Capsules, RFC 9297:
  https://www.rfc-editor.org/rfc/rfc9297.html
- WebTransport over HTTP/3 draft:
  https://www.ietf.org/archive/id/draft-ietf-webtrans-http3-13.html

Research notes:

- ngtcp2 is the QUIC transport library. It owns packet processing, CIDs, stream
  flow control, loss recovery, timers, handshake integration, and connection
  close state.
- nghttp3 is the HTTP/3 mapping. It does not own UDP, QUIC packet processing,
  or QUIC stream flow control. The application must bridge nghttp3 reads/writes
  to the QUIC stack.
- QUIC requires TLS APIs designed for QUIC. A normal TLS-over-TCP socket stack
  is not enough.
- ngtcp2 supports multiple TLS helper backends. The OpenSSL backend is available
  with OpenSSL 3.5+ but is marked experimental upstream.
- HTTP/3 requires local unidirectional streams for control, QPACK encoder, and
  QPACK decoder traffic.

## 3. Current Repo State

Useful existing pieces:

- `fino:net/socket` already exposes low-level socket creation, nonblocking
  mode, UDP `sendto` / `recvfrom`, address encoding, and event-loop readable /
  writable integration.
- `internal:runtime/loop` already exposes readable readiness and timers, which
  QUIC needs for UDP packet receipt and ngtcp2 expiry handling.
- `internal:openssl` already loads OpenSSL dynamically and centralizes crypto /
  TLS bindings.
- `fino:net/http/server` currently binds TCP, accepts optional TLS, negotiates
  H2 through ALPN, detects h2c prefaces, and dispatches to H1 or H2 drivers.
- HTTP handlers currently expose `(Request) => Response` and hide most
  connection and stream details.
- `internal:net/http/h2/*` already demonstrates the local pattern for dynamic
  library loading, FFI callbacks, session wrappers, stream callbacks, and
  driver integration.
- `fino:net/http/app` is Koa-style middleware over Fetch-compatible requests
  and responses. It should remain usable without transport-specific knowledge.

Important gaps:

- There is no high-level UDP socket class, only low-level helpers.
- There is no QUIC-aware TLS setup in `internal:openssl`.
- There is no CID routing table, packet dispatcher, QUIC timer loop, or
  ACK-driven outbound data retention.
- The HTTP driver interface is connection-reader/writer oriented. QUIC/H3 needs
  a session/stream model instead.
- Current H2 server code buffers request and response bodies more than a mature
  multiplexed architecture should.

## 4. Architecture Direction

### 4.1 Layering

The intended stack is:

1. UDP socket/event-loop layer.
2. ngtcp2 QUIC connection layer.
3. QUIC stream abstractions exposed to JS.
4. nghttp3 HTTP/3 session layer.
5. Unified HTTP session/stream adapters for H1, H2, and H3.
6. `serve()`, `fetch()`, and `App.listen()` as high-level convenience APIs.

This keeps QUIC valuable by itself and prevents HTTP/3 from being built as a
special case that cannot support WebTransport, DATAGRAM, connection migration,
or future QUIC APIs.

### 4.2 Public API Direction

Phase 1 should introduce:

```ts
import { QuicEndpoint } from 'fino:net/quic';

const endpoint = QuicEndpoint.listen({
  hostname: '127.0.0.1',
  port: 4433,
  tls: { cert: './localhost.crt', key: './localhost.key' },
  alpn: ['fino-quic'],
});

for await (const conn of endpoint) {
  for await (const stream of conn.streams) {
    // stream.readable / stream.writable
  }
}
```

Potential Phase 1 types:

- `quicAvailable: boolean`
- `quicVersion: string | null`
- `QuicEndpoint`
- `QuicConnection`
- `QuicStream`
- `QuicDatagram` only if needed internally; public DATAGRAM is deferred.

Potential `QuicEndpoint` API:

- `listen(options): QuicEndpoint`
- `connect(options): Promise<QuicConnection>`
- `address`
- `close(): Promise<void>`
- `[Symbol.asyncIterator](): AsyncIterator<QuicConnection>`

Potential `QuicConnection` API:

- `remoteAddress`
- `localAddress`
- `alpnProtocol`
- `handshakeComplete`
- `streams`
- `openBidirectionalStream(): Promise<QuicStream>`
- `openUnidirectionalStream(): Promise<QuicStream>`
- `close(errorCode?, reason?): Promise<void>`

Potential `QuicStream` API:

- `id`
- `direction`
- `readable`
- `writable`
- `reset(errorCode): void`
- `stopSending(errorCode): void`
- close/error state inspection

### 4.3 FFI Boundary

Follow the current H2 pattern:

- Add `internal:net/quic/ngtcp2/bindings`.
- Add `internal:net/quic/ngtcp2/crypto-ossl`.
- Add public `fino:net/quic` as a JS wrapper over internal bindings.
- Later add `internal:net/http/h3/bindings` and `fino:net/http/h3`.

Binding requirements:

- Dynamic library candidates for Homebrew and common Linux paths.
- `requireQuic()` and `requireH3()` style helpers with install guidance.
- Strong references for every FFI callback until the native connection/session
  is closed.
- Strong references for outbound packet and stream buffers until ngtcp2 reports
  that they are no longer needed.
- Async FFI where callbacks can cross from native code back into JS.

## 5. Phase Tracker

Legend: `not started`, `researching`, `in progress`, `blocked`, `done`.

| Phase | Area | Status | Notes |
| --- | --- | --- | --- |
| 1 | QUIC module | not started | Deliver `fino:net/quic` without HTTP/3. |
| 2 | HTTP/3 module | not started | Build on Phase 1 QUIC streams. |
| 3 | Unified HTTP architecture | not started | Shared session/stream model for H1/H2/H3. |
| 4 | fetch, pooling, Alt-Svc | not started | H3 origin pool and fallback policy. |
| 5 | Advanced QUIC/H3 features | not started | 0-RTT, DATAGRAM, WebTransport, H3 WebSockets. |

## 6. Phase 1: QUIC Only

Phase 1 acceptance target: a working low-level QUIC module that can establish
client and server connections, negotiate ALPN, open streams, exchange bytes,
handle resets/closes, and pass focused loopback tests. No HTTP/3 behavior is in
scope for this phase.

### 6.1 Build and Availability

Tasks:

- Add dynamic loading for `libngtcp2`.
- Add dynamic loading for `libngtcp2_crypto_ossl`.
- Extend `internal:openssl` for OpenSSL 3.5+ QUIC session setup.
- Export `quicAvailable` and `quicVersion`.
- Throw clear errors when ngtcp2 is missing, OpenSSL lacks QUIC support, or the
  crypto helper library is unavailable.

Open questions:

- Which exact Homebrew paths should be first for ngtcp2 and ngtcp2_crypto_ossl?
- Should the public module expose separate `cryptoBackend` and
  `cryptoBackendAvailable` values?

### 6.2 UDP Endpoint

Tasks:

- Add a small UDP endpoint abstraction over existing low-level socket helpers.
- Bind IPv4 and IPv6 addresses.
- Receive datagrams through `loop.readable(fd)` and `recvfrom()`.
- Send datagrams through `sendto()`.
- Close endpoints without leaving readable waits alive.

Notes:

- QUIC packet flow is message-oriented. Do not adapt UDP to the current
  `BytesReader` / `BytesWriter` stream model.
- Keep each datagram and peer address available to the packet dispatcher.

### 6.3 Connection and CID Routing

Tasks:

- Decode QUIC packet version and CIDs on receipt.
- Route datagrams by destination connection ID.
- For unknown Initial packets, validate enough to create a server connection.
- Track original DCID, active SCIDs, issued CIDs, retired CIDs, and close-time
  cleanup.
- Remove all CID associations when a connection closes.

Notes:

- This is also the future foundation for connection migration.
- The endpoint owns the routing table; `QuicConnection` owns ngtcp2 state.

### 6.4 TLS and Handshake

Tasks:

- Configure QUIC-capable OpenSSL client and server sessions.
- Wire ngtcp2 crypto callbacks through `ngtcp2_crypto_ossl`.
- Negotiate ALPN.
- Expose `handshakeComplete` and `alpnProtocol`.
- Reject connections with unsupported ALPN.

Notes:

- Use OpenSSL 3.5+ first even though upstream marks it experimental.
- Keep the TLS backend swappable; do not bake OpenSSL details into public
  `fino:net/quic` types.

### 6.5 Timers and Packet Pump

Tasks:

- Use monotonic timestamps for ngtcp2 calls.
- Schedule `ngtcp2_conn_get_expiry2()` through `loop.timeout()`.
- On timer fire, call `ngtcp2_conn_handle_expiry()`.
- Drive write attempts after reads, timer expiry, stream writes, ACK callbacks,
  flow-control updates, and close events.
- Respect the send quantum returned by ngtcp2.

Notes:

- Timer cancellation must be explicit to avoid keeping the runtime alive after
  endpoint/connection close.
- GSO and pacing optimizations are out of scope for Phase 1.

### 6.6 Streams and Flow Control

Tasks:

- Expose bidirectional and unidirectional streams.
- Deliver incoming stream bytes as async-readable chunks.
- Accept JS writes and submit stream data through ngtcp2.
- Retain outbound buffers until ACK/loss callbacks make release safe.
- Surface flow-control blockage as backpressure on `writable`.
- Implement stream reset and stop-sending.

Notes:

- QUIC stream data lifetime is stricter than TCP writes. A JS buffer cannot be
  dropped just because a native call returned.
- The stream API must preserve independent stream delivery. One blocked stream
  should not block unrelated streams.

### 6.7 Close and Error Behavior

Tasks:

- Support graceful connection close with application error code and reason.
- Surface transport errors to the connection and all active streams.
- Surface stream resets to only the affected stream.
- Ensure endpoint close rejects or closes pending accept/connect work.

### 6.8 Phase 1 Tests

Tests:

- `quicAvailable` / version exports.
- Missing library error messages.
- UDP endpoint bind/send/receive on loopback.
- Client/server QUIC handshake on loopback.
- ALPN negotiation success and failure.
- Client-initiated bidirectional stream echo.
- Server-initiated stream where supported by negotiated limits.
- Concurrent stream echo without head-of-line blocking.
- Stream reset propagation.
- Connection close cleanup.
- Timer cleanup after close.

External/interoperability tests:

- Connect Fino client to ngtcp2 example server when installed.
- Connect ngtcp2 example client to Fino server when installed.
- Gate these tests on local tool availability and skip cleanly.

## 7. Phase 2: HTTP/3

Phase 2 builds `fino:net/http/h3` on top of Phase 1.

Tasks:

- Add dynamic loading for `libnghttp3`.
- Create `H3ClientSession` and `H3ServerSession`.
- Create and bind HTTP/3 control, QPACK encoder, and QPACK decoder streams.
- Bridge QUIC stream bytes into `nghttp3_conn_read_stream2()`.
- Bridge `nghttp3_conn_writev_stream()` output into QUIC stream writes.
- Call `nghttp3_conn_add_write_offset()` when QUIC accepts bytes.
- Block/unblock H3 streams on QUIC flow-control signals.
- Convert H3 headers into Fetch-compatible `Request` / `Response` objects.
- Validate pseudo-headers, content-length, trailers, and forbidden headers.

Tests:

- H3 request/response over loopback.
- Request and response body streaming.
- Trailers.
- Concurrent H3 requests completing out of order.
- H3 stream reset without connection close.
- Interop with ngtcp2/nghttp3 example client and server.

## 8. Phase 3: Unified HTTP Architecture

The current HTTP server API is connection-driver oriented. H3 should push the
core HTTP model toward sessions and logical streams.

Target internal shape:

- `HttpSession`
- `HttpStream`
- `HttpProtocolDriver`
- H1 adapter
- H2 adapter
- H3 adapter

Default public behavior:

```ts
serve({ port: 3000 }, async (request) => {
  return new Response('ok');
});
```

Advanced public behavior:

```ts
serve({ port: 3000, mode: 'stream' }, async (stream) => {
  const request = stream.request;
  await stream.respond(new Response(request.method));
});
```

App router behavior:

- `App.listen()` continues to work unchanged.
- `ctx.protocol` can expose `'http/1.1'`, `'h2'`, or `'h3'`.
- `ctx.stream` can be present for advanced handlers, but ordinary middleware
  should not need it.
- OpenAPI generation remains unchanged.

## 9. Phase 4: fetch, Pooling, and Alt-Svc

Tasks:

- Add an origin pool that can hold H1, H2, and H3 entries behind one interface.
- Add H3 client sessions for multiplexed requests.
- Parse and cache `Alt-Svc` entries advertising H3.
- Prefer H3 for future requests after Alt-Svc discovery.
- Fall back to H2/H1 on QUIC failure.
- Add explicit fetch override, for example `{ httpVersion: '3' }`, once the
  option shape is settled.

Default:

- Do not enable 0-RTT as part of fetch in this phase.
- Do not persist Alt-Svc cache across process runs until the policy is explicit.

## 10. Advanced Feature Backlog

### 10.1 0-RTT

Why it matters:

- QUIC can send early application data on resumed connections.
- This is valuable for latency-sensitive clients and eventually fetch pooling.

Requirements:

- Store TLS session tickets.
- Store selected QUIC transport parameters from the previous connection.
- Use `ngtcp2_conn_encode_0rtt_transport_params2()` and
  `ngtcp2_conn_decode_and_set_0rtt_transport_params()`.
- Handle early-data rejection with `ngtcp2_conn_tls_early_data_rejected()`.
- Reopen streams and resend data manually when early data is rejected and the
  application opts into replay-safe retry.

API concerns:

- 0-RTT data can be replayed. It must be opt-in.
- Default allowlist should be safe methods only, likely `GET`, `HEAD`, and
  application-declared idempotent requests.
- Request bodies should be disabled for 0-RTT by default.
- Server APIs need a way to tell handlers whether a request arrived as early
  data so applications can reject unsafe operations.

Status: deferred.

### 10.2 QUIC DATAGRAM

Why it matters:

- DATAGRAM adds unreliable message delivery over a QUIC connection.
- It is required by WebTransport and useful for real-time state updates where
  old messages can be dropped.

Requirements:

- Negotiate DATAGRAM transport support.
- Configure max datagram frame size.
- Expose send/receive datagram APIs with drop/backpressure semantics.
- Decide whether datagrams belong on `QuicConnection` directly or under a
  higher-level session object.

API concerns:

- Datagrams are not ordered and not reliable.
- Backpressure cannot mean "eventually deliver every message"; it needs clear
  drop behavior.
- Observability should count sent, received, dropped, and rejected datagrams.

Status: deferred.

### 10.3 HTTP Datagrams

Why it matters:

- HTTP Datagrams are the HTTP/3 layer used by WebTransport and other extensions.

Requirements:

- Enable nghttp3 `h3_datagram` settings.
- Map H3 datagram payloads to the associated stream/session context.
- Coordinate with QUIC DATAGRAM negotiation.

Status: deferred until H3 and QUIC DATAGRAM exist.

### 10.4 WebTransport

Why it matters:

- WebTransport exposes bidirectional streams, unidirectional streams, and
  datagrams to browser clients over HTTP/3.

Requirements:

- HTTP/3 extended CONNECT.
- HTTP Datagrams.
- QUIC DATAGRAM.
- Session-level stream creation and lifecycle management.
- Router support for WebTransport endpoints.

API direction:

```ts
app.webtransport('/session', async (session) => {
  for await (const stream of session.incomingBidirectionalStreams) {
    // ...
  }
});
```

Status: deferred.

### 10.5 HTTP/3 WebSockets

Why it matters:

- Existing WebSockets use HTTP/1.1 upgrade. HTTP/3 uses extended CONNECT
  instead, as described by RFC 9220.

Requirements:

- Enable Extended CONNECT in H3 settings.
- Recognize `:protocol = websocket`.
- Map one H3 stream to the WebSocket message layer.
- Update router and connection-takeover semantics because H3 WebSockets do not
  take over an entire connection.

API concerns:

- H1 WebSocket `ConnectionTakeover` is connection-level.
- H3 WebSocket is stream-level.
- The unified HTTP architecture should avoid locking WebSockets to a
  connection-only model.

Status: deferred.

### 10.6 Connection Migration

Why it matters:

- QUIC allows connections to survive address changes.

Requirements:

- Robust CID routing.
- Path validation.
- Endpoint-level packet routing that does not assume one address per
  connection forever.
- Observability for path changes and validation failures.

Phase 1 design constraint:

- CID routing must be designed so migration remains possible later, even if
  migration behavior is disabled initially.

Status: deferred.

### 10.7 qlog and Diagnostics

Useful future diagnostics:

- qlog output.
- Connection counters.
- Per-stream lifecycle events.
- Packet loss and retransmission counters.
- Congestion window and RTT metrics.
- OpenTelemetry spans/events for QUIC handshake, stream open/close, and H3
  request lifecycle.

Status: deferred.

## 11. Open Questions

- Exact public naming: `fino:net/quic` vs additional submodules.
- Whether to expose a first-class UDP endpoint module before QUIC or keep it
  internal.
- Whether `QuicStream.readable` / `writable` should use Web Streams or the
  existing async byte stream style.
- How much of the `QuicConnection` state should be observable without making
  the API unstable.
- How to represent backpressure for unreliable datagrams.
- Whether fetch should expose `httpVersion: '3'` or a more general transport
  preference API.
- How to document OpenSSL's experimental upstream status without making the
  API feel provisional.

## 12. Near-Term Implementation Checklist

Phase 1 checklist:

- [ ] Bind/load ngtcp2.
- [ ] Bind/load ngtcp2_crypto_ossl.
- [ ] Extend OpenSSL bindings for QUIC-capable sessions.
- [ ] Add UDP endpoint abstraction.
- [ ] Implement QUIC endpoint packet loop.
- [ ] Implement server connection creation and CID routing.
- [ ] Implement client connection creation.
- [ ] Implement handshake and ALPN.
- [ ] Implement timers and write pump.
- [ ] Implement stream open/read/write/reset.
- [ ] Implement outbound buffer retention and ACK cleanup.
- [ ] Implement connection close and cleanup.
- [ ] Add loopback tests.
- [ ] Add optional ngtcp2 interop tests.

Phase 2+ checklist:

- [ ] Bind/load nghttp3.
- [ ] Implement H3 session setup.
- [ ] Bridge H3 to QUIC streams.
- [ ] Add H3 server/client tests.
- [ ] Refactor HTTP core around session/stream adapters.
- [ ] Integrate H3 into serve/fetch/app.
- [ ] Add Alt-Svc and H3 pooling.
- [ ] Revisit 0-RTT, DATAGRAM, WebTransport, and H3 WebSockets.
