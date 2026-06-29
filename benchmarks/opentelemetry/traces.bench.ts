/**
 * Benchmarks for fino:opentelemetry/traces
 *
 * Run with: cargo run -- bench benchmarks/opentelemetry/traces.bench.ts
 */

import { TracerProvider, runWithActiveSpan } from 'fino:opentelemetry/traces';
import { bench } from 'fino:bench';

const provider = new TracerProvider();
const tracer = provider.getTracer('bench.traces');

bench('opentelemetry/traces', (b) => {
  b.measure('TracerProvider construct', () => new TracerProvider());
  b.measure('getTracer', () => provider.getTracer('bench.traces'));
  b.measure('start/end span', () => {
    const span = tracer.startSpan('bench.operation');
    span.setAttribute('route', '/orders');
    span.addEvent('validated');
    span.end({ status: { code: 'OK' } });
  });
  b.measure('runWithActiveSpan', () => {
    const span = tracer.startSpan('bench.active');
    runWithActiveSpan(span, () => undefined);
    span.end();
  });
});
