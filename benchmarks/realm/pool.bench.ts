/**
* Benchmarks for fino:realm/pool
*
* Run with: cargo run -- bench benchmarks/realm/pool.bench.ts
*/
import { correlationIdContext } from 'fino:realm/pool';
import { RealmPool } from 'fino:realm/pool';
import { bench } from 'fino:bench';
const fixtures = new URL('../../tests/realm/fixtures/', import.meta.url);
function fixture(name: string): string {
  return new URL(name, fixtures).pathname;
}
bench('realm pool context', (b) => {
  b.measure('correlation context get', () => correlationIdContext.get());
});
bench('realm pool calls', (b) => {
  b.measure('single worker warm batch', async () => {
    const pool = new RealmPool<(value: string) => string>({
      entry: fixture('echo-fn.ts'),
      size: 1
    });
    try {
      for (let i = 0; i < 16; i++) await pool.call(`task-${i}`);
    } finally {
      await pool.close();
    }
  });
  b.measure('two worker concurrent batch', async () => {
    const pool = new RealmPool<(value: string) => string>({
      entry: fixture('echo-fn.ts'),
      size: 2,
      timeout: 5e3
    });
    try {
      await Promise.all(Array.from({ length: 8 }, (_, i) => pool.call(`task-${i}`)));
    } finally {
      await pool.close();
    }
  });
});
bench('realm pool failure paths', (b) => {
  b.measure('per-call timeout cleanup', async () => {
    const pool = new RealmPool({
      entry: fixture('long-running.ts'),
      size: 1,
      timeout: 5,
      closeTimeout: 5
    });
    try {
      try {
        await pool.call();
      } catch {}
    } finally {
      await pool.close();
    }
  });
  b.measure('close drain timeout cleanup', async () => {
    const pool = new RealmPool({
      entry: fixture('never-fn.ts'),
      size: 1,
      timeout: 0,
      closeTimeout: 5
    });
    const pending = pool.call().catch(() => undefined);
    await pool.close();
    await pending;
  });
});
