/**
 * Tests for RealmPool exclusive mode — one task per worker run.
 */
import { describe, it } from 'fino:test/test';
import { RealmPool } from 'fino:realm/pool';
import type instanceIdFn from './fixtures/instance-id-fn.ts';
import type neverFn from './fixtures/never-fn.ts';
import type sumFn from './fixtures/sum-fn.ts';

function fixture(name: string): string {
  return new URL(`./fixtures/${name}`, import.meta.url).pathname;
}

describe('RealmPool exclusive mode', () => {
  it('rejects maxQueue without exclusive', (t) => {
    t.throws(
      () =>
        new RealmPool({
          entry: fixture('sum-fn.ts'),
          maxQueue: 1,
        }),
      /maxQueue requires exclusive/,
      'maxQueue without exclusive is a construction error',
    );
  });
  it('serializes concurrent calls on a single worker', async (t) => {
    const pool = new RealmPool<typeof instanceIdFn>({
      entry: fixture('instance-id-fn.ts'),
      size: 1,
      exclusive: true,
    });
    try {
      const [a, b] = await Promise.all([pool.call(60), pool.call(60)]);
      t.ok(
        b!.start >= a!.end || a!.start >= b!.end,
        'second call started only after the first finished',
      );
    } finally {
      await pool.close();
    }
  });
  it('recycles the worker after every call', async (t) => {
    const pool = new RealmPool<typeof instanceIdFn>({
      entry: fixture('instance-id-fn.ts'),
      size: 1,
      exclusive: true,
    });
    try {
      const first = await pool.call(0);
      const second = await pool.call(0);
      t.ok(first.id !== second.id, 'each call ran in a fresh realm instance');
    } finally {
      await pool.close();
    }
  });
  it('reuses the worker across calls in default mode', async (t) => {
    const pool = new RealmPool<typeof instanceIdFn>({
      entry: fixture('instance-id-fn.ts'),
      size: 1,
    });
    try {
      const first = await pool.call(0);
      const second = await pool.call(0);
      t.equal(first.id, second.id, 'default mode keeps the same realm instance');
    } finally {
      await pool.close();
    }
  });
  it('rejects fast when the queue is full', async (t) => {
    const pool = new RealmPool<typeof instanceIdFn>({
      entry: fixture('instance-id-fn.ts'),
      size: 1,
      exclusive: true,
      maxQueue: 1,
    });
    try {
      const running = pool.call(80);
      const queuedCall = pool.call(0);
      await t.rejects(
        () => pool.call(0),
        /queue is full \(maxQueue=1\)/,
        'third concurrent call rejects',
      );
      await Promise.all([running, queuedCall]);
      t.ok(true, 'running and queued calls still complete');
    } finally {
      await pool.close();
    }
  });
  it('frees the worker after a timeout by recycling it', async (t) => {
    const pool = new RealmPool<typeof neverFn>({
      entry: fixture('never-fn.ts'),
      size: 1,
      exclusive: true,
      timeout: 150,
    });
    try {
      await t.rejects(() => pool.call(), /timed out after 150ms/, 'stuck call rejects on timeout');
      // The recycled slot must accept new work; never-fn never resolves, so
      // reaching a second timeout (rather than queue starvation) proves the
      // slot was freed and the call was dispatched.
      const started = performance.now();
      await t.rejects(
        () => pool.call(),
        /timed out after 150ms/,
        'recycled worker accepted the next call',
      );
      t.ok(performance.now() - started < 5000, 'second call dispatched promptly after recycle');
    } finally {
      await pool.close();
    }
  });
  it('close() rejects queued calls', async (t) => {
    const pool = new RealmPool<typeof instanceIdFn>({
      entry: fixture('instance-id-fn.ts'),
      size: 1,
      exclusive: true,
    });
    const running = pool.call(150);
    const queuedCall = pool.call(0);
    t.equal(pool.queued, 1, 'one call is waiting for a worker');
    const closing = pool.close();
    await t.rejects(() => queuedCall, /RealmPool is closed/, 'queued call rejects on close');
    await running;
    await closing;
    t.ok(true, 'in-flight call settled and close completed');
  });
});
