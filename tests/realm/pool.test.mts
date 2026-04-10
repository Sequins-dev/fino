/**
 * Tests for fino:realm/pool — RealmPool with load-based dispatch.
 *
 * RealmPool maintains a set of warm thread realms, dispatches tasks to the
 * least-loaded worker, and supports multiple concurrent tasks per worker.
 */

import { describe, it } from 'fino:test/test';
import { RealmPool } from 'fino:realm/pool';

import type sumFn from './fixtures/sum-fn.mts';
import type echoFn from './fixtures/echo-fn.mts';
import type errorFn from './fixtures/error-fn.mts';
import type corrFn from './fixtures/corr-fn.mts';

describe('RealmPool basics', () => {
  it('dispatches a call to a worker and returns the result', async (t) => {
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('./fixtures/sum-fn.mts', import.meta.url).pathname,
      size: 2,
    });
    const result = await pool.call(1, 2, 3);
    t.equal(result, 6, 'sum of 1+2+3 is 6');
    await pool.close();
  });

  it('dispatches multiple concurrent calls', async (t) => {
    const pool = new RealmPool<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
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

  it('propagates errors thrown inside the worker', async (t) => {
    const pool = new RealmPool<typeof errorFn>({
      entry: new URL('./fixtures/error-fn.mts', import.meta.url).pathname,
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
    type Payload = { x: number; y: number[]; z: boolean };
    const pool = new RealmPool<(input: Payload) => Payload>({
      entry: new URL('./fixtures/echo-fn.mts', import.meta.url).pathname,
      size: 1,
    });
    const input: Payload = { x: 42, y: [1, 2, 3], z: true };
    const result = await pool.call(input);
    t.equal(result.x, 42, 'x correct');
    t.equal(result.y[1], 2, 'y[1] correct');
    t.equal(result.z, true, 'z correct');
    await pool.close();
  });

  it('close() waits for in-flight tasks then terminates workers', async (t) => {
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('./fixtures/sum-fn.mts', import.meta.url).pathname,
      size: 2,
    });
    const p = pool.call(10, 20);
    await pool.close();
    const result = await p;
    t.equal(result, 30, 'in-flight task completed before shutdown');
  });

  it('rejects new calls after close()', async (t) => {
    const pool = new RealmPool<typeof sumFn>({
      entry: new URL('./fixtures/sum-fn.mts', import.meta.url).pathname,
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
      entry: new URL('./fixtures/corr-fn.mts', import.meta.url).pathname,
      size: 1,
    });
    const corrId = await pool.call();
    t.ok(typeof corrId === 'string' && corrId.length > 0, 'correlation ID is a non-empty string');
    await pool.close();
  });
});
