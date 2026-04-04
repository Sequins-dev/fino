import { Context } from '../runtime/context.mts';
import { Topic, topic } from '../util/topic.mts';
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

export enum SeverityNumber {
  TRACE = 1,
  TRACE2 = 2,
  TRACE3 = 3,
  TRACE4 = 4,
  DEBUG = 5,
  DEBUG2 = 6,
  DEBUG3 = 7,
  DEBUG4 = 8,
  INFO = 9,
  INFO2 = 10,
  INFO3 = 11,
  INFO4 = 12,
  WARN = 13,
  WARN2 = 14,
  WARN3 = 15,
  WARN4 = 16,
  ERROR = 17,
  ERROR2 = 18,
  ERROR3 = 19,
  ERROR4 = 20,
  FATAL = 21,
  FATAL2 = 22,
  FATAL3 = 23,
  FATAL4 = 24,
}

export class LoggerProvider extends BaseProvider {
  getLogger(
    name: string,
    version?: string,
    options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number },
  ): Logger {
    return new Logger(this, normalizeScope(name, version, options?.schemaUrl, options?.attributes, options?.droppedAttributesCount));
  }
}

export class Logger {
  #provider: LoggerProvider;
  #scope: ScopeInfo;
  // Pre-cached topic sets keyed by severity suffix, plus the shared record topic.
  #topicsByPhase: Map<string, Array<Topic<LogRecord>>>;
  #recordTopic: Topic<LogRecord>;

  constructor(provider: LoggerProvider, scope: ScopeInfo) {
    this.#provider = provider;
    this.#scope = scope;
    this.#topicsByPhase = new Map();
    this.#recordTopic = topic<LogRecord>('otel:log:record');
  }

  #getTopics(phase: string): Array<Topic<LogRecord>> {
    let topics = this.#topicsByPhase.get(phase);
    if (!topics) {
      topics = topicNames('log', this.#scope, phase).map((name) => topic<LogRecord>(name));
      this.#topicsByPhase.set(phase, topics);
    }
    return topics;
  }

  #publishRecord(record: LogRecord, phase: string): void {
    for (const t of this.#getTopics(phase)) t.publish(record);
    this.#recordTopic.publish(record);
  }

  get scope(): ScopeInfo {
    return {
      ...this.#scope,
      ...(this.#scope.attributes ? { attributes: { ...this.#scope.attributes } } : {}),
    };
  }

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

  debug(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'DEBUG', severityNumber: SeverityNumber.DEBUG, attributes });
  }

  info(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'INFO', severityNumber: SeverityNumber.INFO, attributes });
  }

  warn(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'WARN', severityNumber: SeverityNumber.WARN, attributes });
  }

  error(body: unknown, attributes: Attributes = {}): void {
    this.emit(body, { severityText: 'ERROR', severityNumber: SeverityNumber.ERROR, attributes });
  }
}

export class LogRecordBuilder {
  #record: Partial<LogRecord> & { attributes: Attributes };

  constructor() {
    this.#record = { attributes: {} };
  }

  setBody(body: unknown): this {
    this.#record.body = body;
    return this;
  }

  setTextBody(body: string): this {
    this.#record.body = String(body);
    return this;
  }

  setJsonBody(body: unknown): this {
    this.#record.body = body;
    return this;
  }

  setSeverity(severityText: string, severityNumber?: number): this {
    this.#record.severityText = severityText;
    if (severityNumber === undefined) {
      delete this.#record.severityNumber;
    } else {
      this.#record.severityNumber = severityNumber;
    }
    return this;
  }

  setAttribute(key: string, value: unknown): this {
    this.#record.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    Object.assign(this.#record.attributes, attributes || {});
    return this;
  }

  setEventName(name: string): this {
    this.#record.eventName = String(name);
    return this;
  }

  setCategory(name: string): this {
    this.#record.categoryName = String(name);
    return this;
  }

  setDroppedAttributesCount(count: number): this {
    this.#record.droppedAttributesCount = Number(count) || 0;
    return this;
  }

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

  build(): LogRecord {
    return {
      ...this.#record,
      attributes: { ...(this.#record.attributes || {}) },
    };
  }
}

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

export function getLoggerProvider(): LoggerProvider {
  return loggerProviderContext.get() || defaultLoggerProvider;
}

export function setLoggerProvider(provider: LoggerProvider): void {
  defaultLoggerProvider = provider;
}

export function runWithLoggerProvider<R>(provider: LoggerProvider, fn: () => R): R {
  return loggerProviderContext.runWithValue(provider, fn);
}

export function runWithoutLoggerProvider<R>(fn: () => R): R {
  return loggerProviderContext.runWithValue(null, fn);
}
