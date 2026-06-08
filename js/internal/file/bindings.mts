/**
 * Shared libc FFI bindings, constants, and helpers for internal file modules.
 *
 * This module centralizes platform-specific POSIX bindings for `fino:file`
 * implementations. It opens libc, exposes file and directory syscalls, maps
 * numeric errno values to stable error codes, and provides path/string helpers
 * used by stat parsing, directory entries, handles, and filesystem providers.
 *
 * Darwin and Linux differ in flag values, `struct stat` layout, async file I/O,
 * and directory entry encoding, so consumers should import the exported
 * constants instead of copying numeric values. Runtime-facing helpers throw
 * normalized JavaScript errors with syscall and path context when syscalls fail.
 *
 * ## Example
 *
 * ```typescript no_run
 * import * as bindings from 'internal:file/bindings';
 *
 * const path = bindings.cstr('/tmp/fino-example.txt');
 * const fd = bindings.lib.symbols.open(
 *   path,
 *   bindings.O_CREAT | bindings.O_RDWR | bindings.O_TRUNC,
 *   0o644,
 * );
 * if (fd < 0) bindings.throwErrno('open', '/tmp/fino-example.txt');
 * bindings.lib.symbols.close(fd);
 * ```
 *
 * @internal
 */

import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import { encodeUtf8, decodeUtf8 } from '../globals/encoding.mts';
import { Path } from '../../file/path.mts';

export { Pointer };
export { encodeUtf8, decodeUtf8 };

interface LoopModule {
  submit(fn: (raw: object, id: number) => void): Promise<{ res: number }>;
  readable(fd: number): Promise<number>;
}

interface AsyncOpsModule {
  asyncOpen(raw: object, pathBuf: ArrayBuffer, flags: number, mode: number, id: number): void;
  asyncRead(raw: object, fd: number, buf: ArrayBuffer, len: number, id: number): void;
  asyncClose(raw: object, fd: number, id: number): void;
}

interface ErrnoError extends Error {
  code?: string | number;
  syscall?: string;
  path?: string;
}

/**
 * True when the runtime is running on macOS.
 *
 * File binding constants and struct layouts depend on this value. Linux uses
 * the `false` branch.
 *
 * ```typescript no_run
 * import { isDarwin } from 'internal:file/bindings';
 * if (isDarwin) {
 *   // Use Darwin-specific stat/dirent layout.
 * }
 * ```
 *
 * @internal
 */
export const isDarwin = os === 'darwin';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';

// POSIX errno → string code. Values ≤34 are identical on Linux and macOS.
// Platform-divergent values are listed separately.
const _ERRNO_CODES: Record<number, string> = {
  1: 'EPERM',   2: 'ENOENT',  3: 'ESRCH',   4: 'EINTR',   5: 'EIO',
  6: 'ENXIO',   7: 'E2BIG',   8: 'ENOEXEC', 9: 'EBADF',  10: 'ECHILD',
  11: isDarwin ? 'EDEADLK' : 'EAGAIN',
  12: 'ENOMEM', 13: 'EACCES', 14: 'EFAULT', 16: 'EBUSY',  17: 'EEXIST',
  18: 'EXDEV',  19: 'ENODEV', 20: 'ENOTDIR',21: 'EISDIR', 22: 'EINVAL',
  23: 'ENFILE', 24: 'EMFILE', 25: 'ENOTTY', 27: 'EFBIG',  28: 'ENOSPC',
  29: 'ESPIPE', 30: 'EROFS',  31: 'EMLINK', 32: 'EPIPE',  33: 'EDOM',
  34: 'ERANGE',
  // macOS-specific
  ...(isDarwin ? {
    35: 'EAGAIN', 36: 'EINPROGRESS', 37: 'EALREADY', 38: 'ENOTSOCK',
    60: 'ETIMEDOUT', 61: 'ECONNREFUSED', 63: 'ECONNRESET', 66: 'ENOTEMPTY',
  } : {
    // Linux-specific
    11: 'EAGAIN', 35: 'EDEADLK', 36: 'ENAMETOOLONG', 37: 'ENOLCK',
    38: 'ENOSYS', 39: 'ENOTEMPTY', 98: 'EADDRINUSE', 99: 'EADDRNOTAVAIL',
    110: 'ETIMEDOUT', 111: 'ECONNREFUSED', 104: 'ECONNRESET',
  }),
};

// Both platforms need fino:loop for async reads.
// Linux additionally uses fino:io_uring for IORING_OP_READ / IORING_OP_OPENAT.
//
// macOS: kqueue EVFILT_READ on a regular file (vnode) fires when
//   current_file_offset < file_size, with ev.data = file_size - current_offset
//   (bytes remaining). It does NOT fire when offset == file_size (at EOF).
//   We therefore check the current offset via lseek(SEEK_CUR) before each
//   loop.readable() call to avoid hanging at EOF.
/**
 * Loaded event-loop module used by async file reads and close operations.
 *
 * Set during module initialization. It is nullable only to reflect dynamic
 * import failure before initialization completes.
 *
 * ```typescript no_run
 * import * as bindings from 'internal:file/bindings';
 * const loop = bindings.loopModule;
 * ```
 *
 * @internal
 */
export let loopModule: LoopModule | null = null;
/**
 * Linux io_uring async file operation bindings.
 *
 * `null` on macOS, where file reads use kqueue-assisted synchronous reads.
 *
 * ```typescript no_run
 * import { asyncOps } from 'internal:file/bindings';
 * if (asyncOps) void asyncOps.asyncRead;
 * ```
 *
 * @internal
 */
export let asyncOps: AsyncOpsModule | null = null;
loopModule = await import('internal:runtime/loop');
if (!isDarwin) {
  asyncOps = await import('internal:runtime/io_uring');
}
const errnoFn = isDarwin ? '__error' : '__errno_location';

/**
 * Platform libc handle with filesystem-related symbols.
 *
 * The symbol signatures are intentionally low-level and return native errno
 * results. Callers should use `throwErrno` after nonzero or negative syscall
 * results.
 *
 * ```typescript no_run
 * import { lib, cstr } from 'internal:file/bindings';
 * const rc = lib.symbols.access(cstr('/tmp'), 0);
 * ```
 *
 * @internal
 */
export const lib = dlopen(LIBC, {
  open:       { parameters: ['buffer', 'i32', 'i32'],          result: 'i32'     },
  close:      { parameters: ['i32'],                            result: 'i32'     },
  stat:       { parameters: ['buffer', 'buffer'],               result: 'i32'     },
  lstat:      { parameters: ['buffer', 'buffer'],               result: 'i32'     },
  fstat:      { parameters: ['i32', 'buffer'],                  result: 'i32'     },
  opendir:    { parameters: ['buffer'],                         result: 'pointer' },
  readdir:    { parameters: ['pointer'],                        result: 'pointer' },
  closedir:   { parameters: ['pointer'],                        result: 'i32'     },
  mkdir:      { parameters: ['buffer', 'u32'],                  result: 'i32'     },
  rmdir:      { parameters: ['buffer'],                         result: 'i32'     },
  unlink:     { parameters: ['buffer'],                         result: 'i32'     },
  rename:     { parameters: ['buffer', 'buffer'],               result: 'i32'     },
  readlink:   { parameters: ['buffer', 'buffer', 'usize'],      result: 'isize'   },
  symlink:    { parameters: ['buffer', 'buffer'],               result: 'i32'     },
  realpath:   { parameters: ['buffer', 'buffer'],               result: 'pointer' },
  fchmod:     { parameters: ['i32', 'u32'],                     result: 'i32'     },
  read:       { parameters: ['i32', 'buffer', 'usize'],         result: 'isize'   },
  write:      { parameters: ['i32', 'buffer', 'usize'],         result: 'isize'   },
  lseek:      { parameters: ['i32', 'i64', 'i32'],              result: 'i64'     },
  pread:      { parameters: ['i32', 'buffer', 'usize', 'i64'], result: 'isize'   },
  pwrite:     { parameters: ['i32', 'buffer', 'usize', 'i64'], result: 'isize'   },
  fsync:      { parameters: ['i32'],                            result: 'i32'     },
  ftruncate:  { parameters: ['i32', 'i64'],                     result: 'i32'     },
  [errnoFn]:  { parameters: [],                                 result: 'pointer' },
  chmod:     { parameters: ['buffer', 'u32'],                   result: 'i32'     },
  chown:     { parameters: ['buffer', 'i32', 'i32'],            result: 'i32'     },
  lchown:    { parameters: ['buffer', 'i32', 'i32'],            result: 'i32'     },
  utimes:    { parameters: ['buffer', 'buffer'],                result: 'i32'     },
  truncate:  { parameters: ['buffer', 'i64'],                   result: 'i32'     },
  link:      { parameters: ['buffer', 'buffer'],                result: 'i32'     },
  access:    { parameters: ['buffer', 'i32'],                   result: 'i32'     },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Open read-only flag for `open(2)`.
 * ```typescript no_run
 * import { O_RDONLY } from 'internal:file/bindings';
 * void O_RDONLY;
 * ```
 * @internal */
export const O_RDONLY = 0;
/** Open write-only flag for `open(2)`.
 * ```typescript no_run
 * import { O_WRONLY } from 'internal:file/bindings';
 * void O_WRONLY;
 * ```
 * @internal */
export const O_WRONLY = 1;
/** Open read-write flag for `open(2)`.
 * ```typescript no_run
 * import { O_RDWR } from 'internal:file/bindings';
 * void O_RDWR;
 * ```
 * @internal */
export const O_RDWR   = 2;
/** Create file flag for `open(2)`, platform-adjusted.
 * ```typescript no_run
 * import { O_CREAT } from 'internal:file/bindings';
 * void O_CREAT;
 * ```
 * @internal */
export const O_CREAT  = isDarwin ? 0x0200 : 0x040;
/** Truncate file flag for `open(2)`, platform-adjusted.
 * ```typescript no_run
 * import { O_TRUNC } from 'internal:file/bindings';
 * void O_TRUNC;
 * ```
 * @internal */
export const O_TRUNC  = isDarwin ? 0x0400 : 0x200;
/** Append write flag for `open(2)`, platform-adjusted.
 * ```typescript no_run
 * import { O_APPEND } from 'internal:file/bindings';
 * void O_APPEND;
 * ```
 * @internal */
export const O_APPEND = isDarwin ? 0x0008 : 0x400;
/** Exclusive create flag for `open(2)`, platform-adjusted.
 * ```typescript no_run
 * import { O_EXCL } from 'internal:file/bindings';
 * void O_EXCL;
 * ```
 * @internal */
export const O_EXCL   = isDarwin ? 0x0800 : 0x080;

/** POSIX file-type mask used with `mode`.
 * ```typescript no_run
 * import { S_IFMT } from 'internal:file/bindings';
 * void S_IFMT;
 * ```
 * @internal */
export const S_IFMT   = 0xF000;
/** POSIX regular-file mode bit.
 * ```typescript no_run
 * import { S_IFREG } from 'internal:file/bindings';
 * void S_IFREG;
 * ```
 * @internal */
export const S_IFREG  = 0x8000;
/** POSIX directory mode bit.
 * ```typescript no_run
 * import { S_IFDIR } from 'internal:file/bindings';
 * void S_IFDIR;
 * ```
 * @internal */
export const S_IFDIR  = 0x4000;
/** POSIX symlink mode bit.
 * ```typescript no_run
 * import { S_IFLNK } from 'internal:file/bindings';
 * void S_IFLNK;
 * ```
 * @internal */
export const S_IFLNK  = 0xA000;
/** POSIX socket mode bit.
 * ```typescript no_run
 * import { S_IFSOCK } from 'internal:file/bindings';
 * void S_IFSOCK;
 * ```
 * @internal */
export const S_IFSOCK = 0xC000;
/** POSIX FIFO mode bit.
 * ```typescript no_run
 * import { S_IFIFO } from 'internal:file/bindings';
 * void S_IFIFO;
 * ```
 * @internal */
export const S_IFIFO  = 0x1000;
/** POSIX block-device mode bit.
 * ```typescript no_run
 * import { S_IFBLK } from 'internal:file/bindings';
 * void S_IFBLK;
 * ```
 * @internal */
export const S_IFBLK  = 0x6000;
/** POSIX character-device mode bit.
 * ```typescript no_run
 * import { S_IFCHR } from 'internal:file/bindings';
 * void S_IFCHR;
 * ```
 * @internal */
export const S_IFCHR  = 0x2000;

/** Seek from file start.
 * ```typescript no_run
 * import { SEEK_SET } from 'internal:file/bindings';
 * void SEEK_SET;
 * ```
 * @internal */
export const SEEK_SET = 0;
/** Seek from current file offset.
 * ```typescript no_run
 * import { SEEK_CUR } from 'internal:file/bindings';
 * void SEEK_CUR;
 * ```
 * @internal */
export const SEEK_CUR = 1;
/** Seek from file end.
 * ```typescript no_run
 * import { SEEK_END } from 'internal:file/bindings';
 * void SEEK_END;
 * ```
 * @internal */
export const SEEK_END = 2;

/** Existence check flag for `access(2)`.
 * ```typescript no_run
 * import { F_OK } from 'internal:file/bindings';
 * void F_OK;
 * ```
 * @internal */
export const F_OK = 0;
/** Read permission check flag for `access(2)`.
 * ```typescript no_run
 * import { R_OK } from 'internal:file/bindings';
 * void R_OK;
 * ```
 * @internal */
export const R_OK = 4;
/** Write permission check flag for `access(2)`.
 * ```typescript no_run
 * import { W_OK } from 'internal:file/bindings';
 * void W_OK;
 * ```
 * @internal */
export const W_OK = 2;
/** Execute permission check flag for `access(2)`.
 * ```typescript no_run
 * import { X_OK } from 'internal:file/bindings';
 * void X_OK;
 * ```
 * @internal */
export const X_OK = 1;

/** Unknown directory-entry type.
 * ```typescript no_run
 * import { DT_UNKNOWN } from 'internal:file/bindings';
 * void DT_UNKNOWN;
 * ```
 * @internal */
export const DT_UNKNOWN = 0;
/** FIFO directory-entry type.
 * ```typescript no_run
 * import { DT_FIFO } from 'internal:file/bindings';
 * void DT_FIFO;
 * ```
 * @internal */
export const DT_FIFO    = 1;
/** Character-device directory-entry type.
 * ```typescript no_run
 * import { DT_CHR } from 'internal:file/bindings';
 * void DT_CHR;
 * ```
 * @internal */
export const DT_CHR     = 2;
/** Directory directory-entry type.
 * ```typescript no_run
 * import { DT_DIR } from 'internal:file/bindings';
 * void DT_DIR;
 * ```
 * @internal */
export const DT_DIR     = 4;
/** Block-device directory-entry type.
 * ```typescript no_run
 * import { DT_BLK } from 'internal:file/bindings';
 * void DT_BLK;
 * ```
 * @internal */
export const DT_BLK     = 6;
/** Regular-file directory-entry type.
 * ```typescript no_run
 * import { DT_REG } from 'internal:file/bindings';
 * void DT_REG;
 * ```
 * @internal */
export const DT_REG     = 8;
/** Symlink directory-entry type.
 * ```typescript no_run
 * import { DT_LNK } from 'internal:file/bindings';
 * void DT_LNK;
 * ```
 * @internal */
export const DT_LNK     = 10;
/** Socket directory-entry type.
 * ```typescript no_run
 * import { DT_SOCK } from 'internal:file/bindings';
 * void DT_SOCK;
 * ```
 * @internal */
export const DT_SOCK    = 12;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Encode a JS string as a null-terminated UTF-8 buffer.
 *
 * The returned `Uint8Array` is suitable for libc calls expecting `char *`.
 * Embedded null bytes are preserved and may truncate the path at the C layer.
 *
 * ```typescript no_run
 * import { cstr } from 'internal:file/bindings';
 * const path = cstr('/tmp/file.txt');
 * ```
 *
 * @internal
 */
export function cstr(s: string): Uint8Array {
  const enc = encodeUtf8(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}

/**
 * Throw an error annotated with the current errno value.
 *
 * Reads thread-local errno, maps common values to POSIX names, and attaches
 * `code`, `syscall`, and `path` fields to the thrown `Error`.
 *
 * ```typescript no_run
 * import { lib, cstr, throwErrno } from 'internal:file/bindings';
 * if (lib.symbols.unlink(cstr('/missing')) !== 0) throwErrno('unlink', '/missing');
 * ```
 *
 * @internal
 */
export function throwErrno(syscall: string, path: string): never {
  const getErrno = lib.symbols[errnoFn] as () => object;
  const num  = Pointer.readI32(getErrno(), 0);
  throwErrnoCode(syscall, path, num);
}

/**
 * Throw an error annotated with an explicit errno value.
 *
 * Linux io_uring completions report failures as negative errno values rather
 * than setting thread-local errno in the JavaScript thread. Use this helper for
 * those completion results.
 *
 * @internal
 */
export function throwErrnoCode(syscall: string, path: string, errno: number): never {
  const num = Math.abs(errno);
  const code = _ERRNO_CODES[num] ?? `E${num}`;
  const err: ErrnoError = new Error(`${syscall}('${path}'): ${code}`);
  err.code    = code;
  err.syscall = syscall;
  err.path    = path;
  throw err;
}

/**
 * Read a null-terminated C string from a pointer at a byte offset.
 *
 * Bytes are decoded as UTF-8. Reading stops at the first null byte; malformed
 * UTF-8 uses replacement semantics from the decoder.
 *
 * ```typescript no_run
 * import { readCStr } from 'internal:file/bindings';
 * const name = readCStr(direntPtr, 19);
 * ```
 *
 * @internal
 */
export function readCStr(ptr: object, offset: number): string {
  const bytes = [];
  let i = 0;
  while (true) {
    const b = Pointer.readU8(ptr, offset + i);
    if (b === 0) break;
    bytes.push(b);
    i++;
  }
  return decodeUtf8(new Uint8Array(bytes));
}

/**
 * Coerce a `Path` or string to a plain string for FFI and diagnostics.
 *
 * Non-Path values are converted with `String`.
 *
 * ```typescript no_run
 * import { _toStr } from 'internal:file/bindings';
 * const text = _toStr('/tmp/file.txt');
 * ```
 *
 * @internal
 */
export function _toStr(p: Path | string): string {
  return p instanceof Path ? p.toString() : String(p);
}

/**
 * Coerce a `Path` or string to a `Path` instance.
 *
 * Existing `Path` objects are returned unchanged.
 *
 * ```typescript no_run
 * import { _toPath } from 'internal:file/bindings';
 * const path = _toPath('/tmp/file.txt');
 * ```
 *
 * @internal
 */
export function _toPath(p: Path | string): Path {
  return p instanceof Path ? p : new Path(p);
}

/**
 * Join a directory path and child name.
 *
 * Uses `Path.join` so separators are normalized consistently with the public
 * path module.
 *
 * ```typescript no_run
 * import { joinPath } from 'internal:file/bindings';
 * const child = joinPath('/tmp', 'file.txt');
 * ```
 *
 * @internal
 */
export function joinPath(dir: Path | string, name: string): string {
  return _toPath(dir).join(name).toString();
}

// ---------------------------------------------------------------------------
// Mode string → O_* flags
// ---------------------------------------------------------------------------

/**
 * Convert a file mode string into platform `O_*` flags.
 *
 * Supports `r`, `w`, `a`, `r+`, `w+`, `a+`, and internal `c+` (read-write,
 * create if missing, no append/truncate). Unknown modes throw before any syscall
 * is attempted.
 *
 * ```typescript no_run
 * import { modeToFlags } from 'internal:file/bindings';
 * const flags = modeToFlags('w+');
 * ```
 *
 * @internal
 */
export function modeToFlags(mode: string): number {
  switch (mode) {
    case 'r':  return O_RDONLY;
    case 'w':  return O_WRONLY | O_CREAT | O_TRUNC;
    case 'a':  return O_WRONLY | O_CREAT | O_APPEND;
    case 'r+': return O_RDWR;
    case 'w+': return O_RDWR   | O_CREAT | O_TRUNC;
    case 'a+': return O_RDWR   | O_CREAT | O_APPEND;
    case 'c+': return O_RDWR   | O_CREAT;
    default:   throw new Error(`Unknown file mode: '${mode}'`);
  }
}

/**
 * Return whether a mode string permits reading.
 *
 * Unknown strings are treated by their literal value here; validation happens
 * in `modeToFlags`.
 *
 * ```typescript no_run
 * import { modeIsReadable } from 'internal:file/bindings';
 * modeIsReadable('a+'); // true
 * ```
 *
 * @internal
 */
export function modeIsReadable(mode: string): boolean {
  return mode === 'r' || mode === 'r+' || mode === 'w+' || mode === 'a+' || mode === 'c+';
}

/**
 * Return whether a mode string permits writing.
 *
 * Only plain `r` is considered non-writable.
 *
 * ```typescript no_run
 * import { modeIsWritable } from 'internal:file/bindings';
 * modeIsWritable('w'); // true
 * ```
 *
 * @internal
 */
export function modeIsWritable(mode: string): boolean {
  return mode !== 'r';
}
