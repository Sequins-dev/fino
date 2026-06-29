/**
 * Tests for fino:realm remote mode over fino:cluster.
 */

import { after, describe, it } from 'fino:test/test';
import { Process, cwd, execPath } from 'fino:process';
import {
  Facade,
  ImportMap,
  Realm,
  SystemDnsConfig,
  SystemNetConfig,
} from 'fino:realm';
import { startCluster, leaveCluster } from 'fino:cluster';
import * as loop from 'internal:runtime/loop';
import { quicAvailable } from 'fino:net/quic';
import { h3Available } from 'internal:net/http/h3/bindings';

import type echoFn from './fixtures/echo-fn.ts';
import type errorFn from './fixtures/error-fn.ts';
import type facadeCallFn from './fixtures/facade-call.ts';
import type facadeSinkFn from './fixtures/facade-sink-fn.ts';
import type facadeStreamFn from './fixtures/facade-stream-fn.ts';

const root = `${cwd()}/tests/realm/fixtures`;
const clusterTls = {
  cert: `${cwd()}/tests/net/fixtures/test.crt`,
  key: `${cwd()}/tests/net/fixtures/test.key`,
};

function fixture(name: string): string {
  return `file://${root}/${name}`;
}

function decodeUtf8(b: ArrayBuffer | ArrayBufferView): string {
  return new TextDecoder().decode(b);
}

function randomPort(): number {
  return 34_000 + Math.floor(Math.random() * 5_000);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    loop.timeout(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

async function readLine(proc: Process): Promise<string> {
  const bytes = await proc.stdout.readUntil(new Uint8Array([10]), 4096);
  if (bytes === null) throw new Error('worker exited before readiness line');
  return decodeUtf8(bytes).trim();
}

async function waitForWorker(port: number): Promise<Process> {
  const proc = new Process(execPath, ['tests/cluster/fixtures/worker-process.ts', `https://127.0.0.1:${port}/__fino_cluster`]);
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
  const waiting = proc.wait();
  let result: Awaited<ReturnType<Process['wait']>>;
  try {
    result = await withTimeout(waiting, 500, 'worker graceful shutdown');
  } catch {
    proc.kill();
    result = await waiting;
  }
  if (result.code !== 0 && result.signal === null) {
    throw new Error(`worker exited with code ${String(result.code)} signal ${String(result.signal)}`);
  }
}

let sharedWorker: Process | null = null;
let sharedClusterStarted = false;

async function ensureRemoteWorker(): Promise<boolean> {
  if (!quicAvailable || !h3Available) return false;
  if (sharedWorker !== null) return true;
  const port = randomPort();
  await withTimeout(startCluster({ port, nodeId: `realm-remote-seed-${port}`, tls: clusterTls }), 2_000, 'startCluster');
  sharedClusterStarted = true;
  try {
    sharedWorker = await waitForWorker(port);
    return true;
  } catch (err) {
    if (sharedClusterStarted) {
      leaveCluster();
      sharedClusterStarted = false;
    }
    throw err;
  }
}

async function withRemoteWorker<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (!(await ensureRemoteWorker())) return undefined;
  return await fn();
}

describe('Realm remote mode', () => {
  after(async () => {
    if (sharedWorker !== null) {
      await stopWorker(sharedWorker);
      sharedWorker = null;
    }
    if (sharedClusterStarted) {
      leaveCluster();
      sharedClusterStarted = false;
    }
  });

  it('remote: true requires an active cluster', async (t) => {
    await t.rejects(
      async () => {
        new Realm({
          entry: fixture('hello.ts'),
          remote: true,
        });
      },
      /remote: true requires an active cluster/,
    );
  });

  it('call() returns values through the cluster transport', async (t) => {
    await withRemoteWorker(async () => {
      const realm = new Realm<typeof echoFn>({
        entry: fixture('echo-fn.ts'),
        remote: true,
      });
      const result = await withTimeout(realm.call('remote-ok'), 3_000, 'remote call');
      t.equal(result, 'remote-ok', 'remote call result propagated');
    });
  });

  it('call() propagates child function errors', async (t) => {
    await withRemoteWorker(async () => {
      const realm = new Realm<typeof errorFn>({
        entry: fixture('error-fn.ts'),
        remote: true,
      });
      await t.rejects(
        () => withTimeout(realm.call('boom'), 3_000, 'remote call error'),
        /deliberate error/,
      );
    });
  });

  it('run() rejects bootstrap errors from the remote worker', async (t) => {
    await withRemoteWorker(async () => {
      const realm = new Realm({
        entry: fixture('throw-at-toplevel.ts'),
        remote: true,
      });
      await t.rejects(
        () => withTimeout(realm.run(), 3_000, 'remote bootstrap error'),
        /deliberate top-level error/,
      );
    });
  });

  it('terminate() settles a running remote realm', async (t) => {
    await withRemoteWorker(async () => {
      const realm = new Realm({
        entry: fixture('long-running.ts'),
        remote: true,
      });
      const running = withTimeout(realm.run(), 3_000, 'remote terminate');
      await loop.timeout(20);
      realm.terminate();
      await running;
      t.ok(true, 'remote run settled after terminate');
    });
  });

  it('remote facades support scalar calls', async (t) => {
    await withRemoteWorker(async () => {
      const facade = new Facade('fino:test-facade', ['greet'])
        .handle('greet', async (name) => `hello ${name}`);
      const realm = new Realm<typeof facadeCallFn>({
        entry: fixture('facade-call.ts'),
        remote: true,
        overrides: ImportMap.deny([
          { pattern: 'fino:test-facade', directive: facade },
        ]),
      });
      const result = await withTimeout(realm.call(), 3_000, 'remote facade call');
      t.equal(result, 'hello world', 'remote facade scalar result propagated');
    });
  });

  it('remote facades support read streams', async (t) => {
    await withRemoteWorker(async () => {
      const facade = new Facade('fino:test-facade', [])
        .stream('chunks', async function* () {
          yield 'remote-alpha';
          yield 'remote-beta';
        });
      const realm = new Realm<typeof facadeStreamFn>({
        entry: fixture('facade-stream-fn.ts'),
        remote: true,
        overrides: ImportMap.deny([
          { pattern: 'fino:test-facade', directive: facade },
        ]),
      });
      const result = await withTimeout(realm.call(), 3_000, 'remote facade stream') as unknown[];
      t.deepEqual(result, ['remote-alpha', 'remote-beta'], 'remote facade stream chunks propagated');
    });
  });

  it('remote facades support write streams', async (t) => {
    await withRemoteWorker(async () => {
      const received: string[] = [];
      const facade = new Facade('fino:test-facade', [])
        .sendStream('writeChunks', async (_args, source) => {
          for await (const chunk of source) received.push(chunk as string);
          return { chunks: received.length, joined: received.join('') };
        });
      const realm = new Realm<typeof facadeSinkFn>({
        entry: fixture('facade-sink-fn.ts'),
        remote: true,
        overrides: ImportMap.deny([
          { pattern: 'fino:test-facade', directive: facade },
        ]),
      });
      const result = await withTimeout(realm.call(), 3_000, 'remote facade sink') as {
        chunks: number;
        joined: string;
      };
      t.equal(result.chunks, 3, 'remote sink delivered every chunk');
      t.equal(result.joined, 'hello world!', 'remote sink preserved chunk order');
    });
  });

  it('remote import overrides and legacy provider options serialize to the worker', async (t) => {
    await withRemoteWorker(async () => {
      const blocked = new Realm({
        entry: fixture('import-ffi.ts'),
        remote: true,
        blocked: ['fino:ffi'],
      });
      await withTimeout(blocked.run(), 3_000, 'remote blocked import');

      const allowed = new Realm({
        entry: fixture('import-allowed.ts'),
        remote: true,
        overrides: ImportMap.inherit([{ pattern: 'fino:ffi', directive: 'inherit' }]),
        providers: {
          net: new SystemNetConfig(),
          dns: new SystemDnsConfig(),
        },
      });
      await withTimeout(allowed.run(), 3_000, 'remote import/provider parity');
      t.ok(true, 'remote realm accepted import rules and legacy providers');
    });
  });
});
