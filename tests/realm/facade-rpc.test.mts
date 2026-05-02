/**
 * Tests for the Facade RPC mechanism.
 *
 * Facades let a parent-realm implement an interface that child realms call.
 * The call is forwarded via `internal:parent-rpc` and settled when the
 * parent's handler returns.
 *
 * These tests cover thread-realm facades; process realm facades follow
 * the same path through a different transport.
 */

import { describe, it } from 'fino:test/test';
import { Realm, Facade, FacadeHandle, ImportMap } from 'fino:realm';
import type facadeCallFn from './fixtures/facade-call.mts';
import type facadeUnknownFn from './fixtures/facade-unknown-method.mts';
import type facadeStreamFn from './fixtures/facade-stream-fn.mts';
import type facadeStreamErrorFn from './fixtures/facade-stream-error-fn.mts';
import type facadeHandleFn from './fixtures/facade-handle-fn.mts';
import type facadeSinkFn from './fixtures/facade-sink-fn.mts';

describe('Facade RPC — thread realm', () => {
  it('basic call-response round-trip', async (t) => {
    const facade = new Facade('test:facade', ['greet'])
      .handle('greet', async (name) => `hello ${name}`);

    const realm = new Realm<typeof facadeCallFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-call.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.equal(result, 'hello world', 'facade returned expected greeting');
  });

  it('handler that throws causes call() to reject', async (t) => {
    const facade = new Facade('test:facade', ['greet'])
      .handle('greet', async () => { throw new Error('handler exploded'); });

    const realm = new Realm<typeof facadeCallFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-call.mts', import.meta.url).pathname,
    });
    try {
      await realm.call();
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok(
        (err as Error).message.includes('handler exploded'),
        'error message propagated: ' + (err as Error).message,
      );
    }
  });

  it('calling an unknown method rejects', async (t) => {
    const facade = new Facade('test:facade', ['greet', 'unknownMethod'])
      .handle('greet', async () => 'hi');
    // Note: 'unknownMethod' is in exports but has no handler registered

    const realm = new Realm<typeof facadeUnknownFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-unknown-method.mts', import.meta.url).pathname,
    });
    try {
      await realm.call();
      t.fail('should have rejected for unknown method');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok(
        (err as Error).message.toLowerCase().includes('unknown') ||
        (err as Error).message.toLowerCase().includes('method') ||
        (err as Error).message.toLowerCase().includes('handler'),
        'error message indicates unknown/missing method: ' + (err as Error).message,
      );
    }
  });

  it('streaming handler delivers chunks in order', async (t) => {
    const facade = new Facade('test:facade', [])
      .stream('chunks', async function* () {
        yield 'alpha';
        yield 'beta';
        yield 'gamma';
      });

    const realm = new Realm<typeof facadeStreamFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-stream-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call() as unknown[];
    t.deepEqual(result, ['alpha', 'beta', 'gamma'], 'all chunks delivered in order');
  });

  it('streaming handler that throws propagates the error', async (t) => {
    const facade = new Facade('test:facade', [])
      .stream('failingChunks', async function* () {
        yield 'first';
        throw new Error('stream exploded');
      });

    const realm = new Realm<typeof facadeStreamErrorFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-stream-error-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call() as { ok: boolean; message: string; collected: unknown[] };
    t.equal(result.ok, false, 'error was caught');
    t.deepEqual(result.collected, ['first'], 'first chunk was received before error');
    t.ok(result.message.includes('stream exploded'), 'error message propagated: ' + result.message);
  });

  it('empty streaming handler ends immediately', async (t) => {
    const facade = new Facade('test:facade', [])
      .stream('chunks', async function* () {
        // yield nothing
      });

    const realm = new Realm<typeof facadeStreamFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-stream-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call() as unknown[];
    t.deepEqual(result, [], 'empty stream returns empty array');
  });

  it('Facade.from() wraps object methods', async (t) => {
    const service = {
      async greet(name: unknown) { return `greetings ${name}`; },
    };
    const facade = Facade.from(service, { specifier: 'test:facade' });

    const realm = new Realm<typeof facadeCallFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-call.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.equal(result, 'greetings world', 'Facade.from wraps method correctly');
  });
});

// ---------------------------------------------------------------------------
// C2 — embedded realm (same V8 isolate, MessagePort transport)
// ---------------------------------------------------------------------------

describe('Facade RPC — embedded realm', () => {
  it('basic call-response round-trip via IntraPort', async (t) => {
    const facade = new Facade('test:facade', ['greet'])
      .handle('greet', async (name) => `hello ${name}`);

    const realm = new Realm<typeof facadeCallFn>({
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-call.mts', import.meta.url).pathname,
    });
    const result = await realm.call();
    t.equal(result, 'hello world', 'embedded realm facade returned correct greeting');
  });

  it('handler error propagates through embedded realm facade', async (t) => {
    const facade = new Facade('test:facade', ['greet'])
      .handle('greet', async () => { throw new Error('embedded boom'); });

    const realm = new Realm<typeof facadeCallFn>({
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-call.mts', import.meta.url).pathname,
    });
    try {
      await realm.call();
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok((err as Error).message.includes('embedded boom'), 'error message propagated');
    }
  });

  it('streaming handler delivers chunks via IntraPort', async (t) => {
    const facade = new Facade('test:facade', [])
      .stream('chunks', async function* () {
        yield 'one';
        yield 'two';
        yield 'three';
      });

    const realm = new Realm<typeof facadeStreamFn>({
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-stream-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call() as unknown[];
    t.deepEqual(result, ['one', 'two', 'three'], 'all chunks delivered via IntraPort');
  });
});

// ---------------------------------------------------------------------------
// FacadeHandle — stateful handle protocol
// ---------------------------------------------------------------------------

describe('Facade RPC — FacadeHandle (thread realm)', () => {
  it('handle with scalar and streaming methods round-trips correctly', async (t) => {
    const facade = new Facade('test:facade', ['openHandle'])
      .handle('openHandle', async (key: unknown) => {
        return new FacadeHandle(
          {
            getValue: async () => `value-for-${key}`,
            close:    async () => undefined,
          },
          {
            readChunks: async function* (n: unknown) {
              for (let i = 0; i < (n as number); i++) yield `chunk-${i}`;
            },
          },
        );
      });

    const realm = new Realm<typeof facadeHandleFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-handle-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call() as { value: string; chunks: string[] };
    t.equal(result.value, 'value-for-my-key', 'scalar handle method returned correct value');
    t.deepEqual(result.chunks, ['chunk-0', 'chunk-1', 'chunk-2'], 'streaming handle method yielded 3 chunks');
  });

  it('handle scalar method error propagates', async (t) => {
    const facade = new Facade('test:facade', ['openHandle'])
      .handle('openHandle', async () => {
        return new FacadeHandle({
          getValue: async () => { throw new Error('handle getValue failed'); },
          close:    async () => undefined,
        }, {
          readChunks: async function* () { yield 'x'; },
        });
      });

    const realm = new Realm<typeof facadeHandleFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-handle-fn.mts', import.meta.url).pathname,
    });
    try {
      await realm.call();
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok((err as Error).message.includes('handle getValue failed'), 'error message propagated');
    }
  });

  it('handle method error propagates if called on non-existent method', async (t) => {
    // The handle has no getValue method — calling it should reject.
    const facade = new Facade('test:facade', ['openHandle'])
      .handle('openHandle', async () => {
        return new FacadeHandle({
          // no getValue, no close — fixture will get errors
        }, {
          readChunks: async function* () {},
        });
      });

    const realm = new Realm<typeof facadeHandleFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-handle-fn.mts', import.meta.url).pathname,
    });
    try {
      await realm.call();
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error on missing handle method');
      t.ok(
        (err as Error).message.includes('getValue') || (err as Error).message.includes('method'),
        'error mentions missing method: ' + (err as Error).message,
      );
    }
  });
});


// ---------------------------------------------------------------------------
// callSink — write stream (child→parent, QUIC client-initiated stream model)
// ---------------------------------------------------------------------------

describe('Facade RPC — callSink / sendStream (thread realm)', () => {
  it('sink delivers all chunks to the parent handler without per-chunk ack', async (t) => {
    const received: string[] = [];
    const facade = new Facade('test:facade', [])
      .sendStream('writeChunks', async (_args, source) => {
        for await (const chunk of source) received.push(chunk as string);
        return { chunks: received.length, joined: received.join('') };
      });

    const realm = new Realm<typeof facadeSinkFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-sink-fn.mts', import.meta.url).pathname,
    });
    const result = await realm.call() as { chunks: number; joined: string };
    t.equal(result.chunks, 3, '3 chunks received by parent handler');
    t.equal(result.joined, 'hello world!', 'chunks arrived in order, joined correctly');
  });

  it('sink handler error rejects sink.result', async (t) => {
    const facade = new Facade('test:facade', [])
      .sendStream('writeChunks', async (_args, _source) => {
        throw new Error('sink handler failed');
      });

    const realm = new Realm<typeof facadeSinkFn>({
      thread: true,
      overrides: ImportMap.deny([
        { pattern: 'fino:runtime/loop', directive: 'inherit' },
        { pattern: 'test:facade', directive: facade.toDirective() },
      ]),
      entry: new URL('./fixtures/facade-sink-fn.mts', import.meta.url).pathname,
    });
    try {
      await realm.call();
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok((err as Error).message.includes('sink handler failed'), 'error message propagated');
    }
  });
});
