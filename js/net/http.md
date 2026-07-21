---
weight: 10
---
# HTTP

fino's HTTP subsystem is built around the global Fetch-compatible `Request`, `Response`, and `Headers` objects. All server and client logic lives in `fino:` modules. `WebSocket`, `EventSource`, and `WebTransport` are globals; no import is needed to use them in application code.

The subsystem has several focused surfaces that cover different concerns. Pick based on what you're building.

## Which guide to read

**Starting an HTTP server** — use `fino:net/http/server`. It provides `serveHttp()` (simple request/response handler), `serve()` (accept-based handler that also handles WebSocket and WebTransport upgrades), and server lifecycle management. See the [server guide](./http/serving.md).

**Routing and middleware** — use `fino:net/http/app`. It provides `App`, `Router`, Koa-style middleware, URLPattern route builders, body and schema helpers, OpenAPI generation, cookie producers, and a `listen()` shortcut that wires the app into `serve()`. Production server-session middleware and stores live in `fino:security/session`; the app module retains its original unsealed helpers for compatibility. See the [routing guide](./http/routing.md).

**Making outbound HTTP requests** — either use the global `fetch()` for one-shot requests, or `HttpClient` from `fino:net/http/client` for reusable policy, protocol control, rich response metadata, persistent logical sessions, and built-in SSE and WebSocket helpers. See the [client guide](./http/http-client.md).

**WebSockets** — the `WebSocket` global covers the client side. The server side goes through `serve()` or a `route().websocket()` operation, which surface an `IncomingWebSocketRequest` whose `accept()` method returns a `WebSocketConnection` from `fino:net/http/websocket`. See the [WebSockets guide](./http/websockets.md).

**Server-sent events** — `route().sse()` registers a streaming operation whose handler writes events through an `EventSourceWriter`. The `EventSource` global covers client-side SSE, and `parseEventStream` from `fino:net/http/eventstream` parses streaming SSE bodies (POST-based APIs included). Streaming agent responses over SSE is shown in the [AI section](../ai.md). See the [server-sent events guide](./http/server-sent-events.md).

**WebTransport** — the `WebTransport` global is the client entry point (also importable from `fino:net/http/webtransport`). The server side surfaces an `IncomingWebTransportRequest` through `serve()`. Requires HTTP/3 and QUIC. See the [WebTransport guide](./http/web-transport.md).

**Protocol details** — HTTP/1.1 keep-alive, HTTP/2 ALPN negotiation and h2c, HTTP/3 activation, and TLS configuration are all handled by `serve()` and `HttpClient` without internal-module imports. See the [protocols guide](./http/protocols.md).

## Public modules

| Module | Main exports |
|---|---|
| `fino:net/http` | `Headers`, `Request`, `Response`, wire parse/serialize |
| `fino:net/http/server` | `serve`, `serveHttp`, `ServeOptions`, `ServeServer` |
| `fino:net/http/client` | `HttpClient`, `HttpSession`, `HttpResponse` |
| `fino:net/http/app` | `App`, `Router`, `schema`, `body`, `cookies`, `sessions` |
| `fino:net/http/eventstream` | `EventSourceReader`, `EventSourceWriter`, `parseEventStream` |
| `fino:net/http/eventsource` | `EventSource` (also available as a global) |
| `fino:net/http/websocket` | `WebSocketConnection`, `WebSocket`, `CloseEvent`, `ErrorEvent`, `WebSocketError` |
| `fino:net/http/webtransport` | `WebTransport`, `WebTransportDatagramDuplexStream` |

HTTP/1.1, HTTP/2, and HTTP/3 protocol drivers, connection pools, and internal ALPN machinery are implementation details exposed only through `fino:net/http/server` and `fino:net/http/client`. Do not import `internal:` modules directly.
