/**
* internal:scheduler/workload — the tenant workload record and its state machine.
*
* A `TenantWorkloadRecord` is the node's coarse ownership record. Runnable and
* running state belongs to the native reactor. Its lifecycle is a small explicit
* state machine; every mutation goes through
* {@link transition}, which rejects illegal jumps so an invalid state can never
* arise silently.
*
* @internal
*/
import type {
  PriorityClass,
  TenantWorkloadRecord,
  TenantWorkloadState,
  WorkloadId
} from './types.ts';

/**
* The legal successor states for each workload state.
*
* A workload is placed, claimed by a reactor, and either fails, is re-placed,
* or terminates. The reactor owns finer-grained execution state.
*/
export const LEGAL_TRANSITIONS: Record<TenantWorkloadState, readonly TenantWorkloadState[]> = {
  unclaimed: ['claimed', 'terminating'],
  claimed: ['failed', 'terminating'],
  failed: ['unclaimed', 'terminating'],
  terminating: ['dead'],
  dead: []
};

/** True when no workload work remains for this state. */
export function isTerminal(state: TenantWorkloadState): boolean {
  return state === 'dead';
}

/** Whether a workload in `from` may legally move to `to`. */
export function canTransition(from: TenantWorkloadState, to: TenantWorkloadState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
* Move `record` to `next`, enforcing the state machine.
*
* Throws (leaving the record unchanged) when the transition is not legal, so
* callers cannot drive a workload into an inconsistent state.
*/
export function transition(record: TenantWorkloadRecord, next: TenantWorkloadState): TenantWorkloadRecord {
  if (!canTransition(record.state, next)) {
    throw new Error(`illegal workload transition: ${record.state} -> ${next}`);
  }
  record.state = next;
  return record;
}

/** Options for {@link createWorkloadRecord}; everything else defaults sensibly. */
export interface CreateWorkloadOptions {
  tenantId: string;
  workloadId: WorkloadId;
  isolateId: string;
  priority?: PriorityClass;
}

/** Build a fresh `unclaimed` workload record. */
export function createWorkloadRecord(options: CreateWorkloadOptions): TenantWorkloadRecord {
  return {
    tenantId: options.tenantId,
    workloadId: options.workloadId,
    isolateId: options.isolateId,
    threadId: null,
    state: 'unclaimed',
    priority: options.priority ?? 'service'
  };
}

/**
* Coarse orchestrator-facing status for a fine-grained scheduler state. Lets the
* orchestrator's `Workload.status` (`running`/`done`/`error`/`terminated`) be
* derived from the single scheduler state machine rather than tracked twice.
*/
export type WorkloadStatus = 'running' | 'done' | 'error' | 'terminated';

export function workloadStatusFor(state: TenantWorkloadState): WorkloadStatus {
  switch (state) {
    case 'failed':
      return 'error';
    case 'terminating':
    case 'dead':
      return 'terminated';
    default:
      return 'running';
  }
}
