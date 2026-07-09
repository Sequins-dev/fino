/**
* internal:realm/allocate — the realm placement seam.
*
* A realm is a serializable configuration; WHERE it runs is the allocator's
* decision, not the caller's (`fino:realm` exposes no placement options).
* This module is the chokepoint every non-process realm construction goes
* through, so growing the policy never touches `Realm` itself:
*
* - v1 (this file): every realm gets a dedicated reactor thread — the exact
*   behavior `thread: true` used to request, applied universally.
* - Pooling: a bounded reactor-thread pool with least-loaded placement and
*   multiplexed contexts once the pool is at width.
* - Orchestrator-backed: placements become workload records in the node
*   collection, load reports drive drain+respawn rebalancing.
* - Cross-node: with a cluster active, the config ships to a peer node's
*   allocator and runs on one of its reactors.
*
* See research-docs/research/realm-allocation.md.
*
* @internal
*/

/** Where an allocated realm is constructed. */
export interface RealmPlacement {
  /**
  * `thread` — construct on a dedicated reactor thread (own isolate).
  * `embedded` — construct in the caller's isolate on the caller's reactor;
  * only chosen when the config demands same-isolate coupling (live
  * MessagePort handoff, REPL wiring).
  */
  kind: 'thread' | 'embedded';
}

/** The placement-relevant slice of a realm config. */
export interface AllocationRequest {
  /** Entry module path (informational; future policies key affinity on it). */
  entry?: string;
  /** Same-isolate coupling required: live ports or REPL mode. */
  requiresSameIsolate?: boolean;
}

/**
* Decide where a realm runs.
*
* @internal
*/
export function allocatePlacement(request: AllocationRequest): RealmPlacement {
  if (request.requiresSameIsolate) return { kind: 'embedded' };
  return { kind: 'thread' };
}
