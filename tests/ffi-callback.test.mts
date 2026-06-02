/**
 * Tests for FfiCallback — expose JS functions as C-callable function pointers.
 */

import { describe, it } from 'fino:test/test';
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'fino:process';

const libcPath = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

// qsort is called async (pool thread) so the comparator callback fires on a
// non-V8 thread, exercising the real cross-thread bridge.
// Both base and compar are 'pointer' (not 'buffer'), so they're treated as
// plain address integers — safe to copy into AsyncFfiWork before the pool runs.
const libc = dlopen(libcPath, {
  qsort: {
    parameters: ['pointer', 'usize', 'usize', 'pointer'],
    result: 'void',
    async: true,
  },
});

// ---------------------------------------------------------------------------
// Basic construction and lifecycle
// ---------------------------------------------------------------------------

describe('FfiCallback basic', () => {
  it('constructor returns an object with pointer and close', (t) => {
    const cb = new FfiCallback(
      { parameters: ['i32', 'i32'], result: 'i32' },
      (a: number, b: number) => a - b,
    );
    t.ok(cb !== null && typeof cb === 'object', 'result is an object');
    t.ok(cb.pointer instanceof ArrayBuffer && cb.pointer.byteLength === 8, 'pointer is 8-byte ArrayBuffer');
    t.ok(typeof cb.close === 'function', 'close is a function');
    cb.close();
  });

  it('close() is idempotent', (t) => {
    const cb = new FfiCallback({ parameters: [], result: 'void' }, () => {});
    cb.close();
    let threw = false;
    try { cb.close(); } catch { threw = true; }
    t.equal(threw, false, 'second close does not throw');
  });
});

// ---------------------------------------------------------------------------
// Cross-thread invocation via qsort
// ---------------------------------------------------------------------------

describe('FfiCallback cross-thread (qsort)', () => {
  it('JS comparator is invoked and sorts an array', async (t) => {
    let callCount = 0;

    // Comparator receives two *const int pointers. Use Pointer.readI32 to
    // dereference the pointer arg to the actual integer value.
    const cmp = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      (aPtr: ArrayBuffer, bPtr: ArrayBuffer) => {
        callCount++;
        const a = Pointer.readI32(aPtr, 0);
        const b = Pointer.readI32(bPtr, 0);
        return a - b;
      },
    );

    const arr = new Int32Array([5, 3, 1, 4, 2]);
    // Pointer.of wraps arr.buffer's backing-store address as a pointer arg.
    await libc.symbols.qsort(Pointer.of(arr.buffer), 5n, 4n, cmp.pointer);

    t.ok(callCount > 0, `comparator called ${callCount} times`);
    t.deepEqual(Array.from(arr), [1, 2, 3, 4, 5], 'array is sorted ascending');

    cmp.close();
  });

  it('comparator for descending sort', async (t) => {
    const cmp = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      (aPtr: ArrayBuffer, bPtr: ArrayBuffer) => {
        const a = Pointer.readI32(aPtr, 0);
        const b = Pointer.readI32(bPtr, 0);
        return b - a;
      },
    );

    const arr = new Int32Array([3, 1, 4, 1, 5, 9, 2, 6]);
    await libc.symbols.qsort(Pointer.of(arr.buffer), 8n, 4n, cmp.pointer);

    t.deepEqual(Array.from(arr), [9, 6, 5, 4, 3, 2, 1, 1], 'array is sorted descending');

    cmp.close();
  });
});

// ---------------------------------------------------------------------------
// Promise-returning callback
// ---------------------------------------------------------------------------

describe('FfiCallback async-returning comparator', () => {
  it('comparator may return a Promise that resolves to a number', async (t) => {
    const cmp = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      async (aPtr: ArrayBuffer, bPtr: ArrayBuffer) => {
        await Promise.resolve();
        const a = Pointer.readI32(aPtr, 0);
        const b = Pointer.readI32(bPtr, 0);
        return a - b;
      },
    );

    const arr = new Int32Array([7, 2, 8, 1, 5]);
    await libc.symbols.qsort(Pointer.of(arr.buffer), 5n, 4n, cmp.pointer);

    t.deepEqual(Array.from(arr), [1, 2, 5, 7, 8], 'async comparator sorts correctly');

    cmp.close();
  });
});
