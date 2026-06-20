/**
 * Tests for the fino CLI command tree defined by js/internal/main.mts.
 */

import { describe, it } from 'fino:test/test';
import type { Assert } from 'fino:test/assert';
import { Process, env, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import * as loop from 'internal:runtime/loop';

const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);

async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  return decodeUtf8(chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
    const merged = new Uint8Array(acc.byteLength + c.byteLength);
    merged.set(acc);
    merged.set(c, acc.byteLength);
    return merged;
  }, new Uint8Array(0)));
}

async function runCli(args: string[], options: { env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<Process['wait']>> }> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...env, ...(options.env || {}) })) {
    if (value !== undefined) childEnv[key] = value;
  }
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
  return { stdout, stderr, result };
}

async function mkdirp(fs: DiskFileSystem, path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let current = path.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? '/' + part : current + '/' + part;
    try { await fs.mkdir(current); } catch { /* already exists */ }
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

async function withTempProject<T>(tree: Record<string, string>, fn: (dir: string, fs: DiskFileSystem) => Promise<T>): Promise<T> {
  const fs = new DiskFileSystem();
  const dir = '/tmp/fino-tooling-cli-' + Math.floor(Math.random() * 1_000_000_000);
  await fs.mkdir(dir);
  try {
    for (const [rel, content] of Object.entries(tree)) {
      const path = dir + '/' + rel;
      const slash = path.lastIndexOf('/');
      if (slash > dir.length) await mkdirp(fs, path.slice(0, slash));
      await fs.writeFile(path, content);
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

async function expectLiveOtelSignal(t: Assert, fixture: string, path: string, label: string): Promise<void> {
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

describe('CLI commands', () => {
  it('prints root help with command list', async (t) => {
    const { stdout, stderr, result } = await runCli(['--help']);

    t.equal(result.code, 0, 'help exits successfully');
    t.equal(stderr, '', 'no stderr for help');
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
  });

  it('runs a script through the root command', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/cli-script.mts']);

    t.equal(result.code, 0, 'script exits successfully');
    t.equal(stderr, '', 'script does not write stderr');
    t.ok(stdout.includes('cli fixture ran'), 'script was imported and executed');
  });

  it('keeps the root runtime alive until Atomics.waitAsync settles', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/atomics-waitasync-keepalive.mts']);

    t.equal(result.code, 0, 'waitAsync fixture exits successfully');
    t.equal(stderr, '', 'waitAsync fixture does not write stderr');
    t.ok(stdout.includes('waitAsync:ok:1'), 'waitAsync settled after async notification');
  });

  it('reports shutdown hook failure when the script succeeds', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/shutdown-hook-fails.mts']);

    t.equal(result.code, 1, 'shutdown-only failure exits nonzero');
    t.ok(stdout.includes('script completed'), 'script completed before shutdown failed');
    t.ok(stderr.includes('shutdown hook failed'), 'stderr reports hook failure');
  });

  it('keeps the script failure primary when shutdown also fails', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/script-and-shutdown-fail.mts']);

    t.equal(result.code, 1, 'script failure exits nonzero');
    t.equal(stdout, '', 'failing script does not write stdout');
    t.ok(stderr.includes('primary script failure'), 'stderr reports primary script failure');
    t.ok(!stderr.includes('secondary shutdown failure'), 'shutdown failure does not replace script failure');
  });

  it('runs a script through the run command', async (t) => {
    const { stdout, stderr, result } = await runCli(['run', './tests/fixtures/cli-script.mts']);

    t.equal(result.code, 0, 'run command script exits successfully');
    t.equal(stderr, '', 'run command script does not write stderr');
    t.ok(stdout.includes('cli fixture ran'), 'run command imported and executed the script');
  });

  it('exposes root script arguments through process argv after --', async (t) => {
    await withTempProject({
      'argv.mts': [
        "import { argv } from 'fino:process';",
        "console.log(JSON.stringify(argv.slice(1)));",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['argv.mts', '--', '--user-flag', 'value'], { cwd: dir });

      t.equal(result.code, 0, 'root script with -- args exits successfully');
      t.equal(stderr, '', 'root script with -- args does not write stderr');
      t.ok(stdout.includes('["argv.mts","--","--user-flag","value"]'), 'argv preserves script and user arguments');
    });
  });

  it('exposes run command script arguments through process argv after --', async (t) => {
    await withTempProject({
      'argv.mts': [
        "import { argv } from 'fino:process';",
        "console.log(JSON.stringify(argv.slice(1)));",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['run', 'argv.mts', '--', '--user-flag', 'value'], { cwd: dir });

      t.equal(result.code, 0, 'run script with -- args exits successfully');
      t.equal(stderr, '', 'run script with -- args does not write stderr');
      t.ok(stdout.includes('["run","argv.mts","--","--user-flag","value"]'), 'argv preserves run command, script, and user arguments');
    });
  });

  it('prints focused help for each subcommand', async (t) => {
    const commands = ['run', 'test', 'bench', 'install', 'init', 'doc', 'fmt', 'lint', 'repl'];

    for (const command of commands) {
      const { stdout, stderr, result } = await runCli([command, '--help']);
      t.equal(result.code, 0, `${command} --help exits successfully`);
      t.equal(stderr, '', `${command} --help does not write stderr`);
      t.ok(stdout.includes(`Usage: fino ${command}`), `${command} --help includes command usage`);
    }
  });

  it('reports a missing script for run without arguments', async (t) => {
    const { stdout, stderr, result } = await runCli(['run']);

    t.equal(result.code, 1, 'run without a script exits nonzero');
    t.equal(stdout, '', 'run without a script does not write stdout');
    t.ok(stderr.includes('script'), 'run without a script reports the missing script positional');
  });

  it('reports module resolution failures for missing root, test, and bench inputs', async (t) => {
    await withTempProject({}, async (dir) => {
      for (const [label, args] of [
        ['root script fallback', ['missing-entry.mts']],
        ['test input', ['test', 'missing.test.mts']],
        ['bench input', ['bench', 'missing.bench.mts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runCli(args, {
          cwd: dir,
          env: { FINO_BENCH_MIN_NS: '1000' },
        });

        t.equal(result.code, 1, `${label} exits nonzero`);
        t.equal(stdout, '', `${label} does not write stdout`);
        t.ok(stderr.includes('Cannot resolve module'), `${label} reports module resolution failure`);
      }
    });
  });

  it('does not expand run command directory or glob inputs', async (t) => {
    await withTempProject({
      'scripts/entry.mts': "console.log('should-not-run');\n",
    }, async (dir) => {
      for (const [label, args] of [
        ['directory input', ['run', 'scripts']],
        ['glob input', ['run', 'scripts/*.mts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runCli(args, { cwd: dir });

        t.equal(result.code, 1, `${label} exits nonzero`);
        t.equal(stdout, '', `${label} does not import discovered scripts`);
        t.ok(stderr.length > 0, `${label} reports the unresolved module specifier`);
        t.ok(!stderr.includes('should-not-run'), `${label} does not execute nested files`);
      }
    });
  });

  it('reruns run --watch when an imported module changes', async (t) => {
    await withTempProject({
      'state.mts': 'export const value = 1;\n',
      'entry.mts': [
        "import { value } from './state.mts';",
        "console.log('watch value:' + value);",
        '',
      ].join('\n'),
    }, async (dir, fs) => {
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) childEnv[key] = value;
      }

      const proc = new Process(execPath, ['run', '--watch', 'entry.mts'], { cwd: dir, env: childEnv });
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
        await poll(() => stdoutChunks.join('').includes('watch value:1'), 3000);
        await loop.timeout(300);
        await fs.writeFile(dir + '/state.mts', 'export const value = 2;\n');
        await poll(() => stdoutChunks.join('').includes('watch value:2'), 5000);
      } finally {
        proc.kill();
      }

      const result = await proc.wait();
      await Promise.all([stdoutDone, stderrDone]);

      t.ok(result.signal !== null || result.code === 0, 'watch child terminates after SIGTERM');
      t.equal(stderrChunks.join(''), '', 'run --watch does not write stderr');
    });
  });

  it('fmt --check reports changed files without writing', async (t) => {
    await withTempProject({
      'src/app.ts': 'const value = "hello";\nif (value) { console.log(value); }\n',
    }, async (dir, fs) => {
      const before = await fs.readFile(dir + '/src/app.ts');
      const { stdout, stderr, result } = await runCli(['fmt', '--check'], { cwd: dir });
      const after = await fs.readFile(dir + '/src/app.ts');

      t.equal(result.code, 1, 'fmt --check exits nonzero when files would change');
      t.equal(stdout, '', 'fmt --check failure does not write stdout');
      t.ok(stderr.includes('src/app.ts would reformat'), 'fmt --check reports the changed file');
      t.equal(after, before, 'fmt --check does not write the file');
    });
  });

  it('fmt writes only changed source files', async (t) => {
    await withTempProject({
      'src/app.ts': 'const value = "hello";\nif (value) { console.log(value); }\n',
      'target/generated.ts': 'const value = "ignored";\n',
    }, async (dir, fs) => {
      const { stdout, stderr, result } = await runCli(['fmt'], { cwd: dir });
      const formatted = await fs.readFile(dir + '/src/app.ts');
      const ignored = await fs.readFile(dir + '/target/generated.ts');

      t.equal(result.code, 0, 'fmt exits successfully');
      t.equal(stderr, '', 'fmt success does not write stderr');
      t.ok(stdout.includes('formatted 1 file'), 'fmt reports changed files');
      t.equal(formatted, "const value = 'hello';\nif (value) {\n  console.log(value);\n}\n", 'fmt writes formatted source');
      t.equal(ignored, 'const value = "ignored";\n', 'fmt ignores generated output directories');
    });
  });

  it('fmt accepts explicit glob inputs', async (t) => {
    await withTempProject({
      'src/app.ts': 'const value = "hello";\n',
      'other/app.ts': 'const value = "unchanged";\n',
    }, async (dir, fs) => {
      const { stdout, stderr, result } = await runCli(['fmt', 'src/*.ts'], { cwd: dir });
      const formatted = await fs.readFile(dir + '/src/app.ts');
      const untouched = await fs.readFile(dir + '/other/app.ts');

      t.equal(result.code, 0, 'fmt exits successfully for explicit glob');
      t.equal(stderr, '', 'fmt explicit glob does not write stderr');
      t.ok(stdout.includes('formatted 1 file'), 'fmt explicit glob reports changed files');
      t.equal(formatted, "const value = 'hello';\n", 'fmt writes matched file');
      t.equal(untouched, 'const value = "unchanged";\n', 'fmt leaves unmatched source alone');
    });
  });

  it('fmt reports parse diagnostics with file locations', async (t) => {
    await withTempProject({
      'src/broken.ts': 'export function broken( {\n',
    }, async (dir) => {
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
    await withTempProject({
      'src/app.ts': 'const value = "hello";\n',
      'src/nested/view.ts': 'const view = "ok";\n',
      '.hidden/ignored.ts': 'const value = "hidden";\n',
      'build/ignored.ts': 'const value = "build";\n',
      'dist/ignored.ts': 'const value = "dist";\n',
      'target/ignored.ts': 'const value = "target";\n',
    }, async (dir, fs) => {
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
    });
  });

  it('lint reports diagnostics and lint --fix does not format', async (t) => {
    await withTempProject({
      'src/app.ts': 'debugger;\nconst value = "hello";\n',
    }, async (dir, fs) => {
      const linted = await runCli(['lint'], { cwd: dir });
      t.equal(linted.result.code, 1, 'lint exits nonzero for diagnostics');
      t.ok(linted.stderr.includes('no-debugger'), 'lint reports rule code');

      const fixed = await runCli(['lint', '--fix'], { cwd: dir });
      const after = await fs.readFile(dir + '/src/app.ts');
      t.equal(fixed.result.code, 1, 'lint --fix exits nonzero when diagnostics remain');
      t.ok(fixed.stderr.includes('fino lint: fixed 0 files, 1 remaining'), 'lint --fix reports the current no-op fixer behavior');
      t.equal(after, 'debugger;\nconst value = "hello";\n', 'lint --fix does not format or change unsupported fixes');
    });
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
    const { stdout, stderr, result } = await runCli(['test', './tests/util/topic.test.mts']);

    t.equal(result.code, 0, 'test command exits successfully');
    t.equal(stderr, '', 'test command does not write stderr');
    t.ok(stdout.includes('# pass  1'), 'test subcommand ran the requested suite');
  });

  it('does not accept the legacy --test shortcut', async (t) => {
    const { stdout, stderr, result } = await runCli(['--test', './tests/util/topic.test.mts']);

    t.equal(result.code, 1, 'legacy --test shortcut exits with an error');
    t.equal(stdout, '', 'legacy --test shortcut does not run tests');
    t.ok(stderr.includes('Unknown option "--test"'), 'legacy --test shortcut reports an unknown option');
  });

  it('accepts bare repo-relative paths in the test subcommand', async (t) => {
    const { stdout, stderr, result } = await runCli(['test', 'tests/util/topic.test.mts']);

    t.equal(result.code, 0, 'bare relative test path exits successfully');
    t.equal(stderr, '', 'bare relative test path does not write stderr');
    t.ok(stdout.includes('# pass  1'), 'bare relative test path ran the requested suite');
  });

  it('passes --filter to the test command', async (t) => {
    const { stdout, stderr, result } = await runCli(['test', '--filter', 'needle', './tests/fixtures/filter-tests.mts']);

    t.equal(result.code, 0, 'filtered test command exits successfully');
    t.equal(stderr, '', 'filtered test command does not write stderr');
    t.ok(!stdout.includes('alpha outer'), 'non-matching top-level group omitted');
    t.ok(stdout.includes('beta outer'), 'ancestor of matching nested group retained');
    t.ok(stdout.includes('needle child'), 'matching nested describe group included');
    t.ok(!stdout.includes('match leaf'), 'unmatched nested group omitted');
  });

  it('passes --show-output modes to the test command', async (t) => {
    await withTempProject({
      'output.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('noisy pass', () => console.log('stdout:pass'));",
        "test('noisy fail', () => { console.log('stdout:fail'); throw new Error('fixture failed'); });",
        '',
      ].join('\n'),
    }, async (dir) => {
      const failures = await runCli(['test', '--show-output=failures', 'output.test.mts'], { cwd: dir });
      t.equal(failures.result.code, 1, 'failures mode exits nonzero for failing test');
      t.ok(!failures.stdout.includes('stdout:pass'), 'failures mode suppresses passing output');
      t.ok(failures.stdout.includes('#   stdout:fail'), 'failures mode prints failing captured output');

      const never = await runCli(['test', '--show-output=never', 'output.test.mts'], { cwd: dir });
      t.equal(never.result.code, 1, 'never mode exits nonzero for failing test');
      t.ok(!never.stdout.includes('stdout:pass'), 'never mode suppresses passing output');
      t.ok(!never.stdout.includes('stdout:fail'), 'never mode suppresses failing captured output');

      const always = await runCli(['test', '--show-output=always', 'output.test.mts'], { cwd: dir });
      t.equal(always.result.code, 1, 'always mode exits nonzero for failing test');
      t.ok(always.stdout.includes('stdout:pass'), 'always mode streams passing output');
      t.ok(always.stdout.includes('stdout:fail'), 'always mode streams failing output');
    });
  });

  it('reports after hook failures from the test command', async (t) => {
    await withTempProject({
      'after-failure.test.mts': [
        "import { after, describe, it } from 'fino:test/test';",
        "describe('cli after failure', () => {",
        "  after(() => { console.log('after:output'); throw new Error('after failed'); });",
        "  it('passes body', (t) => t.ok(true));",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'after-failure.test.mts'], { cwd: dir });

      t.equal(result.code, 1, 'after hook failure exits nonzero');
      t.ok(stderr.includes('[error] Error: 1 test(s) failed'), 'test command writes failure summary to stderr');
      t.ok(stdout.includes('ok 1 - passes body'), 'passing body is still reported');
      t.ok(stdout.includes('not ok 1 - cli after failure'), 'parent group is marked failed');
      t.ok(stdout.includes('# 1) after hook: cli after failure'), 'after hook diagnostic title is printed');
      t.ok(stdout.includes('#   Error: after failed'), 'after hook error is printed');
      t.ok(stdout.includes('#   after:output'), 'after hook output is captured');
    });
  });

  it('expands test directories in the test command', async (t) => {
    await withTempProject({
      'tests/alpha.test.mts': [
        "import { describe, it } from 'fino:test/test';",
        "describe('alpha directory suite', () => {",
        "  describe('needle directory group', () => {",
        "    it('runs directory test', (t) => t.ok(true));",
        "  });",
        "});",
        '',
      ].join('\n'),
      'tests/nested/beta.test.mts': [
        "import { describe, it } from 'fino:test/test';",
        "describe('beta directory suite', () => {",
        "  it('runs beta test', (t) => t.ok(true));",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', '--filter', 'needle directory', 'tests'], { cwd: dir });

      t.equal(result.code, 0, 'test directory input exits successfully');
      t.equal(stderr, '', 'test directory input does not write stderr');
      t.ok(stdout.includes('alpha directory suite'), 'test directory input imports matching file');
      t.ok(stdout.includes('needle directory group'), 'test directory input runs matching group');
      t.ok(!stdout.includes('beta directory suite'), 'test directory input omits unmatched test groups');
    });
  });

  it('expands test globs in the test command', async (t) => {
    await withTempProject({
      'tests/alpha.test.mts': [
        "import { describe, it } from 'fino:test/test';",
        "describe('alpha glob suite', () => {",
        "  describe('needle glob group', () => {",
        "    it('runs glob test', (t) => t.ok(true));",
        "  });",
        "});",
        '',
      ].join('\n'),
      'tests/nested/beta.test.mts': [
        "import { describe, it } from 'fino:test/test';",
        "describe('beta glob suite', () => {",
        "  it('runs beta test', (t) => t.ok(true));",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', '--filter', 'needle glob', 'tests/**/*.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'test glob input exits successfully');
      t.equal(stderr, '', 'test glob input does not write stderr');
      t.ok(stdout.includes('alpha glob suite'), 'test glob input imports matching file');
      t.ok(stdout.includes('needle glob group'), 'test glob input runs matching group');
      t.ok(!stdout.includes('beta glob suite'), 'test glob input omits unmatched test groups');
    });
  });

  it('fails when expanded test inputs match no files', async (t) => {
    await withTempProject({}, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'tests'], { cwd: dir });

      t.equal(result.code, 1, 'empty test directory expansion exits with an error');
      t.equal(stdout, '', 'empty test expansion does not run the TAP runner');
      t.ok(stderr.includes('fino test: no test files matched'), 'empty test expansion reports no matched files');
    });
  });

  it('passes --filter to the bench command', async (t) => {
    const { stdout, stderr, result } = await runCli(['bench', '--filter', 'needle', './tests/fixtures/filter-bench.mts'], {
      env: { FINO_BENCH_MIN_NS: '1000' },
    });

    t.equal(result.code, 0, 'filtered bench command exits successfully');
    t.equal(stderr, '', 'filtered bench command does not write stderr');
    t.ok(!stdout.includes('# alpha bench'), 'non-matching suite omitted');
    t.ok(stdout.includes('# beta bench'), 'ancestor suite of matching nested group retained');
    t.ok(stdout.includes('# needle group'), 'matching nested benchmark group included');
    t.ok(!stdout.includes('other group'), 'unmatched nested benchmark group omitted');
  });

  it('prints human benchmark output without JSON results', async (t) => {
    await withTempProject({
      'benchmarks/human.bench.mts': [
        "import { bench } from 'fino:bench';",
        "bench('human output bench', (b) => {",
        "  b.measure('first measure', () => 1);",
        "  b.measure('second measure', () => 2);",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['bench', 'benchmarks/human.bench.mts'], {
        cwd: dir,
        env: { FINO_BENCH_MIN_NS: '1000' },
      });

      t.equal(result.code, 0, 'human benchmark exits successfully');
      t.equal(stderr, '', 'human benchmark does not write stderr');
      t.ok(stdout.startsWith('benc.h v1.0.0\n'), 'bench command prints benc.h header');
      t.ok(stdout.includes('# human output bench'), 'bench command prints suite heading');
      t.ok(/first measure - .+ i\/s /.test(stdout), 'bench command prints human measurement line');
      t.ok(stdout.includes('Comparing...'), 'bench command prints human comparison text');
      t.ok(!stdout.split('\n').some((line) => line.trim().startsWith('{') || line.trim().startsWith('[')), 'bench command does not emit JSON lines');
    });
  });

  it('expands benchmark directories in the bench command', async (t) => {
    await withTempProject({
      'benchmarks/alpha.bench.mts': [
        "import { bench } from 'fino:bench';",
        "bench('alpha directory bench', (b) => {",
        "  b.group('needle directory group', (g) => {",
        "    g.measure('directory measure', () => 1);",
        "  });",
        "});",
        '',
      ].join('\n'),
      'benchmarks/nested/beta.bench.mts': [
        "import { bench } from 'fino:bench';",
        "bench('beta directory bench', (b) => {",
        "  b.measure('beta measure', () => 2);",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['bench', '--filter', 'needle directory', 'benchmarks'], {
        cwd: dir,
        env: { FINO_BENCH_MIN_NS: '1000' },
      });

      t.equal(result.code, 0, 'bench directory input exits successfully');
      t.equal(stderr, '', 'bench directory input does not write stderr');
      t.ok(stdout.includes('# alpha directory bench'), 'bench directory input imports matching file');
      t.ok(stdout.includes('# needle directory group'), 'bench directory input runs matching group');
      t.ok(!stdout.includes('# beta directory bench'), 'bench directory input omits unmatched benchmark groups');
    });
  });

  it('expands benchmark globs in the bench command', async (t) => {
    await withTempProject({
      'benchmarks/alpha.bench.mts': [
        "import { bench } from 'fino:bench';",
        "bench('alpha glob bench', (b) => {",
        "  b.group('needle glob group', (g) => {",
        "    g.measure('glob measure', () => 1);",
        "  });",
        "});",
        '',
      ].join('\n'),
      'benchmarks/nested/beta.bench.mts': [
        "import { bench } from 'fino:bench';",
        "bench('beta glob bench', (b) => {",
        "  b.measure('beta measure', () => 2);",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['bench', '--filter', 'needle glob', 'benchmarks/**/*.bench.mts'], {
        cwd: dir,
        env: { FINO_BENCH_MIN_NS: '1000' },
      });

      t.equal(result.code, 0, 'bench glob input exits successfully');
      t.equal(stderr, '', 'bench glob input does not write stderr');
      t.ok(stdout.includes('# alpha glob bench'), 'bench glob input imports matching file');
      t.ok(stdout.includes('# needle glob group'), 'bench glob input runs matching group');
      t.ok(!stdout.includes('# beta glob bench'), 'bench glob input omits unmatched benchmark groups');
    });
  });

  it('fails when expanded benchmark inputs match no files', async (t) => {
    await withTempProject({}, async (dir) => {
      for (const [label, args] of [
        ['empty benchmark directory', ['bench', 'benchmarks']],
        ['empty benchmark glob', ['bench', 'benchmarks/**/*.bench.mts']],
      ] as [string, string[]][]) {
        const { stdout, stderr, result } = await runCli(args, {
          cwd: dir,
          env: { FINO_BENCH_MIN_NS: '1000' },
        });

        t.equal(result.code, 1, `${label} exits with an error`);
        t.equal(stdout, '', `${label} does not run the benchmark runner`);
        t.ok(stderr.includes('fino bench: no benchmark files matched'), `${label} reports no matched files`);
      }
    });
  });

  it('runs async benchmarks and setup/teardown in order', async (t) => {
    await withTempProject({
      'benchmarks/async.bench.mts': [
        "import { bench } from 'fino:bench';",
        "let logged = false;",
        "bench('async fixture bench', (b) => {",
        "  b.measure('async measure', {",
        "    setup() { return { value: 41 }; },",
        "    async fn(ctx) { if (!logged) { console.log('fn:' + ctx.value); logged = true; } await Promise.resolve(); },",
        "    teardown(ctx) { console.log('teardown:' + ctx.value); },",
        "  });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['bench', 'benchmarks/async.bench.mts'], {
        cwd: dir,
        env: { FINO_BENCH_MIN_NS: '1000' },
      });

      t.equal(result.code, 0, 'async bench exits successfully');
      t.equal(stderr, '', 'async bench does not write stderr');
      t.ok(stdout.includes('async measure'), 'async measure ran');
      t.ok(stdout.includes('fn:41'), 'async measured function received setup context');
      t.ok(stdout.includes('teardown:41'), 'teardown ran after async measurement');
    });
  });

  it('runs benchmark teardown when the measured function throws', async (t) => {
    await withTempProject({
      'benchmarks/failing.bench.mts': [
        "import { bench } from 'fino:bench';",
        "bench('failing fixture bench', (b) => {",
        "  b.measure('throws measure', {",
        "    setup() { return 'ctx'; },",
        "    fn() { throw new Error('measured failure'); },",
        "    teardown(ctx) { console.log('teardown:' + ctx); },",
        "  });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['bench', 'benchmarks/failing.bench.mts'], {
        cwd: dir,
        env: { FINO_BENCH_MIN_NS: '1000' },
      });

      t.equal(result.code, 1, 'failing benchmark exits nonzero');
      t.equal(stdout.includes('throws measure'), false, 'failed measurement is not reported as completed');
      t.ok(stdout.includes('teardown:ctx'), 'teardown ran after measurement failure');
      t.ok(stderr.includes('measured failure'), 'stderr reports measured failure');
    });
  });

  it('prints mapped ts locations to stderr', async (t) => {
    const { stdout, stderr, result } = await runCli(['./tests/fixtures/source-map-cli.mts']);

    t.equal(result.code, 0, 'script exits successfully after printing the error');
    t.equal(stdout, '', 'failing script does not write stdout');
    t.ok(stderr.includes('source-map-throw.ts:18'), 'stderr points at original ts line');
  });

  it('boots OTEL export for the root script and its dependencies', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-script.mts',
    ]);

    t.equal(result.code, 0, 'script exits successfully with OTEL enabled');
    t.equal(stderr, '', 'OTEL bootstrap does not write stderr');
    t.ok(stdout.includes('entry providers ready'), 'entry script sees OTEL providers');
    t.ok(stdout.includes('dependency providers ready'), 'dependency import sees OTEL providers');
    t.ok(stdout.includes('http://collector.example:4318/custom/v1/traces'), 'trace export targets the configured endpoint');
    t.ok(stdout.includes('http://collector.example:4318/custom/v1/logs'), 'log export targets the configured endpoint');
    t.ok(stdout.includes('http://collector.example:4318/custom/v1/metrics'), 'metric export targets the configured endpoint');
    t.ok(stdout.includes('application/json'), 'OTEL bootstrap uses JSON content type');
    t.ok(stdout.includes('"resourceSpans"'), 'trace export uses OTLP JSON structure');
    t.ok(stdout.includes('"resourceLogs"'), 'log export uses OTLP JSON structure');
    t.ok(stdout.includes('"resourceMetrics"'), 'metric export uses OTLP JSON structure');
  });

  it('uses --otlp-endpoint to bootstrap the entrypoint SDK', async (t) => {
    const disabled = await runCli(['./tests/fixtures/cli-otel-entrypoint.mts']);
    t.equal(disabled.result.code, 0, 'entrypoint fixture exits successfully without OTEL bootstrap');
    t.equal(disabled.stderr, '', 'entrypoint fixture without OTEL bootstrap does not write stderr');
    t.ok(!disabled.stdout.includes('export:http://collector.example:4318/custom/v1/traces'), 'trace export is not active without --otlp-endpoint');
    t.ok(!disabled.stdout.includes('export:http://collector.example:4318/custom/v1/logs'), 'log export is not active without --otlp-endpoint');
    t.ok(!disabled.stdout.includes('export:http://collector.example:4318/custom/v1/metrics'), 'metric export is not active without --otlp-endpoint');

    const enabled = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-entrypoint.mts',
    ]);
    t.equal(enabled.result.code, 0, 'entrypoint fixture exits successfully with OTEL bootstrap');
    t.equal(enabled.stderr, '', 'entrypoint fixture with OTEL bootstrap does not write stderr');
    t.ok(enabled.stdout.includes('export:http://collector.example:4318/custom/v1/traces'), 'trace export is active with --otlp-endpoint');
    t.ok(enabled.stdout.includes('export:http://collector.example:4318/custom/v1/logs'), 'log export is active with --otlp-endpoint');
    t.ok(enabled.stdout.includes('export:http://collector.example:4318/custom/v1/metrics'), 'metric export is active with --otlp-endpoint');
    t.ok(enabled.stdout.includes('"service.name"'), 'entrypoint export includes service.name resource metadata');
    t.ok(enabled.stdout.includes('"fino"'), 'entrypoint export uses package.json service.name');
    t.ok(enabled.stdout.includes('"service.version"'), 'entrypoint export includes package version resource metadata');
    t.ok(enabled.stdout.includes('"1.0.0"'), 'entrypoint export includes package.json version');
    t.ok(enabled.stdout.includes('"telemetry.sdk.name"'), 'entrypoint export includes telemetry SDK metadata');
    t.ok(!enabled.stdout.includes('POST http://collector.example:4318/custom/v1/traces'), 'exporter requests do not generate fetch client spans');
    t.ok(!enabled.stdout.includes('"scope":{"name":"fetch"}'), 'exporter requests do not emit fetch scope spans');
    t.ok(!enabled.stdout.includes('"scope":{"name":"dns"}'), 'exporter requests do not emit dns scope spans');
    t.ok(!enabled.stdout.includes('"scope":{"name":"socket"}'), 'exporter requests do not emit socket scope spans');
  });

  it('keeps OTEL providers active for async work after entrypoint import', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-async.mts',
    ]);

    t.equal(result.code, 0, 'async OTEL script exits successfully');
    t.equal(stderr, '', 'async OTEL bootstrap does not write stderr');
    t.ok(stdout.includes('http://collector.example:4318/custom/v1/traces'), 'async span export targets the configured endpoint');
    t.ok(stdout.includes('http://collector.example:4318/custom/v1/logs'), 'async log export targets the configured endpoint');
    t.ok(stdout.includes('http://collector.example:4318/custom/v1/metrics'), 'async metric export targets the configured endpoint');
  });

  it('flushes trace exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-trace.mts', 'traces', 'trace');
  });

  it('flushes log exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-log.mts', 'logs', 'log');
  });

  it('flushes metric exports while the process is still running', async (t) => {
    await expectLiveOtelSignal(t, './tests/fixtures/cli-otel-live-metric.mts', 'metrics', 'metric');
  });

  it('reports OTEL exporter failures to stderr', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-error.mts',
    ]);

    t.equal(result.code, 0, 'script still exits successfully when OTEL export fails');
    t.equal(stdout, '', 'failing collector fixture does not write stdout');
    t.ok(stderr.includes('[otel] export to http://collector.example:4318/custom failed: collector offline'), 'collector failure is reported to stderr');
  });

  it('can print OTEL request and response details through FINO_OTEL_DEBUG', async (t) => {
    const { stdout, stderr, result } = await runCli([
      '--otlp-endpoint',
      'http://collector.example:4318/custom',
      './tests/fixtures/cli-otel-entrypoint.mts',
    ], {
      env: { FINO_OTEL_DEBUG: '1' },
    });

    t.equal(result.code, 0, 'debug OTEL script exits successfully');
    t.ok(stdout.includes('export:http://collector.example:4318/custom/v1/traces'), 'debug fixture still exports traces');
    t.ok(stderr.includes('[otel] request traces POST http://collector.example:4318/custom/v1/traces'), 'debug output includes request metadata');
    t.ok(stderr.includes('[otel] response traces 200 http://collector.example:4318/custom/v1/traces'), 'debug output includes response metadata');
    t.ok(stderr.includes('\\"service.name\\"'), 'debug output includes the JSON request body');
    t.ok(stderr.includes('\\"resourceSpans\\"'), 'debug output includes OTLP trace payload structure');
  });
});
