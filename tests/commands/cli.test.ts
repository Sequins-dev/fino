/**
 * Command integration tests for the fino CLI tree defined by js/internal/main.ts.
 */
import { describe, it } from 'fino:test/test';
import type { Assert } from 'fino:test/assert';
import { chdir, cwd, Process, env, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import * as loop from 'internal:runtime/loop';
import rootCommand from 'internal:commands/root';
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const DURATION_RE = String.raw`\d+(?:\.\d+)?(?:ns|us|ms|s|m|h)\b`;
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  return decodeUtf8(
    chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
      const merged = new Uint8Array(acc.byteLength + c.byteLength);
      merged.set(acc);
      merged.set(c, acc.byteLength);
      return merged;
    }, new Uint8Array(0)),
  );
}
async function runCli(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  result: Awaited<ReturnType<Process['wait']>>;
}> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...env,
    ...(options.env || {}),
  })) {
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.FINO_OTEL_EXPORT_INTERVAL_MS ??= '20';
  const proc = new Process(execPath, args, {
    env: childEnv,
    cwd: options.cwd,
  });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return {
    stdout,
    stderr,
    result,
  };
}
async function mkdirp(fs: DiskFileSystem, path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let current = path.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? '/' + part : current + '/' + part;
    try {
      await fs.mkdir(current);
    } catch {}
  }
}
async function rmrf(fs: DiskFileSystem, path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isDirectory()) {
    const dir = await fs.dir(path);
    for await (const entry of dir) await rmrf(fs, entry.path.toString());
    await fs.rmdir(path);
  } else {
    await fs.unlink(path);
  }
}
async function withTempProject<T>(
  tree: Record<string, string>,
  fn: (dir: string, fs: DiskFileSystem) => Promise<T>,
): Promise<T> {
  const fs = new DiskFileSystem();
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const rawReadFile = fs.readFile.bind(fs);
  const rawWriteFile = fs.writeFile.bind(fs);
  fs.readFile = (async (path: string) => textDecoder.decode(await rawReadFile(path))) as never;
  fs.writeFile = (async (
    path: string,
    data: string | Uint8Array | ArrayBuffer | ArrayBufferView,
  ) => {
    await rawWriteFile(path, typeof data === 'string' ? textEncoder.encode(data) : data);
  }) as never;
  const dir = '/tmp/fino-tooling-cli-' + Math.floor(Math.random() * 1e9);
  await fs.mkdir(dir);
  try {
    for (const [rel, content] of Object.entries(tree)) {
      const path = dir + '/' + rel;
      const slash = path.lastIndexOf('/');
      if (slash > dir.length) await mkdirp(fs, path.slice(0, slash));
      await fs.writeFile(path, content as never);
    }
    return await fn(dir, fs);
  } finally {
    await rmrf(fs, dir);
  }
}
async function poll(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await loop.timeout(50);
  }
}
async function expectLiveOtelSignal(
  t: Assert,
  fixture: string,
  path: string,
  label: string,
): Promise<void> {
  const { stdout, stderr, result } = await runCli([
    '--otlp-endpoint',
    'http://collector.example:4318/custom',
    fixture,
  ]);
  t.equal(result.code, 0, `${label} script exits successfully`);
  t.equal(stderr, '', `${label} OTEL bootstrap does not write stderr`);
  const exportIndex = stdout.indexOf(`export:http://collector.example:4318/custom/v1/${path}`);
  const runningIndex = stdout.indexOf('still-running');
  t.ok(exportIndex !== -1, `${label} export happened during process lifetime`);
  t.ok(runningIndex !== -1, `${label} fixture remained alive after producing telemetry`);
  t.ok(exportIndex < runningIndex, `${label} export happened before the script finished running`);
}
async function parseRoot(args: string[]): Promise<string> {
  const result = await rootCommand.parse(args);
  return typeof result === 'string' ? result : '';
}
async function runRootInProcess(
  args: string[],
  options: {
    cwd?: string;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  result: {
    code: number;
    signal: number | null;
  };
}> {
  const previousCwd = cwd();
  try {
    if (options.cwd !== undefined) chdir(options.cwd);
    const result = await rootCommand.parse(args);
    return {
      stdout: typeof result === 'string' ? result : '',
      stderr: '',
      result: {
        code: 0,
        signal: null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: message + '\n',
      result: {
        code: 1,
        signal: null,
      },
    };
  } finally {
    if (options.cwd !== undefined) chdir(previousCwd);
  }
}
describe('CLI commands', () => {
  it('prints root help with command list', async (t) => {
    const stdout = await parseRoot(['--help']);
    t.ok(stdout.includes('Usage: fino'), 'usage mentions fino root command');
    t.ok(stdout.includes('[script]'), 'usage documents script positional fallback');
    t.ok(stdout.includes('Commands:'), 'help lists commands');
    t.ok(stdout.includes('run'), 'help includes run command');
    t.ok(stdout.includes('repl'), 'help includes repl command');
    t.ok(stdout.includes('test'), 'help includes test command');
    t.ok(stdout.includes('bench'), 'help includes bench command');
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
    const commands = ['run', 'test', 'bench', 'install', 'init', 'doc', 'fmt', 'lint', 'repl'];
    for (const command of commands) {
      const stdout = await parseRoot([command, '--help']);
      t.ok(stdout.includes(`Usage: fino ${command}`), `${command} --help includes command usage`);
    }
  });
  it('runs tasks loaded from a project tasks directory', async (t) => {
    await withTempProject(
      {
        'tasks/build.ts': [
          "import { task } from 'fino:task';",
          'export default task({',
          "  name: 'build',",
          "  cli: { options: [{ flags: '--name', type: 'string', required: true }] },",
          '  run: async (input, ctx) => {',
          '    await ctx.writer.writeText(`build:${input.name}\\n`);',
          '  }',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', 'build', '--name', 'Ada'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'project task exits successfully');
        t.equal(stderr, '', 'project task does not write stderr');
        t.ok(stdout.includes('build:Ada'), 'project task wrote expected output');
      },
    );
  });
  it('runs every CLI command inside a process-reactor workload', async (t) => {
    await withTempProject(
      {
        'tasks/location.ts': [
          "import { task } from 'fino:task';",
          "import { currentWorkloadOwner, usesProcessReadiness } from 'internal:scheduler-native';",
          'export default task({',
          "  name: 'location',",
          '  run: async (_input, ctx) => {',
          "    const leaked = Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('__fino'));",
          '    await ctx.writer.writeText(',
          '      `reactor:${usesProcessReadiness()}:${currentWorkloadOwner() > 0}:${leaked.length}\\n`,',
          '    );',
          '  }',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', 'location'], { cwd: dir });
        t.equal(result.code, 0, 'project task exits successfully');
        t.equal(stderr, '', 'project task does not write stderr');
        t.ok(
          stdout.includes('reactor:true:true:0'),
          'project task uses host-owned scheduler state without leaking globals',
        );
      },
    );
  });
  it('loads multiple task files as sibling commands', async (t) => {
    await withTempProject(
      {
        'tasks/build.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'build', run: async (_input, ctx) => ctx.writer.writeText('build\\n') });",
          '',
        ].join('\n'),
        'tasks/deploy.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'deploy', run: async (_input, ctx) => ctx.writer.writeText('deploy\\n') });",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', 'deploy'], { cwd: dir });
        t.equal(result.code, 0, 'second task exits successfully');
        t.equal(stderr, '', 'second task does not write stderr');
        t.ok(stdout.includes('deploy'), 'second task was loaded as a sibling command');
      },
    );
  });
  it('prints help for loaded project tasks', async (t) => {
    await withTempProject(
      {
        'tasks/build.ts': [
          "import { task } from 'fino:task';",
          'export default task({',
          "  name: 'build',",
          "  description: 'Build the application',",
          "  cli: { options: [{ flags: '--watch', type: 'boolean', description: 'Watch files' }] },",
          '  run: async () => undefined',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const rootHelp = await runCli(['task', '--help'], { cwd: dir });
        t.equal(rootHelp.result.code, 0, 'task root help exits successfully');
        t.equal(rootHelp.stderr, '', 'task root help does not write stderr');
        t.ok(rootHelp.stdout.includes('Usage: fino task'), 'task root help shows delegated usage');
        t.ok(rootHelp.stdout.includes('build'), 'task root help lists project task');
        const childHelp = await runCli(['task', 'build', '--help'], { cwd: dir });
        t.equal(childHelp.result.code, 0, 'task child help exits successfully');
        t.equal(childHelp.stderr, '', 'task child help does not write stderr');
        t.ok(
          childHelp.stdout.includes('Usage: fino task build'),
          'task child help shows child usage',
        );
        t.ok(childHelp.stdout.includes('--watch'), 'task child help lists child option');
      },
    );
  });
  it('passes JSON output mode to loaded project tasks', async (t) => {
    await withTempProject(
      {
        'tasks/inspect.ts': [
          "import { task } from 'fino:task';",
          'export default task({',
          "  name: 'inspect',",
          "  outputMode: 'both',",
          '  run: async (_input, ctx) => {',
          "    if (ctx.writer.mode === 'json') {",
          "      await ctx.writer.writeJson({ ok: true, task: 'inspect' });",
          '      return;',
          '    }',
          "    await ctx.writer.writeText('inspect\\n');",
          '  }',
          '});',
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', '--json', 'inspect'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'json project task exits successfully');
        t.equal(stderr, '', 'json project task does not write stderr');
        t.ok(stdout.includes('"task":"inspect"'), 'project task wrote JSON through shared writer');
      },
    );
  });
  it('loads tasks from a custom directory', async (t) => {
    await withTempProject(
      {
        'custom/deploy.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'deploy', run: async (_input, ctx) => ctx.writer.writeText('custom-deploy\\n') });",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['task', '--dir', 'custom', 'deploy'], {
          cwd: dir,
        });
        t.equal(result.code, 0, 'custom-directory task exits successfully');
        t.equal(stderr, '', 'custom-directory task does not write stderr');
        t.ok(stdout.includes('custom-deploy'), 'task was loaded from custom directory');
      },
    );
  });
  it('reports task directory loading errors clearly', async (t) => {
    await withTempProject(
      {
        'empty/.keep': '',
        'invalid/bad.ts': "export default { name: 'bad' };\n",
        'duplicate/a.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'same', run: async () => undefined });",
          '',
        ].join('\n'),
        'duplicate/b.ts': [
          "import { task } from 'fino:task';",
          "export default task({ name: 'same', run: async () => undefined });",
          '',
        ].join('\n'),
      },
      async (dir) => {
        const missing = await runCli(['task'], { cwd: dir });
        t.equal(missing.result.code, 1, 'missing tasks directory exits nonzero');
        t.ok(
          missing.stderr.includes('no tasks directory found'),
          'missing directory error names the issue',
        );
        const empty = await runCli(['task', '--dir', 'empty'], { cwd: dir });
        t.equal(empty.result.code, 1, 'empty tasks directory exits nonzero');
        t.ok(empty.stderr.includes('no task files found'), 'empty directory error names the issue');
        const invalid = await runCli(['task', '--dir', 'invalid'], { cwd: dir });
        t.equal(invalid.result.code, 1, 'invalid task export exits nonzero');
        t.ok(invalid.stderr.includes('bad.ts'), 'invalid export error names the file');
        t.ok(
          invalid.stderr.includes('default-export a Task'),
          'invalid export error explains the contract',
        );
        const duplicate = await runCli(['task', '--dir', 'duplicate'], { cwd: dir });
        t.equal(duplicate.result.code, 1, 'duplicate task names exit nonzero');
        t.ok(
          duplicate.stderr.includes('Duplicate task "same"'),
          'duplicate task error names the task',
        );
      },
    );
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
          await poll(() => stdoutChunks.join('').includes('watch value:1'), 3e3);
          await loop.timeout(300);
          await fs.writeFile(dir + '/state.ts', 'export const value = 2;\n');
          await poll(() => stdoutChunks.join('').includes('watch value:2'), 5e3);
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
            5e3,
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
  it('fmt --check reports changed files without writing', async (t) => {
    await withTempProject(
      { 'src/app.ts': 'const value = "hello";\nif (value) { console.log(value); }\n' },
      async (dir, fs) => {
        const before = await fs.readFile(dir + '/src/app.ts');
        const { stdout, stderr, result } = await runCli(['fmt', '--check'], { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(result.code, 1, 'fmt --check exits nonzero when files would change');
        t.equal(stdout, '', 'fmt --check failure does not write stdout');
        t.ok(stderr.includes('src/app.ts would reformat'), 'fmt --check reports the changed file');
        t.equal(after, before, 'fmt --check does not write the file');
      },
    );
  });
  it('fmt writes only changed source files', async (t) => {
    await withTempProject(
      {
        'src/app.ts': 'const value = "hello";\nif (value) { console.log(value); }\n',
        'target/generated.ts': 'const value = "ignored";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt'], { cwd: dir });
        const formatted = await fs.readFile(dir + '/src/app.ts');
        const ignored = await fs.readFile(dir + '/target/generated.ts');
        t.equal(result.code, 0, 'fmt exits successfully');
        t.equal(stderr, '', 'fmt success does not write stderr');
        t.ok(stdout.includes('formatted 1 file'), 'fmt reports changed files');
        t.equal(
          formatted,
          "const value = 'hello';\nif (value) {\n  console.log(value);\n}\n",
          'fmt writes formatted source',
        );
        t.equal(ignored, 'const value = "ignored";\n', 'fmt ignores generated output directories');
      },
    );
  });
  it('fmt accepts explicit glob inputs', async (t) => {
    await withTempProject(
      {
        'src/app.ts': 'const value = "hello";\n',
        'other/app.ts': 'const value = "unchanged";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt', 'src/*.ts'], { cwd: dir });
        const formatted = await fs.readFile(dir + '/src/app.ts');
        const untouched = await fs.readFile(dir + '/other/app.ts');
        t.equal(result.code, 0, 'fmt exits successfully for explicit glob');
        t.equal(stderr, '', 'fmt explicit glob does not write stderr');
        t.ok(stdout.includes('formatted 1 file'), 'fmt explicit glob reports changed files');
        t.equal(formatted, "const value = 'hello';\n", 'fmt writes matched file');
        t.equal(untouched, 'const value = "unchanged";\n', 'fmt leaves unmatched source alone');
      },
    );
  });
  it('fmt fails missing explicit directory and glob inputs without writing', async (t) => {
    await withTempProject({ 'src/app.ts': 'const value = "hello";\n' }, async (dir, fs) => {
      const before = await fs.readFile(dir + '/src/app.ts');
      for (const [label, args] of [
        ['missing directory', ['fmt', 'missing-dir']],
        ['missing glob', ['fmt', 'src/missing-*.ts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runCli(args, { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(result.code, 1, `fmt ${label} exits nonzero`);
        t.equal(stdout, '', `fmt ${label} does not write stdout`);
        t.ok(stderr.includes('fino fmt:'), `fmt ${label} reports command failure`);
        t.equal(after, before, `fmt ${label} does not write unrelated source`);
      }
    });
  });
  it('fmt reports parse diagnostics with file locations', async (t) => {
    await withTempProject({ 'src/broken.ts': 'export function broken( {\n' }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['fmt'], { cwd: dir });
      t.equal(result.code, 1, 'fmt exits nonzero for parse diagnostics');
      t.equal(stdout, '', 'fmt diagnostics do not write stdout');
      t.ok(stderr.includes('src/broken.ts'), 'diagnostics include the relative file path');
      t.ok(stderr.includes('1:1'), 'diagnostics include a source location');
      t.ok(stderr.includes('error parse'), 'diagnostics include severity and code');
      t.ok(stderr.includes('fino fmt:'), 'command error summary is printed');
    });
  });
  it('fmt recursively discovers source directories and ignores hidden and build output', async (t) => {
    await withTempProject(
      {
        'src/app.ts': 'const value = "hello";\n',
        'src/nested/view.ts': 'const view = "ok";\n',
        '.hidden/ignored.ts': 'const value = "hidden";\n',
        'build/ignored.ts': 'const value = "build";\n',
        'dist/ignored.ts': 'const value = "dist";\n',
        'target/ignored.ts': 'const value = "target";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt'], { cwd: dir });
        const app = await fs.readFile(dir + '/src/app.ts');
        const view = await fs.readFile(dir + '/src/nested/view.ts');
        const hidden = await fs.readFile(dir + '/.hidden/ignored.ts');
        const build = await fs.readFile(dir + '/build/ignored.ts');
        const dist = await fs.readFile(dir + '/dist/ignored.ts');
        const target = await fs.readFile(dir + '/target/ignored.ts');
        t.equal(result.code, 0, 'fmt exits successfully');
        t.equal(stderr, '', 'fmt recursive discovery does not write stderr');
        t.ok(stdout.includes('formatted 2 files'), 'fmt reports both discovered source files');
        t.equal(app, "const value = 'hello';\n", 'fmt formats nested source under cwd');
        t.equal(view, "const view = 'ok';\n", 'fmt formats recursively discovered nested source');
        t.equal(hidden, 'const value = "hidden";\n', 'fmt ignores hidden directories');
        t.equal(build, 'const value = "build";\n', 'fmt ignores build directories');
        t.equal(dist, 'const value = "dist";\n', 'fmt ignores dist directories');
        t.equal(target, 'const value = "target";\n', 'fmt ignores target directories');
      },
    );
  });
  it('fmt discovery uses supported extensions, recursion, ignores, sorting, and dedupe', async (t) => {
    await withTempProject(
      {
        'src/b.ts': 'const b = "b";\n',
        'src/a.ts': 'const a = "a";\n',
        'src/nested/c.jsx': 'const c = "c";\n',
        'src/unsupported.json': '{"quote":"double"}\n',
        '.hidden/d.ts': 'const d = "d";\n',
        'node_modules/pkg/e.ts': 'const e = "e";\n',
      },
      async (dir, fs) => {
        const { stdout, stderr, result } = await runCli(['fmt', 'src/b.ts', 'src', 'src/*.ts'], {
          cwd: dir,
        });
        const a = await fs.readFile(dir + '/src/a.ts');
        const b = await fs.readFile(dir + '/src/b.ts');
        const c = await fs.readFile(dir + '/src/nested/c.jsx');
        const unsupported = await fs.readFile(dir + '/src/unsupported.json');
        const hidden = await fs.readFile(dir + '/.hidden/d.ts');
        const ignored = await fs.readFile(dir + '/node_modules/pkg/e.ts');
        t.equal(result.code, 0, 'fmt exits successfully for mixed explicit inputs');
        t.equal(stderr, '', 'fmt mixed discovery does not write stderr');
        t.ok(
          stdout.includes('formatted 3 files'),
          'fmt de-dupes overlapping file, directory, and glob inputs',
        );
        t.equal(a, "const a = 'a';\n", 'fmt includes supported .ts files');
        t.equal(b, "const b = 'b';\n", 'fmt includes supported .ts files once');
        t.equal(c, "const c = 'c';\n", 'fmt recursively includes supported nested files');
        t.equal(unsupported, '{"quote":"double"}\n', 'fmt ignores unsupported extensions');
        t.equal(hidden, 'const d = "d";\n', 'fmt ignores hidden directories');
        t.equal(ignored, 'const e = "e";\n', 'fmt ignores built-in ignored directories');
      },
    );
  });
  it('lint reports diagnostics and lint --fix does not format', async (t) => {
    await withTempProject(
      { 'src/app.ts': 'debugger;\nexport const value = "hello";\n' },
      async (dir, fs) => {
        const linted = await runCli(['lint'], { cwd: dir });
        t.equal(linted.result.code, 1, 'lint exits nonzero for diagnostics');
        t.ok(linted.stderr.includes('no-debugger'), 'lint reports rule code');
        const fixed = await runCli(['lint', '--fix'], { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(fixed.result.code, 0, 'lint --fix exits successfully after applying safe fixes');
        t.ok(
          fixed.stdout.includes('fino lint: fixed 1 file, 0 remaining'),
          'lint --fix reports applied fixes',
        );
        t.equal(fixed.stderr, '', 'lint --fix does not report diagnostics removed by fixes');
        t.equal(after.includes('debugger'), false, 'lint --fix removes the debugger statement');
        t.ok(
          after.includes('export const value = "hello";'),
          'lint --fix does not reformat unaffected source',
        );
      },
    );
  });
  it('lint fails missing explicit directory and glob inputs without writing', async (t) => {
    await withTempProject({ 'src/app.ts': 'const value = "hello";\n' }, async (dir, fs) => {
      const before = await fs.readFile(dir + '/src/app.ts');
      for (const [label, args] of [
        ['missing directory', ['lint', 'missing-dir']],
        ['missing glob', ['lint', 'src/missing-*.ts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runCli(args, { cwd: dir });
        const after = await fs.readFile(dir + '/src/app.ts');
        t.equal(result.code, 1, `lint ${label} exits nonzero`);
        t.equal(stdout, '', `lint ${label} does not write stdout`);
        t.ok(stderr.includes('fino lint:'), `lint ${label} reports command failure`);
        t.equal(after, before, `lint ${label} does not write unrelated source`);
      }
    });
  });
  it('lint reports files in sorted de-duplicated discovery order', async (t) => {
    await withTempProject(
      {
        'src/b.ts': 'debugger;\n',
        'src/a.ts': 'debugger;\n',
        'src/nested/c.ts': 'debugger;\n',
        'src/ignored.json': '{"debugger":true}\n',
        '.hidden/d.ts': 'debugger;\n',
        'dist/e.ts': 'debugger;\n',
      },
      async (dir) => {
        const { stdout, stderr, result } = await runCli(['lint', 'src/b.ts', 'src', 'src/*.ts'], {
          cwd: dir,
        });
        const first = stderr.indexOf('src/a.ts');
        const second = stderr.indexOf('src/b.ts');
        const third = stderr.indexOf('src/nested/c.ts');
        t.equal(result.code, 1, 'lint exits nonzero for discovered diagnostics');
        t.equal(stdout, '', 'lint diagnostics do not write stdout');
        t.ok(
          first !== -1 && second !== -1 && third !== -1,
          'lint reports all supported discovered files',
        );
        t.ok(first < second && second < third, 'lint reports discovered files in sorted order');
        t.equal(
          stderr.indexOf('src/b.ts'),
          stderr.lastIndexOf('src/b.ts'),
          'lint de-dupes overlapping inputs',
        );
        t.notOk(stderr.includes('src/ignored.json'), 'lint ignores unsupported extensions');
        t.notOk(stderr.includes('.hidden/d.ts'), 'lint ignores hidden directories');
        t.notOk(stderr.includes('dist/e.ts'), 'lint ignores built-in ignored directories');
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
        const never = await runCli(['test', '--show-output=never', 'output.test.ts'], { cwd: dir });
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
  it('prints mapped ts locations to stderr', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/source-map-cli.ts']);
    t.equal(result.code, 0, 'script exits successfully after printing the error');
    t.equal(stdout, '', 'failing script does not write stdout');
    t.ok(stderr.includes('source-map-throw.ts:14'), 'stderr points at original ts line');
  });
  it('boots OTEL export for the root script and its dependencies', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-script.ts',
    ]);
    t.equal(result.code, 0, 'script exits successfully with OTEL enabled');
    t.equal(stderr, '', 'OTEL bootstrap does not write stderr');
    t.ok(stdout.includes('entry providers ready'), 'entry script sees OTEL providers');
    t.ok(stdout.includes('dependency providers ready'), 'dependency import sees OTEL providers');
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/traces'),
      'trace export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/logs'),
      'log export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/metrics'),
      'metric export targets the configured endpoint',
    );
    t.ok(stdout.includes('application/json'), 'OTEL bootstrap uses JSON content type');
    t.ok(stdout.includes('"resourceSpans"'), 'trace export uses OTLP JSON structure');
    t.ok(stdout.includes('"resourceLogs"'), 'log export uses OTLP JSON structure');
    t.ok(stdout.includes('"resourceMetrics"'), 'metric export uses OTLP JSON structure');
  });
  it('uses --otlp-endpoint to bootstrap the entrypoint SDK', async (t) => {
    const disabled = await runCli(['./tests/fixtures/cli-otel-entrypoint.ts']);
    t.equal(
      disabled.result.code,
      0,
      'entrypoint fixture exits successfully without OTEL bootstrap',
    );
    t.equal(disabled.stderr, '', 'entrypoint fixture without OTEL bootstrap does not write stderr');
    t.ok(
      !disabled.stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'trace export is not active without --otlp-endpoint',
    );
    t.ok(
      !disabled.stdout.includes('export:http://collector.example:4318/custom/v1/logs'),
      'log export is not active without --otlp-endpoint',
    );
    t.ok(
      !disabled.stdout.includes('export:http://collector.example:4318/custom/v1/metrics'),
      'metric export is not active without --otlp-endpoint',
    );
    const enabled = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-entrypoint.ts',
    ]);
    t.equal(enabled.result.code, 0, 'entrypoint fixture exits successfully with OTEL bootstrap');
    t.equal(enabled.stderr, '', 'entrypoint fixture with OTEL bootstrap does not write stderr');
    t.ok(
      enabled.stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'trace export is active with --otlp-endpoint',
    );
    t.ok(
      enabled.stdout.includes('export:http://collector.example:4318/custom/v1/logs'),
      'log export is active with --otlp-endpoint',
    );
    t.ok(
      enabled.stdout.includes('export:http://collector.example:4318/custom/v1/metrics'),
      'metric export is active with --otlp-endpoint',
    );
    t.ok(
      enabled.stdout.includes('"service.name"'),
      'entrypoint export includes service.name resource metadata',
    );
    t.ok(enabled.stdout.includes('"fino"'), 'entrypoint export uses package.json service.name');
    t.ok(
      enabled.stdout.includes('"service.version"'),
      'entrypoint export includes package version resource metadata',
    );
    t.ok(enabled.stdout.includes('"1.0.0"'), 'entrypoint export includes package.json version');
    t.ok(
      enabled.stdout.includes('"telemetry.sdk.name"'),
      'entrypoint export includes telemetry SDK metadata',
    );
    t.ok(
      !enabled.stdout.includes('POST http://collector.example:4318/custom/v1/traces'),
      'exporter requests do not generate fetch client spans',
    );
    t.ok(
      !enabled.stdout.includes('"scope":{"name":"fetch"}'),
      'exporter requests do not emit fetch scope spans',
    );
    t.ok(
      !enabled.stdout.includes('"scope":{"name":"dns"}'),
      'exporter requests do not emit dns scope spans',
    );
    t.ok(
      !enabled.stdout.includes('"scope":{"name":"socket"}'),
      'exporter requests do not emit socket scope spans',
    );
  });
  it('passes the CLI OTLP endpoint to constructed realms with overrides', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-child-realms.ts',
    ]);
    t.equal(result.code, 0, 'child realm fixture exits successfully');
    t.equal(stderr, '', 'child realm fixture does not write stderr');
    t.ok(
      stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'child realm inherits the CLI endpoint',
    );
    t.ok(
      stdout.includes('export:http://override-collector.example:4318/override/v1/traces'),
      'child realm can override the endpoint',
    );
    t.ok(stdout.includes('child:disabled:done'), 'disabled child still runs');
    const disabledStart = stdout.indexOf('child:override:done');
    const disabledOutput = disabledStart >= 0 ? stdout.slice(disabledStart) : stdout;
    t.ok(
      !disabledOutput.includes('export:http://collector.example:4318/custom/v1/traces'),
      'disabled child does not export to inherited endpoint',
    );
    t.ok(
      !disabledOutput.includes('export:http://override-collector.example:4318/override/v1/traces'),
      'disabled child does not export to override endpoint',
    );
  });
  it('lets --otlp-endpoint override the OTEL base endpoint env var', async (t) => {
    const flagWins = await runCli(
      [
        '--otlp-endpoint',
        'http://flag-collector.example:4318/flag',
        './tests/fixtures/cli-otel-entrypoint.ts',
      ],
      { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env-collector.example:4318/env' } },
    );
    t.equal(flagWins.result.code, 0, 'flag-over-env entrypoint exits successfully');
    t.ok(
      flagWins.stdout.includes('export:http://flag-collector.example:4318/flag/v1/traces'),
      'flag endpoint wins for trace export',
    );
    t.ok(
      !flagWins.stdout.includes('env-collector.example'),
      'env base endpoint is not used when flag is present',
    );
  });
  it('applies OTEL per-signal endpoints, headers, compression, and resource env vars', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/cli-otel-entrypoint.ts'], {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env-collector.example:4318/base',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://env-collector.example:4318/custom-traces',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://env-collector.example:4318/custom-logs',
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://env-collector.example:4318/custom-metrics',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-env=one,x-other=two',
        OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
        OTEL_RESOURCE_ATTRIBUTES:
          'service.name=resource-service,deployment.environment=test,team=runtime',
        OTEL_SERVICE_NAME: 'env-service',
      },
    });
    t.equal(result.code, 0, 'env-rich entrypoint exits successfully');
    t.equal(stderr, '', 'env-rich bootstrap does not write stderr');
    t.ok(
      stdout.includes('export:http://env-collector.example:4318/custom-traces'),
      'trace endpoint override used',
    );
    t.ok(
      stdout.includes('export:http://env-collector.example:4318/custom-logs'),
      'log endpoint override used',
    );
    t.ok(
      stdout.includes('export:http://env-collector.example:4318/custom-metrics'),
      'metric endpoint override used',
    );
    t.ok(stdout.includes('"service.name"'), 'resource includes service.name');
    t.ok(stdout.includes('"env-service"'), 'OTEL_SERVICE_NAME overrides resource service.name');
    t.ok(
      stdout.includes('"deployment.environment"'),
      'resource attributes include deployment environment',
    );
    t.ok(stdout.includes('"team"'), 'resource attributes include custom team');
    t.ok(stdout.includes('x-env'), 'OTEL exporter headers are applied');
    t.ok(stdout.includes('content-encoding'), 'OTEL compression header is applied');
    t.ok(stdout.includes('gzip'), 'gzip compression is selected');
  });
  it('respects OTEL_SDK_DISABLED for env-only bootstrap', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/cli-otel-entrypoint.ts'], {
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://env-collector.example:4318/env',
        OTEL_SDK_DISABLED: 'true',
      },
    });
    t.equal(result.code, 0, 'disabled SDK entrypoint exits successfully');
    t.equal(stderr, '', 'disabled SDK bootstrap does not write stderr');
    t.ok(
      !stdout.includes('export:http://env-collector.example:4318/env/v1/traces'),
      'disabled SDK suppresses trace export',
    );
    t.ok(
      !stdout.includes('export:http://env-collector.example:4318/env/v1/logs'),
      'disabled SDK suppresses log export',
    );
    t.ok(
      !stdout.includes('export:http://env-collector.example:4318/env/v1/metrics'),
      'disabled SDK suppresses metric export',
    );
  });
  it('keeps OTEL providers active for async work after entrypoint import', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-async.ts',
    ]);
    t.equal(result.code, 0, 'async OTEL script exits successfully');
    t.equal(stderr, '', 'async OTEL bootstrap does not write stderr');
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/traces'),
      'async span export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/logs'),
      'async log export targets the configured endpoint',
    );
    t.ok(
      stdout.includes('http://collector.example:4318/custom/v1/metrics'),
      'async metric export targets the configured endpoint',
    );
  });
  it('flushes trace exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-trace.ts', 'traces', 'trace');
  });
  it('flushes log exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-log.ts', 'logs', 'log');
  });
  it('flushes metric exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-metric.ts', 'metrics', 'metric');
  });
  it('reports OTEL exporter failures to stderr', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-error.ts',
    ]);
    t.equal(result.code, 0, 'script still exits successfully when OTEL export fails');
    t.equal(stdout, '', 'failing collector fixture does not write stdout');
    t.ok(
      stderr.includes(
        '[otel] export to http://collector.example:4318/custom failed: collector offline',
      ),
      'collector failure is reported to stderr',
    );
  });
  it('can print OTEL request and response details through FINO_OTEL_DEBUG', async (t) => {
    const { stdout, stderr, result } = await runCli(
      [
        '--otlp-endpoint',
        'http://collector.example:4318/custom',
        './tests/fixtures/cli-otel-entrypoint.ts',
      ],
      { env: { FINO_OTEL_DEBUG: '1' } },
    );
    t.equal(result.code, 0, 'debug OTEL script exits successfully');
    t.ok(
      stdout.includes('export:http://collector.example:4318/custom/v1/traces'),
      'debug fixture still exports traces',
    );
    t.ok(
      stderr.includes('[otel] request traces POST http://collector.example:4318/custom/v1/traces'),
      'debug output includes request metadata',
    );
    t.ok(
      stderr.includes('[otel] response traces 200 http://collector.example:4318/custom/v1/traces'),
      'debug output includes response metadata',
    );
    t.ok(stderr.includes('\\"service.name\\"'), 'debug output includes the JSON request body');
    t.ok(
      stderr.includes('\\"resourceSpans\\"'),
      'debug output includes OTLP trace payload structure',
    );
  });
});
