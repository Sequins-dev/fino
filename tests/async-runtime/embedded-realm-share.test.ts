/**
 * Tests that reactor-pooled child realms can run async FFI concurrently with
 * their parent and with other pooled realms.
 */
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';
import type asyncFfiChild from './fixtures/async-ffi-child.ts';
const ENTRY = new URL('./fixtures/async-ffi-child.ts', import.meta.url).pathname;
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
function recordMaximum(stats: Int32Array, value: number): void {
  while (true) {
    const previous = Atomics.load(stats, 1);
    if (previous >= value || Atomics.compareExchange(stats, 1, previous, value) === previous)
      return;
  }
}
async function waitForActive(stats: Int32Array, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Atomics.load(stats, 0) < count) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('async FFI worker activation timed out');
    const current = Atomics.load(stats, 0);
    const waiter = Atomics.waitAsync(stats, 0, current, remaining);
    if (waiter.async) await waiter.value;
  }
}
describe('reactor-pooled Realm async execution', () => {
  it('async FFI works inside a pooled child realm', async (t) => {
    const realm = new Realm<typeof asyncFfiChild>({ entry: ENTRY });
    const pid = await realm.call(1e4);
    t.ok(typeof pid === 'number' && pid > 0, `child realm async FFI returned pid ${pid}`);
  });
  it('parent and child run async FFI concurrently', async (t) => {
    const libAsync = dlopen(LIBC, {
      usleep: {
        parameters: ['u32'],
        result: 'i32',
        async: true,
      },
    });
    const sleepUs = 25e4;
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const stats = new Int32Array(shared);
    const realm = new Realm<typeof asyncFfiChild>({ entry: ENTRY });
    const child = realm.call({ sleepUs, stats: shared, minimumActive: 2 });
    await waitForActive(stats, 1);
    const active = Atomics.add(stats, 0, 1) + 1;
    recordMaximum(stats, active);
    Atomics.notify(stats, 0);
    const parent = libAsync.symbols.usleep(sleepUs).finally(() => Atomics.sub(stats, 0, 1));
    const [childPid] = await Promise.all([child, parent]);
    t.ok(typeof childPid === 'number' && childPid > 0, 'child returned valid pid');
    t.equal(Atomics.load(stats, 0), 0, 'parent and child async work finished');
    t.equal(Atomics.load(stats, 1), 2, 'parent and child async FFI overlapped');
  });
  it('multiple pooled children complete async FFI concurrently', async (t) => {
    const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const children = [
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
    ];
    const pids = await Promise.all(
      children.map((realm) => realm.call({ sleepUs: 25e4, stats: shared, minimumActive: 3 })),
    );
    t.equal(pids.length, 3, 'all 3 children returned');
    for (const pid of pids) {
      t.ok(typeof pid === 'number' && pid > 0, `pid ${pid} is valid`);
    }
    const stats = new Int32Array(shared);
    t.equal(Atomics.load(stats, 0), 0, 'all child async work finished');
    t.equal(Atomics.load(stats, 1), 3, 'all child async FFI calls overlapped');
  });
});
