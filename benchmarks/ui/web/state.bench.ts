/**
 * Benchmarks for fino:ui/web/state
 *
 * Run with: cargo run -- bench benchmarks/ui/web/state.bench.ts
 */
import { bench } from 'fino:bench';
import { InMemoryViewStore, ViewVersionConflictError, type ViewSnapshot } from 'fino:ui/web/state';

function snapshot(version: number): ViewSnapshot {
  const now = Date.now();
  return {
    viewId: 'bench-view',
    view: 'benchmark',
    version,
    data: { value: version },
    regions: { root: String(version) },
    applied: [],
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 60_000,
  };
}

const store = new InMemoryViewStore({ historyLimit: 32 });
let version = 0;
await store.save(snapshot(version));

bench('ui/web/state', (b) => {
  b.measure('bounded save + load', async () => {
    const previous = version;
    version++;
    await store.save(snapshot(version), { expectVersion: previous });
    await store.load('bench-view');
  });
  b.measure('history + stats', async () => {
    await store.history('bench-view', { limit: 8 });
    await store.stats();
  });
  b.measure('CAS conflict', async () => {
    try {
      await store.save(snapshot(version + 1), { expectVersion: version - 1 });
      throw new Error('stale CAS unexpectedly succeeded');
    } catch (error) {
      if (!(error instanceof ViewVersionConflictError)) throw error;
    }
  });
});
