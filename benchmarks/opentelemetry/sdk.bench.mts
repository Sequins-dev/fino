/**
 * Benchmarks for fino:opentelemetry/sdk
 *
 * Run with: cargo run -- bench benchmarks/opentelemetry/sdk.bench.mts
 */

import { BatchLogRecordProcessor, BatchSpanProcessor, InMemoryExporter, ManualMetricReader, OtelSDK, Resource } from 'fino:opentelemetry/sdk';
import { bench } from 'fino:bench';

bench('opentelemetry/sdk', (b) => {
  b.measure('InMemoryExporter construct', () => new InMemoryExporter());
  b.measure('Resource construct', () => new Resource({ 'service.name': 'bench' }));
  b.measure('BatchSpanProcessor construct', () => new BatchSpanProcessor(new InMemoryExporter()));
  b.measure('BatchLogRecordProcessor construct', () => new BatchLogRecordProcessor(new InMemoryExporter()));
  b.measure('ManualMetricReader construct', () => new ManualMetricReader(new InMemoryExporter()));
  b.measure('OtelSDK construct', () => new OtelSDK({
    resource: new Resource({ 'service.name': 'bench' }),
    exporters: [new InMemoryExporter()],
  }));
});
