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
      const after = stdout.indexOf('\norder:after\n');

      t.equal(result.code, 1, 'body failure exits nonzero');
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
      t.ok(stdout.includes('hook:beforeEach'), 'beforeEach hook ran');
      t.ok(!stdout.includes('hook:body'), 'body is skipped after beforeEach failure');
      t.ok(!stdout.includes('hook:afterEach'), 'afterEach does not run after beforeEach failure');
      t.ok(stdout.includes('hook:after'), 'after hook still runs after beforeEach failure');
    });
  });
});
