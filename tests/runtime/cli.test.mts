/**
 * Tests for the fino CLI command tree defined by js/internal/main.mts.
 */

import { describe, it } from 'fino:test/test';
import type { Assert } from 'fino:test/assert';
import { Process, env, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

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

  it('runs a script through the run command', async (t) => {
    const { stdout, stderr, result } = await runCli(['run', './tests/fixtures/cli-script.mts']);

    t.equal(result.code, 0, 'run command script exits successfully');
    t.equal(stderr, '', 'run command script does not write stderr');
    t.ok(stdout.includes('cli fixture ran'), 'run command imported and executed the script');
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

  it('passes --filter to the bench command', async (t) => {
    const { stdout, stderr, result } = await runCli(['bench', '--filter', 'needle', './tests/fixtures/filter-bench.mts']);

    t.equal(result.code, 0, 'filtered bench command exits successfully');
    t.equal(stderr, '', 'filtered bench command does not write stderr');
    t.ok(!stdout.includes('# alpha bench'), 'non-matching suite omitted');
    t.ok(stdout.includes('# beta bench'), 'ancestor suite of matching nested group retained');
    t.ok(stdout.includes('# needle group'), 'matching nested benchmark group included');
    t.ok(!stdout.includes('other group'), 'unmatched nested benchmark group omitted');
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
