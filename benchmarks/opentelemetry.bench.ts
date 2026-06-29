/**
* Benchmarks for fino:opentelemetry
*
* Run with: cargo run -- bench benchmarks/opentelemetry.bench.ts
*/
import { Baggage, BatchSpanProcessor, FetchInstrumentation, HttpServerInstrumentation, InMemoryExporter, OtelSDK, Resource, TracerProvider, W3CTraceContextPropagator, defaultCarrierApiFor, normalizeResource, otelRuntimeEvent, otelRuntimeTopic, randomHex } from 'fino:opentelemetry';
import { bench } from 'fino:bench';
import { topic } from 'fino:context/topic';
const traceContext = {
  traceId: '0'.repeat(31) + '1',
  spanId: '0'.repeat(15) + '1',
  traceFlags: 1
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
bench('opentelemetry runtime instrumentation', (b) => {
  b.measure('http server runtime span pair', async () => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new HttpServerInstrumentation()]
    }).start();
    try {
      topic(otelRuntimeTopic('http.server', 'request', 'start')).publish(otelRuntimeEvent('http.server', 'request', 'start', {
        requestId: 'bench-http-server',
        method: 'GET',
        route: '/bench/:id',
        url: 'http://127.0.0.1/bench/1',
        headers: {},
        timeUnixNano: 100
      }));
      topic(otelRuntimeTopic('http.server', 'request', 'end')).publish(otelRuntimeEvent('http.server', 'request', 'end', {
        requestId: 'bench-http-server',
        statusCode: 200,
        timeUnixNano: 200
      }));
      await sdk.flush();
    } finally {
      await sdk.shutdown();
    }
  });
  b.measure('fetch runtime failure span', async () => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      instrumentations: [new FetchInstrumentation()]
    }).start();
    try {
      topic(otelRuntimeTopic('fetch', 'request', 'start')).publish(otelRuntimeEvent('fetch', 'request', 'start', {
        requestId: 'bench-fetch',
        method: 'POST',
        url: 'https://api.example.test/orders',
        headers: {},
        timeUnixNano: 300
      }));
      topic(otelRuntimeTopic('fetch', 'request', 'error')).publish(otelRuntimeEvent('fetch', 'request', 'error', {
        requestId: 'bench-fetch',
        error: new Error('connection refused'),
        timeUnixNano: 350
      }));
      await sdk.flush();
    } finally {
      await sdk.shutdown();
    }
  });
});
