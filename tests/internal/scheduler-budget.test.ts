/**
* Budget enforcement: the cooperative yield path (a workload voluntarily yields
* and accrues debt) versus the hard-cancel path (a synchronous runaway is
* forcibly unwound by the scheduler's budget watchdog). Both run as real thread
* realms pumping tenant isolates.
*/
import { describe, it } from 'fino:test/test';
import { Facade, ImportMap, Realm } from 'fino:realm';
import { BudgetWatchdog } from 'internal:orchestrator/budget-watchdog';

type Lease = {
  leaseId: string;
  workloadId: string;
  epoch: number;
  priority: 'interactive' | 'service' | 'background';
  entryPath: string;
  data?: unknown;
};

type Wake = { workloadId: string; reason: 'message'; sourceId: string };

const schedulerSource = `
  import { runSchedulerShard } from 'internal:scheduler/shard';
  export default async function(config) { return runSchedulerShard(config); }
`;

function schedulerRealm(host: Facade): Realm<(config: unknown) => Promise<{ dispatches: number }>> {
  return Realm.fromSource(schedulerSource, {
    thread: true,
    overrides: ImportMap.deny([
      { pattern: 'fino:*', directive: 'inherit' },
      { pattern: 'internal:*', directive: 'inherit' },
      { pattern: 'internal:scheduler/host', directive: host }
    ])
  });
}

function createHost(leases: Lease[], wakes: Wake[]) {
  const released: Array<{ leaseId: string; reason: string }> = [];
  const load: Array<{ debtMicros: number }> = [];
  let polled = false;
  const facade = new Facade('internal:scheduler/host', [
    'claimWorkloads', 'pollWakes', 'dispatchWorkload', 'renewLease', 'releaseLease', 'recordShardLoad'
  ]);
  facade.handle('claimWorkloads', async (_shardId: unknown, capacity: unknown) => leases.slice(0, Number(capacity)));
  facade.handle('pollWakes', async () => {
    if (polled) return [];
    polled = true;
    return wakes;
  });
  facade.handle('dispatchWorkload', async () => {
    throw new Error('facade dispatch is unused for isolate workloads');
  });
  facade.handle('renewLease', async () => true);
  facade.handle('releaseLease', async (leaseId: unknown, reason: unknown) => {
    released.push({ leaseId: String(leaseId), reason: String(reason) });
  });
  facade.handle('recordShardLoad', async (_shardId: unknown, summary: unknown) => {
    load.push(summary as { debtMicros: number });
  });
  return { facade, released, load };
}

describe('scheduler budget enforcement', () => {
  it('hard-cancels a synchronous runaway and keeps its sibling schedulable', async (t) => {
    const worker = new URL('./fixtures/scheduler-runaway-worker.ts', import.meta.url).pathname;
    const host = createHost([
      { leaseId: 'lease-run', workloadId: 'work-run', epoch: 1, priority: 'service', entryPath: worker, data: { runaway: true } },
      { leaseId: 'lease-ok', workloadId: 'work-ok', epoch: 1, priority: 'service', entryPath: worker, data: { runaway: false } }
    ], [
      { workloadId: 'work-run', reason: 'message', sourceId: 'run' },
      { workloadId: 'work-ok', reason: 'message', sourceId: 'ok' }
    ]);
    // The watchdog service runs on this (the orchestrator) thread — it is what
    // terminates the runaway on the blocked scheduler thread.
    const watchdog = new BudgetWatchdog({ sweepIntervalMs: 10 });
    watchdog.start();
    try {
      const realm = schedulerRealm(host.facade);
      const summary = await realm.call({
        shardId: 'shard-budget', capacity: 2, maxDispatches: 2, maxPolls: 1, hardBudgetMicros: 120_000, releaseOnShutdown: true
      });
      t.equal(summary.dispatches, 2, 'both workloads were pumped');
      t.equal(host.released.some((r) => r.leaseId === 'lease-run' && r.reason === 'terminated'), true, 'the runaway was hard-cancelled');
      t.equal(host.released.some((r) => r.leaseId === 'lease-ok' && r.reason === 'terminated'), false, 'the well-behaved sibling survived the runaway');
      t.equal(watchdog.firedTotal >= 1, true, 'the watchdog service fired at least once');
    } finally {
      await watchdog.stop();
    }
  });

  it('lets a cooperative workload yield and accrue debt without terminating it', async (t) => {
    const worker = new URL('./fixtures/scheduler-cooperative-worker.ts', import.meta.url).pathname;
    const host = createHost([
      { leaseId: 'lease-coop', workloadId: 'work-coop', epoch: 1, priority: 'service', entryPath: worker, data: { costMicros: 250 } }
    ], [
      { workloadId: 'work-coop', reason: 'message', sourceId: 'coop' }
    ]);
    const realm = schedulerRealm(host.facade);
    const summary = await realm.call({
      shardId: 'shard-coop', capacity: 1, maxDispatches: 1, maxPolls: 1, hardBudgetMicros: 150_000, releaseOnShutdown: true
    });
    t.equal(summary.dispatches, 1, 'the cooperative workload was pumped');
    t.equal(host.released.some((r) => r.leaseId === 'lease-coop' && r.reason === 'terminated'), false, 'a voluntary yield is not a termination');
    t.equal(host.load.some((s) => s.debtMicros === 250), true, 'the yielded cost was accounted as debt');
  });
});
