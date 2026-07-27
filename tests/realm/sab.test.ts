/**
 * Tests for SharedArrayBuffer + Atomics across reactor-pooled Realm isolates.
 *
 * Both Isolates share the same ArrayBufferAllocator, so a SharedArrayBuffer
 * created on one side is accessible (via the SAB registry) on the other.
 *
 * CLI work runs on the reactor worker pool, so Atomics.wait() is allowed.
 */
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import type echoFn from './fixtures/echo-fn.ts';
describe('SharedArrayBuffer', () => {
  it('Atomics.wait is allowed in a reactor workload', (t) => {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    t.equal(Atomics.wait(view, 0, 0, 0), 'timed-out', 'workload may block its worker thread');
  });
  it('round-trips a SharedArrayBuffer through a Realm call', async (t) => {
    const realm = new Realm<typeof echoFn>({
      entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname,
    });
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    view[0] = 77;
    const result = await realm.call(sab as unknown as string);
    t.ok(result instanceof SharedArrayBuffer, 'result is a SharedArrayBuffer');
    const resultView = new Int32Array(result as unknown as SharedArrayBuffer);
    t.equal(resultView[0], 77, 'value preserved through serialization');
  });
});
