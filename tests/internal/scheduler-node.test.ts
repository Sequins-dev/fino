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
const syncHeavy = new URL('./fixtures/scheduler-syncheavy-worker.ts', import.meta.url).pathname;
const parallelOps = new URL('./fixtures/scheduler-parallel-ops-worker.ts', import.meta.url).pathname;
const heapHog = new URL('./fixtures/scheduler-heaphog-worker.ts', import.meta.url).pathname;
const readWorker = new URL('./fixtures/scheduler-read-worker.ts', import.meta.url).pathname;
const fileErrorWorker = new URL('./fixtures/scheduler-fileerror-worker.ts', import.meta.url).pathname;
const ioLoopWorker = new URL('./fixtures/scheduler-ioloop-worker.ts', import.meta.url).pathname;
const handleBinaryWorker = new URL('./fixtures/scheduler-handle-binary-worker.ts', import.meta.url).pathname;

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

  it('terminates a workload that exceeds its heap cap without OOMing the node', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('heap');
    await fs.mkdir(root);
    const out = `${root}/survivor.txt`;
    // A generous hard budget so the runaway watchdog can't be what stops the hog
    // — only the heap-limit callback can. One thread hosts both.
    const node = new SchedulerNode({ shardCount: 1, capacity: 2, heapLimitBytes: 96 * 1024 * 1024, hardBudgetMicros: 60_000_000 });
    node.start();
    try {
      const hog = node.deploy({ tenantId: 'hog', entryPath: heapHog, data: {} });
      const ok = node.deploy({ tenantId: 'ok', entryPath: runOnce, data: { outputPath: out, message: 'survived' } });
      const hogReleased = node.whenReleased(hog);
      const okReleased = node.whenReleased(ok);
      wakeFor(node, hog, 'go');
      wakeFor(node, ok, 'go');
      const hogReason = await hogReleased;
      await okReleased;
      t.equal(hogReason, 'terminated', 'the heap hog was contained, not left to OOM the process');
      t.equal(new TextDecoder().decode(await fs.readFile(out)), 'survived', 'the sibling survived the heap hog');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('round-trips binary through facade-owned file I/O via the serializer', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('binary');
    await fs.mkdir(root);
    const input = `${root}/in.bin`;
    const output = `${root}/out.bin`;
    // Bytes spanning the full 0..255 range, including values base64/UTF-8 would
    // have mangled if the transport were wrong.
    const payload = new Uint8Array(512);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 13) % 256;
    await fs.writeFile(input, payload);
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'io', entryPath: readWorker, data: { inputPath: input, outputPath: output } });
      const released = node.whenReleased(id);
      wakeFor(node, id, 'go');
      await released;
      const got = await fs.readFile(output);
      t.equal(got.length, payload.length, 'byte length preserved');
      t.equal([...got].every((b, i) => b === payload[i]), true, 'every byte survived the facade read');
    } finally {
      await node.shutdown();
      await fs.unlink(input).catch(() => undefined);
      await fs.unlink(output).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('performs a workload\'s concurrent operations in parallel', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('parallel');
    await fs.mkdir(root);
    const out = `${root}/elapsed.txt`;
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'io', entryPath: parallelOps, data: { outputPath: out } });
      const released = node.whenReleased(id);
      wakeFor(node, id, 'go');
      await released;
      const elapsed = Number(new TextDecoder().decode(await fs.readFile(out)));
      // Two 200ms delays run concurrently (~200ms), not serially (~400ms).
      t.equal(elapsed < 350, true, `two 200ms ops overlapped (took ${elapsed}ms, serial would be ~400ms)`);
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('migrates a sync-heavy workload off a latency thread onto a batch thread', async (t) => {
    const node = new SchedulerNode({ shardCount: 1, batchPool: { minThreads: 1 }, capacity: 4, syncSliceThresholdMicros: 30_000 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'compute', entryPath: syncHeavy, data: { busyMs: 80 } });
      const first = node.collection().placementOf(id);
      t.equal(node.collection().shardClassOf(first ?? ''), 'latency', 'starts on a latency thread');
      // The heavy sync slice trips the on-CPU threshold and triggers migration.
      wakeFor(node, id, 'sample-1');
      await new Promise((resolve) => setTimeout(resolve, 400));
      t.equal(node.collection().shardClassOf(node.collection().placementOf(id) ?? ''), 'latency', 'one blocking sample does not move a realm');
      for (let sample = 2; sample <= 4; sample++) {
        if (node.collection().shardClassOf(node.collection().placementOf(id) ?? '') === 'batch') break;
        wakeFor(node, id, `sample-${sample}`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      let landed: string | null = null;
      for (let i = 0; i < 200; i++) {
        landed = node.collection().placementOf(id);
        if (landed !== null && node.collection().shardClassOf(landed) === 'batch') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      t.equal(node.collection().shardClassOf(landed ?? ''), 'batch', 'migrated to a batch thread');
      const released = node.whenReleased(id);
      node.revoke(id, 'test-done');
      await released;
    } finally {
      await node.shutdown();
    }
  });

  it('spawns batch capacity on demand for a blocking workload', async (t) => {
    const node = new SchedulerNode({
      shardCount: 1,
      capacity: 2,
      syncSliceThresholdMicros: 10_000,
      batchPool: { minThreads: 0, maxThreads: 1, idleTimeoutMs: 30_000 }
    });
    node.start();
    try {
      t.equal(node.shardIds().some((id) => id.startsWith('batch-')), false, 'no batch reactor is warm');
      const id = node.deploy({ tenantId: 'compute', entryPath: syncHeavy, data: { busyMs: 80 } });
      wakeFor(node, id, 'sample-1');
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (let sample = 2; sample <= 4; sample++) {
        if (node.collection().shardClassOf(node.collection().placementOf(id) ?? '') === 'batch') break;
        wakeFor(node, id, `sample-${sample}`);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      let landed: string | null = null;
      for (let i = 0; i < 200; i++) {
        landed = node.collection().placementOf(id);
        if (landed !== null && node.collection().shardClassOf(landed) === 'batch') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      t.equal(node.collection().shardClassOf(landed ?? ''), 'batch', 'an on-demand batch reactor received the isolate');
      t.equal(node.shardIds().filter((id) => id.startsWith('batch-')).length, 1, 'provisioning respected the maximum');
      const released = node.whenReleased(id);
      node.revoke(id, 'test-done');
      await released;
    } finally {
      await node.shutdown();
    }
  });

  it('provisions lower-priority capacity before admitting a bound workload', async (t) => {
    const node = new SchedulerNode({
      shardCount: 1,
      capacity: 2,
      batchPool: { minThreads: 0, maxThreads: 1, idleTimeoutMs: 30_000 }
    });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'stateful', entryPath: longlived, replication: 'bound' });
      const shard = node.collection().placementOf(id);
      t.equal(node.collection().shardClassOf(shard ?? ''), 'batch', 'bound work never starts on a latency reactor');
      t.equal(node.collection().replicationOf(id), 'bound');
      const released = node.whenReleased(id);
      node.revoke(id, 'test-done');
      await released;
    } finally {
      await node.shutdown();
    }
  });

  it('retires an on-demand batch reactor after its idle timeout', async (t) => {
    const node = new SchedulerNode({
      shardCount: 1,
      capacity: 2,
      syncSliceThresholdMicros: 10_000,
      batchPool: { minThreads: 0, maxThreads: 1, idleTimeoutMs: 25 }
    });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'compute', entryPath: syncHeavy, data: { busyMs: 50 } });
      wakeFor(node, id, 'sample-1');
      await new Promise((resolve) => setTimeout(resolve, 400));
      wakeFor(node, id, 'sample-2');
      for (let i = 0; i < 100; i++) {
        const shard = node.collection().placementOf(id);
        if (shard !== null && node.collection().shardClassOf(shard) === 'batch') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const released = node.whenReleased(id);
      node.revoke(id, 'test-done');
      await released;
      for (let i = 0; i < 100 && node.shardIds().some((shard) => shard.startsWith('batch-')); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      t.equal(node.shardIds().some((shard) => shard.startsWith('batch-')), false, 'the cold batch pool returned to zero threads');
    } finally {
      await node.shutdown();
    }
  });

  it('does not offload an affinity-pinned blocking workload', async (t) => {
    const node = new SchedulerNode({
      shardCount: 1,
      batchPool: { minThreads: 1 },
      capacity: 2,
      syncSliceThresholdMicros: 10_000
    });
    node.start();
    try {
      const id = node.deploy({
        tenantId: 'core',
        entryPath: syncHeavy,
        affinity: 'shard-0',
        data: { busyMs: 40 }
      });
      wakeFor(node, id, 'go');
      await new Promise((resolve) => setTimeout(resolve, 250));
      t.equal(node.collection().placementOf(id), 'shard-0', 'hard affinity prevented automatic movement');
      const outcome = await node.move(id, 'batch-0');
      t.equal(outcome.status, 'deferred', 'manual movement respects the same pin');
      const released = node.whenReleased(id);
      node.revoke(id, 'test-done');
      await released;
    } finally {
      await node.shutdown();
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

  it('propagates a failed host operation back to tenant await with its message', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('fileerr');
    await fs.mkdir(root);
    const out = `${root}/err.txt`;
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'io', entryPath: fileErrorWorker, data: { missingPath: `${root}/does-not-exist.bin`, outputPath: out } });
      const released = node.whenReleased(id);
      wakeFor(node, id, 'go');
      await released;
      const message = new TextDecoder().decode(await fs.readFile(out));
      t.equal(message !== 'no-error' && message.length > 0, true, `the facade read rejection reached the tenant (got: ${message})`);
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('revokes a workload that has a host operation in flight without wedging the thread', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('revoke-inflight');
    await fs.mkdir(root);
    const readPath = `${root}/loop-input.bin`;
    const survivorOut = `${root}/survivor.txt`;
    await fs.writeFile(readPath, new Uint8Array(4096));
    const node = new SchedulerNode({ shardCount: 1, capacity: 4 });
    node.start();
    try {
      // A workload looping on facade reads (almost always mid-op), on the same
      // thread as a run-once sibling.
      const loop = node.deploy({ tenantId: 'loop', entryPath: ioLoopWorker, data: { readPath } });
      const loopReleased = node.whenReleased(loop);
      wakeFor(node, loop, 'go');
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Revoke mid-op; the isolate is terminated while a #performHostOp is
      // outstanding — must not leak an unhandled rejection or wedge the thread.
      node.revoke(loop, 'operator');
      await loopReleased;
      // The thread is still healthy: a sibling deployed after the revoke runs.
      const survivor = node.deploy({ tenantId: 'ok', entryPath: runOnce, data: { outputPath: survivorOut, message: 'alive' } });
      const survivorReleased = node.whenReleased(survivor);
      wakeFor(node, survivor, 'go');
      await survivorReleased;
      t.equal(new TextDecoder().decode(await fs.readFile(survivorOut)), 'alive', 'the thread kept working after a mid-op revoke');
    } finally {
      await node.shutdown();
      await fs.unlink(readPath).catch(() => undefined);
      await fs.unlink(survivorOut).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('round-trips full-range binary through the file-handle pwrite and write paths', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('handlebin');
    await fs.mkdir(root);
    const pwritePath = `${root}/pwrite.bin`;
    const writePath = `${root}/write.bin`;
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'io', entryPath: handleBinaryWorker, data: { pwritePath, writePath } });
      const released = node.whenReleased(id);
      wakeFor(node, id, 'go');
      await released;
      for (const path of [pwritePath, writePath]) {
        const got = await fs.readFile(path);
        t.equal(got.length, 256, `${path}: 256 bytes written`);
        t.equal([...got].every((b, i) => b === i), true, `${path}: every 0..255 byte survived the handle write`);
      }
    } finally {
      await node.shutdown();
      await fs.unlink(pwritePath).catch(() => undefined);
      await fs.unlink(writePath).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('quiesces on shutdown: every shard settles its run() and returns a final summary', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('quiesce');
    await fs.mkdir(root);
    const out = `${root}/done.txt`;
    const node = new SchedulerNode({ shardCount: 2, capacity: 4 });
    node.start();
    const id = node.deploy({ tenantId: 'acme', entryPath: runOnce, data: { outputPath: out, message: 'done' } });
    const released = node.whenReleased(id);
    wakeFor(node, id, 'go');
    await released;
    // shutdown() bounds each shard join and returns a summary per shard only if
    // each shard's run() settled cleanly (dispatch + heartbeat loops stopped),
    // rather than being force-killed on the join timeout.
    const summaries = await node.shutdown();
    t.equal(summaries.length, 2, 'a final summary per shard');
    t.equal(summaries.every((s) => typeof s.shardId === 'string' && s.dispatches >= 0), true, 'each shard reported a well-formed summary');
    await fs.unlink(out).catch(() => undefined);
    await fs.rmdir(root).catch(() => undefined);
  });

  it('moves a stateful workload without reconstructing its module mailbox', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('handoff');
    await fs.mkdir(root);
    const out = `${root}/reconstructed.json`;
    const seed = `${root}/seed.json`;
    const node = new SchedulerNode({ shardCount: 2, capacity: 4 });
    node.start();
    try {
      const id = node.deploy({ tenantId: 'acme', entryPath: handoffWorker, data: { outputPath: out, seedPath: seed } });
      t.equal(node.collection().placementOf(id), 'shard-0', 'fresh placement begins on shard-0');
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
      const moved = await node.move(id, 'shard-1');
      t.equal(moved.status, 'moved', `the same isolate attached on shard-1 (${JSON.stringify(moved)})`);
      wakeFor(node, id, 'after-move');
      await released;
      t.deepEqual(JSON.parse(new TextDecoder().decode(await fs.readFile(out))), ['seed-1', 'seed-2', 'after-move', 'live-isolate'], 'module memory survived the live move');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.unlink(seed).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('moves an ordinary live workload without an application drain protocol', async (t) => {
    const fs = new DiskFileSystem();
    const root = tmpRoot('live-move');
    await fs.mkdir(root);
    const out = `${root}/count.txt`;
    const node = new SchedulerNode({ shardCount: 2, capacity: 4 });
    node.start();
    try {
      const id = node.deploy({
        tenantId: 'acme',
        entryPath: longlived,
        data: { outputPath: out, until: 2 }
      });
      t.equal(node.collection().placementOf(id), 'shard-0', 'fresh placement starts on the first latency shard');
      const released = node.whenReleased(id);
      wakeFor(node, id, 'before-move');
      for (let i = 0; i < 100; i++) {
        const count = await fs.readFile(out).then((b) => new TextDecoder().decode(b)).catch(() => '');
        if (count === '1') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const outcome = await node.move(id, 'shard-1');
      t.equal(outcome.status, 'moved', 'the node committed a live-isolate move');
      t.equal(node.collection().placementOf(id), 'shard-1', 'placement follows the attached isolate');
      wakeFor(node, id, 'after-move');
      await released;
      t.equal(new TextDecoder().decode(await fs.readFile(out)), '2', 'module state survived without checkpoint hooks');
    } finally {
      await node.shutdown();
      await fs.unlink(out).catch(() => undefined);
      await fs.rmdir(root).catch(() => undefined);
    }
  });

  it('reserves destination capacity before concurrent live moves', async (t) => {
    const node = new SchedulerNode({ shardCount: 3, capacity: 1 });
    node.start();
    try {
      const first = node.deploy({ tenantId: 'a', entryPath: longlived, data: { outputPath: '/tmp/fino-move-reserve-a' } });
      const second = node.deploy({ tenantId: 'b', entryPath: longlived, data: { outputPath: '/tmp/fino-move-reserve-b' } });
      t.equal(node.collection().placementOf(first), 'shard-0', 'first source is shard-0');
      t.equal(node.collection().placementOf(second), 'shard-1', 'second source is shard-1');

      const [a, b] = await Promise.race([
        Promise.all([
          node.move(first, 'shard-2'),
          node.move(second, 'shard-2')
        ]),
        new Promise<Array<{ status: string }>>((resolve) => setTimeout(() => resolve([{ status: 'timeout' }, { status: 'timeout' }]), 1_000))
      ]);
      t.equal([a.status, b.status].filter((status) => status === 'moved').length, 1, 'one move consumed the only slot');
      t.equal([a.status, b.status].filter((status) => status === 'deferred').length, 1, 'the competing move was deferred before detach');
    } finally {
      await node.shutdown();
      const fs = new DiskFileSystem();
      await fs.unlink('/tmp/fino-move-reserve-a').catch(() => undefined);
      await fs.unlink('/tmp/fino-move-reserve-b').catch(() => undefined);
    }
  });
});
