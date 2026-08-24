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
/**
 * Create a workload spec without queueing it, returning its handle.
 *
 * Creation and submission are separate calls: until `submitReactorWorkload`
 * runs, no reactor can claim the spec, so a caller can read its owner and wake
 * descriptor and arm listeners on them with no race. `system` places it in the
 * system scheduling class, which outranks every app realm and is never a shed
 * candidate.
 */
export function createWorkload(entryPath: string, system?: boolean): number;
/** The owner id an unsubmitted workload will run under. */
export function workloadOwner(workload: number): number;
/** The descriptor that becomes readable when an unsubmitted workload has host work. */
export function workloadWakeFd(workload: number): number;
/** Discard a workload that was created but never submitted. */
export function terminateWorkload(workload: number): void;
export function createScheduledRealm(
  root: string,
  entryPath: string,
  rules: unknown[] | string,
  watch: boolean,
  realmData: unknown,
  bootstrapData: unknown,
  repl: boolean,
): {
  handle: number;
  owner: number;
  wakeFd: number;
  portWakeFd: number;
  completionFd: number;
};
export function scheduledRealmSend(
  handle: number,
  header: Uint8Array,
  data: Uint8Array,
  stores?: Uint8Array[],
  ports?: [number, number][],
): void;
export function scheduledRealmRecv(
  handle: number,
): Array<[Uint8Array[], [number, number][], Uint8Array?]>;
export function takeScheduledRealmStatus(handle: number): {
  kind: 'pending' | 'done' | 'reload' | 'error';
  error?: string;
};
export function closeScheduledRealm(handle: number): void;
export function forceScheduledRealm(handle: number): boolean;

/** Watchdog thresholds for one queue; each falls back to its `FINO_WATCHDOG_*` variable. */
export interface WatchdogTuning {
  intervalMs?: number;
  stallMs?: number;
  sustainedMs?: number;
}

/**
 * A reactor queue. `null` or `undefined` in place of one names the installed
 * process pool, which is how realms other than the one that created it — the
 * system realm in particular — reach it. Queue handles are thread-locals and do
 * not travel between realms.
 */
export type QueueRef = number | null | undefined;

/** Start the process pool and return the descriptor its events arrive on. */
export function startReactorPool(tuning?: WatchdogTuning): number;
/**
 * Create a reactor queue. `install` (default true) registers it as the process
 * pool; standalone queues exist for tests and tooling.
 */
export function createReactorQueue(
  install?: boolean,
  tuning?: WatchdogTuning,
): { handle: number; controlFd: number };
/** Move a created spec onto a queue, returning the owner it will run under. */
export function submitReactorWorkload(queue: QueueRef, workload: number): number;
export function createReactorThread(queue?: QueueRef): { handle: number; worker: number };
export function closeReactorThread(thread: number): void;
export function signalReactorOwner(owner: number): void;
export function takeReactorEvents(queue?: QueueRef): Array<{
  /**
   * `submitted` and `activated` announce an owner; `settled`, `error` and
   * `shed` retire it. `overrun` and `halted` are watchdog escalations against a
   * slice — the workload still reports its own terminal event afterwards.
   */
  kind: 'submitted' | 'activated' | 'settled' | 'error' | 'shed' | 'overrun' | 'halted';
  worker: number;
  owner: number;
  error?: string;
}>;
export function closeReactorQueue(queue: number): void;
export function stopReactorPool(): void;

/**
 * Nominate the cheapest pre-init app spec on a queue for transfer, returning
 * its owner or 0 when nothing is eligible.
 *
 * A mark is a claim, not a removal: a local reactor may still claim the spec
 * first, and `takeShedWorkload` fails if one did. Only pre-init specs are
 * eligible — a live isolate is pinned to this node.
 */
export function markSheddingWorkload(queue: QueueRef): number;
/** Commit a mark, moving the spec into the shed table. Null if a reactor won the race. */
export function takeShedWorkload(queue: QueueRef, owner: number): number | null;
/** Release a mark without transferring. */
export function clearSheddingWorkload(queue: QueueRef, owner: number): boolean;
/** Return a shed spec to a queue after a refused offer, keeping its position. */
export function resubmitShedWorkload(queue: QueueRef, shed: number): number;
/** Everything a destination node needs to reconstruct an equivalent workload. */
export function shedWorkloadConfig(shed: number): {
  entry: string;
  root: string;
  /** `ImportRule[]` JSON, the same shape `createScheduledRealm` accepts. */
  rules: string;
  watch: boolean;
  repl: boolean;
  data: string | null;
  bootstrapData: string | null;
};
/** The descriptor that fires when the local parent sends to a shed workload. */
export function shedWorkloadWakeFd(shed: number): number;
/** Drain what the parent has sent, for forwarding to the workload's new host. */
export function shedRecvFromParent(
  shed: number,
): Array<[Uint8Array[], [number, number][], Uint8Array?]>;
/** Deliver a message from the new host back to the local parent. */
export function shedSendToParent(
  shed: number,
  data: Uint8Array,
  stores?: Uint8Array[],
  header?: Uint8Array,
): void;
/** Settle the parent's completion await for a workload that finished elsewhere. */
export function shedComplete(shed: number, error?: string): void;
/** Discard a shed spec whose transfer succeeded. */
export function dropShedWorkload(shed: number): void;

/** Processors this process may run on. fino defines no `navigator.hardwareConcurrency`. */
export function availableParallelism(): number;
/** Drain per-workload load counters accumulated since the previous call. */
export function takeReactorLoadSample(queue?: QueueRef): Array<{
  owner: number;
  busyMicros: number;
  slices: number;
  loopTurns: number;
  activationDelayMicros: number;
  activations: number;
}>;
/** Point-in-time queue pressure. */
export function reactorQueueDepth(queue?: QueueRef): {
  pendingSpecs: number;
  parkedLive: number;
  active: number;
};
/** Heap statistics for the calling isolate, so every realm can self-report. */
export function isolateHeapStatistics(): {
  totalHeapSize: number;
  usedHeapSize: number;
  heapSizeLimit: number;
  mallocedMemory: number;
  externalMemory: number;
};

export function processReadinessControlFd(): number;
export function registerProcessReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
): void;
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
  schedulerPoll: boolean,
];
export function takeSharedReadinessChanges(): ReadinessChangeTuple[];
export function routeProcessReadiness(
  owner: number,
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
  installed: number,
  notifyPool?: boolean,
): void;
export function takeSharedLoopEvents(owner: number): Float64Array;
