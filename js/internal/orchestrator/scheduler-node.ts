/**
* internal:orchestrator/scheduler-node — boots a node's scheduler threads and
* drives them over a push control channel.
*
* A `SchedulerNode` registers N scheduler threads with a {@link
* NodeIsolateCollection}, boots each as a long-lived explicit-thread realm
* running `internal:scheduler/shard`, and coordinates them entirely by pushing
* control messages (`place` / `wake` / `revoke` / `drain` / `shutdown`) over each
* realm's port — no per-tick polling. Scheduler threads push `released` and
* `load` reports back over the same channel, which the node folds into the one
* authoritative collection. App code never reaches this: it deploys a workload
* and the orchestrator decides which thread hosts it.
*
* @internal
*/
import * as engine from 'internal:reactor-engine';
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
  type: 'released' | 'syncHeavy' | 'load' | 'drained';
  workloadId?: number;
  reason?: string;
  cpuMicros?: number;
  held?: number;
  runnable?: number;
  debtBand?: number;
  /** Drained: the migrated mailbox as JSON (`[{sequence,data}]`). */
  snapshot?: string;
}

/** Release reasons that re-place a workload rather than terminating it. */
const RE_PLACING_REASONS = new Set<string>(['rebalanced', 'renew_failed']);

/** How many scheduler threads to boot and how much each may hold. */
export interface SchedulerNodeOptions {
  /** Number of latency-sensitive scheduler threads. Defaults to 2. */
  shardCount?: number;
  /** Number of lower-priority batch threads that absorb sync-heavy workloads. Defaults to 0. */
  batchThreads?: number;
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
  /** Soft on-CPU limit (µs) per sync slice; overrunning migrates the workload to a batch thread. */
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
  #reactors = new Map<string, ReactorHandle>();
  #watchdog = new BudgetWatchdog();
  #started = false;
  #shuttingDown = false;
  #released = new Map<WorkloadId, (reason: string) => void>();
  #pendingHandoff = new Map<WorkloadId, string | undefined>();
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
    const batchThreads = options.batchThreads ?? 0;
    if (!Number.isInteger(batchThreads) || batchThreads < 0) {
      throw new TypeError('batchThreads must be a non-negative integer');
    }
    this.#shardIds = [];
    for (let i = 0; i < shardCount; i++) {
      const shardId = `shard-${i}`;
      this.#shardIds.push(shardId);
      this.#collection.registerShard(shardId, this.#capacity, 'latency');
    }
    for (let i = 0; i < batchThreads; i++) {
      const shardId = `batch-${i}`;
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
    for (const shardId of this.#shardIds) {
      const config = {
        ...this.#hardBudgetMicros !== undefined ? { hardBudgetMicros: this.#hardBudgetMicros } : {},
        ...this.#syncSliceThresholdMicros !== undefined ? { syncSliceMicros: this.#syncSliceThresholdMicros } : {},
        ...this.#heapLimitBytes !== undefined ? { heapLimitBytes: this.#heapLimitBytes } : {}
      };
      const reactorId = engine.spawnReactor(config);
      this.#reactors.set(shardId, { reactorId, summary: { shardId, claimed: 0, dispatches: 0, released: 0, heldLeases: 0 }, lastReport: Date.now(), dead: false });
      void this.#pumpReports(shardId, reactorId);
    }
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
        debtMicros: 0
      };
      this.#collection.recordLoad(shardId, summary);
      return;
    }
    if (report.type === 'syncHeavy') {
      // Migrate a sync-heavy workload off a latency thread onto a batch thread.
      const workloadId = this.#fromEngineId.get(report.workloadId ?? -1);
      if (workloadId === undefined) return;
      const current = this.#collection.placementOf(workloadId);
      if (current !== null && this.#collection.shardClassOf(current) === 'latency') {
        const batch = this.#collection.leastLoadedOfClass('batch');
        if (batch !== null) this.handoff(workloadId, batch);
      }
      return;
    }
    if (report.type === 'drained') {
      const workloadId = this.#fromEngineId.get(report.workloadId ?? -1);
      if (workloadId === undefined) return;
      // The engine drained the tenant and serialized its mailbox; carry that
      // JSON to the destination so it reconstructs the pending state.
      let mailbox: unknown[] = [];
      if (report.snapshot !== undefined && report.snapshot !== '') {
        try {
          const parsed = JSON.parse(report.snapshot);
          if (Array.isArray(parsed)) mailbox = parsed;
        } catch {
          mailbox = [];
        }
      }
      this.#completeHandoff(workloadId, { mailbox });
      return;
    }
    if (report.type === 'released') {
      const workloadId = this.#fromEngineId.get(report.workloadId ?? -1);
      if (workloadId === undefined) return;
      handle.summary.dispatches += 1;
      handle.summary.released += 1;
      const reason = report.reason ?? 'released';
      const leaseId = this.#collection.leaseOf(workloadId);
      if (leaseId !== null) this.#collection.release(leaseId, reason as ReleaseReason);
      const isRealm = this.#realmSpecs.delete(workloadId);
      this.#realmPorts.delete(workloadId);
      this.#activate();
      if (isRealm || !RE_PLACING_REASONS.has(reason)) {
        const resolve = this.#released.get(workloadId);
        if (resolve !== undefined) {
          this.#released.delete(workloadId);
          resolve(reason);
        }
      }
    }
  }

  /**
  * Begin handing a workload off to another thread: mark it draining and push a
  * `drain` to its current holder, which quiesces it and reports a snapshot. The
  * move completes in {@link #completeHandoff} when that report arrives.
  */
  handoff(workloadId: WorkloadId, toShardId?: string): void {
    const shardId = this.#collection.placementOf(workloadId);
    if (shardId === null) return;
    this.#collection.drainForHandoff(workloadId);
    this.#pendingHandoff.set(workloadId, toShardId);
    const reactorId = this.#reactorFor(shardId);
    if (reactorId !== null) engine.drain(reactorId, this.#engineId(workloadId));
  }

  #completeHandoff(workloadId: WorkloadId, pending: { mailbox: unknown[] }): void {
    if (this.#collection.record(workloadId)?.state !== 'draining') return;
    this.#collection.completeHandoff(workloadId, { mailbox: pending.mailbox }, Date.now() * 1_000_000);
    const toShardId = this.#pendingHandoff.get(workloadId);
    this.#pendingHandoff.delete(workloadId);
    this.#collection.placeHandoff(workloadId, toShardId);
    // Push the reconstructed workload to its destination and wake it so it
    // rebuilds from the snapshot the claim attached to its lease.
    this.#activate();
    this.wake(workloadId, { workloadId, reason: 'control', sourceId: 'handoff-resume' });
  }

  /**
  * Place a workload on the node and push it to its scheduler thread. Returns the
  * workload id. The workload runs once it receives a {@link wake}.
  */
  deploy(spec: NodeWorkloadSpec): WorkloadId {
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
    try {
      workloadId = this.#collection.deploy({
        tenantId: spec.tenantId ?? 'realm',
        entryPath: spec.entryPath,
        ...spec.priority !== undefined ? { priority: spec.priority } : {}
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

  /** Create + place a claimed workload on its reactor (parked until woken). */
  #placeOnEngine(reactorId: number, lease: LeaseRecord): void {
    const entryPath = lease.entryPath ?? '';
    const priorityClass = PRIORITY_CLASS[lease.priority] ?? 1;
    const realmSpec = this.#realmSpecs.get(lease.workloadId);
    if (realmSpec !== undefined) {
      const info = engine.placeRealm(reactorId, this.#engineId(lease.workloadId), entryPath, realmSpec.rulesJson, realmSpec.realmData ?? '', realmSpec.bootstrapData ?? '', priorityClass) as {
        portHandle: number;
        portWakeFd: number;
      };
      this.#realmPorts.set(lease.workloadId, info);
      return;
    }
    const dataJson = JSON.stringify(lease.data ?? {});
    // A reclaimed handed-off workload carries a snapshot; hand its mailbox to the
    // engine so the first activation reconstructs from `request.handoff`.
    const handoffJson = lease.handoff !== undefined ? JSON.stringify(lease.handoff.mailbox ?? []) : '';
    engine.place(reactorId, this.#engineId(lease.workloadId), entryPath, dataJson, priorityClass, 'place', '', handoffJson);
  }

  /** Wake a workload on its hosting reactor (each wake is one activation). */
  wake(workloadId: WorkloadId, wake: TenantWake): void {
    const shardId = this.#collection.placementOf(workloadId);
    if (shardId === null) return;
    const reactorId = this.#reactorFor(shardId);
    if (reactorId !== null) engine.wake(reactorId, this.#engineId(workloadId), wake.reason, wake.sourceId);
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
    const handles = [...this.#reactors.values()];
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
