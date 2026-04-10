/**
 * Tests for fino:realm — basic Realm construction and lifecycle.
 */

import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';

describe('Realm lifecycle', () => {
  it('creates and runs a child realm that exits naturally', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/hello.mts', import.meta.url).pathname,
    });
    await realm.run();
    t.ok(true, 'child realm exited');
  });

  it('realm.terminate() stops a long-running realm', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/long-running.mts', import.meta.url).pathname,
    });
    const p = realm.run();
    // Give it a tick to start, then terminate.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    realm.terminate();
    await p;
    t.ok(true, 'terminated child realm resolved');
  });

  it('[Symbol.dispose] terminates the realm', async (t) => {
    let p: Promise<void>;
    {
      using realm = new Realm({
        entry: new URL('./fixtures/long-running.mts', import.meta.url).pathname,
      });
      p = realm.run();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await p;
    t.ok(true, 'disposed realm resolved');
  });
});
