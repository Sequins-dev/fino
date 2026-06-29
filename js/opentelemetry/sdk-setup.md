---
weight: 22
---
# SDK Setup

`OtelSDK` wires together the signal modules — traces, metrics, and logs — by subscribing to the records they produce and routing them through processors, readers, and exporters. Import everything from `fino:opentelemetry/sdk`.

## Constructor options

```typescript
import {
  BatchLogRecordProcessor,
  BatchSpanProcessor,
  OtelSDK,
  PeriodicMetricReader,
  Resource,
} from 'fino:opentelemetry/sdk';

const sdk = new OtelSDK({
  resource: new Resource({ 'service.name': 'orders-api', 'service.version': '2.1.0' }),
  spanProcessors: [...],
  logRecordProcessors: [...],
  metricReaders: [...],
  instrumentations: [...],
  sampler: ...,
  views: [...],
  metricCardinalityLimit: 1000,
  spanLimits: { attributeCountLimit: 128, attributeValueLengthLimit: 256 },
});
```

All options are optional. When `exporters` is omitted, the SDK creates a default `OTLPHttpJsonExporter` targeting `http://127.0.0.1:4318`. When `spanProcessors` is omitted, a `BatchSpanProcessor` wrapping the default exporter is used. When `sampler` is omitted, `AlwaysOnSampler` is used.

### resource

A `Resource` instance describing the service. Its attributes are merged into every span, log, and metric record the SDK processes.

```typescript
import { Resource } from 'fino:opentelemetry/sdk';

const resource = new Resource({
  'service.name': 'orders-api',
  'service.version': '2.1.0',
  'deployment.environment': 'production',
});
```

### exporters

An array of exporters to fan out to. If you supply `exporters` without supplying `spanProcessors`, the SDK wraps the exporter list in a `BatchSpanProcessor` automatically. If you supply `spanProcessors` explicitly, `exporters` is only used as a fallback default for the fan-out exporter.

### spanProcessors

An array of `SpanProcessor` instances. Each finished span is delivered to all processors in order. The standard processor is `BatchSpanProcessor`:

```typescript
import { BatchSpanProcessor, OTLPHttpJsonExporter } from 'fino:opentelemetry/sdk';

const exporter = new OTLPHttpJsonExporter({ endpoint: 'http://127.0.0.1:4318' });

const processor = new BatchSpanProcessor(exporter, {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 0,
});
```

`scheduledDelayMillis` controls how long the processor waits after receiving a span before exporting. A value of `0` means flush is only triggered explicitly via `forceFlush`. A positive value triggers a background export after that many milliseconds.

### logRecordProcessors

An array of `LogRecordProcessor` instances. Each emitted log record is delivered to all processors. The standard processor is `BatchLogRecordProcessor`, which also supports attribute limiting:

```typescript
import { BatchLogRecordProcessor } from 'fino:opentelemetry/sdk';

const logProcessor = new BatchLogRecordProcessor(exporter, {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  attributeCountLimit: 64,
  attributeValueLengthLimit: 512,
});
```

### metricReaders

An array of metric readers. Readers receive accumulated metrics and export them. Two readers are available:

`ManualMetricReader` collects metrics on demand. Call `.collect()` to drain the current batch:

```typescript
import { ManualMetricReader } from 'fino:opentelemetry/sdk';

const reader = new ManualMetricReader();
// ... after sdk.flush():
const metrics = reader.collect();
```

`PeriodicMetricReader` (also exported as `PeriodicExportingMetricReader`) exports on a timer:

```typescript
import { PeriodicMetricReader } from 'fino:opentelemetry/sdk';

const reader = new PeriodicMetricReader(exporter, {
  intervalMs: 60_000,    // default: 60 seconds
  temporality: 'cumulative',  // or 'delta'
});
```

### sampler

The `Sampler` lives on the SDK, not on the tracer or provider. This is consumer-side sampling: providers always publish span records; the SDK decides which to keep. The default is `AlwaysOnSampler`, which keeps every span.

```typescript
import { AlwaysOnSampler, OtelSDK } from 'fino:opentelemetry/sdk';

const sdk = new OtelSDK({ sampler: new AlwaysOnSampler() });
```

To implement custom sampling, extend `Sampler` and override `shouldSample(record)`. Return `true` to keep the span, `false` to drop it, or a `SamplingResult` object to keep and optionally add attributes or a trace state:

```typescript
import { Sampler } from 'fino:opentelemetry/traces';

class RateSampler extends Sampler {
  #rate: number;
  constructor(rate: number) { super(); this.#rate = rate; }
  shouldSample() { return Math.random() < this.#rate; }
}
```

### views

An array of `MetricView` objects. Views are applied when the SDK records each metric observation. They can rename instruments, filter attribute keys, or change aggregation type:

```typescript
const sdk = new OtelSDK({
  views: [
    {
      instrumentName: 'http.request.duration',
      name: 'http.duration',
      attributeKeys: ['http.route', 'http.method'],
    },
  ],
});
```

### spanLimits

Controls attribute, event, and link limits applied to spans before they reach processors:

```typescript
const sdk = new OtelSDK({
  spanLimits: {
    attributeCountLimit: 128,
    attributeValueLengthLimit: 1024,
    eventCountLimit: 128,
    linkCountLimit: 128,
  },
});
```

### metricCardinalityLimit

An integer cap on the number of distinct attribute-set combinations per instrument. New attribute combinations beyond the limit are dropped. Default is no limit.

## Lifecycle

`sdk.start()` activates subscriptions for trace, log, and metric records and starts any periodic readers. It is idempotent — calling it multiple times is safe.

`sdk.flush()` does the following in order:
1. Calls all registered observable metric callbacks and records their observations
2. Delivers accumulated metrics to all metric readers
3. Calls `forceFlush()` on all span processors, log processors, and metric readers in parallel

`sdk.shutdown()` calls `flush()` first, then calls `shutdown()` on all processors and readers, then disposes all instrumentation subscriptions and resets internal state. After shutdown, `start()` can be called again.

## InMemoryExporter for testing

`InMemoryExporter` accepts spans, logs, and metrics in memory. It is useful for asserting telemetry output in tests without a real collector.

```typescript
import { BatchSpanProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';

const memory = new InMemoryExporter();
const sdk = new OtelSDK({
  exporters: [memory],
  spanProcessors: [new BatchSpanProcessor(memory)],
}).start();

// ... run some code that creates spans ...

await sdk.flush();

const spans = memory.getFinishedSpans();
const logs = memory.getFinishedLogs();
const metrics = memory.getFinishedMetrics();
```

## Providers without an SDK

When no SDK is installed, signal records are published on internal topics and immediately discarded — no queue fills up, no error is thrown. This is intentional: providers work independently of SDK installation. This makes it safe to import and use the tracer, meter, or logger before an SDK is wired up, or in contexts where telemetry is intentionally disabled.
