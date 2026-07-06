export function createWorkload(entryPath: string, heapLimitBytes?: number): number;
export function dispatchWorkload(handle: number, requestJson: string, hardBudgetMicros?: number): Uint8Array;
export function completeHostOperation(handle: number, operationId: number, ok: boolean, payload: Uint8Array): void;
export function terminateWorkload(handle: number): void;
/**
 * Read end of the workload isolate's wake pipe. Register it on the scheduler
 * loop (`loop.readable`) so a background completion for this isolate wakes the
 * scheduler to re-pump it. Returns -1 for an invalid handle.
 */
export function workloadWakeFd(handle: number): number;
/**
 * Terminate the execution of every scheduled workload whose armed pump deadline
 * has elapsed, returning how many were terminated. Driven by the orchestrator's
 * budget-watchdog service; safe to call from a thread other than the one the
 * workload is pumping on, which is exactly how a synchronous runaway is broken.
 */
export function sweepBudgets(): number;
