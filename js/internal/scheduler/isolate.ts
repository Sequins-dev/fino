/**
* internal:scheduler/isolate — the scheduled tenant-isolate construct.
*
* An `Isolate` is one V8 isolate hosted on a scheduler thread with no OS thread
* of its own. The owning scheduler powers its event loop: it enters and pumps
* the isolate only when the isolate has work (a completion to turn into
* microtasks), and never blocks the thread waiting on the isolate's I/O.
*
* This is the TypeScript face of the `internal:scheduler-native` primitive.
* Internals hold `Isolate` handles and decide scheduling; app code never sees
* one directly (a `Realm` placement resolves onto an `Isolate`).
*
* @internal
*/
import { createWorkload, dispatchWorkload, completeHostOperation, terminateWorkload, workloadWakeFd } from 'internal:scheduler-native';
import { deserialize } from 'internal:serializer';

/** Sentinel the native pump returns when the isolate is parked on external I/O. */
export const PUMP_PENDING = 'pumpPending';

/**
* Outcome of a single native pump of an isolate.
*
* - `pending` — the isolate ran to quiescence and is parked on an outstanding
*   operation; the scheduler should re-pump when its wake fd signals or a
*   completion is injected. Never blocks.
* - `hostOperation` — the isolate requested a privileged operation the scheduler
*   must perform on its behalf, then feed back via {@link Isolate.complete}.
* - `settled` — the dispatch resolved; `value` is the workload's returned result,
*   deserialized from the pump's internal:serializer bytes (binary preserved).
*/
/** One privileged operation the scheduler performs on a workload's behalf. */
export interface HostOperation {
  id: number;
  operation: string;
  args?: Record<string, unknown>;
}

export type PumpOutcome =
  | { kind: 'pending' }
  | { kind: 'hostOperations'; operations: HostOperation[] }
  | { kind: 'budgetTerminated' }
  | { kind: 'settled'; value: unknown };

/**
* The native pump wraps every outcome in a discriminated envelope tagged with
* `__finoPump`, so a tenant's own settled return value (nested under `value`)
* can never be mistaken for a `pending`/`terminated`/`hostOps` control outcome.
*/
interface PumpEnvelope {
  __finoPump: 'pending' | 'terminated' | 'hostOps' | 'settled';
  operations?: HostOperation[];
  value?: unknown;
}

/**
* A scheduled tenant isolate. Created on the current (scheduler) thread; pumped
* on demand by the owning scheduler loop.
*/
export class Isolate {
  #handle: number;

  constructor(entryPath: string, heapLimitBytes = 0) {
    this.#handle = createWorkload(entryPath, heapLimitBytes);
  }

  /**
  * Read end of this isolate's wake pipe. Register it on the scheduler loop
  * (`loop.readable`) so a background completion for this isolate wakes the
  * scheduler to re-pump exactly this isolate.
  */
  get wakeFd(): number {
    return workloadWakeFd(this.#handle);
  }

  /**
  * Run one non-blocking pump. `requestJson` starts the dispatch on the first
  * pump; pass `'{}'` on subsequent pumps to continue an in-flight dispatch.
  *
  * `hardBudgetMicros` bounds this single synchronous pump slice: if the isolate
  * runs synchronous JS past the budget, its execution is forcibly unwound and
  * the pump reports `budgetTerminated`. Zero (the default) disables the limit.
  * This is the runaway-containment budget, separate from the cooperative
  * accounting budget the workload reads from its dispatch request.
  */
  pump(requestJson: string, hardBudgetMicros = 0): PumpOutcome {
    const raw = deserialize(dispatchWorkload(this.#handle, requestJson, hardBudgetMicros)) as PumpEnvelope;
    switch (raw?.__finoPump) {
      case 'hostOps': return { kind: 'hostOperations', operations: raw.operations ?? [] };
      case 'pending': return { kind: 'pending' };
      case 'terminated': return { kind: 'budgetTerminated' };
      case 'settled': return { kind: 'settled', value: raw.value };
      default: throw new Error('scheduler pump returned an untagged outcome');
    }
  }

  /**
  * Inject the result of a scheduler-performed operation (as internal:serializer
  * bytes, so binary crosses without base64) and let the isolate resume.
  */
  complete(operationId: number, ok: boolean, payload: Uint8Array): void {
    completeHostOperation(this.#handle, operationId, ok, payload);
  }

  /** Dispose the isolate and free its resources. */
  terminate(): void {
    terminateWorkload(this.#handle);
  }
}
