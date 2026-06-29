---
weight: 25
---
# Runtime Instrumentations

Instrumentations produce spans automatically for runtime I/O events without requiring changes to application code. They subscribe to fino's internal runtime topic events and emit spans to the SDK. Each instrumentation is a class that implements `enable(sdk)`.

All instrumentation classes are imported from `fino:opentelemetry/sdk`.

## Installing instrumentations

Pass instrumentation instances in the `instrumentations` array when constructing `OtelSDK`:

```typescript
import {
  DnsInstrumentation,
  FetchInstrumentation,
  HttpServerInstrumentation,
  OtelSDK,
  SocketInstrumentation,
  TlsInstrumentation,
  TraceTopicInstrumentation,
} from 'fino:opentelemetry/sdk';

const sdk = new OtelSDK({
  instrumentations: [
    new TraceTopicInstrumentation(),
    new HttpServerInstrumentation(),
    new FetchInstrumentation(),
    new DnsInstrumentation(),
    new SocketInstrumentation(),
    new TlsInstrumentation(),
  ],
}).start();
```

`start()` calls `enable(sdk)` on each instrumentation, which installs topic subscriptions. `shutdown()` calls `dispose()` on each, which removes subscriptions and clears buffered state.

Instrumentations only record spans while a tracer provider context is active. If the tracer provider context is suppressed (for example, inside the OTLP exporter's recursive-instrumentation guard), no spans are emitted.

## HttpServerInstrumentation

Produces server spans for incoming HTTP requests handled by fino's HTTP server.

**Span name:** `<METHOD> <route>` — for example, `GET /orders/:id`

**Span kind:** `server`

**Attributes:**

| Attribute | Value |
|---|---|
| `http.request.method` | HTTP method (`GET`, `POST`, etc.) |
| `http.route` | Matched route pattern |
| `url.full` | Full request URL |
| `http.response.status_code` | Response status code (on end or error) |
| `error.message` | Error message (on error events) |

**Status:** `OK` for responses with status codes below 500; `ERROR` for 500 and above.

**Propagation:** Incoming `traceparent` and `tracestate` headers are extracted using the SDK's propagator. The extracted context becomes the parent of the server span. The span context is then installed for the duration of the request handler, so any child spans created by handler code are automatically parented.

## FetchInstrumentation

Produces client spans for outgoing `fetch` requests.

**Span name:** `<METHOD> <url>` — for example, `POST https://api.example.com/orders`

**Span kind:** `client`

**Attributes:**

| Attribute | Value |
|---|---|
| `http.request.method` | HTTP method |
| `url.full` | Request URL |
| `http.response.status_code` | Response status code (on end) |
| `error.message` | Error message (on network failure) |

**Status:** `OK` for responses with status codes below 500; `ERROR` for 500 and above, or for network failures.

**Propagation:** The instrumentation injects the current trace context into the outgoing request headers using the SDK's propagator. The `traceparent` header is set automatically. You do not need to call `inject` manually for fetch requests.

## DnsInstrumentation

Produces client spans for DNS lookups performed by the runtime networking layer.

**Span name:** `DNS <hostname>` — for example, `DNS api.example.com`

**Span kind:** `client`

**Attributes:**

| Attribute | Value |
|---|---|
| `dns.question.name` | Hostname being resolved |
| `dns.answer.address` | Resolved IP address (on success) |
| `net.sock.family` | Socket family (`inet`, `inet6`) |
| `runtime.request_id` | Correlates with the HTTP request that triggered this lookup |
| `runtime.request_hop` | Hop count within the request pipeline |
| `error.message` | Error message (on failure) |

**Parent:** DNS spans are typically children of an HTTP client or socket span from the same request pipeline, when those instrumentations are also installed.

## SocketInstrumentation

Produces client spans for TCP/UDP socket connections.

**Span name:** `CONNECT <host>:<port>` — for example, `CONNECT 93.184.216.34:443`

**Span kind:** `client`

**Attributes:**

| Attribute | Value |
|---|---|
| `net.transport` | Transport protocol (`tcp`, `udp`) |
| `net.peer.name` | Target hostname or IP |
| `net.peer.port` | Target port number |
| `runtime.request_id` | Correlates with the enclosing HTTP request |
| `runtime.request_hop` | Hop count within the request pipeline |
| `error.message` | Error message (on connection failure) |

## TlsInstrumentation

Produces client spans for TLS handshakes.

**Span name:** `TLS <hostname>:<port>` — for example, `TLS api.example.com:443`

**Span kind:** `client`

**Attributes:**

| Attribute | Value |
|---|---|
| `server.address` | Hostname presented to the TLS handshake |
| `server.port` | Port number |
| `tls.protocol.name` | TLS protocol version (e.g., `TLSv1.3`) |
| `runtime.request_id` | Correlates with the enclosing HTTP request |
| `runtime.request_hop` | Hop count within the request pipeline |
| `error.message` | Error message (on handshake failure) |

## TraceTopicInstrumentation

Bridges user-created spans (from `getTracerProvider().getTracer(...)`) into the SDK span pipeline. Without this instrumentation, spans published through the trace API topic are not delivered to the SDK's span processors.

This instrumentation is required for manual tracing to work end-to-end with the SDK. Include it in every production SDK configuration. It is always included when using the `--otlp-endpoint` CLI bootstrap.

`TraceTopicInstrumentation` subscribes to scoped trace topics. It buffers in-flight spans keyed by span ID, accumulates mutations (attribute, event, link, status, rename), and delivers the final assembled record to the SDK's processors when the span ends. Spans that have been open for more than five minutes without an end event are evicted automatically.

## When to enable each instrumentation

The CLI bootstrap (`--otlp-endpoint`) installs all six instrumentations automatically. For custom SDK configurations:

- Enable `TraceTopicInstrumentation` whenever you use manual tracing. Without it, spans never reach your exporters.
- Enable `HttpServerInstrumentation` on any process that handles HTTP requests through fino's server.
- Enable `FetchInstrumentation` on any process that makes outgoing `fetch` calls.
- Enable `DnsInstrumentation`, `SocketInstrumentation`, and `TlsInstrumentation` when you want network-level visibility inside traces. These produce child spans that make latency breakdowns visible in trace viewers.

Unused instrumentations have no overhead when disabled.
