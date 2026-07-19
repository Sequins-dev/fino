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
import { availableParallelism } from 'internal:process';
import { normalizeDeploymentScalingPolicy, type DeploymentScalingPolicy } from 'internal:orchestrator/scaling';

interface ReplicaRecord<T> {
  value: T;
  active: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** An exclusive admission lease for one deployment replica. */
export interface ReplicaLease<T> {
  readonly value: T;
  release(): void;
}

/** Construction and lifecycle hooks for a deployment controller. */
export interface DeploymentControllerOptions<T> {
  scaling?: DeploymentScalingPolicy;
  create(): T | Promise<T>;
  dispose(value: T): void;
}

/** Owns replica admission and scaling for one logical deployment. */
export class DeploymentController<T> {
  readonly ready: Promise<void>;
  #records: ReplicaRecord<T>[] = [];
  #waiters = new Set<() => void>();
  #create: () => T | Promise<T>;
  #dispose: (value: T) => void;
  #min: number;
  #max: number;
  #scaleUpWindowMs: number;
  #scaleDownWindowMs: number;
  #scaleUp: Promise<ReplicaRecord<T>> | null = null;
  #closed = false;

  constructor(options: DeploymentControllerOptions<T>) {
    const capacity = Math.max(1, availableParallelism, options.scaling?.min ?? 0, options.scaling?.max ?? 0);
    const policy = normalizeDeploymentScalingPolicy(options.scaling, capacity);
    this.#create = options.create;
    this.#dispose = options.dispose;
    this.#min = policy.min;
    this.#max = policy.max;
    this.#scaleUpWindowMs = policy.scaleUpWindowMs;
    this.#scaleDownWindowMs = policy.scaleDownWindowMs;
    this.ready = this.#ensureMinimum();
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
      const idle = this.#records.find((record) => record.active === 0);
      if (idle !== undefined) return this.#lease(idle);
      if (this.#records.length < this.#max) {
        const released = await this.#waitForRelease(this.#scaleUpWindowMs);
        if (released) continue;
        this.#scaleUp ??= this.#spawn().finally(() => { this.#scaleUp = null; });
        const record = await this.#scaleUp;
        if (record.active === 0) return this.#lease(record);
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
  }

  async #ensureMinimum(): Promise<void> {
    while (!this.#closed && this.#records.length < this.#min) await this.#spawn();
  }

  async #spawn(): Promise<ReplicaRecord<T>> {
    if (this.#closed) throw new Error('RealmDeployment has been terminated');
    const record: ReplicaRecord<T> = {
      value: await this.#create(),
      active: 0,
      idleTimer: null
    };
    if (this.#closed) {
      this.#dispose(record.value);
      throw new Error('RealmDeployment has been terminated');
    }
    this.#records.push(record);
    return record;
  }

  #lease(record: ReplicaRecord<T>): ReplicaLease<T> {
    if (record.idleTimer !== null) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }
    record.active++;
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
    record.active = Math.max(0, record.active - 1);
    const index = this.#records.indexOf(record);
    if (record.active === 0 && index >= this.#min && record.idleTimer === null) {
      record.idleTimer = setTimeout(() => {
        record.idleTimer = null;
        const current = this.#records.indexOf(record);
        if (record.active !== 0 || current < this.#min) return;
        this.#records.splice(current, 1);
        this.#retire(record);
      }, this.#scaleDownWindowMs);
    }
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  #retire(record: ReplicaRecord<T>): void {
    if (record.idleTimer !== null) clearTimeout(record.idleTimer);
    this.#dispose(record.value);
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
