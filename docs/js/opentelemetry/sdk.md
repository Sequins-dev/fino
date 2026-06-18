# sdk

fino:opentelemetry/sdk - SDK wiring, exporters, resources, and propagation.

This module contains the cross-signal OpenTelemetry SDK surface. Use it to
start telemetry collection, configure processors and metric readers, export
records to memory or OTLP/HTTP JSON, install runtime instrumentations, manage
resources, and propagate trace context through carriers.

`OtelSDK.start()` is idempotent. `flush()` drains queued span and log
processors, collects observable metrics, and exports reader batches.
`shutdown()` flushes first, then disposes instrumentations and readers. The
OTLP exporter defaults to `http://127.0.0.1:4318` with signal-specific
`/v1/traces`, `/v1/logs`, and `/v1/metrics` paths.

```typescript
import { BatchSpanProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';

const memory = new InMemoryExporter();
const sdk = new OtelSDK({
  exporters: [memory],
  spanProcessors: [new BatchSpanProcessor(memory)],
});
sdk.start();
await sdk.flush();
```

See OpenTelemetry SDK configuration:
https://opentelemetry.io/docs/concepts/sdk-configuration/
