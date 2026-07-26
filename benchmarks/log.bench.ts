/**
 * Benchmarks for fino:log
 *
 * Run with: cargo run -- bench benchmarks/log.bench.ts
 */
import {
  createConsoleSink,
  createJsonSink,
  createLogger,
  createOtelSink,
  runWithLogContext,
} from 'fino:log';
import { bench } from 'fino:bench';
import { LoggerProvider, runWithLoggerProvider } from 'fino:opentelemetry/logs';
const logger = createLogger({
  name: 'bench',
  level: 'fatal',
  context: { component: 'bench' },
});
const sinkLogger = createLogger({
  name: 'bench.sink',
  level: 'debug',
  context: { component: 'bench' },
});
bench('log', (b) => {
  b.measure('createLogger', () => createLogger({ name: 'bench.child' }));
  b.measure('filtered debug log', () => logger.debug('not emitted'));
  b.measure('runWithLogContext', () => runWithLogContext({ requestId: 'abc' }, () => undefined));
});
bench('log sinks', (b) => {
  b.measure('json sink write batch', () => {
    const lines: string[] = [];
    const sink = createJsonSink({
      level: 'info',
      write(line) {
        lines.push(line);
      },
    });
    for (let i = 0; i < 16; i++) sinkLogger.info('json sink event', { index: i });
    sink.dispose();
  });
  b.measure('console sink format batch', () => {
    const lines: string[] = [];
    const sink = createConsoleSink({
      level: 'debug',
      write(line) {
        lines.push(line);
      },
    });
    for (let i = 0; i < 16; i++) sinkLogger.warn('console sink event', { index: i });
    sink.dispose();
  });
  b.measure('otel sink forwarding batch', () => {
    const provider = new LoggerProvider();
    return runWithLoggerProvider(provider, () => {
      const sink = createOtelSink({ level: 'info' });
      for (let i = 0; i < 16; i++) sinkLogger.error('otel sink event', { index: i });
      sink.dispose();
    });
  });
  b.measure('sink level filtering', () => {
    let writes = 0;
    const sink = createJsonSink({
      level: 'fatal',
      write() {
        writes++;
      },
    });
    for (let i = 0; i < 16; i++) sinkLogger.warn('filtered sink event', { index: i });
    sinkLogger.fatal('visible sink event');
    sink.dispose();
    return writes;
  });
});
