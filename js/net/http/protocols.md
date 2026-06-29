---
weight: 17
---
# Protocol Versions and Transport

fino's HTTP server and client support HTTP/1.1, HTTP/2, and HTTP/3 through the same handler and request API. Protocol selection is automatic based on what the connection negotiates; handlers and middleware do not need to branch on protocol versions for ordinary request/response work.

## HTTP/1.1

HTTP/1.1 is the default protocol and is always available. Connections are kept alive after each response: the server loops over requests on the same TCP connection until the client sends `Connection: close`, the handler returns a response with that header, or the connection is reset.

Request pipelining is handled by the driver; the application handler sees one request at a time per connection.

The `Expect: 100-continue` mechanism is handled automatically. When a client sends a request with `Expect: 100-continue` before sending the body, the server responds with `100 Continue` before the handler reads the body. Unsupported `Expect` values cause a `417 Expectation Failed` response.

Keep-alive behavior can be bounded with timeout options:

```ts
import { serveHttp } from 'fino:net/http/server';

serveHttp({
  port: 3000,
  headersTimeoutMs: 5_000,   // abort if request headers arrive too slowly
  idleTimeoutMs: 60_000,     // abort an idle keep-alive after 60 s
}, async () => new Response('ok'));
```

Set either timeout to `0` or omit it to disable. Both apply only to HTTP/1.1 connections; HTTP/2 and HTTP/3 use their own flow-control mechanisms.

## HTTP/2

HTTP/2 support is enabled automatically when the runtime was built with libnghttp2. No option is needed to activate it; the server negotiates HTTP/2 on any connection that supports it.

### TLS with ALPN

When `tls` is configured, the server offers both `h2` and `http/1.1` via ALPN and selects the right driver after the TLS handshake. The handler receives the same `Request`/`Response` API regardless of which protocol was negotiated:

```ts
import { serve } from 'fino:net/http/server';

serve({
  port: 443,
  tls: {
    cert: '/etc/tls/server.crt',
    key:  '/etc/tls/server.key',
  },
}, async (incoming) => {
  const accepted = await incoming.accept();
  // accepted.protocol is 'h2' or 'http/1.1' depending on ALPN outcome
  await accepted.respond(Response.json({ ok: true }));
});
```

To restrict ALPN to HTTP/2 only (for services that require it), set `tls.protocols`:

```ts
serve({
  port: 443,
  tls: {
    cert: './server.crt',
    key:  './server.key',
    protocols: ['h2'],  // advertise only h2
  },
}, handler);
```

### Prior-knowledge h2c (plain TCP)

Clients that know the server speaks HTTP/2 can use prior-knowledge HTTP/2 over plain TCP by sending the HTTP/2 connection preface directly. The server detects the preface and switches to the HTTP/2 driver automatically:

```ts
serveHttp({ port: 8080 }, async () => new Response('ok'));
// h2c prior-knowledge connections are handled automatically
```

### h2c upgrade

The HTTP/1.1 to h2c upgrade dance (RFC 7540 §3.2) lets a client negotiate HTTP/2 using a standard HTTP/1.1 `Upgrade: h2c` header. This is opt-in because it adds latency:

```ts
serveHttp({ port: 8080, allowH2cUpgrade: true }, async () => new Response('ok'));
```

### HTTP/2 in the client

`HttpClient` from `fino:net/http/client` requests HTTP/2 when `protocols` includes `'h2'`. The underlying `fetch()` also negotiates HTTP/2 when the server offers it over TLS:

```ts
import { HttpClient } from 'fino:net/http/client';

const client = new HttpClient({
  baseUrl: 'https://api.example.com',
  protocols: ['h2', 'http/1.1'],
});

const session = await client.session('https://api.example.com', { protocol: 'h2' });
```

HTTP/2 connection reuse and request multiplexing are handled by the pool shared with global `fetch()`. Closing an `HttpSession` with `protocol: 'h2'` removes the origin from the pool.

## HTTP/3

HTTP/3 runs over QUIC rather than TCP, eliminating head-of-line blocking at the transport layer. It requires a valid TLS certificate, the QUIC transport available in `fino:net/quic`, and libnghttp3 at runtime.

### Server HTTP/3

Add `h3: true` to `ServeOptions` to open a QUIC/HTTP/3 listener on the same port and address as the TCP listener:

```ts
import { serve } from 'fino:net/http/server';

serve({
  port: 443,
  tls: {
    cert: './server.crt',
    key:  './server.key',
  },
  h3: true,
}, async (incoming) => {
  const accepted = await incoming.accept();
  await accepted.respond(Response.json({ protocol: accepted.protocol }));
});
```

The `ready` promise on the returned server resolves when both the TCP listener (for HTTP/1.1 and HTTP/2) and the UDP/QUIC listener (for HTTP/3) are fully bound. If `h3` initialization fails, the TCP listener is closed before the error propagates.

QUIC options (MTU, congestion control, etc.) can be passed through the `h3` object form:

```ts
serve({
  port: 443,
  tls: { cert: './server.crt', key: './server.key' },
  h3: { quic: { /* QuicListenOptions subset */ } },
}, handler);
```

### Client HTTP/3

Use `HttpClient` with `protocols: ['h3']` or create an explicit H3 session:

```ts
import { HttpClient } from 'fino:net/http/client';

const client = new HttpClient({ protocols: ['h3'] });
const response = await client.request('https://h3.example.com/data');
console.log(response.protocol); // 'h3'
await client.close();
```

An H3 `HttpSession` holds one QUIC connection for its lifetime and multiplexes all requests over it:

```ts
const session = await client.session('https://h3.example.com', { protocol: 'h3' });
const r1 = await session.request({ path: '/a' });
const r2 = await session.request({ path: '/b' }); // reuses the same QUIC connection
await session.close();
```

## TLS configuration

TLS is configured through the `tls` option on `serve()` and `ServeOptions`. Both `cert` and `key` are file paths to PEM-encoded certificate chain and private key files:

```ts
serve({
  port: 443,
  tls: {
    cert: '/etc/tls/fullchain.pem',
    key:  '/etc/tls/privkey.pem',
  },
}, handler);
```

On the client side, custom CA trust and certificate verification are controlled through `HttpClient`'s `tls` option:

```ts
const client = new HttpClient({
  tls: {
    ca: '/etc/tls/internal-ca.pem',  // trust a custom CA (preferred for self-signed certs)
  },
});
```

ALPN protocol advertisement for TLS servers is controlled by `tls.protocols`. When omitted, it defaults to `['h2', 'http/1.1']` when HTTP/2 is available, or `['http/1.1']` otherwise.

## How the runtime selects a protocol

When a new TCP connection arrives on a TLS server, the runtime reads the ALPN result from the TLS handshake. If it is `h2`, the HTTP/2 driver handles the connection; otherwise the HTTP/1.1 driver does.

When a new TCP connection arrives on a plain TCP server, the runtime peeks at the first 24 bytes. If they match the HTTP/2 connection preface (`PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`), the HTTP/2 driver takes over. Otherwise the HTTP/1.1 driver handles the connection.

HTTP/3 connections arrive on the separate QUIC endpoint (UDP) and are handled by the H3 driver without any peeking or ALPN — QUIC always uses the `h3` ALPN protocol.

The application handler sees a consistent `Request`/`Response` API regardless of which protocol carried the request. The protocol used is available through `session.protocol` in `serve()` handlers or `response.protocol` in `HttpClient` responses.
