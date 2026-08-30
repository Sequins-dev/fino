/**
 * Benchmarks for fino:cluster
 *
 * Run with: cargo run -- bench benchmarks/cluster.bench.ts
 */
import { getCluster, joinCluster, leaveCluster, startCluster } from 'fino:cluster';
import { bench } from 'fino:bench';
import { Realm } from 'fino:realm';
import { Process, cwd, execPath } from 'fino:process';
import * as loop from 'internal:runtime/loop';
const remoteCallEntry = `file://${cwd()}/tests/cluster/fixtures/remote-call.ts`;
const neverFnEntry = `file://${cwd()}/tests/realm/fixtures/never-fn.ts`;
function decodeUtf8(b: ArrayBuffer | ArrayBufferView): string {
  return new TextDecoder().decode(b);
}
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timer = loop.timeout(ms);
  timer.unref();
  return Promise.race([
    promise,
    timer.then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]).finally(() => timer.cancel());
}
async function readLine(proc: Process): Promise<string> {
  const bytes = await proc.stdout.readUntil(new Uint8Array([10]), 4096);
  if (bytes === null) throw new Error('worker exited before readiness line');
  return decodeUtf8(bytes).trim();
}
async function waitForWorker(seedPort: number): Promise<Process> {
  const proc = new Process(execPath, [
    'tests/cluster/fixtures/worker-process.ts',
    String(seedPort),
  ]);
  try {
    const line = await withTimeout(readLine(proc), 2e3, 'worker readiness');
    if (line !== 'worker ready') throw new Error(`unexpected worker readiness line: ${line}`);
    return proc;
  } catch (err) {
    proc.kill();
    throw err;
  }
}
async function stopWorker(proc: Process): Promise<void> {
  proc.stdin.close();
  await proc.wait();
}
async function killWorker(proc: Process): Promise<void> {
  proc.kill();
  await proc.wait();
}
bench('cluster state', (b) => {
  b.measure('getCluster() inactive', () => getCluster());
  b.measure('leaveCluster() inactive', () => leaveCluster());
});
bench('cluster public API references', (b) => {
  b.measure('operation references', () => {
    return (
      startCluster !== undefined &&
      joinCluster !== undefined &&
      leaveCluster !== undefined &&
      getCluster !== undefined
    );
  });
});
bench('cluster loopback lifecycle', (b) => {
  b.measure('startCluster + leaveCluster', async () => {
    await startCluster({
      port: 0,
      nodeId: 'bench-seed',
    });
    await leaveCluster();
  });
});
bench('cluster remote realm', (b) => {
  b.measure('spawn and call remote worker', async () => {
    const seedPort = await startCluster({
      port: 0,
      nodeId: 'bench-call',
    });
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(seedPort);
      const realm = new Realm<(name: string) => string>({
        entry: remoteCallEntry,
        remote: true,
      });
      await realm.call('bench');
    } finally {
      if (worker !== null) await stopWorker(worker);
      await leaveCluster();
    }
  });
  b.measure('worker loss rejects active call', async () => {
    const seedPort = await startCluster({
      port: 0,
      nodeId: 'bench-loss',
    });
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(seedPort);
      const realm = new Realm<() => Promise<never>>({
        entry: neverFnEntry,
        remote: true,
      });
      const pending = realm.call().catch(() => undefined);
      await loop.timeout(5);
      await killWorker(worker);
      worker = null;
      await withTimeout(pending, 2e3, 'worker loss rejection');
    } finally {
      if (worker !== null) await stopWorker(worker);
      await leaveCluster();
    }
  });
});
