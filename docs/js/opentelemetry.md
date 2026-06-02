# opentelemetry

fino:opentelemetry — tracing, metrics, logs, and SDK helpers.

This module re-exports the public OpenTelemetry surface used by runtime
instrumentation and application code. It includes context propagation,
span/log/metric model types, exporters, and SDK wiring helpers.

## Attributes

```ts
type Attributes = Record<string, unknown>
```

## ScopeInfo

```ts
type ScopeInfo = { name: string; version?: string; schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number; }
```

## SignalName

```ts
type SignalName = 'trace' | 'log' | 'metric'
```

## MetricTemporality

```ts
type MetricTemporality = 'delta' | 'cumulative'
```

## MetricAggregationType

```ts
type MetricAggregationType = 'histogram' | 'lastValue' | 'sum'
```

## CarrierLike

```ts
type CarrierLike = { [key: string]: unknown; get?(key: string): unknown; set?(key: string, value: unknown): unknown; keys?(): Iterable<string>; }
```

## CarrierApi

```ts
interface CarrierApi<TCarrier = CarrierLike> {
```

### get

```ts
get(target: TCarrier, key: string): unknown
```

### set

```ts
set(target: TCarrier, key: string, value: unknown): void
```

### keys

```ts
keys(target: TCarrier): string[]
```

## TraceContext

```ts
interface TraceContext {
```

### traceId

```ts
traceId?: string
```

### spanId

```ts
spanId?: string
```

### traceFlags

```ts
traceFlags?: number
```

### traceState

```ts
traceState?: string
```

### baggage

```ts
baggage?: Baggage | null
```

## SpanStatus

```ts
interface SpanStatus {
```

### code

```ts
code?: string
```

### message

```ts
message?: string
```

## SpanLinkContext

```ts
interface SpanLinkContext {
```

### traceId

```ts
traceId: string
```

### spanId

```ts
spanId: string
```

### traceState

```ts
traceState?: string
```

### flags

```ts
flags?: number
```

## SpanLinkRecord

```ts
interface SpanLinkRecord extends SpanLinkContext {
```

### attributes

```ts
attributes?: Attributes
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

## SpanEventRecord

```ts
interface SpanEventRecord {
```

### name

```ts
name: string
```

### attributes

```ts
attributes?: Attributes
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

## SpanRecord

```ts
interface SpanRecord {
```

### schemaVersion

```ts
schemaVersion?: number
```

### operation

```ts
operation?: string
```

### name

```ts
name?: string
```

### traceId

```ts
traceId: string
```

### spanId

```ts
spanId: string
```

### parentSpanId

```ts
parentSpanId?: string | null
```

### traceState

```ts
traceState?: string
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### startTimeUnixNano

```ts
startTimeUnixNano?: number
```

### endTimeUnixNano

```ts
endTimeUnixNano?: number
```

### attributes

```ts
attributes?: Attributes
```

### scope

```ts
scope?: ScopeInfo
```

### resource

```ts
resource?: Resource
```

### kind

```ts
kind?: string
```

### status

```ts
status?: SpanStatus | null
```

### events

```ts
events?: SpanEventRecord[]
```

### links

```ts
links?: SpanLinkRecord[]
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

### droppedEventsCount

```ts
droppedEventsCount?: number
```

### droppedLinksCount

```ts
droppedLinksCount?: number
```

### flags

```ts
flags?: number
```

### injectedHeaders

```ts
injectedHeaders?: Record<string, unknown>
```

## LogRecord

```ts
interface LogRecord {
```

### schemaVersion

```ts
schemaVersion?: number
```

### body

```ts
body?: unknown
```

### severityText

```ts
severityText?: string
```

### severityNumber

```ts
severityNumber?: number
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### observedTimeUnixNano

```ts
observedTimeUnixNano?: number
```

### attributes

```ts
attributes?: Attributes
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

### scope

```ts
scope?: ScopeInfo
```

### resource

```ts
resource?: Resource
```

### traceId

```ts
traceId?: string
```

### spanId

```ts
spanId?: string
```

### traceFlags

```ts
traceFlags?: number
```

### baggage

```ts
baggage?: Baggage | null
```

### eventName

```ts
eventName?: string
```

### categoryName

```ts
categoryName?: string
```

### flags

```ts
flags?: number
```

## ExemplarRecord

```ts
interface ExemplarRecord {
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### traceId

```ts
traceId?: string
```

### spanId

```ts
spanId?: string
```

### value

```ts
value?: number
```

### asInt

```ts
asInt?: number
```

### asDouble

```ts
asDouble?: number
```

### filteredAttributes

```ts
filteredAttributes?: Attributes
```

## QuantileValueRecord

```ts
interface QuantileValueRecord {
```

### quantile

```ts
quantile: number
```

### value

```ts
value: number
```

## ExponentialBuckets

```ts
interface ExponentialBuckets {
```

### offset

```ts
offset?: number
```

### bucketCounts

```ts
bucketCounts?: Array<number | bigint>
```

## MetricExemplarContext

```ts
interface MetricExemplarContext {
```

### traceId

```ts
traceId?: string
```

### spanId

```ts
spanId?: string
```

### traceFlags

```ts
traceFlags?: number
```

## MetricRecord

```ts
interface MetricRecord {
```

### schemaVersion

```ts
schemaVersion?: number
```

### name

```ts
name: string
```

### value

```ts
value?: number
```

### count

```ts
count?: number
```

### sum

```ts
sum?: number
```

### min

```ts
min?: number
```

### max

```ts
max?: number
```

### unit

```ts
unit?: string
```

### description

```ts
description?: string
```

### kind

```ts
kind?: string
```

### aggregationKind

```ts
aggregationKind?: string
```

### aggregationTemporality

```ts
aggregationTemporality?: number
```

### isMonotonic

```ts
isMonotonic?: boolean
```

### attributes

```ts
attributes?: Attributes
```

### metadata

```ts
metadata?: Attributes
```

### scope

```ts
scope?: ScopeInfo
```

### resource

```ts
resource?: Resource
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### startTimeUnixNano

```ts
startTimeUnixNano?: number
```

### explicitBounds

```ts
explicitBounds?: number[]
```

### bucketCounts

```ts
bucketCounts?: Array<number | bigint>
```

### quantileValues

```ts
quantileValues?: QuantileValueRecord[]
```

### exemplars

```ts
exemplars?: ExemplarRecord[]
```

### flags

```ts
flags?: number
```

### exemplarContext

```ts
exemplarContext?: MetricExemplarContext | null
```

### scale

```ts
scale?: number
```

### zeroCount

```ts
zeroCount?: number
```

### zeroThreshold

```ts
zeroThreshold?: number
```

### positive

```ts
positive?: ExponentialBuckets
```

### negative

```ts
negative?: ExponentialBuckets
```

## ObservableMetricObservation

```ts
interface ObservableMetricObservation {
```

### value

```ts
value: number
```

### attributes

```ts
attributes?: Attributes
```

### timeUnixNano

```ts
timeUnixNano?: number
```

## ObservableMetricRegistration

```ts
interface ObservableMetricRegistration {
```

### kind

```ts
kind: string
```

### name

```ts
name: string
```

### unit

```ts
unit: string
```

### description

```ts
description: string
```

### scope

```ts
scope: ScopeInfo
```

### resource

```ts
resource: Resource
```

### callback

```ts
callback: () => ObservableMetricObservation | ObservableMetricObservation[] | null | undefined
```

## MetricInstrumentOptions

```ts
interface MetricInstrumentOptions {
```

### unit

```ts
unit?: string
```

### description

```ts
description?: string
```

### attributes

```ts
attributes?: Attributes
```

### kind

```ts
kind?: string
```

## MetricView

```ts
interface MetricView {
```

### instrumentName

```ts
instrumentName?: string
```

### name

```ts
name?: string
```

### description

```ts
description?: string
```

### attributeKeys

```ts
attributeKeys?: string[]
```

### aggregation

```ts
aggregation?: { type: MetricAggregationType; boundaries?: number[]; monotonic?: boolean; }
```

## PartialSuccessResult

```ts
interface PartialSuccessResult {
```

### rejectedSpans

```ts
rejectedSpans: number
```

### rejectedLogs

```ts
rejectedLogs: number
```

### rejectedDataPoints

```ts
rejectedDataPoints: number
```

### errorMessage

```ts
errorMessage: string
```

## ExportResult

```ts
interface ExportResult {
```

### code

```ts
code: 'success' | 'failure'
```

## OtelExporter

```ts
interface OtelExporter {
```

### exportSpans

```ts
exportSpans(spans: SpanRecord[]): Promise<ExportResult>
```

### exportLogs

```ts
exportLogs(logs: LogRecord[]): Promise<ExportResult>
```

### exportMetrics

```ts
exportMetrics(metrics: MetricRecord[]): Promise<ExportResult>
```

### shutdown

```ts
shutdown?(): Promise<void>
```

## OtelSdkLike

```ts
interface OtelSdkLike {
```

### propagator

```ts
readonly propagator: TextMapPropagator
```

### recordSpanStart

```ts
recordSpanStart(span: SpanRecord): void
```

### recordSpan

```ts
recordSpan(span: SpanRecord): void
```

### recordLog

```ts
recordLog(log: LogRecord): void
```

### recordMetric

```ts
recordMetric(metric: MetricRecord): void
```

## Disposable

```ts
interface Disposable {
```

### dispose

```ts
dispose(): void
```

## Instrumentation

```ts
interface Instrumentation {
```

### enable

```ts
enable(sdk: OtelSdkLike): void | Disposable | Disposable[]
```

## RuntimeHttpRequestEvent

```ts
interface RuntimeHttpRequestEvent {
```

### requestId

```ts
requestId: string
```

### method

```ts
method?: string
```

### route

```ts
route?: string
```

### url

```ts
url?: string
```

### headers

```ts
headers?: CarrierLike
```

### statusCode

```ts
statusCode?: number
```

### error

```ts
error?: unknown
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### resource

```ts
resource?: Resource
```

## RuntimeDnsEvent

```ts
interface RuntimeDnsEvent {
```

### lookupId

```ts
lookupId: string
```

### requestId

```ts
requestId?: string
```

### hop

```ts
hop?: number
```

### hostname

```ts
hostname?: string
```

### address

```ts
address?: string
```

### family

```ts
family?: string | number
```

### error

```ts
error?: unknown
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### resource

```ts
resource?: Resource
```

## RuntimeSocketEvent

```ts
interface RuntimeSocketEvent {
```

### connectId

```ts
connectId: string
```

### requestId

```ts
requestId?: string
```

### hop

```ts
hop?: number
```

### host

```ts
host?: string
```

### port

```ts
port?: number
```

### transport

```ts
transport?: string
```

### error

```ts
error?: unknown
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### resource

```ts
resource?: Resource
```

## RuntimeTlsEvent

```ts
interface RuntimeTlsEvent {
```

### handshakeId

```ts
handshakeId: string
```

### requestId

```ts
requestId?: string
```

### hop

```ts
hop?: number
```

### hostname

```ts
hostname?: string
```

### port

```ts
port?: number
```

### protocol

```ts
protocol?: string
```

### error

```ts
error?: unknown
```

### timeUnixNano

```ts
timeUnixNano?: number
```

### resource

```ts
resource?: Resource
```

## ResourceOptions

```ts
interface ResourceOptions {
```

### droppedAttributesCount

```ts
droppedAttributesCount?: number
```

### entityRefs

```ts
entityRefs?: Array<{ schemaUrl?: string; type?: string; idKeys?: string[] }>
```

### schemaUrl

```ts
schemaUrl?: string | null
```

## ProviderOptions

```ts
interface ProviderOptions {
```

### resource

```ts
resource?: Resource | Attributes | null
```

## SpanStartOptions

```ts
interface SpanStartOptions {
```

### traceId

```ts
traceId?: string
```

### parentSpanId

```ts
parentSpanId?: string | null
```

### attributes

```ts
attributes?: Attributes
```

### links

```ts
links?: SpanLinkRecord[]
```

### kind

```ts
kind?: string
```

## SpanEndOptions

```ts
interface SpanEndOptions {
```

### attributes

```ts
attributes?: Attributes
```

### status

```ts
status?: SpanStatus | null
```

## ActiveTelemetryContext

```ts
interface ActiveTelemetryContext extends TraceContext {
```

## SamplingResult

```ts
interface SamplingResult {
```

### sample

```ts
sample: boolean
```

### attributes

```ts
attributes?: Attributes
```

### traceState

```ts
traceState?: string
```

## SpanLimits

```ts
interface SpanLimits {
```

### attributeCountLimit

```ts
attributeCountLimit?: number
```

### attributeValueLengthLimit

```ts
attributeValueLengthLimit?: number
```

### eventCountLimit

```ts
eventCountLimit?: number
```

### linkCountLimit

```ts
linkCountLimit?: number
```

## RetryOptions

```ts
interface RetryOptions {
```

### maxAttempts

```ts
maxAttempts?: number
```

### initialBackoffMillis

```ts
initialBackoffMillis?: number
```

## requireRecord

```ts
function requireRecord(kind: string, value: unknown): Record<string, unknown>
```

## OTEL_SCHEMA_VERSION

```ts
const OTEL_SCHEMA_VERSION
```

## OTEL_TOPIC_SUFFIXES

```ts
const OTEL_TOPIC_SUFFIXES
```

## nowUnixNano

```ts
function nowUnixNano(): number
```

## randomHex

```ts
function randomHex(length: number): string
```

## encodeSegment

```ts
function encodeSegment(value: unknown): string
```

## requireNonEmptyName

```ts
function requireNonEmptyName(kind: string, value: unknown): string
```

## scopeSegment

```ts
function scopeSegment(scope: ScopeInfo): string
```

## normalizeScope

```ts
function normalizeScope( name: string, version?: string, schemaUrl?: string | null, attributes?: Attributes, droppedAttributesCount?: number, ): ScopeInfo
```

## topicNames

```ts
function topicNames(signal: string, scope: ScopeInfo, ...suffixes: string[]): string[]
```

## publishScoped

```ts
function publishScoped<TPayload>(signal: SignalName, scope: ScopeInfo, suffixes: string[], payload: TPayload): void
```

## hexToBytes

```ts
function hexToBytes(hex: string, size: number): Uint8Array
```

## bytesEqual

```ts
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
```

## Resource

```ts
class Resource {
```

### constructor

```ts
constructor(attributes: Attributes = {}, options: ResourceOptions = {})
```

### attributes

```ts
get attributes(): Attributes
```

### droppedAttributesCount

```ts
get droppedAttributesCount(): number
```

### entityRefs

```ts
get entityRefs(): Array<{ schemaUrl?: string; type?: string; idKeys: string[] }>
```

### schemaUrl

```ts
get schemaUrl(): string | null
```

## normalizeResource

```ts
function normalizeResource(resource?: Resource | Attributes | null): Resource
```

## mergeAttributes

```ts
function mergeAttributes(a?: Attributes, b?: Attributes): Attributes
```

## Baggage

```ts
class Baggage {
```

### constructor

```ts
constructor(entries: Record<string, string> = {})
```

### get

```ts
get(key: string): string | undefined
```

### set

```ts
set(key: string, value: string): Baggage
```

### delete

```ts
delete(key: string): Baggage
```

### entries

```ts
entries()
```

### toString

```ts
toString(): string
```

### fromString

```ts
static fromString(text: string | null | undefined): Baggage
```

## TextMapPropagator

```ts
class TextMapPropagator {
```

### inject

```ts
inject<TCarrier = CarrierLike>( _carrier: TCarrier, _context: TraceContext | null | undefined, _carrierApi?: CarrierApi<TCarrier>, ): void
```

### extract

```ts
extract<TCarrier = CarrierLike>(_carrier: TCarrier, _carrierApi?: CarrierApi<TCarrier>): TraceContext | null
```

## defaultCarrierApiFor

```ts
function defaultCarrierApiFor<TCarrier extends CarrierLike>(carrier: TCarrier): CarrierApi<TCarrier>
```

## carrierApiFor

```ts
function carrierApiFor<TCarrier>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): CarrierApi<TCarrier>
```

## snapshotCarrier

```ts
function snapshotCarrier<TCarrier extends CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): Record<string, unknown>
```

## registerActiveSpanContextGetter

```ts
function registerActiveSpanContextGetter(getter: () => TraceContext | null): void
```

## getActiveBaggage

```ts
function getActiveBaggage(): Baggage
```

## currentActiveTelemetryContext

```ts
function currentActiveTelemetryContext(): ActiveTelemetryContext | undefined
```

## runWithActiveContext

```ts
function runWithActiveContext<R>(context: ActiveTelemetryContext, fn: () => R): R
```

## runWithBaggage

```ts
function runWithBaggage<R>(baggage: Baggage, fn: () => R): R
```

## installRequestContext

```ts
function installRequestContext(requestId: string, context: ActiveTelemetryContext): void
```

## consumeRequestContext

```ts
function consumeRequestContext(requestId: string): ActiveTelemetryContext | null
```

## Propagation

```ts
const Propagation
```

### getPropagator

```ts
getPropagator(): TextMapPropagator
```

### setPropagator

```ts
setPropagator(propagator: TextMapPropagator): void
```

### inject

```ts
inject<TCarrier = CarrierLike>( carrier: TCarrier, context?: TraceContext | null, carrierApi?: CarrierApi<TCarrier>, ): void
```

### extract

```ts
extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null
```

## W3CTraceContextPropagator

```ts
class W3CTraceContextPropagator extends TextMapPropagator {
```

### inject

```ts
inject<TCarrier = CarrierLike>( carrier: TCarrier, context: TraceContext | null | undefined, carrierApi?: CarrierApi<TCarrier>, ): void
```

### extract

```ts
extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null
```

## BaseProvider

```ts
class BaseProvider {
```

### constructor

```ts
constructor(options: ProviderOptions = {})
```

### resource

```ts
get resource(): Resource
```

## truncateAttributeValue

```ts
function truncateAttributeValue(value: unknown, limit: number): unknown
```

## limitAttributeEntries

```ts
function limitAttributeEntries( attributes: Attributes, limits: { attributeCountLimit?: number; attributeValueLengthLimit?: number }, ): { attrs: Attributes; dropped: number }
```

## otelTopic

```ts
function otelTopic(signal: string, scope: ScopeInfo, ...suffixes: string[]): string
```

## otelRuntimeTopic

```ts
function otelRuntimeTopic(domain: string, operation: string, phase: string): string
```

## otelRuntimeEvent

```ts
function otelRuntimeEvent<TPayload extends Record<string, unknown>>( domain: string, operation: string, phase: string, payload: TPayload = {} as TPayload, ): TPayload & { schemaVersion: number; topic: string; family: string; domain: string; operation: string; phase: string; correlationId: unknown; }
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

### shouldSample

```ts
shouldSample(_record: SpanRecord): SamplingResult | boolean
```

## AlwaysOnSampler

```ts
class AlwaysOnSampler extends Sampler {
```

## TracerProvider

```ts
class TracerProvider extends BaseProvider {
```

### getTracer

```ts
getTracer( name: string, version?: string, options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number }, ): Tracer
```

## Span

```ts
class Span {
```

### constructor

```ts
constructor(tracer: Tracer, name: string, options: SpanStartOptions = {})
```

### traceId

```ts
get traceId(): string
```

### spanId

```ts
get spanId(): string
```

### setAttribute

```ts
setAttribute(key: string, value: unknown): this
```

### setAttributes

```ts
setAttributes(attributes: Attributes): this
```

### addEvent

```ts
addEvent(name: string, attributes: Attributes = {}, timeUnixNano: number = nowUnixNano()): this
```

### addLink

```ts
addLink(linkContext: SpanLinkContext, attributes: Attributes = {}): this
```

### setStatus

```ts
setStatus(status: SpanStatus | null): this
```

### recordException

```ts
recordException(error: unknown, attributes: Attributes = {}): this
```

### updateName

```ts
updateName(name: string): this
```

### isRecording

```ts
isRecording(): boolean
```

### end

```ts
end(options: SpanEndOptions = {}): void
```

## Tracer

```ts
class Tracer {
```

### constructor

```ts
constructor(provider: TracerProvider, scope: ScopeInfo)
```

### scope

```ts
get scope(): ScopeInfo
```

### publishTrace

```ts
publishTrace(kind: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename', payload: SpanRecord & Record<string, unknown>): void
```

### startSpan

```ts
startSpan(name: string, options: SpanStartOptions = {}): Span
```

## applySpanLimits

```ts
function applySpanLimits(span: SpanRecord, limits: SpanLimits = {}): SpanRecord
```

## isScopedTraceTopic

```ts
function isScopedTraceTopic( name: string, phase: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename', ): boolean
```

## getTracerProvider

```ts
function getTracerProvider(): TracerProvider
```

## setTracerProvider

```ts
function setTracerProvider(provider: TracerProvider): void
```

## runWithTracerProvider

```ts
function runWithTracerProvider<R>(provider: TracerProvider, fn: () => R): R
```

## runWithoutTracerProvider

```ts
function runWithoutTracerProvider<R>(fn: () => R): R
```

## isTracerProviderContextEnabled

```ts
function isTracerProviderContextEnabled(): boolean
```

## getActiveSpan

```ts
function getActiveSpan(): Span | undefined
```

## getActiveSpanContext

```ts
function getActiveSpanContext(): TraceContext | null
```

## runWithActiveSpan

```ts
function runWithActiveSpan<R>(span: Span, fn: () => R): R
```

## SeverityNumber

```ts
enum SeverityNumber { TRACE = 1, TRACE2 = 2, TRACE3 = 3, TRACE4 = 4, DEBUG = 5, DEBUG2 = 6, DEBUG3 = 7, DEBUG4 = 8, INFO = 9, INFO2 = 10, INFO3 = 11, INFO4 = 12, WARN = 13, WARN2 = 14, WARN3 = 15, WARN4 = 16, ERROR = 17, ERROR2 = 18, ERROR3 = 19, ERROR4 = 20, FATAL = 21, FATAL2 = 22, FATAL3 = 23, FATAL4 = 24, }
```

## LoggerProvider

```ts
class LoggerProvider extends BaseProvider {
```

### getLogger

```ts
getLogger( name: string, version?: string, options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number }, ): Logger
```

## Logger

```ts
class Logger {
```

### constructor

```ts
constructor(provider: LoggerProvider, scope: ScopeInfo)
```

### scope

```ts
get scope(): ScopeInfo
```

### emit

```ts
emit(body: unknown, options: { severityText?: string; severityNumber?: number; attributes?: Attributes } = {}): void
```

### emitRecord

```ts
emitRecord(builder: LogRecordBuilder | Partial<LogRecord>): void
```

### debug

```ts
debug(body: unknown, attributes: Attributes = {}): void
```

### info

```ts
info(body: unknown, attributes: Attributes = {}): void
```

### warn

```ts
warn(body: unknown, attributes: Attributes = {}): void
```

### error

```ts
error(body: unknown, attributes: Attributes = {}): void
```

## LogRecordBuilder

```ts
class LogRecordBuilder {
```

### constructor

```ts
constructor()
```

### setBody

```ts
setBody(body: unknown): this
```

### setTextBody

```ts
setTextBody(body: string): this
```

### setJsonBody

```ts
setJsonBody(body: unknown): this
```

### setSeverity

```ts
setSeverity(severityText: string, severityNumber?: number): this
```

### setAttribute

```ts
setAttribute(key: string, value: unknown): this
```

### setAttributes

```ts
setAttributes(attributes: Attributes): this
```

### setEventName

```ts
setEventName(name: string): this
```

### setCategory

```ts
setCategory(name: string): this
```

### setDroppedAttributesCount

```ts
setDroppedAttributesCount(count: number): this
```

### setContext

```ts
setContext(context: TraceContext | null | undefined): this
```

### build

```ts
build(): LogRecord
```

## applyLogLimits

```ts
function applyLogLimits( log: LogRecord, limits: { attributeCountLimit?: number; attributeValueLengthLimit?: number } = {}, ): LogRecord
```

## getLoggerProvider

```ts
function getLoggerProvider(): LoggerProvider
```

## setLoggerProvider

```ts
function setLoggerProvider(provider: LoggerProvider): void
```

## runWithLoggerProvider

```ts
function runWithLoggerProvider<R>(provider: LoggerProvider, fn: () => R): R
```

## runWithoutLoggerProvider

```ts
function runWithoutLoggerProvider<R>(fn: () => R): R
```

## MeterProvider

```ts
class MeterProvider extends BaseProvider {
```

### getMeter

```ts
getMeter( name: string, version?: string, options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number }, ): Meter
```

## Counter

```ts
class Counter {
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {})
```

### add

```ts
add(value: number, attributes: Attributes = {}): void
```

## UpDownCounter

```ts
class UpDownCounter {
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {})
```

### add

```ts
add(value: number, attributes: Attributes = {}): void
```

## HistogramInstrument

```ts
class HistogramInstrument {
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions & { advice?: { explicitBucketBoundaries?: number[] } } = {})
```

### record

```ts
record(value: number, attributes: Attributes = {}): void
```

## ObservableGauge

```ts
class ObservableGauge {
```

### constructor

```ts
constructor(handle: { dispose(): void })
```

### dispose

```ts
dispose(): void
```

## Gauge

```ts
class Gauge {
```

### constructor

```ts
constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {})
```

### record

```ts
record(value: number, attributes: Attributes = {}): void
```

## ObservableCounter

```ts
class ObservableCounter extends ObservableGauge {
```

## ObservableUpDownCounter

```ts
class ObservableUpDownCounter extends ObservableGauge {
```

## Histogram

```ts
const Histogram
```

## Meter

```ts
class Meter {
```

### constructor

```ts
constructor(provider: MeterProvider, scope: ScopeInfo)
```

### record

```ts
record(name: string, value: number, options: MetricInstrumentOptions & { explicitBounds?: number[] } = {}): void
```

### createCounter

```ts
createCounter(name: string, options: MetricInstrumentOptions = {}): Counter
```

### createUpDownCounter

```ts
createUpDownCounter(name: string, options: MetricInstrumentOptions = {}): UpDownCounter
```

### createHistogram

```ts
createHistogram(name: string, options: MetricInstrumentOptions & { advice?: { explicitBucketBoundaries?: number[] } } = {}): HistogramInstrument
```

### createGauge

```ts
createGauge(name: string, options: MetricInstrumentOptions = {}): Gauge
```

### createObservableCounter

```ts
createObservableCounter(name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}): ObservableCounter
```

### createObservableUpDownCounter

```ts
createObservableUpDownCounter( name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}, ): ObservableUpDownCounter
```

### createObservableGauge

```ts
createObservableGauge(name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}): ObservableGauge
```

## cloneMetric

```ts
function cloneMetric(metric: MetricRecord): MetricRecord
```

## zeroMetric

```ts
function zeroMetric(metric: MetricRecord): MetricRecord
```

## attributesKey

```ts
function attributesKey(attributes: Attributes): string
```

## normalizeMetricKind

```ts
function normalizeMetricKind(kind: string | undefined): string
```

## metricInstrumentKey

```ts
function metricInstrumentKey(metric: MetricRecord): string
```

## metricSeriesKey

```ts
function metricSeriesKey(metric: MetricRecord): string
```

## accumulateMetric

```ts
function accumulateMetric(store: Map<string, MetricRecord>, key: string, metric: MetricRecord): void
```

## applyMetricView

```ts
function applyMetricView(metric: MetricRecord, views: MetricView[]): MetricRecord
```

## getMeterProvider

```ts
function getMeterProvider(): MeterProvider
```

## setMeterProvider

```ts
function setMeterProvider(provider: MeterProvider): void
```

## runWithMeterProvider

```ts
function runWithMeterProvider<R>(provider: MeterProvider, fn: () => R): R
```

## runWithoutMeterProvider

```ts
function runWithoutMeterProvider<R>(fn: () => R): R
```

## InMemoryExporter

```ts
class InMemoryExporter {
```

### exportSpans

```ts
async exportSpans(spans: SpanRecord[]): Promise<ExportResult>
```

### exportLogs

```ts
async exportLogs(logs: LogRecord[]): Promise<ExportResult>
```

### exportMetrics

```ts
async exportMetrics(metrics: MetricRecord[]): Promise<ExportResult>
```

### getFinishedSpans

```ts
getFinishedSpans(): SpanRecord[]
```

### getFinishedLogs

```ts
getFinishedLogs(): LogRecord[]
```

### getFinishedMetrics

```ts
getFinishedMetrics(): MetricRecord[]
```

## SpanProcessor

```ts
class SpanProcessor {
```

### onStart

```ts
onStart(_span: SpanRecord): void
```

### onEnd

```ts
onEnd(_span: SpanRecord): void
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

### shutdown

```ts
async shutdown(): Promise<void>
```

## LogRecordProcessor

```ts
class LogRecordProcessor {
```

### onEmit

```ts
onEmit(_log: LogRecord): void
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

### shutdown

```ts
async shutdown(): Promise<void>
```

## MetricReader

```ts
class MetricReader {
```

### constructor

```ts
constructor(options: { temporality?: MetricTemporality } = {})
```

### temporality

```ts
get temporality(): MetricTemporality
```

### record

```ts
record(_metric: MetricRecord): void
```

### receive

```ts
receive(_metrics: MetricRecord[]): void
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

### shutdown

```ts
async shutdown(): Promise<void>
```

## ManualMetricReader

```ts
class ManualMetricReader extends MetricReader {
```

### receive

```ts
receive(metrics: MetricRecord[]): void
```

### collect

```ts
collect(): MetricRecord[]
```

## BatchSpanProcessor

```ts
class BatchSpanProcessor extends SpanProcessor {
```

### constructor

```ts
constructor(exporter: OtelExporter, options: { maxQueueSize?: number; maxExportBatchSize?: number; scheduledDelayMillis?: number } = {})
```

### droppedSpanCount

```ts
get droppedSpanCount(): number
```

### onEnd

```ts
onEnd(span: SpanRecord): void
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

### shutdown

```ts
async shutdown(): Promise<void>
```

## BatchLogRecordProcessor

```ts
class BatchLogRecordProcessor extends LogRecordProcessor {
```

### constructor

```ts
constructor( exporter: OtelExporter, options: { maxQueueSize?: number; maxExportBatchSize?: number; scheduledDelayMillis?: number; attributeCountLimit?: number; attributeValueLengthLimit?: number; } = {}, )
```

### onEmit

```ts
onEmit(log: LogRecord): void
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

### shutdown

```ts
async shutdown(): Promise<void>
```

## PeriodicMetricReader

```ts
class PeriodicMetricReader extends MetricReader {
```

### constructor

```ts
constructor(exporter: OtelExporter, options: { temporality?: MetricTemporality; intervalMs?: number } = {})
```

### _startPeriodicCollection

```ts
_startPeriodicCollection(collectAndFlush: () => Promise<void>): void
```

Called by OtelSDK.start() to wire up a periodic collection cycle.
`collectAndFlush` calls back into the SDK to collect accumulated metrics,
deliver them via receive(), and then calls forceFlush() to export.

### receive

```ts
receive(metrics: MetricRecord[]): void
```

### forceFlush

```ts
async forceFlush(): Promise<void>
```

### shutdown

```ts
async shutdown(): Promise<void>
```

## PeriodicExportingMetricReader

```ts
const PeriodicExportingMetricReader
```

## OtelSDK

```ts
class OtelSDK {
```

### constructor

```ts
constructor(options: { exporters?: OtelExporter[]; instrumentations?: Instrumentation[]; spanProcessors?: SpanProcessor[]; logRecordProcessors?: LogRecordProcessor[]; metricReaders?: MetricReader[]; sampler?: Sampler; propagator?: TextMapPropagator; views?: MetricView[]; metricCardinalityLimit?: number; spanLimits?: SpanLimits; resource?: Resource | Record<string, unknown> | null; } = {})
```

### propagator

```ts
get propagator(): TextMapPropagator
```

### resource

```ts
get resource(): Resource | null
```

### start

```ts
start(): this
```

### recordSpanStart

```ts
recordSpanStart(span: SpanRecord): void
```

### recordSpan

```ts
recordSpan(span: SpanRecord): void
```

### recordLog

```ts
recordLog(log: LogRecord): void
```

### recordMetric

```ts
recordMetric(metric: MetricRecord): void
```

### flush

```ts
async flush(): Promise<void>
```

### shutdown

```ts
async shutdown(): Promise<void>
```
