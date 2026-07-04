/**
* internal:security/sandbox/ffi — libc surface used by the self-sandboxing
* launcher and its parent.
*
* The launcher applies OS policy to *itself* over FFI and then `execve`s the
* target, so it needs raw libc syscalls that the normal async I/O path never
* touches: `setrlimit`, `prctl`, `unshare`, `execve`, and the `landlock_*` /
* `seccomp` families reached through `syscall(2)`. None of this is
* sandbox-specific — it is platform surface any FFI caller could bind — but it
* lives here because the launcher is its only consumer.
*
* @internal
*/
import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
const isLinux = os === 'linux';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
// Symbols present on both Linux and macOS. `prctl`, the `landlock_*` family,
// and glibc's `__errno_location` are Linux-only and are bound separately so the
// eager dlopen does not fail on macOS.
const COMMON_SYMBOLS = {
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  close: { parameters: ['i32'], result: 'i32' },
  // fcntl and open are variadic in libc; on Darwin ARM64 the extra arg must be
  // passed on the stack, so they must be declared variadic (fixed-arg count).
  fcntl: { parameters: ['i32', 'i32', 'i32'], result: 'i32', variadic: 2 },
  poll: { parameters: ['buffer', 'u64', 'i32'], result: 'i32' },
  socketpair: { parameters: ['i32', 'i32', 'i32', 'buffer'], result: 'i32' },
  chdir: { parameters: ['buffer'], result: 'i32' },
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
  syscall: { parameters: ['i64', 'i64', 'i64', 'i64', 'i64'], result: 'i64' }
} as const;
const LINUX_SYMBOLS = {
  prctl: { parameters: ['i32', 'u64', 'u64', 'u64', 'u64'], result: 'i32' },
  __errno_location: { parameters: [], result: 'pointer' }
} as const;
/**
* Shared libc handle. Every symbol here is synchronous; the launcher is a
* dedicated short-lived process, so blocking calls do not run on any live
* event loop.
*/
export const libc = dlopen(LIBC, isLinux ? { ...COMMON_SYMBOLS, ...LINUX_SYMBOLS } : COMMON_SYMBOLS) as {
  symbols: Record<string, (...args: unknown[]) => number | bigint | unknown>;
};
// macOS exposes errno through `__error` rather than glibc's `__errno_location`.
const errnoLib = (() => {
  if (isLinux) return null;
  try {
    return dlopen(LIBC, { __error: { parameters: [], result: 'pointer' } });
  } catch (_) {
    return null;
  }
})();
/**
* Current thread's `errno`. Read immediately after a failed libc call.
*/
export function errno(): number {
  try {
    const ptr = isLinux ? libc.symbols.__errno_location() : errnoLib?.symbols.__error();
    if (ptr == null) return 0;
    return Number((Pointer as unknown as { readI32(p: unknown, off: number): number }).readI32(ptr, 0));
  } catch (_) {
    return 0;
  }
}
// fcntl(2)
export const F_SETFD = 2;
export const FD_CLOEXEC = 1;
// socket(2)
export const AF_UNIX = 1;
export const SOCK_STREAM = 1;
// poll(2)
export const POLLIN = 0x0001;
// prctl(2)
export const PR_SET_NO_NEW_PRIVS = 38;
export const PR_SET_SECCOMP = 22;
export const SECCOMP_MODE_FILTER = 2;
// open(2)
export const O_PATH = isLinux ? 0x200000 : 0;
export const O_CLOEXEC = isLinux ? 0x80000 : 0x1000000;
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_CREAT = isLinux ? 0x40 : 0x200;
export const O_TRUNC = isLinux ? 0x200 : 0x400;
// setrlimit(2) resource ids differ by platform.
export const RLIMIT_AS = isLinux ? 9 : 5;
export const RLIMIT_NPROC = isLinux ? 6 : 7;
// Linux landlock syscall numbers (arch-independent).
export const SYS_LANDLOCK_CREATE_RULESET = 444n;
export const SYS_LANDLOCK_ADD_RULE = 445n;
export const SYS_LANDLOCK_RESTRICT_SELF = 446n;
export const SYS_SECCOMP = 317n;
export const SYS_UNSHARE = 272n;
/** Encode a JS string as a null-terminated UTF-8 buffer. */
export function cstr(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}
/**
* Build a null-terminated `char**` from JS strings for `execve`.
*
* Returns both the pointer array and the backing buffers; callers must keep
* `bufs` in scope until the syscall returns so the GC does not reclaim the
* string memory.
*/
export function buildCStringArray(strings: string[]): { ptrBuf: ArrayBuffer; bufs: Uint8Array[] } {
  const bufs = strings.map(cstr);
  const ptrBuf = new ArrayBuffer((bufs.length + 1) * 8);
  const view = new DataView(ptrBuf);
  for (let i = 0; i < bufs.length; i++) {
    view.setBigUint64(i * 8, Pointer.addr(bufs[i]), true);
  }
  return { ptrBuf, bufs };
}
/** Set (or clear) FD_CLOEXEC on a descriptor. */
export function setCloexec(fd: number, on: boolean): void {
  libc.symbols.fcntl(fd, F_SETFD, on ? FD_CLOEXEC : 0);
}
/**
* Canonicalize a path with `realpath(3)`, resolving symlinks and firmlinks
* (e.g. `/tmp` → `/private/tmp` on macOS). Returns the original path unchanged
* when it cannot be resolved (e.g. it does not exist). macOS Seatbelt matches
* rules against the canonical path, so profile paths must be resolved first.
*/
export function realpathSync(path: string): string {
  const out = new Uint8Array(4096);
  const rc = libc.symbols.realpath(cstr(path), out);
  if (rc == null) return path;
  let end = out.indexOf(0);
  if (end < 0) end = out.length;
  return new TextDecoder().decode(out.subarray(0, end));
}
/**
* Synchronously read a small file into a string, or return `null` if it cannot
* be opened. For sysfs/procfs pseudo-files read by the launcher off the event
* loop and for cgroup cleanup on the parent.
*/
export function readFileSync(path: string): string | null {
  const fd = Number(libc.symbols.open(cstr(path), O_RDONLY, 0));
  if (fd < 0) return null;
  try {
    let out = '';
    const buf = new Uint8Array(4096);
    for (;;) {
      const n = Number(libc.symbols.read(fd, buf, buf.length));
      if (n <= 0) break;
      out += new TextDecoder().decode(buf.subarray(0, n));
    }
    return out;
  } finally {
    libc.symbols.close(fd);
  }
}
/**
* Synchronously read up to `maxBytes` raw bytes from a file, or `null` if it
* cannot be opened. Used to parse ELF headers; unlike {@link readFileSync} it
* preserves binary content.
*/
export function readFileBytesSync(path: string, maxBytes: number): Uint8Array | null {
  const fd = Number(libc.symbols.open(cstr(path), O_RDONLY, 0));
  if (fd < 0) return null;
  try {
    const out = new Uint8Array(maxBytes);
    let offset = 0;
    while (offset < maxBytes) {
      const chunk = new Uint8Array(maxBytes - offset);
      const n = Number(libc.symbols.read(fd, chunk, chunk.length));
      if (n <= 0) break;
      out.set(chunk.subarray(0, n), offset);
      offset += n;
    }
    return out.subarray(0, offset);
  } finally {
    libc.symbols.close(fd);
  }
}
/**
* Synchronously write a string to a file, creating it if necessary. Returns the
* errno on failure and 0 on success. Used for cgroup control files, which accept
* a single small write.
*/
export function writeFileSync(path: string, content: string, create = false): number {
  const flags = O_WRONLY | (create ? O_CREAT | O_TRUNC : 0);
  const fd = Number(libc.symbols.open(cstr(path), flags, 0o644));
  if (fd < 0) return errno();
  try {
    const bytes = new TextEncoder().encode(content);
    const n = Number(libc.symbols.write(fd, bytes, bytes.length));
    return n < 0 ? errno() : 0;
  } finally {
    libc.symbols.close(fd);
  }
}
