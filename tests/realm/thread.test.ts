/**
* Tests for fino:realm — thread Realm (thread: true).
*
* Thread realms run in a separate V8 Isolate on an OS thread. Messaging uses
* V8 ValueSerializer over Rust mpsc channels instead of same-Isolate
* structured clone.
*/
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
// Import fixture types so the Realm<F> generic can connect call() args/return.
import type echoFn from './fixtures/echo-fn.ts';
import type sumFn from './fixtures/multi-arg-fn.ts';
import type errorFn from './fixtures/error-fn.ts';
describe('Thread Realm basics', () => {
  it('rejects multiple isolated mode flags at construction', (t) => {
    t.throws(() => new Realm({
      thread: true,
      process: true,
      entry: new URL('./fixtures/hello.ts', import.meta.url).pathname
    }), /thread.*process.*remote|isolated mode/i, 'thread and process cannot both be enabled');
  });
  it('spawns a thread realm that runs to completion', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/hello.ts', import.meta.url).pathname
    });
    // hello.ts has no default function — it completes after module evaluation.
    await realm.run();
    t.ok(true, 'thread realm ran to completion');
  });
  it('call() invokes the default-export function in a thread realm', async (t) => {
    const realm = new Realm<typeof echoFn>({
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
    const result = await realm.call('hello from thread');
    t.equal(result, 'hello from thread', 'echo result matches input');
  });
  it('call() passes multiple arguments to the thread realm function', async (t) => {
    const realm = new Realm<typeof sumFn>({
      thread: true,
      entry: new URL('./fixtures/multi-arg-fn.ts', import.meta.url).pathname
    });
    const result = await realm.call(1, 2, 3, 4);
    t.equal(result, 10, 'sum of 1+2+3+4 is 10');
  });
  it('call() propagates errors thrown inside the thread realm', async (t) => {
    const realm = new Realm<typeof errorFn>({
      thread: true,
      entry: new URL('./fixtures/error-fn.ts', import.meta.url).pathname
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
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
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
  it('Map is preserved as Map through realm.call() (not converted to plain object)', async (t) => {
    type MapFn = (m: Map<string, number>) => Map<string, number>;
    const realm = new Realm<MapFn>({
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
    const input = new Map<string, number>([['alpha', 1], ['beta', 2]]);
    const result = await realm.call(input);
    t.ok(result instanceof Map, 'result is a Map (not a plain object)');
    t.equal(result.get('alpha'), 1, 'Map entry alpha preserved');
    t.equal(result.get('beta'), 2, 'Map entry beta preserved');
    t.equal(result.size, 2, 'Map size correct');
  });
  it('Set is preserved as Set through realm.call()', async (t) => {
    type SetFn = (s: Set<string>) => Set<string>;
    const realm = new Realm<SetFn>({
      thread: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname
    });
    const input = new Set([
      'x',
      'y',
      'z'
    ]);
    const result = await realm.call(input);
    t.ok(result instanceof Set, 'result is a Set (not a plain object)');
    t.ok(result.has('x') && result.has('y') && result.has('z'), 'all Set entries present');
    t.equal(result.size, 3, 'Set size correct');
  });
  it('Error subclass name and message are preserved through realm.call()', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/type-error-fn.ts', import.meta.url).pathname
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
  it('terminate() stops a thread realm', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/long-running.ts', import.meta.url).pathname
    });
    const runPromise = realm.run();
    // Small delay to let the realm start.
    await new Promise<void>((res) => setTimeout(res, 10));
    realm.terminate();
    await runPromise;
    t.ok(true, 'thread realm terminated successfully');
  });
});
