/**
 * Log providers, loggers, severity helpers, builders, and log limits.
 *
 * This internal module creates scoped loggers and publishes `LogRecord`
 * payloads on severity-specific and shared log topics. It captures the active
 * trace context when a log is emitted, applies default severity values, and
 * provides a builder for structured log records.
 *
 * The default severity is `INFO` with severity number `9`. `emitRecord()` fills
 * missing timestamps, scope, resource, and trace context but preserves explicit
 * fields from the builder or partial record. Attribute limiting is separate so
 * processors can apply SDK-specific limits without changing logger behavior.
 *
 * ```typescript no_run
 * const logger = getLoggerProvider().getLogger('orders');
 * logger.info('created order', { orderId: 'ord_123' });
 * logger.emitRecord(new LogRecordBuilder().setSeverity('WARN').setTextBody('slow path'));
 * ```
 *
 * See OpenTelemetry logs:
 * https://opentelemetry.io/docs/concepts/signals/logs/
 *
 * @internal
 */

import { Context } from '../../context/index.mts';
import { Topic, topic } from '../../context/topic.mts';
import {
  BaseProvider,
  OTEL_SCHEMA_VERSION,
  limitAttributeEntries,
  normalizeScope,
  nowUnixNano,
  topicNames,
} from './common.mts';
import type { Attributes, LogRecord, ScopeInfo, TraceContext } from './common.mts';
import { getActiveSpanContext } from './traces.mts';

/**
 * SeverityNumber enum exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const value = SeverityNumber;
 * ```
 */
export enum SeverityNumber {
  /**
   * TRACE numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.TRACE;
   * ```
   */
  TRACE = 1,
  /**
   * TRACE2 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.TRACE2;
   * ```
   */
  TRACE2 = 2,
  /**
   * TRACE3 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.TRACE3;
   * ```
   */
  TRACE3 = 3,
  /**
   * TRACE4 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.TRACE4;
   * ```
   */
  TRACE4 = 4,
  /**
   * DEBUG numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.DEBUG;
   * ```
   */
  DEBUG = 5,
  /**
   * DEBUG2 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.DEBUG2;
   * ```
   */
  DEBUG2 = 6,
  /**
   * DEBUG3 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.DEBUG3;
   * ```
   */
  DEBUG3 = 7,
  /**
   * DEBUG4 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.DEBUG4;
   * ```
   */
  DEBUG4 = 8,
  /**
   * INFO numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.INFO;
   * ```
   */
  INFO = 9,
  /**
   * INFO2 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.INFO2;
   * ```
   */
  INFO2 = 10,
  /**
   * INFO3 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.INFO3;
   * ```
   */
  INFO3 = 11,
  /**
   * INFO4 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.INFO4;
   * ```
   */
  INFO4 = 12,
  /**
   * WARN numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.WARN;
   * ```
   */
  WARN = 13,
  /**
   * WARN2 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.WARN2;
   * ```
   */
  WARN2 = 14,
  /**
   * WARN3 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.WARN3;
   * ```
   */
  WARN3 = 15,
  /**
   * WARN4 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.WARN4;
   * ```
   */
  WARN4 = 16,
  /**
   * ERROR numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.ERROR;
   * ```
   */
  ERROR = 17,
  /**
   * ERROR2 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.ERROR2;
   * ```
   */
  ERROR2 = 18,
  /**
   * ERROR3 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.ERROR3;
   * ```
   */
  ERROR3 = 19,
  /**
   * ERROR4 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.ERROR4;
   * ```
   */
  ERROR4 = 20,
  /**
   * FATAL numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.FATAL;
   * ```
   */
  FATAL = 21,
  /**
   * FATAL2 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.FATAL2;
   * ```
   */
  FATAL2 = 22,
  /**
   * FATAL3 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.FATAL3;
   * ```
   */
  FATAL3 = 23,
  /**
   * FATAL4 numeric severity value in SeverityNumber.
   *
   * The value follows the OpenTelemetry severity-number range. It is a stable numeric marker and does not perform validation by itself.
   *
   * ```typescript no_run
   * const severity = SeverityNumber.FATAL4;
   * ```
   */
  FATAL4 = 24,
}

/**
 * LoggerProvider class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = LoggerProvider;
 * ```
 */
export class LoggerProvider extends BaseProvider {
  /**
   * getLogger member on LoggerProvider.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LoggerProvider.prototype.getLogger;
   * ```
   */
  getLogger(
    name: string,
    version?: string,
    options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number },
  ): Logger {
    return new Logger(this, normalizeScope(name, version, options?.schemaUrl, options?.attributes, options?.droppedAttributesCount));
  }
}

/**
 * Logger class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = Logger;
 * ```
 */
export class Logger {
  /**
   * #provider member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Logger.#provider';
   * ```
   */
  #provider: LoggerProvider;
  /**
   * #scope member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Logger.#scope';
   * ```
   */
  #scope: ScopeInfo;
  // Pre-cached topic sets keyed by severity suffix, plus the shared record topic.
  /**
   * #topicsByPhase member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Logger.#topicsByPhase';
   * ```
   */
  #topicsByPhase: Map<string, Array<Topic<LogRecord>>>;
  /**
   * #recordTopic member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'Logger.#recordTopic';
   * ```
   */
  #recordTopic: Topic<LogRecord>;

  /**
   * constructor member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const instance = new Logger();
   * ```
   */
  constructor(provider: LoggerProvider, scope: ScopeInfo) {
    this.#provider = provider;
    this.#scope = scope;
    this.#topicsByPhase = new Map();
    this.#recordTopic = topic<LogRecord>('otel:log:record');
  }

  /**
   * Returns cached scoped log topics for a severity or emit phase.
   *
   * The first call creates the topic set for the logger scope; later calls reuse
   * it. Unknown phases are accepted and encoded into topic names, so callers
   * should pass normalized severity text.
   *
   * ```typescript no_run
   * const helper = 'Logger.#getTopics';
   * ```
   */
  #getTopics(phase: string): Array<Topic<LogRecord>> {
    let topics = this.#topicsByPhase.get(phase);
    if (!topics) {
      topics = topicNames('log', this.#scope, phase).map((name) => topic<LogRecord>(name));
      this.#topicsByPhase.set(phase, topics);
    }
    return topics;
  }

  /**
   * Publishes a log record to scoped phase topics and the shared record topic.
   *
   * The record is forwarded as provided. Processor-side limits and resource
   * enrichment happen later in `OtelSDK`, not in this helper.
   *
   * ```typescript no_run
   * const helper = 'Logger.#publishRecord';
   * ```
   */
  #publishRecord(record: LogRecord, phase: string): void {
    for (const t of this.#getTopics(phase)) t.publish(record);
    this.#recordTopic.publish(record);
  }

  /**
   * scope member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const getter = Logger.prototype.scope;
   * ```
   */
  get scope(): ScopeInfo {
    return {
      ...this.#scope,
      ...(this.#scope.attributes ? { attributes: { ...this.#scope.attributes } } : {}),
    };
  }

  /**
   * emit member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Logger.prototype.emit;
   * ```
   */
  emit(body: unknown, options: { severityText?: string; severityNumber?: number; attributes?: Attributes } = {}): void {
    const activeContext = getActiveSpanContext();
    const record: LogRecord = {
      schemaVersion: OTEL_SCHEMA_VERSION,
      body,
      severityText: options.severityText || 'INFO',
      severityNumber: options.severityNumber || SeverityNumber.INFO,
      timeUnixNano: nowUnixNano(),
      attributes: { ...(options.attributes || {}) },
      scope: { ...this.#scope },
      resource: this.#provider.resource,
      ...(activeContext?.traceId ? { traceId: activeContext.traceId } : {}),
      ...(activeContext?.spanId ? { spanId: activeContext.spanId } : {}),
      ...(activeContext?.traceFlags !== undefined ? { traceFlags: activeContext.traceFlags } : {}),
      ...(activeContext?.baggage !== undefined ? { baggage: activeContext.baggage } : {}),
    };
    this.#publishRecord(record, String(options.severityText || 'emit').toLowerCase());
  }

  /**
   * emitRecord member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Logger.prototype.emitRecord;
   * ```
   */
  emitRecord(builder: LogRecordBuilder | Partial<LogRecord>): void {
    const record = builder instanceof LogRecordBuilder ? builder.build() : { ...builder };
    const activeContext = getActiveSpanContext();
    const finalRecord: LogRecord = {
      schemaVersion: record.schemaVersion ?? OTEL_SCHEMA_VERSION,
      severityText: record.severityText ?? 'INFO',
      severityNumber: record.severityNumber ?? SeverityNumber.INFO,
      timeUnixNano: record.timeUnixNano ?? nowUnixNano(),
      attributes: { ...(record.attributes || {}) },
      scope: { ...this.#scope },
      resource: record.resource ?? this.#provider.resource,
    };
    if (record.body !== undefined) finalRecord.body = record.body;
    if (record.observedTimeUnixNano !== undefined) finalRecord.observedTimeUnixNano = record.observedTimeUnixNano;
    if (record.droppedAttributesCount !== undefined) finalRecord.droppedAttributesCount = record.droppedAttributesCount;
    const traceId = record.traceId ?? activeContext?.traceId;
    const spanId = record.spanId ?? activeContext?.spanId;
    const traceFlags = record.traceFlags ?? activeContext?.traceFlags;
    const baggage = record.baggage ?? activeContext?.baggage;
    if (traceId !== undefined) finalRecord.traceId = traceId;
    if (spanId !== undefined) finalRecord.spanId = spanId;
    if (traceFlags !== undefined) finalRecord.traceFlags = traceFlags;
    if (baggage !== undefined) finalRecord.baggage = baggage;
    if (record.eventName !== undefined) finalRecord.eventName = record.eventName;
    if (record.categoryName !== undefined) finalRecord.categoryName = record.categoryName;
    if (record.flags !== undefined) finalRecord.flags = record.flags;
    this.#publishRecord(finalRecord, String(finalRecord.severityText || 'emit').toLowerCase());
  }

  /**
   * debug member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Logger.prototype.debug;
   * ```
   */
  debug(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'DEBUG', severityNumber: SeverityNumber.DEBUG, attributes });
  }

  /**
   * info member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Logger.prototype.info;
   * ```
   */
  info(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'INFO', severityNumber: SeverityNumber.INFO, attributes });
  }

  /**
   * warn member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Logger.prototype.warn;
   * ```
   */
  warn(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'WARN', severityNumber: SeverityNumber.WARN, attributes });
  }

  /**
   * error member on Logger.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = Logger.prototype.error;
   * ```
   */
  error(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'ERROR', severityNumber: SeverityNumber.ERROR, attributes });
  }
}

/**
 * LogRecordBuilder class exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const ctor = LogRecordBuilder;
 * ```
 */
export class LogRecordBuilder {
  /**
   * #record member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const field = 'LogRecordBuilder.#record';
   * ```
   */
  #record: Partial<LogRecord> & { attributes: Attributes };

  /**
   * constructor member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const instance = new LogRecordBuilder();
   * ```
   */
  constructor() {
    this.#record = { attributes: {} };
  }

  /**
   * setBody member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setBody;
   * ```
   */
  setBody(body: unknown): this {
    this.#record.body = body;
    return this;
  }

  /**
   * setTextBody member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setTextBody;
   * ```
   */
  setTextBody(body: string): this {
    this.#record.body = String(body);
    return this;
  }

  /**
   * setJsonBody member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setJsonBody;
   * ```
   */
  setJsonBody(body: unknown): this {
    this.#record.body = body;
    return this;
  }

  /**
   * setSeverity member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setSeverity;
   * ```
   */
  setSeverity(severityText: string, severityNumber?: number): this {
    this.#record.severityText = severityText;
    if (severityNumber === undefined) {
      delete this.#record.severityNumber;
    } else {
      this.#record.severityNumber = severityNumber;
    }
    return this;
  }

  /**
   * setAttribute member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setAttribute;
   * ```
   */
  setAttribute(key: string, value: unknown): this {
    this.#record.attributes[key] = value;
    return this;
  }

  /**
   * setAttributes member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setAttributes;
   * ```
   */
  setAttributes(attributes: Attributes): this {
    Object.assign(this.#record.attributes, attributes || {});
    return this;
  }

  /**
   * setEventName member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setEventName;
   * ```
   */
  setEventName(name: string): this {
    this.#record.eventName = String(name);
    return this;
  }

  /**
   * setCategory member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setCategory;
   * ```
   */
  setCategory(name: string): this {
    this.#record.categoryName = String(name);
    return this;
  }

  /**
   * setDroppedAttributesCount member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setDroppedAttributesCount;
   * ```
   */
  setDroppedAttributesCount(count: number): this {
    this.#record.droppedAttributesCount = Number(count) || 0;
    return this;
  }

  /**
   * setContext member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.setContext;
   * ```
   */
  setContext(context: TraceContext | null | undefined): this {
    if (context?.traceId) this.#record.traceId = context.traceId;
    else delete this.#record.traceId;
    if (context?.spanId) this.#record.spanId = context.spanId;
    else delete this.#record.spanId;
    if (context?.traceFlags !== undefined) this.#record.traceFlags = context.traceFlags;
    else delete this.#record.traceFlags;
    if (context?.baggage !== undefined) this.#record.baggage = context.baggage;
    else delete this.#record.baggage;
    return this;
  }

  /**
   * build member on LogRecordBuilder.
   *
   * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
   *
   * ```typescript no_run
   * const member = LogRecordBuilder.prototype.build;
   * ```
   */
  build(): LogRecord {
    return {
      ...this.#record,
      attributes: { ...(this.#record.attributes || {}) },
    };
  }
}

/**
 * applyLogLimits function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = applyLogLimits;
 * ```
 */
export function applyLogLimits(
  log: LogRecord,
  limits: { attributeCountLimit?: number; attributeValueLengthLimit?: number } = {},
): LogRecord {
  const hasLimit = Number.isFinite(limits.attributeCountLimit ?? Infinity) || Number.isFinite(limits.attributeValueLengthLimit ?? Infinity);
  if (!hasLimit) return log;
  const { attrs, dropped } = limitAttributeEntries(log.attributes || {}, limits);
  return {
    ...log,
    attributes: attrs,
    ...(dropped > 0 ? { droppedAttributesCount: (log.droppedAttributesCount || 0) + dropped } : {}),
  };
}

const loggerProviderContext = new Context<LoggerProvider | null>('otel:logger-provider');
let defaultLoggerProvider = new LoggerProvider();

/**
 * getLoggerProvider function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = getLoggerProvider;
 * ```
 */
export function getLoggerProvider(): LoggerProvider {
  return loggerProviderContext.get() || defaultLoggerProvider;
}

/**
 * setLoggerProvider function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = setLoggerProvider;
 * ```
 */
export function setLoggerProvider(provider: LoggerProvider): void {
  defaultLoggerProvider = provider;
}

/**
 * runWithLoggerProvider function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = runWithLoggerProvider;
 * ```
 */
export function runWithLoggerProvider<R>(provider: LoggerProvider, fn: () => R): R {
  return loggerProviderContext.runWithValue(provider, fn);
}

/**
 * runWithoutLoggerProvider function exposed by the OpenTelemetry API.
 *
 * Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
 *
 * ```typescript no_run
 * const fn = runWithoutLoggerProvider;
 * ```
 */
export function runWithoutLoggerProvider<R>(fn: () => R): R {
  return loggerProviderContext.runWithValue(null, fn);
}
