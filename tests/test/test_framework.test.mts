/**
 * Tests for boats:test — the TAP test framework itself.
 * Tests the framework's assertion helpers and async test support.
 */

import { describe, it } from 'boats:test/test';

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
