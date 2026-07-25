/**
* internal:orchestrator/node — authoritative node placement state.
*
* This collection records reactors, realms, load summaries, and in-progress
* movement reservations. Runnable state belongs exclusively to each reactor.
*
* @internal
*/
export type RealmId = string;
export type PriorityClass = 'interactive' | 'service' | 'background';

export type ReactorClass = 'latency' | 'batch';

/** A realm workload's placement config: the serialized realm. */
export interface RealmWorkloadSpec {
  entryPath: string;
  /** The realm's complete serialized import rules (parent-inherited). */
  rulesJson: string;
  /** JSON-serialized RealmOptions.data, if any. */
  realmData?: string;
  /** Runtime-owned bootstrap metadata JSON, if any. */
  bootstrapData?: string;
  /** Restart the logical deployment when its loaded files change. */
  watch?: boolean;
  /** Bootstrap the replica as a REPL evaluator. */
  repl?: boolean;
  priority?: PriorityClass;
}

/** Authoritative placement record for one realm. */
export interface RealmRecord {
  id: RealmId;
  engineId: number;
  reactorId: string;
  spec: RealmWorkloadSpec;
  moveTo: string | null;
  released: Promise<string>;
  release(reason: string): void;
}

interface ReactorRecord {
  id: string;
  handle: number | null;
  capacity: number;
  reactorClass: ReactorClass;
  heldRealms: number;
  runnableRealms: number;
  debtMicros: number;
}

/** Main-thread state used by the node orchestrator for coarse placement. */
export class NodeRealmCollection {
  #reactors = new Map<string, ReactorRecord>();
  #realms = new Map<RealmId, RealmRecord>();
  #roundRobin = 0;

  registerReactor(id: string, capacity: number, reactorClass: ReactorClass = 'latency'): void {
    if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError('reactor capacity must be a positive integer');
    this.#reactors.set(id, {
      id,
      handle: null,
      capacity,
      reactorClass,
      heldRealms: 0,
      runnableRealms: 0,
      debtMicros: 0
    });
  }

  unregisterReactor(id: string): void {
    this.#reactors.delete(id);
  }

  reactorIds(): string[] {
    return [...this.#reactors.keys()];
  }

  reactorHandle(id: string): number | null {
    return this.#reactors.get(id)?.handle ?? null;
  }

  setReactorHandle(id: string, handle: number | null): void {
    const reactor = this.#reactors.get(id);
    if (reactor !== undefined) reactor.handle = handle;
  }

  allocate(engineId: number, spec: RealmWorkloadSpec): RealmRecord {
    const priority = spec.priority ?? 'service';
    // Background realms live on the batch pool so they never contend with
    // latency-class work; fall back to latency only when no batch reactor
    // can take them.
    const preferred: ReactorClass = priority === 'background' ? 'batch' : 'latency';
    let reactorId = this.#leastLoaded(null, preferred);
    if (reactorId === null && preferred === 'batch') reactorId = this.#leastLoaded(null, 'latency');
    if (reactorId === null) throw new Error('cannot place realm: all reactors are at capacity');
    const id = `realm-${engineId}`;
    let release!: (reason: string) => void;
    const record: RealmRecord = {
      id,
      engineId,
      reactorId,
      spec,
      moveTo: null,
      released: new Promise((resolve) => { release = resolve; }),
      release
    };
    this.#realms.set(id, record);
    return record;
  }

  release(id: RealmId, reason: string): void {
    const record = this.#realms.get(id);
    if (record === undefined) return;
    this.#realms.delete(id);
    record.release(reason);
  }

  record(id: RealmId): RealmRecord | undefined {
    return this.#realms.get(id);
  }

  recordByEngineId(engineId: number): RealmRecord | undefined {
    return this.#realms.get(`realm-${engineId}`);
  }

  realmIds(): RealmId[] {
    return [...this.#realms.keys()];
  }

  placementOf(id: RealmId): string | null {
    return this.#realms.get(id)?.reactorId ?? null;
  }

  reserveMove(id: RealmId, destination: string): boolean {
    const record = this.#realms.get(id);
    if (record === undefined || record.moveTo !== null || !this.#hasRoom(destination)) return false;
    record.moveTo = destination;
    return true;
  }

  cancelMove(id: RealmId): void {
    const record = this.#realms.get(id);
    if (record !== undefined) record.moveTo = null;
  }

  commitMove(id: RealmId, destination: string): boolean {
    const record = this.#realms.get(id);
    if (record === undefined || record.moveTo !== destination) return false;
    record.reactorId = destination;
    record.moveTo = null;
    return true;
  }

  hasMoveReservations(reactorId: string): boolean {
    for (const realm of this.#realms.values()) if (realm.moveTo === reactorId) return true;
    return false;
  }

  recordLoad(reactorId: string, heldRealms: number, runnableRealms: number, debtMicros: number): void {
    const reactor = this.#reactors.get(reactorId);
    if (reactor !== undefined) Object.assign(reactor, { heldRealms, runnableRealms, debtMicros });
  }

  reactorClassOf(id: string): ReactorClass | null {
    return this.#reactors.get(id)?.reactorClass ?? null;
  }

  assignedTo(id: string): number {
    let count = 0;
    for (const realm of this.#realms.values()) {
      if (realm.reactorId === id) count++;
      if (realm.moveTo === id) count++;
    }
    return count;
  }

  realmsOn(reactorId: string): RealmId[] {
    return [...this.#realms.values()].filter((realm) => realm.reactorId === reactorId).map((realm) => realm.id);
  }

  leastLoaded(exclude: string | null): string | null {
    return this.#leastLoaded(exclude);
  }

  leastLoadedOfClass(reactorClass: ReactorClass, exclude?: string): string | null {
    return this.#leastLoaded(exclude ?? null, reactorClass);
  }

  #hasRoom(id: string): boolean {
    const reactor = this.#reactors.get(id);
    return reactor !== undefined && this.assignedTo(id) < reactor.capacity;
  }

  #leastLoaded(exclude: string | null, reactorClass?: ReactorClass): string | null {
    const eligible = [...this.#reactors.values()].filter((reactor) =>
      reactor.id !== exclude &&
      (reactorClass === undefined || reactor.reactorClass === reactorClass) &&
      this.#hasRoom(reactor.id)
    );
    if (eligible.length === 0) return null;
    let best = eligible[0]!;
    let bestKey = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < eligible.length; offset++) {
      const reactor = eligible[(this.#roundRobin + offset) % eligible.length]!;
      const key = this.assignedTo(reactor.id) * 1e6 + reactor.runnableRealms * 1e3 + Math.min(reactor.debtMicros, 999);
      if (key < bestKey) {
        best = reactor;
        bestKey = key;
      }
    }
    this.#roundRobin++;
    return best.id;
  }
}
