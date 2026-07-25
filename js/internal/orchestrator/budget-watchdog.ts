/**
* internal:orchestrator/budget-watchdog — the node's runaway-containment service.
*
* A realm isolate is pumped synchronously on its reactor thread, so an
* unbounded synchronous loop in realm code would pin that thread forever. The
* only thing that can break it is V8 `terminate_execution` fired from *another*
* thread — which is why containment is a system service that runs on the
* orchestrator thread, not on the reactor thread it is protecting.
*
* The reactor side is deliberately passive: each budgeted pump arms a deadline
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

/**
* Start the orchestrator-thread service that terminates workloads whose
* synchronous pump slice has overrun its hard budget.
*
* The timer is unreferenced: live Realm ports keep the root alive while work is
* active, and the node's shutdown hook stops the service during normal teardown.
*/
export function startBudgetWatchdog(sweepIntervalMs = 20): () => void {
  let stopped = false;
  let timer: ReturnType<typeof timeout> | null = null;
  const sweep = () => {
    if (stopped) return;
    sweepBudgets();
    timer = timeout(sweepIntervalMs).unref();
    void timer.then(sweep);
  };
  sweep();
  return () => {
    if (stopped) return;
    stopped = true;
    timer?.cancel();
    timer = null;
    sweepBudgets();
  };
}
