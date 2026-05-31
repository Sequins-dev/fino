/**
 * internal/opentelemetry/metrics — internal runtime module.
 *
 * 
 * @internal
 */

import { Context } from '../../context/index.mts';
import { Topic, topic } from '../../context/topic.mts';
import {
  BaseProvider,
  OTEL_SCHEMA_VERSION,
  normalizeScope,
  nowUnixNano,
  topicNames,
  requireNonEmptyName,
} from './common.mts';
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
} from './common.mts';
import { getActiveSpanContext } from './traces.mts';

export class MeterProvider extends BaseProvider {
  getMeter(
    name: string,
    version?: string,
    options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number },
  ): Meter {
    return new Meter(this, normalizeScope(name, version, options?.schemaUrl, options?.attributes, options?.droppedAttributesCount));
  }
}

export class Counter {
  #meter: Meter;
  #name: string;
  #options: MetricInstrumentOptions;

  constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {}) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
  }

  add(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, { ...this.#options, attributes, kind: 'counter' });
  }
}

export class UpDownCounter {
  #meter: Meter;
  #name: string;
  #options: MetricInstrumentOptions;

  constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {}) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
  }

  add(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, { ...this.#options, attributes, kind: 'updowncounter' });
  }
}

// OTel spec default explicit bucket boundaries.
const DEFAULT_HISTOGRAM_BOUNDARIES = [0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000];

export class HistogramInstrument {
  #meter: Meter;
  #name: string;
  #options: MetricInstrumentOptions;
  #boundaries: number[];

  constructor(meter: Meter, name: string, options: MetricInstrumentOptions & { advice?: { explicitBucketBoundaries?: number[] } } = {}) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
    this.#boundaries = Array.isArray(options.advice?.explicitBucketBoundaries)
      ? [...options.advice!.explicitBucketBoundaries!]
      : DEFAULT_HISTOGRAM_BOUNDARIES;
  }

  record(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, { ...this.#options, attributes, kind: 'histogram', explicitBounds: this.#boundaries } as MetricInstrumentOptions & { explicitBounds?: number[] });
  }
}

export class ObservableGauge {
  #handle: { dispose(): void } | null;

  constructor(handle: { dispose(): void }) {
    this.#handle = handle;
  }

  dispose(): void {
    this.#handle?.dispose?.();
  }
}

export class Gauge {
  #meter: Meter;
  #name: string;
  #options: MetricInstrumentOptions;

  constructor(meter: Meter, name: string, options: MetricInstrumentOptions = {}) {
    this.#meter = meter;
    this.#name = requireNonEmptyName('metric instrument', name);
    this.#options = options;
  }

  record(value: number, attributes: Attributes = {}): void {
    this.#meter.record(this.#name, value, { ...this.#options, attributes, kind: 'gauge' });
  }
}

export class ObservableCounter extends ObservableGauge {}
export class ObservableUpDownCounter extends ObservableGauge {}
export const Histogram = HistogramInstrument;

export class Meter {
  #provider: MeterProvider;
  #scope: ScopeInfo;
  // Pre-cached topic sets keyed by `${instrumentName}:${kind}`, plus the shared record topic.
  #topicsByKey: Map<string, Array<Topic<MetricRecord>>>;
  #recordTopic: Topic<MetricRecord>;

  constructor(provider: MeterProvider, scope: ScopeInfo) {
    this.#provider = provider;
    this.#scope = scope;
    this.#topicsByKey = new Map();
    this.#recordTopic = topic<MetricRecord>('otel:metric:record');
  }

  #getTopics(instrumentName: string, kind: string): Array<Topic<MetricRecord>> {
    const key = `${instrumentName}:${kind}`;
    let topics = this.#topicsByKey.get(key);
    if (!topics) {
      topics = topicNames('metric', this.#scope, instrumentName, kind).map((name) => topic<MetricRecord>(name));
      this.#topicsByKey.set(key, topics);
    }
    return topics;
  }

  record(name: string, value: number, options: MetricInstrumentOptions & { explicitBounds?: number[] } = {}): void {
    const metricName = requireNonEmptyName('metric instrument', name);
    const activeContext = getActiveSpanContext();
    const exemplarContext: MetricExemplarContext | null = activeContext
      ? {
          ...(activeContext.traceId ? { traceId: activeContext.traceId } : {}),
          ...(activeContext.spanId ? { spanId: activeContext.spanId } : {}),
          ...(activeContext.traceFlags !== undefined ? { traceFlags: activeContext.traceFlags } : {}),
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

  createCounter(name: string, options: MetricInstrumentOptions = {}): Counter {
    return new Counter(this, name, options);
  }

  createUpDownCounter(name: string, options: MetricInstrumentOptions = {}): UpDownCounter {
    return new UpDownCounter(this, name, options);
  }

  createHistogram(name: string, options: MetricInstrumentOptions & { advice?: { explicitBucketBoundaries?: number[] } } = {}): HistogramInstrument {
    return new HistogramInstrument(this, name, options);
  }

  createGauge(name: string, options: MetricInstrumentOptions = {}): Gauge {
    return new Gauge(this, name, options);
  }

  createObservableCounter(name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}): ObservableCounter {
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
        topic<ObservableMetricRegistration>('otel:metric:observable:unregister').publish(registration);
      },
    });
  }

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
        topic<ObservableMetricRegistration>('otel:metric:observable:unregister').publish(registration);
      },
    });
  }

  createObservableGauge(name: string, callback: ObservableMetricRegistration['callback'], options: MetricInstrumentOptions = {}): ObservableGauge {
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
        topic<ObservableMetricRegistration>('otel:metric:observable:unregister').publish(registration);
      },
    });
  }
}

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
            ...(exemplar.filteredAttributes ? { filteredAttributes: { ...exemplar.filteredAttributes } } : {}),
          })),
        }
      : metric.exemplars !== undefined
        ? { exemplars: metric.exemplars }
        : {}),
  };
}

export function zeroMetric(metric: MetricRecord): MetricRecord {
  const clone = cloneMetric(metric);
  if (typeof clone.value === 'number') clone.value = 0;
  if (typeof clone.count === 'number') clone.count = 0;
  if (typeof clone.sum === 'number') clone.sum = 0;
  if (typeof clone.min === 'number') clone.min = 0;
  if (typeof clone.max === 'number') clone.max = 0;
  if (Array.isArray(clone.bucketCounts)) clone.bucketCounts = clone.bucketCounts.map(() => 0);
  if (Array.isArray(clone.quantileValues)) clone.quantileValues = clone.quantileValues.map((value) => ({ ...value, value: 0 }));
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

export function attributesKey(attributes: Attributes): string {
  return JSON.stringify(sortAttributeEntries(attributes));
}

export function normalizeMetricKind(kind: string | undefined): string {
  if (kind === 'observablecounter') return 'counter';
  if (kind === 'observableupdowncounter') return 'updowncounter';
  return kind || 'record';
}

export function metricInstrumentKey(metric: MetricRecord): string {
  return JSON.stringify([metric.scope?.name || '', metric.scope?.version || '', metric.name || '', normalizeMetricKind(metric.kind || 'record'), metric.unit || '']);
}

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
    return { ...cloneMetric(metric), kind: metric.kind || kind, aggregationKind: kind, value: Number(metric.value || 0), aggregationTemporality: 2, isMonotonic: true, exemplars: exemplar ? [exemplar] : [] };
  }
  if (kind === 'updowncounter') {
    return { ...cloneMetric(metric), kind: metric.kind || kind, aggregationKind: kind, value: Number(metric.value || 0), aggregationTemporality: 2, isMonotonic: false, exemplars: exemplar ? [exemplar] : [] };
  }
  if (kind === 'histogram') {
    const value = Number(metric.value || 0);
    const bounds = Array.isArray(metric.explicitBounds) && metric.explicitBounds.length > 0
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

export function accumulateMetric(store: Map<string, MetricRecord>, key: string, metric: MetricRecord): void {
  const normalized = { ...cloneMetric(metric), aggregationKind: normalizeMetricKind(metric.kind || metric.aggregationKind || 'record') };
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
    existing.bucketCounts = (existing.bucketCounts || []).map((count, index) => Number(count || 0) + Number(buckets[index] || 0));
  } else {
    if (normalized.value !== undefined) existing.value = normalized.value;
    if (normalized.timeUnixNano !== undefined) existing.timeUnixNano = normalized.timeUnixNano;
  }
  if (exemplar) existing.exemplars = [exemplar];
}

export function applyMetricView(metric: MetricRecord, views: MetricView[]): MetricRecord {
  let out = cloneMetric(metric);
  for (const view of views) {
    if (view.instrumentName && view.instrumentName !== out.name) continue;
    if (view.name) out.name = view.name;
    if (view.description) out.description = view.description;
    if (Array.isArray(view.attributeKeys)) {
      const filtered: Attributes = {};
      for (const key of view.attributeKeys) {
        if (Object.prototype.hasOwnProperty.call(out.attributes || {}, key)) filtered[key] = out.attributes?.[key];
      }
      out.attributes = filtered;
    }
    if (view.aggregation?.type === 'histogram') {
      out.kind = 'histogram';
      out.explicitBounds = Array.isArray(view.aggregation.boundaries) ? [...view.aggregation.boundaries] : [];
      if (!Array.isArray(out.bucketCounts) || out.bucketCounts.length !== out.explicitBounds.length + 1) {
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

export function getMeterProvider(): MeterProvider {
  return meterProviderContext.get() || defaultMeterProvider;
}

export function setMeterProvider(provider: MeterProvider): void {
  defaultMeterProvider = provider;
}

export function runWithMeterProvider<R>(provider: MeterProvider, fn: () => R): R {
  return meterProviderContext.runWithValue(provider, fn);
}

export function runWithoutMeterProvider<R>(fn: () => R): R {
  return meterProviderContext.runWithValue(null, fn);
}
