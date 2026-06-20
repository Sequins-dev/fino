/**
 * Tests for FfiCallback — expose JS functions as C-callable function pointers.
 */

import { describe, it } from 'fino:test/test';
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'fino:process';
import { Context } from 'fino:context';

const libcPath = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

const libc = dlopen(libcPath, {
  qsort: {
    parameters: ['pointer', 'usize', 'usize', 'pointer'],
    result: 'void',
  },
});

// qsort is called async (pool thread) so the comparator callback fires on a
// non-V8 thread, exercising the real cross-thread bridge.
// Both base and compar are 'pointer' (not 'buffer'), so they're treated as
// plain address integers — safe to copy into AsyncFfiWork before the pool runs.
const asyncLibc = dlopen(libcPath, {
  qsort: {
    parameters: ['pointer', 'usize', 'usize', 'pointer'],
    result: 'void',
    async: true,
  },
});

describe('FfiCallback same-thread (qsort)', () => {
  it('dlopen exposes raw C symbol pointers', (t) => {
    t.ok(libc.pointers.qsort instanceof ArrayBuffer, 'qsort pointer is an ArrayBuffer');
    t.equal(libc.pointers.qsort.byteLength, 8, 'qsort pointer is pointer-sized');
    t.notEqual(Pointer.addr(libc.pointers.qsort), 0n, 'qsort pointer is non-null');
  });

  it('JS comparator works when C invokes it during a synchronous FFI call', (t) => {
    let callCount = 0;
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
    libc.symbols.qsort(Pointer.of(arr.buffer), 5n, 4n, cmp.pointer);

    t.ok(callCount > 0, `comparator called ${callCount} times`);
    t.deepEqual(Array.from(arr), [1, 2, 3, 4, 5], 'array is sorted ascending');

    cmp.close();
  });

  it('same-thread callbacks re-enter with the active context', (t) => {
    const ctx = new Context('ffi-sync-callback-prop');
    const seen: unknown[] = [];
    const cmp = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      (aPtr: ArrayBuffer, bPtr: ArrayBuffer) => {
        seen.push(ctx.get());
        const a = Pointer.readI32(aPtr, 0);
        const b = Pointer.readI32(bPtr, 0);
        return a - b;
      },
    );

    const arr = new Int32Array([2, 1]);
    ctx.runWithValue('via-qsort', () => {
      libc.symbols.qsort(Pointer.of(arr.buffer), 2n, 4n, cmp.pointer);
    });

    t.ok(seen.length > 0, 'comparator was called');
    t.deepEqual([...new Set(seen)], ['via-qsort'], 'callbacks see the active sync FFI context');
    t.deepEqual(Array.from(arr), [1, 2], 'array is sorted ascending');

    cmp.close();
  });
});

// ---------------------------------------------------------------------------
// Basic construction and lifecycle
// ---------------------------------------------------------------------------

describe('FfiCallback basic', () => {
  it('supports using disposal', (t) => {
    let cbRef: { close(): void; pointer: ArrayBuffer } | null = null;
    {
      using cb = new FfiCallback({ parameters: [], result: 'void' }, () => {});
      cbRef = cb;
      t.ok(cb.pointer instanceof ArrayBuffer, 'callback is usable inside using scope');
    }

    let threw = false;
    try { cbRef!.close(); } catch { threw = true; }
    t.equal(threw, false, 'using disposal closes callback idempotently');
  });

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
    await asyncLibc.symbols.qsort(Pointer.of(arr.buffer), 5n, 4n, cmp.pointer);

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
    await asyncLibc.symbols.qsort(Pointer.of(arr.buffer), 8n, 4n, cmp.pointer);

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
    await asyncLibc.symbols.qsort(Pointer.of(arr.buffer), 5n, 4n, cmp.pointer);

    t.deepEqual(Array.from(arr), [1, 2, 5, 7, 8], 'async comparator sorts correctly');

    cmp.close();
  });
});
