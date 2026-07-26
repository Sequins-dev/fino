import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process } from 'fino:process';
import * as loop from 'internal:runtime/loop';
const fs = new DiskFileSystem();
const enc = new TextEncoder();
const dec = new TextDecoder();
const HQ_ROOT = '/private/tmp/fino-quic-hq-test-root';
const WSSL_HQ_CLIENT_CANDIDATES = [
  '/opt/homebrew/bin/wsslhqclient',
  '/usr/local/bin/wsslhqclient',
  '/private/tmp/libngtcp2-1.23.0/examples/wsslhqclient',
  '/private/tmp/libngtcp2-1.22.0/examples/wsslhqclient',
];
const WSSL_HQ_SERVER_CANDIDATES = [
  '/opt/homebrew/bin/wsslhqserver',
  '/usr/local/bin/wsslhqserver',
  '/private/tmp/libngtcp2-1.23.0/examples/wsslhqserver',
  '/private/tmp/libngtcp2-1.22.0/examples/wsslhqserver',
];
async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function ensureHqRoot(): Promise<void> {
  if (!(await exists(HQ_ROOT))) await fs.mkdir(HQ_ROOT);
  await fs.writeFile(`${HQ_ROOT}/echo`, enc.encode('ossl-hq-ok\n'));
}
async function findFirst(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    if (await exists(path)) return path;
  }
  return null;
}
async function collect(
  reader: AsyncIterable<Uint8Array>,
  onChunk?: (text: string) => void,
): Promise<string> {
  let out = '';
  for await (const chunk of reader) {
    const text = dec.decode(chunk);
    out += text;
    onChunk?.(text);
  }
  return out;
}
function delay(ms: number): Promise<void> {
  return loop.timeout(ms);
}
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}
function spawnFino(script: string): Process {
  const proc = new Process('./target/debug/fino', [script]);
  proc.stdin.close();
  return proc;
}
describe('QUIC HQ interop', () => {
  it('exchanges HQ requests with ngtcp2 tools when installed', async (t) => {
    const hqClientPath = await findFirst(WSSL_HQ_CLIENT_CANDIDATES);
    const hqServerPath = await findFirst(WSSL_HQ_SERVER_CANDIDATES);
    if (hqClientPath === null || hqServerPath === null) {
      t.ok(true, 'ngtcp2 HQ tools are not installed; external HQ interop skipped');
      return;
    }
    await ensureHqRoot();
    const hqServer = new Process(hqServerPath, [
      '--quiet',
      '--no-quic-dump',
      '--no-http-dump',
      '-d',
      HQ_ROOT,
      '127.0.0.1',
      '4444',
      'tests/net/fixtures/test.key',
      'tests/net/fixtures/test.crt',
    ]);
    hqServer.stdin.close();
    const hqServerOut = collect(hqServer.stdout);
    const hqServerErr = collect(hqServer.stderr);
    try {
      await delay(250);
      const finoClient = spawnFino('tests/net/fixtures/quic-hq-client.ts');
      const clientOut = collect(finoClient.stdout);
      const clientErr = collect(finoClient.stderr);
      const clientStatus = await withTimeout(finoClient.wait(), 5e3, 'Fino HQ client');
      t.equal(clientStatus.code, 0, await clientErr);
      t.equal((await clientOut).trim(), 'ossl-hq-ok', 'Fino client reads ngtcp2 HQ response');
    } finally {
      hqServer.kill();
      await hqServer.wait();
      await hqServerOut;
      await hqServerErr;
    }
    const finoServer = spawnFino('tests/net/fixtures/quic-hq-server.ts');
    let serverOutText = '';
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const finoServerOut = collect(finoServer.stdout, (text) => {
      serverOutText += text;
      if (serverOutText.includes('ready')) readyResolve();
    });
    const finoServerErr = collect(finoServer.stderr);
    await withTimeout(ready, 5e3, 'Fino HQ server readiness');
    const hqClient = new Process(hqClientPath, [
      '--quiet',
      '--no-quic-dump',
      '--exit-on-all-streams-close',
      '127.0.0.1',
      '4445',
      'http://127.0.0.1:4445/echo',
    ]);
    hqClient.stdin.close();
    const hqClientOut = collect(hqClient.stdout);
    const hqClientErr = collect(hqClient.stderr);
    const hqClientStatus = await withTimeout(hqClient.wait(), 5e3, 'ngtcp2 HQ client');
    t.equal(hqClientStatus.code, 0, (await hqClientErr) + (await hqClientOut));
    const finoServerStatus = await withTimeout(finoServer.wait(), 5e3, 'Fino HQ server');
    const serverOut = await finoServerOut;
    t.equal(finoServerStatus.code, 0, await finoServerErr);
    t.ok(serverOut.includes('GET /echo'), 'Fino server receives ngtcp2 HQ request');
    t.ok(serverOut.includes('done'), 'Fino server completes HQ response');
  });
});
