# HTTP Client Sessions Research

> Status: research and API-shaping note. This document proposes a lower-level
> HTTP client model for fino. It is not an implementation commitment and does
> not freeze exact TypeScript names.

## 1. Goal

Design a lower-level HTTP client API that can power `fetch()` while also
supporting durable API clients, explicit logical sessions, long-lived streams,
credential reuse, Server-Sent Events, WebSocket, protocol lifecycle diagnostics,
and future HTTP/2 and HTTP/3 capabilities.

The recommended model is **Client + Session**:

- `HttpClient` owns policy, state, and pooling across origins.
- `HttpSession` exposes an origin-scoped logical HTTP relationship for advanced
  callers.
- `HttpResponse` is richer than Fetch `Response`, but can adapt into one.

The central distinction is that a session is not necessarily one transport
connection. A session is a logical relationship to an origin. Its current
connection may change over time because of HTTP/2 GOAWAY, HTTP/3 reconnect, or
QUIC path migration.

## 2. Current Repo State

The current public HTTP client story is centered on global `fetch()` and
Fetch-compatible `Request`, `Response`, and `Headers` objects.

Useful existing pieces:

- `internal:globals/fetch` implements HTTP and HTTPS fetch, redirect handling,
  aborts, decompression, integrity checks, and Fetch-compatible request and
  response objects.
- HTTP/1.1 fetch currently opens a fresh TCP or TLS connection per hop and asks
  for `Connection: close`.
- HTTPS fetch can negotiate HTTP/2 through ALPN and reuse an internal
  origin-keyed `H2ConnectionPool`.
- The internal HTTP/2 pool already models some important lower-level behavior:
  active streams, GOAWAY handling, idle eviction, and per-origin reuse.
- HTTP/3 has a lower-level `H3ClientSession` that can open requests over a QUIC
  connection and surface trailers, stream closure, and GOAWAY-like shutdown.
- Public `fino:net/http/h3.fetch()` exists separately from the unified global
  fetch path and currently creates a temporary H3 client flow rather than a
  durable public client/session API.
- `fino:net/http/eventsource` and `fino:net/http/websocket` already cover
  important real-time protocol pieces, but they are not organized around a
  shared client/session abstraction.

The gap is not "can fino make HTTP requests?" The gap is a durable,
protocol-aware client layer for users who need more control than `fetch()` can
comfortably expose.

## 3. Prior Art

Mature HTTP client APIs separate high-level application policy from transport
connection management.

- Go's `net/http.Client` owns request policy such as redirects, cookies, and
  timeout behavior, while `Transport` owns connection reuse, proxies, TLS, and
  lower-level mechanics. The docs also emphasize that clients and transports
  are safe to reuse and contain internal cached connection state:
  https://pkg.go.dev/net/http
- Rust `reqwest::Client` is a reusable client handle with an internal
  connection pool. Its docs recommend constructing one client and reusing it:
  https://docs.rs/reqwest/latest/reqwest/struct.Client.html
- Python HTTPX `Client` provides persistent configuration, connection pooling,
  cookies, headers, authentication, event hooks, and explicit request sending:
  https://www.python-httpx.org/advanced/clients/
- Node's `http.Agent` focuses on socket pooling and connection reuse, exposing
  a separate object for lower-level connection lifecycle policy:
  https://nodejs.org/api/http.html

The consistent lesson is that most applications should hold a reusable client,
while lower-level connection/session details should remain available when they
matter.

## 4. Recommended Model

### 4.1 `HttpClient`

`HttpClient` is the object ordinary application code should keep around. It
owns policy and state:

- base URL resolution;
- default headers;
- explicit cookie jar;
- explicit auth provider;
- redirect policy;
- retry policy;
- request, response, and idle timeouts;
- TLS options;
- protocol preferences;
- session pool;
- observability hooks;
- lifecycle cleanup.

Example:

```ts
const client = new HttpClient({
  baseUrl: 'https://api.example.com',
  headers: { authorization: `Bearer ${token}` },
  cookies: new CookieJar(),
  protocols: ['h3', 'h2', 'http/1.1'],
});

const response = await client.request('/users');
const fetchResponse = await client.fetch('/users');
```

Potential shape:

```ts
interface HttpClient {
  request(input: HttpRequestInput, init?: HttpRequestInit): Promise<HttpResponse>;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  session(origin: string | URL, options?: HttpSessionOptions): Promise<HttpSession>;

  sse(input: string | URL, options?: SseOptions): EventSource;
  websocket(input: string | URL, options?: WebSocketOptions): Promise<WebSocket>;

  closeIdleSessions(): Promise<void>;
  close(): Promise<void>;
}
```

`client.request()` chooses or creates an appropriate session according to
origin, protocol preferences, pooling policy, current health, and request
requirements. `client.session()` is the explicit escape hatch when the caller
wants to pin work to a logical origin/protocol session.

### 4.2 `HttpSession`

`HttpSession` is a logical session to one origin. It is not a stable one-to-one
wrapper around a socket, TLS connection, or QUIC connection.

```ts
const session = await client.session('https://api.example.com', {
  protocol: 'h3',
});

const stream = await session.request({
  method: 'GET',
  path: '/events',
});
```

Potential shape:

```ts
interface HttpSession {
  readonly id: string;
  readonly origin: string;
  readonly protocol: 'http/1.1' | 'h2' | 'h3';
  readonly state: 'connecting' | 'ready' | 'draining' | 'closed';
  readonly currentConnection: HttpConnectionInfo | null;

  request(init: HttpSessionRequest): Promise<HttpResponse>;
  sse(path: string, options?: SseOptions): EventSource;
  websocket(path: string, options?: WebSocketOptions): Promise<WebSocket>;

  reconnect(options?: ReconnectOptions): Promise<void>;
  close(options?: CloseOptions): Promise<void>;

  readonly events: AsyncIterable<HttpSessionEvent>;
}
```

The important identity rule is:

```ts
session.id !== session.currentConnection?.id
```

The session identity remains stable while the current transport may change.
Lifecycle events should make those changes observable:

```ts
type HttpSessionEvent =
  | { type: 'connecting'; session: HttpSession }
  | { type: 'connected'; session: HttpSession; connection: HttpConnectionInfo }
  | { type: 'migrated'; session: HttpSession; connection: HttpConnectionInfo }
  | { type: 'goaway'; session: HttpSession; lastStreamId?: unknown }
  | { type: 'draining'; session: HttpSession }
  | { type: 'reconnecting'; session: HttpSession; reason: unknown }
  | { type: 'reconnected'; session: HttpSession; connection: HttpConnectionInfo }
  | { type: 'closed'; session: HttpSession; reason?: unknown };
```

### 4.3 Protocol Semantics

HTTP/1.1:

- The session is a logical policy/state container for one origin.
- Requests may use short-lived TCP/TLS connections or a small keep-alive pool.
- No multiplexing is implied.
- Reconnect means opening another connection for the next request.
- The session model is still useful for cookies, auth, base headers,
  diagnostics, retry policy, and fetch layering.

HTTP/2:

- The session uses one active multiplexed H2 connection at a time.
- Concurrent requests become independent streams.
- GOAWAY marks the active connection draining.
- In-flight streams at or below the last accepted stream ID may finish.
- New requests can use a replacement connection under the same logical session.
- Automatic replay is conservative and must respect idempotency and body
  replayability.

HTTP/3:

- The session uses one active QUIC/H3 connection at a time.
- QUIC path migration can change the network path without changing logical
  session identity.
- Reconnect may replace the QUIC connection under the same logical session.
- HTTP/3 stream and GOAWAY behavior must follow H3 rules, but user-facing
  policy should match the H2 session model where possible.

## 5. `HttpResponse`

`HttpResponse` should be richer than Fetch `Response`, while staying easy to
adapt into one. It should preserve details that matter to advanced clients:
session identity, current connection, protocol, trailers, timing, retry
attempts, and cancellation semantics.

Potential shape:

```ts
interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly url: string;
  readonly redirected: boolean;

  readonly request: HttpRequestInfo;
  readonly session: HttpSession;
  readonly connection: HttpConnectionInfo | null;

  readonly protocol: 'http/1.1' | 'h2' | 'h3';
  readonly trailers: Promise<Headers>;
  readonly timing: HttpResponseTiming;

  readonly body: AsyncIterable<Uint8Array>;

  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;

  toFetchResponse(): Response;
  close(): Promise<void>;
}
```

Supporting shapes:

```ts
interface HttpRequestInfo {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly idempotent: boolean;
  readonly replayable: boolean;
  readonly attempt: number;
}

interface HttpConnectionInfo {
  readonly id: string;
  readonly protocol: 'http/1.1' | 'h2' | 'h3';
  readonly transport: 'tcp' | 'tls' | 'quic';
  readonly localAddress: unknown | null;
  readonly remoteAddress: unknown | null;
  readonly alpnProtocol: string | null;
  readonly connectedAt: number;
}

interface HttpResponseTiming {
  readonly startTime: number;
  readonly dnsStart?: number;
  readonly dnsEnd?: number;
  readonly connectStart?: number;
  readonly connectEnd?: number;
  readonly tlsStart?: number;
  readonly tlsEnd?: number;
  readonly requestHeadersStart?: number;
  readonly requestHeadersEnd?: number;
  readonly responseHeadersStart?: number;
  readonly responseHeadersEnd?: number;
  readonly bodyStart?: number;
  readonly bodyEnd?: number;
}
```

Response semantics:

- `body` is streaming and single-consumption.
- Convenience readers consume and close the body.
- `trailers` resolves after body completion and rejects if the stream fails.
- `close()` cancels or drains the body according to protocol rules and releases
  resources.
- `toFetchResponse()` adapts status, headers, and body to a standard
  `Response`; lower-level metadata stays on `HttpResponse`.

Open question: whether `HttpResponse` should extend `Response` directly. The
recommended answer is no. Keeping it separate avoids overloading Fetch
semantics and lets `toFetchResponse()` be the explicit compatibility boundary.

## 6. SSE

SSE fits naturally into the session model because it is a long-lived HTTP `GET`
with `Accept: text/event-stream`.

```ts
const events = client.sse('/events', {
  reconnect: true,
  maxRetryDelayMs: 30_000,
});

events.addEventListener('message', (event) => {
  console.log(event.data);
});
```

Recommended behavior:

- `client.sse()` resolves URLs, headers, cookies, auth, TLS, protocol
  preferences, and observability through the owning `HttpClient`.
- `session.sse()` pins the stream to an explicit logical session.
- The return value should be `EventSource`-compatible rather than a raw
  `HttpResponse`.
- The EventSource object should own event parsing, `Last-Event-ID`, retry delay,
  close behavior, and application-level reconnect.
- H2 and H3 multiplexing lets an SSE stream stay open while other requests share
  the same logical session.
- QUIC path migration should not interrupt SSE if the underlying H3 connection
  survives.
- If the transport must be replaced, SSE may reconnect at the HTTP layer and
  preserve `Last-Event-ID` where possible.

SSE should be allowed to reconnect automatically because reconnect is part of
the EventSource programming model.

## 7. WebSocket

WebSocket should also be available as a client/session convenience, but it is
different from SSE because it changes protocols rather than staying an ordinary
HTTP response stream.

```ts
const socket = await client.websocket('/chat', {
  protocols: ['chat.v1'],
});

socket.send('hello');
```

Recommended behavior:

- `client.websocket()` resolves URLs, headers, cookies, auth, TLS, protocol
  preferences, and observability through the owning `HttpClient`.
- `session.websocket()` pins the attempt to an explicit logical session.
- The return value should be WebSocket-compatible.
- Initial support can map to the existing HTTP/1.1 Upgrade path.
- HTTP/2 and HTTP/3 WebSocket support should be documented as future Extended
  CONNECT work.
- WebSocket reconnect should not be automatic by default because message replay,
  resubscription, and application state recovery are domain-specific.
- WebSocket lifecycle should still participate in client/session diagnostics and
  close behavior.

The API should leave room for future H2/H3 WebSocket over Extended CONNECT
without forcing the H1 upgrade implementation to masquerade as a normal
request/response.

## 8. Fetch Layering

`fetch()` should be implementable on top of this lower-level model:

```ts
async function fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const response = await defaultHttpClient.request(input, normalizeFetchInit(init));
  return response.toFetchResponse();
}
```

The default fetch client should remain mostly stateless and Fetch-compatible:

- no ambient browser cookie jar;
- no browser CORS enforcement unless explicitly implemented later;
- no browser HTTP cache unless explicitly implemented later;
- conservative redirect credential forwarding;
- Fetch-compatible abort and body consumption behavior.

The lower-level `HttpClient` should be able to do more than fetch:

- preserve explicit cookies and auth across requests;
- expose protocol, session, and connection diagnostics;
- keep H2/H3 sessions warm;
- support long-lived SSE and WebSocket helpers;
- expose trailers and timing directly;
- support richer retry and reconnect policy.

## 9. Tradeoffs

### 9.1 Client + Session

Recommended.

Benefits:

- Best API-client ergonomics.
- Natural home for cookies, auth, redirects, retries, defaults, and telemetry.
- Clean path for implementing `fetch()`.
- Explicit sessions remain available for protocol-aware use.
- H1, H2, and H3 fit the same logical model without pretending their transport
  behavior is identical.

Costs:

- More public API surface.
- Users must understand two nouns.
- The implementation must be clear about when `client.request()` pools sessions
  and when `client.session()` pins work to a logical session.

### 9.2 Session First

Not recommended as the main API.

Benefits:

- Strongest mental model for H2 and H3.
- Maximum control for protocol debugging, long-lived streams, and custom
  pooling experiments.
- Fewer hidden decisions.

Costs:

- Awkward for ordinary API clients.
- Redirects across origins need another object anyway.
- Shared cookie and auth state across origins becomes userland work.
- `fetch()` layering is less natural.
- H1 sessions feel abstract because H1 does not provide durable multiplexed
  transport sessions.

### 9.3 Client Only

Not recommended.

Benefits:

- Smallest API.
- Easy to explain for request/response workloads.
- Smoothest migration path from `fetch()`.

Costs:

- Hides too much of the H2/H3 lifecycle.
- Weak fit for explicit SSE pinning, GOAWAY handling, migration diagnostics,
  stream limits, and future WebTransport-like APIs.
- Advanced users would end up needing private APIs.

## 10. State And Safety Defaults

Recommended defaults:

- Cookies are explicit opt-in.
- Auth providers are explicit opt-in.
- There is no ambient browser-like credential store.
- Credential forwarding across redirects is conservative.
- Request retries are conservative.
- SSE may reconnect automatically.
- WebSocket does not reconnect automatically.

Retry rules:

- Completed requests stay completed.
- Active streaming requests fail unless continuity is guaranteed.
- Idempotent requests may retry only if the body is replayable and policy allows
  it.
- Non-idempotent requests are not retried by default.
- Application code can opt into stronger replay behavior when it owns the
  semantic risk.

## 11. Deferred Scope

Deferred items:

- Exact TypeScript names and module paths.
- Concrete cookie jar and auth provider APIs.
- Full retry policy surface.
- Public timing taxonomy compatibility with the browser Performance APIs.
- HTTP cache behavior.
- Browser CORS behavior.
- HTTP/2 WebSocket Extended CONNECT.
- HTTP/3 WebSocket over Extended CONNECT / RFC 9220.
- WebTransport.
- Automatic WebSocket reconnect helpers.
- Multi-origin session coalescing for H2/H3.

These are intentionally out of scope for the first research decision. The
important first decision is the durable `HttpClient` plus logical `HttpSession`
shape.

