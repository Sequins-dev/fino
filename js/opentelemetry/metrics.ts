/**
* fino:opentelemetry/metrics - meter providers, instruments, and metric records.
*
* This module contains the public metric signal API. Use it to create counters,
* gauges, histograms, and observable instruments, or to describe metric records
* delivered to SDK metric readers and exporters.
*
* Instrument and meter names must be non-empty strings. Synchronous instruments
* publish observations immediately. Observable instruments register callbacks
* that the SDK collects during flush or periodic reader cycles. Histograms use
* OpenTelemetry default explicit bucket boundaries unless custom advice is
* supplied when the instrument is created.
*
* ```typescript no_run
* import { getMeterProvider } from 'fino:opentelemetry/metrics';
*
* const meter = getMeterProvider().getMeter('orders');
* const counter = meter.createCounter('orders.created', { unit: '1' });
* counter.add(1, { tenant: 'acme' });
* ```
*
* See OpenTelemetry metrics:
* https://opentelemetry.io/docs/concepts/signals/metrics/
*/
export { Counter, Gauge, Histogram, HistogramInstrument, Meter, MeterProvider, ObservableCounter, ObservableGauge, ObservableUpDownCounter, UpDownCounter, accumulateMetric, applyMetricView, attributesKey, cloneMetric, getMeterProvider, metricInstrumentKey, metricSeriesKey, normalizeMetricKind, runWithMeterProvider, runWithoutMeterProvider, setMeterProvider, zeroMetric } from '../internal/opentelemetry/metrics.ts';
export type { ExemplarRecord, ExponentialBuckets, MetricAggregationType, MetricExemplarContext, MetricInstrumentOptions, MetricRecord, MetricTemporality, MetricView, ObservableMetricObservation, ObservableMetricRegistration, QuantileValueRecord } from '../internal/opentelemetry/common.ts';
