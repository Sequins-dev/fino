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
 * Everything exported here is synchronous and blocking by design: the launcher
 * is a dedicated, short-lived process that has not yet started an event loop, so
 * it is free to call raw libc directly. Do not import this module into
 * long-running code on a live event loop — the blocking reads and writes would
 * stall it.
 *
 * ```ts no_run
 * import { libc, errno, cstr, readFileSync } from 'internal:security/sandbox/ffi';
 *
 * // Read a procfs pseudo-file the async path cannot reach yet.
 * const cgroup = readFileSync('/proc/self/cgroup');
 *
 * // Call a raw libc symbol and inspect errno on failure.
 * const rc = libc.symbols.chdir(cstr('/nonexistent'));
 * if (Number(rc) !== 0) throw new Error(`chdir failed: errno ${errno()}`);
 * ```
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
  syscall: { parameters: ['i64', 'i64', 'i64', 'i64', 'i64'], result: 'i64' },
} as const;
const LINUX_SYMBOLS = {
  prctl: { parameters: ['i32', 'u64', 'u64', 'u64', 'u64'], result: 'i32' },
  __errno_location: { parameters: [], result: 'pointer' },
} as const;
/**
 * Shared libc handle opened once at module load. Every symbol here is
 * synchronous; the launcher is a dedicated short-lived process, so blocking
 * calls do not run on any live event loop.
 *
 * The handle is opened eagerly with the symbol set available on the current OS:
 * the `read`/`write`/`open`/`execve`/`syscall` family on both platforms, plus
 * `prctl` and glibc's `__errno_location` only on Linux. Reach `landlock_*`,
 * `seccomp`, and `unshare` through `libc.symbols.syscall` with the `SYS_*`
 * numbers exported below. Symbol return values arrive as JS `number`s or
 * `bigint`s per the FFI result type, so wrap them in `Number(...)` before
 * comparing against small integers.
 *
 * ```ts no_run
 * import { libc, cstr, O_RDONLY } from 'internal:security/sandbox/ffi';
 *
 * const fd = Number(libc.symbols.open(cstr('/etc/hostname'), O_RDONLY, 0));
 * if (fd >= 0) libc.symbols.close(fd);
 * ```
 */
export const libc = dlopen(
  LIBC,
  isLinux ? { ...COMMON_SYMBOLS, ...LINUX_SYMBOLS } : COMMON_SYMBOLS,
) as {
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
 * Current thread's `errno`, or 0 if it cannot be read.
 *
 * Reads the thread-local `errno` slot through `__errno_location` on Linux or
 * `__error` on macOS. `errno` is only meaningful immediately after a libc call
 * that reported failure — an intervening call may overwrite it, and it is never
 * cleared on success — so capture it on the same line you detect the error.
 * Returns 0 rather than throwing if the errno symbol is unavailable or the read
 * faults, so a 0 result means "no error information" rather than a definite
 * success.
 *
 * ```ts no_run
 * import { libc, errno, cstr, O_RDONLY } from 'internal:security/sandbox/ffi';
 *
 * const fd = Number(libc.symbols.open(cstr('/no/such/file'), O_RDONLY, 0));
 * if (fd < 0) throw new Error(`open failed: errno ${errno()}`);
 * ```
 */
export function errno(): number {
  try {
    const ptr = isLinux ? libc.symbols.__errno_location() : errnoLib?.symbols.__error();
    if (ptr == null) return 0;
    return Number(
      (Pointer as unknown as { readI32(p: unknown, off: number): number }).readI32(ptr, 0),
    );
  } catch (_) {
    return 0;
  }
}
// fcntl(2)
/** `fcntl` command that sets the file-descriptor flags for a descriptor. */
export const F_SETFD = 2;
/** Close-on-exec flag bit: the descriptor is closed automatically by `execve`. */
export const FD_CLOEXEC = 1;
// socket(2)
/** Address family for local (Unix-domain) sockets, used by `socketpair`. */
export const AF_UNIX = 1;
/** Connection-oriented, reliable byte-stream socket type. */
export const SOCK_STREAM = 1;
// poll(2)
/** `poll` event bit indicating a descriptor has data available to read. */
export const POLLIN = 0x0001;
// prctl(2)
/**
 * `prctl` operation that permanently forbids privilege escalation for the
 * calling thread and its children. Required before installing a seccomp filter
 * as an unprivileged process.
 */
export const PR_SET_NO_NEW_PRIVS = 38;
/** `prctl` operation that installs a seccomp filter on the calling thread. */
export const PR_SET_SECCOMP = 22;
/** seccomp mode selecting a classic-BPF filter program (as opposed to strict mode). */
export const SECCOMP_MODE_FILTER = 2;
// open(2)
/**
 * `open` flag requesting a descriptor that only references a filesystem
 * location, without read or write access. Linux-only; 0 on other platforms,
 * where the flag has no effect.
 */
export const O_PATH = isLinux ? 0x200000 : 0;
/** `open` flag that atomically sets close-on-exec on the new descriptor. */
export const O_CLOEXEC = isLinux ? 0x80000 : 0x1000000;
/** `open` flag for read-only access. */
export const O_RDONLY = 0;
/** `open` flag for write-only access. */
export const O_WRONLY = 1;
/** `open` flag that creates the file if it does not already exist. */
export const O_CREAT = isLinux ? 0x40 : 0x200;
/** `open` flag that truncates an existing regular file to zero length. */
export const O_TRUNC = isLinux ? 0x200 : 0x400;
// setrlimit(2) resource ids differ by platform.
/** `setrlimit` resource id for the process address-space (virtual memory) limit. */
export const RLIMIT_AS = isLinux ? 9 : 5;
/** `setrlimit` resource id for the maximum number of processes/threads. */
export const RLIMIT_NPROC = isLinux ? 6 : 7;
// Linux landlock syscall numbers (arch-independent).
/** Linux syscall number for `landlock_create_ruleset`. */
export const SYS_LANDLOCK_CREATE_RULESET = 444n;
/** Linux syscall number for `landlock_add_rule`. */
export const SYS_LANDLOCK_ADD_RULE = 445n;
/** Linux syscall number for `landlock_restrict_self`. */
export const SYS_LANDLOCK_RESTRICT_SELF = 446n;
/** Linux syscall number for `seccomp`, used to install a filter via `syscall`. */
export const SYS_SECCOMP = 317n;
/** Linux syscall number for `unshare`, used to detach namespaces. */
export const SYS_UNSHARE = 272n;
/**
 * Encode a JS string as a null-terminated UTF-8 buffer suitable for a libc
 * `char*` argument.
 *
 * The returned buffer is one byte longer than the encoded string; the trailing
 * byte is the zero terminator libc expects. Pass the result directly as a
 * `buffer` FFI argument. Keep a reference to it alive until the call returns so
 * the GC does not reclaim the backing memory mid-call.
 *
 * ```ts no_run
 * import { libc, cstr } from 'internal:security/sandbox/ffi';
 *
 * libc.symbols.chdir(cstr('/tmp'));
 * ```
 */
export function cstr(s: string): Uint8Array {
  const enc = new TextEncoder().encode(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}
/**
 * Build a null-terminated `char**` from JS strings, as `execve` expects for its
 * `argv` and `envp` arguments.
 *
 * `ptrBuf` is an array of little-endian 64-bit pointers, one per input string
 * plus a trailing null entry, each pointing at a null-terminated copy of the
 * corresponding string. `bufs` holds those string copies. Both the pointer
 * array and every buffer in `bufs` must stay reachable until the syscall
 * returns, otherwise the GC may free the string memory the kernel is still
 * reading — so bind the whole result to a variable that outlives the call.
 *
 * ```ts no_run
 * import { libc, cstr, buildCStringArray } from 'internal:security/sandbox/ffi';
 *
 * const path = cstr('/bin/echo');
 * const argv = buildCStringArray(['/bin/echo', 'hello']);
 * const envp = buildCStringArray(['PATH=/usr/bin']);
 * // argv and envp must remain in scope across this call.
 * libc.symbols.execve(path, argv.ptrBuf, envp.ptrBuf);
 * ```
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
/**
 * Set or clear the close-on-exec flag on a descriptor.
 *
 * When `on` is true the descriptor is closed automatically at the next
 * `execve`, keeping it out of the target program; when false the descriptor is
 * deliberately kept open across `execve` so it can be inherited (for example a
 * status pipe the launcher hands to its child). Failures from the underlying
 * `fcntl` are not surfaced.
 *
 * ```ts no_run
 * import { setCloexec } from 'internal:security/sandbox/ffi';
 *
 * setCloexec(statusPipeWriteFd, false); // let the child inherit it
 * ```
 */
export function setCloexec(fd: number, on: boolean): void {
  libc.symbols.fcntl(fd, F_SETFD, on ? FD_CLOEXEC : 0);
}
/**
 * Canonicalize a path with `realpath(3)`, resolving symlinks and firmlinks
 * (e.g. `/tmp` → `/private/tmp` on macOS). Returns the original path unchanged
 * when it cannot be resolved (e.g. it does not exist). macOS Seatbelt matches
 * rules against the canonical path, so profile paths must be resolved first.
 *
 * ```ts no_run
 * import { realpathSync } from 'internal:security/sandbox/ffi';
 *
 * const canonical = realpathSync('/tmp'); // '/private/tmp' on macOS
 * ```
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
 *
 * Reads the whole file in 4 KiB chunks and decodes it as UTF-8. Intended for
 * the short pseudo-files these subsystems expose; there is no size limit, so do
 * not point it at large or streaming files. A `null` result means the file
 * could not be opened (missing, or permission denied); an empty readable file
 * yields `''`, not `null`.
 *
 * ```ts no_run
 * import { readFileSync } from 'internal:security/sandbox/ffi';
 *
 * const max = readFileSync('/sys/fs/cgroup/memory.max');
 * if (max === null) throw new Error('cgroup not readable');
 * ```
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
 *
 * Reads until `maxBytes` bytes have been collected or the file ends, whichever
 * comes first, and returns a view of exactly the bytes read — which may be
 * shorter than `maxBytes` for a small file. A `null` result means the file
 * could not be opened.
 *
 * ```ts no_run
 * import { readFileBytesSync } from 'internal:security/sandbox/ffi';
 *
 * const header = readFileBytesSync('/proc/self/exe', 20);
 * const isElf = header !== null &&
 *   header[0] === 0x7f && header[1] === 0x45; // 0x7f 'E'
 * ```
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
 * Synchronously write a string to a file, returning 0 on success or the errno
 * on failure.
 *
 * By default the file is opened write-only and must already exist, matching
 * cgroup control files, which are pre-created by the kernel and accept a single
 * small write. Pass `create` as true to create and truncate the file (mode
 * 0644) when it may not exist yet. The content is written in a single `write`
 * call; a short write is treated as success (0), so this is meant for the small
 * control-file writes the launcher performs, not for arbitrary bulk output.
 *
 * ```ts no_run
 * import { writeFileSync } from 'internal:security/sandbox/ffi';
 *
 * const rc = writeFileSync('/sys/fs/cgroup/fino.scope/memory.max', '536870912');
 * if (rc !== 0) throw new Error(`cgroup write failed: errno ${rc}`);
 * ```
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
