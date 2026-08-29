/** CLI root, run, watch, and REPL dispatch integration tests. */
import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { env, execPath, Process } from 'fino:process';
import * as loop from 'internal:runtime/loop';
import {
  decodeUtf8,
  parseRoot,
  poll,
  pprofThreadLabels,
  runCli,
  runRootInProcess,
  withTempProject,
} from './cli-test-helpers.ts';

describe('CLI commands: run', () => {
  it('prints root help with command list', async (t) => {
    const stdout = await parseRoot(['--help']);
    t.ok(stdout.includes('Usage: fino'), 'usage mentions fino root command');
    t.ok(stdout.includes('[script]'), 'usage documents script positional fallback');
    t.ok(stdout.includes('Commands:'), 'help lists commands');
    t.ok(stdout.includes('run'), 'help includes run command');
    t.ok(stdout.includes('repl'), 'help includes repl command');
    t.ok(stdout.includes('test'), 'help includes test command');
    t.ok(stdout.includes('coverage'), 'help includes coverage command');
    t.ok(stdout.includes('bench'), 'help includes bench command');
    t.ok(stdout.includes('load'), 'help includes load command');
    t.ok(stdout.includes('install'), 'help includes install command');
    t.ok(stdout.includes('init'), 'help includes init command');
    t.ok(stdout.includes('doc'), 'help includes doc command');
    t.ok(stdout.includes('fmt'), 'help includes fmt command');
    t.ok(stdout.includes('lint'), 'help includes lint command');
    t.ok(stdout.includes('task'), 'help includes task command');
  });
  it('runs a script through the root command', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/cli-script.ts']);
    t.equal(result.code, 0, 'script exits successfully');
    t.equal(stderr, '', 'script does not write stderr');
    t.ok(stdout.includes('cli fixture ran'), 'script was imported and executed');
  });
  it('writes one thread-labeled pprof for every in-process Realm', async (t) => {
    await withTempProject(
      {
        'entry.ts': [
          "import { Realm } from 'fino:realm';",
          "import { startProfiling, stopProfiling } from 'fino:profiler';",
          "import { cwd } from 'fino:process';",
          'function spin(ms: number) {',
          '  const end = Date.now() + ms;',
          '  let value = 0;',
          '  while (Date.now() < end) value += Math.sqrt(value + 1);',
          '  return value;',
          '}',
          "startProfiling('manual');",
          'spin(30);',
          "console.log('manual-profile:' + stopProfiling('manual').byteLength);",
          'await Promise.all([',
          '  new Realm({ entry: `file://${cwd()}/child.ts` }).run(),',
          '  new Realm({ entry: `file://${cwd()}/child.ts` }).run(),',
          ']);',
          'spin(20);',
          '',
        ].join('\n'),
        'child.ts': [
          'const end = Date.now() + 40;',
          'let value = 0;',
          'while (Date.now() < end) value += Math.sqrt(value + 1);',
          'console.log(`child-profile-work:${value > 0}`);',
          '',
        ].join('\n'),
        'error.ts': [
          'const end = Date.now() + 20;',
          'while (Date.now() < end) Math.sqrt(Date.now());',
          "throw new Error('profiled failure');",
          '',
        ].join('\n'),
      },
      async (dir, fs) => {
        const explicit = await runCli(['run', '--profile', 'entry.ts'], { cwd: dir });
        t.equal(explicit.result.code, 0, 'profiled run exits successfully');
        t.equal(explicit.stderr, '', 'profiled run does not write stderr');
        t.ok(explicit.stdout.includes('manual-profile:'), 'public profiler remains usable');

        const profilePath = `${dir}/profile.pb`;
        const profile = await new DiskFileSystem().readFile(profilePath);
        const labels = pprofThreadLabels(profile);
        const uniqueLabels = new Set(labels);
        t.ok(labels.length > 0, 'pprof samples carry thread labels');
        t.ok(uniqueLabels.size >= 3, 'concurrent Realms keep distinct thread values');
        t.ok(
          [...uniqueLabels].every((label) => label.startsWith('realm-')),
          'thread values use unique Realm identities',
        );
        t.ok(
          [...uniqueLabels].some((label) => label.includes('entry.ts')),
          'application Realm appears in the profile',
        );
        t.ok(
          [...uniqueLabels].some((label) => label.includes('child.ts')),
          'nested Realm appears in the profile',
        );

        await fs.unlink(profilePath);
        const shorthand = await runCli(['--profile', 'entry.ts'], { cwd: dir });
        t.equal(shorthand.result.code, 0, 'root shorthand profile exits successfully');
        t.ok((await new DiskFileSystem().readFile(profilePath)).byteLength > 0);

        await fs.unlink(profilePath);
        const failed = await runCli(['run', '--profile', 'error.ts'], { cwd: dir });
        t.equal(failed.result.code, 1, 'entry failure remains a failed run');
        t.ok(failed.stderr.includes('profiled failure'), 'entry failure is still reported');
        t.ok(
          pprofThreadLabels(await new DiskFileSystem().readFile(profilePath)).some((label) =>
            label.includes('error.ts'),
          ),
          'a failed Realm finalizes into the process profile',
        );

        await fs.unlink(profilePath);
        const trailing = await runCli(['run', 'entry.ts', '--profile'], { cwd: dir });
        t.equal(trailing.result.code, 0, 'trailing script flag exits successfully');
        let trailingProfileExists = true;
        try {
          await new DiskFileSystem().lstat(profilePath);
        } catch {
          trailingProfileExists = false;
        }
        t.equal(trailingProfileExists, false, 'a flag after the script belongs to the script');
      },
    );
  });
  it('keeps the root runtime alive until Atomics.waitAsync settles', async (t) => {
    const { stdout, stderr, result } = await runCli([
      './tests/fixtures/atomics-waitasync-keepalive.ts',
    ]);
    t.equal(result.code, 0, 'waitAsync fixture exits successfully');
    t.equal(stderr, '', 'waitAsync fixture does not write stderr');
    t.ok(stdout.includes('waitAsync:ok:1'), 'waitAsync settled after async notification');
  });
  it('reportError writes a diagnostic without failing the process', async (t) => {
    await withTempProject(
      {
        'report-error.ts': [
          "reportError(new Error('reported failure'));",
          "console.log('after-report-error');",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['report-error.ts'], { cwd: dir });
        t.equal(result.code, 0, 'reportError alone does not set a failing exit code');
        t.ok(stdout.includes('after-report-error'), 'script continues after reportError');
        t.ok(stderr.includes('Unhandled error:'), 'stderr includes reportError prefix');
        t.ok(stderr.includes('reported failure'), 'stderr includes the reported error');
      },
    );
  });
  it('reports root script top-level throw failures', async (t) => {
    await withTempProject(
      { 'throws.ts': "throw new Error('root top-level throw');\n" },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['throws.ts'], { cwd: dir });
        t.equal(result.code, 1, 'top-level throw exits nonzero');
        t.equal(stdout, '', 'top-level throw does not write stdout');
        t.ok(stderr.includes('root top-level throw'), 'stderr reports top-level throw');
      },
    );
  });
  it('reports root script top-level await rejections', async (t) => {
    await withTempProject(
      { 'rejects.ts': "await Promise.reject(new Error('root top-level await rejection'));\n" },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['rejects.ts'], { cwd: dir });
        t.equal(result.code, 1, 'top-level await rejection exits nonzero');
        t.equal(stdout, '', 'top-level await rejection does not write stdout');
        t.ok(
          stderr.includes('root top-level await rejection'),
          'stderr reports top-level await rejection',
        );
      },
    );
  });
  it('reports shutdown hook failure when the script succeeds', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/shutdown-hook-fails.ts']);
    t.equal(result.code, 1, 'shutdown-only failure exits nonzero');
    t.ok(stdout.includes('script completed'), 'script completed before shutdown failed');
    t.ok(stderr.includes('shutdown hook failed'), 'stderr reports hook failure');
  });
  it('keeps the script failure primary when shutdown also fails', async (t) => {
    const { stdout, stderr, result } = await runCli([
      './tests/fixtures/script-and-shutdown-fail.ts',
    ]);
    t.equal(result.code, 1, 'script failure exits nonzero');
    t.equal(stdout, '', 'failing script does not write stdout');
    t.ok(stderr.includes('primary script failure'), 'stderr reports primary script failure');
    t.ok(
      !stderr.includes('secondary shutdown failure'),
      'shutdown failure does not replace script failure',
    );
  });
  it('runs a script through the run command', async (t) => {
    const { stdout, stderr, result } = await runCli(['run', './tests/fixtures/cli-script.ts']);
    t.equal(result.code, 0, 'run command script exits successfully');
    t.equal(stderr, '', 'run command script does not write stderr');
    t.ok(stdout.includes('cli fixture ran'), 'run command imported and executed the script');
  });
  it('exposes root script arguments through process argv after --', async (t) => {
    await withTempProject(
      {
        'argv.ts': [
          "import { argv } from 'fino:process';",
          'console.log(JSON.stringify(argv.slice(1)));',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['argv.ts', '--', '--user-flag', 'value'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'root script with -- args exits successfully');
        t.equal(stderr, '', 'root script with -- args does not write stderr');
        t.ok(
          stdout.includes('["argv.ts","--","--user-flag","value"]'),
          'argv preserves script and user arguments',
        );
      },
    );
  });
  it('passes root script arguments without requiring --', async (t) => {
    await withTempProject(
      {
        'argv.ts': [
          "import { argv } from 'fino:process';",
          'console.log(JSON.stringify(argv.slice(1)));',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['argv.ts', '--watch', '--user-flag', 'value'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'root script with direct args exits successfully');
        t.equal(stderr, '', 'root script with direct args does not write stderr');
        t.ok(
          stdout.includes('["argv.ts","--watch","--user-flag","value"]'),
          'argv preserves all tokens after the script as script arguments',
        );
      },
    );
  });
  it('exposes run command script arguments through process argv after --', async (t) => {
    await withTempProject(
      {
        'argv.ts': [
          "import { argv } from 'fino:process';",
          'console.log(JSON.stringify(argv.slice(1)));',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['run', 'argv.ts', '--', '--user-flag', 'value'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'run script with -- args exits successfully');
        t.equal(stderr, '', 'run script with -- args does not write stderr');
        t.ok(
          stdout.includes('["run","argv.ts","--","--user-flag","value"]'),
          'argv preserves run command, script, and user arguments',
        );
      },
    );
  });
  it('passes run command script arguments without requiring --', async (t) => {
    await withTempProject(
      {
        'argv.ts': [
          "import { argv } from 'fino:process';",
          'console.log(JSON.stringify(argv.slice(1)));',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(
          ['run', 'argv.ts', '--watch', '--user-flag', 'value'],
          { cwd: dir },
        );
        t.equal(result.code, 0, 'run script with direct args exits successfully');
        t.equal(stderr, '', 'run script with direct args does not write stderr');
        t.ok(
          stdout.includes('["run","argv.ts","--watch","--user-flag","value"]'),
          'argv preserves run command, script, and all script arguments',
        );
      },
    );
  });
  it('prints focused help for each subcommand', async (t) => {
    const commands = [
      'run',
      'test',
      'coverage',
      'bench',
      'load',
      'install',
      'init',
      'doc',
      'fmt',
      'lint',
      'repl',
      'preview',
    ];
    for (const command of commands) {
      const stdout = await parseRoot([command, '--help']);
      t.ok(stdout.includes(`Usage: fino ${command}`), `${command} --help includes command usage`);
    }
  });
  it('reports a missing script for run without arguments', async (t) => {
    const { stdout, stderr, result } = await runRootInProcess(['run']);
    t.equal(result.code, 1, 'run without a script exits nonzero');
    t.equal(stdout, '', 'run without a script does not write stdout');
    t.ok(stderr.includes('script'), 'run without a script reports the missing script positional');
  });
  it('reports module resolution failures for missing root, test, and bench inputs', async (t) => {
    await withTempProject({}, async (dir) => {
      for (const [label, args] of [
        ['root script fallback', ['missing-entry.ts']],
        ['test input', ['test', 'missing.test.ts']],
        ['bench input', ['bench', 'missing.bench.ts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runRootInProcess(args, { cwd: dir });
        t.equal(result.code, 1, `${label} exits nonzero`);
        t.equal(stdout, '', `${label} does not write stdout`);
        t.ok(
          stderr.includes('Cannot resolve module'),
          `${label} reports module resolution failure`,
        );
      }
    });
  });
  it('does not expand run command directory or glob inputs', async (t) => {
    await withTempProject(
      { 'scripts/entry.ts': "console.log('should-not-run');\n" },
      async (dir) => {
        for (const [label, args] of [
          ['directory input', ['run', 'scripts']],
          ['glob input', ['run', 'scripts/*.ts']],
        ] as [string, string[]][]) {
          const { stdout, stderr, result } = await runRootInProcess(args, { cwd: dir });
          t.equal(result.code, 1, `${label} exits nonzero`);
          t.equal(stdout, '', `${label} does not import discovered scripts`);
          t.ok(stderr.length > 0, `${label} reports the unresolved module specifier`);
          t.ok(!stderr.includes('should-not-run'), `${label} does not execute nested files`);
        }
      },
    );
  });
  it('reruns run --watch when an imported module changes', async (t) => {
    await withTempProject(
      {
        'state.ts': 'export const value = 1;\n',
        'entry.ts': [
          "import { value } from './state.ts';",
          "console.log('watch value:' + value);",
          '',
        ].join('\n'),
      },
      async (dir, fs) => {
        const childEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
          if (value !== undefined) childEnv[key] = value;
        }
        const proc = new Process(execPath, ['run', '--watch', 'entry.ts'], {
          cwd: dir,
          env: childEnv,
        });
        proc.stdin.close();
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        const stdoutDone = (async () => {
          for await (const chunk of proc.stdout) stdoutChunks.push(decodeUtf8(chunk));
        })();
        const stderrDone = (async () => {
          for await (const chunk of proc.stderr) stderrChunks.push(decodeUtf8(chunk));
        })();
        try {
          // A debug build may spend several seconds creating and compiling a
          // fresh isolate group before the watched entrypoint first runs.
          await poll(() => stdoutChunks.join('').includes('watch value:1'), 10e3);
          await loop.timeout(300);
          await fs.writeFile(dir + '/state.ts', 'export const value = 2;\n');
          await poll(() => stdoutChunks.join('').includes('watch value:2'), 10e3);
        } finally {
          proc.kill();
        }
        const result = await proc.wait();
        await Promise.all([stdoutDone, stderrDone]);
        t.ok(result.signal !== null || result.code === 0, 'watch child terminates after SIGTERM');
        t.equal(stderrChunks.join(''), '', 'run --watch does not write stderr');
      },
    );
  });
  it('passes --otlp-endpoint into run --watch realms', async (t) => {
    await withTempProject(
      {
        'entry.ts': [
          "import { getTracerProvider } from 'fino:opentelemetry';",
          'globalThis.fetch = async (url) => {',
          "  console.log('watch-export:' + String(url));",
          "  return new Response('{}', { status: 200 });",
          '};',
          "const span = getTracerProvider().getTracer('watch.fixture').startSpan('watch-span');",
          'span.end();',
          'await new Promise((resolve) => setTimeout(resolve, 80));',
          "console.log('watch-ready');",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const childEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
          if (value !== undefined) childEnv[key] = value;
        }
        childEnv.FINO_OTEL_EXPORT_INTERVAL_MS = '20';
        const proc = new Process(
          execPath,
          ['run', '--watch', '--otlp-endpoint', 'http://collector.example:4318/watch', 'entry.ts'],
          {
            cwd: dir,
            env: childEnv,
          },
        );
        proc.stdin.close();
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];
        const stdoutDone = (async () => {
          for await (const chunk of proc.stdout) stdoutChunks.push(decodeUtf8(chunk));
        })();
        const stderrDone = (async () => {
          for await (const chunk of proc.stderr) stderrChunks.push(decodeUtf8(chunk));
        })();
        try {
          await poll(
            () =>
              stdoutChunks
                .join('')
                .includes('watch-export:http://collector.example:4318/watch/v1/traces'),
            10e3,
          );
        } finally {
          proc.kill();
        }
        const result = await proc.wait();
        await Promise.all([stdoutDone, stderrDone]);
        t.ok(
          result.signal !== null || result.code === 0,
          'watch OTLP child terminates after SIGTERM',
        );
        t.equal(stderrChunks.join(''), '', 'run --watch OTLP does not write stderr');
      },
    );
  });
  it('starts the REPL when no script is given', async (t) => {
    const { stdout, stderr, result } = await runCli([]);
    t.equal(result.code, 0, 'empty root invocation exits successfully after stdin closes');
    t.equal(stderr, '', 'empty root invocation does not write stderr');
    t.ok(stdout.includes('Fino REPL'), 'empty root invocation starts the REPL');
    t.ok(stdout.includes('> '), 'empty root invocation prints the REPL prompt');
  });
  it('starts the REPL through the repl command', async (t) => {
    const { stdout, stderr, result } = await runCli(['repl']);
    t.equal(result.code, 0, 'repl command exits successfully after stdin closes');
    t.equal(stderr, '', 'repl command does not write stderr');
    t.ok(stdout.includes('Fino REPL'), 'repl command starts the REPL');
    t.ok(stdout.includes('> '), 'repl command prints the REPL prompt');
  });
  it('prints mapped ts locations to stderr', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/source-map-cli.ts']);
    t.equal(result.code, 0, 'script exits successfully after printing the error');
    t.equal(stdout, '', 'failing script does not write stdout');
    t.ok(stderr.includes('source-map-throw.ts:14'), 'stderr points at original ts line');
  });
});
