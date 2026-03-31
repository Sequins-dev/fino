/**
 * Tests for process.stdin / process.stdout / process.stderr.
 */

import { describe, it } from 'boats:test/test';
import { stdin, stdout, stderr, Process } from 'boats:runtime/process';
import * as loop from 'boats:runtime/loop';

const enc = new TextEncoder();
const dec = new TextDecoder();
function encodeUtf8(s) { return enc.encode(s); }
function decodeUtf8(b) { return dec.decode(b); }

function joinChunks(chunks) {
  return chunks.reduce((acc, c) => {
    const out = new Uint8Array(acc.length + c.length);
    out.set(acc);
    out.set(c, acc.length);
    return out;
  }, new Uint8Array(0));
}

describe('process.stdout', () => {
  it('returns a Writer that can write bytes', async (t) => {
    const lp = loop.create();
    try {
      const w = stdout();
      t.ok(w !== null && typeof w === 'object', 'stdout() returns an object');
      t.ok(typeof w.write === 'function', 'has write method');
      // Write an empty buffer — should succeed without error.
      await w.write(new Uint8Array(0));
      t.ok(true, 'write empty buffer succeeds');
    } finally {
      loop.destroy(lp);
    }
  });

  it('returns the same singleton on repeated calls', async (t) => {
    const lp = loop.create();
    try {
      const a = stdout();
      const b = stdout();
      t.ok(a === b, 'stdout() returns the same instance');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('process.stderr', () => {
  it('returns a Writer', async (t) => {
    const lp = loop.create();
    try {
      const w = stderr();
      t.ok(w !== null && typeof w === 'object', 'stderr() returns an object');
      t.ok(typeof w.write === 'function', 'has write method');
    } finally {
      loop.destroy(lp);
    }
  });
});

describe('process.stdin via child process pipe', () => {
  it('can read stdout of a child process via Reader', async (t) => {
    const lp = loop.create();
    try {
      const proc = new Process('/bin/echo', ['-n', 'hello from child'], { loop: lp });
      proc.stdin.close();
      const chunks = [];
      for await (const chunk of proc.stdout) chunks.push(chunk);
      const result = decodeUtf8(joinChunks(chunks));
      t.equal(result, 'hello from child', 'read child stdout via Reader');
      await proc.wait();
    } finally {
      loop.destroy(lp);
    }
  });

  it('can pipe data into a child via its stdin Writer', async (t) => {
    const lp = loop.create();
    try {
      const proc = new Process('/bin/cat', [], { loop: lp });
      await proc.stdin.write(encodeUtf8('piped input'));
      proc.stdin.close();
      const chunks = [];
      for await (const chunk of proc.stdout) chunks.push(chunk);
      const result = decodeUtf8(joinChunks(chunks));
      t.equal(result, 'piped input', 'cat echoes stdin back via stdout');
      await proc.wait();
    } finally {
      loop.destroy(lp);
    }
  });
});
