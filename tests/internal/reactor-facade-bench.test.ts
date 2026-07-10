/**
* Scheduler-tax measurement: how much overhead the multi-tenant scheduler adds
* to file I/O versus a direct (non-scheduler) read loop, now that the native
* reactor engine has replaced the old cross-isolate facade.
*
*   direct        — this realm reads the file N times with real fino:file.
*   orchestrator  — a SchedulerNode tenant reads the same file N times: the
*                   cold-path orchestrator (deploy/claim/report pump) driving the
*                   native engine, which does the reads with direct tenant I/O.
*   engine        — the same worker placed straight on the engine (no
*                   orchestrator), isolating the raw per-thread reactor cost.
*
* The historical facade added ~3.2x / +30 µs per op (72.6k → 23k reads/s) by
* proxying every read cross-isolate with `internal:serializer` round-trips. Both
* engine paths do direct I/O instead, so they should sit far closer to the direct
* baseline. Prints results; asserts every path completed.
*/
import { describe, it } from 'fino:test/test';
import { SchedulerNode } from 'internal:orchestrator/scheduler-node';
import { DiskFileSystem } from 'fino:file';
import * as engine from 'internal:reactor-engine';
import { ThreadPort } from 'internal:realm/transport-port';

const workerPath = new URL('./fixtures/scheduler-bench-read-worker.ts', import.meta.url).pathname;

async function waitForEngineReleased(reactorId: number, workloadId: number): Promise<void> {
  for (;;) {
    await engine.nextReport(reactorId);
    const reports = engine.drainReports(reactorId) as { type: string; workloadId?: number }[];
    if (reports.some((r) => r.type === 'released' && r.workloadId === workloadId)) return;
  }
}

describe('scheduler tax — file reads', () => {
  it('direct vs orchestrator vs raw-engine read loop', async (t) => {
    const fs = new DiskFileSystem();
    const stamp = Math.floor(performance.now());
    const inputPath = `/tmp/fino-facade-bench-${stamp}.bin`;
    await fs.writeFile(inputPath, new Uint8Array(1024).fill(65));

    const ITER = 3000;

    // Direct baseline — no scheduler, real fino:file in this realm.
    const d0 = performance.now();
    for (let i = 0; i < ITER; i++) await fs.readFile(inputPath);
    const directMs = performance.now() - d0;

    // Orchestrator tenant — SchedulerNode driving the engine, direct tenant I/O.
    const node = new SchedulerNode({ shardCount: 1, capacity: 2 });
    node.start();
    let orchMs = 0;
    try {
      const id = node.deploy({ tenantId: 'bench', entryPath: workerPath, data: { inputPath, iterations: ITER } });
      const released = node.whenReleased(id);
      const f0 = performance.now();
      node.wake(id, { workloadId: id, reason: 'message', sourceId: 'go' });
      await released;
      orchMs = performance.now() - f0;
    } finally {
      await node.shutdown();
    }

    // Raw engine tenant — same worker placed directly on the engine through
    // the one realm construction path, dispatched over its port.
    const rid = engine.spawnReactor({});
    let engineMs = 0;
    try {
      const e0 = performance.now();
      const info = engine.placeRealm(rid, 1, workerPath, '', '', '', 1) as {
        portHandle: number;
        portWakeFd: number;
      };
      const port = new ThreadPort(info.portWakeFd, info.portHandle);
      port.addEventListener('message', (ev) => {
        const msg = (ev as { data?: { __tenant_result?: boolean; result?: { result?: string } } }).data;
        if (msg?.__tenant_result && msg.result?.result === 'terminated') {
          engine.revoke(rid, 1, 'terminated');
        }
      });
      port.start();
      port.postMessage({
        __tenant_dispatch: true,
        request: { workloadId: 1, data: { inputPath, iterations: ITER }, wake: { reason: 'go', sourceId: 'test' } }
      });
      await waitForEngineReleased(rid, 1);
      engineMs = performance.now() - e0;
      port.close();
    } finally {
      engine.shutdown(rid);
    }

    const directOps = Math.round(ITER / (directMs / 1000));
    const orchOps = Math.round(ITER / (orchMs / 1000));
    const engineOps = Math.round(ITER / (engineMs / 1000));
    const orchTaxUs = ((orchMs - directMs) / ITER) * 1000;
    const engineTaxUs = ((engineMs - directMs) / ITER) * 1000;
    console.log(`\n  reads: ${ITER}`);
    console.log(`  direct:       ${directMs.toFixed(1)}ms  (${directOps} reads/s)`);
    console.log(`  orchestrator: ${orchMs.toFixed(1)}ms  (${orchOps} reads/s)  ${(orchMs / directMs).toFixed(1)}x, +${orchTaxUs.toFixed(1)}us/op`);
    console.log(`  engine:       ${engineMs.toFixed(1)}ms  (${engineOps} reads/s)  ${(engineMs / directMs).toFixed(1)}x, +${engineTaxUs.toFixed(1)}us/op\n`);

    const summary =
      `reads=${ITER}\n` +
      `direct=${directMs.toFixed(1)}ms ${directOps}/s\n` +
      `orchestrator=${orchMs.toFixed(1)}ms ${orchOps}/s ${(orchMs / directMs).toFixed(1)}x\n` +
      `engine=${engineMs.toFixed(1)}ms ${engineOps}/s ${(engineMs / directMs).toFixed(1)}x\n`;
    await fs.writeFile('/tmp/fino-facade-bench-result.txt', new TextEncoder().encode(summary));

    t.ok(directMs > 0, 'direct loop ran');
    t.ok(orchMs > 0, 'orchestrator loop ran');
    t.ok(engineMs > 0, 'engine loop ran');

    await fs.unlink(inputPath);
  });
});
