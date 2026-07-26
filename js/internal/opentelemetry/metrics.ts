/**
 * Metric providers, instruments, observable registrations, and aggregation.
 *
 * This module implements the OpenTelemetry metrics API on top of Fino's topic
 * bus. A `MeterProvider` hands out `Meter`s scoped to an instrumentation library;
 * a meter creates the synchronous instruments (`Counter`, `UpDownCounter`,
 * `Gauge`, `HistogramInstrument`) and the observable instruments
 * (`ObservableCounter`, `ObservableUpDownCounter`, `ObservableGauge`). Recording a
 * measurement builds a `MetricRecord` — stamping it with the meter's scope, the
 * provider's resource, the current time, and, if a span is active, an exemplar
 * context — and publishes it to the meter's pre-cached per-scope topics plus the
 * shared `otel:metric:record` topic. Observable instruments do not record eagerly:
 * they publish a registration to `otel:metric:observable:register` and return a
 * disposable that republishes it to `otel:metric:observable:unregister`. The
 * reader and exporter side lives in the SDK, which subscribes to these topics.
 *
 * Alongside the API surface, this module holds the pure SDK-side helpers the
 * reader uses to fold a stream of records into a fixed set of series.
 * `cloneMetric` deep-copies a record so aggregation never mutates the published
 * one; `metricSeriesKey`, `metricInstrumentKey`, and `attributesKey` derive stable
 * grouping keys; `normalizeMetricKind` collapses observable kinds onto their
 * synchronous equivalents; `accumulateMetric` folds a new observation into a
 * running aggregate (summing counters, bucketing histograms, keeping the last
 * value for gauges); `applyMetricView` rewrites a record according to configured
 * views; and `zeroMetric` produces the reset points a delta reader emits for a
 * series that stopped reporting.
 *
 * Instrument names must be non-empty — `requireNonEmptyName` throws a `TypeError`
 * otherwise. Histograms use the OpenTelemetry default explicit bucket boundaries
 * unless `advice.explicitBucketBoundaries` is supplied at creation. Use
 * `getMeterProvider()` to reach the active provider; `setMeterProvider` replaces
 * the process-wide default, while `runWithMeterProvider` and
 * `runWithoutMeterProvider` override it for the duration of a callback.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const meter = getMeterProvider().getMeter('orders');
 * const created = meter.createCounter('orders.created', { unit: '1' });
 * created.add(1, { tenant: 'acme' });
 *
 * const latency = meter.createHistogram('order.latency', { unit: 'ms' });
 * latency.record(42, { route: '/checkout' });
 * ```
 *
 * See OpenTelemetry metrics:
 * https://opentelemetry.io/docs/concepts/signals/metrics/
 *
 * @internal
 */
import { Context } from '../../context/index.ts';
import { Topic, topic } from '../../context/topic.ts';
import {
  BaseProvider,
  OTEL_SCHEMA_VERSION,
  normalizeScope,
  nowUnixNano,
  topicNames,
  requireNonEmptyName,
} from './common.ts';
import type {
  Attributes,
  ExemplarRecord,
  MetricExemplarContext,
  MetricInstrumentOptions,
  MetricRecord,
  MetricView,
  ObservableMetricRegistration,
  QuantileValueRecord,
  ScopeInfo,
} from './common.ts';
import { getActiveSpanContext } from './traces.ts';
import type { ReadonlySignal } from 'fino:signals';
/**
 * Entry point of the metrics API — the factory that produces scoped `Meter`s.
 *
 * A `MeterProvider` carries the resource (from `BaseProvider`) that every metric
 * it produces is stamped with. It holds no per-instrument state itself; each
 * `getMeter` call returns a fresh `Meter` bound to this provider and the given
 * instrumentation scope. Obtain the active provider with `getMeterProvider()`
 * rather than constructing one directly unless you are installing a custom SDK.
 *
 * ```ts no_run
 * import { MeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const provider = new MeterProvider({ resource: { 'service.name': 'billing' } });
 * const meter = provider.getMeter('billing/invoices', '1.4.0');
 * ```
 */
export class MeterProvider extends BaseProvider {
  /**
   * Returns a `Meter` scoped to a named instrumentation library.
   *
   * `name` identifies the library or subsystem emitting metrics and is what
   * per-scope topic routing keys off of; `version` and the optional `schemaUrl`,
   * `attributes`, and `droppedAttributesCount` further qualify the scope. The
   * arguments are passed through `normalizeScope`, which throws a `TypeError` if
   * `name` is empty. Each call allocates a new `Meter`; there is no caching, so
   * hold onto the returned instance rather than calling `getMeter` per record.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const meter = getMeterProvider().getMeter('db/pool', '2.0.0', {
   *   schemaUrl: 'https://opentelemetry.io/schemas/1.24.0',
   * });
   * ```
   */
  getMeter(
    name: string,
    version?: string,
    options?: {
      schemaUrl?: string | null;
      attributes?: Attributes;
      droppedAttributesCount?: number;
    },
  ): Meter {
    return new Meter(
      this,
      normalizeScope(
        name,
        version,
        options?.schemaUrl,
        options?.attributes,
        options?.droppedAttributesCount,
      ),
    );
  }
}
/**
 * A monotonic synchronous counter — records non-negative increments to a sum.
 *
 * Use a counter for values that only ever go up, such as requests served or bytes
 * written. Each `add` publishes a `counter`-kind `MetricRecord`; the SDK folds
 * those into a running total per attribute set. For values that can also decrease,
 * use `UpDownCounter`. Create one with `Meter.createCounter` rather than
 * constructing it directly.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const requests = getMeterProvider().getMeter('http').createCounter('http.requests');
 * requests.add(1, { method: 'GET', route: '/health' });
 * ```
 */
export class Counter {
  /** The meter this counter records through. */
  #meter: Meter;
  /** The validated, non-empty instrument name. */
  #name: string;
  /** Instrument options (unit, description) merged into every record. */
  #options: MetricInstrumentOptions;
  /**
   * Binds the counter to a meter and validates its name.
   *
   * Throws a `TypeError` if `name` is empty or whitespace-only. Prefer
   * `Meter.createCounter`, which calls this for you.
   */
  constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {}) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
  }
  /**
   * Adds `value` to the counter for the given attribute set.
   *
   * `value` should be non-negative; the API does not reject a negative number, but
   * a monotonic counter is only meaningful with increments. `attributes` partition
   * the counter into independent series, so keep their cardinality bounded. Each
   * call publishes one record synchronously to the meter's topics.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const bytes = getMeterProvider().getMeter('io').createCounter('io.bytes.written');
   * bytes.add(4096, { device: 'nvme0' });
   * ```
   */
  add(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, {
      ...this.#options,
      attributes,
      kind: 'counter',
    });
  }
}
/**
 * A non-monotonic synchronous counter — records signed deltas to a sum that may rise or fall.
 *
 * Use an up-down counter for quantities that go both directions, such as the
 * number of in-flight requests, items in a queue, or active connections. Positive
 * values increase the sum, negative values decrease it. The SDK marks the series
 * as non-monotonic so exporters treat it as a gauge-like sum. Create one with
 * `Meter.createUpDownCounter`.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const inflight = getMeterProvider().getMeter('http').createUpDownCounter('http.requests.active');
 * inflight.add(1);   // request started
 * inflight.add(-1);  // request finished
 * ```
 */
export class UpDownCounter {
  /** The meter this counter records through. */
  #meter: Meter;
  /** The validated, non-empty instrument name. */
  #name: string;
  /** Instrument options (unit, description) merged into every record. */
  #options: MetricInstrumentOptions;
  /**
   * Binds the up-down counter to a meter and validates its name.
   *
   * Throws a `TypeError` if `name` is empty. Prefer `Meter.createUpDownCounter`.
   */
  constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {}) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
  }
  /**
   * Adds a signed `value` to the counter for the given attribute set.
   *
   * Pass a positive number to increment and a negative number to decrement the
   * running sum. Each call publishes one `updowncounter`-kind record synchronously.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const queued = getMeterProvider().getMeter('jobs').createUpDownCounter('jobs.queued');
   * queued.add(5, { queue: 'email' });
   * queued.add(-2, { queue: 'email' });
   * ```
   */
  add(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, {
      ...this.#options,
      attributes,
      kind: 'updowncounter',
    });
  }
}
// OTel spec default explicit bucket boundaries.
const DEFAULT_HISTOGRAM_BOUNDARIES = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1e3, 2500, 5e3, 7500, 1e4,
];
/**
 * A histogram instrument — records a distribution of values across explicit buckets.
 *
 * Use a histogram for measurements whose distribution matters, such as request
 * latency or payload size. Each recorded value increments the bucket it falls into
 * and contributes to the count, sum, min, and max the SDK maintains per series.
 * Buckets are defined by the explicit boundaries passed as
 * `advice.explicitBucketBoundaries` at creation, defaulting to the OpenTelemetry
 * standard boundaries (0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000,
 * 7500, 10000) when none are given. Create one with `Meter.createHistogram`; the
 * public alias `Histogram` points at this class.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const latency = getMeterProvider().getMeter('http').createHistogram('http.server.duration', {
 *   unit: 'ms',
 *   advice: { explicitBucketBoundaries: [1, 5, 10, 50, 100, 500] },
 * });
 * latency.record(37, { route: '/orders' });
 * ```
 */
export class HistogramInstrument {
  /** The meter this histogram records through. */
  #meter: Meter;
  /** The validated, non-empty instrument name. */
  #name: string;
  /** Instrument options (unit, description) merged into every record. */
  #options: MetricInstrumentOptions;
  /** The explicit bucket boundaries, defaulted to the OTel standard set. */
  #boundaries: number[];
  /**
   * Binds the histogram to a meter, validates its name, and fixes its buckets.
   *
   * When `advice.explicitBucketBoundaries` is an array it is copied and used as the
   * bucket boundaries; otherwise the shared default boundaries are used. Throws a
   * `TypeError` if `name` is empty. Prefer `Meter.createHistogram`.
   */
  constructor(
    meter: Meter,
    name: string,
    options: MetricInstrumentOptions & {
      advice?: {
        explicitBucketBoundaries?: number[];
      };
    } = {},
  ) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
    this.#boundaries = Array.isArray(options.advice?.explicitBucketBoundaries)
      ? [...options.advice!.explicitBucketBoundaries!]
      : DEFAULT_HISTOGRAM_BOUNDARIES;
  }
  /**
   * Records a single `value` into the distribution for the given attribute set.
   *
   * The record carries this histogram's explicit bounds so the reader can place the
   * value in the correct bucket and update count, sum, min, and max. Publishes one
   * `histogram`-kind record synchronously.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const size = getMeterProvider().getMeter('http').createHistogram('http.request.size', { unit: 'By' });
   * size.record(2048, { route: '/upload' });
   * ```
   */
  record(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, {
      ...this.#options,
      attributes,
      kind: 'histogram',
      explicitBounds: this.#boundaries,
    } as MetricInstrumentOptions & {
      explicitBounds?: number[];
    });
  }
}
/**
 * Handle to a registered observable (asynchronous) instrument.
 *
 * Unlike synchronous instruments, an observable gauge does not record eagerly.
 * `Meter.createObservableGauge` registers a callback that the SDK invokes on each
 * collection to read the current value; this object is the disposable handle that
 * unregisters that callback. It is the common return type for all observable
 * instruments — `ObservableCounter` and `ObservableUpDownCounter` subclass it with
 * no behavioral difference. Call `dispose()` (or use `using`) to stop observing.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const meter = getMeterProvider().getMeter('runtime');
 * const handle = meter.createObservableGauge('heap.used', () => ({ value: 12_345_678 }));
 * handle.dispose(); // stop reporting
 * ```
 */
export class ObservableGauge {
  /** Disposable that unregisters the observing callback, or `null` once disposed. */
  #handle: {
    dispose(): void;
  } | null;
  /**
   * Wraps the disposable returned by the meter's registration.
   *
   * Constructed internally by the `createObservable*` meter methods; you receive an
   * instance rather than building one.
   */
  constructor(handle: { dispose(): void }) {
    this.#handle = handle;
  }
  /**
   * Unregisters the observing callback so the instrument stops being collected.
   *
   * Idempotent and safe to call when never registered — the underlying disposal is
   * invoked at most once and missing handles are ignored.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const handle = getMeterProvider().getMeter('sys').createObservableCounter('gc.count', () => ({ value: 3 }));
   * handle.dispose();
   * ```
   */
  dispose(): void {
    this.#handle?.dispose?.();
  }
}
/**
 * A synchronous gauge — records the latest sampled value of something that varies.
 *
 * Use a gauge for a current reading that is not a sum, such as a temperature, a
 * pool size, or a cache hit ratio. Each `record` replaces the previous value for
 * its attribute set (last-value semantics) rather than accumulating. When the
 * value is naturally produced by a callback on collection rather than pushed,
 * prefer an observable gauge via `Meter.createObservableGauge`. Create a
 * synchronous gauge with `Meter.createGauge`.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const temp = getMeterProvider().getMeter('sensors').createGauge('cpu.temperature', { unit: 'Cel' });
 * temp.record(61.5, { core: '0' });
 * ```
 */
export class Gauge {
  /** The meter this gauge records through. */
  #meter: Meter;
  /** The validated, non-empty instrument name. */
  #name: string;
  /** Instrument options (unit, description) merged into every record. */
  #options: MetricInstrumentOptions;
  /**
   * Binds the gauge to a meter and validates its name.
   *
   * Throws a `TypeError` if `name` is empty. Prefer `Meter.createGauge`.
   */
  constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {}) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
  }
  /**
   * Records the current `value` for the given attribute set.
   *
   * The reader keeps only the most recent value per series, so recording again
   * overwrites rather than adds. Publishes one `gauge`-kind record synchronously.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const ratio = getMeterProvider().getMeter('cache').createGauge('cache.hit.ratio');
   * ratio.record(0.92, { tier: 'l1' });
   * ```
   */
  record(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, {
      ...this.#options,
      attributes,
      kind: 'gauge',
    });
  }
}
/**
 * Handle to a registered observable counter (monotonic asynchronous sum).
 *
 * Returned by `Meter.createObservableCounter`. Behaviorally identical to
 * `ObservableGauge` — the distinction is the registered instrument kind, which
 * the SDK aggregates as a monotonic sum. Call `dispose()` to stop observing.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const handle = getMeterProvider().getMeter('proc').createObservableCounter('page.faults', () => ({ value: 128 }));
 * handle.dispose();
 * ```
 */
export class ObservableCounter extends ObservableGauge {}
/**
 * Handle to a registered observable up-down counter (non-monotonic asynchronous sum).
 *
 * Returned by `Meter.createObservableUpDownCounter`. Behaviorally identical to
 * `ObservableGauge`, but the SDK aggregates it as a non-monotonic sum that may
 * rise or fall between collections. Call `dispose()` to stop observing.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const handle = getMeterProvider().getMeter('pool').createObservableUpDownCounter('conns.open', () => ({ value: 7 }));
 * handle.dispose();
 * ```
 */
export class ObservableUpDownCounter extends ObservableGauge {}
/**
 * Public alias for `HistogramInstrument`, matching the OpenTelemetry `Histogram` name.
 *
 * Provided so callers can name the type `Histogram` as the API spec does; it is
 * the exact same class. `Meter.createHistogram` returns instances of it.
 *
 * ```ts no_run
 * import { Histogram } from 'fino:opentelemetry/metrics';
 *
 * function record(h: InstanceType<typeof Histogram>, ms: number): void {
 *   h.record(ms);
 * }
 * ```
 */
export const Histogram = HistogramInstrument;
/**
 * The instrument factory for one instrumentation scope, and the source of metric records.
 *
 * A meter is bound to a `MeterProvider` and a `ScopeInfo` (name, version, and
 * schema). Its `create*` methods mint the synchronous and observable instruments;
 * those instruments all funnel measurements back through `Meter.record`, which
 * assembles a `MetricRecord` and publishes it to the scope's topics plus the
 * shared `otel:metric:record` topic. Topic sets are cached per
 * `instrumentName:kind`, so records for the same instrument reuse their topics.
 * Obtain a meter from `MeterProvider.getMeter` rather than constructing one.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const meter = getMeterProvider().getMeter('checkout', '3.1.0');
 * const orders = meter.createCounter('orders.count');
 * const latency = meter.createHistogram('orders.latency', { unit: 'ms' });
 * orders.add(1, { store: 'eu' });
 * latency.record(58, { store: 'eu' });
 * ```
 */
export class Meter {
  /** The provider that supplies the resource stamped on every record. */
  #provider: MeterProvider;
  /** The instrumentation scope (name/version) this meter emits under. */
  #scope: ScopeInfo;
  // Pre-cached topic sets keyed by `${instrumentName}:${kind}`, plus the shared record topic.
  /** Cache of per-instrument scoped topics, keyed by `instrumentName:kind`. */
  #topicsByKey: Map<string, Array<Topic<MetricRecord>>>;
  /** The shared `otel:metric:record` topic every record is also published to. */
  #recordTopic: Topic<MetricRecord>;
  /**
   * Binds the meter to its provider and scope and prepares the shared record topic.
   *
   * Called internally by `MeterProvider.getMeter`; the `scope` is expected to have
   * already been normalized to a non-empty name.
   */
  constructor(provider: MeterProvider, scope: ScopeInfo) {
    this.#provider = provider;
    this.#scope = scope;
    this.#topicsByKey = new Map();
    this.#recordTopic = topic<MetricRecord>('otel:metric:record');
  }
  /**
   * Returns cached scoped metric topics for an instrument and kind.
   *
   * Topic names are created lazily and keyed by `instrumentName:kind`. The helper
   * assumes the caller already normalized and validated the instrument name.
   */
  #getTopics(instrumentName: string, kind: string): Array<Topic<MetricRecord>> {
    const key = `${instrumentName}:${kind}`;
    let topics = this.#topicsByKey.get(key);
    if (!topics) {
      topics = topicNames('metric', this.#scope, instrumentName, kind).map((name) =>
        topic<MetricRecord>(name),
      );
      this.#topicsByKey.set(key, topics);
    }
    return topics;
  }
  /**
   * Assembles a `MetricRecord` and publishes it to the scope's topics.
   *
   * This is the low-level sink all synchronous instruments delegate to; you rarely
   * call it directly. It validates `name` (throwing a `TypeError` if empty),
   * timestamps the record, and stamps it with the meter's scope, the provider's
   * resource, the instrument `kind` (defaulting to `'record'`), and the `unit` and
   * `description` from `options`. When a span is active on the current context, its
   * trace and span ids are captured as an `exemplarContext` so the reader can build
   * an exemplar. The record is published to each cached scoped topic and to the
   * shared `otel:metric:record` topic; `explicitBounds`, when present, rides along
   * for histogram bucketing.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const meter = getMeterProvider().getMeter('custom');
   * meter.record('widgets.built', 3, { kind: 'counter', unit: '1', attributes: { line: 'a' } });
   * ```
   */
  record(
    name: string,
    value: number,
    options: MetricInstrumentOptions & {
      explicitBounds?: number[];
    } = {},
  ): void {
    const metricName = requireNonEmptyName('metric instrument', name);
    const activeContext = getActiveSpanContext();
    const exemplarContext: MetricExemplarContext | null = activeContext
      ? {
          ...(activeContext.traceId ? { traceId: activeContext.traceId } : {}),
          ...(activeContext.spanId ? { spanId: activeContext.spanId } : {}),
          ...(activeContext.traceFlags !== undefined
            ? { traceFlags: activeContext.traceFlags }
            : {}),
        }
      : null;
    const kind = options.kind || 'record';
    const record: MetricRecord = {
      schemaVersion: OTEL_SCHEMA_VERSION,
      name: metricName,
      value,
      timeUnixNano: nowUnixNano(),
      unit: options.unit || '',
      description: options.description || '',
      kind,
      attributes: { ...(options.attributes || {}) },
      scope: { ...this.#scope },
      resource: this.#provider.resource,
      ...(options.explicitBounds ? { explicitBounds: options.explicitBounds } : {}),
      ...(exemplarContext ? { exemplarContext } : {}),
    };
    for (const t of this.#getTopics(metricName, kind)) t.publish(record);
    this.#recordTopic.publish(record);
  }
  /**
   * Creates a monotonic `Counter` bound to this meter.
   *
   * Throws a `TypeError` if `name` is empty. `options.unit` and
   * `options.description` are attached to every record the counter emits.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const c = getMeterProvider().getMeter('api').createCounter('errors', { unit: '1' });
   * c.add(1, { code: '500' });
   * ```
   */
  createCounter(name: string, options: MetricInstrumentOptions = {}): Counter {
    return new Counter(this, name, options);
  }
  /**
   * Creates a non-monotonic `UpDownCounter` bound to this meter.
   *
   * Throws a `TypeError` if `name` is empty. Use for quantities that both rise and
   * fall, like active connections.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const g = getMeterProvider().getMeter('pool').createUpDownCounter('conns');
   * g.add(1);
   * ```
   */
  createUpDownCounter(name: string, options: MetricInstrumentOptions = {}): UpDownCounter {
    return new UpDownCounter(this, name, options);
  }
  /**
   * Creates a `HistogramInstrument` bound to this meter.
   *
   * Throws a `TypeError` if `name` is empty. Pass
   * `options.advice.explicitBucketBoundaries` to override the default bucket layout;
   * otherwise the OTel standard boundaries are used.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const h = getMeterProvider().getMeter('api').createHistogram('latency', {
   *   unit: 'ms',
   *   advice: { explicitBucketBoundaries: [10, 50, 100, 250] },
   * });
   * h.record(42);
   * ```
   */
  createHistogram(
    name: string,
    options: MetricInstrumentOptions & {
      advice?: {
        explicitBucketBoundaries?: number[];
      };
    } = {},
  ): HistogramInstrument {
    return new HistogramInstrument(this, name, options);
  }
  /**
   * Creates a synchronous last-value `Gauge` bound to this meter.
   *
   * Throws a `TypeError` if `name` is empty. Each `record` overwrites the previous
   * value for its attribute set.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const q = getMeterProvider().getMeter('queue').createGauge('depth');
   * q.record(17, { name: 'ingest' });
   * ```
   */
  createGauge(name: string, options: MetricInstrumentOptions = {}): Gauge {
    return new Gauge(this, name, options);
  }
  /**
   * Registers an asynchronous monotonic counter observed on each collection.
   *
   * `callback` is invoked by the SDK at collection time and returns the current
   * cumulative value (and optional attributes). This publishes a registration to
   * `otel:metric:observable:register` and returns an `ObservableCounter` handle;
   * call its `dispose()` to unregister. Unlike the synchronous instruments, no name
   * validation happens here — an empty name would surface downstream.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * let served = 0;
   * const handle = getMeterProvider().getMeter('http').createObservableCounter(
   *   'requests.total',
   *   () => ({ value: served }),
   * );
   * handle.dispose();
   * ```
   */
  createObservableCounter(
    name: string,
    callback: ObservableMetricRegistration['callback'],
    options: MetricInstrumentOptions = {},
  ): ObservableCounter {
    const registration: ObservableMetricRegistration = {
      kind: 'observablecounter',
      name,
      unit: options.unit || '',
      description: options.description || '',
      scope: { ...this.#scope },
      resource: this.#provider.resource,
      callback,
    };
    topic<ObservableMetricRegistration>('otel:metric:observable:register').publish(registration);
    return new ObservableCounter({
      dispose() {
        topic<ObservableMetricRegistration>('otel:metric:observable:unregister').publish(
          registration,
        );
      },
    });
  }
  /**
   * Registers an asynchronous non-monotonic counter observed on each collection.
   *
   * Like `createObservableCounter`, but the SDK treats the observed value as a
   * non-monotonic sum that may decrease between collections. Returns an
   * `ObservableUpDownCounter` handle; call `dispose()` to unregister.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const handle = getMeterProvider().getMeter('mem').createObservableUpDownCounter(
   *   'heap.bytes',
   *   () => ({ value: 8 * 1024 * 1024 }),
   * );
   * handle.dispose();
   * ```
   */
  createObservableUpDownCounter(
    name: string,
    callback: ObservableMetricRegistration['callback'],
    options: MetricInstrumentOptions = {},
  ): ObservableUpDownCounter {
    const registration: ObservableMetricRegistration = {
      kind: 'observableupdowncounter',
      name,
      unit: options.unit || '',
      description: options.description || '',
      scope: { ...this.#scope },
      resource: this.#provider.resource,
      callback,
    };
    topic<ObservableMetricRegistration>('otel:metric:observable:register').publish(registration);
    return new ObservableUpDownCounter({
      dispose() {
        topic<ObservableMetricRegistration>('otel:metric:observable:unregister').publish(
          registration,
        );
      },
    });
  }
  /**
   * Registers an asynchronous gauge observed on each collection.
   *
   * `callback` returns the current reading (last-value semantics); the SDK invokes
   * it at collection time. Use this when a value is cheaper to sample on demand than
   * to push, such as a pool size or a system metric. Returns an `ObservableGauge`
   * handle; call `dispose()` to unregister. See also `gaugeFromSignal` for wiring a
   * `fino:signals` value directly.
   *
   * ```ts no_run
   * import { getMeterProvider } from 'fino:opentelemetry/metrics';
   *
   * const handle = getMeterProvider().getMeter('os').createObservableGauge(
   *   'load.avg',
   *   () => ({ value: 0.42, attributes: { interval: '1m' } }),
   * );
   * handle.dispose();
   * ```
   */
  createObservableGauge(
    name: string,
    callback: ObservableMetricRegistration['callback'],
    options: MetricInstrumentOptions = {},
  ): ObservableGauge {
    const registration: ObservableMetricRegistration = {
      kind: 'gauge',
      name,
      unit: options.unit || '',
      description: options.description || '',
      scope: { ...this.#scope },
      resource: this.#provider.resource,
      callback,
    };
    topic<ObservableMetricRegistration>('otel:metric:observable:register').publish(registration);
    return new ObservableGauge({
      dispose() {
        topic<ObservableMetricRegistration>('otel:metric:observable:unregister').publish(
          registration,
        );
      },
    });
  }
}
/**
 * Creates an observable gauge that reports a `fino:signals` value on each collection.
 *
 * Bridges reactive state into metrics: the gauge's collection callback simply
 * reads `signal.get()`, so whatever value the signal currently holds is what gets
 * exported, with no manual polling. The optional `attributes` are split out of
 * `options` and attached to every observation; the remaining instrument options
 * (unit, description) are forwarded to `createObservableGauge`. Returns the same
 * `ObservableGauge` handle — call `dispose()` to stop reporting.
 *
 * ```ts no_run
 * import { getMeterProvider, gaugeFromSignal } from 'fino:opentelemetry/metrics';
 * import { signal } from 'fino:signals';
 *
 * const depth = signal(0);
 * const meter = getMeterProvider().getMeter('queue');
 * const handle = gaugeFromSignal(meter, 'queue.depth', depth, { unit: '1', attributes: { name: 'ingest' } });
 * depth.set(12); // next collection reports 12
 * handle.dispose();
 * ```
 */
export function gaugeFromSignal(
  meter: Meter,
  name: string,
  signal: ReadonlySignal<number>,
  options: MetricInstrumentOptions & {
    attributes?: Attributes;
  } = {},
): ObservableGauge {
  const { attributes = {}, ...instrumentOptions } = options;
  return meter.createObservableGauge(
    name,
    () => ({
      value: signal.get(),
      attributes,
    }),
    instrumentOptions,
  );
}
/**
 * Returns a deep copy of a metric record safe to aggregate into without mutating the original.
 *
 * Published records are shared with every topic subscriber, so the SDK never
 * mutates them in place. This clones the record and independently copies its
 * mutable structures — the `attributes` map, and the `explicitBounds`,
 * `bucketCounts`, `quantileValues`, and `exemplars` arrays (including each
 * exemplar's `filteredAttributes`) — while leaving scalars and the shared
 * `resource`/`scope` references as-is. Non-array values in those fields are carried
 * through unchanged.
 *
 * ```ts no_run
 * import { cloneMetric } from 'fino:opentelemetry/metrics';
 *
 * const copy = cloneMetric({ name: 'orders', value: 1, attributes: { store: 'eu' } });
 * copy.attributes!.store = 'us'; // does not affect the source record
 * ```
 */
export function cloneMetric(metric: MetricRecord): MetricRecord {
  return {
    ...metric,
    attributes: { ...(metric.attributes || {}) },
    ...(Array.isArray(metric.explicitBounds)
      ? { explicitBounds: [...metric.explicitBounds] }
      : metric.explicitBounds !== undefined
        ? { explicitBounds: metric.explicitBounds }
        : {}),
    ...(Array.isArray(metric.bucketCounts)
      ? { bucketCounts: [...metric.bucketCounts] }
      : metric.bucketCounts !== undefined
        ? { bucketCounts: metric.bucketCounts }
        : {}),
    ...(Array.isArray(metric.quantileValues)
      ? { quantileValues: metric.quantileValues.map((value) => ({ ...value })) }
      : metric.quantileValues !== undefined
        ? { quantileValues: metric.quantileValues }
        : {}),
    ...(Array.isArray(metric.exemplars)
      ? {
          exemplars: metric.exemplars.map((exemplar) => ({
            ...exemplar,
            ...(exemplar.filteredAttributes
              ? { filteredAttributes: { ...exemplar.filteredAttributes } }
              : {}),
          })),
        }
      : metric.exemplars !== undefined
        ? { exemplars: metric.exemplars }
        : {}),
  };
}
/**
 * Returns a zeroed clone of a metric record — a reset point for a series that stopped reporting.
 *
 * A delta reader must emit a final zero point for any series that reported last
 * cycle but not this one, so downstream consumers see it return to baseline. This
 * clones the record (via `cloneMetric`) and sets every present numeric aggregate —
 * `value`, `count`, `sum`, `min`, `max`, all `bucketCounts`, and each
 * `quantileValues` entry's `value` — to `0`, and clears `exemplars`. Fields that
 * were absent stay absent; identity fields (name, scope, attributes) are preserved.
 *
 * ```ts no_run
 * import { zeroMetric } from 'fino:opentelemetry/metrics';
 *
 * const reset = zeroMetric({ name: 'orders', value: 42, attributes: { store: 'eu' } });
 * // reset.value === 0, same name and attributes
 * ```
 */
export function zeroMetric(metric: MetricRecord): MetricRecord {
  const clone = cloneMetric(metric);
  if (typeof clone.value === 'number') clone.value = 0;
  if (typeof clone.count === 'number') clone.count = 0;
  if (typeof clone.sum === 'number') clone.sum = 0;
  if (typeof clone.min === 'number') clone.min = 0;
  if (typeof clone.max === 'number') clone.max = 0;
  if (Array.isArray(clone.bucketCounts)) clone.bucketCounts = clone.bucketCounts.map(() => 0);
  if (Array.isArray(clone.quantileValues))
    clone.quantileValues = clone.quantileValues.map((value) => ({
      ...value,
      value: 0,
    }));
  clone.exemplars = [];
  return clone;
}
function sortAttributeEntries(attributes: Attributes): Array<[string, unknown]> {
  return Object.entries(attributes || {}).sort((a, b) => {
    const left = String(a[0]);
    const right = String(b[0]);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}
/**
 * Produces a stable string key for a set of attributes, independent of insertion order.
 *
 * Attributes are sorted by key before serialization, so two records with the same
 * attributes in a different order yield the same key. Used to group measurements
 * into series within an instrument. A missing or empty bag produces the key for an
 * empty list.
 *
 * ```ts no_run
 * import { attributesKey } from 'fino:opentelemetry/metrics';
 *
 * attributesKey({ b: 2, a: 1 }) === attributesKey({ a: 1, b: 2 }); // true
 * ```
 */
export function attributesKey(attributes: Attributes): string {
  return JSON.stringify(sortAttributeEntries(attributes));
}
/**
 * Collapses an instrument kind onto the aggregation it shares with a synchronous one.
 *
 * Observable counters and up-down counters aggregate identically to their
 * synchronous equivalents, so this maps `'observablecounter'` to `'counter'` and
 * `'observableupdowncounter'` to `'updowncounter'`. Any other kind is returned
 * unchanged, and a missing kind becomes `'record'`.
 *
 * ```ts no_run
 * import { normalizeMetricKind } from 'fino:opentelemetry/metrics';
 *
 * normalizeMetricKind('observablecounter'); // 'counter'
 * normalizeMetricKind(undefined);           // 'record'
 * ```
 */
export function normalizeMetricKind(kind: string | undefined): string {
  if (kind === 'observablecounter') return 'counter';
  if (kind === 'observableupdowncounter') return 'updowncounter';
  return kind || 'record';
}
/**
 * Produces a stable key identifying the instrument a record belongs to, ignoring attributes.
 *
 * Combines the scope name and version, the metric name, the normalized kind, and
 * the unit. All records from the same instrument share this key regardless of
 * their attribute sets, which is how the SDK discovers every series under an
 * instrument (for example, to zero the ones that dropped out). See
 * `metricSeriesKey` for the per-series key that also folds in attributes.
 *
 * ```ts no_run
 * import { metricInstrumentKey } from 'fino:opentelemetry/metrics';
 *
 * const key = metricInstrumentKey({ name: 'orders', kind: 'counter', unit: '1' });
 * ```
 */
export function metricInstrumentKey(metric: MetricRecord): string {
  return JSON.stringify([
    metric.scope?.name || '',
    metric.scope?.version || '',
    metric.name || '',
    normalizeMetricKind(metric.kind || 'record'),
    metric.unit || '',
  ]);
}
/**
 * Produces a stable key identifying a single time series — an instrument plus one attribute set.
 *
 * Extends `metricInstrumentKey` with the record's sorted attributes, so two
 * measurements collapse to the same key only when they share both the instrument
 * and every attribute value. This is the key `accumulateMetric` folds into, giving
 * one aggregate per distinct attribute combination.
 *
 * ```ts no_run
 * import { metricSeriesKey } from 'fino:opentelemetry/metrics';
 *
 * const key = metricSeriesKey({ name: 'orders', kind: 'counter', unit: '1', attributes: { store: 'eu' } });
 * ```
 */
export function metricSeriesKey(metric: MetricRecord): string {
  return JSON.stringify([
    metric.scope?.name || '',
    metric.scope?.version || '',
    metric.name || '',
    normalizeMetricKind(metric.kind || 'record'),
    metric.unit || '',
    sortAttributeEntries(metric.attributes || {}),
  ]);
}
function buildHistogramBuckets(bounds: number[], value: number): number[] {
  const bucketCounts = new Array(bounds.length + 1).fill(0);
  let index = bounds.findIndex((bound) => value <= bound);
  if (index === -1) index = bucketCounts.length - 1;
  bucketCounts[index] = 1;
  return bucketCounts;
}
function createExemplar(metric: MetricRecord): ExemplarRecord | null {
  if (!metric?.exemplarContext?.traceId || !metric?.exemplarContext?.spanId) return null;
  const numericValue = Number(metric.value || 0);
  return {
    timeUnixNano: metric.timeUnixNano || nowUnixNano(),
    traceId: metric.exemplarContext.traceId,
    spanId: metric.exemplarContext.spanId,
    value: numericValue,
    filteredAttributes: { ...(metric.attributes || {}) },
  };
}
function initializeAggregate(metric: MetricRecord): MetricRecord {
  const kind = normalizeMetricKind(metric.kind || 'record');
  const exemplar = createExemplar(metric);
  if (kind === 'counter') {
    return {
      ...cloneMetric(metric),
      kind: metric.kind || kind,
      aggregationKind: kind,
      value: Number(metric.value || 0),
      aggregationTemporality: 2,
      isMonotonic: true,
      exemplars: exemplar ? [exemplar] : [],
    };
  }
  if (kind === 'updowncounter') {
    return {
      ...cloneMetric(metric),
      kind: metric.kind || kind,
      aggregationKind: kind,
      value: Number(metric.value || 0),
      aggregationTemporality: 2,
      isMonotonic: false,
      exemplars: exemplar ? [exemplar] : [],
    };
  }
  if (kind === 'histogram') {
    const value = Number(metric.value || 0);
    const bounds =
      Array.isArray(metric.explicitBounds) && metric.explicitBounds.length > 0
        ? [...metric.explicitBounds]
        : [...DEFAULT_HISTOGRAM_BOUNDARIES];
    return {
      ...cloneMetric(metric),
      kind: metric.kind || kind,
      aggregationKind: kind,
      count: 1,
      sum: value,
      min: value,
      max: value,
      explicitBounds: bounds,
      bucketCounts: buildHistogramBuckets(bounds, value),
      aggregationTemporality: 2,
      exemplars: exemplar ? [exemplar] : [],
    };
  }
  return {
    ...cloneMetric(metric),
    kind: metric.kind || kind,
    aggregationKind: kind,
    exemplars: exemplar ? [exemplar] : [],
  };
}
/**
 * Folds one measurement into a running aggregate stored under a series key.
 *
 * This is the core reducer of the metrics SDK. On the first record for `key` it
 * seeds a fresh aggregate (from `initializeAggregate`): counters and up-down
 * counters start at their value with cumulative temporality, histograms start with
 * count 1 and the value placed in its bucket, gauges keep the last value. On
 * subsequent records it updates the existing aggregate in place — summing counter
 * values, accumulating histogram count/sum/min/max and bucket counts, or replacing
 * the value and timestamp for last-value kinds. Whenever a record carries an active
 * trace context, the latest exemplar replaces the aggregate's exemplar list.
 * Kind is resolved through `normalizeMetricKind`, so observable variants aggregate
 * like their synchronous counterparts. The input is cloned; the caller's record is
 * never mutated.
 *
 * ```ts no_run
 * import { accumulateMetric, metricSeriesKey, type MetricRecord } from 'fino:opentelemetry/metrics';
 *
 * const store = new Map<string, MetricRecord>();
 * const a = { name: 'orders', kind: 'counter', value: 1, attributes: { store: 'eu' } };
 * const b = { name: 'orders', kind: 'counter', value: 2, attributes: { store: 'eu' } };
 * accumulateMetric(store, metricSeriesKey(a), a);
 * accumulateMetric(store, metricSeriesKey(b), b); // aggregate value is now 3
 * ```
 */
export function accumulateMetric(
  store: Map<string, MetricRecord>,
  key: string,
  metric: MetricRecord,
): void {
  const normalized = {
    ...cloneMetric(metric),
    aggregationKind: normalizeMetricKind(metric.kind || metric.aggregationKind || 'record'),
  };
  const existing = store.get(key);
  if (!existing) {
    store.set(key, initializeAggregate(normalized));
    return;
  }
  const exemplar = createExemplar(normalized);
  const aggregationKind = existing.aggregationKind || normalized.aggregationKind;
  if (aggregationKind === 'counter' || aggregationKind === 'updowncounter') {
    existing.value = Number(existing.value || 0) + Number(normalized.value || 0);
  } else if (aggregationKind === 'histogram') {
    const value = Number(normalized.value || 0);
    existing.count = Number(existing.count || 0) + 1;
    existing.sum = Number(existing.sum || 0) + value;
    existing.min = typeof existing.min === 'number' ? Math.min(existing.min, value) : value;
    existing.max = typeof existing.max === 'number' ? Math.max(existing.max, value) : value;
    const buckets = buildHistogramBuckets(existing.explicitBounds || [], value);
    existing.bucketCounts = (existing.bucketCounts || []).map(
      (count, index) => Number(count || 0) + Number(buckets[index] || 0),
    );
  } else {
    if (normalized.value !== undefined) existing.value = normalized.value;
    if (normalized.timeUnixNano !== undefined) existing.timeUnixNano = normalized.timeUnixNano;
  }
  if (exemplar) existing.exemplars = [exemplar];
}
/**
 * Rewrites a metric record according to the configured views, returning a new record.
 *
 * Views customize how an instrument is exported. Each view whose `instrumentName`
 * matches (or is unset, matching all) is applied in order to a clone of the input:
 * `name` and `description` are renamed when set; `attributeKeys` drops all
 * attributes except the listed ones; and `aggregation` reshapes the record —
 * `'histogram'` converts it to a histogram, seeding buckets from the current value
 * against the view's `boundaries`; `'lastValue'` turns it into a gauge; and
 * `'sum'` turns it into a counter or, when `monotonic` is `false`, an up-down
 * counter. The original record is not mutated.
 *
 * ```ts no_run
 * import { applyMetricView, type MetricView } from 'fino:opentelemetry/metrics';
 *
 * const views: MetricView[] = [{
 *   instrumentName: 'http.duration',
 *   name: 'http.server.duration',
 *   aggregation: { type: 'histogram', boundaries: [10, 50, 100] },
 *   attributeKeys: ['route'],
 * }];
 * const out = applyMetricView({ name: 'http.duration', value: 42, attributes: { route: '/x', pid: 9 } }, views);
 * ```
 */
export function applyMetricView(metric: MetricRecord, views: MetricView[]): MetricRecord {
  let out = cloneMetric(metric);
  for (const view of views) {
    if (view.instrumentName && view.instrumentName !== out.name) continue;
    if (view.name) out.name = view.name;
    if (view.description) out.description = view.description;
    if (Array.isArray(view.attributeKeys)) {
      const filtered: Attributes = {};
      for (const key of view.attributeKeys) {
        if (Object.prototype.hasOwnProperty.call(out.attributes || {}, key))
          filtered[key] = out.attributes?.[key];
      }
      out.attributes = filtered;
    }
    if (view.aggregation?.type === 'histogram') {
      out.kind = 'histogram';
      out.explicitBounds = Array.isArray(view.aggregation.boundaries)
        ? [...view.aggregation.boundaries]
        : [];
      if (
        !Array.isArray(out.bucketCounts) ||
        out.bucketCounts.length !== out.explicitBounds.length + 1
      ) {
        const counts = new Array(out.explicitBounds.length + 1).fill(0);
        if (typeof out.value === 'number') {
          let index = out.explicitBounds.findIndex((bound) => out.value! <= bound);
          if (index === -1) index = counts.length - 1;
          counts[index] = 1;
          out.count = 1;
          out.sum = out.value;
          out.min = out.value;
          out.max = out.value;
        }
        out.bucketCounts = counts;
      }
    } else if (view.aggregation?.type === 'lastValue') {
      out.kind = 'gauge';
    } else if (view.aggregation?.type === 'sum') {
      out.kind = view.aggregation.monotonic === false ? 'updowncounter' : 'counter';
      out.isMonotonic = view.aggregation.monotonic !== false;
    }
  }
  return out;
}
const meterProviderContext = new Context<MeterProvider | null>('otel:meter-provider');
let defaultMeterProvider = new MeterProvider();
/**
 * Returns the meter provider in effect for the current context.
 *
 * Resolves to the provider bound by an enclosing `runWithMeterProvider` call if
 * one is active on the context, otherwise the process-wide default. There is
 * always a provider — a default `MeterProvider` exists from startup — so this
 * never returns null. This is the entry point most instrumentation uses.
 *
 * ```ts no_run
 * import { getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const meter = getMeterProvider().getMeter('my-lib');
 * ```
 */
export function getMeterProvider(): MeterProvider {
  return meterProviderContext.get() || defaultMeterProvider;
}
/**
 * Replaces the process-wide default meter provider.
 *
 * Installs `provider` as the fallback returned by `getMeterProvider()` whenever no
 * context-scoped provider is active. Call this once during SDK setup. It does not
 * affect a provider currently bound by `runWithMeterProvider`, which takes
 * precedence for the duration of that call.
 *
 * ```ts no_run
 * import { MeterProvider, setMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * setMeterProvider(new MeterProvider({ resource: { 'service.name': 'api' } }));
 * ```
 */
export function setMeterProvider(provider: MeterProvider): void {
  defaultMeterProvider = provider;
}
/**
 * Runs `fn` with `provider` as the active meter provider for the dynamic extent of the call.
 *
 * Binds `provider` on the context so any `getMeterProvider()` reached while `fn`
 * runs (including through awaited async work that stays on the context) sees it,
 * then restores the previous provider on return. Returns whatever `fn` returns.
 * Use it to route a subsystem's metrics through a distinct provider without
 * touching the global default.
 *
 * ```ts no_run
 * import { MeterProvider, runWithMeterProvider, getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * const scoped = new MeterProvider({ resource: { 'service.name': 'worker' } });
 * runWithMeterProvider(scoped, () => {
 *   getMeterProvider().getMeter('jobs').createCounter('done').add(1);
 * });
 * ```
 */
export function runWithMeterProvider<R>(provider: MeterProvider, fn: () => R): R {
  return meterProviderContext.runWithValue(provider, fn);
}
/**
 * Runs `fn` with the context-scoped meter provider explicitly cleared.
 *
 * Binds `null` on the context so `getMeterProvider()` falls back to the
 * process-wide default even inside an enclosing `runWithMeterProvider`. Useful to
 * punch out of a scoped provider for a region of code. Returns whatever `fn`
 * returns.
 *
 * ```ts no_run
 * import { runWithoutMeterProvider, getMeterProvider } from 'fino:opentelemetry/metrics';
 *
 * runWithoutMeterProvider(() => {
 *   getMeterProvider().getMeter('sys').createCounter('ticks').add(1); // uses the default provider
 * });
 * ```
 */
export function runWithoutMeterProvider<R>(fn: () => R): R {
  return meterProviderContext.runWithValue(null, fn);
}
