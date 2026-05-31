/**
 * internal/opentelemetry/traces — internal runtime module.
 *
 * 
 * @internal
 */

import { Context } from '../../context/index.mts';
import { Topic, topic } from '../../context/topic.mts';
import {
  Baggage,
  BaseProvider,
  OTEL_SCHEMA_VERSION,
  currentActiveTelemetryContext,
  getActiveBaggage,
  limitAttributeEntries,
  normalizeScope,
  nowUnixNano,
  randomHex,
  registerActiveSpanContextGetter,
  requireNonEmptyName,
  runWithActiveContext,
  runWithBaggage,
  topicNames,
} from './common.mts';
import type {
  ActiveTelemetryContext,
  Attributes,
  SamplingResult,
  ScopeInfo,
  SpanEndOptions,
  SpanEventRecord,
  SpanLimits,
  SpanLinkContext,
  SpanLinkRecord,
  SpanRecord,
  SpanStartOptions,
  SpanStatus,
  TraceContext,
} from './common.mts';

export class Sampler {
  shouldSample(_record: SpanRecord): SamplingResult | boolean {
    return true;
  }
}

export class AlwaysOnSampler extends Sampler {}

export class TracerProvider extends BaseProvider {
  getTracer(
    name: string,
    version?: string,
    options?: { schemaUrl?: string | null; attributes?: Attributes; droppedAttributesCount?: number },
  ): Tracer {
    return new Tracer(this, normalizeScope(name, version, options?.schemaUrl, options?.attributes, options?.droppedAttributesCount));
  }
}

export class Span {
  #tracer: Tracer;
  #name: string;
  #traceId: string;
  #spanId: string;
  #parentSpanId: string | null;
  #startTimeUnixNano: number;
  #ended: boolean;
  #kind: string;

  constructor(tracer: Tracer, name: string, options: SpanStartOptions = {}) {
    const parentContext = getActiveSpanContext();
    const spanName = requireNonEmptyName('span', name);
    this.#tracer = tracer;
    this.#name = spanName;
    this.#traceId = (options.traceId || parentContext?.traceId || randomHex(32)).toLowerCase();
    this.#spanId = randomHex(16).toLowerCase();
    this.#parentSpanId = options.parentSpanId === undefined ? parentContext?.spanId || null : options.parentSpanId;
    this.#startTimeUnixNano = nowUnixNano();
    this.#ended = false;
    this.#kind = options.kind || 'internal';

    this.#tracer.publishTrace('start', {
      schemaVersion: OTEL_SCHEMA_VERSION,
      operation: this.#name,
      traceId: this.#traceId,
      spanId: this.#spanId,
      parentSpanId: this.#parentSpanId,
      timeUnixNano: this.#startTimeUnixNano,
      attributes: { ...(options.attributes || {}) },
      kind: this.#kind,
    });
    if (Array.isArray(options.links)) {
      for (const link of options.links) this.addLink(link, link.attributes || {});
    }
  }

  get traceId(): string {
    return this.#traceId;
  }

  get spanId(): string {
    return this.#spanId;
  }

  #publishMutation(phase: 'attribute' | 'event' | 'link' | 'status' | 'rename', payload: Record<string, unknown>): void {
    this.#tracer.publishTrace(phase, {
      schemaVersion: OTEL_SCHEMA_VERSION,
      operation: this.#name,
      traceId: this.#traceId,
      spanId: this.#spanId,
      parentSpanId: this.#parentSpanId,
      kind: this.#kind,
      ...payload,
    });
  }

  setAttribute(key: string, value: unknown): this {
    this.#publishMutation('attribute', {
      timeUnixNano: nowUnixNano(),
      attributeKey: key,
      attributeValue: value,
    });
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes || {})) this.setAttribute(key, value);
    return this;
  }

  addEvent(name: string, attributes: Attributes = {}, timeUnixNano: number = nowUnixNano()): this {
    this.#publishMutation('event', {
      timeUnixNano,
      event: { name, attributes: { ...attributes }, timeUnixNano },
    });
    return this;
  }

  addLink(linkContext: SpanLinkContext, attributes: Attributes = {}): this {
    this.#publishMutation('link', {
      timeUnixNano: nowUnixNano(),
      link: {
        traceId: linkContext.traceId,
        spanId: linkContext.spanId,
        traceState: linkContext.traceState,
        attributes: { ...attributes },
        flags: linkContext.flags ?? 1,
      },
    });
    return this;
  }

  setStatus(status: SpanStatus | null): this {
    this.#publishMutation('status', {
      timeUnixNano: nowUnixNano(),
      status: status ? { ...status } : null,
    });
    return this;
  }

  recordException(error: unknown, attributes: Attributes = {}): this {
    const err = error instanceof Error ? error : new Error(String(error));
    this.setStatus({ code: 'ERROR', message: err.message });
    return this.addEvent('exception', {
      'exception.type': err.name,
      'exception.message': err.message,
      ...(err.stack ? { 'exception.stacktrace': err.stack } : {}),
      ...attributes,
    });
  }

  updateName(name: string): this {
    const nextName = requireNonEmptyName('span', name);
    this.#publishMutation('rename', {
      timeUnixNano: nowUnixNano(),
      nextOperation: nextName,
    });
    this.#name = nextName;
    return this;
  }

  isRecording(): boolean {
    return !this.#ended;
  }

  end(options: SpanEndOptions = {}): void {
    if (this.#ended) return;
    this.#ended = true;
    const endTimeUnixNano = nowUnixNano();
    // Publish attribute/status mutations using the end time so they don't post-date the span end.
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        this.#tracer.publishTrace('attribute', {
          schemaVersion: OTEL_SCHEMA_VERSION,
          operation: this.#name,
          traceId: this.#traceId,
          spanId: this.#spanId,
          parentSpanId: this.#parentSpanId,
          kind: this.#kind,
          timeUnixNano: endTimeUnixNano,
          attributeKey: key,
          attributeValue: value,
        });
      }
    }
    if (options.status) {
      this.#tracer.publishTrace('status', {
        schemaVersion: OTEL_SCHEMA_VERSION,
        operation: this.#name,
        traceId: this.#traceId,
        spanId: this.#spanId,
        parentSpanId: this.#parentSpanId,
        kind: this.#kind,
        timeUnixNano: endTimeUnixNano,
        status: { ...options.status },
      });
    }
    this.#tracer.publishTrace('end', {
      schemaVersion: OTEL_SCHEMA_VERSION,
      operation: this.#name,
      traceId: this.#traceId,
      spanId: this.#spanId,
      parentSpanId: this.#parentSpanId,
      timeUnixNano: endTimeUnixNano,
      startTimeUnixNano: this.#startTimeUnixNano,
      kind: this.#kind,
    });
  }
}

export class Tracer {
  #provider: TracerProvider;
  #scope: ScopeInfo;
  #topics: Record<
    'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename',
    Array<Topic<SpanRecord & Record<string, unknown>>>
  >;

  constructor(provider: TracerProvider, scope: ScopeInfo) {
    this.#provider = provider;
    this.#scope = scope;
    this.#topics = {
      start: topicNames('trace', this.#scope, 'start').map((name) => topic(name)),
      end: topicNames('trace', this.#scope, 'end').map((name) => topic(name)),
      event: topicNames('trace', this.#scope, 'event').map((name) => topic(name)),
      attribute: topicNames('trace', this.#scope, 'attribute').map((name) => topic(name)),
      link: topicNames('trace', this.#scope, 'link').map((name) => topic(name)),
      status: topicNames('trace', this.#scope, 'status').map((name) => topic(name)),
      rename: topicNames('trace', this.#scope, 'rename').map((name) => topic(name)),
    };
  }

  get scope(): ScopeInfo {
    return { ...this.#scope };
  }

  publishTrace(kind: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename', payload: SpanRecord & Record<string, unknown>): void {
    const record = {
      ...payload,
      scope: { ...this.#scope },
      resource: this.#provider.resource,
    };
    for (const target of this.#topics[kind]) target.publish(record);
  }

  startSpan(name: string, options: SpanStartOptions = {}): Span {
    return new Span(this, name, options);
  }
}


export function applySpanLimits(span: SpanRecord, limits: SpanLimits = {}): SpanRecord {
  const { attrs, dropped: droppedAttrs } = limitAttributeEntries(span.attributes || {}, limits);
  const eventLimit = limits.eventCountLimit ?? Number.POSITIVE_INFINITY;
  const linkLimit = limits.linkCountLimit ?? Number.POSITIVE_INFINITY;

  const allEvents = Array.isArray(span.events) ? span.events : [];
  const keptEvents = Number.isFinite(eventLimit) ? allEvents.slice(0, eventLimit) : allEvents;
  const droppedEvents = allEvents.length - keptEvents.length;

  const allLinks = Array.isArray(span.links) ? span.links : [];
  const keptLinks = Number.isFinite(linkLimit) ? allLinks.slice(0, linkLimit) : allLinks;
  const droppedLinks = allLinks.length - keptLinks.length;

  return {
    ...span,
    attributes: attrs,
    ...(droppedAttrs > 0 ? { droppedAttributesCount: (span.droppedAttributesCount || 0) + droppedAttrs } : {}),
    ...(span.events !== undefined || allEvents.length > 0
      ? {
          events: keptEvents.map((event) => {
            const { attrs: evAttrs, dropped: evDropped } = limitAttributeEntries(event.attributes || {}, limits);
            return {
              ...event,
              attributes: evAttrs,
              ...(evDropped > 0 ? { droppedAttributesCount: (event.droppedAttributesCount || 0) + evDropped } : {}),
            };
          }),
        }
      : {}),
    ...(droppedEvents > 0 ? { droppedEventsCount: (span.droppedEventsCount || 0) + droppedEvents } : {}),
    ...(span.links !== undefined || allLinks.length > 0
      ? {
          links: keptLinks.map((link) => {
            const { attrs: lnAttrs, dropped: lnDropped } = limitAttributeEntries(link.attributes || {}, limits);
            return {
              ...link,
              attributes: lnAttrs,
              ...(lnDropped > 0 ? { droppedAttributesCount: (link.droppedAttributesCount || 0) + lnDropped } : {}),
            };
          }),
        }
      : {}),
    ...(droppedLinks > 0 ? { droppedLinksCount: (span.droppedLinksCount || 0) + droppedLinks } : {}),
  };
}

export function isScopedTraceTopic(
  name: string,
  phase: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename',
): boolean {
  if (!name.startsWith('otel:trace:')) return false;
  if (!name.endsWith(`:${phase}`)) return false;
  const remainder = name.slice('otel:trace:'.length, name.length - `:${phase}`.length);
  const segments = remainder.split(':');
  if (segments.length !== 1) return false;
  const [segment] = segments;
  return segment !== undefined && !segment.includes('@');
}

const tracerProviderContext = new Context<TracerProvider | null>('otel:tracer-provider');
const activeSpanContext = new Context<Span>('otel:active-span');
let defaultTracerProvider = new TracerProvider();

export function getTracerProvider(): TracerProvider {
  return tracerProviderContext.get() || defaultTracerProvider;
}

export function setTracerProvider(provider: TracerProvider): void {
  defaultTracerProvider = provider;
}

export function runWithTracerProvider<R>(provider: TracerProvider, fn: () => R): R {
  return tracerProviderContext.runWithValue(provider, fn);
}

export function runWithoutTracerProvider<R>(fn: () => R): R {
  return tracerProviderContext.runWithValue(null, fn);
}

export function isTracerProviderContextEnabled(): boolean {
  return tracerProviderContext.get() !== null;
}

export function getActiveSpan(): Span | undefined {
  return activeSpanContext.get();
}

export function getActiveSpanContext(): TraceContext | null {
  const explicit = currentActiveTelemetryContext();
  const baggage = getActiveBaggage();
  if (explicit) {
    return {
      ...explicit,
      traceFlags: explicit.traceFlags ?? 1,
      baggage,
    };
  }
  const span = activeSpanContext.get();
  if (!span) return baggage ? { baggage } : null;
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: 1,
    baggage,
  };
}

export function runWithActiveSpan<R>(span: Span, fn: () => R): R {
  const inherited = getActiveSpanContext();
  const nextContext: ActiveTelemetryContext = {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: inherited?.traceFlags ?? 1,
    ...(inherited?.traceState ? { traceState: inherited.traceState } : {}),
    ...(inherited?.baggage !== undefined ? { baggage: inherited.baggage } : {}),
  };
  return activeSpanContext.runWithValue(span, () =>
    runWithActiveContext(nextContext, () => (nextContext.baggage instanceof Baggage ? runWithBaggage(nextContext.baggage, fn) : fn())),
  );
}

registerActiveSpanContextGetter(getActiveSpanContext);
