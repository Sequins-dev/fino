/**
 * Tests for fino:realm — basic Realm construction and lifecycle.
 */
import { describe, it } from 'fino:test/test';
import { Realm, ImportMap, type RealmObservation } from 'fino:realm';
import { loopFd } from 'internal:runtime/loop';
import type realmDataFn from './fixtures/realm-data-fn.ts';
import type loopFdFn from './fixtures/loop-fd-fn.ts';
import { EnvelopeKind } from 'internal:realm/envelope';
describe('Realm lifecycle', () => {
  it('creates and runs a child realm that exits naturally', async (t) => {
    const frames: RealmObservation[] = [];
    const realm = new Realm({
      entry: new URL('./fixtures/hello.ts', import.meta.url).pathname,
      observe: { capture: 'snapshot', next: (frame) => frames.push(frame) },
    });
    await realm.run();
    t.ok(
      frames.some(
        (frame) =>
          frame.capture === 'snapshot' &&
          frame.kind === EnvelopeKind.Lifecycle &&
          (frame.value as { phase?: unknown }).phase === 'entry:loaded',
      ),
      'child lifecycle crossed the observed channel',
    );
    t.ok(
      frames.some(
        (frame) =>
          frame.capture === 'snapshot' &&
          frame.kind === EnvelopeKind.Lifecycle &&
          (frame.value as { phase?: unknown }).phase === 'exit',
      ),
      'run drains the ordered channel exit',
    );
  });
  it('uses the thread reactor directly for parent and child realms', async (t) => {
    const realm = new Realm<typeof loopFdFn>({
      entry: new URL('./fixtures/loop-fd-fn.ts', import.meta.url).pathname,
    });
    t.equal(await realm.call(), loopFd(), 'parent and child are peers on one backend');
  });
  it('disposes ambient handles after a one-shot call completes', async (t) => {
    const realm = Realm.fromSource<() => number>(`
      export default function callOnce() {
        setTimeout(() => {}, 30_000);
        return 42;
      }
    `);
    t.equal(await realm.call(), 42, 'call returns before the ambient timer');
    const outcome = await Promise.race([
      realm.run().then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ]);
    if (outcome === 'timeout') realm.terminate({ force: true });
    t.equal(outcome, 'done', 'completed call owns no remaining ambient loop work');
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
    const frames: RealmObservation[] = [];
    const realm = new Realm<typeof realmDataFn>({
      entry: new URL('./fixtures/realm-data-fn.ts', import.meta.url).pathname,
      data: { role: 'worker' },
      otlpEndpoint: 'http://collector.example:4318/base',
      observe: { capture: 'snapshot', next: (frame) => frames.push(frame) },
    });
    const raw = await realm.call();
    t.equal(raw, JSON.stringify({ role: 'worker' }), 'child sees only caller-provided data');
    t.ok(
      frames.some(
        (frame) =>
          frame.capture === 'snapshot' &&
          frame.kind === EnvelopeKind.Bootstrap &&
          (frame.value as { data?: unknown }).data === JSON.stringify({ role: 'worker' }),
      ),
      'initial data crossed the observed channel',
    );
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
