/**
* internal:scheduler/workload — the tenant workload record and its state machine.
*
* A `TenantWorkloadRecord` is pure data, so it can be simulated, inspected,
* handed off between scheduler threads, and reconstructed after failure. Its
* lifecycle is a small explicit state machine; every mutation goes through
* {@link transition}, which rejects illegal jumps so an invalid state can never
* arise silently.
*
* @internal
*/
import type {
  HandoffSnapshot,
  PendingFacadeOp,
  PendingMessage,
  PendingTimer,
  PriorityClass,
  TenantWake,
  TenantWorkloadRecord,
  TenantWorkloadState,
  WorkloadId
} from './types.ts';

/**
* The legal successor states for each workload state.
*
* Follows the lifecycle in `realm-loop-orchestration.md` §6: a workload is
* claimed from the collection, becomes idle, runs, and either yields back to
* idle/runnable, drains for handoff, fails, or is torn down. `dead` is terminal.
*/
export const LEGAL_TRANSITIONS: Record<TenantWorkloadState, readonly TenantWorkloadState[]> = {
  unclaimed: ['claimed', 'terminating'],
  claimed: ['idle', 'failed', 'terminating'],
  idle: ['runnable', 'draining', 'failed', 'terminating'],
  runnable: ['running', 'idle', 'draining', 'failed', 'terminating'],
  running: ['idle', 'runnable', 'draining', 'failed', 'terminating'],
  draining: ['handoff_ready', 'failed', 'terminating'],
  handoff_ready: ['unclaimed', 'claimed', 'terminating'],
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
  tickMicros?: number;
}

/** Build a fresh `unclaimed` workload record. */
export function createWorkloadRecord(options: CreateWorkloadOptions): TenantWorkloadRecord {
  return {
    tenantId: options.tenantId,
    workloadId: options.workloadId,
    isolateId: options.isolateId,
    threadId: null,
    leaseEpoch: 0,
    state: 'unclaimed',
    priority: options.priority ?? 'service',
    budget: {
      tickMicros: options.tickMicros ?? 1_000,
      debtMicros: 0,
      heapBytes: 0
    },
    runnableReasons: [],
    lastPumpResult: null,
    counters: {
      recentCpuMicros: 0,
      recentWakeCount: 0,
      hardBudgetViolations: 0,
      mailboxDepth: 0
    }
  };
}

/** Record a wake against a workload, bumping its counters. */
export function noteWake(record: TenantWorkloadRecord, wake: TenantWake): void {
  record.runnableReasons.push(wake);
  record.counters.recentWakeCount++;
}

/** The pending work a drained workload carries into a handoff. */
export interface PendingWork {
  entryPath?: string;
  data?: unknown;
  mailbox?: PendingMessage[];
  timers?: PendingTimer[];
  facadeOps?: PendingFacadeOp[];
}

/**
* Capture a quiesced workload as a data-only {@link HandoffSnapshot}. The record
* is deep-copied so later mutation of the live record cannot corrupt an in-flight
* handoff. `capturedAtNanos` is supplied by the caller so this stays a pure
* function (no clock coupling) and is deterministic in tests.
*/
export function captureHandoff(
  record: TenantWorkloadRecord,
  pending: PendingWork,
  capturedAtNanos: number
): HandoffSnapshot {
  return {
    record: cloneRecord(record),
    ...pending.entryPath !== undefined ? { entryPath: pending.entryPath } : {},
    ...pending.data !== undefined ? { data: pending.data } : {},
    mailbox: (pending.mailbox ?? []).slice(),
    timers: (pending.timers ?? []).slice(),
    facadeOps: (pending.facadeOps ?? []).slice(),
    capturedAtNanos
  };
}

/**
* Rebuild an `unclaimed` record from a handoff snapshot, ready to be re-placed
* and reclaimed on another thread. Identity, priority, accumulated budget debt,
* and counters carry over; the thread binding and lease epoch are reset because
* the destination assigns a fresh lease.
*/
export function reconstructRecord(snapshot: HandoffSnapshot): TenantWorkloadRecord {
  const rebuilt = cloneRecord(snapshot.record);
  rebuilt.threadId = null;
  rebuilt.leaseEpoch = 0;
  rebuilt.state = 'unclaimed';
  rebuilt.runnableReasons = [];
  rebuilt.lastPumpResult = null;
  rebuilt.counters.mailboxDepth = snapshot.mailbox.length;
  return rebuilt;
}

function cloneRecord(record: TenantWorkloadRecord): TenantWorkloadRecord {
  return {
    ...record,
    budget: { ...record.budget },
    runnableReasons: record.runnableReasons.slice(),
    counters: { ...record.counters }
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
