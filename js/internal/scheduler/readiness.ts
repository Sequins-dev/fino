/**
 * internal:scheduler/readiness — compare parked-isolate readiness drivers.
 *
 * The resident path gives every workload a stable owner id and attaches its
 * TypeScript loop to one thread reactor. Rust waits for scalar readiness,
 * enters the captured owner, and invokes that realm's TypeScript completion
 * hook. The promise resolver, actual read/write syscall, buffers, retry loop,
 * and protocol policy stay in the workload.
 *
 * The older host-operation path remains beside it as a benchmark comparison.
 * The prototype does not yet provide placement, migration, or CPU budgets.
 *
 * ```ts no_run
 * import { runReadinessWorkload } from 'internal:scheduler/readiness';
 *
 * const result = await runReadinessWorkload('./worker.ts', { fd: socketFd });
 * ```
 *
 * @internal
 */
import * as hostLoop from 'internal:runtime/loop';
import { driveSharedResidentWorkloads } from 'internal:scheduler-native';
import {
  Isolate,
  type HostOperation,
  type PumpOutcome,
  type ResidentRunResult,
} from './isolate.ts';
async function performReadinessOperation(operation: HostOperation): Promise<unknown> {
  const fd = Number(operation.args?.fd);
  if (!Number.isInteger(fd) || fd < 0) {
    throw new TypeError(`invalid readiness fd: ${String(operation.args?.fd)}`);
  }
  switch (operation.operation) {
    case 'readable':
      return await hostLoop.readable(fd);
    case 'writable':
      await hostLoop.writable(fd);
      return null;
    case 'removeRead':
      hostLoop.removeRead(fd);
      return null;
    case 'removeWrite':
      hostLoop.removeWrite(fd);
      return null;
    default:
      throw new Error(`unsupported scheduler host operation: ${operation.operation}`);
  }
}
interface PendingOperation {
  operation: HostOperation;
  promise: Promise<void>;
}
function startOperation(
  isolate: Isolate,
  operation: HostOperation,
  pending: Set<PendingOperation>,
): void {
  let record!: PendingOperation;
  const promise = (async () => {
    try {
      let ok = true;
      let value: unknown;
      try {
        value = await performReadinessOperation(operation);
      } catch (error) {
        ok = false;
        value = { message: error instanceof Error ? error.message : String(error) };
      }
      isolate.complete(operation.id, ok, JSON.stringify(value));
    } finally {
      pending.delete(record);
    }
  })();
  record = {
    operation,
    promise,
  };
  pending.add(record);
}
function cancelOperation(operation: HostOperation): void {
  const fd = Number(operation.args?.fd);
  if (!Number.isInteger(fd) || fd < 0) return;
  if (operation.operation === 'readable') {
    hostLoop.removeRead(fd);
  } else if (operation.operation === 'writable') {
    hostLoop.removeWrite(fd);
  }
}
/**
 * Run one workload isolate to completion on the caller's readiness loop.
 *
 * `entryPath` must default-export a function. `input` is JSON-serialized and
 * passed to that function. The workload may use ordinary Fino stream and socket
 * APIs: their actual syscalls and buffer handling execute inside the workload,
 * while readiness promises are registered on the caller's single loop backend.
 *
 * Multiple calls may run concurrently. They share the caller's io_uring,
 * kqueue, or poll backend without sharing V8 state. The returned promise rejects
 * for unsupported host operations or workload failures, and the isolate is
 * always disposed after settlement. Concurrent readiness requests resume the
 * workload on the first completion; losing watches are cancelled at teardown
 * rather than forming an all-operations barrier.
 *
 * ```ts no_run
 * const [left, right] = await Promise.all([
 *   runReadinessWorkload('./reader.ts', { fd: leftFd }),
 *   runReadinessWorkload('./reader.ts', { fd: rightFd }),
 * ]);
 * ```
 *
 * @internal
 */
export async function runReadinessWorkload<T = unknown>(
  entryPath: string,
  input: unknown,
): Promise<T> {
  const isolate = new Isolate(entryPath);
  const pending = new Set<PendingOperation>();
  let wake: Promise<number> | undefined;
  let request = JSON.stringify(input);
  try {
    while (true) {
      const outcome: PumpOutcome = isolate.pump(request);
      request = '{}';
      switch (outcome.kind) {
        case 'settled':
          return outcome.value as T;
        case 'hostOperations': {
          for (const operation of outcome.operations) {
            startOperation(isolate, operation, pending);
          }
          await Promise.race(Array.from(pending, (operation) => operation.promise));
          break;
        }
        case 'pending': {
          wake ??= hostLoop.readable(isolate.wakeFd).finally(() => {
            wake = undefined;
          });
          if (pending.size === 0) {
            await wake;
          } else {
            await Promise.race([wake, ...Array.from(pending, (operation) => operation.promise)]);
          }
          break;
        }
      }
    }
  } finally {
    if (wake !== undefined) hostLoop.removeRead(isolate.wakeFd);
    for (const { operation } of pending) cancelOperation(operation);
    pending.clear();
    isolate.terminate();
  }
}
/**
 * Run one workload while retaining it as the thread's entered isolate.
 *
 * Unlike {@link runReadinessWorkload}, this single-workload comparison path
 * blocks the calling scheduler isolate until settlement. The workload uses its
 * own ordinary TypeScript readiness loop, and native code leaves it entered
 * across every loop turn. The returned counters cover the dispatch run itself;
 * construction and disposal are outside them.
 *
 * This is an experiment for measuring isolate transition costs, not a
 * multi-workload scheduler. A future shared-reactor implementation would keep
 * the same resident execution invariant while switching only when another
 * workload becomes runnable.
 *
 * @internal
 */
export function runResidentReadinessWorkload<T = unknown>(
  entryPath: string,
  input: unknown,
): ResidentRunResult<T> {
  const isolate = new Isolate(entryPath, true);
  try {
    return isolate.runResident<T>(input);
  } finally {
    isolate.terminate();
  }
}
/**
 * Result of running several resident isolates over one thread-shared backend.
 *
 * `workloadSwitches` counts transitions between workload isolates after their
 * initial dispatch. `schedulerReadinessTurns` is always zero: scheduler
 * TypeScript chooses the next captured owner, but it never polls or resolves
 * readiness itself.
 *
 * @internal
 */
export interface SharedResidentRunResult<T = unknown> {
  values: T[];
  workloadSwitches: number;
  schedulerReadinessTurns: number;
  isolateEntries: number;
  isolateExits: number;
  loopTurns: number;
}
/**
 * Run several workload isolates whose ordinary TypeScript loops attach to the
 * current thread's one kqueue/io_uring backend.
 *
 * Each workload is entered once to create its task and publish its readiness
 * registration. The native driver then retains the active isolate until it
 * settles or a completion captured for another owner requires a direct switch.
 * The caller's TypeScript performs setup and teardown only; it does not poll,
 * resolve readiness, or participate between workload switches.
 *
 * @internal
 */
export function runSharedResidentReadinessWorkloads<T = unknown>(
  entryPath: string,
  inputs: unknown[],
): SharedResidentRunResult<T> {
  if (inputs.length === 1) {
    const result = runResidentReadinessWorkload<T>(entryPath, inputs[0]);
    return {
      values: [result.value],
      workloadSwitches: 0,
      schedulerReadinessTurns: 0,
      isolateEntries: result.isolateEntries,
      isolateExits: result.isolateExits,
      loopTurns: result.loopTurns,
    };
  }
  const isolates = inputs.map(() => new Isolate(entryPath, true));
  try {
    const result = driveSharedResidentWorkloads(
      isolates.map((isolate) => isolate.nativeHandle),
      inputs,
    ) as Omit<SharedResidentRunResult<T>, 'schedulerReadinessTurns'>;
    return {
      ...result,
      schedulerReadinessTurns: 0,
    };
  } finally {
    for (const isolate of isolates) isolate.terminate();
  }
}
