/** CLI coverage integration tests. */
import { describe, it } from 'fino:test/test';
import { runCli, withTempProject } from './cli-test-helpers.ts';

describe('CLI commands: coverage', () => {
  // This workflow boots multiple CLI processes sequentially on two-CPU CI.
  it(
    'collects original-source coverage and exposes focused reports',
    { timeout: 120_000 },
    async (t) => {
      await withTempProject(
        {
          'src/classify.ts': [
            'export function classify(value: number): string {',
            "  if (value > 0) return 'positive';",
            "  return 'other';",
            '}',
            'export class Marker {',
            '  value = 1;',
            '}',
            '',
          ].join('\n'),
          'src/classify.test.ts': [
            "import { describe, it } from 'fino:test/test';",
            "import { classify, Marker } from './classify.ts';",
            "describe('classification', () => {",
            "  it('classifies positive input', (t) => {",
            "    t.equal(classify(1), 'positive');",
            '    t.equal(new Marker().value, 1);',
            '  });',
            '});',
            '',
          ].join('\n'),
        },
        async (dir, fs) => {
          const collected = await runCli(
            ['test', '--parallel', '--coverage', 'src/classify.test.ts'],
            { cwd: dir },
          );
          t.equal(collected.result.code, 0, 'bare coverage flag exits successfully');
          t.equal(collected.stderr, '', 'coverage collection does not write stderr');
          t.equal(
            collected.stdout.match(/^# coverage$/gm)?.length,
            1,
            'TAP output has one grouped coverage header',
          );
          t.ok(
            !collected.stdout.includes('# coverage lines'),
            'coverage metric comments do not repeat the header',
          );
          const artifact = JSON.parse(
            (await fs.readFile(dir + '/coverage/coverage.json')) as unknown as string,
          ) as {
            schemaVersion: number;
            run: { complete: boolean };
            realms: Array<{ id: string; status: string }>;
            files: Array<{
              path: string;
              lines: Array<{ line: number; hits: number; coveredIn: string[] }>;
            }>;
          };
          t.equal(artifact.schemaVersion, 1, 'coverage artifact is versioned');
          t.ok(artifact.run.complete, 'coverage artifact records a complete run');
          t.ok(
            artifact.realms.length >= 2,
            'coverage artifact records the command and parallel file Realms',
          );
          const source = artifact.files.find((file) => file.path === 'src/classify.ts');
          t.ok(
            source !== undefined,
            'TypeScript source map resolves coverage to the original file',
          );
          t.ok(
            source?.lines.some((line) => line.hits === 0 && line.line === 3),
            'uncovered branch is reported at its original TypeScript line',
          );
          t.ok(
            source?.lines.some((line) => line.coveredIn.length > 0),
            'covered source records retain Realm attribution',
          );

          const summary = await runCli(['coverage', 'summary'], { cwd: dir });
          t.equal(summary.result.code, 0, 'coverage summary exits successfully');
          t.ok(
            summary.stdout.startsWith('coverage complete\n'),
            'summary reports run completeness',
          );
          const files = await runCli(['coverage', 'files'], { cwd: dir });
          t.equal(files.result.code, 0, 'coverage files exits successfully');
          t.ok(files.stdout.includes('file src/classify.ts'), 'files report names original source');
          const lines = await runCli(['coverage', 'lines', 'src/classify.ts'], { cwd: dir });
          t.equal(lines.result.code, 0, 'coverage lines exits successfully');
          t.ok(lines.stdout.includes('uncovered-lines 3'), 'lines report uses compact line ranges');
          t.ok(
            lines.stdout.includes("source 3 |   return 'other';"),
            'lines report includes source',
          );
          const functions = await runCli(['coverage', 'functions', 'src/classify.ts'], {
            cwd: dir,
          });
          t.equal(functions.result.code, 0, 'coverage functions exits successfully');
          t.ok(
            functions.stdout.includes('function src/classify.ts '),
            'functions report original-source records',
          );
          const branches = await runCli(['coverage', 'branches', 'src/classify.ts'], {
            cwd: dir,
          });
          t.equal(branches.result.code, 0, 'coverage branches exits successfully');
          t.ok(branches.stdout.includes('branch src/classify.ts '), 'branches use original ranges');
          const failedCheck = await runCli(['coverage', 'check', '--lines', '100'], { cwd: dir });
          t.equal(failedCheck.result.code, 1, 'coverage check fails below its threshold');
          t.ok(failedCheck.stderr.includes('Coverage check failed'), 'failed check explains why');
          const exported = await runCli(['coverage', 'export', 'lcov'], { cwd: dir });
          t.equal(exported.result.code, 0, 'LCOV export exits successfully');
          const lcov = (await fs.readFile(dir + '/coverage/lcov.info')) as unknown as string;
          const canonicalDir = await fs.realpath(dir);
          t.ok(
            lcov.includes('SF:' + canonicalDir + '/src/classify.ts'),
            'LCOV names the canonical original source',
          );
          t.ok(lcov.includes('DA:3,0'), 'LCOV contains the uncovered line');

          const custom = await runCli(
            ['test', '--coverage=reports/custom.json', 'src/classify.test.ts'],
            { cwd: dir },
          );
          t.equal(custom.result.code, 0, 'custom coverage path exits successfully');
          const customArtifact = JSON.parse(
            (await fs.readFile(dir + '/reports/custom.json')) as unknown as string,
          ) as { schemaVersion: number };
          t.equal(
            customArtifact.schemaVersion,
            1,
            'custom coverage path receives the JSON artifact',
          );
          const customSummary = await runCli(
            ['coverage', 'summary', '--input', 'reports/custom.json'],
            { cwd: dir },
          );
          t.equal(
            customSummary.result.code,
            0,
            'coverage command accepts a custom JSON input path',
          );
        },
      );
    },
  );
  it('aggregates scheduled and process Realm coverage into one artifact', async (t) => {
    await withTempProject(
      {
        'worker.ts': [
          'export default function double(value: number): number {',
          '  return value * 2;',
          '}',
          '',
        ].join('\n'),
        'realms.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "import { Realm } from 'fino:realm';",
          "import type double from './worker.ts';",
          "const entry = new URL('./worker.ts', import.meta.url).pathname;",
          "describe('Realm coverage', () => {",
          "  it('runs worker Realms', async (t) => {",
          '    const scheduled = new Realm<typeof double>({ entry });',
          "    t.equal(await scheduled.call(2), 4, 'scheduled result');",
          '    const process = new Realm<typeof double>({ entry, process: true });',
          "    t.equal(await process.call(3), 6, 'process result');",
          '  });',
          '});',
          '',
        ].join('\n'),
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--coverage=coverage/realms.json', 'realms.test.ts'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'multi-Realm coverage run exits successfully');
        t.equal(stderr, '', 'multi-Realm coverage does not write stderr');
        t.ok(stdout.includes('#   realms     3 complete, 0 incomplete'), 'TAP groups Realm totals');
        const artifact = JSON.parse(
          (await fs.readFile(dir + '/coverage/realms.json')) as unknown as string,
        ) as {
          realms: Array<{ id: string; parentId: string | null; kind: string; status: string }>;
          files: Array<{ path: string; lines: Array<{ coveredIn: string[] }> }>;
        };
        const root = artifact.realms.find((realm) => realm.kind === 'test');
        const scheduled = artifact.realms.find((realm) => realm.kind === 'scheduled');
        const process = artifact.realms.find((realm) => realm.kind === 'process');
        t.ok(root !== undefined, 'artifact includes the test Realm');
        t.equal(scheduled?.parentId, root?.id, 'scheduled Realm records its parent');
        t.equal(process?.parentId, root?.id, 'process Realm records its parent');
        t.ok(
          artifact.realms.every((realm) => realm.status === 'complete'),
          'every participating Realm submitted a complete snapshot',
        );
        const worker = artifact.files.find((file) => file.path === 'worker.ts');
        const coveredIn = new Set(worker?.lines.flatMap((line) => line.coveredIn) ?? []);
        t.ok(
          coveredIn.has(scheduled?.id ?? ''),
          'worker coverage is attributed to scheduled Realm',
        );
        t.ok(coveredIn.has(process?.id ?? ''), 'worker coverage is attributed to process Realm');
        const realms = await runCli(['coverage', 'realms', '--input', 'coverage/realms.json'], {
          cwd: dir,
        });
        t.equal(realms.result.code, 0, 'coverage realms exits successfully');
        t.ok(realms.stdout.includes('kind=scheduled'), 'Realm list includes scheduled coverage');
        t.ok(realms.stdout.includes('kind=process'), 'Realm list includes process coverage');
        const realm = await runCli(
          ['coverage', 'realm', String(process?.id), '--input', 'coverage/realms.json'],
          { cwd: dir },
        );
        t.equal(realm.result.code, 0, 'coverage realm exits successfully');
        t.ok(realm.stdout.includes('kind process'), 'Realm detail selects the requested Realm');
      },
    );
  });
  it('keeps a TypeScript placeholder for an abruptly exited process Realm', async (t) => {
    await withTempProject(
      {
        'crash.ts': ["import { exit } from 'fino:process';", 'exit(7);', ''].join('\n'),
        'crash.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "import { Realm } from 'fino:realm';",
          "const entry = new URL('./crash.ts', import.meta.url).pathname;",
          "describe('crash coverage', () => {",
          "  it('observes the failed Realm', async (t) => {",
          '    const realm = new Realm({ entry, process: true });',
          '    let rejected = false;',
          '    try { await realm.run(); } catch { rejected = true; }',
          "    t.ok(rejected, 'process Realm exits nonzero');",
          '  });',
          '});',
          '',
        ].join('\n'),
      },
      async (dir, fs) => {
        const { stdout, result } = await runCli(
          ['test', '--coverage=coverage/crash.json', 'crash.test.ts'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'the caught child failure does not fail the test run');
        t.ok(stdout.includes('#   realms     1 complete, 1 incomplete'));
        const artifact = JSON.parse(
          (await fs.readFile(dir + '/coverage/crash.json')) as unknown as string,
        ) as {
          run: { complete: boolean };
          realms: Array<{ kind: string; status: string }>;
          warnings: string[];
        };
        t.equal(
          artifact.run.complete,
          false,
          'the missing child snapshot marks the run incomplete',
        );
        t.equal(
          artifact.realms.find((realm) => realm.kind === 'process')?.status,
          'missing',
          'the parent-written child placeholder survives the abrupt exit',
        );
        t.ok(
          artifact.warnings.some((warning) =>
            warning.includes('Realm did not submit a final coverage snapshot'),
          ),
          'the placeholder explains why the Realm is incomplete',
        );
      },
    );
  });
});
