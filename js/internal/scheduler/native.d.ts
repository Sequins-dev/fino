/**
 * internal:scheduler-native — irreducible V8/thread/mailbox primitives.
 *
 * TypeScript owns all scheduling and readiness policy. These functions only
 * create and transfer isolates, command worker threads, and carry scalar
 * readiness metadata between realms.
 *
 * @internal
 */
export function createWorkload(entryPath: string): number;
export function terminateWorkload(handle: number): void;
export function workloadWakeFd(handle: number): number;
export function workloadOwner(handle: number): number;
export function createScheduledRealm(
  root: string,
  entryPath: string,
  serializedRules: string,
  watch: boolean,
  realmData: string | undefined,
  bootstrapData: string | undefined,
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

export function createReactorQueue(handles: number[]): {
  handle: number;
  owners: number[];
  controlFd: number;
};
export function createReactorThread(queue: number): {
  handle: number;
  worker: number;
};
export function closeReactorThread(thread: number): void;
export function addReactorWorkload(queue: number, workload: number): number;
export function signalReactorWorkload(queue: number, owner: number): void;
export function signalReactorOwner(owner: number): void;
export function takeReactorEvents(queue: number): Array<{
  kind: 'activated' | 'settled' | 'error';
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
export const registerSharedReadiness: typeof registerProcessReadiness;
export function takeSharedReadinessChanges(): string;
export function routeProcessReadiness(
  owner: number,
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
  notifyPool?: boolean,
): void;
export function routeSharedLoopEvent(owner: number, eventJson: string): void;
export function takeSharedLoopEvents(owner: number): string;

/** Compatibility stubs retained until the backend modules stop importing them. */
export function sharedLoopDescriptor(candidate?: string): string | null;
export function pollSharedReactor(timeoutMs: number | null): boolean;
export function registerSharedPoll(userData: number): number;
export function takeSharedPoll(pollId: number): number | null;
export function cancelSharedPoll(pollId: number): void;
