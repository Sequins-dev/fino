/**
* internal:opentelemetry/instrumentations/trace-topic — bridges manual tracing
* events into assembled OpenTelemetry span records.
*
* Manual tracing in Fino works by publishing events onto scoped trace topics:
* starting a span, setting an attribute, appending an event or link, updating
* status, renaming the operation, and ending the span each publish a discrete
* message. This instrumentation is the consumer that stitches those messages
* back into a single span. It subscribes to every phase, buffers the in-flight
* span keyed by span id, folds each mutation into the buffered record, and on
* the end event delivers one completed `SpanRecord` to the SDK's processors.
*
* Without this instrumentation enabled, manually created spans publish their
* events but nothing collects them, so they never reach an exporter. It is
* installed by default in the standard SDK bootstrap and is also listed
* explicitly whenever an application configures its own `OtelSDK`.
*
* Buffered spans that never receive an end event would otherwise leak, so the
* instrumentation runs a periodic sweep that evicts any span open for longer
* than five minutes. This is a safety valve, not a normal code path — a
* well-behaved producer always ends its spans.
*
* Because it is an `internal:*` module, application code does not import it
* directly; it is re-exported as `TraceTopicInstrumentation` from
* `fino:opentelemetry` and `fino:opentelemetry/sdk` and passed to the SDK.
*
* ```ts no_run
* import { OtelSDK, BatchSpanProcessor, OTLPHttpJsonExporter, TraceTopicInstrumentation }
*   from 'fino:opentelemetry/sdk';
*
* const sdk = new OtelSDK({
*   spanProcessors: [new BatchSpanProcessor(new OTLPHttpJsonExporter())],
*   instrumentations: [new TraceTopicInstrumentation()],
* });
* sdk.start();
* ```
*
* @internal
*/
import { subscribeMatching } from '../../../context/topic.ts';
import type { Disposable, OtelSdkLike, SpanEventRecord, SpanLinkRecord, SpanRecord } from '../common.ts';
import { isScopedTraceTopic } from '../traces.ts';
/**
* Instrumentation that assembles manual-tracing topic events into span records.
*
* An instance is stateless until `enable()` is called; the SDK constructs it,
* holds it in its instrumentation list, and calls `enable()` once during
* startup. The returned disposable is retained by the SDK and disposed on
* shutdown. All buffering, subscription, and eviction state lives inside the
* `enable()` closure rather than on the instance, so the same instrument can be
* enabled against more than one SDK sink independently.
*
* The instrument matches the scoped trace topics for the seven span phases
* (`start`, `attribute`, `event`, `link`, `status`, `rename`, `end`) using
* `isScopedTraceTopic`. Mutation events for an unknown span id are dropped
* silently, which tolerates events that arrive after eviction or before a
* start.
*
* ```ts no_run
* import { TraceTopicInstrumentation }
*   from 'internal:opentelemetry/instrumentations/trace-topic';
*
* const instrumentation = new TraceTopicInstrumentation();
* const spans = [];
* const handle = instrumentation.enable({
*   recordSpanStart() {},
*   recordSpan(span) { spans.push(span); },
* });
*
* // ... manual tracing publishes start/attribute/end events for a span ...
*
* handle.dispose(); // stops subscriptions, cancels eviction, clears buffers
* ```
*
* @internal
*/
export class TraceTopicInstrumentation {
  /**
  * Subscribe to the scoped trace topics and begin forwarding spans to a sink.
  *
  * A `start` event seeds a buffered record from the span's identity, kind,
  * parent, start time, initial attributes, and scope/resource, then calls
  * `sdk.recordSpanStart()` with the raw start payload. Subsequent `attribute`,
  * `event`, `link`, `status`, and `rename` events fold into that buffered
  * record: attributes are merged by key, events and links are appended, status
  * replaces the current status, and a rename replaces the operation name. A
  * mutation whose span id is not currently buffered is ignored.
  *
  * The `end` event finalizes the span. It merges the buffered start state with
  * the defined fields of the end payload — preferring the accumulated name,
  * attributes, status, events, and links — resolves start and end timestamps,
  * removes the buffered entry, and calls `sdk.recordSpan()` with the completed
  * record. An end event for a span that was never started (or was already
  * evicted) still produces a best-effort record from the end payload alone.
  *
  * Buffered spans carry an internal start timestamp; a timer running once per
  * minute evicts any span older than five minutes so a missing end event
  * cannot leak memory indefinitely.
  *
  * The returned disposable removes all seven subscriptions, cancels the
  * eviction timer, and clears the buffer. Disposing is idempotent from the
  * SDK's perspective and should be called on shutdown.
  *
  * ```ts no_run
  * import { TraceTopicInstrumentation }
  *   from 'internal:opentelemetry/instrumentations/trace-topic';
  *
  * const handle = new TraceTopicInstrumentation().enable({
  *   recordSpanStart(span) { console.log('started', span.spanId); },
  *   recordSpan(span) { console.log('completed', span.name, span.attributes); },
  * });
  *
  * // Later, during SDK shutdown:
  * handle.dispose();
  * ```
  *
  * @internal
  */
  enable(sdk: OtelSdkLike): Disposable {
    const SPAN_TTL_MS = 5 * 60 * 1e3;
    const EVICTION_INTERVAL_MS = 60 * 1e3;
    const active = new Map<string, SpanRecord & {
      _startedAt: number;
    }>();
    const evictionTimer = (setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of active) {
        if (now - entry._startedAt > SPAN_TTL_MS) active.delete(id);
      }
    }, EVICTION_INTERVAL_MS) as unknown) as number;
    const onStart = subscribeMatching<SpanRecord>((name) => isScopedTraceTopic(name, 'start'), (span) => {
      active.set(span.spanId, {
        name: span.operation || span.name || '',
        traceId: span.traceId,
        spanId: span.spanId,
        ...span.kind !== undefined ? { kind: span.kind } : {},
        ...span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {},
        ...span.timeUnixNano !== undefined ? { startTimeUnixNano: span.timeUnixNano } : {},
        attributes: { ...span.attributes || {} },
        ...span.scope ? { scope: span.scope } : {},
        ...span.resource ? { resource: span.resource } : {},
        events: [],
        links: [],
        _startedAt: Date.now()
      });
      sdk.recordSpanStart(span);
    });
    const onAttribute = subscribeMatching<SpanRecord & {
      attributeKey?: string;
      attributeValue?: unknown;
    }>((name) => isScopedTraceTopic(name, 'attribute'), (event) => {
      const span = active.get(event.spanId);
      if (!span || typeof event.attributeKey !== 'string') return;
      span.attributes = {
        ...span.attributes || {},
        [event.attributeKey]: event.attributeValue
      };
    });
    const onEvent = subscribeMatching<SpanRecord & {
      event?: SpanEventRecord;
    }>((name) => isScopedTraceTopic(name, 'event'), (event) => {
      const span = active.get(event.spanId);
      if (!span || !event.event) return;
      span.events = [...span.events || [], event.event];
    });
    const onLink = subscribeMatching<SpanRecord & {
      link?: SpanLinkRecord;
    }>((name) => isScopedTraceTopic(name, 'link'), (event) => {
      const span = active.get(event.spanId);
      if (!span || !event.link) return;
      span.links = [...span.links || [], event.link];
    });
    const onStatus = subscribeMatching<SpanRecord>((name) => isScopedTraceTopic(name, 'status'), (event) => {
      const span = active.get(event.spanId);
      if (span) span.status = event.status ?? null;
    });
    const onRename = subscribeMatching<SpanRecord & {
      nextOperation?: string;
    }>((name) => isScopedTraceTopic(name, 'rename'), (event) => {
      const span = active.get(event.spanId);
      if (span && typeof event.nextOperation === 'string') span.name = event.nextOperation;
    });
    const onEnd = subscribeMatching<SpanRecord>((name) => isScopedTraceTopic(name, 'end'), (span) => {
      const start = active.get(span.spanId);
      active.delete(span.spanId);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _startedAt: _dropped, ...startWithoutMeta } = (start || {}) as SpanRecord & {
        _startedAt?: number;
      };
      const merged: SpanRecord = {
        ...startWithoutMeta as SpanRecord,
        ...Object.fromEntries(Object.entries(span).filter(([, value]) => value !== undefined)),
        name: start?.name || span.operation || span.name || '',
        attributes: { ...start?.attributes || {} },
        status: start?.status ?? span.status ?? null,
        events: start?.events || [],
        links: start?.links || [],
        ...(start?.startTimeUnixNano || span.startTimeUnixNano) !== undefined ? { startTimeUnixNano: start?.startTimeUnixNano || span.startTimeUnixNano } : {},
        ...(span.timeUnixNano || span.endTimeUnixNano) !== undefined ? { endTimeUnixNano: span.timeUnixNano || span.endTimeUnixNano } : {}
      };
      sdk.recordSpan(merged);
    });
    return { dispose() {
      clearInterval(evictionTimer);
      onStart.dispose();
      onAttribute.dispose();
      onEvent.dispose();
      onLink.dispose();
      onStatus.dispose();
      onRename.dispose();
      onEnd.dispose();
      active.clear();
    } };
  }
}
