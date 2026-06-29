/**
 * Autobahn Testsuite — RFC 6455 WebSocket server conformance.
 *
 * Runs Autobahn `wstest` in fuzzing-client mode against a live Fino echo
 * server. Either `wstest` must be installed or the Autobahn Docker image must
 * already be available locally. Docker is deliberately used only with an
 * existing image so this test never pulls network dependencies implicitly.
 * Missing harness dependencies are hard failures, not skips.
 *
 * Coverage runs the complete emitted Autobahn WebSocket server suite when
 * `FINO_FULL_SPEC_TESTS=1` is set.
 */

import { describe, it, before, after } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, env } from 'fino:process';
import { serve } from 'fino:net/http/server';
import { WebSocketConnection } from 'fino:net/http/websocket';
import { specSuiteSkipReason, specSuitesEnabled } from './spec-gate.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const fs = new DiskFileSystem('/');

const WSTEST_CANDIDATES = [
  '/opt/homebrew/bin/wstest',
  '/usr/local/bin/wstest',
  `${env.HOME ?? ''}/.local/bin/wstest`,
  '/usr/bin/wstest',
];

const DOCKER_CANDIDATES = [
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/usr/bin/docker',
];

const AUTOBahn_IMAGE = 'crossbario/autobahn-testsuite';
const AUTOBahn_IMAGE_CANDIDATES = [
  `${AUTOBahn_IMAGE}:local`,
  `${AUTOBahn_IMAGE}:latest`,
  AUTOBahn_IMAGE,
];
const AUTOBahn_SUITES = [
  { name: 'group 1 baseline cases', patterns: ['1.*'], requiredGroups: ['1'] },
  { name: 'group 2 baseline cases', patterns: ['2.*'], requiredGroups: ['2'] },
  { name: 'group 3 baseline cases', patterns: ['3.*'], requiredGroups: ['3'] },
  { name: 'group 4 baseline cases', patterns: ['4.*'], requiredGroups: ['4'] },
  { name: 'group 5 baseline cases', patterns: ['5.*'], requiredGroups: ['5'] },
  { name: 'group 6 baseline cases', patterns: ['6.*'], requiredGroups: ['6'] },
  { name: 'group 7 baseline cases', patterns: ['7.*'], requiredGroups: ['7'] },
  { name: 'group 9 baseline cases', patterns: ['9.*'], requiredGroups: ['9'] },
  // Autobahn's wildcard emits the baseline suite but not these optional group
  // patterns, so collect them explicitly to avoid silently skipping coverage.
  { name: 'group 10 optional cases', patterns: ['10.*'], requiredGroups: ['10'] },
  { name: 'group 12.1 permessage-deflate cases', patterns: ['12.1.*'], requiredGroups: ['12'] },
  { name: 'group 12.2 permessage-deflate cases', patterns: ['12.2.*'], requiredGroups: ['12'] },
  { name: 'group 12.3 permessage-deflate cases', patterns: ['12.3.*'], requiredGroups: ['12'] },
  { name: 'group 12.4 permessage-deflate cases', patterns: ['12.4.*'], requiredGroups: ['12'] },
  { name: 'group 12.5 permessage-deflate cases', patterns: ['12.5.*'], requiredGroups: ['12'] },
  { name: 'group 13.1 permessage-deflate cases', patterns: ['13.1.*'], requiredGroups: ['13'] },
  { name: 'group 13.2 permessage-deflate cases', patterns: ['13.2.*'], requiredGroups: ['13'] },
  { name: 'group 13.3 permessage-deflate cases', patterns: ['13.3.*'], requiredGroups: ['13'] },
  { name: 'group 13.4 permessage-deflate cases', patterns: ['13.4.*'], requiredGroups: ['13'] },
  { name: 'group 13.5 permessage-deflate cases', patterns: ['13.5.*'], requiredGroups: ['13'] },
  { name: 'group 13.6 permessage-deflate cases', patterns: ['13.6.*'], requiredGroups: ['13'] },
  { name: 'group 13.7 permessage-deflate cases', patterns: ['13.7.*'], requiredGroups: ['13'] },
];
const AUTOBahn_SUITE_FILTER = env.FINO_AUTOBAHN_SUITE;
const AUTOBahn_SPEC_ENABLED = specSuitesEnabled || env.FINO_FULL_SPEC_TESTS === '1';
const AUTOBahn_ACTIVE_SUITES =
  typeof AUTOBahn_SUITE_FILTER === 'string' && AUTOBahn_SUITE_FILTER.trim() !== ''
    ? AUTOBahn_SUITES.filter(suite =>
      suite.name.includes(AUTOBahn_SUITE_FILTER.trim()) ||
      suite.patterns.some(pattern => pattern.includes(AUTOBahn_SUITE_FILTER.trim())))
    : AUTOBahn_SUITES;
const skipAutobahn = !AUTOBahn_SPEC_ENABLED && specSuiteSkipReason;

interface AutobahnCase {
  id: string;
  behavior: string;
  behaviorClose: string;
  duration: number | null;
  remoteCloseCode: number | null;
  reportFile: string;
}

interface AutobahnTool {
  kind: 'wstest' | 'docker';
  path: string;
  image?: string;
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
  if (wstest !== null) {
    const probe = await runProcess(wstest, ['--version']);
    if (probe.code === 0) return { kind: 'wstest', path: wstest };
  }

  const docker = await findCandidate(DOCKER_CANDIDATES);
  if (docker === null) return null;

  const image = await findAutobahnImage(docker);
  if (image === null) return null;
  return { kind: 'docker', path: docker, image };
}

async function dockerServerArch(docker: string): Promise<string> {
  const result = await runProcess(docker, ['version', '--format', '{{.Server.Arch}}']);
  return result.code === 0 ? result.stdout.trim() : '';
}

async function dockerImageArch(docker: string, image: string): Promise<string | null> {
  const result = await runProcess(docker, ['image', 'inspect', image, '--format', '{{.Architecture}}']);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

async function findAutobahnImage(docker: string): Promise<string | null> {
  const envImage = env.FINO_AUTOBAHN_IMAGE;
  if (typeof envImage === 'string' && envImage.trim() !== '') {
    const arch = await dockerImageArch(docker, envImage.trim());
    if (arch !== null) return envImage.trim();
    return null;
  }

  const serverArch = await dockerServerArch(docker);
  let fallback: string | null = null;
  for (const image of AUTOBahn_IMAGE_CANDIDATES) {
    const arch = await dockerImageArch(docker, image);
    if (arch === null) continue;
    if (fallback === null) fallback = image;
    if (serverArch !== '' && arch === serverArch) return image;
  }
  return fallback;
}

function normalizeBehavior(value: unknown): string {
  return String(value ?? '').toUpperCase();
}

function parseAutobahnIndex(jsonText: string): AutobahnCase[] {
  const raw = JSON.parse(jsonText) as Record<string, any>;
  const agent = isRecord(raw.fino) ? raw.fino : raw;
  const cases: AutobahnCase[] = [];

  for (const [id, value] of Object.entries(agent)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

async function runAutobahn(tool: AutobahnTool, port: number, reportDir: string, casePatterns: string[]): Promise<void> {
  const configPath = `${reportDir}/fuzzingclient.json`;
  const host = tool.kind === 'docker' ? 'host.docker.internal' : '127.0.0.1';
  const config = {
    outdir: reportDir,
    servers: [{
      agent: 'fino',
      url: `ws://${host}:${port}/`,
      options: { version: 18 },
    }],
    cases: casePatterns,
    excludeCases: [],
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
      tool.image!,
      'wstest', '-m', 'fuzzingclient', '-s', configPath,
    ]);

  if (result.code !== 0) {
    throw new Error(`Autobahn exited ${result.code}\nstdout:\n${result.stdout.trim()}\nstderr:\n${result.stderr.trim()}`);
  }
}

let server: ReturnType<typeof serve> | undefined;
let tool: AutobahnTool | null | undefined;

async function getAutobahnTool(): Promise<AutobahnTool | null> {
  if (tool === undefined) tool = await findAutobahnTool();
  return tool;
}

async function collectAutobahnCases(casePatterns: string[]): Promise<Map<string, AutobahnCase>> {
  const autobahnTool = await getAutobahnTool();
  if (autobahnTool === null) {
    throw new Error('Autobahn harness unavailable: install wstest or pre-load the crossbario/autobahn-testsuite Docker image');
  }

  const reportDir = `/tmp/fino-autobahn-${Date.now()}`;
  server = await startEchoServer();
  try {
    await runAutobahn(autobahnTool, server.port, reportDir, casePatterns);
    return new Map(parseAutobahnIndex(await readText(`${reportDir}/index.json`)).map(c => [c.id, c]));
  } finally {
    await server.close();
    server = undefined;
  }
}

describe('Autobahn — RFC 6455 WebSocket conformance', { skip: skipAutobahn }, () => {
  if (!AUTOBahn_SPEC_ENABLED) {
    it('preflight', { skip: specSuiteSkipReason }, () => {});
    return;
  }

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

  for (const suite of AUTOBahn_ACTIVE_SUITES) {
    describe(suite.name, () => {
      let suiteCases = new Map<string, AutobahnCase>();
      let emittedCaseIds: string[] = [];

      before(async () => {
        suiteCases = await collectAutobahnCases(suite.patterns);
        emittedCaseIds = [...suiteCases.keys()].sort(compareCaseIds);
      });

      it('records Autobahn case results', (t) => {
        if (suite.requiredGroups.length === 0 && suiteCases.size === 0) {
          t.ok(true, 'Autobahn emitted no cases for this optional group');
          return;
        }
        t.ok(suiteCases.size > 0, 'Autobahn report contains scheduled cases');
      });

      it('records expected Autobahn groups', (t) => {
        for (const group of suite.requiredGroups) {
          t.ok(emittedCaseIds.some(id => id.startsWith(`${group}.`)), `Autobahn group ${group} was emitted`);
        }
      });

      it('passes every emitted Autobahn case', (t) => {
        const failed = [...suiteCases.values()].filter(c => !passingCase(c));
        t.deepEqual(
          failed.map(c => `${c.id}: behavior=${c.behavior || '<empty>'}, behaviorClose=${c.behaviorClose || '<empty>'}, report=${c.reportFile || '<none>'}`),
          [],
          'all emitted Autobahn cases pass',
        );
      });
    });
  }
});
