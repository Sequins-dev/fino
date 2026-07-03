---
weight: 12
---
# Networking Guide

Fino networking ranges from high-level Fetch-style HTTP to low-level sockets,
TLS, DNS, mDNS, QUIC, WebSockets, server-sent events, and WebTransport.

Start with the highest-level API that matches the protocol:

- Use [`fino:net/http/server`](./http/serving.md) for HTTP servers.
- Use [`fino:net/http/client`](./http/http-client.md) or global `fetch()` for
  HTTP clients.
- Use [`fino:net/http/websocket`](./http/websockets.md) for WebSockets.
- Use [`fino:net/http/webtransport`](./http/web-transport.md) for WebTransport.
- Use `fino:net/socket`, `fino:net/tls`, `fino:net/dns`, `fino:net/mdns`, and
  `fino:net/quic` when building lower-level protocol tools.

## Low-Level Sockets

Socket APIs expose nonblocking descriptors, async readers/writers, datagrams,
address helpers, and errno constants. They are useful for custom protocols and
runtime modules, but application servers should prefer HTTP, WebSocket, or
WebTransport helpers.

## TLS And QUIC

`fino:net/tls` wraps OpenSSL for client and server handshakes. `fino:net/quic`
provides QUIC endpoint and stream primitives used by HTTP/3 and WebTransport.
Availability depends on linked native libraries; check capability booleans and
handle unavailable protocol support explicitly.

## DNS

`fino:net/dns` resolves names through provider abstractions, and `fino:net/mdns`
handles local multicast discovery. Use provider injection in tests when network
answers must be deterministic.
