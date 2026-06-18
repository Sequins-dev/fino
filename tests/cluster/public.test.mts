/**
 * Public integration coverage for fino:cluster over the WebSocket transport.
 */

import { describe, it } from 'fino:test/test';
import { Process, cwd, execPath } from 'fino:process';
import { Realm } from 'fino:realm';
import { startCluster, leaveCluster } from 'fino:cluster';
import * as loop from 'internal:runtime/loop';

const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const remoteCallEntry = `file://${cwd()}/tests/cluster/fixtures/remote-call.mts`;

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
  const proc = new Process(execPath, ['tests/cluster/fixtures/worker-process.mts', String(port)]);
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

describe('fino:cluster public WebSocket integration', () => {
  it('startCluster + joinCluster route remote Realm.call over WebSocket', async (t) => {
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-seed' }), 2_000, 'startCluster');
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
    leaveCluster();
    leaveCluster();
    const port = randomPort();
    await withTimeout(startCluster({ port, nodeId: 'cluster-restart' }), 2_000, 'first startCluster');
    leaveCluster();
    await loop.timeout(20);
    await withTimeout(startCluster({ port: port + 1, nodeId: 'cluster-restart-2' }), 2_000, 'second startCluster');
    leaveCluster();
    t.ok(true, 'cluster state can be reused after leaveCluster');
  });
});
