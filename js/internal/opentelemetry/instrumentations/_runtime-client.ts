/**
 * internal:opentelemetry/instrumentations/_runtime-client — client span factory for runtime instrumentations.
 *
 * Runtime instrumentations (sockets, DNS, outbound HTTP, and similar low-level
 * subsystems) observe a lifecycle event after it has already happened: they hold
 * the operation's start and end timestamps, a bag of attributes, and a final
 * status, and they need to emit a single `client`-kind span for it. This helper
 * centralizes the one piece of that shaping that is easy to get wrong — stitching
 * the span into the caller's active trace context.
 *
 * When a span is active on the current async context at the moment the helper is
 * called, the produced span joins that trace: it inherits the active trace id and
 * records the active span as its parent, so the runtime operation nests under the
 * application code that triggered it. When no span is active — for example a
 * connection opened by background machinery outside any request — a fresh trace id
 * is generated and the span becomes a root. The caller keeps full ownership of
 * everything else: it supplies the name, scope, timestamps, attributes, and status,
 * and it is responsible for actually recording the returned record with a span
 * processor.
 *
 * This module is internal to the OpenTelemetry implementation and is not part of
 * the public API; instrumentation authors import it, application code does not.
 *
 * ```ts no_run
 *   import { createRuntimeClientSpan } from 'internal:opentelemetry/instrumentations/_runtime-client';
 *
 *   // Inside a socket instrumentation, once a connect attempt finishes:
 *   sdk.recordSpan(createRuntimeClientSpan(
 *     `CONNECT ${host}:${port}`,
 *     'socket',
 *     event.resource,
 *     startTimeUnixNano,
 *     endTimeUnixNano,
 *     { 'net.peer.name': host, 'net.peer.port': port },
 *     { code: 'OK' },
 *   ));
 * ```
 *
 * @internal
 */
import { randomHex } from '../common.ts';
import type { Attributes, Resource, SpanRecord, SpanStatus } from '../common.ts';
import { getActiveSpanContext } from '../traces.ts';
/**
 * Builds a complete `client`-kind span record for an already-observed runtime operation, linked to the active trace when one exists.
 *
 * The `kind` is always `'client'`, matching the outbound nature of the runtime
 * subsystems this serves. Trace linkage is decided at call time from the active
 * span context: if a span is active, the returned record reuses that trace id and
 * sets the active span's id as its `parentSpanId`; if none is active, a fresh
 * random trace id is generated and no parent is set, making the span a root of a
 * new trace. A distinct random span id is always generated for the record itself.
 *
 * The `resource` argument is attached only when defined — passing `undefined`
 * leaves the `resource` field off the record entirely rather than setting it to a
 * nullish value. The `attributes` object is referenced as-is (not cloned), so the
 * caller should not keep mutating it after the call. Timestamps are taken verbatim
 * as Unix nanoseconds; this helper does no clock reading or unit conversion. It
 * never records or exports the span — the caller must hand the returned record to
 * a span processor. It does not throw.
 *
 * ```ts no_run
 *   import { createRuntimeClientSpan } from 'internal:opentelemetry/instrumentations/_runtime-client';
 *
 *   const start = performance.now() * 1e6;
 *   // ... perform the DNS lookup ...
 *   const end = performance.now() * 1e6;
 *
 *   const span = createRuntimeClientSpan(
 *     'DNS lookup example.com',
 *     'fino.dns',
 *     undefined,
 *     start,
 *     end,
 *     { 'dns.question.name': 'example.com', 'dns.answers.count': 2 },
 *     { code: 'OK' },
 *   );
 *   // span.traceId matches the active request's trace when one is in scope,
 *   // and span.parentSpanId points at whatever span was active at call time.
 * ```
 *
 * @internal
 */
export function createRuntimeClientSpan(
  name: string,
  scopeName: string,
  resource: Resource | undefined,
  startTimeUnixNano: number,
  endTimeUnixNano: number,
  attributes: Attributes,
  status: SpanStatus,
): SpanRecord {
  const parentContext = getActiveSpanContext();
  return {
    name,
    kind: 'client',
    traceId: parentContext?.traceId || randomHex(32),
    spanId: randomHex(16),
    ...(parentContext?.traceId && parentContext?.spanId
      ? { parentSpanId: parentContext.spanId }
      : {}),
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    scope: { name: scopeName },
    ...(resource ? { resource } : {}),
    status,
  };
}
