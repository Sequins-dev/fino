/**
* internal:orchestrator/scheduler-node — boots a node's scheduler threads and
* drives them over a push control channel.
*
* A `SchedulerNode` registers N scheduler threads with a {@link
* NodeIsolateCollection} and boots each as a native reactor engine thread.
* Every workload — tenant or full child realm — is constructed on its engine
* through the one realm path (`placeRealm`); tenant activations are dispatched
* as `__tenant_dispatch` messages over a node-held port, and the results
* (`idle` / `terminated`) are classified here. Engine threads push
* `released` / `syncHeavy` / `load` reports back over the report channel, which
* the node folds into the one authoritative collection. App code never reaches
* this: it deploys a workload and the orchestrator decides which thread hosts
* it.
*
* @internal
*/
import * as engine from 'internal:reactor-engine';
import { ThreadPort } from 'internal:realm/transport-port';
import { NodeIsolateCollection, type NodeWorkloadSpec, type ReleaseReason } from './node.ts';
import { BudgetWatchdog } from './budget-watchdog.ts';
import type { LeaseRecord, PriorityClass, SchedulerShardSummary, ShardLoadSummary, TenantWake, WorkloadId } from '../scheduler/types.ts';

/** A realm workload's placement config: the serialized realm. */
export interface RealmWorkloadSpec {
  entryPath: string;
  /** The realm's complete serialized import rules (parent-inherited). */
  rulesJson: string;
  /** JSON-serialized RealmOptions.data, if any. */
  realmData?: string;
  /** Runtime-owned bootstrap metadata JSON, if any. */
  bootstrapData?: string;
  priority?: PriorityClass;
  tenantId?: string;
  /** Whether this live isolate may change local reactor threads. */
  localMobility?: 'movable' | 'pinned';
  /** Whether this realm can split into independent isolates. */
  replication?: 'replicated' | 'bound';
  /** Requested availability minimum for the future cluster reconciler. */
  scalingMin?: number;
  /** Optional requested replica ceiling. */
  scalingMax?: number;
}

/** Priority class → the engine's numeric priority (compareRunnable). */
const PRIORITY_CLASS: Record<PriorityClass, number> = { interactive: 0, service: 1, background: 2 };

/** A native reactor engine thread, plus liveness bookkeeping. */
interface ReactorHandle {
  reactorId: number;
  summary: SchedulerShardSummary;
  /** Wall-clock (ms) of this reactor's last report. */
  lastReport: number;
  /** True once declared dead and its workloads recovered. */
  dead: boolean;
}

/** One engine report drained from a reactor's report channel. */
interface EngineReport {
  type: 'released' | 'syncHeavy' | 'load' | 'moved' | 'detached' | 'started';
  workloadId?: number;
  reason?: string;
  cpuMicros?: number;
  held?: number;
  runnable?: number;
  debtBand?: number;
  debtMicros?: number;
}

/** Result of attempting to move one live isolate between local reactors. */
export type MoveOutcome =
  | { status: 'moved'; fromShardId: string; toShardId: string }
  | { status: 'deferred'; reason: string };

/** Release reasons that re-place a workload rather than terminating it. */
const RE_PLACING_REASONS = new Set<string>(['rebalanced', 'renew_failed']);

/** How many scheduler threads to boot and how much each may hold. */
export interface SchedulerNodeOptions {
  /** Number of latency-sensitive scheduler threads. Defaults to 2. */
  shardCount?: number;
  /**
  * Number of lower-priority batch threads created at startup. Defaults to 0.
  * @deprecated Use `batchPool.minThreads`; retained for existing internal callers.
  */
  batchThreads?: number;
  /** On-demand batch reactor pool. Defaults to zero warm and one maximum thread. */
  batchPool?: {
    /** Batch reactors created at startup. Defaults to 0. */
    minThreads?: number;
    /** Maximum batch reactors, including warm threads. Defaults to 1. */
    maxThreads?: number;
    /** Idle retirement delay in milliseconds. Defaults to 30 seconds. */
    idleTimeoutMs?: number;
  };
  /** Per-thread workload capacity. Defaults to 8. */
  capacity?: number;
  /** Cooperative accounting budget (µs) passed to each shard. */
  budgetMicros?: number;
  /** Hard per-pump-slice runaway budget (µs) passed to each shard. */
  hardBudgetMicros?: number;
  /** Liveness-heartbeat cadence (ms) for each shard; also sets the supervisor's stale threshold. */
  heartbeatMs?: number;
  /** @deprecated Load is reported on change now; ignored. */
  loadReportMs?: number;
  /** Soft blocking limit (µs) per pump slice; repeated overruns move a movable workload to batch. */
  syncSliceThresholdMicros?: number;
  /** Per-workload heap cap (bytes); nearing it terminates the workload rather than OOMing the process. */
  heapLimitBytes?: number;
}

/**
* A running scheduler node: N long-lived scheduler threads over one node isolate
* collection, coordinated by push.
*/
export class SchedulerNode {
  #collection = new NodeIsolateCollection();
  #shardIds: string[];
  #capacity: number;
  #budgetMicros?: number;
  #hardBudgetMicros?: number;
  #heartbeatMs?: number;
  #syncSliceThresholdMicros?: number;
  #heapLimitBytes?: number;
  #batchMinThreads: number;
  #batchMaxThreads: number;
  #batchIdleTimeoutMs: number;
  #batchSeq = 0;
  #batchIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #reactors = new Map<string, ReactorHandle>();
  #watchdog = new BudgetWatchdog();
  #started = false;
  #shuttingDown = false;
  #released = new Map<WorkloadId, (reason: string) => void>();
  #pendingMoves = new Map<WorkloadId, {
    fromShardId: string;
    toShardId: string;
    resolve(outcome: MoveOutcome): void;
  }>();
  #blockingSamples = new Map<WorkloadId, number[]>();
  #moveCooldownUntil = new Map<WorkloadId, number>();
  // Node-held parent ports for tenant workloads: activations are dispatched
  // as `__tenant_dispatch` messages over the realm channel, results come
  // back as `__tenant_result` — the engine only pumps the realm.
  #tenantPorts = new Map<WorkloadId, ThreadPort>();
  // Realm workloads: their full configs (for placement) and the parent-side
  // channel halves handed back to the Realm objects that own them.
  #realmSpecs = new Map<WorkloadId, RealmWorkloadSpec>();
  #realmPorts = new Map<WorkloadId, {
    portHandle: number;
    portWakeFd: number;
  }>();
  // The engine keys workloads by a numeric id; the orchestrator by a string
  // WorkloadId. Maintain a bijection so control + reports translate cleanly.
  #engineIdSeq = 1;
  #toEngineId = new Map<WorkloadId, number>();
  #fromEngineId = new Map<number, WorkloadId>();

  constructor(options: SchedulerNodeOptions = {}) {
    const shardCount = options.shardCount ?? 2;
    if (!Number.isInteger(shardCount) || shardCount < 1) {
      throw new TypeError('shardCount must be a positive integer');
    }
    this.#capacity = options.capacity ?? 8;
    this.#budgetMicros = options.budgetMicros;
    this.#hardBudgetMicros = options.hardBudgetMicros;
    this.#heartbeatMs = options.heartbeatMs;
    this.#syncSliceThresholdMicros = options.syncSliceThresholdMicros;
    this.#heapLimitBytes = options.heapLimitBytes;
    const batchThreads = options.batchPool?.minThreads ?? options.batchThreads ?? 0;
    const maxBatchThreads = options.batchPool?.maxThreads ?? Math.max(1, batchThreads);
    const batchIdleTimeoutMs = options.batchPool?.idleTimeoutMs ?? 30_000;
    if (!Number.isInteger(batchThreads) || batchThreads < 0) {
      throw new TypeError('batchThreads must be a non-negative integer');
    }
    if (!Number.isInteger(maxBatchThreads) || maxBatchThreads < batchThreads) {
      throw new TypeError('batchPool.maxThreads must be an integer no smaller than minThreads');
    }
    if (!Number.isFinite(batchIdleTimeoutMs) || batchIdleTimeoutMs < 0) {
      throw new TypeError('batchPool.idleTimeoutMs must be a non-negative number');
    }
    this.#batchMinThreads = batchThreads;
    this.#batchMaxThreads = maxBatchThreads;
    this.#batchIdleTimeoutMs = batchIdleTimeoutMs;
    this.#shardIds = [];
    for (let i = 0; i < shardCount; i++) {
      const shardId = `shard-${i}`;
      this.#shardIds.push(shardId);
      this.#collection.registerShard(shardId, this.#capacity, 'latency');
    }
    for (let i = 0; i < batchThreads; i++) {
      const shardId = `batch-${this.#batchSeq++}`;
      this.#shardIds.push(shardId);
      this.#collection.registerShard(shardId, this.#capacity, 'batch');
    }
  }

  /** The node's authoritative isolate collection. */
  collection(): NodeIsolateCollection {
    return this.#collection;
  }

  /** The ids of the node's scheduler threads. */
  shardIds(): string[] {
    return [...this.#shardIds];
  }

  /** Boot the native reactor threads and start runaway containment. Idempotent. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#watchdog.start();
    for (const shardId of this.#shardIds) this.#spawnShardReactor(shardId);
  }

  #spawnShardReactor(shardId: string): void {
    const config = {
      ...this.#hardBudgetMicros !== undefined ? { hardBudgetMicros: this.#hardBudgetMicros } : {},
      ...this.#syncSliceThresholdMicros !== undefined ? { syncSliceMicros: this.#syncSliceThresholdMicros } : {},
      ...this.#heapLimitBytes !== undefined ? { heapLimitBytes: this.#heapLimitBytes } : {},
      reactorClass: this.#collection.shardClassOf(shardId) ?? 'latency'
    };
    const reactorId = engine.spawnReactor(config);
    this.#reactors.set(shardId, { reactorId, summary: { shardId, claimed: 0, dispatches: 0, released: 0, heldLeases: 0 }, lastReport: Date.now(), dead: false });
    void this.#pumpReports(shardId, reactorId);
  }

  #provisionBatchShard(): string | null {
    const existing = this.#shardIds.filter((id) => this.#collection.shardClassOf(id) === 'batch');
    if (existing.length >= this.#batchMaxThreads) return null;
    const shardId = `batch-${this.#batchSeq++}`;
    this.#shardIds.push(shardId);
    this.#collection.registerShard(shardId, this.#capacity, 'batch');
    if (this.#started) this.#spawnShardReactor(shardId);
    return shardId;
  }

  #cancelBatchRetirement(shardId: string): void {
    const timer = this.#batchIdleTimers.get(shardId);
    if (timer !== undefined) clearTimeout(timer);
    this.#batchIdleTimers.delete(shardId);
  }

  #scheduleBatchRetirement(shardId: string): void {
    if (this.#collection.shardClassOf(shardId) !== 'batch') return;
    const batchCount = this.#shardIds.filter((id) => this.#collection.shardClassOf(id) === 'batch').length;
    if (batchCount <= this.#batchMinThreads) return;
    this.#cancelBatchRetirement(shardId);
    const timer = setTimeout(() => {
      this.#batchIdleTimers.delete(shardId);
      if (this.#shuttingDown || this.#collection.heldBy(shardId) !== 0 || this.#collection.hasLiveMoveReservations(shardId)) return;
      const remainingBatch = this.#shardIds.filter((id) => this.#collection.shardClassOf(id) === 'batch').length;
      if (remainingBatch <= this.#batchMinThreads) return;
      const handle = this.#reactors.get(shardId);
      this.#reactors.delete(shardId);
      this.#collection.unregisterShard(shardId);
      this.#shardIds = this.#shardIds.filter((id) => id !== shardId);
      if (handle !== undefined) engine.shutdown(handle.reactorId);
    }, this.#batchIdleTimeoutMs);
    this.#batchIdleTimers.set(shardId, timer);
  }

  /**
  * Drain a reactor's report channel on the orchestrator loop for the reactor's
  * lifetime. `nextReport` resolves when the engine thread posts a report wake —
  * and once more when the thread exits, so the loop sees the reactor gone
  * (empty drain + not alive) and exits.
  */
  async #pumpReports(shardId: string, reactorId: number): Promise<void> {
    while (this.#reactors.has(shardId) && !this.#shuttingDown) {
      await engine.nextReport(reactorId);
      if (!this.#reactors.has(shardId)) break;
      const reports = engine.drainReports(reactorId) as EngineReport[];
      for (const report of reports) this.#onEngineReport(shardId, report);
      // A dead reactor thread wakes its pump one final time with nothing
      // queued — recover its workloads onto the survivors.
      if (reports.length === 0 && !engine.reactorAlive(reactorId)) {
        this.#onReactorExit(shardId);
        break;
      }
    }
  }

  /** A reactor thread died — recover its workloads. No-op during shutdown. */
  #onReactorExit(shardId: string): void {
    if (this.#shuttingDown) return;
    this.#recover(shardId);
  }

  #recover(shardId: string): void {
    const handle = this.#reactors.get(shardId);
    if (handle === undefined || handle.dead) return;
    handle.dead = true;
    this.#reactors.delete(shardId);
    // Stop placing on the dead thread, re-place its workloads on survivors
    // (from snapshot if any, else respawned from the entry), then place + wake.
    this.#collection.unregisterShard(shardId);
    const recovered = this.#collection.recoverShard(shardId);
    this.#activate();
    for (const workloadId of recovered) {
      this.wake(workloadId, { workloadId, reason: 'control', sourceId: 'recovery-resume' });
    }
  }

  /** Fold one engine report into the authoritative collection. */
  #onEngineReport(shardId: string, report: EngineReport): void {
    const handle = this.#reactors.get(shardId);
    if (handle === undefined) return;
    handle.lastReport = Date.now();
    if (report.type === 'load') {
      const summary: ShardLoadSummary = {
        shardId,
        heldLeases: report.held ?? 0,
        runnableWorkloads: report.runnable ?? 0,
        dispatches: 0,
        debtMicros: report.debtMicros ?? 0
      };
      this.#collection.recordLoad(shardId, summary);
      return;
    }
    if (report.type === 'started') return;
    if (report.type === 'syncHeavy') {
      // Migrate a sync-heavy workload off a latency thread onto a batch thread.
      const workloadId = this.#fromEngineId.get(report.workloadId ?? -1);
      if (workloadId === undefined) return;
      const current = this.#collection.placementOf(workloadId);
      if (current !== null && this.#collection.shardClassOf(current) === 'latency') {
        const now = Date.now();
        const samples = (this.#blockingSamples.get(workloadId) ?? []).filter((at) => now - at <= 1_000);
        samples.push(now);
        this.#blockingSamples.set(workloadId, samples);
        if (samples.length < 2 || now < (this.#moveCooldownUntil.get(workloadId) ?? 0)) return;
        this.#blockingSamples.delete(workloadId);
        const batch = this.#collection.leastLoadedOfClass('batch') ?? this.#provisionBatchShard();
        if (batch !== null) void this.move(workloadId, batch);
      }
      return;
    }
    if (report.type === 'moved') {
      const workloadId = this.#fromEngineId.get(report.workloadId ?? -1);
      if (workloadId === undefined) return;
      const pending = this.#pendingMoves.get(workloadId);
      if (pending === undefined || pending.toShardId !== shardId) return;
      this.#pendingMoves.delete(workloadId);
      this.#collection.moveLiveLease(workloadId, shardId);
      this.#moveCooldownUntil.set(workloadId, Date.now() + 5_000);
      pending.resolve({
        status: 'moved',
        fromShardId: pending.fromShardId,
        toShardId: pending.toShardId
      });
      return;
    }
    if (report.type === 'detached') return;
    if (report.type === 'released') {
      const workloadId = this.#fromEngineId.get(report.workloadId ?? -1);
      if (workloadId === undefined) return;
      const pendingMove = this.#pendingMoves.get(workloadId);
      if (pendingMove !== undefined) {
        this.#pendingMoves.delete(workloadId);
        this.#collection.releaseLiveMoveReservation(workloadId, pendingMove.toShardId);
        pendingMove.resolve({ status: 'deferred', reason: 'source-released' });
      }
      handle.summary.dispatches += 1;
      handle.summary.released += 1;
      const reason = report.reason ?? 'released';
      this.#blockingSamples.delete(workloadId);
      this.#moveCooldownUntil.delete(workloadId);
      const leaseId = this.#collection.leaseOf(workloadId);
      if (leaseId !== null) this.#collection.release(leaseId, reason as ReleaseReason);
      const isRealm = this.#realmSpecs.delete(workloadId);
      this.#realmPorts.delete(workloadId);
      if (!RE_PLACING_REASONS.has(reason)) {
        const port = this.#tenantPorts.get(workloadId);
        if (port !== undefined) {
          port.close();
          this.#tenantPorts.delete(workloadId);
        }
      }
      this.#activate();
      if (isRealm || !RE_PLACING_REASONS.has(reason)) {
        const resolve = this.#released.get(workloadId);
        if (resolve !== undefined) {
          this.#released.delete(workloadId);
          resolve(reason);
        }
      }
      this.#scheduleBatchRetirement(shardId);
    }
  }

  /**
  * Move an exited live isolate to another local reactor. The workload id,
  * module heap, port, active lease, and pending async state remain unchanged.
  */
  move(workloadId: WorkloadId, toShardId?: string): Promise<MoveOutcome> {
    const fromShardId = this.#collection.placementOf(workloadId);
    if (fromShardId === null) return Promise.resolve({ status: 'deferred', reason: 'not-placed' });
    if (!this.#collection.isLocallyMovable(workloadId)) {
      return Promise.resolve({ status: 'deferred', reason: 'pinned' });
    }
    if (this.#pendingMoves.has(workloadId)) {
      return Promise.resolve({ status: 'deferred', reason: 'move-in-progress' });
    }
    const target = toShardId ?? this.#collection.leastLoaded(fromShardId);
    if (target === fromShardId) return Promise.resolve({ status: 'deferred', reason: 'already-placed' });
    if (!this.#collection.reserveLiveMove(workloadId, target)) {
      return Promise.resolve({ status: 'deferred', reason: 'destination-capacity' });
    }
    this.#cancelBatchRetirement(target);
    const sourceReactor = this.#reactorFor(fromShardId);
    const destinationReactor = this.#reactorFor(target);
    if (sourceReactor === null || destinationReactor === null) {
      this.#collection.releaseLiveMoveReservation(workloadId, target);
      return Promise.resolve({ status: 'deferred', reason: 'reactor-unavailable' });
    }
    return new Promise<MoveOutcome>((resolve) => {
      this.#pendingMoves.set(workloadId, { fromShardId, toShardId: target, resolve });
      try {
        engine.moveRealm(sourceReactor, destinationReactor, this.#engineId(workloadId));
      } catch {
        this.#pendingMoves.delete(workloadId);
        this.#collection.releaseLiveMoveReservation(workloadId, target);
        resolve({ status: 'deferred', reason: 'move-start-failed' });
      }
    });
  }

  /**
  * Place a workload on the node and push it to its scheduler thread. Returns the
  * workload id. The workload runs once it receives a {@link wake}.
  */
  deploy(spec: NodeWorkloadSpec): WorkloadId {
    if (spec.replication === 'bound' && this.#collection.leastLoadedOfClass('batch') === null) {
      this.#provisionBatchShard();
    }
    const workloadId = this.#collection.deploy(spec);
    this.#activate();
    return workloadId;
  }

  /**
  * Place a REALM workload — a full child realm hosted on a scheduler thread.
  * Returns the workload id plus the parent-side channel half (the caller
  * constructs the Realm's port over it), or `null` when the node has no
  * capacity — the caller falls back to a dedicated thread.
  */
  deployRealm(spec: RealmWorkloadSpec): {
    workloadId: WorkloadId;
    portHandle: number;
    portWakeFd: number;
  } | null {
    let workloadId: WorkloadId;
    if (spec.replication === 'bound' && this.#collection.leastLoadedOfClass('batch') === null) {
      this.#provisionBatchShard();
    }
    try {
      workloadId = this.#collection.deploy({
        tenantId: spec.tenantId ?? 'realm',
        entryPath: spec.entryPath,
        ...spec.priority !== undefined ? { priority: spec.priority } : {},
        ...spec.localMobility !== undefined ? { localMobility: spec.localMobility } : {},
        ...spec.replication !== undefined ? { replication: spec.replication } : {}
      });
    } catch {
      return null;
    }
    this.#realmSpecs.set(workloadId, spec);
    this.#activate();
    const port = this.#realmPorts.get(workloadId);
    if (port === undefined) {
      // No live reactor claimed it (all threads down): undo the record.
      this.#realmSpecs.delete(workloadId);
      const leaseId = this.#collection.leaseOf(workloadId);
      if (leaseId !== null) this.#collection.release(leaseId, 'revoked');
      return null;
    }
    return { workloadId, ...port };
  }

  /** The reactor id hosting `shardId`, or null. */
  #reactorFor(shardId: string): number | null {
    const handle = this.#reactors.get(shardId);
    return handle === undefined ? null : handle.reactorId;
  }

  /** Claim every newly-placed workload for its thread and place it on the engine. */
  #activate(): void {
    for (const shardId of this.#shardIds) {
      const reactorId = this.#reactorFor(shardId);
      if (reactorId === null) continue;
      for (const lease of this.#collection.claim(shardId, this.#capacity)) {
        this.#placeOnEngine(reactorId, lease);
      }
    }
  }

  /** The engine's numeric id for a workload (assigning one on first use). */
  #engineId(workloadId: WorkloadId): number {
    let id = this.#toEngineId.get(workloadId);
    if (id === undefined) {
      id = this.#engineIdSeq++;
      this.#toEngineId.set(workloadId, id);
      this.#fromEngineId.set(id, workloadId);
    }
    return id;
  }

  /**
  * Create + place a claimed workload on its reactor. Every workload is a
  * realm — one construction path. Tenant workloads additionally get a
  * node-held port: the node dispatches activations over it and classifies
  * the results.
  */
  #placeOnEngine(reactorId: number, lease: LeaseRecord): void {
    const workloadId = lease.workloadId;
    const entryPath = lease.entryPath ?? '';
    const priorityClass = PRIORITY_CLASS[lease.priority] ?? 1;
    const realmSpec = this.#realmSpecs.get(workloadId);
    if (realmSpec !== undefined) {
      const info = engine.placeRealm(reactorId, this.#engineId(workloadId), entryPath, realmSpec.rulesJson, realmSpec.realmData ?? '', realmSpec.bootstrapData ?? '', priorityClass) as {
        portHandle: number;
        portWakeFd: number;
      };
      this.#realmPorts.set(workloadId, info);
      return;
    }
    // Tenant workload: realm construction with the tenant sandbox rules
    // (empty rules_json → the engine applies its tenant defaults).
    const info = engine.placeRealm(reactorId, this.#engineId(workloadId), entryPath, '', '', '', priorityClass) as {
      portHandle: number;
      portWakeFd: number;
    };
    const old = this.#tenantPorts.get(workloadId);
    if (old !== undefined) old.close();
    const port = new ThreadPort(info.portWakeFd, info.portHandle);
    port.addEventListener('message', (ev) => {
      const data = (ev as {
        data?: unknown;
      }).data;
      this.#onTenantResult(workloadId, data);
    });
    port.start();
    this.#tenantPorts.set(workloadId, port);
  }

  /** Classify a tenant activation result delivered over the workload's port. */
  #onTenantResult(workloadId: WorkloadId, data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const msg = data as {
      __tenant_result?: boolean;
      __tenant_error?: boolean;
      result?: {
        result?: string;
        mailbox?: unknown[];
      };
      message?: string;
    };
    if (msg.__tenant_error) {
      this.revoke(workloadId, 'failed');
      return;
    }
    if (!msg.__tenant_result) return;
    const outcome = msg.result?.result ?? 'idle';
    if (outcome === 'terminated') {
      this.revoke(workloadId, 'terminated');
    }
    // 'idle': parked until the next wake — nothing to do.
  }

  /**
  * Wake a workload: dispatch one activation over its port. The message's
  * wake byte is itself what makes the hosting reactor pump the realm.
  */
  wake(workloadId: WorkloadId, wake: TenantWake): void {
    const port = this.#tenantPorts.get(workloadId);
    if (port === undefined) return;
    const request: Record<string, unknown> = {
      workloadId,
      data: this.#collection.entryDataOf(workloadId) ?? {},
      wake: { reason: wake.reason, sourceId: wake.sourceId }
    };
    port.postMessage({
      __tenant_dispatch: true,
      request
    });
  }

  /** Revoke a workload on its hosting reactor. */
  revoke(workloadId: WorkloadId, reason: string): void {
    const shardId = this.#collection.placementOf(workloadId);
    if (shardId === null) return;
    const reactorId = this.#reactorFor(shardId);
    if (reactorId !== null) engine.revoke(reactorId, this.#engineId(workloadId), reason);
  }

  /** Resolve with the release reason when a workload reaches a terminal state. */
  whenReleased(workloadId: WorkloadId): Promise<string> {
    if (this.#collection.leaseOf(workloadId) === null && this.#collection.record(workloadId) === undefined) {
      return Promise.resolve('released');
    }
    return new Promise<string>((resolve) => this.#released.set(workloadId, resolve));
  }

  /** Shut every reactor down, stop containment, and return their final summaries. */
  async shutdown(): Promise<SchedulerShardSummary[]> {
    this.#shuttingDown = true;
    for (const timer of this.#batchIdleTimers.values()) clearTimeout(timer);
    this.#batchIdleTimers.clear();
    const handles = [...this.#reactors.values()];
    for (const [workloadId, pending] of this.#pendingMoves) {
      this.#collection.releaseLiveMoveReservation(workloadId, pending.toShardId);
      pending.resolve({ status: 'deferred', reason: 'shutdown' });
    }
    this.#pendingMoves.clear();
    this.#blockingSamples.clear();
    this.#moveCooldownUntil.clear();
    // Signal every reactor to stop; the report pumps exit on the final wake
    // each reactor thread posts as it dies.
    for (const handle of handles) engine.shutdown(handle.reactorId);
    this.#reactors.clear();
    await this.#watchdog.stop();
    const summaries = handles.map((h) => h.summary);
    // Settle outstanding released-waiters rather than dangling them: their
    // workloads die with the reactors, and a waiter that never resolves
    // holds its supervisor (a parent realm's run() entry) open forever.
    for (const resolve of this.#released.values()) resolve('shutdown');
    this.#released.clear();
    for (const port of this.#tenantPorts.values()) port.close();
    this.#tenantPorts.clear();
    this.#started = false;
    this.#shuttingDown = false;
    return summaries;
  }

  /** Test hook: forcibly stop a reactor thread. */
  _killShard(shardId: string): void {
    const reactorId = this.#reactorFor(shardId);
    if (reactorId !== null) engine.shutdown(reactorId);
  }
}
