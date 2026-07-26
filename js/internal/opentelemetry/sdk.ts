/**
 * internal:opentelemetry/sdk — cross-signal SDK wiring for processors, readers, exporters, and instrumentations.
 *
 * This internal module is the collection engine behind `fino:opentelemetry/sdk`
 * (which re-exports everything here). `OtelSDK` subscribes to the runtime's
 * trace, log, metric, and observable-registration topics and applies the full
 * pipeline before records reach an exporter: span limits, sampling, log limits,
 * metric views, cardinality limits, resource enrichment, and multi-exporter
 * fan-out. The individual span processors, log processors, and metric readers
 * are the batching stages that sit between the SDK and the exporters.
 *
 * By default an `OtelSDK` uses an OTLP HTTP JSON exporter, a single
 * `BatchSpanProcessor`, no log processors, no metric readers, an always-on
 * sampler, and a W3C trace-context propagator. `start()` is idempotent and
 * wires up the topic subscriptions and periodic readers; `flush()` collects
 * observable metrics and drains every processor and reader; `shutdown()`
 * flushes, then disposes instrumentations and readers and resets state so the
 * SDK can be started again.
 *
 * Metrics are aggregated in two parallel stores — one cumulative, one delta —
 * so a reader configured for either temporality can be served without
 * re-accumulating. Spans are sampled once: `recordSpanStart` remembers a
 * sampled span id so the matching `recordSpan` can skip a second sampler pass,
 * and a bare `recordSpan` (no prior start) samples on the spot.
 *
 * ```ts no_run
 * import { BatchSpanProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';
 *
 * const memory = new InMemoryExporter();
 * const sdk = new OtelSDK({
 *   exporters: [memory],
 *   spanProcessors: [new BatchSpanProcessor(memory, { scheduledDelayMillis: 0 })],
 * }).start();
 *
 * // ... run instrumented work ...
 *
 * await sdk.flush();
 * console.log(memory.getFinishedSpans().length);
 * await sdk.shutdown();
 * ```
 *
 * See OpenTelemetry SDK concepts:
 * https://opentelemetry.io/docs/concepts/sdk-configuration/
 *
 * @internal
 */
import { topic } from '../../context/topic.ts';
import { Resource, TextMapPropagator, normalizeResource, nowUnixNano } from './common.ts';
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
} from './common.ts';
import { OTLPHttpJsonExporter } from './exporters.ts';
import {
  HttpServerInstrumentation,
  TraceTopicInstrumentation,
  FetchInstrumentation,
  DnsInstrumentation,
  SocketInstrumentation,
  TlsInstrumentation,
  JobsInstrumentation,
} from './instrumentations/index.ts';
import { applyLogLimits } from './logs.ts';
import {
  accumulateMetric,
  applyMetricView,
  attributesKey,
  cloneMetric,
  metricInstrumentKey,
  metricSeriesKey,
  zeroMetric,
} from './metrics.ts';
import { AlwaysOnSampler, Sampler, applySpanLimits } from './traces.ts';
import { W3CTraceContextPropagator } from './common.ts';
import { lazy } from 'fino:signals';
import type { ReadonlySignal } from 'fino:signals';
/**
 * An exporter that retains every span, log, and metric it receives in memory.
 *
 * This is the exporter to reach for in tests and assertions: nothing leaves the
 * process, and the `getFinished*` accessors return defensive copies of what has
 * been exported so far. Its `export*` methods always resolve with a `success`
 * result, so it never exercises retry or failure paths — pair it with a real
 * exporter if you need to test those.
 *
 * ```ts no_run
 * import { BatchSpanProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';
 *
 * const memory = new InMemoryExporter();
 * const sdk = new OtelSDK({
 *   spanProcessors: [new BatchSpanProcessor(memory, { scheduledDelayMillis: 0 })],
 * }).start();
 *
 * await sdk.flush();
 * for (const span of memory.getFinishedSpans()) console.log(span.name);
 * ```
 */
export class InMemoryExporter {
  /** Spans accumulated by `exportSpans`, in arrival order. */
  #spans: SpanRecord[] = [];
  /** Log records accumulated by `exportLogs`, in arrival order. */
  #logs: LogRecord[] = [];
  /** Metric records accumulated by `exportMetrics`, in arrival order. */
  #metrics: MetricRecord[] = [];
  /**
   * Appends the given spans to the in-memory store and resolves with success.
   */
  async exportSpans(spans: SpanRecord[]): Promise<ExportResult> {
    this.#spans.push(...spans);
    return { code: 'success' };
  }
  /**
   * Appends the given log records to the in-memory store and resolves with success.
   */
  async exportLogs(logs: LogRecord[]): Promise<ExportResult> {
    this.#logs.push(...logs);
    return { code: 'success' };
  }
  /**
   * Appends the given metric records to the in-memory store and resolves with success.
   */
  async exportMetrics(metrics: MetricRecord[]): Promise<ExportResult> {
    this.#metrics.push(...metrics);
    return { code: 'success' };
  }
  /**
   * Returns a shallow copy of every span exported so far.
   *
   * The returned array is a snapshot; later exports do not mutate it. Assert
   * against its length and contents after calling `sdk.flush()`.
   */
  getFinishedSpans(): SpanRecord[] {
    return [...this.#spans];
  }
  /**
   * Returns a shallow copy of every log record exported so far.
   */
  getFinishedLogs(): LogRecord[] {
    return [...this.#logs];
  }
  /**
   * Returns a shallow copy of every metric record exported so far.
   */
  getFinishedMetrics(): MetricRecord[] {
    return [...this.#metrics];
  }
}
/**
 * Base class for span processors; the no-op default that subclasses override.
 *
 * A span processor is the stage the SDK notifies when a span starts
 * (`onStart`) and ends (`onEnd`). The base implementation does nothing, which
 * makes it a valid null processor and a convenient superclass. Subclass it to
 * batch, filter, or forward spans — see `BatchSpanProcessor`.
 *
 * ```ts no_run
 * import { SpanProcessor } from 'fino:opentelemetry/sdk';
 * import type { SpanRecord } from 'fino:opentelemetry';
 *
 * class LoggingProcessor extends SpanProcessor {
 *   onEnd(span: SpanRecord): void {
 *     console.log('finished span', span.name);
 *   }
 * }
 * ```
 */
export class SpanProcessor {
  /** Called when a span starts, after sampling and limits are applied. No-op by default. */
  onStart(_span: SpanRecord): void {}
  /** Called when a span ends, after limits are applied. No-op by default. */
  onEnd(_span: SpanRecord): void {}
  /** Exports anything the processor has buffered. Resolves immediately by default. */
  async forceFlush(): Promise<void> {}
  /** Flushes and releases resources. Resolves immediately by default. */
  async shutdown(): Promise<void> {}
}
/**
 * Base class for log-record processors; the no-op default that subclasses override.
 *
 * A log processor is notified once per emitted log record via `onEmit`. The
 * base implementation is a null processor. Subclass it to batch or forward logs
 * — see `BatchLogRecordProcessor`.
 *
 * ```ts no_run
 * import { LogRecordProcessor } from 'fino:opentelemetry/sdk';
 * import type { LogRecord } from 'fino:opentelemetry';
 *
 * class ConsoleLogProcessor extends LogRecordProcessor {
 *   onEmit(log: LogRecord): void {
 *     console.log(log.severityText, log.body);
 *   }
 * }
 * ```
 */
export class LogRecordProcessor {
  /** Called for each emitted log record. No-op by default. */
  onEmit(_log: LogRecord): void {}
  /** Exports anything the processor has buffered. Resolves immediately by default. */
  async forceFlush(): Promise<void> {}
  /** Flushes and releases resources. Resolves immediately by default. */
  async shutdown(): Promise<void> {}
}
/**
 * Base class for metric readers; carries the reader's aggregation temporality.
 *
 * A metric reader is the sink the SDK delivers aggregated metric batches to.
 * Its `temporality` — `'cumulative'` (default) or `'delta'` — selects which of
 * the SDK's two aggregate stores feeds it, and stamps `aggregationTemporality`
 * on each record. The base class is a null reader; subclass it to collect
 * (`ManualMetricReader`) or export on a timer (`PeriodicMetricReader`).
 *
 * ```ts no_run
 * import { MetricReader } from 'fino:opentelemetry/sdk';
 *
 * const reader = new MetricReader({ temporality: 'delta' });
 * console.log(reader.temporality); // 'delta'
 * ```
 */
export class MetricReader {
  /** The configured aggregation temporality, `'cumulative'` or `'delta'`. */
  #temporality: MetricTemporality;
  /**
   * Constructs a reader with the given temporality, defaulting to `'cumulative'`.
   */
  constructor(
    options: {
      temporality?: MetricTemporality;
    } = {},
  ) {
    this.#temporality = options.temporality || 'cumulative';
  }
  /** The aggregation temporality this reader reports metrics with. */
  get temporality(): MetricTemporality {
    return this.#temporality;
  }
  /** Records a single metric. No-op by default. */
  record(_metric: MetricRecord): void {}
  /** Receives a batch of aggregated metrics from the SDK. No-op by default. */
  receive(_metrics: MetricRecord[]): void {}
  /** Exports anything buffered. Resolves immediately by default. */
  async forceFlush(): Promise<void> {}
  /** Stops collection and releases resources. Resolves immediately by default. */
  async shutdown(): Promise<void> {}
}
/**
 * A metric reader that buffers the latest batch for synchronous `collect()`.
 *
 * Unlike `PeriodicMetricReader`, this reader never exports on its own — it holds
 * the most recent batch the SDK delivered and hands it out when you call
 * `collect()`. This is the building block behind `metricsSignal` and any pull-
 * based integration (a scrape endpoint, a dashboard poll). Under `'delta'`
 * temporality, receiving an empty batch after having seen data emits zeroed
 * copies of the last series so downstream consumers observe the reset.
 *
 * ```ts no_run
 * import { ManualMetricReader, OtelSDK } from 'fino:opentelemetry/sdk';
 *
 * const reader = new ManualMetricReader({ temporality: 'delta' });
 * const sdk = new OtelSDK({ metricReaders: [reader] }).start();
 *
 * await sdk.flush();          // SDK delivers a batch to the reader
 * const metrics = reader.collect(); // drains and returns it
 * ```
 */
export class ManualMetricReader extends MetricReader {
  /** The batch currently available to `collect()`; cleared once collected. */
  #batch: MetricRecord[] = [];
  /** The last non-empty batch, used to synthesize zeroed deltas on reset. */
  #lastSeen: MetricRecord[] = [];
  /**
   * Stores the delivered batch for the next `collect()`.
   *
   * Each call replaces the buffered batch rather than appending. When a delta
   * reader receives an empty batch after previously seeing data, the buffer is
   * filled with zeroed copies of the last series so the reset is visible.
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
   * Returns and clears the buffered batch as cloned records.
   *
   * The buffer is emptied, so a second call before the next `receive()` returns
   * an empty array. Records are cloned, so mutating them does not affect SDK
   * state.
   */
  collect(): MetricRecord[] {
    const out = this.#batch.map((metric) => cloneMetric(metric));
    this.#batch = [];
    return out;
  }
}
/**
 * Wraps a `ManualMetricReader` in a cold signal that re-collects on an interval.
 *
 * The returned signal starts empty, collects once immediately when it gains its
 * first subscriber, then polls `reader.collect()` every `intervalMs`
 * (default 1000). Empty collections are skipped, so the signal only updates
 * when there is new metric data. Being cold, the polling timer is only active
 * while the signal has subscribers and is cleared when the last one leaves.
 *
 * ```ts no_run
 * import { ManualMetricReader, OtelSDK, metricsSignal } from 'fino:opentelemetry/sdk';
 *
 * const reader = new ManualMetricReader();
 * new OtelSDK({ metricReaders: [reader] }).start();
 *
 * const metrics = metricsSignal(reader, { intervalMs: 5000 });
 * const stop = metrics.subscribe((batch) => console.log('metrics', batch.length));
 * // later: stop();
 * ```
 */
export function metricsSignal(
  reader: ManualMetricReader,
  options: {
    intervalMs?: number;
  } = {},
): ReadonlySignal<MetricRecord[]> {
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
 * A span processor that queues finished spans and exports them in batches.
 *
 * Spans are buffered on `onEnd` and flushed to the exporter in slices of
 * `maxExportBatchSize` (default 512). Once the queue reaches `maxQueueSize`
 * (default 2048), further spans are dropped and counted in `droppedSpanCount`.
 * When `scheduledDelayMillis` is greater than zero a timer flushes the queue
 * after that delay; with the default of `0` no timer is armed and you must call
 * `forceFlush()` (or `sdk.flush()`) to export — which is what tests typically
 * want for determinism.
 *
 * ```ts no_run
 * import { BatchSpanProcessor, InMemoryExporter } from 'fino:opentelemetry/sdk';
 *
 * const exporter = new InMemoryExporter();
 * const processor = new BatchSpanProcessor(exporter, {
 *   maxQueueSize: 4096,
 *   maxExportBatchSize: 256,
 *   scheduledDelayMillis: 5000,
 * });
 * ```
 */
export class BatchSpanProcessor extends SpanProcessor {
  /** The exporter batches are handed to. */
  #exporter: OtelExporter;
  /** Spans buffered since the last flush. */
  #queue: SpanRecord[] = [];
  /** Maximum spans exported per `exportSpans` call. */
  #maxExportBatchSize: number;
  /** Queue capacity; spans arriving when full are dropped. */
  #maxQueueSize: number;
  /** Delay before an automatic flush; `0` disables the timer. */
  #scheduledDelayMillis: number;
  /** Handle for the pending scheduled-flush timer, or null when idle. */
  #timer: number | null = null;
  /** Count of spans dropped because the queue was full. */
  #droppedSpanCount = 0;
  /**
   * Constructs a batch processor around an exporter with optional sizing.
   *
   * `maxQueueSize` defaults to 2048, `maxExportBatchSize` to 512, and
   * `scheduledDelayMillis` to 0 (manual flush only).
   */
  constructor(
    exporter: OtelExporter,
    options: {
      maxQueueSize?: number;
      maxExportBatchSize?: number;
      scheduledDelayMillis?: number;
    } = {},
  ) {
    super();
    this.#exporter = exporter;
    this.#maxQueueSize = options.maxQueueSize || 2048;
    this.#maxExportBatchSize = options.maxExportBatchSize || 512;
    this.#scheduledDelayMillis = options.scheduledDelayMillis || 0;
  }
  /** How many spans have been dropped because the queue was full. */
  get droppedSpanCount(): number {
    return this.#droppedSpanCount;
  }
  /**
   * Enqueues a finished span, dropping it if the queue is at capacity.
   *
   * When a positive `scheduledDelayMillis` is configured and no flush is
   * pending, this arms the flush timer.
   */
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
  /**
   * Cancels any pending timer and exports the whole queue in batches.
   *
   * Drains the queue in slices of `maxExportBatchSize`, awaiting each
   * `exportSpans` call in turn, so it resolves only once everything buffered
   * has been handed to the exporter.
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
  /** Flushes remaining spans; the exporter itself is not closed here. */
  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}
/**
 * A log-record processor that applies attribute limits and exports in batches.
 *
 * Logs are buffered on `onEmit` after `attributeCountLimit` and
 * `attributeValueLengthLimit` (both unbounded by default) are enforced, then
 * flushed to the exporter in slices of `maxExportBatchSize` (default 512).
 * Records arriving when the queue is at `maxQueueSize` (default 2048) are
 * silently dropped. As with the span processor, `scheduledDelayMillis` of `0`
 * means no automatic flush — call `forceFlush()` or `sdk.flush()`.
 *
 * ```ts no_run
 * import { BatchLogRecordProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';
 *
 * const exporter = new InMemoryExporter();
 * const sdk = new OtelSDK({
 *   logRecordProcessors: [
 *     new BatchLogRecordProcessor(exporter, { attributeValueLengthLimit: 1024 }),
 *   ],
 * }).start();
 * ```
 */
export class BatchLogRecordProcessor extends LogRecordProcessor {
  /** The exporter batches are handed to. */
  #exporter: OtelExporter;
  /** Log records buffered since the last flush. */
  #queue: LogRecord[] = [];
  /** Queue capacity; records arriving when full are dropped. */
  #maxQueueSize: number;
  /** Maximum records exported per `exportLogs` call. */
  #maxExportBatchSize: number;
  /** Delay before an automatic flush; `0` disables the timer. */
  #scheduledDelayMillis: number;
  /** Cap on attribute entries retained per record. */
  #attributeCountLimit: number;
  /** Cap on attribute string-value length per record. */
  #attributeValueLengthLimit: number;
  /** Handle for the pending scheduled-flush timer, or null when idle. */
  #timer: number | null = null;
  /**
   * Constructs a batch log processor around an exporter with optional limits.
   *
   * Sizing defaults match `BatchSpanProcessor`; attribute-count and value-length
   * limits default to unbounded (`Number.POSITIVE_INFINITY`).
   */
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
  /**
   * Applies attribute limits and enqueues the record, dropping it if full.
   *
   * Arms the flush timer when a positive `scheduledDelayMillis` is configured
   * and none is pending.
   */
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
  /**
   * Cancels any pending timer and exports the whole queue in batches.
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
  /** Flushes remaining logs; the exporter itself is not closed here. */
  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}
/**
 * Exporter that fans a single export call out to several underlying exporters.
 *
 * Used internally by `OtelSDK` when more than one exporter is configured. Each
 * signal method dispatches to every wrapped exporter in parallel via
 * `Promise.allSettled`, and reports `failure` if any exporter rejects or itself
 * returns `failure`; otherwise `success`. Missing methods on a wrapped exporter
 * are treated as trivially successful.
 *
 * @internal
 */
class FanoutExporter implements OtelExporter {
  /** The wrapped exporters each call is delivered to. */
  #exporters: OtelExporter[];
  constructor(exporters: OtelExporter[]) {
    this.#exporters = exporters;
  }
  async #fanout(
    method: 'exportSpans' | 'exportLogs' | 'exportMetrics',
    records: SpanRecord[] | LogRecord[] | MetricRecord[],
  ): Promise<ExportResult> {
    const results = await Promise.allSettled(
      this.#exporters.map(
        (exporter) =>
          exporter?.[method]?.(records as never) || Promise.resolve({ code: 'success' }),
      ),
    );
    const failed = results.some(
      (result) => result.status === 'rejected' || result.value?.code === 'failure',
    );
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
 * A metric reader that periodically collects aggregates and exports them.
 *
 * Once `OtelSDK.start()` wires it up, this reader exports on a fixed interval
 * (`intervalMs`, default 60000). Each cycle the SDK collects the aggregate
 * store matching the reader's temporality, delivers it via `receive()`, and the
 * reader exports the buffered batch. A non-positive interval disables the timer,
 * leaving the reader flush-on-demand. Use `PeriodicExportingMetricReader` as the
 * stable alias for this class.
 *
 * ```ts no_run
 * import { OTLPHttpJsonExporter, OtelSDK, PeriodicMetricReader } from 'fino:opentelemetry/sdk';
 *
 * const sdk = new OtelSDK({
 *   metricReaders: [
 *     new PeriodicMetricReader(new OTLPHttpJsonExporter(), { intervalMs: 15000 }),
 *   ],
 * }).start();
 * ```
 */
export class PeriodicMetricReader extends MetricReader {
  /** The exporter each collected batch is sent to. */
  #exporter: OtelExporter;
  /** Metrics buffered by `receive` awaiting the next flush. */
  #queue: MetricRecord[] = [];
  /** Collection/export interval in milliseconds. */
  #intervalMs: number;
  /** Handle for the periodic collection timer, or null when not started. */
  #timer: number | null = null;
  /**
   * Constructs a periodic reader around an exporter.
   *
   * `temporality` is passed through to `MetricReader` (default `'cumulative'`)
   * and `intervalMs` defaults to 60000.
   */
  constructor(
    exporter: OtelExporter,
    options: {
      temporality?: MetricTemporality;
      intervalMs?: number;
    } = {},
  ) {
    super(options);
    this.#exporter = exporter;
    this.#intervalMs = options.intervalMs ?? 6e4;
  }
  /**
   * Called by `OtelSDK.start()` to begin the periodic collection cycle.
   *
   * `collectAndFlush` is the SDK-supplied callback that collects accumulated
   * metrics, delivers them via `receive()`, and calls `forceFlush()` to export.
   * A non-positive interval disables scheduling, and repeated calls are ignored
   * once a timer is active. This is an internal wiring hook, not part of the
   * public reader contract.
   *
   * ```ts no_run
   * import { OTLPHttpJsonExporter, PeriodicMetricReader } from 'fino:opentelemetry/sdk';
   *
   * const reader = new PeriodicMetricReader(new OTLPHttpJsonExporter(), { intervalMs: 1000 });
   * reader._startPeriodicCollection(async () => {});
   * ```
   */
  _startPeriodicCollection(collectAndFlush: () => Promise<void>): void {
    if (this.#intervalMs <= 0 || this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void collectAndFlush();
    }, this.#intervalMs) as unknown as number;
  }
  /** Buffers a batch of aggregated metrics for the next flush. */
  receive(metrics: MetricRecord[]): void {
    this.#queue.push(...metrics);
  }
  /** Exports and clears the buffered metrics; a no-op when empty. */
  async forceFlush(): Promise<void> {
    if (this.#queue.length === 0) return;
    const batch = this.#queue.splice(0, this.#queue.length);
    await this.#exporter.exportMetrics(batch);
  }
  /** Stops the collection timer and flushes any remaining metrics. */
  async shutdown(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.forceFlush();
  }
}
/**
 * Stable OpenTelemetry-spec alias for `PeriodicMetricReader`.
 *
 * Provided so code written against the standard SDK naming works unchanged;
 * it is the same constructor, not a subclass.
 *
 * ```ts no_run
 * import { OTLPHttpJsonExporter, PeriodicExportingMetricReader } from 'fino:opentelemetry/sdk';
 *
 * const reader = new PeriodicExportingMetricReader(new OTLPHttpJsonExporter());
 * ```
 */
export const PeriodicExportingMetricReader = PeriodicMetricReader;
/**
 * Evaluates a sampler result against a span.
 *
 * Returns the span (possibly enriched with the sampler's added attributes and
 * trace state) when sampled, or null when dropped. A boolean result is treated
 * as a plain keep/drop decision with no enrichment.
 *
 * @internal
 */
function applySamplingResult(
  span: SpanRecord,
  result: SamplingResult | boolean,
): SpanRecord | null {
  if (typeof result === 'boolean') return result ? span : null;
  if (!result.sample) return null;
  if (!result.attributes && !result.traceState) return span;
  return {
    ...span,
    ...(result.attributes
      ? {
          attributes: {
            ...(span.attributes || {}),
            ...(result.attributes as Attributes),
          },
        }
      : {}),
    ...(result.traceState ? { traceState: result.traceState } : {}),
  };
}
/**
 * The cross-signal collection engine that turns runtime telemetry into exports.
 *
 * An `OtelSDK` ties together processors, readers, exporters, a sampler, a
 * propagator, metric views, span/log limits, a cardinality limit, and a
 * resource. Once `start()` runs it subscribes to the runtime metric/log/
 * observable topics and drives any periodic readers; span recording is driven
 * by instrumentations calling `recordSpanStart`/`recordSpan`. Records flow
 * through the pipeline — sampling and limits for spans, limits for logs, views
 * and cardinality capping for metrics — with the configured resource merged in
 * along the way, before reaching processors and readers.
 *
 * Construction fills in defaults for anything omitted: an OTLP HTTP JSON
 * exporter, one `BatchSpanProcessor`, no log processors or metric readers, an
 * `AlwaysOnSampler`, a `W3CTraceContextPropagator`, no views, an unbounded
 * cardinality limit, empty span limits, and no resource. Multiple exporters are
 * automatically wrapped in a fan-out exporter.
 *
 * ```ts no_run
 * import {
 *   BatchSpanProcessor,
 *   InMemoryExporter,
 *   OtelSDK,
 *   PeriodicMetricReader,
 * } from 'fino:opentelemetry/sdk';
 *
 * const exporter = new InMemoryExporter();
 * const sdk = new OtelSDK({
 *   resource: { 'service.name': 'checkout' },
 *   spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
 *   metricReaders: [new PeriodicMetricReader(exporter, { intervalMs: 0 })],
 * }).start();
 *
 * await sdk.flush();
 * await sdk.shutdown();
 * ```
 */
export class OtelSDK {
  /** Span processors that receive sampled, limited spans. */
  #spanProcessors: SpanProcessor[];
  /** Log processors that receive enriched log records. */
  #logRecordProcessors: LogRecordProcessor[];
  /** Metric readers fed from the aggregate stores. */
  #metricReaders: MetricReader[];
  /** Sampler consulted once per span to keep or drop it. */
  #sampler: Sampler;
  /** Propagator exposed for injecting/extracting trace context. */
  #propagator: TextMapPropagator;
  /** Instrumentations enabled on `start()` and disposed on `shutdown()`. */
  #instrumentations: Instrumentation[];
  /** Disposables (topic subscriptions and instrumentation handles) to release on shutdown. */
  #disposables: Array<{
    dispose(): void;
  }> = [];
  /** Whether `start()` has run; guards idempotency. */
  #started = false;
  /** Span ids sampled at start, so their end can skip a second sampler pass. */
  #sampledSpans = new Set<string>();
  /** Cumulative-temporality metric aggregates, keyed by series. */
  #metricAggregates = new Map<string, MetricRecord>();
  /** Delta-temporality metric aggregates, cleared after each delta flush. */
  #metricDeltaAggregates = new Map<string, MetricRecord>();
  /** Registered observable (pull) metric callbacks, collected on flush. */
  #observableMetrics = new Set<ObservableMetricRegistration>();
  /** Metric views applied to shape or rename instruments. */
  #views: MetricView[];
  /** Maximum distinct attribute sets retained per instrument. */
  #metricCardinalityLimit: number;
  /** Span attribute/event/link limits applied before export. */
  #spanLimits: SpanLimits;
  /** Resource merged into every emitted record, or null when unset. */
  #resource: Resource | null;
  /**
   * Constructs an SDK, filling in defaults for any omitted option.
   *
   * When no exporters are given a single OTLP HTTP JSON exporter is used; when
   * several are given they are wrapped in a fan-out exporter feeding the default
   * `BatchSpanProcessor`. A plain object passed as `resource` is normalized into
   * a `Resource`.
   */
  constructor(
    options: {
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
    } = {},
  ) {
    const exporters =
      options.exporters && options.exporters.length > 0
        ? options.exporters
        : [new OTLPHttpJsonExporter()];
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
  /** The configured trace-context propagator, for injecting/extracting carriers. */
  get propagator(): TextMapPropagator {
    return this.#propagator;
  }
  /** The configured resource merged into emitted records, or null when unset. */
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
   * @internal
   */
  #withResource<
    TRecord extends {
      resource?: Resource;
    },
  >(record: TRecord): TRecord {
    if (!(this.#resource instanceof Resource)) return record;
    return {
      ...record,
      resource: new Resource(
        {
          ...(record.resource instanceof Resource ? record.resource.attributes : {}),
          ...this.#resource.attributes,
        },
        {
          droppedAttributesCount: this.#resource.droppedAttributesCount,
          entityRefs: this.#resource.entityRefs,
          schemaUrl: this.#resource.schemaUrl,
        },
      ),
    };
  }
  /**
   * Starts collection: subscribes to runtime topics and enables instrumentations.
   *
   * Idempotent — a second call while already started is a no-op and returns
   * `this`. Subscribes to the metric, log, and observable-registration topics,
   * arms periodic metric readers, and enables each instrumentation, tracking any
   * returned disposables for `shutdown()`. Returns the SDK so `start()` can be
   * chained onto construction.
   *
   * ```ts no_run
   * import { OtelSDK } from 'fino:opentelemetry/sdk';
   *
   * const sdk = new OtelSDK().start();
   * ```
   */
  start(): this {
    if (this.#started) return this;
    this.#started = true;
    this.#disposables.push(
      topic<MetricRecord>('otel:metric:record').subscribe((metric) => this.recordMetric(metric)),
      topic<LogRecord>('otel:log:record').subscribe((log) => this.recordLog(log)),
      topic<ObservableMetricRegistration>('otel:metric:observable:register').subscribe(
        (registration) => this.#observableMetrics.add(registration),
      ),
      topic<ObservableMetricRegistration>('otel:metric:observable:unregister').subscribe(
        (registration) => this.#observableMetrics.delete(registration),
      ),
    );
    for (const reader of this.#metricReaders) {
      if (reader instanceof PeriodicMetricReader) {
        const sdk = this;
        reader._startPeriodicCollection(async () => {
          // Collect accumulated metrics and deliver to this reader, then export.
          const source =
            reader.temporality === 'delta' ? sdk.#metricDeltaAggregates : sdk.#metricAggregates;
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
      if (
        typeof (
          result as {
            dispose?: () => void;
          }
        ).dispose === 'function'
      ) {
        this.#disposables.push(
          result as {
            dispose(): void;
          },
        );
      } else if (Array.isArray(result)) {
        for (const item of result) {
          if (item && typeof item.dispose === 'function') this.#disposables.push(item);
        }
      }
    }
    return this;
  }
  /**
   * Records the start of a span, applying limits and sampling.
   *
   * The span is limit-clamped and resource-enriched, then the sampler decides
   * whether to keep it. Dropped spans return immediately; kept spans have their
   * id remembered so the matching `recordSpan` skips re-sampling, and every span
   * processor's `onStart` is invoked.
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
   * Records the end of a span and delivers it to the processors.
   *
   * If the span was sampled at start its remembered id is consumed and the span
   * is passed straight to each processor's `onEnd`. A span with no prior
   * `recordSpanStart` (a direct end) is sampled here first, and dropped if the
   * sampler declines.
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
   * Records a log, enriches it with the resource, and emits to log processors.
   *
   * This is the handler bound to the `otel:log:record` topic on `start()`, but
   * it can also be called directly.
   */
  recordLog(log: LogRecord): void {
    const enriched = this.#withResource(log);
    for (const processor of this.#logRecordProcessors) processor.onEmit(enriched);
  }
  /**
   * Records a metric, applying views, cardinality limits, and aggregation.
   *
   * The metric is view-shaped and resource-enriched, then dropped if it would
   * introduce a new attribute set beyond the per-instrument cardinality limit.
   * Surviving metrics are accumulated into both the cumulative and delta
   * aggregate stores keyed by series. This is the handler bound to the
   * `otel:metric:record` topic on `start()`.
   */
  recordMetric(metric: MetricRecord): void {
    const prepared = applyMetricView(this.#withResource(metric), this.#views);
    const instrumentKey = metricInstrumentKey(prepared);
    const seenForInstrument = new Set(
      [...this.#metricAggregates.values()]
        .filter((item) => metricInstrumentKey(item) === instrumentKey)
        .map((item) => attributesKey(item.attributes || {})),
    );
    const attrKey = attributesKey(prepared.attributes || {});
    if (!seenForInstrument.has(attrKey) && seenForInstrument.size >= this.#metricCardinalityLimit)
      return;
    const key = metricSeriesKey(prepared);
    accumulateMetric(this.#metricAggregates, key, prepared);
    accumulateMetric(this.#metricDeltaAggregates, key, prepared);
  }
  /**
   * Collects observable metrics and drains all processors and readers.
   *
   * Each registered observable callback is invoked (errors are swallowed and the
   * observable skipped) and its observations recorded. Then, for every reader,
   * the aggregate store matching its temporality is delivered via `receive()`,
   * and all span processors, log processors, and readers are flushed in
   * parallel. Delta aggregates are cleared afterward so the next window starts
   * fresh.
   *
   * ```ts no_run
   * import { BatchSpanProcessor, InMemoryExporter, OtelSDK } from 'fino:opentelemetry/sdk';
   *
   * const exporter = new InMemoryExporter();
   * const sdk = new OtelSDK({
   *   spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
   * }).start();
   *
   * await sdk.flush();
   * console.log(exporter.getFinishedSpans().length);
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
      const list = Array.isArray(observations)
        ? observations
        : observations == null
          ? []
          : [observations];
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
      const source =
        reader.temporality === 'delta' ? this.#metricDeltaAggregates : this.#metricAggregates;
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
  /**
   * Flushes, then shuts down processors, readers, and instrumentations.
   *
   * Runs a final `flush()`, then shuts down every span processor, log processor,
   * and reader in parallel, disposes all tracked disposables (topic
   * subscriptions and instrumentation handles, errors ignored), clears the
   * sampled-span and aggregate state, and marks the SDK stopped. After this the
   * SDK can be `start()`ed again.
   *
   * ```ts no_run
   * import { OtelSDK } from 'fino:opentelemetry/sdk';
   *
   * const sdk = new OtelSDK().start();
   * await sdk.shutdown();
   * ```
   */
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
  JobsInstrumentation,
};
