---
weight: 20
---
# Metrics

Metrics track numerical measurements over time. Fino's metric implementation supports counters, up-down counters, gauges, histograms, and their observable equivalents. All instrument types are available from `fino:opentelemetry/metrics`.

## Getting a meter

```typescript
import { getMeterProvider } from 'fino:opentelemetry/metrics';

const meter = getMeterProvider().getMeter('orders', '1.0.0');
```

The name identifies the component or library recording the metrics. An optional version string is included in the scope metadata exported alongside each measurement.

## Synchronous instruments

Synchronous instruments record a measurement immediately when you call them. The value is published to any active SDK subscribers at that point.

**Counter** — monotonically increasing value, always positive:

```typescript
const requestCount = meter.createCounter('http.requests.total', {
  unit: '1',
  description: 'Total number of HTTP requests',
});

requestCount.add(1, { 'http.route': '/orders', 'http.method': 'POST' });
```

**UpDownCounter** — value that can increase or decrease:

```typescript
const queueDepth = meter.createUpDownCounter('queue.depth', { unit: '1' });

queueDepth.add(1);   // item enqueued
queueDepth.add(-1);  // item dequeued
```

**Gauge** — records the current absolute value, replacing any previous observation for the same attribute set:

```typescript
const temperature = meter.createGauge('system.cpu.temperature', { unit: 'Cel' });

temperature.record(72.4, { 'cpu.id': '0' });
```

**Histogram** — distributes measurements into buckets for percentile analysis:

```typescript
const latency = meter.createHistogram('http.request.duration', { unit: 'ms' });

latency.record(142, { 'http.route': '/orders' });
```

Histograms use the OpenTelemetry default explicit bucket boundaries (`[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]`) unless you supply custom boundaries via the `advice` option:

```typescript
const latency = meter.createHistogram('db.query.duration', {
  unit: 'ms',
  advice: { explicitBucketBoundaries: [1, 5, 10, 50, 100, 500] },
});
```

`Histogram` is an alias for `HistogramInstrument`. Both names are exported from `fino:opentelemetry/metrics`.

## Observable instruments

Observable instruments register a callback that the SDK calls during `flush()` or a periodic reader cycle. The callback returns one or more observations. Observable instruments are best for measurements that are expensive to compute continuously, like memory usage or queue depths polled from an external source.

The callback receives no arguments and returns an object with `value` and `attributes`, or an array of such objects.

**Observable gauge:**

```typescript
import { getMeterProvider } from 'fino:opentelemetry/metrics';

const meter = getMeterProvider().getMeter('system');

const memGauge = meter.createObservableGauge(
  'process.memory.rss',
  () => ({ value: process.memoryUsage?.().rss ?? 0, attributes: {} }),
  { unit: 'By' },
);
```

**Observable counter:**

```typescript
const reqGauge = meter.createObservableCounter(
  'http.requests.completed',
  () => ({ value: completedCount, attributes: {} }),
  { unit: '1' },
);
```

**Observable up-down counter:**

```typescript
const connGauge = meter.createObservableUpDownCounter(
  'db.connections.active',
  () => ({ value: pool.activeConnections(), attributes: {} }),
);
```

Each `create*` method returns a disposable handle. Call `handle.dispose()` to unregister the callback:

```typescript
const handle = meter.createObservableGauge('cpu.temp', () => ({ value: 0, attributes: {} }));

// later, when the component shuts down:
handle.dispose();
```

## When observables are collected

Observable callbacks are called by the SDK at two points:

1. When `sdk.flush()` is called — the SDK collects all registered callbacks, records their observations as metrics, and delivers them to configured readers before exporting.
2. On each tick of a `PeriodicMetricReader` interval — the reader triggers a `collectAndFlush` that calls all observable callbacks and exports the result.

If no SDK is installed, observable registrations are tracked but callbacks are never called. Installing an SDK later will not retroactively collect past observations.

## Attribute sets and cardinality

Each unique combination of attribute keys and values creates a separate time series. Metrics with high-cardinality attributes (like user IDs or request IDs) can produce an unbounded number of series. The SDK has a `metricCardinalityLimit` option (default: no limit) that drops new attribute combinations beyond the configured cap for a given instrument.

## Metric views

Views let the SDK rename an instrument, filter its attributes, or change its aggregation. They are configured on `OtelSDK` as the `views` option and applied when the SDK records each observation. See `sdk-setup.md` for wiring.

```typescript
import { OtelSDK } from 'fino:opentelemetry/sdk';

const sdk = new OtelSDK({
  views: [
    {
      instrumentName: 'http.request.duration',
      attributeKeys: ['http.route'],  // drop all other attributes
    },
  ],
});
```
