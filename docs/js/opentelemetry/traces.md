# js/opentelemetry/traces

fino:opentelemetry/traces - trace providers, tracers, spans, and trace records.

This module contains the public trace signal API. Use it to create manual
spans, swap tracer providers for tests or scoped execution, inspect the
active span, and describe trace records consumed by SDK processors and
exporters.

Span names and tracer scope names must be non-empty strings. Span attributes,
events, links, status updates, and rename operations are published as runtime
telemetry records; processors may apply additional SDK limits before export.
Active-span context follows Fino async context propagation and is visible
through `getActiveSpan()` and `getActiveSpanContext()`.

```typescript
import { getTracerProvider, runWithActiveSpan } from 'fino:opentelemetry/traces';

const tracer = getTracerProvider().getTracer('orders', '1.0.0');
const span = tracer.startSpan('orders.create', { attributes: { tenant: 'acme' } });
runWithActiveSpan(span, () => {
  span.addEvent('validated');
});
span.end({ status: { code: 'OK' } });
```

See OpenTelemetry traces:
https://opentelemetry.io/docs/concepts/signals/traces/

## AlwaysOnSampler

```ts
class AlwaysOnSampler extends Sampler {
```

AlwaysOnSampler class used by the internal OpenTelemetry runtime.

Documents the class's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const ctor = AlwaysOnSampler;
```

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
publishTrace(
  kind: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename',
  payload: SpanRecord & Record<string, unknown>
): void
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
getTracer(name: string, version?: string, options?: {
  schemaUrl?: string | null;
  attributes?: Attributes;
  droppedAttributesCount?: number;
}): Tracer
```

getTracer member on TracerProvider.

Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.

```typescript
const member = TracerProvider.prototype.getTracer;
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

## getTracerProvider

```ts
function getTracerProvider(): TracerProvider
```

getTracerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = getTracerProvider;
```

## isScopedTraceTopic

```ts
function isScopedTraceTopic(
  name: string,
  phase: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename'
): boolean
```

isScopedTraceTopic function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = isScopedTraceTopic;
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

## runWithActiveSpan

```ts
function runWithActiveSpan<R>(span: Span, fn: () => R): R
```

runWithActiveSpan function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = runWithActiveSpan;
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

## setTracerProvider

```ts
function setTracerProvider(provider: TracerProvider): void
```

setTracerProvider function used by the internal OpenTelemetry runtime.

Documents the function's shape, defaults, and failure caveats for private documentation builds. Runtime behavior is defined by the implementation below; this comment does not make the symbol stable API.

```typescript
const fn = setTracerProvider;
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
