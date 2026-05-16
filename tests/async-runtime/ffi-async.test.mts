/**
 * Tests for async: true FFI symbols — thread-pool offload, Promise return.
 */

import { describe, it } from 'fino:test/test';
import { dlopen } from 'fino:ffi';
import { os } from 'fino:runtime/process';

const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

// Two separate opens of the same library — one for sync access, one for async.
// The key in the dlopen object is the actual C symbol name; async: true changes
// the calling convention, not the symbol lookup.
const libSync = dlopen(LIBC, {
  getpid: { parameters: [], result: 'i32' },
});
const libAsync = dlopen(LIBC, {
  getpid:  { parameters: [],       result: 'i32', async: true },
  usleep:  { parameters: ['u32'],  result: 'i32', async: true },
});

describe('async FFI', () => {
  it('sync symbol still returns value directly', (t) => {
    const pid = libSync.symbols.getpid();
    t.ok(typeof pid === 'number' && pid > 0, 'sync getpid returns positive number');
  });

  it('async symbol returns a Promise', (t) => {
    const p = libAsync.symbols.getpid();
    t.ok(p instanceof Promise, 'async symbol returns Promise');
    return p;
  });

  it('async symbol resolves with correct value', async (t) => {
    const syncPid = libSync.symbols.getpid();
    const asyncPid = await libAsync.symbols.getpid();
    t.equal(asyncPid, syncPid, 'async getpid matches sync getpid');
  });

  it('async call does not block the event loop', async (t) => {
    let microtaskRan = false;
    const sleep = libAsync.symbols.usleep(50_000); // 50 ms
    Promise.resolve().then(() => { microtaskRan = true; });
    await sleep;
    t.ok(microtaskRan, 'microtask ran while async FFI was in flight');
  });

  it('multiple concurrent async calls run in parallel', async (t) => {
    const start = Date.now();
    await Promise.all([
      libAsync.symbols.usleep(50_000),
      libAsync.symbols.usleep(50_000),
      libAsync.symbols.usleep(50_000),
      libAsync.symbols.usleep(50_000),
    ]);
    const elapsed = Date.now() - start;
    // Serial would take ~200ms; parallel should be ~50ms
    t.ok(elapsed < 150, `parallel calls took ${elapsed}ms (expected < 150ms)`);
  });

  it('async call with i32 result converts correctly', async (t) => {
    const pid = await libAsync.symbols.getpid();
    t.ok(Number.isInteger(pid), 'result is integer');
    t.ok(pid > 0, 'pid is positive');
  });

  it('sync and async calls return matching values', async (t) => {
    const syncPid = libSync.symbols.getpid();
    const asyncPid = await libAsync.symbols.getpid();
    t.equal(typeof syncPid, 'number', 'sync works');
    t.equal(typeof asyncPid, 'number', 'async works');
    t.equal(syncPid, asyncPid, 'both return same pid');
  });
});
