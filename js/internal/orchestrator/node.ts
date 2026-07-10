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
* the same {@link transition} state machine, so the orchestrator's coarse view
* and the scheduler's fine view can never disagree about a workload's lifecycle.
*
* Revocation is immediate: the orchestrator pushes a `revoke`/`drain` control
* message to the holding thread rather than waiting out a renewal window. A
* revoked workload is re-placed and reclaimed fresh; state-preserving handoff of
* a *running* isolate is the separate drain/snapshot flow.
*
* @internal
*/
import { captureHandoff, createWorkloadRecord, reconstructRecord, transition, type PendingWork } from '../scheduler/workload.ts';
import { WorkloadAllocator, type ShardClass } from './allocator.ts';
import type {
  HandoffSnapshot,
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
export type ReleaseReason = 'terminated' | 'shutdown' | 'failed' | 'renew_failed' | 'rebalanced';

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
}

interface StoredLease {
  leaseId: LeaseId;
  workloadId: WorkloadId;
  shardId: ShardId;
  priority: PriorityClass;
  entryPath?: string;
  data?: unknown;
}

/**
* The node isolate collection: workload records, leases, and handoff snapshots
* for every tenant workload on one node. Placement — *which* thread hosts a
* workload — and the thread roster/load view live in the {@link WorkloadAllocator}
* this collection delegates to; the collection owns record lifecycle and exposes
* per-thread occupancy back to the allocator.
*/
export class NodeIsolateCollection {
  #workloads = new Map<WorkloadId, TenantWorkloadRecord>();
  #entries = new Map<WorkloadId, { entryPath?: string; data?: unknown }>();
  #placement = new Map<WorkloadId, ShardId>();
  #leases = new Map<LeaseId, StoredLease>();
  #workloadLease = new Map<WorkloadId, LeaseId>();
  #snapshots = new Map<WorkloadId, HandoffSnapshot>();
  #allocator = new WorkloadAllocator({ assignedCount: (shardId) => this.#assignedCount(shardId) });
  #nextWorkload = 0;
  #nextLease = 0;

  /** The deployment `data` payload recorded for a workload, if any. */
  entryDataOf(workloadId: WorkloadId): unknown {
    return this.#entries.get(workloadId)?.data;
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

  /**
  * Remove a scheduler thread from placement consideration (e.g. after it dies).
  * Existing leases are cleaned up separately by {@link recoverShard}; this just
  * stops new work being placed on it.
  */
  unregisterShard(shardId: ShardId): void {
    this.#allocator.unregisterShard(shardId);
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
    this.#workloads.set(workloadId, record);
    this.#entries.set(workloadId, { entryPath: spec.entryPath, data: spec.data });
    const target = this.#choosePlacement(spec);
    this.#placement.set(workloadId, target);
    record.threadId = target;
    return workloadId;
  }

  #choosePlacement(spec: NodeWorkloadSpec): ShardId {
    // Resolve same-tenant colocation to the sibling's current thread; the
    // allocator applies affinity/capacity/class policy and enforces capacity.
    const preferShard = spec.colocateWith !== undefined ? this.#shardOf(spec.colocateWith) : null;
    return this.#allocator.choose({
      ...spec.affinity !== undefined ? { affinity: spec.affinity } : {},
      ...preferShard !== null ? { preferShard } : {},
      shardClass: 'latency'
    });
  }

  #shardOf(workloadId: WorkloadId): ShardId | null {
    const lease = this.#activeLease(workloadId);
    if (lease !== null) return lease.shardId;
    return this.#placement.get(workloadId) ?? null;
  }

  /** Per-thread occupancy: workloads leased to or placed on a thread. The allocator reads this. */
  #assignedCount(shardId: ShardId): number {
    let count = 0;
    for (const lease of this.#leases.values()) if (lease.shardId === shardId) count++;
    for (const placed of this.#placement.values()) if (placed === shardId) count++;
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
    for (const [workloadId, placed] of this.#placement) {
      if (placed !== shardId) continue;
      const record = this.#workloads.get(workloadId);
      if (record?.state === 'unclaimed') candidates.push(workloadId);
    }
    candidates.sort((a, b) => {
      const ra = this.#workloads.get(a)!;
      const rb = this.#workloads.get(b)!;
      const pr = PRIORITY_RANK[ra.priority] - PRIORITY_RANK[rb.priority];
      return pr !== 0 ? pr : a < b ? -1 : a > b ? 1 : 0;
    });

    const leases: LeaseRecord[] = [];
    for (const workloadId of candidates.slice(0, room)) {
      const record = this.#workloads.get(workloadId)!;
      const entry = this.#entries.get(workloadId) ?? {};
      const leaseId = `lease-${this.#nextLease++}`;
      const stored: StoredLease = {
        leaseId,
        workloadId,
        shardId,
        priority: record.priority,
        ...entry.entryPath !== undefined ? { entryPath: entry.entryPath } : {},
        ...entry.data !== undefined ? { data: entry.data } : {}
      };
      this.#leases.set(leaseId, stored);
      this.#workloadLease.set(workloadId, leaseId);
      this.#placement.delete(workloadId);
      record.threadId = shardId;
      transition(record, 'claimed');
      // A reclaimed handed-off workload carries its snapshot so the destination
      // can reconstruct pending work; hand it over exactly once.
      const snapshot = this.#snapshots.get(workloadId);
      this.#snapshots.delete(workloadId);
      leases.push({
        leaseId,
        workloadId,
        priority: record.priority,
        ...stored.entryPath !== undefined ? { entryPath: stored.entryPath } : {},
        ...stored.data !== undefined ? { data: stored.data } : {},
        ...snapshot !== undefined ? { handoff: snapshot } : {}
      });
    }
    return leases;
  }

  #heldCount(shardId: ShardId): number {
    let count = 0;
    for (const lease of this.#leases.values()) if (lease.shardId === shardId) count++;
    return count;
  }

  #activeLease(workloadId: WorkloadId): StoredLease | null {
    const leaseId = this.#workloadLease.get(workloadId);
    if (leaseId === undefined) return null;
    return this.#leases.get(leaseId) ?? null;
  }

  /**
  * Return a workload to the collection. `release` is idempotent and stale-safe:
  * a call for a lease that is no longer the workload's active lease only clears
  * that stale lease. Terminal reasons drive the record to `dead` and drop it;
  * `failed` leaves an observable failed record; `renew_failed`/`rebalanced`
  * re-place the workload on another thread.
  */
  release(leaseId: LeaseId, reason: ReleaseReason): void {
    const lease = this.#leases.get(leaseId);
    if (lease === undefined) return;
    this.#leases.delete(leaseId);
    const { workloadId } = lease;
    if (this.#workloadLease.get(workloadId) !== leaseId) return;
    this.#workloadLease.delete(workloadId);
    const record = this.#workloads.get(workloadId);
    if (record === undefined) return;

    switch (reason) {
      case 'terminated':
      case 'shutdown': {
        if (record.state !== 'terminating' && record.state !== 'dead') transition(record, 'terminating');
        transition(record, 'dead');
        this.#workloads.delete(workloadId);
        this.#entries.delete(workloadId);
        this.#placement.delete(workloadId);
        this.#snapshots.delete(workloadId);
        break;
      }
      case 'failed': {
        if (record.state !== 'failed') transition(record, 'failed');
        // No reconstruction from a failed workload; drop its snapshot.
        this.#snapshots.delete(workloadId);
        break;
      }
      case 'renew_failed':
      case 'rebalanced': {
        if (record.state !== 'failed') transition(record, 'failed');
        transition(record, 'unclaimed');
        const target = this.#allocator.leastLoaded(lease.shardId);
        this.#placement.set(workloadId, target);
        record.threadId = target;
        break;
      }
      default: {
        // Any operator- or caller-supplied reason (`operator`, a custom string)
        // is terminal: drop the record rather than leaving it — without this a
        // custom revoke reason falls through and leaks the record in
        // `#workloads`/`#entries`/`#placement` forever.
        if (record.state !== 'terminating' && record.state !== 'dead') transition(record, 'terminating');
        transition(record, 'dead');
        this.#workloads.delete(workloadId);
        this.#entries.delete(workloadId);
        this.#placement.delete(workloadId);
        this.#snapshots.delete(workloadId);
        break;
      }
    }
  }

  /**
  * Begin draining a workload for handoff. It is walked to `draining` through the
  * state machine; the holding thread — told to drain by the pushed control
  * message — quiesces it and reports a snapshot via {@link completeHandoff}.
  */
  drainForHandoff(workloadId: WorkloadId): void {
    const record = this.#workloads.get(workloadId);
    if (record === undefined) throw new Error(`unknown workload: ${workloadId}`);
    if (record.state === 'claimed') transition(record, 'idle');
    if (record.state === 'idle' || record.state === 'runnable' || record.state === 'running') {
      transition(record, 'draining');
    }
    if (record.state !== 'draining') {
      throw new Error(`cannot drain workload in state ${record.state}: ${workloadId}`);
    }
  }

  /**
  * Record the drained workload's quiesced state as a handoff snapshot and move
  * it to `handoff_ready`. The holding thread supplies the pending work
  * (undelivered messages, unfired timers, in-flight facade ops); the entry and
  * seed data come from the collection. Drops the workload's now-stale lease.
  */
  completeHandoff(workloadId: WorkloadId, pending: PendingWork, capturedAtNanos: number): HandoffSnapshot {
    const record = this.#workloads.get(workloadId);
    if (record === undefined) throw new Error(`unknown workload: ${workloadId}`);
    if (record.state !== 'draining') throw new Error(`workload is not draining: ${workloadId}`);
    const entry = this.#entries.get(workloadId) ?? {};
    const snapshot = captureHandoff(record, {
      ...entry.entryPath !== undefined ? { entryPath: entry.entryPath } : {},
      ...entry.data !== undefined ? { data: entry.data } : {},
      ...pending.mailbox !== undefined ? { mailbox: pending.mailbox } : {},
      ...pending.timers !== undefined ? { timers: pending.timers } : {},
      ...pending.facadeOps !== undefined ? { facadeOps: pending.facadeOps } : {}
    }, capturedAtNanos);
    transition(record, 'handoff_ready');
    this.#snapshots.set(workloadId, snapshot);
    const leaseId = this.#workloadLease.get(workloadId);
    if (leaseId !== undefined) {
      this.#leases.delete(leaseId);
      this.#workloadLease.delete(workloadId);
    }
    return snapshot;
  }

  /**
  * Place a handed-off (or recovered) workload for reclaiming. Moves it from
  * `handoff_ready` back to `unclaimed` on `toShardId` (or the least-loaded
  * thread other than where it was), keeping its snapshot so the next
  * {@link claim} hands it to the destination for reconstruction.
  */
  placeHandoff(workloadId: WorkloadId, toShardId?: ShardId): ShardId {
    const record = this.#workloads.get(workloadId);
    if (record === undefined) throw new Error(`unknown workload: ${workloadId}`);
    if (record.state !== 'handoff_ready') throw new Error(`workload is not handoff_ready: ${workloadId}`);
    transition(record, 'unclaimed');
    const target = toShardId !== undefined && this.#allocator.hasShard(toShardId)
      ? toShardId
      : this.#allocator.leastLoaded(record.threadId);
    this.#placement.set(workloadId, target);
    record.threadId = target;
    return target;
  }

  /**
  * Recover every workload a failed scheduler thread was hosting. Each is rebuilt
  * from its last handoff snapshot if one exists (drained cleanly before the
  * failure), otherwise respawned from its record and entry — pending in-flight
  * work is lost on a hard crash, but the workload comes back. Recovered
  * workloads are re-placed on the surviving threads. Returns their ids.
  */
  recoverShard(shardId: ShardId): WorkloadId[] {
    const victims: WorkloadId[] = [];
    for (const lease of this.#leases.values()) {
      if (lease.shardId === shardId) victims.push(lease.workloadId);
    }
    const recovered: WorkloadId[] = [];
    for (const workloadId of victims) {
      const leaseId = this.#workloadLease.get(workloadId);
      if (leaseId !== undefined) {
        this.#leases.delete(leaseId);
        this.#workloadLease.delete(workloadId);
      }
      const snapshot = this.#snapshots.get(workloadId);
      const record = snapshot !== undefined
        ? reconstructRecord(snapshot)
        : this.#respawnRecord(workloadId);
      if (record === undefined) continue;
      this.#workloads.set(workloadId, record);
      const target = this.#allocator.leastLoaded(shardId);
      this.#placement.set(workloadId, target);
      record.threadId = target;
      recovered.push(workloadId);
    }
    return recovered;
  }

  #respawnRecord(workloadId: WorkloadId): TenantWorkloadRecord | undefined {
    const previous = this.#workloads.get(workloadId);
    if (previous === undefined) return undefined;
    const rebuilt = createWorkloadRecord({
      tenantId: previous.tenantId,
      workloadId,
      isolateId: previous.isolateId,
      priority: previous.priority
    });
    rebuilt.budget.debtMicros = previous.budget.debtMicros;
    return rebuilt;
  }

  /** The stored handoff snapshot for a workload awaiting reclaim, if any. */
  snapshotOf(workloadId: WorkloadId): HandoffSnapshot | undefined {
    return this.#snapshots.get(workloadId);
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
    return this.#workloads.get(workloadId);
  }

  /** The workload's active lease id, if it holds one. */
  leaseOf(workloadId: WorkloadId): LeaseId | null {
    return this.#workloadLease.get(workloadId) ?? null;
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
    for (const lease of this.#leases.values()) if (lease.shardId === shardId) ids.push(lease.workloadId);
    for (const [workloadId, placed] of this.#placement) if (placed === shardId) ids.push(workloadId);
    return ids;
  }
}
