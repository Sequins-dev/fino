/**
 * internal/opentelemetry/common — internal runtime module.
 *
 * 
 * @internal
 */

import { Context } from '../../runtime/context.mts';
import { topic } from '../../util/topic.mts';
export { topic } from '../../util/topic.mts';

export type Attributes = Record<string, unknown>;
export type ScopeInfo = {
  name: string;
  version?: string;
  schemaUrl?: string | null;
  attributes?: Attributes;
  droppedAttributesCount?: number;
};
export type SignalName = 'trace' | 'log' | 'metric';
export type MetricTemporality = 'delta' | 'cumulative';
export type MetricAggregationType = 'histogram' | 'lastValue' | 'sum';
export type CarrierLike = {
  [key: string]: unknown;
  get?(key: string): unknown;
  set?(key: string, value: unknown): unknown;
  keys?(): Iterable<string>;
};

export interface CarrierApi<TCarrier = CarrierLike> {
  get(target: TCarrier, key: string): unknown;
  set(target: TCarrier, key: string, value: unknown): void;
  keys(target: TCarrier): string[];
}

function readCarrierValue(carrier: unknown, key: string): unknown {
  const record = carrier as Record<string, unknown> | null | undefined;
  return record?.[key];
}

function writeCarrierValue(carrier: unknown, key: string, value: unknown): void {
  (carrier as Record<string, unknown>)[key] = value;
}

export interface TraceContext {
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  traceState?: string;
  baggage?: Baggage | null;
}

export interface SpanStatus {
  code?: string;
  message?: string;
}

export interface SpanLinkContext {
  traceId: string;
  spanId: string;
  traceState?: string;
  flags?: number;
}

export interface SpanLinkRecord extends SpanLinkContext {
  attributes?: Attributes;
  droppedAttributesCount?: number;
}

export interface SpanEventRecord {
  name: string;
  attributes?: Attributes;
  timeUnixNano?: number;
  droppedAttributesCount?: number;
}

export interface SpanRecord {
  schemaVersion?: number;
  operation?: string;
  name?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  traceState?: string;
  timeUnixNano?: number;
  startTimeUnixNano?: number;
  endTimeUnixNano?: number;
  attributes?: Attributes;
  scope?: ScopeInfo;
  resource?: Resource;
  kind?: string;
  status?: SpanStatus | null;
  events?: SpanEventRecord[];
  links?: SpanLinkRecord[];
  droppedAttributesCount?: number;
  droppedEventsCount?: number;
  droppedLinksCount?: number;
  flags?: number;
  injectedHeaders?: Record<string, unknown>;
}

export interface LogRecord {
  schemaVersion?: number;
  body?: unknown;
  severityText?: string;
  severityNumber?: number;
  timeUnixNano?: number;
  observedTimeUnixNano?: number;
  attributes?: Attributes;
  droppedAttributesCount?: number;
  scope?: ScopeInfo;
  resource?: Resource;
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  baggage?: Baggage | null;
  eventName?: string;
  categoryName?: string;
  flags?: number;
}

export interface ExemplarRecord {
  timeUnixNano?: number;
  traceId?: string;
  spanId?: string;
  value?: number;
  asInt?: number;
  asDouble?: number;
  filteredAttributes?: Attributes;
}

export interface QuantileValueRecord {
  quantile: number;
  value: number;
}

export interface ExponentialBuckets {
  offset?: number;
  bucketCounts?: Array<number | bigint>;
}

export interface MetricExemplarContext {
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
}

export interface MetricRecord {
  schemaVersion?: number;
  name: string;
  value?: number;
  count?: number;
  sum?: number;
  min?: number;
  max?: number;
  unit?: string;
  description?: string;
  kind?: string;
  aggregationKind?: string;
  aggregationTemporality?: number;
  isMonotonic?: boolean;
  attributes?: Attributes;
  metadata?: Attributes;
  scope?: ScopeInfo;
  resource?: Resource;
  timeUnixNano?: number;
  startTimeUnixNano?: number;
  explicitBounds?: number[];
  bucketCounts?: Array<number | bigint>;
  quantileValues?: QuantileValueRecord[];
  exemplars?: ExemplarRecord[];
  flags?: number;
  exemplarContext?: MetricExemplarContext | null;
  scale?: number;
  zeroCount?: number;
  zeroThreshold?: number;
  positive?: ExponentialBuckets;
  negative?: ExponentialBuckets;
}

export interface ObservableMetricObservation {
  value: number;
  attributes?: Attributes;
  timeUnixNano?: number;
}

export interface ObservableMetricRegistration {
  kind: string;
  name: string;
  unit: string;
  description: string;
  scope: ScopeInfo;
  resource: Resource;
  callback: () => ObservableMetricObservation | ObservableMetricObservation[] | null | undefined;
}

export interface MetricInstrumentOptions {
  unit?: string;
  description?: string;
  attributes?: Attributes;
  kind?: string;
}

export interface MetricView {
  instrumentName?: string;
  name?: string;
  description?: string;
  attributeKeys?: string[];
  aggregation?: {
    type: MetricAggregationType;
    boundaries?: number[];
    monotonic?: boolean;
  };
}

export interface PartialSuccessResult {
  rejectedSpans: number;
  rejectedLogs: number;
  rejectedDataPoints: number;
  errorMessage: string;
}

export interface ExportResult {
  code: 'success' | 'failure';
}

export interface OtelExporter {
  exportSpans(spans: SpanRecord[]): Promise<ExportResult>;
  exportLogs(logs: LogRecord[]): Promise<ExportResult>;
  exportMetrics(metrics: MetricRecord[]): Promise<ExportResult>;
  shutdown?(): Promise<void>;
}

export interface OtelSdkLike {
  readonly propagator: TextMapPropagator;
  recordSpanStart(span: SpanRecord): void;
  recordSpan(span: SpanRecord): void;
  recordLog(log: LogRecord): void;
  recordMetric(metric: MetricRecord): void;
}

export interface Disposable {
  dispose(): void;
}

export interface Instrumentation {
  enable(sdk: OtelSdkLike): void | Disposable | Disposable[];
}

export interface RuntimeHttpRequestEvent {
  requestId: string;
  method?: string;
  route?: string;
  url?: string;
  headers?: CarrierLike;
  statusCode?: number;
  error?: unknown;
  timeUnixNano?: number;
  resource?: Resource;
}

export interface RuntimeDnsEvent {
  lookupId: string;
  requestId?: string;
  hop?: number;
  hostname?: string;
  address?: string;
  family?: string | number;
  error?: unknown;
  timeUnixNano?: number;
  resource?: Resource;
}

export interface RuntimeSocketEvent {
  connectId: string;
  requestId?: string;
  hop?: number;
  host?: string;
  port?: number;
  transport?: string;
  error?: unknown;
  timeUnixNano?: number;
  resource?: Resource;
}

export interface RuntimeTlsEvent {
  handshakeId: string;
  requestId?: string;
  hop?: number;
  hostname?: string;
  port?: number;
  protocol?: string;
  error?: unknown;
  timeUnixNano?: number;
  resource?: Resource;
}

export interface ResourceOptions {
  droppedAttributesCount?: number;
  entityRefs?: Array<{ schemaUrl?: string; type?: string; idKeys?: string[] }>;
  schemaUrl?: string | null;
}

export interface ProviderOptions {
  resource?: Resource | Attributes | null;
}

export interface SpanStartOptions {
  traceId?: string;
  parentSpanId?: string | null;
  attributes?: Attributes;
  links?: SpanLinkRecord[];
  kind?: string;
}

export interface SpanEndOptions {
  attributes?: Attributes;
  status?: SpanStatus | null;
}

export interface ActiveTelemetryContext extends TraceContext {}

export interface SamplingResult {
  sample: boolean;
  attributes?: Attributes;
  traceState?: string;
}

export interface SpanLimits {
  attributeCountLimit?: number;
  attributeValueLengthLimit?: number;
  eventCountLimit?: number;
  linkCountLimit?: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  initialBackoffMillis?: number;
}

const DEFAULT_RESOURCE_ATTRIBUTES: Attributes = {
  'service.name': 'unknown_service',
  'telemetry.sdk.name': 'fino',
  'telemetry.sdk.language': 'javascript',
};

export function requireRecord(kind: string, value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${kind} must be an object`);
  }
  return value as Record<string, unknown>;
}

export const OTEL_SCHEMA_VERSION = 1;

export const OTEL_TOPIC_SUFFIXES = Object.freeze({
  trace: Object.freeze(['start', 'end', 'error', 'event', 'attribute', 'link', 'status', 'rename']),
  log: Object.freeze(['emit', 'debug', 'info', 'warn', 'error']),
  metric: Object.freeze(['record', 'observe']),
  runtime: Object.freeze(['start', 'end', 'error']),
});

export function nowUnixNano(): number {
  return (performance.timeOrigin + performance.now()) * 1_000_000;
}

export function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.slice(0, length);
}

export function encodeSegment(value: unknown): string {
  return encodeURIComponent(String(value));
}

export function requireNonEmptyName(kind: string, value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new TypeError(`${kind} name must be a non-empty string`);
  return name;
}

export function scopeSegment(scope: ScopeInfo): string {
  const name = encodeSegment(scope.name);
  return scope.version ? `${name}@${encodeSegment(scope.version)}` : name;
}

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

export function publishScoped<TPayload>(signal: SignalName, scope: ScopeInfo, suffixes: string[], payload: TPayload): void {
  for (const name of topicNames(signal, scope, ...suffixes)) {
    topic<TPayload>(name).publish(payload);
  }
}

export function hexToBytes(hex: string, size: number): Uint8Array {
  const value = (hex || '').padStart(size * 2, '0').slice(0, size * 2);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class Resource {
  #attributes: Attributes;
  #droppedAttributesCount: number;
  #entityRefs: Array<{ schemaUrl?: string; type?: string; idKeys: string[] }>;
  #schemaUrl: string | null;

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

  get attributes(): Attributes {
    return { ...this.#attributes };
  }

  get droppedAttributesCount(): number {
    return this.#droppedAttributesCount;
  }

  get entityRefs(): Array<{ schemaUrl?: string; type?: string; idKeys: string[] }> {
    return this.#entityRefs.map((ref) => ({
      ...(ref.schemaUrl ? { schemaUrl: ref.schemaUrl } : {}),
      ...(ref.type ? { type: ref.type } : {}),
      idKeys: [...ref.idKeys],
    }));
  }

  get schemaUrl(): string | null {
    return this.#schemaUrl;
  }
}

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

export function mergeAttributes(a?: Attributes, b?: Attributes): Attributes {
  return { ...(a || {}), ...(b || {}) };
}

export class Baggage {
  #entries: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.#entries = new Map(Object.entries(entries));
  }

  get(key: string): string | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: string): Baggage {
    const next = new Baggage(Object.fromEntries(this.#entries));
    next.#entries.set(key, value);
    return next;
  }

  delete(key: string): Baggage {
    const next = new Baggage(Object.fromEntries(this.#entries));
    next.#entries.delete(key);
    return next;
  }

  entries() {
    return this.#entries.entries();
  }

  toString(): string {
    return [...this.#entries.entries()]
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join(',');
  }

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

export class TextMapPropagator {
  inject<TCarrier = CarrierLike>(
    _carrier: TCarrier,
    _context: TraceContext | null | undefined,
    _carrierApi?: CarrierApi<TCarrier>,
  ): void {}
  extract<TCarrier = CarrierLike>(_carrier: TCarrier, _carrierApi?: CarrierApi<TCarrier>): TraceContext | null {
    return null;
  }
}

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

export function carrierApiFor<TCarrier>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): CarrierApi<TCarrier> {
  return carrierApi || (defaultCarrierApiFor(carrier as CarrierLike) as CarrierApi<TCarrier>);
}

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

export function registerActiveSpanContextGetter(getter: () => TraceContext | null): void {
  activeSpanContextGetter = getter;
}

export function getActiveBaggage(): Baggage {
  return activeBaggageContext.get() || activeTelemetryContext.get()?.baggage || new Baggage();
}

export function currentActiveTelemetryContext(): ActiveTelemetryContext | undefined {
  return activeTelemetryContext.get();
}

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

export function runWithBaggage<R>(baggage: Baggage, fn: () => R): R {
  const current = activeTelemetryContext.get();
  if (current) {
    return activeTelemetryContext.runWithValue({ ...current, baggage }, () => activeBaggageContext.runWithValue(baggage, fn));
  }
  return activeBaggageContext.runWithValue(baggage, fn);
}

// Per-request context installation — allows instrumentation to propagate a span
// context into the handler's async execution scope without coupling serve.mts
// to specific OTel types.
const _pendingRequestContexts = new Map<string, { context: ActiveTelemetryContext; installedAt: number }>();
const _PENDING_REQUEST_TTL_MS = 5 * 60 * 1_000;
const _MAX_PENDING_REQUEST_CONTEXTS = 10_000;

export function installRequestContext(requestId: string, context: ActiveTelemetryContext): void {
  // Evict the oldest entry if we hit the cap (O(1) amortized — only scans on overflow).
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

export function consumeRequestContext(requestId: string): ActiveTelemetryContext | null {
  const entry = _pendingRequestContexts.get(requestId) ?? null;
  _pendingRequestContexts.delete(requestId);
  return entry?.context ?? null;
}

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
  extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null {
    return this.getPropagator().extract(carrier, carrierApi);
  },
};

export class W3CTraceContextPropagator extends TextMapPropagator {
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
  }

  extract<TCarrier = CarrierLike>(carrier: TCarrier, carrierApi?: CarrierApi<TCarrier>): TraceContext | null {
    const api = carrierApiFor(carrier, carrierApi);
    const traceparent = api.get(carrier, 'traceparent');
    if (typeof traceparent !== 'string') return null;
    const trimmed = traceparent.trim();
    // Spec: accept any version (forward-compat).
    // For v00, require exactly 55 chars. For unknown versions, parse permissively.
    const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/i.exec(trimmed);
    if (!match) return null;
    const version = match[1];
    const traceId = match[2];
    const spanId = match[3];
    const flags = match[4];
    if (!traceId || !spanId || !flags) return null;
    // Reject all-zeros invalid IDs.
    if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
    // For v00, disallow trailing content.
    if (version === '00' && trimmed.length !== 55) return null;
    const traceState = api.get(carrier, 'tracestate');
    return {
      traceId: traceId.toLowerCase(),
      spanId: spanId.toLowerCase(),
      traceFlags: parseInt(flags, 16) & 0xff,
      ...(typeof traceState === 'string' && traceState ? { traceState } : {}),
    };
  }
}

export class BaseProvider {
  #resource: Resource;

  constructor(options: ProviderOptions = {}) {
    this.#resource = normalizeResource(options.resource);
  }

  get resource(): Resource {
    return this.#resource;
  }
}

export function truncateAttributeValue(value: unknown, limit: number): unknown {
  if (!Number.isFinite(limit) || limit <= 0) return value;
  if (typeof value === 'string') return value.slice(0, limit);
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.slice(0, limit) : v));
  return value;
}

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

export function otelTopic(signal: string, scope: ScopeInfo, ...suffixes: string[]): string {
  const parts = [`otel:${signal}:${scopeSegment(scope)}`];
  if (suffixes.length > 0) parts.push(suffixes.map(encodeSegment).join(':'));
  return parts.join(':');
}

export function otelRuntimeTopic(domain: string, operation: string, phase: string): string {
  return `otel:runtime:${encodeSegment(domain)}:${encodeSegment(operation)}:${encodeSegment(phase)}`;
}

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
