/**
 * Tests for fino:realm — Process Realm (process: true).
 *
 * Process realms run in a separate OS process. They provide hard crash
 * isolation: a child crash cannot corrupt the parent's heap. Messaging
 * uses framed binary over a Unix socketpair.
 */
import { describe, it } from 'fino:test/test';
import { Realm, ImportMap } from 'fino:realm';
import type echoFn from './fixtures/echo-fn.ts';
import type sumFn from './fixtures/multi-arg-fn.ts';
import type errorFn from './fixtures/error-fn.ts';
describe('Process Realm basics', () => {
  it('spawns a process realm that runs to completion', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/hello.ts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'process realm ran to completion');
  });
  it('call() invokes the default-export function in a process realm', async (t) => {
    const realm = new Realm<typeof echoFn>({
      process: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const result = await realm.call('hello from process');
    t.equal(result, 'hello from process', 'echo result matches input');
  });
  it('call() passes multiple arguments', async (t) => {
    const realm = new Realm<typeof sumFn>({
      process: true,
      entry: new URL('./fixtures/multi-arg-fn.ts', import.meta.url).pathname,
    });
    const result = await realm.call(10, 20, 30);
    t.equal(result, 60, 'sum of 10+20+30 is 60');
  });
  it('call() propagates errors from process realm', async (t) => {
    const realm = new Realm<typeof errorFn>({
      process: true,
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
  it('terminate() stops a process realm and cleans up', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/long-running.ts', import.meta.url).pathname,
    });
    const runPromise = realm.run();
    await new Promise<void>((res) => setTimeout(res, 10));
    realm.terminate();
    // run() must settle (resolves or rejects) — confirms the child is reaped
    try {
      await runPromise;
    } catch {}
    // Attempt a subsequent call on the terminated realm; must reject rather than hang.
    try {
      await realm.call();
      t.fail('call() on terminated realm should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'call() after terminate() rejects with Error');
    }
  });
  it('child process exit(1) surfaces as run() rejection', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/exit-nonzero.ts', import.meta.url).pathname,
    });
    try {
      await realm.run();
      t.fail('should have rejected on non-zero exit');
    } catch (err) {
      t.ok(err instanceof Error, 'run() rejects with Error on non-zero exit');
    }
  });
  it('top-level throw surfaces as run() rejection', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/throw-at-toplevel.ts', import.meta.url).pathname,
    });
    await t.rejects(
      () => realm.run(),
      /top-level|throw|Error/i,
      'run() rejects when child throws during module evaluation',
    );
  });
  it('terminate() is idempotent and later call rejects promptly', async (t) => {
    const realm = new Realm<typeof echoFn>({
      process: true,
      entry: new URL('./fixtures/long-running.ts', import.meta.url).pathname,
    });
    const running = realm.run();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    realm.terminate();
    realm.terminate();
    try {
      await running;
    } catch {}
    const callSettled = await Promise.race([
      realm.call('after-terminate').then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 2e3)),
    ]);
    t.equal(callSettled, 'rejected', 'call after terminate rejects promptly');
    t.ok(true, 'double terminate completed without throwing');
  });
});
describe('Process Realm — serialization of complex types over IPC', () => {
  it('call() round-trips a nested object', async (t) => {
    type Obj = {
      x: number;
      nested: {
        arr: number[];
        flag: boolean;
      };
    };
    const realm = new Realm<(o: Obj) => Obj>({
      process: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const input: Obj = {
      x: 42,
      nested: {
        arr: [1, 2, 3],
        flag: true,
      },
    };
    const result = await realm.call(input);
    t.equal(result.x, 42, 'top-level number survives IPC');
    t.equal(result.nested.arr[1], 2, 'nested array element survives IPC');
    t.equal(result.nested.flag, true, 'nested boolean survives IPC');
  });
  it('delivers a queued call result after the child exits', async (t) => {
    const realm = new Realm<typeof echoFn>({
      process: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const resultPromise = realm.call('queued-before-exit');
    const blockedUntil = performance.now() + 500;
    while (performance.now() < blockedUntil) {
      // Keep the parent isolate busy until the short-lived child has replied
      // and exited. Its queued reply must still be delivered before teardown.
    }
    t.equal(await resultPromise, 'queued-before-exit');
  });
  it('call() round-trips an ArrayBuffer', async (t) => {
    const realm = new Realm<(b: ArrayBuffer) => ArrayBuffer>({
      process: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const buf = new Uint8Array([222, 173, 190, 239]).buffer;
    const result = await realm.call(buf);
    const view = new Uint8Array(result as ArrayBuffer);
    t.equal(view[0], 222, 'first byte survives IPC');
    t.equal(view[3], 239, 'last byte survives IPC');
  });
});
describe('Process Realm call() + run() ordering', () => {
  it('run() resolves after call() has completed', async (t) => {
    const realm = new Realm<typeof echoFn>({
      process: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const runPromise = realm.run();
    const result = await realm.call('ordering-check');
    t.equal(result, 'ordering-check', 'call() returned the correct result');
    // run() should settle once the realm exits (after call completes)
    await runPromise;
    t.ok(true, 'run() resolved cleanly after call() completed');
  });
});
describe('Process Realm call() after realm has exited', () => {
  it('call() on an already-exited realm rejects rather than hanging', async (t) => {
    const realm = new Realm<typeof echoFn>({
      process: true,
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    // Complete one call so the realm runs and exits cleanly.
    const runPromise = realm.run();
    await realm.call('before-exit');
    await runPromise;
    // Now the realm has exited. A subsequent call should reject promptly.
    const settled = await Promise.race([
      realm.call('after-exit').then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<string>((res) => setTimeout(() => res('timeout'), 2e3)),
    ]);
    t.equal(settled, 'rejected', 'call() after realm exit rejects (does not hang)');
  });
});
describe('Process Realm import rules', () => {
  it('import rules are respected in the child process', async (t) => {
    const realm = new Realm({
      process: true,
      overrides: ImportMap.inherit([
        {
          pattern: 'fino:ffi',
          directive: 'block',
        },
      ]),
      entry: new URL('./fixtures/import-ffi.ts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'child process realm respected the block rule');
  });
});
