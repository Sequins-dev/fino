/**
 * Autobahn Testsuite — RFC 6455 WebSocket server conformance.
 *
 * Runs Autobahn `wstest` in fuzzing-client mode against a live Fino echo
 * server. Either `wstest` must be installed or the Autobahn Docker image must
 * already be available locally. Docker is deliberately used only with an
 * existing image so this test never pulls network dependencies implicitly.
 * Missing harness dependencies are hard failures, not skips.
 *
 * Default coverage is limited to non-extension, non-mass/performance server
 * cases. Fino documents extension negotiation, including permessage-deflate,
 * as out of scope for this release.
 */

import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process } from 'fino:process';
import { serve } from 'fino:net/http/server';
import { WebSocketConnection } from 'fino:net/http/websocket';

const enc = new TextEncoder();
const dec = new TextDecoder();
const fs = new DiskFileSystem('/');

const WSTEST_CANDIDATES = [
  '/opt/homebrew/bin/wstest',
  '/usr/local/bin/wstest',
  '/usr/bin/wstest',
];

const DOCKER_CANDIDATES = [
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/usr/bin/docker',
];

const AUTOBahn_IMAGE = 'crossbario/autobahn-testsuite';
const CASES = [
  '1.*',
  '2.*',
  '3.*',
  '4.*',
  '5.*',
  '6.*',
  '7.*',
  '9.*',
  '10.*',
  '12.*',
  '13.*',
];

interface AutobahnCase {
  id: string;
  behavior: string;
  behaviorClose: string;
  duration: number | null;
  remoteCloseCode: number | null;
  reportFile: string;
}

interface AutobahnGroup {
  children: Map<string, AutobahnGroup>;
  leaves: string[];
}

interface AutobahnTool {
  kind: 'wstest' | 'docker';
  path: string;
}

interface AutobahnTestContext {
  ok(value: unknown, message?: string): void;
  fail(message?: string): void;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string> {
  const file = await fs.open(path);
  try {
    return dec.decode(await file.bytes());
  } finally {
    await file.close();
  }
}

async function runProcess(path: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = new Process(path, args);
  try { proc.stdin.close(); } catch {}

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drainOut = (async () => { for await (const c of proc.stdout) stdoutChunks.push(c); })();
  const drainErr = (async () => { for await (const c of proc.stderr) stderrChunks.push(c); })();
  const { code } = await proc.wait();
  await drainOut;
  await drainErr;
  try { await proc.stdout.close(); } catch {}
  try { await proc.stderr.close(); } catch {}

  return {
    code,
    stdout: dec.decode(concat(stdoutChunks)),
    stderr: dec.decode(concat(stderrChunks)),
  };
}

async function findCandidate(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function findAutobahnTool(): Promise<AutobahnTool | null> {
  const wstest = await findCandidate(WSTEST_CANDIDATES);
  if (wstest !== null) return { kind: 'wstest', path: wstest };

  const docker = await findCandidate(DOCKER_CANDIDATES);
  if (docker === null) return null;

  const image = await runProcess(docker, ['image', 'inspect', AUTOBahn_IMAGE]);
  if (image.code !== 0) return null;
  return { kind: 'docker', path: docker };
}

function normalizeBehavior(value: unknown): string {
  return String(value ?? '').toUpperCase();
}

function parseAutobahnIndex(jsonText: string): AutobahnCase[] {
  const raw = JSON.parse(jsonText) as Record<string, any>;
  const cases: AutobahnCase[] = [];

  for (const [id, value] of Object.entries(raw)) {
    if (id === 'agent') continue;
    if (value === null || typeof value !== 'object') continue;
    cases.push({
      id,
      behavior: normalizeBehavior(value.behavior),
      behaviorClose: normalizeBehavior(value.behaviorClose),
      duration: typeof value.duration === 'number' ? value.duration : null,
      remoteCloseCode: typeof value.remoteCloseCode === 'number' ? value.remoteCloseCode : null,
      reportFile: typeof value.reportfile === 'string' ? value.reportfile : '',
    });
  }

  cases.sort((a, b) => compareCaseIds(a.id, b.id));
  return cases;
}

function compareCaseIds(a: string, b: string): number {
  const aa = a.split('.').map(part => Number(part));
  const bb = b.split('.').map(part => Number(part));
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function passingCase(c: AutobahnCase): boolean {
  const behaviorOk = c.behavior === 'OK' || c.behavior === 'INFORMATIONAL' || c.behavior === 'NON-STRICT';
  const closeOk = c.behaviorClose === '' || c.behaviorClose === 'OK' || c.behaviorClose === 'INFORMATIONAL' || c.behaviorClose === 'NON-STRICT';
  return behaviorOk && closeOk;
}

function newGroup(): AutobahnGroup {
  return { children: new Map(), leaves: [] };
}

function groupCases(cases: string[]): AutobahnGroup {
  const root = newGroup();
  for (const id of cases) {
    const parts = id.split('.');
    const leaf = parts.pop();
    if (!leaf) continue;
    let group = root;
    for (const part of parts) {
      let child = group.children.get(part);
      if (!child) {
        child = newGroup();
        group.children.set(part, child);
      }
      group = child;
    }
    group.leaves.push(leaf);
  }
  return root;
}

function defineCaseTests(
  group: AutobahnGroup,
  prefix: string[],
  getCase: (id: string) => AutobahnCase | undefined,
): void {
  for (const [part, child] of group.children) {
    const path = [...prefix, part];
    describe(`case group ${path.join('.')}`, () => {
      defineCaseTests(child, path, getCase);
    });
  }

  for (const leaf of group.leaves) {
    const id = [...prefix, leaf].join('.');
    it(`case ${id}`, (t: AutobahnTestContext) => {
      const result = getCase(id);
      if (result === undefined) {
        t.fail(`Autobahn case ${id} was not present in report`);
        return;
      }
      if (!passingCase(result)) {
        t.fail(
          `Autobahn case ${id} failed: behavior=${result.behavior || '<empty>'}, ` +
          `behaviorClose=${result.behaviorClose || '<empty>'}, report=${result.reportFile || '<none>'}`,
        );
        return;
      }
      t.ok(true, `Autobahn case ${id} passed`);
    });
  }
}

async function startEchoServer(): Promise<ReturnType<typeof serve>> {
  return serve({ port: 0 }, async (incoming) => {
    if (incoming.kind !== 'websocket') {
      await incoming.reject(new Response('', { status: 404 }));
      return;
    }

    const ws = await incoming.accept();
    (async () => {
      for await (const msg of ws) {
        if (msg.type === 'text' || msg.type === 'binary') ws.send(msg.data as any);
      }
    })().catch(() => {});
  });
}

async function runAutobahn(tool: AutobahnTool, port: number, reportDir: string): Promise<void> {
  const configPath = `${reportDir}/fuzzingclient.json`;
  const config = {
    outdir: reportDir,
    servers: [{
      agent: 'fino',
      url: `ws://127.0.0.1:${port}/`,
      options: { version: 18 },
    }],
    cases: CASES,
    excludeCases: [
      '8.*',
      '11.*',
      '12.1.3',
      '12.1.4',
    ],
    excludeAgentCases: {},
  };
  await fs.mkdir(reportDir);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  const result = tool.kind === 'wstest'
    ? await runProcess(tool.path, ['-m', 'fuzzingclient', '-s', configPath])
    : await runProcess(tool.path, [
      'run', '--rm',
      '--network', 'host',
      '-v', `${reportDir}:${reportDir}`,
      AUTOBahn_IMAGE,
      'wstest', '-m', 'fuzzingclient', '-s', configPath,
    ]);

  if (result.code !== 0) {
    throw new Error(`Autobahn exited ${result.code}\nstdout:\n${result.stdout.trim()}\nstderr:\n${result.stderr.trim()}`);
  }
}

const tool = await findAutobahnTool();
let server: ReturnType<typeof serve>;
let cases = new Map<string, AutobahnCase>();

describe('Autobahn — RFC 6455 WebSocket conformance', () => {
  before(async () => {
    if (tool === null) {
      throw new Error('Autobahn harness unavailable: install wstest or pre-load the crossbario/autobahn-testsuite Docker image');
    }
    const reportDir = `/tmp/fino-autobahn-${Date.now()}`;
    server = await startEchoServer();
    await runAutobahn(tool, server.port, reportDir);
    cases = new Map(parseAutobahnIndex(await readText(`${reportDir}/index.json`)).map(c => [c.id, c]));
  });

  after(async () => {
    if (server) await server.close();
  });

  it('parses Autobahn report cases independently', (t) => {
    const parsed = parseAutobahnIndex(JSON.stringify({
      agent: 'fino',
      '1.2.1': { behavior: 'OK', behaviorClose: 'OK', duration: 1, remoteCloseCode: 1000, reportfile: 'case1.html' },
      '1.1.1': { behavior: 'FAILED', behaviorClose: 'OK', reportfile: 'case2.html' },
    }));

    t.deepEqual(parsed.map(c => c.id), ['1.1.1', '1.2.1'], 'cases are sorted by numeric case id');
    t.equal(passingCase(parsed[0]!), false, 'failed behavior fails the case');
    t.equal(passingCase(parsed[1]!), true, 'OK behavior passes the case');
  });

  it('records at least one Autobahn case result', (t) => {
    t.ok(cases.size > 0, 'Autobahn report contains scheduled cases');
  });

  defineCaseTests(groupCases([
    '1.1.1', '1.1.2', '1.2.1', '1.2.2', '1.3.1', '1.3.2',
    '2.1', '2.2', '2.3', '2.4',
    '3.1', '3.2', '3.3',
    '4.1.1', '4.1.2', '4.2.1', '4.2.2',
    '5.1', '5.2', '5.3',
    '6.1.1', '6.2.1', '6.3.1',
    '7.1.1', '7.3.1', '7.5.1', '7.7.1', '7.9.1',
    '9.1.1', '9.2.1', '9.3.1', '9.4.1',
    '10.1.1', '10.2.1',
    '12.1.1', '12.1.2',
    '13.1.1', '13.2.1', '13.3.1',
  ]), [], id => cases.get(id));
});
