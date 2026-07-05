/**
* Metadata-only runnable selection for scheduler shards.
*
* @internal
*/
import type { PriorityClass, RunnableWorkload, TenantWake } from './types.ts';

const PRIORITY_WEIGHT: Record<PriorityClass, number> = {
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

function compareRunnable(a: RunnableWorkload, b: RunnableWorkload): number {
  const priority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (priority !== 0) return priority;

  const aWake = earliestWake(a);
  const bWake = earliestWake(b);
  const aDeadline = aWake?.deadlineNanos ?? Number.POSITIVE_INFINITY;
  const bDeadline = bWake?.deadlineNanos ?? Number.POSITIVE_INFINITY;
  if (aDeadline !== bDeadline) return aDeadline - bDeadline;

  if (a.debtMicros !== b.debtMicros) return a.debtMicros - b.debtMicros;

  const aWakeSequence = aWake?.sequence ?? a.sequence;
  const bWakeSequence = bWake?.sequence ?? b.sequence;
  if (aWakeSequence !== bWakeSequence) return aWakeSequence - bWakeSequence;

  return a.workloadId < b.workloadId ? -1 : a.workloadId > b.workloadId ? 1 : 0;
}

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
