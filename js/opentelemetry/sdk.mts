import { topic } from '../util/topic.mts';
import {
  Resource,
  TextMapPropagator,
  normalizeResource,
  nowUnixNano,
} from './common.mts';
import type {
  Attributes,
  ExportResult,
  Instrumentation,
  LogRecord,
  MetricRecord,
  MetricTemporality,
  MetricView,
  ObservableMetricRegistration,
  OtelExporter,
  SamplingResult,
  SpanLimits,
  SpanRecord,
} from './common.mts';
import { OTLPHttpJsonExporter } from './exporters.mts';
import { HttpServerInstrumentation, TraceTopicInstrumentation, FetchInstrumentation, DnsInstrumentation, SocketInstrumentation, TlsInstrumentation } from './instrumentations/index.mts';
import { applyLogLimits } from './logs.mts';
import {
  accumulateMetric,
  applyMetricView,
  attributesKey,
  cloneMetric,
  metricInstrumentKey,
  metricSeriesKey,
  zeroMetric,
} from './metrics.mts';
import { AlwaysOnSampler, Sampler, applySpanLimits } from './traces.mts';
import { W3CTraceContextPropagator } from './common.mts';

export class InMemoryExporter {
  #spans: SpanRecord[] = [];
  #logs: LogRecord[] = [];
  #metrics: MetricRecord[] = [];

  async exportSpans(spans: SpanRecord[]): Promise<ExportResult> {
    this.#spans.push(...spans);
    return { code: 'success' };
  }

  async exportLogs(logs: LogRecord[]): Promise<ExportResult> {
    this.#logs.push(...logs);
    return { code: 'success' };
  }

  async exportMetrics(metrics: MetricRecord[]): Promise<ExportResult> {
    this.#metrics.push(...metrics);
    return { code: 'success' };
  }

  getFinishedSpans(): SpanRecord[] {
    return [...this.#spans];
  }

  getFinishedLogs(): LogRecord[] {
    return [...this.#logs];
  }

  getFinishedMetrics(): MetricRecord[] {
    return [...this.#metrics];
  }
}

export class SpanProcessor {
  onStart(_span: SpanRecord): void {}
  onEnd(_span: SpanRecord): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export class LogRecordProcessor {
  onEmit(_log: LogRecord): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export class MetricReader {
  #temporality: MetricTemporality;

  constructor(options: { temporality?: MetricTemporality } = {}) {
    this.#temporality = options.temporality || 'cumulative';
  }

  get temporality(): MetricTemporality {
    return this.#temporality;
  }

  record(_metric: MetricRecord): void {}
  receive(_metrics: MetricRecord[]): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export class ManualMetricReader extends MetricReader {
  #batch: MetricRecord[] = [];
  #lastSeen: MetricRecord[] = [];

  receive(metrics: MetricRecord[]): void {
    if (metrics.length === 0 && this.temporality === 'delta' && this.#lastSeen.length > 0) {
      this.#batch = this.#lastSeen.map((metric) => zeroMetric(metric));
      return;
    }
    this.#batch = metrics.map((metric) => cloneMetric(metric));
    if (metrics.length > 0) this.#lastSeen = metrics.map((metric) => cloneMetric(metric));
  }

  collect(): MetricRecord[] {
    const out = this.#batch.map((metric) => cloneMetric(metric));
    this.#batch = [];
    return out;
  }
}

export class BatchSpanProcessor extends SpanProcessor {
  #exporter: OtelExporter;
  #queue: SpanRecord[] = [];
  #maxExportBatchSize: number;
  #maxQueueSize: number;
  #scheduledDelayMillis: number;
  #timer: number | null = null;
  #droppedSpanCount = 0;

  constructor(exporter: OtelExporter, options: { maxQueueSize?: number; maxExportBatchSize?: number; scheduledDelayMillis?: number } = {}) {
    super();
    this.#exporter = exporter;
    this.#maxQueueSize = options.maxQueueSize || 2048;
    this.#maxExportBatchSize = options.maxExportBatchSize || 512;
    this.#scheduledDelayMillis = options.scheduledDelayMillis || 0;
  }

  get droppedSpanCount(): number {
    return this.#droppedSpanCount;
  }

  onEnd(span: SpanRecord): void {
    if (this.#queue.length >= this.#maxQueueSize) {
      this.#droppedSpanCount++;
      return;
    }
    this.#queue.push(span);
    if (this.#scheduledDelayMillis > 0 && this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.forceFlush();
      }, this.#scheduledDelayMillis) as unknown as number;
    }
  }

  async forceFlush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#maxExportBatchSize);
      await this.#exporter.exportSpans(batch);
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

export class BatchLogRecordProcessor extends LogRecordProcessor {
  #exporter: OtelExporter;
  #queue: LogRecord[] = [];
  #maxQueueSize: number;
  #maxExportBatchSize: number;
  #scheduledDelayMillis: number;
  #attributeCountLimit: number;
  #attributeValueLengthLimit: number;
  #timer: number | null = null;

  constructor(
    exporter: OtelExporter,
    options: {
      maxQueueSize?: number;
      maxExportBatchSize?: number;
      scheduledDelayMillis?: number;
      attributeCountLimit?: number;
      attributeValueLengthLimit?: number;
    } = {},
  ) {
    super();
    this.#exporter = exporter;
    this.#maxQueueSize = options.maxQueueSize || 2048;
    this.#maxExportBatchSize = options.maxExportBatchSize || 512;
    this.#scheduledDelayMillis = options.scheduledDelayMillis || 0;
    this.#attributeCountLimit = options.attributeCountLimit || Number.POSITIVE_INFINITY;
    this.#attributeValueLengthLimit = options.attributeValueLengthLimit || Number.POSITIVE_INFINITY;
  }

  onEmit(log: LogRecord): void {
    if (this.#queue.length >= this.#maxQueueSize) return;
    this.#queue.push(
      applyLogLimits(log, {
        attributeCountLimit: this.#attributeCountLimit,
        attributeValueLengthLimit: this.#attributeValueLengthLimit,
      }),
    );
    if (this.#scheduledDelayMillis > 0 && this.#timer === null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.forceFlush();
      }, this.#scheduledDelayMillis) as unknown as number;
    }
  }

  async forceFlush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#maxExportBatchSize);
      await this.#exporter.exportLogs(batch);
    }
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

class FanoutExporter implements OtelExporter {
  #exporters: OtelExporter[];

  constructor(exporters: OtelExporter[]) {
    this.#exporters = exporters;
  }

  async #fanout(method: 'exportSpans' | 'exportLogs' | 'exportMetrics', records: SpanRecord[] | LogRecord[] | MetricRecord[]): Promise<ExportResult> {
    const results = await Promise.allSettled(this.#exporters.map((exporter) => exporter?.[method]?.(records as never) || Promise.resolve({ code: 'success' })));
    const failed = results.some((result) => result.status === 'rejected' || result.value?.code === 'failure');
    return { code: failed ? 'failure' : 'success' };
  }

  async exportSpans(spans: SpanRecord[]): Promise<ExportResult> {
    return this.#fanout('exportSpans', spans);
  }

  async exportLogs(logs: LogRecord[]): Promise<ExportResult> {
    return this.#fanout('exportLogs', logs);
  }

  async exportMetrics(metrics: MetricRecord[]): Promise<ExportResult> {
    return this.#fanout('exportMetrics', metrics);
  }
}

export class PeriodicMetricReader extends MetricReader {
  #exporter: OtelExporter;
  #queue: MetricRecord[] = [];
  #intervalMs: number;
  #timer: number | null = null;

  constructor(exporter: OtelExporter, options: { temporality?: MetricTemporality; intervalMs?: number } = {}) {
    super(options);
    this.#exporter = exporter;
    this.#intervalMs = options.intervalMs ?? 60_000;
  }

  /**
   * Called by OtelSDK.start() to wire up a periodic collection cycle.
   * `collectAndFlush` calls back into the SDK to collect accumulated metrics,
   * deliver them via receive(), and then calls forceFlush() to export.
   */
  _startPeriodicCollection(collectAndFlush: () => Promise<void>): void {
    if (this.#intervalMs <= 0 || this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void collectAndFlush();
    }, this.#intervalMs) as unknown as number;
  }

  receive(metrics: MetricRecord[]): void {
    this.#queue.push(...metrics);
  }

  async forceFlush(): Promise<void> {
    if (this.#queue.length === 0) return;
    const batch = this.#queue.splice(0, this.#queue.length);
    await this.#exporter.exportMetrics(batch);
  }

  async shutdown(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.forceFlush();
  }
}

export const PeriodicExportingMetricReader = PeriodicMetricReader;

/** Evaluate a sampler result and return the (possibly attribute-enriched) span, or null if not sampled. */
function applySamplingResult(span: SpanRecord, result: SamplingResult | boolean): SpanRecord | null {
  if (typeof result === 'boolean') return result ? span : null;
  if (!result.sample) return null;
  if (!result.attributes && !result.traceState) return span;
  return {
    ...span,
    ...(result.attributes
      ? { attributes: { ...(span.attributes || {}), ...(result.attributes as Attributes) } }
      : {}),
    ...(result.traceState ? { traceState: result.traceState } : {}),
  };
}

export class OtelSDK {
  #spanProcessors: SpanProcessor[];
  #logRecordProcessors: LogRecordProcessor[];
  #metricReaders: MetricReader[];
  #sampler: Sampler;
  #propagator: TextMapPropagator;
  #instrumentations: Instrumentation[];
  #disposables: Array<{ dispose(): void }> = [];
  #started = false;
  #sampledSpans = new Set<string>();
  #metricAggregates = new Map<string, MetricRecord>();
  #metricDeltaAggregates = new Map<string, MetricRecord>();
  #observableMetrics = new Set<ObservableMetricRegistration>();
  #views: MetricView[];
  #metricCardinalityLimit: number;
  #spanLimits: SpanLimits;
  #resource: Resource | null;

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
  } = {}) {
    const exporters = options.exporters && options.exporters.length > 0 ? options.exporters : [new OTLPHttpJsonExporter()];
    const defaultExporter = exporters.length === 1 ? exporters[0]! : new FanoutExporter(exporters);
    this.#spanProcessors = options.spanProcessors || [new BatchSpanProcessor(defaultExporter)];
    this.#logRecordProcessors = options.logRecordProcessors || [];
    this.#metricReaders = options.metricReaders || [];
    this.#sampler = options.sampler || new AlwaysOnSampler();
    this.#propagator = options.propagator || new W3CTraceContextPropagator();
    this.#instrumentations = options.instrumentations || [];
    this.#views = options.views || [];
    this.#metricCardinalityLimit = options.metricCardinalityLimit || Number.POSITIVE_INFINITY;
    this.#spanLimits = options.spanLimits || {};
    this.#resource = options.resource == null ? null : normalizeResource(options.resource);
  }

  get propagator(): TextMapPropagator {
    return this.#propagator;
  }

  get resource(): Resource | null {
    return this.#resource;
  }

  #withResource<TRecord extends { resource?: Resource }>(record: TRecord): TRecord {
    if (!(this.#resource instanceof Resource)) return record;
    return {
      ...record,
      resource: new Resource({
        ...(record.resource instanceof Resource ? record.resource.attributes : {}),
        ...this.#resource.attributes,
      }, {
        droppedAttributesCount: this.#resource.droppedAttributesCount,
        entityRefs: this.#resource.entityRefs,
        schemaUrl: this.#resource.schemaUrl,
      }),
    };
  }

  start(): this {
    if (this.#started) return this;
    this.#started = true;
    this.#disposables.push(
      topic<MetricRecord>('otel:metric:record').subscribe((metric) => this.recordMetric(metric)),
      topic<LogRecord>('otel:log:record').subscribe((log) => this.recordLog(log)),
      topic<ObservableMetricRegistration>('otel:metric:observable:register').subscribe((registration) => this.#observableMetrics.add(registration)),
      topic<ObservableMetricRegistration>('otel:metric:observable:unregister').subscribe((registration) => this.#observableMetrics.delete(registration)),
    );
    for (const reader of this.#metricReaders) {
      if (reader instanceof PeriodicMetricReader) {
        const sdk = this;
        reader._startPeriodicCollection(async () => {
          // Collect accumulated metrics and deliver to this reader, then export.
          const source = reader.temporality === 'delta' ? sdk.#metricDeltaAggregates : sdk.#metricAggregates;
          const batch = [...source.values()].map((metric) => {
            const copy = cloneMetric(metric);
            copy.aggregationTemporality = reader.temporality === 'delta' ? 1 : 2;
            return copy;
          });
          reader.receive(batch);
          if (reader.temporality === 'delta') sdk.#metricDeltaAggregates.clear();
          await reader.forceFlush();
        });
      }
    }
    for (const instrumentation of this.#instrumentations) {
      const result = instrumentation.enable?.(this);
      if (!result) continue;
      if (typeof (result as { dispose?: () => void }).dispose === 'function') {
        this.#disposables.push(result as { dispose(): void });
      } else if (Array.isArray(result)) {
        for (const item of result) {
          if (item && typeof item.dispose === 'function') this.#disposables.push(item);
        }
      }
    }
    return this;
  }

  recordSpanStart(span: SpanRecord): void {
    const limited = applySpanLimits(this.#withResource(span), this.#spanLimits);
    const samplerResult = this.#sampler.shouldSample(limited);
    const finalSpan = applySamplingResult(limited, samplerResult);
    if (!finalSpan) return;
    this.#sampledSpans.add(span.spanId);
    for (const processor of this.#spanProcessors) processor.onStart?.(finalSpan);
  }

  recordSpan(span: SpanRecord): void {
    if (!this.#sampledSpans.delete(span.spanId)) {
      // Not sampled at start — run sampler now (handles direct recordSpan calls without a prior recordSpanStart).
      const limited = applySpanLimits(this.#withResource(span), this.#spanLimits);
      const samplerResult = this.#sampler.shouldSample(limited);
      const finalSpan = applySamplingResult(limited, samplerResult);
      if (!finalSpan) return;
      for (const processor of this.#spanProcessors) processor.onEnd(finalSpan);
        return;
    }
    const limited = applySpanLimits(this.#withResource(span), this.#spanLimits);
    for (const processor of this.#spanProcessors) processor.onEnd(limited);
  }

  recordLog(log: LogRecord): void {
    const enriched = this.#withResource(log);
    for (const processor of this.#logRecordProcessors) processor.onEmit(enriched);
  }

  recordMetric(metric: MetricRecord): void {
    const prepared = applyMetricView(this.#withResource(metric), this.#views);
    const instrumentKey = metricInstrumentKey(prepared);
    const seenForInstrument = new Set(
      [...this.#metricAggregates.values()]
        .filter((item) => metricInstrumentKey(item) === instrumentKey)
        .map((item) => attributesKey(item.attributes || {})),
    );
    const attrKey = attributesKey(prepared.attributes || {});
    if (!seenForInstrument.has(attrKey) && seenForInstrument.size >= this.#metricCardinalityLimit) return;
    const key = metricSeriesKey(prepared);
    accumulateMetric(this.#metricAggregates, key, prepared);
    accumulateMetric(this.#metricDeltaAggregates, key, prepared);
  }

  async flush(): Promise<void> {
    for (const registration of this.#observableMetrics) {
      let observations;
      try {
        observations = registration.callback?.();
      } catch {
        continue;
      }
      const list = Array.isArray(observations) ? observations : observations == null ? [] : [observations];
      for (const observation of list) {
        this.recordMetric({
          name: registration.name,
          kind: registration.kind,
          unit: registration.unit,
          description: registration.description,
          scope: registration.scope,
          resource: registration.resource,
          value: observation.value,
          attributes: observation.attributes || {},
          timeUnixNano: observation.timeUnixNano || nowUnixNano(),
        });
      }
    }
    for (const reader of this.#metricReaders) {
      const source = reader.temporality === 'delta' ? this.#metricDeltaAggregates : this.#metricAggregates;
      const batch = [...source.values()].map((metric) => {
        const copy = cloneMetric(metric);
        copy.aggregationTemporality = reader.temporality === 'delta' ? 1 : 2;
        return copy;
      });
      reader.receive(batch);
    }
    await Promise.all([
      ...this.#spanProcessors.map((processor) => processor.forceFlush()),
      ...this.#logRecordProcessors.map((processor) => processor.forceFlush()),
      ...this.#metricReaders.map((reader) => reader.forceFlush()),
    ]);
    this.#metricDeltaAggregates.clear();
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await Promise.all([
      ...this.#spanProcessors.map((processor) => processor.shutdown()),
      ...this.#logRecordProcessors.map((processor) => processor.shutdown()),
      ...this.#metricReaders.map((reader) => reader.shutdown()),
    ]);
    for (const disposable of this.#disposables.splice(0, this.#disposables.length)) {
      try {
        disposable.dispose();
      } catch {}
    }
    this.#sampledSpans.clear();
    this.#metricAggregates.clear();
    this.#metricDeltaAggregates.clear();
    this.#started = false;
  }
}

export {
  OTLPHttpJsonExporter,
  HttpServerInstrumentation,
  TraceTopicInstrumentation,
  FetchInstrumentation,
  DnsInstrumentation,
  SocketInstrumentation,
  TlsInstrumentation,
};
