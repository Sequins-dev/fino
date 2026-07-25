/**
* internal:scheduler-native — irreducible parked-isolate primitives.
*
* The implementation owns V8 isolate lifecycle and swaps per-isolate async
* state. Scheduling policy, readiness registration, I/O syscalls, and buffers
* remain in TypeScript.
*
* @internal
*/
export function createWorkload(entryPath: string): number;
export function dispatchWorkload(handle: number, requestJson: string): string;
export function completeHostOperation(handle: number, operationId: number, ok: boolean, resultJson: string): void;
export function terminateWorkload(handle: number): void;
/**
* Read end of the workload isolate's wake pipe. Register it on the scheduler
* loop (`loop.readable`) so a background completion for this isolate wakes the
* scheduler to re-pump it. Returns -1 for an invalid handle.
*/
export function workloadWakeFd(handle: number): number;
