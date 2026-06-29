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
 * Attributes type exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: Attributes = {} as Attributes;
 * ```
 */
export type Attributes = Record<string, unknown>;
/**
 * ScopeInfo type exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ScopeInfo = {} as ScopeInfo;
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
 * SignalName type exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SignalName = {} as SignalName;
 * ```
 */
export type SignalName = 'trace' | 'log' | 'metric';
/**
 * MetricTemporality type exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: MetricTemporality = {} as MetricTemporality;
 * ```
 */
export type MetricTemporality = 'delta' | 'cumulative';
/**
 * MetricAggregationType type exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: MetricAggregationType = {} as MetricAggregationType;
 * ```
 */
export type MetricAggregationType = 'histogram' | 'lastValue' | 'sum';
/**
 * CarrierLike type exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: CarrierLike = {} as CarrierLike;
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
 * CarrierApi interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: CarrierApi = {} as CarrierApi;
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
 * TraceContext interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: TraceContext = {} as TraceContext;
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
 * SpanStatus interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanStatus = {} as SpanStatus;
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
 * SpanLinkContext interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanLinkContext = {} as SpanLinkContext;
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
 * SpanLinkRecord interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanLinkRecord = {} as SpanLinkRecord;
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
 * SpanEventRecord interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanEventRecord = {} as SpanEventRecord;
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
 * SpanRecord interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanRecord = {} as SpanRecord;
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
 * LogRecord interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: LogRecord = {} as LogRecord;
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
 * ExemplarRecord interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ExemplarRecord = {} as ExemplarRecord;
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
 * QuantileValueRecord interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: QuantileValueRecord = {} as QuantileValueRecord;
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
 * ExponentialBuckets interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ExponentialBuckets = {} as ExponentialBuckets;
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
 * MetricExemplarContext interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: MetricExemplarContext = {} as MetricExemplarContext;
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
 * MetricRecord interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: MetricRecord = {} as MetricRecord;
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
 * ObservableMetricObservation interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ObservableMetricObservation = {} as ObservableMetricObservation;
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
 * ObservableMetricRegistration interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ObservableMetricRegistration = {} as ObservableMetricRegistration;
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
 * MetricInstrumentOptions interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: MetricInstrumentOptions = {} as MetricInstrumentOptions;
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
 * MetricView interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: MetricView = {} as MetricView;
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
 * PartialSuccessResult interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: PartialSuccessResult = {} as PartialSuccessResult;
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
 * ExportResult interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ExportResult = {} as ExportResult;
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
 * OtelExporter interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: OtelExporter = {} as OtelExporter;
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
 * OtelSdkLike interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: OtelSdkLike = {} as OtelSdkLike;
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
 * Disposable interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: Disposable = {} as Disposable;
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
 * Instrumentation interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: Instrumentation = {} as Instrumentation;
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
 * RuntimeHttpRequestEvent interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: RuntimeHttpRequestEvent = {} as RuntimeHttpRequestEvent;
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
 * RuntimeDnsEvent interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: RuntimeDnsEvent = {} as RuntimeDnsEvent;
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
 * RuntimeSocketEvent interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: RuntimeSocketEvent = {} as RuntimeSocketEvent;
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
 * RuntimeTlsEvent interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: RuntimeTlsEvent = {} as RuntimeTlsEvent;
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
 * ResourceOptions interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ResourceOptions = {} as ResourceOptions;
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
  entityRefs?: Array<{ schemaUrl?: string; type?: string; idKeys?: string[] }>;
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
 * ProviderOptions interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ProviderOptions = {} as ProviderOptions;
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
 * SpanStartOptions interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanStartOptions = {} as SpanStartOptions;
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
 * SpanEndOptions interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanEndOptions = {} as SpanEndOptions;
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
 * ActiveTelemetryContext interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: ActiveTelemetryContext = {} as ActiveTelemetryContext;
 * ```
 */
export interface ActiveTelemetryContext extends TraceContext {}

/**
 * SamplingResult interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SamplingResult = {} as SamplingResult;
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
 * SpanLimits interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: SpanLimits = {} as SpanLimits;
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
 * RetryOptions interface exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value: RetryOptions = {} as RetryOptions;
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
 * requireRecord function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = requireRecord;
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
 * OTEL_SCHEMA_VERSION const exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value = OTEL_SCHEMA_VERSION;
 * ```
 */
export const OTEL_SCHEMA_VERSION = 1;

/**
 * OTEL_TOPIC_SUFFIXES const exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value = OTEL_TOPIC_SUFFIXES;
 * ```
 */
export const OTEL_TOPIC_SUFFIXES = Object.freeze({
  trace: Object.freeze(['start', 'end', 'error', 'event', 'attribute', 'link', 'status', 'rename']),
  log: Object.freeze(['emit', 'debug', 'info', 'warn', 'error']),
  metric: Object.freeze(['record', 'observe']),
  runtime: Object.freeze(['start', 'end', 'error']),
});

/**
 * nowUnixNano function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = nowUnixNano;
 * ```
 */
export function nowUnixNano(): number {
  return (performance.timeOrigin + performance.now()) * 1_000_000;
}

/**
 * randomHex function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = randomHex;
 * ```
 */
export function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.slice(0, length);
}

/**
 * encodeSegment function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = encodeSegment;
 * ```
 */
export function encodeSegment(value: unknown): string {
  return encodeURIComponent(String(value));
}

/**
 * requireNonEmptyName function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = requireNonEmptyName;
 * ```
 */
export function requireNonEmptyName(kind: string, value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new TypeError(`${kind} name must be a non-empty string`);
  return name;
}

/**
 * scopeSegment function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = scopeSegment;
 * ```
 */
export function scopeSegment(scope: ScopeInfo): string {
  const name = encodeSegment(scope.name);
  return scope.version ? `${name}@${encodeSegment(scope.version)}` : name;
}

/**
 * normalizeScope function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = normalizeScope;
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
 * topicNames function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = topicNames;
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
 * publishScoped function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = publishScoped;
 * ```
 */
export function publishScoped<TPayload>(signal: SignalName, scope: ScopeInfo, suffixes: string[], payload: TPayload): void {
  for (const name of topicNames(signal, scope, ...suffixes)) {
    topic<TPayload>(name).publish(payload);
  }
}

/**
 * hexToBytes function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = hexToBytes;
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
 * bytesEqual function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = bytesEqual;
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
 * Resource class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = Resource;
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
  #entityRefs: Array<{ schemaUrl?: string; type?: string; idKeys: string[] }>;
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
   * constructor member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const instance = new Resource();
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
   * attributes member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const getter = Resource.prototype.attributes;
   * ```
   */
  get attributes(): Attributes {
    return { ...this.#attributes };
  }

  /**
   * droppedAttributesCount member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const getter = Resource.prototype.droppedAttributesCount;
   * ```
   */
  get droppedAttributesCount(): number {
    return this.#droppedAttributesCount;
  }

  /**
   * entityRefs member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const getter = Resource.prototype.entityRefs;
   * ```
   */
  get entityRefs(): Array<{ schemaUrl?: string; type?: string; idKeys: string[] }> {
    return this.#entityRefs.map((ref) => ({
      ...(ref.schemaUrl ? { schemaUrl: ref.schemaUrl } : {}),
      ...(ref.type ? { type: ref.type } : {}),
      idKeys: [...ref.idKeys],
    }));
  }

  /**
   * schemaUrl member on Resource.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const getter = Resource.prototype.schemaUrl;
   * ```
   */
  get schemaUrl(): string | null {
    return this.#schemaUrl;
  }
}

/**
 * normalizeResource function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = normalizeResource;
 * ```
 */
export function normalizeResource(resource?: Resource | Attributes | null): Resource {
  if (resource instanceof Resource) {
    return new Resource(
      { ...DEFAULT_RESOURCE_ATTRIBUTES, ...resource.attributes },
      {
        droppedAttributesCount: resource.droppedAttributesCount,
        entityRefs: resource.entityRefs,
        schemaUrl: resource.schemaUrl,
      },
    );
  }
  return new Resource({ ...DEFAULT_RESOURCE_ATTRIBUTES, ...(resource || {}) });
}

/**
 * mergeAttributes function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = mergeAttributes;
 * ```
 */
export function mergeAttributes(a?: Attributes, b?: Attributes): Attributes {
  return { ...(a || {}), ...(b || {}) };
}

/**
 * Baggage class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = Baggage;
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
   * constructor member on Baggage.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const instance = new Baggage();
   * ```
   */
  constructor(entries: Record<string, string> = {}) {
    this.#entries = new Map(Object.entries(entries));
  }

  /**
   * get member on Baggage.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Baggage.prototype.get;
   * ```
   */
  get(key: string): string | undefined {
    return this.#entries.get(key);
  }

  /**
   * set member on Baggage.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Baggage.prototype.set;
   * ```
   */
  set(key: string, value: string): Baggage {
    const next = new Baggage(Object.fromEntries(this.#entries));
    next.#entries.set(key, value);
    return next;
  }

  /**
   * delete member on Baggage.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Baggage.prototype.delete;
   * ```
   */
  delete(key: string): Baggage {
    const next = new Baggage(Object.fromEntries(this.#entries));
    next.#entries.delete(key);
    return next;
  }

  /**
   * entries member on Baggage.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Baggage.prototype.entries;
   * ```
   */
  entries() {
    return this.#entries.entries();
  }

  /**
   * toString member on Baggage.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Baggage.prototype.toString;
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
 * TextMapPropagator class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = TextMapPropagator;
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
  extract<TCarrier = CarrierLike>(_carrier: TCarrier, _carrierApi?: CarrierApi<TCarrier>): TraceContext | null {
    return null;
  }
}

/**
 * defaultCarrierApiFor function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = defaultCarrierApiFor;
 * ```
 */
export function defaultCarrierApiFor<TCarrier extends CarrierLike>(carrier: TCarrier): CarrierApi<TCarrier> {
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
 * carrierApiFor function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = carrierApiFor;
 * ```
 */
export function carrierApiFor<TCarrier>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): CarrierApi<TCarrier> {
  return carrierApi || (defaultCarrierApiFor(carrier as CarrierLike) as CarrierApi<TCarrier>);
}

/**
 * snapshotCarrier function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = snapshotCarrier;
 * ```
 */
export function snapshotCarrier<TCarrier extends CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): Record<string, unknown> {
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
 * registerActiveSpanContextGetter function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = registerActiveSpanContextGetter;
 * ```
 */
export function registerActiveSpanContextGetter(getter: () => TraceContext | null): void {
  activeSpanContextGetter = getter;
}

/**
 * getActiveBaggage function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = getActiveBaggage;
 * ```
 */
export function getActiveBaggage(): Baggage {
  return activeBaggageContext.get() || activeTelemetryContext.get()?.baggage || new Baggage();
}

/**
 * currentActiveTelemetryContext function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = currentActiveTelemetryContext;
 * ```
 */
export function currentActiveTelemetryContext(): ActiveTelemetryContext | undefined {
  return activeTelemetryContext.get();
}

/**
 * runWithActiveContext function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = runWithActiveContext;
 * ```
 */
export function runWithActiveContext<R>(context: ActiveTelemetryContext, fn: () => R): R {
  const baggage =
    context?.baggage instanceof Baggage ? context.baggage : context?.baggage ? new Baggage(context.baggage) : undefined;
  const normalized: ActiveTelemetryContext = {
    ...(context?.traceId ? { traceId: context.traceId } : {}),
    ...(context?.spanId ? { spanId: context.spanId } : {}),
    traceFlags: context?.traceFlags ?? 1,
    ...(context?.traceState ? { traceState: context.traceState } : {}),
    ...(baggage ? { baggage } : {}),
  };
  return activeTelemetryContext.runWithValue(
    normalized,
    () => (normalized.baggage instanceof Baggage ? activeBaggageContext.runWithValue(normalized.baggage, fn) : fn()),
  );
}

/**
 * runWithBaggage function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = runWithBaggage;
 * ```
 */
export function runWithBaggage<R>(baggage: Baggage, fn: () => R): R {
  const current = activeTelemetryContext.get();
  if (current) {
    return activeTelemetryContext.runWithValue({ ...current, baggage }, () => activeBaggageContext.runWithValue(baggage, fn));
  }
  return activeBaggageContext.runWithValue(baggage, fn);
}

// Per-request context installation - allows instrumentation to propagate a span
// context into the handler's async execution scope without coupling serve.ts
// to specific OTel types.
const _pendingRequestContexts = new Map<string, { context: ActiveTelemetryContext; installedAt: number }>();
const _PENDING_REQUEST_TTL_MS = 5 * 60 * 1_000;
const _MAX_PENDING_REQUEST_CONTEXTS = 10_000;

/**
 * installRequestContext function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = installRequestContext;
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
  _pendingRequestContexts.set(requestId, { context, installedAt: Date.now() });
}

/**
 * consumeRequestContext function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = consumeRequestContext;
 * ```
 */
export function consumeRequestContext(requestId: string): ActiveTelemetryContext | null {
  const entry = _pendingRequestContexts.get(requestId) ?? null;
  _pendingRequestContexts.delete(requestId);
  return entry?.context ?? null;
}

/**
 * Propagation const exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value = Propagation;
 * ```
 */
export const Propagation = {
  /**
   * getPropagator member on Propagation.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Propagation.getPropagator;
   * ```
   */
  getPropagator(): TextMapPropagator {
    if (_globalPropagator === null) _globalPropagator = new W3CTraceContextPropagator();
    return _globalPropagator;
  },
  /**
   * setPropagator member on Propagation.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Propagation.setPropagator;
   * ```
   */
  setPropagator(propagator: TextMapPropagator): void {
    _globalPropagator = propagator;
  },
  /**
   * Injects the active or provided context through the configured propagator.
   *
   * If no explicit context is passed, the registered active-span getter is used.
   * Missing context is tolerated; the default W3C propagator simply leaves the
   * carrier unchanged.
   *
   * ```typescript no_run
   * Propagation.inject({}, { traceId: '0'.repeat(32), spanId: '1'.repeat(16) });
   * ```
   */
  inject<TCarrier = CarrierLike>(
    carrier: TCarrier,
    context?: TraceContext | null,
    carrierApi?: CarrierApi<TCarrier>,
  ): void {
    this.getPropagator().inject(carrier, context || activeSpanContextGetter(), carrierApi);
  },
  /**
   * Extracts context through the configured propagator.
   *
   * Returns `null` when no valid trace context is present. A custom carrier API
   * can be supplied for header maps that do not use object-style reads.
   *
   * ```typescript no_run
   * const context = Propagation.extract({ traceparent: '00-00000000000000000000000000000001-0000000000000001-01' });
   * ```
   */
  extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null {
    return this.getPropagator().extract(carrier, carrierApi);
  },
};

/**
 * W3CTraceContextPropagator class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = W3CTraceContextPropagator;
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
    const flags = Number(context.traceFlags || 0) & 0xff;
    const api = carrierApiFor(carrier, carrierApi);
    api.set(carrier, 'traceparent', `00-${context.traceId}-${context.spanId}-${flags.toString(16).padStart(2, '0')}`);
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
  extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null {
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
      traceFlags: parseInt(flags, 16) & 0xff,
      ...(typeof traceState === 'string' && traceState ? { traceState } : {}),
      ...(typeof baggage === 'string' && baggage ? { baggage: Baggage.fromString(baggage) } : {}),
    };
  }
}

/**
 * BaseProvider class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = BaseProvider;
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
   * constructor member on BaseProvider.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const instance = new BaseProvider();
   * ```
   */
  constructor(options: ProviderOptions = {}) {
    this.#resource = normalizeResource(options.resource);
  }

  /**
   * resource member on BaseProvider.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const getter = BaseProvider.prototype.resource;
   * ```
   */
  get resource(): Resource {
    return this.#resource;
  }
}

/**
 * truncateAttributeValue function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = truncateAttributeValue;
 * ```
 */
export function truncateAttributeValue(value: unknown, limit: number): unknown {
  if (!Number.isFinite(limit) || limit <= 0) return value;
  if (typeof value === 'string') return value.slice(0, limit);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.slice(0, limit) : v));
  return value;
}

/**
 * limitAttributeEntries function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = limitAttributeEntries;
 * ```
 */
export function limitAttributeEntries(
  attributes: Attributes,
  limits: { attributeCountLimit?: number; attributeValueLengthLimit?: number },
): { attrs: Attributes; dropped: number } {
  const entries = Object.entries(attributes || {});
  const limit = limits.attributeCountLimit ?? Number.POSITIVE_INFINITY;
  const kept = Number.isFinite(limit) ? entries.slice(0, limit) : entries;
  const out: Attributes = {};
  for (const [key, value] of kept) {
    out[key] = truncateAttributeValue(value, limits.attributeValueLengthLimit ?? Number.POSITIVE_INFINITY);
  }
  return { attrs: out, dropped: entries.length - kept.length };
}

/**
 * otelTopic function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = otelTopic;
 * ```
 */
export function otelTopic(signal: string, scope: ScopeInfo, ...suffixes: string[]): string {
  const parts = [`otel:${signal}:${scopeSegment(scope)}`];
  if (suffixes.length > 0) parts.push(suffixes.map(encodeSegment).join(':'));
  return parts.join(':');
}

/**
 * otelRuntimeTopic function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = otelRuntimeTopic;
 * ```
 */
export function otelRuntimeTopic(domain: string, operation: string, phase: string): string {
  return `otel:runtime:${encodeSegment(domain)}:${encodeSegment(operation)}:${encodeSegment(phase)}`;
}

/**
 * otelRuntimeEvent function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = otelRuntimeEvent;
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
      payload.requestId || payload.lookupId || payload.connectId || payload.handshakeId || payload.spanId || null,
    ...payload,
  };
}
