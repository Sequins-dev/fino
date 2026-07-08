/**
* Native reactor engine (internal:reactor-engine) — end-to-end loop test.
*
* Spawns a native reactor thread, places compute-only tenants, and verifies the
* place → pump → settle(terminated) → release path plus report delivery over the
* cross-thread report channel. This exercises the native scheduling loop that
* replaces js/internal/scheduler/shard.ts (no facade, no per-slice serialize).
*/
import { describe, it } from 'fino:test/test';
import * as engine from 'internal:reactor-engine';
import { DiskFileSystem } from 'fino:file';

const worker = new URL('./fixtures/reactor-compute-worker.ts', import.meta.url).pathname;
const ioWorker = new URL('./fixtures/reactor-io-worker.ts', import.meta.url).pathname;
const socketWorker = new URL('./fixtures/reactor-socket-worker.ts', import.meta.url).pathname;

interface EngineReport {
  type: string;
  workloadId?: number;
  reason?: string;
}

async function nextReports(reactorId: number): Promise<EngineReport[]> {
  await engine.nextReport(reactorId);
  return engine.drainReports(reactorId) as EngineReport[];
}

/** Collect reports until one satisfies `pred`, then return it. */
async function waitForReport(
  reactorId: number,
  pred: (r: EngineReport) => boolean
): Promise<EngineReport> {
  for (;;) {
    const reports = await nextReports(reactorId);
    const hit = reports.find(pred);
    if (hit !== undefined) return hit;
  }
}

describe('native reactor engine', () => {
  it('places a compute tenant, pumps it, and releases on terminate', async (t) => {
    const rid = engine.spawnReactor({});
    t.ok(rid >= 0, 'spawned a reactor thread');

    engine.place(rid, 1, worker, JSON.stringify({ iterations: 500 }), 0, 'go', 'test');
    engine.wake(rid, 1, 'go', 'test');
    const released = await waitForReport(rid, (r) => r.type === 'released');
    t.equal(released.workloadId, 1, 'released the placed workload');
    t.equal(released.reason, 'terminated', 'terminal reason is the tenant result');

    engine.shutdown(rid);
  });

  it('runs several tenants placed together', async (t) => {
    const rid = engine.spawnReactor({});
    const ids = [10, 11, 12, 13];
    for (const id of ids) {
      engine.place(rid, id, worker, JSON.stringify({ iterations: 100 }), 0, 'go', 'test');
      engine.wake(rid, id, 'go', 'test');
    }
    const seen = new Set<number>();
    while (seen.size < ids.length) {
      const released = await waitForReport(rid, (r) => r.type === 'released' && !seen.has(r.workloadId!));
      seen.add(released.workloadId!);
      t.equal(released.reason, 'terminated', `workload ${released.workloadId} terminated`);
    }
    t.equal(seen.size, ids.length, 'all tenants ran and released');

    engine.shutdown(rid);
  });

  it('a tenant does direct file I/O through the reactor engine', async (t) => {
    const fs = new DiskFileSystem();
    const inputPath = `/tmp/fino-engine-io-${Math.floor(performance.now())}.bin`;
    await fs.writeFile(inputPath, new Uint8Array(2048).fill(66));

    const rid = engine.spawnReactor({});
    engine.place(rid, 42, ioWorker, JSON.stringify({ inputPath, iterations: 5 }), 0, 'go', 'test');
    engine.wake(rid, 42, 'go', 'test');
    const released = await waitForReport(rid, (r) => r.type === 'released');
    t.equal(released.workloadId, 42, 'the I/O tenant released');
    t.equal(released.reason, 'terminated', 'it terminated cleanly (reads succeeded)');

    engine.shutdown(rid);
    await fs.unlink(inputPath);
  });

  it('a tenant does direct socket I/O (listen/connect/accept/echo) on the engine', async (t) => {
    const rid = engine.spawnReactor({});
    engine.place(rid, 77, socketWorker, '{}', 0, 'go', 'test');
    engine.wake(rid, 77, 'go', 'test');
    const released = await waitForReport(rid, (r) => r.type === 'released');
    t.equal(released.workloadId, 77, 'the socket tenant released');
    t.equal(released.reason, 'terminated', 'the TCP echo completed on the engine');

    engine.shutdown(rid);
  });
});
