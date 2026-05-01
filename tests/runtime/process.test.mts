/**
 * Tests for fino:process — process info APIs and child process spawning.
 */

import { describe, it } from 'fino:test/test';
import { os, arch, argv, env, execPath, pid, ppid, cwd, chdir, kill, Process } from 'fino:runtime/process';
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);

function joinChunks(chunks: Uint8Array[]): string {
  return decodeUtf8(chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
    const merged = new Uint8Array(acc.byteLength + c.byteLength);
    merged.set(acc);
    merged.set(c, acc.byteLength);
    return merged;
  }, new Uint8Array(0)));
}

describe('Platform info', () => {
  it('os is a non-empty string', (t) => {
    t.equal(typeof os, 'string');
    t.ok(os.length > 0, 'os is non-empty');
  });

  it('arch is a non-empty string', (t) => {
    t.equal(typeof arch, 'string');
    t.ok(arch.length > 0, 'arch is non-empty');
  });

  it('os is a known platform', (t) => {
    const known = ['darwin', 'linux', 'windows', 'freebsd', 'unknown'];
    t.ok(known.includes(os), 'os is known: ' + os);
  });

  it('arch is a known architecture', (t) => {
    const known = ['x86_64', 'aarch64', 'x86', 'arm', 'unknown'];
    t.ok(known.includes(arch), 'arch is known: ' + arch);
  });

  it('argv is an array with at least one entry', (t) => {
    t.ok(Array.isArray(argv), 'argv is an Array');
    t.ok(argv.length >= 1, 'argv has at least the binary name');
    t.equal(typeof argv[0], 'string', 'argv[0] is a string');
  });

  it('env is a plain object with string values', (t) => {
    t.ok(env !== null && typeof env === 'object', 'env is an object');
    const keys = Object.keys(env);
    t.ok(keys.length > 0, 'env has at least one entry');
    for (const k of keys) {
      t.equal(typeof env[k], 'string', `env[${k}] is a string`);
    }
  });

  it('execPath is a non-empty string', (t) => {
    t.equal(typeof execPath, 'string');
    t.ok(execPath.length > 0, 'execPath is non-empty');
  });
});

describe('Process APIs', () => {
  it('pid is a positive integer', (t) => {
    t.equal(typeof pid, 'number');
    t.ok(pid > 0, `pid ${pid} > 0`);
    t.ok(Number.isInteger(pid), 'pid is an integer');
  });

  it('ppid is a positive integer', (t) => {
    t.equal(typeof ppid, 'number');
    t.ok(ppid > 0, `ppid ${ppid} > 0`);
    t.ok(Number.isInteger(ppid), 'ppid is an integer');
  });

  it('cwd() returns a non-empty string', (t) => {
    const dir = cwd();
    t.equal(typeof dir, 'string');
    t.ok(dir.length > 0, 'cwd is non-empty');
    t.ok(dir.startsWith('/'), 'cwd is absolute');
  });

  it('chdir() changes and restores working directory', (t) => {
    const original = cwd();
    chdir('/tmp');
    t.ok(cwd().endsWith('tmp'), `cwd after chdir('/tmp') ends with tmp`);
    chdir(original);
    t.equal(cwd(), original);
  });

  it('internal:process cannot be imported from user code', async (t) => {
    let threw = false;
    let errMsg = '';
    try {
      await import('internal:process');
    } catch (e: unknown) {
      threw = true;
      errMsg = String(e instanceof Error ? e.message : e);
    }
    t.ok(threw, 'importing internal:process from user code throws');
    t.ok(errMsg.includes('Cannot import internal module'), `error mentions internal module: ${errMsg}`);
  });
});

describe('Process class', () => {
  it('spawns /bin/echo and reads stdout', async (t) => {
    const proc = new Process('/bin/echo', ['hello fino']);
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    t.equal(joinChunks(chunks).trim(), 'hello fino');
    const { code } = await proc.wait();
    t.equal(code, 0);
  });

  it('wait() returns correct exit code', async (t) => {
    const proc = new Process('/bin/sh', ['-c', 'exit 42']);
    proc.stdin.close();
    for await (const _ of proc.stdout) { /* drain */ }
    for await (const _ of proc.stderr) { /* drain */ }
    const { code, signal } = await proc.wait();
    t.equal(code, 42);
    t.equal(signal, null);
  });

  it('stdin pipes to child stdin', async (t) => {
    const proc = new Process('/bin/cat', []);
    await proc.stdin.write(encodeUtf8('ping\n'));
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    t.equal(joinChunks(chunks), 'ping\n');
    await proc.wait();
  });

  it('captures stderr', async (t) => {
    const proc = new Process('/bin/sh', ['-c', 'echo err >&2']);
    proc.stdin.close();
    for await (const _ of proc.stdout) { /* drain */ }
    const errChunks = [];
    for await (const chunk of proc.stderr) errChunks.push(chunk);
    t.equal(joinChunks(errChunks).trim(), 'err');
    await proc.wait();
  });

  it('cwd option changes child working directory', async (t) => {
    const proc = new Process('/bin/pwd', [], { cwd: '/tmp' });
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    t.ok(joinChunks(chunks).trim().endsWith('tmp'), 'pwd output ends with tmp');
    await proc.wait();
  });

  it('kill() sends signal to child', async (t) => {
    const proc = new Process('/bin/sleep', ['60']);
    proc.kill();
    const { code, signal } = await proc.wait();
    t.equal(code, null);
    t.ok(signal !== null, 'child was signalled');
  });
});

describe('exit() propagates non-zero code to parent', () => {
  it('exit(42) results in wait().code === 42', async (t) => {
    const proc = new Process(execPath, [
      'run',
      new URL('../fixtures/exit-with-code.mts', import.meta.url).pathname,
    ], { env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string> });
    proc.stdin.close();
    for await (const _ of proc.stdout) { /* drain */ }
    const { code, signal } = await proc.wait();
    t.equal(code, 42, 'exit(42) produces wait().code === 42');
    t.equal(signal, null, 'process exited normally (no signal)');
  });
});

describe('B1 regression: exit() flushes stdout before terminating', () => {
  it('output written to stdout before exit(0) is captured by the parent', async (t) => {
    // Spawn a child process that writes to stdout then calls exit(0).
    // If exit() does not flush the coalesce buffer, the output is lost and
    // the test fails.
    const proc = new Process(execPath, [
      'run',
      new URL('../fixtures/exit-with-output.mts', import.meta.url).pathname,
    ], { env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string> });
    proc.stdin.close();
    const chunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    const { code } = await proc.wait();
    const captured = decodeUtf8(chunks.reduce((acc, c) => {
      const m = new Uint8Array(acc.byteLength + c.byteLength);
      m.set(acc); m.set(c, acc.byteLength);
      return m;
    }, new Uint8Array(0)));
    t.equal(code, 0, 'child exited with code 0');
    t.ok(captured.includes('exit-flush-test-output'), 'stdout was flushed before exit: ' + JSON.stringify(captured));
  });
});
