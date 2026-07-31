/**
 * internal:scheduler-native — irreducible V8/thread/mailbox primitives.
 *
 * TypeScript owns all scheduling and readiness policy. These functions only
 * create and transfer isolates, command worker threads, and carry scalar
 * readiness metadata between realms.
 *
 * @internal
 */
export function currentWorkloadOwner(): number;
export function usesProcessReadiness(): boolean;
export function setSchedulerPollingRequired(callback: () => boolean): void;
export function createWorkload(entryPath: string, systemClass?: boolean): number;
export function terminateWorkload(handle: number): void;
export function workloadWakeFd(handle: number): number;
export function workloadOwner(handle: number): number;
export function createScheduledRealm(
  root: string,
  entryPath: string,
  rules: unknown[] | string,
  watch: boolean,
  realmData: unknown,
  bootstrapData: unknown,
  repl: boolean,
  systemClass?: boolean,
): {
  handle: number;
  owner: number;
  wakeFd: number;
  portWakeFd: number;
  completionFd: number;
};
export function scheduledRealmSend(
  handle: number,
  data: Uint8Array,
  stores?: Uint8Array[],
  ports?: [number, number][],
): void;
export function scheduledRealmRecv(handle: number): Array<[Uint8Array[], [number, number][]]>;
export function takeScheduledRealmStatus(handle: number): {
  kind: 'pending' | 'done' | 'reload' | 'error';
  error?: string;
};
export function closeScheduledRealm(handle: number): void;

export function createReactorQueue(install?: boolean): {
  handle: number;
  controlFd: number;
};
export function submitReactorWorkload(queue: number, workload: number): number;
export function markSheddingWorkload(queue: number): number;
export function takeShedWorkload(queue: number, owner: number): number | null;
export function clearSheddingWorkload(queue: number, owner: number): boolean;
export function resubmitShedWorkload(queue: number, shedWorkload: number): number;
export function shedWorkloadConfig(shedWorkload: number): {
  entry: string;
  root: string;
  rules: string;
  watch: boolean;
  repl: boolean;
  data: string | null;
  bootstrapData: string | null;
};
export function dropShedWorkload(shedWorkload: number): void;
export function createReactorThread(queue: number): {
  handle: number;
  worker: number;
};
export function availableParallelism(): number;
export function takeReactorLoadSample(queue: number): Array<{
  owner: number;
  busyMicros: number;
  slices: number;
  loopTurns: number;
  activationDelayMicros: number;
  activations: number;
}>;
export function reactorQueueDepth(queue: number): {
  pendingSpecs: number;
  parkedLive: number;
  active: number;
};
export function isolateHeapStatistics(): {
  totalHeapSize: number;
  usedHeapSize: number;
  heapSizeLimit: number;
  mallocedMemory: number;
  externalMemory: number;
};
export function closeReactorThread(thread: number): void;
export function signalReactorOwner(owner: number): void;
export function takeReactorEvents(queue: number): Array<{
  kind: 'submitted' | 'activated' | 'settled' | 'error';
  worker: number;
  owner: number;
  previous?: number;
  error?: string;
  loopTurns: number;
}>;
export function closeReactorQueue(queue: number): void;

export function processReadinessControlFd(): number;
export function registerProcessReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
): void;
export const registerProcessPersistentReadiness: typeof registerProcessReadiness;
export function acknowledgeProcessReadiness(acknowledgement: number): void;
export function registerReactorWake(owner: number, fd: number): void;
export type ReadinessChangeTuple = [
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
  cancelOwner: number | null,
  schedulerWake: boolean,
  acknowledgement: number | null,
];
export function takeSharedReadinessChanges(): ReadinessChangeTuple[];
export function routeProcessReadiness(owner: number, event: Uint8Array, notifyPool?: boolean): void;
export function takeSharedLoopEvents(owner: number): Uint8Array[];
