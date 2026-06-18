# traces

fino:opentelemetry/traces - trace providers, tracers, spans, and trace records.

This module contains the public trace signal API. Use it to create manual
spans, swap tracer providers for tests or scoped execution, inspect the
active span, and describe trace records consumed by SDK processors and
exporters.

Span names and tracer scope names must be non-empty strings. Span attributes,
events, links, status updates, and rename operations are published as runtime
telemetry records; processors may apply additional SDK limits before export.
Active-span context follows Fino async context propagation and is visible
through `getActiveSpan()` and `getActiveSpanContext()`.

```typescript
import { getTracerProvider, runWithActiveSpan } from 'fino:opentelemetry/traces';

const tracer = getTracerProvider().getTracer('orders', '1.0.0');
const span = tracer.startSpan('orders.create', { attributes: { tenant: 'acme' } });
runWithActiveSpan(span, () => {
  span.addEvent('validated');
});
span.end({ status: { code: 'OK' } });
```

See OpenTelemetry traces:
https://opentelemetry.io/docs/concepts/signals/traces/
