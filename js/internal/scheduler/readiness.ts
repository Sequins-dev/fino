/**
 * internal:scheduler/readiness — compare parked-isolate readiness drivers.
 *
 * The resident paths give every workload a stable owner id. The single-thread
 * comparison attaches them to one thread reactor. The pooled path instead lets
 * the caller's main TypeScript realm own the process backend and choose which
 * quiescent isolate each native worker pumps.
 * Promise resolution, actual read/write syscalls, buffers, retry loops, and
 * protocol policy stay in TypeScript.
 *
 * The older host-operation path remains beside it as a benchmark comparison.
 * The pool defaults to one worker per available processor and retains the
 * selected isolate until another has strictly more queued readiness. It does
 * not yet provide CPU budgets or route platform-specific process/vnode/signal
 * watches through the process reactor.
 *
 * ```ts no_run
 * import {
 *   runPooledResidentReadinessWorkloads,
 *   runReadinessWorkload
 * } from 'internal:scheduler/readiness';
 *
 * const result = await runReadinessWorkload('./worker.ts', { fd: socketFd });
 *
 * const pooled = runPooledResidentReadinessWorkloads('./worker.ts', jobs, {
 *   threads: 4
 * });
 * ```
 *
 * @internal
 */
import * as hostLoop from 'internal:runtime/loop';
import {
  closeOrchestratedPool,
  createOrchestratedPool,
  driveSharedResidentWorkloads,
  scheduleOrchestratedWorker,
  takeOrchestratedPoolEvents,
} from 'internal:scheduler-native';
import {
  Isolate,
  type HostOperation,
  type PumpOutcome,
  type ResidentRunResult,
} from './isolate.ts';
import { currentProcessReadinessController } from './reactor.ts';
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
 * This is the single-workload comparison path. Use
 * {@link runPooledResidentReadinessWorkloads} when parked isolates should be
 * eligible to move across the process worker pool.
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
 * Result of running resident isolates across the process worker pool.
 *
 * `workloadMigrations` counts activations on a different worker from the
 * isolate's previous pool activation. `workerThreads` reports the effective
 * pool size after applying the host parallelism cap. The inherited transition
 * counters include settlement exits as well as priority-driven switches.
 *
 * @internal
 */
export interface PooledResidentRunResult<T = unknown> extends SharedResidentRunResult<T> {
  workloadMigrations: number;
  workerThreads: number;
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
/**
 * Run readiness-driven isolates on a process-wide worker pool.
 *
 * The selected isolate remains entered on its worker until a parked isolate
 * has a strictly larger readiness backlog. Exact ties retain the current
 * isolate. The caller's TypeScript realm owns the process backend, placement,
 * priority, and lifecycle policy. Native workers only enter, pump, retain, and
 * exit isolates when instructed. `threads` defaults to the host's available
 * parallelism and is capped at that value. Every input and result must be
 * structured-cloneable.
 *
 * ```ts no_run
 * const result = await runPooledResidentReadinessWorkloadsAsync('./reader.ts', jobs, {
 *   threads: 4
 * });
 * console.log(result.workloadMigrations);
 * ```
 *
 * @internal
 */
export async function runPooledResidentReadinessWorkloadsAsync<T = unknown>(
  entryPath: string,
  inputs: unknown[],
  options: {
    threads?: number;
  } = {},
): Promise<PooledResidentRunResult<T>> {
  if (inputs.length === 0) {
    return {
      values: [],
      workloadSwitches: 0,
      workloadMigrations: 0,
      schedulerReadinessTurns: 0,
      isolateEntries: 0,
      isolateExits: 0,
      loopTurns: 0,
      workerThreads: 0,
    };
  }
  const isolates = inputs.map(() => new Isolate(entryPath, true, true));
  let native: ReturnType<typeof createOrchestratedPool>;
  try {
    native = createOrchestratedPool(
      isolates.map((isolate) => isolate.nativeHandle),
      inputs,
      options.threads ?? 0,
    );
  } catch (error) {
    for (const isolate of isolates) isolate.terminate();
    throw error;
  }
  type WorkloadStatus = 'parked' | 'running' | 'resident' | 'switching' | 'settled';
  interface WorkloadState {
    owner: number;
    position: number;
    wakeFd: number;
    wakeArmed: boolean;
    pending: number;
    status: WorkloadStatus;
  }
  interface WorkerState {
    index: number;
    current?: number;
    releasing?: number;
    busy: boolean;
  }
  const workloads = new Map<number, WorkloadState>(
    native.owners.map((owner, position) => [
      owner,
      {
        owner,
        position,
        wakeFd: isolates[position].wakeFd,
        wakeArmed: false,
        pending: 1,
        status: 'parked',
      },
    ]),
  );
  const workers: WorkerState[] = Array.from(
    {
      length: native.workerThreads,
    },
    (_, index) => ({
      index,
      busy: false,
    }),
  );
  const values = new Array<T>(inputs.length);
  let remaining = inputs.length;
  let fatal: Error | undefined;
  let wakeVersion = 0;
  let observedWakeVersion = 0;
  let resolveWake: (() => void) | undefined;
  let schedulerReadinessTurns = 0;
  const wake = (): void => {
    wakeVersion++;
    resolveWake?.();
    resolveWake = undefined;
  };
  const waitForWake = async (): Promise<void> => {
    if (wakeVersion === observedWakeVersion) {
      await new Promise<void>((resolve) => {
        resolveWake = resolve;
      });
    }
    observedWakeVersion = wakeVersion;
    schedulerReadinessTurns++;
  };
  let stopped = false;
  const directReadiness = currentProcessReadinessController();
  const stopDirectReadiness =
    directReadiness === undefined
      ? []
      : native.owners.map((owner) =>
          directReadiness.listen(owner, () => {
            const workload = workloads.get(owner);
            if (workload !== undefined && workload.status !== 'settled') workload.pending++;
            wake();
          }),
        );
  let poolWakeArmed = false;
  const armPoolWake = (): void => {
    if (stopped || poolWakeArmed) return;
    poolWakeArmed = true;
    void hostLoop.readable(native.controlFd).then(() => {
      poolWakeArmed = false;
      if (!stopped) wake();
    });
  };
  const armWorkloadWake = (workload: WorkloadState): void => {
    if (stopped || workload.wakeArmed || workload.status === 'settled') return;
    workload.wakeArmed = true;
    void hostLoop.readable(workload.wakeFd).then(() => {
      workload.wakeArmed = false;
      if (stopped || workload.status === 'settled') return;
      workload.pending++;
      wake();
    });
  };
  const bestParked = (): WorkloadState | undefined => {
    let best: WorkloadState | undefined;
    for (const workload of workloads.values()) {
      if (workload.status !== 'parked' || workload.pending === 0) continue;
      if (best === undefined || workload.pending > best.pending) best = workload;
    }
    return best;
  };
  let metrics: ReturnType<typeof closeOrchestratedPool> | undefined;
  armPoolWake();
  try {
    while (remaining > 0 && fatal === undefined) {
      let progressed = false;
      for (const event of takeOrchestratedPoolEvents(native.handle)) {
        progressed = true;
        const workload = workloads.get(event.owner);
        if (workload === undefined) {
          fatal = new Error('orchestrated pool returned an unknown owner');
          break;
        }
        if (event.kind === 'ready') {
          if (workload.status !== 'settled') workload.pending++;
          continue;
        }
        const worker = workers[event.worker];
        if (worker === undefined) {
          fatal = new Error('orchestrated pool returned an unknown worker or owner');
          break;
        }
        if (worker.releasing !== undefined) {
          const released = workloads.get(worker.releasing);
          if (released?.status === 'switching') released.status = 'parked';
          worker.releasing = undefined;
        }
        worker.busy = false;
        if (event.kind === 'quiescent') {
          worker.current = event.owner;
          workload.status = 'resident';
          armWorkloadWake(workload);
        } else {
          worker.current = undefined;
          workload.status = 'settled';
          if (workload.wakeArmed) {
            hostLoop.removeRead(workload.wakeFd);
            workload.wakeArmed = false;
          }
          remaining--;
          if (event.kind === 'settled') {
            values[workload.position] = event.value as T;
          } else {
            fatal = new Error(event.error ?? `orchestrated workload ${event.owner} failed`);
            break;
          }
        }
      }
      armPoolWake();
      if (fatal !== undefined) break;

      for (const worker of workers) {
        if (worker.busy) continue;
        const current = worker.current === undefined ? undefined : workloads.get(worker.current);
        const parked = bestParked();
        let target: WorkloadState | undefined;
        if (current === undefined) {
          target = parked;
        } else if (parked !== undefined && parked.pending > current.pending) {
          target = parked;
        } else if (current.pending > 0) {
          target = current;
        }
        if (target === undefined) continue;
        progressed = true;
        if (current !== undefined && current.owner !== target.owner) {
          current.status = 'switching';
          worker.releasing = current.owner;
        }
        target.pending = 0;
        target.status = 'running';
        worker.current = target.owner;
        worker.busy = true;
        scheduleOrchestratedWorker(native.handle, worker.index, target.owner);
      }
      if (remaining > 0 && !progressed) await waitForWake();
    }
    if (fatal !== undefined) throw fatal;
  } finally {
    stopped = true;
    for (const stop of stopDirectReadiness) stop();
    if (poolWakeArmed) hostLoop.removeRead(native.controlFd);
    for (const workload of workloads.values()) {
      if (workload.wakeArmed) hostLoop.removeRead(workload.wakeFd);
    }
    metrics = closeOrchestratedPool(native.handle);
    for (const isolate of isolates) isolate.terminate();
  }
  return {
    values,
    ...metrics,
    schedulerReadinessTurns,
    workerThreads: native.workerThreads,
  };
}

/**
 * Synchronously run readiness-driven isolates through the main-realm
 * TypeScript orchestrator.
 *
 * This convenience wrapper spins the caller's ordinary TypeScript loop around
 * {@link runPooledResidentReadinessWorkloadsAsync}. The async form is preferred
 * when the caller already runs inside an asynchronous command realm.
 *
 * @internal
 */
export function runPooledResidentReadinessWorkloads<T = unknown>(
  entryPath: string,
  inputs: unknown[],
  options: {
    threads?: number;
  } = {},
): PooledResidentRunResult<T> {
  return hostLoop.run(() =>
    runPooledResidentReadinessWorkloadsAsync<T>(entryPath, inputs, options),
  );
}
