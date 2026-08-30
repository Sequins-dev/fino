/** CLI benchmark integration tests. */
import { describe, it } from 'fino:test/test';
import { runCli, runRootInProcess, withTempProject } from './cli-test-helpers.ts';

describe('CLI commands: bench', () => {
  it('passes --filter to the bench command', async (t) => {
    const { stdout, stderr, result } = await runCli(
      ['bench', '--filter', 'needle', './tests/fixtures/filter-bench.ts'],
      { env: { FINO_BENCH_MIN_NS: '1000' } },
    );
    t.equal(result.code, 0, 'filtered bench command exits successfully');
    t.equal(stderr, '', 'filtered bench command does not write stderr');
    t.ok(!stdout.includes('# alpha bench'), 'non-matching suite omitted');
    t.ok(stdout.includes('# beta bench'), 'ancestor suite of matching nested group retained');
    t.ok(stdout.includes('# needle group'), 'matching nested benchmark group included');
    t.ok(!stdout.includes('other group'), 'unmatched nested benchmark group omitted');
  });
  it('prints human benchmark output without JSON results', async (t) => {
    await withTempProject(
      {
        'benchmarks/human.bench.ts': [
          "import { bench } from 'fino:bench';",
          "bench('human output bench', (b) => {",
          "  b.measure('first measure', () => 1);",
          "  b.measure('second measure', () => 2);",
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['bench', 'benchmarks/human.bench.ts'], {
          cwd: dir,
          env: { FINO_BENCH_MIN_NS: '1000' },
        });
        t.equal(result.code, 0, 'human benchmark exits successfully');
        t.equal(stderr, '', 'human benchmark does not write stderr');
        t.ok(stdout.startsWith('benc.h v1.0.0\n'), 'bench command prints benc.h header');
        t.ok(stdout.includes('# human output bench'), 'bench command prints suite heading');
        t.ok(
          /first measure - .+ i\/s /.test(stdout),
          'bench command prints human measurement line',
        );
        t.ok(stdout.includes('Comparing...'), 'bench command prints human comparison text');
        t.ok(
          !stdout
            .split('\n')
            .some((line) => line.trim().startsWith('{') || line.trim().startsWith('[')),
          'bench command does not emit JSON lines',
        );
      },
    );
  });
  it('expands benchmark directories in the bench command', async (t) => {
    await withTempProject(
      {
        'benchmarks/alpha.bench.ts': [
          "import { bench } from 'fino:bench';",
          "bench('alpha directory bench', (b) => {",
          "  b.group('needle directory group', (g) => {",
          "    g.measure('directory measure', () => 1);",
          '  });',
          '});',
          '',
        ].join('\n'),
        'benchmarks/nested/beta.bench.ts': [
          "import { bench } from 'fino:bench';",
          "bench('beta directory bench', (b) => {",
          "  b.measure('beta measure', () => 2);",
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['bench', '--filter', 'needle directory', 'benchmarks'],
          {
            cwd: dir,
            env: { FINO_BENCH_MIN_NS: '1000' },
          },
        );
        t.equal(result.code, 0, 'bench directory input exits successfully');
        t.equal(stderr, '', 'bench directory input does not write stderr');
        t.ok(
          stdout.includes('# alpha directory bench'),
          'bench directory input imports matching file',
        );
        t.ok(
          stdout.includes('# needle directory group'),
          'bench directory input runs matching group',
        );
        t.ok(
          !stdout.includes('# beta directory bench'),
          'bench directory input omits unmatched benchmark groups',
        );
      },
    );
  });
  it('expands benchmark globs in the bench command', async (t) => {
    await withTempProject(
      {
        'benchmarks/alpha.bench.ts': [
          "import { bench } from 'fino:bench';",
          "bench('alpha glob bench', (b) => {",
          "  b.group('needle glob group', (g) => {",
          "    g.measure('glob measure', () => 1);",
          '  });',
          '});',
          '',
        ].join('\n'),
        'benchmarks/nested/beta.bench.ts': [
          "import { bench } from 'fino:bench';",
          "bench('beta glob bench', (b) => {",
          "  b.measure('beta measure', () => 2);",
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['bench', '--filter', 'needle glob', 'benchmarks/**/*.bench.ts'],
          {
            cwd: dir,
            env: { FINO_BENCH_MIN_NS: '1000' },
          },
        );
        t.equal(result.code, 0, 'bench glob input exits successfully');
        t.equal(stderr, '', 'bench glob input does not write stderr');
        t.ok(stdout.includes('# alpha glob bench'), 'bench glob input imports matching file');
        t.ok(stdout.includes('# needle glob group'), 'bench glob input runs matching group');
        t.ok(
          !stdout.includes('# beta glob bench'),
          'bench glob input omits unmatched benchmark groups',
        );
      },
    );
  });
  it('fails when expanded benchmark inputs match no files', async (t) => {
    await withTempProject({}, async (dir) => {
      for (const [label, args] of [
        ['empty benchmark directory', ['bench', 'benchmarks']],
        ['empty benchmark glob', ['bench', 'benchmarks/**/*.bench.ts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runRootInProcess(args, { cwd: dir });
        t.equal(result.code, 1, `${label} exits with an error`);
        t.equal(stdout, '', `${label} does not run the benchmark runner`);
        t.ok(
          stderr.includes('fino bench: no benchmark files matched'),
          `${label} reports no matched files`,
        );
      }
    });
  });
  it('runs async benchmarks and setup/teardown in order', async (t) => {
    await withTempProject(
      {
        'benchmarks/async.bench.ts': [
          "import { bench } from 'fino:bench';",
          'let logged = false;',
          "bench('async fixture bench', (b) => {",
          "  b.measure('async measure', {",
          '    setup() { return { value: 41 }; },',
          "    async fn(ctx) { if (!logged) { console.log('fn:' + ctx.value); logged = true; } await Promise.resolve(); },",
          "    teardown(ctx) { console.log('teardown:' + ctx.value); },",
          '  });',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['bench', 'benchmarks/async.bench.ts'], {
          cwd: dir,
          env: { FINO_BENCH_MIN_NS: '1000' },
        });
        t.equal(result.code, 0, 'async bench exits successfully');
        t.equal(stderr, '', 'async bench does not write stderr');
        t.ok(stdout.includes('async measure'), 'async measure ran');
        t.ok(stdout.includes('fn:41'), 'async measured function received setup context');
        t.ok(stdout.includes('teardown:41'), 'teardown ran after async measurement');
      },
    );
  });
  it('runs benchmark teardown when the measured function throws', async (t) => {
    await withTempProject(
      {
        'benchmarks/failing.bench.ts': [
          "import { bench } from 'fino:bench';",
          "bench('failing fixture bench', (b) => {",
          "  b.measure('throws measure', {",
          "    setup() { return 'ctx'; },",
          "    fn() { throw new Error('measured failure'); },",
          "    teardown(ctx) { console.log('teardown:' + ctx); },",
          '  });',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['bench', 'benchmarks/failing.bench.ts'], {
          cwd: dir,
          env: { FINO_BENCH_MIN_NS: '1000' },
        });
        t.equal(result.code, 1, 'failing benchmark exits nonzero');
        t.equal(
          stdout.includes('throws measure'),
          false,
          'failed measurement is not reported as completed',
        );
        t.ok(stdout.includes('teardown:ctx'), 'teardown ran after measurement failure');
        t.ok(stderr.includes('measured failure'), 'stderr reports measured failure');
      },
    );
  });
});
