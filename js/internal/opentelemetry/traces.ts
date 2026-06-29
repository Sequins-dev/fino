/**
* Trace providers, tracers, spans, sampling, and active span context.
*
* This internal module turns application span calls and runtime trace-topic
* events into `SpanRecord` payloads. It owns the default tracer provider,
* active-span context, sampler hooks, span mutation topics, and span limit
* application used by the SDK.
*
* Spans publish a start record at construction time and an end record when
* `end()` is called. Attribute, event, link, status, and rename mutations are
* published as separate topic records so processors can assemble or observe
* them without coupling directly to `Span` instances. Names are required to be
* non-empty; repeated `end()` calls are ignored.
*
* ```typescript no_run
* const tracer = getTracerProvider().getTracer('orders', '1.0.0');
* const span = tracer.startSpan('orders.create');
* span.setAttribute('tenant', 'acme').end({ status: { code: 'OK' } });
* ```
*
* See OpenTelemetry traces:
* https://opentelemetry.io/docs/concepts/signals/traces/
*
* @internal
*/
import { Context } from '../../context/index.ts';
import { Topic, topic } from '../../context/topic.ts';
import { Baggage, BaseProvider, OTEL_SCHEMA_VERSION, currentActiveTelemetryContext, getActiveBaggage, limitAttributeEntries, normalizeScope, nowUnixNano, randomHex, registerActiveSpanContextGetter, requireNonEmptyName, runWithActiveContext, runWithBaggage, topicNames } from './common.ts';
import type { ActiveTelemetryContext, Attributes, SamplingResult, ScopeInfo, SpanEndOptions, SpanEventRecord, SpanLimits, SpanLinkContext, SpanLinkRecord, SpanRecord, SpanStartOptions, SpanStatus, TraceContext } from './common.ts';
/**
* Sampler class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = Sampler;
* ```
*/
export class Sampler {
  /**
  * shouldSample member on Sampler.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Sampler.prototype.shouldSample;
  * ```
  */
  shouldSample(_record: SpanRecord): SamplingResult | boolean {
    return true;
  }
}
/**
* AlwaysOnSampler class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = AlwaysOnSampler;
* ```
*/
export class AlwaysOnSampler extends Sampler {}
/**
* TracerProvider class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = TracerProvider;
* ```
*/
export class TracerProvider extends BaseProvider {
  /**
  * getTracer member on TracerProvider.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = TracerProvider.prototype.getTracer;
  * ```
  */
  getTracer(name: string, version?: string, options?: {
    schemaUrl?: string | null;
    attributes?: Attributes;
    droppedAttributesCount?: number;
  }): Tracer {
    return new Tracer(this, normalizeScope(name, version, options?.schemaUrl, options?.attributes, options?.droppedAttributesCount));
  }
}
/**
* Span class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = Span;
* ```
*/
export class Span {
  /**
  * #tracer member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#tracer';
  * ```
  */
  #tracer: Tracer;
  /**
  * #name member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#name';
  * ```
  */
  #name: string;
  /**
  * #traceId member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#traceId';
  * ```
  */
  #traceId: string;
  /**
  * #spanId member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#spanId';
  * ```
  */
  #spanId: string;
  /**
  * #parentSpanId member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#parentSpanId';
  * ```
  */
  #parentSpanId: string | null;
  /**
  * #startTimeUnixNano member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#startTimeUnixNano';
  * ```
  */
  #startTimeUnixNano: number;
  /**
  * #ended member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#ended';
  * ```
  */
  #ended: boolean;
  /**
  * #kind member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Span.#kind';
  * ```
  */
  #kind: string;
  /**
  * constructor member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const instance = new Span();
  * ```
  */
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
      attributes: { ...options.attributes || {} },
      kind: this.#kind
    });
    if (Array.isArray(options.links)) {
      for (const link of options.links) this.addLink(link, link.attributes || {});
    }
  }
  /**
  * traceId member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const getter = Span.prototype.traceId;
  * ```
  */
  get traceId(): string {
    return this.#traceId;
  }
  /**
  * spanId member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const getter = Span.prototype.spanId;
  * ```
  */
  get spanId(): string {
    return this.#spanId;
  }
  /**
  * Publishes a non-start/end span mutation on the tracer topics.
  *
  * The payload is enriched with the current span identity and kind before it is
  * emitted. Callers provide the mutation-specific fields; this helper does not
  * validate attribute values or event payloads.
  *
  * ```typescript no_run
  * const helper = 'Span.#publishMutation';
  * ```
  */
  #publishMutation(phase: 'attribute' | 'event' | 'link' | 'status' | 'rename', payload: Record<string, unknown>): void {
    this.#tracer.publishTrace(phase, {
      schemaVersion: OTEL_SCHEMA_VERSION,
      operation: this.#name,
      traceId: this.#traceId,
      spanId: this.#spanId,
      parentSpanId: this.#parentSpanId,
      kind: this.#kind,
      ...payload
    });
  }
  /**
  * setAttribute member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.setAttribute;
  * ```
  */
  setAttribute(key: string, value: unknown): this {
    this.#publishMutation('attribute', {
      timeUnixNano: nowUnixNano(),
      attributeKey: key,
      attributeValue: value
    });
    return this;
  }
  /**
  * setAttributes member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.setAttributes;
  * ```
  */
  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes || {})) this.setAttribute(key, value);
    return this;
  }
  /**
  * addEvent member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.addEvent;
  * ```
  */
  addEvent(name: string, attributes: Attributes = {}, timeUnixNano: number = nowUnixNano()): this {
    this.#publishMutation('event', {
      timeUnixNano,
      event: {
        name,
        attributes: { ...attributes },
        timeUnixNano
      }
    });
    return this;
  }
  /**
  * addLink member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.addLink;
  * ```
  */
  addLink(linkContext: SpanLinkContext, attributes: Attributes = {}): this {
    this.#publishMutation('link', {
      timeUnixNano: nowUnixNano(),
      link: {
        traceId: linkContext.traceId,
        spanId: linkContext.spanId,
        traceState: linkContext.traceState,
        attributes: { ...attributes },
        flags: linkContext.flags ?? 1
      }
    });
    return this;
  }
  /**
  * setStatus member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.setStatus;
  * ```
  */
  setStatus(status: SpanStatus | null): this {
    this.#publishMutation('status', {
      timeUnixNano: nowUnixNano(),
      status: status ? { ...status } : null
    });
    return this;
  }
  /**
  * recordException member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.recordException;
  * ```
  */
  recordException(error: unknown, attributes: Attributes = {}): this {
    const err = error instanceof Error ? error : new Error(String(error));
    this.setStatus({
      code: 'ERROR',
      message: err.message
    });
    return this.addEvent('exception', {
      'exception.type': err.name,
      'exception.message': err.message,
      ...err.stack ? { 'exception.stacktrace': err.stack } : {},
      ...attributes
    });
  }
  /**
  * updateName member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.updateName;
  * ```
  */
  updateName(name: string): this {
    const nextName = requireNonEmptyName('span', name);
    this.#publishMutation('rename', {
      timeUnixNano: nowUnixNano(),
      nextOperation: nextName
    });
    this.#name = nextName;
    return this;
  }
  /**
  * isRecording member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.isRecording;
  * ```
  */
  isRecording(): boolean {
    return !this.#ended;
  }
  /**
  * end member on Span.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Span.prototype.end;
  * ```
  */
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
          attributeValue: value
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
        status: { ...options.status }
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
      kind: this.#kind
    });
  }
}
/**
* Tracer class exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const ctor = Tracer;
* ```
*/
export class Tracer {
  /**
  * #provider member on Tracer.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Tracer.#provider';
  * ```
  */
  #provider: TracerProvider;
  /**
  * #scope member on Tracer.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Tracer.#scope';
  * ```
  */
  #scope: ScopeInfo;
  /**
  * #topics member on Tracer.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const field = 'Tracer.#topics';
  * ```
  */
  #topics: Record<'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename', Array<Topic<SpanRecord & Record<string, unknown>>>>;
  /**
  * constructor member on Tracer.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const instance = new Tracer();
  * ```
  */
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
      rename: topicNames('trace', this.#scope, 'rename').map((name) => topic(name))
    };
  }
  /**
  * scope member on Tracer.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const getter = Tracer.prototype.scope;
  * ```
  */
  get scope(): ScopeInfo {
    return { ...this.#scope };
  }
  /**
  * publishTrace member on Tracer.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Tracer.prototype.publishTrace;
  * ```
  */
  publishTrace(kind: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename', payload: SpanRecord & Record<string, unknown>): void {
    const record = {
      ...payload,
      scope: { ...this.#scope },
      resource: this.#provider.resource
    };
    for (const target of this.#topics[kind]) target.publish(record);
  }
  /**
  * startSpan member on Tracer.
  *
  * Defaults and error behavior follow the containing runtime object. Values may be absent or no-op when telemetry is disabled, shutdown, or scoped out by context.
  *
  * ```typescript no_run
  * const member = Tracer.prototype.startSpan;
  * ```
  */
  startSpan(name: string, options: SpanStartOptions = {}): Span {
    return new Span(this, name, options);
  }
}
/**
* applySpanLimits function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = applySpanLimits;
* ```
*/
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
    ...droppedAttrs > 0 ? { droppedAttributesCount: (span.droppedAttributesCount || 0) + droppedAttrs } : {},
    ...span.events !== undefined || allEvents.length > 0 ? { events: keptEvents.map((event) => {
      const { attrs: evAttrs, dropped: evDropped } = limitAttributeEntries(event.attributes || {}, limits);
      return {
        ...event,
        attributes: evAttrs,
        ...evDropped > 0 ? { droppedAttributesCount: (event.droppedAttributesCount || 0) + evDropped } : {}
      };
    }) } : {},
    ...droppedEvents > 0 ? { droppedEventsCount: (span.droppedEventsCount || 0) + droppedEvents } : {},
    ...span.links !== undefined || allLinks.length > 0 ? { links: keptLinks.map((link) => {
      const { attrs: lnAttrs, dropped: lnDropped } = limitAttributeEntries(link.attributes || {}, limits);
      return {
        ...link,
        attributes: lnAttrs,
        ...lnDropped > 0 ? { droppedAttributesCount: (link.droppedAttributesCount || 0) + lnDropped } : {}
      };
    }) } : {},
    ...droppedLinks > 0 ? { droppedLinksCount: (span.droppedLinksCount || 0) + droppedLinks } : {}
  };
}
/**
* isScopedTraceTopic function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = isScopedTraceTopic;
* ```
*/
export function isScopedTraceTopic(name: string, phase: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename'): boolean {
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
/**
* getTracerProvider function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = getTracerProvider;
* ```
*/
export function getTracerProvider(): TracerProvider {
  return tracerProviderContext.get() || defaultTracerProvider;
}
/**
* setTracerProvider function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = setTracerProvider;
* ```
*/
export function setTracerProvider(provider: TracerProvider): void {
  defaultTracerProvider = provider;
}
/**
* runWithTracerProvider function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = runWithTracerProvider;
* ```
*/
export function runWithTracerProvider<R>(provider: TracerProvider, fn: () => R): R {
  return tracerProviderContext.runWithValue(provider, fn);
}
/**
* runWithoutTracerProvider function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = runWithoutTracerProvider;
* ```
*/
export function runWithoutTracerProvider<R>(fn: () => R): R {
  return tracerProviderContext.runWithValue(null, fn);
}
/**
* isTracerProviderContextEnabled function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = isTracerProviderContextEnabled;
* ```
*/
export function isTracerProviderContextEnabled(): boolean {
  return tracerProviderContext.get() !== null;
}
/**
* getActiveSpan function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = getActiveSpan;
* ```
*/
export function getActiveSpan(): Span | undefined {
  return activeSpanContext.get();
}
/**
* getActiveSpanContext function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = getActiveSpanContext;
* ```
*/
export function getActiveSpanContext(): TraceContext | null {
  const explicit = currentActiveTelemetryContext();
  const baggage = getActiveBaggage();
  if (explicit) {
    return {
      ...explicit,
      traceFlags: explicit.traceFlags ?? 1,
      baggage
    };
  }
  const span = activeSpanContext.get();
  if (!span) return baggage ? { baggage } : null;
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: 1,
    baggage
  };
}
/**
* runWithActiveSpan function exposed by the OpenTelemetry API.
*
* Documents behavior, defaults, return shape, and failure caveats for generated API documentation.
*
* ```typescript no_run
* const fn = runWithActiveSpan;
* ```
*/
export function runWithActiveSpan<R>(span: Span, fn: () => R): R {
  const inherited = getActiveSpanContext();
  const nextContext: ActiveTelemetryContext = {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: inherited?.traceFlags ?? 1,
    ...inherited?.traceState ? { traceState: inherited.traceState } : {},
    ...inherited?.baggage !== undefined ? { baggage: inherited.baggage } : {}
  };
  return activeSpanContext.runWithValue(span, () => runWithActiveContext(nextContext, () => nextContext.baggage instanceof Baggage ? runWithBaggage(nextContext.baggage, fn) : fn()));
}
registerActiveSpanContextGetter(getActiveSpanContext);
