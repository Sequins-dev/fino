/**
 * Tests that scheduler-hosted realms own working async FFI executors.
 */
import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';
import type asyncFfiChild from './fixtures/async-ffi-child.ts';
const ENTRY = new URL('./fixtures/async-ffi-child.ts', import.meta.url).pathname;
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
async function elapsed(fn: () => Promise<unknown>): Promise<number> {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}
describe('reactor realm async executor', () => {
  it('async FFI works inside a reactor realm', async (t) => {
    const realm = new Realm<typeof asyncFfiChild>({ entry: ENTRY });
    const pid = await realm.call(1e4);
    t.ok(typeof pid === 'number' && pid > 0, `child realm async FFI returned pid ${pid}`);
  });
  it('parent and reactor realm run async FFI concurrently', async (t) => {
    const libAsync = dlopen(LIBC, { usleep: {
      parameters: ['u32'],
      result: 'i32',
      async: true
    } });
    const sleepUs = 1e6;
    const sequential = await elapsed(async () => {
      const realm = new Realm<typeof asyncFfiChild>({ entry: ENTRY });
      await realm.call(sleepUs);
      await libAsync.symbols.usleep(sleepUs);
    });
    const realm = new Realm<typeof asyncFfiChild>({ entry: ENTRY });
    let childPid = 0;
    const concurrent = await elapsed(async () => {
      const [pid] = await Promise.all([realm.call(sleepUs), libAsync.symbols.usleep(sleepUs)]);
      childPid = pid;
    });
    t.ok(typeof childPid === 'number' && childPid > 0, 'child returned valid pid');
    t.ok(sequential > 0, 'sequential baseline completed');
    t.ok(concurrent < sequential * .85, `concurrent parent+child took ${concurrent}ms vs ${sequential}ms sequential`);
  });
  it('multiple reactor realms complete async FFI concurrently', async (t) => {
    const sequential = await elapsed(async () => {
      const children = [
        new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
        new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
        new Realm<typeof asyncFfiChild>({ entry: ENTRY })
      ];
      for (const child of children) await child.call(15e4);
    });
    const children = [
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
      new Realm<typeof asyncFfiChild>({ entry: ENTRY })
    ];
    const pids: number[] = [];
    const concurrent = await elapsed(async () => {
      pids.push(...await Promise.all(children.map((r) => r.call(15e4))));
    });
    t.equal(pids.length, 3, 'all 3 children returned');
    for (const pid of pids) {
      t.ok(typeof pid === 'number' && pid > 0, `pid ${pid} is valid`);
    }
    t.ok(concurrent < sequential, `3 concurrent child realms took ${concurrent}ms vs ${sequential}ms sequential`);
  });
});
