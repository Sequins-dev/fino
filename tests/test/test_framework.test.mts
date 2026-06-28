/**
 * Tests for fino:test — the TAP test framework itself.
 * Tests the framework's assertion helpers and async test support.
 */

import { describe, it } from 'fino:test/test';
import { Process, env, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);

async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeUtf8(merged);
}

async function runCli(args: string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<Process['wait']>> }> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  const proc = new Process(execPath, args, { env: childEnv, cwd: options.cwd });
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

async function withTempProject<T>(tree: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const fs = new DiskFileSystem();
  const dir = '/tmp/fino-test-framework-' + Math.floor(Math.random() * 1_000_000_000);
  await fs.mkdir(dir);
  try {
    for (const [rel, content] of Object.entries(tree)) {
      const path = dir + '/' + rel;
      const slash = path.lastIndexOf('/');
      if (slash > dir.length) await mkdirp(fs, path.slice(0, slash));
      await fs.writeFile(path, content);
    }
    return await fn(dir);
  } finally {
    await rmrf(fs, dir);
  }
}

describe('assertion helpers', () => {
  it('t.ok — truthy values', (t) => {
    t.ok(true, 'true');
    t.ok(1, 'number 1');
    t.ok('x', 'non-empty string');
    t.ok({}, 'object');
  });

  it('t.notOk — falsy values', (t) => {
    t.notOk(false, 'false');
    t.notOk(0, 'zero');
    t.notOk('', 'empty string');
    t.notOk(null, 'null');
    t.notOk(undefined, 'undefined');
  });

  it('t.equal — strict equality', (t) => {
    t.equal(1 + 1, 2);
    t.equal('hello', 'hello');
    t.equal(null, null);
  });

  it('t.notEqual — strict inequality', (t) => {
    t.notEqual(1, 2);
    t.notEqual('a', 'b');
  });

  it('t.deepEqual — plain objects', (t) => {
    t.deepEqual({ a: 1 }, { a: 1 });
    t.deepEqual([1, 2, 3], [1, 2, 3]);
    t.deepEqual({ x: { y: 2 } }, { x: { y: 2 } });
  });

  it('t.throws — sync exception', (t) => {
    t.throws(() => { throw new Error('boom'); }, null, 'does throw');
    t.throws(
      () => { throw new TypeError('type'); },
      (e) => e instanceof TypeError,
      'threw TypeError',
    );
  });
});

describe('async tests', () => {
  it('async test with Promise.resolve', async (t) => {
    const v = await Promise.resolve(42);
    t.equal(v, 42, 'resolved value');
  });

  it('async test with cascading awaits', async (t) => {
    const a = await Promise.resolve('a');
    const b = await Promise.resolve('b');
    const c = await Promise.resolve('c');
    t.equal(a + b + c, 'abc', 'cascading awaits work');
  });

  it('async test with Promise.all', async (t) => {
    const results = await Promise.all([
      Promise.resolve(1),
      Promise.resolve(2),
      Promise.resolve(3),
    ]);
    t.deepEqual(results, [1, 2, 3], 'Promise.all resolves all');
  });
});

describe('t.rejects', () => {
  it('t.rejects — async function that rejects', async (t) => {
    await t.rejects(async () => { throw new Error('boom'); }, null, 'does reject');
  });

  it('t.rejects — checks rejection value', async (t) => {
    await t.rejects(
      async () => { throw new TypeError('type error'); },
      (e) => e instanceof TypeError,
      'rejected with TypeError',
    );
  });

  it('t.rejects — rejected promise', async (t) => {
    await t.rejects(() => Promise.reject(new RangeError('out')), null, 'promise rejection');
  });
});

describe('runner behavior', () => {
  it('emits per-test metadata on passing leaves', async (t) => {
    await withTempProject({
      'meta-pass.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('metadata pass', (t) => {",
        "  t.meta({ case: 'empty', rows: 0, nullable: null, missing: undefined, ready: true, count: 2n });",
        "  t.ok(true);",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'meta-pass.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'metadata fixture exits successfully');
      t.equal(stderr, '', 'metadata fixture does not write stderr');
      t.ok(stdout.includes('ok 1 - metadata pass # case=empty, rows=0, nullable=null, missing=undefined, ready=true, count=2'), 'passing leaf includes metadata');
    });
  });

  it('emits per-test metadata on failing leaves', async (t) => {
    await withTempProject({
      'meta-fail.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('metadata fail', (t) => {",
        "  t.meta({ case: 'bad' });",
        "  t.equal(1, 2, 'different');",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'meta-fail.test.mts'], { cwd: dir });

      t.equal(result.code, 1, 'failing metadata fixture exits nonzero');
      t.ok(stdout.includes('not ok 1 - metadata fail # case=bad'), 'failing leaf includes metadata');
    });
  });

  it('merges repeated metadata calls and overwrites older keys', async (t) => {
    await withTempProject({
      'meta-merge.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('metadata merge', (t) => {",
        "  t.meta({ case: 'first', rows: 1 });",
        "  t.meta({ case: 'second', done: false });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'meta-merge.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'merged metadata fixture exits successfully');
      t.ok(stdout.includes('ok 1 - metadata merge # case=second, rows=1, done=false'), 'later metadata overwrites existing keys');
    });
  });

  it('quotes unsafe string metadata values', async (t) => {
    await withTempProject({
      'meta-quote.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('metadata quote', (t) => {",
        "  t.meta({ simple: 'alpha', spaced: 'two words', comma: 'a,b', quoted: 'say \"hi\"', hash: 'a#b' });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'meta-quote.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'quoted metadata fixture exits successfully');
      t.ok(stdout.includes('ok 1 - metadata quote # simple=alpha, spaced="two words", comma="a,b", quoted="say \\"hi\\"", hash="a#b"'), 'unsafe strings are JSON quoted');
    });
  });

  it('leaves TAP output unchanged when metadata is absent', async (t) => {
    await withTempProject({
      'no-meta.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('plain pass', (t) => t.ok(true));",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'no-meta.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'plain fixture exits successfully');
      t.ok(stdout.includes('ok 1 - plain pass\n'), 'plain result has no metadata comment');
      t.ok(!stdout.includes('ok 1 - plain pass #'), 'plain result has no trailing metadata segment');
    });
  });

  it('keeps metadata off standalone Assert instances', async (t) => {
    await withTempProject({
      'assert-meta.test.mts': [
        "import { test } from 'fino:test/test';",
        "import { Assert } from 'fino:test/assert';",
        "test('standalone assert', (t) => {",
        "  t.equal(typeof new Assert().meta, 'undefined');",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'assert-meta.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'standalone assert fixture exits successfully');
      t.ok(stdout.includes('ok 1 - standalone assert'), 'standalone Assert has no meta method');
    });
  });

  it('rejects invalid metadata keys', async (t) => {
    await withTempProject({
      'meta-invalid.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('invalid metadata', (t) => {",
        "  t.meta({ 'bad key': 'value' });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'meta-invalid.test.mts'], { cwd: dir });

      t.equal(result.code, 1, 'invalid metadata fixture exits nonzero');
      t.ok(stdout.includes('not ok 1 - invalid metadata'), 'invalid metadata fails the leaf');
      t.ok(stdout.includes('TypeError: Invalid test metadata key "bad key"'), 'invalid metadata reports TypeError');
    });
  });

  it('emits TAP output for passing files', async (t) => {
    await withTempProject({
      'tap.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('top leaf', (t) => t.ok(true));",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'tap.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'passing fixture exits successfully');
      t.equal(stderr, '', 'passing fixture does not write stderr');
      t.ok(stdout.startsWith('TAP version 13\n'), 'TAP header is first');
      t.ok(stdout.includes('1..1'), 'TAP plan is printed');
      t.ok(stdout.includes('ok 1 - top leaf'), 'passing top-level test is reported');
      t.ok(stdout.includes('# pass  1'), 'summary reports one pass');
      t.ok(/# time  \d+(?:\.\d+)?ms\b/.test(stdout), 'summary reports total runtime');
    });
  });

  it('suppresses console output from passing tests by default', async (t) => {
    await withTempProject({
      'quiet-pass.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('quiet pass', () => {",
        "  console.log('stdout:passing');",
        "  console.error('stderr:passing');",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'quiet-pass.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'passing fixture exits successfully');
      t.equal(stderr, '', 'captured stderr is not written for passing tests');
      t.ok(stdout.includes('ok 1 - quiet pass'), 'passing test is reported');
      t.ok(!stdout.includes('stdout:passing'), 'passing stdout is suppressed');
      t.ok(!stdout.includes('stderr:passing'), 'passing stderr is suppressed');
      t.ok(!stdout.includes('# Failure details'), 'success output has no failure details section');
    });
  });

  it('prints captured stdout and stderr with failing test details', async (t) => {
    await withTempProject({
      'quiet-fail.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('noisy failure', () => {",
        "  console.log('stdout:first');",
        "  console.warn('stderr:warn');",
        "  console.error('stderr:error');",
        "  throw new Error('body failed');",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'quiet-fail.test.mts'], { cwd: dir });
      const failureLine = stdout.indexOf('not ok 1 - noisy failure');
      const details = stdout.indexOf('# Failure details');
      const capturedStdout = stdout.indexOf('# Captured stdout:');
      const capturedStderr = stdout.indexOf('# Captured stderr:');

      t.equal(result.code, 1, 'failing fixture exits nonzero');
      t.ok(stderr.includes('[error] Error: 1 test(s) failed'), 'command failure summary is still written to stderr');
      t.ok(!stderr.includes('stderr:warn'), 'captured warning is not written live to stderr');
      t.ok(!stderr.includes('stderr:error'), 'captured error is not written live to stderr');
      t.ok(failureLine >= 0, 'failing test is reported inline');
      t.ok(details > failureLine, 'failure details are printed at the end');
      t.ok(stdout.includes('# 1) noisy failure'), 'failure details include test name');
      t.ok(stdout.includes('# Error:'), 'failure details include error heading');
      t.ok(stdout.includes('#   Error: body failed'), 'failure details include thrown error');
      t.ok(capturedStdout > details, 'captured stdout section follows failure heading');
      t.ok(capturedStderr > capturedStdout, 'captured stderr section follows stdout');
      t.ok(stdout.includes('#   stdout:first'), 'captured stdout line is printed');
      t.ok(stdout.includes('#   [warn] stderr:warn'), 'captured warning line is printed');
      t.ok(stdout.includes('#   [error] stderr:error'), 'captured error line is printed');
    });
  });

  it('runs hooks in lifecycle order and tears down after body failures', async (t) => {
    await withTempProject({
      'hooks.test.mts': [
        "import { after, afterEach, before, beforeEach, describe, it } from 'fino:test/test';",
        "describe('hooks', () => {",
        "  before(() => console.log('order:before'));",
        "  beforeEach(() => console.log('order:beforeEach'));",
        "  afterEach(() => console.log('order:afterEach'));",
        "  after(() => console.log('order:after'));",
        "  it('fails body', () => { console.log('order:body'); throw new Error('body failed'); });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'hooks.test.mts'], { cwd: dir });
      const before = stdout.indexOf('order:before');
      const beforeEach = stdout.indexOf('order:beforeEach');
      const body = stdout.indexOf('order:body');
      const afterEach = stdout.indexOf('order:afterEach');
      const after = stdout.indexOf('#   order:after\n');
      const details = stdout.indexOf('# Failure details');

      t.equal(result.code, 1, 'body failure exits nonzero');
      t.ok(details >= 0, 'failure details are printed');
      t.ok(before > details, 'before hook output is shown in final details');
      t.ok(before < beforeEach && beforeEach < body && body < afterEach && afterEach < after, 'hooks run in lifecycle order');
      t.ok(stdout.includes('not ok 1 - fails body'), 'body failure is reported');
    });
  });

  it('propagates skip reasons through describe groups', async (t) => {
    await withTempProject({
      'skip.test.mts': [
        "import { describe, it } from 'fino:test/test';",
        "describe('outer skip', { skip: 'blocked' }, () => {",
        "  it('first skipped', () => console.log('should-not-run'));",
        "  describe('inner skip', () => {",
        "    it('second skipped', () => console.log('should-not-run'));",
        "  });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'skip.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'skipped fixture exits successfully');
      t.equal(stderr, '', 'skipped fixture does not write stderr');
      t.ok(stdout.includes('# SKIP blocked'), 'skip reason is printed');
      t.ok(!stdout.includes('should-not-run'), 'skipped test bodies are not executed');
      t.ok(stdout.includes('# skip'), 'summary reports skipped tests');
    });
  });

  it('reports nested failures through parent subtests', async (t) => {
    await withTempProject({
      'nested-failure.test.mts': [
        "import { describe, it } from 'fino:test/test';",
        "describe('outer', () => {",
        "  describe('inner', () => {",
        "    it('fails nested', (t) => t.equal(1, 2, 'different'));",
        "  });",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'nested-failure.test.mts'], { cwd: dir });

      t.equal(result.code, 1, 'nested failure exits nonzero');
      t.ok(stdout.includes('# Subtest: outer'), 'outer subtest is printed');
      t.ok(stdout.includes('# Subtest: inner'), 'inner subtest is printed');
      t.ok(stdout.includes('not ok 1 - fails nested'), 'leaf failure is printed');
      t.ok(stdout.includes('not ok 1 - inner'), 'inner group failure is printed');
      t.ok(stdout.includes('not ok 1 - outer'), 'outer group failure is printed');
    });
  });

  it('filters matching top-level test leaves', async (t) => {
    await withTempProject({
      'filter.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('needle top leaf', (t) => t.ok(true));",
        "test('other top leaf', () => { throw new Error('should not run'); });",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', '--filter', 'needle', 'filter.test.mts'], { cwd: dir });

      t.equal(result.code, 0, 'filtered top-level leaf exits successfully');
      t.equal(stderr, '', 'filtered top-level leaf does not write stderr');
      t.ok(stdout.includes('ok 1 - needle top leaf'), 'matching top-level test leaf is included');
      t.ok(!stdout.includes('other top leaf'), 'non-matching top-level leaf is omitted');
      t.ok(stdout.includes('# pass  1'), 'summary reports the filtered pass');
    });
  });

  it('makes teardown after hook failures explicit', async (t) => {
    await withTempProject({
      'hook-failure.test.mts': [
        "import { after, afterEach, beforeEach, describe, it } from 'fino:test/test';",
        "describe('beforeEach failure', () => {",
        "  beforeEach(() => { console.log('hook:beforeEach'); throw new Error('setup failed'); });",
        "  afterEach(() => console.log('hook:afterEach'));",
        "  after(() => console.log('hook:after'));",
        "  it('does not run body', () => console.log('hook:body'));",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', 'hook-failure.test.mts'], { cwd: dir });

      t.equal(result.code, 1, 'hook failure exits nonzero');
      t.ok(stdout.includes('# Failure details'), 'failure details are printed');
      t.ok(stdout.includes('hook:beforeEach'), 'beforeEach hook ran');
      t.ok(!stdout.includes('hook:body'), 'body is skipped after beforeEach failure');
      t.ok(!stdout.includes('hook:afterEach'), 'afterEach does not run after beforeEach failure');
      t.ok(stdout.includes('hook:after'), 'after hook still runs after beforeEach failure');
    });
  });

  it('reports after hook failures with captured output', async (t) => {
    await withTempProject({
      'after-failure.test.mts': [
        "import { after, describe, it } from 'fino:test/test';",
        "describe('after failure', () => {",
        "  after(() => { console.log('hook:after-output'); throw new Error('after failed'); });",
        "  it('passes body', (t) => t.ok(true));",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', 'after-failure.test.mts'], { cwd: dir });

      t.equal(result.code, 1, 'after hook failure exits nonzero');
      t.ok(stderr.includes('[error] Error: 1 test(s) failed'), 'command failure summary is written to stderr');
      t.ok(stdout.includes('ok 1 - passes body'), 'passing body is still reported');
      t.ok(stdout.includes('not ok 1 - after failure'), 'parent group is marked failed');
      t.ok(stdout.includes('# 1) after hook: after failure'), 'failure details include after hook title');
      t.ok(stdout.includes('#   Error: after failed'), 'failure details include after hook error');
      t.ok(stdout.includes('# Captured stdout:'), 'failure details include captured stdout section');
      t.ok(stdout.includes('#   hook:after-output'), 'after hook output is captured');
    });
  });

  it('supports live console output for debugging', async (t) => {
    await withTempProject({
      'show-output.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('debug output', () => console.log('stdout:live'));",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', '--show-output=always', 'show-output.test.mts'], { cwd: dir });
      const live = stdout.indexOf('stdout:live');
      const ok = stdout.indexOf('ok 1 - debug output');

      t.equal(result.code, 0, 'passing fixture exits successfully');
      t.equal(stderr, '', 'debug fixture does not write stderr');
      t.ok(live >= 0, 'console output is written live');
      t.ok(live < ok, 'live output appears before the test result');
    });
  });

  it('rejects invalid output reporting modes', async (t) => {
    await withTempProject({
      'tap.test.mts': [
        "import { test } from 'fino:test/test';",
        "test('top leaf', (t) => t.ok(true));",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, stderr, result } = await runCli(['test', '--show-output=bad', 'tap.test.mts'], { cwd: dir });

      t.equal(result.code, 1, 'invalid mode exits nonzero');
      t.equal(stdout, '', 'invalid mode does not start TAP output');
      t.ok(stderr.includes('Invalid --show-output value "bad"'), 'invalid mode is reported');
    });
  });

  it('adds duration metadata to every result line when requested', async (t) => {
    await withTempProject({
      'durations.test.mts': [
        "import { after, describe, it, test } from 'fino:test/test';",
        "test('leaf pass', (t) => { t.meta({ duration: 'user' }); });",
        "test('leaf fail', () => { throw new Error('boom'); });",
        "test('leaf skip', { skip: 'blocked' }, () => { throw new Error('skip body'); });",
        "describe('skipped group', { skip: 'blocked' }, () => {",
        "  it('child skip', () => {});",
        "});",
        "describe('after fail group', () => {",
        "  after(() => { throw new Error('after failed'); });",
        "  it('body pass', () => {});",
        "});",
        '',
      ].join('\n'),
    }, async (dir) => {
      const { stdout, result } = await runCli(['test', '--durations', 'durations.test.mts'], { cwd: dir });
      const resultLines = stdout.split('\n').filter((line) => /^\s*(ok|not ok) \d+ - /.test(line));

      t.equal(result.code, 1, 'durations fixture exits nonzero');
      t.ok(resultLines.length >= 7, 'fixture emits multiple result lines');
      for (const line of resultLines) {
        t.ok(/# duration=\d+(?:\.\d+)?ms\b/.test(line), 'result line includes duration metadata: ' + line);
      }
      t.ok(stdout.includes('ok 1 - leaf pass # duration='), 'runner duration overrides user duration');
      t.ok(/ok \d+ - leaf skip # SKIP blocked # duration=\d+(?:\.\d+)?ms\b/.test(stdout), 'skipped leaf keeps SKIP directive before duration');
      t.ok(/ok \d+ - skipped group # SKIP blocked # duration=\d+(?:\.\d+)?ms\b/.test(stdout), 'skipped group keeps SKIP directive before duration');
      t.ok(/not ok \d+ - after fail group # duration=\d+(?:\.\d+)?ms\b/.test(stdout), 'hook-generated group failure includes duration');
    });
  });
});
