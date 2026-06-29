---
weight: 21
---
# Structured Logs

The log signal carries structured records with a severity, body, attributes, and optional trace correlation. Log records are independent of the trace signal: you do not need an active span to emit a log, but when a span is active the record automatically captures its trace context.

## Getting a logger

```typescript
import { getLoggerProvider } from 'fino:opentelemetry/logs';

const logger = getLoggerProvider().getLogger('orders', '1.0.0');
```

The name identifies the component emitting logs. It appears in the scope metadata of exported records.

## Convenience methods

For common severity levels, `Logger` provides shorthand methods that set both the severity text and severity number:

```typescript
logger.debug('cache miss', { 'cache.key': 'order:123' });
logger.info('order created', { 'order.id': 'ord_123' });
logger.warn('slow query', { 'query.duration_ms': 420 });
logger.error('payment failed', { 'payment.code': 'card_declined' });
```

Each convenience method takes a body (any value) and an optional attributes object.

## Building records with LogRecordBuilder

For full control over the record — custom severity numbers, explicit context, or structured bodies — use `LogRecordBuilder`:

```typescript
import {
  LogRecordBuilder,
  SeverityNumber,
  getLoggerProvider,
} from 'fino:opentelemetry/logs';

const logger = getLoggerProvider().getLogger('orders');

logger.emitRecord(
  new LogRecordBuilder()
    .setSeverity('WARN', SeverityNumber.WARN)
    .setTextBody('slow order path detected')
    .setAttributes({ 'order.id': 'ord_123', 'latency.ms': 820 }),
);
```

The builder's methods chain and return `this`:

- `.setSeverity(text, number?)` — sets the severity text and optional numeric severity
- `.setTextBody(text)` — sets a string body
- `.setJsonBody(value)` — sets a structured (non-string) body
- `.setBody(value)` — sets any body value
- `.setAttribute(key, value)` — sets a single attribute
- `.setAttributes(attrs)` — merges an attributes object
- `.setEventName(name)` — sets the event name field
- `.setCategory(name)` — sets the category name field
- `.setContext(traceContext)` — explicitly sets trace ID, span ID, and trace flags

## Severity numbers

`SeverityNumber` is an enum covering the full OpenTelemetry severity range. Each named level also has three variants (`LEVEL2`, `LEVEL3`, `LEVEL4`) for finer-grained severity within the same band:

| Name | Number |
|---|---|
| `TRACE` | 1 |
| `DEBUG` | 5 |
| `INFO` | 9 |
| `WARN` | 13 |
| `ERROR` | 17 |
| `FATAL` | 21 |

When using `setSeverity`, omitting the number leaves it unset on the builder; `emitRecord` will then default it to `INFO` (9). The convenience methods always set both severity text and number.

## Trace correlation

When a log record is emitted inside an active span — either because application code called `runWithActiveSpan` or because an instrumentation (such as `HttpServerInstrumentation`) set up the span context — the logger automatically captures the active `traceId`, `spanId`, and `traceFlags` from async context and attaches them to the record. No explicit action is required.

You can override or clear the trace context on a builder using `.setContext(ctx)`:

```typescript
const builder = new LogRecordBuilder()
  .setSeverity('INFO', SeverityNumber.INFO)
  .setTextBody('external event received')
  .setContext({ traceId: incomingTraceId, spanId: incomingSpanId, traceFlags: 1 });

logger.emitRecord(builder);
```

## Emit versus emitRecord

`logger.emit(body, options?)` is a lower-level method that accepts body, `severityText`, `severityNumber`, and `attributes` directly:

```typescript
logger.emit('retrying request', {
  severityText: 'WARN',
  severityNumber: SeverityNumber.WARN,
  attributes: { 'retry.attempt': 2 },
});
```

`logger.emitRecord(builder)` is preferred when you need the full `LogRecordBuilder` fluent API.

## Processing and export

Log records are not exported by default. They are delivered to whichever `LogRecordProcessor` instances are registered on the SDK at the time of emission. The `BatchLogRecordProcessor` buffers records and exports them in batches; it optionally applies attribute count and value-length limits before queuing. See `sdk-setup.md` for wiring.
