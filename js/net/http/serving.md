---
weight: 11
---
# HTTP Server

`fino:net/http/server` provides two entry points for starting an HTTP server. Both share the same underlying listener, connection multiplexing, and protocol machinery.

## Choosing between serveHttp and serve

`serveHttp` is the straightforward path. Its handler receives a `Request` and returns a `Response`:

```ts
import { serveHttp } from 'fino:net/http/server';

const server = serveHttp({ port: 3000 }, async (req) => {
  return Response.json({ ok: true });
});

console.log(`listening on port ${server.port}`);
await server.close();
```

`serve` is the lower-level path and is necessary when a handler needs to deal with WebSocket upgrades, WebTransport sessions, or cases where it wants to reject certain connections before they are accepted. Its handler receives an `IncomingHttp` value with a `kind` discriminant:

```ts
import { serve } from 'fino:net/http/server';

const server = serve({ port: 3000 }, async (incoming) => {
  if (incoming.kind === 'websocket') {
    const ws = await incoming.accept();
    ws.addEventListener('message', (e) => ws.send((e as MessageEvent).data));
    return;
  }

  if (incoming.kind === 'request') {
    const accepted = await incoming.accept();
    await accepted.respond(Response.json({ ok: true }));
  }
});
```

When building an HTTP API without WebSocket or WebTransport support, `serveHttp` is the right choice. When any of those protocol upgrades need to be handled at the server level, use `serve`. The `App` class from `fino:net/http/app` internally uses `serve` and handles the dispatch automatically, so applications using routing usually stay on `app.listen()` rather than either of these functions directly.

## Reading request bodies

Bodies are consumed once. The global `Request` exposes convenience methods for the common cases:

```ts
serveHttp({ port: 3000 }, async (req) => {
  if (req.method === 'POST' && new URL(req.url).pathname === '/upload') {
    const text = await req.text();          // UTF-8 string
    const bytes = await req.bytes();        // Uint8Array
    const data = await req.json();          // parsed JSON
    return new Response('received');
  }
  return new Response('not found', { status: 404 });
});
```

For bodies too large to buffer in memory, iterate the stream directly:

```ts
serveHttp({ port: 3000 }, async (req) => {
  let total = 0;
  if (req.body !== null) {
    for await (const chunk of req.body) {
      total += chunk.byteLength;
    }
  }
  return Response.json({ bytes: total });
});
```

## Returning responses

A handler can return a string, bytes, an async iterable, or `null` for no body:

```ts
// String body — Content-Type defaults to text/plain
return new Response('hello');

// JSON — sets Content-Type: application/json
return Response.json({ id: 1, name: 'Alice' });

// Bytes
return new Response(new Uint8Array([0x68, 0x69]), {
  headers: { 'content-type': 'application/octet-stream' },
});

// Status only
return new Response(null, { status: 204 });
```

When the response body has no `Content-Length` or `Transfer-Encoding` header, the server eagerly buffers the body and injects `Content-Length`. For a genuinely streaming response, set `Transfer-Encoding: chunked` (or any `Transfer-Encoding`) on the response and return an async iterable as the body:

```ts
async function* heartbeat(): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  while (true) {
    yield enc.encode(`data: ${Date.now()}\n\n`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

return new Response(heartbeat(), {
  headers: {
    'content-type': 'text/event-stream',
    'transfer-encoding': 'chunked',
    'cache-control': 'no-store',
  },
});
```

## Timeout options

Use `headersTimeoutMs` and `idleTimeoutMs` on servers exposed to untrusted clients. Without them, a slow or stalled client can hold a connection open indefinitely.

```ts
import { serve } from 'fino:net/http/server';

serve({
  port: 3000,
  headersTimeoutMs: 5_000,   // abort if headers take longer than 5 s
  idleTimeoutMs: 30_000,     // abort an idle keep-alive after 30 s
}, async (incoming) => {
  const accepted = await incoming.accept();
  await accepted.respond(new Response('ok'));
});
```

`headersTimeoutMs` bounds how long the server waits for a complete HTTP request header block. `idleTimeoutMs` bounds the gap between responses on a keep-alive connection. Set either to `0` or omit it to disable that timeout. These timeouts apply to HTTP/1.1 connections; HTTP/2 and HTTP/3 connections have their own flow-control mechanisms.

## Graceful shutdown

`server.close()` stops accepting new connections, closes the listening socket, releases TLS state, and resolves after all in-flight connections finish:

```ts
const server = serveHttp({ port: 3000 }, async () => new Response('ok'));

process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});
```

The server object also implements `Symbol.asyncDispose`, so it works with `await using`:

```ts
{
  await using server = serveHttp({ port: 3000 }, async () => new Response('ok'));
  // server closes automatically when the block exits
}
```

`close()` does not enforce a drain deadline. Applications that need bounded shutdown should add their own timeout around `close()`.

## Binding options

```ts
import { serveHttp } from 'fino:net/http/server';

serveHttp({
  port: 3000,
  hostname: '127.0.0.1',    // bind address; defaults to 0.0.0.0
  family: 'ipv4',            // explicit IP family; inferred from hostname when omitted
  backlog: 128,              // listen backlog
  reuseAddr: true,           // SO_REUSEADDR before bind
  reusePort: true,           // SO_REUSEPORT before bind (where supported)
}, async () => new Response('ok'));
```

Pass `port: 0` to let the OS assign an ephemeral port; read it back from `server.port` after the server object is created. When `hostname` contains `:` the family defaults to IPv6; otherwise it defaults to IPv4. The `ready` promise on the returned server resolves once all requested listeners — including an optional HTTP/3 listener — are fully established.

## TLS and protocol negotiation

Pass TLS certificate and key paths to enable HTTPS:

```ts
serve({
  port: 443,
  tls: {
    cert: '/etc/tls/server.crt',
    key:  '/etc/tls/server.key',
  },
}, async (incoming) => {
  const accepted = await incoming.accept();
  await accepted.respond(new Response('secure'));
});
```

When TLS is configured, the server negotiates the protocol via ALPN. If HTTP/2 support is available, it advertises `h2` and `http/1.1` by default; plain-TCP clients that send an HTTP/2 prior-knowledge preface are also handled. To add an HTTP/3 listener on the same host and port, set `h3: true` alongside `tls`. Protocol details are covered in the protocols guide.
