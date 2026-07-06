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
* Values cross the isolate boundary as an `internal:serializer` structured
* clone (both the request args and the injected result), so binary payloads
* (file bytes) travel as `Uint8Array`s directly — no JSON, no base64.
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
