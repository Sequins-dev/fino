/** Direct launcher and OS policy operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isLinux = os === 'linux';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
// Symbols present on both Linux and macOS. `prctl`, the `landlock_*` family,
// and glibc's `__errno_location` are Linux-only and are bound separately so the
// eager dlopen does not fail on macOS.
const COMMON_SYMBOLS = {
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  pread: { parameters: ['i32', 'buffer', 'usize', 'i64'], result: 'isize' },
  write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  close: { parameters: ['i32'], result: 'i32' },
  // fcntl and open are variadic in libc; on Darwin ARM64 the extra arg must be
  // passed on the stack, so they must be declared variadic (fixed-arg count).
  fcntl: { parameters: ['i32', 'i32', 'i32'], result: 'i32', variadic: 2 },
  poll: { parameters: ['buffer', 'u64', 'i32'], result: 'i32' },
  socketpair: { parameters: ['i32', 'i32', 'i32', 'buffer'], result: 'i32' },
  chdir: { parameters: ['buffer'], result: 'i32' },
  access: { parameters: ['buffer', 'i32'], result: 'i32' },
  open: { parameters: ['buffer', 'i32', 'i32'], result: 'i32', variadic: 2 },
  mkdir: { parameters: ['buffer', 'u32'], result: 'i32' },
  rmdir: { parameters: ['buffer'], result: 'i32' },
  realpath: { parameters: ['buffer', 'buffer'], result: 'pointer' },
  getpid: { parameters: [], result: 'i32' },
  setpgid: { parameters: ['i32', 'i32'], result: 'i32' },
  setrlimit: { parameters: ['i32', 'buffer'], result: 'i32' },
  execve: { parameters: ['buffer', 'buffer', 'buffer'], result: 'i32' },
  waitpid: { parameters: ['i32', 'buffer', 'i32'], result: 'i32' },
  _exit: { parameters: ['i32'], result: 'void' },
  syscall: { parameters: ['i64', 'i64', 'i64', 'i64', 'i64'], result: 'i64' },
} as const;
const LINUX_SYMBOLS = {
  prctl: { parameters: ['i32', 'u64', 'u64', 'u64', 'u64'], result: 'i32' },
  gettid: { parameters: [], result: 'i32' },
  __errno_location: { parameters: [], result: 'pointer' },
} as const;
export const security = dlopen(
  LIBC,
  isLinux ? { ...COMMON_SYMBOLS, ...LINUX_SYMBOLS } : COMMON_SYMBOLS,
) as {
  symbols: Record<string, (...args: unknown[]) => number | bigint | unknown>;
};
// macOS exposes errno through `__error` rather than glibc's `__errno_location`.
export const securityErrno = (() => {
  if (isLinux) return null;
  try {
    return dlopen(LIBC, { __error: { parameters: [], result: 'pointer' } });
  } catch (_) {
    return null;
  }
})();
