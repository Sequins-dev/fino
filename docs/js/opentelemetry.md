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

## AlwaysOnSampler

```ts
class AlwaysOnSampler extends Sampler {
```

Re-exported from `js/opentelemetry/traces.AlwaysOnSampler`.

## Sampler

```ts
class Sampler {
```

Re-exported from `js/opentelemetry/traces.Sampler`.

## Span

```ts
class Span {
```

Re-exported from `js/opentelemetry/traces.Span`.

## Tracer

```ts
class Tracer {
```

Re-exported from `js/opentelemetry/traces.Tracer`.

## TracerProvider

```ts
class TracerProvider extends BaseProvider {
```

Re-exported from `js/opentelemetry/traces.TracerProvider`.

## applySpanLimits

```ts
function applySpanLimits(span: SpanRecord, limits: SpanLimits = {}): SpanRecord
```

Re-exported from `js/opentelemetry/traces.applySpanLimits`.

## getActiveSpan

```ts
function getActiveSpan(): Span | undefined
```

Re-exported from `js/opentelemetry/traces.getActiveSpan`.

## getActiveSpanContext

```ts
function getActiveSpanContext(): TraceContext | null
```

Re-exported from `js/opentelemetry/traces.getActiveSpanContext`.

## getTracerProvider

```ts
function getTracerProvider(): TracerProvider
```

Re-exported from `js/opentelemetry/traces.getTracerProvider`.

## isScopedTraceTopic

```ts
function isScopedTraceTopic(
  name: string,
  phase: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename'
): boolean
```

Re-exported from `js/opentelemetry/traces.isScopedTraceTopic`.

## isTracerProviderContextEnabled

```ts
function isTracerProviderContextEnabled(): boolean
```

Re-exported from `js/opentelemetry/traces.isTracerProviderContextEnabled`.

## runWithActiveSpan

```ts
function runWithActiveSpan<R>(span: Span, fn: () => R): R
```

Re-exported from `js/opentelemetry/traces.runWithActiveSpan`.

## runWithTracerProvider

```ts
function runWithTracerProvider<R>(provider: TracerProvider, fn: () => R): R
```

Re-exported from `js/opentelemetry/traces.runWithTracerProvider`.

## runWithoutTracerProvider

```ts
function runWithoutTracerProvider<R>(fn: () => R): R
```

Re-exported from `js/opentelemetry/traces.runWithoutTracerProvider`.

## setTracerProvider

```ts
function setTracerProvider(provider: TracerProvider): void
```

Re-exported from `js/opentelemetry/traces.setTracerProvider`.

## ActiveTelemetryContext

```ts
interface ActiveTelemetryContext extends TraceContext {
```

Re-exported from `js/opentelemetry/traces.ActiveTelemetryContext`.

## SamplingResult

```ts
interface SamplingResult {
```

Re-exported from `js/opentelemetry/traces.SamplingResult`.

## SpanEndOptions

```ts
interface SpanEndOptions {
```

Re-exported from `js/opentelemetry/traces.SpanEndOptions`.

## SpanEventRecord

```ts
interface SpanEventRecord {
```

Re-exported from `js/opentelemetry/traces.SpanEventRecord`.

## SpanLimits

```ts
interface SpanLimits {
```

Re-exported from `js/opentelemetry/traces.SpanLimits`.

## SpanLinkContext

```ts
interface SpanLinkContext {
```

Re-exported from `js/opentelemetry/traces.SpanLinkContext`.

## SpanLinkRecord

```ts
interface SpanLinkRecord extends SpanLinkContext {
```

Re-exported from `js/opentelemetry/traces.SpanLinkRecord`.

## SpanRecord

```ts
interface SpanRecord {
```

Re-exported from `js/opentelemetry/traces.SpanRecord`.

## SpanStartOptions

```ts
interface SpanStartOptions {
```

Re-exported from `js/opentelemetry/traces.SpanStartOptions`.

## SpanStatus

```ts
interface SpanStatus {
```

Re-exported from `js/opentelemetry/traces.SpanStatus`.

## TraceContext

```ts
interface TraceContext {
```

Re-exported from `js/opentelemetry/traces.TraceContext`.

## Counter

```ts
class Counter {
```

Re-exported from `js/opentelemetry/metrics.Counter`.

## Gauge

```ts
class Gauge {
```

Re-exported from `js/opentelemetry/metrics.Gauge`.

## Histogram

```ts
const Histogram
```

Re-exported from `js/opentelemetry/metrics.Histogram`.

## HistogramInstrument

```ts
class HistogramInstrument {
```

Re-exported from `js/opentelemetry/metrics.HistogramInstrument`.

## Meter

```ts
class Meter {
```

Re-exported from `js/opentelemetry/metrics.Meter`.

## MeterProvider

```ts
class MeterProvider extends BaseProvider {
```

Re-exported from `js/opentelemetry/metrics.MeterProvider`.

## ObservableCounter

```ts
class ObservableCounter extends ObservableGauge {
```

Re-exported from `js/opentelemetry/metrics.ObservableCounter`.

## ObservableGauge

```ts
class ObservableGauge {
```

Re-exported from `js/opentelemetry/metrics.ObservableGauge`.

## ObservableUpDownCounter

```ts
class ObservableUpDownCounter extends ObservableGauge {
```

Re-exported from `js/opentelemetry/metrics.ObservableUpDownCounter`.

## UpDownCounter

```ts
class UpDownCounter {
```

Re-exported from `js/opentelemetry/metrics.UpDownCounter`.

## accumulateMetric

```ts
function accumulateMetric(store: Map<string, MetricRecord>, key: string, metric: MetricRecord): void
```

Re-exported from `js/opentelemetry/metrics.accumulateMetric`.

## applyMetricView

```ts
function applyMetricView(metric: MetricRecord, views: MetricView[]): MetricRecord
```

Re-exported from `js/opentelemetry/metrics.applyMetricView`.

## attributesKey

```ts
function attributesKey(attributes: Attributes): string
```

Re-exported from `js/opentelemetry/metrics.attributesKey`.

## cloneMetric

```ts
function cloneMetric(metric: MetricRecord): MetricRecord
```

Re-exported from `js/opentelemetry/metrics.cloneMetric`.

## getMeterProvider

```ts
function getMeterProvider(): MeterProvider
```

Re-exported from `js/opentelemetry/metrics.getMeterProvider`.

## metricInstrumentKey

```ts
function metricInstrumentKey(metric: MetricRecord): string
```

Re-exported from `js/opentelemetry/metrics.metricInstrumentKey`.

## metricSeriesKey

```ts
function metricSeriesKey(metric: MetricRecord): string
```

Re-exported from `js/opentelemetry/metrics.metricSeriesKey`.

## normalizeMetricKind

```ts
function normalizeMetricKind(kind: string | undefined): string
```

Re-exported from `js/opentelemetry/metrics.normalizeMetricKind`.

## runWithMeterProvider

```ts
function runWithMeterProvider<R>(provider: MeterProvider, fn: () => R): R
```

Re-exported from `js/opentelemetry/metrics.runWithMeterProvider`.

## runWithoutMeterProvider

```ts
function runWithoutMeterProvider<R>(fn: () => R): R
```

Re-exported from `js/opentelemetry/metrics.runWithoutMeterProvider`.

## setMeterProvider

```ts
function setMeterProvider(provider: MeterProvider): void
```

Re-exported from `js/opentelemetry/metrics.setMeterProvider`.

## zeroMetric

```ts
function zeroMetric(metric: MetricRecord): MetricRecord
```

Re-exported from `js/opentelemetry/metrics.zeroMetric`.

## ExemplarRecord

```ts
interface ExemplarRecord {
```

Re-exported from `js/opentelemetry/metrics.ExemplarRecord`.

## ExponentialBuckets

```ts
interface ExponentialBuckets {
```

Re-exported from `js/opentelemetry/metrics.ExponentialBuckets`.

## MetricAggregationType

```ts
type MetricAggregationType = 'histogram' | 'lastValue' | 'sum'
```

Re-exported from `js/opentelemetry/metrics.MetricAggregationType`.

## MetricExemplarContext

```ts
interface MetricExemplarContext {
```

Re-exported from `js/opentelemetry/metrics.MetricExemplarContext`.

## MetricInstrumentOptions

```ts
interface MetricInstrumentOptions {
```

Re-exported from `js/opentelemetry/metrics.MetricInstrumentOptions`.

## MetricRecord

```ts
interface MetricRecord {
```

Re-exported from `js/opentelemetry/metrics.MetricRecord`.

## MetricTemporality

```ts
type MetricTemporality = 'delta' | 'cumulative'
```

Re-exported from `js/opentelemetry/metrics.MetricTemporality`.

## MetricView

```ts
interface MetricView {
```

Re-exported from `js/opentelemetry/metrics.MetricView`.

## ObservableMetricObservation

```ts
interface ObservableMetricObservation {
```

Re-exported from `js/opentelemetry/metrics.ObservableMetricObservation`.

## ObservableMetricRegistration

```ts
interface ObservableMetricRegistration {
```

Re-exported from `js/opentelemetry/metrics.ObservableMetricRegistration`.

## QuantileValueRecord

```ts
interface QuantileValueRecord {
```

Re-exported from `js/opentelemetry/metrics.QuantileValueRecord`.

## LogRecordBuilder

```ts
class LogRecordBuilder {
```

Re-exported from `js/opentelemetry/logs.LogRecordBuilder`.

## Logger

```ts
class Logger {
```

Re-exported from `js/opentelemetry/logs.Logger`.

## LoggerProvider

```ts
class LoggerProvider extends BaseProvider {
```

Re-exported from `js/opentelemetry/logs.LoggerProvider`.

## SeverityNumber

```ts
enum SeverityNumber {
  TRACE = 1,
  TRACE2 = 2,
  TRACE3 = 3,
  TRACE4 = 4,
  DEBUG = 5,
  DEBUG2 = 6,
  DEBUG3 = 7,
  DEBUG4 = 8,
  INFO = 9,
  INFO2 = 10,
  INFO3 = 11,
  INFO4 = 12,
  WARN = 13,
  WARN2 = 14,
  WARN3 = 15,
  WARN4 = 16,
  ERROR = 17,
  ERROR2 = 18,
  ERROR3 = 19,
  ERROR4 = 20,
  FATAL = 21,
  FATAL2 = 22,
  FATAL3 = 23,
  FATAL4 = 24
}

```

Re-exported from `js/opentelemetry/logs.SeverityNumber`.

## applyLogLimits

```ts
function applyLogLimits(log: LogRecord, limits: {
  attributeCountLimit?: number;
  attributeValueLengthLimit?: number;
} = {}): LogRecord
```

Re-exported from `js/opentelemetry/logs.applyLogLimits`.

## getLoggerProvider

```ts
function getLoggerProvider(): LoggerProvider
```

Re-exported from `js/opentelemetry/logs.getLoggerProvider`.

## runWithLoggerProvider

```ts
function runWithLoggerProvider<R>(provider: LoggerProvider, fn: () => R): R
```

Re-exported from `js/opentelemetry/logs.runWithLoggerProvider`.

## runWithoutLoggerProvider

```ts
function runWithoutLoggerProvider<R>(fn: () => R): R
```

Re-exported from `js/opentelemetry/logs.runWithoutLoggerProvider`.

## setLoggerProvider

```ts
function setLoggerProvider(provider: LoggerProvider): void
```

Re-exported from `js/opentelemetry/logs.setLoggerProvider`.

## LogRecord

```ts
interface LogRecord {
```

Re-exported from `js/opentelemetry/logs.LogRecord`.

## BatchLogRecordProcessor

```ts
class BatchLogRecordProcessor extends LogRecordProcessor {
```

Re-exported from `js/opentelemetry/sdk.BatchLogRecordProcessor`.

## BatchSpanProcessor

```ts
class BatchSpanProcessor extends SpanProcessor {
```

Re-exported from `js/opentelemetry/sdk.BatchSpanProcessor`.

## InMemoryExporter

```ts
class InMemoryExporter {
```

Re-exported from `js/opentelemetry/sdk.InMemoryExporter`.

## LogRecordProcessor

```ts
class LogRecordProcessor {
```

Re-exported from `js/opentelemetry/sdk.LogRecordProcessor`.

## ManualMetricReader

```ts
class ManualMetricReader extends MetricReader {
```

Re-exported from `js/opentelemetry/sdk.ManualMetricReader`.

## MetricReader

```ts
class MetricReader {
```

Re-exported from `js/opentelemetry/sdk.MetricReader`.

## OtelSDK

```ts
class OtelSDK {
```

Re-exported from `js/opentelemetry/sdk.OtelSDK`.

## PeriodicExportingMetricReader

```ts
const PeriodicExportingMetricReader
```

Re-exported from `js/opentelemetry/sdk.PeriodicExportingMetricReader`.

## PeriodicMetricReader

```ts
class PeriodicMetricReader extends MetricReader {
```

Re-exported from `js/opentelemetry/sdk.PeriodicMetricReader`.

## SpanProcessor

```ts
class SpanProcessor {
```

Re-exported from `js/opentelemetry/sdk.SpanProcessor`.

## Baggage

```ts
class Baggage {
```

Re-exported from `js/opentelemetry/sdk.Baggage`.

## BaseProvider

```ts
class BaseProvider {
```

Re-exported from `js/opentelemetry/sdk.BaseProvider`.

## OTEL_SCHEMA_VERSION

```ts
const OTEL_SCHEMA_VERSION
```

Re-exported from `js/opentelemetry/sdk.OTEL_SCHEMA_VERSION`.

## OTEL_TOPIC_SUFFIXES

```ts
const OTEL_TOPIC_SUFFIXES
```

Re-exported from `js/opentelemetry/sdk.OTEL_TOPIC_SUFFIXES`.

## Propagation

```ts
const Propagation
```

Re-exported from `js/opentelemetry/sdk.Propagation`.

## Resource

```ts
class Resource {
```

Re-exported from `js/opentelemetry/sdk.Resource`.

## TextMapPropagator

```ts
class TextMapPropagator {
```

Re-exported from `js/opentelemetry/sdk.TextMapPropagator`.

## W3CTraceContextPropagator

```ts
class W3CTraceContextPropagator extends TextMapPropagator {
```

Re-exported from `js/opentelemetry/sdk.W3CTraceContextPropagator`.

## bytesEqual

```ts
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean
```

Re-exported from `js/opentelemetry/sdk.bytesEqual`.

## carrierApiFor

```ts
function carrierApiFor<TCarrier>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>
): CarrierApi<TCarrier>
```

Re-exported from `js/opentelemetry/sdk.carrierApiFor`.

## consumeRequestContext

```ts
function consumeRequestContext(requestId: string): ActiveTelemetryContext | null
```

Re-exported from `js/opentelemetry/sdk.consumeRequestContext`.

## currentActiveTelemetryContext

```ts
function currentActiveTelemetryContext(): ActiveTelemetryContext | undefined
```

Re-exported from `js/opentelemetry/sdk.currentActiveTelemetryContext`.

## defaultCarrierApiFor

```ts
function defaultCarrierApiFor<TCarrier extends CarrierLike>(carrier: TCarrier): CarrierApi<TCarrier>
```

Re-exported from `js/opentelemetry/sdk.defaultCarrierApiFor`.

## encodeSegment

```ts
function encodeSegment(value: unknown): string
```

Re-exported from `js/opentelemetry/sdk.encodeSegment`.

## getActiveBaggage

```ts
function getActiveBaggage(): Baggage
```

Re-exported from `js/opentelemetry/sdk.getActiveBaggage`.

## hexToBytes

```ts
function hexToBytes(hex: string, size: number): Uint8Array
```

Re-exported from `js/opentelemetry/sdk.hexToBytes`.

## installRequestContext

```ts
function installRequestContext(requestId: string, context: ActiveTelemetryContext): void
```

Re-exported from `js/opentelemetry/sdk.installRequestContext`.

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

Re-exported from `js/opentelemetry/sdk.limitAttributeEntries`.

## mergeAttributes

```ts
function mergeAttributes(a?: Attributes, b?: Attributes): Attributes
```

Re-exported from `js/opentelemetry/sdk.mergeAttributes`.

## normalizeResource

```ts
function normalizeResource(resource?: Resource | Attributes | null): Resource
```

Re-exported from `js/opentelemetry/sdk.normalizeResource`.

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

Re-exported from `js/opentelemetry/sdk.normalizeScope`.

## nowUnixNano

```ts
function nowUnixNano(): number
```

Re-exported from `js/opentelemetry/sdk.nowUnixNano`.

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

Re-exported from `js/opentelemetry/sdk.otelRuntimeEvent`.

## otelRuntimeTopic

```ts
function otelRuntimeTopic(domain: string, operation: string, phase: string): string
```

Re-exported from `js/opentelemetry/sdk.otelRuntimeTopic`.

## otelTopic

```ts
function otelTopic(signal: string, scope: ScopeInfo, ...suffixes: string[]): string
```

Re-exported from `js/opentelemetry/sdk.otelTopic`.

## publishScoped

```ts
function publishScoped<TPayload>(
  signal: SignalName,
  scope: ScopeInfo,
  suffixes: string[],
  payload: TPayload
): void
```

Re-exported from `js/opentelemetry/sdk.publishScoped`.

## randomHex

```ts
function randomHex(length: number): string
```

Re-exported from `js/opentelemetry/sdk.randomHex`.

## registerActiveSpanContextGetter

```ts
function registerActiveSpanContextGetter(getter: () => TraceContext | null): void
```

Re-exported from `js/opentelemetry/sdk.registerActiveSpanContextGetter`.

## requireNonEmptyName

```ts
function requireNonEmptyName(kind: string, value: unknown): string
```

Re-exported from `js/opentelemetry/sdk.requireNonEmptyName`.

## requireRecord

```ts
function requireRecord(kind: string, value: unknown): Record<string, unknown>
```

Re-exported from `js/opentelemetry/sdk.requireRecord`.

## runWithActiveContext

```ts
function runWithActiveContext<R>(context: ActiveTelemetryContext, fn: () => R): R
```

Re-exported from `js/opentelemetry/sdk.runWithActiveContext`.

## runWithBaggage

```ts
function runWithBaggage<R>(baggage: Baggage, fn: () => R): R
```

Re-exported from `js/opentelemetry/sdk.runWithBaggage`.

## scopeSegment

```ts
function scopeSegment(scope: ScopeInfo): string
```

Re-exported from `js/opentelemetry/sdk.scopeSegment`.

## snapshotCarrier

```ts
function snapshotCarrier<TCarrier extends CarrierLike>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>
): Record<string, unknown>
```

Re-exported from `js/opentelemetry/sdk.snapshotCarrier`.

## topic

```ts
function topic<T = unknown>(name: string): Topic<T>
```

Re-exported from `topic.topic`.

## topicNames

```ts
function topicNames(signal: string, scope: ScopeInfo, ...suffixes: string[]): string[]
```

Re-exported from `js/opentelemetry/sdk.topicNames`.

## truncateAttributeValue

```ts
function truncateAttributeValue(value: unknown, limit: number): unknown
```

Re-exported from `js/opentelemetry/sdk.truncateAttributeValue`.

## Attributes

```ts
type Attributes = Record<string, unknown>
```

Re-exported from `js/opentelemetry/sdk.Attributes`.

## CarrierApi

```ts
interface CarrierApi<TCarrier = CarrierLike> {
```

Re-exported from `js/opentelemetry/sdk.CarrierApi`.

## CarrierLike

```ts
type CarrierLike = {
  [key: string]: unknown;
  get?(key: string): unknown;
  set?(key: string, value: unknown): unknown;
  keys?(): Iterable<string>;
}
```

Re-exported from `js/opentelemetry/sdk.CarrierLike`.

## Disposable

```ts
interface Disposable {
```

Re-exported from `js/opentelemetry/sdk.Disposable`.

## ExportResult

```ts
interface ExportResult {
```

Re-exported from `js/opentelemetry/sdk.ExportResult`.

## Instrumentation

```ts
interface Instrumentation {
```

Re-exported from `js/opentelemetry/sdk.Instrumentation`.

## OtelExporter

```ts
interface OtelExporter {
```

Re-exported from `js/opentelemetry/sdk.OtelExporter`.

## OtelSdkLike

```ts
interface OtelSdkLike {
```

Re-exported from `js/opentelemetry/sdk.OtelSdkLike`.

## PartialSuccessResult

```ts
interface PartialSuccessResult {
```

Re-exported from `js/opentelemetry/sdk.PartialSuccessResult`.

## ProviderOptions

```ts
interface ProviderOptions {
```

Re-exported from `js/opentelemetry/sdk.ProviderOptions`.

## ResourceOptions

```ts
interface ResourceOptions {
```

Re-exported from `js/opentelemetry/sdk.ResourceOptions`.

## RetryOptions

```ts
interface RetryOptions {
```

Re-exported from `js/opentelemetry/sdk.RetryOptions`.

## RuntimeDnsEvent

```ts
interface RuntimeDnsEvent {
```

Re-exported from `js/opentelemetry/sdk.RuntimeDnsEvent`.

## RuntimeHttpRequestEvent

```ts
interface RuntimeHttpRequestEvent {
```

Re-exported from `js/opentelemetry/sdk.RuntimeHttpRequestEvent`.

## RuntimeSocketEvent

```ts
interface RuntimeSocketEvent {
```

Re-exported from `js/opentelemetry/sdk.RuntimeSocketEvent`.

## RuntimeTlsEvent

```ts
interface RuntimeTlsEvent {
```

Re-exported from `js/opentelemetry/sdk.RuntimeTlsEvent`.

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

Re-exported from `js/opentelemetry/sdk.ScopeInfo`.

## SignalName

```ts
type SignalName = 'trace' | 'log' | 'metric'
```

Re-exported from `js/opentelemetry/sdk.SignalName`.
