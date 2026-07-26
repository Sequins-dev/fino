/**
 * Tests for fino:assert — AssertionError, Assert class, default instance,
 * and named exports.
 */
import { describe, it } from 'fino:test/test';
import {
  Assert,
  AssertionError,
  ok,
  notOk,
  equal,
  notEqual,
  deepEqual,
  fail,
  throws,
  rejects,
  match,
  doesNotThrow,
  doesNotReject,
  strictEqual,
  notStrictEqual,
} from 'fino:test/assert';
import assertDefault from 'fino:test/assert';
describe('AssertionError', () => {
  it('is an Error subclass', (t) => {
    const err = new AssertionError({
      message: 'oops',
      actual: 1,
      expected: 2,
      operator: 'equal',
    });
    t.ok(err instanceof Error, 'instanceof Error');
    t.ok(err instanceof AssertionError, 'instanceof AssertionError');
    t.equal(err.name, 'AssertionError', 'name');
    t.equal(err.message, 'oops', 'message');
    t.equal(err.actual, 1, 'actual');
    t.equal(err.expected, 2, 'expected');
    t.equal(err.operator, 'equal', 'operator');
  });
  it('default message when none given', (t) => {
    const err = new AssertionError({});
    t.equal(err.message, 'Assertion failed', 'default message');
  });
  it('fields from equal failure', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.equal(1, 2, 'values differ');
    t.equal(errors[0]!.actual, 1, 'actual');
    t.equal(errors[0]!.expected, 2, 'expected');
    t.equal(errors[0]!.operator, 'equal', 'operator');
  });
  it('fields from ok failure', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.ok(false, 'must be true');
    t.equal(errors[0]!.actual, false, 'actual');
    t.equal(errors[0]!.expected, true, 'expected');
    t.equal(errors[0]!.operator, 'ok', 'operator');
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
    try {
      assertDefault.ok(true);
    } catch (_) {
      threw = true;
    }
    t.ok(!threw, 'no throw on passing assertion');
  });
  it('named export ok — throws AssertionError on failure', (t) => {
    t.throws(
      () => ok(false),
      (e) => e instanceof AssertionError,
      'ok throws',
    );
  });
  it('named export equal — throws on mismatch', (t) => {
    t.throws(
      () => equal(1, 2),
      (e) => e instanceof AssertionError,
      'equal throws',
    );
  });
  it('named export throws — passes when fn throws', (t) => {
    let threw = false;
    try {
      throws(() => {
        throw new Error();
      });
    } catch (_) {
      threw = true;
    }
    t.ok(!threw, 'no throw when fn throws as expected');
  });
});
describe('Assert callbacks', () => {
  it('onFail is called with AssertionError', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(err) {
        errors.push(err);
      },
    });
    a.ok(false);
    t.equal(errors.length, 1, 'one error collected');
    t.ok(errors[0] instanceof AssertionError, 'error is AssertionError');
  });
  it('onPass is called on each passing assertion', (t) => {
    let passCount = 0;
    const a = new Assert({
      onPass() {
        passCount++;
      },
    });
    a.ok(true);
    a.equal(1, 1);
    a.notOk(false);
    t.equal(passCount, 3, 'onPass called 3 times');
  });
  it('multiple failures accumulate without throwing', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(err) {
        errors.push(err);
      },
    });
    a.ok(false, 'first');
    a.equal(1, 2, 'second');
    a.notOk(true, 'third');
    t.equal(errors.length, 3, 'all 3 failures collected');
  });
});
describe('ok / notOk', () => {
  it('ok — passes for truthy, fails for falsy', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.ok(true);
    a.ok(1);
    a.ok('x');
    a.ok({});
    a.ok(false);
    a.ok(0);
    a.ok('');
    a.ok(null);
    t.equal(errors.length, 4, '4 falsy values fail');
  });
  it('notOk — passes for falsy, fails for truthy', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.notOk(false);
    a.notOk(0);
    a.notOk(null);
    a.notOk(undefined);
    a.notOk(true);
    a.notOk(1);
    t.equal(errors.length, 2, '2 truthy values fail');
  });
});
describe('equal / notEqual / deepEqual / fail', () => {
  it('equal — strict equality (===)', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.equal(1, 1);
    a.equal('a', 'a');
    a.equal(null, null);
    a.equal(1, '1');
    a.equal(1, 2);
    t.equal(errors.length, 2, '2 failures');
    t.ok(errors[0]!.message.includes('expected'), 'message includes "expected"');
    t.equal(errors[0]!.operator, 'equal', 'operator is equal');
  });
  it('notEqual — strict inequality (!==)', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.notEqual(1, 2);
    a.notEqual(1, 1);
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0]!.operator, 'notEqual', 'operator is notEqual');
  });
  it('deepEqual — nested objects and arrays', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.deepEqual({ x: 1 }, { x: 1 });
    a.deepEqual([1, 2, 3], [1, 2, 3]);
    a.deepEqual({ a: { b: 2 } }, { a: { b: 2 } });
    a.deepEqual({ x: 1 }, { x: 2 });
    a.deepEqual([1, 2], [1, 2, 3]);
    t.equal(errors.length, 2, '2 failures');
  });
  it('deepEqual — compares Map, Set, Date, RegExp, symbols, typed arrays, and cycles', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    const sym = Symbol('key');
    const cycleA: any = { name: 'cycle' };
    const cycleB: any = { name: 'cycle' };
    cycleA.self = cycleA;
    cycleB.self = cycleB;
    a.deepEqual(
      new Map([[{ id: 1 }, new Set(['a', 'b'])]]),
      new Map([[{ id: 1 }, new Set(['b', 'a'])]]),
    );
    a.deepEqual(new Date('2024-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
    a.deepEqual(/abc/gi, /abc/gi);
    a.deepEqual({ [sym]: 42 }, { [sym]: 42 });
    a.deepEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]));
    a.deepEqual(cycleA, cycleB);
    a.deepEqual(new Map([['x', 1]]), new Map([['x', 2]]));
    a.deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]));
    t.equal(errors.length, 2, '2 rich deepEqual mismatches fail');
  });
  it('strictEqual and notStrictEqual alias strict equality helpers', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.strictEqual(1, 1);
    a.notStrictEqual(1, 2);
    a.strictEqual(1, '1');
    a.notStrictEqual(1, 1);
    t.equal(errors.length, 2, 'aliases preserve pass/fail callback behavior');
    t.equal(errors[0]!.operator, 'strictEqual', 'strictEqual operator is reported');
    t.equal(errors[1]!.operator, 'notStrictEqual', 'notStrictEqual operator is reported');
  });
  it('fail — always invokes onFail', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.fail('something went wrong');
    t.equal(errors.length, 1, '1 error');
    t.equal(errors[0]!.message, 'something went wrong', 'message preserved');
    t.equal(errors[0]!.operator, 'fail', 'operator is fail');
  });
  it('fail — default message when none given', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.fail();
    t.equal(errors[0]!.message, 'fail called', 'default message');
  });
});
describe('throws', () => {
  it('passes when fn throws', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.throws(
      () => {
        throw new Error('boom');
      },
      null,
      'does throw',
    );
    t.equal(errors.length, 0, 'no failures');
  });
  it('fails when fn does not throw', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.throws(() => {}, null, 'should throw but does not');
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0]!.operator, 'throws', 'operator is throws');
  });
  it('check function validates thrown value', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.throws(
      () => {
        throw new TypeError();
      },
      (e) => e instanceof TypeError,
      'right type',
    );
    a.throws(
      () => {
        throw new Error();
      },
      (e) => e instanceof TypeError,
      'wrong type',
    );
    t.equal(errors.length, 1, '1 failure (wrong type)');
  });
  it('RegExp check tested against err.message', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.throws(
      () => {
        throw new Error('bad value');
      },
      /bad/,
      'matches regex',
    );
    a.throws(
      () => {
        throw new Error('bad value');
      },
      /good/,
      'no match',
    );
    t.equal(errors.length, 1, '1 failure');
  });
  it('constructor check matches thrown error type', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.throws(
      () => {
        throw new TypeError('bad type');
      },
      TypeError,
      'matches constructor',
    );
    a.throws(
      () => {
        throw new Error('plain');
      },
      TypeError,
      'wrong constructor',
    );
    t.equal(errors.length, 1, '1 failure');
  });
  it('doesNotThrow passes when callback does not throw and fails when it throws', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.doesNotThrow(() => {}, undefined, 'no throw');
    a.doesNotThrow(
      () => {
        throw new Error('boom');
      },
      Error,
      'throws',
    );
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0]!.operator, 'doesNotThrow', 'operator is doesNotThrow');
  });
  it('match passes strings matching a RegExp and fails mismatches', (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    a.match('hello world', /world/);
    a.match('hello world', /mars/);
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0]!.operator, 'match', 'operator is match');
  });
});
describe('rejects', () => {
  it('passes when async fn rejects', async (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    await a.rejects(async () => {
      throw new Error('boom');
    }, null);
    t.equal(errors.length, 0, 'no failures');
  });
  it('fails when async fn resolves', async (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    await a.rejects(async () => {}, null);
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0]!.operator, 'rejects', 'operator is rejects');
  });
  it('check function validates rejection', async (t) => {
    const errors = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    await a.rejects(
      async () => {
        throw new TypeError();
      },
      (e) => e instanceof TypeError,
    );
    await a.rejects(
      async () => {
        throw new Error();
      },
      (e) => e instanceof TypeError,
    );
    t.equal(errors.length, 1, '1 failure (wrong type)');
  });
  it('reports the rejected Error message when a check fails', async (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(error) {
        errors.push(error);
      },
    });
    await a.rejects(
      async () => {
        throw new Error('actual rejection');
      },
      /different message/,
    );
    t.ok(
      errors[0]?.message.includes('Error: actual rejection'),
      'failure includes the rejected error instead of an empty object',
    );
  });
  it('works with Promise.reject()', async (t) => {
    const errors = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    await a.rejects(() => Promise.reject(new RangeError('out')), null);
    t.equal(errors.length, 0, 'no failures');
  });
  it('constructor check matches rejected error type', async (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    await a.rejects(async () => {
      throw new RangeError('out');
    }, RangeError);
    await a.rejects(async () => {
      throw new Error('plain');
    }, RangeError);
    t.equal(errors.length, 1, '1 failure');
  });
  it('doesNotReject passes when callback resolves and fails when it rejects', async (t) => {
    const errors: AssertionError[] = [];
    const a = new Assert({
      onFail(e) {
        errors.push(e);
      },
    });
    await a.doesNotReject(async () => {}, undefined, 'resolves');
    await a.doesNotReject(
      async () => {
        throw new Error('boom');
      },
      Error,
      'rejects',
    );
    t.equal(errors.length, 1, '1 failure');
    t.equal(errors[0]!.operator, 'doesNotReject', 'operator is doesNotReject');
  });
  it('named assertion exports include Node-compatible aliases', async (t) => {
    strictEqual(1, 1);
    notStrictEqual(1, 2);
    match('abc', /b/);
    doesNotThrow(() => {});
    await doesNotReject(async () => {});
    await rejects(async () => {
      throw new TypeError('type');
    }, TypeError);
    throws(() => {
      throw new RangeError('range');
    }, RangeError);
    t.ok(true, 'named aliases are callable');
  });
});
