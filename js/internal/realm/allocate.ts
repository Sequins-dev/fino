/**
* internal:realm/allocate — the realm placement seam.
*
* A realm is a serializable configuration; WHERE it runs is the allocator's
* decision, not the caller's (`fino:realm` exposes no placement options).
* This module is the chokepoint every non-process realm construction goes
* through, so growing the policy never touches `Realm` itself.
*
* Current policy: realms are placed on the node's scheduler pool — engine
* reactor threads shared with tenant workloads, records held in the one
* NodeIsolateCollection — with one realm per shard (capacity 1) so a realm
* that blocks its thread cannot stall a sibling. Past pool capacity, and for
* configurations the pool cannot host yet (watch mode, same-isolate
* coupling, engine-hosted parents that cannot spawn reactors), placement
* falls back to a dedicated reactor thread.
*
* See research-docs/research/realm-allocation.md.
*
* @internal
*/
import { SchedulerNode } from 'internal:orchestrator/scheduler-node';
import { isEngineThread } from 'internal:reactor-engine';
import { registerShutdownHook } from 'internal:shutdown';

/** Where an allocated realm is constructed. */
export interface RealmPlacement {
  /**
  * `pool` — hosted on a node scheduler thread as a workload record.
  * `thread` — construct on a dedicated reactor thread (own isolate).
  * `embedded` — construct in the caller's isolate on the caller's reactor;
  * only chosen when the config demands same-isolate coupling (live
  * MessagePort handoff, REPL wiring).
  */
  kind: 'pool' | 'thread' | 'embedded';
}

/** The placement-relevant slice of a realm config. */
export interface AllocationRequest {
  /** Entry module path (informational; future policies key affinity on it). */
  entry?: string;
  /** Same-isolate coupling required: live ports or REPL mode. */
  requiresSameIsolate?: boolean;
  /** Watch-mode reload machinery is dedicated-thread-only for now. */
  watch?: boolean;
}

/**
* Decide where a realm runs.
*
* @internal
*/
export function allocatePlacement(request: AllocationRequest): RealmPlacement {
  if (request.requiresSameIsolate) return { kind: 'embedded' };
  if (request.watch) return { kind: 'thread' };
  if (isEngineThread()) return { kind: 'thread' };
  return { kind: 'pool' };
}

// ---------------------------------------------------------------------------
// The node pool
// ---------------------------------------------------------------------------

/** How many scheduler threads the lazily-started node boots. */
const POOL_SHARDS = 2;

let _node: SchedulerNode | null = null;
let _liveRealms = 0;
let _idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

let _shutdownHookRegistered = false;

function ensureNode(): SchedulerNode {
  if (_node === null) {
    // One realm per shard: a realm may block its thread (Atomics.wait, sync
    // FFI), so shards must not multiplex realms until the allocator can
    // classify them. Capacity growth is a policy change here, not an API one.
    _node = new SchedulerNode({ shardCount: POOL_SHARDS, capacity: 1 });
    _node.start();
    if (!_shutdownHookRegistered) {
      _shutdownHookRegistered = true;
      // The host realm winding down takes its pool with it: orphaned
      // pooled realms (created but never run/terminated) must not hold the
      // process open — an orphaned dedicated-thread realm never did, its
      // thread simply died with the process.
      registerShutdownHook(() => {
        const node = _node;
        _node = null;
        _liveRealms = 0;
        if (_idleShutdownTimer !== null) {
          clearTimeout(_idleShutdownTimer);
          _idleShutdownTimer = null;
        }
        if (node !== null) return node.shutdown().then(() => undefined);
        return undefined;
      });
    }
  }
  return _node;
}

/**
* Idle shutdown: the node's scheduler threads, report pumps, and watchdog
* interval hold the host realm alive, so the pool winds down when its last
* realm releases. Debounced — back-to-back workloads (one test suite ending
* as the next begins) reuse the node instead of racing a teardown against a
* fresh placement; a genuinely idle process pays one 50ms tail.
*/
function releaseRealmRef(node: SchedulerNode): void {
  _liveRealms--;
  if (_liveRealms > 0 || _node !== node) return;
  if (_idleShutdownTimer !== null) clearTimeout(_idleShutdownTimer);
  _idleShutdownTimer = setTimeout(() => {
    _idleShutdownTimer = null;
    if (_liveRealms === 0 && _node === node) {
      _node = null;
      void node.shutdown();
    }
  }, 50);
}

/** A pool-hosted realm placement, returned to `Realm`. */
export interface PooledRealm {
  workloadId: string;
  /** Parent-side channel half: the Realm's port messages through it. */
  portHandle: number;
  portWakeFd: number;
  /** Resolves with the engine release reason when the realm exits. */
  released: Promise<string>;
  /** Hard-kill the workload (terminate() fallback when the port is closed). */
  revoke(reason: string): void;
}

/**
* Place a realm config on the node pool. Returns `null` when the pool is at
* capacity — the caller falls back to a dedicated thread.
*
* @internal
*/
export function placePooledRealm(config: {
  entry: string;
  rulesJson: string;
  realmData?: string;
  bootstrapData?: string;
}): PooledRealm | null {
  const node = ensureNode();
  const placed = node.deployRealm({
    entryPath: config.entry,
    rulesJson: config.rulesJson,
    ...config.realmData !== undefined ? { realmData: config.realmData } : {},
    ...config.bootstrapData !== undefined ? { bootstrapData: config.bootstrapData } : {}
  });
  if (placed === null) return null;
  _liveRealms++;
  if (_idleShutdownTimer !== null) {
    clearTimeout(_idleShutdownTimer);
    _idleShutdownTimer = null;
  }
  const released = node.whenReleased(placed.workloadId);
  released.then(() => releaseRealmRef(node), () => releaseRealmRef(node));
  return {
    workloadId: placed.workloadId,
    portHandle: placed.portHandle,
    portWakeFd: placed.portWakeFd,
    released,
    revoke: (reason: string) => node.revoke(placed.workloadId, reason)
  };
}
