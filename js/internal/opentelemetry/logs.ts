/**
* internal:opentelemetry/logs — logger providers, loggers, severities, builders, and log limits.
*
* This module backs the public `fino:opentelemetry/logs` surface. It creates
* scoped loggers that turn each emitted log into a `LogRecord` and publish it on
* two sets of topics: severity-specific scoped topics (for consumers that filter
* by scope and phase) and the shared `otel:log:record` topic (for the SDK, which
* collects every record regardless of scope). Emission captures the active trace
* context — trace id, span id, trace flags, and baggage — so logs written inside
* a span are correlated with it automatically.
*
* Records are filled with sensible defaults at emit time: the severity defaults
* to `INFO` with severity number `9`, the timestamp defaults to the current wall
* clock in Unix nanoseconds, the scope is the logger's own scope, and the
* resource comes from the owning provider. Explicit fields you set through the
* builder or a partial record are always preserved over these defaults. Attribute
* count and value-length limiting is deliberately kept out of the logger and
* exposed separately as `applyLogLimits`, so SDK processors can enforce their own
* limits without changing what loggers emit.
*
* The active provider is resolved through an async-context slot, so tests and
* request scopes can override it with `runWithLoggerProvider` without mutating
* global state, while `setLoggerProvider` replaces the process-wide default.
*
* ```typescript no_run
* import { LogRecordBuilder, SeverityNumber, getLoggerProvider } from 'internal:opentelemetry/logs';
*
* const logger = getLoggerProvider().getLogger('orders', '1.4.0');
* logger.info('created order', { orderId: 'ord_123' });
* logger.emitRecord(
*   new LogRecordBuilder()
*     .setSeverity('WARN', SeverityNumber.WARN)
*     .setTextBody('slow order path')
*     .setAttribute('latency.ms', 812),
* );
* ```
*
* See OpenTelemetry logs:
* https://opentelemetry.io/docs/concepts/signals/logs/
*
* @internal
*/
import { Context } from '../../context/index.ts';
import { Topic, topic } from '../../context/topic.ts';
import { BaseProvider, OTEL_SCHEMA_VERSION, limitAttributeEntries, normalizeScope, nowUnixNano, topicNames } from './common.ts';
import type { Attributes, LogRecord, ScopeInfo, TraceContext } from './common.ts';
import { getActiveSpanContext } from './traces.ts';
/**
* Numeric severity levels from the OpenTelemetry log data model.
*
* Each of the six named ranges (TRACE, DEBUG, INFO, WARN, ERROR, FATAL) spans
* four numeric values, from the base level to three increasingly urgent
* sub-levels, giving the `1`–`24` contiguous range the spec defines. Higher
* numbers are more severe. These values populate the `severityNumber` field of a
* `LogRecord` and pair with the free-form `severityText`; the number is what
* backends sort and threshold on, so prefer passing a member of this enum over a
* raw integer.
*
* ```typescript no_run
* import { LogRecordBuilder, SeverityNumber } from 'internal:opentelemetry/logs';
*
* const record = new LogRecordBuilder()
*   .setSeverity('ERROR', SeverityNumber.ERROR)
*   .setTextBody('payment declined')
*   .build();
* ```
*/
export enum SeverityNumber {
  /** Lowest severity — the base TRACE level (1). */
  TRACE = 1,
  /** Second TRACE sub-level (2). */
  TRACE2 = 2,
  /** Third TRACE sub-level (3). */
  TRACE3 = 3,
  /** Fourth TRACE sub-level (4). */
  TRACE4 = 4,
  /** Base DEBUG level (5). */
  DEBUG = 5,
  /** Second DEBUG sub-level (6). */
  DEBUG2 = 6,
  /** Third DEBUG sub-level (7). */
  DEBUG3 = 7,
  /** Fourth DEBUG sub-level (8). */
  DEBUG4 = 8,
  /** Base INFO level (9) — the default severity for emitted records. */
  INFO = 9,
  /** Second INFO sub-level (10). */
  INFO2 = 10,
  /** Third INFO sub-level (11). */
  INFO3 = 11,
  /** Fourth INFO sub-level (12). */
  INFO4 = 12,
  /** Base WARN level (13). */
  WARN = 13,
  /** Second WARN sub-level (14). */
  WARN2 = 14,
  /** Third WARN sub-level (15). */
  WARN3 = 15,
  /** Fourth WARN sub-level (16). */
  WARN4 = 16,
  /** Base ERROR level (17). */
  ERROR = 17,
  /** Second ERROR sub-level (18). */
  ERROR2 = 18,
  /** Third ERROR sub-level (19). */
  ERROR3 = 19,
  /** Fourth ERROR sub-level (20). */
  ERROR4 = 20,
  /** Base FATAL level (21). */
  FATAL = 21,
  /** Second FATAL sub-level (22). */
  FATAL2 = 22,
  /** Third FATAL sub-level (23). */
  FATAL3 = 23,
  /** Highest severity — the fourth FATAL sub-level (24). */
  FATAL4 = 24
}
/**
* Factory for `Logger` instances, carrying the resource that stamps every record they emit.
*
* Extends `BaseProvider`, so a provider is constructed with a `resource` (or
* plain attributes) that identifies the emitting service; every logger it hands
* out attaches that resource to its records. A single provider is typically
* shared across a whole application and installed as the active provider via
* `setLoggerProvider` or `runWithLoggerProvider`.
*
* ```typescript no_run
* import { LoggerProvider } from 'internal:opentelemetry/logs';
* import { Resource } from 'internal:opentelemetry/common';
*
* const provider = new LoggerProvider({ resource: new Resource({ 'service.name': 'api' }) });
* const logger = provider.getLogger('api/http');
* logger.info('server started');
* ```
*/
export class LoggerProvider extends BaseProvider {
  /**
  * Returns a `Logger` bound to a named instrumentation scope.
  *
  * The `name` is required and identifies the library or subsystem producing the
  * logs; it drives the scoped topic names records are published on. The optional
  * `version` and `options` (schema URL, scope attributes, dropped-attribute
  * count) further qualify the scope. The scope is normalized before use, which
  * trims the name and throws a `TypeError` if it is empty or whitespace-only.
  *
  * ```typescript no_run
  * import { LoggerProvider } from 'internal:opentelemetry/logs';
  *
  * const provider = new LoggerProvider();
  * const logger = provider.getLogger('billing', '2.0.0', {
  *   schemaUrl: 'https://opentelemetry.io/schemas/1.31.0',
  *   attributes: { team: 'payments' },
  * });
  * ```
  */
  getLogger(name: string, version?: string, options?: {
    schemaUrl?: string | null;
    attributes?: Attributes;
    droppedAttributesCount?: number;
  }): Logger {
    return new Logger(this, normalizeScope(name, version, options?.schemaUrl, options?.attributes, options?.droppedAttributesCount));
  }
}
/**
* Emitter of log records for one instrumentation scope.
*
* A logger holds its owning provider and normalized scope, and offers two ways
* to produce records: the convenience methods (`debug`/`info`/`warn`/`error` and
* the general `emit`), which take a body plus attributes; and `emitRecord`, which
* accepts a fully or partially built `LogRecord` for cases that need event
* names, categories, or an explicit timestamp. Both paths fill missing defaults,
* stamp the logger's scope and the provider's resource, and capture the active
* trace context so logs written inside a span are correlated with it.
*
* Every record is published on the scope's severity-phase topics and on the
* shared `otel:log:record` topic. Construct loggers through
* `LoggerProvider.getLogger` rather than directly.
*
* ```typescript no_run
* import { getLoggerProvider } from 'internal:opentelemetry/logs';
*
* const logger = getLoggerProvider().getLogger('worker');
* logger.debug('job dequeued', { jobId: 'j-9' });
* logger.error('job failed', { jobId: 'j-9', attempt: 3 });
* ```
*/
export class Logger {
  /** The provider that created this logger; supplies the resource stamped on records. */
  #provider: LoggerProvider;
  /** Normalized instrumentation scope this logger emits under. */
  #scope: ScopeInfo;
  // Pre-cached topic sets keyed by severity suffix, plus the shared record topic.
  /** Lazily built cache of scoped topic arrays, keyed by lowercased emit phase. */
  #topicsByPhase: Map<string, Array<Topic<LogRecord>>>;
  /** The shared `otel:log:record` topic every record is also published to. */
  #recordTopic: Topic<LogRecord>;
  /**
  * Binds a logger to its provider and scope and prepares the shared record topic.
  *
  * Called by `LoggerProvider.getLogger`; application code does not invoke this
  * directly.
  *
  * ```typescript no_run
  * import { LoggerProvider } from 'internal:opentelemetry/logs';
  *
  * const logger = new LoggerProvider().getLogger('scope.name');
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
  */
  #publishRecord(record: LogRecord, phase: string): void {
    for (const t of this.#getTopics(phase)) t.publish(record);
    this.#recordTopic.publish(record);
  }
  /**
  * A defensive copy of this logger's instrumentation scope.
  *
  * The returned object is safe to mutate; its `attributes` are also copied, so
  * changes to it never affect records this logger emits.
  *
  * ```typescript no_run
  * import { getLoggerProvider } from 'internal:opentelemetry/logs';
  *
  * const logger = getLoggerProvider().getLogger('cache', '1.0.0');
  * const { name, version } = logger.scope;
  * ```
  */
  get scope(): ScopeInfo {
    return {
      ...this.#scope,
      ...this.#scope.attributes ? { attributes: { ...this.#scope.attributes } } : {}
    };
  }
  /**
  * Emits a log record from a body and options, filling defaults and trace context.
  *
  * The `body` may be any value — a string message or a structured object. When
  * omitted, `severityText` defaults to `'INFO'` and `severityNumber` to
  * `SeverityNumber.INFO`. The timestamp is set to now, the logger's scope and the
  * provider's resource are attached, and any active trace context (trace id, span
  * id, trace flags, baggage) is captured. The record is published on the phase
  * topic derived from the lowercased `severityText` (or `'emit'` when none is
  * given) and on the shared record topic.
  *
  * ```typescript no_run
  * import { getLoggerProvider, SeverityNumber } from 'internal:opentelemetry/logs';
  *
  * const logger = getLoggerProvider().getLogger('auth');
  * logger.emit('token refreshed', {
  *   severityText: 'INFO',
  *   severityNumber: SeverityNumber.INFO,
  *   attributes: { 'user.id': 'u_7' },
  * });
  * ```
  */
  emit(body: unknown, options: {
    severityText?: string;
    severityNumber?: number;
    attributes?: Attributes;
  } = {}): void {
    const activeContext = getActiveSpanContext();
    const record: LogRecord = {
      schemaVersion: OTEL_SCHEMA_VERSION,
      body,
      severityText: options.severityText || 'INFO',
      severityNumber: options.severityNumber || SeverityNumber.INFO,
      timeUnixNano: nowUnixNano(),
      attributes: { ...options.attributes || {} },
      scope: { ...this.#scope },
      resource: this.#provider.resource,
      ...activeContext?.traceId ? { traceId: activeContext.traceId } : {},
      ...activeContext?.spanId ? { spanId: activeContext.spanId } : {},
      ...activeContext?.traceFlags !== undefined ? { traceFlags: activeContext.traceFlags } : {},
      ...activeContext?.baggage !== undefined ? { baggage: activeContext.baggage } : {}
    };
    this.#publishRecord(record, String(options.severityText || 'emit').toLowerCase());
  }
  /**
  * Emits a pre-built or partial log record, preserving its explicit fields.
  *
  * Accepts either a `LogRecordBuilder` (which is built first) or a partial
  * `LogRecord`. Explicit fields on the record win; only missing ones are filled:
  * schema version, severity text/number (default `'INFO'` / `SeverityNumber.INFO`),
  * timestamp, resource. The logger's scope always replaces any scope on the input.
  * Trace correlation fields (trace id, span id, trace flags, baggage) fall back to
  * the active trace context when not already set on the record. Optional fields
  * (`body`, `observedTimeUnixNano`, `eventName`, `categoryName`, `flags`,
  * `droppedAttributesCount`) are carried through only when present. The publish
  * phase is the lowercased final `severityText`.
  *
  * ```typescript no_run
  * import { getLoggerProvider, LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const logger = getLoggerProvider().getLogger('checkout');
  * logger.emitRecord(
  *   new LogRecordBuilder()
  *     .setEventName('order.placed')
  *     .setJsonBody({ orderId: 'ord_9', total: 42.5 })
  *     .setSeverity('INFO'),
  * );
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
      attributes: { ...record.attributes || {} },
      scope: { ...this.#scope },
      resource: record.resource ?? this.#provider.resource
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
  * Emits a record at DEBUG severity (severity number 5).
  *
  * Shorthand for `emit` with `severityText: 'DEBUG'`.
  *
  * ```typescript no_run
  * import { getLoggerProvider } from 'internal:opentelemetry/logs';
  *
  * getLoggerProvider().getLogger('db').debug('query executed', { rows: 12 });
  * ```
  */
  debug(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, {
      severityText: 'DEBUG',
      severityNumber: SeverityNumber.DEBUG,
      attributes
    });
  }
  /**
  * Emits a record at INFO severity (severity number 9).
  *
  * Shorthand for `emit` with `severityText: 'INFO'`.
  *
  * ```typescript no_run
  * import { getLoggerProvider } from 'internal:opentelemetry/logs';
  *
  * getLoggerProvider().getLogger('http').info('request handled', { status: 200 });
  * ```
  */
  info(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, {
      severityText: 'INFO',
      severityNumber: SeverityNumber.INFO,
      attributes
    });
  }
  /**
  * Emits a record at WARN severity (severity number 13).
  *
  * Shorthand for `emit` with `severityText: 'WARN'`.
  *
  * ```typescript no_run
  * import { getLoggerProvider } from 'internal:opentelemetry/logs';
  *
  * getLoggerProvider().getLogger('pool').warn('connection retry', { attempt: 2 });
  * ```
  */
  warn(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, {
      severityText: 'WARN',
      severityNumber: SeverityNumber.WARN,
      attributes
    });
  }
  /**
  * Emits a record at ERROR severity (severity number 17).
  *
  * Shorthand for `emit` with `severityText: 'ERROR'`.
  *
  * ```typescript no_run
  * import { getLoggerProvider } from 'internal:opentelemetry/logs';
  *
  * getLoggerProvider().getLogger('api').error('unhandled exception', { code: 'E_IO' });
  * ```
  */
  error(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, {
      severityText: 'ERROR',
      severityNumber: SeverityNumber.ERROR,
      attributes
    });
  }
}
/**
* Fluent builder that assembles a `LogRecord` field by field before emission.
*
* Every setter mutates the in-progress record and returns `this`, so calls chain.
* The builder starts with an empty attribute map and no other fields; nothing is
* filled with defaults here — defaults are applied later when a `Logger` emits
* the built record. Use this when a log needs more than a body and attributes,
* such as an event name, a category, an explicit dropped-attribute count, or a
* trace context detached from the ambient one. Call `build` to snapshot the
* record, or hand the builder straight to `Logger.emitRecord`.
*
* ```typescript no_run
* import { LogRecordBuilder, SeverityNumber, getLoggerProvider } from 'internal:opentelemetry/logs';
*
* const record = new LogRecordBuilder()
*   .setTextBody('cache miss')
*   .setSeverity('WARN', SeverityNumber.WARN)
*   .setAttributes({ key: 'user:7', region: 'us-east' })
*   .setEventName('cache.miss')
*   .build();
*
* getLoggerProvider().getLogger('cache').emitRecord(record);
* ```
*/
export class LogRecordBuilder {
  /** In-progress record accumulated by the setters; always carries an attribute map. */
  #record: Partial<LogRecord> & {
    attributes: Attributes;
  };
  /**
  * Creates an empty builder with an empty attribute map and no other fields set.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const builder = new LogRecordBuilder();
  * ```
  */
  constructor() {
    this.#record = { attributes: {} };
  }
  /**
  * Sets the record body to any value, unchanged.
  *
  * Use this when the body may be a string, number, boolean, or structured
  * object and you do not want coercion; `setTextBody` and `setJsonBody` are
  * intent-revealing variants.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setBody({ event: 'ping', ok: true });
  * ```
  */
  setBody(body: unknown): this {
    this.#record.body = body;
    return this;
  }
  /**
  * Sets the record body to the string form of the given value.
  *
  * The value is passed through `String()`, so non-string inputs are stringified.
  * Use this for human-readable log messages.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setTextBody('user signed in');
  * ```
  */
  setTextBody(body: string): this {
    this.#record.body = String(body);
    return this;
  }
  /**
  * Sets the record body to a structured value, unchanged.
  *
  * Behaves like `setBody` but signals intent that the body is structured JSON
  * data rather than a text message.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setJsonBody({ orderId: 'ord_1', items: 3 });
  * ```
  */
  setJsonBody(body: unknown): this {
    this.#record.body = body;
    return this;
  }
  /**
  * Sets the severity text and, optionally, the severity number.
  *
  * When `severityNumber` is omitted the number field is cleared, letting the
  * emitting logger apply its default (`SeverityNumber.INFO`). Passing an explicit
  * number pins it. The text is stored as given, so callers control casing.
  *
  * ```typescript no_run
  * import { LogRecordBuilder, SeverityNumber } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setSeverity('ERROR', SeverityNumber.ERROR);
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
  * Sets a single attribute by key, replacing any previous value for that key.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setAttribute('http.status_code', 503);
  * ```
  */
  setAttribute(key: string, value: unknown): this {
    this.#record.attributes[key] = value;
    return this;
  }
  /**
  * Merges a map of attributes into the record, overwriting duplicate keys.
  *
  * A nullish argument is treated as an empty map. Existing attributes not present
  * in the argument are kept.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setAttributes({ region: 'eu', shard: 4 });
  * ```
  */
  setAttributes(attributes: Attributes): this {
    Object.assign(this.#record.attributes, attributes || {});
    return this;
  }
  /**
  * Sets the event name that identifies this record as a named event.
  *
  * The value is coerced to a string. Event names typically follow a dotted
  * namespace such as `user.login`.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setEventName('user.login');
  * ```
  */
  setEventName(name: string): this {
    this.#record.eventName = String(name);
    return this;
  }
  /**
  * Sets the category name used to group related records.
  *
  * The value is coerced to a string.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setCategory('auth');
  * ```
  */
  setCategory(name: string): this {
    this.#record.categoryName = String(name);
    return this;
  }
  /**
  * Records how many attributes were dropped before this record was built.
  *
  * The count is coerced with `Number()` and any non-numeric or NaN value becomes
  * `0`. Set this when you have already trimmed attributes upstream and want the
  * loss reflected in the exported record.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setDroppedAttributesCount(3);
  * ```
  */
  setDroppedAttributesCount(count: number): this {
    this.#record.droppedAttributesCount = Number(count) || 0;
    return this;
  }
  /**
  * Attaches an explicit trace context, or clears it when given nullish/empty context.
  *
  * Each of trace id, span id, trace flags, and baggage is set when present on the
  * given context and deleted otherwise, so passing `null` or an empty object
  * removes any previously set correlation fields. Use this to correlate a record
  * with a specific span rather than the ambient one the logger would capture.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const b = new LogRecordBuilder().setContext({
  *   traceId: '5b8aa5a2d2c872e8321cf37308d69df2',
  *   spanId: '051581bf3cb55c13',
  *   traceFlags: 1,
  * });
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
  * Snapshots the accumulated record into a plain `LogRecord`.
  *
  * The returned record is a shallow copy with its own copied attribute map, so
  * further mutation of the builder does not affect it. Only fields that were
  * explicitly set are present; defaults are applied later at emission. The
  * builder can be reused after `build`.
  *
  * ```typescript no_run
  * import { LogRecordBuilder } from 'internal:opentelemetry/logs';
  *
  * const record = new LogRecordBuilder().setTextBody('done').build();
  * ```
  */
  build(): LogRecord {
    return {
      ...this.#record,
      attributes: { ...this.#record.attributes || {} }
    };
  }
}
/**
* Returns a log record with attribute count and value-length limits applied.
*
* When neither limit is finite the original record is returned unchanged, so
* this is cheap to call unconditionally. Otherwise attributes beyond
* `attributeCountLimit` are dropped and string values longer than
* `attributeValueLengthLimit` are truncated; any newly dropped attributes are
* added to the record's `droppedAttributesCount`. Kept separate from logger
* emission so SDK processors can enforce limits at export time without changing
* what loggers produce.
*
* ```typescript no_run
* import { applyLogLimits, LogRecordBuilder } from 'internal:opentelemetry/logs';
*
* const record = new LogRecordBuilder()
*   .setAttributes({ a: 1, b: 2, c: 'a very long string value' })
*   .build();
*
* const limited = applyLogLimits(record, {
*   attributeCountLimit: 2,
*   attributeValueLengthLimit: 8,
* });
* ```
*/
export function applyLogLimits(log: LogRecord, limits: {
  attributeCountLimit?: number;
  attributeValueLengthLimit?: number;
} = {}): LogRecord {
  const hasLimit = Number.isFinite(limits.attributeCountLimit ?? Infinity) || Number.isFinite(limits.attributeValueLengthLimit ?? Infinity);
  if (!hasLimit) return log;
  const { attrs, dropped } = limitAttributeEntries(log.attributes || {}, limits);
  return {
    ...log,
    attributes: attrs,
    ...dropped > 0 ? { droppedAttributesCount: (log.droppedAttributesCount || 0) + dropped } : {}
  };
}
const loggerProviderContext = new Context<LoggerProvider | null>('otel:logger-provider');
let defaultLoggerProvider = new LoggerProvider();
/**
* Returns the active `LoggerProvider` for the current async context.
*
* Resolves to the provider installed by an enclosing `runWithLoggerProvider`
* call if one is on the async-context stack; otherwise the process-wide default
* (set by `setLoggerProvider`, or the built-in provider at startup). This is the
* entry point most code uses to obtain a logger.
*
* ```typescript no_run
* import { getLoggerProvider } from 'internal:opentelemetry/logs';
*
* const logger = getLoggerProvider().getLogger('app');
* ```
*/
export function getLoggerProvider(): LoggerProvider {
  return loggerProviderContext.get() || defaultLoggerProvider;
}
/**
* Replaces the process-wide default `LoggerProvider`.
*
* Affects every subsequent `getLoggerProvider` call that is not inside a
* `runWithLoggerProvider` scope. Typically called once at startup by the SDK
* after building a provider with the desired resource. To override a provider
* only for a bounded region, prefer `runWithLoggerProvider`.
*
* ```typescript no_run
* import { LoggerProvider, setLoggerProvider } from 'internal:opentelemetry/logs';
* import { Resource } from 'internal:opentelemetry/common';
*
* setLoggerProvider(new LoggerProvider({ resource: new Resource({ 'service.name': 'api' }) }));
* ```
*/
export function setLoggerProvider(provider: LoggerProvider): void {
  defaultLoggerProvider = provider;
}
/**
* Runs a function with a scoped `LoggerProvider` visible to `getLoggerProvider`.
*
* Installs `provider` in the async-context slot for the duration of `fn`,
* including across `await` boundaries, then restores the previous value. Returns
* whatever `fn` returns (its promise, if async). Use this to give a request,
* test, or child scope its own provider without mutating the global default.
*
* ```typescript no_run
* import { LoggerProvider, runWithLoggerProvider, getLoggerProvider } from 'internal:opentelemetry/logs';
*
* const scoped = new LoggerProvider();
* await runWithLoggerProvider(scoped, async () => {
*   getLoggerProvider().getLogger('req').info('handling request');
* });
* ```
*/
export function runWithLoggerProvider<R>(provider: LoggerProvider, fn: () => R): R {
  return loggerProviderContext.runWithValue(provider, fn);
}
/**
* Runs a function with any scoped logger provider suppressed.
*
* Clears the async-context slot for the duration of `fn`, so `getLoggerProvider`
* falls back to the process-wide default even when called inside an enclosing
* `runWithLoggerProvider` scope. Returns whatever `fn` returns.
*
* ```typescript no_run
* import { runWithoutLoggerProvider, getLoggerProvider } from 'internal:opentelemetry/logs';
*
* runWithoutLoggerProvider(() => {
*   getLoggerProvider().getLogger('bootstrap').info('using default provider');
* });
* ```
*/
export function runWithoutLoggerProvider<R>(fn: () => R): R {
  return loggerProviderContext.runWithValue(null, fn);
}
