/**
 * Tests that Realm.run() rejects when a child realm's entry module throws at
 * top-level during evaluation (bootstrap/evaluation failure).
 */

import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';

const fixture = new URL('./fixtures/throw-at-toplevel.mts', import.meta.url).pathname;

describe('Realm bootstrap errors', () => {
  it('embedded realm: Realm.run() rejects on top-level throw', async (t) => {
    const realm = new Realm({ entry: fixture });
    try {
      await realm.run();
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok(
        (err as Error).message.includes('deliberate top-level error'),
        'error message propagated: ' + (err as Error).message,
      );
    }
  });

  it('thread realm: Realm.run() rejects on top-level throw', async (t) => {
    const realm = new Realm({ thread: true, entry: fixture });
    try {
      await realm.run();
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'thread realm rejects with Error on bootstrap throw');
    }
  });
});
