/**
* Tests for fino:realm — call() function mode.
*/
import { describe, it } from 'fino:test/test';
import { Realm, RealmDeployment } from 'fino:realm';
import type echoFn from './fixtures/echo-fn.ts';
import type asyncFn from './fixtures/async-fn.ts';
import type errorFn from './fixtures/error-fn.ts';
import type multiArgFn from './fixtures/multi-arg-fn.ts';
import type slowFn from './fixtures/slow-fn.ts';
import type nestedFn from './fixtures/nested-call.ts';
import type scalingFn from './fixtures/scaling-fn.ts';
describe('Realm call()', () => {
  it('calls a synchronous default-export function and returns the result', async (t) => {
    const realm = new Realm<typeof echoFn>({ entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname });
    const result = await realm.call('hello');
    t.equal(result, 'hello', 'result matches input');
  });
  it('calls an async default-export function and returns the result', async (t) => {
    const realm = new Realm<typeof asyncFn>({ entry: new URL('./fixtures/async-fn.ts', import.meta.url).pathname });
    const result = await realm.call(21);
    t.equal(result, 42, 'async function result is correct');
  });
  it('propagates errors thrown by the child function', async (t) => {
    const realm = new Realm<typeof errorFn>({ entry: new URL('./fixtures/error-fn.ts', import.meta.url).pathname });
    try {
      await realm.call('anything');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'error is an Error');
      t.ok((err as Error).message.includes('deliberate error'), 'message propagated');
    }
  });
  it('passes complex objects as input', async (t) => {
    type Payload = {
      x: number;
      y: number[];
      z: boolean;
    };
    const realm = new Realm<(input: Payload) => Payload>({ entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname });
    const input: Payload = {
      x: 1,
      y: [2, 3],
      z: true
    };
    const result = await realm.call(input);
    t.ok(typeof result === 'object' && result !== null, 'result is an object');
    t.equal(result.x, 1, 'x correct');
    t.equal(result.y[0], 2, 'y[0] correct');
    t.equal(result.z, true, 'z correct');
  });
  it('spreads multiple arguments into the child function', async (t) => {
    const realm = new Realm<typeof multiArgFn>({ entry: new URL('./fixtures/multi-arg-fn.ts', import.meta.url).pathname });
    const result = await realm.call(1, 2, 3, 4);
    t.equal(result, 10, 'sum of 1+2+3+4 is 10');
  });
  it('passes zero arguments when call() is invoked with none', async (t) => {
    const realm = new Realm<typeof multiArgFn>({ entry: new URL('./fixtures/multi-arg-fn.ts', import.meta.url).pathname });
    const result = await realm.call();
    t.equal(result, 0, 'sum of no args is 0');
  });
  it('replays an early __call message sent before the child handler is installed', async (t) => {
    const realm = new Realm<typeof slowFn>({ entry: new URL('./fixtures/slow-fn.ts', import.meta.url).pathname });
    const result = await realm.call(5, 'early-call-ok');
    t.equal(result, 'early-call-ok', 'early call was replayed after child load');
  });
  it('reuses one logical realm for sequential calls', async (t) => {
    using realm = new Realm<typeof echoFn>({ entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname });
    t.equal(await realm.call('first'), 'first');
    t.equal(await realm.call('second'), 'second');
  });
  it('recreates replicas after an idle deployment drained', async (t) => {
    using realm = new Realm<typeof echoFn>({ entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname });
    t.equal(await realm.call('before-idle'), 'before-idle');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    t.equal(await realm.call('after-idle'), 'after-idle');
  });
  it('routes nested Realm allocation through the owning node', async (t) => {
    using realm = new Realm<typeof nestedFn>({ entry: new URL('./fixtures/nested-call.ts', import.meta.url).pathname });
    t.equal(await realm.call('nested'), 'nested');
  });
  it('adds a replica when call queue delay stays unhealthy', async (t) => {
    using realm = new RealmDeployment<typeof scalingFn>({
      entry: new URL('./fixtures/scaling-fn.ts', import.meta.url).pathname,
      scaling: { min: 1, max: 2 }
    });
    const first = realm.call(1_300);
    const second = realm.call(0);
    const ids = await Promise.all([first, second]);
    t.notEqual(ids[0], ids[1], 'queued work ran on another isolate after the scale-up window');
  });
  it('warms the configured availability minimum', async (t) => {
    using realm = new RealmDeployment<typeof scalingFn>({
      entry: new URL('./fixtures/scaling-fn.ts', import.meta.url).pathname,
      scaling: { min: 2, max: 2, scaleUpWindowMs: 1_500 }
    });
    const started = performance.now();
    const ids = await Promise.all([realm.call(50), realm.call(0)]);
    t.notEqual(ids[0], ids[1]);
    t.ok(performance.now() - started < 1_250, 'minimum replicas were ready without a scale-up wait');
  });
  it('drains a quiet replica above the minimum', async (t) => {
    using realm = new RealmDeployment<typeof scalingFn>({
      entry: new URL('./fixtures/scaling-fn.ts', import.meta.url).pathname,
      scaling: { min: 1, max: 2, scaleUpWindowMs: 5, scaleDownWindowMs: 20 }
    }).ref();
    const initial = await Promise.all([realm.call(20), realm.call(0)]);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    const afterDrain = await Promise.all([realm.call(20), realm.call(0)]);
    t.notEqual(afterDrain[1], initial[1], 'the quiet excess replica was replaced after drain');
  });
});
