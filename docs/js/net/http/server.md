# js/net/http/server

fino:serve — HTTP server convenience.

`serve()` wraps `Socket.listen()` and dispatches each accepted connection to
an H1ServerDriver (or, in future, an H2ServerDriver based on ALPN/preface
detection). The driver owns the per-connection keep-alive, pipelining, and
protocol-upgrade logic.

## Usage

```ts
import { serve } from 'fino:net/http/server';

const server = serve({ port: 3000 }, async (req) => {
  return new Response('hello');
});

// Graceful shutdown:
await server.close();
```

## Keep-alive

HTTP/1.1 connections are kept alive by default. The driver loops over
requests on the same TCP connection until the client sends
`Connection: close`, the handler returns a response with that header, or
the connection is reset.

## Content-Length

If the handler's Response does not include a `Content-Length` or
`Transfer-Encoding` header, the driver eagerly buffers the body and injects
`Content-Length`. For truly streaming responses, set one of those headers
yourself.

## Error handling

If the handler throws an unhandled error, the driver sends a bare
`500 Internal Server Error` response and closes the connection. The handler
is responsible for catching its own application errors and returning
appropriate responses.

## serve

```ts
function serve( options: ServeOptions, handler: (req: Request) => Response | ConnectionTakeover | Promise<Response | ConnectionTakeover>, ): ServeServer
```

Start an HTTP server.

Each incoming connection is handled concurrently. The event loop is
implicitly kept alive as long as the server is open.

`hostname` defaults to `0.0.0.0`, and `port` may be `0` to request an
ephemeral port. When `tls` is present, the server loads the certificate and
key paths and advertises HTTP/2 through ALPN when libnghttp2 is available.
`close()` stops accepting, closes the listening socket, releases TLS state,
and resolves after in-flight connections finish.

```ts
import { serve } from 'fino:net/http/server';

const server = serve({ port: 3000 }, async (req) => new Response('hello'));
console.log(server.port);
await server.close();
```
