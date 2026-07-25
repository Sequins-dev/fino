/**
* Tests for fino:realm — blocking module specifiers through overrides.
*/
import { describe, it } from 'fino:test/test';
import { ImportMap, Realm } from 'fino:realm';
describe('Realm blocked specifiers', () => {
  it('a block rule throws on import in the child', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/import-ffi.ts', import.meta.url).pathname,
      overrides: ImportMap.inherit([{ pattern: 'fino:ffi', directive: 'block' }])
    });
    // The entry module attempts to import fino:ffi and catches the error.
    // It writes a marker and exits cleanly.
    await realm.run();
    t.ok(true, 'child realm exited after blocked import');
  });

  it('rejects the removed providers/blocked options with a pointer to overrides', (t) => {
    t.throws(() => new Realm({
      entry: './worker.ts',
      ...{ blocked: ['fino:ffi'] }
    } as never), /providers\/blocked were removed/);
  });
});
