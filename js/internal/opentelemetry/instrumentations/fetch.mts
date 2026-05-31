/**
 * internal/opentelemetry/instrumentations/fetch — internal runtime module.
 *
 * 
 * @internal
 */

import { topic } from '../../../util/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
  randomHex,
  snapshotCarrier,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeHttpRequestEvent, SpanStatus } from '../common.mts';
import { getActiveSpanContext, isTracerProviderContextEnabled } from '../traces.mts';

export class FetchInstrumentation {
  #active = new Map<
    string,
    { traceId: string; spanId: string; parentSpanId: string | null; startTimeUnixNano: number; kind: string; method?: string; url?: string; injectedHeaders: Record<string, unknown> }
  >();

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
