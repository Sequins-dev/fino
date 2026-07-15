/**
* internal:orchestrator/budget-watchdog — the node's runaway-containment service.
*
* A tenant isolate is pumped synchronously on its scheduler thread, so an
* unbounded synchronous loop in tenant code would pin that thread forever. The
* only thing that can break it is V8 `terminate_execution` fired from *another*
* thread — which is why containment is a system service that runs on the
* orchestrator thread, not on the scheduler thread it is protecting.
*
* The scheduler side is deliberately passive: each budgeted pump arms a deadline
* in a process-global native registry just before entering the isolate and
* clears it just after (cheap, in-process, no cross-thread traffic). This
* service owns the *policy* — how often to check and what to do — entirely in
* TypeScript: on a timer it calls `sweepBudgets()`, which terminates every
* workload whose deadline has elapsed. There is no native watchdog thread; the
* cadence is a normal loop timer on whichever thread starts the service.
*
* Detection granularity is the sweep interval: a runaway is contained within its
* hard budget plus at most one interval. That is exactly the right trade for
* catching infinite loops — precise-to-the-microsecond termination buys nothing.
*
* @internal
*/
import { sweepBudgets } from 'internal:reactor/workload';
import { timeout } from 'internal:runtime/loop';

const DEFAULT_SWEEP_INTERVAL_MS = 20;

/** Options for {@link BudgetWatchdog}. */
export interface BudgetWatchdogOptions {
  /** How often to sweep for overdue pumps, in milliseconds. Defaults to 20. */
  sweepIntervalMs?: number;
}

/**
* The orchestrator-thread service that terminates workloads whose synchronous
* pump slice has overrun its hard budget.
*/
export class BudgetWatchdog {
  #sweepIntervalMs: number;
  #running = false;
  #loop: Promise<void> | null = null;
  #stopPromise: Promise<void> | null = null;
  #stopResolve: (() => void) | null = null;
  #firedTotal = 0;

  constructor(options: BudgetWatchdogOptions = {}) {
    this.#sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  /** Total number of workloads this service has hard-cancelled since starting. */
  get firedTotal(): number {
    return this.#firedTotal;
  }

  /** Whether the sweep loop is currently running. */
  get running(): boolean {
    return this.#running;
  }

  /** Begin sweeping. Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopPromise = new Promise<void>((resolve) => {
      this.#stopResolve = resolve;
    });
    this.#loop = this.#run();
  }

  /**
  * Stop sweeping and wait for the loop to unwind. Runs one final sweep so an
  * overrun that landed in the last interval is still contained.
  */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#stopResolve?.();
    const loop = this.#loop;
    this.#loop = null;
    if (loop !== null) await loop;
  }

  async #run(): Promise<void> {
    const stopPromise = this.#stopPromise ?? Promise.resolve();
    while (this.#running) {
      this.#firedTotal += sweepBudgets();
      // Wake early when stop() fires, otherwise sleep out the interval. Cancel
      // the timer afterwards so a pending sweep never keeps the loop alive.
      const timer = timeout(this.#sweepIntervalMs);
      await Promise.race([timer, stopPromise]);
      timer.cancel();
    }
    // Final sweep to catch an overrun from the last interval before we exit.
    this.#firedTotal += sweepBudgets();
  }
}
