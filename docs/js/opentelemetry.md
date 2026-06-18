# opentelemetry

fino:opentelemetry - tracing, metrics, logs, and SDK helpers.

This backward-compatible facade re-exports the public OpenTelemetry surface
from signal-specific modules and SDK helpers. New code can import narrower
surfaces from `fino:opentelemetry/traces`, `fino:opentelemetry/metrics`,
`fino:opentelemetry/logs`, and `fino:opentelemetry/sdk`.

Use this facade when configuring telemetry for an application or when
creating manual spans, logs, or metrics. Defaults are intentionally local:
the SDK exporter targets OTLP/HTTP on `http://127.0.0.1:4318`, trace context
uses W3C `traceparent`, and resources default to `unknown_service` until a
service name is provided.

```typescript
import { OtelSDK, InMemoryExporter, getTracerProvider } from 'fino:opentelemetry';

const memory = new InMemoryExporter();
new OtelSDK({ exporters: [memory] }).start();
const span = getTracerProvider().getTracer('app').startSpan('work');
span.end();
```

See OpenTelemetry concepts:
https://opentelemetry.io/docs/concepts/
