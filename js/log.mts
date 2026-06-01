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
 * ```ts
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
import { getActiveSpanContext, getLoggerProvider, SeverityNumber } from './opentelemetry/index.mts';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type Fields = Record<string, unknown>;

/** Structured event emitted by `Logger` and consumed by sinks/subscribers. */
export interface LogRecord {
  /** ISO-8601 timestamp generated when the record is emitted. */
  timestamp: string;
  /** Normalized severity level. */
  level: LogLevel;
  /** Logger name, usually a dotted subsystem path. */
  logger: string;
  /** Human-readable event message. */
  message: string;
  /** Per-call structured fields. */
  fields: Fields;
  /** Async-scoped and logger-scoped fields merged together. */
  context: Fields;
  /** Normalized error details when the message or `fields.error` is an Error. */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /** OpenTelemetry trace id copied from the active span, when present. */
  traceId?: string;
  /** OpenTelemetry span id copied from the active span, when present. */
  spanId?: string;
  /** OpenTelemetry trace flags copied from the active span, when present. */
  traceFlags?: number;
}

/** Options for constructing a `Logger`. */
export interface LoggerOptions {
  /** Non-empty logger name. */
  name: string;
  /** Minimum emitted level. Defaults to `trace`. */
  level?: LogLevel;
  /** Fields attached to every record emitted by this logger. */
  context?: Fields;
}

/** Shared options for log subscriptions and sinks. */
export interface SinkOptions {
  /** Minimum level accepted by the subscription. Defaults to all levels. */
  level?: LogLevel;
}

/** Options for line-oriented sinks such as text and JSON output. */
export interface WriteSinkOptions extends SinkOptions {
  /** Receives each rendered line. Defaults to direct stdout/stderr writes. */
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
 */
export function runWithLogContext<R>(context: Fields, fn: () => R): R {
  return logContext.runWithValue({ ...getLogContext(), ...cloneFields(context) }, fn);
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Emits structured log records onto the fino log topics. */
export class Logger {
  #name: string;
  #level: LogLevel;
  #context: Fields;

  /** Create a logger with a required non-empty name. */
  constructor(options: LoggerOptions) {
    const name = String(options.name ?? '').trim();
    if (name.length === 0) throw new Error('Logger name must be a non-empty string');
    this.#name = name;
    this.#level = normalizeLevel(options.level, 'trace');
    this.#context = cloneFields(options.context);
  }

  /** Logger name included on every emitted record. */
  get name(): string {
    return this.#name;
  }

  /** Minimum level this logger emits. */
  get level(): LogLevel {
    return this.#level;
  }

  /**
   * Create a child logger.
   *
   * If `options.name` is provided, it is appended to the parent name with a
   * dot. Other fields become logger context unless provided under
   * `options.context`.
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

  /** Emit a trace-level record. */
  trace(message: unknown, fields: Fields = {}): void { this.log('trace', message, fields); }
  /** Emit a debug-level record. */
  debug(message: unknown, fields: Fields = {}): void { this.log('debug', message, fields); }
  /** Emit an info-level record. */
  info(message: unknown, fields: Fields = {}): void { this.log('info', message, fields); }
  /** Emit a warn-level record. */
  warn(message: unknown, fields: Fields = {}): void { this.log('warn', message, fields); }
  /** Emit an error-level record. */
  error(message: unknown, fields: Fields = {}): void { this.log('error', message, fields); }
  /** Emit a fatal-level record. */
  fatal(message: unknown, fields: Fields = {}): void { this.log('fatal', message, fields); }
}

/** Convenience factory for `new Logger(options)`. */
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
