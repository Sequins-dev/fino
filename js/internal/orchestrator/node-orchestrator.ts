/**
* internal:orchestrator/node-orchestrator — owns a node's reactor threads and
* drives them over a push control channel.
*
* A `NodeOrchestrator` owns the node's native reactor threads and records each
* realm's authoritative placement. Reactors push lifecycle and coarse load
* reports back to this owner; runnable selection never leaves the reactor.
*
* @internal
*/
import * as engine from 'internal:reactor-engine';
import { terminateArmedBudgets } from 'internal:reactor/workload';
import { availableParallelism, env } from 'internal:process';
import {
  NodeRealmCollection,
  type PriorityClass,
  type RealmId,
  type RealmWorkloadSpec
} from './node.ts';
import { startBudgetWatchdog } from './budget-watchdog.ts';

export type { RealmWorkloadSpec } from './node.ts';

/** Priority class → the engine's numeric priority (compareRunnable). */
const PRIORITY_CLASS: Record<PriorityClass, number> = { interactive: 0, service: 1, background: 2 };

/** One engine report drained from a reactor's report channel. */
type EngineReport =
  | { type: 'released'; workloadId: number; reason: string }
  | { type: 'syncHeavy'; workloadId: number; cpuMicros: number }
  | { type: 'load'; held: number; runnable: number; debtMicros: number }
  | { type: 'moved'; workloadId: number }
  | { type: 'moveRejected'; workloadId: number; reason: string };

interface RealmPorts {
  portHandle: number;
  portWakeFd: number;
  allocationPortHandle: number;
  allocationPortWakeFd: number;
}

/** One admitted realm and its complete node-owned lifecycle. */
export interface RealmWorkloadAllocation extends RealmPorts {
  workloadId: RealmId;
  released: Promise<string>;
  revoke(reason: string): void;
}

/** Result of attempting to move one live isolate between local reactors. */
export type MoveOutcome =
  | { status: 'moved'; fromReactorId: string; toReactorId: string }
  | { status: 'deferred'; reason: string };

/** How many reactors to boot and how much each may hold. */
export interface NodeOrchestratorOptions {
  /** Number of latency-sensitive reactors. Defaults to native parallelism minus the reserved batch reactor. */
  reactorCount?: number;
  /** Batch reactor pool. By default one reactor is reserved when native parallelism exceeds one. */
  batchPool?: {
    /** Batch reactors created at startup. Defaults to the reserved reactor described above. */
    minReactors?: number;
    /** Maximum batch reactors, including warm reactors. Defaults to at least one and never below `minReactors`. */
    maxReactors?: number;
    /** Idle retirement delay in milliseconds. Defaults to 30 seconds. */
    idleTimeoutMs?: number;
  };
  /** Per-reactor workload capacity. Defaults to 8. */
  capacity?: number;
  /** Hard per-pump-slice runaway budget (µs) passed to each reactor. */
  hardBudgetMicros?: number;
  /** Soft blocking limit (µs) per pump slice; repeated overruns move a movable workload to batch. */
  syncSliceThresholdMicros?: number;
  /** Per-workload heap cap (bytes); nearing it terminates the workload rather than OOMing the process. */
  heapLimitBytes?: number;
}

function envInt(name: string): number | undefined {
  const raw = (env as Record<string, string | undefined>)[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
* Resolve the node's orchestrator tuning from the process environment, with
* the built-in defaults for anything unset. This is the production config
* seam: every knob the constructor accepts is reachable without code.
*/
export function resolveNodeOrchestratorOptions(): NodeOrchestratorOptions {
  return {
    reactorCount: envInt('FINO_REACTOR_COUNT'),
    capacity: envInt('FINO_REACTOR_CAPACITY') ?? 8,
    hardBudgetMicros: envInt('FINO_REACTOR_HARD_BUDGET_MICROS'),
    syncSliceThresholdMicros: envInt('FINO_REACTOR_SYNC_SLICE_MICROS'),
    heapLimitBytes: envInt('FINO_REALM_HEAP_LIMIT_BYTES'),
    batchPool: {
      minReactors: envInt('FINO_BATCH_REACTORS_MIN'),
      maxReactors: envInt('FINO_BATCH_REACTORS_MAX'),
      idleTimeoutMs: envInt('FINO_BATCH_IDLE_TIMEOUT_MS')
    }
  };
}

/**
* Node-level owner for reactor lifecycle, realm placement, and movement.
*/
export class NodeOrchestrator {
  #collection = new NodeRealmCollection();
  #capacity: number;
  #hardBudgetMicros: number | undefined;
  #syncSliceThresholdMicros: number | undefined;
  #heapLimitBytes: number | undefined;
  #batchMinReactors: number;
  #batchMaxReactors: number;
  #batchIdleTimeoutMs: number;
  #batchSeq = 0;
  #batchIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #stopWatchdog: (() => void) | null = null;
  #started = false;
  #shuttingDown = false;
  #closed = false;
  #pendingMoves = new Map<RealmId, {
    fromReactorId: string;
    toReactorId: string;
    resolve(outcome: MoveOutcome): void;
  }>();
  #previousBlockingSample = new Map<RealmId, number>();
  #engineIdSeq = 1;

  constructor(options: NodeOrchestratorOptions = {}) {
    const hardwareParallelism = availableParallelism;
    const defaultBatchReactors = options.reactorCount === undefined && hardwareParallelism > 1 ? 1 : 0;
    const reactorCount = options.reactorCount ?? hardwareParallelism - defaultBatchReactors;
    if (!Number.isInteger(reactorCount) || reactorCount < 1) {
      throw new TypeError('reactorCount must be a positive integer');
    }
    this.#capacity = options.capacity ?? 8;
    this.#hardBudgetMicros = options.hardBudgetMicros;
    this.#syncSliceThresholdMicros = options.syncSliceThresholdMicros;
    this.#heapLimitBytes = options.heapLimitBytes;
    const minBatchReactors = options.batchPool?.minReactors ?? defaultBatchReactors;
    const maxBatchReactors = options.batchPool?.maxReactors ?? Math.max(1, minBatchReactors);
    const batchIdleTimeoutMs = options.batchPool?.idleTimeoutMs ?? 30_000;
    if (!Number.isInteger(minBatchReactors) || minBatchReactors < 0) {
      throw new TypeError('batchPool.minReactors must be a non-negative integer');
    }
    if (!Number.isInteger(maxBatchReactors) || maxBatchReactors < minBatchReactors) {
      throw new TypeError('batchPool.maxReactors must be an integer no smaller than minReactors');
    }
    if (!Number.isFinite(batchIdleTimeoutMs) || batchIdleTimeoutMs < 0) {
      throw new TypeError('batchPool.idleTimeoutMs must be a non-negative number');
    }
    this.#batchMinReactors = minBatchReactors;
    this.#batchMaxReactors = maxBatchReactors;
    this.#batchIdleTimeoutMs = batchIdleTimeoutMs;
    for (let i = 0; i < reactorCount; i++) {
      const reactorName = `reactor-${i}`;
      this.#collection.registerReactor(reactorName, this.#capacity, 'latency');
    }
    for (let i = 0; i < minBatchReactors; i++) {
      const reactorName = `batch-${this.#batchSeq++}`;
      this.#collection.registerReactor(reactorName, this.#capacity, 'batch');
    }
  }

  /** The node's authoritative realm-placement collection. */
  collection(): NodeRealmCollection {
    return this.#collection;
  }

  /** The ids of the node's reactors. */
  reactorIds(): string[] {
    return this.#collection.reactorIds();
  }

  /** Aggregate admission slots on latency reactors eligible for new realms. */
  admissionCapacity(): number {
    if (this.#closed) return 0;
    return this.reactorIds().filter((id) => this.#collection.reactorClassOf(id) === 'latency').length * this.#capacity;
  }

  /** Boot the native reactor threads and start runaway containment. */
  #start(): void {
    if (this.#closed) throw new Error('NodeOrchestrator is one-shot and has been shut down');
    if (this.#started) return;
    this.#started = true;
    this.#stopWatchdog = startBudgetWatchdog();
    for (const reactorName of this.reactorIds()) this.#spawnReactor(reactorName);
  }

  #spawnReactor(reactorName: string): void {
    const config = {
      ...this.#hardBudgetMicros !== undefined ? { hardBudgetMicros: this.#hardBudgetMicros } : {},
      ...this.#syncSliceThresholdMicros !== undefined ? { syncSliceMicros: this.#syncSliceThresholdMicros } : {},
      ...this.#heapLimitBytes !== undefined ? { heapLimitBytes: this.#heapLimitBytes } : {},
      reactorClass: this.#collection.reactorClassOf(reactorName) ?? 'latency'
    };
    const reactorId = engine.spawnReactor(config);
    this.#collection.setReactorHandle(reactorName, reactorId);
    void this.#pumpReports(reactorName, reactorId);
  }

  #provisionBatchReactor(): string | null {
    const existing = this.reactorIds().filter((id) => this.#collection.reactorClassOf(id) === 'batch');
    if (existing.length >= this.#batchMaxReactors) return null;
    const reactorName = `batch-${this.#batchSeq++}`;
    this.#collection.registerReactor(reactorName, this.#capacity, 'batch');
    if (this.#started) this.#spawnReactor(reactorName);
    return reactorName;
  }

  #cancelBatchRetirement(reactorName: string): void {
    const timer = this.#batchIdleTimers.get(reactorName);
    if (timer !== undefined) clearTimeout(timer);
    this.#batchIdleTimers.delete(reactorName);
  }

  #scheduleBatchRetirement(reactorName: string): void {
    if (this.#collection.reactorClassOf(reactorName) !== 'batch') return;
    const batchCount = this.reactorIds().filter((id) => this.#collection.reactorClassOf(id) === 'batch').length;
    if (batchCount <= this.#batchMinReactors) return;
    this.#cancelBatchRetirement(reactorName);
    const timer = setTimeout(() => {
      this.#batchIdleTimers.delete(reactorName);
      if (this.#shuttingDown || this.#collection.assignedTo(reactorName) !== 0 || this.#collection.hasMoveReservations(reactorName)) return;
      const remainingBatch = this.reactorIds().filter((id) => this.#collection.reactorClassOf(id) === 'batch').length;
      if (remainingBatch <= this.#batchMinReactors) return;
      const handle = this.#reactorFor(reactorName);
      this.#collection.unregisterReactor(reactorName);
      if (handle !== null) {
        engine.shutdown(handle);
        engine.joinReactor(handle);
      }
    }, this.#batchIdleTimeoutMs);
    this.#batchIdleTimers.set(reactorName, timer);
  }

  /**
  * Drain a reactor's report channel on the orchestrator loop for the reactor's
  * lifetime. `nextReport` resolves when the engine reactor posts a report wake —
  * and once more when the reactor exits, so the loop sees the reactor gone
  * (empty drain + not alive) and exits.
  */
  async #pumpReports(reactorName: string, reactorId: number): Promise<void> {
    while (this.#reactorFor(reactorName) !== null && !this.#shuttingDown) {
      await engine.nextReport(reactorId);
      if (this.#reactorFor(reactorName) !== reactorId) break;
      const reports = engine.drainReports(reactorId) as EngineReport[];
      for (const report of reports) this.#onEngineReport(reactorName, report);
      // A dead reactor wakes its pump one final time with nothing queued.
      if (reports.length === 0 && !engine.reactorAlive(reactorId)) {
        if (!this.#shuttingDown) this.#recover(reactorName);
        break;
      }
    }
  }

  #recover(reactorName: string): void {
    const reactorId = this.#reactorFor(reactorName);
    if (reactorId === null) return;
    this.#collection.setReactorHandle(reactorName, null);
    for (const [realmId, pending] of this.#pendingMoves) {
      if (pending.fromReactorId !== reactorName && pending.toReactorId !== reactorName) continue;
      this.#pendingMoves.delete(realmId);
      this.#collection.cancelMove(realmId);
      pending.resolve({ status: 'deferred', reason: 'reactor-exited' });
    }
    // A hard reactor loss also loses its isolates. Settle their allocations so
    // Realm or RealmDeployment can reconstruct cleanly on a later call.
    const lost = this.#collection.realmsOn(reactorName);
    for (const workloadId of lost) {
      this.#collection.release(workloadId, 'reactor-exited');
    }
    engine.joinReactor(reactorId);
    this.#spawnReactor(reactorName);
  }

  /** Fold one engine report into the authoritative collection. */
  #onEngineReport(reactorName: string, report: EngineReport): void {
    if (this.#reactorFor(reactorName) === null) return;
    switch (report.type) {
      case 'load':
        this.#collection.recordLoad(reactorName, report.held, report.runnable, report.debtMicros);
        return;
      case 'syncHeavy':
        return this.#onSyncHeavyReport(report);
      case 'moved':
        return this.#onMovedReport(reactorName, report);
      case 'moveRejected':
        return this.#onMoveRejectedReport(report);
      case 'released':
        return this.#onReleasedReport(reactorName, report);
    }
  }

  #workloadForReport(report: EngineReport): RealmId | undefined {
    return 'workloadId' in report ? this.#collection.recordByEngineId(report.workloadId)?.id : undefined;
  }

  #onSyncHeavyReport(report: EngineReport): void {
    const workloadId = this.#workloadForReport(report);
    if (workloadId === undefined) return;
    const current = this.#collection.placementOf(workloadId);
    if (current === null || this.#collection.reactorClassOf(current) !== 'latency') return;
    const now = Date.now();
    const previous = this.#previousBlockingSample.get(workloadId);
    if (previous === undefined || now - previous > 1_000) {
      this.#previousBlockingSample.set(workloadId, now);
      return;
    }
    this.#previousBlockingSample.delete(workloadId);
    const existing = this.#collection.leastLoadedOfClass('batch');
    const batch = existing ?? this.#provisionBatchReactor();
    if (batch !== null) void this.move(workloadId, batch).then((outcome) => {
      if (existing === null && outcome.status !== 'moved') this.#scheduleBatchRetirement(batch);
    });
  }

  #onMovedReport(reactorName: string, report: EngineReport): void {
    const workloadId = this.#workloadForReport(report);
    if (workloadId === undefined) return;
    const pending = this.#pendingMoves.get(workloadId);
    if (pending === undefined || pending.toReactorId !== reactorName) return;
    this.#pendingMoves.delete(workloadId);
    this.#collection.commitMove(workloadId, reactorName);
    pending.resolve({
      status: 'moved',
      fromReactorId: pending.fromReactorId,
      toReactorId: pending.toReactorId
    });
  }

  #onMoveRejectedReport(report: EngineReport): void {
    const workloadId = this.#workloadForReport(report);
    if (workloadId === undefined) return;
    const pending = this.#pendingMoves.get(workloadId);
    if (pending === undefined) return;
    this.#pendingMoves.delete(workloadId);
    this.#collection.cancelMove(workloadId);
    pending.resolve({ status: 'deferred', reason: report.reason });
  }

  #onReleasedReport(reactorName: string, report: EngineReport): void {
    const workloadId = this.#workloadForReport(report);
    if (workloadId === undefined) return;
    const pendingMove = this.#pendingMoves.get(workloadId);
    if (pendingMove !== undefined) {
      this.#pendingMoves.delete(workloadId);
      this.#collection.cancelMove(workloadId);
      pendingMove.resolve({ status: 'deferred', reason: 'source-released' });
    }
    const reason = report.reason;
    this.#previousBlockingSample.delete(workloadId);
    this.#collection.release(workloadId, reason);
    this.#scheduleBatchRetirement(reactorName);
  }

  /**
  * Move a live isolate to another local reactor. The realm id,
  * module heap, port, active lease, and pending async state remain unchanged.
  */
  move(workloadId: RealmId, toReactorId?: string): Promise<MoveOutcome> {
    const fromReactorId = this.#collection.placementOf(workloadId);
    if (fromReactorId === null) return Promise.resolve({ status: 'deferred', reason: 'not-placed' });
    if (this.#pendingMoves.has(workloadId)) {
      return Promise.resolve({ status: 'deferred', reason: 'move-in-progress' });
    }
    const target = toReactorId ?? this.#collection.leastLoaded(fromReactorId);
    if (target === null) return Promise.resolve({ status: 'deferred', reason: 'destination-capacity' });
    if (target === fromReactorId) return Promise.resolve({ status: 'deferred', reason: 'already-placed' });
    if (!this.#collection.reserveMove(workloadId, target)) {
      return Promise.resolve({ status: 'deferred', reason: 'destination-capacity' });
    }
    this.#cancelBatchRetirement(target);
    const sourceReactor = this.#reactorFor(fromReactorId);
    const destinationReactor = this.#reactorFor(target);
    if (sourceReactor === null || destinationReactor === null) {
      this.#collection.cancelMove(workloadId);
      return Promise.resolve({ status: 'deferred', reason: 'reactor-unavailable' });
    }
    return new Promise<MoveOutcome>((resolve) => {
      this.#pendingMoves.set(workloadId, { fromReactorId, toReactorId: target, resolve });
      try {
        engine.moveRealm(sourceReactor, destinationReactor, this.#engineId(workloadId));
      } catch {
        this.#pendingMoves.delete(workloadId);
        this.#collection.cancelMove(workloadId);
        resolve({ status: 'deferred', reason: 'move-start-failed' });
      }
    });
  }

  /**
  * Place a realm — a full child execution container hosted on a reactor.
  * Returns the workload id plus the parent-side channel half (the caller
  * constructs the Realm's port over it), or `null` when the node has no
  * capacity.
  */
  #ensureBatchReactorFor(spec: RealmWorkloadSpec): void {
    if (spec.priority !== 'background') return;
    const existing = this.reactorIds().some((id) => this.#collection.reactorClassOf(id) === 'batch');
    if (!existing) this.#provisionBatchReactor();
  }

  async allocateRealm(spec: RealmWorkloadSpec): Promise<RealmWorkloadAllocation | null> {
    this.#start();
    this.#ensureBatchReactorFor(spec);
    let record;
    try {
      record = this.#collection.allocate(this.#engineIdSeq++, spec);
    } catch {
      return null;
    }
    const workloadId = record.id;
    const port = this.#placeOnEngine(workloadId);
    if (port === null) {
      this.#collection.release(workloadId, 'placement-failed');
      return null;
    }
    return {
      workloadId,
      ...port,
      released: record.released,
      revoke: (reason: string) => this.#revoke(workloadId, reason)
    };
  }

  /** The reactor id hosting `reactorName`, or null. */
  #reactorFor(reactorName: string): number | null {
    return this.#collection.reactorHandle(reactorName);
  }

  /** The engine's numeric id for a realm. */
  #engineId(workloadId: RealmId): number {
    return this.#collection.record(workloadId)!.engineId;
  }

  /** Construct one realm on its assigned reactor. */
  #placeOnEngine(workloadId: RealmId): RealmPorts | null {
    const record = this.#collection.record(workloadId);
    if (record === undefined) return null;
    const reactorId = this.#reactorFor(record.reactorId);
    if (reactorId === null) return null;
    const realmSpec = record.spec;
    const info = engine.placeRealm(reactorId, {
      realmId: record.engineId,
      entryPath: realmSpec.entryPath,
      rulesJson: realmSpec.rulesJson,
      ...realmSpec.realmData !== undefined ? { data: realmSpec.realmData } : {},
      ...realmSpec.bootstrapData !== undefined ? { bootstrapData: realmSpec.bootstrapData } : {},
      priority: PRIORITY_CLASS[realmSpec.priority ?? 'service'],
      watch: realmSpec.watch === true,
      repl: realmSpec.repl === true
    }) as RealmPorts;
    return info;
  }

  /** Revoke a workload on its hosting reactor. */
  #revoke(workloadId: RealmId, reason: string): void {
    const reactorName = this.#collection.placementOf(workloadId);
    if (reactorName === null) return;
    const reactorId = this.#reactorFor(reactorName);
    if (reactorId !== null) engine.revoke(reactorId, this.#engineId(workloadId), reason);
  }

  /** Shut down and join every reactor, then stop runaway containment. */
  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#shuttingDown = true;
    for (const timer of this.#batchIdleTimers.values()) clearTimeout(timer);
    this.#batchIdleTimers.clear();
    const handles = this.reactorIds()
      .map((id) => this.#reactorFor(id))
      .filter((id): id is number => id !== null);
    for (const [workloadId, pending] of this.#pendingMoves) {
      this.#collection.cancelMove(workloadId);
      pending.resolve({ status: 'deferred', reason: 'shutdown' });
    }
    this.#pendingMoves.clear();
    this.#previousBlockingSample.clear();
    // Signal every reactor to stop; the report pumps exit on the final wake
    // each reactor posts as it dies.
    for (const handle of handles) engine.shutdown(handle);
    terminateArmedBudgets();
    for (const handle of handles) engine.joinReactor(handle);
    for (const id of this.reactorIds()) this.#collection.setReactorHandle(id, null);
    this.#stopWatchdog?.();
    this.#stopWatchdog = null;
    // Settle outstanding allocation lifetimes rather than dangling supervisors.
    for (const workloadId of this.#collection.realmIds()) this.#collection.release(workloadId, 'shutdown');
  }

  /** Test hook: forcibly stop a reactor. */
  _killReactor(reactorName: string): void {
    const reactorId = this.#reactorFor(reactorName);
    if (reactorId !== null) engine.shutdown(reactorId);
  }

  /** Test hook: inject a panic at one realm's isolate boundary. */
  _crashRealm(workloadId: RealmId): void {
    const reactorName = this.#collection.placementOf(workloadId);
    if (reactorName === null) return;
    const reactorId = this.#reactorFor(reactorName);
    if (reactorId !== null) engine.crashRealm(reactorId, this.#engineId(workloadId));
  }

  /** Test hook: read the physical-worker generation behind a logical reactor. */
  _reactorGeneration(reactorName: string): number {
    const reactorId = this.#reactorFor(reactorName);
    return reactorId === null ? 0 : engine.reactorGeneration(reactorId) as number;
  }
}
