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

/**
* Coarse ownership state maintained by the node collection. Fine-grained
* runnable/running state belongs exclusively to the native reactor engine.
*/
export type TenantWorkloadState =
  | 'unclaimed'
  | 'claimed'
  | 'failed'
  | 'terminating'
  | 'dead';

/**
* Node-owned identity and placement state for one tenant workload.
*/
export interface TenantWorkloadRecord {
  tenantId: string;
  workloadId: WorkloadId;
  isolateId: string;
  threadId: ShardId | null;
  state: TenantWorkloadState;
  priority: PriorityClass;
}

export interface LeaseRecord {
  leaseId: LeaseId;
  workloadId: WorkloadId;
  priority: PriorityClass;
  entryPath?: string;
  data?: unknown;
}

export interface TenantWake {
  workloadId: WorkloadId;
  reason: WakeReason;
  sourceId: string;
  deadlineNanos?: number | null;
  priorityBoost?: number;
  sequence?: number;
}

export interface ShardLoadSummary {
  shardId: ShardId;
  heldLeases: number;
  runnableWorkloads: number;
  dispatches: number;
  debtMicros: number;
}

export interface SchedulerShardSummary {
  shardId: ShardId;
  dispatches: number;
  released: number;
}
