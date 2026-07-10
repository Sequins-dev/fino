/**
* internal:orchestrator/scaling — deterministic cluster placement and realm
* replica-count policy.
*
* This module contains no transport or timer ownership. Cluster observations
* are supplied by the agent and timestamps by the reconciler, keeping placement
* and stabilization decisions reproducible in tests and across leader changes.
*
* @internal
*/

/** Publicly configurable realm replication policy before defaults are applied. */
export interface RealmScalingPolicy {
  mode?: 'replicated' | 'bound';
  min?: number;
  max?: number;
  loopDelayTargetMs?: number;
  scaleUpWindowMs?: number;
  scaleDownBusyRatio?: number;
  scaleDownWindowMs?: number;
}

/** Validated scaling policy used by placement and reconciliation. */
export interface NormalizedScalingPolicy {
  mode: 'replicated' | 'bound';
  min: number;
  max: number;
  loopDelayTargetMs: number;
  scaleUpWindowMs: number;
  scaleDownBusyRatio: number;
  scaleDownWindowMs: number;
}

/** Apply latency-first defaults and cap replicas to physical reactor capacity. */
export function normalizeScalingPolicy(policy: RealmScalingPolicy | undefined, reactorCapacity: number): NormalizedScalingPolicy {
  if (!Number.isInteger(reactorCapacity) || reactorCapacity < 1) {
    throw new TypeError('cluster reactor capacity must be a positive integer');
  }
  const mode = policy?.mode ?? 'replicated';
  const requestedMax = policy?.max ?? reactorCapacity;
  const max = mode === 'bound' ? 1 : requestedMax;
  const min = mode === 'bound' ? 1 : policy?.min ?? 1;
  if (!Number.isInteger(min) || min < 1) throw new TypeError('scaling minimum must be a positive integer');
  if (!Number.isInteger(max) || max < 1) throw new TypeError('scaling maximum must be a positive integer');
  if (max > reactorCapacity) throw new RangeError('scaling maximum exceeds cluster reactor capacity');
  if (min > reactorCapacity) throw new RangeError('scaling minimum exceeds cluster reactor capacity');
  if (min > max) throw new RangeError('scaling minimum cannot exceed maximum');
  const loopDelayTargetMs = positive(policy?.loopDelayTargetMs ?? 5, 'loop delay target');
  const scaleUpWindowMs = nonNegative(policy?.scaleUpWindowMs ?? 1_000, 'scale-up window');
  const scaleDownBusyRatio = policy?.scaleDownBusyRatio ?? .1;
  if (!Number.isFinite(scaleDownBusyRatio) || scaleDownBusyRatio < 0 || scaleDownBusyRatio > 1) {
    throw new RangeError('scale-down busy ratio must be in [0, 1]');
  }
  const scaleDownWindowMs = nonNegative(policy?.scaleDownWindowMs ?? 30_000, 'scale-down window');
  return { mode, min, max, loopDelayTargetMs, scaleUpWindowMs, scaleDownBusyRatio, scaleDownWindowMs };
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return value;
}

/** Soft node observation used for cluster-level placement. */
export interface PlacementNode {
  nodeId: string;
  local: boolean;
  loopPressure: number;
  reactorCapacity: number;
  assigned: number;
}

/** Cluster-level node chooser; local allocators remain responsible for shards. */
export class PlacementReconciler {
  /**
  * Choose an admissible node. Replica spreading is applied first. For an
  * ordinary allocation, a remote node wins whenever it is no more pressured
  * than the best local candidate.
  */
  chooseNode(nodes: readonly PlacementNode[], replicaNodes: ReadonlySet<string>): PlacementNode | null {
    const eligible = nodes.filter((node) =>
      Number.isFinite(node.loopPressure) &&
      Number.isInteger(node.reactorCapacity) &&
      node.reactorCapacity > node.assigned
    );
    if (eligible.length === 0) return null;
    const unoccupied = eligible.filter((node) => !replicaNodes.has(node.nodeId));
    const candidates = unoccupied.length > 0 ? unoccupied : eligible;
    const ordered = [...candidates].sort((a, b) =>
      a.loopPressure - b.loopPressure ||
      a.assigned / a.reactorCapacity - b.assigned / b.reactorCapacity ||
      compareAscii(a.nodeId, b.nodeId)
    );
    if (replicaNodes.size > 0) return ordered[0] ?? null;
    const local = ordered.find((node) => node.local);
    const remote = ordered.find((node) => !node.local);
    if (remote !== undefined && (local === undefined || remote.loopPressure <= local.loopPressure)) return remote;
    return local ?? remote ?? null;
  }
}

/** One interval-based observation for a concrete isolate replica. */
export interface ReplicaObservation {
  replicaId: string;
  busyRatio: number;
  queueDepth: number;
  oldestQueueAgeMs: number;
  runnableDelayP95Ms: number;
}

/** A single serialized reconciliation action. */
export type ScalingAction = { type: 'scale-up' } | { type: 'scale-down'; replicaId: string };

/** A ready/draining route materialized from replica observations. */
export interface DirectoryTarget {
  replicaId: string;
  nodeId: string;
  ready: boolean;
  draining?: boolean;
}

/** Push-oriented service routes; DNS is a projection of this same state. */
export class ServiceDirectory {
  #services = new Map<string, Map<string, DirectoryTarget>>();

  /** Insert or replace one observed replica. Starting replicas remain hidden. */
  observe(service: string, target: DirectoryTarget): void {
    let replicas = this.#services.get(service);
    if (replicas === undefined) {
      replicas = new Map();
      this.#services.set(service, replicas);
    }
    replicas.set(target.replicaId, { ...target });
  }

  /** Withdraw a replica from new routing before its listeners are stopped. */
  beginDrain(service: string, replicaId: string): void {
    const target = this.#services.get(service)?.get(replicaId);
    if (target !== undefined) target.draining = true;
  }

  /** Forget a stopped replica after its drain completes. */
  remove(service: string, replicaId: string): void {
    const replicas = this.#services.get(service);
    replicas?.delete(replicaId);
    if (replicas?.size === 0) this.#services.delete(service);
  }

  /** Current ready, non-draining route snapshot. */
  targets(service: string): DirectoryTarget[] {
    return [...(this.#services.get(service)?.values() ?? [])]
      .filter((target) => target.ready && !target.draining)
      .sort((a, b) => compareAscii(a.replicaId, b.replicaId))
      .map((target) => ({ ...target }));
  }

  /** DNS records are derived from, never independent of, the live directory. */
  dnsProjection(service: string): DirectoryTarget[] {
    return this.targets(service);
  }
}

/** Minimal contract a non-task resource exposes to replica draining. */
export interface DrainResource {
  hasRef(): boolean;
}

/** Tracks listener shutdown and referenced in-flight work for one replica. */
export class ReplicaDrainTracker {
  #listeners = new Set<() => void>();
  #resources = new Set<DrainResource>();
  #activeTasks = 0;
  #draining = false;
  #settled = false;
  #resolve!: () => void;
  #done = new Promise<void>((resolve) => { this.#resolve = resolve; });

  /** Number of routed tasks admitted before drain cutover and not yet settled. */
  get activeTasks(): number {
    return this.#activeTasks;
  }

  /** Register an accepting handle's synchronous stop-accepting action. */
  registerListener(stopAccepting: () => void): () => void {
    if (this.#draining) {
      stopAccepting();
      return () => {};
    }
    this.#listeners.add(stopAccepting);
    return () => this.#listeners.delete(stopAccepting);
  }

  /** Track a non-listener resource and return its explicit release hook. */
  registerResource(resource: DrainResource): () => void {
    this.#resources.add(resource);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.#resources.delete(resource);
      this.#checkDone();
    };
  }

  /** Admit one routed task and return an idempotent completion function. */
  admitTask(): () => void {
    if (this.#draining) throw new Error('replica is draining and cannot admit new tasks');
    this.#activeTasks++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#activeTasks--;
      this.#checkDone();
    };
  }

  /** Stop listeners immediately and resolve after referenced work reaches zero. */
  beginDrain(): Promise<void> {
    if (!this.#draining) {
      this.#draining = true;
      for (const stop of this.#listeners) stop();
      this.#listeners.clear();
      this.#checkDone();
    }
    return this.#done;
  }

  #checkDone(): void {
    if (!this.#draining || this.#settled || this.#activeTasks !== 0) return;
    for (const resource of this.#resources) if (resource.hasRef()) return;
    this.#settled = true;
    this.#resolve();
  }
}

/** Host callbacks needed to materialize one scaling decision. */
export interface ReplicaSetReconcilerOptions {
  service: string;
  directory: ServiceDirectory;
  spawn(target: PlacementNode): Promise<{ replicaId: string; nodeId: string }>;
  drain(replicaId: string): Promise<void>;
  completeAction?: () => void;
}

/** Applies serialized autoscaler actions with readiness and drain ordering. */
export class ReplicaSetReconciler {
  #options: ReplicaSetReconcilerOptions;

  constructor(options: ReplicaSetReconcilerOptions) {
    this.#options = options;
  }

  /**
  * Apply one action. Scale-up publishes only after `spawn` resolves ready;
  * scale-down withdraws synchronously before awaiting the host drain.
  */
  async apply(action: ScalingAction, target: PlacementNode | null): Promise<void> {
    try {
      if (action.type === 'scale-up') {
        if (target === null) throw new Error('scale-up has no admissible placement target');
        const replica = await this.#options.spawn(target);
        this.#options.directory.observe(this.#options.service, { ...replica, ready: true });
        return;
      }
      this.#options.directory.beginDrain(this.#options.service, action.replicaId);
      await this.#options.drain(action.replicaId);
      this.#options.directory.remove(this.#options.service, action.replicaId);
    } finally {
      this.#options.completeAction?.();
    }
  }
}

/** Latency-first, time-stabilized replica-count controller. */
export class ReplicaAutoscaler {
  #policy: NormalizedScalingPolicy;
  #observations: readonly ReplicaObservation[] = [];
  #pressureSince: number | null = null;
  #quietSince: number | null = null;
  #pending = false;

  constructor(policy: RealmScalingPolicy & { min: number; max: number }) {
    this.#policy = normalizeScalingPolicy(policy, policy.max);
  }

  /** Record a complete current observation set at monotonic time `nowMs`. */
  observe(nowMs: number, observations: readonly ReplicaObservation[]): void {
    this.#observations = observations.map((observation) => ({ ...observation }));
    const pressureThreshold = this.#policy.loopDelayTargetMs / 2;
    const pressured = observations.some((observation) =>
      observation.queueDepth > 0 &&
      (observation.oldestQueueAgeMs >= pressureThreshold || observation.runnableDelayP95Ms >= pressureThreshold)
    );
    this.#pressureSince = pressured ? this.#pressureSince ?? nowMs : null;
    const quiet = observations.length > this.#policy.min && observations.every((observation) =>
      observation.queueDepth === 0 && observation.busyRatio < this.#policy.scaleDownBusyRatio
    );
    this.#quietSince = quiet ? this.#quietSince ?? nowMs : null;
  }

  /** Return at most one action until `completeAction()` records cutover/drain completion. */
  evaluate(nowMs: number): ScalingAction | null {
    if (this.#pending || this.#policy.mode === 'bound') return null;
    if (
      this.#observations.length < this.#policy.max &&
      this.#pressureSince !== null &&
      nowMs - this.#pressureSince >= this.#policy.scaleUpWindowMs
    ) {
      this.#pending = true;
      return { type: 'scale-up' };
    }
    if (
      this.#observations.length > this.#policy.min &&
      this.#quietSince !== null &&
      nowMs - this.#quietSince >= this.#policy.scaleDownWindowMs
    ) {
      const candidate = [...this.#observations].sort((a, b) =>
        a.busyRatio - b.busyRatio || compareAscii(a.replicaId, b.replicaId)
      )[0];
      if (candidate !== undefined) {
        this.#pending = true;
        return { type: 'scale-down', replicaId: candidate.replicaId };
      }
    }
    return null;
  }

  /** Allow another decision after a successor is ready or a drain completes. */
  completeAction(): void {
    this.#pending = false;
  }
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
