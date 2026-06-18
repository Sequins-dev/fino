import { describe, it } from 'fino:test/test';
import {
  createConsoleSink,
  createJsonSink,
  createLogger,
  createOtelSink,
  getLogContext,
  runWithLogContext,
  subscribeLogs,
} from 'fino:log';
import { topic } from 'fino:context/topic';
import { LoggerProvider, runWithLoggerProvider } from 'fino:opentelemetry/logs';

describe('fino:log', () => {
  it('publishes records to subscribers without installing a default sink', (t) => {
    const records: unknown[] = [];
    const handle = subscribeLogs((record) => records.push(record));
    const logger = createLogger({ name: 'test.logger' });

    logger.info('started', { port: 3000 });
    handle.dispose();

    t.equal(records.length, 1, 'subscriber receives one record');
    const record = records[0] as Record<string, unknown>;
    t.equal(record.level, 'info', 'level is normalized');
    t.equal(record.logger, 'test.logger', 'logger name is included');
    t.equal(record.message, 'started', 'message is included');
    t.deepEqual(record.fields, { port: 3000 }, 'fields are included');
    t.ok(typeof record.timestamp === 'string', 'timestamp is present');
  });

  it('filters by level and merges async log context into records', async (t) => {
    const records: Array<Record<string, unknown>> = [];
    const handle = subscribeLogs((record) => records.push(record as Record<string, unknown>));
    const logger = createLogger({ name: 'ctx.logger', level: 'warn' });

    await runWithLogContext({ requestId: 'req-1' }, async () => {
      await Promise.resolve();
      logger.info('hidden');
      logger.error(new Error('boom'), { code: 'E_TEST' });
    });
    handle.dispose();

    t.equal(records.length, 1, 'only error passes warn level');
    t.equal(records[0].message, 'boom', 'error message is normalized');
    t.deepEqual(records[0].context, { requestId: 'req-1' }, 'context is propagated');
    t.deepEqual(records[0].fields, { code: 'E_TEST' }, 'fields are preserved');
    t.ok(records[0].error && typeof records[0].error === 'object', 'error details are attached');
  });

  it('returns a defensive copy of the active log context', async (t) => {
    await runWithLogContext({ requestId: 'req-copy' }, async () => {
      const context = getLogContext();
      context.requestId = 'mutated';

      t.deepEqual(getLogContext(), { requestId: 'req-copy' }, 'mutating returned context does not alter active context');
    });
    t.deepEqual(getLogContext(), {}, 'context clears after scope');
  });

  it('creates child loggers with merged names, levels, and context', (t) => {
    const records: Array<Record<string, unknown>> = [];
    const handle = subscribeLogs((record) => records.push(record as Record<string, unknown>));
    const logger = createLogger({ name: 'root', level: 'warn', context: { service: 'api' } })
      .child({ name: 'worker', level: 'debug', shard: 'a' });

    logger.info('visible');
    handle.dispose();

    t.equal(records.length, 1, 'child level overrides parent level');
    t.equal(records[0].logger, 'root.worker', 'child name appends to parent name');
    t.deepEqual(records[0].context, { service: 'api', shard: 'a' }, 'child context merges with parent context');
  });

  it('formats records through an explicit JSON sink', (t) => {
    const lines: string[] = [];
    const sink = createJsonSink({ write(line) { lines.push(line); } });
    const logger = createLogger({ name: 'json.logger' });

    logger.warn('careful', { retry: true });
    sink.dispose();

    t.equal(lines.length, 1, 'json sink writes one line');
    const parsed = JSON.parse(lines[0]);
    t.equal(parsed.level, 'warn', 'json includes level');
    t.equal(parsed.logger, 'json.logger', 'json includes logger');
    t.deepEqual(parsed.fields, { retry: true }, 'json includes fields');
  });

  it('filters console sinks and stops writing after dispose', (t) => {
    const lines: string[] = [];
    const sink = createConsoleSink({ level: 'warn', write(line) { lines.push(line); } });
    const logger = createLogger({ name: 'console.logger' });

    logger.info('hidden');
    logger.warn('visible', { retry: true });
    sink.dispose();
    logger.error('after dispose');

    t.equal(lines.length, 1, 'console sink writes only matching records before dispose');
    t.ok(lines[0]!.includes('WARN console.logger visible'), 'console sink formats text record');
    t.ok(lines[0]!.includes('"retry":true'), 'console sink includes fields');
  });

  it('forwards records through the OpenTelemetry sink', (t) => {
    const records: Array<Record<string, unknown>> = [];
    const handle = topic<Record<string, unknown>>('otel:log:record').subscribe((record) => records.push(record));
    const provider = new LoggerProvider();

    runWithLoggerProvider(provider, () => {
      const sink = createOtelSink();
      createLogger({ name: 'otel.logger' }).error(new Error('boom'), { code: 'E_TEST' });
      sink.dispose();
    });
    handle.dispose();

    t.equal(records.length, 1, 'otel sink emits one OTel log record');
    t.equal(records[0].body, 'boom', 'otel body uses log message');
    t.equal(records[0].severityText, 'ERROR', 'otel severity text maps from log level');
    t.equal((records[0].attributes as Record<string, unknown>).code, 'E_TEST', 'otel attributes include fields');
    t.equal((records[0].attributes as Record<string, unknown>)['exception.message'], 'boom', 'otel attributes include error details');
  });
});
