/**
* Native reactor engine (internal:reactor-engine) — end-to-end loop test.
*
* Spawns a native reactor thread, places tenant workloads through the one realm
* construction path (`placeRealm` + a `__tenant_dispatch` port activation), and
* verifies the place → dispatch → settle(terminated) → release path plus report
* delivery over the cross-thread report channel. This exercises the native
* scheduling loop directly, without the orchestrator on top.
*/
import { describe, it } from 'fino:test/test';
import * as engine from 'internal:reactor-engine';
import { ThreadPort } from 'internal:realm/transport-port';
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

/**
* Place a tenant workload on the engine and dispatch one activation over its
* port — the same protocol SchedulerNode drives, minus the orchestrator. The
* returned port classifies the tenant result: `terminated` revokes with that
* reason, an error revokes as `failed`.
*/
function placeTenant(reactorId: number, workloadId: number, entryPath: string, data: unknown): ThreadPort {
  const info = engine.placeRealm(reactorId, workloadId, entryPath, '', '', '', 1) as {
    portHandle: number;
    portWakeFd: number;
  };
  const port = new ThreadPort(info.portWakeFd, info.portHandle);
  port.addEventListener('message', (ev) => {
    const msg = (ev as { data?: { __tenant_result?: boolean; __tenant_error?: boolean; result?: { result?: string } } }).data;
    if (msg?.__tenant_error) {
      engine.revoke(reactorId, workloadId, 'failed');
    } else if (msg?.__tenant_result && msg.result?.result === 'terminated') {
      engine.revoke(reactorId, workloadId, 'terminated');
    }
  });
  port.start();
  port.postMessage({
    __tenant_dispatch: true,
    request: { workloadId, data, wake: { reason: 'go', sourceId: 'test' } }
  });
  return port;
}

describe('native reactor engine', () => {
  it('places a compute tenant, pumps it, and releases on terminate', async (t) => {
    const rid = engine.spawnReactor({});
    t.ok(rid >= 0, 'spawned a reactor thread');

    const port = placeTenant(rid, 1, worker, { iterations: 500 });
    const released = await waitForReport(rid, (r) => r.type === 'released');
    t.equal(released.workloadId, 1, 'released the placed workload');
    t.equal(released.reason, 'terminated', 'terminal reason is the tenant result');

    port.close();
    engine.shutdown(rid);
  });

  it('runs several tenants placed together', async (t) => {
    const rid = engine.spawnReactor({});
    const ids = [10, 11, 12, 13];
    const ports = ids.map((id) => placeTenant(rid, id, worker, { iterations: 100 }));
    const seen = new Set<number>();
    while (seen.size < ids.length) {
      const released = await waitForReport(rid, (r) => r.type === 'released' && !seen.has(r.workloadId!));
      seen.add(released.workloadId!);
      t.equal(released.reason, 'terminated', `workload ${released.workloadId} terminated`);
    }
    t.equal(seen.size, ids.length, 'all tenants ran and released');

    for (const port of ports) port.close();
    engine.shutdown(rid);
  });

  it('a tenant does direct file I/O through the reactor engine', async (t) => {
    const fs = new DiskFileSystem();
    const inputPath = `/tmp/fino-engine-io-${Math.floor(performance.now())}.bin`;
    await fs.writeFile(inputPath, new Uint8Array(2048).fill(66));

    const rid = engine.spawnReactor({});
    const port = placeTenant(rid, 42, ioWorker, { inputPath, iterations: 5 });
    const released = await waitForReport(rid, (r) => r.type === 'released');
    t.equal(released.workloadId, 42, 'the I/O tenant released');
    t.equal(released.reason, 'terminated', 'it terminated cleanly (reads succeeded)');

    port.close();
    engine.shutdown(rid);
    await fs.unlink(inputPath);
  });

  it('a tenant does direct socket I/O (listen/connect/accept/echo) on the engine', async (t) => {
    const rid = engine.spawnReactor({});
    const port = placeTenant(rid, 77, socketWorker, {});
    const released = await waitForReport(rid, (r) => r.type === 'released');
    t.equal(released.workloadId, 77, 'the socket tenant released');
    t.equal(released.reason, 'terminated', 'the TCP echo completed on the engine');

    port.close();
    engine.shutdown(rid);
  });
});
