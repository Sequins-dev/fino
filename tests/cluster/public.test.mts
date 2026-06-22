/**
 * Public integration coverage for fino:cluster over WebTransport.
 */

import { describe, it } from 'fino:test/test';
import { Process, cwd, execPath } from 'fino:process';
import { Realm } from 'fino:realm';
import { startCluster, joinCluster, leaveCluster } from 'fino:cluster';
import * as loop from 'internal:runtime/loop';
import { quicAvailable } from 'fino:net/quic';
import { h3Available } from 'internal:net/http/h3/bindings';

const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const remoteCallEntry = `file://${cwd()}/tests/cluster/fixtures/remote-call.mts`;
const longRunningEntry = `file://${cwd()}/tests/realm/fixtures/long-running.mts`;
const neverFnEntry = `file://${cwd()}/tests/realm/fixtures/never-fn.mts`;
const clusterTls = {
  cert: `${cwd()}/tests/net/fixtures/test.crt`,
  key: `${cwd()}/tests/net/fixtures/test.key`,
};

async function readLine(proc: Process): Promise<string> {
  const bytes = await proc.stdout.readUntil(new Uint8Array([10]), 4096);
  if (bytes === null) throw new Error('worker exited before readiness line');
  return decodeUtf8(bytes).trim();
}

function randomPort(): number {
  return 30_000 + Math.floor(Math.random() * 10_000);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    loop.timeout(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

async function waitForWorker(port: number): Promise<Process> {
  const proc = new Process(execPath, ['tests/cluster/fixtures/worker-process.mts', `https://127.0.0.1:${port}/__fino_cluster`]);
  try {
    const line = await withTimeout(readLine(proc), 2_000, 'worker readiness');
    if (line !== 'worker ready') throw new Error(`unexpected worker readiness line: ${line}`);
    return proc;
  } catch (err) {
    proc.kill();
    throw err;
  }
}

async function stopWorker(proc: Process): Promise<void> {
  proc.stdin.close();
  const result = await proc.wait();
  if (result.code !== 0) {
    throw new Error(`worker exited with code ${String(result.code)} signal ${String(result.signal)}`);
  }
}

async function killWorker(proc: Process): Promise<void> {
  proc.kill();
  await proc.wait();
}

describe('fino:cluster public WebTransport integration', () => {
  it('rejects ws:// cluster seeds', async (t) => {
    await t.rejects(
      () => joinCluster({ seed: 'ws://127.0.0.1:1', nodeId: 'bad-seed' }),
      /WebTransport cluster seeds must use https:/,
    );
  });

  it('startCluster + joinCluster route remote Realm.call over WebTransport', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-seed', tls: clusterTls }), 2_000, 'startCluster');
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm<(name: string) => string>({
        entry: remoteCallEntry,
        remote: true,
      });
      const result = await withTimeout(realm.call('ok'), 3_000, 'remote Realm.call');
      t.equal(result, 'remote:ok', 'remote realm call returned worker result');
    } finally {
      if (worker !== null) await stopWorker(worker);
      leaveCluster();
    }
  });

  it('leaveCluster is idempotent and allows a later start', async (t) => {
    if (!quicAvailable || !h3Available) return;
    leaveCluster();
    leaveCluster();
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-restart', tls: clusterTls }), 2_000, 'first startCluster');
    leaveCluster();
    await loop.timeout(20);
    await withTimeout(startCluster({ port: port + 1, nodeId: 'cluster-restart-2', tls: clusterTls }), 2_000, 'second startCluster');
    leaveCluster();
    t.ok(true, 'cluster state can be reused after leaveCluster');
  });

  it('allows only one active cluster connection per process', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-single-active', tls: clusterTls }), 2_000, 'startCluster');
    try {
      await t.rejects(
        () => startCluster({ port: port + 1, nodeId: 'cluster-second-active', tls: clusterTls }),
        /already connected/i,
        'second startCluster rejects while connected',
      );
    } finally {
      leaveCluster();
    }
  });

  it('remote Realm.run settles after terminate()', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-terminate', tls: clusterTls }), 2_000, 'startCluster');
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm({
        entry: longRunningEntry,
        remote: true,
      });
      const running = withTimeout(realm.run(), 3_000, 'remote Realm.run terminate');
      await loop.timeout(20);
      realm.terminate();
      await running;
      t.ok(true, 'remote realm run settled after terminate');
    } finally {
      if (worker !== null) await stopWorker(worker);
      leaveCluster();
    }
  });

  it('worker loss rejects an active remote Realm.call', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-worker-loss', tls: clusterTls }), 2_000, 'startCluster');
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm<() => Promise<never>>({
        entry: neverFnEntry,
        remote: true,
      });
      const pending = withTimeout(realm.call(), 3_000, 'remote Realm.call worker loss');
      await loop.timeout(50);
      await killWorker(worker);
      worker = null;
      await t.rejects(() => pending);
    } finally {
      if (worker !== null) await stopWorker(worker);
      leaveCluster();
    }
  });

  it('leaveCluster rejects an active remote Realm.call', async (t) => {
    if (!quicAvailable || !h3Available) return;
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-shutdown', tls: clusterTls }), 2_000, 'startCluster');
    let worker: Process | null = null;
    try {
      worker = await waitForWorker(port);
      const realm = new Realm<() => Promise<never>>({
        entry: neverFnEntry,
        remote: true,
      });
      const pending = realm.call();
      await loop.timeout(20);
      leaveCluster();
      await t.rejects(() => withTimeout(pending, 3_000, 'remote Realm.call leaveCluster'), /cluster connection closed/i);
    } finally {
      if (worker !== null) await stopWorker(worker);
      leaveCluster();
    }
  });
});
