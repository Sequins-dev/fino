import { subscribeMatching } from '../../util/topic.mts';
import type { Disposable, OtelSdkLike, SpanEventRecord, SpanLinkRecord, SpanRecord } from '../common.mts';
import { isScopedTraceTopic } from '../traces.mts';

export class TraceTopicInstrumentation {
  enable(sdk: OtelSdkLike): Disposable {
    const SPAN_TTL_MS = 5 * 60 * 1_000;
    const EVICTION_INTERVAL_MS = 60 * 1_000;
    const active = new Map<string, SpanRecord & { _startedAt: number }>();

    const evictionTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of active) {
        if (now - entry._startedAt > SPAN_TTL_MS) active.delete(id);
      }
    }, EVICTION_INTERVAL_MS) as unknown as number;

    const onStart = subscribeMatching<SpanRecord>(
      (name) => isScopedTraceTopic(name, 'start'),
      (span) => {
        active.set(span.spanId, {
          name: span.operation || span.name || '',
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.kind !== undefined ? { kind: span.kind } : {}),
          ...(span.parentSpanId !== undefined ? { parentSpanId: span.parentSpanId } : {}),
          ...(span.timeUnixNano !== undefined ? { startTimeUnixNano: span.timeUnixNano } : {}),
          attributes: { ...(span.attributes || {}) },
          ...(span.scope ? { scope: span.scope } : {}),
          ...(span.resource ? { resource: span.resource } : {}),
          events: [],
          links: [],
          _startedAt: Date.now(),
        });
        sdk.recordSpanStart(span);
      },
    );
    const onAttribute = subscribeMatching<SpanRecord & { attributeKey?: string; attributeValue?: unknown }>(
      (name) => isScopedTraceTopic(name, 'attribute'),
      (event) => {
        const span = active.get(event.spanId);
        if (!span || typeof event.attributeKey !== 'string') return;
        span.attributes = { ...(span.attributes || {}), [event.attributeKey]: event.attributeValue };
      },
    );
    const onEvent = subscribeMatching<SpanRecord & { event?: SpanEventRecord }>(
      (name) => isScopedTraceTopic(name, 'event'),
      (event) => {
        const span = active.get(event.spanId);
        if (!span || !event.event) return;
        span.events = [...(span.events || []), event.event];
      },
    );
    const onLink = subscribeMatching<SpanRecord & { link?: SpanLinkRecord }>(
      (name) => isScopedTraceTopic(name, 'link'),
      (event) => {
        const span = active.get(event.spanId);
        if (!span || !event.link) return;
        span.links = [...(span.links || []), event.link];
      },
    );
    const onStatus = subscribeMatching<SpanRecord>((name) => isScopedTraceTopic(name, 'status'), (event) => {
      const span = active.get(event.spanId);
      if (span) span.status = event.status ?? null;
    });
    const onRename = subscribeMatching<SpanRecord & { nextOperation?: string }>(
      (name) => isScopedTraceTopic(name, 'rename'),
      (event) => {
        const span = active.get(event.spanId);
        if (span && typeof event.nextOperation === 'string') span.name = event.nextOperation;
      },
    );
    const onEnd = subscribeMatching<SpanRecord>((name) => isScopedTraceTopic(name, 'end'), (span) => {
      const start = active.get(span.spanId);
      active.delete(span.spanId);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _startedAt: _dropped, ...startWithoutMeta } = (start || {}) as SpanRecord & { _startedAt?: number };
      const merged: SpanRecord = {
        ...(startWithoutMeta as SpanRecord),
        ...Object.fromEntries(Object.entries(span).filter(([, value]) => value !== undefined)),
        name: start?.name || span.operation || span.name || '',
        attributes: { ...(start?.attributes || {}) },
        status: start?.status ?? span.status ?? null,
        events: start?.events || [],
        links: start?.links || [],
        ...((start?.startTimeUnixNano || span.startTimeUnixNano) !== undefined
          ? { startTimeUnixNano: start?.startTimeUnixNano || span.startTimeUnixNano }
          : {}),
        ...((span.timeUnixNano || span.endTimeUnixNano) !== undefined
          ? { endTimeUnixNano: span.timeUnixNano || span.endTimeUnixNano }
          : {}),
      };
      sdk.recordSpan(merged);
    });
    return {
      dispose() {
        clearInterval(evictionTimer);
        onStart.dispose();
        onAttribute.dispose();
        onEvent.dispose();
        onLink.dispose();
        onStatus.dispose();
        onRename.dispose();
        onEnd.dispose();
        active.clear();
      },
    };
  }
}
