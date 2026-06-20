# js/opentelemetry/metrics

fino:opentelemetry/metrics - meter providers, instruments, and metric records.

This module contains the public metric signal API. Use it to create counters,
gauges, histograms, and observable instruments, or to describe metric records
delivered to SDK metric readers and exporters.

Instrument and meter names must be non-empty strings. Synchronous instruments
publish observations immediately. Observable instruments register callbacks
that the SDK collects during flush or periodic reader cycles. Histograms use
OpenTelemetry default explicit bucket boundaries unless custom advice is
supplied when the instrument is created.

```typescript
import { getMeterProvider } from 'fino:opentelemetry/metrics';

const meter = getMeterProvider().getMeter('orders');
const counter = meter.createCounter('orders.created', { unit: '1' });
counter.add(1, { tenant: 'acme' });
```

See OpenTelemetry metrics:
https://opentelemetry.io/docs/concepts/signals/metrics/

## Counter

```ts
class Counter {
```

Counter class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = Counter;
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {})
```

constructor member on Counter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Counter();
```

### add

```ts
add(value: number, attributes: Attributes = {}): void
```

add member on Counter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Counter.prototype.add;
```

## Gauge

```ts
class Gauge {
```

Gauge class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = Gauge;
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {})
```

constructor member on Gauge.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Gauge();
```

### record

```ts
record(value: number, attributes: Attributes = {}): void
```

record member on Gauge.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Gauge.prototype.record;
```

## Histogram

```ts
const Histogram
```

Histogram const exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value = Histogram;
```

## HistogramInstrument

```ts
class HistogramInstrument {
```

HistogramInstrument class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = HistogramInstrument;
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions & {
  advice?: {
    explicitBucketBoundaries?: number[];
  };
} = {})
```

constructor member on HistogramInstrument.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new HistogramInstrument();
```

### record

```ts
record(value: number, attributes: Attributes = {}): void
```

record member on HistogramInstrument.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = HistogramInstrument.prototype.record;
```

## Meter

```ts
class Meter {
```

Meter class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = Meter;
```

### constructor

```ts
constructor(provider: MeterProvider, scope: ScopeInfo)
```

constructor member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Meter();
```

### record

```ts
record(name: string, value: number, options: MetricInstrumentOptions & {
  explicitBounds?: number[];
} = {}): void
```

record member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.record;
```

### createCounter

```ts
createCounter(name: string, options: MetricInstrumentOptions = {}): Counter
```

createCounter member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createCounter;
```

### createUpDownCounter

```ts
createUpDownCounter(name: string, options: MetricInstrumentOptions = {}): UpDownCounter
```

createUpDownCounter member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createUpDownCounter;
```

### createHistogram

```ts
createHistogram(name: string, options: MetricInstrumentOptions & {
  advice?: {
    explicitBucketBoundaries?: number[];
  };
} = {}): HistogramInstrument
```

createHistogram member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createHistogram;
```

### createGauge

```ts
createGauge(name: string, options: MetricInstrumentOptions = {}): Gauge
```

createGauge member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createGauge;
```

### createObservableCounter

```ts
createObservableCounter(
  name: string,
  callback: ObservableMetricRegistration['callback'],
  options: MetricInstrumentOptions = {
  }
): ObservableCounter
```

createObservableCounter member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createObservableCounter;
```

### createObservableUpDownCounter

```ts
createObservableUpDownCounter(
  name: string,
  callback: ObservableMetricRegistration['callback'],
  options: MetricInstrumentOptions = {
  }
): ObservableUpDownCounter
```

createObservableUpDownCounter member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createObservableUpDownCounter;
```

### createObservableGauge

```ts
createObservableGauge(
  name: string,
  callback: ObservableMetricRegistration['callback'],
  options: MetricInstrumentOptions = {
  }
): ObservableGauge
```

createObservableGauge member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createObservableGauge;
```

## MeterProvider

```ts
class MeterProvider extends BaseProvider {
```

MeterProvider class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = MeterProvider;
```

### getMeter

```ts
getMeter(name: string, version?: string, options?: {
  schemaUrl?: string | null;
  attributes?: Attributes;
  droppedAttributesCount?: number;
}): Meter
```

getMeter member on MeterProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = MeterProvider.prototype.getMeter;
```

## ObservableCounter

```ts
class ObservableCounter extends ObservableGauge {
```

ObservableCounter class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = ObservableCounter;
```

## ObservableGauge

```ts
class ObservableGauge {
```

ObservableGauge class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = ObservableGauge;
```

### constructor

```ts
constructor(handle: {
  dispose(): void;
})
```

constructor member on ObservableGauge.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new ObservableGauge();
```

### dispose

```ts
dispose(): void
```

dispose member on ObservableGauge.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = ObservableGauge.prototype.dispose;
```

## ObservableUpDownCounter

```ts
class ObservableUpDownCounter extends ObservableGauge {
```

ObservableUpDownCounter class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = ObservableUpDownCounter;
```

## UpDownCounter

```ts
class UpDownCounter {
```

UpDownCounter class exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const ctor = UpDownCounter;
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {})
```

constructor member on UpDownCounter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new UpDownCounter();
```

### add

```ts
add(value: number, attributes: Attributes = {}): void
```

add member on UpDownCounter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = UpDownCounter.prototype.add;
```

## accumulateMetric

```ts
function accumulateMetric(store: Map<string, MetricRecord>, key: string, metric: MetricRecord): void
```

accumulateMetric function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = accumulateMetric;
```

## applyMetricView

```ts
function applyMetricView(metric: MetricRecord, views: MetricView[]): MetricRecord
```

applyMetricView function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = applyMetricView;
```

## attributesKey

```ts
function attributesKey(attributes: Attributes): string
```

attributesKey function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = attributesKey;
```

## cloneMetric

```ts
function cloneMetric(metric: MetricRecord): MetricRecord
```

cloneMetric function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = cloneMetric;
```

## getMeterProvider

```ts
function getMeterProvider(): MeterProvider
```

getMeterProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = getMeterProvider;
```

## metricInstrumentKey

```ts
function metricInstrumentKey(metric: MetricRecord): string
```

metricInstrumentKey function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = metricInstrumentKey;
```

## metricSeriesKey

```ts
function metricSeriesKey(metric: MetricRecord): string
```

metricSeriesKey function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = metricSeriesKey;
```

## normalizeMetricKind

```ts
function normalizeMetricKind(kind: string | undefined): string
```

normalizeMetricKind function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = normalizeMetricKind;
```

## runWithMeterProvider

```ts
function runWithMeterProvider<R>(provider: MeterProvider, fn: () => R): R
```

runWithMeterProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = runWithMeterProvider;
```

## runWithoutMeterProvider

```ts
function runWithoutMeterProvider<R>(fn: () => R): R
```

runWithoutMeterProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = runWithoutMeterProvider;
```

## setMeterProvider

```ts
function setMeterProvider(provider: MeterProvider): void
```

setMeterProvider function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = setMeterProvider;
```

## zeroMetric

```ts
function zeroMetric(metric: MetricRecord): MetricRecord
```

zeroMetric function exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const fn = zeroMetric;
```

## ExemplarRecord

```ts
interface ExemplarRecord {
```

ExemplarRecord interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: ExemplarRecord = {} as ExemplarRecord;
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExemplarRecord['timeUnixNano'];
```

### traceId

```ts
traceId?: string
```

traceId property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExemplarRecord['traceId'];
```

### spanId

```ts
spanId?: string
```

spanId property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExemplarRecord['spanId'];
```

### value

```ts
value?: number
```

value property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExemplarRecord['value'];
```

### asInt

```ts
asInt?: number
```

asInt property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExemplarRecord['asInt'];
```

### asDouble

```ts
asDouble?: number
```

asDouble property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExemplarRecord['asDouble'];
```

### filteredAttributes

```ts
filteredAttributes?: Attributes
```

filteredAttributes property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExemplarRecord['filteredAttributes'];
```

## ExponentialBuckets

```ts
interface ExponentialBuckets {
```

ExponentialBuckets interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: ExponentialBuckets = {} as ExponentialBuckets;
```

### offset

```ts
offset?: number
```

offset property on ExponentialBuckets.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExponentialBuckets['offset'];
```

### bucketCounts

```ts
bucketCounts?: Array<number | bigint>
```

bucketCounts property on ExponentialBuckets.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ExponentialBuckets['bucketCounts'];
```

## MetricAggregationType

```ts
type MetricAggregationType = 'histogram' | 'lastValue' | 'sum'
```

MetricAggregationType type exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: MetricAggregationType = {} as MetricAggregationType;
```

## MetricExemplarContext

```ts
interface MetricExemplarContext {
```

MetricExemplarContext interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: MetricExemplarContext = {} as MetricExemplarContext;
```

### traceId

```ts
traceId?: string
```

traceId property on MetricExemplarContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricExemplarContext['traceId'];
```

### spanId

```ts
spanId?: string
```

spanId property on MetricExemplarContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricExemplarContext['spanId'];
```

### traceFlags

```ts
traceFlags?: number
```

traceFlags property on MetricExemplarContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricExemplarContext['traceFlags'];
```

## MetricInstrumentOptions

```ts
interface MetricInstrumentOptions {
```

MetricInstrumentOptions interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: MetricInstrumentOptions = {} as MetricInstrumentOptions;
```

### unit

```ts
unit?: string
```

unit property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricInstrumentOptions['unit'];
```

### description

```ts
description?: string
```

description property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricInstrumentOptions['description'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricInstrumentOptions['attributes'];
```

### kind

```ts
kind?: string
```

kind property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricInstrumentOptions['kind'];
```

## MetricRecord

```ts
interface MetricRecord {
```

MetricRecord interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: MetricRecord = {} as MetricRecord;
```

### schemaVersion

```ts
schemaVersion?: number
```

schemaVersion property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['schemaVersion'];
```

### name

```ts
name: string
```

name property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['name'];
```

### value

```ts
value?: number
```

value property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['value'];
```

### count

```ts
count?: number
```

count property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['count'];
```

### sum

```ts
sum?: number
```

sum property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['sum'];
```

### min

```ts
min?: number
```

min property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['min'];
```

### max

```ts
max?: number
```

max property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['max'];
```

### unit

```ts
unit?: string
```

unit property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['unit'];
```

### description

```ts
description?: string
```

description property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['description'];
```

### kind

```ts
kind?: string
```

kind property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['kind'];
```

### aggregationKind

```ts
aggregationKind?: string
```

aggregationKind property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['aggregationKind'];
```

### aggregationTemporality

```ts
aggregationTemporality?: number
```

aggregationTemporality property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['aggregationTemporality'];
```

### isMonotonic

```ts
isMonotonic?: boolean
```

isMonotonic property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['isMonotonic'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['attributes'];
```

### metadata

```ts
metadata?: Attributes
```

metadata property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['metadata'];
```

### scope

```ts
scope?: ScopeInfo
```

scope property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['scope'];
```

### resource

```ts
resource?: Resource
```

resource property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['resource'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['timeUnixNano'];
```

### startTimeUnixNano

```ts
startTimeUnixNano?: number
```

startTimeUnixNano property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['startTimeUnixNano'];
```

### explicitBounds

```ts
explicitBounds?: number[]
```

explicitBounds property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['explicitBounds'];
```

### bucketCounts

```ts
bucketCounts?: Array<number | bigint>
```

bucketCounts property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['bucketCounts'];
```

### quantileValues

```ts
quantileValues?: QuantileValueRecord[]
```

quantileValues property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['quantileValues'];
```

### exemplars

```ts
exemplars?: ExemplarRecord[]
```

exemplars property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['exemplars'];
```

### flags

```ts
flags?: number
```

flags property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['flags'];
```

### exemplarContext

```ts
exemplarContext?: MetricExemplarContext | null
```

exemplarContext property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['exemplarContext'];
```

### scale

```ts
scale?: number
```

scale property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['scale'];
```

### zeroCount

```ts
zeroCount?: number
```

zeroCount property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['zeroCount'];
```

### zeroThreshold

```ts
zeroThreshold?: number
```

zeroThreshold property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['zeroThreshold'];
```

### positive

```ts
positive?: ExponentialBuckets
```

positive property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['positive'];
```

### negative

```ts
negative?: ExponentialBuckets
```

negative property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricRecord['negative'];
```

## MetricTemporality

```ts
type MetricTemporality = 'delta' | 'cumulative'
```

MetricTemporality type exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: MetricTemporality = {} as MetricTemporality;
```

## MetricView

```ts
interface MetricView {
```

MetricView interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: MetricView = {} as MetricView;
```

### instrumentName

```ts
instrumentName?: string
```

instrumentName property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricView['instrumentName'];
```

### name

```ts
name?: string
```

name property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricView['name'];
```

### description

```ts
description?: string
```

description property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricView['description'];
```

### attributeKeys

```ts
attributeKeys?: string[]
```

attributeKeys property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricView['attributeKeys'];
```

### aggregation

```ts
aggregation?: {
  type: MetricAggregationType;
  boundaries?: number[];
  monotonic?: boolean;
}
```

aggregation property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: MetricView['aggregation'];
```

## ObservableMetricObservation

```ts
interface ObservableMetricObservation {
```

ObservableMetricObservation interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: ObservableMetricObservation = {} as ObservableMetricObservation;
```

### value

```ts
value: number
```

value property on ObservableMetricObservation.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricObservation['value'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on ObservableMetricObservation.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricObservation['attributes'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on ObservableMetricObservation.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricObservation['timeUnixNano'];
```

## ObservableMetricRegistration

```ts
interface ObservableMetricRegistration {
```

ObservableMetricRegistration interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: ObservableMetricRegistration = {} as ObservableMetricRegistration;
```

### kind

```ts
kind: string
```

kind property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricRegistration['kind'];
```

### name

```ts
name: string
```

name property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricRegistration['name'];
```

### unit

```ts
unit: string
```

unit property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricRegistration['unit'];
```

### description

```ts
description: string
```

description property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricRegistration['description'];
```

### scope

```ts
scope: ScopeInfo
```

scope property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricRegistration['scope'];
```

### resource

```ts
resource: Resource
```

resource property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricRegistration['resource'];
```

### callback

```ts
callback: () => ObservableMetricObservation | ObservableMetricObservation[] | null | undefined
```

callback property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: ObservableMetricRegistration['callback'];
```

## QuantileValueRecord

```ts
interface QuantileValueRecord {
```

QuantileValueRecord interface exposed by the OpenTelemetry API.

Documents behavior, defaults, return shape, and failure caveats for generated API documentation.

```typescript
const value: QuantileValueRecord = {} as QuantileValueRecord;
```

### quantile

```ts
quantile: number
```

quantile property on QuantileValueRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: QuantileValueRecord['quantile'];
```

### value

```ts
value: number
```

value property on QuantileValueRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.

```typescript
let value: QuantileValueRecord['value'];
```
