/**
* Shared records for the internal scheduler shard.
*
* @internal
*/

export type WorkloadId = string;
export type LeaseId = string;
export type ShardId = string;

export type PriorityClass = 'interactive' | 'service' | 'background';

export type WakeReason =
  | 'message'
  | 'facade_completion'
  | 'timer'
  | 'io'
  | 'backpressure'
  | 'child_event'
  | 'v8_task'
  | 'control';

export type PumpResult = 'idle' | 'runnable' | 'budget_yield' | 'terminated' | 'failed';

/**
* Lifecycle state of a tenant workload in the node isolate collection. The legal
* transitions between these states are enforced by `internal:scheduler/workload`.
*/
export type TenantWorkloadState =
  | 'unclaimed'
  | 'claimed'
  | 'idle'
  | 'runnable'
  | 'running'
  | 'draining'
  | 'handoff_ready'
  | 'failed'
  | 'terminating'
  | 'dead';

/**
* The fine-grained scheduling record for one tenant workload. This is the
* data-only twin of the orchestrator's coarse `Workload`; it carries everything
* a scheduler needs to select, account for, hand off, and recover the workload.
*/
export interface TenantWorkloadRecord {
  tenantId: string;
  workloadId: WorkloadId;
  isolateId: string;
  threadId: ShardId | null;
  leaseEpoch: number;
  state: TenantWorkloadState;
  priority: PriorityClass;
  budget: {
    tickMicros: number;
    debtMicros: number;
    heapBytes: number;
  };
  runnableReasons: TenantWake[];
  lastPumpResult: PumpResult | null;
  counters: {
    recentCpuMicros: number;
    recentWakeCount: number;
    hardBudgetViolations: number;
    mailboxDepth: number;
  };
}

export interface LeaseRecord {
  leaseId: LeaseId;
  workloadId: WorkloadId;
  epoch: number;
  priority: PriorityClass;
  entryPath?: string;
  data?: unknown;
  /** Present when this lease reclaims a handed-off workload; the destination reconstructs from it. */
  handoff?: HandoffSnapshot;
}

/** An inbound message queued for a workload but not yet delivered. */
export interface PendingMessage {
  sequence: number;
  data: unknown;
}

/** A timer a workload has armed but that has not yet fired. */
export interface PendingTimer {
  id: string;
  dueAtNanos: number;
  kind: 'timeout' | 'interval';
  intervalNanos?: number;
}

/** A facade operation the workload had in flight when it was drained. */
export interface PendingFacadeOp {
  id: number;
  provider: string;
  method: string;
  args: unknown;
}

/**
* A data-only capture of a quiesced workload, sufficient to reconstruct it on
* another scheduler thread (or after a thread failure) without migrating the V8
* isolate's memory. It carries the fine-grained record plus the pending work —
* undelivered messages, unfired timers, and in-flight facade operations — that
* must survive the move. Everything here is plain, serializable data: no
* closures, no live handles.
*/
export interface HandoffSnapshot {
  record: TenantWorkloadRecord;
  entryPath?: string;
  data?: unknown;
  mailbox: PendingMessage[];
  timers: PendingTimer[];
  facadeOps: PendingFacadeOp[];
  capturedAtNanos: number;
}

export interface TenantWake {
  workloadId: WorkloadId;
  reason: WakeReason;
  sourceId: string;
  deadlineNanos?: number | null;
  priorityBoost?: number;
  sequence?: number;
}

export interface RunnableWorkload {
  workloadId: WorkloadId;
  priority: PriorityClass;
  wakes: TenantWake[];
  debtMicros: number;
  sequence: number;
}

export interface DispatchRequest {
  workloadId: WorkloadId;
  wake: TenantWake;
  budgetMicros: number;
  debtMicros: number;
}

export interface DispatchResult {
  result: PumpResult;
  costMicros?: number;
}

export interface ShardLoadSummary {
  shardId: ShardId;
  heldLeases: number;
  runnableWorkloads: number;
  dispatches: number;
  debtMicros: number;
}

export interface SchedulerShardConfig {
  shardId: ShardId;
  capacity: number;
  budgetMicros?: number;
  /** Hard per-pump-slice limit (µs) for runaway containment; overruns are terminated. */
  hardBudgetMicros?: number;
  /** Interval (ms) between load-summary reports to the orchestrator. Default 50. */
  loadReportMs?: number;
}

/**
* Control messages the orchestrator pushes to a scheduler thread over its realm
* port (`realm.port.postMessage`). The scheduler receives them as `message`
* events on `globalThis.realmPort` and applies them to its held set — replacing
* the per-tick `pollWakes` RPC. Revocation is immediate (no renewal window), and
* draining is a distinct signal from revoking.
*/
export type SchedulerControlMessage =
  | { control: 'place'; lease: LeaseRecord }
  | { control: 'wake'; wake: TenantWake }
  | { control: 'revoke'; workloadId: WorkloadId; reason: string }
  | { control: 'drain'; workloadId: WorkloadId }
  | { control: 'shutdown' };

/**
* Messages a scheduler thread pushes back to the orchestrator over the same
* channel: terminal releases, periodic load, and (Phase 3) handoff reports.
*/
export type SchedulerReport =
  | { report: 'released'; shardId: ShardId; workloadId: WorkloadId; reason: string }
  | { report: 'drained'; shardId: ShardId; workloadId: WorkloadId; pending: { mailbox: PendingMessage[] } }
  | { report: 'load'; summary: ShardLoadSummary }
  | { report: 'summary'; summary: SchedulerShardSummary };

export interface SchedulerShardSummary {
  shardId: ShardId;
  claimed: number;
  dispatches: number;
  released: number;
  heldLeases: number;
}
