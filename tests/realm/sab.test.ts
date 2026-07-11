/**
* Tests for SharedArrayBuffer + Atomics across thread-realm boundaries.
*
* Both Isolates share the same ArrayBufferAllocator, so a SharedArrayBuffer
* created on one side is accessible (via the SAB registry) on the other.
*
* Atomics.wait() must throw on the main thread but work inside reactor realms.
*/
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import type echoFn from './fixtures/echo-fn.ts';
describe('SharedArrayBuffer', () => {
  it('Atomics.wait throws on the main thread', (t) => {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    let threw = false;
    try {
      Atomics.wait(view, 0, 0, 0);
    } catch {
      threw = true;
    }
    t.ok(threw, 'Atomics.wait should throw on the main thread');
  });
  it('round-trips a SharedArrayBuffer through a realm call', async (t) => {
    using realm = new Realm<typeof echoFn>({ entry: new URL('./fixtures/echo-fn.ts', import.meta.url).pathname });
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    view[0] = 77;
    const result = await realm.call((sab as unknown) as string);
    t.ok(result instanceof SharedArrayBuffer, 'result is a SharedArrayBuffer');
    const resultView = new Int32Array((result as unknown) as SharedArrayBuffer);
    t.equal(resultView[0], 77, 'value preserved through serialization');
  });
});
