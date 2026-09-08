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
export function createWorkload(entryPath: string): {
  owner: number;
  wakeFd: number;
};
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

export function startReactorPool(): number;
export function createReactorThread(): number;
export function closeReactorThread(thread: number): void;
/** Signal an active owner, returning false once that owner has retired. */
export function signalReactorOwner(owner: number): boolean;
/**
 * Read-only snapshot of the reactor pool's scheduling state, or `null` when the
 * process reactor is not running.
 *
 * `parkedWithNothingQueued` is the diagnostic that matters: those realms cannot
 * be claimed by any worker no matter how long it waits.
 */
/** Publish the readiness controller's registration count for diagnostics. */
export function setReadinessHeartbeat(registrations: number): void;
export function reactorPoolStats(): {
  parked: number;
  residents: number;
  ready: number;
  waitingWorkers: number;
  workers: number;
  queuedEvents: number;
  pendingSignals: number;
  parkedWithNothingQueued: number;
  controllerRegistrations: number;
  controllerRouted: number;
  signalsDropped: number;
  framesSent: number;
  framesDrained: number;
  mailboxChanges: number;
  readinessBorrowedFds: number;
  mailboxOwnersWithEvents: number;
  mailboxEvents: number;
} | null;
export function takeReactorEvents(): Array<{
  kind: 'activated' | 'settled' | 'error';
  worker: number;
  owner: number;
  error?: string;
}>;
export function stopReactorPool(): void;

export function processReadinessControlFd(): number;
export function registerProcessReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
): number;
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
  borrowedFd: number | null,
  traceId: number,
];
export function takeSharedReadinessChanges(): ReadinessChangeTuple[];
/** Release a controller-owned descriptor after removing its kernel watch. */
export function releaseSharedReadinessFd(fd: number): void;
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
  traceId?: number,
): void;
export function takeSharedLoopEvents(owner: number): Float64Array;

/** Append one scalar readiness transition to the opt-in process ledger. */
export function recordReadinessTrace(
  operation: number,
  owner: number,
  stage: string,
  ident: number,
  filter: number,
  token: number,
): void;
/** Non-destructive bounded snapshot; FINO_TRACE_READINESS=1 enables collection. */
export function readinessTraceSnapshot(owner?: number): string;

/** Publish the current Realm loop state to the opt-in native diagnostic reader. */
export function recordRealmState(name: string, state: string): void;
