import { describe, it } from 'fino:test/test';
import {
  createJsonSink,
  createLogger,
  runWithLogContext,
  subscribeLogs,
} from 'fino:log';

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
});
