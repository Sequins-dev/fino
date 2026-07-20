/**
* internal:orchestrator/deployment — replica lifecycle and queue-pressure control.
*
* A deployment controller owns replica count, admission, draining, and
* retirement. It is deliberately generic: execution containers are supplied by
* the caller, while the controller decides only when another independent
* container is needed. Reactor scheduling remains entirely native.
*
* @internal
*/
import { IdleRetirement } from './idle.ts';

export interface DeploymentScalingPolicy {
  min?: number;
  max?: number;
  scaleUpWindowMs?: number;
  scaleDownWindowMs?: number;
}

interface NormalizedDeploymentScalingPolicy {
  min: number;
  max: number | null;
  scaleUpWindowMs: number;
  scaleDownWindowMs: number;
}

function normalizeDeploymentScalingPolicy(
  policy: DeploymentScalingPolicy | undefined,
  reactorCapacity: number
): NormalizedDeploymentScalingPolicy {
  if (!Number.isInteger(reactorCapacity) || reactorCapacity < 1) {
    throw new TypeError('reactor capacity must be a positive integer');
  }
  const min = policy?.min ?? 1;
  const max = policy?.max ?? null;
  if (!Number.isInteger(min) || min < 1) throw new TypeError('scaling minimum must be a positive integer');
  if (max !== null && (!Number.isInteger(max) || max < 1)) throw new TypeError('scaling maximum must be a positive integer');
  if (max !== null && min > max) throw new RangeError('scaling minimum cannot exceed maximum');
  if (min > reactorCapacity) throw new RangeError('scaling minimum exceeds eligible cluster capacity');
  if (max !== null && max > reactorCapacity) throw new RangeError('scaling maximum exceeds eligible cluster capacity');
  const scaleUpWindowMs = nonNegative(policy?.scaleUpWindowMs ?? 1_000, 'scale-up window');
  const scaleDownWindowMs = nonNegative(policy?.scaleDownWindowMs ?? 30_000, 'scale-down window');
  return { min, max, scaleUpWindowMs, scaleDownWindowMs };
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`);
  return value;
}

interface ReplicaRecord<T> {
  value: T;
  /** Admission holds + the scale-down idle timer for this replica. */
  idle: IdleRetirement;
}

/** An exclusive admission lease for one deployment replica. */
export interface ReplicaLease<T> {
  readonly value: T;
  release(): void;
}

/** Construction and lifecycle hooks for a deployment controller. */
export interface DeploymentControllerOptions<T> {
  scaling?: DeploymentScalingPolicy;
  /** Current aggregate admission capacity of eligible cluster nodes. */
  capacity(): number;
  create(): T | Promise<T>;
  dispose(value: T): void;
  /** Called exactly once when the deployment releases orchestration. */
  onTerminate?(): void;
}

/** Owns replica admission and scaling for one logical deployment. */
export class DeploymentController<T> {
  readonly ready: Promise<void>;
  #records: ReplicaRecord<T>[] = [];
  #waiters = new Set<() => void>();
  #create: () => T | Promise<T>;
  #dispose: (value: T) => void;
  #min: number;
  #max: number | null;
  #capacity: () => number;
  #scaleUpWindowMs: number;
  #scaleDownWindowMs: number;
  #scaleUp: Promise<ReplicaRecord<T>> | null = null;
  #closed = false;
  #onTerminate: (() => void) | null;

  constructor(options: DeploymentControllerOptions<T>) {
    const capacity = options.capacity();
    const policy = normalizeDeploymentScalingPolicy(options.scaling, capacity);
    this.#create = options.create;
    this.#dispose = options.dispose;
    this.#min = policy.min;
    this.#max = policy.max;
    this.#capacity = options.capacity;
    this.#scaleUpWindowMs = policy.scaleUpWindowMs;
    this.#scaleDownWindowMs = policy.scaleDownWindowMs;
    this.#onTerminate = options.onTerminate ?? null;
    this.ready = this.#ensureMinimum().catch((error) => {
      this.terminate();
      throw error;
    });
  }

  /** Snapshot the currently allocated replica values. */
  values(): T[] {
    return this.#records.map((record) => record.value);
  }

  /** Wait for and exclusively admit work to one replica. */
  async acquire(): Promise<ReplicaLease<T>> {
    if (this.#closed) throw new Error('RealmDeployment has been terminated');
    await this.ready;
    while (!this.#closed) {
      const idle = this.#records.find((record) => record.idle.held === 0);
      if (idle !== undefined) return this.#lease(idle);
      if (this.#records.length < this.#currentMaximum()) {
        const released = await this.#waitForRelease(this.#scaleUpWindowMs);
        if (released) continue;
        this.#scaleUp ??= this.#spawn().finally(() => { this.#scaleUp = null; });
        const record = await this.#scaleUp;
        if (record.idle.held === 0) return this.#lease(record);
        continue;
      }
      await this.#waitForRelease();
    }
    throw new Error('RealmDeployment has been terminated');
  }

  /** Temporarily retain every ready replica, used for deployment broadcasts. */
  async acquireAll(): Promise<ReplicaLease<T>[]> {
    if (this.#closed) throw new Error('RealmDeployment has been terminated');
    await this.ready;
    return this.#records.map((record) => this.#lease(record));
  }

  /** Dispose every replica and reject future admission. */
  terminate(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
    for (const record of this.#records.splice(0)) this.#retire(record);
    const onTerminate = this.#onTerminate;
    this.#onTerminate = null;
    onTerminate?.();
  }

  async #ensureMinimum(): Promise<void> {
    while (!this.#closed && this.#records.length < this.#min) await this.#spawn();
  }

  async #spawn(): Promise<ReplicaRecord<T>> {
    if (this.#closed) throw new Error('RealmDeployment has been terminated');
    const value = await this.#create();
    const record: ReplicaRecord<T> = {
      value,
      idle: null as unknown as IdleRetirement
    };
    record.idle = new IdleRetirement({
      delayMs: this.#scaleDownWindowMs,
      shouldRetire: () => this.#records.indexOf(record) >= this.#min,
      retire: () => {
        const current = this.#records.indexOf(record);
        if (current < 0) return;
        this.#records.splice(current, 1);
        this.#dispose(record.value);
      }
    });
    if (this.#closed) {
      this.#dispose(record.value);
      throw new Error('RealmDeployment has been terminated');
    }
    this.#records.push(record);
    return record;
  }

  #lease(record: ReplicaRecord<T>): ReplicaLease<T> {
    record.idle.retain();
    let released = false;
    return {
      value: record.value,
      release: () => {
        if (released) return;
        released = true;
        this.#release(record);
      }
    };
  }

  #release(record: ReplicaRecord<T>): void {
    record.idle.release();
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  #retire(record: ReplicaRecord<T>): void {
    record.idle.cancel();
    this.#dispose(record.value);
  }

  #currentMaximum(): number {
    const capacity = Math.max(0, Math.floor(this.#capacity()));
    return this.#max === null ? capacity : Math.min(this.#max, capacity);
  }

  #waitForRelease(timeout?: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => {
        if (!this.#waiters.delete(wake)) return;
        if (timer !== null) clearTimeout(timer);
        resolve(true);
      };
      this.#waiters.add(wake);
      if (timeout !== undefined) {
        timer = setTimeout(() => {
          if (!this.#waiters.delete(wake)) return;
          resolve(false);
        }, timeout);
      }
    });
  }
}
