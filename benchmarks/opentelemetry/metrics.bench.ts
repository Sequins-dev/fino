/**
 * Benchmarks for fino:opentelemetry/metrics
 *
 * Run with: cargo run -- bench benchmarks/opentelemetry/metrics.bench.ts
 */
import { MeterProvider, attributesKey } from 'fino:opentelemetry/metrics';
import { bench } from 'fino:bench';
const provider = new MeterProvider();
const meter = provider.getMeter('bench.metrics');
const counter = meter.createCounter('requests', { unit: '1' });
const gauge = meter.createGauge('queue.depth', { unit: '1' });
const histogram = meter.createHistogram('latency.ms', { unit: 'ms' });
bench('opentelemetry/metrics', (b) => {
  b.measure('MeterProvider construct', () => new MeterProvider());
  b.measure('getMeter', () => provider.getMeter('bench.metrics'));
  b.measure('attributesKey', () =>
    attributesKey({
      route: '/orders',
      status: 200,
    }),
  );
  b.measure('counter.add', () => counter.add(1, { route: '/orders' }));
  b.measure('gauge.record', () => gauge.record(12, { queue: 'default' }));
  b.measure('histogram.record', () => histogram.record(42, { route: '/orders' }));
});
