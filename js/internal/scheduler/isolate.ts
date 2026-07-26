/**
 * internal:scheduler/isolate — the scheduled tenant-isolate construct.
 *
 * An `Isolate` is one V8 isolate hosted on a scheduler thread with no OS thread
 * of its own. The owning scheduler powers its event loop: it enters and pumps
 * the isolate only when the isolate has work (a completion to turn into
 * microtasks), and never blocks the thread waiting on the isolate's I/O.
 *
 * This is the TypeScript face of the `internal:scheduler-native` primitive.
 * The prototype holds `Isolate` handles directly; a production scheduler could
 * later make realm placement resolve onto one without moving scheduling policy
 * into native code.
 *
 * @internal
 */
import {
  createWorkload,
  dispatchWorkload,
  driveResidentWorkload,
  completeHostOperation,
  terminateWorkload,
  workloadOwner,
  workloadWakeFd,
} from 'internal:scheduler-native';
/**
 * Outcome of a single native pump of an isolate.
 *
 * - `pending` — the isolate ran to quiescence and is parked on an outstanding
 *   operation; the scheduler should re-pump when its wake fd signals or a
 *   completion is injected. Never blocks.
 * - `hostOperations` — the isolate requested scalar readiness operations for
 *   the scheduler to register on its shared loop.
 * - `settled` — the dispatch resolved; `value` is its JSON-sized result.
 */
/** One scalar readiness operation the scheduler performs for a workload. */
export interface HostOperation {
  id: number;
  operation: string;
  args?: Record<string, unknown>;
}
export type PumpOutcome =
  | {
      kind: 'pending';
    }
  | {
      kind: 'hostOperations';
      operations: HostOperation[];
    }
  | {
      kind: 'settled';
      value: unknown;
    };
/**
 * The native pump wraps every outcome in a discriminated JSON envelope, so a
 * workload's result cannot be mistaken for scheduler control state.
 */
interface PumpEnvelope {
  kind: 'pending' | 'hostOperations' | 'settled';
  operations?: HostOperation[];
  value?: unknown;
}
/**
 * Result of driving one resident workload without leaving its isolate between
 * readiness turns.
 */
export interface ResidentRunResult<T = unknown> {
  value: T;
  loopTurns: number;
  isolateEntries: number;
  isolateExits: number;
}
/**
 * A scheduled tenant isolate. Created on the current (scheduler) thread; pumped
 * on demand by the owning scheduler loop.
 */
export class Isolate {
  #handle: number;
  constructor(entryPath: string, resident = false) {
    this.#handle = createWorkload(entryPath, !resident);
  }
  /**
   * Read end of this isolate's wake pipe. Register it on the scheduler loop
   * (`loop.readable`) so a background completion for this isolate wakes the
   * scheduler to re-pump exactly this isolate.
   */
  get wakeFd(): number {
    return workloadWakeFd(this.#handle);
  }
  /** Stable owner id captured in readiness tasks created by this isolate. */
  get owner(): number {
    return workloadOwner(this.#handle);
  }
  /** Opaque native handle used by the thread reactor driver. */
  get nativeHandle(): number {
    return this.#handle;
  }
  /**
   * Run one non-blocking pump. `requestJson` starts the dispatch on the first
   * pump; pass `'{}'` on subsequent pumps to continue an in-flight dispatch.
   *
   * The readiness prototype does not yet apply a CPU budget. The call must
   * therefore be made only for trusted exploratory workloads until scheduling
   * policy grows a termination mechanism.
   */
  pump(requestJson: string): PumpOutcome {
    const raw = JSON.parse(dispatchWorkload(this.#handle, requestJson)) as PumpEnvelope;
    switch (raw?.kind) {
      case 'hostOperations':
        return {
          kind: 'hostOperations',
          operations: raw.operations ?? [],
        };
      case 'pending':
        return { kind: 'pending' };
      case 'settled':
        return {
          kind: 'settled',
          value: raw.value,
        };
      default:
        throw new Error('scheduler pump returned an untagged outcome');
    }
  }
  /**
   * Enter this isolate once and drive its own TypeScript readiness loop until
   * the dispatch settles.
   *
   * This blocks the caller and is only a single-workload comparison path.
   */
  runResident<T>(input: unknown): ResidentRunResult<T> {
    return driveResidentWorkload(this.#handle, input) as ResidentRunResult<T>;
  }
  /**
   * Inject one JSON-sized readiness result and let the isolate resume.
   */
  complete(operationId: number, ok: boolean, resultJson: string): void {
    completeHostOperation(this.#handle, operationId, ok, resultJson);
  }
  /** Dispose the isolate and free its resources. */
  terminate(): void {
    terminateWorkload(this.#handle);
  }
}
