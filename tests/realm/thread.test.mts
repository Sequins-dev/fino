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
import type echoFn from './fixtures/echo-fn.mts';
import type sumFn from './fixtures/multi-arg-fn.mts';
import type errorFn from './fixtures/error-fn.mts';

describe('Thread Realm basics', () => {
  it('spawns a thread realm that runs to completion', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/hello.mts', import.meta.url).pathname,
    });
    // hello.mts has no default function — it completes after module evaluation.
    await realm.run();
    t.ok(true, 'thread realm ran to completion');
  });

  it('call() invokes the default-export function in a thread realm', async (t) => {
    const realm = new Realm<typeof echoFn>({
      thread: true,
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call('hello from thread');
    t.equal(result, 'hello from thread', 'echo result matches input');
  });

  it('call() passes multiple arguments to the thread realm function', async (t) => {
    const realm = new Realm<typeof sumFn>({
      thread: true,
      entry: new URL('./fixtures/multi-arg-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call(1, 2, 3, 4);
    t.equal(result, 10, 'sum of 1+2+3+4 is 10');
  });

  it('call() propagates errors thrown inside the thread realm', async (t) => {
    const realm = new Realm<typeof errorFn>({
      thread: true,
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

  it('call() passes complex objects through ValueSerializer', async (t) => {
    type Payload = { x: number; y: number[]; z: boolean };
    const realm = new Realm<(input: Payload) => Payload>({
      thread: true,
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const input: Payload = { x: 1, y: [2, 3], z: true };
    const result = await realm.call(input);
    t.ok(typeof result === 'object' && result !== null, 'result is an object');
    t.equal(result.x, 1, 'x correct');
    t.equal(result.y[0], 2, 'y[0] correct');
    t.equal(result.z, true, 'z correct');
  });

  it('terminate() stops a thread realm', async (t) => {
    const realm = new Realm({
      thread: true,
      entry: new URL('./fixtures/long-running.mts', import.meta.url).pathname,
    });
    const runPromise = realm.run();
    // Small delay to let the realm start.
    await new Promise<void>((res) => setTimeout(res, 10));
    realm.terminate();
    await runPromise;
    t.ok(true, 'thread realm terminated successfully');
  });
});
