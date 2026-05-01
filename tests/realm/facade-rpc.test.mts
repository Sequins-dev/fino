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
import { Realm, Facade, ImportMap } from 'fino:realm';
import type facadeCallFn from './fixtures/facade-call.mts';
import type facadeUnknownFn from './fixtures/facade-unknown-method.mts';

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
