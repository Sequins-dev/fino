/**
* internal/opentelemetry/instrumentations/tls — internal runtime module.
*
* Turns the runtime's internal TLS handshake lifecycle into OpenTelemetry client
* spans. The runtime publishes `tls.handshake.start`, `tls.handshake.end`, and
* `tls.handshake.error` events on the internal topic bus whenever a socket
* negotiates TLS; this instrumentation subscribes to those topics and emits one
* `TLS <hostname>:<port>` client span per completed handshake, tagged with the
* peer address, negotiated protocol, and the originating runtime request when
* the handshake belongs to an outgoing fetch or proxy hop.
*
* Each in-flight handshake is keyed by its handshake id from the start event
* until the matching end or error event arrives, so overlapping handshakes on
* different connections are tracked independently. A handshake whose start event
* was never seen (for instance because tracing was enabled mid-handshake) is
* ignored rather than producing a span with missing timing. Spans are recorded
* only while the tracer provider context is enabled, so enabling the
* instrumentation while tracing is off is inert until a provider is installed.
*
* This is internal wiring behind the public OpenTelemetry facade — application
* code enables the full instrumentation set through the SDK rather than
* constructing this class directly. Use it directly only when selectively wiring
* runtime instrumentations against a custom SDK-like sink.
*
* ```ts no_run
* import { TlsInstrumentation } from 'internal:opentelemetry/instrumentations/tls';
*
* const instrumentation = new TlsInstrumentation();
* const disposable = instrumentation.enable(sdk);
*
* // TLS handshakes now record `TLS host:port` client spans through `sdk`.
* // Detach the topic subscriptions during shutdown.
* disposable.dispose();
* ```
*
* @internal
*/
import { topic } from '../../../context/topic.ts';
import { nowUnixNano, otelRuntimeTopic } from '../common.ts';
import type { Disposable, OtelSdkLike, RuntimeTlsEvent, SpanStatus } from '../common.ts';
import { createRuntimeClientSpan } from './_runtime-client.ts';
import { isTracerProviderContextEnabled } from '../traces.ts';
/**
* Runtime TLS handshake instrumentation.
*
* Construct once, then call `enable(sdk)` to attach the topic subscriptions and
* receive a `Disposable` that removes them again. The class holds no global
* state, so the same instrumentation type can be enabled independently against
* several SDK instances; a single instance, however, keeps one live map of
* in-flight handshakes and should be `enable`d once at a time.
*
* Only handshakes that both start and finish while the tracer provider context
* is enabled produce a span. A start observed with tracing off leaves nothing to
* correlate the later end against, and an end or error whose start was never
* recorded is silently dropped.
*
* ```ts no_run
* import { TlsInstrumentation } from 'internal:opentelemetry/instrumentations/tls';
*
* const spans: unknown[] = [];
* const sdk = { recordSpan: (span: unknown) => spans.push(span) };
*
* const disposable = new TlsInstrumentation().enable(sdk);
* // ... run TLS traffic; each handshake pushes a span into `spans` ...
* disposable.dispose();
* ```
*
* @internal
*/
export class TlsInstrumentation {
  /**
  * Tracks in-flight TLS handshakes between their start and end/error events.
  *
  * Keyed by the handshake id carried on every `RuntimeTlsEvent`, each entry
  * captures the peer hostname and port, the originating runtime request id and
  * hop when the handshake belongs to an outgoing request, and the start
  * timestamp used as the span's start time. Entries are inserted on
  * `tls.handshake.start` and removed when the matching end or error event
  * finishes the span, so the map only ever holds handshakes still negotiating.
  *
  * @internal
  */
  #active = new Map<string, {
    requestId?: string;
    hop?: number;
    hostname?: string;
    port?: number;
    startTimeUnixNano: number;
  }>();
  /**
  * Subscribes to the TLS handshake topics and streams completed spans to `sdk`.
  *
  * Attaches three subscriptions — start, end, and error — to the runtime's TLS
  * handshake topics. `sdk` need only supply a `recordSpan` method; each finished
  * handshake is passed to it as a client span named `TLS <hostname>:<port>`
  * carrying `server.address`/`server.port`, the negotiated `tls.protocol.name`,
  * the originating `runtime.request_id`/`runtime.request_hop` when the handshake
  * belongs to an outgoing request, and `error.message` on failure. Successful
  * handshakes get an `OK` status; failed ones get `ERROR` with the error text.
  *
  * The returned `Disposable` removes all three subscriptions; call its `dispose`
  * during shutdown to detach cleanly. While the tracer provider context is
  * disabled every callback is a no-op, so no spans are buffered when tracing is
  * off.
  *
  * ```ts no_run
  * import { TlsInstrumentation } from 'internal:opentelemetry/instrumentations/tls';
  *
  * const disposable = new TlsInstrumentation().enable({
  *   recordSpan(span) {
  *     console.log('tls span', span.name);
  *   },
  * });
  *
  * // Stop recording TLS handshake spans.
  * disposable.dispose();
  * ```
  *
  * @internal
  */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeTlsEvent>(otelRuntimeTopic('tls', 'handshake', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      this.#active.set(event.handshakeId, {
        ...event.requestId ? { requestId: event.requestId } : {},
        ...event.hop !== undefined ? { hop: event.hop } : {},
        ...event.hostname ? { hostname: event.hostname } : {},
        ...event.port !== undefined ? { port: event.port } : {},
        startTimeUnixNano: event.timeUnixNano || nowUnixNano()
      });
    });
    const finish = (event: RuntimeTlsEvent, status: SpanStatus) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.handshakeId);
      if (!span) return;
      this.#active.delete(event.handshakeId);
      sdk.recordSpan(createRuntimeClientSpan(`TLS ${span.hostname}:${span.port}`, 'tls', event.resource, span.startTimeUnixNano, event.timeUnixNano || nowUnixNano(), {
        'server.address': span.hostname,
        'server.port': span.port,
        ...event.protocol ? { 'tls.protocol.name': event.protocol } : {},
        ...span.requestId ? { 'runtime.request_id': span.requestId } : {},
        ...typeof span.hop === 'number' ? { 'runtime.request_hop': span.hop } : {},
        ...event.error ? { 'error.message': String((event.error as Error)?.message || event.error) } : {}
      }, status));
    };
    const onEnd = topic<RuntimeTlsEvent>(otelRuntimeTopic('tls', 'handshake', 'end')).subscribe((event) => finish(event, { code: 'OK' }));
    const onError = topic<RuntimeTlsEvent>(otelRuntimeTopic('tls', 'handshake', 'error')).subscribe((event) => finish(event, {
      code: 'ERROR',
      message: String((event.error as Error)?.message || event.error)
    }));
    return { dispose() {
      onStart.dispose();
      onEnd.dispose();
      onError.dispose();
    } };
  }
}
