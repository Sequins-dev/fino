/**
 * Tests for fino:realm — basic Realm construction and lifecycle.
 */
import { describe, it } from 'fino:test/test';
import { Realm, ImportMap } from 'fino:realm';
import type realmDataFn from './fixtures/realm-data-fn.ts';
describe('Realm lifecycle', () => {
  it('creates and runs a child realm that exits naturally', async (t) => {
    const realm = new Realm({ entry: new URL('./fixtures/hello.ts', import.meta.url).pathname });
    await realm.run();
    t.ok(true, 'child realm exited');
  });
  it('realm.terminate() stops a long-running realm', async (t) => {
    const realm = new Realm({
      entry: new URL('./fixtures/long-running.ts', import.meta.url).pathname,
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
        entry: new URL('./fixtures/long-running.ts', import.meta.url).pathname,
      });
      p = realm.run();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await p;
    t.ok(true, 'disposed realm resolved');
  });
  it('keeps RealmOptions.data separate from OTLP endpoint metadata', async (t) => {
    const realm = new Realm<typeof realmDataFn>({
      thread: true,
      entry: new URL('./fixtures/realm-data-fn.ts', import.meta.url).pathname,
      data: { role: 'worker' },
      otlpEndpoint: 'http://collector.example:4318/base',
    });
    const raw = await realm.call();
    t.equal(raw, JSON.stringify({ role: 'worker' }), 'child sees only caller-provided data');
  });
  it('rejects empty Realm OTLP endpoints', (t) => {
    t.throws(
      () =>
        new Realm({
          entry: new URL('./fixtures/hello.ts', import.meta.url).pathname,
          otlpEndpoint: '',
        }),
      /otlpEndpoint must be a non-empty string/,
      'empty endpoint is rejected',
    );
  });
});
describe('Realm.fromSource', () => {
  it('runs source with static imports and top-level await', async (t) => {
    const realm = Realm.fromSource(`
      import { basename } from 'fino:file/path';

      const name = basename('/tmp/source-entry.ts');
      await Promise.resolve();
      if (name !== 'source-entry.ts') throw new Error('bad basename: ' + name);
    `);
    await realm.run();
    t.ok(true, 'source entry ran as a module');
  });
  it('supports mixed value and type imports', async (t) => {
    const realm = Realm.fromSource(`
      import { Realm } from 'fino:realm';
      import type { RealmOptions } from 'fino:realm';

      const opts: Pick<RealmOptions, 'entry'> = { entry: 'virtual.ts' };
      if (typeof Realm !== 'function') throw new Error('missing Realm value');
      if (opts.entry !== 'virtual.ts') throw new Error('type import was not erased');
    `);
    await realm.run();
    t.ok(true, 'mixed imports compiled and executed');
  });
  it('rejects on top-level runtime error', async (t) => {
    const realm = Realm.fromSource(`throw new Error('source failed');`);
    await t.rejects(() => realm.run(), /source failed/, 'run rejects with the source error');
  });
  it('works with an explicit specifier', async (t) => {
    const realm = Realm.fromSource(
      `import sum from './sum-fn.ts';
       if (sum(20, 22) !== 42) throw new Error('bad sum');`,
      { specifier: new URL('./fixtures/source-entry.ts', import.meta.url).pathname },
    );
    await realm.run();
    t.ok(true, 'explicit specifier provides a relative import base');
  });
  it('preserves caller overrides while adding the source entry rule', async (t) => {
    const realm = Realm.fromSource(
      `import { marker } from 'virtual:dep';
       if (marker !== 'ok') throw new Error('bad marker');`,
      {
        overrides: ImportMap.deny([
          {
            pattern: 'virtual:dep',
            directive: {
              type: 'source',
              code: `export const marker = 'ok';`,
              source_map: '',
            },
          },
        ]),
      },
    );
    await realm.run();
    t.ok(true, 'caller import rules and source entry rule both applied');
  });
});
