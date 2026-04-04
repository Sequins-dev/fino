import { randomHex } from '../common.mts';
import type { Attributes, Resource, SpanRecord, SpanStatus } from '../common.mts';
import { getActiveSpanContext } from '../traces.mts';

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
    ...(parentContext?.traceId && parentContext?.spanId ? { parentSpanId: parentContext.spanId } : {}),
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    scope: { name: scopeName },
    ...(resource ? { resource } : {}),
    status,
  };
}
