/**
 * h2spec — RFC 7540/7541 conformance suite.
 *
 * Runs the external `h2spec` binary against a live fino HTTPS server (TLS +
 * ALPN h2). h2spec is skipped if HTTP/2 or TLS support is unavailable in the
 * runtime. Missing `h2spec` harness binaries are hard failures, not skips.
 *
 * ## Pass/fail
 *
 * The test parses h2spec's JUnit XML output and fails when any scheduled case
 * fails. h2spec v2.6 exposes no server-side `http2/6.6` PUSH_PROMISE cases in
 * `--dryrun`; Fino still covers client-sent PUSH_PROMISE rejection locally.
 * Every scheduled h2spec unit is its own test so failures identify the exact
 * Generic, HTTP/2, or HPACK leaf that failed.
 *
 * ## Per-unit invocation
 *
 * h2spec v2.6 has a Go-level panic in its inter-section transition code when
 * passed multiple section args in one invocation. Running sections 3-8 in a
 * single call reliably crashes before writing JUnit. The fix: invoke h2spec
 * once per dry-run leaf; each invocation writes its own JUnit file and maps to
 * one Fino test.
 *
 * ## Case IDs
 *
 * h2spec uses classname+testname from its JUnit XML to form IDs:
 *   classname="http2/6.5.3"  name="1" → id "http2/6.5.3/1"
 *   classname="hpack/2.3"    name="1" → id "hpack/2.3/1"
 *
 * ## Running locally
 *
 *   brew install h2spec          # macOS
 *   go install github.com/summerwind/h2spec/cmd/h2spec@latest  # any platform
 *
 * Then:
 *   cargo run -- test tests/integration/h2spec.test.mts
 */

import { describe, it, before, after } from 'fino:test/test';
import { serveHttp } from 'fino:net/http/server';
import { DiskFileSystem } from 'fino:file';
import { Process } from 'fino:process';
import { h2Available } from '../../js/net/http/h2.mts';
import { specSuiteSkipReason, specSuitesEnabled } from './spec-gate.mts';

if (!h2Available && (globalThis as any).process?.env?.FINO_REQUIRE_H2 === '1') {
  throw new Error('FINO_REQUIRE_H2=1 but libnghttp2 is not available');
}

const decodeUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

const CERT_PATH = new URL('../net/fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH  = new URL('../net/fixtures/test.key',  import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Find the h2spec binary (candidate-path probe, no PATH expansion)
// ---------------------------------------------------------------------------

const _H2SPEC_CANDIDATES = [
  '/opt/homebrew/bin/h2spec',
  '/usr/local/bin/h2spec',
  `${(globalThis as any).process?.env?.HOME ?? ''}/go/bin/h2spec`,
  '/usr/bin/h2spec',
  '/usr/local/go/bin/h2spec',
];

async function _findH2spec(): Promise<string | null> {
  const fs = new DiskFileSystem('/');
  for (const p of _H2SPEC_CANDIDATES) {
    if (!p.startsWith('/')) continue;
    try {
      await fs.stat(p);
      return p;
    } catch { /* not found at this path */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JUnit XML parser — extract case IDs from h2spec output
// ---------------------------------------------------------------------------

interface H2specResults {
  passing: string[];
  failing: string[];
}

interface H2specAggregate {
  passing: Set<string>;
  failing: Set<string>;
}

interface DryrunSection {
  indent: number;
  number: string;
  path: string;
}

interface H2specUnitGroup {
  children: Map<string, H2specUnitGroup>;
  leaves: string[];
}

interface H2specDryrunInfo {
  units: string[];
  labels: Map<string, string>;
}

interface H2specTestContext {
  ok(value: unknown, message?: string): void;
  fail(message?: string): void;
}

function _decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function _parseJunit(xml: string): H2specResults {
  const passing: string[] = [];
  const failing: string[] = [];

  // h2spec v2.6 JUnit format: <testcase package="section" classname="desc" ...>
  // Failing tests have an <error> or <failure> child element.
  // Self-closing tags are passing (no child elements).
  const tagRe = /<testcase\b([^>]*?)(\/>|>(.*?)<\/testcase>)/gs;
  const pkgRe = /package="([^"]*)"/;
  const clsRe = /classname="([^"]*)"/;

  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const attrs = m[1];
    const isSelfClosing = m[2] === '/>';
    const body = isSelfClosing ? '' : (m[3] ?? '');

    const pkg = _decodeXml(pkgRe.exec(attrs)?.[1] ?? '');
    const cls = _decodeXml(clsRe.exec(attrs)?.[1] ?? '');
    if (!pkg && !cls) continue;
    const id = `${pkg}/${cls}`;

    if (!isSelfClosing && (/<error\b/.test(body) || /<failure\b/.test(body))) {
      failing.push(id);
    } else {
      if (!passing.includes(id) && !failing.includes(id)) passing.push(id);
    }
  }

  return { passing, failing };
}

function _mergeH2specResults(aggregate: H2specAggregate, results: H2specResults): void {
  for (const id of results.passing) {
    aggregate.passing.add(id);
    aggregate.failing.delete(id);
  }
  for (const id of results.failing) {
    if (!aggregate.passing.has(id)) {
      aggregate.failing.add(id);
    }
  }
}

function _parseH2specDryrun(stdout: string): H2specDryrunInfo {
  const units: string[] = [];
  const labels = new Map<string, string>();
  const stack: DryrunSection[] = [];
  let suite = '';

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('Generic tests for HTTP/2 server')) {
      suite = 'generic';
      labels.set(suite, line.trim());
      stack.length = 0;
      continue;
    }
    if (line.startsWith('Hypertext Transfer Protocol Version 2')) {
      suite = 'http2';
      labels.set(suite, line.trim());
      stack.length = 0;
      continue;
    }
    if (line.startsWith('HPACK: Header Compression for HTTP/2')) {
      suite = 'hpack';
      labels.set(suite, line.trim());
      stack.length = 0;
      continue;
    }

    const section = /^(\s*)(\d+(?:\.\d+)*)\. (.+)$/.exec(line);
    if (section) {
      const indent = section[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const path = `${suite}/${section[2]}`;
      stack.push({ indent, number: section[2], path });
      labels.set(path, section[3].trim());
      continue;
    }

    const leaf = /^(\s*)(\d+): (.+)$/.exec(line);
    if (!leaf || !suite) continue;

    const indent = leaf[1].length;
    const parent = [...stack].reverse().find(entry => entry.indent < indent);
    if (parent) {
      const unit = `${parent.path}/${leaf[2]}`;
      units.push(unit);
      labels.set(unit, leaf[3].trim());
    }
  }

  return { units, labels };
}

// ---------------------------------------------------------------------------
// Concat helper
// ---------------------------------------------------------------------------

function _concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// ---------------------------------------------------------------------------
// Run h2spec for a single unit and return its JUnit XML
// ---------------------------------------------------------------------------

// h2spec v2.6 panics in its inter-section transition code when multiple section
// args are passed in one invocation (the Go recover() only applies within a
// section's test goroutines, not across sections). Running one leaf unit at a
// time gives each invocation a clean Go process; each writes JUnit reliably.
//
// Keep this list aligned to `h2spec --dryrun`: Generic server cases, RFC HTTP/2
// section cases, and HPACK cases. Parent sections are intentionally expanded to
// leaves so h2spec teardown from one case cannot mask another case's result.
const _H2SPEC_UNITS = [
  'generic/1/1',
  'generic/2/1', 'generic/2/2', 'generic/2/3', 'generic/2/4', 'generic/2/5',
  'generic/3.1/1', 'generic/3.1/2', 'generic/3.1/3',
  'generic/3.2/1', 'generic/3.2/2', 'generic/3.2/3',
  'generic/3.3/1', 'generic/3.3/2', 'generic/3.3/3', 'generic/3.3/4', 'generic/3.3/5',
  'generic/3.4/1', 'generic/3.5/1', 'generic/3.7/1', 'generic/3.8/1',
  'generic/3.9/1', 'generic/3.9/2',
  'generic/3.10/1', 'generic/3.10/2',
  'generic/4/1', 'generic/4/2', 'generic/4/3', 'generic/4/4',
  'generic/5/1', 'generic/5/2', 'generic/5/3', 'generic/5/4', 'generic/5/5',
  'generic/5/6', 'generic/5/7', 'generic/5/8', 'generic/5/9', 'generic/5/10',
  'generic/5/11', 'generic/5/12', 'generic/5/13', 'generic/5/14', 'generic/5/15',

  'http2/3.5/1', 'http2/3.5/2',
  'http2/4.1/1', 'http2/4.1/2', 'http2/4.1/3',
  'http2/4.2/1', 'http2/4.2/2', 'http2/4.2/3',
  'http2/4.3/1', 'http2/4.3/2', 'http2/4.3/3',
  'http2/5.1/1', 'http2/5.1/2', 'http2/5.1/3', 'http2/5.1/4', 'http2/5.1/5',
  'http2/5.1/6', 'http2/5.1/7', 'http2/5.1/8', 'http2/5.1/9', 'http2/5.1/10',
  'http2/5.1/11', 'http2/5.1/12', 'http2/5.1/13',
  'http2/5.1.1/1', 'http2/5.1.1/2', 'http2/5.1.2/1',
  'http2/5.3.1/1', 'http2/5.3.1/2', 'http2/5.4.1/1',
  'http2/5.5/1', 'http2/5.5/2',
  'http2/6.1/1', 'http2/6.1/2', 'http2/6.1/3',
  'http2/6.2/1', 'http2/6.2/2', 'http2/6.2/3', 'http2/6.2/4',
  'http2/6.3/1', 'http2/6.3/2',
  'http2/6.4/1', 'http2/6.4/2', 'http2/6.4/3',
  'http2/6.5/1', 'http2/6.5/2', 'http2/6.5/3',
  'http2/6.5.2/1', 'http2/6.5.2/2', 'http2/6.5.2/3', 'http2/6.5.2/4', 'http2/6.5.2/5',
  'http2/6.5.3/1', 'http2/6.5.3/2',
  'http2/6.7/1', 'http2/6.7/2', 'http2/6.7/3', 'http2/6.7/4',
  'http2/6.8/1',
  'http2/6.9/1', 'http2/6.9/2', 'http2/6.9/3',
  'http2/6.9.1/1', 'http2/6.9.1/2', 'http2/6.9.1/3',
  'http2/6.9.2/1', 'http2/6.9.2/2', 'http2/6.9.2/3',
  'http2/6.10/1', 'http2/6.10/2', 'http2/6.10/3',
  'http2/6.10/4', 'http2/6.10/5', 'http2/6.10/6',
  'http2/7/1', 'http2/7/2',
  'http2/8.1/1', 'http2/8.1.2/1',
  'http2/8.1.2.1/1', 'http2/8.1.2.1/2', 'http2/8.1.2.1/3', 'http2/8.1.2.1/4',
  'http2/8.1.2.2/1', 'http2/8.1.2.2/2',
  'http2/8.1.2.3/1', 'http2/8.1.2.3/2', 'http2/8.1.2.3/3', 'http2/8.1.2.3/4',
  'http2/8.1.2.3/5', 'http2/8.1.2.3/6', 'http2/8.1.2.3/7',
  'http2/8.1.2.6/1', 'http2/8.1.2.6/2',
  'http2/8.2/1',

  'hpack/2.3.3/1', 'hpack/2.3.3/2',
  'hpack/4.2/1',
  'hpack/5.2/1', 'hpack/5.2/2', 'hpack/5.2/3',
  'hpack/6.1/1', 'hpack/6.3/1',
];

function _newH2specUnitGroup(): H2specUnitGroup {
  return { children: new Map(), leaves: [] };
}

function _groupH2specUnits(units: string[]): H2specUnitGroup {
  const root = _newH2specUnitGroup();

  for (const unit of units) {
    const parts = unit.split('/');
    const leaf = parts.pop();
    if (!leaf) continue;

    let group = root;
    for (const part of parts) {
      let child = group.children.get(part);
      if (!child) {
        child = _newH2specUnitGroup();
        group.children.set(part, child);
      }
      group = child;
    }
    group.leaves.push(leaf);
  }

  return root;
}

function _h2specLabel(
  kind: 'suite' | 'section' | 'case',
  number: string,
  path: string,
  labels: Map<string, string>,
): string {
  const title = labels.get(path);
  return title ? `${kind} ${number} - ${title}` : `${kind} ${number}`;
}

async function _runSection(
  h2specPath: string,
  section: string,
  port: number,
): Promise<{ xml: string; stderr: string }> {
  let lastStderr = '';
  // Retry up to 10 times with 500ms between attempts. After h2spec exits, the
  // server has async TLS/nghttp2 cleanup in flight; the next invocation's probe
  // connection can land during that window and get RST/EOF, causing h2spec to
  // exit before writing JUnit. Retrying reliably clears the race.
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (attempt > 1) await new Promise<void>(r => setTimeout(r, 500));

    const junitPath = `/tmp/fino-h2spec-${section.replace(/\//g, '-')}-${Date.now()}.xml`;

    const proc = new Process(h2specPath, [
      section,
      '-h', '127.0.0.1',
      '-p', String(port),
      '-t',          // TLS
      '-k',          // skip cert verify (self-signed fixture)
      '-j', junitPath,
    ]);

    // Close stdin immediately — h2spec doesn't read it, and leaving it open
    // leaks the stdinW fd across sections.
    try { proc.stdin.close(); } catch {}

    const stderrChunks: Uint8Array[] = [];
    const drainErr = (async () => { for await (const c of proc.stderr) stderrChunks.push(c); })();
    // stdout is progress output; drain but discard
    const drainOut = (async () => { for await (const _ of proc.stdout) {} })();
    await proc.wait();
    await drainOut;
    await drainErr;
    // Close pipe read fds explicitly — they are not auto-closed on EOF,
    // and leaving them open accumulates fds across sections.
    try { await proc.stdout.close(); } catch {}
    try { await proc.stderr.close(); } catch {}

    lastStderr = decodeUtf8(_concat(stderrChunks));

    let xml = '';
    try {
      const fs = new DiskFileSystem('/');
      const file = await fs.open(junitPath);
      xml = decodeUtf8(await file.bytes());
      await file.close();
    } catch { /* JUnit not written — section may have had no tests */ }

    if (xml.length > 0) return { xml, stderr: lastStderr };
  }

  return { xml: '', stderr: lastStderr };
}

async function _runDryrun(h2specPath: string): Promise<string> {
  const proc = new Process(h2specPath, ['--dryrun']);
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

  if (code !== 0) {
    throw new Error(`h2spec --dryrun exited ${code}: ${decodeUtf8(_concat(stderrChunks)).trim()}`);
  }

  return decodeUtf8(_concat(stdoutChunks));
}

async function _assertH2specUnitPasses(t: H2specTestContext, unit: string, port: number): Promise<void> {
  let lastFailing: string[] = [];
  let lastStderr = '';
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (attempt > 1) {
      // Give TLS/nghttp2 teardown from the previous unit time to settle.
      await new Promise<void>(r => setTimeout(r, 1000));
    }
    const { xml, stderr } = await _runSection(h2specPath!, unit, port);
    lastStderr = stderr;
    if (!xml) {
      lastFailing = [`${unit} did not produce JUnit (stderr: ${stderr.trim() || '<empty>'})`];
      continue;
    }

    const parsed = _parseJunit(xml);
    if (parsed.passing.length === 0 && parsed.failing.length === 0) {
      lastFailing = [`${unit} JUnit XML parsed no test cases`];
      continue;
    }
    if (parsed.failing.length === 0) {
      t.ok(true, `${parsed.passing.length} h2spec case(s) passed`);
      return;
    }
    lastFailing = parsed.failing;
  }

  const lines = lastFailing.map(id => `  ${id}`).join('\n');
  t.fail(
    `${lastFailing.length} h2spec case(s) failed after retries:\n${lines}` +
    (lastStderr.trim() ? `\n\nstderr:\n${lastStderr.trim()}` : ''),
  );
}

function _defineH2specUnitTests(
  group: H2specUnitGroup,
  prefix: string[],
  getPort: () => number,
  labels: Map<string, string>,
): void {
  for (const [name, child] of group.children) {
    const path = [...prefix, name].join('/');
    const label = prefix.length === 0
      ? _h2specLabel('suite', name, path, labels)
      : _h2specLabel('section', name, path, labels);
    describe(label, () => {
      _defineH2specUnitTests(child, [...prefix, name], getPort, labels);
    });
  }

  for (const leaf of group.leaves) {
    const path = [...prefix, leaf].join('/');
    it(_h2specLabel('case', leaf, path, labels), { skip }, async (t) => {
      await _assertH2specUnitPasses(t, path, getPort());
    });
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const h2specPath = specSuitesEnabled ? await _findH2spec() : null;
const tlsAvailable = (globalThis as any).tlsAvailable as boolean | undefined;

const skip = (!h2Available || !tlsAvailable)
  && 'requires libnghttp2 and OpenSSL support';

if (specSuitesEnabled && !skip && !h2specPath) {
  throw new Error(`h2spec harness unavailable: install h2spec (${_H2SPEC_CANDIDATES[0]})`);
}

const h2specDryrunInfo = specSuitesEnabled && !skip
  ? _parseH2specDryrun(await _runDryrun(h2specPath!))
  : { units: [], labels: new Map<string, string>() };

describe('h2spec — RFC 7540/7541 conformance (TLS)', () => {
  if (!specSuitesEnabled) {
    it('preflight', { skip: specSuiteSkipReason }, () => {});
    return;
  }

  let server: ReturnType<typeof serve>;
  let port: number;

  before(async () => {
    if (skip) return;
    server = serveHttp(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response('ok'),
    );
    port = server.port;
  });

  after(async () => {
    if (server) await server.close();
  });

  it('treats a later duplicate pass as clearing an earlier failure', (t) => {
    const caseId = 'http2/5.1.2/5 Sends a RST_STREAM frame to idle stream after reaching the concurrent stream limit';
    const first = _parseJunit(`
      <testsuite>
        <testcase package="http2/5.1.2" classname="5 Sends a RST_STREAM frame to idle stream after reaching the concurrent stream limit">
          <failure message="expected pass"/>
        </testcase>
      </testsuite>
    `);
    const second = _parseJunit(`
      <testsuite>
        <testcase package="http2/5.1.2" classname="5 Sends a RST_STREAM frame to idle stream after reaching the concurrent stream limit"/>
      </testsuite>
    `);
    const aggregate: H2specAggregate = { passing: new Set(), failing: new Set() };

    _mergeH2specResults(aggregate, first);
    _mergeH2specResults(aggregate, second);

    t.deepEqual([...aggregate.passing], [caseId], 'the duplicate case is counted as passing');
    t.deepEqual([...aggregate.failing], [], 'the duplicate case is not counted as failing');
  });

  it('schedules every h2spec dryrun leaf', { skip }, async (t) => {
    const actual = h2specDryrunInfo.units;
    const scheduled = [..._H2SPEC_UNITS];
    const missing = actual.filter(unit => !scheduled.includes(unit));
    const extra = scheduled.filter(unit => !actual.includes(unit));

    t.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      'scheduled leaves match h2spec --dryrun',
    );
  });

  _defineH2specUnitTests(_groupH2specUnits(_H2SPEC_UNITS), [], () => port, h2specDryrunInfo.labels);
});
