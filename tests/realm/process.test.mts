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

  it('terminate() stops a process realm', async (t) => {
    const realm = new Realm({
      process: true,
      entry: new URL('./fixtures/long-running.mts', import.meta.url).pathname,
    });
    const runPromise = realm.run();
    await new Promise<void>((res) => setTimeout(res, 10));
    realm.terminate();
    await runPromise;
    t.ok(true, 'process realm terminated successfully');
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
