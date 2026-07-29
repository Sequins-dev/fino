import { describe, it } from 'fino:test/test';
import { Database } from 'fino:database';
import { DiskFileSystem } from 'fino:file';
import { DatabaseViewStore, InMemoryViewStore, type ViewSnapshot } from 'fino:ui/web/state';
import { viewStateStoreConformance } from './fixtures/ui-view-store-conformance.ts';

viewStateStoreConformance('InMemoryViewStore', async (options) => {
  return new InMemoryViewStore(options);
});

viewStateStoreConformance('DatabaseViewStore', async (options) => {
  return DatabaseViewStore.open(':memory:', options);
});

function snapshot(overrides: Partial<ViewSnapshot> = {}): ViewSnapshot {
  const now = Date.now();
  return {
    viewId: 'view-1',
    view: 'todos',
    version: 0,
    data: { items: [] },
    regions: {},
    applied: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

describe('fino:ui/web/state options', () => {
  it('rejects invalid retention and query limits', async (t) => {
    t.throws(() => new InMemoryViewStore({ historyLimit: -1 }), /historyLimit/);
    await t.rejects(
      () => DatabaseViewStore.open(':memory:', { historyLimit: 1.5 }),
      /historyLimit/,
    );
    const store = new InMemoryViewStore();
    await store.save(snapshot());
    await t.rejects(() => store.history('view-1', { limit: -1 }), /limit/);
    await t.rejects(() => store.compact('view-1', -1), /retain/);
  });

  it('rolls back the head when database history persistence fails', async (t) => {
    const path = `/tmp/fino-ui-state-${Math.floor(Math.random() * 1e9)}.db`;
    const fs = new DiskFileSystem();
    try {
      await fs.unlink(path);
    } catch {}
    const store = await DatabaseViewStore.open(path, { fs });
    try {
      await store.save(snapshot());
      const control = await Database.open(path, { fs });
      try {
        await control.exec(`CREATE TRIGGER fail_ui_history
          BEFORE INSERT ON ui_view_snapshot_history
          BEGIN
            SELECT RAISE(FAIL, 'forced history failure');
          END`);
      } finally {
        await control.close();
      }
      await t.rejects(
        () =>
          store.save(snapshot({ version: 1 }), {
            expectVersion: 0,
          }),
        /forced history failure/,
      );
      t.equal((await store.load('view-1'))?.version, 0, 'head update was rolled back');
      t.deepEqual(
        (await store.history('view-1')).map((entry) => entry.version),
        [0],
        'history remains consistent with the head',
      );
    } finally {
      await store.close();
      try {
        await fs.unlink(path);
      } catch {}
    }
  });
});
