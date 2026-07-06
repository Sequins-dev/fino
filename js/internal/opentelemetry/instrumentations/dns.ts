/**
* internal/opentelemetry/instrumentations/dns — internal runtime module.
*
* Converts the runtime's DNS lookup lifecycle into OpenTelemetry client spans.
* The runtime publishes `dns.lookup.start`, `dns.lookup.end`, and
* `dns.lookup.error` topic events for each name resolution it performs; this
* instrumentation subscribes to all three and correlates them by lookup id.
*
* A start event opens an in-flight entry that captures the hostname, the
* originating request id and hop (when the lookup was triggered while handling
* an instrumented request), and a start timestamp. The matching end or error
* event closes the entry and emits a single `DNS <hostname>` client span
* through the SDK sink. Spans are only recorded while tracer-context recording
* is enabled, so instrumentation left enabled across a provider shutdown stops
* producing data without needing to be torn down. End or error events whose
* lookup id was never opened — for example because recording was disabled when
* the lookup began — are ignored rather than producing an orphan span.
*
* This is internal plumbing wired up by the OpenTelemetry SDK, not something
* applications construct directly. It is documented here for runtime
* maintainers; the private state is visible only when docs are built with
* `--include-private`.
*
* ```ts no_run
* import { DnsInstrumentation } from 'internal:opentelemetry/instrumentations/dns';
*
* const instrumentation = new DnsInstrumentation();
* const disposable = instrumentation.enable({
*   recordSpan(span) {
*     console.log(span.name); // e.g. "DNS example.com"
*   },
* });
*
* // On SDK shutdown:
* disposable.dispose();
* ```
*
* @internal
*/
import { topic } from '../../../context/topic.ts';
import { nowUnixNano, otelRuntimeTopic } from '../common.ts';
import type { Disposable, OtelSdkLike, RuntimeDnsEvent, SpanStatus } from '../common.ts';
import { createRuntimeClientSpan } from './_runtime-client.ts';
import { isTracerProviderContextEnabled } from '../traces.ts';
/**
* Turns runtime DNS lookup events into client spans.
*
* A single instance owns the map of in-flight lookups keyed by lookup id. It
* holds no configuration: construct it, call `enable` once with the SDK sink
* that should receive completed spans, and keep the
* returned disposable to unsubscribe at shutdown. Recording is gated on the
* tracer provider's context recording flag, so spans are suppressed while
* tracing is paused even though the subscriptions stay live.
*
* ```ts no_run
* import { DnsInstrumentation } from 'internal:opentelemetry/instrumentations/dns';
*
* const spans: unknown[] = [];
* const instrumentation = new DnsInstrumentation();
* const disposable = instrumentation.enable({
*   recordSpan(span) {
*     spans.push(span);
*   },
* });
*
* // ...run instrumented DNS lookups, then tear down:
* disposable.dispose();
* ```
*
* @internal
*/
export class DnsInstrumentation {
  /**
  * In-flight lookups awaiting an end or error event, keyed by lookup id.
  *
  * A start event inserts an entry carrying the fields needed to build the span
  * later: the hostname, the optional originating request id and hop, and the
  * lookup's start timestamp in Unix nanoseconds. The matching end or error
  * event reads and deletes the entry so each lookup produces exactly one span
  * and the map does not accumulate stale entries. Entries are only inserted
  * while recording is enabled, so lookups that begin while tracing is paused
  * are never tracked.
  *
  * @internal
  */
  #active = new Map<string, {
    requestId?: string;
    hop?: number;
    hostname?: string;
    startTimeUnixNano: number;
  }>();
  /**
  * Subscribes to the DNS lookup topics and streams completed spans to the sink.
  *
  * Each finished lookup produces one client span named `DNS <hostname>`. The
  * span's timestamps come from the start and end/error events, and its
  * attributes are populated only where data is available:
  * `dns.question.name` from the hostname, `dns.answer.address` from the
  * resolved address, `net.sock.family` from the socket family,
  * `runtime.request_id` and `runtime.request_hop` when the lookup was
  * triggered inside an instrumented request, and `error.message` on failure.
  * End events yield an `OK` status; error events yield an `ERROR` status
  * carrying the error message. When an active trace context exists the span is
  * parented to it, otherwise it starts a fresh trace.
  *
  * Call this exactly once per instance. The returned disposable removes all
  * three topic subscriptions and must be invoked during SDK shutdown to avoid
  * leaking them; dropping the reference without disposing leaves the
  * instrumentation subscribed for the lifetime of the process.
  *
  * ```ts no_run
  * import { DnsInstrumentation } from 'internal:opentelemetry/instrumentations/dns';
  *
  * const disposable = new DnsInstrumentation().enable({
  *   recordSpan(span) {
  *     if (span.status?.code === 'ERROR') {
  *       console.warn('DNS lookup failed:', span.attributes['error.message']);
  *     }
  *   },
  * });
  *
  * disposable.dispose();
  * ```
  *
  * @internal
  */
  enable(sdk: OtelSdkLike): Disposable {
    const onStart = topic<RuntimeDnsEvent>(otelRuntimeTopic('dns', 'lookup', 'start')).subscribe((event) => {
      if (!isTracerProviderContextEnabled()) return;
      this.#active.set(event.lookupId, {
        ...event.requestId ? { requestId: event.requestId } : {},
        ...event.hop !== undefined ? { hop: event.hop } : {},
        ...event.hostname ? { hostname: event.hostname } : {},
        startTimeUnixNano: event.timeUnixNano || nowUnixNano()
      });
    });
    const finish = (event: RuntimeDnsEvent, status: SpanStatus) => {
      if (!isTracerProviderContextEnabled()) return;
      const span = this.#active.get(event.lookupId);
      if (!span) return;
      this.#active.delete(event.lookupId);
      sdk.recordSpan(createRuntimeClientSpan(`DNS ${span.hostname}`, 'dns', event.resource, span.startTimeUnixNano, event.timeUnixNano || nowUnixNano(), {
        'dns.question.name': span.hostname,
        ...event.address ? { 'dns.answer.address': event.address } : {},
        ...event.family ? { 'net.sock.family': event.family } : {},
        ...span.requestId ? { 'runtime.request_id': span.requestId } : {},
        ...typeof span.hop === 'number' ? { 'runtime.request_hop': span.hop } : {},
        ...event.error ? { 'error.message': String((event.error as Error)?.message || event.error) } : {}
      }, status));
    };
    const onEnd = topic<RuntimeDnsEvent>(otelRuntimeTopic('dns', 'lookup', 'end')).subscribe((event) => finish(event, { code: 'OK' }));
    const onError = topic<RuntimeDnsEvent>(otelRuntimeTopic('dns', 'lookup', 'error')).subscribe((event) => finish(event, {
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
