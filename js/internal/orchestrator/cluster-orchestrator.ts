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
  #retained = 0;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #shutdownHookRegistered = false;

  /** Allocate one realm on an eligible node, or return `null` at capacity. */
  allocateRealm(spec: RealmWorkloadSpec): ClusterRealmAllocation | null {
    const node = this.#ensureNode();
    const placed = node.deployRealm(spec);
    if (placed === null) {
      this.#scheduleIdleShutdown();
      return null;
    }
    this.#retain();
    const released = node.whenReleased(placed.workloadId);
    void released.then(() => this.#release(), () => this.#release());
    return {
      ...placed,
      released,
      revoke: (reason: string) => node.revoke(placed.workloadId, reason)
    };
  }

  /** Construct deployment admission against aggregate eligible capacity. */
  createDeployment<T>(options: Omit<DeploymentControllerOptions<T>, 'capacity' | 'onTerminate'>): DeploymentController<T> {
    this.#retain();
    this.#ensureNode();
    try {
      return new DeploymentController({
        ...options,
        capacity: () => this.admissionCapacity(),
        onTerminate: () => this.#release()
      });
    } catch (error) {
      this.#release();
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
        this.#retained = 0;
        if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
        this.#idleTimer = null;
        const active = this.#node;
        this.#node = null;
        return active?.shutdown();
      });
    }
    return node;
  }

  #retain(): void {
    this.#retained++;
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #release(): void {
    this.#retained = Math.max(0, this.#retained - 1);
    this.#scheduleIdleShutdown();
  }

  #scheduleIdleShutdown(): void {
    if (this.#retained !== 0 || this.#node === null) return;
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    const node = this.#node;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#retained !== 0 || this.#node !== node) return;
      this.#node = null;
      void node.shutdown();
    }, 50);
  }
}

/** Process-local cluster orchestration service. */
export const clusterOrchestrator = new ClusterOrchestrator();
