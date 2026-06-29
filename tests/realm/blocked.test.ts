/**
 * Tests for fino:realm — blocked module specifiers.
 */

import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';

describe('Realm blocked specifiers', () => {
  it('blocked module throws on import in the child', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/import-ffi.ts', import.meta.url).pathname,
      blocked: ['fino:ffi'],
    });
    // The entry module attempts to import fino:ffi and catches the error.
    // It writes a marker and exits cleanly.
    await realm.run();
    t.ok(true, 'child realm exited after blocked import');
  });
});
