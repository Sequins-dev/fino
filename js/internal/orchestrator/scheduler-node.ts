/**
* internal:orchestrator/scheduler-node — boots a node's scheduler threads and
* binds them to the node isolate collection.
*
* A `SchedulerNode` is the concrete multi-thread orchestrator: it registers N
* scheduler threads with a {@link NodeIsolateCollection}, exposes `deploy()` so
* app placement flows through the orchestrator, and `run()` spins each scheduler
* thread up as an explicit-thread realm running `internal:scheduler/shard`. Each
* thread is handed the `internal:scheduler/host` contract as a facade backed by
* the collection, so every claim / renew / release / load report marshals onto
* the orchestrator's loop and mutates the one authoritative collection — no
* shared mutable state crosses a thread boundary.
*
* Threads are booted with the same explicit-thread `Realm({ thread: true })`
* path core services already use; app code never reaches this — it deploys a
* workload and the orchestrator decides which thread hosts it.
*
* @internal
*/
import { Facade, ImportMap, Realm } from '../../realm/index.ts';
import { NodeIsolateCollection, type NodeWorkloadSpec } from './node.ts';
import type { ReleaseReason } from './node.ts';
import { BudgetWatchdog } from './budget-watchdog.ts';
import type { SchedulerShardSummary, ShardLoadSummary, WorkloadId } from '../scheduler/types.ts';

const SCHEDULER_ENTRY = `
  import { runSchedulerShard } from 'internal:scheduler/shard';
  export default async function(config) {
    return runSchedulerShard(config);
  }
`;

const HOST_INHERIT: string[] = [
  'fino:*',
  'internal:*',
  'internal:scheduler/shard',
  'internal:scheduler/selection',
  'internal:scheduler/types',
  'internal:scheduler/isolate',
  'internal:scheduler/facade-ops',
  'internal:scheduler/file-provider',
  'internal:scheduler-native',
  'internal:runtime/loop'
];

/** How many scheduler threads to boot and how much each may hold. */
export interface SchedulerNodeOptions {
  /** Number of scheduler threads. Defaults to 2. */
  shardCount?: number;
  /** Per-thread workload capacity. Defaults to 8. */
  capacity?: number;
}

/** Bounds for a single scheduling round across the node's threads. */
export interface NodeRoundConfig {
  maxDispatches?: number;
  maxPolls?: number;
  budgetMicros?: number;
  hardBudgetMicros?: number;
  renewEvery?: number;
  pollTimeoutMs?: number;
  releaseOnShutdown?: boolean;
}

/**
* A running scheduler node: N scheduler threads over one node isolate
* collection.
*/
export class SchedulerNode {
  #collection = new NodeIsolateCollection();
  #shardIds: string[];
  #capacity: number;

  constructor(options: SchedulerNodeOptions = {}) {
    const shardCount = options.shardCount ?? 2;
    if (!Number.isInteger(shardCount) || shardCount < 1) {
      throw new TypeError('shardCount must be a positive integer');
    }
    this.#capacity = options.capacity ?? 8;
    this.#shardIds = [];
    for (let i = 0; i < shardCount; i++) {
      const shardId = `shard-${i}`;
      this.#shardIds.push(shardId);
      this.#collection.registerShard(shardId, this.#capacity);
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

  /** Place a workload on the node through the orchestrator. */
  deploy(spec: NodeWorkloadSpec): WorkloadId {
    return this.#collection.deploy(spec);
  }

  #hostFacade(): Facade {
    const collection = this.#collection;
    return new Facade('internal:scheduler/host', [
      'claimWorkloads',
      'pollWakes',
      'dispatchWorkload',
      'renewLease',
      'releaseLease',
      'recordShardLoad'
    ])
      .handle('claimWorkloads', async (shardId, capacity) => collection.claim(String(shardId), Number(capacity)))
      .handle('pollWakes', async (shardId) => collection.pollWakes(String(shardId)))
      .handle('dispatchWorkload', async () => {
        throw new Error('scheduler node hosts isolate workloads; facade dispatch is unavailable');
      })
      .handle('renewLease', async (leaseId, epoch) => collection.renew(String(leaseId), Number(epoch)))
      .handle('releaseLease', async (leaseId, reason) => {
        collection.release(String(leaseId), String(reason) as ReleaseReason);
      })
      .handle('recordShardLoad', async (shardId, summary) => {
        collection.recordLoad(String(shardId), summary as ShardLoadSummary);
      });
  }

  /**
  * Run one scheduling round on every thread concurrently and return their
  * summaries. Each thread claims its placed workloads from the collection,
  * pumps them, and reports load — all through the shared host facade.
  */
  async run(config: NodeRoundConfig = {}): Promise<SchedulerShardSummary[]> {
    // Runaway containment runs on this (the orchestrator) thread for the whole
    // round: it terminates any tenant that overruns its hard pump budget on a
    // scheduler thread, which that scheduler thread cannot do for itself while
    // blocked in the runaway.
    const watchdog = new BudgetWatchdog();
    watchdog.start();
    try {
      return await this.#runRound(config);
    } finally {
      await watchdog.stop();
    }
  }

  async #runRound(config: NodeRoundConfig): Promise<SchedulerShardSummary[]> {
    const host = this.#hostFacade();
    const rounds = this.#shardIds.map((shardId) => {
      const realm = Realm.fromSource<(config: unknown) => Promise<SchedulerShardSummary>>(SCHEDULER_ENTRY, {
        thread: true,
        overrides: ImportMap.deny([
          ...HOST_INHERIT.map((pattern) => ({ pattern, directive: 'inherit' as const })),
          { pattern: 'internal:scheduler/host', directive: host }
        ])
      });
      return realm.call({
        shardId,
        capacity: this.#capacity,
        maxPolls: config.maxPolls ?? 1,
        ...config.maxDispatches !== undefined ? { maxDispatches: config.maxDispatches } : {},
        ...config.budgetMicros !== undefined ? { budgetMicros: config.budgetMicros } : {},
        ...config.hardBudgetMicros !== undefined ? { hardBudgetMicros: config.hardBudgetMicros } : {},
        ...config.renewEvery !== undefined ? { renewEvery: config.renewEvery } : {},
        ...config.pollTimeoutMs !== undefined ? { pollTimeoutMs: config.pollTimeoutMs } : {},
        releaseOnShutdown: config.releaseOnShutdown ?? true
      });
    });
    return Promise.all(rounds);
  }
}
