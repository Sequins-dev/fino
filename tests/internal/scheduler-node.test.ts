/**
* Integration tests for the long-lived, push-driven scheduler node: the
* orchestrator boots scheduler threads, places workloads through the collection,
* pushes control (place/wake/revoke) over the realm port, and folds released/load
* reports back — no bounded rounds, no polling. Covers run-once workloads,
* long-lived workloads that park and are re-woken, and immediate revocation.
*/
import { describe, it } from 'fino:test/test';
import { SchedulerNode } from 'internal:orchestrator/scheduler-node';
import { DiskFileSystem } from 'fino:file';
import type { WorkloadId } from 'internal:scheduler/types';

const runOnce = new URL('./fixtures/deploy-worker.ts', import.meta.url).pathname;
const longlived = new URL('./fixtures/scheduler-longlived-worker.ts', import.meta.url).pathname;
const handoffWorker = new URL('./fixtures/scheduler-handoff-worker.ts', import.meta.url).pathname;

function tmpRoot(tag: string): string {
  return `/tmp/fino-node-${tag}-${Math.floor(Math.random() * 1e9)}`;
}

function wakeFor(node: SchedulerNode, workloadId: WorkloadId, sourceId: string): void {
  node.wake(workloadId, { workloadId, reason: 'message', sourceId });
}

describe('scheduler node', () => {
  it('places run-once workloads across threads and runs them to completion', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('runonce');
    await fs.mkdir(root);
    const node = new SchedulerNode({ shardCount: 2, capacity: 4 });
    node.start();
    try {
      const ids: WorkloadId[] = [];
      const done: Array<Promise<void>> = [];
      for (let i = 0; i < 4; i++) {
        const id = node.deploy({ tenantId: 'acme', entryPath: runOnce, data: { outputPath: `${root}/w${i}.txt`, message: `m${i}` } });
        ids.push(id);
        done.push(node.whenReleased(id));
        wakeFor(node, id, `w${i}`);
      }
      const threads = new Set(ids.map((id) => node.collection().placementOf(id)));
      t.equal(threads.size, 2, 'placement used both threads');
      await Promise.all(done);
      for (let i = 0; i < 4; i++) {
        t.equal(new TextDecoder().decode(await fs.readFile(`${root}/w${i}.txt`)), `m${i}`, `w${i} did its facade I/O`);
      }
    } finally {
      await node.shutdown();
      for (let i = 0; i < 4; i++) await fs.unlink(`${root}/w${i}.txt`).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('keeps a long-lived workload parked across wakes with persistent state', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('longlived');
    await fs.mkdir(root);
    const out = `${root}/count.txt`;
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    try {
      // Terminates after 3 wakes; each activation increments module-level state
      // in the SAME isolate, proving it stayed alive and parked between wakes.
      const id = node.deploy({ tenantId: 'acme', entryPath: longlived, data: { outputPath: out, until: 3 } });
      const released = node.whenReleased(id);
      // Three distinct wakes (distinct sourceId so they don't coalesce).
      wakeFor(node, id, 'a');
      wakeFor(node, id, 'b');
      wakeFor(node, id, 'c');
      await released;
      t.equal(new TextDecoder().decode(await fs.readFile(out)), '3', 'the isolate persisted state across three parked activations');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('revokes a parked workload immediately', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('revoke');
    await fs.mkdir(root);
    const out = `${root}/count.txt`;
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    try {
      // No `until`, so it parks after its first activation and never self-terminates.
      const id = node.deploy({ tenantId: 'acme', entryPath: longlived, data: { outputPath: out } });
      const released = node.whenReleased(id);
      wakeFor(node, id, 'once');
      // Give it a moment to run its first activation and park, then revoke.
      await new Promise((resolve) => setTimeout(resolve, 100));
      node.revoke(id, 'operator');
      await released;
      t.ok(true, 'a parked long-lived workload was revoked and released');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('honors affinity so core services can pin a workload to a thread', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('affinity');
    await fs.mkdir(root);
    const node = new SchedulerNode({ shardCount: 3, capacity: 4 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'core', entryPath: runOnce, affinity: 'shard-2', data: { outputPath: `${root}/pinned.txt`, message: 'pinned' } });
      t.equal(node.collection().placementOf(id), 'shard-2', 'pinned to the requested thread');
      const released = node.whenReleased(id);
      wakeFor(node, id, 'pin');
      await released;
      t.equal(new TextDecoder().decode(await fs.readFile(`${root}/pinned.txt`)), 'pinned', 'the pinned workload ran');
    } finally {
      await node.shutdown();
      await fs.unlink(`${root}/pinned.txt`).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('recovers a dead thread\'s workloads onto a surviving thread', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('recover');
    await fs.mkdir(root);
    const out = `${root}/recovered.txt`;
    const node = new SchedulerNode({ shardCount: 2, capacity: 4 });
    node.start();
    try {
      // Placed and leased on shard-0 but not yet woken, so it hasn't run there.
      const id = node.deploy({ tenantId: 'acme', entryPath: runOnce, affinity: 'shard-0', data: { outputPath: out, message: 'recovered' } });
      t.equal(node.collection().placementOf(id), 'shard-0', 'initially on shard-0');
      const released = node.whenReleased(id);
      // Kill shard-0; the supervisor observes its run() settle and re-places the
      // workload on the survivor, which wakes and runs it.
      node._killShard('shard-0');
      await released;
      // The workload never ran on shard-0 (it was never woken there), so the
      // output file existing proves it was recovered and ran on the survivor.
      t.equal(new TextDecoder().decode(await fs.readFile(out)), 'recovered', 'the recovered workload ran on the surviving thread');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('hands a live workload off to another thread, preserving its pending state', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('handoff');
    await fs.mkdir(root);
    const out = `${root}/reconstructed.json`;
    const seed = `${root}/seed.json`;
    const node = new SchedulerNode({ shardCount: 2, capacity: 4 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'acme', entryPath: handoffWorker, affinity: 'shard-0', data: { outputPath: out, seedPath: seed } });
      const released = node.whenReleased(id);
      // Two wakes accumulate a mailbox in the live isolate on shard-0.
      wakeFor(node, id, 'seed-1');
      wakeFor(node, id, 'seed-2');
      // Wait (robust to thread-boot time) until both seeds have been processed.
      for (let i = 0; i < 100; i++) {
        const seen = await fs.readFile(seed).then((b) => new TextDecoder().decode(b)).catch(() => '');
        if (seen === '["seed-1","seed-2"]') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // Now hand the live workload to shard-1.
      node.handoff(id, 'shard-1');
      await released;
      // The destination isolate reconstructed the mailbox from the snapshot.
      t.deepEqual(JSON.parse(new TextDecoder().decode(await fs.readFile(out))), ['seed-1', 'seed-2', 'reconstructed'], 'pending mailbox survived the cross-thread handoff');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.unlink(seed).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });
});
