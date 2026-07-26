/**
 * internal:opentelemetry/instrumentations/http-server — server-side HTTP tracing.
 *
 * Bridges the runtime's HTTP server request lifecycle onto OpenTelemetry server
 * spans. The runtime publishes `http.server request start`, `end`, and `error`
 * events on the shared telemetry topic bus (see `otelRuntimeTopic` in
 * `../common.ts`); this instrumentation subscribes to them, opens a span on each
 * start, and closes it on the matching end or error. It never touches sockets or
 * the HTTP layer directly — it only observes events, so it stays decoupled from
 * `serve.ts` and works for any server that emits the runtime topics.
 *
 * On a start event it extracts inbound W3C propagation context from the request
 * headers (via the SDK's propagator), mints a fresh span id, records the pending
 * span keyed by request id, notifies the SDK with `recordSpanStart`, and installs
 * the span context so the handler and any downstream instrumentations (fetch,
 * DNS, socket, TLS) parent their child spans correctly. The matching end or error
 * event finalizes and emits the span through `recordSpan`. Events whose request
 * id has no recorded start are ignored, so a late or duplicate end is harmless.
 * All handlers no-op while the tracer provider context is disabled, letting the
 * runtime keep emitting events cheaply when tracing is off.
 *
 * This is internal plumbing wired up by the OpenTelemetry SDK, not something
 * applications construct directly; the SDK owns the propagator and span sinks.
 *
 * ```ts no_run
 * import { HttpServerInstrumentation } from 'internal:opentelemetry/instrumentations/http-server';
 *
 * // The SDK supplies the propagator and span recorders; enable() returns a
 * // disposable that tears down every subscription.
 * const instrumentation = new HttpServerInstrumentation();
 * const handle = instrumentation.enable(sdk);
 * // ...serve requests; spans are produced automatically...
 * handle.dispose();
 * ```
 *
 * See the OpenTelemetry HTTP semantic conventions:
 * https://opentelemetry.io/docs/specs/semconv/http/http-spans/
 *
 * @internal
 */
import { topic } from '../../../context/topic.ts';
import { installRequestContext, nowUnixNano, otelRuntimeTopic, randomHex } from '../common.ts';
import type { Attributes, Disposable, OtelSdkLike, RuntimeHttpRequestEvent } from '../common.ts';
import { isTracerProviderContextEnabled } from '../traces.ts';
/**
 * Turns runtime HTTP server request events into OpenTelemetry server spans.
 *
 * One instance owns a map of in-flight spans keyed by request id. Calling
 * `enable` wires up subscriptions to the `http.server` start, end, and error
 * runtime topics; the returned disposable removes them again. A start event
 * extracts inbound propagation context, records the pending span, and installs
 * the span context for the handler. The matching end or error event finalizes
 * that span: end events attach the response status code and mark 5xx responses
 * as errors, while error events attach the thrown error's message and mark the
 * span as errored. End or error events without a recorded start are ignored, so
 * the instrumentation tolerates duplicate or out-of-order runtime events.
 *
 * The instance is reusable — call `enable` again after disposing to resubscribe.
 * Enabling twice concurrently creates duplicate subscriptions and would record
 * each span twice, so dispose the previous handle first.
 *
 * ```ts no_run
 * import { HttpServerInstrumentation } from 'internal:opentelemetry/instrumentations/http-server';
 *
 * const instrumentation = new HttpServerInstrumentation();
 * const handle = instrumentation.enable(sdk);
 * // Every request the runtime serves now produces a server span through `sdk`.
 * handle.dispose();
 * ```
 *
 * @internal
 */
export class HttpServerInstrumentation {
  /**
   * In-flight spans awaiting their end or error event, keyed by request id.
   *
   * A start event inserts an entry holding the span's identity (trace and span
   * ids, optional parent span id), its start timestamp, kind, and the attributes
   * gathered so far. The matching end or error event reads the entry to finalize
   * the span, then deletes it. Entries persist only for the lifetime of a
   * request, so a request that emits no terminal event leaves a small residual
   * entry until the process ends.
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
      attributes: Attributes;
    }
  >();
  /**
   * Subscribes to the HTTP server runtime topics and returns a teardown handle.
   *
   * The `sdk` must expose `propagator.extract()` to read inbound trace context
   * from request headers, `recordSpanStart()` to notify processors before the
   * handler runs, and `recordSpan()` to emit each completed span. Spans are named
   * `<method> <route>` (falling back to `HTTP` and `/`), carry `http.request.method`,
   * `http.route`, and `url.full` attributes, use server kind, and are scoped to
   * `http.server`. End events add `http.response.status_code` and set the status
   * to `ERROR` for codes 500 and above, otherwise `OK`; error events add
   * `error.message` and always set `ERROR`. When the request's start event was
   * dropped (or the tracer provider context is disabled at start time) there is
   * no recorded span, and the corresponding end or error event is a no-op.
   *
   * The returned disposable's `dispose()` unsubscribes all three topic handlers.
   * Call it before enabling again to avoid duplicate subscriptions.
   *
   * ```ts no_run
   * import { HttpServerInstrumentation } from 'internal:opentelemetry/instrumentations/http-server';
   *
   * const handle = new HttpServerInstrumentation().enable(sdk);
   * try {
   *   // ...run the server; each request produces a parented server span...
   * } finally {
   *   handle.dispose();
   * }
   * ```
   *
   * @internal
   */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeHttpRequestEvent>(
      otelRuntimeTopic('http.server', 'request', 'start'),
    ).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      const extracted = sdk.propagator.extract(event.headers || {}) || {};
      const traceId = extracted.traceId || randomHex(32);
      const spanId = randomHex(16);
      const startTimeUnixNano = event.timeUnixNano || nowUnixNano();
      const attributes: Attributes = {
        'http.request.method': event.method,
        'http.route': event.route,
        ...(event.url ? { 'url.full': event.url } : {}),
      };
      this.#active.set(event.requestId, {
        traceId,
        spanId,
        parentSpanId: extracted.spanId || null,
        startTimeUnixNano,
        kind: 'server',
        attributes,
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
        ...(event.resource ? { resource: event.resource } : {}),
      });
      // Install the span context so the handler runs inside it, allowing user
      // code and downstream instrumentations (fetch, DNS, socket, TLS) to
      // create properly-parented child spans.
      installRequestContext(event.requestId, {
        traceId,
        spanId,
        traceFlags: extracted.traceFlags ?? 1,
      });
    });
    const onEnd = topic<RuntimeHttpRequestEvent>(
      otelRuntimeTopic('http.server', 'request', 'end'),
    ).subscribe((event) => {
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
          ...(event.statusCode !== undefined
            ? { 'http.response.status_code': event.statusCode }
            : {}),
        },
        scope: { name: 'http.server' },
        ...(event.resource ? { resource: event.resource } : {}),
        status:
          (event.statusCode || 0) >= 500
            ? {
                code: 'ERROR',
                message: String(event.statusCode),
              }
            : { code: 'OK' },
      });
    });
    const onError = topic<RuntimeHttpRequestEvent>(
      otelRuntimeTopic('http.server', 'request', 'error'),
    ).subscribe((event) => {
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
          'error.message': String((event.error as Error)?.message || event.error),
        },
        scope: { name: 'http.server' },
        ...(event.resource ? { resource: event.resource } : {}),
        status: {
          code: 'ERROR',
          message: String((event.error as Error)?.message || event.error),
        },
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
