/**
 * Shared OpenTelemetry model, resource, propagation, and topic helpers.
 *
 * This internal module defines the record shapes and utility functions used by
 * the trace, log, metric, SDK, and exporter layers. It is responsible for W3C
 * trace-context propagation, baggage serialization, resource normalization,
 * runtime topic naming, attribute limiting, and request-context handoff between
 * instrumented runtime events and handler execution.
 *
 * Defaults favor safe local telemetry: resources include `service.name` and
 * Fino SDK attributes, propagation uses W3C `traceparent`, `tracestate`, and
 * `baggage`, and optional record fields are omitted rather than filled with
 * sentinel values. Helpers in this module are internal plumbing and may expose
 * low-level payload details when docs are built with `--include-private`.
 *
 * ```typescript no_run
 * import {
 *   normalizeResource,
 *   W3CTraceContextPropagator,
 * } from 'internal:opentelemetry/common';
 *
 * const resource = normalizeResource({ 'service.name': 'api' });
 * const carrier: Record<string, unknown> = {};
 * new W3CTraceContextPropagator().inject(carrier, {
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 *   traceFlags: 1,
 * });
 * ```
 *
 * See the W3C Trace Context specification:
 * https://www.w3.org/TR/trace-context/
 *
 * @internal
 */
import { Context } from '../../context/index.ts';
import { topic } from '../../context/topic.ts';
export { topic } from '../../context/topic.ts';
/**
 * Open-ended key/value map of attributes attached to spans, logs, metrics, and resources.
 *
 * Values are stored as `unknown` because the OpenTelemetry data model permits
 * strings, numbers, booleans, and homogeneous arrays of those; validation and
 * truncation happen later in `limitAttributeEntries` and `truncateAttributeValue`
 * rather than in the type. An empty object is a valid, attribute-free value.
 *
 * ```typescript no_run
 * import type { Attributes } from 'internal:opentelemetry/common';
 *
 * const attrs: Attributes = {
 *   'http.request.method': 'GET',
 *   'http.response.status_code': 200,
 *   'url.path': '/orders',
 * };
 * ```
 */
export type Attributes = Record<string, unknown>;
/**
 * Identity of an instrumentation scope — the named library or subsystem that produced a signal.
 *
 * The `name` is required and is what topic routing keys off of (see
 * `topicNames` and `otelTopic`); `version` further qualifies the scope in
 * versioned topic names. `schemaUrl`, `attributes`, and `droppedAttributesCount`
 * carry through to exported records unchanged. Construct these with
 * `normalizeScope` rather than by hand to guarantee a non-empty name.
 *
 * ```typescript no_run
 * import type { ScopeInfo } from 'internal:opentelemetry/common';
 *
 * const scope: ScopeInfo = { name: 'my-app/db', version: '2.1.0' };
 * ```
 */
export type ScopeInfo = {
  /**
   * name property on ScopeInfo.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ScopeInfo['name'];
   * ```
   */
  name: string;
  /**
   * version property on ScopeInfo.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ScopeInfo['version'];
   * ```
   */
  version?: string;
  /**
   * schemaUrl property on ScopeInfo.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ScopeInfo['schemaUrl'];
   * ```
   */
  schemaUrl?: string | null;
  /**
   * attributes property on ScopeInfo.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ScopeInfo['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * droppedAttributesCount property on ScopeInfo.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ScopeInfo['droppedAttributesCount'];
   * ```
   */
  droppedAttributesCount?: number;
};
/**
 * The three OpenTelemetry signal families this runtime emits.
 *
 * Used to build topic names and to select per-signal suffix vocabularies in
 * `OTEL_TOPIC_SUFFIXES`. Runtime instrumentation events use a separate
 * `'runtime'` family and are not part of this union.
 *
 * ```typescript no_run
 * import type { SignalName } from 'internal:opentelemetry/common';
 *
 * const signal: SignalName = 'trace';
 * ```
 */
export type SignalName = 'trace' | 'log' | 'metric';
/**
 * Aggregation temporality for a metric stream — whether points report a period delta or a running total.
 *
 * `'delta'` points describe the change since the previous export; `'cumulative'`
 * points describe the total since the stream's start time. Readers and exporters
 * must agree on temporality per instrument kind.
 *
 * ```typescript no_run
 * import type { MetricTemporality } from 'internal:opentelemetry/common';
 *
 * const temporality: MetricTemporality = 'cumulative';
 * ```
 */
export type MetricTemporality = 'delta' | 'cumulative';
/**
 * How a metric view aggregates recorded measurements.
 *
 * `'sum'` accumulates additive values, `'lastValue'` keeps only the most recent
 * observation (gauges), and `'histogram'` distributes values across buckets.
 * Selected per view in `MetricView.aggregation`.
 *
 * ```typescript no_run
 * import type { MetricAggregationType } from 'internal:opentelemetry/common';
 *
 * const aggregation: MetricAggregationType = 'histogram';
 * ```
 */
export type MetricAggregationType = 'histogram' | 'lastValue' | 'sum';
/**
 * Duck-typed shape a propagation carrier may take — a plain record and/or a `Headers`-like accessor object.
 *
 * Propagators read and write context keys through either the indexer or, when
 * present, the optional `get`/`set`/`keys` methods (as a `Headers` or `Map`
 * provides). `defaultCarrierApiFor` inspects a value of this shape and picks the
 * right access strategy, so most callers pass a plain object or a `Headers`
 * instance directly.
 *
 * ```typescript no_run
 * import type { CarrierLike } from 'internal:opentelemetry/common';
 *
 * const plain: CarrierLike = { traceparent: '00-...-01' };
 * const headers: CarrierLike = new Headers();
 * ```
 */
export type CarrierLike = {
  [key: string]: unknown;
  /**
   * get method on CarrierLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: CarrierLike['get'] = undefined as never;
   * ```
   */
  get?(key: string): unknown;
  /**
   * set method on CarrierLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: CarrierLike['set'] = undefined as never;
   * ```
   */
  set?(key: string, value: unknown): unknown;
  /**
   * keys method on CarrierLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: CarrierLike['keys'] = undefined as never;
   * ```
   */
  keys?(): Iterable<string>;
};
/**
 * Strategy object that reads, writes, and enumerates keys on a specific carrier type.
 *
 * Propagators never touch a carrier directly; they receive a `CarrierApi` from
 * `carrierApiFor`/`defaultCarrierApiFor` so the same inject/extract logic works
 * against plain objects, `Headers`, `Map`, or any bespoke transport. Supply a
 * custom implementation when your carrier does not match `CarrierLike`.
 *
 * ```typescript no_run
 * import type { CarrierApi } from 'internal:opentelemetry/common';
 *
 * const mapApi: CarrierApi<Map<string, string>> = {
 *   get: (m, k) => m.get(k),
 *   set: (m, k, v) => void m.set(k, String(v)),
 *   keys: (m) => [...m.keys()],
 * };
 * ```
 */
export interface CarrierApi<TCarrier = CarrierLike> {
  /**
   * get method on CarrierApi.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: CarrierApi['get'] = undefined as never;
   * ```
   */
  get(target: TCarrier, key: string): unknown;
  /**
   * set method on CarrierApi.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: CarrierApi['set'] = undefined as never;
   * ```
   */
  set(target: TCarrier, key: string, value: unknown): void;
  /**
   * keys method on CarrierApi.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: CarrierApi['keys'] = undefined as never;
   * ```
   */
  keys(target: TCarrier): string[];
}
function readCarrierValue(carrier: unknown, key: string): unknown {
  const record = carrier as Record<string, unknown> | null | undefined;
  return record?.[key];
}
function writeCarrierValue(carrier: unknown, key: string, value: unknown): void {
  (carrier as Record<string, unknown>)[key] = value;
}
/**
 * Trace-context fields carried across a propagation boundary.
 *
 * Every field is optional so the same shape describes both a fully-populated
 * extracted context and a partial one under construction. `traceId`/`spanId` are
 * lowercase hex, `traceFlags` is the one-byte W3C flags value (bit 0 = sampled),
 * `traceState` is the raw vendor list, and `baggage` holds decoded W3C baggage.
 *
 * ```typescript no_run
 * import type { TraceContext } from 'internal:opentelemetry/common';
 *
 * const ctx: TraceContext = {
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 *   traceFlags: 1,
 * };
 * ```
 */
export interface TraceContext {
  /**
   * traceId property on TraceContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: TraceContext['traceId'];
   * ```
   */
  traceId?: string;
  /**
   * spanId property on TraceContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: TraceContext['spanId'];
   * ```
   */
  spanId?: string;
  /**
   * traceFlags property on TraceContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: TraceContext['traceFlags'];
   * ```
   */
  traceFlags?: number;
  /**
   * traceState property on TraceContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: TraceContext['traceState'];
   * ```
   */
  traceState?: string;
  /**
   * baggage property on TraceContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: TraceContext['baggage'];
   * ```
   */
  baggage?: Baggage | null;
}
/**
 * Terminal status attached to a span at end time.
 *
 * `code` is the OpenTelemetry status string (typically `'unset'`, `'ok'`, or
 * `'error'`); `message` supplies a human-readable description and is meaningful
 * mainly for the error code. A `null` status on a span means status was never
 * set and should be treated as unset.
 *
 * ```typescript no_run
 * import type { SpanStatus } from 'internal:opentelemetry/common';
 *
 * const status: SpanStatus = { code: 'error', message: 'connection reset' };
 * ```
 */
export interface SpanStatus {
  /**
   * code property on SpanStatus.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanStatus['code'];
   * ```
   */
  code?: string;
  /**
   * message property on SpanStatus.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanStatus['message'];
   * ```
   */
  message?: string;
}
/**
 * Minimal reference to another span that a link points at.
 *
 * Identifies the linked span by its `traceId` and `spanId` (both required),
 * optionally carrying that span's `traceState` and W3C `flags`. Extended with
 * attributes by `SpanLinkRecord`.
 *
 * ```typescript no_run
 * import type { SpanLinkContext } from 'internal:opentelemetry/common';
 *
 * const link: SpanLinkContext = {
 *   traceId: '00000000000000000000000000000002',
 *   spanId: '0000000000000002',
 * };
 * ```
 */
export interface SpanLinkContext {
  /**
   * traceId property on SpanLinkContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLinkContext['traceId'];
   * ```
   */
  traceId: string;
  /**
   * spanId property on SpanLinkContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLinkContext['spanId'];
   * ```
   */
  spanId: string;
  /**
   * traceState property on SpanLinkContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLinkContext['traceState'];
   * ```
   */
  traceState?: string;
  /**
   * flags property on SpanLinkContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLinkContext['flags'];
   * ```
   */
  flags?: number;
}
/**
 * A span link enriched with its own attributes for export.
 *
 * Adds an optional `attributes` bag and a `droppedAttributesCount` to the bare
 * `SpanLinkContext`, matching the OTLP link shape. This is the form passed in
 * `SpanStartOptions.links` and stored on a `SpanRecord`.
 *
 * ```typescript no_run
 * import type { SpanLinkRecord } from 'internal:opentelemetry/common';
 *
 * const link: SpanLinkRecord = {
 *   traceId: '00000000000000000000000000000002',
 *   spanId: '0000000000000002',
 *   attributes: { 'link.kind': 'follows_from' },
 * };
 * ```
 */
export interface SpanLinkRecord extends SpanLinkContext {
  /**
   * attributes property on SpanLinkRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLinkRecord['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * droppedAttributesCount property on SpanLinkRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLinkRecord['droppedAttributesCount'];
   * ```
   */
  droppedAttributesCount?: number;
}
/**
 * A timestamped, named event recorded within a span's lifetime.
 *
 * `name` is required; `timeUnixNano` defaults to the moment the event was added
 * when omitted, and `attributes` carry structured detail. Exceptions are
 * commonly recorded as an event named `exception` with `exception.*` attributes.
 *
 * ```typescript no_run
 * import type { SpanEventRecord } from 'internal:opentelemetry/common';
 *
 * const event: SpanEventRecord = {
 *   name: 'cache.miss',
 *   attributes: { 'cache.key': 'user:42' },
 * };
 * ```
 */
export interface SpanEventRecord {
  /**
   * name property on SpanEventRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanEventRecord['name'];
   * ```
   */
  name: string;
  /**
   * attributes property on SpanEventRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanEventRecord['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * timeUnixNano property on SpanEventRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanEventRecord['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * droppedAttributesCount property on SpanEventRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanEventRecord['droppedAttributesCount'];
   * ```
   */
  droppedAttributesCount?: number;
}
/**
 * The full serialized shape of a span as it flows across topics and into exporters.
 *
 * `traceId` and `spanId` are required; everything else is populated across the
 * span lifecycle (start, attribute/event/link mutations, status, end). Timestamps
 * are Unix nanoseconds, `kind` is the OTel span-kind string, and the `dropped*`
 * counters record data lost to span limits. `injectedHeaders` snapshots any
 * propagation headers written on the outbound side of an instrumented call.
 *
 * ```typescript no_run
 * import type { SpanRecord } from 'internal:opentelemetry/common';
 *
 * const span: SpanRecord = {
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 *   name: 'GET /orders',
 *   kind: 'server',
 *   startTimeUnixNano: Date.now() * 1e6,
 * };
 * ```
 */
export interface SpanRecord {
  /**
   * schemaVersion property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['schemaVersion'];
   * ```
   */
  schemaVersion?: number;
  /**
   * operation property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['operation'];
   * ```
   */
  operation?: string;
  /**
   * name property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['name'];
   * ```
   */
  name?: string;
  /**
   * traceId property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['traceId'];
   * ```
   */
  traceId: string;
  /**
   * spanId property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['spanId'];
   * ```
   */
  spanId: string;
  /**
   * parentSpanId property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['parentSpanId'];
   * ```
   */
  parentSpanId?: string | null;
  /**
   * traceState property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['traceState'];
   * ```
   */
  traceState?: string;
  /**
   * timeUnixNano property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * startTimeUnixNano property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['startTimeUnixNano'];
   * ```
   */
  startTimeUnixNano?: number;
  /**
   * endTimeUnixNano property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['endTimeUnixNano'];
   * ```
   */
  endTimeUnixNano?: number;
  /**
   * attributes property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * scope property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['scope'];
   * ```
   */
  scope?: ScopeInfo;
  /**
   * resource property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['resource'];
   * ```
   */
  resource?: Resource;
  /**
   * kind property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['kind'];
   * ```
   */
  kind?: string;
  /**
   * status property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['status'];
   * ```
   */
  status?: SpanStatus | null;
  /**
   * events property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['events'];
   * ```
   */
  events?: SpanEventRecord[];
  /**
   * links property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['links'];
   * ```
   */
  links?: SpanLinkRecord[];
  /**
   * droppedAttributesCount property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['droppedAttributesCount'];
   * ```
   */
  droppedAttributesCount?: number;
  /**
   * droppedEventsCount property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['droppedEventsCount'];
   * ```
   */
  droppedEventsCount?: number;
  /**
   * droppedLinksCount property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['droppedLinksCount'];
   * ```
   */
  droppedLinksCount?: number;
  /**
   * flags property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['flags'];
   * ```
   */
  flags?: number;
  /**
   * injectedHeaders property on SpanRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanRecord['injectedHeaders'];
   * ```
   */
  injectedHeaders?: Record<string, unknown>;
}
/**
 * The serialized shape of a single log record in the OpenTelemetry data model.
 *
 * `body` holds the log payload (string or structured value). `severityNumber`
 * is the numeric OTel severity (1–24) and `severityText` its label. When a log
 * is emitted inside an active span the `traceId`/`spanId`/`traceFlags` are
 * stamped for correlation, and `baggage` captures the active baggage. `eventName`
 * marks the record as a semantic event rather than a free-form message.
 *
 * ```typescript no_run
 * import type { LogRecord } from 'internal:opentelemetry/common';
 *
 * const log: LogRecord = {
 *   body: 'checkout completed',
 *   severityNumber: 9,
 *   severityText: 'INFO',
 * };
 * ```
 */
export interface LogRecord {
  /**
   * schemaVersion property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['schemaVersion'];
   * ```
   */
  schemaVersion?: number;
  /**
   * body property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['body'];
   * ```
   */
  body?: unknown;
  /**
   * severityText property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['severityText'];
   * ```
   */
  severityText?: string;
  /**
   * severityNumber property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['severityNumber'];
   * ```
   */
  severityNumber?: number;
  /**
   * timeUnixNano property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * observedTimeUnixNano property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['observedTimeUnixNano'];
   * ```
   */
  observedTimeUnixNano?: number;
  /**
   * attributes property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * droppedAttributesCount property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['droppedAttributesCount'];
   * ```
   */
  droppedAttributesCount?: number;
  /**
   * scope property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['scope'];
   * ```
   */
  scope?: ScopeInfo;
  /**
   * resource property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['resource'];
   * ```
   */
  resource?: Resource;
  /**
   * traceId property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['traceId'];
   * ```
   */
  traceId?: string;
  /**
   * spanId property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['spanId'];
   * ```
   */
  spanId?: string;
  /**
   * traceFlags property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['traceFlags'];
   * ```
   */
  traceFlags?: number;
  /**
   * baggage property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['baggage'];
   * ```
   */
  baggage?: Baggage | null;
  /**
   * eventName property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['eventName'];
   * ```
   */
  eventName?: string;
  /**
   * categoryName property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['categoryName'];
   * ```
   */
  categoryName?: string;
  /**
   * flags property on LogRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: LogRecord['flags'];
   * ```
   */
  flags?: number;
}
/**
 * An exemplar — a sampled measurement that links a metric point back to a trace.
 *
 * Records the measured `value` (or the typed `asInt`/`asDouble`), the
 * `timeUnixNano` at which it was taken, and the `traceId`/`spanId` of the span
 * active during the measurement. `filteredAttributes` holds attributes that were
 * dropped by the view but retained on the exemplar for debugging.
 *
 * ```typescript no_run
 * import type { ExemplarRecord } from 'internal:opentelemetry/common';
 *
 * const exemplar: ExemplarRecord = {
 *   value: 128,
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 * };
 * ```
 */
export interface ExemplarRecord {
  /**
   * timeUnixNano property on ExemplarRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExemplarRecord['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * traceId property on ExemplarRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExemplarRecord['traceId'];
   * ```
   */
  traceId?: string;
  /**
   * spanId property on ExemplarRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExemplarRecord['spanId'];
   * ```
   */
  spanId?: string;
  /**
   * value property on ExemplarRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExemplarRecord['value'];
   * ```
   */
  value?: number;
  /**
   * asInt property on ExemplarRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExemplarRecord['asInt'];
   * ```
   */
  asInt?: number;
  /**
   * asDouble property on ExemplarRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExemplarRecord['asDouble'];
   * ```
   */
  asDouble?: number;
  /**
   * filteredAttributes property on ExemplarRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExemplarRecord['filteredAttributes'];
   * ```
   */
  filteredAttributes?: Attributes;
}
/**
 * A single quantile/value pair in a summary metric point.
 *
 * `quantile` is in the range 0..1 (0.5 is the median, 0.99 the 99th percentile)
 * and `value` is the estimated measurement at that quantile. Both are required.
 *
 * ```typescript no_run
 * import type { QuantileValueRecord } from 'internal:opentelemetry/common';
 *
 * const p99: QuantileValueRecord = { quantile: 0.99, value: 250 };
 * ```
 */
export interface QuantileValueRecord {
  /**
   * quantile property on QuantileValueRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: QuantileValueRecord['quantile'];
   * ```
   */
  quantile: number;
  /**
   * value property on QuantileValueRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: QuantileValueRecord['value'];
   * ```
   */
  value: number;
}
/**
 * One side (positive or negative) of an exponential histogram's bucket counts.
 *
 * `offset` is the index of the first populated bucket relative to the histogram
 * scale, and `bucketCounts` are the per-bucket counts starting at that offset.
 * Counts may be `bigint` when they exceed the safe integer range. Used by the
 * `positive`/`negative` fields of an exponential-histogram `MetricRecord`.
 *
 * ```typescript no_run
 * import type { ExponentialBuckets } from 'internal:opentelemetry/common';
 *
 * const positive: ExponentialBuckets = { offset: 0, bucketCounts: [3, 7, 2] };
 * ```
 */
export interface ExponentialBuckets {
  /**
   * offset property on ExponentialBuckets.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExponentialBuckets['offset'];
   * ```
   */
  offset?: number;
  /**
   * bucketCounts property on ExponentialBuckets.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExponentialBuckets['bucketCounts'];
   * ```
   */
  bucketCounts?: Array<number | bigint>;
}
/**
 * The trace context captured at the moment a measurement is recorded, used to build exemplars.
 *
 * An instrument reads the active span and passes this alongside a value so the
 * metric layer can attach an `ExemplarRecord`. A `null` context on a
 * `MetricRecord` means no span was active.
 *
 * ```typescript no_run
 * import type { MetricExemplarContext } from 'internal:opentelemetry/common';
 *
 * const ctx: MetricExemplarContext = {
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 *   traceFlags: 1,
 * };
 * ```
 */
export interface MetricExemplarContext {
  /**
   * traceId property on MetricExemplarContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricExemplarContext['traceId'];
   * ```
   */
  traceId?: string;
  /**
   * spanId property on MetricExemplarContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricExemplarContext['spanId'];
   * ```
   */
  spanId?: string;
  /**
   * traceFlags property on MetricExemplarContext.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricExemplarContext['traceFlags'];
   * ```
   */
  traceFlags?: number;
}
/**
 * The serialized shape of a single metric data point, spanning every instrument kind.
 *
 * Only `name` is required; which of the remaining fields are populated depends
 * on `kind` and `aggregationKind`. Sums and gauges use `value`; histograms use
 * `count`/`sum`/`min`/`max` with `explicitBounds`/`bucketCounts`; summaries use
 * `quantileValues`; exponential histograms use `scale`/`zeroCount`/`positive`/
 * `negative`. `aggregationTemporality` is the numeric OTLP temporality enum.
 *
 * ```typescript no_run
 * import type { MetricRecord } from 'internal:opentelemetry/common';
 *
 * const point: MetricRecord = {
 *   name: 'http.server.request.duration',
 *   kind: 'histogram',
 *   count: 3,
 *   sum: 42,
 *   explicitBounds: [10, 50, 100],
 *   bucketCounts: [1, 1, 1, 0],
 * };
 * ```
 */
export interface MetricRecord {
  /**
   * schemaVersion property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['schemaVersion'];
   * ```
   */
  schemaVersion?: number;
  /**
   * name property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['name'];
   * ```
   */
  name: string;
  /**
   * value property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['value'];
   * ```
   */
  value?: number;
  /**
   * count property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['count'];
   * ```
   */
  count?: number;
  /**
   * sum property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['sum'];
   * ```
   */
  sum?: number;
  /**
   * min property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['min'];
   * ```
   */
  min?: number;
  /**
   * max property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['max'];
   * ```
   */
  max?: number;
  /**
   * unit property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['unit'];
   * ```
   */
  unit?: string;
  /**
   * description property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['description'];
   * ```
   */
  description?: string;
  /**
   * kind property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['kind'];
   * ```
   */
  kind?: string;
  /**
   * aggregationKind property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['aggregationKind'];
   * ```
   */
  aggregationKind?: string;
  /**
   * aggregationTemporality property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['aggregationTemporality'];
   * ```
   */
  aggregationTemporality?: number;
  /**
   * isMonotonic property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['isMonotonic'];
   * ```
   */
  isMonotonic?: boolean;
  /**
   * attributes property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * metadata property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['metadata'];
   * ```
   */
  metadata?: Attributes;
  /**
   * scope property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['scope'];
   * ```
   */
  scope?: ScopeInfo;
  /**
   * resource property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['resource'];
   * ```
   */
  resource?: Resource;
  /**
   * timeUnixNano property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * startTimeUnixNano property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['startTimeUnixNano'];
   * ```
   */
  startTimeUnixNano?: number;
  /**
   * explicitBounds property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['explicitBounds'];
   * ```
   */
  explicitBounds?: number[];
  /**
   * bucketCounts property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['bucketCounts'];
   * ```
   */
  bucketCounts?: Array<number | bigint>;
  /**
   * quantileValues property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['quantileValues'];
   * ```
   */
  quantileValues?: QuantileValueRecord[];
  /**
   * exemplars property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['exemplars'];
   * ```
   */
  exemplars?: ExemplarRecord[];
  /**
   * flags property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['flags'];
   * ```
   */
  flags?: number;
  /**
   * exemplarContext property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['exemplarContext'];
   * ```
   */
  exemplarContext?: MetricExemplarContext | null;
  /**
   * scale property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['scale'];
   * ```
   */
  scale?: number;
  /**
   * zeroCount property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['zeroCount'];
   * ```
   */
  zeroCount?: number;
  /**
   * zeroThreshold property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['zeroThreshold'];
   * ```
   */
  zeroThreshold?: number;
  /**
   * positive property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['positive'];
   * ```
   */
  positive?: ExponentialBuckets;
  /**
   * negative property on MetricRecord.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricRecord['negative'];
   * ```
   */
  negative?: ExponentialBuckets;
}
/**
 * One value produced by an observable (async) instrument's callback.
 *
 * `value` is required; `attributes` distinguish concurrent series for the same
 * instrument, and `timeUnixNano` overrides the collection timestamp when set. A
 * callback may return one of these or an array of them per collection cycle.
 *
 * ```typescript no_run
 * import type { ObservableMetricObservation } from 'internal:opentelemetry/common';
 *
 * const observation: ObservableMetricObservation = {
 *   value: process.memoryUsage?.().rss ?? 0,
 *   attributes: { 'pool': 'heap' },
 * };
 * ```
 */
export interface ObservableMetricObservation {
  /**
   * value property on ObservableMetricObservation.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricObservation['value'];
   * ```
   */
  value: number;
  /**
   * attributes property on ObservableMetricObservation.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricObservation['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * timeUnixNano property on ObservableMetricObservation.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricObservation['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
}
/**
 * A registered observable instrument and the callback the meter invokes each collection cycle.
 *
 * All descriptive fields (`kind`, `name`, `unit`, `description`, `scope`,
 * `resource`) are required so the emitted metric is fully described without a
 * separate lookup. `callback` is polled on every metric read and may return a
 * single observation, an array, or `null`/`undefined` to skip the cycle.
 *
 * ```typescript no_run
 * import type { ObservableMetricRegistration } from 'internal:opentelemetry/common';
 *
 * const reg: ObservableMetricRegistration = {
 *   kind: 'observableGauge',
 *   name: 'process.uptime',
 *   unit: 's',
 *   description: 'seconds since start',
 *   scope: { name: 'runtime' },
 *   resource: {} as never,
 *   callback: () => ({ value: performance.now() / 1000 }),
 * };
 * ```
 */
export interface ObservableMetricRegistration {
  /**
   * kind property on ObservableMetricRegistration.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricRegistration['kind'];
   * ```
   */
  kind: string;
  /**
   * name property on ObservableMetricRegistration.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricRegistration['name'];
   * ```
   */
  name: string;
  /**
   * unit property on ObservableMetricRegistration.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricRegistration['unit'];
   * ```
   */
  unit: string;
  /**
   * description property on ObservableMetricRegistration.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricRegistration['description'];
   * ```
   */
  description: string;
  /**
   * scope property on ObservableMetricRegistration.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricRegistration['scope'];
   * ```
   */
  scope: ScopeInfo;
  /**
   * resource property on ObservableMetricRegistration.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricRegistration['resource'];
   * ```
   */
  resource: Resource;
  /**
   * callback property on ObservableMetricRegistration.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ObservableMetricRegistration['callback'];
   * ```
   */
  callback: () => ObservableMetricObservation | ObservableMetricObservation[] | null | undefined;
}
/**
 * Descriptive options supplied when creating a metric instrument.
 *
 * `unit` and `description` are carried onto every emitted point; `attributes`
 * provide instrument-level defaults merged with per-measurement attributes; and
 * `kind` names the instrument type. All fields are optional.
 *
 * ```typescript no_run
 * import type { MetricInstrumentOptions } from 'internal:opentelemetry/common';
 *
 * const options: MetricInstrumentOptions = {
 *   unit: 'ms',
 *   description: 'request latency',
 * };
 * ```
 */
export interface MetricInstrumentOptions {
  /**
   * unit property on MetricInstrumentOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricInstrumentOptions['unit'];
   * ```
   */
  unit?: string;
  /**
   * description property on MetricInstrumentOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricInstrumentOptions['description'];
   * ```
   */
  description?: string;
  /**
   * attributes property on MetricInstrumentOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricInstrumentOptions['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * kind property on MetricInstrumentOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricInstrumentOptions['kind'];
   * ```
   */
  kind?: string;
}
/**
 * A view that reshapes how a matched instrument is aggregated and exported.
 *
 * `instrumentName` selects which instrument the view applies to (supporting a
 * trailing `*` wildcard by convention); `name`/`description` rename the output
 * stream; `attributeKeys` restricts which attribute keys are kept; and
 * `aggregation` overrides the aggregation type and, for histograms, the bucket
 * `boundaries`.
 *
 * ```typescript no_run
 * import type { MetricView } from 'internal:opentelemetry/common';
 *
 * const view: MetricView = {
 *   instrumentName: 'http.server.*',
 *   attributeKeys: ['http.route'],
 *   aggregation: { type: 'histogram', boundaries: [50, 100, 250] },
 * };
 * ```
 */
export interface MetricView {
  /**
   * instrumentName property on MetricView.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricView['instrumentName'];
   * ```
   */
  instrumentName?: string;
  /**
   * name property on MetricView.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricView['name'];
   * ```
   */
  name?: string;
  /**
   * description property on MetricView.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricView['description'];
   * ```
   */
  description?: string;
  /**
   * attributeKeys property on MetricView.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricView['attributeKeys'];
   * ```
   */
  attributeKeys?: string[];
  /**
   * aggregation property on MetricView.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: MetricView['aggregation'];
   * ```
   */
  aggregation?: {
    type: MetricAggregationType;
    boundaries?: number[];
    monotonic?: boolean;
  };
}
/**
 * The `partialSuccess` payload an OTLP endpoint returns when it accepts some but not all items.
 *
 * Each `rejected*` counter reports how many spans, logs, or data points the
 * backend dropped, and `errorMessage` explains why. A zero count with an empty
 * message indicates full success. Exporters surface this without treating it as
 * a transport failure.
 *
 * ```typescript no_run
 * import type { PartialSuccessResult } from 'internal:opentelemetry/common';
 *
 * const partial: PartialSuccessResult = {
 *   rejectedSpans: 2,
 *   rejectedLogs: 0,
 *   rejectedDataPoints: 0,
 *   errorMessage: 'span attribute limit exceeded',
 * };
 * ```
 */
export interface PartialSuccessResult {
  /**
   * rejectedSpans property on PartialSuccessResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: PartialSuccessResult['rejectedSpans'];
   * ```
   */
  rejectedSpans: number;
  /**
   * rejectedLogs property on PartialSuccessResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: PartialSuccessResult['rejectedLogs'];
   * ```
   */
  rejectedLogs: number;
  /**
   * rejectedDataPoints property on PartialSuccessResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: PartialSuccessResult['rejectedDataPoints'];
   * ```
   */
  rejectedDataPoints: number;
  /**
   * errorMessage property on PartialSuccessResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: PartialSuccessResult['errorMessage'];
   * ```
   */
  errorMessage: string;
}
/**
 * The outcome an exporter resolves with after attempting to send a batch.
 *
 * `code` is `'success'` when the batch was delivered (including partial-success
 * responses that the exporter chose to accept) and `'failure'` when it was not.
 * Processors use this to decide whether to retry or drop the batch.
 *
 * ```typescript no_run
 * import type { ExportResult } from 'internal:opentelemetry/common';
 *
 * const result: ExportResult = { code: 'success' };
 * ```
 */
export interface ExportResult {
  /**
   * code property on ExportResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ExportResult['code'];
   * ```
   */
  code: 'success' | 'failure';
}
/**
 * The contract every telemetry exporter implements to receive batched records.
 *
 * A processor calls the `export*` method for its signal with an array of records
 * and awaits an `ExportResult`. Implementations should resolve (never reject) so
 * the processor can act on the result code, and the optional `shutdown` should
 * flush and release transport resources.
 *
 * ```typescript no_run
 * import type { OtelExporter, ExportResult } from 'internal:opentelemetry/common';
 *
 * const exporter: OtelExporter = {
 *   async exportSpans(spans): Promise<ExportResult> {
 *     console.log(spans.length, 'spans');
 *     return { code: 'success' };
 *   },
 *   async exportLogs() { return { code: 'success' }; },
 *   async exportMetrics() { return { code: 'success' }; },
 * };
 * ```
 */
export interface OtelExporter {
  /**
   * exportSpans method on OtelExporter.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelExporter['exportSpans'] = undefined as never;
   * ```
   */
  exportSpans(spans: SpanRecord[]): Promise<ExportResult>;
  /**
   * exportLogs method on OtelExporter.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelExporter['exportLogs'] = undefined as never;
   * ```
   */
  exportLogs(logs: LogRecord[]): Promise<ExportResult>;
  /**
   * exportMetrics method on OtelExporter.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelExporter['exportMetrics'] = undefined as never;
   * ```
   */
  exportMetrics(metrics: MetricRecord[]): Promise<ExportResult>;
  /**
   * shutdown method on OtelExporter.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelExporter['shutdown'] = undefined as never;
   * ```
   */
  shutdown?(): Promise<void>;
}
/**
 * The minimal SDK surface an `Instrumentation` needs to record signals and propagate context.
 *
 * Exposes the active `propagator` plus record sinks for each signal.
 * `recordSpanStart` publishes a span's start before it ends, while `recordSpan`
 * publishes the completed span; `recordLog` and `recordMetric` handle the other
 * two signals. Instrumentations depend on this narrow interface rather than the
 * concrete SDK so they stay decoupled from the SDK implementation.
 *
 * ```typescript no_run
 * import type { OtelSdkLike, SpanRecord } from 'internal:opentelemetry/common';
 *
 * function finish(sdk: OtelSdkLike, span: SpanRecord): void {
 *   span.endTimeUnixNano = Date.now() * 1e6;
 *   sdk.recordSpan(span);
 * }
 * ```
 */
export interface OtelSdkLike {
  /**
   * propagator property on OtelSdkLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: OtelSdkLike['propagator'];
   * ```
   */
  readonly propagator: TextMapPropagator;
  /**
   * recordSpanStart method on OtelSdkLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelSdkLike['recordSpanStart'] = undefined as never;
   * ```
   */
  recordSpanStart(span: SpanRecord): void;
  /**
   * recordSpan method on OtelSdkLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelSdkLike['recordSpan'] = undefined as never;
   * ```
   */
  recordSpan(span: SpanRecord): void;
  /**
   * recordLog method on OtelSdkLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelSdkLike['recordLog'] = undefined as never;
   * ```
   */
  recordLog(log: LogRecord): void;
  /**
   * recordMetric method on OtelSdkLike.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: OtelSdkLike['recordMetric'] = undefined as never;
   * ```
   */
  recordMetric(metric: MetricRecord): void;
}
/**
 * A teardown handle returned by an instrumentation's `enable` to undo its patches.
 *
 * Calling `dispose` should reverse whatever the instrumentation installed
 * (topic subscriptions, monkey-patches) and must be idempotent. An
 * instrumentation may return one, several, or none of these.
 *
 * ```typescript no_run
 * import type { Disposable } from 'internal:opentelemetry/common';
 *
 * const handle: Disposable = { dispose() { console.log('unhooked'); } };
 * handle.dispose();
 * ```
 */
export interface Disposable {
  /**
   * dispose method on Disposable.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: Disposable['dispose'] = undefined as never;
   * ```
   */
  dispose(): void;
}
/**
 * A pluggable instrumentation that wires runtime events into the SDK when enabled.
 *
 * `enable` is called once with the SDK and should install its hooks, optionally
 * returning `Disposable`(s) so the SDK can later tear them down. Returning
 * nothing means the instrumentation manages its own lifetime.
 *
 * ```typescript no_run
 * import type { Instrumentation } from 'internal:opentelemetry/common';
 *
 * const noop: Instrumentation = {
 *   enable(sdk) {
 *     return { dispose() {} };
 *   },
 * };
 * ```
 */
export interface Instrumentation {
  /**
   * enable method on Instrumentation.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * const member: Instrumentation['enable'] = undefined as never;
   * ```
   */
  enable(sdk: OtelSdkLike): void | Disposable | Disposable[];
}
/**
 * Payload published on the `otel:runtime:http.server`/`fetch` topics for an HTTP request lifecycle.
 *
 * `requestId` correlates the `start`, `end`, and `error` phases of one request.
 * `method`, `route`, `url`, and `headers` describe the request; `statusCode` and
 * `error` describe the outcome. The HTTP-server and fetch instrumentations
 * subscribe to these and translate them into spans.
 *
 * ```typescript no_run
 * import type { RuntimeHttpRequestEvent } from 'internal:opentelemetry/common';
 *
 * const event: RuntimeHttpRequestEvent = {
 *   requestId: 'req-1',
 *   method: 'GET',
 *   route: '/orders/:id',
 *   statusCode: 200,
 * };
 * ```
 */
export interface RuntimeHttpRequestEvent {
  /**
   * requestId property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['requestId'];
   * ```
   */
  requestId: string;
  /**
   * method property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['method'];
   * ```
   */
  method?: string;
  /**
   * route property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['route'];
   * ```
   */
  route?: string;
  /**
   * url property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['url'];
   * ```
   */
  url?: string;
  /**
   * headers property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['headers'];
   * ```
   */
  headers?: CarrierLike;
  /**
   * statusCode property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['statusCode'];
   * ```
   */
  statusCode?: number;
  /**
   * error property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['error'];
   * ```
   */
  error?: unknown;
  /**
   * timeUnixNano property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * resource property on RuntimeHttpRequestEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeHttpRequestEvent['resource'];
   * ```
   */
  resource?: Resource;
}
/**
 * Payload published on the `otel:runtime:dns` topics for a DNS lookup lifecycle.
 *
 * `lookupId` correlates the phases of one lookup and `requestId` ties it back to
 * the originating HTTP request when known. `hop` orders multiple lookups within
 * a request. The resolved `address`/`family` and any `error` describe the
 * outcome. Consumed by the DNS instrumentation to build client spans.
 *
 * ```typescript no_run
 * import type { RuntimeDnsEvent } from 'internal:opentelemetry/common';
 *
 * const event: RuntimeDnsEvent = {
 *   lookupId: 'dns-1',
 *   hostname: 'example.com',
 *   address: '93.184.216.34',
 *   family: 4,
 * };
 * ```
 */
export interface RuntimeDnsEvent {
  /**
   * lookupId property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['lookupId'];
   * ```
   */
  lookupId: string;
  /**
   * requestId property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['requestId'];
   * ```
   */
  requestId?: string;
  /**
   * hop property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['hop'];
   * ```
   */
  hop?: number;
  /**
   * hostname property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['hostname'];
   * ```
   */
  hostname?: string;
  /**
   * address property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['address'];
   * ```
   */
  address?: string;
  /**
   * family property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['family'];
   * ```
   */
  family?: string | number;
  /**
   * error property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['error'];
   * ```
   */
  error?: unknown;
  /**
   * timeUnixNano property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * resource property on RuntimeDnsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeDnsEvent['resource'];
   * ```
   */
  resource?: Resource;
}
/**
 * Payload published on the `otel:runtime:socket` topics for a TCP/socket connect lifecycle.
 *
 * `connectId` correlates the phases of one connection attempt and `requestId`
 * ties it to the originating request. `host`, `port`, and `transport` describe
 * the peer; `hop` orders retries; `error` describes a failed connect. Consumed
 * by the socket instrumentation.
 *
 * ```typescript no_run
 * import type { RuntimeSocketEvent } from 'internal:opentelemetry/common';
 *
 * const event: RuntimeSocketEvent = {
 *   connectId: 'sock-1',
 *   host: '10.0.0.5',
 *   port: 443,
 *   transport: 'tcp',
 * };
 * ```
 */
export interface RuntimeSocketEvent {
  /**
   * connectId property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['connectId'];
   * ```
   */
  connectId: string;
  /**
   * requestId property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['requestId'];
   * ```
   */
  requestId?: string;
  /**
   * hop property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['hop'];
   * ```
   */
  hop?: number;
  /**
   * host property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['host'];
   * ```
   */
  host?: string;
  /**
   * port property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['port'];
   * ```
   */
  port?: number;
  /**
   * transport property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['transport'];
   * ```
   */
  transport?: string;
  /**
   * error property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['error'];
   * ```
   */
  error?: unknown;
  /**
   * timeUnixNano property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * resource property on RuntimeSocketEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeSocketEvent['resource'];
   * ```
   */
  resource?: Resource;
}
/**
 * Payload published on the `otel:runtime:tls` topics for a TLS handshake lifecycle.
 *
 * `handshakeId` correlates the phases of one handshake and `requestId` ties it
 * to the originating request. `hostname`/`port` identify the peer, `protocol`
 * reports the negotiated TLS version, and `error` describes a failed handshake.
 * Consumed by the TLS instrumentation.
 *
 * ```typescript no_run
 * import type { RuntimeTlsEvent } from 'internal:opentelemetry/common';
 *
 * const event: RuntimeTlsEvent = {
 *   handshakeId: 'tls-1',
 *   hostname: 'example.com',
 *   port: 443,
 *   protocol: 'TLSv1.3',
 * };
 * ```
 */
export interface RuntimeTlsEvent {
  /**
   * handshakeId property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['handshakeId'];
   * ```
   */
  handshakeId: string;
  /**
   * requestId property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['requestId'];
   * ```
   */
  requestId?: string;
  /**
   * hop property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['hop'];
   * ```
   */
  hop?: number;
  /**
   * hostname property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['hostname'];
   * ```
   */
  hostname?: string;
  /**
   * port property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['port'];
   * ```
   */
  port?: number;
  /**
   * protocol property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['protocol'];
   * ```
   */
  protocol?: string;
  /**
   * error property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['error'];
   * ```
   */
  error?: unknown;
  /**
   * timeUnixNano property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['timeUnixNano'];
   * ```
   */
  timeUnixNano?: number;
  /**
   * resource property on RuntimeTlsEvent.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RuntimeTlsEvent['resource'];
   * ```
   */
  resource?: Resource;
}
/**
 * Secondary options for constructing a `Resource` beyond its attribute map.
 *
 * `droppedAttributesCount` records attributes elided before construction,
 * `entityRefs` declares OTel entity references (each with a type and identifying
 * key set), and `schemaUrl` pins the semantic-convention schema. All optional.
 *
 * ```typescript no_run
 * import { Resource } from 'internal:opentelemetry/common';
 * import type { ResourceOptions } from 'internal:opentelemetry/common';
 *
 * const options: ResourceOptions = {
 *   schemaUrl: 'https://opentelemetry.io/schemas/1.24.0',
 * };
 * const resource = new Resource({ 'service.name': 'api' }, options);
 * ```
 */
export interface ResourceOptions {
  /**
   * droppedAttributesCount property on ResourceOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ResourceOptions['droppedAttributesCount'];
   * ```
   */
  droppedAttributesCount?: number;
  /**
   * entityRefs property on ResourceOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ResourceOptions['entityRefs'];
   * ```
   */
  entityRefs?: Array<{
    schemaUrl?: string;
    type?: string;
    idKeys?: string[];
  }>;
  /**
   * schemaUrl property on ResourceOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ResourceOptions['schemaUrl'];
   * ```
   */
  schemaUrl?: string | null;
}
/**
 * Options shared by every signal provider (tracer, meter, logger).
 *
 * `resource` describes the entity producing telemetry and may be a `Resource`, a
 * plain attribute map (normalized via `normalizeResource`), or `null` to accept
 * the default resource. Passed to `BaseProvider`.
 *
 * ```typescript no_run
 * import type { ProviderOptions } from 'internal:opentelemetry/common';
 *
 * const options: ProviderOptions = {
 *   resource: { 'service.name': 'checkout', 'service.version': '4.2.0' },
 * };
 * ```
 */
export interface ProviderOptions {
  /**
   * resource property on ProviderOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: ProviderOptions['resource'];
   * ```
   */
  resource?: Resource | Attributes | null;
}
/**
 * Options for starting a span.
 *
 * `traceId` and `parentSpanId` establish parentage explicitly (a `null` parent
 * forces a new root even inside an active span); omitting them inherits the
 * active context. `attributes`, `links`, and `kind` seed the span at start.
 *
 * ```typescript no_run
 * import type { SpanStartOptions } from 'internal:opentelemetry/common';
 *
 * const options: SpanStartOptions = {
 *   kind: 'client',
 *   attributes: { 'db.system': 'postgresql' },
 * };
 * ```
 */
export interface SpanStartOptions {
  /**
   * traceId property on SpanStartOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanStartOptions['traceId'];
   * ```
   */
  traceId?: string;
  /**
   * parentSpanId property on SpanStartOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanStartOptions['parentSpanId'];
   * ```
   */
  parentSpanId?: string | null;
  /**
   * attributes property on SpanStartOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanStartOptions['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * links property on SpanStartOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanStartOptions['links'];
   * ```
   */
  links?: SpanLinkRecord[];
  /**
   * kind property on SpanStartOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanStartOptions['kind'];
   * ```
   */
  kind?: string;
}
/**
 * Options for ending a span.
 *
 * `attributes` are merged into the span at end time and `status` sets its final
 * status (a `null` status leaves the existing status untouched). Both optional.
 *
 * ```typescript no_run
 * import type { SpanEndOptions } from 'internal:opentelemetry/common';
 *
 * const options: SpanEndOptions = {
 *   status: { code: 'ok' },
 *   attributes: { 'http.response.status_code': 200 },
 * };
 * ```
 */
export interface SpanEndOptions {
  /**
   * attributes property on SpanEndOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanEndOptions['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * status property on SpanEndOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanEndOptions['status'];
   * ```
   */
  status?: SpanStatus | null;
}
/**
 * The trace context stored in the ambient async-context store as "currently active".
 *
 * Structurally identical to `TraceContext`; the distinct name marks values that
 * flow through `runWithActiveContext`/`currentActiveTelemetryContext` rather than
 * across a wire boundary. Read the current one with
 * `currentActiveTelemetryContext`.
 *
 * ```typescript no_run
 * import { runWithActiveContext } from 'internal:opentelemetry/common';
 * import type { ActiveTelemetryContext } from 'internal:opentelemetry/common';
 *
 * const active: ActiveTelemetryContext = {
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 *   traceFlags: 1,
 * };
 * runWithActiveContext(active, () => doWork());
 * ```
 */
export interface ActiveTelemetryContext extends TraceContext {}
/**
 * The decision a sampler returns for a candidate span.
 *
 * `sample` is the drop/keep verdict. `attributes` are merged onto the span when
 * kept (letting a sampler annotate its reasoning), and `traceState` lets the
 * sampler amend the vendor trace state that propagates downstream.
 *
 * ```typescript no_run
 * import type { SamplingResult } from 'internal:opentelemetry/common';
 *
 * const result: SamplingResult = {
 *   sample: true,
 *   attributes: { 'sampler.rate': 0.1 },
 * };
 * ```
 */
export interface SamplingResult {
  /**
   * sample property on SamplingResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SamplingResult['sample'];
   * ```
   */
  sample: boolean;
  /**
   * attributes property on SamplingResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SamplingResult['attributes'];
   * ```
   */
  attributes?: Attributes;
  /**
   * traceState property on SamplingResult.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SamplingResult['traceState'];
   * ```
   */
  traceState?: string;
}
/**
 * Caps applied to a span's attributes, events, and links before export.
 *
 * `attributeCountLimit` bounds how many attributes are kept (excess counted as
 * dropped by `limitAttributeEntries`); `attributeValueLengthLimit` truncates
 * long string values; `eventCountLimit` and `linkCountLimit` bound events and
 * links. Omitting a field means unlimited for that dimension.
 *
 * ```typescript no_run
 * import type { SpanLimits } from 'internal:opentelemetry/common';
 *
 * const limits: SpanLimits = {
 *   attributeCountLimit: 128,
 *   attributeValueLengthLimit: 1024,
 * };
 * ```
 */
export interface SpanLimits {
  /**
   * attributeCountLimit property on SpanLimits.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLimits['attributeCountLimit'];
   * ```
   */
  attributeCountLimit?: number;
  /**
   * attributeValueLengthLimit property on SpanLimits.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLimits['attributeValueLengthLimit'];
   * ```
   */
  attributeValueLengthLimit?: number;
  /**
   * eventCountLimit property on SpanLimits.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLimits['eventCountLimit'];
   * ```
   */
  eventCountLimit?: number;
  /**
   * linkCountLimit property on SpanLimits.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: SpanLimits['linkCountLimit'];
   * ```
   */
  linkCountLimit?: number;
}
/**
 * Exporter retry policy for transient export failures.
 *
 * `maxAttempts` bounds the total number of tries and `initialBackoffMillis` is
 * the first backoff delay, typically grown exponentially on each retry. Omitting
 * a field falls back to the exporter's built-in default.
 *
 * ```typescript no_run
 * import type { RetryOptions } from 'internal:opentelemetry/common';
 *
 * const retry: RetryOptions = { maxAttempts: 5, initialBackoffMillis: 250 };
 * ```
 */
export interface RetryOptions {
  /**
   * maxAttempts property on RetryOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RetryOptions['maxAttempts'];
   * ```
   */
  maxAttempts?: number;
  /**
   * initialBackoffMillis property on RetryOptions.
   *
   * Omitted optional values default to `undefined`; required values are expected from the producer before the record is exported or published. Consumers should tolerate missing optional fields in telemetry payloads.
   *
   * ```typescript no_run
   * let value: RetryOptions['initialBackoffMillis'];
   * ```
   */
  initialBackoffMillis?: number;
}
const DEFAULT_RESOURCE_ATTRIBUTES: Attributes = {
  'service.name': 'unknown_service',
  'telemetry.sdk.name': 'fino',
  'telemetry.sdk.language': 'javascript',
};
/**
 * Coerces a value to a plain record, tolerating nullish input but rejecting non-objects.
 *
 * Returns an empty object for `null`/`undefined`, returns the value unchanged
 * when it is a non-array object, and throws a `TypeError` (using `kind` in the
 * message) for primitives and arrays. Handy for validating optional options bags.
 *
 * ```typescript no_run
 * import { requireRecord } from 'internal:opentelemetry/common';
 *
 * requireRecord('attributes', undefined);        // {}
 * requireRecord('attributes', { a: 1 });         // { a: 1 }
 * requireRecord('attributes', [1, 2]);           // throws TypeError
 * ```
 */
export function requireRecord(kind: string, value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${kind} must be an object`);
  }
  return value as Record<string, unknown>;
}
/**
 * Version stamp written into the `schemaVersion` field of runtime event payloads.
 *
 * Consumers can branch on this to stay compatible as the internal event shape
 * evolves. It is the runtime's own event-schema version, unrelated to an OTel
 * semantic-convention `schemaUrl`.
 *
 * ```typescript no_run
 * import { OTEL_SCHEMA_VERSION } from 'internal:opentelemetry/common';
 *
 * if (OTEL_SCHEMA_VERSION >= 1) {
 *   // handle the current runtime event shape
 * }
 * ```
 */
export const OTEL_SCHEMA_VERSION = 1;
/**
 * The frozen catalog of valid topic suffixes for each signal family.
 *
 * Maps each family (`trace`, `log`, `metric`, `runtime`) to the lifecycle/level
 * suffixes it may append to a scoped topic name — for example a trace topic can
 * end in `start`/`end`/`error`, while a log topic ends in a severity like
 * `info`/`warn`. Deeply frozen so the vocabulary cannot be mutated at runtime.
 *
 * ```typescript no_run
 * import { OTEL_TOPIC_SUFFIXES } from 'internal:opentelemetry/common';
 *
 * OTEL_TOPIC_SUFFIXES.trace;  // ['start', 'end', 'error', 'event', ...]
 * OTEL_TOPIC_SUFFIXES.log;    // ['emit', 'debug', 'info', 'warn', 'error']
 * ```
 */
export const OTEL_TOPIC_SUFFIXES = Object.freeze({
  trace: Object.freeze(['start', 'end', 'error', 'event', 'attribute', 'link', 'status', 'rename']),
  log: Object.freeze(['emit', 'debug', 'info', 'warn', 'error']),
  metric: Object.freeze(['record', 'observe']),
  runtime: Object.freeze(['start', 'end', 'error']),
});
/**
 * Returns the current wall-clock time as Unix-epoch nanoseconds.
 *
 * Combines `performance.timeOrigin` with `performance.now()` for sub-millisecond
 * resolution, then scales to nanoseconds — the timestamp unit every record in
 * this module uses. Because the result is a double, it exceeds 2^53 and loses
 * single-nanosecond precision; it is accurate to roughly the microsecond.
 *
 * ```typescript no_run
 * import { nowUnixNano } from 'internal:opentelemetry/common';
 *
 * const span = { startTimeUnixNano: nowUnixNano() };
 * ```
 */
export function nowUnixNano(): number {
  return (performance.timeOrigin + performance.now()) * 1e6;
}
/**
 * Generates a cryptographically random lowercase hex string of the given length.
 *
 * Draws random bytes from `crypto.getRandomValues` and truncates to exactly
 * `length` characters, so odd lengths are supported. Used to mint trace and span
 * IDs (32 and 16 hex chars respectively).
 *
 * ```typescript no_run
 * import { randomHex } from 'internal:opentelemetry/common';
 *
 * const traceId = randomHex(32);
 * const spanId = randomHex(16);
 * ```
 */
export function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.slice(0, length);
}
/**
 * Percent-encodes a value for safe use as a single colon-delimited topic segment.
 *
 * Stringifies the input then applies `encodeURIComponent`, so any `:` or other
 * delimiter inside a scope name or suffix cannot break the `otel:...` topic
 * grammar. This is the escaping used throughout `topicNames`/`otelTopic`.
 *
 * ```typescript no_run
 * import { encodeSegment } from 'internal:opentelemetry/common';
 *
 * encodeSegment('my:service');  // 'my%3Aservice'
 * ```
 */
export function encodeSegment(value: unknown): string {
  return encodeURIComponent(String(value));
}
/**
 * Validates and trims a required name string, throwing when it is blank.
 *
 * Coerces the value to a string, trims surrounding whitespace, and throws a
 * `TypeError` naming `kind` if the result is empty. Used to guarantee scopes and
 * instruments always carry a usable name.
 *
 * ```typescript no_run
 * import { requireNonEmptyName } from 'internal:opentelemetry/common';
 *
 * requireNonEmptyName('scope', '  db  ');  // 'db'
 * requireNonEmptyName('scope', '   ');     // throws TypeError
 * ```
 */
export function requireNonEmptyName(kind: string, value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new TypeError(`${kind} name must be a non-empty string`);
  return name;
}
/**
 * Renders a scope as a topic segment, appending `@version` when a version is present.
 *
 * Both name and version are percent-encoded via `encodeSegment`. A versionless
 * scope yields just the encoded name. This is the versioned form used inside
 * `otelTopic`; `topicNames` emits both the bare and versioned forms.
 *
 * ```typescript no_run
 * import { scopeSegment } from 'internal:opentelemetry/common';
 *
 * scopeSegment({ name: 'db', version: '2.1.0' });  // 'db@2.1.0'
 * scopeSegment({ name: 'db' });                    // 'db'
 * ```
 */
export function scopeSegment(scope: ScopeInfo): string {
  const name = encodeSegment(scope.name);
  return scope.version ? `${name}@${encodeSegment(scope.version)}` : name;
}
/**
 * Builds a validated `ScopeInfo`, omitting empty optional fields and copying attributes.
 *
 * The name is run through `requireNonEmptyName` (throwing a `TypeError` when
 * blank). Falsy `version`, `schemaUrl`, `attributes`, and `droppedAttributesCount`
 * are left off the result entirely rather than set to `undefined`, and the
 * attributes object is shallow-copied so later mutation of the caller's map does
 * not leak in.
 *
 * ```typescript no_run
 * import { normalizeScope } from 'internal:opentelemetry/common';
 *
 * const scope = normalizeScope('my-app/db', '2.1.0');
 * // { name: 'my-app/db', version: '2.1.0' }
 * ```
 */
export function normalizeScope(
  name: string,
  version?: string,
  schemaUrl?: string | null,
  attributes?: Attributes,
  droppedAttributesCount?: number,
): ScopeInfo {
  return {
    name: requireNonEmptyName('scope', name),
    ...(version ? { version } : {}),
    ...(schemaUrl ? { schemaUrl } : {}),
    ...(attributes ? { attributes: { ...attributes } } : {}),
    ...(droppedAttributesCount ? { droppedAttributesCount } : {}),
  };
}
/**
 * Computes the set of topic names a scoped signal should be published to.
 *
 * Always includes the bare `otel:<signal>:<name>` form; when the scope has a
 * version it also includes the `otel:<signal>:<name>@<version>` form, so both
 * version-agnostic and version-pinned subscribers receive the event. Any
 * `suffixes` are appended as a single `:`-joined, encoded segment. `publishScoped`
 * fans a payload out across exactly this list.
 *
 * ```typescript no_run
 * import { topicNames } from 'internal:opentelemetry/common';
 *
 * topicNames('trace', { name: 'db', version: '2.1.0' }, 'start');
 * // ['otel:trace:db:start', 'otel:trace:db@2.1.0:start']
 * ```
 */
export function topicNames(signal: string, scope: ScopeInfo, ...suffixes: string[]): string[] {
  const names = [`otel:${signal}:${encodeSegment(scope.name)}`];
  if (scope.version) names.push(`otel:${signal}:${scopeSegment(scope)}`);
  const out: string[] = [];
  for (const name of names) {
    if (suffixes.length === 0) {
      out.push(name);
    } else {
      out.push(`${name}:${suffixes.map(encodeSegment).join(':')}`);
    }
  }
  return out;
}
/**
 * Publishes one payload to every topic name that `topicNames` derives for a scope.
 *
 * Delivers the same payload to both the bare and versioned topic forms so
 * subscribers at either granularity see it. Publication is synchronous through
 * the topic bus.
 *
 * ```typescript no_run
 * import { publishScoped } from 'internal:opentelemetry/common';
 *
 * publishScoped('trace', { name: 'db', version: '2.1.0' }, ['start'], {
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 * });
 * ```
 */
export function publishScoped<TPayload>(
  signal: SignalName,
  scope: ScopeInfo,
  suffixes: string[],
  payload: TPayload,
): void {
  for (const name of topicNames(signal, scope, ...suffixes)) {
    topic<TPayload>(name).publish(payload);
  }
}
/**
 * Decodes a hex string into a fixed-size byte array, left-padding or truncating to fit.
 *
 * Always returns exactly `size` bytes: shorter input is zero-padded on the left,
 * longer input is truncated, and any non-hex pair decodes to `0` rather than
 * throwing. Useful for turning a trace/span ID into its binary form for
 * comparison with `bytesEqual`.
 *
 * ```typescript no_run
 * import { hexToBytes } from 'internal:opentelemetry/common';
 *
 * hexToBytes('0001', 2);  // Uint8Array [0, 1]
 * hexToBytes('1', 2);     // Uint8Array [0, 1]  (left-padded)
 * ```
 */
export function hexToBytes(hex: string, size: number): Uint8Array {
  const value = (hex || '').padStart(size * 2, '0').slice(0, size * 2);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}
/**
 * Compares two byte arrays for equal length and identical contents.
 *
 * Returns `false` immediately when the lengths differ, otherwise compares every
 * byte. This is a plain value comparison, not a constant-time one, so it is not
 * suitable for comparing secrets.
 *
 * ```typescript no_run
 * import { bytesEqual, hexToBytes } from 'internal:opentelemetry/common';
 *
 * bytesEqual(hexToBytes('0001', 2), hexToBytes('0001', 2));  // true
 * ```
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
/**
 * An immutable description of the entity producing telemetry.
 *
 * Holds a copied attribute map plus optional entity references, a schema URL,
 * and a dropped-attribute count. All state is private and every getter returns a
 * defensive copy, so a `Resource` cannot be mutated after construction. Prefer
 * `normalizeResource` to build one with the default SDK attributes merged in.
 *
 * ```typescript no_run
 * import { Resource } from 'internal:opentelemetry/common';
 *
 * const resource = new Resource(
 *   { 'service.name': 'checkout', 'service.version': '4.2.0' },
 *   { schemaUrl: 'https://opentelemetry.io/schemas/1.24.0' },
 * );
 * resource.attributes['service.name'];  // 'checkout'
 * ```
 */
export class Resource {
  /**
   * #attributes member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Resource.#attributes';
   * ```
   */
  #attributes: Attributes;
  /**
   * #droppedAttributesCount member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Resource.#droppedAttributesCount';
   * ```
   */
  #droppedAttributesCount: number;
  /**
   * #entityRefs member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Resource.#entityRefs';
   * ```
   */
  #entityRefs: Array<{
    schemaUrl?: string;
    type?: string;
    idKeys: string[];
  }>;
  /**
   * #schemaUrl member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Resource.#schemaUrl';
   * ```
   */
  #schemaUrl: string | null;
  /**
   * Builds a resource from an attribute map and optional secondary options.
   *
   * The attributes are shallow-copied, `entityRefs` are deep-copied with their
   * `idKeys` normalized to arrays, and a missing `schemaUrl` becomes `null`. Both
   * arguments default to empty, so `new Resource()` yields an attribute-free
   * resource.
   *
   * ```typescript no_run
   * const resource = new Resource({ 'service.name': 'api' });
   * ```
   */
  constructor(attributes: Attributes = {}, options: ResourceOptions = {}) {
    this.#attributes = { ...attributes };
    this.#droppedAttributesCount = options.droppedAttributesCount || 0;
    this.#entityRefs = Array.isArray(options.entityRefs)
      ? options.entityRefs.map((ref) => ({
          ...(ref.schemaUrl ? { schemaUrl: ref.schemaUrl } : {}),
          ...(ref.type ? { type: ref.type } : {}),
          idKeys: Array.isArray(ref.idKeys) ? [...ref.idKeys] : [],
        }))
      : [];
    this.#schemaUrl = options.schemaUrl || null;
  }
  /**
   * A fresh shallow copy of the resource's attributes.
   *
   * Mutating the returned object never affects the resource; read the value each
   * time you need it.
   *
   * ```typescript no_run
   * const resource = new Resource({ 'service.name': 'api' });
   * resource.attributes['service.name'];  // 'api'
   * ```
   */
  get attributes(): Attributes {
    return { ...this.#attributes };
  }
  /**
   * The number of attributes dropped before this resource was constructed, or `0`.
   *
   * ```typescript no_run
   * new Resource({}, { droppedAttributesCount: 3 }).droppedAttributesCount;  // 3
   * ```
   */
  get droppedAttributesCount(): number {
    return this.#droppedAttributesCount;
  }
  /**
   * A deep copy of the resource's entity references.
   *
   * Each returned entry carries its own fresh `idKeys` array, so the internal
   * state stays immutable. Empty when no entity references were supplied.
   *
   * ```typescript no_run
   * const resource = new Resource({}, {
   *   entityRefs: [{ type: 'service', idKeys: ['service.name'] }],
   * });
   * resource.entityRefs[0].type;  // 'service'
   * ```
   */
  get entityRefs(): Array<{
    schemaUrl?: string;
    type?: string;
    idKeys: string[];
  }> {
    return this.#entityRefs.map((ref) => ({
      ...(ref.schemaUrl ? { schemaUrl: ref.schemaUrl } : {}),
      ...(ref.type ? { type: ref.type } : {}),
      idKeys: [...ref.idKeys],
    }));
  }
  /**
   * The semantic-convention schema URL for this resource, or `null` if none was set.
   *
   * ```typescript no_run
   * new Resource({}, { schemaUrl: 'https://opentelemetry.io/schemas/1.24.0' }).schemaUrl;
   * ```
   */
  get schemaUrl(): string | null {
    return this.#schemaUrl;
  }
}
/**
 * Coerces any resource-ish input into a `Resource` with the default SDK attributes merged in.
 *
 * Accepts an existing `Resource`, a plain attribute map, or `null`/`undefined`.
 * The result always includes the defaults (`service.name` = `unknown_service`,
 * `telemetry.sdk.name` = `fino`, `telemetry.sdk.language` = `javascript`), with
 * the caller's attributes taking precedence. When passed a `Resource`, its
 * dropped-count, entity refs, and schema URL are preserved.
 *
 * ```typescript no_run
 * import { normalizeResource } from 'internal:opentelemetry/common';
 *
 * const resource = normalizeResource({ 'service.name': 'checkout' });
 * resource.attributes['telemetry.sdk.name'];  // 'fino'
 * ```
 */
export function normalizeResource(resource?: Resource | Attributes | null): Resource {
  if (resource instanceof Resource) {
    return new Resource(
      {
        ...DEFAULT_RESOURCE_ATTRIBUTES,
        ...resource.attributes,
      },
      {
        droppedAttributesCount: resource.droppedAttributesCount,
        entityRefs: resource.entityRefs,
        schemaUrl: resource.schemaUrl,
      },
    );
  }
  return new Resource({
    ...DEFAULT_RESOURCE_ATTRIBUTES,
    ...(resource || {}),
  });
}
/**
 * Shallow-merges two attribute maps into a new object, with the second winning on key conflicts.
 *
 * Either argument may be omitted; the result is always a fresh object, so
 * neither input is mutated. Keys present in `b` override the same keys in `a`.
 *
 * ```typescript no_run
 * import { mergeAttributes } from 'internal:opentelemetry/common';
 *
 * mergeAttributes({ a: 1, b: 2 }, { b: 3 });  // { a: 1, b: 3 }
 * ```
 */
export function mergeAttributes(a?: Attributes, b?: Attributes): Attributes {
  return {
    ...(a || {}),
    ...(b || {}),
  };
}
/**
 * An immutable W3C baggage set — string key/value pairs that propagate alongside trace context.
 *
 * Every mutating operation (`set`, `delete`) returns a new `Baggage` rather than
 * modifying the receiver, so instances are safe to share across async scopes.
 * `toString` produces a spec-compliant `baggage` header value and
 * `Baggage.fromString` parses one back.
 *
 * W3C Baggage: https://www.w3.org/TR/baggage/
 *
 * ```typescript no_run
 * import { Baggage } from 'internal:opentelemetry/common';
 *
 * const baggage = new Baggage({ tenant: 'acme' }).set('region', 'us');
 * baggage.get('tenant');   // 'acme'
 * baggage.toString();      // 'tenant=acme,region=us'
 * ```
 */
export class Baggage {
  /**
   * #entries member on Baggage.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Baggage.#entries';
   * ```
   */
  #entries: Map<string, string>;
  /**
   * Creates a baggage set from an initial record of entries, defaulting to empty.
   *
   * ```typescript no_run
   * const baggage = new Baggage({ tenant: 'acme' });
   * ```
   */
  constructor(entries: Record<string, string> = {}) {
    this.#entries = new Map(Object.entries(entries));
  }
  /**
   * Returns the value for a key, or `undefined` when the key is absent.
   *
   * ```typescript no_run
   * new Baggage({ tenant: 'acme' }).get('tenant');  // 'acme'
   * ```
   */
  get(key: string): string | undefined {
    return this.#entries.get(key);
  }
  /**
   * Returns a new baggage with the key set to the given value, leaving the receiver unchanged.
   *
   * ```typescript no_run
   * const base = new Baggage({ tenant: 'acme' });
   * const next = base.set('region', 'us');  // base still has only tenant
   * ```
   */
  set(key: string, value: string): Baggage {
    const next = new Baggage(Object.fromEntries(this.#entries));
    next.#entries.set(key, value);
    return next;
  }
  /**
   * Returns a new baggage without the given key, leaving the receiver unchanged.
   *
   * Deleting an absent key is a no-op that still returns a fresh copy.
   *
   * ```typescript no_run
   * new Baggage({ tenant: 'acme', region: 'us' }).delete('region');
   * ```
   */
  delete(key: string): Baggage {
    const next = new Baggage(Object.fromEntries(this.#entries));
    next.#entries.delete(key);
    return next;
  }
  /**
   * Returns an iterator over the `[key, value]` pairs in insertion order.
   *
   * ```typescript no_run
   * for (const [key, value] of new Baggage({ tenant: 'acme' }).entries()) {
   *   console.log(key, value);
   * }
   * ```
   */
  entries() {
    return this.#entries.entries();
  }
  /**
   * Serializes the baggage to a W3C `baggage` header value.
   *
   * Keys and values are percent-encoded and joined with commas. An empty baggage
   * serializes to the empty string.
   *
   * ```typescript no_run
   * new Baggage({ tenant: 'acme', region: 'us' }).toString();  // 'tenant=acme,region=us'
   * ```
   */
  toString(): string {
    return [...this.#entries.entries()]
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join(',');
  }
  /**
   * True when the baggage contains no entries.
   *
   * ```typescript no_run
   * new Baggage().isEmpty(); // true
   * ```
   */
  isEmpty(): boolean {
    return this.#entries.size === 0;
  }
  /**
   * Parses a W3C baggage header into an immutable `Baggage` value.
   *
   * Empty, `null`, or `undefined` input returns an empty baggage object. Invalid
   * comma segments without `=` are ignored, and duplicate decoded keys keep the
   * last parsed value.
   *
   * ```typescript no_run
   * const baggage = Baggage.fromString('tenant=acme,region=us');
   * ```
   */
  static fromString(text: string | null | undefined): Baggage {
    if (!text) return new Baggage();
    const entries: Record<string, string> = {};
    for (const part of text.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = decodeURIComponent(trimmed.slice(0, index));
      const value = decodeURIComponent(trimmed.slice(index + 1));
      entries[key] = value;
    }
    return new Baggage(entries);
  }
}
/**
 * Base class for text-map propagators — the no-op default that subclasses override.
 *
 * On its own, `inject` does nothing and `extract` always returns `null`, so the
 * base class is a safe null-object when no propagation format is configured.
 * `W3CTraceContextPropagator` is the concrete implementation. Both methods accept
 * an optional `CarrierApi` so a subclass can work with non-object carriers.
 *
 * ```typescript no_run
 * import { TextMapPropagator } from 'internal:opentelemetry/common';
 *
 * class NoopPropagator extends TextMapPropagator {}
 * new NoopPropagator().extract({});  // null
 * ```
 */
export class TextMapPropagator {
  /**
   * Injects trace context into a carrier.
   *
   * The base propagator is a no-op for subclasses to override. It accepts a
   * custom carrier API for non-object carriers and never throws for missing
   * context.
   *
   * ```typescript no_run
   * new TextMapPropagator().inject({}, null);
   * ```
   */
  inject<TCarrier = CarrierLike>(
    _carrier: TCarrier,
    _context: TraceContext | null | undefined,
    _carrierApi?: CarrierApi<TCarrier>,
  ): void {}
  /**
   * Extracts trace context from a carrier.
   *
   * The base propagator cannot decode any format and always returns `null`.
   * Subclasses return a `TraceContext` only when required carrier fields are
   * present and valid.
   *
   * ```typescript no_run
   * const context = new TextMapPropagator().extract({});
   * ```
   */
  extract<TCarrier = CarrierLike>(
    _carrier: TCarrier,
    _carrierApi?: CarrierApi<TCarrier>,
  ): TraceContext | null {
    return null;
  }
}
/**
 * Picks a `CarrierApi` for a carrier by sniffing whether it exposes `get`/`set` methods.
 *
 * When the carrier has both `get` and `set` functions (as `Headers` or a `Map`
 * does), the returned API routes through them and reads keys via `keys()` if
 * available. Otherwise it treats the carrier as a plain record, using property
 * access and `Object.keys`. Callers usually reach this through `carrierApiFor`.
 *
 * ```typescript no_run
 * import { defaultCarrierApiFor } from 'internal:opentelemetry/common';
 *
 * const api = defaultCarrierApiFor(new Headers());
 * api.set(new Headers(), 'traceparent', '00-...-01');
 * ```
 */
export function defaultCarrierApiFor<TCarrier extends CarrierLike>(
  carrier: TCarrier,
): CarrierApi<TCarrier> {
  if (carrier && typeof carrier.get === 'function' && typeof carrier.set === 'function') {
    return {
      get(target, key) {
        return target.get!(key);
      },
      set(target, key, value) {
        target.set!(key, value);
      },
      keys(target) {
        if (typeof target.keys === 'function') return [...target.keys()];
        return [];
      },
    };
  }
  return {
    get(target, key) {
      return readCarrierValue(target, key);
    },
    set(target, key, value) {
      writeCarrierValue(target, key, value);
    },
    keys(target) {
      return Object.keys((target as object | null | undefined) || {});
    },
  };
}
/**
 * Returns the caller-supplied `CarrierApi` if given, otherwise derives one with `defaultCarrierApiFor`.
 *
 * This is the entry point propagators use so an explicit strategy always wins
 * over the sniffed default. Passing a custom API lets you propagate through a
 * carrier that does not match `CarrierLike`.
 *
 * ```typescript no_run
 * import { carrierApiFor } from 'internal:opentelemetry/common';
 *
 * const api = carrierApiFor({} as Record<string, unknown>);
 * ```
 */
export function carrierApiFor<TCarrier>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>,
): CarrierApi<TCarrier> {
  return carrierApi || (defaultCarrierApiFor(carrier as CarrierLike) as CarrierApi<TCarrier>);
}
/**
 * Copies every key/value from a carrier into a plain record.
 *
 * Iterates the carrier's keys through its `CarrierApi` and materializes them as
 * an ordinary object — useful for capturing a `Headers` instance as a plain
 * snapshot (for example the `injectedHeaders` on a `SpanRecord`).
 *
 * ```typescript no_run
 * import { snapshotCarrier } from 'internal:opentelemetry/common';
 *
 * const headers = new Headers({ traceparent: '00-...-01' });
 * const plain = snapshotCarrier(headers);  // { traceparent: '00-...-01' }
 * ```
 */
export function snapshotCarrier<TCarrier extends CarrierLike>(
  carrier: TCarrier,
  carrierApi?: CarrierApi<TCarrier>,
): Record<string, unknown> {
  const api = carrierApiFor(carrier, carrierApi);
  const out: Record<string, unknown> = {};
  for (const key of api.keys(carrier)) {
    out[key] = api.get(carrier, key);
  }
  return out;
}
const activeTelemetryContext = new Context<ActiveTelemetryContext>('otel:active-telemetry-context');
const activeBaggageContext = new Context<Baggage>('otel:active-baggage');
let activeSpanContextGetter: () => TraceContext | null = () => null;
let _globalPropagator: TextMapPropagator | null = null;
/**
 * Installs the callback that resolves the currently active span's trace context.
 *
 * The trace SDK registers a getter here so that `Propagation.inject` (called
 * without an explicit context) can read the active span without this module
 * depending on the tracer. Registering again replaces the previous getter; until
 * one is set the default returns `null`.
 *
 * ```typescript no_run
 * import { registerActiveSpanContextGetter } from 'internal:opentelemetry/common';
 *
 * registerActiveSpanContextGetter(() => currentSpan()?.spanContext() ?? null);
 * ```
 */
export function registerActiveSpanContextGetter(getter: () => TraceContext | null): void {
  activeSpanContextGetter = getter;
}
/**
 * Returns the baggage currently in scope, falling back through context stores to an empty set.
 *
 * Prefers the dedicated active-baggage store, then the baggage attached to the
 * active telemetry context, and finally a fresh empty `Baggage`. Always returns
 * a value, so callers never need to null-check.
 *
 * ```typescript no_run
 * import { getActiveBaggage } from 'internal:opentelemetry/common';
 *
 * const tenant = getActiveBaggage().get('tenant');
 * ```
 */
export function getActiveBaggage(): Baggage {
  return activeBaggageContext.get() || activeTelemetryContext.get()?.baggage || new Baggage();
}
/**
 * Returns the active telemetry context installed by `runWithActiveContext`, or `undefined`.
 *
 * `undefined` means no context has been made active in the current async scope —
 * typically outside any instrumented request handler.
 *
 * ```typescript no_run
 * import { currentActiveTelemetryContext } from 'internal:opentelemetry/common';
 *
 * const traceId = currentActiveTelemetryContext()?.traceId;
 * ```
 */
export function currentActiveTelemetryContext(): ActiveTelemetryContext | undefined {
  return activeTelemetryContext.get();
}
/**
 * Runs a function with the given telemetry context installed as active for its async scope.
 *
 * Normalizes the context first: only truthy `traceId`/`spanId`/`traceState` are
 * carried, `traceFlags` defaults to `1` (sampled) when absent, and a plain
 * baggage object is upgraded to a `Baggage`. When the context carries baggage it
 * is also installed in the active-baggage store so `getActiveBaggage` sees it.
 * The function's return value is passed through.
 *
 * ```typescript no_run
 * import { runWithActiveContext } from 'internal:opentelemetry/common';
 *
 * runWithActiveContext(
 *   { traceId: '0'.repeat(31) + '1', spanId: '0'.repeat(15) + '1' },
 *   () => handleRequest(),
 * );
 * ```
 */
export function runWithActiveContext<R>(context: ActiveTelemetryContext, fn: () => R): R {
  const baggage =
    context?.baggage instanceof Baggage
      ? context.baggage
      : context?.baggage
        ? new Baggage(context.baggage)
        : undefined;
  const normalized: ActiveTelemetryContext = {
    ...(context?.traceId ? { traceId: context.traceId } : {}),
    ...(context?.spanId ? { spanId: context.spanId } : {}),
    traceFlags: context?.traceFlags ?? 1,
    ...(context?.traceState ? { traceState: context.traceState } : {}),
    ...(baggage ? { baggage } : {}),
  };
  return activeTelemetryContext.runWithValue(normalized, () =>
    normalized.baggage instanceof Baggage
      ? activeBaggageContext.runWithValue(normalized.baggage, fn)
      : fn(),
  );
}
/**
 * Runs a function with the given baggage active, layering it onto any active telemetry context.
 *
 * When a telemetry context is already active, its baggage is replaced with the
 * supplied set for the duration of the call; otherwise only the active-baggage
 * store is set. Nested calls override outer baggage within their scope. The
 * function's return value is passed through.
 *
 * ```typescript no_run
 * import { runWithBaggage, Baggage, getActiveBaggage } from 'internal:opentelemetry/common';
 *
 * runWithBaggage(new Baggage({ tenant: 'acme' }), () => {
 *   getActiveBaggage().get('tenant');  // 'acme'
 * });
 * ```
 */
export function runWithBaggage<R>(baggage: Baggage, fn: () => R): R {
  const current = activeTelemetryContext.get();
  if (current) {
    return activeTelemetryContext.runWithValue(
      {
        ...current,
        baggage,
      },
      () => activeBaggageContext.runWithValue(baggage, fn),
    );
  }
  return activeBaggageContext.runWithValue(baggage, fn);
}
// Per-request context installation - allows instrumentation to propagate a span
// context into the handler's async execution scope without coupling serve.ts
// to specific OTel types.
const _pendingRequestContexts = new Map<
  string,
  {
    context: ActiveTelemetryContext;
    installedAt: number;
  }
>();
const _PENDING_REQUEST_TTL_MS = 5 * 60 * 1e3;
const _MAX_PENDING_REQUEST_CONTEXTS = 1e4;
/**
 * Stashes a trace context under a request id so a handler can later adopt it.
 *
 * This decouples the point where instrumentation extracts context (on the socket
 * thread) from where the handler runs, without coupling `serve` to OTel types.
 * Retrieve and remove the entry with `consumeRequestContext`. The pending map is
 * bounded: entries older than five minutes are evicted on overflow, and if it is
 * still full the oldest entry is dropped, so an id that is never consumed leaks
 * only transiently.
 *
 * ```typescript no_run
 * import { installRequestContext } from 'internal:opentelemetry/common';
 *
 * installRequestContext('req-1', {
 *   traceId: '0'.repeat(31) + '1',
 *   spanId: '0'.repeat(15) + '1',
 * });
 * ```
 */
export function installRequestContext(requestId: string, context: ActiveTelemetryContext): void {
  // Evict the oldest entry if we hit the cap (O(1) amortized - only scans on overflow).
  if (_pendingRequestContexts.size >= _MAX_PENDING_REQUEST_CONTEXTS) {
    const now = Date.now();
    for (const [id, entry] of _pendingRequestContexts) {
      if (now - entry.installedAt > _PENDING_REQUEST_TTL_MS) {
        _pendingRequestContexts.delete(id);
        if (_pendingRequestContexts.size < _MAX_PENDING_REQUEST_CONTEXTS) break;
      }
    }
    // If still at cap, drop oldest entry.
    if (_pendingRequestContexts.size >= _MAX_PENDING_REQUEST_CONTEXTS) {
      _pendingRequestContexts.delete(_pendingRequestContexts.keys().next().value!);
    }
  }
  _pendingRequestContexts.set(requestId, {
    context,
    installedAt: Date.now(),
  });
}
/**
 * Removes and returns the context previously stashed for a request id, or `null`.
 *
 * The entry is deleted whether or not it existed, so a context can be adopted
 * exactly once. Returns `null` when no context was installed or it was already
 * consumed. Pair with `runWithActiveContext` to activate the result.
 *
 * ```typescript no_run
 * import { consumeRequestContext, runWithActiveContext } from 'internal:opentelemetry/common';
 *
 * const ctx = consumeRequestContext('req-1');
 * if (ctx) runWithActiveContext(ctx, () => handleRequest());
 * ```
 */
export function consumeRequestContext(requestId: string): ActiveTelemetryContext | null {
  const entry = _pendingRequestContexts.get(requestId) ?? null;
  _pendingRequestContexts.delete(requestId);
  return entry?.context ?? null;
}
/**
 * The process-global propagation facade used to inject and extract trace context.
 *
 * `getPropagator` lazily creates a `W3CTraceContextPropagator` on first use, and
 * `setPropagator` swaps in a custom one. `inject` writes the active span's
 * context (from the getter registered via `registerActiveSpanContextGetter`)
 * when no context is passed explicitly, and `extract` reads context off an
 * inbound carrier. Both delegate to the current propagator.
 *
 * ```typescript no_run
 * import { Propagation } from 'internal:opentelemetry/common';
 *
 * const headers = new Headers();
 * Propagation.inject(headers);                 // writes traceparent from active span
 * const incoming = Propagation.extract(headers);
 * ```
 */
export const Propagation = {
  getPropagator(): TextMapPropagator {
    if (_globalPropagator === null) _globalPropagator = new W3CTraceContextPropagator();
    return _globalPropagator;
  },
  setPropagator(propagator: TextMapPropagator): void {
    _globalPropagator = propagator;
  },
  inject<TCarrier = CarrierLike>(
    carrier: TCarrier,
    context?: TraceContext | null,
    carrierApi?: CarrierApi<TCarrier>,
  ): void {
    this.getPropagator().inject(carrier, context || activeSpanContextGetter(), carrierApi);
  },
  extract<TCarrier = CarrierLike>(
    carrier: TCarrier,
    carrierApi?: CarrierApi<TCarrier>,
  ): TraceContext | null {
    return this.getPropagator().extract(carrier, carrierApi);
  },
};
/**
 * Propagator implementing W3C `traceparent`, `tracestate`, and `baggage` headers.
 *
 * This is the default propagator returned by `Propagation.getPropagator`. It
 * injects a version-`00` `traceparent`, adds `tracestate` and `baggage` when
 * present, and on extraction validates the header strictly (rejecting all-zero
 * IDs, the reserved `ff` version, and v00 headers with trailing data) while
 * parsing unknown lowercase versions permissively for forward compatibility.
 *
 * W3C Trace Context: https://www.w3.org/TR/trace-context/
 *
 * ```typescript no_run
 * import { W3CTraceContextPropagator } from 'internal:opentelemetry/common';
 *
 * const propagator = new W3CTraceContextPropagator();
 * const headers = new Headers();
 * propagator.inject(headers, {
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 *   traceFlags: 1,
 * });
 * const context = propagator.extract(headers);
 * ```
 */
export class W3CTraceContextPropagator extends TextMapPropagator {
  /**
   * Writes W3C `traceparent` and optional `tracestate` values into a carrier.
   *
   * Missing `traceId` or `spanId` leaves the carrier untouched. `traceFlags` are
   * masked to one byte and encoded as two lowercase hexadecimal digits.
   *
   * ```typescript no_run
   * new W3CTraceContextPropagator().inject({}, { traceId: '0'.repeat(31) + '1', spanId: '0'.repeat(15) + '1' });
   * ```
   */
  inject<TCarrier = CarrierLike>(
    carrier: TCarrier,
    context: TraceContext | null | undefined,
    carrierApi?: CarrierApi<TCarrier>,
  ): void {
    if (!context?.traceId || !context?.spanId) return;
    const flags = Number(context.traceFlags || 0) & 255;
    const api = carrierApiFor(carrier, carrierApi);
    api.set(
      carrier,
      'traceparent',
      `00-${context.traceId}-${context.spanId}-${flags.toString(16).padStart(2, '0')}`,
    );
    if (context.traceState) api.set(carrier, 'tracestate', String(context.traceState));
    if (context.baggage instanceof Baggage && !context.baggage.isEmpty()) {
      api.set(carrier, 'baggage', context.baggage.toString());
    }
  }
  /**
   * Reads W3C trace context from `traceparent` and optional `tracestate`.
   *
   * Returns `null` for malformed headers, all-zero trace IDs, all-zero span IDs,
   * or v00 headers with trailing data. Unknown versions are parsed
   * permissively for forward compatibility.
   *
   * ```typescript no_run
   * const context = new W3CTraceContextPropagator().extract({ traceparent: '00-00000000000000000000000000000001-0000000000000001-01' });
   * ```
   */
  extract<TCarrier = CarrierLike>(
    carrier: TCarrier,
    carrierApi?: CarrierApi<TCarrier>,
  ): TraceContext | null {
    const api = carrierApiFor(carrier, carrierApi);
    const traceparent = api.get(carrier, 'traceparent');
    if (typeof traceparent !== 'string') return null;
    const trimmed = traceparent.trim();
    // Spec: accept unknown lowercase versions for forward compatibility, but
    // reject the reserved ff version and uppercase hex fields.
    const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/.exec(trimmed);
    if (!match) return null;
    const version = match[1];
    const traceId = match[2];
    const spanId = match[3];
    const flags = match[4];
    if (!traceId || !spanId || !flags) return null;
    if (version === 'ff') return null;
    // Reject all-zeros invalid IDs.
    if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
    // For v00, disallow trailing content.
    if (version === '00' && trimmed.length !== 55) return null;
    const traceState = api.get(carrier, 'tracestate');
    const baggage = api.get(carrier, 'baggage');
    return {
      traceId: traceId.toLowerCase(),
      spanId: spanId.toLowerCase(),
      traceFlags: parseInt(flags, 16) & 255,
      ...(typeof traceState === 'string' && traceState ? { traceState } : {}),
      ...(typeof baggage === 'string' && baggage ? { baggage: Baggage.fromString(baggage) } : {}),
    };
  }
}
/**
 * Shared base for the tracer, meter, and logger providers, holding a normalized `Resource`.
 *
 * Subclasses inherit resource handling for free: the constructor runs the
 * supplied `resource` option through `normalizeResource` so every provider
 * exposes a fully-populated resource (defaults merged in) via the read-only
 * `resource` getter.
 *
 * ```typescript no_run
 * import { BaseProvider } from 'internal:opentelemetry/common';
 *
 * class TracerProvider extends BaseProvider {}
 * const provider = new TracerProvider({ resource: { 'service.name': 'api' } });
 * provider.resource.attributes['service.name'];  // 'api'
 * ```
 */
export class BaseProvider {
  /**
   * #resource member on BaseProvider.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'BaseProvider.#resource';
   * ```
   */
  #resource: Resource;
  /**
   * Normalizes the `resource` option into a `Resource`, defaulting to the SDK resource.
   *
   * ```typescript no_run
   * const provider = new BaseProvider({ resource: { 'service.name': 'api' } });
   * ```
   */
  constructor(options: ProviderOptions = {}) {
    this.#resource = normalizeResource(options.resource);
  }
  /**
   * The normalized resource describing the entity this provider produces telemetry for.
   *
   * ```typescript no_run
   * new BaseProvider().resource.attributes['telemetry.sdk.name'];  // 'fino'
   * ```
   */
  get resource(): Resource {
    return this.#resource;
  }
}
/**
 * Truncates a string attribute value (or the strings inside an array value) to a length limit.
 *
 * A non-positive or non-finite `limit` returns the value unchanged. Strings are
 * clipped to `limit` characters; arrays have their string elements clipped
 * element-wise while non-string elements pass through; all other value types are
 * returned as-is.
 *
 * ```typescript no_run
 * import { truncateAttributeValue } from 'internal:opentelemetry/common';
 *
 * truncateAttributeValue('a very long value', 6);  // 'a very'
 * truncateAttributeValue(['abcdef', 42], 3);        // ['abc', 42]
 * ```
 */
export function truncateAttributeValue(value: unknown, limit: number): unknown {
  if (!Number.isFinite(limit) || limit <= 0) return value;
  if (typeof value === 'string') return value.slice(0, limit);
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v.slice(0, limit) : v));
  return value;
}
/**
 * Applies span-attribute limits, returning the kept attributes and how many were dropped.
 *
 * Keeps the first `attributeCountLimit` entries in insertion order (excess
 * counted in `dropped`) and truncates each kept string value to
 * `attributeValueLengthLimit` via `truncateAttributeValue`. An omitted limit is
 * treated as unlimited for that dimension, so with no limits nothing is dropped.
 *
 * ```typescript no_run
 * import { limitAttributeEntries } from 'internal:opentelemetry/common';
 *
 * const { attrs, dropped } = limitAttributeEntries(
 *   { a: 1, b: 2, c: 3 },
 *   { attributeCountLimit: 2 },
 * );
 * // attrs = { a: 1, b: 2 }, dropped = 1
 * ```
 */
export function limitAttributeEntries(
  attributes: Attributes,
  limits: {
    attributeCountLimit?: number;
    attributeValueLengthLimit?: number;
  },
): {
  attrs: Attributes;
  dropped: number;
} {
  const entries = Object.entries(attributes || {});
  const limit = limits.attributeCountLimit ?? Number.POSITIVE_INFINITY;
  const kept = Number.isFinite(limit) ? entries.slice(0, limit) : entries;
  const out: Attributes = {};
  for (const [key, value] of kept) {
    out[key] = truncateAttributeValue(
      value,
      limits.attributeValueLengthLimit ?? Number.POSITIVE_INFINITY,
    );
  }
  return {
    attrs: out,
    dropped: entries.length - kept.length,
  };
}
/**
 * Builds the single versioned topic name for a scoped signal.
 *
 * Produces `otel:<signal>:<scopeSegment>[:<suffixes>]`, where the scope segment
 * includes `@version` when the scope is versioned and any suffixes are joined
 * with `:`. Unlike `topicNames` this returns exactly one name (the versioned
 * form), which is what publishers and subscribers key on.
 *
 * ```typescript no_run
 * import { otelTopic } from 'internal:opentelemetry/common';
 *
 * otelTopic('trace', { name: 'mysql' }, 'start');  // 'otel:trace:mysql:start'
 * ```
 */
export function otelTopic(signal: string, scope: ScopeInfo, ...suffixes: string[]): string {
  const parts = [`otel:${signal}:${scopeSegment(scope)}`];
  if (suffixes.length > 0) parts.push(suffixes.map(encodeSegment).join(':'));
  return parts.join(':');
}
/**
 * Builds the topic name for a runtime instrumentation event.
 *
 * Produces `otel:runtime:<domain>:<operation>:<phase>` with each part
 * percent-encoded — for example `('http.server', 'request', 'start')`. These are
 * the topics that the runtime publishes network/DNS/TLS lifecycle events on and
 * that the built-in instrumentations subscribe to.
 *
 * ```typescript no_run
 * import { otelRuntimeTopic } from 'internal:opentelemetry/common';
 *
 * otelRuntimeTopic('dns', 'lookup', 'start');  // 'otel:runtime:dns:lookup:start'
 * ```
 */
export function otelRuntimeTopic(domain: string, operation: string, phase: string): string {
  return `otel:runtime:${encodeSegment(domain)}:${encodeSegment(operation)}:${encodeSegment(phase)}`;
}
/**
 * Wraps a runtime event payload with standard envelope fields for publishing.
 *
 * Merges the caller's payload with `schemaVersion` (`OTEL_SCHEMA_VERSION`), the
 * resolved `topic`, a `family` of `'runtime'`, the `domain`/`operation`/`phase`,
 * and a `correlationId` derived from the first present of `requestId`,
 * `lookupId`, `connectId`, `handshakeId`, or `spanId` (else `null`). Payload keys
 * are spread last, so an explicit `topic` or `correlationId` in the payload wins.
 *
 * ```typescript no_run
 * import { otelRuntimeEvent, otelRuntimeTopic } from 'internal:opentelemetry/common';
 * import { topic } from 'internal:opentelemetry/common';
 *
 * const event = otelRuntimeEvent('dns', 'lookup', 'start', {
 *   lookupId: 'dns-1',
 *   hostname: 'example.com',
 * });
 * topic(otelRuntimeTopic('dns', 'lookup', 'start')).publish(event);
 * ```
 */
export function otelRuntimeEvent<TPayload extends Record<string, unknown>>(
  domain: string,
  operation: string,
  phase: string,
  payload: TPayload = {} as TPayload,
): TPayload & {
  schemaVersion: number;
  topic: string;
  family: string;
  domain: string;
  operation: string;
  phase: string;
  correlationId: unknown;
} {
  const topicName = otelRuntimeTopic(domain, operation, phase);
  return {
    schemaVersion: OTEL_SCHEMA_VERSION,
    topic: topicName,
    family: 'runtime',
    domain,
    operation,
    phase,
    correlationId:
      payload.requestId ||
      payload.lookupId ||
      payload.connectId ||
      payload.handshakeId ||
      payload.spanId ||
      null,
    ...payload,
  };
}
