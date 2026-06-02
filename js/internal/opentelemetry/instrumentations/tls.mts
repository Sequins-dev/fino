/**
 * internal/opentelemetry/instrumentations/tls — internal runtime module.
 *
 * Converts runtime TLS handshake lifecycle topic events into client spans.
 * Handshakes are tracked by handshake id until an end or error event is
 * published.
 *
 * ```js
 * const { TlsInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/tls';
 * console.log(new TlsInstrumentation().constructor.name);
 * ```
 *
 * @internal
 */

import { topic } from '../../../context/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeTlsEvent, SpanStatus } from '../common.mts';
import { createRuntimeClientSpan } from './_runtime-client.mts';
import { isTracerProviderContextEnabled } from '../traces.mts';

/**
 * Runtime TLS handshake instrumentation.
 *
 * The instrumentation subscribes to `tls.handshake.start`,
 * `tls.handshake.end`, and `tls.handshake.error` topics. It records spans only
 * while tracer context recording is enabled. Missing start events are ignored.
 *
 * ```js
 * const { TlsInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/tls';
 * const disposable = new TlsInstrumentation().enable({ recordSpan() {} });
 * disposable.dispose();
 * ```
 *
 * @internal
 */
export class TlsInstrumentation {
  /**
   * Private property `#active` used by `TlsInstrumentation`.
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
  #active = new Map<string, { requestId?: string; hop?: number; hostname?: string; port?: number; startTimeUnixNano: number }>();

  /**
   * Enable TLS handshake topic subscriptions.
   *
   * Each finished handshake records a client span named
   * `TLS <hostname>:<port>` with server, TLS protocol, runtime request, and
   * error attributes when present. The returned disposable removes all
   * subscriptions.
   *
   * ```js
   * const { TlsInstrumentation } =
   *   import 'internal:opentelemetry/instrumentations/tls';
   * const disposable = new TlsInstrumentation().enable({ recordSpan() {} });
   * disposable.dispose();
   * ```
   *
   * @param sdk SDK-like sink that accepts completed spans.
   * @returns A disposable that removes all TLS subscriptions.
   * @internal
   */
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
