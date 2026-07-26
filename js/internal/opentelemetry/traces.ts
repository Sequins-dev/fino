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
 * non-empty; repeated `end()` calls are ignored. Trace and span IDs are lowercase
 * hex derived from the active span context when one exists, otherwise generated
 * randomly.
 *
 * Everything here is plumbing for the public `fino:opentelemetry` surface. The
 * SDK builds on `applySpanLimits` and the `Sampler` hook to enforce span limits
 * and consumer-side sampling; instrumentation uses `isScopedTraceTopic` to
 * distinguish unversioned scope topics from versioned ones.
 *
 * ```typescript no_run
 * import { getTracerProvider, runWithActiveSpan } from 'internal:opentelemetry/traces';
 *
 * const tracer = getTracerProvider().getTracer('orders', '1.0.0');
 * const span = tracer.startSpan('orders.create');
 * await runWithActiveSpan(span, async () => {
 *   span.setAttribute('tenant', 'acme');
 * });
 * span.end({ status: { code: 'OK' } });
 * ```
 *
 * See OpenTelemetry traces:
 * https://opentelemetry.io/docs/concepts/signals/traces/
 *
 * @internal
 */
import { Context } from '../../context/index.ts';
import { Topic, topic } from '../../context/topic.ts';
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
} from './common.ts';
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
} from './common.ts';
/**
 * Consumer-side sampling hook: decides whether a completed span record should be exported.
 *
 * This is the base class and default policy — its `shouldSample` returns `true`,
 * so every span is kept. Unlike head-based OpenTelemetry samplers, sampling here
 * runs after the span record has been assembled and limited (see the SDK's
 * processor pipeline), which lets a sampler inspect the final attributes, status,
 * and events before deciding. Subclass and override `shouldSample` to drop or
 * enrich records.
 *
 * ```typescript no_run
 * import { Sampler } from 'internal:opentelemetry/traces';
 * import type { SpanRecord, SamplingResult } from 'internal:opentelemetry/common';
 *
 * class ErrorsOnlySampler extends Sampler {
 *   shouldSample(record: SpanRecord): SamplingResult | boolean {
 *     return record.status?.code === 'ERROR';
 *   }
 * }
 * ```
 */
export class Sampler {
  /**
   * Returns whether the given span record should be sampled, or a `SamplingResult` with overrides.
   *
   * The base implementation always returns `true`. A boolean return keeps
   * (`true`) or drops (`false`) the record as-is; returning a `SamplingResult`
   * lets a sampler additionally merge attributes or set `traceState` on the
   * exported record. The record passed in has already had span limits applied.
   *
   * ```typescript no_run
   * import { Sampler } from 'internal:opentelemetry/traces';
   *
   * const keep = new Sampler().shouldSample({
   *   traceId: '00000000000000000000000000000001',
   *   spanId: '0000000000000001',
   * });
   * ```
   */
  shouldSample(_record: SpanRecord): SamplingResult | boolean {
    return true;
  }
}
/**
 * Sampler that keeps every span — the explicit "always on" policy.
 *
 * Behaviorally identical to the base `Sampler`, but named so an SDK configuration
 * can state its intent. This is the default sampler the SDK installs when none is
 * supplied.
 *
 * ```typescript no_run
 * import { AlwaysOnSampler } from 'internal:opentelemetry/traces';
 *
 * const sampler = new AlwaysOnSampler();
 * sampler.shouldSample({
 *   traceId: '00000000000000000000000000000001',
 *   spanId: '0000000000000001',
 * }); // true
 * ```
 */
export class AlwaysOnSampler extends Sampler {}
/**
 * Factory for `Tracer` instances, scoped to a resource.
 *
 * Extends `BaseProvider`, so it carries the `resource` describing the emitting
 * service (defaulting to Fino SDK attributes when constructed without one). Each
 * `getTracer` call mints a `Tracer` bound to a named instrumentation scope; that
 * scope drives which topics span records are published on. There is a
 * process-wide default provider plus a context-scoped override — see
 * `getTracerProvider` and `runWithTracerProvider`.
 *
 * ```typescript no_run
 * import { TracerProvider } from 'internal:opentelemetry/traces';
 * import { Resource } from 'internal:opentelemetry/common';
 *
 * const provider = new TracerProvider({
 *   resource: new Resource({ 'service.name': 'orders' }),
 * });
 * const tracer = provider.getTracer('orders.db', '1.0.0');
 * ```
 */
export class TracerProvider extends BaseProvider {
  /**
   * Returns a `Tracer` bound to the named instrumentation scope and this provider's resource.
   *
   * `name` must be a non-empty string identifying the instrumenting library or
   * subsystem; it throws otherwise. `version` and `options.schemaUrl`,
   * `options.attributes`, and `options.droppedAttributesCount` further qualify
   * the scope and flow through to every emitted record. The scope is normalized
   * via `normalizeScope`, so passing an empty `name` fails fast.
   *
   * ```typescript no_run
   * import { TracerProvider } from 'internal:opentelemetry/traces';
   *
   * const tracer = new TracerProvider().getTracer('http.server', '2.0.0', {
   *   schemaUrl: 'https://opentelemetry.io/schemas/1.27.0',
   * });
   * ```
   */
  getTracer(
    name: string,
    version?: string,
    options?: {
      schemaUrl?: string | null;
      attributes?: Attributes;
      droppedAttributesCount?: number;
    },
  ): Tracer {
    return new Tracer(
      this,
      normalizeScope(
        name,
        version,
        options?.schemaUrl,
        options?.attributes,
        options?.droppedAttributesCount,
      ),
    );
  }
}
/**
 * A single in-progress or completed operation, emitting its lifecycle as topic records.
 *
 * Constructing a span (usually via `Tracer.startSpan`) immediately publishes a
 * `start` record; `end()` publishes an `end` record. Between those, mutation
 * methods (`setAttribute`, `addEvent`, `addLink`, `setStatus`,
 * `recordException`, `updateName`) each publish their own scoped topic record
 * rather than buffering state on the instance, so processors assemble the final
 * span from the record stream. This makes a `Span` a thin publisher, not the
 * system of record.
 *
 * On construction the span inherits `traceId` and `parentSpanId` from the active
 * span context (see `runWithActiveSpan`) unless overridden through
 * `SpanStartOptions`. A fresh random `spanId` is always generated. Span names
 * must be non-empty. `end()` is idempotent — subsequent calls are ignored and
 * `isRecording()` returns `false`.
 *
 * ```typescript no_run
 * import { getTracerProvider } from 'internal:opentelemetry/traces';
 *
 * const tracer = getTracerProvider().getTracer('checkout');
 * const span = tracer.startSpan('checkout.submit', { kind: 'server' });
 * try {
 *   span.setAttribute('cart.size', 3);
 * } catch (err) {
 *   span.recordException(err);
 * } finally {
 *   span.end();
 * }
 * ```
 */
export class Span {
  /** Tracer that created this span; used to publish records on the right scoped topics. */
  #tracer: Tracer;
  /** Current operation name; mutated by `updateName` and stamped on every published record. */
  #name: string;
  /** Lowercase-hex trace ID, inherited from the active context or generated at construction. */
  #traceId: string;
  /** Lowercase-hex span ID, always freshly generated for this span. */
  #spanId: string;
  /** Parent span ID inherited from the active context, or `null` for a root span. */
  #parentSpanId: string | null;
  /** Start timestamp in Unix nanoseconds, captured when the span is constructed. */
  #startTimeUnixNano: number;
  /** Whether `end()` has already run; guards against duplicate end records. */
  #ended: boolean;
  /** OpenTelemetry span kind string (`internal`, `server`, `client`, ...); defaults to `internal`. */
  #kind: string;
  /**
   * Creates a span, derives its identity from the active context, and publishes the `start` record.
   *
   * The trace ID resolves in order of `options.traceId`, the active span
   * context's trace ID, then a new random ID; the parent span ID resolves from
   * `options.parentSpanId` (honoring an explicit `null`) or the active span.
   * `options.attributes` seed the start record, and each entry in `options.links`
   * is emitted as a link record. Throws if `name` is empty.
   *
   * ```typescript no_run
   * import { Span, getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const tracer = getTracerProvider().getTracer('db');
   * const span = new Span(tracer, 'SELECT users', {
   *   kind: 'client',
   *   attributes: { 'db.system': 'postgresql' },
   * });
   * ```
   */
  constructor(tracer: Tracer, name: string, options: SpanStartOptions = {}) {
    const parentContext = getActiveSpanContext();
    const spanName = requireNonEmptyName('span', name);
    this.#tracer = tracer;
    this.#name = spanName;
    this.#traceId = (options.traceId || parentContext?.traceId || randomHex(32)).toLowerCase();
    this.#spanId = randomHex(16).toLowerCase();
    this.#parentSpanId =
      options.parentSpanId === undefined ? parentContext?.spanId || null : options.parentSpanId;
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
  /**
   * The span's lowercase-hex trace ID, shared by every span in the same trace.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('x').startSpan('op');
   * const traceId = span.traceId;
   * ```
   */
  get traceId(): string {
    return this.#traceId;
  }
  /**
   * The span's lowercase-hex span ID, unique to this span within its trace.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('x').startSpan('op');
   * const spanId = span.spanId;
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
   */
  #publishMutation(
    phase: 'attribute' | 'event' | 'link' | 'status' | 'rename',
    payload: Record<string, unknown>,
  ): void {
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
  /**
   * Sets a single attribute on the span by publishing an `attribute` mutation record.
   *
   * Returns `this` for chaining. The value is not validated or truncated here —
   * span limits are applied later by `applySpanLimits` during export. A later
   * write to the same key wins because processors replay records in order.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('http').startSpan('GET /orders');
   * span.setAttribute('http.response.status_code', 200);
   * ```
   */
  setAttribute(key: string, value: unknown): this {
    this.#publishMutation('attribute', {
      timeUnixNano: nowUnixNano(),
      attributeKey: key,
      attributeValue: value,
    });
    return this;
  }
  /**
   * Sets several attributes at once, publishing one `attribute` record per entry.
   *
   * Equivalent to calling `setAttribute` for each own enumerable entry of
   * `attributes`; a nullish argument is treated as empty. Returns `this`.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('http').startSpan('GET /orders');
   * span.setAttributes({ 'http.request.method': 'GET', 'url.path': '/orders' });
   * ```
   */
  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes || {})) this.setAttribute(key, value);
    return this;
  }
  /**
   * Records a timestamped, named event on the span.
   *
   * `timeUnixNano` defaults to now; pass an explicit value to backdate an event.
   * The attributes are shallow-copied into the record. Returns `this`.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('cache').startSpan('lookup');
   * span.addEvent('cache.miss', { 'cache.key': 'user:42' });
   * ```
   */
  addEvent(name: string, attributes: Attributes = {}, timeUnixNano: number = nowUnixNano()): this {
    this.#publishMutation('event', {
      timeUnixNano,
      event: {
        name,
        attributes: { ...attributes },
        timeUnixNano,
      },
    });
    return this;
  }
  /**
   * Adds a link from this span to another span, optionally with link attributes.
   *
   * The link's `flags` default to `1` (sampled) when the context omits them.
   * Links added at construction time via `SpanStartOptions.links` route through
   * this method. Returns `this`.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('batch').startSpan('process');
   * span.addLink(
   *   { traceId: '00000000000000000000000000000002', spanId: '0000000000000002' },
   *   { 'link.kind': 'follows_from' },
   * );
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
        flags: linkContext.flags ?? 1,
      },
    });
    return this;
  }
  /**
   * Sets (or clears) the span's terminal status.
   *
   * Passing a `SpanStatus` publishes a copy of it; passing `null` publishes a
   * cleared status, which processors treat as unset. Returns `this`.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('rpc').startSpan('call');
   * span.setStatus({ code: 'ERROR', message: 'deadline exceeded' });
   * ```
   */
  setStatus(status: SpanStatus | null): this {
    this.#publishMutation('status', {
      timeUnixNano: nowUnixNano(),
      status: status ? { ...status } : null,
    });
    return this;
  }
  /**
   * Records an exception on the span: sets an error status and adds an `exception` event.
   *
   * Non-`Error` values are coerced to an `Error` via `String(error)`. The status
   * is set to `ERROR` with the error message, and an event named `exception` is
   * added with `exception.type`, `exception.message`, and (when present)
   * `exception.stacktrace` attributes, merged with any extra `attributes` you
   * supply. Returns `this`.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('db').startSpan('query');
   * try {
   *   throw new Error('connection reset');
   * } catch (err) {
   *   span.recordException(err, { retryable: true });
   * }
   * ```
   */
  recordException(error: unknown, attributes: Attributes = {}): this {
    const err = error instanceof Error ? error : new Error(String(error));
    this.setStatus({
      code: 'ERROR',
      message: err.message,
    });
    return this.addEvent('exception', {
      'exception.type': err.name,
      'exception.message': err.message,
      ...(err.stack ? { 'exception.stacktrace': err.stack } : {}),
      ...attributes,
    });
  }
  /**
   * Renames the span, publishing a `rename` record and updating the local name.
   *
   * The new name feeds subsequent records' `operation` field. Throws if `name` is
   * empty. Returns `this`.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('http').startSpan('request');
   * span.updateName('GET /orders/:id');
   * ```
   */
  updateName(name: string): this {
    const nextName = requireNonEmptyName('span', name);
    this.#publishMutation('rename', {
      timeUnixNano: nowUnixNano(),
      nextOperation: nextName,
    });
    this.#name = nextName;
    return this;
  }
  /**
   * Returns whether the span is still open (has not been ended).
   *
   * Once `end()` runs this returns `false`, signalling that further mutations,
   * while still published, are logically post-completion.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('x').startSpan('op');
   * span.isRecording(); // true
   * span.end();
   * span.isRecording(); // false
   * ```
   */
  isRecording(): boolean {
    return !this.#ended;
  }
  /**
   * Finalizes the span and publishes its `end` record; idempotent after the first call.
   *
   * Calling `end()` again after the span has ended is a no-op. Any
   * `options.attributes` and `options.status` are published first, stamped with
   * the end timestamp so they do not appear to post-date the span's completion,
   * then the `end` record carries both the end time and the original start time.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const span = getTracerProvider().getTracer('job').startSpan('run');
   * span.end({ status: { code: 'OK' }, attributes: { 'job.records': 128 } });
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
/**
 * Scope-bound span factory that publishes span lifecycle records onto trace topics.
 *
 * A `Tracer` is created by `TracerProvider.getTracer` and carries a fixed
 * instrumentation `ScopeInfo`. It precomputes the topic set for each span phase
 * (start, end, event, attribute, link, status, rename) — one topic for the base
 * scope name plus, when the scope has a version, a versioned topic — so
 * `publishTrace` fans a record out to every matching processor. Instrumentation
 * and application code normally use `startSpan` and let `Span` drive publishing.
 *
 * ```typescript no_run
 * import { getTracerProvider } from 'internal:opentelemetry/traces';
 *
 * const tracer = getTracerProvider().getTracer('orders', '1.0.0');
 * const span = tracer.startSpan('orders.create', { kind: 'server' });
 * span.end();
 * ```
 */
export class Tracer {
  /** Provider that created this tracer; supplies the resource stamped on published records. */
  #provider: TracerProvider;
  /** Immutable instrumentation scope this tracer emits under. */
  #scope: ScopeInfo;
  /** Precomputed per-phase topic lists (base and versioned) that records are published to. */
  #topics: Record<
    'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename',
    Array<Topic<SpanRecord & Record<string, unknown>>>
  >;
  /**
   * Binds the tracer to a provider and scope and precomputes its per-phase topics.
   *
   * Constructed indirectly through `TracerProvider.getTracer`; direct
   * construction requires an already-normalized `ScopeInfo`.
   *
   * ```typescript no_run
   * import { Tracer, TracerProvider } from 'internal:opentelemetry/traces';
   * import { normalizeScope } from 'internal:opentelemetry/common';
   *
   * const tracer = new Tracer(new TracerProvider(), normalizeScope('db', '1.0.0'));
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
      rename: topicNames('trace', this.#scope, 'rename').map((name) => topic(name)),
    };
  }
  /**
   * A defensive copy of this tracer's instrumentation scope.
   *
   * Returns a fresh object each call, so mutating the result cannot alter the
   * tracer's internal scope.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const scope = getTracerProvider().getTracer('db', '1.0.0').scope;
   * scope.name; // 'db'
   * ```
   */
  get scope(): ScopeInfo {
    return { ...this.#scope };
  }
  /**
   * Publishes one span-phase record, enriched with this tracer's scope and resource.
   *
   * The record is shallow-copied and stamped with a copy of the scope and the
   * provider's resource, then published to every topic registered for the given
   * phase. Called by `Span` for each lifecycle event; rarely invoked directly.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const tracer = getTracerProvider().getTracer('db', '1.0.0');
   * tracer.publishTrace('event', {
   *   traceId: '00000000000000000000000000000001',
   *   spanId: '0000000000000001',
   *   event: { name: 'cache.hit' },
   * });
   * ```
   */
  publishTrace(
    kind: 'start' | 'end' | 'event' | 'attribute' | 'link' | 'status' | 'rename',
    payload: SpanRecord & Record<string, unknown>,
  ): void {
    const record = {
      ...payload,
      scope: { ...this.#scope },
      resource: this.#provider.resource,
    };
    for (const target of this.#topics[kind]) target.publish(record);
  }
  /**
   * Starts a new span in this tracer's scope, publishing its `start` record immediately.
   *
   * A convenience wrapper over `new Span(this, name, options)`. Throws if `name`
   * is empty. The returned span inherits trace and parent IDs from the active
   * span context unless `options` overrides them.
   *
   * ```typescript no_run
   * import { getTracerProvider } from 'internal:opentelemetry/traces';
   *
   * const tracer = getTracerProvider().getTracer('http.server');
   * const span = tracer.startSpan('GET /orders', { kind: 'server' });
   * span.end();
   * ```
   */
  startSpan(name: string, options: SpanStartOptions = {}): Span {
    return new Span(this, name, options);
  }
}
/**
 * Applies span limits to a span record, truncating attributes, events, and links and counting drops.
 *
 * Returns a new `SpanRecord` (the input is not mutated). Attribute count and
 * value-length limits are enforced via `limitAttributeEntries` on the span and
 * on each kept event and link; `eventCountLimit` and `linkCountLimit` cap the
 * respective arrays, keeping the earliest entries. Every kind of drop is folded
 * into the matching `dropped*Count` field, added to any count already present.
 * Unlimited dimensions default to positive infinity, meaning "keep everything".
 * Event and link arrays are only included in the output when the input had them.
 *
 * ```typescript no_run
 * import { applySpanLimits } from 'internal:opentelemetry/traces';
 *
 * const limited = applySpanLimits(
 *   {
 *     traceId: '00000000000000000000000000000001',
 *     spanId: '0000000000000001',
 *     attributes: { a: 1, b: 2, c: 3 },
 *   },
 *   { attributeCountLimit: 2 },
 * );
 * limited.droppedAttributesCount; // 1
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
    ...(droppedAttrs > 0
      ? { droppedAttributesCount: (span.droppedAttributesCount || 0) + droppedAttrs }
      : {}),
    ...(span.events !== undefined || allEvents.length > 0
      ? {
          events: keptEvents.map((event) => {
            const { attrs: evAttrs, dropped: evDropped } = limitAttributeEntries(
              event.attributes || {},
              limits,
            );
            return {
              ...event,
              attributes: evAttrs,
              ...(evDropped > 0
                ? { droppedAttributesCount: (event.droppedAttributesCount || 0) + evDropped }
                : {}),
            };
          }),
        }
      : {}),
    ...(droppedEvents > 0
      ? { droppedEventsCount: (span.droppedEventsCount || 0) + droppedEvents }
      : {}),
    ...(span.links !== undefined || allLinks.length > 0
      ? {
          links: keptLinks.map((link) => {
            const { attrs: lnAttrs, dropped: lnDropped } = limitAttributeEntries(
              link.attributes || {},
              limits,
            );
            return {
              ...link,
              attributes: lnAttrs,
              ...(lnDropped > 0
                ? { droppedAttributesCount: (link.droppedAttributesCount || 0) + lnDropped }
                : {}),
            };
          }),
        }
      : {}),
    ...(droppedLinks > 0
      ? { droppedLinksCount: (span.droppedLinksCount || 0) + droppedLinks }
      : {}),
  };
}
/**
 * Tests whether a topic name is the unversioned scope trace topic for a given phase.
 *
 * Returns `true` only for names of the form `otel:trace:<scope>:<phase>` where
 * `<scope>` is a single segment containing no `@` (the version separator). This
 * deliberately excludes versioned topics (`otel:trace:<scope>@<version>:<phase>`),
 * so a consumer subscribing at the scope level can avoid double-counting records
 * that also fan out to a versioned topic. Names not starting with `otel:trace:`
 * or not ending with the expected phase suffix return `false`.
 *
 * ```typescript no_run
 * import { isScopedTraceTopic } from 'internal:opentelemetry/traces';
 *
 * isScopedTraceTopic('otel:trace:orders:start', 'start');          // true
 * isScopedTraceTopic('otel:trace:orders@1.0.0:start', 'start');    // false
 * ```
 */
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
/**
 * Returns the effective tracer provider — the context-scoped one if set, otherwise the default.
 *
 * Instrumentation should call this rather than caching a provider, so that a
 * provider installed via `runWithTracerProvider` (or the process default set by
 * `setTracerProvider`) is honored. A context value of `null` (from
 * `runWithoutTracerProvider`) falls through to the default provider.
 *
 * ```typescript no_run
 * import { getTracerProvider } from 'internal:opentelemetry/traces';
 *
 * const tracer = getTracerProvider().getTracer('my-lib');
 * ```
 */
export function getTracerProvider(): TracerProvider {
  return tracerProviderContext.get() || defaultTracerProvider;
}
/**
 * Replaces the process-wide default tracer provider.
 *
 * Affects every call to `getTracerProvider` that is not inside a
 * `runWithTracerProvider` scope. The SDK calls this during bootstrap to install
 * a configured provider.
 *
 * ```typescript no_run
 * import { setTracerProvider, TracerProvider } from 'internal:opentelemetry/traces';
 * import { Resource } from 'internal:opentelemetry/common';
 *
 * setTracerProvider(new TracerProvider({
 *   resource: new Resource({ 'service.name': 'orders' }),
 * }));
 * ```
 */
export function setTracerProvider(provider: TracerProvider): void {
  defaultTracerProvider = provider;
}
/**
 * Runs `fn` with `provider` installed as the active tracer provider for the dynamic scope.
 *
 * The override is restored when `fn` returns and propagates across async
 * boundaries within the callback. Returns whatever `fn` returns.
 *
 * ```typescript no_run
 * import { runWithTracerProvider, TracerProvider, getTracerProvider } from 'internal:opentelemetry/traces';
 *
 * const provider = new TracerProvider();
 * runWithTracerProvider(provider, () => {
 *   getTracerProvider() === provider; // true
 * });
 * ```
 */
export function runWithTracerProvider<R>(provider: TracerProvider, fn: () => R): R {
  return tracerProviderContext.runWithValue(provider, fn);
}
/**
 * Runs `fn` with tracing suppressed, so `getTracerProvider` yields the default and context is disabled.
 *
 * Sets the context provider to `null` for the callback's dynamic scope. Used by
 * exporters to avoid instrumenting their own outbound telemetry traffic and
 * creating feedback loops. Returns whatever `fn` returns.
 *
 * ```typescript no_run
 * import { runWithoutTracerProvider, isTracerProviderContextEnabled } from 'internal:opentelemetry/traces';
 *
 * runWithoutTracerProvider(() => {
 *   isTracerProviderContextEnabled(); // false
 * });
 * ```
 */
export function runWithoutTracerProvider<R>(fn: () => R): R {
  return tracerProviderContext.runWithValue(null, fn);
}
/**
 * Reports whether a tracer provider is currently installed in the context (not suppressed).
 *
 * Returns `false` inside a `runWithoutTracerProvider` scope (where the context
 * value is `null`) and `true` when a provider has been set via
 * `runWithTracerProvider`. Note it returns `false` when no context override
 * exists at all, even though `getTracerProvider` would still yield the default.
 *
 * ```typescript no_run
 * import { runWithTracerProvider, TracerProvider, isTracerProviderContextEnabled } from 'internal:opentelemetry/traces';
 *
 * runWithTracerProvider(new TracerProvider(), () => {
 *   isTracerProviderContextEnabled(); // true
 * });
 * ```
 */
export function isTracerProviderContextEnabled(): boolean {
  return tracerProviderContext.get() !== null;
}
/**
 * Returns the `Span` currently marked active via `runWithActiveSpan`, or `undefined`.
 *
 * This yields the live `Span` instance (so you can mutate it), distinct from
 * `getActiveSpanContext`, which returns just the propagatable identity. Returns
 * `undefined` outside any active-span scope.
 *
 * ```typescript no_run
 * import { getActiveSpan } from 'internal:opentelemetry/traces';
 *
 * getActiveSpan()?.setAttribute('checkpoint', 'reached');
 * ```
 */
export function getActiveSpan(): Span | undefined {
  return activeSpanContext.get();
}
/**
 * Returns the active trace context for propagation, merging explicit context, the active span, and baggage.
 *
 * Resolution favors an explicit `ActiveTelemetryContext` (installed by
 * instrumentation that extracted an upstream `traceparent`), defaulting its
 * `traceFlags` to `1` and attaching the active baggage. Otherwise it derives the
 * context from the active `Span` (flags `1`). When neither exists it returns just
 * the baggage-bearing context, or `null` if there is no baggage either. This is
 * the getter registered with the common layer so other signals can correlate.
 *
 * ```typescript no_run
 * import { getActiveSpanContext } from 'internal:opentelemetry/traces';
 * import { W3CTraceContextPropagator } from 'internal:opentelemetry/common';
 *
 * const ctx = getActiveSpanContext();
 * const headers: Record<string, unknown> = {};
 * if (ctx) new W3CTraceContextPropagator().inject(headers, ctx);
 * ```
 */
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
/**
 * Runs `fn` with `span` as the active span, so child spans inherit its trace and parent IDs.
 *
 * Installs both the active-`Span` slot (for `getActiveSpan`) and a derived
 * `ActiveTelemetryContext` (for `getActiveSpanContext`), inheriting `traceFlags`,
 * `traceState`, and `baggage` from any surrounding context. When inherited
 * baggage is present it is re-established for the callback. The scope unwinds
 * when `fn` returns and propagates across awaits. Returns whatever `fn` returns.
 *
 * ```typescript no_run
 * import { getTracerProvider, runWithActiveSpan } from 'internal:opentelemetry/traces';
 *
 * const tracer = getTracerProvider().getTracer('orders');
 * const parent = tracer.startSpan('orders.create');
 * await runWithActiveSpan(parent, async () => {
 *   const child = tracer.startSpan('orders.validate'); // parentSpanId = parent.spanId
 *   child.end();
 * });
 * parent.end();
 * ```
 */
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
    runWithActiveContext(nextContext, () =>
      nextContext.baggage instanceof Baggage ? runWithBaggage(nextContext.baggage, fn) : fn(),
    ),
  );
}
registerActiveSpanContextGetter(getActiveSpanContext);
