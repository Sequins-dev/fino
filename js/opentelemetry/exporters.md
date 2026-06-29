---
weight: 23
---
# Exporters and CLI Bootstrap

Exporters receive batches of spans, logs, and metrics from processors and readers and deliver them to an external collector. Fino ships one production exporter: `OTLPHttpJsonExporter`. `InMemoryExporter` is available for testing.

Both are imported from `fino:opentelemetry/sdk`.

## OTLPHttpJsonExporter

`OTLPHttpJsonExporter` serializes records to OTLP/HTTP JSON and POSTs them to a collector. The wire format is JSON; there is no gRPC or protobuf option.

```typescript
import { OTLPHttpJsonExporter, OtelSDK, BatchSpanProcessor } from 'fino:opentelemetry/sdk';

const exporter = new OTLPHttpJsonExporter({
  endpoint: 'http://127.0.0.1:4318',
});

const sdk = new OtelSDK({
  exporters: [exporter],
  spanProcessors: [new BatchSpanProcessor(exporter)],
}).start();
```

### Endpoint routing

The exporter appends signal-specific paths to the base endpoint:

- Spans go to `<endpoint>/v1/traces`
- Logs go to `<endpoint>/v1/logs`
- Metrics go to `<endpoint>/v1/metrics`

If the base endpoint already ends with `/v1/<signal>` or contains `/v1/`, it is used as-is for that signal.

You can also configure signal-specific endpoints independently:

```typescript
const exporter = new OTLPHttpJsonExporter({
  endpoint: 'http://collector:4318',
  endpoints: {
    traces: 'http://jaeger:4318/v1/traces',
    logs: 'http://loki:3100/v1/logs',
    // metrics: falls back to endpoint/v1/metrics
  },
});
```

### Headers and compression

```typescript
const exporter = new OTLPHttpJsonExporter({
  endpoint: 'https://api.example.com/otel',
  headers: {
    'x-api-key': 'my-token',
    Authorization: 'Bearer eyJ...',
  },
  compression: 'gzip',   // 'gzip', 'deflate', or 'br'
});
```

### Retry behavior

By default the exporter makes one attempt with no backoff. Configure `retry` to add resilience:

```typescript
const exporter = new OTLPHttpJsonExporter({
  endpoint: 'http://127.0.0.1:4318',
  retry: {
    maxAttempts: 3,
    initialBackoffMillis: 500,  // doubles with each failed attempt
  },
});
```

The retry rules:
- Network failures (request throws) are retried up to `maxAttempts`
- HTTP `429 Too Many Requests` is retried; if the response includes a `Retry-After` header, that delay is used instead of the backoff
- HTTP `4xx` responses other than `429` are not retried — they indicate a client error
- HTTP `5xx` responses are retried

### Observability hooks

The exporter supports hooks for logging or instrumentation of the export path itself:

```typescript
const exporter = new OTLPHttpJsonExporter({
  endpoint: 'http://127.0.0.1:4318',
  onError(error) {
    console.error('[otel] export failed:', error.message);
  },
  onPartialSuccess(result) {
    console.warn('[otel] partial success:', result.rejectedSpans, 'spans rejected');
  },
  onRequest(info) {
    console.log('[otel] exporting', info.signal, 'to', info.url);
  },
  onResponse(info) {
    console.log('[otel] export response', info.status, 'for', info.signal);
  },
});
```

### No recursive instrumentation

Export requests run outside active telemetry provider contexts. This means HTTP spans produced by `FetchInstrumentation` do not include the export request itself. The exporter deliberately suppresses provider context around each `fetch` call to break the feedback loop.

### Timeout

```typescript
const exporter = new OTLPHttpJsonExporter({
  endpoint: 'http://127.0.0.1:4318',
  timeoutMillis: 5000,  // 5 seconds per attempt
});
```

## InMemoryExporter for testing

`InMemoryExporter` accumulates records in memory:

```typescript
import { BatchSpanProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';

const memory = new InMemoryExporter();

const sdk = new OtelSDK({
  exporters: [memory],
  spanProcessors: [new BatchSpanProcessor(memory)],
}).start();

// run your code...
await sdk.flush();

const spans = memory.getFinishedSpans();   // SpanRecord[]
const logs = memory.getFinishedLogs();     // LogRecord[]
const metrics = memory.getFinishedMetrics(); // MetricRecord[]
```

## CLI bootstrap

The simplest way to enable OTLP export for a script is the `--otlp-endpoint` flag:

```sh
fino --otlp-endpoint http://127.0.0.1:4318 app.ts
```

This installs tracer, logger, and meter providers, starts a full instrumentation set (HTTP server, fetch, DNS, socket, TLS, trace topics), and registers a shutdown hook that flushes and stops the SDK when the script exits.

The equivalent using the `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 fino app.ts
```

### Supported environment variables

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP endpoint |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Signal-specific override for traces |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Signal-specific override for logs |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Signal-specific override for metrics |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` pairs added to all requests |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `none` or `gzip` |
| `OTEL_SERVICE_NAME` | Overrides the `service.name` resource attribute |
| `OTEL_RESOURCE_ATTRIBUTES` | Comma-separated `key=value` resource attributes |
| `FINO_OTEL_EXPORT_INTERVAL_MS` | Export interval in milliseconds (default: `1000`) |

### Resource detection

The bootstrap loader constructs the service resource by:
1. Reading `service.name` and `service.version` from `package.json` in the working directory
2. Applying `OTEL_RESOURCE_ATTRIBUTES` key-value pairs on top
3. Applying `OTEL_SERVICE_NAME` as `service.name` if set
4. Falling back to the script filename (without extension) as `service.name` if nothing else is found
