/**
 * Child realm fixture: performs async FFI calls and returns results.
 * Used to verify that embedded child realms share the parent's executor.
 */
import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const lib = dlopen(LIBC, {
  getpid: {
    parameters: [],
    result: 'i32',
    async: true,
  },
  usleep: {
    parameters: ['u32'],
    result: 'i32',
    async: true,
  },
});
type AsyncFfiWork = {
  sleepUs: number;
  stats: SharedArrayBuffer;
  minimumActive: number;
};

function recordMaximum(stats: Int32Array, value: number): void {
  while (true) {
    const previous = Atomics.load(stats, 1);
    if (previous >= value || Atomics.compareExchange(stats, 1, previous, value) === previous)
      return;
  }
}

export default async function (work: number | AsyncFfiWork) {
  const sleepUs = typeof work === 'number' ? work : work.sleepUs;
  const stats = typeof work === 'number' ? undefined : new Int32Array(work.stats);
  if (stats !== undefined) {
    const active = Atomics.add(stats, 0, 1) + 1;
    recordMaximum(stats, active);
    const deadline = Date.now() + 15_000;
    while (Atomics.load(stats, 0) < work.minimumActive) {
      if (Date.now() >= deadline) throw new Error('async FFI concurrency barrier timed out');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  // Concurrent async FFI calls inside a child realm
  try {
    const [pid] = await Promise.all([lib.symbols.getpid(), lib.symbols.usleep(sleepUs)]);
    return pid as number;
  } finally {
    if (stats !== undefined) Atomics.sub(stats, 0, 1);
  }
}
