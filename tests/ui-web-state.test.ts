import { describe, it } from 'fino:test/test';
import { InMemoryViewStore, DatabaseViewStore, type ViewSnapshot } from 'fino:ui/web/state';
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
    expiresAt: now + 6e4,
    ...overrides
  };
}
describe('fino:ui/web/state', () => {
  it('clones in-memory snapshots and rejects stale CAS saves', async (t) => {
    const store = new InMemoryViewStore();
    await store.save(snapshot());
    const loaded = await store.load('view-1');
    loaded!.data.items = ['mutated'];
    t.deepEqual((await store.load('view-1'))!.data, { items: [] }, 'load returns a clone');
    await store.save({
      ...snapshot(),
      version: 1,
      data: { items: ['next'] }
    }, { expectVersion: 0 });
    await t.rejects(() => store.save({
      ...snapshot(),
      version: 2
    }, { expectVersion: 0 }), /version conflict/);
  });
  it('persists head, history, and TTL sweep in DatabaseViewStore', async (t) => {
    const store = await DatabaseViewStore.open(':memory:');
    const expired = snapshot({
      viewId: 'expired',
      expiresAt: Date.now() - 1
    });
    await store.save(snapshot({ version: 0 }));
    await store.save(snapshot({
      version: 1,
      data: { items: ['saved'] }
    }), { expectVersion: 0 });
    await store.save(expired);
    t.equal((await store.load('view-1'))!.version, 1, 'head loads latest version');
    t.deepEqual((await store.history('view-1')).map((entry) => entry.version), [1, 0], 'history keeps versions newest first');
    t.equal(await store.sweep(Date.now()), 1, 'sweep deletes expired heads');
    t.equal(await store.load('expired'), null, 'expired snapshot is gone');
    await store.close();
  });
  it('rejects non-JSON snapshot data by key', async (t) => {
    const store = new InMemoryViewStore();
    await t.rejects(() => store.save(snapshot({ data: { bad: undefined } })), /bad/);
  });
});
