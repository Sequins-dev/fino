---
weight: 24
---
# Context Propagation

Context propagation carries trace identity across process boundaries. When a service makes an outgoing HTTP request, it injects the current trace context into the request headers. When a service receives an incoming request, it extracts that context from the headers and uses it as the parent span context for its own work. This stitches distributed traces together across services.

Fino includes one built-in propagator: `W3CTraceContextPropagator`. It implements the W3C Trace Context specification using the `traceparent`, `tracestate`, and `baggage` headers. No other propagator (B3, Jaeger, etc.) is included.

All propagation types are imported from `fino:opentelemetry/sdk`.

## Injecting context into outgoing requests

`inject` writes the active trace context into a carrier object. The `W3CTraceContextPropagator` writes `traceparent` (and optionally `tracestate` and `baggage`):

```typescript
import { W3CTraceContextPropagator } from 'fino:opentelemetry/sdk';
import { getActiveSpanContext } from 'fino:opentelemetry/traces';

const propagator = new W3CTraceContextPropagator();
const carrier: Record<string, string> = {};

propagator.inject(carrier, getActiveSpanContext());

// carrier is now:
// { traceparent: '00-<traceId>-<spanId>-01' }
```

Pass the carrier as the headers object of your outgoing request. If you are using `fetch`, this means spreading the carrier into the fetch `headers` option.

## Extracting context from incoming requests

`extract` reads trace headers from a carrier and returns a `TraceContext` object:

```typescript
import { W3CTraceContextPropagator } from 'fino:opentelemetry/sdk';

const propagator = new W3CTraceContextPropagator();

// headers is the incoming request headers object
const ctx = propagator.extract(headers);
// ctx: { traceId, spanId, traceFlags, traceState?, baggage? }
```

Use the extracted context to start a child span that continues the remote trace:

```typescript
import { getTracerProvider, runWithActiveSpan } from 'fino:opentelemetry/traces';

const tracer = getTracerProvider().getTracer('orders');

const span = tracer.startSpan('orders.process', {
  traceId: ctx.traceId,
  parentSpanId: ctx.spanId,
});

await runWithActiveSpan(span, async () => {
  await handleRequest();
});
span.end({ status: { code: 'OK' } });
```

## The Propagation facade

`Propagation` is a convenience façade that delegates to the SDK's configured propagator. When an `OtelSDK` is running, it registers its propagator with the facade. Code that calls `Propagation.inject` or `Propagation.extract` will use whatever propagator is currently installed.

```typescript
import { Propagation } from 'fino:opentelemetry/sdk';
import { getActiveSpanContext } from 'fino:opentelemetry/traces';

const carrier: Record<string, string> = {};
Propagation.inject(carrier, getActiveSpanContext());

const ctx = Propagation.extract(incomingHeaders);
```

Using `Propagation` (the facade) rather than a concrete propagator directly decouples your code from the specific propagation format. If the SDK is configured with a different propagator in the future, the facade picks it up automatically.

## Baggage

`Baggage` is a key-value store propagated alongside trace context in the W3C `baggage` header. It carries user-defined values across service boundaries — useful for things like tenant IDs, feature flags, or sampling hints that need to flow with the request.

### Setting baggage

```typescript
import { Baggage, runWithBaggage } from 'fino:opentelemetry/sdk';

const baggage = new Baggage({ 'tenant.id': 'acme', 'feature.flag': 'experiment-3' });

await runWithBaggage(baggage, async () => {
  // Any spans or logs emitted here include this baggage.
  // Outgoing propagation (inject) serializes it into the baggage header.
  await processRequest();
});
```

### Reading active baggage

```typescript
import { getActiveBaggage } from 'fino:opentelemetry/sdk';

const baggage = getActiveBaggage();
if (baggage) {
  const tenantId = baggage.get('tenant.id');
}
```

### Baggage in propagated context

When `W3CTraceContextPropagator.inject` is called, active baggage is serialized into the `baggage` header. When `extract` is called, any `baggage` header in the carrier is parsed and returned as a `Baggage` instance on the `TraceContext`. You can then pass it to `runWithBaggage` to make it active for the duration of the request handler.

## What runtime instrumentations propagate automatically

`FetchInstrumentation` injects trace context into the headers of every outgoing `fetch` request. You do not need to call `inject` manually for fetch — the instrumentation does it using the SDK's configured propagator.

`HttpServerInstrumentation` extracts trace context from incoming HTTP request headers automatically. The span it creates for the request is parented to the remote trace. Handler code runs inside the extracted span context.

For other transports (raw TCP, WebSocket, message queues), you must call `inject` and `extract` yourself.

## Dual context stores

Active span context is tracked in two complementary stores:

1. **Fino async context** — the `getActiveSpan()` and `getActiveSpanContext()` calls read from this store. It is maintained automatically across `await` boundaries using `runWithActiveSpan`.

2. **W3C propagation context** — populated by calling `inject` or from `extract`. This is the wire format for cross-process propagation and is separate from the in-process async context.

When `getActiveSpanContext()` is called, it first checks for an explicitly set active telemetry context (from `inject`/`extract`), then falls back to the async-context active span. This means `inject` always sees the right context whether the span was created manually or extracted from incoming headers.
