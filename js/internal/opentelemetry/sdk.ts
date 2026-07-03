/**
* OpenTelemetry SDK wiring for processors, readers, exporters, and runtime instrumentation.
*
* This internal module subscribes to the trace, log, metric, and observable
* registration topics produced by the runtime OpenTelemetry modules. It applies
* sampling, limits, metric views, cardinality limits, resource enrichment, and
* exporter fan-out before delivering records to processors and readers.
*
* By default, the SDK uses an OTLP HTTP JSON exporter, a batch span processor,
* no log processors, no metric readers, an always-on sampler, and a W3C
* propagator. `start()` is idempotent, `flush()` exports queued telemetry and
* collects observables, and `shutdown()` flushes before disposing
* instrumentations and readers.
*
* ```typescript no_run
* const memory = new InMemoryExporter();
* const sdk = new OtelSDK({
*   exporters: [memory],
*   spanProcessors: [new BatchSpanProcessor(memory)],
* }).start();
* await sdk.flush();
* ```
*
* See OpenTelemetry SDK concepts:
* https://opentelemetry.io/docs/concepts/sdk-configuration/
*
* @internal
*/
import { topic } from '../../context/topic.ts';
import { Resource, TextMapPropagator, normalizeResource, nowUnixNano } from './common.ts';
import type { Attributes, ExportResult, Instrumentation, LogRecord, MetricRecord, MetricTemporality, MetricView, ObservableMetricRegistration, OtelExporter, SamplingResult, SpanLimits, SpanRecord } from './common.ts';
import { OTLPHttpJsonExporter } from './exporters.ts';
import { HttpServerInstrumentation, TraceTopicInstrumentation, FetchInstrumentation, DnsInstrumentation, SocketInstrumentation, TlsInstrumentation, JobsInstrumentation } from './instrumentations/index.ts';
import { applyLogLimits } from './logs.ts';
import { accumulateMetric, applyMetricView, attributesKey, cloneMetric, metricInstrumentKey, metricSeriesKey, zeroMetric } from './metrics.ts';
import { AlwaysOnSampler, Sampler, applySpanLimits } from './traces.ts';
import { W3CTraceContextPropagator } from './common.ts';
import { lazy } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
/**
* InMemoryExporter class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = InMemoryExporter;
* ```
*/
export class InMemoryExporter {
  /**
  * #spans member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'InMemoryExporter.#spans';
  * ```
  */
  #spans: SpanRecord[] = [];
  /**
  * #logs member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'InMemoryExporter.#logs';
  * ```
  */
  #logs: LogRecord[] = [];
  /**
  * #metrics member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'InMemoryExporter.#metrics';
  * ```
  */
  #metrics: MetricRecord[] = [];
  /**
  * exportSpans member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = InMemoryExporter.prototype.exportSpans;
  * ```
  */
  async exportSpans(spans: SpanRecord[]): Promise<ExportResult> {
    this.#spans.push(...spans);
    return { code: 'success' };
  }
  /**
  * exportLogs member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = InMemoryExporter.prototype.exportLogs;
  * ```
  */
  async exportLogs(logs: LogRecord[]): Promise<ExportResult> {
    this.#logs.push(...logs);
    return { code: 'success' };
  }
  /**
  * exportMetrics member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = InMemoryExporter.prototype.exportMetrics;
  * ```
  */
  async exportMetrics(metrics: MetricRecord[]): Promise<ExportResult> {
    this.#metrics.push(...metrics);
    return { code: 'success' };
  }
  /**
  * getFinishedSpans member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = InMemoryExporter.prototype.getFinishedSpans;
  * ```
  */
  getFinishedSpans(): SpanRecord[] {
    return [...this.#spans];
  }
  /**
  * getFinishedLogs member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = InMemoryExporter.prototype.getFinishedLogs;
  * ```
  */
  getFinishedLogs(): LogRecord[] {
    return [...this.#logs];
  }
  /**
  * getFinishedMetrics member on InMemoryExporter.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = InMemoryExporter.prototype.getFinishedMetrics;
  * ```
  */
  getFinishedMetrics(): MetricRecord[] {
    return [...this.#metrics];
  }
}
/**
* SpanProcessor class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = SpanProcessor;
* ```
*/
export class SpanProcessor {
  /**
  * onStart member on SpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = SpanProcessor.prototype.onStart;
  * ```
  */
  onStart(_span: SpanRecord): void {}
  /**
  * onEnd member on SpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = SpanProcessor.prototype.onEnd;
  * ```
  */
  onEnd(_span: SpanRecord): void {}
  /**
  * forceFlush member on SpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = SpanProcessor.prototype.forceFlush;
  * ```
  */
  async forceFlush(): Promise<void> {}
  /**
  * shutdown member on SpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = SpanProcessor.prototype.shutdown;
  * ```
  */
  async shutdown(): Promise<void> {}
}
/**
* LogRecordProcessor class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = LogRecordProcessor;
* ```
*/
export class LogRecordProcessor {
  /**
  * onEmit member on LogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = LogRecordProcessor.prototype.onEmit;
  * ```
  */
  onEmit(_log: LogRecord): void {}
  /**
  * forceFlush member on LogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = LogRecordProcessor.prototype.forceFlush;
  * ```
  */
  async forceFlush(): Promise<void> {}
  /**
  * shutdown member on LogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = LogRecordProcessor.prototype.shutdown;
  * ```
  */
  async shutdown(): Promise<void> {}
}
/**
* MetricReader class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = MetricReader;
* ```
*/
export class MetricReader {
  /**
  * #temporality member on MetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'MetricReader.#temporality';
  * ```
  */
  #temporality: MetricTemporality;
  /**
  * constructor member on MetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const instance = new MetricReader();
  * ```
  */
  constructor(options: {
    temporality?: MetricTemporality;
  } = {}) {
    this.#temporality = options.temporality || 'cumulative';
  }
  /**
  * temporality member on MetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const getter = MetricReader.prototype.temporality;
  * ```
  */
  get temporality(): MetricTemporality {
    return this.#temporality;
  }
  /**
  * record member on MetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = MetricReader.prototype.record;
  * ```
  */
  record(_metric: MetricRecord): void {}
  /**
  * receive member on MetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = MetricReader.prototype.receive;
  * ```
  */
  receive(_metrics: MetricRecord[]): void {}
  /**
  * forceFlush member on MetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = MetricReader.prototype.forceFlush;
  * ```
  */
  async forceFlush(): Promise<void> {}
  /**
  * shutdown member on MetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = MetricReader.prototype.shutdown;
  * ```
  */
  async shutdown(): Promise<void> {}
}
/**
* ManualMetricReader class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = ManualMetricReader;
* ```
*/
export class ManualMetricReader extends MetricReader {
  /**
  * #batch member on ManualMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'ManualMetricReader.#batch';
  * ```
  */
  #batch: MetricRecord[] = [];
  /**
  * #lastSeen member on ManualMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'ManualMetricReader.#lastSeen';
  * ```
  */
  #lastSeen: MetricRecord[] = [];
  /**
  * receive member on ManualMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = ManualMetricReader.prototype.receive;
  * ```
  */
  receive(metrics: MetricRecord[]): void {
    if (metrics.length === 0 && this.temporality === 'delta' && this.#lastSeen.length > 0) {
      this.#batch = this.#lastSeen.map((metric) => zeroMetric(metric));
      return;
    }
    this.#batch = metrics.map((metric) => cloneMetric(metric));
    if (metrics.length > 0) this.#lastSeen = metrics.map((metric) => cloneMetric(metric));
  }
  /**
  * collect member on ManualMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = ManualMetricReader.prototype.collect;
  * ```
  */
  collect(): MetricRecord[] {
    const out = this.#batch.map((metric) => cloneMetric(metric));
    this.#batch = [];
    return out;
  }
}
/**
* Create a cold signal that periodically collects a manual metric reader.
*/
export function metricsSignal(reader: ManualMetricReader, options: {
  intervalMs?: number;
} = {}): ReadonlySignal<MetricRecord[]> {
  const intervalMs = options.intervalMs ?? 1000;
  return lazy<MetricRecord[]>([], (set) => {
    const collect = () => {
      const metrics = reader.collect();
      if (metrics.length > 0) set(metrics);
    };
    collect();
    const timer = setInterval(collect, intervalMs);
    return () => clearInterval(timer);
  });
}
/**
* BatchSpanProcessor class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = BatchSpanProcessor;
* ```
*/
export class BatchSpanProcessor extends SpanProcessor {
  /**
  * #exporter member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchSpanProcessor.#exporter';
  * ```
  */
  #exporter: OtelExporter;
  /**
  * #queue member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchSpanProcessor.#queue';
  * ```
  */
  #queue: SpanRecord[] = [];
  /**
  * #maxExportBatchSize member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchSpanProcessor.#maxExportBatchSize';
  * ```
  */
  #maxExportBatchSize: number;
  /**
  * #maxQueueSize member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchSpanProcessor.#maxQueueSize';
  * ```
  */
  #maxQueueSize: number;
  /**
  * #scheduledDelayMillis member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchSpanProcessor.#scheduledDelayMillis';
  * ```
  */
  #scheduledDelayMillis: number;
  /**
  * #timer member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchSpanProcessor.#timer';
  * ```
  */
  #timer: number | null = null;
  /**
  * #droppedSpanCount private field on BatchSpanProcessor.
  *
  * Stores internal runtime state only. Defaults are assigned by field initializers or the constructor, and callers should not depend on this private slot.
  *
  * ```typescript no_run
  * const field = 'BatchSpanProcessor.#droppedSpanCount';
  * ```
  */
  #droppedSpanCount = 0;
  /**
  * constructor member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const instance = new BatchSpanProcessor();
  * ```
  */
  constructor(exporter: OtelExporter, options: {
    maxQueueSize?: number;
    maxExportBatchSize?: number;
    scheduledDelayMillis?: number;
  } = {}) {
    super();
    this.#exporter = exporter;
    this.#maxQueueSize = options.maxQueueSize || 2048;
    this.#maxExportBatchSize = options.maxExportBatchSize || 512;
    this.#scheduledDelayMillis = options.scheduledDelayMillis || 0;
  }
  /**
  * droppedSpanCount member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const getter = BatchSpanProcessor.prototype.droppedSpanCount;
  * ```
  */
  get droppedSpanCount(): number {
    return this.#droppedSpanCount;
  }
  /**
  * onEnd member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = BatchSpanProcessor.prototype.onEnd;
  * ```
  */
  onEnd(span: SpanRecord): void {
    if (this.#queue.length >= this.#maxQueueSize) {
      this.#droppedSpanCount++;
      return;
    }
    this.#queue.push(span);
    if (this.#scheduledDelayMillis > 0 && this.#timer === null) {
      this.#timer = (setTimeout(() => {
        this.#timer = null;
        void this.forceFlush();
      }, this.#scheduledDelayMillis) as unknown) as number;
    }
  }
  /**
  * forceFlush member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = BatchSpanProcessor.prototype.forceFlush;
  * ```
  */
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
  /**
  * shutdown member on BatchSpanProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = BatchSpanProcessor.prototype.shutdown;
  * ```
  */
  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}
/**
* BatchLogRecordProcessor class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = BatchLogRecordProcessor;
* ```
*/
export class BatchLogRecordProcessor extends LogRecordProcessor {
  /**
  * #exporter member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#exporter';
  * ```
  */
  #exporter: OtelExporter;
  /**
  * #queue member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#queue';
  * ```
  */
  #queue: LogRecord[] = [];
  /**
  * #maxQueueSize member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#maxQueueSize';
  * ```
  */
  #maxQueueSize: number;
  /**
  * #maxExportBatchSize member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#maxExportBatchSize';
  * ```
  */
  #maxExportBatchSize: number;
  /**
  * #scheduledDelayMillis member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#scheduledDelayMillis';
  * ```
  */
  #scheduledDelayMillis: number;
  /**
  * #attributeCountLimit member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#attributeCountLimit';
  * ```
  */
  #attributeCountLimit: number;
  /**
  * #attributeValueLengthLimit member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#attributeValueLengthLimit';
  * ```
  */
  #attributeValueLengthLimit: number;
  /**
  * #timer member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'BatchLogRecordProcessor.#timer';
  * ```
  */
  #timer: number | null = null;
  /**
  * constructor member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const instance = new BatchLogRecordProcessor();
  * ```
  */
  constructor(exporter: OtelExporter, options: {
    maxQueueSize?: number;
    maxExportBatchSize?: number;
    scheduledDelayMillis?: number;
    attributeCountLimit?: number;
    attributeValueLengthLimit?: number;
  } = {}) {
    super();
    this.#exporter = exporter;
    this.#maxQueueSize = options.maxQueueSize || 2048;
    this.#maxExportBatchSize = options.maxExportBatchSize || 512;
    this.#scheduledDelayMillis = options.scheduledDelayMillis || 0;
    this.#attributeCountLimit = options.attributeCountLimit || Number.POSITIVE_INFINITY;
    this.#attributeValueLengthLimit = options.attributeValueLengthLimit || Number.POSITIVE_INFINITY;
  }
  /**
  * onEmit member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = BatchLogRecordProcessor.prototype.onEmit;
  * ```
  */
  onEmit(log: LogRecord): void {
    if (this.#queue.length >= this.#maxQueueSize) return;
    this.#queue.push(applyLogLimits(log, {
      attributeCountLimit: this.#attributeCountLimit,
      attributeValueLengthLimit: this.#attributeValueLengthLimit
    }));
    if (this.#scheduledDelayMillis > 0 && this.#timer === null) {
      this.#timer = (setTimeout(() => {
        this.#timer = null;
        void this.forceFlush();
      }, this.#scheduledDelayMillis) as unknown) as number;
    }
  }
  /**
  * forceFlush member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = BatchLogRecordProcessor.prototype.forceFlush;
  * ```
  */
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
  /**
  * shutdown member on BatchLogRecordProcessor.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = BatchLogRecordProcessor.prototype.shutdown;
  * ```
  */
  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}
class FanoutExporter implements OtelExporter {
  /**
  * #exporters private field on FanoutExporter.
  *
  * Stores internal runtime state only. Defaults are assigned by field initializers or the constructor, and callers should not depend on this private slot.
  *
  * ```typescript no_run
  * const field = 'FanoutExporter.#exporters';
  * ```
  */
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
/**
* PeriodicMetricReader class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = PeriodicMetricReader;
* ```
*/
export class PeriodicMetricReader extends MetricReader {
  /**
  * #exporter member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'PeriodicMetricReader.#exporter';
  * ```
  */
  #exporter: OtelExporter;
  /**
  * #queue member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'PeriodicMetricReader.#queue';
  * ```
  */
  #queue: MetricRecord[] = [];
  /**
  * #intervalMs member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'PeriodicMetricReader.#intervalMs';
  * ```
  */
  #intervalMs: number;
  /**
  * #timer member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'PeriodicMetricReader.#timer';
  * ```
  */
  #timer: number | null = null;
  /**
  * constructor member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const instance = new PeriodicMetricReader();
  * ```
  */
  constructor(exporter: OtelExporter, options: {
    temporality?: MetricTemporality;
    intervalMs?: number;
  } = {}) {
    super(options);
    this.#exporter = exporter;
    this.#intervalMs = options.intervalMs ?? 6e4;
  }
  /**
  * Called by OtelSDK.start() to wire up a periodic collection cycle.
  *
  * `collectAndFlush` calls back into the SDK to collect accumulated metrics,
  * deliver them via `receive()`, and then call `forceFlush()` to export. A
  * non-positive interval disables scheduling, and repeated calls are ignored
  * once a timer is active.
  *
  * ```typescript no_run
  * const reader = new PeriodicMetricReader({} as never, { intervalMs: 1000 });
  * reader._startPeriodicCollection(async () => {});
  * ```
  */
  _startPeriodicCollection(collectAndFlush: () => Promise<void>): void {
    if (this.#intervalMs <= 0 || this.#timer !== null) return;
    this.#timer = (setInterval(() => {
      void collectAndFlush();
    }, this.#intervalMs) as unknown) as number;
  }
  /**
  * receive member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = PeriodicMetricReader.prototype.receive;
  * ```
  */
  receive(metrics: MetricRecord[]): void {
    this.#queue.push(...metrics);
  }
  /**
  * forceFlush member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = PeriodicMetricReader.prototype.forceFlush;
  * ```
  */
  async forceFlush(): Promise<void> {
    if (this.#queue.length === 0) return;
    const batch = this.#queue.splice(0, this.#queue.length);
    await this.#exporter.exportMetrics(batch);
  }
  /**
  * shutdown member on PeriodicMetricReader.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = PeriodicMetricReader.prototype.shutdown;
  * ```
  */
  async shutdown(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.forceFlush();
  }
}
/**
* PeriodicExportingMetricReader const exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const value = PeriodicExportingMetricReader;
* ```
*/
export const PeriodicExportingMetricReader = PeriodicMetricReader;
/** Evaluate a sampler result and return the (possibly attribute-enriched) span, or null if not sampled. */
function applySamplingResult(span: SpanRecord, result: SamplingResult | boolean): SpanRecord | null {
  if (typeof result === 'boolean') return result ? span : null;
  if (!result.sample) return null;
  if (!result.attributes && !result.traceState) return span;
  return {
    ...span,
    ...result.attributes ? { attributes: {
      ...span.attributes || {},
      ...result.attributes as Attributes
    } } : {},
    ...result.traceState ? { traceState: result.traceState } : {}
  };
}
/**
* OtelSDK class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = OtelSDK;
* ```
*/
export class OtelSDK {
  /**
  * #spanProcessors member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#spanProcessors';
  * ```
  */
  #spanProcessors: SpanProcessor[];
  /**
  * #logRecordProcessors member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#logRecordProcessors';
  * ```
  */
  #logRecordProcessors: LogRecordProcessor[];
  /**
  * #metricReaders member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#metricReaders';
  * ```
  */
  #metricReaders: MetricReader[];
  /**
  * #sampler member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#sampler';
  * ```
  */
  #sampler: Sampler;
  /**
  * #propagator member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#propagator';
  * ```
  */
  #propagator: TextMapPropagator;
  /**
  * #instrumentations member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#instrumentations';
  * ```
  */
  #instrumentations: Instrumentation[];
  /**
  * #disposables member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#disposables';
  * ```
  */
  #disposables: Array<{
    dispose(): void;
  }> = [];
  /**
  * #started private field on OtelSDK.
  *
  * Stores internal runtime state only. Defaults are assigned by field initializers or the constructor, and callers should not depend on this private slot.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#started';
  * ```
  */
  #started = false;
  /**
  * #sampledSpans private field on OtelSDK.
  *
  * Stores internal runtime state only. Defaults are assigned by field initializers or the constructor, and callers should not depend on this private slot.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#sampledSpans';
  * ```
  */
  #sampledSpans = new Set<string>();
  /**
  * #metricAggregates private field on OtelSDK.
  *
  * Stores internal runtime state only. Defaults are assigned by field initializers or the constructor, and callers should not depend on this private slot.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#metricAggregates';
  * ```
  */
  #metricAggregates = new Map<string, MetricRecord>();
  /**
  * #metricDeltaAggregates private field on OtelSDK.
  *
  * Stores internal runtime state only. Defaults are assigned by field initializers or the constructor, and callers should not depend on this private slot.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#metricDeltaAggregates';
  * ```
  */
  #metricDeltaAggregates = new Map<string, MetricRecord>();
  /**
  * #observableMetrics private field on OtelSDK.
  *
  * Stores internal runtime state only. Defaults are assigned by field initializers or the constructor, and callers should not depend on this private slot.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#observableMetrics';
  * ```
  */
  #observableMetrics = new Set<ObservableMetricRegistration>();
  /**
  * #views member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#views';
  * ```
  */
  #views: MetricView[];
  /**
  * #metricCardinalityLimit member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#metricCardinalityLimit';
  * ```
  */
  #metricCardinalityLimit: number;
  /**
  * #spanLimits member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#spanLimits';
  * ```
  */
  #spanLimits: SpanLimits;
  /**
  * #resource member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'OtelSDK.#resource';
  * ```
  */
  #resource: Resource | null;
  /**
  * constructor member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const instance = new OtelSDK();
  * ```
  */
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
  /**
  * propagator member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const getter = OtelSDK.prototype.propagator;
  * ```
  */
  get propagator(): TextMapPropagator {
    return this.#propagator;
  }
  /**
  * resource member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const getter = OtelSDK.prototype.resource;
  * ```
  */
  get resource(): Resource | null {
    return this.#resource;
  }
  /**
  * Merges the SDK resource into an emitted telemetry record.
  *
  * When no SDK resource is configured, the original record is returned. When a
  * resource is configured, its attributes override the record resource
  * attributes and its dropped-count, schema URL, and entity refs are preserved.
  *
  * ```typescript no_run
  * const helper = 'OtelSDK.#withResource';
  * ```
  */
  #withResource<TRecord extends {
    resource?: Resource;
  }>(record: TRecord): TRecord {
    if (!(this.#resource instanceof Resource)) return record;
    return {
      ...record,
      resource: new Resource({
        ...record.resource instanceof Resource ? record.resource.attributes : {},
        ...this.#resource.attributes
      }, {
        droppedAttributesCount: this.#resource.droppedAttributesCount,
        entityRefs: this.#resource.entityRefs,
        schemaUrl: this.#resource.schemaUrl
      })
    };
  }
  /**
  * start member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = OtelSDK.prototype.start;
  * ```
  */
  start(): this {
    if (this.#started) return this;
    this.#started = true;
    this.#disposables.push(topic<MetricRecord>('otel:metric:record').subscribe((metric) => this.recordMetric(metric)), topic<LogRecord>('otel:log:record').subscribe((log) => this.recordLog(log)), topic<ObservableMetricRegistration>('otel:metric:observable:register').subscribe((registration) => this.#observableMetrics.add(registration)), topic<ObservableMetricRegistration>('otel:metric:observable:unregister').subscribe((registration) => this.#observableMetrics.delete(registration)));
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
      if (typeof (result as {
        dispose?: () => void;
      }).dispose === 'function') {
        this.#disposables.push(result as {
          dispose(): void;
        });
      } else if (Array.isArray(result)) {
        for (const item of result) {
          if (item && typeof item.dispose === 'function') this.#disposables.push(item);
        }
      }
    }
    return this;
  }
  /**
  * recordSpanStart member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = OtelSDK.prototype.recordSpanStart;
  * ```
  */
  recordSpanStart(span: SpanRecord): void {
    const limited = applySpanLimits(this.#withResource(span), this.#spanLimits);
    const samplerResult = this.#sampler.shouldSample(limited);
    const finalSpan = applySamplingResult(limited, samplerResult);
    if (!finalSpan) return;
    this.#sampledSpans.add(span.spanId);
    for (const processor of this.#spanProcessors) processor.onStart?.(finalSpan);
  }
  /**
  * recordSpan member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = OtelSDK.prototype.recordSpan;
  * ```
  */
  recordSpan(span: SpanRecord): void {
    if (!this.#sampledSpans.delete(span.spanId)) {
      // Not sampled at start - run sampler now (handles direct recordSpan calls without a prior recordSpanStart).
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
  /**
  * recordLog member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = OtelSDK.prototype.recordLog;
  * ```
  */
  recordLog(log: LogRecord): void {
    const enriched = this.#withResource(log);
    for (const processor of this.#logRecordProcessors) processor.onEmit(enriched);
  }
  /**
  * recordMetric member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = OtelSDK.prototype.recordMetric;
  * ```
  */
  recordMetric(metric: MetricRecord): void {
    const prepared = applyMetricView(this.#withResource(metric), this.#views);
    const instrumentKey = metricInstrumentKey(prepared);
    const seenForInstrument = new Set([...this.#metricAggregates.values()].filter((item) => metricInstrumentKey(item) === instrumentKey).map((item) => attributesKey(item.attributes || {})));
    const attrKey = attributesKey(prepared.attributes || {});
    if (!seenForInstrument.has(attrKey) && seenForInstrument.size >= this.#metricCardinalityLimit) return;
    const key = metricSeriesKey(prepared);
    accumulateMetric(this.#metricAggregates, key, prepared);
    accumulateMetric(this.#metricDeltaAggregates, key, prepared);
  }
  /**
  * flush member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = OtelSDK.prototype.flush;
  * ```
  */
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
          timeUnixNano: observation.timeUnixNano || nowUnixNano()
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
      ...this.#metricReaders.map((reader) => reader.forceFlush())
    ]);
    this.#metricDeltaAggregates.clear();
  }
  /**
  * shutdown member on OtelSDK.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = OtelSDK.prototype.shutdown;
  * ```
  */
  async shutdown(): Promise<void> {
    await this.flush();
    await Promise.all([
      ...this.#spanProcessors.map((processor) => processor.shutdown()),
      ...this.#logRecordProcessors.map((processor) => processor.shutdown()),
      ...this.#metricReaders.map((reader) => reader.shutdown())
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
export { OTLPHttpJsonExporter, HttpServerInstrumentation, TraceTopicInstrumentation, FetchInstrumentation, DnsInstrumentation, SocketInstrumentation, TlsInstrumentation, JobsInstrumentation };
