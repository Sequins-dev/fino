/**
 * Benchmarks for fino:opentelemetry
 *
 * Run with: cargo run -- bench benchmarks/opentelemetry.bench.mts
 */

import {
  Baggage,
  Resource,
  TracerProvider,
  W3CTraceContextPropagator,
  defaultCarrierApiFor,
  normalizeResource,
  randomHex,
} from 'fino:opentelemetry';
import { bench } from 'fino:bench';

const traceContext = {
  traceId: '0'.repeat(31) + '1',
  spanId: '0'.repeat(15) + '1',
  traceFlags: 1,
};

bench('opentelemetry core', (b) => {
  b.measure('Resource normalize', () => normalizeResource(new Resource({ 'service.name': 'fino' })));
  b.measure('Baggage set/get', () => new Baggage().set('tenant', 'bench').get('tenant'));
  b.measure('randomHex', () => randomHex(16));
});

bench('opentelemetry propagation', (b) => {
  const propagator = new W3CTraceContextPropagator();
  b.measure('inject traceparent', () => {
    const carrier: Record<string, string> = {};
    propagator.inject(carrier, traceContext);
  });
  b.measure('carrier API lookup', () => defaultCarrierApiFor({}));
});

bench('opentelemetry providers', (b) => {
  b.measure('TracerProvider construct', () => new TracerProvider());
});
