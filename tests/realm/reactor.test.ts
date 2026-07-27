/**
 * Tests for fino:realm reactor-pooled isolates.
 *
 * Realm isolates move between worker threads under the shared reactor
 * scheduler. Messaging uses V8 ValueSerializer across isolates.
 */
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import * as schedulerNative from 'internal:scheduler-native';
// Import fixture types so the Realm<F> generic can connect call() args/return.
import type echoFn from './fixtures/echo-fn.ts';
import type sumFn from './fixtures/multi-arg-fn.ts';
import type errorFn from './fixtures/error-fn.ts';
import type asyncFn from './fixtures/async-fn.ts';

describe('Reactor scheduler native surface', () => {
  it('does not expose retired compatibility operations', (t) => {
    for (const name of [
      'sharedLoopDescriptor',
      'pollSharedReactor',
      'registerSharedPoll',
      'takeSharedPoll',
      'cancelSharedPoll',
      'addReactorWorkload',
      'signalReactorWorkload',
      'routeSharedLoopEvent',
    ]) {
      t.equal(name in schedulerNative, false, `${name} is not exported`);
    }
  });
  it('exposes explicit workload submission for an initially empty pool', (t) => {
    t.equal(
      'submitReactorWorkload' in schedulerNative,
      true,
      'workloads are submitted separately from queue construction',
    );
  });
});

describe('Reactor-pooled Realm basics', () => {
  it('runs a pooled realm to completion', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/hello.ts', import.meta.url).pathname,
    });
    // hello.ts has no default function — it completes after module evaluation.
    await realm.run();
    t.ok(true, 'pooled realm ran to completion');
  });
  it('call() invokes the default-export function in a pooled realm', async (t) => {
    const realm = new Realm<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const result = await realm.call('hello from pool');
    t.equal(result, 'hello from pool', 'echo result matches input');
  });
  it('call() passes multiple arguments to the pooled realm function', async (t) => {
    const realm = new Realm<typeof sumFn>({
      entry: new URL('./fixtures/multi-arg-fn.ts', import.meta.url).pathname,
    });
    const result = await realm.call(1, 2, 3, 4);
    t.equal(result, 10, 'sum of 1+2+3+4 is 10');
  });
  it('routes colliding realm-local timer ids to their owning isolates', async (t) => {
    const entry = new URL('./fixtures/async-fn.ts', import.meta.url).pathname;
    const realms = [
      new Realm<typeof asyncFn>({ entry }),
      new Realm<typeof asyncFn>({ entry }),
      new Realm<typeof asyncFn>({ entry }),
    ];
    t.deepEqual(
      await Promise.all(realms.map((realm, index) => realm.call(index + 1))),
      [2, 4, 6],
      'all sibling realm timers resolve independently',
    );
  });
  it('call() propagates errors thrown inside the pooled realm', async (t) => {
    const realm = new Realm<typeof errorFn>({
      entry: new URL('./fixtures/error-fn.ts', import.meta.url).pathname,
    });
    try {
      await realm.call('anything');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'error is an Error');
      t.ok((err as Error).message.includes('deliberate error'), 'message propagated');
    }
  });
  it('call() passes complex objects through ValueSerializer', async (t) => {
    type Payload = {
      x: number;
      y: number[];
      z: boolean;
    };
    const realm = new Realm<(input: Payload) => Payload>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const input: Payload = {
      x: 1,
      y: [2, 3],
      z: true,
    };
    const result = await realm.call(input);
    t.ok(typeof result === 'object' && result !== null, 'result is an object');
    t.equal(result.x, 1, 'x correct');
    t.equal(result.y[0], 2, 'y[0] correct');
    t.equal(result.z, true, 'z correct');
  });
  it('Map is preserved as Map through realm.call() (not converted to plain object)', async (t) => {
    type MapFn = (m: Map<string, number>) => Map<string, number>;
    const realm = new Realm<MapFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const input = new Map<string, number>([
      ['alpha', 1],
      ['beta', 2],
    ]);
    const result = await realm.call(input);
    t.ok(result instanceof Map, 'result is a Map (not a plain object)');
    t.equal(result.get('alpha'), 1, 'Map entry alpha preserved');
    t.equal(result.get('beta'), 2, 'Map entry beta preserved');
    t.equal(result.size, 2, 'Map size correct');
  });
  it('Set is preserved as Set through realm.call()', async (t) => {
    type SetFn = (s: Set<string>) => Set<string>;
    const realm = new Realm<SetFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const input = new Set(['x', 'y', 'z']);
    const result = await realm.call(input);
    t.ok(result instanceof Set, 'result is a Set (not a plain object)');
    t.ok(result.has('x') && result.has('y') && result.has('z'), 'all Set entries present');
    t.equal(result.size, 3, 'Set size correct');
  });
  it('Error subclass name and message are preserved through realm.call()', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/type-error-fn.ts', import.meta.url).pathname,
    });
    try {
      await realm.call('anything');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'error is an Error');
      t.equal((err as Error).name, 'TypeError', 'error name (TypeError) is preserved');
      t.ok((err as Error).message.includes('expected a string'), 'message content preserved');
    }
  });
  it('terminate() stops a pooled realm', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/long-running.ts', import.meta.url).pathname,
    });
    const runPromise = realm.run();
    // Small delay to let the realm start.
    await new Promise<void>((res) => setTimeout(res, 10));
    realm.terminate();
    await runPromise;
    t.ok(true, 'pooled realm terminated successfully');
  });
});
