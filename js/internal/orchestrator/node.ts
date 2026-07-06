/**
* internal:orchestrator/node — the node isolate collection.
*
* This is the orchestrator's authoritative registry of every tenant workload on
* the node, the leases that bind each workload to a scheduler thread, and the
* load each thread is carrying. The orchestrator claims workloads from it and
* pushes them to their scheduler threads; threads report releases and load back,
* which the orchestrator folds in here via `release` and `recordLoad`. Placement
* — deciding which scheduler thread hosts a workload — lives here too, because
* app code never chooses placement; it deploys a workload and the orchestrator
* places it.
*
* The collection is pure main-thread state driven only by the orchestrator loop,
* so there is one writer and no shared mutable state across threads. Records are
* the same `TenantWorkloadRecord`s the scheduler reasons about, driven through
* the same
* {@link transition} state machine, so the orchestrator's coarse view and the
* scheduler's fine view can never disagree about a workload's lifecycle.
*
* Leases carry an epoch. `renew` is a compare-and-set on that epoch: the
* orchestrator revokes a lease by bumping its epoch, so the holding thread's next
* renewal fails and it drops the workload — the mechanism behind load-driven
* rebalancing. State-preserving handoff of a *running* isolate is deferred to the
* handoff/recovery phase; here a revoked workload is re-placed and reclaimed
* fresh.
*
* @internal
*/
import { captureHandoff, createWorkloadRecord, reconstructRecord, transition, type PendingWork } from '../scheduler/workload.ts';
import type {
  HandoffSnapshot,
  LeaseId,
  LeaseRecord,
  PriorityClass,
  ShardId,
  ShardLoadSummary,
  TenantWake,
  TenantWorkloadRecord,
  WorkloadId
} from '../scheduler/types.ts';

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
  epoch: number;
  priority: PriorityClass;
  entryPath?: string;
  data?: unknown;
}

/**
* The class of a scheduler thread. `latency` threads host normal work and stay
* responsive; `batch` threads exist to absorb sync-heavy workloads migrated off
* the latency threads, so they never receive fresh placement.
*/
export type ShardClass = 'latency' | 'batch';

interface ShardHandle {
  shardId: ShardId;
  capacity: number;
  shardClass: ShardClass;
}

/**
* The node isolate collection: placement, leases, and load aggregation for every
* tenant workload on one node.
*/
export class NodeIsolateCollection {
  #workloads = new Map<WorkloadId, TenantWorkloadRecord>();
  #entries = new Map<WorkloadId, { entryPath?: string; data?: unknown }>();
  #placement = new Map<WorkloadId, ShardId>();
  #leases = new Map<LeaseId, StoredLease>();
  #workloadLease = new Map<WorkloadId, LeaseId>();
  #shards = new Map<ShardId, ShardHandle>();
  #load = new Map<ShardId, ShardLoadSummary>();
  #wakes = new Map<WorkloadId, TenantWake[]>();
  #snapshots = new Map<WorkloadId, HandoffSnapshot>();
  #roundRobin = 0;
  #nextWorkload = 0;
  #nextLease = 0;
  #nextEpoch = 0;

  /** Register a scheduler thread, its capacity, and its class so placement can target it. */
  registerShard(shardId: ShardId, capacity: number, shardClass: ShardClass = 'latency'): void {
    if (!Number.isFinite(capacity) || capacity < 0) {
      throw new TypeError('shard capacity must be a non-negative finite number');
    }
    this.#shards.set(shardId, { shardId, capacity: Math.floor(capacity), shardClass });
    if (!this.#load.has(shardId)) {
      this.#load.set(shardId, { shardId, heldLeases: 0, runnableWorkloads: 0, dispatches: 0, debtMicros: 0 });
    }
  }

  /** The class of a registered thread, or null if unknown. */
  shardClassOf(shardId: ShardId): ShardClass | null {
    return this.#shards.get(shardId)?.shardClass ?? null;
  }

  /** The least-loaded registered thread of a given class, or null if none. */
  leastLoadedOfClass(shardClass: ShardClass, exclude?: ShardId): ShardId | null {
    const pool = [...this.#shards.values()].filter((shard) => shard.shardClass === shardClass && shard.shardId !== exclude);
    if (pool.length === 0) return null;
    return this.#leastLoaded(exclude ?? null, shardClass);
  }

  /**
  * Remove a scheduler thread from placement consideration (e.g. after it dies).
  * Existing leases are cleaned up separately by {@link recoverShard}; this just
  * stops new work being placed on it.
  */
  unregisterShard(shardId: ShardId): void {
    this.#shards.delete(shardId);
    this.#load.delete(shardId);
  }

  /** Every registered scheduler thread. */
  shards(): ShardId[] {
    return [...this.#shards.keys()];
  }

  /**
  * Admit a workload to the node and place it on a scheduler thread. Returns the
  * workload id; the workload stays `unclaimed` until its target thread claims
  * it. Throws if no scheduler thread is registered to host it.
  */
  deploy(spec: NodeWorkloadSpec): WorkloadId {
    if (this.#shards.size === 0) throw new Error('cannot deploy: no scheduler threads registered');
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
    if (spec.affinity !== undefined) {
      if (!this.#shards.has(spec.affinity)) throw new Error(`unknown affinity thread: ${spec.affinity}`);
      // A hard pin must honor capacity: over-subscribing a thread would leave the
      // workload placed-but-never-claimable (claim caps at capacity), silently
      // stranding it. Reject loudly instead.
      if (!this.#hasRoom(spec.affinity)) throw new Error(`affinity thread at capacity: ${spec.affinity}`);
      return spec.affinity;
    }
    if (spec.colocateWith !== undefined) {
      const sibling = this.#shardOf(spec.colocateWith);
      if (sibling !== null && this.#hasRoom(sibling)) return sibling;
    }
    // Fresh work goes to latency threads; batch threads only receive sync-heavy
    // workloads migrated off them.
    const target = this.#leastLoaded(null, 'latency');
    // Every thread is full: refuse rather than pile onto a shard that cannot
    // claim the workload.
    if (!this.#hasRoom(target)) throw new Error('cannot place workload: all scheduler threads at capacity');
    return target;
  }

  #shardOf(workloadId: WorkloadId): ShardId | null {
    const lease = this.#activeLease(workloadId);
    if (lease !== null) return lease.shardId;
    return this.#placement.get(workloadId) ?? null;
  }

  #assignedCount(shardId: ShardId): number {
    let count = 0;
    for (const lease of this.#leases.values()) if (lease.shardId === shardId) count++;
    for (const placed of this.#placement.values()) if (placed === shardId) count++;
    return count;
  }

  #hasRoom(shardId: ShardId): boolean {
    const shard = this.#shards.get(shardId);
    if (shard === undefined) return false;
    return this.#assignedCount(shardId) < shard.capacity;
  }

  /**
  * Least-loaded placement target. Ranks by current assignment count, breaking
  * ties on the shard's last reported runnable/debt load, then round-robin so a
  * cold start still spreads. `exclude` skips a thread (used when re-placing a
  * revoked workload off its old thread).
  */
  #leastLoaded(exclude: ShardId | null, shardClass?: ShardClass): ShardId {
    const all = [...this.#shards.values()];
    const classed = shardClass === undefined ? all : all.filter((shard) => shard.shardClass === shardClass);
    const source = classed.length > 0 ? classed : all;
    const ids = source.map((shard) => shard.shardId).filter((id) => id !== exclude);
    const pool = ids.length > 0 ? ids : source.map((shard) => shard.shardId);
    let best: ShardId | null = null;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const id = pool[(this.#roundRobin + i) % pool.length];
      const load = this.#load.get(id);
      const assigned = this.#assignedCount(id);
      const key = assigned * 1e6 + (load ? load.runnableWorkloads * 1e3 + Math.min(load.debtMicros, 999) : 0);
      if (key < bestKey) {
        bestKey = key;
        best = id;
      }
    }
    this.#roundRobin++;
    return best ?? pool[0];
  }

  /**
  * Hand a scheduler thread up to `capacity` workloads placed on it. Creates a
  * fresh epoch-stamped lease for each and moves the record `unclaimed ->
  * claimed`. Respects both the caller's requested `capacity` and the thread's
  * registered capacity.
  */
  claim(shardId: ShardId, capacity: number): LeaseRecord[] {
    const shard = this.#shards.get(shardId);
    if (shard === undefined) return [];
    const held = this.#heldCount(shardId);
    const room = Math.max(0, Math.min(Math.floor(capacity), shard.capacity) - held);
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
      const epoch = ++this.#nextEpoch;
      const leaseId = `lease-${this.#nextLease++}`;
      const stored: StoredLease = {
        leaseId,
        workloadId,
        shardId,
        epoch,
        priority: record.priority,
        ...entry.entryPath !== undefined ? { entryPath: entry.entryPath } : {},
        ...entry.data !== undefined ? { data: entry.data } : {}
      };
      this.#leases.set(leaseId, stored);
      this.#workloadLease.set(workloadId, leaseId);
      this.#placement.delete(workloadId);
      record.leaseEpoch = epoch;
      record.threadId = shardId;
      transition(record, 'claimed');
      // A reclaimed handed-off workload carries its snapshot so the destination
      // can reconstruct pending work; hand it over exactly once.
      const snapshot = this.#snapshots.get(workloadId);
      this.#snapshots.delete(workloadId);
      leases.push({
        leaseId,
        workloadId,
        epoch,
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

  /** Compare-and-set on the lease epoch. False once the orchestrator revokes it. */
  renew(leaseId: LeaseId, epoch: number): boolean {
    const lease = this.#leases.get(leaseId);
    return lease !== undefined && lease.epoch === epoch;
  }

  /**
  * Revoke the workload's active lease by bumping its epoch, so the holding
  * thread's next {@link renew} fails and it releases the workload back to the
  * collection for re-placement. Returns false if the workload holds no lease.
  */
  revoke(workloadId: WorkloadId): boolean {
    const lease = this.#activeLease(workloadId);
    if (lease === null) return false;
    lease.epoch = ++this.#nextEpoch;
    return true;
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
    this.#wakes.delete(workloadId);
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
        const target = this.#leastLoaded(lease.shardId);
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
  * Begin draining a workload for handoff. It stops being schedulable and its
  * lease is revoked (epoch bumped) so the holding thread finishes its current
  * work, quiesces, and reports a snapshot via {@link completeHandoff}. The
  * workload is walked to `draining` through the state machine.
  */
  drainForHandoff(workloadId: WorkloadId): void {
    const record = this.#workloads.get(workloadId);
    if (record === undefined) throw new Error(`unknown workload: ${workloadId}`);
    this.revoke(workloadId);
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
    const target = toShardId !== undefined && this.#shards.has(toShardId)
      ? toShardId
      : this.#leastLoaded(record.threadId);
    this.#placement.set(workloadId, target);
    record.threadId = target;
    return target;
  }

  /**
  * Store a recovery snapshot for a still-live workload without changing its
  * state or lease. A scheduler checkpoints its workloads periodically so that if
  * its thread crashes, {@link recoverShard} can restore recent pending work
  * rather than only respawning from the entry.
  */
  checkpoint(workloadId: WorkloadId, pending: PendingWork, capturedAtNanos: number): HandoffSnapshot {
    const record = this.#workloads.get(workloadId);
    if (record === undefined) throw new Error(`unknown workload: ${workloadId}`);
    const entry = this.#entries.get(workloadId) ?? {};
    const snapshot = captureHandoff(record, {
      ...entry.entryPath !== undefined ? { entryPath: entry.entryPath } : {},
      ...entry.data !== undefined ? { data: entry.data } : {},
      ...pending.mailbox !== undefined ? { mailbox: pending.mailbox } : {},
      ...pending.timers !== undefined ? { timers: pending.timers } : {},
      ...pending.facadeOps !== undefined ? { facadeOps: pending.facadeOps } : {}
    }, capturedAtNanos);
    this.#snapshots.set(workloadId, snapshot);
    return snapshot;
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
      this.#wakes.delete(workloadId);
      const snapshot = this.#snapshots.get(workloadId);
      const record = snapshot !== undefined
        ? reconstructRecord(snapshot)
        : this.#respawnRecord(workloadId);
      if (record === undefined) continue;
      this.#workloads.set(workloadId, record);
      const target = this.#leastLoaded(shardId);
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

  /**
  * Threads whose held-lease count exceeds `threshold`. Used to decide when to
  * spread linked work off a hot thread onto a cooler one.
  */
  overloadedShards(threshold: number): ShardId[] {
    const hot: ShardId[] = [];
    for (const shardId of this.#shards.keys()) {
      if (this.#heldCount(shardId) > threshold) hot.push(shardId);
    }
    return hot;
  }

  /** The stored handoff snapshot for a workload awaiting reclaim, if any. */
  snapshotOf(workloadId: WorkloadId): HandoffSnapshot | undefined {
    return this.#snapshots.get(workloadId);
  }

  /** Queue a wake for a workload; delivered to its thread by {@link pollWakes}. */
  enqueueWake(workloadId: WorkloadId, wake: TenantWake): void {
    const queue = this.#wakes.get(workloadId);
    if (queue === undefined) this.#wakes.set(workloadId, [wake]);
    else queue.push(wake);
  }

  /** Drain and return every queued wake for the workloads a thread is hosting. */
  pollWakes(shardId: ShardId): TenantWake[] {
    const wakes: TenantWake[] = [];
    for (const lease of this.#leases.values()) {
      if (lease.shardId !== shardId) continue;
      const queue = this.#wakes.get(lease.workloadId);
      if (queue === undefined || queue.length === 0) continue;
      wakes.push(...queue);
      this.#wakes.set(lease.workloadId, []);
    }
    return wakes;
  }

  /** Record a thread's latest load summary for placement decisions. */
  recordLoad(shardId: ShardId, summary: ShardLoadSummary): void {
    this.#load.set(shardId, summary);
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
    return this.#load.get(shardId);
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
