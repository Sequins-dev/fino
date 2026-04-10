/**
 * Tests for fino:realm — call() function mode.
 */

import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';

import type echoFn from './fixtures/echo-fn.mts';
import type asyncFn from './fixtures/async-fn.mts';
import type errorFn from './fixtures/error-fn.mts';
import type multiArgFn from './fixtures/multi-arg-fn.mts';

describe('Realm call()', () => {
  it('calls a synchronous default-export function and returns the result', async (t) => {
    const realm = new Realm<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call('hello');
    t.equal(result, 'hello', 'result matches input');
  });

  it('calls an async default-export function and returns the result', async (t) => {
    const realm = new Realm<typeof asyncFn>({
      entry: new URL('./fixtures/async-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call(21);
    t.equal(result, 42, 'async function result is correct');
  });

  it('propagates errors thrown by the child function', async (t) => {
    const realm = new Realm<typeof errorFn>({
      entry: new URL('./fixtures/error-fn.mts', import.meta.url).pathname,
    });
    try {
      await realm.call('anything');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'error is an Error');
      t.ok((err as Error).message.includes('deliberate error'), 'message propagated');
    }
  });

  it('passes complex objects as input', async (t) => {
    type Payload = { x: number; y: number[]; z: boolean };
    const realm = new Realm<(input: Payload) => Payload>({
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const input: Payload = { x: 1, y: [2, 3], z: true };
    const result = await realm.call(input);
    t.ok(typeof result === 'object' && result !== null, 'result is an object');
    t.equal(result.x, 1, 'x correct');
    t.equal(result.y[0], 2, 'y[0] correct');
    t.equal(result.z, true, 'z correct');
  });

  it('spreads multiple arguments into the child function', async (t) => {
    const realm = new Realm<typeof multiArgFn>({
      entry: new URL('./fixtures/multi-arg-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call(1, 2, 3, 4);
    t.equal(result, 10, 'sum of 1+2+3+4 is 10');
  });

  it('passes zero arguments when call() is invoked with none', async (t) => {
    const realm = new Realm<typeof multiArgFn>({
      entry: new URL('./fixtures/multi-arg-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.equal(result, 0, 'sum of no args is 0');
  });
});
