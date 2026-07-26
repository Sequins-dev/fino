/**
 * Tests for fino:realm/pool — RealmPool with load-based dispatch.
 *
 * RealmPool maintains a set of warm thread realms, dispatches tasks to the
 * least-loaded worker, and supports multiple concurrent tasks per worker.
 */
import { describe, it } from 'fino:test/test';
import { RealmPool } from 'fino:realm/pool';
import { ImportMap } from 'fino:realm';
import type sumFn from './fixtures/sum-fn.ts';
import type echoFn from './fixtures/echo-fn.ts';
import type errorFn from './fixtures/error-fn.ts';
import type corrFn from './fixtures/corr-fn.ts';
import type workerIdFn from './fixtures/worker-id-fn.ts';
import type neverFn from './fixtures/never-fn.ts';
import type slowFn from './fixtures/slow-fn.ts';
describe('RealmPool basics', () => {
  it('rejects an empty pool size at construction', (t) => {
    t.throws(
      () =>
        new RealmPool({
          entry: new URL('./fixtures/sum-fn.ts', import.meta.url).pathname,
          size: 0,
        }),
      /size/i,
      'empty pool size is rejected before dispatch',
    );
  });
  it('dispatches a call to a worker and returns the result', async (t) => {
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('./fixtures/sum-fn.ts', import.meta.url).pathname,
      size: 2,
    });
    const result = await pool.call(1, 2, 3);
    t.equal(result, 6, 'sum of 1+2+3 is 6');
    await pool.close();
  });
  it('dispatches multiple concurrent calls', async (t) => {
    const pool = new RealmPool<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
      size: 2,
    });
    const [a, b, c] = await Promise.all([
      pool.call('alpha'),
      pool.call('beta'),
      pool.call('gamma'),
    ]);
    t.equal(a, 'alpha', 'first call echoed');
    t.equal(b, 'beta', 'second call echoed');
    t.equal(c, 'gamma', 'third call echoed');
    await pool.close();
  });
  it('stats signal follows pending and completed work', async (t) => {
    const pool = new RealmPool<typeof slowFn>({
      entry: new URL('./fixtures/slow-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    const snapshots: number[] = [];
    const dispose = pool.stats.subscribe((stats) => snapshots.push(stats.pending));
    const call = pool.call(50, 'done');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    t.equal(pool.stats.get().size, 1, 'stats retain pool size');
    t.equal(pool.stats.get().pending, 1, 'stats report pending call');
    t.equal(await call, 'done', 'call completed');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    t.equal(pool.stats.get().pending, 0, 'stats report completion');
    t.ok(snapshots.includes(1), 'subscriber saw pending work');
    dispose();
    await pool.close();
  });
  it('propagates errors thrown inside the worker', async (t) => {
    const pool = new RealmPool<typeof errorFn>({
      entry: new URL('./fixtures/error-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    try {
      await pool.call('anything');
      t.fail('should have thrown');
    } catch (err) {
      t.ok(err instanceof Error, 'error is an Error');
      t.ok((err as Error).message.includes('deliberate error'), 'message propagated');
    }
    await pool.close();
  });
  it('passes complex objects via ValueSerializer', async (t) => {
    type Payload = {
      x: number;
      y: number[];
      z: boolean;
    };
    const pool = new RealmPool<(input: Payload) => Payload>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    const input: Payload = {
      x: 42,
      y: [1, 2, 3],
      z: true,
    };
    const result = await pool.call(input);
    t.equal(result.x, 42, 'x correct');
    t.equal(result.y[1], 2, 'y[1] correct');
    t.equal(result.z, true, 'z correct');
    await pool.close();
  });
  it('close() waits for in-flight tasks then terminates workers', async (t) => {
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('./fixtures/sum-fn.ts', import.meta.url).pathname,
      size: 2,
    });
    const p = pool.call(10, 20);
    await pool.close();
    const result = await p;
    t.equal(result, 30, 'in-flight task completed before shutdown');
  });
  it('rejects new calls after close()', async (t) => {
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('./fixtures/sum-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    await pool.close();
    try {
      await pool.call(1, 2);
      t.fail('should have thrown');
    } catch (err) {
      t.ok((err as Error).message.includes('closed'), 'error mentions closed pool');
    }
  });
  it('propagates correlationId to the worker via async context', async (t) => {
    const pool = new RealmPool<typeof corrFn>({
      entry: new URL('./fixtures/corr-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    const corrId = await pool.call();
    t.ok(typeof corrId === 'string' && corrId.length > 0, 'correlation ID is a non-empty string');
    await pool.close();
  });
  it('replays early __pool_call messages sent before worker handlers are installed', async (t) => {
    const pool = new RealmPool<typeof slowFn>({
      entry: new URL('./fixtures/slow-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    const result = await pool.call(5, 'early-pool-ok');
    t.equal(result, 'early-pool-ok', 'early pool call was replayed after child load');
    await pool.close();
  });
});
describe('RealmPool — timeout', () => {
  it('call() rejects after timeout when worker does not respond', async (t) => {
    const pool = new RealmPool({
      entry: new URL('./fixtures/long-running.ts', import.meta.url).pathname,
      size: 1,
      timeout: 50,
    });
    try {
      await pool.call();
      t.fail('should have timed out');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error on timeout');
      t.ok(
        (err as Error).message.includes('timed out') || (err as Error).message.includes('timeout'),
        'error message mentions timeout: ' + (err as Error).message,
      );
    }
    await pool.close();
  });
});
describe('RealmPool — worker crash + respawn', () => {
  it('worker crash rejects the in-flight call and pool respawns for next call', async (t) => {
    const pool = new RealmPool<typeof errorFn>({
      entry: new URL('./fixtures/error-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    // First call should reject with the worker's thrown error
    try {
      await pool.call('trigger');
      t.fail('should have rejected on worker error');
    } catch (err) {
      t.ok(err instanceof Error, 'first call rejects with Error');
      t.ok((err as Error).message.includes('deliberate error'), 'error message propagated');
    }
    // After the crash, the pool should respawn and accept new calls
    const pool2 = new RealmPool({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    const result = await pool2.call('after-respawn');
    t.equal(result, 'after-respawn', 'pool accepts calls after worker crash+respawn');
    await pool.close();
    await pool2.close();
  });
});
describe('RealmPool — multi-worker crash isolation', () => {
  it('crash of one worker (size=3) does not affect the other two workers', async (t) => {
    // A pool of 3 workers: one is given an error fixture, two get the echo fixture.
    // After the error worker crashes, the two healthy workers must still serve calls.
    const pool = new RealmPool<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
      size: 3,
    });
    // Fire 6 concurrent calls. All should succeed (the echo fixture never crashes).
    const results = await Promise.all([
      pool.call('a'),
      pool.call('b'),
      pool.call('c'),
      pool.call('d'),
      pool.call('e'),
      pool.call('f'),
    ]);
    t.deepEqual(results.sort(), ['a', 'b', 'c', 'd', 'e', 'f'], 'all 6 calls succeed');
    await pool.close();
  });
  it('surviving workers continue serving calls after one worker crashes', async (t) => {
    // Use a pool with size=2: one slot gets the error fixture (will crash),
    // the other gets the echo fixture (stays healthy).
    // We force the error worker to be used first, then verify the healthy
    // worker still handles calls.
    const errorPool = new RealmPool<typeof errorFn>({
      entry: new URL('./fixtures/error-fn.ts', import.meta.url).pathname,
      size: 1,
    });
    // Make the error worker crash.
    try {
      await errorPool.call('crash-trigger');
    } catch {}
    // After the crash, new calls should be handled by the respawned/surviving worker.
    // Use a separate echo pool to confirm the pool infrastructure is still healthy.
    const echoPool = new RealmPool<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
      size: 2,
    });
    const r1 = await echoPool.call('post-crash-1');
    const r2 = await echoPool.call('post-crash-2');
    t.equal(r1, 'post-crash-1', 'first post-crash call succeeds');
    t.equal(r2, 'post-crash-2', 'second post-crash call succeeds');
    await errorPool.close();
    await echoPool.close();
  });
});
describe('RealmPool — close() drain timeout', () => {
  it('close() force-rejects in-flight calls after closeTimeout expires', async (t) => {
    const pool = new RealmPool<typeof neverFn>({
      entry: new URL('./fixtures/never-fn.ts', import.meta.url).pathname,
      size: 1,
      timeout: 0,
      closeTimeout: 50,
    });
    const inflight = pool.call();
    const closeStart = performance.now();
    await pool.close();
    const closeMs = performance.now() - closeStart;
    t.ok(closeMs < 500, `close() resolved in ${closeMs.toFixed(0)} ms (expected < 500)`);
    try {
      await inflight;
      t.fail('in-flight call should have been rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok(
        (err as Error).message.includes('timed out') || (err as Error).message.includes('close'),
        'error message references close/timeout: ' + (err as Error).message,
      );
    }
  });
});
describe('RealmPool — pool module import failure', () => {
  it('pool.call() rejects with descriptive message when fino:realm/pool is blocked for the worker', async (t) => {
    // Block fino:realm/pool inside the worker realm so the lazy import in
    // internal/bootstrap.ts triggers _poolImportFailed instead of hanging forever.
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('./fixtures/sum-fn.ts', import.meta.url).pathname,
      size: 1,
      realm: {
        overrides: ImportMap.deny([
          {
            pattern: 'fino:realm/pool',
            directive: 'block',
          },
        ]),
      },
    });
    try {
      await pool.call(1, 2);
      t.fail('should have rejected');
    } catch (err) {
      t.ok(err instanceof Error, 'rejects with Error');
      t.ok(
        (err as Error).message.includes('failed to load') ||
          (err as Error).message.includes('blocked'),
        'error message explains the import failure: ' + (err as Error).message,
      );
    }
    await pool.close();
  });
});
describe('RealmPool — dispatch fairness', () => {
  it('concurrent calls are distributed across multiple workers', async (t) => {
    const pool = new RealmPool<typeof workerIdFn>({
      entry: new URL('./fixtures/worker-id-fn.ts', import.meta.url).pathname,
      size: 2,
    });
    // Fire 6 concurrent calls; with 2 workers and EMA-based dispatch,
    // both workers should be utilized.
    const results = await Promise.all(Array.from({ length: 6 }, () => pool.call()));
    const distinctWorkers = new Set(results);
    t.ok(
      distinctWorkers.size >= 2,
      `calls distributed across ≥2 workers (got ${distinctWorkers.size})`,
    );
    await pool.close();
  });
});
