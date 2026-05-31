/**
 * internal/opentelemetry/instrumentations/tls — internal runtime module.
 *
 * 
 * @internal
 */

import { topic } from '../../../util/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeTlsEvent, SpanStatus } from '../common.mts';
import { createRuntimeClientSpan } from './_runtime-client.mts';
import { isTracerProviderContextEnabled } from '../traces.mts';

export class TlsInstrumentation {
  #active = new Map<string, { requestId?: string; hop?: number; hostname?: string; port?: number; startTimeUnixNano: number }>();

  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeTlsEvent>(otelRuntimeTopic('tls', 'handshake', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      this.#active.set(event.handshakeId, {
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.hop !== undefined ? { hop: event.hop } : {}),
        ...(event.hostname ? { hostname: event.hostname } : {}),
        ...(event.port !== undefined ? { port: event.port } : {}),
        startTimeUnixNano: event.timeUnixNano || nowUnixNano(),
      });
    });
    const finish = (event: RuntimeTlsEvent, status: SpanStatus) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.handshakeId);
      if (!span) return;
      this.#active.delete(event.handshakeId);
      sdk.recordSpan(
        createRuntimeClientSpan(
          `TLS ${span.hostname}:${span.port}`,
          'tls',
          event.resource,
          span.startTimeUnixNano,
          event.timeUnixNano || nowUnixNano(),
          {
            'server.address': span.hostname,
            'server.port': span.port,
            ...(event.protocol ? { 'tls.protocol.name': event.protocol } : {}),
            ...(span.requestId ? { 'runtime.request_id': span.requestId } : {}),
            ...(typeof span.hop === 'number' ? { 'runtime.request_hop': span.hop } : {}),
            ...(event.error ? { 'error.message': String((event.error as Error)?.message || event.error) } : {}),
          },
          status,
        ),
      );
    };
    const onEnd = topic<RuntimeTlsEvent>(otelRuntimeTopic('tls', 'handshake', 'end')).subscribe((event) => finish(event, { code: 'OK' }));
    const onError = topic<RuntimeTlsEvent>(otelRuntimeTopic('tls', 'handshake', 'error')).subscribe((event) =>
      finish(event, { code: 'ERROR', message: String((event.error as Error)?.message || event.error) }),
    );
    return {
      dispose() {
        onStart.dispose();
        onEnd.dispose();
        onError.dispose();
      },
    };
  }
}
