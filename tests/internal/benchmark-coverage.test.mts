import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();

function publicBuiltins(source: string): string[] {
  const specs = new Set<string>();
  const re = /"(?<spec>fino:[^"]+)"/g;
  for (const match of source.matchAll(re)) {
    const spec = match.groups?.spec;
    if (spec) specs.add(spec);
  }
  return [...specs].sort();
}

function coveredBuiltins(source: string): Set<string> {
  const specs = new Set<string>();
  const re = /`(?<spec>fino:[^`]+)`/g;
  for (const match of source.matchAll(re)) {
    const spec = match.groups?.spec;
    if (spec) specs.add(spec);
  }
  return specs;
}

function listedBenchmarkPaths(source: string): string[] {
  const paths = new Set<string>();
  const re = /\|\s*`fino:[^`]+`\s*\|\s*`(?<path>benchmarks\/[^`]+)`\s*\|/g;
  for (const match of source.matchAll(re)) {
    const path = match.groups?.path;
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

describe('benchmark coverage map', () => {
  it('documents every public fino builtin registered in the loader', async (t) => {
    const loader = await fs.readFile('src/loader.rs', 'utf8');
    const coverage = await fs.readFile('benchmarks/COVERAGE.md', 'utf8');

    const missing = publicBuiltins(loader).filter((spec) => !coveredBuiltins(coverage).has(spec));

    t.deepEqual(missing, [], 'all public builtins appear in benchmarks/COVERAGE.md');
  });

  it('uses js-mirrored benchmark paths for public source builtins', async (t) => {
    const coverage = await fs.readFile('benchmarks/COVERAGE.md', 'utf8');
    const expected = [
      '`fino:log` | `benchmarks/log.bench.mts`',
      '`fino:config` | `benchmarks/config.bench.mts`',
      '`fino:cluster` | `benchmarks/cluster.bench.mts`',
      '`fino:validate` | `benchmarks/validate.bench.mts`',
      '`fino:database/sqlite` | `benchmarks/database/sqlite.bench.mts`',
      '`fino:file/path` | `benchmarks/file/path.bench.mts`',
      '`fino:format/csv` | `benchmarks/format/csv.bench.mts`',
      '`fino:net/http` | `benchmarks/net/http/index.bench.mts`',
      '`fino:module` | `benchmarks/module.bench.mts`',
      '`fino:process` | `benchmarks/process.bench.mts`',
      '`fino:realm/pool` | `benchmarks/realm/pool.bench.mts`',
      '`fino:security/jwt` | `benchmarks/security/jwt.bench.mts`',
      '`fino:test/assert` | `benchmarks/test/assert.bench.mts`',
    ];

    const missing = expected.filter((entry) => !coverage.includes(entry));
    t.deepEqual(missing, [], 'coverage map uses benchmark paths that mirror js source paths');

    for (const file of ['benchmarks/log.bench.mts', 'benchmarks/config.bench.mts', 'benchmarks/validate.bench.mts']) {
      const stat = await fs.stat(file);
      t.ok(stat.isFile(), `${file} exists as a separate benchmark file`);
    }
  });

  it('points only at benchmark files that exist', async (t) => {
    const coverage = await fs.readFile('benchmarks/COVERAGE.md', 'utf8');
    const missing: string[] = [];

    for (const file of listedBenchmarkPaths(coverage)) {
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) missing.push(file);
      } catch {
        missing.push(file);
      }
    }

    t.deepEqual(missing, [], 'all listed benchmark files exist');
  });

  it('keeps release-audit stress and failure benchmarks visible', async (t) => {
    const required = new Map<string, string[]>([
      ['benchmarks/archive.bench.mts', ['many-entry zip list', 'malformed archive open rejects']],
      ['benchmarks/database/sqlite.bench.mts', ['unique constraint failure']],
      ['benchmarks/file/watch.bench.mts', ['directory event delivery']],
      ['benchmarks/net/dns.bench.mts', ['malformed truncated response rejects', 'DNSSEC validation corpus']],
      ['benchmarks/net/tls.bench.mts', ['failed TLS connect rejects']],
      ['benchmarks/net/quic.bench.mts', ['listen without cert rejects']],
      ['benchmarks/net/http/h3.bench.mts', ['requireH3 unavailable failure path']],
      ['benchmarks/net/quic-loopback-transfer.bench.mts', ['loopback client-to-server stream bulk transfer']],
    ]);
    const missing: string[] = [];

    for (const [file, markers] of required) {
      const source = await fs.readFile(file, 'utf8');
      for (const marker of markers) {
        if (!source.includes(marker)) missing.push(`${file}: ${marker}`);
      }
    }

    t.deepEqual(missing, [], 'release-audit benchmark stress/failure markers are present');
  });

  it('links release notes to benchmark inventory and intentional non-parity areas', async (t) => {
    const notes = await fs.readFile('research-docs/research/js-release-notes.md', 'utf8');
    const required = [
      'benchmarks/COVERAGE.md',
      'JOSE',
      'CORS',
      'cookie',
      'Fetch',
      'OpenTelemetry',
      'cluster',
      'remote realms',
      'DNSSEC',
      'HTTP/3',
      'QUIC',
    ];
    const missing = required.filter((marker) => !notes.includes(marker));

    t.deepEqual(missing, [], 'release notes cover benchmark workflow and intentional non-parity areas');
  });

  it('keeps DNSSEC release lane and root anchor policy documented', async (t) => {
    const notes = await fs.readFile('research-docs/research/js-release-notes.md', 'utf8');
    const required = [
      'FINO_DNS_LIVE=1',
      'FINO_DNS_SERVER',
      'tests/net/dns-live.test.mts',
      'https://data.iana.org/root-anchors/root-anchors.xml',
      'root trust anchor rollover',
      'unsupported DNSSEC algorithms and digests fail closed',
    ];
    const missing = required.filter((marker) => !notes.includes(marker));

    t.deepEqual(missing, [], 'DNSSEC release verification policy is explicit');
  });
});
