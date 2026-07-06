/**
* OTLP HTTP JSON export and wire-format conversion helpers.
*
* This internal module serializes span, log, and metric records into OTLP/HTTP
* JSON payloads and posts them to collector endpoints. It groups records by
* resource and scope, maps runtime record fields into OTLP signal shapes,
* handles optional request compression, parses partial-success responses, and
* applies retry and timeout options.
*
* The default endpoint is `http://127.0.0.1:4318`, with `/v1/traces`,
* `/v1/logs`, or `/v1/metrics` appended unless a signal-specific endpoint or
* full `/v1/...` endpoint is supplied. Export after shutdown returns failure.
* 4xx responses other than 429 are not retried.
*
* ```typescript no_run
* import { OTLPHttpJsonExporter } from 'internal:opentelemetry/exporters';
*
* const exporter = new OTLPHttpJsonExporter({
*   endpoint: 'http://127.0.0.1:4318',
*   retry: { maxAttempts: 2, initialBackoffMillis: 100 },
* });
* await exporter.exportSpans([]);
* ```
*
* See the OTLP specification:
* https://opentelemetry.io/docs/specs/otlp/
*
* @internal
*/
import { brotliAvailable, compress } from 'fino:compress';
import { Baggage, Resource, nowUnixNano, requireRecord } from './common.ts';
import type { Attributes, ExportResult, ExemplarRecord, LogRecord, MetricRecord, PartialSuccessResult, RetryOptions, ScopeInfo, SpanRecord } from './common.ts';
import { normalizeMetricKind } from './metrics.ts';
import { runWithoutTracerProvider } from './traces.ts';
import { runWithoutLoggerProvider } from './logs.ts';
import { runWithoutMeterProvider } from './metrics.ts';
type OtlpSignal = 'traces' | 'logs' | 'metrics';
type CompressionKind = 'gzip' | 'deflate' | 'br' | null;
type FetchBody = string | ArrayBufferLike;
type OtlpExporterOptions = {
  endpoint?: string;
  endpoints?: {
    traces?: string;
    logs?: string;
    metrics?: string;
  };
  headers?: Record<string, string>;
  timeoutMillis?: number;
  compression?: CompressionKind;
  retry?: RetryOptions;
  onError?: (error: Error) => void;
  onPartialSuccess?: (result: PartialSuccessResult) => void;
  onRequest?: (info: {
    signal: OtlpSignal;
    url: string;
    method: string;
    headers: Record<string, string>;
    contentType: string;
    bodyText?: string;
    bodyBytes?: Uint8Array;
  }) => void;
  onResponse?: (info: {
    signal: OtlpSignal;
    url: string;
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    bodyText: string;
  }) => void;
};
function normalizeOtlpOptions(kind: string, options: OtlpExporterOptions = {}, defaultEndpoint: string) {
  const baseEndpoint = String(options.endpoint || defaultEndpoint);
  const endpoints = requireRecord(`${kind} endpoints`, options.endpoints);
  const signalEndpoints: Record<OtlpSignal, string | undefined> = {
    traces: undefined,
    logs: undefined,
    metrics: undefined
  };
  for (const signal of [
    'traces',
    'logs',
    'metrics'
  ] as const) {
    if (endpoints[signal] == null) continue;
    if (typeof endpoints[signal] !== 'string' || !String(endpoints[signal]).trim()) {
      throw new TypeError(`${kind} endpoint for ${signal} must be a non-empty string`);
    }
    signalEndpoints[signal] = String(endpoints[signal]);
  }
  const headers = requireRecord(`${kind} headers`, options.headers) as Record<string, string>;
  const timeoutMillis = Math.max(0, Number(options.timeoutMillis || 0));
  if (!Number.isFinite(timeoutMillis)) throw new TypeError(`${kind} timeoutMillis must be finite`);
  const compression = options.compression || null;
  if (compression !== null && ![
    'gzip',
    'deflate',
    'br'
  ].includes(compression)) {
    throw new TypeError(`${kind} compression must be one of: gzip, deflate, br`);
  }
  const retry = {
    maxAttempts: Math.max(1, Number(options.retry?.maxAttempts || 1)),
    initialBackoffMillis: Math.max(0, Number(options.retry?.initialBackoffMillis || 0))
  };
  if (!Number.isFinite(retry.maxAttempts) || !Number.isFinite(retry.initialBackoffMillis)) {
    throw new TypeError(`${kind} retry options must be finite`);
  }
  return {
    baseEndpoint,
    signalEndpoints,
    headers,
    timeoutMillis,
    compression,
    retry,
    onError: typeof options.onError === 'function' ? options.onError : null,
    onPartialSuccess: typeof options.onPartialSuccess === 'function' ? options.onPartialSuccess : null,
    onRequest: typeof options.onRequest === 'function' ? options.onRequest : null,
    onResponse: typeof options.onResponse === 'function' ? options.onResponse : null
  };
}
function signalUrl(baseEndpoint: string, signalEndpoints: Record<OtlpSignal, string | undefined>, path: OtlpSignal): string {
  if (signalEndpoints[path]) return signalEndpoints[path]!;
  if (baseEndpoint.endsWith(`/v1/${path}`)) return baseEndpoint;
  if (baseEndpoint.includes('/v1/')) return baseEndpoint;
  return baseEndpoint.replace(/\/$/, '') + `/v1/${path}`;
}
function withoutProviderContexts<R>(fn: () => R): R {
  return runWithoutTracerProvider(() => runWithoutLoggerProvider(() => runWithoutMeterProvider(fn)));
}
function encodeCompressedBody(body: Uint8Array, compression: CompressionKind): {
  body: Uint8Array;
  encoding: CompressionKind;
} {
  if (compression === 'gzip') return {
    body: compress(body, { format: 'gzip' }),
    encoding: 'gzip'
  };
  if (compression === 'deflate') return {
    body: compress(body, { format: 'deflate' }),
    encoding: 'deflate'
  };
  if (compression === 'br' && brotliAvailable) return {
    body: compress(body, { format: 'brotli' }),
    encoding: 'br'
  };
  return {
    body,
    encoding: null
  };
}
function toFetchBody(body: Uint8Array | string): FetchBody {
  if (typeof body === 'string') return body;
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
}
function parsePartialSuccessText(text: string): PartialSuccessResult | null {
  if (!text) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const partial = (parsed.partialSuccess || parsed.partial_success) as Record<string, unknown> | undefined;
  if (!partial) return null;
  return {
    rejectedSpans: Number(partial.rejectedSpans ?? partial.rejected_spans ?? 0),
    rejectedLogs: Number(partial.rejectedLogs ?? partial.rejected_logs ?? 0),
    rejectedDataPoints: Number(partial.rejectedDataPoints ?? partial.rejected_data_points ?? 0),
    errorMessage: String(partial.errorMessage ?? partial.error_message ?? '')
  };
}
function responseHeadersObject(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof response?.headers?.entries !== 'function') return out;
  for (const [key, value] of response.headers.entries()) out[key] = value;
  return out;
}
async function postOtlp(cfg: {
  isShutdown(): boolean;
  baseEndpoint: string;
  signalEndpoints: Record<OtlpSignal, string | undefined>;
  headers: Record<string, string>;
  timeoutMillis: number;
  compression: CompressionKind;
  retry: Required<RetryOptions>;
  onError: ((error: Error) => void) | null;
  onPartialSuccess: ((result: PartialSuccessResult) => void) | null;
  onRequest: OtlpExporterOptions['onRequest'] | null;
  onResponse: OtlpExporterOptions['onResponse'] | null;
}, path: OtlpSignal, rawBody: Uint8Array | string, contentType: string): Promise<ExportResult> {
  if (cfg.isShutdown()) return { code: 'failure' };
  const sourceBody = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody;
  const { body, encoding } = encodeCompressedBody(sourceBody, cfg.compression);
  const requestBody = toFetchBody(encoding ? body : typeof rawBody === 'string' ? rawBody : body);
  const url = signalUrl(cfg.baseEndpoint, cfg.signalEndpoints, path);
  let attempt = 0;
  let backoff = cfg.retry.initialBackoffMillis;
  while (attempt < cfg.retry.maxAttempts) {
    attempt++;
    let signal: AbortSignal | undefined;
    if (cfg.timeoutMillis > 0 && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(cfg.timeoutMillis);
    }
    const requestHeaders = {
      'content-type': contentType,
      ...encoding ? { 'content-encoding': encoding } : {},
      ...cfg.headers
    };
    cfg.onRequest?.({
      signal: path,
      url,
      method: 'POST',
      headers: requestHeaders,
      contentType,
      ...typeof requestBody === 'string' ? { bodyText: requestBody } : { bodyBytes: new Uint8Array(requestBody) }
    });
    let response: Response;
    try {
      response = await withoutProviderContexts(() => {
        const init: RequestInit = {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody as BodyInit,
          ...signal ? { signal } : {}
        };
        return globalThis.fetch(url, init);
      });
    } catch (error) {
      cfg.onError?.(error instanceof Error ? error : new Error(String(error)));
      if (attempt >= cfg.retry.maxAttempts) return { code: 'failure' };
      if (backoff > 0) await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = backoff > 0 ? backoff * 2 : 0;
      continue;
    }
    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      responseText = '';
    }
    cfg.onResponse?.({
      signal: path,
      url,
      status: response.status,
      ok: Boolean(response.ok),
      headers: responseHeadersObject(response),
      bodyText: responseText
    });
    const partialSuccess = response.ok ? parsePartialSuccessText(responseText) : null;
    if (partialSuccess) cfg.onPartialSuccess?.(partialSuccess);
    if (response.ok) return { code: 'success' };
    cfg.onError?.(new Error(`OTLP ${path} export failed with status ${response.status}${responseText ? ` body=${responseText}` : ''}`));
    // 4xx errors (except 429 Too Many Requests) are not retryable.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) return { code: 'failure' };
    if (attempt >= cfg.retry.maxAttempts) return { code: 'failure' };
    // Respect Retry-After header if present (supports seconds and HTTP-date).
    const retryAfterHeader = responseHeadersObject(response)['retry-after'];
    const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
    const waitMs = retryAfterMs != null ? retryAfterMs : backoff;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    backoff = backoff > 0 ? backoff * 2 : 0;
  }
  return { code: 'failure' };
}
function parseRetryAfterHeader(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1e3;
  const date = new Date(value).getTime();
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}
function jsonAnyValue(value: unknown): Record<string, unknown> {
  if (value instanceof Baggage) return { stringValue: value.toString() };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (value instanceof Uint8Array) {
    let binary = '';
    for (let i = 0; i < value.length; i++) binary += String.fromCharCode(value[i]!);
    return { bytesValue: btoa(binary) };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(jsonAnyValue) } };
  if (value && typeof value === 'object') {
    return { kvlistValue: { values: Object.entries(value).map(([key, entry]) => ({
      key,
      value: jsonAnyValue(entry)
    })) } };
  }
  return { stringValue: String(value ?? '') };
}
function jsonAttributes(attributes: Attributes = {}): Array<{
  key: string;
  value: Record<string, unknown>;
}> {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: jsonAnyValue(value)
  }));
}
function jsonResource(resource?: Resource): Record<string, unknown> | undefined {
  if (!(resource instanceof Resource)) return undefined;
  const out: Record<string, unknown> = {};
  const attrs = jsonAttributes(resource.attributes);
  if (attrs.length > 0) out.attributes = attrs;
  if (resource.droppedAttributesCount > 0) out.droppedAttributesCount = resource.droppedAttributesCount;
  if (resource.entityRefs.length > 0) {
    out.entityRefs = resource.entityRefs.map((ref) => ({
      ...ref.schemaUrl ? { schemaUrl: ref.schemaUrl } : {},
      ...ref.type ? { type: ref.type } : {},
      ...ref.idKeys.length > 0 ? { idKeys: ref.idKeys } : {}
    }));
  }
  return out;
}
function jsonScope(scope?: ScopeInfo): Record<string, unknown> | undefined {
  if (!scope) return undefined;
  const out: Record<string, unknown> = { name: scope.name };
  if (scope.version) out.version = scope.version;
  const attrs = jsonAttributes(scope.attributes || {});
  if (attrs.length > 0) out.attributes = attrs;
  if (scope.droppedAttributesCount) out.droppedAttributesCount = scope.droppedAttributesCount;
  return out;
}
function resourceScopeKey(resource: Resource | undefined, scope: ScopeInfo | undefined): string {
  const rAttrs = resource instanceof Resource ? resource.attributes : {};
  const rKey = `${resource?.schemaUrl ?? ''}:${JSON.stringify(Object.entries(rAttrs).sort())}`;
  const sKey = scope ? `${scope.name}@${scope.version ?? ''}:${scope.schemaUrl ?? ''}` : '';
  return `${rKey}|${sKey}`;
}
function groupByResourceAndScopeJson<TRecord extends {
  resource?: Resource;
  scope?: ScopeInfo;
}>(records: TRecord[]): Array<{
  resource: Resource | undefined;
  scope: ScopeInfo | undefined;
  items: TRecord[];
}> {
  const order: string[] = [];
  const map = new Map<string, {
    resource: Resource | undefined;
    scope: ScopeInfo | undefined;
    items: TRecord[];
  }>();
  for (const record of records) {
    const key = resourceScopeKey(record.resource, record.scope);
    let group = map.get(key);
    if (!group) {
      group = {
        resource: record.resource,
        scope: record.scope,
        items: []
      };
      map.set(key, group);
      order.push(key);
    }
    group.items.push(record);
  }
  return order.map((k) => map.get(k)!);
}
function kindNumber(kind?: string): number {
  if (kind === 'server') return 2;
  if (kind === 'client') return 3;
  if (kind === 'producer') return 4;
  if (kind === 'consumer') return 5;
  return 1;
}
function jsonTraceExport(spans: SpanRecord[]): Record<string, unknown> {
  return { resourceSpans: groupByResourceAndScopeJson(spans).map((group) => ({
    ...jsonResource(group.resource) ? { resource: jsonResource(group.resource) } : {},
    ...group.resource?.schemaUrl ? { schemaUrl: group.resource.schemaUrl } : {},
    scopeSpans: [{
      ...jsonScope(group.scope) ? { scope: jsonScope(group.scope) } : {},
      ...group.scope?.schemaUrl ? { schemaUrl: group.scope.schemaUrl } : {},
      spans: group.items.map((span) => ({
        traceId: span.traceId,
        spanId: span.spanId,
        ...span.traceState ? { traceState: span.traceState } : {},
        ...span.parentSpanId ? { parentSpanId: span.parentSpanId } : {},
        name: span.name || '',
        kind: kindNumber(span.kind),
        startTimeUnixNano: String(span.startTimeUnixNano || 0),
        endTimeUnixNano: String(span.endTimeUnixNano || span.startTimeUnixNano || 0),
        ...span.attributes ? { attributes: jsonAttributes(span.attributes) } : {},
        ...span.droppedAttributesCount ? { droppedAttributesCount: span.droppedAttributesCount } : {},
        ...span.events?.length ? { events: span.events.map((event) => ({
          timeUnixNano: String(event.timeUnixNano || span.endTimeUnixNano || span.startTimeUnixNano || 0),
          name: event.name || 'event',
          ...event.attributes ? { attributes: jsonAttributes(event.attributes) } : {},
          ...event.droppedAttributesCount ? { droppedAttributesCount: event.droppedAttributesCount } : {}
        })) } : {},
        ...span.droppedEventsCount ? { droppedEventsCount: span.droppedEventsCount } : {},
        ...span.links?.length ? { links: span.links.map((link) => ({
          traceId: link.traceId,
          spanId: link.spanId,
          ...link.traceState ? { traceState: link.traceState } : {},
          ...link.attributes ? { attributes: jsonAttributes(link.attributes) } : {},
          ...link.droppedAttributesCount ? { droppedAttributesCount: link.droppedAttributesCount } : {},
          ...link.flags ? { flags: link.flags } : {}
        })) } : {},
        ...span.droppedLinksCount ? { droppedLinksCount: span.droppedLinksCount } : {},
        ...span.status ? { status: {
          ...span.status.message ? { message: span.status.message } : {},
          code: normalizeStatus(span.status)
        } } : {},
        flags: span.flags ?? 1
      }))
    }]
  })) };
}
function jsonLogsExport(logs: LogRecord[]): Record<string, unknown> {
  return { resourceLogs: groupByResourceAndScopeJson(logs).map((group) => ({
    ...jsonResource(group.resource) ? { resource: jsonResource(group.resource) } : {},
    ...group.resource?.schemaUrl ? { schemaUrl: group.resource.schemaUrl } : {},
    scopeLogs: [{
      ...jsonScope(group.scope) ? { scope: jsonScope(group.scope) } : {},
      ...group.scope?.schemaUrl ? { schemaUrl: group.scope.schemaUrl } : {},
      logRecords: group.items.map((log) => {
        // OTLP log `flags` carries the W3C trace context flags (bits 0-7).
        // Prefer the explicit `flags` field; fall back to `traceFlags` (W3C sampled bit).
        const flags = log.flags ?? (log.traceFlags !== undefined ? log.traceFlags & 255 : undefined);
        return {
          timeUnixNano: String(log.timeUnixNano || nowUnixNano()),
          observedTimeUnixNano: String(log.observedTimeUnixNano || log.timeUnixNano || nowUnixNano()),
          severityNumber: log.severityNumber || 9,
          severityText: log.severityText || 'INFO',
          body: jsonAnyValue(log.body),
          ...log.attributes ? { attributes: jsonAttributes(log.attributes) } : {},
          ...log.droppedAttributesCount ? { droppedAttributesCount: log.droppedAttributesCount } : {},
          ...flags !== undefined ? { flags } : {},
          ...log.traceId ? { traceId: log.traceId } : {},
          ...log.spanId ? { spanId: log.spanId } : {}
        };
      })
    }]
  })) };
}
function jsonExemplar(exemplar: ExemplarRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (exemplar.filteredAttributes) out.filteredAttributes = jsonAttributes(exemplar.filteredAttributes);
  if (exemplar.timeUnixNano) out.timeUnixNano = String(exemplar.timeUnixNano);
  if (exemplar.spanId) out.spanId = exemplar.spanId;
  if (exemplar.traceId) out.traceId = exemplar.traceId;
  if (typeof exemplar.asInt === 'number') out.asInt = String(exemplar.asInt);
  else if (typeof exemplar.value === 'number' && Number.isInteger(exemplar.value)) out.asInt = String(exemplar.value);
  else out.asDouble = Number(exemplar.asDouble ?? exemplar.value ?? 0);
  return out;
}
function jsonMetric(metric: MetricRecord): Record<string, unknown> {
  const basePoint: Record<string, unknown> = {
    ...metric.attributes ? { attributes: jsonAttributes(metric.attributes) } : {},
    startTimeUnixNano: String(metric.startTimeUnixNano || metric.timeUnixNano || nowUnixNano()),
    timeUnixNano: String(metric.timeUnixNano || nowUnixNano()),
    ...metric.flags ? { flags: metric.flags } : {}
  };
  const kind = String(normalizeMetricKind(metric.aggregationKind || metric.kind || '')).toLowerCase();
  let data: Record<string, unknown>;
  if (kind === 'sum' || kind === 'counter' || kind === 'updowncounter') {
    data = { sum: {
      dataPoints: [{
        ...basePoint,
        ...typeof metric.value === 'number' && Number.isInteger(metric.value) ? { asInt: String(metric.value) } : { asDouble: Number(metric.value || 0) },
        ...metric.exemplars?.length ? { exemplars: metric.exemplars.map(jsonExemplar) } : {}
      }],
      aggregationTemporality: metric.aggregationTemporality || 2,
      isMonotonic: metric.isMonotonic === false ? false : true
    } };
  } else if (kind === 'histogram') {
    data = { histogram: {
      dataPoints: [{
        ...basePoint,
        count: String(metric.count || 0),
        ...typeof metric.sum === 'number' ? { sum: metric.sum } : {},
        ...metric.bucketCounts ? { bucketCounts: metric.bucketCounts.map((v) => String(v)) } : {},
        ...metric.explicitBounds ? { explicitBounds: metric.explicitBounds } : {},
        ...metric.exemplars?.length ? { exemplars: metric.exemplars.map(jsonExemplar) } : {},
        ...typeof metric.min === 'number' ? { min: metric.min } : {},
        ...typeof metric.max === 'number' ? { max: metric.max } : {}
      }],
      aggregationTemporality: metric.aggregationTemporality || 2
    } };
  } else if (kind === 'exponentialhistogram' || kind === 'exponential_histogram') {
    data = { exponentialHistogram: {
      dataPoints: [{
        ...basePoint,
        count: String(metric.count || 0),
        ...metric.scale ? { scale: metric.scale } : {},
        ...metric.zeroCount ? { zeroCount: String(metric.zeroCount) } : {},
        ...typeof metric.sum === 'number' ? { sum: metric.sum } : {},
        ...metric.positive ? { positive: {
          ...metric.positive.offset ? { offset: metric.positive.offset } : {},
          ...metric.positive.bucketCounts ? { bucketCounts: metric.positive.bucketCounts.map((v) => String(v)) } : {}
        } } : {},
        ...metric.negative ? { negative: {
          ...metric.negative.offset ? { offset: metric.negative.offset } : {},
          ...metric.negative.bucketCounts ? { bucketCounts: metric.negative.bucketCounts.map((v) => String(v)) } : {}
        } } : {},
        ...typeof metric.min === 'number' ? { min: metric.min } : {},
        ...typeof metric.max === 'number' ? { max: metric.max } : {},
        ...metric.zeroThreshold ? { zeroThreshold: metric.zeroThreshold } : {},
        ...metric.exemplars?.length ? { exemplars: metric.exemplars.map(jsonExemplar) } : {}
      }],
      aggregationTemporality: metric.aggregationTemporality || 2
    } };
  } else if (kind === 'summary') {
    data = { summary: { dataPoints: [{
      ...basePoint,
      count: String(metric.count || 0),
      sum: Number(metric.sum || 0),
      ...metric.quantileValues ? { quantileValues: metric.quantileValues.map((v) => ({
        quantile: Number(v.quantile || 0),
        value: Number(v.value || 0)
      })) } : {}
    }] } };
  } else {
    data = { gauge: { dataPoints: [{
      ...basePoint,
      ...typeof metric.value === 'number' && Number.isInteger(metric.value) ? { asInt: String(metric.value) } : { asDouble: Number(metric.value || 0) },
      ...metric.exemplars?.length ? { exemplars: metric.exemplars.map(jsonExemplar) } : {}
    }] } };
  }
  return {
    name: metric.name || 'metric',
    ...metric.description ? { description: metric.description } : {},
    ...metric.unit ? { unit: metric.unit } : {},
    ...data,
    ...metric.metadata ? { metadata: jsonAttributes(metric.metadata) } : {}
  };
}
function jsonMetricsExport(metrics: MetricRecord[]): Record<string, unknown> {
  return { resourceMetrics: groupByResourceAndScopeJson(metrics).map((group) => ({
    ...jsonResource(group.resource) ? { resource: jsonResource(group.resource) } : {},
    ...group.resource?.schemaUrl ? { schemaUrl: group.resource.schemaUrl } : {},
    scopeMetrics: [{
      ...jsonScope(group.scope) ? { scope: jsonScope(group.scope) } : {},
      ...group.scope?.schemaUrl ? { schemaUrl: group.scope.schemaUrl } : {},
      metrics: group.items.map(jsonMetric)
    }]
  })) };
}
function normalizeStatus(status: {
  code?: string;
} | null | undefined): number {
  const code = String(status?.code || '').toUpperCase();
  if (code === 'OK') return 1;
  if (code === 'ERROR') return 2;
  return 0;
}
/**
* OTLP/HTTP JSON exporter for spans, logs, and metrics.
*
* Construct one exporter and reuse it for all three signals. Each `export*`
* method serializes its records into the matching OTLP JSON envelope
* (`resourceSpans`, `resourceLogs`, or `resourceMetrics`), groups records that
* share a resource and instrumentation scope so they emit under a single
* `scope*` entry rather than repeated envelopes, optionally compresses the body,
* and POSTs it to the collector.
*
* Every method resolves to an `ExportResult`. Any 2xx response yields
* `{ code: 'success' }` — a partial-success body still counts as success but
* invokes the `onPartialSuccess` callback first with the rejected counts.
* `{ code: 'failure' }` is returned after the exporter is shut down, when the
* request throws, when a non-retryable 4xx (anything but 429) comes back, or
* when the retry budget is exhausted. Methods never throw for transport errors;
* failures surface only through the returned code and the `onError` callback.
* Retries honor a `Retry-After` header (seconds or HTTP-date) when present,
* otherwise they use exponential backoff seeded from `initialBackoffMillis`.
*
* ```typescript no_run
* import { OTLPHttpJsonExporter } from 'internal:opentelemetry/exporters';
*
* const exporter = new OTLPHttpJsonExporter({
*   endpoint: 'http://collector:4318',
*   compression: 'gzip',
*   retry: { maxAttempts: 3, initialBackoffMillis: 200 },
*   onPartialSuccess: (r) => console.warn('collector rejected', r.rejectedSpans),
* });
*
* const result = await exporter.exportSpans(finishedSpans);
* if (result.code === 'failure') {
*   // buffer the batch and retry on the next flush
* }
* await exporter.shutdown();
* ```
*/
export class OTLPHttpJsonExporter {
  /**
  * Base collector URL; the `/v1/{signal}` path is appended unless it already
  * ends in one or a per-signal override applies.
  */
  #baseEndpoint: string;
  /** Per-signal endpoint overrides that, when set, replace the derived URL for that signal. */
  #signalEndpoints: Record<OtlpSignal, string | undefined>;
  /** Extra request headers merged onto every export POST (for auth, tenancy, etc.). */
  #headers: Record<string, string>;
  /** Per-attempt timeout in milliseconds; `0` disables the abort timer. */
  #timeoutMillis: number;
  /** Requested body compression (`gzip`, `deflate`, `br`, or `null`); `br` degrades to none when brotli is unavailable. */
  #compression: CompressionKind;
  /** Normalized retry budget: max attempts (at least 1) and the initial exponential backoff. */
  #retry: Required<RetryOptions>;
  /** Optional callback fired on transport errors and non-2xx responses before deciding whether to retry. */
  #onError: ((error: Error) => void) | null;
  /** Optional callback fired with the rejected counts when a 2xx body reports a partial success. */
  #onPartialSuccess: ((result: PartialSuccessResult) => void) | null;
  /** Optional callback invoked with the outgoing request details before each attempt (useful for logging or debugging). */
  #onRequest: OtlpExporterOptions['onRequest'] | null;
  /** Optional callback invoked with each response's status, headers, and body text after it is read. */
  #onResponse: OtlpExporterOptions['onResponse'] | null;
  /** Set once `shutdown()` runs; after this every export short-circuits to failure. */
  #isShutdown: boolean;
  /**
  * Creates an exporter bound to a collector endpoint and export policy.
  *
  * `options.endpoint` is the base URL (default `http://127.0.0.1:4318`); the
  * signal path (`/v1/traces`, `/v1/logs`, `/v1/metrics`) is appended
  * automatically unless the base already contains `/v1/`, or a per-signal URL is
  * given in `options.endpoints`. `compression` may be `gzip`, `deflate`, or `br`
  * (brotli silently falls back to no compression when unavailable). `retry`
  * bounds the attempts and the initial exponential backoff, and `timeoutMillis`
  * aborts each attempt through `AbortSignal.timeout`. All options are validated
  * and normalized eagerly, so a bad configuration fails here rather than at the
  * first export.
  *
  * Throws `TypeError` if `endpoints` or `headers` are not plain objects, a
  * per-signal endpoint is present but not a non-empty string, `compression` is
  * not one of the supported values, or the `timeoutMillis` / `retry` numbers are
  * non-finite.
  *
  * ```typescript no_run
  * import { OTLPHttpJsonExporter } from 'internal:opentelemetry/exporters';
  *
  * const exporter = new OTLPHttpJsonExporter({
  *   endpoints: { traces: 'http://collector:4318/v1/traces' },
  *   headers: { 'x-api-key': 'secret' },
  *   timeoutMillis: 5000,
  * });
  * ```
  */
  constructor(options: OtlpExporterOptions = {}) {
    const cfg = normalizeOtlpOptions('OTLP HTTP JSON exporter', options, 'http://127.0.0.1:4318');
    this.#baseEndpoint = cfg.baseEndpoint;
    this.#signalEndpoints = cfg.signalEndpoints;
    this.#headers = cfg.headers;
    this.#timeoutMillis = cfg.timeoutMillis;
    this.#compression = cfg.compression;
    this.#retry = cfg.retry;
    this.#onError = cfg.onError;
    this.#onPartialSuccess = cfg.onPartialSuccess;
    this.#onRequest = cfg.onRequest;
    this.#onResponse = cfg.onResponse;
    this.#isShutdown = false;
  }
  /**
  * Serializes an OTLP JSON payload and posts it to the signal endpoint.
  *
  * Returns `{ code: 'success' }` for successful HTTP responses, including
  * partial-success responses after invoking the configured callback. Returns
  * `{ code: 'failure' }` after shutdown, network failure, non-retryable 4xx, or
  * exhausted retry attempts. The outgoing `fetch` runs with the tracer, logger,
  * and meter provider contexts suppressed so the export request never generates
  * telemetry of its own.
  */
  async #post(path: OtlpSignal, payload: Record<string, unknown>): Promise<ExportResult> {
    const body = JSON.stringify(payload);
    return postOtlp({
      isShutdown: () => this.#isShutdown,
      baseEndpoint: this.#baseEndpoint,
      signalEndpoints: this.#signalEndpoints,
      headers: this.#headers,
      timeoutMillis: this.#timeoutMillis,
      compression: this.#compression,
      retry: this.#retry,
      onError: this.#onError,
      onPartialSuccess: this.#onPartialSuccess,
      onRequest: this.#onRequest,
      onResponse: this.#onResponse
    }, path, body, 'application/json');
  }
  /**
  * Serializes finished spans into a `resourceSpans` envelope and posts it to the
  * traces endpoint.
  *
  * Spans are grouped by resource and instrumentation scope, so a mixed batch
  * still produces one request. Passing an empty array sends an envelope with no
  * spans and normally returns success. Resolves to `{ code: 'failure' }` under
  * the failure conditions described on the class.
  *
  * ```typescript no_run
  * import { OTLPHttpJsonExporter } from 'internal:opentelemetry/exporters';
  *
  * const exporter = new OTLPHttpJsonExporter();
  * const result = await exporter.exportSpans(finishedSpans);
  * ```
  */
  async exportSpans(spans: SpanRecord[]): Promise<ExportResult> {
    return this.#post('traces', jsonTraceExport(spans));
  }
  /**
  * Serializes log records into a `resourceLogs` envelope and posts it to the
  * logs endpoint.
  *
  * Missing timestamps default to the current time and `observedTimeUnixNano`
  * falls back to `timeUnixNano`; severity defaults to `INFO` (number 9). When a
  * record omits `flags` but carries `traceFlags`, the low 8 bits of the W3C
  * trace flags are emitted. Grouping and failure semantics match the other
  * signals.
  *
  * ```typescript no_run
  * import { OTLPHttpJsonExporter } from 'internal:opentelemetry/exporters';
  *
  * const exporter = new OTLPHttpJsonExporter();
  * await exporter.exportLogs([{ body: 'request handled', severityText: 'INFO' }]);
  * ```
  */
  async exportLogs(logs: LogRecord[]): Promise<ExportResult> {
    return this.#post('logs', jsonLogsExport(logs));
  }
  /**
  * Serializes metric records into a `resourceMetrics` envelope and posts it to
  * the metrics endpoint.
  *
  * Each record's aggregation kind selects the OTLP data shape — `sum` /
  * `counter` / `updowncounter` become a `sum`, `histogram` and
  * `exponentialhistogram` map to their point types, `summary` to a summary, and
  * anything else to a `gauge`. Integer values are emitted as `asInt` strings and
  * non-integers as `asDouble`. Grouping and failure semantics match the other
  * signals.
  *
  * ```typescript no_run
  * import { OTLPHttpJsonExporter } from 'internal:opentelemetry/exporters';
  *
  * const exporter = new OTLPHttpJsonExporter();
  * await exporter.exportMetrics([
  *   { name: 'requests_total', kind: 'counter', value: 42 },
  * ]);
  * ```
  */
  async exportMetrics(metrics: MetricRecord[]): Promise<ExportResult> {
    return this.#post('metrics', jsonMetricsExport(metrics));
  }
  /**
  * Marks the exporter shut down so every later export resolves to failure.
  *
  * This is idempotent and does not flush or drain in-flight requests — it only
  * flips the guard that `export*` checks before serializing. Call it once the
  * owning provider is tearing down; any export already awaiting a response
  * completes normally.
  *
  * ```typescript no_run
  * import { OTLPHttpJsonExporter } from 'internal:opentelemetry/exporters';
  *
  * const exporter = new OTLPHttpJsonExporter();
  * await exporter.shutdown();
  * const result = await exporter.exportSpans(spans); // { code: 'failure' }
  * ```
  */
  async shutdown(): Promise<void> {
    this.#isShutdown = true;
  }
}
