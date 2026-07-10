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
import { Socket } from 'fino:net/socket';

const worker = new URL('./fixtures/reactor-compute-worker.ts', import.meta.url).pathname;
const ioWorker = new URL('./fixtures/reactor-io-worker.ts', import.meta.url).pathname;
const socketWorker = new URL('./fixtures/reactor-socket-worker.ts', import.meta.url).pathname;
const movableWorker = new URL('./fixtures/reactor-movable-worker.ts', import.meta.url).pathname;
const movableTimerWorker = new URL('./fixtures/reactor-movable-timer-worker.ts', import.meta.url).pathname;
const syncHeavyWorker = new URL('./fixtures/scheduler-syncheavy-worker.ts', import.meta.url).pathname;
const movableAcceptWorker = new URL('./fixtures/reactor-movable-accept-worker.ts', import.meta.url).pathname;

interface EngineReport {
  type: string;
  workloadId?: number;
  reason?: string;
  reactorClass?: string;
  priorityApplied?: boolean;
  debtMicros?: number;
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

async function waitForReportWithin(
  reactorId: number,
  pred: (r: EngineReport) => boolean,
  timeoutMs: number
): Promise<EngineReport | null> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const hit = (engine.drainReports(reactorId) as EngineReport[]).find(pred);
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return null;
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
  it('reports the requested reactor priority class', async (t) => {
    const rid = engine.spawnReactor({ reactorClass: 'batch' });
    const started = await waitForReportWithin(rid, (r) => r.type === 'started', 250);
    engine.shutdown(rid);
    t.equal(started?.reactorClass, 'batch', 'the native thread received its batch class');
    t.equal(typeof started?.priorityApplied, 'boolean', 'priority application is observable');
  });

  it('continues reporting blocking slices for sustained-pressure decisions', async (t) => {
    const rid = engine.spawnReactor({ syncSliceMicros: 10_000 });
    const workloadId = 90;
    const info = engine.placeRealm(rid, workloadId, syncHeavyWorker, '', '', '', 1) as {
      portHandle: number;
      portWakeFd: number;
    };
    const port = new ThreadPort(info.portWakeFd, info.portHandle);
    port.start();
    port.postMessage({ __tenant_dispatch: true, request: { data: { busyMs: 30 } } });
    const first = await waitForReport(rid, (r) => r.type === 'syncHeavy');
    t.equal(first.workloadId, workloadId, 'the first blocking slice was reported');

    await new Promise((resolve) => setTimeout(resolve, 300));
    port.postMessage({ __tenant_dispatch: true, request: { data: { busyMs: 30 } } });
    let second: EngineReport | undefined;
    let load: EngineReport | undefined;
    const deadline = performance.now() + 500;
    while (performance.now() < deadline && (second === undefined || load === undefined)) {
      for (const report of engine.drainReports(rid) as EngineReport[]) {
        if (report.type === 'syncHeavy') second = report;
        if (report.type === 'load' && (report.debtMicros ?? 0) > 0) load = report;
      }
      if (second === undefined || load === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
    }
    engine.revoke(rid, workloadId, 'terminated');
    port.close();
    engine.shutdown(rid);
    t.equal(second?.workloadId, workloadId, 'later blocking slices remain observable');
    t.ok((load?.debtMicros ?? 0) > 0, 'load reports carry actual accumulated debt');
  });

  it('moves the same live isolate between reactor threads', async (t) => {
    const source = engine.spawnReactor({});
    const destination = engine.spawnReactor({});
    const workloadId = 91;
    const info = engine.placeRealm(source, workloadId, movableWorker, '', '', '', 1) as {
      portHandle: number;
      portWakeFd: number;
    };
    const port = new ThreadPort(info.portWakeFd, info.portHandle);
    const results: Array<{ result?: { count?: number } }> = [];
    port.addEventListener('message', (ev) => {
      const msg = (ev as { data?: { __tenant_result?: boolean; result?: { count?: number } } }).data;
      if (msg?.__tenant_result) results.push(msg);
    });
    port.start();

    port.postMessage({ __tenant_dispatch: true, request: {} });
    while (results.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
    t.equal(results[0]?.result?.count, 1, 'the source isolate established module state');

    await engine.moveRealm(source, destination, workloadId);
    const moved = await waitForReport(destination, (r) => r.type === 'moved');
    t.equal(moved.workloadId, workloadId, 'the destination attached the workload');
    port.postMessage({ __tenant_dispatch: true, request: {} });
    while (results.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    t.equal(results[1]?.result?.count, 2, 'the destination continued in the same isolate');

    engine.revoke(destination, workloadId, 'terminated');
    port.close();
    engine.shutdown(source);
    engine.shutdown(destination);
  });

  it('rehomes pending timers and port watches before the source reactor exits', async (t) => {
    const source = engine.spawnReactor({});
    const destination = engine.spawnReactor({});
    const workloadId = 92;
    const info = engine.placeRealm(source, workloadId, movableTimerWorker, '', '', '', 1) as {
      portHandle: number;
      portWakeFd: number;
    };
    const port = new ThreadPort(info.portWakeFd, info.portHandle);
    let complete: ((value: boolean) => void) | undefined;
    const completed = new Promise<boolean>((resolve) => complete = resolve);
    port.addEventListener('message', (ev) => {
      const msg = (ev as { data?: { __tenant_result?: boolean; result?: { completed?: boolean } } }).data;
      if (msg?.__tenant_result) complete?.(msg.result?.completed === true);
    });
    port.start();
    port.postMessage({ __tenant_dispatch: true, request: { delayMs: 1_000 } });
    await new Promise((resolve) => setTimeout(resolve, 5));

    engine.moveRealm(source, destination, workloadId);
    await waitForReport(destination, (r) => r.type === 'moved');
    const detached = await waitForReportWithin(source, (r) => r.type === 'detached', 250);
    engine.shutdown(source);
    while (engine.reactorAlive(source)) await new Promise((resolve) => setTimeout(resolve, 1));

    const result = await Promise.race([
      completed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500))
    ]);
    t.equal(result, true, 'the pending timer completed after the source exited');

    engine.revoke(destination, workloadId, 'terminated');
    port.close();
    engine.shutdown(destination);
    t.ok(detached, 'the source reported that no workload resources remain attached');
  });

  it('rehomes a pending socket accept before detaching the source', async (t) => {
    const fs = new DiskFileSystem();
    const addressPath = `/tmp/fino-move-accept-${Math.floor(performance.now())}.port`;
    const outputPath = `${addressPath}.out`;
    const source = engine.spawnReactor({});
    const destination = engine.spawnReactor({});
    const workloadId = 93;
    const info = engine.placeRealm(source, workloadId, movableAcceptWorker, '', '', '', 1) as {
      portHandle: number;
      portWakeFd: number;
    };
    const port = new ThreadPort(info.portWakeFd, info.portHandle);
    port.start();
    port.postMessage({ __tenant_dispatch: true, request: { data: { addressPath, outputPath } } });
    let listenPort = 0;
    for (let i = 0; i < 100; i++) {
      listenPort = await fs.readFile(addressPath).then((b) => Number(new TextDecoder().decode(b))).catch(() => 0);
      if (listenPort > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    engine.moveRealm(source, destination, workloadId);
    await waitForReport(destination, (r) => r.type === 'moved');
    const detached = await waitForReportWithin(source, (r) => r.type === 'detached', 500);
    engine.shutdown(source);
    while (engine.reactorAlive(source)) await new Promise((resolve) => setTimeout(resolve, 1));

    const client = await Socket.connect({ family: 'ipv4', ip: '127.0.0.1', port: listenPort });
    const [, writer] = client.split();
    await writer.write(new TextEncoder().encode('after-move'));
    writer.close();
    let output = '';
    for (let i = 0; i < 200; i++) {
      output = await fs.readFile(outputPath).then((b) => new TextDecoder().decode(b)).catch(() => '');
      if (output !== '') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    engine.revoke(destination, workloadId, 'terminated');
    port.close();
    engine.shutdown(destination);
    await fs.unlink(addressPath).catch(() => undefined);
    await fs.unlink(outputPath).catch(() => undefined);
    t.ok(detached, 'the source detached while accept was pending');
    t.equal(output, 'after-move', 'the destination completed the inherited accept');
  });

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
