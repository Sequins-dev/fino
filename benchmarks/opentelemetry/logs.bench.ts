/**
* Benchmarks for fino:opentelemetry/logs
*
* Run with: cargo run -- bench benchmarks/opentelemetry/logs.bench.ts
*/
import { LogRecordBuilder, LoggerProvider, SeverityNumber } from 'fino:opentelemetry/logs';
import { bench } from 'fino:bench';
const provider = new LoggerProvider();
const logger = provider.getLogger('bench.logs');
bench('opentelemetry/logs', (b) => {
  b.measure('LoggerProvider construct', () => new LoggerProvider());
  b.measure('getLogger', () => provider.getLogger('bench.logs'));
  b.measure('LogRecordBuilder chain', () => new LogRecordBuilder().setSeverity('WARN', SeverityNumber.WARN).setTextBody('slow path').setAttributes({ route: '/orders' }));
  b.measure('emitRecord', () => logger.emitRecord({
    body: 'created order',
    severityText: 'INFO',
    severityNumber: SeverityNumber.INFO,
    attributes: { tenant: 'acme' }
  }));
});
