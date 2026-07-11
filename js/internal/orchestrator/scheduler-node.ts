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
  /** Restart the logical deployment when its loaded files change. */
  watch?: boolean;
  /** Bootstrap the replica as a REPL evaluator. */
  repl?: boolean;
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
  type: 'released' | 'syncHeavy' | 'load' | 'moved' | 'moveRejected' | 'detached' | 'started';
  workloadId?: number;
  reason?: string;
  cpuMicros?: number;
  held?: number;
  runnable?: number;
  debtBand?: number;
  debtMicros?: number;
}

interface WorkloadRuntime {
  engineId: number;
  realmSpec: RealmWorkloadSpec | undefined;
  realmPort: { portHandle: number; portWakeFd: number } | undefined;
  tenantPort: ThreadPort | undefined;
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
  /** Hard per-pump-slice runaway budget (µs) passed to each shard. */
  hardBudgetMicros?: number;
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
  #hardBudgetMicros: number | undefined;
  #syncSliceThresholdMicros: number | undefined;
  #heapLimitBytes: number | undefined;
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
  // One authoritative runtime record per workload. The reverse index exists
  // only because native reports carry the engine's numeric id.
  #runtimes = new Map<WorkloadId, WorkloadRuntime>();
  #engineIdSeq = 1;
  #engineOwners = new Map<number, WorkloadId>();

  constructor(options: SchedulerNodeOptions = {}) {
    const hardwareThreads = Math.max(1, navigator.hardwareConcurrency || 1);
    const defaultBatchThreads = options.shardCount === undefined && hardwareThreads > 1 ? 1 : 0;
    const shardCount = options.shardCount ?? hardwareThreads - defaultBatchThreads;
    if (!Number.isInteger(shardCount) || shardCount < 1) {
      throw new TypeError('shardCount must be a positive integer');
    }
    this.#capacity = options.capacity ?? 8;
    this.#hardBudgetMicros = options.hardBudgetMicros;
    this.#syncSliceThresholdMicros = options.syncSliceThresholdMicros;
    this.#heapLimitBytes = options.heapLimitBytes;
    const minBatchThreads = options.batchPool?.minThreads ?? defaultBatchThreads;
    const maxBatchThreads = options.batchPool?.maxThreads ?? Math.max(1, minBatchThreads);
    const batchIdleTimeoutMs = options.batchPool?.idleTimeoutMs ?? 30_000;
    if (!Number.isInteger(minBatchThreads) || minBatchThreads < 0) {
      throw new TypeError('batchPool.minThreads must be a non-negative integer');
    }
    if (!Number.isInteger(maxBatchThreads) || maxBatchThreads < minBatchThreads) {
      throw new TypeError('batchPool.maxThreads must be an integer no smaller than minThreads');
    }
    if (!Number.isFinite(batchIdleTimeoutMs) || batchIdleTimeoutMs < 0) {
      throw new TypeError('batchPool.idleTimeoutMs must be a non-negative number');
    }
    this.#batchMinThreads = minBatchThreads;
    this.#batchMaxThreads = maxBatchThreads;
    this.#batchIdleTimeoutMs = batchIdleTimeoutMs;
    this.#shardIds = [];
    for (let i = 0; i < shardCount; i++) {
      const shardId = `shard-${i}`;
      this.#shardIds.push(shardId);
      this.#collection.registerShard(shardId, this.#capacity, 'latency');
    }
    for (let i = 0; i < minBatchThreads; i++) {
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
    this.#reactors.set(shardId, { reactorId, summary: { shardId, dispatches: 0, released: 0 }, lastReport: Date.now(), dead: false });
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
      const workloadId = this.#engineOwners.get(report.workloadId ?? -1);
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
      const workloadId = this.#engineOwners.get(report.workloadId ?? -1);
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
    if (report.type === 'moveRejected') {
      const workloadId = this.#engineOwners.get(report.workloadId ?? -1);
      if (workloadId === undefined) return;
      const pending = this.#pendingMoves.get(workloadId);
      if (pending === undefined) return;
      this.#pendingMoves.delete(workloadId);
      this.#collection.releaseLiveMoveReservation(workloadId, pending.toShardId);
      pending.resolve({ status: 'deferred', reason: report.reason ?? 'thread-affine-state' });
      return;
    }
    if (report.type === 'detached') return;
    if (report.type === 'released') {
      const workloadId = this.#engineOwners.get(report.workloadId ?? -1);
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
      const runtime = this.#runtimes.get(workloadId);
      const isRealm = runtime?.realmSpec !== undefined;
      if (runtime !== undefined) runtime.realmPort = undefined;
      if (!RE_PLACING_REASONS.has(reason)) {
        const port = runtime?.tenantPort;
        if (port !== undefined) {
          port.close();
        }
        if (runtime !== undefined) this.#engineOwners.delete(runtime.engineId);
        this.#runtimes.delete(workloadId);
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
    this.#runtime(workloadId).realmSpec = spec;
    this.#activate();
    const port = this.#runtimes.get(workloadId)?.realmPort;
    if (port === undefined) {
      // No live reactor claimed it (all threads down): undo the record.
      const runtime = this.#runtimes.get(workloadId);
      if (runtime !== undefined) this.#engineOwners.delete(runtime.engineId);
      this.#runtimes.delete(workloadId);
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
    return this.#runtime(workloadId).engineId;
  }

  #runtime(workloadId: WorkloadId): WorkloadRuntime {
    let runtime = this.#runtimes.get(workloadId);
    if (runtime !== undefined) return runtime;
    const engineId = this.#engineIdSeq++;
    runtime = { engineId, realmSpec: undefined, realmPort: undefined, tenantPort: undefined };
    this.#runtimes.set(workloadId, runtime);
    this.#engineOwners.set(engineId, workloadId);
    return runtime;
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
    const runtime = this.#runtime(workloadId);
    const realmSpec = runtime.realmSpec;
    if (realmSpec !== undefined) {
      const info = engine.placeRealm(reactorId, this.#engineId(workloadId), entryPath, realmSpec.rulesJson, realmSpec.realmData ?? '', realmSpec.bootstrapData ?? '', priorityClass, realmSpec.watch === true, realmSpec.repl === true) as {
        portHandle: number;
        portWakeFd: number;
      };
      runtime.realmPort = info;
      return;
    }
    // Tenant workload: realm construction with the tenant sandbox rules
    // (empty rules_json → the engine applies its tenant defaults).
    const info = engine.placeRealm(reactorId, this.#engineId(workloadId), entryPath, '', '', '', priorityClass, false, false) as {
      portHandle: number;
      portWakeFd: number;
    };
    const old = runtime.tenantPort;
    if (old !== undefined) old.close();
    const port = new ThreadPort(info.portWakeFd, info.portHandle);
    port.addEventListener('message', (ev) => {
      const data = (ev as {
        data?: unknown;
      }).data;
      this.#onTenantResult(workloadId, data);
    });
    port.start();
    runtime.tenantPort = port;
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
    const port = this.#runtimes.get(workloadId)?.tenantPort;
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
    for (const runtime of this.#runtimes.values()) runtime.tenantPort?.close();
    this.#runtimes.clear();
    this.#engineOwners.clear();
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
