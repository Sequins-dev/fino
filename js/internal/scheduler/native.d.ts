/**
 * internal:scheduler-native — irreducible V8/thread/mailbox primitives.
 *
 * The native main-thread host owns pool lifecycle and I/O readiness. Reactor
 * Realms submit operations with owned buffers and consume native completions.
 * TypeScript retains protocol, provider, and application policy.
 *
 * @internal
 */
export function currentWorkloadOwner(): number;
export function usesProcessReadiness(): boolean;
export function setSchedulerPollingRequired(callback: () => boolean): void;
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

/** Signal an active owner, returning false once that owner has retired. */
export function signalReactorOwner(owner: number): boolean;
/**
 * Admit one native read (numeric capacity) or consuming write (byte view).
 * Admission validates the descriptor and the process budget of 4096 operations
 * and 64 MiB of retained backing storage before synchronously detaching writes.
 * Reads and writes require nonblocking streams or regular files. A unique
 * operation id identifies completion; failures before admission throw.
 */
export function submitOwnedIo(fd: number, data: Uint8Array | number): number;
/** Request cancellation of this Realm's operation. Storage survives until native completion. */
export function cancelOwnedIo(id: number): void;
/** Drain this Realm's operation/result/read-buffer completions without serialization. */
export function takeOwnedIo(): Array<[number, number, Uint8Array?]>;
/**
 * Read-only snapshot of the reactor pool's scheduling state, or `null` when the
 * process reactor is not running.
 *
 * `parkedWithNothingQueued` is the diagnostic that matters: those realms cannot
 * be claimed by any worker no matter how long it waits.
 */
export function reactorPoolStats(): {
  nativeIo: boolean;
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

export function registerProcessReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
): number;
export function registerReactorWake(owner: number, fd: number): void;
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
