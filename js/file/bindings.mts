/**
 * internal:file-bindings — shared libc FFI bindings, constants, and helpers
 * for the fino:file sub-modules (stat, handle, entry, fs).
 */

import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import { encodeUtf8, decodeUtf8 } from '../internal/globals/encoding.mts';
import { Path } from './path.mts';

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
export let loopModule: LoopModule | null = null;
export let asyncOps: AsyncOpsModule | null = null;
loopModule = await import('../runtime/loop.mts');
if (!isDarwin) {
  asyncOps = await import('../internal/runtime/io_uring.mts');
}
const errnoFn = isDarwin ? '__error' : '__errno_location';

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

export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR   = 2;
export const O_CREAT  = isDarwin ? 0x0200 : 0x040;
export const O_TRUNC  = isDarwin ? 0x0400 : 0x200;
export const O_APPEND = isDarwin ? 0x0008 : 0x400;
export const O_EXCL   = isDarwin ? 0x0800 : 0x080;

export const S_IFMT   = 0xF000;
export const S_IFREG  = 0x8000;
export const S_IFDIR  = 0x4000;
export const S_IFLNK  = 0xA000;
export const S_IFSOCK = 0xC000;
export const S_IFIFO  = 0x1000;
export const S_IFBLK  = 0x6000;
export const S_IFCHR  = 0x2000;

export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

export const F_OK = 0;
export const R_OK = 4;
export const W_OK = 2;
export const X_OK = 1;

export const DT_UNKNOWN = 0;
export const DT_FIFO    = 1;
export const DT_CHR     = 2;
export const DT_DIR     = 4;
export const DT_BLK     = 6;
export const DT_REG     = 8;
export const DT_LNK     = 10;
export const DT_SOCK    = 12;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Encode a JS string as a null-terminated UTF-8 buffer. */
export function cstr(s: string): Uint8Array {
  const enc = encodeUtf8(s);
  const buf = new Uint8Array(enc.length + 1);
  buf.set(enc);
  return buf;
}

/** Throw an error annotated with the current errno value. */
export function throwErrno(syscall: string, path: string): never {
  const getErrno = lib.symbols[errnoFn] as () => object;
  const num  = Pointer.readI32(getErrno(), 0);
  const code = _ERRNO_CODES[num] ?? `E${num}`;
  const err: ErrnoError = new Error(`${syscall}('${path}'): ${code}`);
  err.code    = code;
  err.syscall = syscall;
  err.path    = path;
  throw err;
}

/** Read a null-terminated C string from a pointer at the given byte offset. */
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

/** Coerce a Path or string to a plain string for FFI / error messages. */
export function _toStr(p: Path | string): string {
  return p instanceof Path ? p.toString() : String(p);
}

/** Coerce a Path or string to a Path instance. */
export function _toPath(p: Path | string): Path {
  return p instanceof Path ? p : new Path(p);
}

/** Join a directory path and a child name, avoiding double slashes. */
export function joinPath(dir: Path | string, name: string): string {
  return _toPath(dir).join(name).toString();
}

// ---------------------------------------------------------------------------
// Mode string → O_* flags
// ---------------------------------------------------------------------------

export function modeToFlags(mode: string): number {
  switch (mode) {
    case 'r':  return O_RDONLY;
    case 'w':  return O_WRONLY | O_CREAT | O_TRUNC;
    case 'a':  return O_WRONLY | O_CREAT | O_APPEND;
    case 'r+': return O_RDWR;
    case 'w+': return O_RDWR   | O_CREAT | O_TRUNC;
    case 'a+': return O_RDWR   | O_CREAT | O_APPEND;
    default:   throw new Error(`Unknown file mode: '${mode}'`);
  }
}

export function modeIsReadable(mode: string): boolean {
  return mode === 'r' || mode === 'r+' || mode === 'w+' || mode === 'a+';
}

export function modeIsWritable(mode: string): boolean {
  return mode !== 'r';
}
