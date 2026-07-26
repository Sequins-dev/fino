/**
 * internal:opentelemetry/instrumentations/fetch — client spans for outgoing fetch requests.
 *
 * This instrumentation turns the runtime's fetch request lifecycle into
 * OpenTelemetry client spans. The runtime publishes `fetch.request.start`,
 * `fetch.request.end`, and `fetch.request.error` events on the shared topic bus
 * for every outgoing `fetch()` call; this module subscribes to those topics,
 * correlates them by request id, and emits one span per request through the SDK
 * it is enabled with. Because the runtime, not this module, owns the fetch call
 * site, instrumentation is fully out-of-band: application code keeps using the
 * standard `fetch()` global and never references this class directly.
 *
 * On a start event the active span context (if any) supplies the parent trace
 * id and parent span id; when there is no active context a fresh 128-bit trace
 * id is generated so the outgoing request still carries a valid W3C trace. The
 * SDK propagator is asked to inject `traceparent`/`tracestate` into the request
 * header carrier, so the downstream service continues the same trace. A snapshot
 * of the injected headers is retained and attached to the finished span for
 * debugging. On finish the span is named `<method> <url>`, tagged with
 * `http.request.method`, `url.full`, and `http.response.status_code`, and marked
 * as an error when the response status is 500 or higher or when the request
 * rejected. Spans are only produced while tracer-provider context recording is
 * enabled; when it is disabled, start and finish events are dropped and no state
 * accumulates. End or error events without a matching start (for example, a
 * request that began while recording was off) are ignored.
 *
 * This is internal plumbing wired up by the OpenTelemetry SDK's instrumentation
 * registry, not a public API. Enable it through the SDK rather than constructing
 * it yourself.
 *
 * ```ts no_run
 * import { FetchInstrumentation } from 'internal:opentelemetry/instrumentations/fetch';
 *
 * const disposable = new FetchInstrumentation().enable({
 *   propagator: {
 *     inject(carrier, ctx) { carrier.traceparent = `00-${ctx.traceId}-${ctx.spanId}-01`; },
 *   },
 *   recordSpan(span) { console.log(span.name, span.status?.code); },
 * });
 *
 * await fetch('https://example.com/api');  // emits a "GET https://example.com/api" span
 * disposable.dispose();
 * ```
 *
 * See the W3C Trace Context specification: https://www.w3.org/TR/trace-context/
 *
 * @internal
 */
import { topic } from '../../../context/topic.ts';
import { nowUnixNano, otelRuntimeTopic, randomHex, snapshotCarrier } from '../common.ts';
import type { Disposable, OtelSdkLike, RuntimeHttpRequestEvent, SpanStatus } from '../common.ts';
import { getActiveSpanContext, isTracerProviderContextEnabled } from '../traces.ts';
/**
 * Runtime fetch client instrumentation.
 *
 * Instances are stateless until `enable()` is called. The class holds a map of
 * in-flight requests keyed by request id: a start event inserts an entry that
 * records the allocated trace and span ids, the parent span id, the start
 * timestamp, and the snapshot of injected headers; the matching end or error
 * event removes the entry and hands the assembled span to the SDK. Requests that
 * never receive a start event (or that start while recording is disabled) leave
 * no entry, so their end events are silently ignored.
 *
 * One `FetchInstrumentation` can be enabled against exactly one SDK at a time.
 * Enabling twice creates independent subscriptions; dispose each returned
 * handle to unsubscribe. The class does not deduplicate or throttle — every
 * fetch lifecycle produces at most one span while recording is enabled.
 *
 * ```ts no_run
 * import { FetchInstrumentation } from 'internal:opentelemetry/instrumentations/fetch';
 *
 * const spans: unknown[] = [];
 * const instrumentation = new FetchInstrumentation();
 * const disposable = instrumentation.enable({
 *   propagator: { inject() {} },
 *   recordSpan(span) { spans.push(span); },
 * });
 * // ... application makes fetch() calls ...
 * disposable.dispose();
 * ```
 *
 * @internal
 */
export class FetchInstrumentation {
  /**
   * Map of in-flight fetch requests keyed by runtime request id.
   *
   * Each entry captures the span state allocated at request start — trace id,
   * span id, parent span id, start timestamp, span kind, method and url when
   * known, and a snapshot of the headers injected by the propagator — and is
   * removed when the matching end or error event finalizes the span. Entries only
   * exist for requests observed while recording was enabled, which is why finish
   * handlers tolerate a missing entry. This state is internal to the running
   * instrumentation and has no application-facing contract.
   *
   * @internal
   */
  #active = new Map<
    string,
    {
      traceId: string;
      spanId: string;
      parentSpanId: string | null;
      startTimeUnixNano: number;
      kind: string;
      method?: string;
      url?: string;
      injectedHeaders: Record<string, unknown>;
    }
  >();
  /**
   * Subscribe to the fetch lifecycle topics and begin emitting client spans.
   *
   * The supplied SDK must expose a `propagator` with an `inject(carrier, ctx)`
   * method and a `recordSpan(span)` sink. On each `fetch.request.start` the
   * propagator injects trace headers into the outgoing request's header carrier;
   * on `fetch.request.end` or `fetch.request.error` the finished span is passed
   * to `recordSpan`. Completed spans use client kind, are named `<method> <url>`,
   * and carry `http.request.method`, `url.full`, `http.response.status_code`,
   * and `error.message` attributes when those fields are present, along with the
   * request resource and the snapshot of injected headers. End events with a
   * status of 500 or above are recorded with an `ERROR` status whose message is
   * the status code; error events are recorded with `ERROR` and the error's
   * message; all other completions are `OK`.
   *
   * Nothing is emitted while tracer-provider context recording is disabled: both
   * the start and finish handlers check the recording flag and return early, so
   * toggling recording at runtime cleanly starts and stops span production. The
   * returned disposable tears down all three topic subscriptions; call it to
   * fully detach the instrumentation.
   *
   * ```ts no_run
   * import { FetchInstrumentation } from 'internal:opentelemetry/instrumentations/fetch';
   *
   * const disposable = new FetchInstrumentation().enable({
   *   propagator: {
   *     inject(carrier, ctx) { carrier.traceparent = `00-${ctx.traceId}-${ctx.spanId}-01`; },
   *   },
   *   recordSpan(span) {
   *     console.log(span.name, span.attributes?.['http.response.status_code'], span.status?.code);
   *   },
   * });
   *
   * await fetch('https://example.com/health');
   * disposable.dispose();
   * ```
   *
   * @internal
   */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeHttpRequestEvent>(
      otelRuntimeTopic('fetch', 'request', 'start'),
    ).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      const parent = getActiveSpanContext();
      const traceId = parent?.traceId || randomHex(32);
      const spanId = randomHex(16);
      const carrier = event.headers || {};
      sdk.propagator.inject(carrier, {
        traceId,
        spanId,
        traceFlags: 1,
      });
      this.#active.set(event.requestId, {
        traceId,
        spanId,
        parentSpanId: parent?.spanId || null,
        startTimeUnixNano: event.timeUnixNano || nowUnixNano(),
        kind: 'client',
        ...(event.method ? { method: event.method } : {}),
        ...(event.url ? { url: event.url } : {}),
        injectedHeaders: snapshotCarrier(carrier),
      });
    });
    const finish = (event: RuntimeHttpRequestEvent, status: SpanStatus) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.requestId);
      if (!span) return;
      this.#active.delete(event.requestId);
      sdk.recordSpan({
        name: `${span.method} ${span.url}`,
        kind: 'client',
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: event.timeUnixNano || nowUnixNano(),
        attributes: {
          ...(span.method ? { 'http.request.method': span.method } : {}),
          ...(span.url ? { 'url.full': span.url } : {}),
          ...(event.statusCode ? { 'http.response.status_code': event.statusCode } : {}),
          ...(event.error
            ? { 'error.message': String((event.error as Error)?.message || event.error) }
            : {}),
        },
        scope: { name: 'fetch' },
        ...(event.resource ? { resource: event.resource } : {}),
        injectedHeaders: span.injectedHeaders,
        status,
      });
    };
    const onEnd = topic<RuntimeHttpRequestEvent>(
      otelRuntimeTopic('fetch', 'request', 'end'),
    ).subscribe((event) => {
      finish(
        event,
        (event.statusCode || 0) >= 500
          ? {
              code: 'ERROR',
              message: String(event.statusCode),
            }
          : { code: 'OK' },
      );
    });
    const onError = topic<RuntimeHttpRequestEvent>(
      otelRuntimeTopic('fetch', 'request', 'error'),
    ).subscribe((event) => {
      finish(event, {
        code: 'ERROR',
        message: String((event.error as Error)?.message || event.error),
      });
    });
    return {
      dispose() {
        onStart.dispose();
        onEnd.dispose();
        onError.dispose();
      },
    };
  }
}
