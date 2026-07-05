/**
* internal:scheduler/facade-ops — the tenant side of facade-owned I/O.
*
* A tenant isolate does not own real I/O readiness. Instead its I/O modules are
* remapped to scheduler-backed providers that call {@link facadeOp}: this emits
* a `FacadeOperationRecord` to the owning scheduler, which performs the real
* operation on its own event loop and injects the result back. The tenant's
* promise stays parked (the scheduler pumps other isolates meanwhile) until the
* completion arrives.
*
* Values cross the isolate boundary as JSON, so binary payloads (file bytes)
* are wrapped with {@link encodeBinary} / {@link decodeBinary} as base64.
*
* @internal
*/

/** One privileged operation a tenant realm asked its scheduler to perform. */
export interface FacadeOperationRecord {
  provider: string;
  method: string;
  args: Record<string, unknown>;
}

interface SchedulerBridge {
  __finoSchedulerHostOp(operation: string, args: Record<string, unknown>): Promise<unknown>;
}

function bridge(): SchedulerBridge {
  const g = globalThis as unknown as Partial<SchedulerBridge>;
  if (typeof g.__finoSchedulerHostOp !== 'function') {
    throw new Error('facade I/O is only available inside a scheduler-managed realm');
  }
  return g as SchedulerBridge;
}

/**
* Ask the owning scheduler to perform `provider.method(args)` and resolve with
* its result. Rejects if the scheduler reports the operation failed.
*/
export function facadeOp(provider: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return bridge().__finoSchedulerHostOp(`${provider}:${method}`, args);
}

const B64 = '__finoU8Base64';

/** Wrap bytes for JSON transport as `{ [B64]: "<base64>" }`. */
export function encodeBinary(bytes: Uint8Array): Record<string, string> {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return { [B64]: btoa(binary) };
}

/** Reverse {@link encodeBinary}; returns the bytes for a wrapped value. */
export function decodeBinary(value: unknown): Uint8Array {
  const wrapped = value as Record<string, unknown> | null;
  const b64 = wrapped?.[B64];
  if (typeof b64 !== 'string') throw new TypeError('expected an encoded binary payload');
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** True when `value` is a wrapped binary payload from {@link encodeBinary}. */
export function isEncodedBinary(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)[B64] === 'string';
}
