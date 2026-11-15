import { describe, it } from 'fino:test/test';
import { Realm, ImportMap } from 'fino:realm';

describe('descendant import policy', () => {
  for (const process of [false, true])
    it(`cannot regrant a parent-denied builtin through inherit (process=${process})`, async (t) => {
      using parent = Realm.fromSource(
        `
      import { Realm, ImportMap } from 'fino:realm';
      export default async function () {
        using child = Realm.fromSource(
          "export default async () => { try { await import('fino:ffi'); return true; } catch { return false; } };",
          { process: ${process}, overrides: ImportMap.inherit([]) },
        );
        return await child.call();
      }
    `,
        { overrides: ImportMap.inherit([{ pattern: 'fino:ffi', directive: 'block' }]) },
      );
      t.equal(await parent.call(), false, 'the child retains the parent denial');
    });
});
