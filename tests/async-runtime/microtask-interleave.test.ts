/**
 * Tests that V8 microtasks and Rust async executor interleave correctly.
 */
import { describe, it } from 'fino:test/test';
import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const lib = dlopen(LIBC, {
  usleep: {
    parameters: ['u32'],
    result: 'i32',
    async: true,
  },
});
const { usleep } = lib.symbols;
describe('microtask + async-executor interleaving', () => {
  it('JS setTimeout resolves while async FFI is pending', async (t) => {
    const sleepDone = usleep(8e4);
    // Timer fires after 10 ms, well before usleep completes
    const timerValue = await new Promise<number>((resolve) => {
      setTimeout(() => resolve(42), 10);
    });
    t.equal(timerValue, 42, 'timer resolved while async FFI was in flight');
    await sleepDone;
    t.ok(true, 'async FFI also completed');
  });
  it('Promise.resolve microtasks run between async FFI calls', async (t) => {
    const log: string[] = [];
    const p1 = usleep(1e4).then(() => log.push('ffi1'));
    Promise.resolve().then(() => log.push('micro1'));
    const p2 = usleep(1e4).then(() => log.push('ffi2'));
    Promise.resolve().then(() => log.push('micro2'));
    await Promise.all([p1, p2]);
    // Microtasks run synchronously before any async FFI completes
    t.ok(log.includes('micro1'), 'micro1 ran');
    t.ok(log.includes('micro2'), 'micro2 ran');
    t.ok(log.includes('ffi1'), 'ffi1 ran');
    t.ok(log.includes('ffi2'), 'ffi2 ran');
    // micro1/micro2 should appear before ffi1/ffi2
    t.ok(log.indexOf('micro1') < log.indexOf('ffi1'), 'micro1 before ffi1');
    t.ok(log.indexOf('micro2') < log.indexOf('ffi2'), 'micro2 before ffi2');
  });
  it('async/await chains work while async FFI is pending', async (t) => {
    const results: number[] = [];
    async function chain() {
      results.push(1);
      await Promise.resolve();
      results.push(2);
      await Promise.resolve();
      results.push(3);
      return 'done';
    }
    const chainPromise = chain();
    const ffiPromise = usleep(3e4);
    const [chainResult] = await Promise.all([chainPromise, ffiPromise]);
    t.equal(chainResult, 'done', 'async chain completed');
    t.deepEqual(results, [1, 2, 3], 'chain ran in order');
  });
});
