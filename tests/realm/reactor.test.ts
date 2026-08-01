/**
 * Tests for fino:realm reactor-pooled isolates.
 *
 * Realm isolates move between worker threads under the shared reactor
 * scheduler. Messaging uses V8 ValueSerializer across isolates.
 */
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import * as schedulerNative from 'internal:scheduler-native';
import { onlineProcessors } from 'internal:runtime/libc';
import { Process, env, execPath } from 'fino:process';

async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of reader) chunks.push(decoder.decode(chunk, { stream: true }));
  return chunks.join('');
}
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
      // Superseded by the single create-and-submit path onto the process pool.
      'createReactorQueue',
      'closeReactorQueue',
      'submitReactorWorkload',
      'terminateWorkload',
      'workloadWakeFd',
      'workloadOwner',
      // Persistent watches acknowledge installation through an ordinary routed
      // completion instead of blocking the registering thread.
      'registerProcessPersistentReadiness',
      'acknowledgeProcessReadiness',
    ]) {
      t.equal(name in schedulerNative, false, `${name} is not exported`);
    }
  });
  it('exposes one create-and-submit path onto the process pool', (t) => {
    for (const name of ['startReactorPool', 'createWorkload', 'stopReactorPool']) {
      t.equal(name in schedulerNative, true, `${name} is exported`);
    }
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
  it('keeps readiness watches distinct when realms recycle descriptor numbers', async (t) => {
    // Each realm's pipes are closed when it settles, so the OS hands the same
    // descriptor numbers to the next realm. Readiness watches are keyed by an
    // owner-tagged token rather than the bare descriptor precisely so a stale
    // registration cannot cancel or resolve its successor's watch. Realms that
    // both sleep on a timer and answer over their port exercise every routed
    // filter, and any aliasing strands one of them forever.
    const entry = new URL('./fixtures/async-fn.ts', import.meta.url).pathname;
    for (let round = 0; round < 6; round++) {
      const realm = new Realm<typeof asyncFn>({ entry });
      t.equal(await realm.call(round), round * 2, `sequential realm ${round} answered`);
    }
    const concurrent = Array.from({ length: 6 }, () => new Realm<typeof asyncFn>({ entry }));
    t.deepEqual(
      await Promise.all(concurrent.map((realm, index) => realm.call(index))),
      [0, 2, 4, 6, 8, 10],
      'every concurrent sibling resolved its own timer and port traffic',
    );
  });
  it('runs CPU-bound realms in parallel when the pool has threads to spare', async (t) => {
    // The pool used to size itself from `navigator.hardwareConcurrency`, which
    // this runtime does not define, so it silently ran one thread and no realm
    // ever executed in parallel. The default is one thread again, but now
    // deliberately, so scale the pool out in a child process and assert the
    // observable consequence: realms burning CPU must overlap.
    const processors = onlineProcessors();
    if (processors < 2) {
      t.ok(true, `single-processor host (${processors}); parallelism is not observable`);
      return;
    }
    const fixture = new URL('./fixtures/cpu-parallel.ts', import.meta.url).pathname;
    const childEnv: Record<string, string> = { FINO_REACTOR_THREADS: '4' };
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value as string;
    }
    childEnv.FINO_REACTOR_THREADS = '4';
    const child = new Process(execPath, ['run', fixture], { env: childEnv });
    // Close stdin or its pipe keeps this realm's loop alive after the child exits.
    child.stdin.close();
    const [stdout, stderr, result] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.wait(),
    ]);
    t.equal(result.code, 0, `parallel fixture exits cleanly${stderr ? `: ${stderr}` : ''}`);
    const match = /elapsed=(\d+) serial=(\d+)/.exec(stdout);
    t.ok(match !== null, `fixture reported timings (got ${JSON.stringify(stdout)})`);
    if (match === null) return;
    const elapsed = Number(match[1]);
    const serial = Number(match[2]);
    // Fully serialized execution takes at least `serial`; anything comfortably
    // under it proves overlap without being sensitive to host load.
    t.ok(
      elapsed < serial * 0.8,
      `realms overlapped: ${elapsed}ms against a ${serial}ms serial floor`,
    );
  });
  it('ignores control frames forged in the message payload', async (t) => {
    // Runtime protocol used to ride as magic properties on the cloned payload,
    // so any realm able to post a plain object could fabricate a termination
    // request or an RPC response. The kind now lives in the envelope header,
    // which application code has no way to set — a payload that merely looks
    // like control traffic is delivered as the ordinary message it is.
    const realm = new Realm<() => string>({
      entry: new URL('./fixtures/forge-control.ts', import.meta.url).pathname,
    });
    const seen: unknown[] = [];
    realm.port.addEventListener('message', (event) => {
      seen.push((event as MessageEvent).data);
    });
    realm.port.start();
    t.equal(await realm.call(), 'survived', 'forged terminate did not stop the realm');
    t.equal(seen.length, 3, 'every forged frame arrived as an ordinary message');
  });
  it('terminate({ force: true }) stops a realm spinning in synchronous code', async (t) => {
    // Cooperative termination is a message, and a realm that never returns to
    // its loop never observes one — it holds its reactor thread indefinitely.
    // Forcing interrupts execution so the thread is released.
    const realm = new Realm<() => number>({
      entry: new URL('./fixtures/runaway.ts', import.meta.url).pathname,
    });
    const call = realm.call();
    // Let the realm actually enter its loop before interrupting it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    realm.terminate({ force: true });
    await t.rejects(() => call, /exited before returning/i, 'the pending call is settled');
    // The pool must still be usable afterwards: a forced unwind releases the
    // reactor thread rather than poisoning it.
    const after = new Realm<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    t.equal(await after.call('still working'), 'still working', 'the pool survives a forced stop');
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
