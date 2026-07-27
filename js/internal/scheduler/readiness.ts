/**
 * internal:scheduler/readiness — TypeScript-owned reactor pool.
 *
 * TypeScript constructs each reactor thread independently, owns pool sizing and
 * lifecycle, installs readiness listeners, and reports runnable owners to the
 * shared native queue. A reactor thread mechanically claims the highest
 * priority available owner. It retains its current isolate on ties and exits it
 * only when a strictly higher-priority realm is available.
 *
 * @internal
 */
import * as loop from 'internal:runtime/loop';
import {
  closeReactorQueue,
  closeReactorThread,
  createReactorQueue,
  createReactorThread,
  signalReactorOwner,
  takeReactorEvents,
} from 'internal:scheduler-native';
import { Isolate } from './isolate.ts';
import { currentProcessReadinessController } from './reactor.ts';

/** Completion and transition counters reported by the TypeScript pool. */
export interface PooledResidentRunResult<T = unknown> {
  values: T[];
  workloadSwitches: number;
  workloadMigrations: number;
  schedulerReadinessTurns: number;
  isolateEntries: number;
  isolateExits: number;
  loopTurns: number;
  workerThreads: number;
}

/**
 * Construct a TS-managed reactor pool and run copies of an entry realm.
 *
 * Every thread is created separately through the native reactor-thread
 * primitive, allowing the TS pool to grow or shrink without changing native
 * policy. `inputs` currently determines the number of entry realms; realm data
 * will move through the ordinary scheduler transport.
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
  const readiness = currentProcessReadinessController();
  if (readiness === undefined) {
    throw new Error('the process scheduler must run in the main TypeScript realm');
  }

  const isolates = inputs.map(() => new Isolate(entryPath));
  const isolateInfo = isolates.map((isolate) => ({
    handle: isolate.nativeHandle,
    wakeFd: isolate.wakeFd,
  }));
  const queue = createReactorQueue(isolateInfo.map((isolate) => isolate.handle));
  const requestedThreads = Math.floor(
    options.threads ?? Math.max(1, navigator.hardwareConcurrency || 1),
  );
  const threadCount = Math.max(1, requestedThreads);
  const threads: Array<ReturnType<typeof createReactorThread>> = [];
  const values = new Array<T>(inputs.length);
  const positions = new Map(queue.owners.map((owner, position) => [owner, position]));
  const initialOwners = new Set(queue.owners);
  const lastWorkers = new Map<number, number>();
  const wakeArmed = new Set<number>();
  let stopped = false;
  let remaining = queue.owners.length;
  let workloadSwitches = 0;
  let workloadMigrations = 0;
  let schedulerReadinessTurns = 0;
  let isolateEntries = 0;
  let isolateExits = 0;
  let loopTurns = 0;

  const signal = (owner: number): void => {
    if (!stopped) signalReactorOwner(owner);
  };
  const stopReadiness = queue.owners.map((owner) => readiness.listen(owner, () => signal(owner)));
  const armWorkloadWake = (owner: number): void => {
    if (stopped || wakeArmed.has(owner)) return;
    const position = positions.get(owner);
    if (position === undefined) return;
    wakeArmed.add(owner);
    void loop.readable(isolateInfo[position]!.wakeFd).then(() => {
      wakeArmed.delete(owner);
      if (stopped || !positions.has(owner)) return;
      signal(owner);
      armWorkloadWake(owner);
    });
  };
  for (const owner of queue.owners) armWorkloadWake(owner);
  for (let index = 0; index < threadCount; index++) {
    threads.push(createReactorThread(queue.handle));
  }

  try {
    while (remaining > 0) {
      await loop.readable(queue.controlFd);
      schedulerReadinessTurns++;
      for (const event of takeReactorEvents(queue.handle)) {
        loopTurns += event.loopTurns;
        if (event.kind === 'activated') {
          if (!positions.has(event.owner)) {
            positions.set(event.owner, -1);
            remaining++;
          }
          isolateEntries++;
          if (event.previous !== undefined) {
            workloadSwitches++;
            isolateExits++;
          }
          const previousWorker = lastWorkers.get(event.owner);
          if (previousWorker !== undefined && previousWorker !== event.worker) {
            workloadMigrations++;
          }
          lastWorkers.set(event.owner, event.worker);
          continue;
        }
        const position = positions.get(event.owner);
        if (position === undefined) {
          throw new Error(`reactor returned unknown owner ${event.owner}`);
        }
        positions.delete(event.owner);
        isolateExits++;
        remaining--;
        if (position >= 0) loop.removeRead(isolateInfo[position]!.wakeFd);
        wakeArmed.delete(event.owner);
        if (event.kind === 'error' && initialOwners.has(event.owner)) {
          throw event.error ?? `scheduled realm ${event.owner} failed`;
        }
        if (position >= 0) values[position] = undefined as T;
      }
    }
  } finally {
    stopped = true;
    for (const stop of stopReadiness) stop();
    loop.removeRead(queue.controlFd);
    for (const [owner, position] of positions) {
      if (position >= 0) loop.removeRead(isolateInfo[position]!.wakeFd);
      wakeArmed.delete(owner);
    }
    for (const thread of threads) closeReactorThread(thread.handle);
    closeReactorQueue(queue.handle);
    for (const isolate of isolates) isolate.terminate();
  }

  return {
    values,
    workloadSwitches,
    workloadMigrations,
    schedulerReadinessTurns,
    isolateEntries,
    isolateExits,
    loopTurns,
    workerThreads: threads.length,
  };
}

/** Synchronous adapter for a main realm that is not already awaiting work. */
export function runPooledResidentReadinessWorkloads<T = unknown>(
  entryPath: string,
  inputs: unknown[],
  options: {
    threads?: number;
  } = {},
): PooledResidentRunResult<T> {
  return loop.run(() => runPooledResidentReadinessWorkloadsAsync<T>(entryPath, inputs, options));
}
