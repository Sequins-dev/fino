import { topic } from '../../util/topic.mts';
import {
  installRequestContext,
  nowUnixNano,
  otelRuntimeTopic,
  randomHex,
} from '../common.mts';
import type { Attributes, Disposable, OtelSdkLike, RuntimeHttpRequestEvent } from '../common.mts';
import { isTracerProviderContextEnabled } from '../traces.mts';

export class HttpServerInstrumentation {
  #active = new Map<
    string,
    { traceId: string; spanId: string; parentSpanId: string | null; startTimeUnixNano: number; kind: string; attributes: Attributes }
  >();

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
      installRequestContext(event.requestId, { traceId, spanId, traceFlags: extracted.traceFlags ?? 1 });
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
          ...(event.statusCode !== undefined ? { 'http.response.status_code': event.statusCode } : {}),
        },
        scope: { name: 'http.server' },
        ...(event.resource ? { resource: event.resource } : {}),
        status: (event.statusCode || 0) >= 500 ? { code: 'ERROR', message: String(event.statusCode) } : { code: 'OK' },
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
        attributes: { ...span.attributes, 'error.message': String((event.error as Error)?.message || event.error) },
        scope: { name: 'http.server' },
        ...(event.resource ? { resource: event.resource } : {}),
        status: { code: 'ERROR', message: String((event.error as Error)?.message || event.error) },
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
