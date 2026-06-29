---
weight: 19
---
# Manual Tracing

Traces record the flow of a request or operation through your system. Each unit of work is a span. Spans form a tree: a parent span contains child spans, and all spans sharing a root trace ID form a trace.

## Getting a tracer

Import `getTracerProvider` from `fino:opentelemetry/traces` and call `getTracer` with a scope name. The name identifies the library or component producing the spans — use a reverse-DNS or module-path style string. An optional version string is included in the scope metadata.

```typescript
import { getTracerProvider } from 'fino:opentelemetry/traces';

const tracer = getTracerProvider().getTracer('orders', '1.0.0');
```

## Starting a span

Call `tracer.startSpan(name, options?)` to create a span. The name must be non-empty. Options let you supply initial attributes, a span kind, explicit parent context, or pre-existing links.

```typescript
const span = tracer.startSpan('orders.create', {
  attributes: { 'order.tenant': 'acme', 'order.items': 3 },
  kind: 'server',
});
```

Valid kind values are `'internal'` (the default), `'server'`, `'client'`, `'producer'`, and `'consumer'`.

## Making a span active

A span becomes the active span for its subtree by passing it to `runWithActiveSpan`. Inside the callback, `getActiveSpan()` returns the span, and any spans created by instrumentation or nested code inherit its trace ID and become its children.

```typescript
import {
  getTracerProvider,
  runWithActiveSpan,
  getActiveSpan,
} from 'fino:opentelemetry/traces';

const tracer = getTracerProvider().getTracer('orders');
const span = tracer.startSpan('orders.create');

const result = await runWithActiveSpan(span, async () => {
  // getActiveSpan() returns span here, and across all awaits.
  return processOrder();
});
```

The active span context is stored in fino's async context system and remains visible across `await` boundaries. Child async tasks inherit the active span from the point where they were started.

## Mutating a span

All mutation methods return `this`, so they chain:

```typescript
span
  .setAttribute('order.id', 'ord_123')
  .setAttribute('order.currency', 'USD');

// Set multiple attributes at once
span.setAttributes({ 'http.route': '/orders', 'http.method': 'POST' });

// Add a named event with optional attributes and timestamp
span.addEvent('payment.authorized', { 'payment.provider': 'stripe' });
```

Attribute keys are strings; values may be any type (strings, numbers, booleans, arrays). SDK processors may truncate long strings or drop attributes beyond the configured limit.

## Recording exceptions

`recordException` is the recommended way to mark a span as failed. It sets the span status to `ERROR`, captures `exception.type`, `exception.message`, and `exception.stacktrace` as event attributes, and returns `this`.

```typescript
try {
  await processOrder();
  span.end({ status: { code: 'OK' } });
} catch (error) {
  span.recordException(error);
  span.end();
}
```

You can also pass extra attributes alongside the exception:

```typescript
span.recordException(error, { 'order.id': orderId });
```

## Ending a span

Call `span.end()` when the operation is complete. Pass a `status` object and any final attributes in the options. Repeated calls to `end()` are ignored.

```typescript
// OK status
span.end({ status: { code: 'OK' } });

// ERROR status with message
span.end({
  status: { code: 'ERROR', message: 'downstream timeout' },
  attributes: { 'retry.count': 3 },
});
```

Status codes are the strings `'OK'` and `'ERROR'`. Omitting status leaves the span unset.

## Updating the span name

The span name can be changed any time before `end()`:

```typescript
span.updateName('orders.create.express');
```

## Nested spans

Each call to `tracer.startSpan` inside a `runWithActiveSpan` callback automatically inherits the active trace ID and parent span ID. You do not need to pass the parent explicitly.

```typescript
await runWithActiveSpan(parentSpan, async () => {
  const childSpan = tracer.startSpan('orders.validate');
  // childSpan.traceId === parentSpan.traceId
  await runWithActiveSpan(childSpan, async () => {
    await validateOrder();
  });
  childSpan.end({ status: { code: 'OK' } });
});
```

## Inspecting the active span context

`getActiveSpanContext()` returns the current `TraceContext`, which includes `traceId`, `spanId`, and `traceFlags`. This is useful when you need to stash trace identifiers for logging or propagation.

```typescript
import {
  getActiveSpan,
  getActiveSpanContext,
} from 'fino:opentelemetry/traces';

const span = getActiveSpan();       // Span instance, or undefined
const ctx = getActiveSpanContext(); // { traceId, spanId, traceFlags, ... }, or null
```

## Span links

Links associate a span with spans from other traces — useful for batch jobs, fan-out, or when a span continues work from another trace.

```typescript
const linkedCtx = getActiveSpanContext();

const span = tracer.startSpan('batch.process', {
  links: [{ traceId: linkedCtx.traceId, spanId: linkedCtx.spanId }],
});
```

Links can also be added after construction with `span.addLink(linkContext, attributes?)`.
