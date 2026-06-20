---
weight: 10
---
# HTTP Guide

The HTTP APIs are built around Fetch-compatible `Request`, `Response`, and
`Headers` objects. Use `fino:net/http/server` for application servers, and drop
down to lower protocol modules only when building tooling or custom transports.

## Start a Server

Use `serve` with a port and a request handler:

```ts
import { serve } from 'fino:net/http/server';

const server = serve({ port: 3000 }, async (request) => {
  return new Response('hello\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
});

console.log(`listening on http://127.0.0.1:${server.port}`);
```

The handler receives a `Request` and returns a `Response` or a promise for one.
Each accepted connection is handled concurrently. HTTP/1.1 keep-alive is enabled
by default until the client or response asks to close the connection.

`hostname` is a numeric bind address. It defaults to `0.0.0.0`; pass
`family: 'ipv6'` to bind the IPv6 wildcard `::`, or pass an IPv6 literal such
as `hostname: '::1'` to infer IPv6. `backlog`, `reuseAddr`, and `reusePort`
are forwarded to the underlying socket listener.

## Route Requests

Use `URL` to inspect the path and query string:

```ts
import { serve } from 'fino:net/http/server';

serve({ port: 3000 }, async (request) => {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({ ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/hello') {
    const name = url.searchParams.get('name') ?? 'world';
    return new Response(`hello ${name}\n`);
  }

  return new Response('not found\n', { status: 404 });
});
```

Keep routing logic close to the handler for small services. Move routes into
helpers once the handler stops being easy to scan.

## Read Request Bodies

Request bodies are consumed once. For JSON APIs, read text and parse it:

```ts
serve({ port: 3000 }, async (request) => {
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/users') {
    const body = await request.text();
    const input = JSON.parse(body);

    return Response.json({
      id: crypto.randomUUID(),
      name: input.name,
    }, { status: 201 });
  }

  return new Response('not found\n', { status: 404 });
});
```

For larger bodies, iterate bytes instead of buffering the entire body:

```ts
let total = 0;

for await (const chunk of request.body) {
  total += chunk.byteLength;
}

return Response.json({ bytes: total });
```

## Return Responses

Return strings for small text responses, `Uint8Array` for bytes, `null` for no
body, or an async iterable for streaming:

```ts
async function* clock() {
  const encoder = new TextEncoder();

  while (true) {
    yield encoder.encode(`${new Date().toISOString()}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

return new Response(clock(), {
  headers: { 'content-type': 'text/plain; charset=utf-8' },
});
```

If a response does not include `Content-Length` or `Transfer-Encoding`, the
server buffers the body and injects `Content-Length`. For true streaming, set an
appropriate streaming header yourself, such as `Transfer-Encoding: chunked`.

## HTTP/1.1 Controls

HTTP/1.1 requests with `Expect: 100-continue` receive an interim
`100 Continue` response before the handler reads the body. Unsupported
expectations are rejected with `417 Expectation Failed`.

Use timeout options on public servers that accept untrusted clients:

```ts
serve({
  port: 3000,
  headersTimeoutMs: 30_000,
  idleTimeoutMs: 60_000,
}, async () => new Response('ok\n'));
```

`headersTimeoutMs` bounds the time allowed for a complete request header block.
`idleTimeoutMs` bounds keep-alive gaps after a completed response. Omit either
option, or set it to `0`, to disable that timeout.

## Shut Down Gracefully

Keep the returned server object when the process needs to stop cleanly:

```ts
const server = serve({ port: 3000 }, async (request) => {
  const url = new URL(request.url);

  if (url.pathname === '/stop') {
    queueMicrotask(() => {
      server.close().catch((error) => console.error(error));
    });
    return new Response('stopping\n');
  }

  return new Response('ok\n');
});
```

`close()` stops accepting new connections and resolves after in-flight
connections finish. It does not enforce a drain deadline; applications that
need bounded shutdown should arrange their own request cancellation or process
deadline around `close()`.

## TLS and HTTP/2

Pass certificate and key paths to serve HTTPS:

```ts
serve({
  port: 3443,
  tls: {
    cert: './localhost.crt',
    key: './localhost.key',
  },
}, async () => new Response('secure\n'));
```

When HTTP/2 support is available, TLS servers advertise `h2` and `http/1.1` via
ALPN. Plain TCP servers can also allow the HTTP/1.1 to h2c upgrade flow:

```ts
serve({ port: 3000, allowH2cUpgrade: true }, async () => {
  return new Response('ok\n');
});
```

Most applications should keep using the request handler API and let the server
driver select HTTP/1.1 or HTTP/2 per connection.

## Server-Sent Events

Use server-sent events when the server needs to push a sequence of text events
over a normal HTTP response:

```ts
async function* events() {
  const encoder = new TextEncoder();

  yield encoder.encode('event: ready\n');
  yield encoder.encode('data: {"ok":true}\n\n');

  while (true) {
    yield encoder.encode('event: tick\n');
    yield encoder.encode(`data: ${new Date().toISOString()}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

return new Response(events(), {
  headers: {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'transfer-encoding': 'chunked',
  },
});
```

SSE is one-way: the client opens an HTTP request and the server writes events
until the connection closes. Use `EventSourceWriter` from
`fino:net/http/eventsource` when writing SSE frames to an existing transport
writer rather than yielding response chunks yourself.

## WebSockets

Use WebSockets when the connection should become a bidirectional message stream
after the HTTP upgrade. The WebSocket module exposes connection and client
classes for upgrade-aware code.

At the application boundary, treat WebSockets as a different route shape from
ordinary request/response handlers: validate the path and headers, accept the
upgrade, then handle messages until the peer closes.

Use WebSockets for interactive sessions, subscriptions that need client
messages, and long-lived bidirectional protocols. Use server-sent events when
the server only needs to push updates.

## Lower-Level Protocol Modules

Most servers should use `serve`. Reach for the lower layers when you are
building protocol tools or custom transports:

- [HTTP module](./index.mts) owns `Headers`, `Request`, `Response`, and shared
  body helpers.
- [HTTP/1.1](./h1.mts) parses and serializes text HTTP wire frames.
- [HTTP/2](./h2.mts) owns HTTP/2 session and stream behavior.
- [Driver](./driver.mts) connects protocol handlers to transport readers and
  writers.
- [EventSource](./eventsource.mts) frames server-sent events.
- [WebSocket](./websocket.mts) handles WebSocket framing and connection state.

The low-level HTTP/1 client driver sends exactly one request over an
already-connected reader/writer pair. DNS, TCP/TLS setup, redirects, retries,
pooling, and body wrapping belong to `fetch()` or the caller.
