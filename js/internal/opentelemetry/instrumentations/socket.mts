/**
 * internal/opentelemetry/instrumentations/socket — internal runtime module.
 *
 * Converts runtime socket connect lifecycle topic events into client spans.
 * Active connections are tracked by connect id until an end or error event is
 * published.
 *
 * ```js
 * const { SocketInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/socket';
 * console.log(new SocketInstrumentation().constructor.name);
 * ```
 *
 * @internal
 */

import { topic } from '../../../context/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeSocketEvent, SpanStatus } from '../common.mts';
import { createRuntimeClientSpan } from './_runtime-client.mts';
import { isTracerProviderContextEnabled } from '../traces.mts';

/**
 * Runtime socket connect instrumentation.
 *
 * The instrumentation subscribes to `socket.connect.start`, `socket.connect.end`,
 * and `socket.connect.error` topics and records spans only when tracer context
 * recording is enabled. Missing start events are ignored, and dispose removes
 * all subscriptions.
 *
 * ```js
 * const { SocketInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/socket';
 * const disposable = new SocketInstrumentation().enable({ recordSpan() {} });
 * disposable.dispose();
 * ```
 *
 * @internal
 */
export class SocketInstrumentation {
  /**
   * Private property `#active` used by `SocketInstrumentation`.
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
  #active = new Map<string, { requestId?: string; hop?: number; host?: string; port?: number; transport: string; startTimeUnixNano: number }>();

  /**
   * Enable socket connect topic subscriptions.
   *
   * Each finished connection records a client span named
   * `CONNECT <host>:<port>` with network, runtime request, and error attributes
   * when present. The returned disposable must be invoked during shutdown.
   *
   * ```js
   * const { SocketInstrumentation } =
   *   import 'internal:opentelemetry/instrumentations/socket';
   * const disposable = new SocketInstrumentation().enable({ recordSpan() {} });
   * disposable.dispose();
   * ```
   *
   * @param sdk SDK-like sink that accepts completed spans.
   * @returns A disposable that removes all socket subscriptions.
   * @internal
   */
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
