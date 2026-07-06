/**
* internal:opentelemetry/instrumentations/socket — client spans for outbound socket connects.
*
* The runtime's networking layer publishes a small lifecycle protocol on the
* OpenTelemetry runtime topic bus whenever it opens a socket: a
* `socket.connect.start` event when a connect begins, then exactly one
* `socket.connect.end` (success) or `socket.connect.error` (failure) when it
* resolves. This instrumentation subscribes to that protocol and turns each
* completed connect into a single `client`-kind span named `CONNECT
* <host>:<port>`, stitched into whatever trace was active on the async context
* when the connect started (via the shared runtime client-span factory).
*
* Correlation is by connect id: the `start` event's payload is stashed in an
* in-flight map keyed by `connectId`, and the matching `end`/`error` event looks
* it up, computes the duration, and emits the span. This design means the span
* is only produced once the outcome is known, so its status and any error
* message reflect the real result rather than an optimistic guess. Events with
* no recorded start (for instance if the instrumentation was enabled mid-connect)
* are silently ignored, and spans are only recorded while tracer-provider context
* recording is enabled — when tracing is disabled no map entries are created and
* nothing is emitted, so the instrumentation adds negligible overhead.
*
* This module is internal to the OpenTelemetry implementation. Application code
* does not import it directly; the OTel SDK wires it up alongside the other
* runtime instrumentations and passes itself in as the span sink.
*
* ```ts no_run
*   import { SocketInstrumentation } from 'internal:opentelemetry/instrumentations/socket';
*   import { getSpanProcessor } from 'internal:opentelemetry/traces.ts';
*
*   const instrumentation = new SocketInstrumentation();
*   const subscription = instrumentation.enable({
*     recordSpan(span) {
*       getSpanProcessor()?.onEnd(span);
*     },
*   });
*
*   // ... later, during SDK shutdown:
*   subscription.dispose();
* ```
*
* @internal
*/
import { topic } from '../../../context/topic.ts';
import { nowUnixNano, otelRuntimeTopic } from '../common.ts';
import type { Disposable, OtelSdkLike, RuntimeSocketEvent, SpanStatus } from '../common.ts';
import { createRuntimeClientSpan } from './_runtime-client.ts';
import { isTracerProviderContextEnabled } from '../traces.ts';
/**
* Turns runtime socket-connect topic events into client spans.
*
* An instance holds the in-flight connect map for a single subscription to the
* three `socket.connect.*` topics. Construct one, call `enable` to start
* recording, and hold the returned disposable so the subscriptions can be torn
* down cleanly at shutdown. A single instance can be enabled once; enabling
* again would create a second, independent set of subscriptions sharing the same
* in-flight map, so create a fresh instance per SDK if you need to re-enable.
*
* Spans are only emitted while tracer-provider context recording is enabled, and
* only for connects whose `start` event was observed. A connect that ends or
* errors without a matching start (or while tracing was disabled at start time)
* produces no span.
*
* ```ts no_run
*   import { SocketInstrumentation } from 'internal:opentelemetry/instrumentations/socket';
*
*   const recorded = [];
*   const instrumentation = new SocketInstrumentation();
*   const subscription = instrumentation.enable({
*     recordSpan(span) {
*       recorded.push(span);
*     },
*   });
*
*   // outbound connects flowing through the runtime now produce
*   // `CONNECT <host>:<port>` client spans in `recorded`.
*   subscription.dispose();
* ```
*
* @internal
*/
export class SocketInstrumentation {
  /**
  * In-flight connects awaiting their end or error event, keyed by connect id.
  *
  * A `socket.connect.start` event inserts an entry capturing the details needed
  * to build the span later — request correlation id, request hop, peer host and
  * port, transport, and the start timestamp. The matching `end`/`error` event
  * removes the entry and emits the span; entries therefore live only for the
  * duration of a single connect. Because insertion is gated on tracer context
  * being enabled, the map stays empty when tracing is off.
  *
  * @internal
  */
  #active = new Map<string, {
    requestId?: string;
    hop?: number;
    host?: string;
    port?: number;
    transport: string;
    startTimeUnixNano: number;
  }>();
  /**
  * Subscribe to the socket-connect topics and record a client span per connect.
  *
  * Subscribes to `socket.connect.start`, `socket.connect.end`, and
  * `socket.connect.error`. Each successful connect produces a span with status
  * `OK`; each failed connect produces a span with status `ERROR` carrying the
  * error message. Every span is named `CONNECT <host>:<port>` and carries
  * network attributes (`net.transport`, `net.peer.name`, `net.peer.port`) plus,
  * when the originating request supplied them, `runtime.request_id` and
  * `runtime.request_hop`, and on failure `error.message`. Completed spans are
  * handed to `sdk.recordSpan`; this method never records them itself, so the
  * caller's sink decides how they are exported.
  *
  * The returned disposable removes all three subscriptions. It must be invoked
  * during SDK shutdown to avoid leaking subscriptions and holding the instance
  * (and any not-yet-finished map entries) alive.
  *
  * ```ts no_run
  *   import { SocketInstrumentation } from 'internal:opentelemetry/instrumentations/socket';
  *   import { getSpanProcessor } from 'internal:opentelemetry/traces.ts';
  *
  *   const subscription = new SocketInstrumentation().enable({
  *     recordSpan(span) {
  *       getSpanProcessor()?.onEnd(span);
  *     },
  *   });
  *
  *   // tear down when the tracer provider shuts down
  *   subscription.dispose();
  * ```
  *
  * @internal
  */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeSocketEvent>(otelRuntimeTopic('socket', 'connect', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      this.#active.set(event.connectId, {
        ...event.requestId ? { requestId: event.requestId } : {},
        ...event.hop !== undefined ? { hop: event.hop } : {},
        ...event.host ? { host: event.host } : {},
        ...event.port !== undefined ? { port: event.port } : {},
        transport: event.transport || 'tcp',
        startTimeUnixNano: event.timeUnixNano || nowUnixNano()
      });
    });
    const finish = (event: RuntimeSocketEvent, status: SpanStatus) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.connectId);
      if (!span) return;
      this.#active.delete(event.connectId);
      sdk.recordSpan(createRuntimeClientSpan(`CONNECT ${span.host}:${span.port}`, 'socket', event.resource, span.startTimeUnixNano, event.timeUnixNano || nowUnixNano(), {
        'net.transport': span.transport,
        'net.peer.name': span.host,
        'net.peer.port': span.port,
        ...span.requestId ? { 'runtime.request_id': span.requestId } : {},
        ...typeof span.hop === 'number' ? { 'runtime.request_hop': span.hop } : {},
        ...event.error ? { 'error.message': String((event.error as Error)?.message || event.error) } : {}
      }, status));
    };
    const onEnd = topic<RuntimeSocketEvent>(otelRuntimeTopic('socket', 'connect', 'end')).subscribe((event) => finish(event, { code: 'OK' }));
    const onError = topic<RuntimeSocketEvent>(otelRuntimeTopic('socket', 'connect', 'error')).subscribe((event) => finish(event, {
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
