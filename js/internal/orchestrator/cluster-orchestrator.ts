/**
* internal:orchestrator/cluster-orchestrator — cluster-level realm ownership.
*
* Placement and deployment admission enter through this layer so adding remote
* nodes does not move policy into `Realm` or the reactor scheduler. Cluster
* orchestration holds every node — local or remote — through the same
* `ClusterNode` contract; the runtime currently constructs one local node by
* default. The service starts lazily on first allocation/deployment and remains
* available until the runtime shutdown hook joins it.
*
* @internal
*/
import { registerShutdownHook } from 'internal:shutdown';
import { DeploymentController, type DeploymentControllerOptions } from './deployment.ts';
import {
  NodeOrchestrator,
  resolveNodeOrchestratorOptions,
  type RealmWorkloadAllocation,
  type RealmWorkloadSpec
} from './node-orchestrator.ts';

export type ClusterRealmAllocation = RealmWorkloadAllocation;

/**
* The admission/lifecycle contract one allocation-capable node presents to
* cluster orchestration, so local and remote nodes are interacted with
* uniformly. `NodeOrchestrator` satisfies it in-process; a remote node
* satisfies it by speaking these same methods over its cluster control
* channel. Every operation that can involve a peer is ALWAYS asynchronous —
* never sometimes-sync — so callers cannot fork on timing. Deliberately NOT
* a realm or port surface: a node admits serialized realm configurations and
* reports lifecycle, and nothing here drives realms (see
* research-docs/research/multi-node-distribution.md).
*/
export interface ClusterNode {
  /** Slots currently eligible for ordinary realm admission (locally cached). */
  admissionCapacity(): number;
  /** Admit a serialized realm; resolves `null` when the node is at capacity. */
  allocateRealm(spec: RealmWorkloadSpec): Promise<RealmWorkloadAllocation | null>;
  /** Stop the node service. One-shot. */
  shutdown(): Promise<void>;
}

/** Cluster-level facade over `ClusterNode`s; defaults to one local node. */
export class ClusterOrchestrator {
  #node: ClusterNode | null = null;
  #createNode: () => ClusterNode;
  #shutdownHookRegistered = false;

  constructor(createNode?: () => ClusterNode) {
    this.#createNode = createNode ?? (() => new NodeOrchestrator(resolveNodeOrchestratorOptions()));
  }

  /** Allocate one realm on an eligible node; resolves `null` at capacity. */
  async allocateRealm(spec: RealmWorkloadSpec): Promise<ClusterRealmAllocation | null> {
    return this.#ensureNode().allocateRealm(spec);
  }

  /** Construct deployment admission against aggregate eligible capacity. */
  createDeployment<T>(options: Omit<DeploymentControllerOptions<T>, 'capacity'>): DeploymentController<T> {
    this.#ensureNode();
    return new DeploymentController({
      ...options,
      capacity: () => this.admissionCapacity()
    });
  }

  /** Aggregate slots currently eligible for ordinary realm admission. */
  admissionCapacity(): number {
    return this.#node?.admissionCapacity() ?? 0;
  }

  #ensureNode(): ClusterNode {
    if (this.#node !== null) return this.#node;
    const node = this.#createNode();
    this.#node = node;
    if (!this.#shutdownHookRegistered) {
      this.#shutdownHookRegistered = true;
      registerShutdownHook(() => {
        this.#shutdownHookRegistered = false;
        const active = this.#node;
        this.#node = null;
        return active?.shutdown();
      });
    }
    return node;
  }
}

/** Process-local cluster orchestration service. */
export const clusterOrchestrator = new ClusterOrchestrator();
