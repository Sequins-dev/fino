/**
 * internal/opentelemetry/instrumentations/fetch — internal runtime module.
 *
 * Converts runtime fetch request lifecycle topic events into client spans and
 * injects propagation headers into the outgoing request carrier.
 *
 * ```js
 * const { FetchInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/fetch';
 * console.log(new FetchInstrumentation().constructor.name);
 * ```
 *
 * @internal
 */

import { topic } from '../../../context/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
  randomHex,
  snapshotCarrier,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeHttpRequestEvent, SpanStatus } from '../common.mts';
import { getActiveSpanContext, isTracerProviderContextEnabled } from '../traces.mts';

/**
 * Runtime fetch client instrumentation.
 *
 * The instrumentation subscribes to fetch request start, end, and error topics.
 * Start events allocate a trace/span id and inject propagation headers through
 * the SDK propagator; finish events record the span and include a snapshot of
 * injected headers. Missing start events are ignored. HTTP status codes 500 and
 * above are marked as errors.
 *
 * ```js
 * const { FetchInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/fetch';
 * const disposable = new FetchInstrumentation().enable({
 *   propagator: { inject() {} },
 *   recordSpan() {},
 * });
 * disposable.dispose();
 * ```
 *
 * @internal
 */
export class FetchInstrumentation {
  /**
   * Private property `#active` used by `FetchInstrumentation`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #active = undefined;
   *
   *   readInternalState() {
   *     return this.#active;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #active = new Map<
    string,
    { traceId: string; spanId: string; parentSpanId: string | null; startTimeUnixNano: number; kind: string; method?: string; url?: string; injectedHeaders: Record<string, unknown> }
  >();

  /**
   * Enable fetch topic subscriptions and propagation injection.
   *
   * The SDK must provide a propagator with `inject()` and a `recordSpan()`
   * method. Completed spans are named `<method> <url>`, use client kind, and
   * include HTTP method, URL, response status, error message, resource, and
   * injected header attributes when available. The returned disposable removes
   * all subscriptions.
   *
   * ```js
   * const { FetchInstrumentation } =
   *   import 'internal:opentelemetry/instrumentations/fetch';
   * const disposable = new FetchInstrumentation().enable({
   *   propagator: { inject(carrier) { carrier.traceparent = '00-demo'; } },
   *   recordSpan(span) { console.log(span.kind); },
   * });
   * disposable.dispose();
   * ```
   *
   * @param sdk SDK-like sink with propagator and span recorder.
   * @returns A disposable that removes all fetch subscriptions.
   * @internal
   */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeHttpRequestEvent>(otelRuntimeTopic('fetch', 'request', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      const parent = getActiveSpanContext();
      const traceId = parent?.traceId || randomHex(32);
      const spanId = randomHex(16);
      const carrier = event.headers || {};
      sdk.propagator.inject(carrier, { traceId, spanId, traceFlags: 1 });
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
          ...(event.error ? { 'error.message': String((event.error as Error)?.message || event.error) } : {}),
        },
        scope: { name: 'fetch' },
        ...(event.resource ? { resource: event.resource } : {}),
        injectedHeaders: span.injectedHeaders,
        status,
      });
    };
    const onEnd = topic<RuntimeHttpRequestEvent>(otelRuntimeTopic('fetch', 'request', 'end')).subscribe((event) => {
      finish(event, (event.statusCode || 0) >= 500 ? { code: 'ERROR', message: String(event.statusCode) } : { code: 'OK' });
    });
    const onError = topic<RuntimeHttpRequestEvent>(otelRuntimeTopic('fetch', 'request', 'error')).subscribe((event) => {
      finish(event, { code: 'ERROR', message: String((event.error as Error)?.message || event.error) });
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
