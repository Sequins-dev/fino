/**
 * Tests for boats:assert — AssertionError, Assert class, default instance,
 * and named exports.
 */

import { describe, it } from 'boats:test/test';
import { Assert, AssertionError, ok, notOk, equal, notEqual, deepEqual, fail, throws, rejects } from 'boats:test/assert';
import assertDefault from 'boats:test/assert';

describe('AssertionError', () => {
  it('is an Error subclass', (t) => {
    const err = new AssertionError({ message: 'oops', actual: 1, expected: 2, operator: 'equal' });
    t.ok(err instanceof Error,           'instanceof Error');
    t.ok(err instanceof AssertionError,  'instanceof AssertionError');
    t.equal(err.name,     'AssertionError', 'name');
    t.equal(err.message,  'oops',          'message');
    t.equal(err.actual,   1,               'actual');
    t.equal(err.expected, 2,               'expected');
    t.equal(err.operator, 'equal',         'operator');
  });

  it('default message when none given', (t) => {
    const err = new AssertionError({});
    t.equal(err.message, 'Assertion failed', 'default message');
  });

  it('fields from equal failure', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.equal(1, 2, 'values differ');
    t.equal(errors[0].actual,   1,       'actual');
    t.equal(errors[0].expected, 2,       'expected');
    t.equal(errors[0].operator, 'equal', 'operator');
  });

  it('fields from ok failure', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.ok(false, 'must be true');
    t.equal(errors[0].actual,   false, 'actual');
    t.equal(errors[0].expected, true,  'expected');
    t.equal(errors[0].operator, 'ok',  'operator');
  });
});

describe('default assert instance', () => {
  it('throws AssertionError on ok(false)', (t) => {
    t.throws(
      () => assertDefault.ok(false),
      (e) => e instanceof AssertionError,
      'throws AssertionError',
    );
  });

  it('does not throw on ok(true)', (t) => {
    let threw = false;
    try { assertDefault.ok(true); } catch (_) { threw = true; }
    t.ok(!threw, 'no throw on passing assertion');
  });

  it('named export ok — throws AssertionError on failure', (t) => {
    t.throws(() => ok(false), (e) => e instanceof AssertionError, 'ok throws');
  });

  it('named export equal — throws on mismatch', (t) => {
    t.throws(() => equal(1, 2), (e) => e instanceof AssertionError, 'equal throws');
  });

  it('named export throws — passes when fn throws', (t) => {
    let threw = false;
    try { throws(() => { throw new Error(); }); } catch (_) { threw = true; }
    t.ok(!threw, 'no throw when fn throws as expected');
  });
});

describe('Assert callbacks', () => {
  it('onFail is called with AssertionError', (t) => {
    const errors = [];
    const a = new Assert({ onFail(err) { errors.push(err); } });
    a.ok(false);
    t.equal(errors.length, 1, 'one error collected');
    t.ok(errors[0] instanceof AssertionError, 'error is AssertionError');
  });

  it('onPass is called on each passing assertion', (t) => {
    let passCount = 0;
    const a = new Assert({ onPass() { passCount++; } });
    a.ok(true);
    a.equal(1, 1);
    a.notOk(false);
    t.equal(passCount, 3, 'onPass called 3 times');
  });

  it('multiple failures accumulate without throwing', (t) => {
    const errors = [];
    const a = new Assert({ onFail(err) { errors.push(err); } });
    a.ok(false, 'first');
    a.equal(1, 2, 'second');
    a.notOk(true, 'third');
    t.equal(errors.length, 3, 'all 3 failures collected');
  });
});

describe('ok / notOk', () => {
  it('ok — passes for truthy, fails for falsy', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.ok(true); a.ok(1); a.ok('x'); a.ok({});
    a.ok(false); a.ok(0); a.ok(''); a.ok(null);
    t.equal(errors.length, 4, '4 falsy values fail');
  });

  it('notOk — passes for falsy, fails for truthy', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.notOk(false); a.notOk(0); a.notOk(null); a.notOk(undefined);
    a.notOk(true); a.notOk(1);
    t.equal(errors.length, 2, '2 truthy values fail');
  });
});

describe('equal / notEqual / deepEqual / fail', () => {
  it('equal — strict equality (===)', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.equal(1, 1);
    a.equal('a', 'a');
    a.equal(null, null);
    a.equal(1, '1');   // fail: different types
    a.equal(1, 2);     // fail
    t.equal(errors.length, 2, '2 failures');
    t.ok(errors[0].message.includes('expected'), 'message includes "expected"');
    t.equal(errors[0].operator, 'equal', 'operator is equal');
  });

  it('notEqual — strict inequality (!==)', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.notEqual(1, 2);
    a.notEqual(1, 1);  // fail
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0].operator, 'notEqual', 'operator is notEqual');
  });

  it('deepEqual — nested objects and arrays', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.deepEqual({ x: 1 },      { x: 1 });
    a.deepEqual([1, 2, 3],     [1, 2, 3]);
    a.deepEqual({ a: { b: 2 } }, { a: { b: 2 } });
    a.deepEqual({ x: 1 },      { x: 2 });  // fail
    a.deepEqual([1, 2],        [1, 2, 3]); // fail
    t.equal(errors.length, 2, '2 failures');
  });

  it('fail — always invokes onFail', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.fail('something went wrong');
    t.equal(errors.length, 1, '1 error');
    t.equal(errors[0].message, 'something went wrong', 'message preserved');
    t.equal(errors[0].operator, 'fail', 'operator is fail');
  });

  it('fail — default message when none given', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.fail();
    t.equal(errors[0].message, 'fail called', 'default message');
  });
});

describe('throws', () => {
  it('passes when fn throws', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.throws(() => { throw new Error('boom'); }, null, 'does throw');
    t.equal(errors.length, 0, 'no failures');
  });

  it('fails when fn does not throw', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.throws(() => {}, null, 'should throw but does not');
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0].operator, 'throws', 'operator is throws');
  });

  it('check function validates thrown value', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.throws(() => { throw new TypeError(); }, (e) => e instanceof TypeError, 'right type');
    a.throws(() => { throw new Error(); },     (e) => e instanceof TypeError, 'wrong type');
    t.equal(errors.length, 1, '1 failure (wrong type)');
  });

  it('RegExp check tested against err.message', (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    a.throws(() => { throw new Error('bad value'); }, /bad/, 'matches regex');
    a.throws(() => { throw new Error('bad value'); }, /good/, 'no match');
    t.equal(errors.length, 1, '1 failure');
  });
});

describe('rejects', () => {
  it('passes when async fn rejects', async (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    await a.rejects(async () => { throw new Error('boom'); }, null);
    t.equal(errors.length, 0, 'no failures');
  });

  it('fails when async fn resolves', async (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    await a.rejects(async () => {}, null);
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0].operator, 'rejects', 'operator is rejects');
  });

  it('check function validates rejection', async (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    await a.rejects(async () => { throw new TypeError(); }, (e) => e instanceof TypeError);
    await a.rejects(async () => { throw new Error(); },     (e) => e instanceof TypeError);
    t.equal(errors.length, 1, '1 failure (wrong type)');
  });

  it('works with Promise.reject()', async (t) => {
    const errors = [];
    const a = new Assert({ onFail(e) { errors.push(e); } });
    await a.rejects(() => Promise.reject(new RangeError('out')), null);
    t.equal(errors.length, 0, 'no failures');
  });
});
