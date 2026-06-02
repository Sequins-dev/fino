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
});
