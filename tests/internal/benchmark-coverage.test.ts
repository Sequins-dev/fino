import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
const fs = new DiskFileSystem();
const textDecoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  return textDecoder.decode(await fs.readFile(path));
}
function publicBuiltins(source: string): string[] {
  const specs = new Set<string>();
  const re = /"(?<spec>fino:[^"]+)"/g;
  for (const match of source.matchAll(re)) {
    const spec = match.groups?.spec;
    if (spec) specs.add(spec);
  }
  return [...specs].sort();
}
function coverageRows(source: string): Map<string, string> {
  const rows = new Map<string, string>();
  const re = /^\|\s*`(?<spec>fino:[^`]+)`\s*\|\s*(?<coverage>[^|]+?)\s*\|$/gm;
  for (const match of source.matchAll(re)) {
    const spec = match.groups?.spec;
    const coverage = match.groups?.coverage;
    if (spec && coverage) rows.set(spec, coverage.trim());
  }
  return rows;
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
    const loader = await readText('src/loader.rs');
    const coverage = await readText('benchmarks/COVERAGE.md');
    const rows = coverageRows(coverage);
    const missing = publicBuiltins(loader).filter((spec) => !rows.has(spec));
    const invalid = [...rows].filter(
      ([, value]) => value !== 'not yet benchmarked' && !/^`benchmarks\/[^`]+`$/.test(value),
    );
    t.deepEqual(missing, [], 'all public builtins have a coverage table row');
    t.deepEqual(invalid, [], 'every row names a benchmark file or the explicit not-yet marker');
  });
  it('uses js-mirrored benchmark paths for public source builtins', async (t) => {
    const coverage = await readText('benchmarks/COVERAGE.md');
    const expected = [
      '`fino:log` | `benchmarks/log.bench.ts`',
      '`fino:config` | `benchmarks/config.bench.ts`',
      '`fino:cluster` | `benchmarks/cluster.bench.ts`',
      '`fino:validate` | `benchmarks/validate.bench.ts`',
      '`fino:database/sqlite` | `benchmarks/database/sqlite.bench.ts`',
      '`fino:file/path` | `benchmarks/file/path.bench.ts`',
      '`fino:format/csv` | `benchmarks/format/csv.bench.ts`',
      '`fino:net/http` | `benchmarks/net/http/index.bench.ts`',
      '`fino:module` | `benchmarks/module.bench.ts`',
      '`fino:process` | `benchmarks/process.bench.ts`',
      '`fino:security/jwt` | `benchmarks/security/jwt.bench.ts`',
      '`fino:test/assert` | `benchmarks/test/assert.bench.ts`',
    ];
    const missing = expected.filter((entry) => !coverage.includes(entry));
    t.deepEqual(missing, [], 'coverage map uses benchmark paths that mirror js source paths');
    for (const file of [
      'benchmarks/log.bench.ts',
      'benchmarks/config.bench.ts',
      'benchmarks/validate.bench.ts',
    ]) {
      const stat = await fs.stat(file);
      t.ok(stat.isFile(), `${file} exists as a separate benchmark file`);
    }
  });
  it('points only at benchmark files that exist', async (t) => {
    const coverage = await readText('benchmarks/COVERAGE.md');
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
      ['benchmarks/archive.bench.ts', ['many-entry zip list', 'malformed archive open rejects']],
      ['benchmarks/database/sqlite.bench.ts', ['unique constraint failure']],
      ['benchmarks/file/watch.bench.ts', ['directory event delivery']],
      [
        'benchmarks/net/dns.bench.ts',
        ['malformed truncated response rejects', 'DNSSEC validation corpus'],
      ],
      ['benchmarks/net/tls.bench.ts', ['failed TLS connect rejects']],
      ['benchmarks/net/quic.bench.ts', ['listen without cert rejects']],
      ['benchmarks/net/http/h3.bench.ts', ['requireH3 unavailable failure path']],
      [
        'benchmarks/net/quic-loopback-transfer.bench.ts',
        ['loopback client-to-server stream bulk transfer'],
      ],
    ]);
    const missing: string[] = [];
    for (const [file, markers] of required) {
      const source = await readText(file);
      for (const marker of markers) {
        if (!source.includes(marker)) missing.push(`${file}: ${marker}`);
      }
    }
    t.deepEqual(missing, [], 'release-audit benchmark stress/failure markers are present');
  });
});
