---
weight: 18
---
# OpenTelemetry Guide

Fino includes OpenTelemetry-compatible traces, logs, metrics, exporters, and
runtime instrumentations. Use the signal modules for application code and the
SDK module to wire processors, readers, exporters, and automatic runtime spans.

## Public API Boundary

Application code should import from:

- `fino:opentelemetry` for the compatibility facade.
- `fino:opentelemetry/traces` for tracers, spans, and active-span context.
- `fino:opentelemetry/logs` for logger providers and structured log records.
- `fino:opentelemetry/metrics` for meters and instruments.
- `fino:opentelemetry/sdk` for SDK setup, processors, readers, exporters, and
  instrumentations.

Modules under `internal:opentelemetry/*` and `js/internal/opentelemetry/*` are
runtime implementation details. Runtime topic helpers and low-level event
envelopes remain available through compatibility exports where they exist, but
they are not the preferred application contract.

## Manual Traces

```ts
import { getTracerProvider, runWithActiveSpan } from 'fino:opentelemetry/traces';

const tracer = getTracerProvider().getTracer('orders', '1.0.0');
const span = tracer.startSpan('orders.create', {
  attributes: { 'order.id': 'ord_123' },
});

try {
  await runWithActiveSpan(span, async () => {
    span.addEvent('validated');
  });
  span.end({ status: { code: 'OK' } });
} catch (error) {
  span.recordException?.(error);
  span.end({ status: { code: 'ERROR', message: String(error) } });
  throw error;
}
```

Active spans use Fino async context, so `getActiveSpan()` and instrumentations
see the current span across `await` boundaries.

## Structured Logs

```ts
import {
  LogRecordBuilder,
  SeverityNumber,
  getLoggerProvider,
} from 'fino:opentelemetry/logs';

const logger = getLoggerProvider().getLogger('orders');

logger.emitRecord(
  new LogRecordBuilder()
    .setSeverity('INFO', SeverityNumber.INFO)
    .setTextBody('created order')
    .setAttributes({ 'order.id': 'ord_123' }),
);
```

Log records copy the active trace context when one is present. SDK log
processors can apply attribute count and value-length limits before export.

## Metrics

```ts
import { getMeterProvider } from 'fino:opentelemetry/metrics';

const meter = getMeterProvider().getMeter('orders');
const created = meter.createCounter('orders.created', { unit: '1' });
const latency = meter.createHistogram('orders.latency.ms', { unit: 'ms' });

created.add(1, { tenant: 'acme' });
latency.record(42, { route: '/orders' });
```

Observable instruments are collected by SDK metric readers during `flush()` or
periodic reader cycles.

## SDK Setup

```ts
import {
  BatchLogRecordProcessor,
  BatchSpanProcessor,
  FetchInstrumentation,
  HttpServerInstrumentation,
  InMemoryExporter,
  OtelSDK,
  PeriodicMetricReader,
  Resource,
} from 'fino:opentelemetry/sdk';

const exporter = new InMemoryExporter();
const reader = new PeriodicMetricReader(exporter, { intervalMs: 0 });

const sdk = new OtelSDK({
  resource: new Resource({ 'service.name': 'orders-api' }),
  exporters: [exporter],
  spanProcessors: [new BatchSpanProcessor(exporter)],
  logRecordProcessors: [new BatchLogRecordProcessor(exporter)],
  metricReaders: [reader],
  instrumentations: [
    new FetchInstrumentation(),
    new HttpServerInstrumentation(),
  ],
}).start();

await sdk.flush();
await sdk.shutdown();
```

`start()` is idempotent. `flush()` drains queued spans and logs, collects
observable metrics, and exports reader batches. `shutdown()` flushes first, then
disposes instrumentations and readers.

## OTLP HTTP Export

```ts
import { OTLPHttpJsonExporter, OtelSDK } from 'fino:opentelemetry/sdk';

const exporter = new OTLPHttpJsonExporter({
  endpoint: 'http://127.0.0.1:4318',
  retry: { maxAttempts: 3, initialBackoffMillis: 100 },
});

new OtelSDK({ exporters: [exporter] }).start();
```

The exporter appends `/v1/traces`, `/v1/logs`, or `/v1/metrics` unless a
signal-specific endpoint is configured. Exporter HTTP requests run outside
active telemetry provider contexts so collector traffic does not recursively
instrument itself.

## CLI Bootstrap

Scripts can use CLI bootstrap instrumentation with an OTLP endpoint:

```sh
fino --otlp-endpoint http://127.0.0.1:4318 app.mts
```

The CLI installs trace, log, and metric providers around the script, starts
runtime instrumentations, and flushes providers before exit.
