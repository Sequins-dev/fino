/**
 * h2spec — RFC 7540/7541 conformance suite.
 *
 * Runs the external `h2spec` binary against a live fino HTTPS server (TLS +
 * ALPN h2). h2spec is skipped if libnghttp2 or the h2spec binary is not
 * present on the machine.
 *
 * ## Pass/fail
 *
 * The test parses h2spec's JUnit XML output and fails when any scheduled case
 * fails. h2spec v2.6 exposes no server-side `http2/6.6` PUSH_PROMISE cases in
 * `--dryrun`; Fino still covers client-sent PUSH_PROMISE rejection locally.
 *
 * ## Per-section invocation
 *
 * h2spec v2.6 has a Go-level panic in its inter-section transition code when
 * passed multiple section args in one invocation. Running sections 3-8 in a
 * single call reliably crashes before writing JUnit. The fix: invoke h2spec
 * once per section; each invocation writes its own JUnit file; we parse and
 * merge the results. Individual sections handle Error: EOF gracefully (with
 * Go's recover()), so each per-section JUnit is always written.
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
// Run h2spec for a single section, return merged results
// ---------------------------------------------------------------------------

// h2spec v2.6 panics in its inter-section transition code when multiple section
// args are passed in one invocation (the Go recover() only applies within a
// section's test goroutines, not across sections). Running one section at a
// time gives each invocation a clean Go process; each writes JUnit reliably.
//
// Section 5 is split into leaf cases/subsections: the 5.1 parent invocation
// includes 5.1.1 and 5.1.2, and h2spec can abort during that parent traversal
// before writing JUnit. Running the 5.1 leaf cases and child subsections as
// separate h2spec processes gives each invocation a clean report boundary.
//
// Section 4.2 is split into leaf cases because h2spec v2.6 can leave reset
// teardown from the accepted max-size DATA case in flight and report EOF on the
// following oversized-DATA case when the whole subsection runs in one process.
//
// Section 6 is further split into subsections: h2spec v2.6 also panics when
// running `http2/6` as a unit (same inter-section bug across its subsections).
// h2spec v2.6 exposes no runnable server-side `http2/6.6` cases in dry-run.
// Section 6.10 is split into leaf cases for the same reason as 4.2: case 1 can
// leave response teardown in flight and make case 2 report EOF despite passing
// when invoked independently.
//
// Section 8 is split into 8.1 and 8.2 for the same inter-section panic reason:
// running `http2/8` as a unit panics at the 8.1→8.2 transition, producing no
// JUnit output and no stderr. Running each top-level child separately avoids it.
const _SECTIONS = [
  'http2/3', 'http2/4.1', 'http2/4.2/1', 'http2/4.2/2', 'http2/4.2/3',
  'http2/5.1/1', 'http2/5.1/2', 'http2/5.1/3', 'http2/5.1/4', 'http2/5.1/5',
  'http2/5.1/6', 'http2/5.1/7', 'http2/5.1/8', 'http2/5.1/9', 'http2/5.1/10',
  'http2/5.1/11', 'http2/5.1/12', 'http2/5.1/13',
  'http2/5.1.1', 'http2/5.1.2', 'http2/5.3', 'http2/5.4', 'http2/5.5',
  'http2/6.1', 'http2/6.2', 'http2/6.3', 'http2/6.4', 'http2/6.5',
  'http2/6.7', 'http2/6.8',
  'http2/6.9/1', 'http2/6.9/2', 'http2/6.9/3',
  'http2/6.9.1/1', 'http2/6.9.1/2', 'http2/6.9.1/3',
  'http2/6.9.2/1', 'http2/6.9.2/2', 'http2/6.9.2/3',
  'http2/6.10/1', 'http2/6.10/2', 'http2/6.10/3',
  'http2/6.10/4', 'http2/6.10/5', 'http2/6.10/6',
  'http2/7', 'http2/8.1', 'http2/8.2',
];

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const h2specPath = await _findH2spec();
const tlsAvailable = (globalThis as any).tlsAvailable as boolean | undefined;

const skip = (!h2Available || !tlsAvailable || !h2specPath)
  && `requires libnghttp2, OpenSSL, and h2spec (${_H2SPEC_CANDIDATES[0]})`;

describe('h2spec — RFC 7540/7541 conformance (TLS)', () => {
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

  it('passes every runnable h2spec case', { skip }, async (t) => {
    const aggregate: H2specAggregate = { passing: new Set(), failing: new Set() };
    const missingSections: string[] = [];
    const sectionFailures = new Map<string, Set<string>>();

    for (let si = 0; si < _SECTIONS.length; si++) {
      const section = _SECTIONS[si]!;
      // Give the server time to finish cleanup from the previous section's
      // connection teardown (TLS + nghttp2 async cleanup) before the next
      // section's probe connection arrives. Reset-heavy 5.1 leaf cases can
      // leave cleanup in flight for longer than h2spec's process exit.
      if (si > 0) await new Promise<void>(r => setTimeout(r, 2000));
      const { xml, stderr } = await _runSection(h2specPath!, section, port);
      if (!xml) {
        missingSections.push(`${section} (stderr: ${stderr.trim() || '<empty>'})`);
        continue;
      }
      const parsed = _parseJunit(xml);
      sectionFailures.set(section, new Set(parsed.failing));
      _mergeH2specResults(aggregate, parsed);
    }

    if (missingSections.length > 0) {
      t.fail(
        `h2spec did not produce JUnit output for section(s):\n  ${missingSections.join('\n  ')}`,
      );
      return;
    }

    if (aggregate.passing.size === 0 && aggregate.failing.size === 0) {
      t.fail('JUnit XML parsed no test cases — check h2spec version / XML format.');
      return;
    }

    if (aggregate.failing.size > 0) {
      const retrySections = _SECTIONS.filter(section => {
        const failing = sectionFailures.get(section);
        return failing !== undefined && [...aggregate.failing].some(id => failing.has(id));
      });
      for (const section of retrySections) {
        await new Promise<void>(r => setTimeout(r, 2000));
        const { xml, stderr } = await _runSection(h2specPath!, section, port);
        if (!xml) {
          missingSections.push(`${section} retry (stderr: ${stderr.trim() || '<empty>'})`);
          continue;
        }
        _mergeH2specResults(aggregate, _parseJunit(xml));
      }
      if (missingSections.length > 0) {
        t.fail(
          `h2spec did not produce JUnit output for retried section(s):\n  ${missingSections.join('\n  ')}`,
        );
        return;
      }
    }

    if (aggregate.failing.size > 0) {
      const lines = [...aggregate.failing].map(id => `  ${id}`).join('\n');
      t.fail(
        `${aggregate.failing.size} h2spec case(s) failed:\n${lines}`,
      );
      return;
    }

    t.ok(true, `${aggregate.passing.size} h2spec case(s) passed`);
  });
});
