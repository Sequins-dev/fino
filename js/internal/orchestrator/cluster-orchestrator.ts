/**
* internal:orchestrator/cluster-orchestrator — cluster-level realm ownership.
*
* The current runtime exposes one eligible local node, but placement and
* deployment admission enter through this layer so adding remote nodes does not
* move policy into `Realm` or the reactor scheduler. The service starts on its
* first retained allocation/deployment and replaces its one-shot node service
* after an idle shutdown.
*
* @internal
*/
import { registerShutdownHook } from 'internal:shutdown';
import { IdleRetirement } from './idle.ts';
import { DeploymentController, type DeploymentControllerOptions } from './deployment.ts';
import { NodeOrchestrator, type RealmWorkloadSpec } from './node-orchestrator.ts';

export interface ClusterRealmAllocation {
  workloadId: string;
  portHandle: number;
  portWakeFd: number;
  allocationPortHandle: number;
  allocationPortWakeFd: number;
  released: Promise<string>;
  revoke(reason: string): void;
}

/** Cluster-level facade; currently backed by one local node. */
export class ClusterOrchestrator {
  #node: NodeOrchestrator | null = null;
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

  /** Allocate one realm on an eligible node, or return `null` at capacity. */
  allocateRealm(spec: RealmWorkloadSpec): ClusterRealmAllocation | null {
    const node = this.#ensureNode();
    const placed = node.deployRealm(spec);
    if (placed === null) {
      this.#idle.poke();
      return null;
    }
    this.#idle.retain();
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

  #ensureNode(): NodeOrchestrator {
    if (this.#node !== null) return this.#node;
    const node = new NodeOrchestrator({ capacity: 8 });
    node.start();
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
