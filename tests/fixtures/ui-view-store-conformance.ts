import { describe, it } from 'fino:test/test';
import {
  ViewVersionConflictError,
  type ViewSnapshot,
  type ViewStateStore,
  type ViewStateStoreOptions,
} from 'fino:ui/web/state';

interface ConformanceStore extends ViewStateStore {
  close?(): Promise<void>;
}

type StoreFactory = (options?: ViewStateStoreOptions) => Promise<ConformanceStore>;

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

async function usingStore<T>(
  factory: StoreFactory,
  options: ViewStateStoreOptions | undefined,
  fn: (store: ConformanceStore) => Promise<T>,
): Promise<T> {
  const store = await factory(options);
  try {
    return await fn(store);
  } finally {
    await store.close?.();
  }
}

/**
 * Register the reusable behavior contract for one `ViewStateStore` provider.
 */
export function viewStateStoreConformance(name: string, factory: StoreFactory): void {
  describe(`${name} ViewStateStore conformance`, () => {
    it('clones values and admits only one concurrent compare-and-swap winner', async (t) => {
      await usingStore(factory, undefined, async (store) => {
        await store.save(snapshot());
        const loaded = await store.load('view-1');
        loaded!.data.items = ['mutated'];
        t.deepEqual((await store.load('view-1'))!.data, { items: [] });

        const attempts = await Promise.allSettled([
          store.save(snapshot({ version: 1, data: { winner: 'a' } }), {
            expectVersion: 0,
          }),
          store.save(snapshot({ version: 1, data: { winner: 'b' } }), {
            expectVersion: 0,
          }),
        ]);
        t.equal(
          attempts.filter((attempt) => attempt.status === 'fulfilled').length,
          1,
          'exactly one CAS save succeeds',
        );
        const rejection = attempts.find((attempt) => attempt.status === 'rejected');
        t.ok(
          rejection?.status === 'rejected' && rejection.reason instanceof ViewVersionConflictError,
          'the loser receives the shared conflict error',
        );
        t.equal((await store.load('view-1'))?.version, 1);
      });
    });

    it('bounds history on save and supports explicit compaction', async (t) => {
      await usingStore(factory, { historyLimit: 2 }, async (store) => {
        for (let version = 0; version < 4; version++) await store.save(snapshot({ version }));

        t.deepEqual(
          (await store.history('view-1')).map((entry) => entry.version),
          [3, 2],
        );
        t.deepEqual(await store.stats(), {
          heads: 1,
          history: 2,
          expired: 0,
        });
        t.equal(await store.compact('view-1', 1), 1);
        t.deepEqual(
          (await store.history('view-1')).map((entry) => entry.version),
          [3],
        );
      });
    });

    it('does not partially change a head or history after validation failure', async (t) => {
      await usingStore(factory, undefined, async (store) => {
        await store.save(snapshot());
        await t.rejects(
          () =>
            store.save(
              snapshot({
                version: 1,
                data: { bad: undefined },
              }),
              { expectVersion: 0 },
            ),
          /bad/,
        );
        t.equal((await store.load('view-1'))?.version, 0);
        t.deepEqual(
          (await store.history('view-1')).map((entry) => entry.version),
          [0],
        );
      });
    });

    it('deletes expired heads with history and reports operational counts', async (t) => {
      await usingStore(factory, undefined, async (store) => {
        const now = Date.now();
        await store.save(snapshot({ viewId: 'active', expiresAt: now + 60_000 }));
        await store.save(snapshot({ viewId: 'expired', expiresAt: now - 1 }));
        t.deepEqual(await store.stats(now), {
          heads: 2,
          history: 2,
          expired: 1,
        });
        t.equal(await store.sweep(now), 1);
        t.deepEqual(await store.stats(now), {
          heads: 1,
          history: 1,
          expired: 0,
        });
        await store.delete('active');
        t.deepEqual(await store.stats(now), {
          heads: 0,
          history: 0,
          expired: 0,
        });
      });
    });
  });
}
