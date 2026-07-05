/**
* Integration tests for the scheduler node: the orchestrator boots real
* scheduler threads, places workloads through the node isolate collection, and
* each thread claims, pumps, and reports load — all through the shared host
* facade, with no shared mutable state crossing a thread boundary.
*/
import { describe, it } from 'fino:test/test';
import { SchedulerNode } from 'internal:orchestrator/scheduler-node';
import { DiskFileSystem } from 'fino:file';
import type { WorkloadId } from 'internal:scheduler/types';

const worker = new URL('./fixtures/scheduler-io-worker.ts', import.meta.url).pathname;
const handoffWorker = new URL('./fixtures/scheduler-handoff-worker.ts', import.meta.url).pathname;

function deployWithWake(node: SchedulerNode, spec: { tenantId: string; marker: string; affinity?: string }): WorkloadId {
  const id = node.deploy({
    tenantId: spec.tenantId,
    entryPath: worker,
    ...spec.affinity !== undefined ? { affinity: spec.affinity } : {},
    data: { inputText: spec.marker, expectText: spec.marker, marker: spec.marker }
  });
  node.collection().enqueueWake(id, { workloadId: id, reason: 'io', sourceId: spec.marker });
  return id;
}

describe('scheduler node', () => {
  it('places workloads across threads and pumps them through the collection', async (t) => {
    const node = new SchedulerNode({ shardCount: 2, capacity: 2 });
    for (let i = 0; i < 4; i++) deployWithWake(node, { tenantId: 'acme', marker: `w${i}` });

    // Placement is decided before any thread boots — assert the spread up front.
    t.equal(node.collection().workloadsOn('shard-0').length, 2, 'shard-0 placed two workloads');
    t.equal(node.collection().workloadsOn('shard-1').length, 2, 'shard-1 placed two workloads');

    const summaries = await node.run({ maxDispatches: 2, maxPolls: 1 });
    const byShard = new Map(summaries.map((s) => [s.shardId, s]));
    t.equal(byShard.get('shard-0')?.claimed, 2, 'shard-0 claimed its two leases');
    t.equal(byShard.get('shard-1')?.claimed, 2, 'shard-1 claimed its two leases');
    const dispatches = summaries.reduce((sum, s) => sum + s.dispatches, 0);
    t.equal(dispatches, 4, 'every placed workload was pumped exactly once');
  });

  it('runs both threads concurrently — neither blocks the other', async (t) => {
    const node = new SchedulerNode({ shardCount: 2, capacity: 1 });
    deployWithWake(node, { tenantId: 'busy', marker: 'busy', affinity: 'shard-0' });
    deployWithWake(node, { tenantId: 'quick', marker: 'quick', affinity: 'shard-1' });

    const summaries = await node.run({ maxDispatches: 1, maxPolls: 1 });
    // Both threads made progress in the same round; work on one thread cannot
    // stall the other because readiness and pumping are thread-local.
    for (const summary of summaries) {
      t.equal(summary.dispatches, 1, `${summary.shardId} dispatched independently`);
    }
  });

  it('reconstructs a workload on its destination thread from a handoff snapshot', async (t) => {
    const fs = new DiskFileSystem();
    const root = `/tmp/fino-handoff-${Math.floor(Math.random() * 1e9)}`;
    await fs.mkdir(root);
    const outputPath = `${root}/recovered.json`;

    const node = new SchedulerNode({ shardCount: 2, capacity: 4 });
    const id = node.deploy({ tenantId: 'acme', entryPath: handoffWorker, affinity: 'shard-1', data: { outputPath } });
    // The snapshot the destination thread will reconstruct from — pending
    // messages that must survive the move.
    node.collection().checkpoint(id, { mailbox: [{ sequence: 1, data: 'alpha' }, { sequence: 2, data: 'beta' }] }, 0);
    node.collection().enqueueWake(id, { workloadId: id, reason: 'message', sourceId: 'm' });

    try {
      const summaries = await node.run({ maxDispatches: 1, maxPolls: 1 });
      t.equal(summaries.find((s) => s.shardId === 'shard-1')?.dispatches, 1, 'destination pumped the reconstructed workload');
      // The reconstructed worker read its handed-off mailbox and wrote it out
      // through its scheduler-owned filesystem.
      t.equal(new TextDecoder().decode(await fs.readFile(outputPath)), '["alpha","beta"]', 'pending messages survived the handoff and were reconstructed');
    } finally {
      await fs.unlink(outputPath).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('honors affinity so core services can pin a workload to a thread', async (t) => {
    const node = new SchedulerNode({ shardCount: 3, capacity: 4 });
    const pinned = deployWithWake(node, { tenantId: 'core', marker: 'pinned', affinity: 'shard-2' });
    t.equal(node.collection().placementOf(pinned), 'shard-2', 'pinned before boot');

    const summaries = await node.run({ maxDispatches: 1, maxPolls: 1 });
    const shard2 = summaries.find((s) => s.shardId === 'shard-2');
    t.equal(shard2?.dispatches, 1, 'the pinned thread ran the workload');
    t.equal(summaries.filter((s) => s.shardId !== 'shard-2').every((s) => s.dispatches === 0), true, 'no other thread touched it');
  });
});
