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
import { ImportMap, Realm } from '../../realm/index.ts';
import { NodeIsolateCollection, type NodeWorkloadSpec, type ReleaseReason } from './node.ts';
import { BudgetWatchdog } from './budget-watchdog.ts';
import type { PendingMessage, SchedulerControlMessage, SchedulerReport, SchedulerShardSummary, TenantWake, WorkloadId } from '../scheduler/types.ts';

const SCHEDULER_ENTRY = `
  import { runSchedulerShard } from 'internal:scheduler/shard';
  await runSchedulerShard();
`;

const SHARD_INHERIT: string[] = [
  'fino:*',
  'internal:*',
  'internal:scheduler/shard',
  'internal:scheduler/selection',
  'internal:scheduler/types',
  'internal:scheduler/isolate',
  'internal:scheduler/facade-ops',
  'internal:scheduler/file-provider',
  'internal:scheduler-native',
  'internal:runtime/loop',
  'internal:realm-bridge'
];

interface RealmPort {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  start?(): void;
}

interface SchedulerRealm {
  port: RealmPort;
  run(): Promise<void>;
  terminate(): void;
}

interface ShardHandle {
  realm: SchedulerRealm;
  port: RealmPort;
  done: Promise<void>;
  summary: SchedulerShardSummary;
  /** Wall-clock (ms) of this shard's last report; a stale value means it hung. */
  lastReport: number;
  /** True once the shard has been declared dead and its workloads recovered. */
  dead: boolean;
}

const DEFAULT_HEARTBEAT_MS = 250;

/** Must match the shard's own default heartbeat cadence (js/internal/scheduler/shard.ts). */
const DEFAULT_SHARD_HEARTBEAT_MS = 1_500;

/** How long to wait for a shard's run() to settle on shutdown before forcing it. */
const SHARD_JOIN_TIMEOUT_MS = 2_000;

/** Release reasons that re-place a workload rather than terminating it. */
const RE_PLACING_REASONS = new Set<string>(['rebalanced', 'renew_failed']);

/** A promise that resolves after `ms` on the orchestrator loop. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  #shards = new Map<string, ShardHandle>();
  #watchdog = new BudgetWatchdog();
  #started = false;
  #shuttingDown = false;
  #released = new Map<WorkloadId, (reason: string) => void>();
  #pendingHandoff = new Map<WorkloadId, string | undefined>();
  #supervisor: { cancel(): void } | null = null;

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

  /** Boot the scheduler threads and start runaway containment. Idempotent. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#watchdog.start();
    for (const shardId of this.#shardIds) {
      const config = {
        shardId,
        capacity: this.#capacity,
        ...this.#budgetMicros !== undefined ? { budgetMicros: this.#budgetMicros } : {},
        ...this.#hardBudgetMicros !== undefined ? { hardBudgetMicros: this.#hardBudgetMicros } : {},
        ...this.#heartbeatMs !== undefined ? { heartbeatMs: this.#heartbeatMs } : {},
        ...this.#syncSliceThresholdMicros !== undefined ? { syncSliceThresholdMicros: this.#syncSliceThresholdMicros } : {},
        ...this.#heapLimitBytes !== undefined ? { heapLimitBytes: this.#heapLimitBytes } : {}
      };
      // Run (not call) the shard entry, so the shard's port reports never
      // collide with a call response; config is handed over as realm data.
      const realm = Realm.fromSource(SCHEDULER_ENTRY, {
        thread: true,
        data: config,
        overrides: ImportMap.deny(SHARD_INHERIT.map((pattern) => ({ pattern, directive: 'inherit' as const })))
      });
      const schedulerRealm = realm as unknown as SchedulerRealm;
      const port = schedulerRealm.port;
      port.addEventListener('message', (event) => this.#onReport(shardId, event.data as SchedulerReport));
      port.start?.();
      const done = schedulerRealm.run();
      // A shard's run() settling while the node is up means its thread died —
      // recover its workloads onto the survivors.
      void done.then(() => this.#onShardExit(shardId), () => this.#onShardExit(shardId));
      this.#shards.set(shardId, { realm: schedulerRealm, port, done, summary: { shardId, claimed: 0, dispatches: 0, released: 0, heldLeases: 0 }, lastReport: Date.now(), dead: false });
    }
    this.#supervisor = this.#superviseHeartbeats();
  }

  /**
  * A dead scheduler thread (crash, or its run() settling unexpectedly) — recover
  * its workloads onto the surviving threads. A no-op during shutdown or if the
  * shard was already recovered.
  */
  #onShardExit(shardId: string): void {
    if (this.#shuttingDown) return;
    this.#recover(shardId);
  }

  #recover(shardId: string): void {
    const handle = this.#shards.get(shardId);
    if (handle === undefined || handle.dead) return;
    handle.dead = true;
    this.#shards.delete(shardId);
    // Stop placing new work on the dead thread, then re-place the workloads it
    // was holding on survivors (from checkpoint if one exists, else respawned
    // from the entry) and push + wake them.
    this.#collection.unregisterShard(shardId);
    const recovered = this.#collection.recoverShard(shardId);
    this.#activate();
    for (const workloadId of recovered) {
      this.wake(workloadId, { workloadId, reason: 'control', sourceId: 'recovery-resume' });
    }
  }

  /**
  * Backstop for a thread that hangs rather than crashing cleanly: if a shard
  * stops reporting for far longer than its report cadence, treat it as dead.
  * The threshold is deliberately generous so transient load or GC pauses never
  * trigger a spurious recovery — the reliable signal is the `run()`-settle
  * watcher; this only catches genuine multi-second hangs.
  */
  #superviseHeartbeats(): { cancel(): void } {
    let cancelled = false;
    const heartbeat = this.#heartbeatMs ?? DEFAULT_SHARD_HEARTBEAT_MS;
    const period = Math.max(DEFAULT_HEARTBEAT_MS, heartbeat);
    // Tolerate several missed heartbeats before declaring a thread dead, so a
    // transient GC pause or scheduling hiccup never triggers a spurious recovery.
    const stale = Math.max(5_000, heartbeat * 4);
    const tick = (): void => {
      if (cancelled || this.#shuttingDown) return;
      const now = Date.now();
      for (const [shardId, handle] of [...this.#shards]) {
        if (!handle.dead && now - handle.lastReport > stale) this.#recover(shardId);
      }
      if (!cancelled) timer = setTimeout(tick, period);
    };
    let timer = setTimeout(tick, period);
    return { cancel(): void { cancelled = true; clearTimeout(timer); } };
  }

  #onReport(shardId: string, message: SchedulerReport): void {
    if (message === null || typeof message !== 'object') return;
    const handle = this.#shards.get(shardId);
    // Ignore reports from a shard already retired by recovery. Otherwise a late
    // `released`/`drained` from a presumed-dead thread mutates collection state
    // for a workload that has since been recovered onto a survivor (its new
    // lease would be mis-released).
    if (handle === undefined) return;
    handle.lastReport = Date.now();
    if (message.report === 'load' || message.report === 'heartbeat') {
      // `load` fires on resource change; `heartbeat` is the slow liveness tick.
      // Both carry a fresh summary and both refresh `lastReport` (set above).
      this.#collection.recordLoad(shardId, message.summary);
      return;
    }
    if (message.report === 'summary') {
      handle.summary = message.summary;
      return;
    }
    if (message.report === 'syncHeavy') {
      // A workload burned too much on-CPU time in one sync slice on a latency
      // thread — migrate it to a batch thread so it stops janking its neighbors.
      const current = this.#collection.placementOf(message.workloadId);
      if (current !== null && this.#collection.shardClassOf(current) === 'latency') {
        const batch = this.#collection.leastLoadedOfClass('batch');
        if (batch !== null) this.handoff(message.workloadId, batch);
      }
      return;
    }
    if (message.report === 'drained') {
      this.#completeHandoff(message.workloadId, message.pending);
      return;
    }
    if (message.report === 'released') {
      const leaseId = this.#collection.leaseOf(message.workloadId);
      if (leaseId !== null) this.#collection.release(leaseId, message.reason as ReleaseReason);
      // Resolve `whenReleased` only for a truly terminal outcome. A re-placing
      // reason (`rebalanced`/`renew_failed`) is not the workload finishing, so
      // it must not resolve a deploy waiter and shut down still-live work.
      if (!RE_PLACING_REASONS.has(message.reason)) {
        const resolve = this.#released.get(message.workloadId);
        if (resolve !== undefined) {
          this.#released.delete(message.workloadId);
          resolve(message.reason);
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
    this.#push(shardId, { control: 'drain', workloadId });
  }

  #completeHandoff(workloadId: WorkloadId, pending: { mailbox: PendingMessage[] }): void {
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

  /** Claim every newly-placed workload for its thread and push it there. */
  #activate(): void {
    for (const shardId of this.#shardIds) {
      for (const lease of this.#collection.claim(shardId, this.#capacity)) {
        this.#push(shardId, { control: 'place', lease });
      }
    }
  }

  /** Push a wake for a workload to its hosting thread. */
  wake(workloadId: WorkloadId, wake: TenantWake): void {
    const shardId = this.#collection.placementOf(workloadId);
    if (shardId !== null) this.#push(shardId, { control: 'wake', wake });
  }

  /** Push an immediate revocation for a workload to its hosting thread. */
  revoke(workloadId: WorkloadId, reason: string): void {
    const shardId = this.#collection.placementOf(workloadId);
    if (shardId !== null) this.#push(shardId, { control: 'revoke', workloadId, reason });
  }

  #push(shardId: string, message: SchedulerControlMessage): void {
    this.#shards.get(shardId)?.port.postMessage(message);
  }

  /** Resolve with the release reason when a workload reaches a terminal state. */
  whenReleased(workloadId: WorkloadId): Promise<string> {
    if (this.#collection.leaseOf(workloadId) === null && this.#collection.record(workloadId) === undefined) {
      return Promise.resolve('released');
    }
    return new Promise<string>((resolve) => this.#released.set(workloadId, resolve));
  }

  /** Shut every thread down, stop containment, and return their final summaries. */
  async shutdown(): Promise<SchedulerShardSummary[]> {
    this.#shuttingDown = true;
    this.#supervisor?.cancel();
    this.#supervisor = null;
    const handles = [...this.#shards.values()];
    for (const handle of handles) handle.port.postMessage({ control: 'shutdown' });
    try {
      // Bound each join: posting `shutdown` asks the shard to settle its run(),
      // but a wedged shard must not hang shutdown forever — which would also
      // leave the budget-watchdog sweep loop spinning.
      await Promise.all(handles.map((handle) =>
        Promise.race([handle.done.catch(() => undefined), delay(SHARD_JOIN_TIMEOUT_MS)])
      ));
    } finally {
      // Always dispose the realms and stop containment, even if a join stalled —
      // posting `shutdown` does not itself tear the thread realm down, so without
      // this the realm/port handles stay live and the process never quiesces.
      for (const handle of handles) handle.realm.terminate();
      await this.#watchdog.stop();
    }
    const summaries = handles.map((shard) => shard.summary);
    this.#shards.clear();
    this.#released.clear();
    this.#started = false;
    this.#shuttingDown = false;
    return summaries;
  }

  /**
  * Test hook: forcibly kill a scheduler thread to exercise recovery. Its
  * `run()` settles, which the node observes and recovers from.
  */
  _killShard(shardId: string): void {
    this.#shards.get(shardId)?.realm.terminate();
  }
}
