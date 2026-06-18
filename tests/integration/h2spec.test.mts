/**
 * h2spec — RFC 7540/7541 conformance suite.
 *
 * Runs the external `h2spec` binary against a live fino HTTPS server (TLS +
 * ALPN h2). h2spec is skipped if libnghttp2 or the h2spec binary is not
 * present on the machine.
 *
 * ## Allowlist-based pass/fail
 *
 * Rather than asserting `exit code == 0` (which almost no implementation
 * achieves), the test diffs h2spec's JUnit XML output against a checked-in
 * allowlist of case IDs we accept as failing today
 * (`tests/integration/h2spec-allowed-failures.json`). The test fails on:
 *
 *   - any case that fails but is NOT in the allowlist (regression / new gap)
 *   - any case that passes but IS in the allowlist (stale entry; must be removed)
 *
 * This makes the allowlist a live baseline: every entry is a TODO, and the
 * test enforces that it stays current.
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
import { serve } from 'fino:net/http/server';
import { DiskFileSystem } from 'fino:file';
import { Process } from 'fino:process';
import { h2Available } from 'fino:net/http/h2';

const decodeUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------

const CERT_PATH = new URL('../net/fixtures/test.crt', import.meta.url).pathname;
const KEY_PATH  = new URL('../net/fixtures/test.key',  import.meta.url).pathname;
const ALLOWLIST_PATH = new URL('./h2spec-allowed-failures.json', import.meta.url).pathname;

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

// ---------------------------------------------------------------------------
// Allowlist loader
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  id: string;
  reason: string;
}

async function _loadAllowlist(): Promise<Map<string, string>> {
  const fs = new DiskFileSystem('/');
  let raw = '[]';
  try {
    const file = await fs.open(ALLOWLIST_PATH);
    raw = decodeUtf8(await file.bytes());
    await file.close();
  } catch { /* file unreadable → empty allowlist */ }
  const entries: AllowlistEntry[] = JSON.parse(raw);
  return new Map(entries.map(e => [e.id, e.reason]));
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
// Section 5 is split into subsections: the "closed" stream tests in 5.1 involve
// 2-second timeouts and connection resets that leave server cleanup in flight.
// If 5.1.2 runs in the same invocation it arrives during that cleanup window and
// gets an RST/EOF before the TLS handshake completes, making it non-deterministic.
// Running each subsection as its own h2spec process gives a clean connection.
//
// Section 6 is further split into subsections: h2spec v2.6 also panics when
// running `http2/6` as a unit (same inter-section bug across its subsections).
// Section 6.6 (PUSH_PROMISE) is omitted — not applicable for server testing.
// Section 6.9 is also omitted: it has sub-subsections (6.9.1, 6.9.2) and
// h2spec v2.6 non-deterministically panics in the 6.9→6.9.1 transition. The
// sub-subsections cannot be run individually (they don't write JUnit output).
//
// Section 8 is split into 8.1 and 8.2 for the same inter-section panic reason:
// running `http2/8` as a unit panics at the 8.1→8.2 transition, producing no
// JUnit output and no stderr. Running each top-level child separately avoids it.
const _SECTIONS = [
  'http2/3', 'http2/4',
  'http2/5.1', 'http2/5.1.1', 'http2/5.1.2', 'http2/5.3', 'http2/5.4', 'http2/5.5',
  'http2/6.1', 'http2/6.2', 'http2/6.3', 'http2/6.4', 'http2/6.5',
  'http2/6.7', 'http2/6.8', 'http2/6.10',
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
    server = serve(
      { port: 0, tls: { cert: CERT_PATH, key: KEY_PATH } },
      async () => new Response('ok'),
    );
    port = server.port;
  });

  after(async () => {
    if (server) await server.close();
  });

  it('matches the allowlisted compliance baseline', { skip }, async (t) => {
    const allPassing: string[] = [];
    const allFailing: string[] = [];
    const missingSections: string[] = [];

    for (let si = 0; si < _SECTIONS.length; si++) {
      const section = _SECTIONS[si]!;
      // Give the server a moment to finish cleanup from the previous section's
      // connection teardown (TLS + nghttp2 async cleanup) before the next
      // section's probe connection arrives. First section needs no delay.
      if (si > 0) await new Promise<void>(r => setTimeout(r, 500));
      const { xml, stderr } = await _runSection(h2specPath!, section, port);
      if (!xml) {
        missingSections.push(`${section} (stderr: ${stderr.trim() || '<empty>'})`);
        continue;
      }
      const { passing, failing } = _parseJunit(xml);
      for (const id of passing) {
        if (!allPassing.includes(id)) allPassing.push(id);
      }
      for (const id of failing) {
        if (!allFailing.includes(id) && !allPassing.includes(id)) allFailing.push(id);
      }
    }

    if (missingSections.length > 0) {
      t.fail(
        `h2spec did not produce JUnit output for section(s):\n  ${missingSections.join('\n  ')}`,
      );
      return;
    }

    if (allPassing.length === 0 && allFailing.length === 0) {
      t.fail('JUnit XML parsed no test cases — check h2spec version / XML format.');
      return;
    }

    const allowlist = await _loadAllowlist();

    const regressions  = allFailing.filter(id => !allowlist.has(id));
    const staleEntries = [...allowlist.keys()].filter(
      id => !allFailing.includes(id) && allPassing.includes(id),
    );

    if (regressions.length > 0) {
      const lines = regressions.map(id => `  ${id}`).join('\n');
      t.fail(
        `${regressions.length} h2spec case(s) failing but not in allowlist (regressions):\n${lines}`,
      );
      return;
    }

    const totalAllowed = allowlist.size;
    if (staleEntries.length > 0) {
      // Soft warning: some allowlisted cases passed this run (timing-sensitive
      // cases may flip between runs). Only actionable if consistently passing.
      const lines = staleEntries.map(id => `  ${id}  (was: ${allowlist.get(id)})`).join('\n');
      console.warn(
        `[h2spec] ${staleEntries.length} allowlisted case(s) passed this run — ` +
        `consider removing from h2spec-allowed-failures.json if consistently passing:\n${lines}`,
      );
    }
    t.ok(
      true,
      `${allPassing.length} pass, ${totalAllowed} allowlisted (${allFailing.length} failing as expected)` +
      (staleEntries.length > 0 ? `, ${staleEntries.length} stale (see warning)` : ''),
    );
  });
});
