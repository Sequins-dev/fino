/**
 * Public integration coverage for fino:cluster over WebTransport.
 */
import { describe, it } from 'fino:test/test';
import { Process, cwd, env, execPath } from 'fino:process';
import { Realm } from 'fino:realm';
import { startCluster, joinCluster, leaveCluster } from 'fino:cluster';
import { DiskFileSystem } from 'fino:file';
import * as loop from 'internal:runtime/loop';
import { quicAvailable } from 'fino:net/quic';
import { h3Available } from 'internal:net/http/h3/bindings';
import { startClusterOnAvailablePort } from './test-helpers.ts';
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const remoteCallEntry = `file://${cwd()}/tests/cluster/fixtures/remote-call.ts`;
const longRunningEntry = `file://${cwd()}/tests/realm/fixtures/long-running.ts`;
const neverFnEntry = `file://${cwd()}/tests/cluster/fixtures/never-fn.ts`;
const clusterTls = {
  cert: `${cwd()}/tests/net/fixtures/test.crt`,
  key: `${cwd()}/tests/net/fixtures/test.key`,
};
const CLUSTER_OPERATION_TIMEOUT_MS = 15_000;
const WORKER_READY_TIMEOUT_MS = CLUSTER_OPERATION_TIMEOUT_MS;
const fs = new DiskFileSystem();
async function readLine(proc: Process): Promise<string> {
  const bytes = await proc.stdout.readUntil(new Uint8Array([10]), 4096);
  if (bytes === null) throw new Error('worker exited before readiness line');
  return decodeUtf8(bytes).trim();
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
async function waitForWorker(port: number): Promise<Process> {
  const proc = new Process(execPath, [
    'tests/cluster/fixtures/worker-process.ts',
    `https://127.0.0.1:${port}/__fino_cluster`,
  ]);
  try {
    const line = await withTimeout(readLine(proc), WORKER_READY_TIMEOUT_MS, 'worker readiness');
    if (line !== 'worker ready') throw new Error(`unexpected worker readiness line: ${line}`);
    return proc;
  } catch (err) {
    proc.kill();
    throw err;
  }
}
async function stopWorker(proc: Process): Promise<void> {
  proc.stdin.close();
  const waiting = proc.wait();
  let result: Awaited<ReturnType<Process['wait']>>;
  try {
    result = await withTimeout(waiting, 500, 'worker graceful shutdown');
  } catch {
    proc.kill();
    result = await waiting;
  }
  if (result.code !== 0 && result.signal === null) {
    throw new Error(
      `worker exited with code ${String(result.code)} signal ${String(result.signal)}`,
    );
  }
}
async function killWorker(proc: Process): Promise<void> {
  proc.kill();
  await proc.wait();
}
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.stat(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`remote Realm.call activation timed out after ${timeoutMs}ms`);
      }
      await loop.timeout(10);
    }
  }
}
describe('fino:cluster public WebTransport integration', { exclusive: true }, () => {
  it('rejects ws:// cluster seeds', async (t) => {
    await t.rejects(
      () =>
        joinCluster({
          seed: 'ws://127.0.0.1:1',
          nodeId: 'bad-seed',
        }),
      /WebTransport cluster seeds must use https:/,
    );
  });
  it('startCluster + joinCluster route remote Realm.call over WebTransport', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = await startClusterOnAvailablePort(
      (port) => ({
        port,
        nodeId: 'cluster-seed',
        tls: clusterTls,
      }),
      'startCluster',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm<(name: string) => string>({
        entry: remoteCallEntry,
        remote: true,
      });
      const result = await withTimeout(
        realm.call('ok'),
        CLUSTER_OPERATION_TIMEOUT_MS,
        'remote Realm.call',
      );
      t.equal(result, 'remote:ok', 'remote realm call returned worker result');
    } finally {
      if (worker !== null) await stopWorker(worker);
      await leaveCluster();
    }
  });
  it('startCluster self-joins through the configured IPv6 hostname and path', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = await startClusterOnAvailablePort(
      (port) => ({
        port,
        hostname: '::1',
        path: `/__fino_cluster_ipv6_${port}`,
        nodeId: 'cluster-ipv6-self-join',
        tls: clusterTls,
      }),
      'startCluster IPv6 self-join',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    const firstClose = leaveCluster();
    t.equal(leaveCluster(), firstClose, 'concurrent leaveCluster calls share shutdown');
    await firstClose;
    t.ok(true, 'seed self-join used configured IPv6 hostname and custom path');
  });
  it('leaveCluster is idempotent and allows a later start', async (t) => {
    if (!quicAvailable || !h3Available) return;
    await leaveCluster();
    await leaveCluster();
    const handlesBefore = loop._activeHandleCounts();
    await startClusterOnAvailablePort(
      (port) => ({
        port,
        nodeId: 'cluster-restart',
        tls: clusterTls,
      }),
      'first startCluster',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    await leaveCluster();
    await startClusterOnAvailablePort(
      (port) => ({
        port,
        nodeId: 'cluster-restart-2',
        tls: clusterTls,
      }),
      'second startCluster',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    await leaveCluster();
    t.ok(true, 'cluster state can be reused after leaveCluster');
    const handlesAfter = loop._activeHandleCounts();
    t.equal(handlesAfter.reads, handlesBefore.reads, 'leaveCluster releases cluster read handles');
    t.equal(
      handlesAfter.referencedTimers,
      handlesBefore.referencedTimers,
      'leaveCluster releases timers that could keep the Realm alive',
    );
  });
  it('allows only one active cluster connection per process', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = await startClusterOnAvailablePort(
      (port) => ({
        port,
        nodeId: 'cluster-single-active',
        tls: clusterTls,
      }),
      'startCluster',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    try {
      await t.rejects(
        () =>
          startCluster({
            port: port + 1,
            nodeId: 'cluster-second-active',
            tls: clusterTls,
          }),
        /already connected/i,
        'second startCluster rejects while connected',
      );
    } finally {
      await leaveCluster();
    }
  });
  it('remote Realm.run settles after terminate()', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = await startClusterOnAvailablePort(
      (port) => ({
        port,
        nodeId: 'cluster-terminate',
        tls: clusterTls,
      }),
      'startCluster',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm({
        entry: longRunningEntry,
        remote: true,
      });
      const running = withTimeout(
        realm.run(),
        CLUSTER_OPERATION_TIMEOUT_MS,
        'remote Realm.run terminate',
      );
      await loop.timeout(20);
      realm.terminate();
      await running;
      t.ok(true, 'remote realm run settled after terminate');
    } finally {
      if (worker !== null) await stopWorker(worker);
      await leaveCluster();
    }
  });
  it('worker loss rejects an active remote Realm.call', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const oldInterval = env.FINO_CLUSTER_HEARTBEAT_INTERVAL_MS;
    const oldTimeout = env.FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS;
    env.FINO_CLUSTER_HEARTBEAT_INTERVAL_MS = '50';
    env.FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS = '1000';
    const port = await startClusterOnAvailablePort(
      (port) => ({
        port,
        nodeId: 'cluster-worker-loss',
        tls: clusterTls,
      }),
      'startCluster',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    let worker: Process | null = null;
    const marker = `/tmp/fino-cluster-call-active-${Date.now()}-${Math.random()}`;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm<(marker: string) => Promise<never>>({
        entry: neverFnEntry,
        remote: true,
      });
      const pending = withTimeout(
        realm.call(marker),
        CLUSTER_OPERATION_TIMEOUT_MS,
        'remote Realm.call worker loss',
      );
      await waitForFile(marker, CLUSTER_OPERATION_TIMEOUT_MS);
      await killWorker(worker);
      worker = null;
      await t.rejects(() => pending, /peer .* disconnected/);
    } finally {
      if (worker !== null) await stopWorker(worker);
      await leaveCluster();
      if (oldInterval === undefined) delete env.FINO_CLUSTER_HEARTBEAT_INTERVAL_MS;
      else env.FINO_CLUSTER_HEARTBEAT_INTERVAL_MS = oldInterval;
      if (oldTimeout === undefined) delete env.FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS;
      else env.FINO_CLUSTER_HEARTBEAT_TIMEOUT_MS = oldTimeout;
      try {
        await fs.unlink(marker);
      } catch {}
    }
  });
  it('leaveCluster rejects an active remote Realm.call', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = await startClusterOnAvailablePort(
      (port) => ({
        port,
        nodeId: 'cluster-shutdown',
        tls: clusterTls,
      }),
      'startCluster',
      CLUSTER_OPERATION_TIMEOUT_MS,
    );
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm<() => Promise<never>>({
        entry: neverFnEntry,
        remote: true,
      });
      const pending = realm.call();
      await loop.timeout(20);
      await leaveCluster();
      await t.rejects(
        () => withTimeout(pending, CLUSTER_OPERATION_TIMEOUT_MS, 'remote Realm.call leaveCluster'),
        /cluster connection closed/i,
      );
    } finally {
      if (worker !== null) await stopWorker(worker);
      await leaveCluster();
    }
  });
});
