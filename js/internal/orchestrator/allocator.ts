/**
* internal:orchestrator/allocator — the node's workload allocator service.
*
* The allocator is the single authority for *where* a workload runs. It holds
* the roster of scheduler threads (their capacity and class), a live view of the
* load each is carrying, and the placement policy — affinity pins, same-tenant
* colocation, latency-vs-batch routing, and capacity enforcement. The node
* collection owns workload *records* and leases and asks the allocator to choose
* a thread; the allocator never touches record lifecycle.
*
* Keeping placement here (rather than scattered through the collection) makes it
* one capacity-enforced chokepoint and gives clustering a natural seam: a future
* cluster-level allocator federates one node-local allocator per node and routes
* by a node-qualified shard id, with this class unchanged as a backend.
*
* Occupancy — how many workloads are currently assigned to a thread — lives in
* the collection (it owns leases and placement), so the allocator reads it back
* through a narrow {@link ShardOccupancy} port rather than duplicating that state
* and risking drift.
*
* @internal
*/
import type { PriorityClass, ShardId, ShardLoadSummary } from '../scheduler/types.ts';

/**
* The class of a scheduler thread. `latency` threads host normal work and stay
* responsive; `batch` threads exist to absorb sync-heavy workloads migrated off
* the latency threads, so they never receive fresh placement.
*/
export type ShardClass = 'latency' | 'batch';

/** How the allocator reads current per-thread occupancy from the collection. */
export interface ShardOccupancy {
  /** Number of workloads currently assigned to (placed on or leased to) a thread. */
  assignedCount(shardId: ShardId): number;
}

/** A placement request. The collection resolves colocation to `preferShard`. */
export interface PlacementRequest {
  /** Hard-pin to a specific thread (core services only); rejected if it has no room. */
  affinity?: ShardId;
  /** Preferred thread (e.g. a same-tenant sibling's thread); used only if it has room. */
  preferShard?: ShardId;
  /** Pool to place fresh work into. Defaults to `latency`. */
  shardClass?: ShardClass;
}

interface AllocatorShard {
  shardId: ShardId;
  capacity: number;
  shardClass: ShardClass;
}

/**
* The workload allocator: thread roster, load view, and placement policy for one
* node. Pure main-thread state driven by the orchestrator loop.
*/
export class WorkloadAllocator {
  #shards = new Map<ShardId, AllocatorShard>();
  #load = new Map<ShardId, ShardLoadSummary>();
  #occupancy: ShardOccupancy;
  #roundRobin = 0;

  constructor(occupancy: ShardOccupancy) {
    this.#occupancy = occupancy;
  }

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

  /** Remove a thread from placement consideration (e.g. after it dies). */
  unregisterShard(shardId: ShardId): void {
    this.#shards.delete(shardId);
    this.#load.delete(shardId);
  }

  /** Whether a thread is registered. */
  hasShard(shardId: ShardId): boolean {
    return this.#shards.has(shardId);
  }

  /** Every registered scheduler thread. */
  shards(): ShardId[] {
    return [...this.#shards.keys()];
  }

  /** The class of a registered thread, or null if unknown. */
  shardClassOf(shardId: ShardId): ShardClass | null {
    return this.#shards.get(shardId)?.shardClass ?? null;
  }

  /** The registered capacity of a thread, or 0 if unknown. */
  capacityOf(shardId: ShardId): number {
    return this.#shards.get(shardId)?.capacity ?? 0;
  }

  /** Record a thread's latest load summary for placement decisions. */
  recordLoad(shardId: ShardId, summary: ShardLoadSummary): void {
    this.#load.set(shardId, summary);
  }

  /** Last reported load for a thread. */
  loadOf(shardId: ShardId): ShardLoadSummary | undefined {
    return this.#load.get(shardId);
  }

  /** Whether a thread has room for another workload under its capacity. */
  hasRoom(shardId: ShardId): boolean {
    const shard = this.#shards.get(shardId);
    if (shard === undefined) return false;
    return this.#occupancy.assignedCount(shardId) < shard.capacity;
  }

  /**
  * Choose a thread for a fresh workload. Honors an affinity pin, then a
  * preferred sibling thread, then the least-loaded thread of the requested
  * class. Capacity is enforced on every path: a full affinity/no-room-anywhere
  * placement throws rather than stranding a workload that could never be claimed.
  */
  choose(request: PlacementRequest = {}): ShardId {
    if (this.#shards.size === 0) throw new Error('cannot place workload: no scheduler threads registered');
    if (request.affinity !== undefined) {
      if (!this.#shards.has(request.affinity)) throw new Error(`unknown affinity thread: ${request.affinity}`);
      if (!this.hasRoom(request.affinity)) throw new Error(`affinity thread at capacity: ${request.affinity}`);
      return request.affinity;
    }
    if (request.preferShard !== undefined && this.hasRoom(request.preferShard)) {
      return request.preferShard;
    }
    const target = this.#leastLoaded(null, request.shardClass ?? 'latency');
    if (!this.hasRoom(target)) throw new Error('cannot place workload: all scheduler threads at capacity');
    return target;
  }

  /**
  * The least-loaded thread of a given class (with room), or null if the class is
  * empty. Used to target a batch thread for a sync-heavy migration and to
  * re-place a workload off a thread it must leave (`exclude`).
  */
  leastLoadedOfClass(shardClass: ShardClass, exclude?: ShardId): ShardId | null {
    const pool = [...this.#shards.values()].filter((shard) =>
      shard.shardClass === shardClass && shard.shardId !== exclude && this.hasRoom(shard.shardId)
    );
    if (pool.length === 0) return null;
    let best = pool[0]!.shardId;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const id = pool[(this.#roundRobin + i) % pool.length]!.shardId;
      const load = this.#load.get(id);
      const assigned = this.#occupancy.assignedCount(id);
      const key = assigned * 1e6 + (load ? load.runnableWorkloads * 1e3 + Math.min(load.debtMicros, 999) : 0);
      if (key < bestKey) {
        bestKey = key;
        best = id;
      }
    }
    this.#roundRobin++;
    return best;
  }

  /**
  * Least-loaded placement target of a class. Ranks by current assignment count,
  * breaks ties on the thread's last reported runnable/debt load, then round-robin
  * so a cold start still spreads. `exclude` skips a thread (used when re-placing a
  * revoked/recovered workload off its old thread). May return a full thread when
  * every candidate is full; callers that must not over-subscribe check
  * {@link hasRoom}.
  */
  leastLoaded(exclude: ShardId | null, shardClass?: ShardClass): ShardId {
    return this.#leastLoaded(exclude, shardClass);
  }

  #leastLoaded(exclude: ShardId | null, shardClass?: ShardClass): ShardId {
    const all = [...this.#shards.values()];
    const classed = shardClass === undefined ? all : all.filter((shard) => shard.shardClass === shardClass);
    const source = classed.length > 0 ? classed : all;
    const ids = source.map((shard) => shard.shardId).filter((id) => id !== exclude);
    const pool = ids.length > 0 ? ids : source.map((shard) => shard.shardId);
    let best: ShardId | null = null;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      const id = pool[(this.#roundRobin + i) % pool.length]!;
      const load = this.#load.get(id);
      const assigned = this.#occupancy.assignedCount(id);
      const key = assigned * 1e6 + (load ? load.runnableWorkloads * 1e3 + Math.min(load.debtMicros, 999) : 0);
      if (key < bestKey) {
        bestKey = key;
        best = id;
      }
    }
    this.#roundRobin++;
    return best ?? pool[0]!;
  }
}
