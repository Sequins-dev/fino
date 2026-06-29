/**
* internal/opentelemetry/instrumentations/http-server — internal runtime module.
*
* Converts runtime HTTP server request lifecycle topic events into server
* spans and installs request trace context for downstream work performed by
* the handler.
*
* ```js
* const { HttpServerInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/http-server';
* console.log(new HttpServerInstrumentation().constructor.name);
* ```
*
* @internal
*/
import { topic } from '../../../context/topic.ts';
import { installRequestContext, nowUnixNano, otelRuntimeTopic, randomHex } from '../common.ts';
import type { Attributes, Disposable, OtelSdkLike, RuntimeHttpRequestEvent } from '../common.ts';
import { isTracerProviderContextEnabled } from '../traces.ts';
/**
* Runtime HTTP server instrumentation.
*
* The instrumentation subscribes to server request start, end, and error
* topics. Start events extract incoming propagation context, record a span
* start, and install request context. End and error events finalize the stored
* span. Missing start events are ignored, and response status codes 500 and
* above are marked as errors.
*
* ```js
* const { HttpServerInstrumentation } =
*   import 'internal:opentelemetry/instrumentations/http-server';
* const disposable = new HttpServerInstrumentation().enable({
*   propagator: { extract() { return {}; } },
*   recordSpanStart() {},
*   recordSpan() {},
* });
* disposable.dispose();
* ```
*
* @internal
*/
export class HttpServerInstrumentation {
  /**
  * Private property `#active` used by `HttpServerInstrumentation`.
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
  #active = new Map<string, {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    startTimeUnixNano: number;
    kind: string;
    attributes: Attributes;
  }>();
  /**
  * Enable HTTP server topic subscriptions.
  *
  * The SDK must provide `propagator.extract()`, `recordSpanStart()`, and
  * `recordSpan()`. Completed spans are named from the request method and
  * route, include response status or error attributes when available, and are
  * emitted with server kind. The returned disposable removes all
  * subscriptions.
  *
  * ```js
  * const { HttpServerInstrumentation } =
  *   import 'internal:opentelemetry/instrumentations/http-server';
  * const disposable = new HttpServerInstrumentation().enable({
  *   propagator: { extract() { return {}; } },
  *   recordSpanStart(span) { console.log(span.kind); },
  *   recordSpan() {},
  * });
  * disposable.dispose();
  * ```
  *
  * @param sdk SDK-like sink with propagator and span recorders.
  * @returns A disposable that removes all HTTP server subscriptions.
  * @internal
  */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeHttpRequestEvent>(otelRuntimeTopic('http.server', 'request', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      const extracted = sdk.propagator.extract(event.headers || {}) || {};
      const traceId = extracted.traceId || randomHex(32);
      const spanId = randomHex(16);
      const startTimeUnixNano = event.timeUnixNano || nowUnixNano();
      const attributes: Attributes = {
        'http.request.method': event.method,
        'http.route': event.route,
        ...event.url ? { 'url.full': event.url } : {}
      };
      this.#active.set(event.requestId, {
        traceId,
        spanId,
        parentSpanId: extracted.spanId || null,
        startTimeUnixNano,
        kind: 'server',
        attributes
      });
      // Notify processors of span start before the handler runs.
      sdk.recordSpanStart({
        name: `${event.method || 'HTTP'} ${event.route || '/'}`,
        kind: 'server',
        traceId,
        spanId,
        parentSpanId: extracted.spanId || null,
        startTimeUnixNano,
        attributes,
        scope: { name: 'http.server' },
        ...event.resource ? { resource: event.resource } : {}
      });
      // Install the span context so the handler runs inside it, allowing user
      // code and downstream instrumentations (fetch, DNS, socket, TLS) to
      // create properly-parented child spans.
      installRequestContext(event.requestId, {
        traceId,
        spanId,
        traceFlags: extracted.traceFlags ?? 1
      });
    });
    const onEnd = topic<RuntimeHttpRequestEvent>(otelRuntimeTopic('http.server', 'request', 'end')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.requestId);
      if (!span) return;
      this.#active.delete(event.requestId);
      sdk.recordSpan({
        name: `${span.attributes['http.request.method']} ${span.attributes['http.route'] || event.route || '/'}`,
        kind: 'server',
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: event.timeUnixNano || nowUnixNano(),
        attributes: {
          ...span.attributes,
          ...event.statusCode !== undefined ? { 'http.response.status_code': event.statusCode } : {}
        },
        scope: { name: 'http.server' },
        ...event.resource ? { resource: event.resource } : {},
        status: (event.statusCode || 0) >= 500 ? {
          code: 'ERROR',
          message: String(event.statusCode)
        } : { code: 'OK' }
      });
    });
    const onError = topic<RuntimeHttpRequestEvent>(otelRuntimeTopic('http.server', 'request', 'error')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.requestId);
      if (!span) return;
      this.#active.delete(event.requestId);
      sdk.recordSpan({
        name: `${span.attributes['http.request.method']} ${span.attributes['http.route'] || event.route || '/'}`,
        kind: 'server',
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: event.timeUnixNano || nowUnixNano(),
        attributes: {
          ...span.attributes,
          'error.message': String((event.error as Error)?.message || event.error)
        },
        scope: { name: 'http.server' },
        ...event.resource ? { resource: event.resource } : {},
        status: {
          code: 'ERROR',
          message: String((event.error as Error)?.message || event.error)
        }
      });
    });
    return { dispose() {
      onStart.dispose();
      onEnd.dispose();
      onError.dispose();
    } };
  }
}
