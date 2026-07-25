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
export function createWorkload(entryPath: string, delegatesReadiness?: boolean): number;
export function dispatchWorkload(handle: number, requestJson: string): string;
export function driveResidentWorkload(handle: number, input: unknown): unknown;
export function driveSharedResidentWorkloads(handles: number[], inputs: unknown[]): unknown;
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
/** Drain scalar backend events queued for `owner`. */
export function takeSharedLoopEvents(owner: number): string;
export function registerSharedReadiness(
  ident: number,
  filter: number,
  flags: number,
  fflags: number,
  data: number,
  udata: number,
): void;
export function pollSharedReactor(timeoutMs: number | null): boolean;
