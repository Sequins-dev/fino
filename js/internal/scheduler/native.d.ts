/**
 * internal:scheduler-native — irreducible parked-isolate primitives.
 *
 * The implementation owns V8 isolate lifecycle and swaps per-isolate async
 * state. It also owns the thread-shared poll and scalar readiness routing.
 * Promise resolvers, I/O syscalls, buffers, and retry policy remain in
 * TypeScript.
 *
 * @internal
 */
export function createWorkload(
  entryPath: string,
  delegatesReadiness?: boolean,
  processReadiness?: boolean,
): number;
export function dispatchWorkload(handle: number, requestJson: string): string;
export function driveResidentWorkload(handle: number, input: unknown): unknown;
export function driveSharedResidentWorkloads(handles: number[], inputs: unknown[]): unknown;
/** Create dumb isolate workers controlled by the main TypeScript realm. */
export function createOrchestratedPool(
  handles: number[],
  inputs: unknown[],
  threads?: number,
): {
  handle: number;
  owners: number[];
  workerThreads: number;
  controlFd: number;
};
/** Ask one native worker to pump an owner once, retaining it on quiescence. */
export function scheduleOrchestratedWorker(pool: number, worker: number, owner: number): void;
/** Drain quiescence and settlement signals emitted by native workers. */
export function takeOrchestratedPoolEvents(pool: number): Array<{
  kind: 'ready' | 'quiescent' | 'settled' | 'error';
  worker: number;
  owner: number;
  value?: unknown;
  error?: string;
  loopTurns: number;
}>;
/** Stop native workers and return isolate-transition counters. */
export function closeOrchestratedPool(pool: number): {
  workloadSwitches: number;
  workloadMigrations: number;
  isolateEntries: number;
  isolateExits: number;
  loopTurns: number;
};
/** Read end of the process readiness and worker-event mailbox pipe. */
export function processReadinessControlFd(): number;
export function completeHostOperation(
  handle: number,
  operationId: number,
  ok: boolean,
  resultJson: string,
): void;
export function terminateWorkload(handle: number): void;
/**
 * Read end of the workload isolate's wake pipe. Register it on the scheduler
 * loop (`loop.readable`) so a background completion for this isolate wakes the
 * scheduler to re-pump it. Returns -1 for an invalid handle.
 */
export function workloadWakeFd(handle: number): number;
/** Return the stable task-routing owner id captured for this workload. */
export function workloadOwner(handle: number): number;
/**
 * Return the current thread's shared event-loop descriptor.
 *
 * The first caller may pass a JSON descriptor to install. Later callers receive
 * that original descriptor, allowing isolated module graphs on one thread to
 * attach to the same kernel backend without sharing V8 objects.
 *
 * @internal
 */
export function sharedLoopDescriptor(candidate?: string): string | null;
/** Queue a scalar backend event for its owning isolate. */
export function routeSharedLoopEvent(owner: number, eventJson: string): void;
/** Route one process-reactor readiness completion without serializing it. */
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
/** Drain scalar backend events queued for `owner`. */
export function takeSharedLoopEvents(owner: number): string;
/** Allocate an owner-routable id for one transient shared-backend poll. */
export function registerSharedPoll(userData: number): number;
/** Resolve and remove a completed shared-backend poll's owner token. */
export function takeSharedPoll(pollId: number): number | null;
/** Forget a cancelled shared-backend poll so a late CQE is ignored. */
export function cancelSharedPoll(pollId: number): void;
export function registerSharedReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
): void;
/** Queue a scalar registration for the process TypeScript reactor realm. */
export function registerProcessReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
): void;
/** Drain scalar registrations for the process TypeScript reactor realm. */
export function takeSharedReadinessChanges(): string;
export function pollSharedReactor(timeoutMs: number | null): boolean;
