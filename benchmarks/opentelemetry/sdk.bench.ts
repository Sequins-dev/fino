/**
 * Benchmarks for fino:opentelemetry/sdk
 *
 * Run with: cargo run -- bench benchmarks/opentelemetry/sdk.bench.ts
 */
import {
  BatchLogRecordProcessor,
  BatchSpanProcessor,
  InMemoryExporter,
  ManualMetricReader,
  OtelSDK,
  PeriodicMetricReader,
  Resource,
} from 'fino:opentelemetry/sdk';
import { bench } from 'fino:bench';
import type { ExportResult, LogRecord, MetricRecord, SpanRecord } from 'fino:opentelemetry/sdk';
const spanRecord: SpanRecord = {
  name: 'bench.span',
  kind: 'internal',
  traceId: '0'.repeat(31) + '1',
  spanId: '0'.repeat(15) + '1',
  startTimeUnixNano: 100,
  endTimeUnixNano: 200,
  attributes: {
    route: '/bench',
    tenant: 'acme',
  },
  scope: { name: 'bench.sdk' },
};
const logRecord: LogRecord = {
  body: 'bench log',
  severityText: 'INFO',
  severityNumber: 9,
  timeUnixNano: 100,
  attributes: {
    route: '/bench',
    tenant: 'acme',
  },
  scope: { name: 'bench.sdk' },
};
const metricRecord: MetricRecord = {
  name: 'bench.requests',
  kind: 'counter',
  value: 1,
  unit: '1',
  attributes: { route: '/bench' },
  scope: { name: 'bench.sdk' },
};
class FailingExporter {
  async exportSpans(_spans: SpanRecord[]): Promise<ExportResult> {
    return { code: 'failure' };
  }
  async exportLogs(_logs: LogRecord[]): Promise<ExportResult> {
    return { code: 'failure' };
  }
  async exportMetrics(_metrics: MetricRecord[]): Promise<ExportResult> {
    return { code: 'failure' };
  }
}
bench('opentelemetry/sdk', (b) => {
  b.measure('InMemoryExporter construct', () => new InMemoryExporter());
  b.measure('Resource construct', () => new Resource({ 'service.name': 'bench' }));
  b.measure('BatchSpanProcessor construct', () => new BatchSpanProcessor(new InMemoryExporter()));
  b.measure(
    'BatchLogRecordProcessor construct',
    () => new BatchLogRecordProcessor(new InMemoryExporter()),
  );
  b.measure('ManualMetricReader construct', () => new ManualMetricReader(new InMemoryExporter()));
  b.measure(
    'OtelSDK construct',
    () =>
      new OtelSDK({
        resource: new Resource({ 'service.name': 'bench' }),
        exporters: [new InMemoryExporter()],
      }),
  );
});
bench('opentelemetry/sdk batching and backpressure', (b) => {
  b.measure('span processor queue pressure', async () => {
    const exporter = new InMemoryExporter();
    const processor = new BatchSpanProcessor(exporter, {
      maxQueueSize: 16,
      maxExportBatchSize: 4,
      scheduledDelayMillis: 0,
    });
    for (let i = 0; i < 64; i++) {
      processor.onEnd({
        ...spanRecord,
        spanId: String(i).padStart(16, '0'),
      });
    }
    await processor.forceFlush();
    await processor.shutdown();
  });
  b.measure('log processor queue pressure', async () => {
    const exporter = new InMemoryExporter();
    const processor = new BatchLogRecordProcessor(exporter, {
      maxQueueSize: 16,
      maxExportBatchSize: 4,
      scheduledDelayMillis: 0,
      attributeCountLimit: 4,
      attributeValueLengthLimit: 32,
    });
    for (let i = 0; i < 64; i++) {
      processor.onEmit({
        ...logRecord,
        body: `bench log ${i}`,
      });
    }
    await processor.forceFlush();
    await processor.shutdown();
  });
  b.measure('manual metric reader collect/reset', async () => {
    const reader = new ManualMetricReader({ temporality: 'delta' });
    for (let i = 0; i < 64; i++) {
      reader.receive([
        {
          ...metricRecord,
          value: i,
        },
      ]);
      reader.collect();
    }
    await reader.shutdown();
  });
});
bench('opentelemetry/sdk exporter failure paths', (b) => {
  b.measure('failed span export flush', async () => {
    const processor = new BatchSpanProcessor(new FailingExporter(), {
      maxQueueSize: 16,
      maxExportBatchSize: 4,
      scheduledDelayMillis: 0,
    });
    for (let i = 0; i < 16; i++)
      processor.onEnd({
        ...spanRecord,
        spanId: String(i).padStart(16, '0'),
      });
    await processor.forceFlush();
    await processor.shutdown();
  });
  b.measure('failed log export flush', async () => {
    const processor = new BatchLogRecordProcessor(new FailingExporter(), {
      maxQueueSize: 16,
      maxExportBatchSize: 4,
      scheduledDelayMillis: 0,
    });
    for (let i = 0; i < 16; i++)
      processor.onEmit({
        ...logRecord,
        body: `failed ${i}`,
      });
    await processor.forceFlush();
    await processor.shutdown();
  });
  b.measure('sdk shutdown drains all signals', async () => {
    const exporter = new InMemoryExporter();
    const sdk = new OtelSDK({
      spanProcessors: [new BatchSpanProcessor(exporter, { scheduledDelayMillis: 0 })],
      logRecordProcessors: [new BatchLogRecordProcessor(exporter, { scheduledDelayMillis: 0 })],
      metricReaders: [new PeriodicMetricReader(exporter, { intervalMs: 0 })],
    }).start();
    sdk.recordSpan(spanRecord);
    sdk.recordLog(logRecord);
    sdk.recordMetric(metricRecord);
    await sdk.shutdown();
  });
});
