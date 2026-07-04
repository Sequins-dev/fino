---
weight: 10
---
# Introduction

fino's HTTP subsystem is built around the global Fetch-compatible `Request`, `Response`, and `Headers` objects. All server and client logic lives in `fino:` modules. `WebSocket` and `EventSource` are globals; no import is needed to use them in application code.

The subsystem has several focused surfaces that cover different concerns. Pick based on what you're building.

## Which guide to read

**Starting an HTTP server** — use `fino:net/http/server`. It provides `serveHttp()` (simple request/response handler), `serve()` (accept-based handler that also handles WebSocket and WebTransport upgrades), and server lifecycle management. See the server guide.

**Routing and middleware** — use `fino:net/http/app`. It provides `App`, `Router`, Koa-style middleware, URLPattern route builders, body and schema helpers, OpenAPI generation, cookie and session producers, and a `listen()` shortcut that wires the app into `serve()`. See the routing guide.

**Making outbound HTTP requests** — either use the global `fetch()` for one-shot requests, or `HttpClient` from `fino:net/http/client` for reusable policy, protocol control, rich response metadata, persistent logical sessions, and built-in SSE and WebSocket helpers. See the client guide.

**WebSockets** — the `WebSocket` global covers the client side. The server side goes through `serve()` or `app.websocket()`, which surface an `IncomingWebSocketRequest` whose `accept()` method returns a `WebSocketConnection` from `fino:net/http/websocket`. See the WebSockets guide.

**Server-sent events** — the `EventSource` global covers client-side SSE. For server-side formatting use `EventSourceWriter` from `fino:net/http/eventstream`; for parsing a streaming SSE body use `parseEventStream` or `EventSourceReader` from the same module. See the server-sent events guide.

**WebTransport** — `WebTransport` from `fino:net/http/webtransport` is the client entry point. The server side surfaces an `IncomingWebTransportRequest` through `serve()`. Requires HTTP/3 and QUIC. See the WebTransport guide.

**Protocol details** — HTTP/1.1 keep-alive, HTTP/2 ALPN negotiation and h2c, HTTP/3 activation, and TLS configuration are all handled by `serve()` and `HttpClient` without internal-module imports. See the protocols guide.

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
