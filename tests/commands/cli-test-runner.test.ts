/** CLI test-runner integration tests. */
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import * as loop from 'internal:runtime/loop';
import type runTestFile from '../../js/internal/test-worker.ts';
import type {
  TestFileCompletion,
  TestFileCompletionAck,
  TestFileRegistration,
  TestGroupCompletion,
  TestGroupStart,
} from '../../js/internal/test-worker.ts';
import { runCli, runRootInProcess, withTempProject } from './cli-test-helpers.ts';

const DURATION_RE = String.raw`\d+(?:\.\d+)?(?:ns|us|ms|s|m|h)\b`;

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const timer = loop.timeout(ms);
  timer.unref();
  try {
    return await Promise.race([
      promise,
      timer.then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    timer.cancel();
  }
}

describe('CLI commands: test', () => {
  it('runs the test subcommand', async (t) => {
    const { stdout, stderr, result } = await runCli(['test', './tests/util/topic.test.ts']);
    t.equal(result.code, 0, 'test command exits successfully');
    t.equal(stderr, '', 'test command does not write stderr');
    t.ok(stdout.includes('# pass  1'), 'test subcommand ran the requested suite');
  });
  it('does not accept the legacy --test shortcut', async (t) => {
    const { stdout, stderr, result } = await runRootInProcess([
      '--test',
      './tests/util/topic.test.ts',
    ]);
    t.equal(result.code, 1, 'legacy --test shortcut exits with an error');
    t.equal(stdout, '', 'legacy --test shortcut does not run tests');
    t.ok(
      stderr.includes('Unknown option "--test"'),
      'legacy --test shortcut reports an unknown option',
    );
  });
  it('accepts bare repo-relative paths in the test subcommand', async (t) => {
    const { stdout, stderr, result } = await runCli(['test', 'tests/util/topic.test.ts']);
    t.equal(result.code, 0, 'bare relative test path exits successfully');
    t.equal(stderr, '', 'bare relative test path does not write stderr');
    t.ok(stdout.includes('# pass  1'), 'bare relative test path ran the requested suite');
  });
  it('passes --filter to the test command', async (t) => {
    const { stdout, stderr, result } = await runCli([
      'test',
      '--filter',
      'needle',
      './tests/fixtures/filter-tests.ts',
    ]);
    t.equal(result.code, 0, 'filtered test command exits successfully');
    t.equal(stderr, '', 'filtered test command does not write stderr');
    t.ok(!stdout.includes('alpha outer'), 'non-matching top-level group omitted');
    t.ok(stdout.includes('beta outer'), 'ancestor of matching nested group retained');
    t.ok(stdout.includes('needle child'), 'matching nested describe group included');
    t.ok(!stdout.includes('match leaf'), 'unmatched nested group omitted');
  });
  it('passes --show-output modes to the test command', async (t) => {
    await withTempProject(
      {
        'output.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('noisy pass', () => console.log('stdout:pass'));",
          "test('noisy fail', () => { console.log('stdout:fail'); throw new Error('fixture failed'); });",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const failures = await runCli(['test', '--show-output=failures', 'output.test.ts'], {
          cwd: dir,
        });
        t.equal(failures.result.code, 1, 'failures mode exits nonzero for failing test');
        t.ok(!failures.stdout.includes('stdout:pass'), 'failures mode suppresses passing output');
        t.ok(
          failures.stdout.includes('#   stdout:fail'),
          'failures mode prints failing captured output',
        );
        const never = await runCli(['test', '--show-output=never', 'output.test.ts'], {
          cwd: dir,
        });
        t.equal(never.result.code, 1, 'never mode exits nonzero for failing test');
        t.ok(!never.stdout.includes('stdout:pass'), 'never mode suppresses passing output');
        t.ok(
          !never.stdout.includes('stdout:fail'),
          'never mode suppresses failing captured output',
        );
        const always = await runCli(['test', '--show-output=always', 'output.test.ts'], {
          cwd: dir,
        });
        t.equal(always.result.code, 1, 'always mode exits nonzero for failing test');
        t.ok(always.stdout.includes('stdout:pass'), 'always mode streams passing output');
        t.ok(always.stdout.includes('stdout:fail'), 'always mode streams failing output');
      },
    );
  });
  it('passes --durations to the test command', async (t) => {
    await withTempProject(
      {
        'durations.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('timed pass', (t) => t.ok(true));",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--durations', 'durations.test.ts'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'durations mode exits successfully');
        t.equal(stderr, '', 'durations mode does not write stderr');
        t.ok(
          new RegExp(String.raw`ok 1 - timed pass # duration=${DURATION_RE}`).test(stdout),
          'test command forwards duration reporting',
        );
      },
    );
  });
  it('merges ordered concurrent file results into deterministic top-level TAP', async (t) => {
    await withTempProject({}, async (dir, fs) => {
      const source = (name: string, peer: string) =>
        [
          "import { describe, it } from 'fino:test/test';",
          "import { DiskFileSystem } from 'fino:file';",
          "import * as loop from 'internal:runtime/loop';",
          'const fs = new DiskFileSystem();',
          `const own = ${JSON.stringify(`${dir}/${name}.ready`)};`,
          `const peer = ${JSON.stringify(`${dir}/${peer}.ready`)};`,
          `describe(${JSON.stringify(`${name} group`)}, () => {`,
          `  it(${JSON.stringify(`${name} waits for ${peer}`)}, async (t) => {`,
          "    await fs.writeFile(own, new TextEncoder().encode('ready'));",
          `    console.log(${JSON.stringify(`ready:${name}`)});`,
          '    for (let attempt = 0; attempt < 100; attempt++) {',
          '      try {',
          '        await fs.lstat(peer);',
          "        t.ok(true, 'peer file ran concurrently');",
          '        return;',
          '      } catch {}',
          '      await loop.timeout(10);',
          '    }',
          "    throw new Error('peer test file did not run concurrently');",
          '  });',
          '});',
          `describe(${JSON.stringify(`${name} second group`)}, () => {`,
          "  it('also passes', (t) => t.ok(true));",
          '});',
          '',
        ].join('\n');
      await fs.writeFile(`${dir}/a.test.ts`, source('a', 'b') as never);
      await fs.writeFile(`${dir}/b.test.ts`, source('b', 'a') as never);
      const { stdout, stderr, result } = await runCli(
        [
          'test',
          '--parallel',
          '--ordered',
          '--durations',
          '--show-output=always',
          'a.test.ts',
          'b.test.ts',
        ],
        { cwd: dir, env: { FINO_REACTOR_THREADS: '1' } },
      );
      t.equal(result.code, 0, 'parallel files exit successfully on one multiplexing reactor');
      t.equal(stderr, '', 'passing parallel files do not write stderr');
      t.equal(
        stdout.split('TAP version 13').length - 1,
        1,
        'parallel output has one root TAP version',
      );
      t.ok(stdout.startsWith('TAP version 13\n'), 'root TAP header is emitted once');
      t.ok(stdout.includes('\n1..4\n'), 'root plan counts groups rather than files');
      const a = stdout.indexOf('# Subtest: a group');
      const b = stdout.indexOf('# Subtest: b group');
      t.ok(a >= 0 && b > a, 'top-level groups retain discovery order');
      t.ok(!stdout.includes('# Subtest: a.test.ts'), 'files are not exposed as wrapper subtests');
      t.ok(stdout.includes('ready:a'), 'always output is buffered until results are merged');
      t.ok(stdout.includes('ready:b'), 'both concurrent file outputs are retained');
      t.ok(
        new RegExp(String.raw`ok 1 - a group # duration=${DURATION_RE}`).test(stdout),
        'first group retains its duration metadata',
      );
      t.ok(stdout.includes('ok 3 - b group'), 'second file continues root numbering');
      t.ok(stdout.includes('    ok 1 - b waits for a'), 'nested numbering remains local');
    });
  });
  it('scales test concurrency per reactor and emits groups as each completes', async (t) => {
    await withTempProject({}, async (dir, fs) => {
      const marker = `${dir}/fast-finished`;
      await fs.writeFile(
        `${dir}/00-slow.test.ts`,
        [
          "import { test } from 'fino:test/test';",
          "import { DiskFileSystem } from 'fino:file';",
          "import * as loop from 'internal:runtime/loop';",
          'const fs = new DiskFileSystem();',
          "test('slow first claim', async (t) => {",
          '  let fastStarted = false;',
          '  for (let attempt = 0; attempt < 1_000; attempt++) {',
          `    try { await fs.lstat(${JSON.stringify(marker)}); fastStarted = true; break; } catch {}`,
          '    await loop.timeout(10);',
          '  }',
          "  if (!fastStarted) throw new Error('fast second claim did not start concurrently');",
          '  await loop.timeout(1_000);',
          '  t.ok(true);',
          '});',
          '',
        ].join('\n') as never,
      );
      await fs.writeFile(
        `${dir}/01-fast.test.ts`,
        [
          "import { test } from 'fino:test/test';",
          "import { DiskFileSystem } from 'fino:file';",
          'const fs = new DiskFileSystem();',
          "test('fast second claim', async (t) => {",
          `  await fs.writeFile(${JSON.stringify(marker)}, new Uint8Array([1]));`,
          '  t.ok(true);',
          '});',
          '',
        ].join('\n') as never,
      );
      const { stdout, stderr, result } = await runCli(
        ['test', '--parallel', '00-slow.test.ts', '01-fast.test.ts'],
        {
          cwd: dir,
          env: { FINO_REACTOR_THREADS: '2', FINO_TEST_CONCURRENCY: '1' },
        },
      );
      t.equal(result.code, 0, 'completion-order run exits successfully');
      t.equal(stderr, '', 'completion-order run has no diagnostics');
      t.ok(stdout.includes('\n1..2\n'), 'completion-order output retains the aggregate plan');
      t.ok(
        stdout.indexOf('ok 1 - fast second claim') < stdout.indexOf('ok 2 - slow first claim'),
        'the later claim emits as soon as it completes',
      );
      t.ok(stdout.includes('ok 1 - fast second claim'), 'root numbering follows emission order');
      t.ok(stdout.includes('ok 2 - slow first claim'), 'the delayed group emits afterward');
    });
  });
  it('suppresses raw and nested Realm output outside the TAP stream', async (t) => {
    await withTempProject(
      {
        'child.ts': "console.log('nested process Realm noise');\n",
        'noise.test.ts': [
          "import { test } from 'fino:test/test';",
          "import { Realm } from 'fino:realm';",
          "import { writeLine } from 'internal:runtime/libc';",
          "test('contains noisy output', async (t) => {",
          "  console.log('console noise');",
          "  writeLine(1, 'raw stdout noise');",
          "  writeLine(2, 'raw stderr noise');",
          "  const realm = new Realm({ entry: new URL('./child.ts', import.meta.url).href, process: true });",
          '  await realm.run();',
          '  t.ok(true);',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['test', '--parallel', 'noise.test.ts'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'noisy passing test exits successfully');
        t.equal(stderr, '', 'raw stderr is suppressed');
        t.ok(stdout.includes('ok 1 - contains noisy output'), 'ordinary TAP result is retained');
        for (const noise of [
          'console noise',
          'raw stdout noise',
          'raw stderr noise',
          'nested process Realm noise',
        ]) {
          t.ok(!stdout.includes(noise), `${noise} is absent from TAP stdout`);
        }
      },
    );
  });
  it('refills parallel capacity when any individual group settles', async (t) => {
    await withTempProject({}, async (dir, fs) => {
      const marker = `${dir}/third-group-started`;
      const imports = [
        "import { test } from 'fino:test/test';",
        "import { DiskFileSystem } from 'fino:file';",
        "import * as loop from 'internal:runtime/loop';",
        'const fs = new DiskFileSystem();',
      ];
      const files: Record<string, string> = {
        '00.test.ts': [...imports, "test('releases the first slot', (t) => t.ok(true));", ''].join(
          '\n',
        ),
        '01.test.ts': [
          ...imports,
          "test('waits for the third group', async (t) => {",
          '  for (let attempt = 0; attempt < 200; attempt++) {',
          `    try { await fs.lstat(${JSON.stringify(marker)}); t.ok(true); return; } catch {}`,
          '    await loop.timeout(5);',
          '  }',
          "  throw new Error('third group was not admitted');",
          '});',
          '',
        ].join('\n'),
        '02.test.ts': [
          ...imports,
          "test('uses the first available slot', async (t) => {",
          `  await fs.writeFile(${JSON.stringify(marker)}, new Uint8Array([1]));`,
          '  t.ok(true);',
          '});',
          '',
        ].join('\n'),
      };
      await Promise.all(
        Object.entries(files).map(([name, source]) =>
          fs.writeFile(`${dir}/${name}`, source as never),
        ),
      );
      const { stdout, stderr, result } = await runCli(
        ['test', '--parallel', ...Object.keys(files).sort()],
        {
          cwd: dir,
          env: { FINO_REACTOR_THREADS: '1', FINO_TEST_CONCURRENCY: '2' },
        },
      );
      t.equal(result.code, 0, 'rolling group admission exits successfully');
      t.equal(stderr, '', 'rolling group admission has no diagnostics');
      t.ok(stdout.includes('\n1..3\n'), 'all groups contribute to the final plan');
      t.ok(
        /ok \d+ - uses the first available slot/.test(stdout),
        'the next group starts when either in-flight group releases a slot',
      );
    });
  });
  it('does not let a parallel test Realm exit the coordinator process', async (t) => {
    await withTempProject(
      {
        '00-exit.test.ts': ["import { exit } from 'fino:process';", 'exit(0);', ''].join('\n'),
        '01-survivor.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('runs after another file requests exit', (t) => t.ok(true));",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--parallel', '--ordered', '00-exit.test.ts', '01-survivor.test.ts'],
          {
            cwd: dir,
            env: { FINO_REACTOR_THREADS: '1', FINO_TEST_CONCURRENCY: '1' },
          },
        );
        t.equal(result.code, 1, 'an in-process Realm exit request fails the test run');
        t.ok(stdout.includes('not ok 1 - 00-exit.test.ts failed to load or run'));
        t.ok(
          stdout.includes('ok 2 - runs after another file requests exit'),
          'later files still run',
        );
        t.ok(stdout.includes('\n1..2\n'), 'the complete aggregate plan is emitted');
        t.ok(stdout.includes('# tests 2'), 'the complete aggregate summary is emitted');
        t.ok(stderr.includes('1 test(s) failed'), 'the exit request is reported as a failure');
      },
    );
  });
  it('drains Realm shutdown hooks before reporting a parallel file', async (t) => {
    await withTempProject({}, async (dir, fs) => {
      await fs.writeFile(
        `${dir}/cleanup.test.ts`,
        [
          "import { test } from 'fino:test/test';",
          "import { DiskFileSystem } from 'fino:file';",
          "import { registerShutdownHook } from 'internal:shutdown';",
          'const fs = new DiskFileSystem();',
          `registerShutdownHook(() => fs.writeFile(${JSON.stringify(`${dir}/cleaned`)}, new Uint8Array([1])));`,
          "test('registers cleanup', (t) => t.ok(true));",
          '',
        ].join('\n') as never,
      );
      const { stdout, stderr, result } = await runCli(['test', '--parallel', 'cleanup.test.ts'], {
        cwd: dir,
      });
      t.equal(result.code, 0, 'parallel file exits successfully after cleanup');
      t.equal(stderr, '', 'successful cleanup does not write stderr');
      t.ok(stdout.includes('ok 1 - registers cleanup'), 'test reports success after its hook');
      const marker = await fs.readFile(`${dir}/cleaned`);
      t.equal((marker as unknown as string).length, 1, 'shutdown hook completed before CLI exit');
    });
  });
  it('does not let ambient handles retain a completed test Realm', async (t) => {
    await withTempProject({}, async (dir, fs) => {
      const marker = `${dir}/completion-reported`;
      await fs.writeFile(
        `${dir}/delayed-exit.test.ts`,
        [
          "import { test } from 'fino:test/test';",
          "import { DiskFileSystem } from 'fino:file';",
          "import { registerShutdownHook } from 'internal:shutdown';",
          'const fs = new DiskFileSystem();',
          'setTimeout(() => {}, 3_000);',
          `registerShutdownHook(() => fs.writeFile(${JSON.stringify(marker)}, new Uint8Array([1])));`,
          "test('reports before its Realm exits', (t) => t.ok(true));",
          '',
        ].join('\n') as never,
      );
      const started = performance.now();
      const { stderr, result } = await runRootInProcess(
        ['test', '--parallel', 'delayed-exit.test.ts'],
        {
          cwd: dir,
        },
      );
      t.equal(result.code, 0, 'the delayed test Realm exits successfully');
      t.equal(stderr, '', 'the delayed exit does not report a lifecycle error');
      t.ok(performance.now() - started < 2_000, 'the ambient timer does not retain the Realm');
      t.ok(await fs.lstat(marker), 'shutdown hooks finish before the Realm exits');
    });
  });
  it('acknowledges worker completion before allowing its Realm to exit', async (t) => {
    await withTempProject(
      {
        'held.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('reports before exit', (t) => t.ok(true));",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const realm = new Realm<typeof runTestFile>({ entry: 'internal:test-worker' });
        let sawResult = false;
        let callSettled = false;
        let runSettled = false;
        let resolveCompletion!: (completion: TestFileCompletion) => void;
        const completionMessage = new Promise<TestFileCompletion>((resolve) => {
          resolveCompletion = resolve;
        });
        const onMessage = (event: Event) => {
          const message = (event as MessageEvent).data as
            | TestFileRegistration
            | TestGroupCompletion
            | TestFileCompletion
            | undefined;
          if (message?.kind === 'fino:test:registered') {
            realm.port.postMessage({
              kind: 'fino:test:start',
              index: 0,
            } satisfies TestGroupStart);
          } else if (message?.kind === 'fino:test:result') {
            sawResult = true;
          } else if (message?.kind === 'fino:test:complete') {
            t.equal(callSettled, false, 'call remains pending before the acknowledgement');
            t.equal(runSettled, false, 'Realm remains alive before the acknowledgement');
            realm.port.postMessage({
              kind: 'fino:test:complete-ack',
            } satisfies TestFileCompletionAck);
            resolveCompletion(message);
          }
        };
        realm.port.addEventListener('message', onMessage);
        realm.port.start();
        const run = realm.run().then(() => {
          runSettled = true;
        });
        const call = realm.call(`file://${dir}/held.test.ts`, {}).then((result) => {
          callSettled = true;
          return result;
        });
        try {
          const completion = await withTimeout(
            completionMessage,
            10_000,
            'test worker did not report completion',
          );
          t.ok(sawResult, 'worker emits its test result before completion');
          t.deepEqual(
            JSON.parse(completion.activeHandles ?? '{}'),
            {
              reads: 1,
              writes: 0,
              timers: 0,
              referencedTimers: 0,
              unreferencedTimers: 0,
              procs: 0,
              completions: 0,
              vnodes: 0,
              pendingInstalls: 0,
              atomicsWaiters: 0,
              pendingV8Tasks: false,
            },
            'only the worker control port remains before the acknowledgement',
          );
          const [callResult] = await Promise.all([call, run]);
          t.equal(callResult.kind, completion.kind, 'call returns the acknowledged completion');
        } finally {
          realm.port.removeEventListener('message', onMessage);
          await realm.terminate({ force: true });
        }

        const unackedRealm = new Realm<typeof runTestFile>({ entry: 'internal:test-worker' });
        const onUnackedMessage = (event: Event) => {
          const message = (event as MessageEvent).data as TestFileRegistration | undefined;
          if (message?.kind !== 'fino:test:registered') return;
          unackedRealm.port.postMessage({
            kind: 'fino:test:start',
            index: 0,
          } satisfies TestGroupStart);
        };
        unackedRealm.port.addEventListener('message', onUnackedMessage);
        unackedRealm.port.start();
        const unackedRun = unackedRealm.run();
        void unackedRealm.call(`file://${dir}/held.test.ts`, {}).catch(() => {});
        try {
          await withTimeout(unackedRun, 10_000, 'unacknowledged test worker did not exit');
          t.ok(true, 'a lost acknowledgement cannot keep the worker Realm alive');
        } finally {
          unackedRealm.port.removeEventListener('message', onUnackedMessage);
          unackedRealm.terminate({ force: true });
        }
      },
    );
  });
  it('bounds live file Realms and emits the aggregate plan at the end', async (t) => {
    await withTempProject({}, async (dir, fs) => {
      const imports = [
        "import { test } from 'fino:test/test';",
        "import { DiskFileSystem } from 'fino:file';",
        'const fs = new DiskFileSystem();',
      ];
      await fs.writeFile(
        `${dir}/a.test.ts`,
        [
          ...imports,
          `await fs.writeFile(${JSON.stringify(`${dir}/a.registered`)}, new Uint8Array([1]));`,
          "test('first file runs before the next file is retained', async (t) => {",
          '  let nextRegistered = true;',
          `  try { await fs.lstat(${JSON.stringify(`${dir}/b.registered`)}); } catch { nextRegistered = false; }`,
          "  t.equal(nextRegistered, false, 'the live Realm window is bounded');",
          '});',
          '',
        ].join('\n') as never,
      );
      await fs.writeFile(
        `${dir}/b.test.ts`,
        [
          ...imports,
          `await fs.writeFile(${JSON.stringify(`${dir}/b.registered`)}, new Uint8Array([1]));`,
          "test('next file enters after the first exits', async (t) => {",
          `  t.ok(await fs.lstat(${JSON.stringify(`${dir}/a.registered`)}));`,
          '});',
          '',
        ].join('\n') as never,
      );
      const { stdout, stderr, result } = await runCli(
        ['test', '--parallel', 'a.test.ts', 'b.test.ts'],
        { cwd: dir, env: { FINO_REACTOR_THREADS: '1', FINO_TEST_CONCURRENCY: '1' } },
      );
      t.equal(result.code, 0, 'rolling files exit successfully');
      t.equal(stderr, '', 'rolling registration has no diagnostics');
      t.ok(
        stdout.indexOf('ok 2 - next file enters after the first exits') < stdout.indexOf('1..2'),
        'aggregate plan follows every ordered test result',
      );
      t.ok(stdout.includes('# tests 2'), 'summary includes both rolling registrations');
    });
  });
  it('rejects an invalid parallel concurrency override', async (t) => {
    await withTempProject(
      {
        'valid.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('would pass', (t) => t.ok(true));",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stderr, result } = await runCli(['test', '--parallel', 'valid.test.ts'], {
          cwd: dir,
          env: { FINO_TEST_CONCURRENCY: '0' },
        });
        t.equal(result.code, 1, 'invalid concurrency exits nonzero');
        t.ok(
          stderr.includes('positive per-reactor integer'),
          'invalid concurrency reports its contract',
        );
      },
    );
  });
  it('reports a parallel file bootstrap failure after other files finish', async (t) => {
    await withTempProject(
      {
        'pass.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('parallel survivor', (t) => t.ok(true));",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--parallel', '--ordered', 'missing.test.ts', 'pass.test.ts'],
          { cwd: dir, env: { FINO_REACTOR_THREADS: '1' } },
        );
        t.equal(result.code, 1, 'a failed parallel file exits nonzero');
        t.ok(stdout.includes('not ok 1 - missing.test.ts failed to load or run'));
        t.ok(stdout.includes('ok 2 - parallel survivor'), 'later passing test still completes');
        t.ok(stdout.includes('# fail  1'), 'parallel summary counts failed files');
        t.ok(stderr.includes('1 test(s) failed'), 'aggregate failure is reported once');
      },
    );
  });
  it('aggregates ordinary parallel failures and skips without file wrappers', async (t) => {
    await withTempProject(
      {
        'failure.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('ordinary failure', () => { throw new Error('expected parallel failure'); });",
          '',
        ].join('\n'),
        'skip.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('ordinary skip', { skip: 'fixture reason' }, () => {});",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--parallel', '--ordered', 'failure.test.ts', 'skip.test.ts'],
          { cwd: dir },
        );
        t.equal(result.code, 1, 'ordinary test failure exits nonzero');
        t.ok(stdout.startsWith('TAP version 13\n'), 'root TAP header is emitted once');
        t.ok(stdout.includes('\n1..2\n'), 'root plan aggregates both tests');
        t.ok(stdout.includes('not ok 1 - ordinary failure'), 'failure remains a root test');
        t.ok(
          stdout.includes('ok 2 - ordinary skip # SKIP fixture reason'),
          'skip remains a root test with its directive',
        );
        t.ok(!stdout.includes('# Subtest: failure.test.ts'), 'failure has no file wrapper');
        t.ok(stdout.includes('# skip  1'), 'aggregate summary counts skips');
        t.ok(stdout.includes('# fail  1'), 'aggregate summary counts failures');
        t.ok(stdout.includes('expected parallel failure'), 'failure diagnostics are retained');
        t.ok(
          stdout.indexOf('ok 2 - ordinary skip') < stdout.indexOf('# Failure details'),
          'failure details wait until every root result has been emitted',
        );
        t.ok(
          stdout.indexOf('# fail  1') < stdout.indexOf('# Failure details'),
          'failure details follow the aggregate summary',
        );
        t.ok(stderr.includes('1 test(s) failed'), 'aggregate failure is reported once');
      },
    );
  });
  it('deduplicates overlapping parallel test inputs', async (t) => {
    await withTempProject(
      {
        'once.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('runs once', (t) => t.ok(true));",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--parallel', 'once.test.ts', './once.test.ts'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'duplicate parallel input exits successfully');
        t.equal(stderr, '', 'duplicate parallel input has no diagnostics');
        t.ok(stdout.includes('\n1..1\n'), 'root plan contains one test');
        t.equal(
          stdout.match(/ok \d+ - runs once/g)?.length,
          1,
          'normalized duplicate module contributes its test once',
        );
      },
    );
  });
  it('reports after hook failures from the test command', async (t) => {
    await withTempProject(
      {
        'after-failure.test.ts': [
          "import { after, describe, it } from 'fino:test/test';",
          "describe('cli after failure', () => {",
          "  after(() => { console.log('after:output'); throw new Error('after failed'); });",
          "  it('passes body', (t) => t.ok(true));",
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['test', 'after-failure.test.ts'], {
          cwd: dir,
        });
        t.equal(result.code, 1, 'after hook failure exits nonzero');
        t.ok(
          stderr.includes('[error] Error: 1 test(s) failed'),
          'test command writes failure summary to stderr',
        );
        t.ok(stdout.includes('ok 1 - passes body'), 'passing body is still reported');
        t.ok(stdout.includes('not ok 1 - cli after failure'), 'parent group is marked failed');
        t.ok(
          stdout.includes('# 1) after hook: cli after failure'),
          'after hook diagnostic title is printed',
        );
        t.ok(stdout.includes('#   Error: after failed'), 'after hook error is printed');
        t.ok(stdout.includes('#   after:output'), 'after hook output is captured');
      },
    );
  });
  it('expands test directories in the test command', async (t) => {
    await withTempProject(
      {
        'tests/alpha.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "describe('alpha directory suite', () => {",
          "  describe('needle directory group', () => {",
          "    it('runs directory test', (t) => t.ok(true));",
          '  });',
          '});',
          '',
        ].join('\n'),
        'tests/nested/beta.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "describe('beta directory suite', () => {",
          "  it('runs beta test', (t) => t.ok(true));",
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--filter', 'needle directory', 'tests'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'test directory input exits successfully');
        t.equal(stderr, '', 'test directory input does not write stderr');
        t.ok(
          stdout.includes('alpha directory suite'),
          'test directory input imports matching file',
        );
        t.ok(stdout.includes('needle directory group'), 'test directory input runs matching group');
        t.ok(
          !stdout.includes('beta directory suite'),
          'test directory input omits unmatched test groups',
        );
      },
    );
  });
  it('expands test globs in the test command', async (t) => {
    await withTempProject(
      {
        'tests/alpha.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "describe('alpha glob suite', () => {",
          "  describe('needle glob group', () => {",
          "    it('runs glob test', (t) => t.ok(true));",
          '  });',
          '});',
          '',
        ].join('\n'),
        'tests/nested/beta.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "describe('beta glob suite', () => {",
          "  it('runs beta test', (t) => t.ok(true));",
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', '--filter', 'needle glob', 'tests/**/*.test.ts'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'test glob input exits successfully');
        t.equal(stderr, '', 'test glob input does not write stderr');
        t.ok(stdout.includes('alpha glob suite'), 'test glob input imports matching file');
        t.ok(stdout.includes('needle glob group'), 'test glob input runs matching group');
        t.ok(!stdout.includes('beta glob suite'), 'test glob input omits unmatched test groups');
      },
    );
  });
  it('ignores non-test files passed to the test command', async (t) => {
    await withTempProject(
      {
        'tests/alpha.test.ts': [
          "import { describe, it } from 'fino:test/test';",
          "describe('alpha direct suite', () => {",
          "  it('runs direct test', (t) => t.ok(true));",
          '});',
          '',
        ].join('\n'),
        'tests/helper.ts': "throw new Error('helper file should not be imported by fino test');\n",
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['test', 'tests/alpha.test.ts', 'tests/helper.ts'],
          { cwd: dir },
        );
        t.equal(
          result.code,
          0,
          'test command exits successfully when non-test helpers are present',
        );
        t.equal(stderr, '', 'test command does not import helper failures');
        t.ok(stdout.includes('alpha direct suite'), 'test command imports the .test.ts file');
        t.equal(
          stdout.includes('helper file should not be imported'),
          false,
          'helper file is ignored',
        );
      },
    );
  });
  it('fails when expanded test inputs match no files', async (t) => {
    await withTempProject({}, async (dir) => {
      const { stdout, stderr, result } = await runRootInProcess(['test', 'tests'], { cwd: dir });
      t.equal(result.code, 1, 'empty test directory expansion exits with an error');
      t.equal(stdout, '', 'empty test expansion does not run the TAP runner');
      t.ok(
        stderr.includes('fino test: no test files matched'),
        'empty test expansion reports no matched files',
      );
    });
  });
});
