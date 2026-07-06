/**
* Metadata-only runnable selection for scheduler shards.
*
* @internal
*/
import type { PriorityClass, RunnableWorkload, TenantWake } from './types.ts';

/** Priority-class ordering weight: lower runs first. The single source of truth. */
export const PRIORITY_WEIGHT: Record<PriorityClass, number> = {
  interactive: 0,
  service: 1,
  background: 2
};

function earliestWake(workload: RunnableWorkload): TenantWake | undefined {
  let best: TenantWake | undefined;
  for (const wake of workload.wakes) {
    if (best === undefined) {
      best = wake;
      continue;
    }
    const bestDeadline = best.deadlineNanos ?? Number.POSITIVE_INFINITY;
    const wakeDeadline = wake.deadlineNanos ?? Number.POSITIVE_INFINITY;
    if (wakeDeadline < bestDeadline) {
      best = wake;
      continue;
    }
    if (wakeDeadline === bestDeadline && (wake.sequence ?? 0) < (best.sequence ?? 0)) {
      best = wake;
    }
  }
  return best;
}

/**
* Total order over runnable workloads: priority class first, then accumulated
* budget debt (so a workload that has hogged CPU yields to a lighter one), then
* age (`sequence`), then id for determinism. This is the single ranking the
* runtime uses; wake *deadlines* order which wake to service within a workload
* (see {@link firstWake}), not which workload to run.
*/
export function compareRunnable(a: RunnableWorkload, b: RunnableWorkload): number {
  const priority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (priority !== 0) return priority;
  if (a.debtMicros !== b.debtMicros) return a.debtMicros - b.debtMicros;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.workloadId < b.workloadId ? -1 : a.workloadId > b.workloadId ? 1 : 0;
}

/**
* The highest-priority workload among `workloads`, or null if none. Unlike
* {@link selectNextWorkload} this does not require a queued wake, so the shard
* can also pick a mid-activation workload it must resume (which carries no wake).
*/
export function pickRunnable(workloads: readonly RunnableWorkload[]): RunnableWorkload | null {
  let best: RunnableWorkload | null = null;
  for (const workload of workloads) {
    if (best === null || compareRunnable(workload, best) < 0) best = workload;
  }
  return best;
}

/** Like {@link pickRunnable} but only among workloads that actually have a queued wake. */
export function selectNextWorkload(workloads: readonly RunnableWorkload[]): RunnableWorkload | null {
  let best: RunnableWorkload | null = null;
  for (const workload of workloads) {
    if (workload.wakes.length === 0) continue;
    if (best === null || compareRunnable(workload, best) < 0) best = workload;
  }
  return best;
}

export function coalesceWake(existing: TenantWake[], wake: TenantWake): TenantWake[] {
  const next = existing.slice();
  const index = next.findIndex((item) => item.reason === wake.reason && item.sourceId === wake.sourceId);
  if (index === -1) {
    next.push(wake);
  } else {
    next[index] = {
      ...next[index],
      ...wake,
      sequence: next[index]?.sequence ?? wake.sequence
    };
  }
  return next;
}

export function firstWake(workload: RunnableWorkload): TenantWake | null {
  return earliestWake(workload) ?? null;
}

/**
* Remove the specific wake that was dispatched, matched by `reason`+`sourceId`
* (the same identity `coalesceWake` dedups on). The dispatched wake is the
* earliest-deadline one `firstWake` selects, which is not necessarily `wakes[0]`
* — so consuming it by identity avoids silently dropping an out-of-order wake
* and re-running the one that was serviced.
*/
export function removeWake(wakes: TenantWake[], dispatched: TenantWake | null): TenantWake[] {
  if (dispatched === null) return wakes;
  const index = wakes.findIndex((wake) => wake.reason === dispatched.reason && wake.sourceId === dispatched.sourceId);
  if (index === -1) return wakes;
  const next = wakes.slice();
  next.splice(index, 1);
  return next;
}
