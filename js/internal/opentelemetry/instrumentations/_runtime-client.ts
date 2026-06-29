/**
* internal/opentelemetry/instrumentations/_runtime-client — internal runtime module.
*
* Shared helper for runtime client instrumentations that need to turn an
* internal lifecycle event into a complete OpenTelemetry span record while
* preserving the current active trace context when one exists.
*
* ```js
* const { createRuntimeClientSpan } =
*   import 'internal:opentelemetry/instrumentations/_runtime-client';
* console.log(typeof createRuntimeClientSpan);
* ```
*
* @internal
*/
import { randomHex } from '../common.ts';
import type { Attributes, Resource, SpanRecord, SpanStatus } from '../common.ts';
import { getActiveSpanContext } from '../traces.ts';
/**
* Create a client span record from runtime event timestamps and attributes.
*
* If an active span context exists, its trace id is reused and its span id is
* set as `parentSpanId`. Otherwise a new trace id is generated. `resource` is
* attached only when provided. The caller is responsible for recording the span
* and for choosing status, scope name, and timestamps.
*
* ```js
* const { createRuntimeClientSpan } =
*   import 'internal:opentelemetry/instrumentations/_runtime-client';
* const span = createRuntimeClientSpan(
*   'CONNECT example.com:443',
*   'socket',
*   undefined,
*   1,
*   2,
*   { 'net.peer.name': 'example.com' },
*   { code: 'OK' },
* );
* console.log(span.kind);
* ```
*
* @param name Span operation name.
* @param scopeName Instrumentation scope name.
* @param resource Optional resource record to attach to the span.
* @param startTimeUnixNano Start timestamp in Unix nanoseconds.
* @param endTimeUnixNano End timestamp in Unix nanoseconds.
* @param attributes Span attributes copied into the record.
* @param status Final span status.
* @returns A complete client `SpanRecord`.
* @internal
*/
export function createRuntimeClientSpan(name: string, scopeName: string, resource: Resource | undefined, startTimeUnixNano: number, endTimeUnixNano: number, attributes: Attributes, status: SpanStatus): SpanRecord {
  const parentContext = getActiveSpanContext();
  return {
    name,
    kind: 'client',
    traceId: parentContext?.traceId || randomHex(32),
    spanId: randomHex(16),
    ...parentContext?.traceId && parentContext?.spanId ? { parentSpanId: parentContext.spanId } : {},
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    scope: { name: scopeName },
    ...resource ? { resource } : {},
    status
  };
}
