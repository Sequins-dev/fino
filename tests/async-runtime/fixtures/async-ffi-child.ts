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
export default async function (sleepUs: number) {
  // Concurrent async FFI calls inside a child realm
  const [pid] = await Promise.all([lib.symbols.getpid(), lib.symbols.usleep(sleepUs)]);
  return pid as number;
}
