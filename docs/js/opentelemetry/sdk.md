# js/opentelemetry/sdk

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

## BatchLogRecordProcessor

```ts
class BatchLogRecordProcessor extends LogRecordProcessor {
```

BatchLogRecordProcessor class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = BatchLogRecordProcessor;
```

### constructor

```ts
constructor(exporter: OtelExporter, options: {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
  attributeCountLimit?: number;
  attributeValueLengthLimit?: number;
} = {})
```

constructor member on BatchLogRecordProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new BatchLogRecordProcessor();
```

### onEmit

```ts
onEmit(log: LogRecord): void
```

onEmit member on BatchLogRecordProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = BatchLogRecordProcessor.prototype.onEmit;
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

forceFlush member on BatchLogRecordProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = BatchLogRecordProcessor.prototype.forceFlush;
```

### shutdown

```ts
async shutdown(): Promise<void>
```

shutdown member on BatchLogRecordProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = BatchLogRecordProcessor.prototype.shutdown;
```

## BatchSpanProcessor

```ts
class BatchSpanProcessor extends SpanProcessor {
```

BatchSpanProcessor class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = BatchSpanProcessor;
```

### constructor

```ts
constructor(exporter: OtelExporter, options: {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
} = {})
```

constructor member on BatchSpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new BatchSpanProcessor();
```

### droppedSpanCount

```ts
get droppedSpanCount(): number
```

droppedSpanCount member on BatchSpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = BatchSpanProcessor.prototype.droppedSpanCount;
```

### onEnd

```ts
onEnd(span: SpanRecord): void
```

onEnd member on BatchSpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = BatchSpanProcessor.prototype.onEnd;
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

forceFlush member on BatchSpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = BatchSpanProcessor.prototype.forceFlush;
```

### shutdown

```ts
async shutdown(): Promise<void>
```

shutdown member on BatchSpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = BatchSpanProcessor.prototype.shutdown;
```

## InMemoryExporter

```ts
class InMemoryExporter {
```

InMemoryExporter class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = InMemoryExporter;
```

### exportSpans

```ts
async exportSpans(spans: SpanRecord[]): Promise<ExportResult>
```

exportSpans member on InMemoryExporter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = InMemoryExporter.prototype.exportSpans;
```

### exportLogs

```ts
async exportLogs(logs: LogRecord[]): Promise<ExportResult>
```

exportLogs member on InMemoryExporter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = InMemoryExporter.prototype.exportLogs;
```

### exportMetrics

```ts
async exportMetrics(metrics: MetricRecord[]): Promise<ExportResult>
```

exportMetrics member on InMemoryExporter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = InMemoryExporter.prototype.exportMetrics;
```

### getFinishedSpans

```ts
getFinishedSpans(): SpanRecord[]
```

getFinishedSpans member on InMemoryExporter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = InMemoryExporter.prototype.getFinishedSpans;
```

### getFinishedLogs

```ts
getFinishedLogs(): LogRecord[]
```

getFinishedLogs member on InMemoryExporter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = InMemoryExporter.prototype.getFinishedLogs;
```

### getFinishedMetrics

```ts
getFinishedMetrics(): MetricRecord[]
```

getFinishedMetrics member on InMemoryExporter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = InMemoryExporter.prototype.getFinishedMetrics;
```

## LogRecordProcessor

```ts
class LogRecordProcessor {
```

LogRecordProcessor class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = LogRecordProcessor;
```

### onEmit

```ts
onEmit(_log: LogRecord): void
```

onEmit member on LogRecordProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordProcessor.prototype.onEmit;
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

forceFlush member on LogRecordProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordProcessor.prototype.forceFlush;
```

### shutdown

```ts
async shutdown(): Promise<void>
```

shutdown member on LogRecordProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordProcessor.prototype.shutdown;
```

## ManualMetricReader

```ts
class ManualMetricReader extends MetricReader {
```

ManualMetricReader class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = ManualMetricReader;
```

### receive

```ts
receive(metrics: MetricRecord[]): void
```

receive member on ManualMetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = ManualMetricReader.prototype.receive;
```

### collect

```ts
collect(): MetricRecord[]
```

collect member on ManualMetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = ManualMetricReader.prototype.collect;
```

## MetricReader

```ts
class MetricReader {
```

MetricReader class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = MetricReader;
```

### constructor

```ts
constructor(options: {
  temporality?: MetricTemporality;
} = {})
```

constructor member on MetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new MetricReader();
```

### temporality

```ts
get temporality(): MetricTemporality
```

temporality member on MetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = MetricReader.prototype.temporality;
```

### record

```ts
record(_metric: MetricRecord): void
```

record member on MetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = MetricReader.prototype.record;
```

### receive

```ts
receive(_metrics: MetricRecord[]): void
```

receive member on MetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = MetricReader.prototype.receive;
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

forceFlush member on MetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = MetricReader.prototype.forceFlush;
```

### shutdown

```ts
async shutdown(): Promise<void>
```

shutdown member on MetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = MetricReader.prototype.shutdown;
```

## OtelSDK

```ts
class OtelSDK {
```

OtelSDK class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = OtelSDK;
```

### constructor

```ts
constructor(options: {
  exporters?: OtelExporter[];
  instrumentations?: Instrumentation[];
  spanProcessors?: SpanProcessor[];
  logRecordProcessors?: LogRecordProcessor[];
  metricReaders?: MetricReader[];
  sampler?: Sampler;
  propagator?: TextMapPropagator;
  views?: MetricView[];
  metricCardinalityLimit?: number;
  spanLimits?: SpanLimits;
  resource?: Resource | Record<string, unknown> | null;
} = {})
```

constructor member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new OtelSDK();
```

### propagator

```ts
get propagator(): TextMapPropagator
```

propagator member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = OtelSDK.prototype.propagator;
```

### resource

```ts
get resource(): Resource | null
```

resource member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = OtelSDK.prototype.resource;
```

### start

```ts
start(): this
```

start member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = OtelSDK.prototype.start;
```

### recordSpanStart

```ts
recordSpanStart(span: SpanRecord): void
```

recordSpanStart member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = OtelSDK.prototype.recordSpanStart;
```

### recordSpan

```ts
recordSpan(span: SpanRecord): void
```

recordSpan member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = OtelSDK.prototype.recordSpan;
```

### recordLog

```ts
recordLog(log: LogRecord): void
```

recordLog member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = OtelSDK.prototype.recordLog;
```

### recordMetric

```ts
recordMetric(metric: MetricRecord): void
```

recordMetric member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = OtelSDK.prototype.recordMetric;
```

### flush

```ts
async flush(): Promise<void>
```

flush member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = OtelSDK.prototype.flush;
```

### shutdown

```ts
async shutdown(): Promise<void>
```

shutdown member on OtelSDK.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = OtelSDK.prototype.shutdown;
```

## PeriodicExportingMetricReader

```ts
const PeriodicExportingMetricReader
```

PeriodicExportingMetricReader const used by the internal OpenTelemetry runtime.

Documents the const's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value = PeriodicExportingMetricReader;
```

## PeriodicMetricReader

```ts
class PeriodicMetricReader extends MetricReader {
```

PeriodicMetricReader class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = PeriodicMetricReader;
```

### constructor

```ts
constructor(exporter: OtelExporter, options: {
  temporality?: MetricTemporality;
  intervalMs?: number;
} = {})
```

constructor member on PeriodicMetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new PeriodicMetricReader();
```

### _startPeriodicCollection

```ts
_startPeriodicCollection(collectAndFlush: () => Promise<void>): void
```

Called by OtelSDK.start() to wire up a periodic collection cycle.

`collectAndFlush` calls back into the SDK to collect accumulated metrics,
deliver them via `receive()`, and then call `forceFlush()` to export. A
non-positive interval disables scheduling, and repeated calls are ignored
once a timer is active.

```typescript
const reader = new PeriodicMetricReader({} as never, { intervalMs: 1000 });
reader._startPeriodicCollection(async () => {});
```

### receive

```ts
receive(metrics: MetricRecord[]): void
```

receive member on PeriodicMetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = PeriodicMetricReader.prototype.receive;
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

forceFlush member on PeriodicMetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = PeriodicMetricReader.prototype.forceFlush;
```

### shutdown

```ts
async shutdown(): Promise<void>
```

shutdown member on PeriodicMetricReader.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = PeriodicMetricReader.prototype.shutdown;
```

## SpanProcessor

```ts
class SpanProcessor {
```

SpanProcessor class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = SpanProcessor;
```

### onStart

```ts
onStart(_span: SpanRecord): void
```

onStart member on SpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = SpanProcessor.prototype.onStart;
```

### onEnd

```ts
onEnd(_span: SpanRecord): void
```

onEnd member on SpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = SpanProcessor.prototype.onEnd;
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

forceFlush member on SpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = SpanProcessor.prototype.forceFlush;
```

### shutdown

```ts
async shutdown(): Promise<void>
```

shutdown member on SpanProcessor.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = SpanProcessor.prototype.shutdown;
```

## Baggage

```ts
class Baggage {
```

Baggage class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = Baggage;
```

### constructor

```ts
constructor(entries: Record<string, string> = {})
```

constructor member on Baggage.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Baggage();
```

### get

```ts
get(key: string): string | undefined
```

get member on Baggage.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Baggage.prototype.get;
```

### set

```ts
set(key: string, value: string): Baggage
```

set member on Baggage.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Baggage.prototype.set;
```

### delete

```ts
delete(key: string): Baggage
```

delete member on Baggage.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Baggage.prototype.delete;
```

### entries

```ts
entries()
```

entries member on Baggage.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Baggage.prototype.entries;
```

### toString

```ts
toString(): string
```

toString member on Baggage.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Baggage.prototype.toString;
```

### fromString

```ts
static fromString(text: string | null | undefined): Baggage
```

Parses a W3C baggage header into an immutable `Baggage` value.

Empty, `null`, or `undefined` input returns an empty baggage object. Invalid
comma segments without `=` are ignored, and duplicate decoded keys keep the
last parsed value.

```typescript
const baggage = Baggage.fromString('tenant=acme,region=us');
```

## BaseProvider

```ts
class BaseProvider {
```

BaseProvider class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = BaseProvider;
```

### constructor

```ts
constructor(options: ProviderOptions = {})
```

constructor member on BaseProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new BaseProvider();
```

### resource

```ts
get resource(): Resource
```

resource member on BaseProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = BaseProvider.prototype.resource;
```

## OTEL_SCHEMA_VERSION

```ts
const OTEL_SCHEMA_VERSION
```

OTEL_SCHEMA_VERSION const used by the internal OpenTelemetry runtime.

Documents the const's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value = OTEL_SCHEMA_VERSION;
```

## OTEL_TOPIC_SUFFIXES

```ts
const OTEL_TOPIC_SUFFIXES
```

OTEL_TOPIC_SUFFIXES const used by the internal OpenTelemetry runtime.

Documents the const's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value = OTEL_TOPIC_SUFFIXES;
```

## Propagation

```ts
const Propagation
```

Propagation const used by the internal OpenTelemetry runtime.

Documents the const's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value = Propagation;
```

### getPropagator

```ts
getPropagator(): TextMapPropagator
```

getPropagator member on Propagation.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Propagation.getPropagator;
```

### setPropagator

```ts
setPropagator(propagator: TextMapPropagator): void
```

setPropagator member on Propagation.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Propagation.setPropagator;
```

### inject

```ts
inject<TCarrier = CarrierLike>(
  carrier: TCarrier,
  context?: TraceContext | null,
  carrierApi?: CarrierApi<TCarrier>
): void
```

Injects the active or provided context through the configured propagator.

If no explicit context is passed, the registered active-span getter is used.
Missing context is tolerated; the default W3C propagator simply leaves the
carrier unchanged.

```typescript
Propagation.inject({}, { traceId: '0'.repeat(32), spanId: '1'.repeat(16) });
```

### extract

```ts
extract<TCarrier = CarrierLike>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>
): TraceContext | null
```

Extracts context through the configured propagator.

Returns `null` when no valid trace context is present. A custom carrier API
can be supplied for header maps that do not use object-style reads.

```typescript
const context = Propagation.extract({ traceparent: '00-00000000000000000000000000000001-0000000000000001-01' });
```

## Resource

```ts
class Resource {
```

Resource class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = Resource;
```

### constructor

```ts
constructor(attributes: Attributes = {}, options: ResourceOptions = {})
```

constructor member on Resource.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Resource();
```

### attributes

```ts
get attributes(): Attributes
```

attributes member on Resource.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Resource.prototype.attributes;
```

### droppedAttributesCount

```ts
get droppedAttributesCount(): number
```

droppedAttributesCount member on Resource.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Resource.prototype.droppedAttributesCount;
```

### entityRefs

```ts
get entityRefs(): Array<{
  schemaUrl?: string;
  type?: string;
  idKeys: string[];
}>
```

entityRefs member on Resource.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Resource.prototype.entityRefs;
```

### schemaUrl

```ts
get schemaUrl(): string | null
```

schemaUrl member on Resource.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Resource.prototype.schemaUrl;
```

## TextMapPropagator

```ts
class TextMapPropagator {
```

TextMapPropagator class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = TextMapPropagator;
```

### inject

```ts
inject<TCarrier = CarrierLike>(
  _carrier: TCarrier,
  _context: TraceContext | null | undefined,
  _carrierApi?: CarrierApi<TCarrier>
): void
```

Injects trace context into a carrier.

The base propagator is a no-op for subclasses to override. It accepts a
custom carrier API for non-object carriers and never throws for missing
context.

```typescript
new TextMapPropagator().inject({}, null);
```

### extract

```ts
extract<TCarrier = CarrierLike>(
  _carrier: TCarrier,
  _carrierApi?: CarrierApi<TCarrier>
): TraceContext | null
```

Extracts trace context from a carrier.

The base propagator cannot decode any format and always returns `null`.
Subclasses return a `TraceContext` only when required carrier fields are
present and valid.

```typescript
const context = new TextMapPropagator().extract({});
```

## W3CTraceContextPropagator

```ts
class W3CTraceContextPropagator extends TextMapPropagator {
```

W3CTraceContextPropagator class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = W3CTraceContextPropagator;
```

### inject

```ts
inject<TCarrier = CarrierLike>(
  carrier: TCarrier,
  context: TraceContext | null | undefined,
  carrierApi?: CarrierApi<TCarrier>
): void
```

Writes W3C `traceparent` and optional `tracestate` values into a carrier.

Missing `traceId` or `spanId` leaves the carrier untouched. `traceFlags` are
masked to one byte and encoded as two lowercase hexadecimal digits.

```typescript
new W3CTraceContextPropagator().inject({}, { traceId: '0'.repeat(31) + '1', spanId: '0'.repeat(15) + '1' });
```

### extract

```ts
extract<TCarrier = CarrierLike>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>
): TraceContext | null
```

Reads W3C trace context from `traceparent` and optional `tracestate`.

Returns `null` for malformed headers, all-zero trace IDs, all-zero span IDs,
or v00 headers with trailing data. Unknown versions are parsed
permissively for forward compatibility.

```typescript
const context = new W3CTraceContextPropagator().extract({ traceparent: '00-00000000000000000000000000000001-0000000000000001-01' });
```

## bytesEqual

```ts
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
```

bytesEqual function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = bytesEqual;
```

## carrierApiFor

```ts
function carrierApiFor<TCarrier>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>
): CarrierApi<TCarrier>
```

carrierApiFor function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = carrierApiFor;
```

## consumeRequestContext

```ts
function consumeRequestContext(requestId: string): ActiveTelemetryContext | null
```

consumeRequestContext function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = consumeRequestContext;
```

## currentActiveTelemetryContext

```ts
function currentActiveTelemetryContext(): ActiveTelemetryContext | undefined
```

currentActiveTelemetryContext function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = currentActiveTelemetryContext;
```

## defaultCarrierApiFor

```ts
function defaultCarrierApiFor<TCarrier extends CarrierLike>(carrier: TCarrier): CarrierApi<TCarrier>
```

defaultCarrierApiFor function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = defaultCarrierApiFor;
```

## encodeSegment

```ts
function encodeSegment(value: unknown): string
```

encodeSegment function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = encodeSegment;
```

## getActiveBaggage

```ts
function getActiveBaggage(): Baggage
```

getActiveBaggage function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getActiveBaggage;
```

## hexToBytes

```ts
function hexToBytes(hex: string, size: number): Uint8Array
```

hexToBytes function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = hexToBytes;
```

## installRequestContext

```ts
function installRequestContext(requestId: string, context: ActiveTelemetryContext): void
```

installRequestContext function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = installRequestContext;
```

## limitAttributeEntries

```ts
function limitAttributeEntries(attributes: Attributes, limits: {
  attributeCountLimit?: number;
  attributeValueLengthLimit?: number;
}): {
  attrs: Attributes;
  dropped: number;
}
```

limitAttributeEntries function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = limitAttributeEntries;
```

## mergeAttributes

```ts
function mergeAttributes(a?: Attributes, b?: Attributes): Attributes
```

mergeAttributes function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = mergeAttributes;
```

## normalizeResource

```ts
function normalizeResource(resource?: Resource | Attributes | null): Resource
```

normalizeResource function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = normalizeResource;
```

## normalizeScope

```ts
function normalizeScope(
  name: string,
  version?: string,
  schemaUrl?: string | null,
  attributes?: Attributes,
  droppedAttributesCount?: number
): ScopeInfo
```

normalizeScope function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = normalizeScope;
```

## nowUnixNano

```ts
function nowUnixNano(): number
```

nowUnixNano function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = nowUnixNano;
```

## otelRuntimeEvent

```ts
function otelRuntimeEvent<TPayload extends Record<string, unknown>>(domain: string, operation: string, phase: string, payload: TPayload = {} as TPayload): TPayload & {
  schemaVersion: number;
  topic: string;
  family: string;
  domain: string;
  operation: string;
  phase: string;
  correlationId: unknown;
}
```

otelRuntimeEvent function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = otelRuntimeEvent;
```

## otelRuntimeTopic

```ts
function otelRuntimeTopic(domain: string, operation: string, phase: string): string
```

otelRuntimeTopic function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = otelRuntimeTopic;
```

## otelTopic

```ts
function otelTopic(signal: string, scope: ScopeInfo, ...suffixes: string[]): string
```

otelTopic function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = otelTopic;
```

## publishScoped

```ts
function publishScoped<TPayload>(
  signal: SignalName,
  scope: ScopeInfo,
  suffixes: string[],
  payload: TPayload
): void
```

publishScoped function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = publishScoped;
```

## randomHex

```ts
function randomHex(length: number): string
```

randomHex function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = randomHex;
```

## registerActiveSpanContextGetter

```ts
function registerActiveSpanContextGetter(getter: () => TraceContext | null): void
```

registerActiveSpanContextGetter function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = registerActiveSpanContextGetter;
```

## requireNonEmptyName

```ts
function requireNonEmptyName(kind: string, value: unknown): string
```

requireNonEmptyName function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = requireNonEmptyName;
```

## requireRecord

```ts
function requireRecord(kind: string, value: unknown): Record<string, unknown>
```

requireRecord function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = requireRecord;
```

## runWithActiveContext

```ts
function runWithActiveContext<R>(context: ActiveTelemetryContext, fn: () => R): R
```

runWithActiveContext function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithActiveContext;
```

## runWithBaggage

```ts
function runWithBaggage<R>(baggage: Baggage, fn: () => R): R
```

runWithBaggage function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithBaggage;
```

## scopeSegment

```ts
function scopeSegment(scope: ScopeInfo): string
```

scopeSegment function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = scopeSegment;
```

## snapshotCarrier

```ts
function snapshotCarrier<TCarrier extends CarrierLike>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>
): Record<string, unknown>
```

snapshotCarrier function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = snapshotCarrier;
```

## topic

```ts
function topic<T = unknown>(name: string): Topic<T>
```

Re-exported from `topic.topic`.

## topicNames

```ts
function topicNames(signal: string, scope: ScopeInfo, ...suffixes: string[]): string[]
```

topicNames function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = topicNames;
```

## truncateAttributeValue

```ts
function truncateAttributeValue(value: unknown, limit: number): unknown
```

truncateAttributeValue function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = truncateAttributeValue;
```

## Attributes

```ts
type Attributes = Record<string, unknown>
```

Attributes type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: Attributes = {} as Attributes;
```

## CarrierApi

```ts
interface CarrierApi<TCarrier = CarrierLike> {
```

CarrierApi interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: CarrierApi = {} as CarrierApi;
```

### get

```ts
get(target: TCarrier, key: string): unknown
```

get method on CarrierApi.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: CarrierApi['get'] = undefined as never;
```

### set

```ts
set(target: TCarrier, key: string, value: unknown): void
```

set method on CarrierApi.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: CarrierApi['set'] = undefined as never;
```

### keys

```ts
keys(target: TCarrier): string[]
```

keys method on CarrierApi.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: CarrierApi['keys'] = undefined as never;
```

## CarrierLike

```ts
type CarrierLike = {
  [key: string]: unknown;
  get?(key: string): unknown;
  set?(key: string, value: unknown): unknown;
  keys?(): Iterable<string>;
}
```

CarrierLike type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: CarrierLike = {} as CarrierLike;
```

## Disposable

```ts
interface Disposable {
```

Disposable interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: Disposable = {} as Disposable;
```

### dispose

```ts
dispose(): void
```

dispose method on Disposable.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: Disposable['dispose'] = undefined as never;
```

## ExportResult

```ts
interface ExportResult {
```

ExportResult interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ExportResult = {} as ExportResult;
```

### code

```ts
code: 'success' | 'failure'
```

code property on ExportResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExportResult['code'];
```

## Instrumentation

```ts
interface Instrumentation {
```

Instrumentation interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: Instrumentation = {} as Instrumentation;
```

### enable

```ts
enable(sdk: OtelSdkLike): void | Disposable | Disposable[]
```

enable method on Instrumentation.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: Instrumentation['enable'] = undefined as never;
```

## OtelExporter

```ts
interface OtelExporter {
```

OtelExporter interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: OtelExporter = {} as OtelExporter;
```

### exportSpans

```ts
exportSpans(spans: SpanRecord[]): Promise<ExportResult>
```

exportSpans method on OtelExporter.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelExporter['exportSpans'] = undefined as never;
```

### exportLogs

```ts
exportLogs(logs: LogRecord[]): Promise<ExportResult>
```

exportLogs method on OtelExporter.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelExporter['exportLogs'] = undefined as never;
```

### exportMetrics

```ts
exportMetrics(metrics: MetricRecord[]): Promise<ExportResult>
```

exportMetrics method on OtelExporter.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelExporter['exportMetrics'] = undefined as never;
```

### shutdown

```ts
shutdown?(): Promise<void>
```

shutdown method on OtelExporter.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelExporter['shutdown'] = undefined as never;
```

## OtelSdkLike

```ts
interface OtelSdkLike {
```

OtelSdkLike interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: OtelSdkLike = {} as OtelSdkLike;
```

### propagator

```ts
readonly propagator: TextMapPropagator
```

propagator property on OtelSdkLike.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: OtelSdkLike['propagator'];
```

### recordSpanStart

```ts
recordSpanStart(span: SpanRecord): void
```

recordSpanStart method on OtelSdkLike.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelSdkLike['recordSpanStart'] = undefined as never;
```

### recordSpan

```ts
recordSpan(span: SpanRecord): void
```

recordSpan method on OtelSdkLike.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelSdkLike['recordSpan'] = undefined as never;
```

### recordLog

```ts
recordLog(log: LogRecord): void
```

recordLog method on OtelSdkLike.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelSdkLike['recordLog'] = undefined as never;
```

### recordMetric

```ts
recordMetric(metric: MetricRecord): void
```

recordMetric method on OtelSdkLike.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
const member: OtelSdkLike['recordMetric'] = undefined as never;
```

## PartialSuccessResult

```ts
interface PartialSuccessResult {
```

PartialSuccessResult interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: PartialSuccessResult = {} as PartialSuccessResult;
```

### rejectedSpans

```ts
rejectedSpans: number
```

rejectedSpans property on PartialSuccessResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: PartialSuccessResult['rejectedSpans'];
```

### rejectedLogs

```ts
rejectedLogs: number
```

rejectedLogs property on PartialSuccessResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: PartialSuccessResult['rejectedLogs'];
```

### rejectedDataPoints

```ts
rejectedDataPoints: number
```

rejectedDataPoints property on PartialSuccessResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: PartialSuccessResult['rejectedDataPoints'];
```

### errorMessage

```ts
errorMessage: string
```

errorMessage property on PartialSuccessResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: PartialSuccessResult['errorMessage'];
```

## ProviderOptions

```ts
interface ProviderOptions {
```

ProviderOptions interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ProviderOptions = {} as ProviderOptions;
```

### resource

```ts
resource?: Resource | Attributes | null
```

resource property on ProviderOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ProviderOptions['resource'];
```

## ResourceOptions

```ts
interface ResourceOptions {
```

ResourceOptions interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ResourceOptions = {} as ResourceOptions;
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

droppedAttributesCount property on ResourceOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ResourceOptions['droppedAttributesCount'];
```

### entityRefs

```ts
entityRefs?: Array<{
  schemaUrl?: string;
  type?: string;
  idKeys?: string[];
}>
```

entityRefs property on ResourceOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ResourceOptions['entityRefs'];
```

### schemaUrl

```ts
schemaUrl?: string | null
```

schemaUrl property on ResourceOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ResourceOptions['schemaUrl'];
```

## RetryOptions

```ts
interface RetryOptions {
```

RetryOptions interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: RetryOptions = {} as RetryOptions;
```

### maxAttempts

```ts
maxAttempts?: number
```

maxAttempts property on RetryOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RetryOptions['maxAttempts'];
```

### initialBackoffMillis

```ts
initialBackoffMillis?: number
```

initialBackoffMillis property on RetryOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RetryOptions['initialBackoffMillis'];
```

## RuntimeDnsEvent

```ts
interface RuntimeDnsEvent {
```

RuntimeDnsEvent interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: RuntimeDnsEvent = {} as RuntimeDnsEvent;
```

### lookupId

```ts
lookupId: string
```

lookupId property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['lookupId'];
```

### requestId

```ts
requestId?: string
```

requestId property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['requestId'];
```

### hop

```ts
hop?: number
```

hop property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['hop'];
```

### hostname

```ts
hostname?: string
```

hostname property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['hostname'];
```

### address

```ts
address?: string
```

address property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['address'];
```

### family

```ts
family?: string | number
```

family property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['family'];
```

### error

```ts
error?: unknown
```

error property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['error'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['timeUnixNano'];
```

### resource

```ts
resource?: Resource
```

resource property on RuntimeDnsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeDnsEvent['resource'];
```

## RuntimeHttpRequestEvent

```ts
interface RuntimeHttpRequestEvent {
```

RuntimeHttpRequestEvent interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: RuntimeHttpRequestEvent = {} as RuntimeHttpRequestEvent;
```

### requestId

```ts
requestId: string
```

requestId property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['requestId'];
```

### method

```ts
method?: string
```

method property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['method'];
```

### route

```ts
route?: string
```

route property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['route'];
```

### url

```ts
url?: string
```

url property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['url'];
```

### headers

```ts
headers?: CarrierLike
```

headers property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['headers'];
```

### statusCode

```ts
statusCode?: number
```

statusCode property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['statusCode'];
```

### error

```ts
error?: unknown
```

error property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['error'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['timeUnixNano'];
```

### resource

```ts
resource?: Resource
```

resource property on RuntimeHttpRequestEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeHttpRequestEvent['resource'];
```

## RuntimeSocketEvent

```ts
interface RuntimeSocketEvent {
```

RuntimeSocketEvent interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: RuntimeSocketEvent = {} as RuntimeSocketEvent;
```

### connectId

```ts
connectId: string
```

connectId property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['connectId'];
```

### requestId

```ts
requestId?: string
```

requestId property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['requestId'];
```

### hop

```ts
hop?: number
```

hop property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['hop'];
```

### host

```ts
host?: string
```

host property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['host'];
```

### port

```ts
port?: number
```

port property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['port'];
```

### transport

```ts
transport?: string
```

transport property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['transport'];
```

### error

```ts
error?: unknown
```

error property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['error'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['timeUnixNano'];
```

### resource

```ts
resource?: Resource
```

resource property on RuntimeSocketEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeSocketEvent['resource'];
```

## RuntimeTlsEvent

```ts
interface RuntimeTlsEvent {
```

RuntimeTlsEvent interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: RuntimeTlsEvent = {} as RuntimeTlsEvent;
```

### handshakeId

```ts
handshakeId: string
```

handshakeId property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['handshakeId'];
```

### requestId

```ts
requestId?: string
```

requestId property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['requestId'];
```

### hop

```ts
hop?: number
```

hop property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['hop'];
```

### hostname

```ts
hostname?: string
```

hostname property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['hostname'];
```

### port

```ts
port?: number
```

port property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['port'];
```

### protocol

```ts
protocol?: string
```

protocol property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['protocol'];
```

### error

```ts
error?: unknown
```

error property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['error'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['timeUnixNano'];
```

### resource

```ts
resource?: Resource
```

resource property on RuntimeTlsEvent.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: RuntimeTlsEvent['resource'];
```

## ScopeInfo

```ts
type ScopeInfo = {
  name: string;
  version?: string;
  schemaUrl?: string | null;
  attributes?: Attributes;
  droppedAttributesCount?: number;
}
```

ScopeInfo type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ScopeInfo = {} as ScopeInfo;
```

## SignalName

```ts
type SignalName = 'trace' | 'log' | 'metric'
```

SignalName type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SignalName = {} as SignalName;
```
