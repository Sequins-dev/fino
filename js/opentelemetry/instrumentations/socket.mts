import { topic } from '../../util/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeSocketEvent, SpanStatus } from '../common.mts';
import { createRuntimeClientSpan } from './_runtime-client.mts';
import { isTracerProviderContextEnabled } from '../traces.mts';

export class SocketInstrumentation {
  #active = new Map<string, { requestId?: string; hop?: number; host?: string; port?: number; transport: string; startTimeUnixNano: number }>();

  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeSocketEvent>(otelRuntimeTopic('socket', 'connect', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      this.#active.set(event.connectId, {
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.hop !== undefined ? { hop: event.hop } : {}),
        ...(event.host ? { host: event.host } : {}),
        ...(event.port !== undefined ? { port: event.port } : {}),
        transport: event.transport || 'tcp',
        startTimeUnixNano: event.timeUnixNano || nowUnixNano(),
      });
    });
    const finish = (event: RuntimeSocketEvent, status: SpanStatus) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.connectId);
      if (!span) return;
      this.#active.delete(event.connectId);
      sdk.recordSpan(
        createRuntimeClientSpan(
          `CONNECT ${span.host}:${span.port}`,
          'socket',
          event.resource,
          span.startTimeUnixNano,
          event.timeUnixNano || nowUnixNano(),
          {
            'net.transport': span.transport,
            'net.peer.name': span.host,
            'net.peer.port': span.port,
            ...(span.requestId ? { 'runtime.request_id': span.requestId } : {}),
            ...(typeof span.hop === 'number' ? { 'runtime.request_hop': span.hop } : {}),
            ...(event.error ? { 'error.message': String((event.error as Error)?.message || event.error) } : {}),
          },
          status,
        ),
      );
    };
    const onEnd = topic<RuntimeSocketEvent>(otelRuntimeTopic('socket', 'connect', 'end')).subscribe((event) => finish(event, { code: 'OK' }));
    const onError = topic<RuntimeSocketEvent>(otelRuntimeTopic('socket', 'connect', 'error')).subscribe((event) =>
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
