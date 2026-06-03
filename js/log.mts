/**
 * fino:log — topic-based structured logging.
 *
 * This module provides the application-facing logging API for fino backend
 * code. Loggers publish structured `LogRecord` objects onto `fino:context/topic`
 * channels; output is deliberately sink-driven. Creating a logger does not
 * install global stdout/stderr behavior, so libraries can safely log without
 * surprising their host application.
 *
 * The default transport topic is `"fino:log"`. Additional per-level and
 * per-logger topics are also published for callers that want narrower
 * subscriptions:
 *
 *   - `fino:log`
 *   - `fino:log:<level>`
 *   - `fino:log:<logger-name>`
 *
 * Context is propagated with `fino:context`, so request IDs and similar fields
 * survive `await` boundaries. If an OpenTelemetry span is active, trace/span
 * identifiers are copied onto the record and can be forwarded with
 * `createOtelSink()`.
 *
 * ```ts no_run
 * import { createJsonSink, createLogger, runWithLogContext } from 'fino:log';
 *
 * const sink = createJsonSink();
 * const log = createLogger({ name: 'api', level: 'info' });
 *
 * await runWithLogContext({ requestId: 'req-1' }, async () => {
 *   log.info('request started', { route: '/health' });
 * });
 *
 * sink.dispose();
 * ```
 */

import { Context } from './context/index.mts';
import { topic } from './context/topic.mts';
import { writeLine } from 'internal:runtime/libc';
import { getActiveSpanContext } from './opentelemetry/traces.mts';
import { getLoggerProvider, SeverityNumber } from './opentelemetry/logs.mts';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type Fields = Record<string, unknown>;

/**
 * Structured event emitted by `Logger` and consumed by sinks/subscribers.
 *
 * Records are immutable by convention once published. Sinks receive the same
 * record shape regardless of whether they render JSON, text, or OpenTelemetry
 * log events.
 *
 * ```ts no_run
 * import { createLogger, subscribeLogs, type LogRecord } from 'fino:log';
 *
 * const events: LogRecord[] = [];
 * const sub = subscribeLogs((record) => events.push(record));
 * createLogger({ name: 'api' }).info('ready');
 * sub.dispose();
 * ```
 */
export interface LogRecord {
  /**
   * ISO-8601 timestamp generated when the record is emitted.
   *
   * ```ts no_run
   * const emittedAt = new Date(record.timestamp);
   * ```
   */
  timestamp: string;
  /**
   * Normalized severity level.
   *
   * ```ts no_run
   * if (record.level === 'error') {
   *   // route to stderr
   * }
   * ```
   */
  level: LogLevel;
  /**
   * Logger name, usually a dotted subsystem path.
   *
   * ```ts no_run
   * const subsystem = record.logger;
   * ```
   */
  logger: string;
  /**
   * Human-readable event message.
   *
   * ```ts no_run
   * console.log(record.message);
   * ```
   */
  message: string;
  /**
   * Per-call structured fields.
   *
   * ```ts no_run
   * const route = record.fields.route;
   * ```
   */
  fields: Fields;
  /**
   * Async-scoped and logger-scoped fields merged together.
   *
   * ```ts no_run
   * const requestId = record.context.requestId;
   * ```
   */
  context: Fields;
  /**
   * Normalized error details when the message or `fields.error` is an Error.
   *
   * ```ts no_run
   * if (record.error) {
   *   console.error(record.error.message);
   * }
   * ```
   */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /**
   * OpenTelemetry trace id copied from the active span, when present.
   *
   * ```ts no_run
   * const traceId = record.traceId ?? 'none';
   * ```
   */
  traceId?: string;
  /**
   * OpenTelemetry span id copied from the active span, when present.
   *
   * ```ts no_run
   * const spanId = record.spanId ?? 'none';
   * ```
   */
  spanId?: string;
  /**
   * OpenTelemetry trace flags copied from the active span, when present.
   *
   * ```ts no_run
   * const sampled = (record.traceFlags ?? 0) & 1;
   * ```
   */
  traceFlags?: number;
}

/**
 * Options for constructing a `Logger`.
 *
 * A logger name is required. The level controls which records are emitted, and
 * context fields are attached to every record from that logger and its
 * descendants.
 *
 * ```ts no_run
 * import { Logger, type LoggerOptions } from 'fino:log';
 *
 * const options: LoggerOptions = {
 *   name: 'api',
 *   level: 'info',
 *   context: { service: 'users' },
 * };
 * const log = new Logger(options);
 * ```
 */
export interface LoggerOptions {
  /**
   * Non-empty logger name.
   *
   * ```ts no_run
   * const options = { name: 'api' };
   * ```
   */
  name: string;
  /**
   * Minimum emitted level. Defaults to `trace`.
   *
   * ```ts no_run
   * const options = { name: 'api', level: 'warn' as const };
   * ```
   */
  level?: LogLevel;
  /**
   * Fields attached to every record emitted by this logger.
   *
   * ```ts no_run
   * const options = { name: 'api', context: { service: 'users' } };
   * ```
   */
  context?: Fields;
}

/**
 * Shared options for log subscriptions and sinks.
 *
 * The level threshold is applied by subscribers after records are published.
 * It does not change logger-level filtering.
 *
 * ```ts no_run
 * import { subscribeLogs, type SinkOptions } from 'fino:log';
 *
 * const options: SinkOptions = { level: 'warn' };
 * const sub = subscribeLogs(() => {}, options);
 * sub.dispose();
 * ```
 */
export interface SinkOptions {
  /**
   * Minimum level accepted by the subscription. Defaults to all levels.
   *
   * ```ts no_run
   * const options = { level: 'error' as const };
   * ```
   */
  level?: LogLevel;
}

/**
 * Options for line-oriented sinks such as text and JSON output.
 *
 * Provide `write` to capture lines in tests, send them to a custom stream, or
 * adapt records to a host logging system.
 *
 * ```ts no_run
 * import { createJsonSink, type WriteSinkOptions } from 'fino:log';
 *
 * const lines: string[] = [];
 * const options: WriteSinkOptions = { write: (line) => lines.push(line) };
 * const sink = createJsonSink(options);
 * sink.dispose();
 * ```
 */
export interface WriteSinkOptions extends SinkOptions {
  /**
   * Receives each rendered line. Defaults to direct stdout/stderr writes.
   *
   * ```ts no_run
   * const options = { write: (line: string) => console.log(line) };
   * ```
   */
  write?: (line: string, record: LogRecord) => void;
}

// ---------------------------------------------------------------------------
// Level and transport state
// ---------------------------------------------------------------------------

const levels: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const severityNumbers: Record<LogLevel, number> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

const logContext = new Context<Fields>('fino:log:context');
const logTopic = topic<LogRecord>('fino:log');

// ---------------------------------------------------------------------------
// Internal normalization helpers
// ---------------------------------------------------------------------------

function normalizeLevel(level: unknown, fallback: LogLevel = 'info'): LogLevel {
  const value = String(level ?? fallback).toLowerCase();
  if (value === 'trace' || value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'fatal') {
    return value;
  }
  throw new Error(`Unknown log level '${String(level)}'`);
}

function cloneFields(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Fields) };
}

function normalizeError(value: unknown): LogRecord['error'] | undefined {
  if (!(value instanceof Error)) return undefined;
  return {
    name: value.name || 'Error',
    message: value.message,
    ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
  };
}

function normalizeMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function shouldEmit(recordLevel: LogLevel, threshold: LogLevel | undefined): boolean {
  return levels[recordLevel] >= levels[normalizeLevel(threshold, 'trace')];
}

// ---------------------------------------------------------------------------
// Async log context
// ---------------------------------------------------------------------------

/**
 * Return the current async-scoped log context.
 *
 * The returned object is a shallow copy, so mutating it does not alter the
 * active context.
 *
 * ```ts no_run
 * import { getLogContext, runWithLogContext } from 'fino:log';
 *
 * runWithLogContext({ requestId: 'req-1' }, () => {
 *   getLogContext().requestId; // 'req-1'
 * });
 * ```
 */
export function getLogContext(): Fields {
  return { ...(logContext.get() ?? {}) };
}

/**
 * Run `fn` with additional structured log context.
 *
 * The provided fields are shallow-merged over any existing context and are
 * visible to logger calls made through async continuations created inside
 * `fn`.
 *
 * ```ts no_run
 * import { createLogger, runWithLogContext } from 'fino:log';
 *
 * const log = createLogger({ name: 'api' });
 * await runWithLogContext({ requestId: 'req-1' }, async () => {
 *   log.info('handled request');
 * });
 * ```
 */
export function runWithLogContext<R>(context: Fields, fn: () => R): R {
  return logContext.runWithValue({ ...getLogContext(), ...cloneFields(context) }, fn);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Emits structured log records onto the fino log topics.
 *
 * A logger filters records by its configured level, merges logger context with
 * async log context, and publishes matching records to broad and narrow topics.
 *
 * ```ts no_run
 * import { Logger, createConsoleSink } from 'fino:log';
 *
 * const sink = createConsoleSink({ level: 'info' });
 * const log = new Logger({ name: 'api', level: 'debug' });
 * log.info('ready', { port: 3000 });
 * sink.dispose();
 * ```
 */
export class Logger {
  /**
   * Private property `#name` used by `Logger`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #name = undefined;
   *
   *   readInternalState() {
   *     return this.#name;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #name: string;
  /**
   * Private property `#level` used by `Logger`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #level = undefined;
   *
   *   readInternalState() {
   *     return this.#level;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #level: LogLevel;
  /**
   * Private property `#context` used by `Logger`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #context = undefined;
   *
   *   readInternalState() {
   *     return this.#context;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #context: Fields;

  /**
   * Create a logger with a required non-empty name.
   *
   * The constructor validates the level and shallow-copies context fields so
   * later mutations of the options object do not affect emitted records.
   *
   * ```ts no_run
   * import { Logger } from 'fino:log';
   *
   * const log = new Logger({ name: 'api', level: 'info' });
   * ```
   */
  constructor(options: LoggerOptions) {
    const name = String(options.name ?? '').trim();
    if (name.length === 0) throw new Error('Logger name must be a non-empty string');
    this.#name = name;
    this.#level = normalizeLevel(options.level, 'trace');
    this.#context = cloneFields(options.context);
  }

  /**
   * Logger name included on every emitted record.
   *
   * ```ts no_run
   * import { createLogger } from 'fino:log';
   *
   * createLogger({ name: 'api' }).name; // 'api'
   * ```
   */
  get name(): string {
    return this.#name;
  }

  /**
   * Minimum level this logger emits.
   *
   * ```ts no_run
   * import { createLogger } from 'fino:log';
   *
   * createLogger({ name: 'api', level: 'warn' }).level; // 'warn'
   * ```
   */
  get level(): LogLevel {
    return this.#level;
  }

  /**
   * Create a child logger.
   *
   * If `options.name` is provided, it is appended to the parent name with a
   * dot. Other fields become logger context unless provided under
   * `options.context`.
   *
   * ```ts no_run
   * import { createLogger } from 'fino:log';
   *
   * const root = createLogger({ name: 'api', context: { service: 'users' } });
   * const requests = root.child({ name: 'requests', route: '/users' });
   * requests.info('started');
   * ```
   */
  child(options: Fields | (Partial<LoggerOptions> & { name?: string }) = {}): Logger {
    const childOptions = cloneFields(options);
    const childName = typeof childOptions.name === 'string' && childOptions.name.length > 0
      ? `${this.#name}.${childOptions.name}`
      : this.#name;
    delete childOptions.name;
    const childLevel = typeof childOptions.level === 'string'
      ? normalizeLevel(childOptions.level)
      : this.#level;
    delete childOptions.level;
    const childContext = childOptions.context && typeof childOptions.context === 'object'
      ? cloneFields(childOptions.context)
      : childOptions;
    return new Logger({
      name: childName,
      level: childLevel,
      context: { ...this.#context, ...childContext },
    });
  }

  /**
   * Emit a record at an arbitrary level.
   *
   * Prefer the level-specific helpers for normal use. Passing an `Error` as
   * `message`, or as `fields.error`, attaches normalized error details.
   *
   * ```ts no_run
   * import { createLogger } from 'fino:log';
   *
   * const log = createLogger({ name: 'api' });
   * log.log('warn', 'slow request', { durationMs: 1200 });
   * ```
   */
  log(level: LogLevel, message: unknown, fields: Fields = {}): void {
    const normalizedLevel = normalizeLevel(level);
    if (!shouldEmit(normalizedLevel, this.#level)) return;
    const activeSpan = getActiveSpanContext();
    const error = normalizeError(message) ?? normalizeError((fields as Fields).error);
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level: normalizedLevel,
      logger: this.#name,
      message: normalizeMessage(message),
      fields: cloneFields(fields),
      context: { ...getLogContext(), ...this.#context },
      ...(error ? { error } : {}),
      ...(activeSpan?.traceId ? { traceId: activeSpan.traceId } : {}),
      ...(activeSpan?.spanId ? { spanId: activeSpan.spanId } : {}),
      ...(activeSpan?.traceFlags !== undefined ? { traceFlags: activeSpan.traceFlags } : {}),
    };
    logTopic.publish(record);
    topic<LogRecord>(`fino:log:${normalizedLevel}`).publish(record);
    topic<LogRecord>(`fino:log:${this.#name}`).publish(record);
  }

  /**
   * Emit a trace-level record.
   *
   * ```ts no_run
   * createLogger({ name: 'api' }).trace('cache lookup');
   * ```
   */
  trace(message: unknown, fields: Fields = {}): void { this.log('trace', message, fields); }
  /**
   * Emit a debug-level record.
   *
   * ```ts no_run
   * createLogger({ name: 'api' }).debug('cache miss', { key: 'user:1' });
   * ```
   */
  debug(message: unknown, fields: Fields = {}): void { this.log('debug', message, fields); }
  /**
   * Emit an info-level record.
   *
   * ```ts no_run
   * createLogger({ name: 'api' }).info('request started');
   * ```
   */
  info(message: unknown, fields: Fields = {}): void { this.log('info', message, fields); }
  /**
   * Emit a warn-level record.
   *
   * ```ts no_run
   * createLogger({ name: 'api' }).warn('rate limit near capacity');
   * ```
   */
  warn(message: unknown, fields: Fields = {}): void { this.log('warn', message, fields); }
  /**
   * Emit an error-level record.
   *
   * ```ts no_run
   * createLogger({ name: 'api' }).error(new Error('database unavailable'));
   * ```
   */
  error(message: unknown, fields: Fields = {}): void { this.log('error', message, fields); }
  /**
   * Emit a fatal-level record.
   *
   * ```ts no_run
   * createLogger({ name: 'api' }).fatal('process cannot continue');
   * ```
   */
  fatal(message: unknown, fields: Fields = {}): void { this.log('fatal', message, fields); }
}

/**
 * Convenience factory for `new Logger(options)`.
 *
 * Use this when a factory reads more naturally than a constructor. It performs
 * the same validation and returns the same `Logger` class.
 *
 * ```ts no_run
 * import { createLogger } from 'fino:log';
 *
 * const log = createLogger({ name: 'api', level: 'info' });
 * log.info('ready');
 * ```
 */
export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}

// ---------------------------------------------------------------------------
// Subscriptions and sinks
// ---------------------------------------------------------------------------

/**
 * Subscribe to structured log records.
 *
 * Returns a disposable subscription handle. This is the lowest-level sink API;
 * higher-level sinks are thin wrappers over this function.
 *
 * ```ts no_run
 * import { createLogger, subscribeLogs } from 'fino:log';
 *
 * const sub = subscribeLogs((record) => {
 *   console.log(record.level, record.message);
 * }, { level: 'info' });
 * createLogger({ name: 'api' }).info('ready');
 * sub.dispose();
 * ```
 */
export function subscribeLogs(fn: (record: LogRecord) => void, options: SinkOptions = {}) {
  const threshold = options.level === undefined ? undefined : normalizeLevel(options.level);
  return logTopic.subscribe((record) => {
    if (threshold !== undefined && !shouldEmit(record.level, threshold)) return;
    fn(record);
  });
}

/** Render a record as one local-development-oriented text line. */
function formatText(record: LogRecord): string {
  const parts = [
    record.timestamp,
    record.level.toUpperCase(),
    record.logger,
    record.message,
  ];
  const extra = { ...record.context, ...record.fields };
  if (Object.keys(extra).length > 0) parts.push(JSON.stringify(extra));
  if (record.error?.stack) parts.push(record.error.stack);
  return parts.join(' ');
}

/**
 * Subscribe a JSON-lines sink.
 *
 * Without a custom `write`, records are written directly to stdout/stderr with
 * one JSON object per line. The sink is opt-in; importing `fino:log` never
 * installs it automatically.
 *
 * ```ts no_run
 * import { createJsonSink, createLogger } from 'fino:log';
 *
 * const sink = createJsonSink({ level: 'info' });
 * createLogger({ name: 'api' }).info('ready');
 * sink.dispose();
 * ```
 */
export function createJsonSink(options: WriteSinkOptions = {}) {
  const write = options.write ?? ((line: string, record: LogRecord) => {
    writeLine(record.level === 'warn' || record.level === 'error' || record.level === 'fatal' ? 2 : 1, line);
  });
  return subscribeLogs((record) => write(JSON.stringify(record), record), options);
}

/**
 * Subscribe a human-readable console sink.
 *
 * This is intended for local development. Production ingestion should normally
 * use `createJsonSink()` or `createOtelSink()`.
 *
 * ```ts no_run
 * import { createConsoleSink, createLogger } from 'fino:log';
 *
 * const sink = createConsoleSink();
 * createLogger({ name: 'api' }).warn('slow request');
 * sink.dispose();
 * ```
 */
export function createConsoleSink(options: WriteSinkOptions = {}) {
  const write = options.write ?? ((line: string, record: LogRecord) => {
    writeLine(record.level === 'warn' || record.level === 'error' || record.level === 'fatal' ? 2 : 1, line);
  });
  return subscribeLogs((record) => write(formatText(record), record), options);
}

/**
 * Subscribe an OpenTelemetry sink.
 *
 * Records are forwarded through the active/default OTel `LoggerProvider`.
 * Context and fields become log attributes, and normalized errors become
 * `exception.*` attributes.
 *
 * ```ts no_run
 * import { createLogger, createOtelSink } from 'fino:log';
 *
 * const sink = createOtelSink({ level: 'info' });
 * createLogger({ name: 'api' }).info('exported to OpenTelemetry');
 * sink.dispose();
 * ```
 */
export function createOtelSink(options: SinkOptions = {}) {
  return subscribeLogs((record) => {
    const logger = getLoggerProvider().getLogger(record.logger);
    logger.emitRecord({
      body: record.message,
      severityText: record.level.toUpperCase(),
      severityNumber: severityNumbers[record.level],
      attributes: {
        ...record.context,
        ...record.fields,
        ...(record.error ? {
          'exception.type': record.error.name,
          'exception.message': record.error.message,
          ...(record.error.stack ? { 'exception.stacktrace': record.error.stack } : {}),
        } : {}),
      },
      ...(record.traceId ? { traceId: record.traceId } : {}),
      ...(record.spanId ? { spanId: record.spanId } : {}),
      ...(record.traceFlags !== undefined ? { traceFlags: record.traceFlags } : {}),
    });
  }, options);
}
