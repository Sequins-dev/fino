/**
* Host facade contract for scheduler shard realms.
*
* This module is normally supplied as a facade by the parent realm. The stubs
* make accidental direct imports fail clearly.
*
* @internal
*/
import type { DispatchRequest, DispatchResult, LeaseRecord, ShardLoadSummary, ShardId, TenantWake } from './types.ts';

function missing(): never {
  throw new Error('internal:scheduler/host must be provided as a facade');
}

export function claimWorkloads(_shardId: ShardId, _capacity: number): Promise<LeaseRecord[]> {
  return missing();
}

export function pollWakes(_shardId: ShardId, _timeoutMs: number): Promise<TenantWake[]> {
  return missing();
}

export function dispatchWorkload(_leaseId: string, _request: DispatchRequest): Promise<DispatchResult> {
  return missing();
}

export function renewLease(_leaseId: string, _epoch: number): Promise<boolean> {
  return missing();
}

export function releaseLease(_leaseId: string, _reason: string): Promise<void> {
  return missing();
}

export function recordShardLoad(_shardId: ShardId, _summary: ShardLoadSummary): Promise<void> {
  return missing();
}
