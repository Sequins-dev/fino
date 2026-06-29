---
weight: 13
---
# HTTP Client

fino provides two client-side request mechanisms: the global `fetch()` function and `HttpClient` from `fino:net/http/client`. The right one to use depends on what you need beyond a basic response.

## fetch vs HttpClient

The global `fetch()` is right for one-shot requests where you control the full URL, you don't need response metadata beyond status and headers, and you don't need to reuse connection policy across requests:

```ts
const res = await fetch('https://api.example.com/users', {
  method: 'GET',
  headers: { authorization: 'Bearer token' },
});
const data = await res.json();
```

`HttpClient` is right when you need any of the following: a base URL resolved against relative paths, default headers applied to every request, protocol preferences (HTTP/2, HTTP/3), rich response metadata including protocol, timing, and connection information, logical sessions that persist across requests, or built-in SSE and WebSocket helpers that share the client's header and TLS policy.

## Creating a client

```ts
import { HttpClient } from 'fino:net/http/client';

const client = new HttpClient({
  baseUrl: 'https://api.example.com',
  headers: { authorization: 'Bearer token', accept: 'application/json' },
  protocols: ['h2', 'http/1.1'],   // prefer HTTP/2
  tls: { rejectUnauthorized: true },
});
```

`protocols` controls which protocol the client requests for explicit sessions. The first entry is preferred. The global `fetch()` handles protocol negotiation independently of this field; `request()` uses it to select the HTTP/2 or HTTP/3 path when an explicit session is active.

## request() and fetch()

`client.request()` returns an `HttpResponse` that includes request metadata, session information, connection details, protocol, timing, and trailers, in addition to the usual status and headers:

```ts
const response = await client.request('/users');

console.log(response.status);         // HTTP status
console.log(response.protocol);       // 'http/1.1' | 'h2' | 'h3'
console.log(response.timing);         // { startTime, responseHeadersEnd, bodyEnd }
console.log(response.request.method); // 'GET'
console.log(response.connection);     // connection info or null

const users = await response.json();
```

`client.fetch()` is a convenience wrapper that calls `request()` and adapts the result to a standard Fetch `Response` via `toFetchResponse()`. Use it when code downstream expects a plain `Response`:

```ts
const res: Response = await client.fetch('/users');
```

Both methods accept per-request options including `method`, `headers`, `body`, `signal`, `redirect`, `integrity`, and `trailers`:

```ts
const response = await client.request('/users', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Alice' }),
});
```

## Consuming an HttpResponse body

`HttpResponse` provides `text()`, `json()`, `bytes()`, and `arrayBuffer()` for buffered consumption, and `body` as an `AsyncIterable<Uint8Array>` for streaming:

```ts
// Buffered
const text = await response.text();
const data = await response.json();
const buf  = await response.bytes();

// Streaming
for await (const chunk of response.body ?? []) {
  process(chunk);
}
```

Calling any body method or iterating `body` marks the response as consumed. To cancel the body without reading it, call `response.close()`.

To pass an `HttpResponse` to code that expects a Fetch `Response`, call `toFetchResponse()`. This also marks the body as consumed from the `HttpResponse` side:

```ts
const fetchRes = response.toFetchResponse();
```

## Logical sessions

A logical session is an origin-scoped relationship that carries stable identity, a pinned protocol, default headers, and connection metadata across multiple requests. Create one with `client.session()`:

```ts
const session = await client.session('https://api.example.com', {
  protocol: 'h2',
});

const r1 = await session.request({ path: '/users' });
const r2 = await session.request({ path: '/users/42', method: 'GET' });
```

Session events record the lifecycle transitions of the session's underlying connection:

```ts
for await (const event of session.events) {
  console.log(event.type, event.session.id);
}
```

For HTTP/3 sessions, `session` opens and holds a QUIC connection that persists across requests — this is how HTTP/3 multiplexing works without per-request QUIC setup. For HTTP/1.1, the session is a logical policy container; individual requests still use one connection each.

Sessions support `reconnect()` to replace the underlying connection while preserving the logical session identity and queued events:

```ts
await session.reconnect({ reason: 'periodic refresh' });
```

Close the session when the logical relationship is done:

```ts
await session.close();
```

## SSE, WebSocket, and WebTransport helpers

`HttpClient` has helpers for opening persistent connections that share the client's default headers and TLS policy:

```ts
// Server-sent events — returns an EventSource (global)
const es = client.sse('/events');
es.onmessage = (e) => console.log(e.data);

// WebSocket — returns a WebSocketConnection
const ws = await client.websocket('/chat', { protocols: ['chat.v1'] });
ws.addEventListener('open', () => ws.send('hello'));

// WebTransport (requires an H3 session internally)
const wt = await client.webtransport('/session');
await wt.ready;
```

The same helpers are available on `HttpSession`:

```ts
const session = await client.session('https://api.example.com');
const ws = await session.websocket('/chat');
```

## Closing the client

`client.close()` closes all logical sessions and marks the client as closed. Subsequent calls to `request()`, `fetch()`, or `session()` throw:

```ts
await client.close();
```

`client.closeIdleSessions()` closes all currently open sessions without closing the client itself.

## Connection pooling and HTTP/2 multiplexing

Connection reuse for HTTP/1.1 requests goes through the global `fetch()` connection pool, which is shared with code that calls `fetch()` directly. HTTP/2 sessions created through an explicit `HttpSession` with `protocol: 'h2'` close the pool entry for that origin when `session.close()` is called. HTTP/3 sessions managed through `HttpSession` hold one QUIC connection per session for the duration of the session's lifetime, enabling full HTTP/3 request multiplexing without reconnecting for each request.
