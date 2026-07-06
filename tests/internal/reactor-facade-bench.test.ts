/**
* Facade tax measurement: how much overhead the current multi-tenant scheduler
* adds to file I/O versus a direct (non-scheduler) read loop.
*
*   direct  — this realm reads the file N times with real fino:file.
*   facade  — a scheduler tenant reads the same file N times through the
*             file-provider facade (host-op round trip + internal:serializer
*             clone of args and result per read).
*
* The ratio is the per-op scheduler tax the reactor (Phase 2, direct tenant I/O
* driven externally by the shard) is meant to eliminate — the gap to close back
* to the direct baseline. Prints results; asserts both paths completed.
*/
import { describe, it } from 'fino:test/test';
import { SchedulerNode } from 'internal:orchestrator/scheduler-node';
import { DiskFileSystem } from 'fino:file';

const workerPath = new URL('./fixtures/scheduler-bench-read-worker.ts', import.meta.url).pathname;

describe('scheduler facade tax — file reads', () => {
  it('direct vs facade read loop', async (t) => {
    const fs = new DiskFileSystem();
    const stamp = Math.floor(performance.now());
    const inputPath = `/tmp/fino-facade-bench-${stamp}.bin`;
    await fs.writeFile(inputPath, new Uint8Array(1024).fill(65));

    const ITER = 3000;

    // Direct baseline — no scheduler, real fino:file in this realm.
    const d0 = performance.now();
    for (let i = 0; i < ITER; i++) await fs.readFile(inputPath);
    const directMs = performance.now() - d0;

    // Scheduler tenant — same reads through the facade.
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    let facadeMs = 0;
    try {
      const id = node.deploy({ tenantId: 'bench', entryPath: workerPath, data: { inputPath, iterations: ITER } });
      const released = node.whenReleased(id);
      const f0 = performance.now();
      node.wake(id, { workloadId: id, reason: 'message', sourceId: 'go' });
      await released;
      facadeMs = performance.now() - f0;
    } finally {
      await node.shutdown();
    }

    const directOps = Math.round(ITER / (directMs / 1000));
    const facadeOps = Math.round(ITER / (facadeMs / 1000));
    const perOpUs = ((facadeMs - directMs) / ITER) * 1000;
    console.log(`\n  reads: ${ITER}`);
    console.log(`  direct: ${directMs.toFixed(1)}ms  (${directOps} reads/s)`);
    console.log(`  facade: ${facadeMs.toFixed(1)}ms  (${facadeOps} reads/s)`);
    console.log(`  facade tax: ${(facadeMs / directMs).toFixed(1)}x slower, +${perOpUs.toFixed(1)}us/op\n`);

    const summary =
      `reads=${ITER}\n` +
      `direct=${directMs.toFixed(1)}ms ${directOps}/s\n` +
      `facade=${facadeMs.toFixed(1)}ms ${facadeOps}/s\n` +
      `tax=${(facadeMs / directMs).toFixed(1)}x +${perOpUs.toFixed(1)}us/op\n`;
    await fs.writeFile('/tmp/fino-facade-bench-result.txt', new TextEncoder().encode(summary));

    t.ok(directMs > 0, 'direct loop ran');
    t.ok(facadeMs > 0, 'facade loop ran');

    await fs.unlink(inputPath);
  });
});
