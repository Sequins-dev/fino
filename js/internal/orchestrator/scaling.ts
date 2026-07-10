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
