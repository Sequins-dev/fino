import { describe, it } from 'fino:test/test';
import { createConsoleSink, createJsonSink, createLogger, createOtelSink, getLogContext, runWithLogContext, subscribeLogs, withLogContext } from 'fino:log';
import { topic } from 'fino:context/topic';
import { LoggerProvider, runWithLoggerProvider } from 'fino:opentelemetry/logs';
import { Process, execPath } from 'fino:process';
import { TracerProvider, runWithActiveSpan } from 'fino:opentelemetry/traces';
const decoder = new TextDecoder();
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
async function readAll(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return decoder.decode(concatBytes(chunks));
}
async function runFixture(mode: string): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
}> {
  const proc = new Process(execPath, ['./tests/fixtures/log-sink-routing.ts', mode]);
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait()
  ]);
  return {
    stdout,
    stderr,
    code: result.code
  };
}
describe('fino:log', () => {
  it('publishes records to subscribers without installing a default sink', (t) => {
    const records: unknown[] = [];
    const handle = subscribeLogs((record) => records.push(record));
    const logger = createLogger({ name: 'test.logger' });
    logger.info('started', { port: 3e3 });
    handle.dispose();
    t.equal(records.length, 1, 'subscriber receives one record');
    const record = records[0] as Record<string, unknown>;
    t.equal(record.level, 'info', 'level is normalized');
    t.equal(record.logger, 'test.logger', 'logger name is included');
    t.equal(record.message, 'started', 'message is included');
    t.deepEqual(record.fields, { port: 3e3 }, 'fields are included');
    t.ok(typeof record.timestamp === 'string', 'timestamp is present');
  });
  it('filters by level and merges async log context into records', async (t) => {
    const records: Array<Record<string, unknown>> = [];
    const handle = subscribeLogs((record) => records.push(record as Record<string, unknown>));
    const logger = createLogger({
      name: 'ctx.logger',
      level: 'warn'
    });
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
  it('returns a defensive copy of the active log context', (t) => {
    {
      using scope = withLogContext({ requestId: 'req-copy' });
      const context = getLogContext();
      context.requestId = 'mutated';
      t.deepEqual(getLogContext(), { requestId: 'req-copy' }, 'mutating returned context does not alter active context');
    }
    t.deepEqual(getLogContext(), {}, 'context clears after scope');
  });
  it('restores nested log context when using scopes are disposed', (t) => {
    {
      using outer = withLogContext({ requestId: 'outer', tenant: 'acme' });
      t.deepEqual(getLogContext(), { requestId: 'outer', tenant: 'acme' }, 'outer scope is active');
      {
        using inner = withLogContext({ requestId: 'inner', route: '/health' });
        t.deepEqual(getLogContext(), { requestId: 'inner', tenant: 'acme', route: '/health' }, 'inner scope merges over outer');
      }
      t.deepEqual(getLogContext(), { requestId: 'outer', tenant: 'acme' }, 'disposing inner restores outer');
    }
    t.deepEqual(getLogContext(), {}, 'disposing outer clears context');
  });
  it('creates child loggers with merged names, levels, and context', (t) => {
    const records: Array<Record<string, unknown>> = [];
    const handle = subscribeLogs((record) => records.push(record as Record<string, unknown>));
    const logger = createLogger({
      name: 'root',
      level: 'warn',
      context: { service: 'api' }
    }).child({
      name: 'worker',
      level: 'debug',
      shard: 'a'
    });
    logger.info('visible');
    handle.dispose();
    t.equal(records.length, 1, 'child level overrides parent level');
    t.equal(records[0].logger, 'root.worker', 'child name appends to parent name');
    t.deepEqual(records[0].context, {
      service: 'api',
      shard: 'a'
    }, 'child context merges with parent context');
  });
  it('formats records through an explicit JSON sink', (t) => {
    const lines: string[] = [];
    const sink = createJsonSink({ write(line) {
      lines.push(line);
    } });
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
    const sink = createConsoleSink({
      level: 'warn',
      write(line) {
        lines.push(line);
      }
    });
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
  it('publishes records on broad, per-level, and per-logger topics', (t) => {
    const broad: unknown[] = [];
    const level: unknown[] = [];
    const loggerTopic: unknown[] = [];
    const broadHandle = topic('fino:log').subscribe((record) => broad.push(record));
    const levelHandle = topic('fino:log:warn').subscribe((record) => level.push(record));
    const loggerHandle = topic('fino:log:topic.logger').subscribe((record) => loggerTopic.push(record));
    createLogger({ name: 'topic.logger' }).warn('topic message');
    broadHandle.dispose();
    levelHandle.dispose();
    loggerHandle.dispose();
    t.equal(broad.length, 1, 'broad topic receives record');
    t.equal(level.length, 1, 'per-level topic receives record');
    t.equal(loggerTopic.length, 1, 'per-logger topic receives record');
    t.equal(broad[0], level[0], 'per-level topic receives same record object');
    t.equal(broad[0], loggerTopic[0], 'per-logger topic receives same record object');
  });
  it('validates logger names and levels', (t) => {
    t.throws(() => createLogger({ name: '' }), /non-empty string/, 'empty name is rejected');
    t.throws(() => createLogger({ name: '   ' }), /non-empty string/, 'blank name is rejected');
    t.throws(() => createLogger({
      name: 'bad.level',
      level: 'verbose' as any
    }), /Unknown log level/, 'invalid constructor level is rejected');
    t.throws(() => createLogger({ name: 'bad.log' }).log('verbose' as any, 'nope'), /Unknown log level/, 'invalid log() level is rejected');
  });
  it('emits fatal records and filters fatal through level thresholds', (t) => {
    const records: Array<Record<string, unknown>> = [];
    const handle = subscribeLogs((record) => records.push((record as unknown) as Record<string, unknown>), { level: 'fatal' });
    const logger = createLogger({ name: 'fatal.logger' });
    logger.error('hidden');
    logger.fatal('fatal message', { exitCode: 1 });
    handle.dispose();
    t.equal(records.length, 1, 'only fatal passes fatal sink threshold');
    t.equal(records[0].level, 'fatal', 'record level is fatal');
    t.equal(records[0].message, 'fatal message', 'fatal message is preserved');
    t.deepEqual(records[0].fields, { exitCode: 1 }, 'fatal fields are preserved');
  });
  it('copies active span fields onto LogRecord', (t) => {
    const records: Array<Record<string, unknown>> = [];
    const handle = subscribeLogs((record) => records.push((record as unknown) as Record<string, unknown>));
    const provider = new TracerProvider();
    const span = provider.getTracer('log.active').startSpan('active-work');
    runWithActiveSpan(span, () => {
      createLogger({ name: 'span.logger' }).info('with span');
    });
    handle.dispose();
    t.equal(records.length, 1, 'subscriber receives one record');
    t.equal(records[0].traceId, span.traceId, 'traceId copied from active span');
    t.equal(records[0].spanId, span.spanId, 'spanId copied from active span');
    t.equal(records[0].traceFlags, 1, 'traceFlags copied from active span context');
  });
  it('routes default JSON sink warning and error levels to stderr', async (t) => {
    const result = await runFixture('json');
    t.equal(result.code, 0, 'fixture exits successfully');
    t.ok(result.stdout.includes('"level":"info"'), 'info JSON record is on stdout');
    t.ok(!result.stdout.includes('"level":"error"'), 'error JSON record is not on stdout');
    t.ok(!result.stdout.includes('"level":"fatal"'), 'fatal JSON record is not on stdout');
    t.ok(result.stderr.includes('"level":"error"'), 'error JSON record is on stderr');
    t.ok(result.stderr.includes('"level":"fatal"'), 'fatal JSON record is on stderr');
  });
  it('routes default console sink warning and error levels to stderr', async (t) => {
    const result = await runFixture('console');
    t.equal(result.code, 0, 'fixture exits successfully');
    t.ok(result.stdout.includes('INFO routing.console info message'), 'info console record is on stdout');
    t.ok(!result.stdout.includes('ERROR routing.console error message'), 'error console record is not on stdout');
    t.ok(!result.stdout.includes('FATAL routing.console fatal message'), 'fatal console record is not on stdout');
    t.ok(result.stderr.includes('ERROR routing.console error message'), 'error console record is on stderr');
    t.ok(result.stderr.includes('FATAL routing.console fatal message'), 'fatal console record is on stderr');
  });
});
