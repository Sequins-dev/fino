/**
 * Tests for fino:realm — Process Realm (process: true).
 *
 * Process realms run in a separate OS process. They provide hard crash
 * isolation: a child crash cannot corrupt the parent's heap. Messaging
 * uses framed binary over a Unix socketpair.
 */

import { describe, it } from 'fino:test/test';
import { Realm, ImportMap } from 'fino:realm';

import type echoFn from './fixtures/echo-fn.mts';
import type sumFn from './fixtures/multi-arg-fn.mts';
import type errorFn from './fixtures/error-fn.mts';

describe('Process Realm basics', () => {
  it('spawns a process realm that runs to completion', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/hello.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'process realm ran to completion');
  });

  it('call() invokes the default-export function in a process realm', async (t) => {
    const realm = new Realm<typeof echoFn>({
      process: true,
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call('hello from process');
    t.equal(result, 'hello from process', 'echo result matches input');
  });

  it('call() passes multiple arguments', async (t) => {
    const realm = new Realm<typeof sumFn>({
      process: true,
      entry: new URL('./fixtures/multi-arg-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call(10, 20, 30);
    t.equal(result, 60, 'sum of 10+20+30 is 60');
  });

  it('call() propagates errors from process realm', async (t) => {
    const realm = new Realm<typeof errorFn>({
      process: true,
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

  it('terminate() stops a process realm and cleans up', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/long-running.mts', import.meta.url).pathname,
    });
    const runPromise = realm.run();
    await new Promise<void>((res) => setTimeout(res, 10));
    realm.terminate();
    // run() must settle (resolves or rejects) — confirms the child is reaped
    try {
      await runPromise;
    } catch {
      // Termination may cause a non-zero exit; either outcome is acceptable.
    }
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
      entry: new URL('./fixtures/exit-nonzero.mts', import.meta.url).pathname,
    });
    try {
      await realm.run();
      t.fail('should have rejected on non-zero exit');
    } catch (err) {
      t.ok(err instanceof Error, 'run() rejects with Error on non-zero exit');
    }
  });
});

describe('Process Realm — serialization of complex types over IPC', () => {
  it('call() round-trips a nested object', async (t) => {
    type Obj = { x: number; nested: { arr: number[]; flag: boolean } };
    const realm = new Realm<(o: Obj) => Obj>({
      process: true,
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const input: Obj = { x: 42, nested: { arr: [1, 2, 3], flag: true } };
    const result = await realm.call(input);
    t.equal(result.x, 42, 'top-level number survives IPC');
    t.equal(result.nested.arr[1], 2, 'nested array element survives IPC');
    t.equal(result.nested.flag, true, 'nested boolean survives IPC');
  });

  it('call() round-trips an ArrayBuffer', async (t) => {
    const realm = new Realm<(b: ArrayBuffer) => ArrayBuffer>({
      process: true,
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    const result = await realm.call(buf);
    const view = new Uint8Array(result as ArrayBuffer);
    t.equal(view[0], 0xde, 'first byte survives IPC');
    t.equal(view[3], 0xef, 'last byte survives IPC');
  });
});

describe('Process Realm call() + run() ordering', () => {
  it('run() resolves after call() has completed', async (t) => {
    const realm = new Realm<typeof echoFn>({
      process: true,
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
    });
    const runPromise = realm.run();
    const result = await realm.call('ordering-check');
    t.equal(result, 'ordering-check', 'call() returned the correct result');
    // run() should settle once the realm exits (after call completes)
    await runPromise;
    t.ok(true, 'run() resolved cleanly after call() completed');
  });
});

describe('Process Realm import rules', () => {
  it('import rules are respected in the child process', async (t) => {
    const realm = new Realm({
      process: true,
      overrides: ImportMap.inherit([
        { pattern: 'fino:ffi', directive: 'block' },
      ]),
      entry: new URL('./fixtures/import-ffi.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'child process realm respected the block rule');
  });
});
