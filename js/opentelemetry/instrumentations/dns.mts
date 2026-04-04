import { topic } from '../../util/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeDnsEvent, SpanStatus } from '../common.mts';
import { createRuntimeClientSpan } from './_runtime-client.mts';
import { isTracerProviderContextEnabled } from '../traces.mts';

export class DnsInstrumentation {
  #active = new Map<string, { requestId?: string; hop?: number; hostname?: string; startTimeUnixNano: number }>();

  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeDnsEvent>(otelRuntimeTopic('dns', 'lookup', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      this.#active.set(event.lookupId, {
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.hop !== undefined ? { hop: event.hop } : {}),
        ...(event.hostname ? { hostname: event.hostname } : {}),
        startTimeUnixNano: event.timeUnixNano || nowUnixNano(),
      });
    });
    const finish = (event: RuntimeDnsEvent, status: SpanStatus) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.lookupId);
      if (!span) return;
      this.#active.delete(event.lookupId);
      sdk.recordSpan(
        createRuntimeClientSpan(
          `DNS ${span.hostname}`,
          'dns',
          event.resource,
          span.startTimeUnixNano,
          event.timeUnixNano || nowUnixNano(),
          {
            'dns.question.name': span.hostname,
            ...(event.address ? { 'dns.answer.address': event.address } : {}),
            ...(event.family ? { 'net.sock.family': event.family } : {}),
            ...(span.requestId ? { 'runtime.request_id': span.requestId } : {}),
            ...(typeof span.hop === 'number' ? { 'runtime.request_hop': span.hop } : {}),
            ...(event.error ? { 'error.message': String((event.error as Error)?.message || event.error) } : {}),
          },
          status,
        ),
      );
    };
    const onEnd = topic<RuntimeDnsEvent>(otelRuntimeTopic('dns', 'lookup', 'end')).subscribe((event) => finish(event, { code: 'OK' }));
    const onError = topic<RuntimeDnsEvent>(otelRuntimeTopic('dns', 'lookup', 'error')).subscribe((event) =>
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
