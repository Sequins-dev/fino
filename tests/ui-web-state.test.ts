import { describe, it } from 'fino:test/test';
import { memoryStore, sqliteStore } from 'fino:store';
import {
  loadViewState,
  saveViewState,
  sweepViewState,
  viewStateHistory,
  type ViewSnapshot,
} from 'fino:ui/web/state';

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

describe('fino:ui/web/state', () => {
  it('clones in-memory snapshots and rejects stale CAS saves', async (t) => {
    const store = memoryStore();
    await saveViewState(store, snapshot());

    const loaded = await loadViewState(store, 'view-1');
    loaded!.data.items = ['mutated'];
    t.deepEqual(
      (await loadViewState(store, 'view-1'))!.data,
      { items: [] },
      'load returns a clone',
    );

    await saveViewState(
      store,
      { ...snapshot(), version: 1, data: { items: ['next'] } },
      { expectVersion: 0 },
    );
    await t.rejects(
      () => saveViewState(store, { ...snapshot(), version: 2 }, { expectVersion: 0 }),
      /version conflict/,
    );
  });

  it('persists head, history, and TTL sweep through sqliteStore', async (t) => {
    const store = await sqliteStore({ path: ':memory:' });
    const expired = snapshot({ viewId: 'expired', expiresAt: Date.now() - 1 });
    await saveViewState(store, snapshot({ version: 0 }));
    await saveViewState(store, snapshot({ version: 1, data: { items: ['saved'] } }), {
      expectVersion: 0,
    });
    await saveViewState(store, expired);

    t.equal((await loadViewState(store, 'view-1'))!.version, 1, 'head loads latest version');
    t.deepEqual(
      (await viewStateHistory(store, 'view-1')).map((entry) => entry.version),
      [1, 0],
      'history keeps versions newest first',
    );
    t.equal(await sweepViewState(store, Date.now()), 1, 'sweep deletes expired heads');
    t.equal(await loadViewState(store, 'expired'), null, 'expired snapshot is gone');
    await store.close();
  });

  it('rejects non-JSON snapshot data by key', async (t) => {
    const store = memoryStore();
    await t.rejects(() => saveViewState(store, snapshot({ data: { bad: undefined } })), /bad/);
  });
});
