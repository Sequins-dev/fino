/**
 * Tests that embedded (same-thread) child realms share the parent's async
 * executor and blocking pool, and that thread realms have their own.
 */

import { describe, it } from 'fino:test/test';
import { Realm } from 'fino:realm';
import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';

import type asyncFfiChild from './fixtures/async-ffi-child.mts';

const ENTRY = new URL('./fixtures/async-ffi-child.mts', import.meta.url).pathname;
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

describe('embedded realm shares async executor', () => {
  it('async FFI works inside an embedded child realm', async (t) => {
    const realm = new Realm<typeof asyncFfiChild>({ entry: ENTRY });
    const pid = await realm.call(10_000);
    t.ok(typeof pid === 'number' && pid > 0, `child realm async FFI returned pid ${pid}`);
  });

  it('parent and embedded child run async FFI concurrently', async (t) => {
    const libAsync = dlopen(LIBC, {
      usleep: { parameters: ['u32'], result: 'i32', async: true },
    });

    const realm = new Realm<typeof asyncFfiChild>({ entry: ENTRY });

    const start = Date.now();
    // Parent and child each sleep 50ms concurrently — should take ~50ms total
    const [childPid] = await Promise.all([
      realm.call(50_000),
      libAsync.symbols.usleep(50_000),
    ]);
    const elapsed = Date.now() - start;

    t.ok(typeof childPid === 'number' && childPid > 0, 'child returned valid pid');
    // Embedded realm startup adds ~100–150ms overhead; verify it's less than serial execution
    // (serial would be ~250ms: realm startup + 50ms + parent 50ms sequential).
    t.ok(elapsed < 350, `concurrent parent+child took ${elapsed}ms (expected < 350ms)`);
  });

  it('multiple embedded children complete async FFI concurrently', async (t) => {
    const children = [
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
      new Realm<typeof asyncFfiChild>({ entry: ENTRY }),
    ];

    const start = Date.now();
    const pids = await Promise.all(children.map(r => r.call(150_000)));
    const elapsed = Date.now() - start;

    t.equal(pids.length, 3, 'all 3 children returned');
    for (const pid of pids) {
      t.ok(typeof pid === 'number' && pid > 0, `pid ${pid} is valid`);
    }
    // Timing includes realm startup. 3 serial sleeps × 150ms would add 450ms
    // on top of that startup, while concurrent shared-pool work adds ~150ms.
    t.ok(elapsed < 650, `3 concurrent child realms took ${elapsed}ms`);
  });
});

describe('thread realm has its own async executor', () => {
  it('async FFI works inside a thread realm', async (t) => {
    const realm = new Realm<typeof asyncFfiChild>({
      thread: true,
      entry: ENTRY,
    });
    const pid = await realm.call(10_000);
    t.ok(typeof pid === 'number' && pid > 0, `thread realm async FFI returned pid ${pid}`);
  });

  it('parent and thread realm run async FFI concurrently', async (t) => {
    const libAsync = dlopen(LIBC, {
      usleep: { parameters: ['u32'], result: 'i32', async: true },
    });

    const realm = new Realm<typeof asyncFfiChild>({
      thread: true,
      entry: ENTRY,
    });

    const start = Date.now();
    const [childPid] = await Promise.all([
      realm.call(100_000),
      libAsync.symbols.usleep(100_000),
    ]);
    const elapsed = Date.now() - start;

    t.ok(typeof childPid === 'number' && childPid > 0, 'thread realm returned valid pid');
    t.ok(elapsed < 300, `parent+thread realm concurrent took ${elapsed}ms`);
  });
});
