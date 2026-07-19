/**
* internal:orchestrator/node — authoritative node placement state.
*
* This collection records reactors, realms, load summaries, and in-progress
* movement reservations. Runnable state belongs exclusively to each reactor.
*
* @internal
*/
import type { PriorityClass, ReactorLoadSummary, RealmId } from './types.ts';

export type ReactorClass = 'latency' | 'batch';

/** Placement inputs retained so a realm can be reconstructed after reactor loss. */
export interface RealmPlacementSpec {
  entryPath: string;
  priority?: PriorityClass;
  localMobility?: 'movable' | 'pinned';
}

/** Authoritative placement record for one realm. */
export interface RealmRecord {
  id: RealmId;
  reactorId: string;
  entryPath: string;
  priority: PriorityClass;
  localMobility: 'movable' | 'pinned';
}

interface ReactorRecord {
  id: string;
  capacity: number;
  reactorClass: ReactorClass;
  load: ReactorLoadSummary;
}

/** Main-thread state used by the node orchestrator for coarse placement. */
export class NodeRealmCollection {
  #reactors = new Map<string, ReactorRecord>();
  #realms = new Map<RealmId, RealmRecord>();
  #reservations = new Map<RealmId, string>();
  #sequence = 0;
  #roundRobin = 0;

  registerReactor(id: string, capacity: number, reactorClass: ReactorClass = 'latency'): void {
    if (!Number.isInteger(capacity) || capacity < 1) throw new TypeError('reactor capacity must be a positive integer');
    this.#reactors.set(id, {
      id,
      capacity,
      reactorClass,
      load: { reactorId: id, heldRealms: 0, runnableRealms: 0, debtMicros: 0 }
    });
  }

  unregisterReactor(id: string): void {
    this.#reactors.delete(id);
  }

  allocate(spec: RealmPlacementSpec): RealmRecord {
    const reactorId = this.#leastLoaded(null, 'latency');
    if (reactorId === null) throw new Error('cannot place realm: all reactors are at capacity');
    const id = `realm-${this.#sequence++}`;
    const record: RealmRecord = {
      id,
      reactorId,
      entryPath: spec.entryPath,
      priority: spec.priority ?? 'service',
      localMobility: spec.localMobility ?? 'movable'
    };
    this.#realms.set(id, record);
    return record;
  }

  release(id: RealmId): void {
    this.#reservations.delete(id);
    this.#realms.delete(id);
  }

  record(id: RealmId): RealmRecord | undefined {
    return this.#realms.get(id);
  }

  placementOf(id: RealmId): string | null {
    return this.#realms.get(id)?.reactorId ?? null;
  }

  isLocallyMovable(id: RealmId): boolean {
    return this.#realms.get(id)?.localMobility === 'movable';
  }

  reserveMove(id: RealmId, destination: string): boolean {
    const record = this.#realms.get(id);
    if (record === undefined || this.#reservations.has(id) || !this.#hasRoom(destination)) return false;
    this.#reservations.set(id, destination);
    return true;
  }

  cancelMove(id: RealmId): void {
    this.#reservations.delete(id);
  }

  commitMove(id: RealmId, destination: string): boolean {
    const record = this.#realms.get(id);
    if (record === undefined || this.#reservations.get(id) !== destination) return false;
    record.reactorId = destination;
    this.#reservations.delete(id);
    return true;
  }

  hasMoveReservations(reactorId: string): boolean {
    for (const destination of this.#reservations.values()) if (destination === reactorId) return true;
    return false;
  }

  recordLoad(reactorId: string, summary: ReactorLoadSummary): void {
    const reactor = this.#reactors.get(reactorId);
    if (reactor !== undefined) reactor.load = summary;
  }

  reactorClassOf(id: string): ReactorClass | null {
    return this.#reactors.get(id)?.reactorClass ?? null;
  }

  assignedTo(id: string): number {
    let count = 0;
    for (const realm of this.#realms.values()) if (realm.reactorId === id) count++;
    for (const destination of this.#reservations.values()) if (destination === id) count++;
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
      const key = this.assignedTo(reactor.id) * 1e6 + reactor.load.runnableRealms * 1e3 + Math.min(reactor.load.debtMicros, 999);
      if (key < bestKey) {
        best = reactor;
        bestKey = key;
      }
    }
    this.#roundRobin++;
    return best.id;
  }
}
