# opentelemetry

fino:opentelemetry - tracing, metrics, logs, and SDK helpers.

This module re-exports the public OpenTelemetry surface used by runtime
instrumentation and application code. It includes context propagation,
span/log/metric model types, exporters, and SDK wiring helpers.

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

## Attributes

```ts
type Attributes = Record<string, unknown>
```

Attributes type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: Attributes = {} as Attributes;
```

## ScopeInfo

```ts
type ScopeInfo = { /** * name property on ScopeInfo. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * let value: ScopeInfo['name']; * ``` */ name: string; /** * version property on ScopeInfo. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * let value: ScopeInfo['version']; * ``` */ version?: string; /** * schemaUrl property on ScopeInfo. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * let value: ScopeInfo['schemaUrl']; * ``` */ schemaUrl?: string | null; /** * attributes property on ScopeInfo. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * let value: ScopeInfo['attributes']; * ``` */ attributes?: Attributes; /** * droppedAttributesCount property on ScopeInfo. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * let value: ScopeInfo['droppedAttributesCount']; * ``` */ droppedAttributesCount?: number; }
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

## MetricTemporality

```ts
type MetricTemporality = 'delta' | 'cumulative'
```

MetricTemporality type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: MetricTemporality = {} as MetricTemporality;
```

## MetricAggregationType

```ts
type MetricAggregationType = 'histogram' | 'lastValue' | 'sum'
```

MetricAggregationType type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: MetricAggregationType = {} as MetricAggregationType;
```

## CarrierLike

```ts
type CarrierLike = { [key: string]: unknown; /** * get method on CarrierLike. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * const member: CarrierLike['get'] = undefined as never; * ``` */ get?(key: string): unknown; /** * set method on CarrierLike. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * const member: CarrierLike['set'] = undefined as never; * ``` */ set?(key: string, value: unknown): unknown; /** * keys method on CarrierLike. * * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads. * * ```typescript no_run * const member: CarrierLike['keys'] = undefined as never; * ``` */ keys?(): Iterable<string>; }
```

CarrierLike type used by the internal OpenTelemetry runtime.

Documents the type's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: CarrierLike = {} as CarrierLike;
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

## TraceContext

```ts
interface TraceContext {
```

TraceContext interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: TraceContext = {} as TraceContext;
```

### traceId

```ts
traceId?: string
```

traceId property on TraceContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: TraceContext['traceId'];
```

### spanId

```ts
spanId?: string
```

spanId property on TraceContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: TraceContext['spanId'];
```

### traceFlags

```ts
traceFlags?: number
```

traceFlags property on TraceContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: TraceContext['traceFlags'];
```

### traceState

```ts
traceState?: string
```

traceState property on TraceContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: TraceContext['traceState'];
```

### baggage

```ts
baggage?: Baggage | null
```

baggage property on TraceContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: TraceContext['baggage'];
```

## SpanStatus

```ts
interface SpanStatus {
```

SpanStatus interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanStatus = {} as SpanStatus;
```

### code

```ts
code?: string
```

code property on SpanStatus.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanStatus['code'];
```

### message

```ts
message?: string
```

message property on SpanStatus.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanStatus['message'];
```

## SpanLinkContext

```ts
interface SpanLinkContext {
```

SpanLinkContext interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanLinkContext = {} as SpanLinkContext;
```

### traceId

```ts
traceId: string
```

traceId property on SpanLinkContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLinkContext['traceId'];
```

### spanId

```ts
spanId: string
```

spanId property on SpanLinkContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLinkContext['spanId'];
```

### traceState

```ts
traceState?: string
```

traceState property on SpanLinkContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLinkContext['traceState'];
```

### flags

```ts
flags?: number
```

flags property on SpanLinkContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLinkContext['flags'];
```

## SpanLinkRecord

```ts
interface SpanLinkRecord extends SpanLinkContext {
```

SpanLinkRecord interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanLinkRecord = {} as SpanLinkRecord;
```

### attributes

```ts
attributes?: Attributes
```

attributes property on SpanLinkRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLinkRecord['attributes'];
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

droppedAttributesCount property on SpanLinkRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLinkRecord['droppedAttributesCount'];
```

## SpanEventRecord

```ts
interface SpanEventRecord {
```

SpanEventRecord interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanEventRecord = {} as SpanEventRecord;
```

### name

```ts
name: string
```

name property on SpanEventRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanEventRecord['name'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on SpanEventRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanEventRecord['attributes'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on SpanEventRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanEventRecord['timeUnixNano'];
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

droppedAttributesCount property on SpanEventRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanEventRecord['droppedAttributesCount'];
```

## SpanRecord

```ts
interface SpanRecord {
```

SpanRecord interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanRecord = {} as SpanRecord;
```

### schemaVersion

```ts
schemaVersion?: number
```

schemaVersion property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['schemaVersion'];
```

### operation

```ts
operation?: string
```

operation property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['operation'];
```

### name

```ts
name?: string
```

name property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['name'];
```

### traceId

```ts
traceId: string
```

traceId property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['traceId'];
```

### spanId

```ts
spanId: string
```

spanId property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['spanId'];
```

### parentSpanId

```ts
parentSpanId?: string | null
```

parentSpanId property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['parentSpanId'];
```

### traceState

```ts
traceState?: string
```

traceState property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['traceState'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['timeUnixNano'];
```

### startTimeUnixNano

```ts
startTimeUnixNano?: number
```

startTimeUnixNano property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['startTimeUnixNano'];
```

### endTimeUnixNano

```ts
endTimeUnixNano?: number
```

endTimeUnixNano property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['endTimeUnixNano'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['attributes'];
```

### scope

```ts
scope?: ScopeInfo
```

scope property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['scope'];
```

### resource

```ts
resource?: Resource
```

resource property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['resource'];
```

### kind

```ts
kind?: string
```

kind property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['kind'];
```

### status

```ts
status?: SpanStatus | null
```

status property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['status'];
```

### events

```ts
events?: SpanEventRecord[]
```

events property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['events'];
```

### links

```ts
links?: SpanLinkRecord[]
```

links property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['links'];
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

droppedAttributesCount property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['droppedAttributesCount'];
```

### droppedEventsCount

```ts
droppedEventsCount?: number
```

droppedEventsCount property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['droppedEventsCount'];
```

### droppedLinksCount

```ts
droppedLinksCount?: number
```

droppedLinksCount property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['droppedLinksCount'];
```

### flags

```ts
flags?: number
```

flags property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['flags'];
```

### injectedHeaders

```ts
injectedHeaders?: Record<string, unknown>
```

injectedHeaders property on SpanRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanRecord['injectedHeaders'];
```

## LogRecord

```ts
interface LogRecord {
```

LogRecord interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: LogRecord = {} as LogRecord;
```

### schemaVersion

```ts
schemaVersion?: number
```

schemaVersion property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['schemaVersion'];
```

### body

```ts
body?: unknown
```

body property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['body'];
```

### severityText

```ts
severityText?: string
```

severityText property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['severityText'];
```

### severityNumber

```ts
severityNumber?: number
```

severityNumber property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['severityNumber'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['timeUnixNano'];
```

### observedTimeUnixNano

```ts
observedTimeUnixNano?: number
```

observedTimeUnixNano property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['observedTimeUnixNano'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['attributes'];
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

droppedAttributesCount property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['droppedAttributesCount'];
```

### scope

```ts
scope?: ScopeInfo
```

scope property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['scope'];
```

### resource

```ts
resource?: Resource
```

resource property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['resource'];
```

### traceId

```ts
traceId?: string
```

traceId property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['traceId'];
```

### spanId

```ts
spanId?: string
```

spanId property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['spanId'];
```

### traceFlags

```ts
traceFlags?: number
```

traceFlags property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['traceFlags'];
```

### baggage

```ts
baggage?: Baggage | null
```

baggage property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['baggage'];
```

### eventName

```ts
eventName?: string
```

eventName property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['eventName'];
```

### categoryName

```ts
categoryName?: string
```

categoryName property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['categoryName'];
```

### flags

```ts
flags?: number
```

flags property on LogRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: LogRecord['flags'];
```

## ExemplarRecord

```ts
interface ExemplarRecord {
```

ExemplarRecord interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ExemplarRecord = {} as ExemplarRecord;
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExemplarRecord['timeUnixNano'];
```

### traceId

```ts
traceId?: string
```

traceId property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExemplarRecord['traceId'];
```

### spanId

```ts
spanId?: string
```

spanId property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExemplarRecord['spanId'];
```

### value

```ts
value?: number
```

value property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExemplarRecord['value'];
```

### asInt

```ts
asInt?: number
```

asInt property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExemplarRecord['asInt'];
```

### asDouble

```ts
asDouble?: number
```

asDouble property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExemplarRecord['asDouble'];
```

### filteredAttributes

```ts
filteredAttributes?: Attributes
```

filteredAttributes property on ExemplarRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExemplarRecord['filteredAttributes'];
```

## QuantileValueRecord

```ts
interface QuantileValueRecord {
```

QuantileValueRecord interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: QuantileValueRecord = {} as QuantileValueRecord;
```

### quantile

```ts
quantile: number
```

quantile property on QuantileValueRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: QuantileValueRecord['quantile'];
```

### value

```ts
value: number
```

value property on QuantileValueRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: QuantileValueRecord['value'];
```

## ExponentialBuckets

```ts
interface ExponentialBuckets {
```

ExponentialBuckets interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ExponentialBuckets = {} as ExponentialBuckets;
```

### offset

```ts
offset?: number
```

offset property on ExponentialBuckets.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExponentialBuckets['offset'];
```

### bucketCounts

```ts
bucketCounts?: Array<number | bigint>
```

bucketCounts property on ExponentialBuckets.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ExponentialBuckets['bucketCounts'];
```

## MetricExemplarContext

```ts
interface MetricExemplarContext {
```

MetricExemplarContext interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: MetricExemplarContext = {} as MetricExemplarContext;
```

### traceId

```ts
traceId?: string
```

traceId property on MetricExemplarContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricExemplarContext['traceId'];
```

### spanId

```ts
spanId?: string
```

spanId property on MetricExemplarContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricExemplarContext['spanId'];
```

### traceFlags

```ts
traceFlags?: number
```

traceFlags property on MetricExemplarContext.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricExemplarContext['traceFlags'];
```

## MetricRecord

```ts
interface MetricRecord {
```

MetricRecord interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: MetricRecord = {} as MetricRecord;
```

### schemaVersion

```ts
schemaVersion?: number
```

schemaVersion property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['schemaVersion'];
```

### name

```ts
name: string
```

name property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['name'];
```

### value

```ts
value?: number
```

value property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['value'];
```

### count

```ts
count?: number
```

count property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['count'];
```

### sum

```ts
sum?: number
```

sum property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['sum'];
```

### min

```ts
min?: number
```

min property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['min'];
```

### max

```ts
max?: number
```

max property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['max'];
```

### unit

```ts
unit?: string
```

unit property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['unit'];
```

### description

```ts
description?: string
```

description property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['description'];
```

### kind

```ts
kind?: string
```

kind property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['kind'];
```

### aggregationKind

```ts
aggregationKind?: string
```

aggregationKind property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['aggregationKind'];
```

### aggregationTemporality

```ts
aggregationTemporality?: number
```

aggregationTemporality property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['aggregationTemporality'];
```

### isMonotonic

```ts
isMonotonic?: boolean
```

isMonotonic property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['isMonotonic'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['attributes'];
```

### metadata

```ts
metadata?: Attributes
```

metadata property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['metadata'];
```

### scope

```ts
scope?: ScopeInfo
```

scope property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['scope'];
```

### resource

```ts
resource?: Resource
```

resource property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['resource'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['timeUnixNano'];
```

### startTimeUnixNano

```ts
startTimeUnixNano?: number
```

startTimeUnixNano property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['startTimeUnixNano'];
```

### explicitBounds

```ts
explicitBounds?: number[]
```

explicitBounds property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['explicitBounds'];
```

### bucketCounts

```ts
bucketCounts?: Array<number | bigint>
```

bucketCounts property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['bucketCounts'];
```

### quantileValues

```ts
quantileValues?: QuantileValueRecord[]
```

quantileValues property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['quantileValues'];
```

### exemplars

```ts
exemplars?: ExemplarRecord[]
```

exemplars property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['exemplars'];
```

### flags

```ts
flags?: number
```

flags property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['flags'];
```

### exemplarContext

```ts
exemplarContext?: MetricExemplarContext | null
```

exemplarContext property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['exemplarContext'];
```

### scale

```ts
scale?: number
```

scale property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['scale'];
```

### zeroCount

```ts
zeroCount?: number
```

zeroCount property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['zeroCount'];
```

### zeroThreshold

```ts
zeroThreshold?: number
```

zeroThreshold property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['zeroThreshold'];
```

### positive

```ts
positive?: ExponentialBuckets
```

positive property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['positive'];
```

### negative

```ts
negative?: ExponentialBuckets
```

negative property on MetricRecord.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricRecord['negative'];
```

## ObservableMetricObservation

```ts
interface ObservableMetricObservation {
```

ObservableMetricObservation interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ObservableMetricObservation = {} as ObservableMetricObservation;
```

### value

```ts
value: number
```

value property on ObservableMetricObservation.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricObservation['value'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on ObservableMetricObservation.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricObservation['attributes'];
```

### timeUnixNano

```ts
timeUnixNano?: number
```

timeUnixNano property on ObservableMetricObservation.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricObservation['timeUnixNano'];
```

## ObservableMetricRegistration

```ts
interface ObservableMetricRegistration {
```

ObservableMetricRegistration interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ObservableMetricRegistration = {} as ObservableMetricRegistration;
```

### kind

```ts
kind: string
```

kind property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricRegistration['kind'];
```

### name

```ts
name: string
```

name property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricRegistration['name'];
```

### unit

```ts
unit: string
```

unit property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricRegistration['unit'];
```

### description

```ts
description: string
```

description property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricRegistration['description'];
```

### scope

```ts
scope: ScopeInfo
```

scope property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricRegistration['scope'];
```

### resource

```ts
resource: Resource
```

resource property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricRegistration['resource'];
```

### callback

```ts
callback: () => ObservableMetricObservation | ObservableMetricObservation[] | null | undefined
```

callback property on ObservableMetricRegistration.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: ObservableMetricRegistration['callback'];
```

## MetricInstrumentOptions

```ts
interface MetricInstrumentOptions {
```

MetricInstrumentOptions interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: MetricInstrumentOptions = {} as MetricInstrumentOptions;
```

### unit

```ts
unit?: string
```

unit property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricInstrumentOptions['unit'];
```

### description

```ts
description?: string
```

description property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricInstrumentOptions['description'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricInstrumentOptions['attributes'];
```

### kind

```ts
kind?: string
```

kind property on MetricInstrumentOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricInstrumentOptions['kind'];
```

## MetricView

```ts
interface MetricView {
```

MetricView interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: MetricView = {} as MetricView;
```

### instrumentName

```ts
instrumentName?: string
```

instrumentName property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricView['instrumentName'];
```

### name

```ts
name?: string
```

name property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricView['name'];
```

### description

```ts
description?: string
```

description property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricView['description'];
```

### attributeKeys

```ts
attributeKeys?: string[]
```

attributeKeys property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricView['attributeKeys'];
```

### aggregation

```ts
aggregation?: { type: MetricAggregationType; boundaries?: number[]; monotonic?: boolean; }
```

aggregation property on MetricView.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: MetricView['aggregation'];
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
entityRefs?: Array<{ schemaUrl?: string; type?: string; idKeys?: string[] }>
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

## SpanStartOptions

```ts
interface SpanStartOptions {
```

SpanStartOptions interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanStartOptions = {} as SpanStartOptions;
```

### traceId

```ts
traceId?: string
```

traceId property on SpanStartOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanStartOptions['traceId'];
```

### parentSpanId

```ts
parentSpanId?: string | null
```

parentSpanId property on SpanStartOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanStartOptions['parentSpanId'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on SpanStartOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanStartOptions['attributes'];
```

### links

```ts
links?: SpanLinkRecord[]
```

links property on SpanStartOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanStartOptions['links'];
```

### kind

```ts
kind?: string
```

kind property on SpanStartOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanStartOptions['kind'];
```

## SpanEndOptions

```ts
interface SpanEndOptions {
```

SpanEndOptions interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanEndOptions = {} as SpanEndOptions;
```

### attributes

```ts
attributes?: Attributes
```

attributes property on SpanEndOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanEndOptions['attributes'];
```

### status

```ts
status?: SpanStatus | null
```

status property on SpanEndOptions.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanEndOptions['status'];
```

## ActiveTelemetryContext

```ts
interface ActiveTelemetryContext extends TraceContext {
```

ActiveTelemetryContext interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: ActiveTelemetryContext = {} as ActiveTelemetryContext;
```

## SamplingResult

```ts
interface SamplingResult {
```

SamplingResult interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SamplingResult = {} as SamplingResult;
```

### sample

```ts
sample: boolean
```

sample property on SamplingResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SamplingResult['sample'];
```

### attributes

```ts
attributes?: Attributes
```

attributes property on SamplingResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SamplingResult['attributes'];
```

### traceState

```ts
traceState?: string
```

traceState property on SamplingResult.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SamplingResult['traceState'];
```

## SpanLimits

```ts
interface SpanLimits {
```

SpanLimits interface used by the internal OpenTelemetry runtime.

Documents the interface's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value: SpanLimits = {} as SpanLimits;
```

### attributeCountLimit

```ts
attributeCountLimit?: number
```

attributeCountLimit property on SpanLimits.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLimits['attributeCountLimit'];
```

### attributeValueLengthLimit

```ts
attributeValueLengthLimit?: number
```

attributeValueLengthLimit property on SpanLimits.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLimits['attributeValueLengthLimit'];
```

### eventCountLimit

```ts
eventCountLimit?: number
```

eventCountLimit property on SpanLimits.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLimits['eventCountLimit'];
```

### linkCountLimit

```ts
linkCountLimit?: number
```

linkCountLimit property on SpanLimits.

Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in private telemetry payloads.

```typescript
let value: SpanLimits['linkCountLimit'];
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

## requireRecord

```ts
function requireRecord(kind: string, value: unknown): Record<string, unknown>
```

requireRecord function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = requireRecord;
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

## nowUnixNano

```ts
function nowUnixNano(): number
```

nowUnixNano function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = nowUnixNano;
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

## encodeSegment

```ts
function encodeSegment(value: unknown): string
```

encodeSegment function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = encodeSegment;
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

## scopeSegment

```ts
function scopeSegment(scope: ScopeInfo): string
```

scopeSegment function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = scopeSegment;
```

## normalizeScope

```ts
function normalizeScope( name: string, version?: string, schemaUrl?: string | null, attributes?: Attributes, droppedAttributesCount?: number, ): ScopeInfo
```

normalizeScope function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = normalizeScope;
```

## topicNames

```ts
function topicNames(signal: string, scope: ScopeInfo, ...suffixes: string[]): string[]
```

topicNames function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = topicNames;
```

## publishScoped

```ts
function publishScoped<TPayload>(signal: SignalName, scope: ScopeInfo, suffixes: string[], payload: TPayload): void
```

publishScoped function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = publishScoped;
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

## bytesEqual

```ts
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
```

bytesEqual function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = bytesEqual;
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
get entityRefs(): Array<{ schemaUrl?: string; type?: string; idKeys: string[] }>
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

## normalizeResource

```ts
function normalizeResource(resource?: Resource | Attributes | null): Resource
```

normalizeResource function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = normalizeResource;
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
inject<TCarrier = CarrierLike>( _carrier: TCarrier, _context: TraceContext | null | undefined, _carrierApi?: CarrierApi<TCarrier>, ): void
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
extract<TCarrier = CarrierLike>(_carrier: TCarrier, _carrierApi?: CarrierApi<TCarrier>): TraceContext | null
```

Extracts trace context from a carrier.

The base propagator cannot decode any format and always returns `null`.
Subclasses return a `TraceContext` only when required carrier fields are
present and valid.

```typescript
const context = new TextMapPropagator().extract({});
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

## carrierApiFor

```ts
function carrierApiFor<TCarrier>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): CarrierApi<TCarrier>
```

carrierApiFor function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = carrierApiFor;
```

## snapshotCarrier

```ts
function snapshotCarrier<TCarrier extends CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): Record<string, unknown>
```

snapshotCarrier function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = snapshotCarrier;
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

## getActiveBaggage

```ts
function getActiveBaggage(): Baggage
```

getActiveBaggage function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getActiveBaggage;
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

## installRequestContext

```ts
function installRequestContext(requestId: string, context: ActiveTelemetryContext): void
```

installRequestContext function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = installRequestContext;
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
inject<TCarrier = CarrierLike>( carrier: TCarrier, context?: TraceContext | null, carrierApi?: CarrierApi<TCarrier>, ): void
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
extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null
```

Extracts context through the configured propagator.

Returns `null` when no valid trace context is present. A custom carrier API
can be supplied for header maps that do not use object-style reads.

```typescript
const context = Propagation.extract({ traceparent: '00-00000000000000000000000000000001-0000000000000001-01' });
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
inject<TCarrier = CarrierLike>( carrier: TCarrier, context: TraceContext | null | undefined, carrierApi?: CarrierApi<TCarrier>, ): void
```

Writes W3C `traceparent` and optional `tracestate` values into a carrier.

Missing `traceId` or `spanId` leaves the carrier untouched. `traceFlags` are
masked to one byte and encoded as two lowercase hexadecimal digits.

```typescript
new W3CTraceContextPropagator().inject({}, { traceId: '0'.repeat(31) + '1', spanId: '0'.repeat(15) + '1' });
```

### extract

```ts
extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null
```

Reads W3C trace context from `traceparent` and optional `tracestate`.

Returns `null` for malformed headers, all-zero trace IDs, all-zero span IDs,
or v00 headers with trailing data. Unknown versions are parsed
permissively for forward compatibility.

```typescript
const context = new W3CTraceContextPropagator().extract({ traceparent: '00-00000000000000000000000000000001-0000000000000001-01' });
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

## truncateAttributeValue

```ts
function truncateAttributeValue(value: unknown, limit: number): unknown
```

truncateAttributeValue function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = truncateAttributeValue;
```

## limitAttributeEntries

```ts
function limitAttributeEntries( attributes: Attributes, limits: { attributeCountLimit?: number; attributeValueLengthLimit?: number }, ): { attrs: Attributes; dropped: number }
```

limitAttributeEntries function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = limitAttributeEntries;
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

## otelRuntimeTopic

```ts
function otelRuntimeTopic(domain: string, operation: string, phase: string): string
```

otelRuntimeTopic function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = otelRuntimeTopic;
```

## otelRuntimeEvent

```ts
function otelRuntimeEvent<TPayload extends Record<string, unknown>>( domain: string, operation: string, phase: string, payload: TPayload = {} as TPayload, ): TPayload & { schemaVersion: number; topic: string; family: string; domain: string; operation: string; phase: string; correlationId: unknown; }
```

otelRuntimeEvent function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = otelRuntimeEvent;
```

## topic

```ts
function topic<T = unknown>(name: string): Topic<T>
```

Re-exported from `topic.topic`.

## Sampler

```ts
class Sampler {
```

Sampler class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = Sampler;
```

### shouldSample

```ts
shouldSample(_record: SpanRecord): SamplingResult | boolean
```

shouldSample member on Sampler.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Sampler.prototype.shouldSample;
```

## AlwaysOnSampler

```ts
class AlwaysOnSampler extends Sampler {
```

AlwaysOnSampler class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = AlwaysOnSampler;
```

## TracerProvider

```ts
class TracerProvider extends BaseProvider {
```

TracerProvider class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = TracerProvider;
```

### getTracer

```ts
getTracer( name: string, version?: string, options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number }, ): Tracer
```

getTracer member on TracerProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = TracerProvider.prototype.getTracer;
```

## Span

```ts
class Span {
```

Span class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = Span;
```

### constructor

```ts
constructor(tracer: Tracer, name: string, options: SpanStartOptions = {})
```

constructor member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Span();
```

### traceId

```ts
get traceId(): string
```

traceId member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Span.prototype.traceId;
```

### spanId

```ts
get spanId(): string
```

spanId member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Span.prototype.spanId;
```

### setAttribute

```ts
setAttribute(key: string, value: unknown): this
```

setAttribute member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.setAttribute;
```

### setAttributes

```ts
setAttributes(attributes: Attributes): this
```

setAttributes member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.setAttributes;
```

### addEvent

```ts
addEvent(name: string, attributes: Attributes = {}, timeUnixNano: number = nowUnixNano()): this
```

addEvent member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.addEvent;
```

### addLink

```ts
addLink(linkContext: SpanLinkContext, attributes: Attributes = {}): this
```

addLink member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.addLink;
```

### setStatus

```ts
setStatus(status: SpanStatus | null): this
```

setStatus member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.setStatus;
```

### recordException

```ts
recordException(error: unknown, attributes: Attributes = {}): this
```

recordException member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.recordException;
```

### updateName

```ts
updateName(name: string): this
```

updateName member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.updateName;
```

### isRecording

```ts
isRecording(): boolean
```

isRecording member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.isRecording;
```

### end

```ts
end(options: SpanEndOptions = {}): void
```

end member on Span.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Span.prototype.end;
```

## Tracer

```ts
class Tracer {
```

Tracer class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = Tracer;
```

### constructor

```ts
constructor(provider: TracerProvider, scope: ScopeInfo)
```

constructor member on Tracer.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Tracer();
```

### scope

```ts
get scope(): ScopeInfo
```

scope member on Tracer.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Tracer.prototype.scope;
```

### publishTrace

```ts
publishTrace(kind: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename', payload: SpanRecord & Record<string, unknown>): void
```

publishTrace member on Tracer.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Tracer.prototype.publishTrace;
```

### startSpan

```ts
startSpan(name: string, options: SpanStartOptions = {}): Span
```

startSpan member on Tracer.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Tracer.prototype.startSpan;
```

## applySpanLimits

```ts
function applySpanLimits(span: SpanRecord, limits: SpanLimits = {}): SpanRecord
```

applySpanLimits function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = applySpanLimits;
```

## isScopedTraceTopic

```ts
function isScopedTraceTopic( name: string, phase: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename', ): boolean
```

isScopedTraceTopic function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = isScopedTraceTopic;
```

## getTracerProvider

```ts
function getTracerProvider(): TracerProvider
```

getTracerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getTracerProvider;
```

## setTracerProvider

```ts
function setTracerProvider(provider: TracerProvider): void
```

setTracerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = setTracerProvider;
```

## runWithTracerProvider

```ts
function runWithTracerProvider<R>(provider: TracerProvider, fn: () => R): R
```

runWithTracerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithTracerProvider;
```

## runWithoutTracerProvider

```ts
function runWithoutTracerProvider<R>(fn: () => R): R
```

runWithoutTracerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithoutTracerProvider;
```

## isTracerProviderContextEnabled

```ts
function isTracerProviderContextEnabled(): boolean
```

isTracerProviderContextEnabled function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = isTracerProviderContextEnabled;
```

## getActiveSpan

```ts
function getActiveSpan(): Span | undefined
```

getActiveSpan function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getActiveSpan;
```

## getActiveSpanContext

```ts
function getActiveSpanContext(): TraceContext | null
```

getActiveSpanContext function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getActiveSpanContext;
```

## runWithActiveSpan

```ts
function runWithActiveSpan<R>(span: Span, fn: () => R): R
```

runWithActiveSpan function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithActiveSpan;
```

## SeverityNumber

```ts
enum SeverityNumber { /** * TRACE numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.TRACE; * ``` */ TRACE = 1, /** * TRACE2 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.TRACE2; * ``` */ TRACE2 = 2, /** * TRACE3 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.TRACE3; * ``` */ TRACE3 = 3, /** * TRACE4 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.TRACE4; * ``` */ TRACE4 = 4, /** * DEBUG numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.DEBUG; * ``` */ DEBUG = 5, /** * DEBUG2 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.DEBUG2; * ``` */ DEBUG2 = 6, /** * DEBUG3 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.DEBUG3; * ``` */ DEBUG3 = 7, /** * DEBUG4 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.DEBUG4; * ``` */ DEBUG4 = 8, /** * INFO numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.INFO; * ``` */ INFO = 9, /** * INFO2 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.INFO2; * ``` */ INFO2 = 10, /** * INFO3 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.INFO3; * ``` */ INFO3 = 11, /** * INFO4 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.INFO4; * ``` */ INFO4 = 12, /** * WARN numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.WARN; * ``` */ WARN = 13, /** * WARN2 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.WARN2; * ``` */ WARN2 = 14, /** * WARN3 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.WARN3; * ``` */ WARN3 = 15, /** * WARN4 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.WARN4; * ``` */ WARN4 = 16, /** * ERROR numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.ERROR; * ``` */ ERROR = 17, /** * ERROR2 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.ERROR2; * ``` */ ERROR2 = 18, /** * ERROR3 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.ERROR3; * ``` */ ERROR3 = 19, /** * ERROR4 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.ERROR4; * ``` */ ERROR4 = 20, /** * FATAL numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.FATAL; * ``` */ FATAL = 21, /** * FATAL2 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.FATAL2; * ``` */ FATAL2 = 22, /** * FATAL3 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.FATAL3; * ``` */ FATAL3 = 23, /** * FATAL4 numeric severity value in SeverityNumber. * * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself. * * ```typescript no_run * const severity = SeverityNumber.FATAL4; * ``` */ FATAL4 = 24, }
```

SeverityNumber enum used by the internal OpenTelemetry runtime.

Documents the enum's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value = SeverityNumber;
```

## LoggerProvider

```ts
class LoggerProvider extends BaseProvider {
```

LoggerProvider class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = LoggerProvider;
```

### getLogger

```ts
getLogger( name: string, version?: string, options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number }, ): Logger
```

getLogger member on LoggerProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LoggerProvider.prototype.getLogger;
```

## Logger

```ts
class Logger {
```

Logger class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = Logger;
```

### constructor

```ts
constructor(provider: LoggerProvider, scope: ScopeInfo)
```

constructor member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new Logger();
```

### scope

```ts
get scope(): ScopeInfo
```

scope member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const getter = Logger.prototype.scope;
```

### emit

```ts
emit(body: unknown, options: { severityText?: string; severityNumber?: number; attributes?: Attributes } = {}): void
```

emit member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.emit;
```

### emitRecord

```ts
emitRecord(builder: LogRecordBuilder | Partial<LogRecord>): void
```

emitRecord member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.emitRecord;
```

### debug

```ts
debug(body: unknown, attributes: Attributes = {}): void
```

debug member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.debug;
```

### info

```ts
info(body: unknown, attributes: Attributes = {}): void
```

info member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.info;
```

### warn

```ts
warn(body: unknown, attributes: Attributes = {}): void
```

warn member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.warn;
```

### error

```ts
error(body: unknown, attributes: Attributes = {}): void
```

error member on Logger.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Logger.prototype.error;
```

## LogRecordBuilder

```ts
class LogRecordBuilder {
```

LogRecordBuilder class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = LogRecordBuilder;
```

### constructor

```ts
constructor()
```

constructor member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const instance = new LogRecordBuilder();
```

### setBody

```ts
setBody(body: unknown): this
```

setBody member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setBody;
```

### setTextBody

```ts
setTextBody(body: string): this
```

setTextBody member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setTextBody;
```

### setJsonBody

```ts
setJsonBody(body: unknown): this
```

setJsonBody member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setJsonBody;
```

### setSeverity

```ts
setSeverity(severityText: string, severityNumber?: number): this
```

setSeverity member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setSeverity;
```

### setAttribute

```ts
setAttribute(key: string, value: unknown): this
```

setAttribute member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setAttribute;
```

### setAttributes

```ts
setAttributes(attributes: Attributes): this
```

setAttributes member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setAttributes;
```

### setEventName

```ts
setEventName(name: string): this
```

setEventName member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setEventName;
```

### setCategory

```ts
setCategory(name: string): this
```

setCategory member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setCategory;
```

### setDroppedAttributesCount

```ts
setDroppedAttributesCount(count: number): this
```

setDroppedAttributesCount member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setDroppedAttributesCount;
```

### setContext

```ts
setContext(context: TraceContext | null | undefined): this
```

setContext member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.setContext;
```

### build

```ts
build(): LogRecord
```

build member on LogRecordBuilder.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = LogRecordBuilder.prototype.build;
```

## applyLogLimits

```ts
function applyLogLimits( log: LogRecord, limits: { attributeCountLimit?: number; attributeValueLengthLimit?: number } = {}, ): LogRecord
```

applyLogLimits function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = applyLogLimits;
```

## getLoggerProvider

```ts
function getLoggerProvider(): LoggerProvider
```

getLoggerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getLoggerProvider;
```

## setLoggerProvider

```ts
function setLoggerProvider(provider: LoggerProvider): void
```

setLoggerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = setLoggerProvider;
```

## runWithLoggerProvider

```ts
function runWithLoggerProvider<R>(provider: LoggerProvider, fn: () => R): R
```

runWithLoggerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithLoggerProvider;
```

## runWithoutLoggerProvider

```ts
function runWithoutLoggerProvider<R>(fn: () => R): R
```

runWithoutLoggerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithoutLoggerProvider;
```

## MeterProvider

```ts
class MeterProvider extends BaseProvider {
```

MeterProvider class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = MeterProvider;
```

### getMeter

```ts
getMeter( name: string, version?: string, options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number }, ): Meter
```

getMeter member on MeterProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = MeterProvider.prototype.getMeter;
```

## Counter

```ts
class Counter {
```

Counter class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

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

## UpDownCounter

```ts
class UpDownCounter {
```

UpDownCounter class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

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

## HistogramInstrument

```ts
class HistogramInstrument {
```

HistogramInstrument class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = HistogramInstrument;
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions & { advice?: { explicitBucketBoundaries?: number[] } } = {})
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

## ObservableGauge

```ts
class ObservableGauge {
```

ObservableGauge class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = ObservableGauge;
```

### constructor

```ts
constructor(handle: { dispose(): void })
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

## Gauge

```ts
class Gauge {
```

Gauge class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

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

## ObservableCounter

```ts
class ObservableCounter extends ObservableGauge {
```

ObservableCounter class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = ObservableCounter;
```

## ObservableUpDownCounter

```ts
class ObservableUpDownCounter extends ObservableGauge {
```

ObservableUpDownCounter class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = ObservableUpDownCounter;
```

## Histogram

```ts
const Histogram
```

Histogram const used by the internal OpenTelemetry runtime.

Documents the const's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value = Histogram;
```

## Meter

```ts
class Meter {
```

Meter class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

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
record(name: string, value: number, options: MetricInstrumentOptions & { explicitBounds?: number[] } = {}): void
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
createHistogram(name: string, options: MetricInstrumentOptions & { advice?: { explicitBucketBoundaries?: number[] } } = {}): HistogramInstrument
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
createObservableCounter(name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}): ObservableCounter
```

createObservableCounter member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createObservableCounter;
```

### createObservableUpDownCounter

```ts
createObservableUpDownCounter( name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}, ): ObservableUpDownCounter
```

createObservableUpDownCounter member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createObservableUpDownCounter;
```

### createObservableGauge

```ts
createObservableGauge(name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}): ObservableGauge
```

createObservableGauge member on Meter.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = Meter.prototype.createObservableGauge;
```

## cloneMetric

```ts
function cloneMetric(metric: MetricRecord): MetricRecord
```

cloneMetric function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = cloneMetric;
```

## zeroMetric

```ts
function zeroMetric(metric: MetricRecord): MetricRecord
```

zeroMetric function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = zeroMetric;
```

## attributesKey

```ts
function attributesKey(attributes: Attributes): string
```

attributesKey function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = attributesKey;
```

## normalizeMetricKind

```ts
function normalizeMetricKind(kind: string | undefined): string
```

normalizeMetricKind function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = normalizeMetricKind;
```

## metricInstrumentKey

```ts
function metricInstrumentKey(metric: MetricRecord): string
```

metricInstrumentKey function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = metricInstrumentKey;
```

## metricSeriesKey

```ts
function metricSeriesKey(metric: MetricRecord): string
```

metricSeriesKey function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = metricSeriesKey;
```

## accumulateMetric

```ts
function accumulateMetric(store: Map<string, MetricRecord>, key: string, metric: MetricRecord): void
```

accumulateMetric function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = accumulateMetric;
```

## applyMetricView

```ts
function applyMetricView(metric: MetricRecord, views: MetricView[]): MetricRecord
```

applyMetricView function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = applyMetricView;
```

## getMeterProvider

```ts
function getMeterProvider(): MeterProvider
```

getMeterProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getMeterProvider;
```

## setMeterProvider

```ts
function setMeterProvider(provider: MeterProvider): void
```

setMeterProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = setMeterProvider;
```

## runWithMeterProvider

```ts
function runWithMeterProvider<R>(provider: MeterProvider, fn: () => R): R
```

runWithMeterProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithMeterProvider;
```

## runWithoutMeterProvider

```ts
function runWithoutMeterProvider<R>(fn: () => R): R
```

runWithoutMeterProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithoutMeterProvider;
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
constructor(options: { temporality?: MetricTemporality } = {})
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
constructor(exporter: OtelExporter, options: { maxQueueSize?: number; maxExportBatchSize?: number; scheduledDelayMillis?: number } = {})
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
constructor( exporter: OtelExporter, options: { maxQueueSize?: number; maxExportBatchSize?: number; scheduledDelayMillis?: number; attributeCountLimit?: number; attributeValueLengthLimit?: number; } = {}, )
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
constructor(exporter: OtelExporter, options: { temporality?: MetricTemporality; intervalMs?: number } = {})
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

## PeriodicExportingMetricReader

```ts
const PeriodicExportingMetricReader
```

PeriodicExportingMetricReader const used by the internal OpenTelemetry runtime.

Documents the const's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const value = PeriodicExportingMetricReader;
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
constructor(options: { exporters?: OtelExporter[]; instrumentations?: Instrumentation[]; spanProcessors?: SpanProcessor[]; logRecordProcessors?: LogRecordProcessor[]; metricReaders?: MetricReader[]; sampler?: Sampler; propagator?: TextMapPropagator; views?: MetricView[]; metricCardinalityLimit?: number; spanLimits?: SpanLimits; resource?: Resource | Record<string, unknown> | null; } = {})
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
