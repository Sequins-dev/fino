/**
* internal:orchestrator/cluster-orchestrator — cluster-level realm ownership.
*
* Placement and deployment admission enter through this layer so adding remote
* nodes does not move policy into `Realm` or the reactor scheduler. Cluster
* orchestration holds every node — local or remote — through the same
* `ClusterNode` contract; the runtime currently constructs one local node by
* default. The service starts on its first retained allocation/deployment and
* replaces its one-shot node service after an idle shutdown.
*
* @internal
*/
import { registerShutdownHook } from 'internal:shutdown';
import { IdleRetirement } from './idle.ts';
import { DeploymentController, type DeploymentControllerOptions } from './deployment.ts';
import { NodeOrchestrator, resolveNodeOrchestratorOptions, type RealmWorkloadSpec } from './node-orchestrator.ts';

export interface ClusterRealmAllocation {
  workloadId: string;
  portHandle: number;
  portWakeFd: number;
  allocationPortHandle: number;
  allocationPortWakeFd: number;
  released: Promise<string>;
  revoke(reason: string): void;
}

/** What a node hands back for one admitted realm. */
export type NodeRealmAllocation = Omit<ClusterRealmAllocation, 'released' | 'revoke'>;

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
  /** Boot the node's substrate. Idempotent. */
  start(): Promise<void>;
  /** Slots currently eligible for ordinary realm admission (locally cached). */
  admissionCapacity(): number;
  /** Admit a serialized realm; resolves `null` when the node is at capacity. */
  allocateRealm(spec: RealmWorkloadSpec): Promise<NodeRealmAllocation | null>;
  /** Resolve with the release reason when a workload reaches a terminal state. */
  whenReleased(workloadId: string): Promise<string>;
  /** Hard-stop one workload on its hosting reactor (one-way). */
  revoke(workloadId: string, reason: string): void;
  /** Stop the node service. One-shot. */
  shutdown(): Promise<void>;
}

/** Cluster-level facade over `ClusterNode`s; defaults to one local node. */
export class ClusterOrchestrator {
  #node: ClusterNode | null = null;
  #createNode: () => ClusterNode;
  #idle = new IdleRetirement({
    delayMs: 50,
    shouldRetire: () => this.#node !== null,
    retire: () => {
      const node = this.#node;
      this.#node = null;
      void node!.shutdown();
    }
  });
  #shutdownHookRegistered = false;

  constructor(createNode?: () => ClusterNode) {
    this.#createNode = createNode ?? (() => new NodeOrchestrator(resolveNodeOrchestratorOptions()));
  }

  /** Allocate one realm on an eligible node; resolves `null` at capacity. */
  async allocateRealm(spec: RealmWorkloadSpec): Promise<ClusterRealmAllocation | null> {
    const node = this.#ensureNode();
    // Hold the node open across the admission window so idle retirement
    // cannot shut it down mid-allocation.
    this.#idle.retain();
    let placed: NodeRealmAllocation | null;
    try {
      placed = await node.allocateRealm(spec);
    } catch (error) {
      this.#idle.release();
      throw error;
    }
    if (placed === null) {
      this.#idle.release();
      return null;
    }
    return this.#wireAllocation(node, placed);
  }

  /** Attach lifetime wiring to an admitted allocation (retain until released). */
  #wireAllocation(node: ClusterNode, placed: NodeRealmAllocation): ClusterRealmAllocation {
    const released = node.whenReleased(placed.workloadId);
    void released.then(() => this.#idle.release(), () => this.#idle.release());
    return {
      ...placed,
      released,
      revoke: (reason: string) => node.revoke(placed.workloadId, reason)
    };
  }

  /** Construct deployment admission against aggregate eligible capacity. */
  createDeployment<T>(options: Omit<DeploymentControllerOptions<T>, 'capacity' | 'onTerminate'>): DeploymentController<T> {
    this.#idle.retain();
    this.#ensureNode();
    try {
      return new DeploymentController({
        ...options,
        capacity: () => this.admissionCapacity(),
        onTerminate: () => this.#idle.release()
      });
    } catch (error) {
      this.#idle.release();
      throw error;
    }
  }

  /** Aggregate slots currently eligible for ordinary realm admission. */
  admissionCapacity(): number {
    return this.#node?.admissionCapacity() ?? 0;
  }

  #ensureNode(): ClusterNode {
    if (this.#node !== null) return this.#node;
    const node = this.#createNode();
    void node.start();
    this.#node = node;
    if (!this.#shutdownHookRegistered) {
      this.#shutdownHookRegistered = true;
      registerShutdownHook(() => {
        this.#shutdownHookRegistered = false;
        this.#idle.reset();
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
