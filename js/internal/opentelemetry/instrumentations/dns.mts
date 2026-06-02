/**
 * internal/opentelemetry/instrumentations/dns — internal runtime module.
 *
 * Converts runtime DNS lookup lifecycle topic events into client spans. Active
 * lookups are tracked by lookup id until an end or error event arrives.
 *
 * ```js
 * const { DnsInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/dns';
 * const instrumentation = new DnsInstrumentation();
 * console.log(typeof instrumentation.enable);
 * ```
 *
 * @internal
 */

import { topic } from '../../../context/topic.mts';
import {
  nowUnixNano,
  otelRuntimeTopic,
} from '../common.mts';
import type { Disposable, OtelSdkLike, RuntimeDnsEvent, SpanStatus } from '../common.mts';
import { createRuntimeClientSpan } from './_runtime-client.mts';
import { isTracerProviderContextEnabled } from '../traces.mts';

/**
 * Runtime DNS lookup instrumentation.
 *
 * The instrumentation subscribes to `dns.lookup.start`, `dns.lookup.end`, and
 * `dns.lookup.error` topics. It records spans only while tracer context
 * recording is enabled. Missing start events are ignored, and dispose removes
 * all topic subscriptions.
 *
 * ```js
 * const { DnsInstrumentation } =
 *   import 'internal:opentelemetry/instrumentations/dns';
 * const instrumentation = new DnsInstrumentation();
 * const disposable = instrumentation.enable({ recordSpan() {} });
 * disposable.dispose();
 * ```
 *
 * @internal
 */
export class DnsInstrumentation {
  /**
   * Private property `#active` used by `DnsInstrumentation`.
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
  #active = new Map<string, { requestId?: string; hop?: number; hostname?: string; startTimeUnixNano: number }>();

  /**
   * Enable DNS topic subscriptions.
   *
   * Each completed lookup records a client span named `DNS <hostname>` with
   * DNS, socket-family, runtime request, and error attributes when available.
   * The returned disposable must be called during SDK shutdown to unsubscribe.
   *
   * ```js
   * const { DnsInstrumentation } =
   *   import 'internal:opentelemetry/instrumentations/dns';
   * const disposable = new DnsInstrumentation().enable({ recordSpan() {} });
   * disposable.dispose();
   * ```
   *
   * @param sdk SDK-like sink that accepts completed spans.
   * @returns A disposable that removes all DNS subscriptions.
   * @internal
   */
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
