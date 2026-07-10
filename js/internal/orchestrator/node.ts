/**
* internal:orchestrator/node — the node isolate collection.
*
* This is the orchestrator's authoritative registry of every tenant workload on
* the node and the leases that bind each workload to a scheduler thread. It
* delegates *placement* — which thread hosts a workload — and the thread
* roster/load view to the {@link WorkloadAllocator}, exposing per-thread
* occupancy back to it; app code never chooses placement, it deploys a workload
* and the allocator places it. Threads report releases and load back, which the
* orchestrator folds in via `release` and `recordLoad`.
*
* The collection is pure main-thread state driven only by the orchestrator loop,
* so there is one writer and no shared mutable state across threads. Records are
* the same `TenantWorkloadRecord`s the scheduler reasons about, driven through
* one coarse ownership state machine; runnable execution state belongs to the
* native reactor and is not duplicated here.
*
* Revocation is immediate: the orchestrator pushes control to the holding
* thread rather than waiting out a renewal window. Planned same-node movement
* keeps the active lease and transfers the live isolate.
*
* @internal
*/
import { createWorkloadRecord, transition } from '../scheduler/workload.ts';
import { WorkloadAllocator, type ShardClass } from './allocator.ts';
import type {
  LeaseId,
  LeaseRecord,
  PriorityClass,
  ShardId,
  ShardLoadSummary,
  TenantWorkloadRecord,
  WorkloadId
} from '../scheduler/types.ts';

export type { ShardClass } from './allocator.ts';

const PRIORITY_RANK: Record<PriorityClass, number> = {
  interactive: 0,
  service: 1,
  background: 2
};

/** How a released lease should be reconciled in the collection. */
export type ReleaseReason = 'terminated' | 'shutdown' | 'failed' | 'renew_failed' | 'rebalanced' | 'revoked';

/**
* Request to place a workload on the node. `tenantId` and `entryPath` are the
* only things app deployment must supply; the placement controls are reserved
* for the orchestrator and core services.
*/
export interface NodeWorkloadSpec {
  tenantId: string;
  workloadId?: WorkloadId;
  isolateId?: string;
  entryPath?: string;
  data?: unknown;
  priority?: PriorityClass;
  /** Hard-pin to a specific scheduler thread (core services only). */
  affinity?: ShardId;
  /** Prefer the thread already hosting this workload (same-tenant colocation). */
  colocateWith?: WorkloadId;
  /** Local live-isolate mobility. Defaults to movable unless affinity is set. */
  localMobility?: 'movable' | 'pinned';
  /** Whether the workload may be independently replicated across isolates. */
  replication?: 'replicated' | 'bound';
}

interface StoredWorkload {
  record: TenantWorkloadRecord;
  entryPath?: string;
  data?: unknown;
  locallyMovable: boolean;
  replication: 'replicated' | 'bound';
  placement: ShardId | null;
  leaseId: LeaseId | null;
}

/**
* The node isolate collection: workload records and leases
* for every tenant workload on one node. Placement — *which* thread hosts a
* workload — and the thread roster/load view live in the {@link WorkloadAllocator}
* this collection delegates to; the collection owns record lifecycle and exposes
* per-thread occupancy back to the allocator.
*/
export class NodeIsolateCollection {
  #workloads = new Map<WorkloadId, StoredWorkload>();
  #leaseOwners = new Map<LeaseId, WorkloadId>();
  #moveReservations = new Map<ShardId, Set<WorkloadId>>();
  #allocator = new WorkloadAllocator({ assignedCount: (shardId) => this.#assignedCount(shardId) });
  #nextWorkload = 0;
  #nextLease = 0;

  /** The deployment `data` payload recorded for a workload, if any. */
  entryDataOf(workloadId: WorkloadId): unknown {
    return this.#workloads.get(workloadId)?.data;
  }

  /** The node's workload allocator (thread roster, load view, placement policy). */
  allocator(): WorkloadAllocator {
    return this.#allocator;
  }

  /** Register a scheduler thread, its capacity, and its class so placement can target it. */
  registerShard(shardId: ShardId, capacity: number, shardClass: ShardClass = 'latency'): void {
    this.#allocator.registerShard(shardId, capacity, shardClass);
  }

  /** The class of a registered thread, or null if unknown. */
  shardClassOf(shardId: ShardId): ShardClass | null {
    return this.#allocator.shardClassOf(shardId);
  }

  /** The least-loaded registered thread of a given class, or null if none. */
  leastLoadedOfClass(shardClass: ShardClass, exclude?: ShardId): ShardId | null {
    return this.#allocator.leastLoadedOfClass(shardClass, exclude);
  }

  /** Least-loaded registered thread other than `exclude`. */
  leastLoaded(exclude?: ShardId): ShardId {
    return this.#allocator.leastLoaded(exclude ?? null);
  }

  /**
  * Remove a scheduler thread from placement consideration (e.g. after it dies).
  * Existing leases are cleaned up separately by {@link recoverShard}; this just
  * stops new work being placed on it.
  */
  unregisterShard(shardId: ShardId): void {
    this.#allocator.unregisterShard(shardId);
    this.#moveReservations.delete(shardId);
  }

  /** Every registered scheduler thread. */
  shards(): ShardId[] {
    return this.#allocator.shards();
  }

  /**
  * Admit a workload to the node and place it on a scheduler thread. Returns the
  * workload id; the workload stays `unclaimed` until its target thread claims
  * it. Throws if no scheduler thread is registered to host it.
  */
  deploy(spec: NodeWorkloadSpec): WorkloadId {
    if (this.#allocator.shards().length === 0) throw new Error('cannot deploy: no scheduler threads registered');
    const workloadId = spec.workloadId ?? `wl-${this.#nextWorkload++}`;
    if (this.#workloads.has(workloadId)) throw new Error(`workload already deployed: ${workloadId}`);
    const isolateId = spec.isolateId ?? `iso-${workloadId}`;
    const record = createWorkloadRecord({
      tenantId: spec.tenantId,
      workloadId,
      isolateId,
      ...spec.priority !== undefined ? { priority: spec.priority } : {}
    });
    const target = this.#choosePlacement(spec);
    this.#workloads.set(workloadId, {
      record,
      ...spec.entryPath !== undefined ? { entryPath: spec.entryPath } : {},
      ...spec.data !== undefined ? { data: spec.data } : {},
      locallyMovable: spec.localMobility !== 'pinned' && spec.affinity === undefined,
      replication: spec.replication ?? 'replicated',
      placement: target,
      leaseId: null
    });
    record.threadId = target;
    return workloadId;
  }

  #choosePlacement(spec: NodeWorkloadSpec): ShardId {
    // Resolve same-tenant colocation to the sibling's current thread; the
    // allocator applies affinity/capacity/class policy and enforces capacity.
    const preferShard = spec.colocateWith !== undefined ? this.#shardOf(spec.colocateWith) : null;
    if (spec.replication === 'bound' && spec.affinity === undefined) {
      const batch = this.#allocator.leastLoadedOfClass('batch');
      if (batch === null) throw new Error('cannot place bound workload: no batch reactor capacity');
      return batch;
    }
    return this.#allocator.choose({
      ...spec.affinity !== undefined ? { affinity: spec.affinity } : {},
      ...preferShard !== null ? { preferShard } : {},
      shardClass: 'latency'
    });
  }

  #shardOf(workloadId: WorkloadId): ShardId | null {
    return this.#workloads.get(workloadId)?.placement ?? null;
  }

  /** Per-thread occupancy: workloads leased to or placed on a thread. The allocator reads this. */
  #assignedCount(shardId: ShardId): number {
    let count = 0;
    for (const workload of this.#workloads.values()) if (workload.placement === shardId) count++;
    return count;
  }

  /**
  * Hand a scheduler thread the workloads the allocator has placed on it (up to
  * `capacity`), turning each placement into a lease and moving the record
  * `unclaimed -> claimed`. Respects both the caller's requested `capacity` and
  * the thread's registered capacity.
  */
  claim(shardId: ShardId, capacity: number): LeaseRecord[] {
    if (!this.#allocator.hasShard(shardId)) return [];
    const held = this.#heldCount(shardId);
    const room = Math.max(0, Math.min(Math.floor(capacity), this.#allocator.capacityOf(shardId)) - held);
    if (room === 0) return [];

    const candidates: WorkloadId[] = [];
    for (const [workloadId, workload] of this.#workloads) {
      if (workload.placement === shardId && workload.leaseId === null && workload.record.state === 'unclaimed') {
        candidates.push(workloadId);
      }
    }
    candidates.sort((a, b) => {
      const ra = this.#workloads.get(a)!.record;
      const rb = this.#workloads.get(b)!.record;
      const pr = PRIORITY_RANK[ra.priority] - PRIORITY_RANK[rb.priority];
      return pr !== 0 ? pr : a < b ? -1 : a > b ? 1 : 0;
    });

    const leases: LeaseRecord[] = [];
    for (const workloadId of candidates.slice(0, room)) {
      const workload = this.#workloads.get(workloadId)!;
      const record = workload.record;
      const leaseId = `lease-${this.#nextLease++}`;
      workload.leaseId = leaseId;
      this.#leaseOwners.set(leaseId, workloadId);
      record.threadId = shardId;
      transition(record, 'claimed');
      leases.push({
        leaseId,
        workloadId,
        priority: record.priority,
        ...workload.entryPath !== undefined ? { entryPath: workload.entryPath } : {},
        ...workload.data !== undefined ? { data: workload.data } : {}
      });
    }
    return leases;
  }

  #heldCount(shardId: ShardId): number {
    let count = 0;
    for (const workload of this.#workloads.values()) {
      if (workload.placement === shardId && workload.leaseId !== null) count++;
    }
    return count;
  }

  /**
  * Commit a live isolate move after the destination reactor has attached it.
  * Record state and lease identity remain unchanged; only the lease's owning
  * shard changes. Capacity is checked at commit time.
  */
  moveLiveLease(workloadId: WorkloadId, toShardId: ShardId): { fromShardId: ShardId; toShardId: ShardId } {
    if (!this.#allocator.hasShard(toShardId)) throw new Error(`unknown destination thread: ${toShardId}`);
    const workload = this.#workloads.get(workloadId);
    if (workload === undefined || workload.leaseId === null) throw new Error(`workload has no active lease: ${workloadId}`);
    const fromShardId = workload.placement;
    if (fromShardId === null) throw new Error(`workload has no active placement: ${workloadId}`);
    if (fromShardId === toShardId) return { fromShardId, toShardId };
    const reserved = this.#moveReservations.get(toShardId)?.has(workloadId) === true;
    if (!reserved && !this.#allocator.hasRoom(toShardId)) throw new Error(`destination thread at capacity: ${toShardId}`);
    workload.placement = toShardId;
    this.releaseLiveMoveReservation(workloadId, toShardId);
    workload.record.threadId = toShardId;
    return { fromShardId, toShardId };
  }

  /** Atomically reserve one destination slot before a native isolate detaches. */
  reserveLiveMove(workloadId: WorkloadId, toShardId: ShardId): boolean {
    if (!this.#allocator.hasShard(toShardId)) return false;
    let reservations = this.#moveReservations.get(toShardId);
    if (reservations === undefined) {
      reservations = new Set();
      this.#moveReservations.set(toShardId, reservations);
    }
    if (reservations.has(workloadId)) return true;
    const used = this.#assignedCount(toShardId) + reservations.size;
    if (used >= this.#allocator.capacityOf(toShardId)) return false;
    reservations.add(workloadId);
    return true;
  }

  /** Release a destination reservation after commit, rollback, or cancellation. */
  releaseLiveMoveReservation(workloadId: WorkloadId, toShardId: ShardId): void {
    const reservations = this.#moveReservations.get(toShardId);
    if (reservations === undefined) return;
    reservations.delete(workloadId);
    if (reservations.size === 0) this.#moveReservations.delete(toShardId);
  }

  /** Whether a shard currently has capacity reserved by an in-flight move. */
  hasLiveMoveReservations(shardId: ShardId): boolean {
    return (this.#moveReservations.get(shardId)?.size ?? 0) > 0;
  }

  /**
  * Return a workload to the collection. `release` is idempotent and stale-safe:
  * a call for a lease that is no longer the workload's active lease only clears
  * that stale lease. Terminal reasons drive the record to `dead` and drop it;
  * `failed` leaves an observable failed record; `renew_failed`/`rebalanced`
  * re-place the workload on another thread.
  */
  release(leaseId: LeaseId, reason: ReleaseReason): void {
    const workloadId = this.#leaseOwners.get(leaseId);
    if (workloadId === undefined) return;
    this.#leaseOwners.delete(leaseId);
    const workload = this.#workloads.get(workloadId);
    if (workload === undefined || workload.leaseId !== leaseId) return;
    workload.leaseId = null;
    const record = workload.record;

    switch (reason) {
      case 'terminated':
      case 'shutdown': {
        if (record.state !== 'terminating' && record.state !== 'dead') transition(record, 'terminating');
        transition(record, 'dead');
        this.#workloads.delete(workloadId);
        break;
      }
      case 'failed': {
        if (record.state !== 'failed') transition(record, 'failed');
        workload.placement = null;
        record.threadId = null;
        break;
      }
      case 'renew_failed':
      case 'rebalanced': {
        if (record.state !== 'failed') transition(record, 'failed');
        transition(record, 'unclaimed');
        const target = this.#allocator.leastLoaded(workload.placement);
        workload.placement = target;
        record.threadId = target;
        break;
      }
      default: {
        // Any operator- or caller-supplied reason (`operator`, a custom string)
        // is terminal: drop the record rather than leaving it — without this a
        // custom revoke reason falls through and leaks its workload record.
        if (record.state !== 'terminating' && record.state !== 'dead') transition(record, 'terminating');
        transition(record, 'dead');
        this.#workloads.delete(workloadId);
        break;
      }
    }
  }

  /**
  * Recover every workload a failed scheduler thread was hosting. Each is rebuilt
  * fresh from its record and entry. Pending in-flight work is lost on a hard
  * crash, but the workload comes back. Recovered
  * workloads are re-placed on the surviving threads. Returns their ids.
  */
  recoverShard(shardId: ShardId): WorkloadId[] {
    const victims: WorkloadId[] = [];
    for (const [workloadId, workload] of this.#workloads) {
      if (workload.placement === shardId && workload.leaseId !== null) victims.push(workloadId);
    }
    const recovered: WorkloadId[] = [];
    for (const workloadId of victims) {
      const workload = this.#workloads.get(workloadId);
      if (workload?.leaseId !== null && workload?.leaseId !== undefined) {
        this.#leaseOwners.delete(workload.leaseId);
        workload.leaseId = null;
      }
      const record = this.#respawnRecord(workloadId);
      if (record === undefined) continue;
      workload!.record = record;
      const target = this.#allocator.leastLoaded(shardId);
      workload!.placement = target;
      record.threadId = target;
      recovered.push(workloadId);
    }
    return recovered;
  }

  #respawnRecord(workloadId: WorkloadId): TenantWorkloadRecord | undefined {
    const previous = this.#workloads.get(workloadId)?.record;
    if (previous === undefined) return undefined;
    const rebuilt = createWorkloadRecord({
      tenantId: previous.tenantId,
      workloadId,
      isolateId: previous.isolateId,
      priority: previous.priority
    });
    return rebuilt;
  }

  /** Record a thread's latest load summary for the allocator's placement decisions. */
  recordLoad(shardId: ShardId, summary: ShardLoadSummary): void {
    this.#allocator.recordLoad(shardId, summary);
  }

  /** The thread currently hosting (or placed to host) a workload, if any. */
  placementOf(workloadId: WorkloadId): ShardId | null {
    return this.#shardOf(workloadId);
  }

  /** The workload's record, if it is still in the collection. */
  record(workloadId: WorkloadId): TenantWorkloadRecord | undefined {
    return this.#workloads.get(workloadId)?.record;
  }

  /** Whether policy or an operator may move this isolate to another local reactor. */
  isLocallyMovable(workloadId: WorkloadId): boolean {
    return this.#workloads.get(workloadId)?.locallyMovable === true;
  }

  /** Whether a workload may split into independent isolates or is state-bound. */
  replicationOf(workloadId: WorkloadId): 'replicated' | 'bound' | null {
    return this.#workloads.get(workloadId)?.replication ?? null;
  }

  /** The workload's active lease id, if it holds one. */
  leaseOf(workloadId: WorkloadId): LeaseId | null {
    return this.#workloads.get(workloadId)?.leaseId ?? null;
  }

  /** Last reported load for a thread. */
  loadOf(shardId: ShardId): ShardLoadSummary | undefined {
    return this.#allocator.loadOf(shardId);
  }

  /** Number of live leases a thread is holding. */
  heldBy(shardId: ShardId): number {
    return this.#heldCount(shardId);
  }

  /** Every workload id currently placed on or leased to a thread. */
  workloadsOn(shardId: ShardId): WorkloadId[] {
    const ids: WorkloadId[] = [];
    for (const [workloadId, workload] of this.#workloads) {
      if (workload.placement === shardId) ids.push(workloadId);
    }
    return ids;
  }
}
