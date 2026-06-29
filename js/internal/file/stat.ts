/**
* POSIX `struct stat` parser for internal `fino:file` providers.
*
* This module converts native `stat(2)`, `lstat(2)`, and `fstat(2)` result
* buffers into the JavaScript `Stat` value used by file providers and entries.
* It handles the platform layouts currently supported by the runtime and
* exposes convenience predicates for common POSIX file types.
*
* Parsed timestamp values are milliseconds since the Unix epoch. The Linux
* layout used here does not provide birth time, so `birthtimeMs` is zero there;
* callers that need creation time should treat that value as best-effort.
*
* ## Example
*
* ```typescript no_run
* import { Stat } from 'internal:file/stat';
*
* const stat = await file.stat();
* if (stat.isFile()) {
*   console.log(stat.size, stat.permissions.toString(8));
* }
* ```
*
* @internal
*/
import { isDarwin, S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFSOCK, S_IFIFO, S_IFBLK, S_IFCHR } from './bindings.ts';
import { arch } from 'internal:process';
/**
* File metadata parsed from a struct stat buffer.
*
* Numeric fields that may be large (ino, dev, size, blocks) are returned as
* Numbers; they fit within JS safe-integer range for all practical file sizes.
*
* ```typescript no_run
* import { Stat } from 'internal:file/stat';
* const stat = new Stat(1, 2, 0o100644, 1, 501, 20, 0, 12, 4096, 1, 0, 0, 0, 0);
* stat.isFile(); // true
* ```
*
* @internal
*/
export class Stat {
  /**
  * Private property `#nlink` used by `Stat`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #nlink = undefined;
  *
  *   readInternalState() {
  *     return this.#nlink;
  *   }
  * }
  * ```
  *
  * @internal
  */
  /**
  * Private property `#mode` used by `Stat`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #mode = undefined;
  *
  *   readInternalState() {
  *     return this.#mode;
  *   }
  * }
  * ```
  *
  * @internal
  */
  /**
  * Private property `#ino` used by `Stat`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #ino = undefined;
  *
  *   readInternalState() {
  *     return this.#ino;
  *   }
  * }
  * ```
  *
  * @internal
  */
  /**
  * Private `#dev` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #dev = 0;
  *
  *   read() {
  *     return this.#dev;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #dev: number;
  /**
  * Private `#ino` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #ino = 0;
  *
  *   read() {
  *     return this.#ino;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #ino: number;
  /**
  * Private `#mode` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #mode = 0;
  *
  *   read() {
  *     return this.#mode;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #mode: number;
  /**
  * Private `#nlink` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #nlink = 0;
  *
  *   read() {
  *     return this.#nlink;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #nlink: number;
  /**
  * Private `#uid` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #uid = 0;
  *
  *   read() {
  *     return this.#uid;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #uid: number;
  /**
  * Private `#gid` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #gid = 0;
  *
  *   read() {
  *     return this.#gid;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #gid: number;
  /**
  * Private `#rdev` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #rdev = 0;
  *
  *   read() {
  *     return this.#rdev;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #rdev: number;
  /**
  * Private `#size` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #size = 0;
  *
  *   read() {
  *     return this.#size;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #size: number;
  /**
  * Private `#blksize` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #blksize = 0;
  *
  *   read() {
  *     return this.#blksize;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #blksize: number;
  /**
  * Private `#blocks` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #blocks = 0;
  *
  *   read() {
  *     return this.#blocks;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #blocks: number;
  /**
  * Private `#atimeMs` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #atimeMs = 0;
  *
  *   read() {
  *     return this.#atimeMs;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #atimeMs: number;
  /**
  * Private `#mtimeMs` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #mtimeMs = 0;
  *
  *   read() {
  *     return this.#mtimeMs;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #mtimeMs: number;
  /**
  * Private `#ctimeMs` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #ctimeMs = 0;
  *
  *   read() {
  *     return this.#ctimeMs;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #ctimeMs: number;
  /**
  * Private `#birthtimeMs` stat field parsed from platform metadata.
  *
  * This member is emitted by the docs generator when
  * `--include-private` is enabled. It is maintained by runtime
  * internals and should be changed only with the surrounding
  * implementation contract in mind.
  *
  * @example
  * ```ts no_run
  * class StatExample {
  *   #birthtimeMs = 0;
  *
  *   read() {
  *     return this.#birthtimeMs;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #birthtimeMs: number;
  /**
  * Create a parsed stat value.
  *
  * Timestamps are milliseconds since the Unix epoch. `birthtimeMs` is zero on
  * Linux because the parsed layout does not include creation time.
  *
  * ```typescript no_run
  * import { Stat } from 'internal:file/stat';
  * const stat = new Stat(1, 2, 0o100644, 1, 501, 20, 0, 12, 4096, 1, 0, 0, 0, 0);
  * ```
  */
  constructor(dev: number, ino: number, mode: number, nlink: number, uid: number, gid: number, rdev: number, size: number, blksize: number, blocks: number, atimeMs: number, mtimeMs: number, ctimeMs: number, birthtimeMs: number) {
    this.#dev = dev;
    this.#ino = ino;
    this.#mode = mode;
    this.#nlink = nlink;
    this.#uid = uid;
    this.#gid = gid;
    this.#rdev = rdev;
    this.#size = size;
    this.#blksize = blksize;
    this.#blocks = blocks;
    this.#atimeMs = atimeMs;
    this.#mtimeMs = mtimeMs;
    this.#ctimeMs = ctimeMs;
    this.#birthtimeMs = birthtimeMs;
  }
  /**
  * Device ID containing the inode.
  *
  * ```typescript no_run
  * const dev = stat.dev;
  * ```
  */
  get dev() {
    return this.#dev;
  }
  /**
  * Inode number.
  *
  * ```typescript no_run
  * const ino = stat.ino;
  * ```
  */
  get ino() {
    return this.#ino;
  }
  /**
  * Raw POSIX mode bits, including file type and permissions.
  *
  * ```typescript no_run
  * const mode = stat.mode;
  * ```
  */
  get mode() {
    return this.#mode;
  }
  /**
  * Hard-link count.
  *
  * ```typescript no_run
  * const links = stat.nlink;
  * ```
  */
  get nlink() {
    return this.#nlink;
  }
  /**
  * Owner user ID.
  *
  * ```typescript no_run
  * const uid = stat.uid;
  * ```
  */
  get uid() {
    return this.#uid;
  }
  /**
  * Owner group ID.
  *
  * ```typescript no_run
  * const gid = stat.gid;
  * ```
  */
  get gid() {
    return this.#gid;
  }
  /**
  * Device ID for special files.
  *
  * ```typescript no_run
  * const rdev = stat.rdev;
  * ```
  */
  get rdev() {
    return this.#rdev;
  }
  /**
  * File size in bytes.
  *
  * ```typescript no_run
  * const size = stat.size;
  * ```
  */
  get size() {
    return this.#size;
  }
  /**
  * Preferred block size for filesystem I/O.
  *
  * ```typescript no_run
  * const blockSize = stat.blksize;
  * ```
  */
  get blksize() {
    return this.#blksize;
  }
  /**
  * Allocated block count.
  *
  * ```typescript no_run
  * const blocks = stat.blocks;
  * ```
  */
  get blocks() {
    return this.#blocks;
  }
  /**
  * Last access time in milliseconds since Unix epoch.
  *
  * ```typescript no_run
  * const atime = stat.atimeMs;
  * ```
  */
  get atimeMs() {
    return this.#atimeMs;
  }
  /**
  * Last modification time in milliseconds since Unix epoch.
  *
  * ```typescript no_run
  * const mtime = stat.mtimeMs;
  * ```
  */
  get mtimeMs() {
    return this.#mtimeMs;
  }
  /**
  * Last status-change time in milliseconds since Unix epoch.
  *
  * ```typescript no_run
  * const ctime = stat.ctimeMs;
  * ```
  */
  get ctimeMs() {
    return this.#ctimeMs;
  }
  /**
  * Creation time in milliseconds since Unix epoch when available.
  *
  * Linux parsing returns zero because the current struct layout does not expose
  * birth time.
  *
  * ```typescript no_run
  * const birth = stat.birthtimeMs;
  * ```
  */
  get birthtimeMs() {
    return this.#birthtimeMs;
  }
  /**
  * Permission bits (`mode & 0o7777`).
  *
  * ```typescript no_run
  * const perms = stat.permissions;
  * ```
  */
  get permissions(): number {
    return this.#mode & 4095;
  }
  /**
  * Return true when the mode identifies a regular file.
  *
  * ```typescript no_run
  * if (stat.isFile()) void stat.size;
  * ```
  */
  isFile(): boolean {
    return (this.#mode & S_IFMT) === S_IFREG;
  }
  /**
  * Return true when the mode identifies a directory.
  *
  * ```typescript no_run
  * const dir = stat.isDirectory();
  * ```
  */
  isDirectory(): boolean {
    return (this.#mode & S_IFMT) === S_IFDIR;
  }
  /**
  * Return true when the mode identifies a symbolic link.
  *
  * ```typescript no_run
  * const link = stat.isSymlink();
  * ```
  */
  isSymlink(): boolean {
    return (this.#mode & S_IFMT) === S_IFLNK;
  }
  /**
  * Return true when the mode identifies a socket.
  *
  * ```typescript no_run
  * const socket = stat.isSocket();
  * ```
  */
  isSocket(): boolean {
    return (this.#mode & S_IFMT) === S_IFSOCK;
  }
  /**
  * Return true when the mode identifies a FIFO.
  *
  * ```typescript no_run
  * const fifo = stat.isFIFO();
  * ```
  */
  isFIFO(): boolean {
    return (this.#mode & S_IFMT) === S_IFIFO;
  }
  /**
  * Return true when the mode identifies a block device.
  *
  * ```typescript no_run
  * const block = stat.isBlockDevice();
  * ```
  */
  isBlockDevice(): boolean {
    return (this.#mode & S_IFMT) === S_IFBLK;
  }
  /**
  * Return true when the mode identifies a character device.
  *
  * ```typescript no_run
  * const chr = stat.isCharacterDevice();
  * ```
  */
  isCharacterDevice(): boolean {
    return (this.#mode & S_IFMT) === S_IFCHR;
  }
  /**
  * Parse a struct stat from a 256-byte ArrayBuffer.
  * Layout differs between macOS arm64 and Linux x86_64.
  *
  * Throws only if the supplied buffer is too small for `DataView` reads. The
  * caller is responsible for passing a buffer filled by `stat`, `lstat`, or
  * `fstat`.
  *
  * ```typescript no_run
  * import { Stat } from 'internal:file/stat';
  * const stat = Stat.parse(new ArrayBuffer(256));
  * ```
  */
  static parse(buf: ArrayBuffer | ArrayBufferView): Stat {
    const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer);
    const toMs = (sec: number | bigint, ns: number | bigint): number => Number(sec) * 1e3 + Number(ns) / 1e6;
    if (isDarwin) {
      // macOS arm64 struct stat (144 bytes):
      //  0: i32 dev      4: u16 mode    6: u16 nlink
      //  8: u64 ino     16: u32 uid    20: u32 gid
      // 24: i32 rdev    28: pad(4)
      // 32: timespec atime (tv_sec i64 @32, tv_nsec i64 @40)
      // 48: timespec mtime (tv_sec i64 @48, tv_nsec i64 @56)
      // 64: timespec ctime (tv_sec i64 @64, tv_nsec i64 @72)
      // 80: timespec birthtime (tv_sec i64 @80, tv_nsec i64 @88)
      // 96: i64 size   104: i64 blocks  112: i32 blksize
      const dev = v.getInt32(0, true);
      const mode = v.getUint16(4, true);
      const nlink = v.getUint16(6, true);
      const ino = Number(v.getBigUint64(8, true));
      const uid = v.getUint32(16, true);
      const gid = v.getUint32(20, true);
      const rdev = v.getInt32(24, true);
      const atimeSec = v.getBigInt64(32, true);
      const atimeNs = v.getBigInt64(40, true);
      const mtimeSec = v.getBigInt64(48, true);
      const mtimeNs = v.getBigInt64(56, true);
      const ctimeSec = v.getBigInt64(64, true);
      const ctimeNs = v.getBigInt64(72, true);
      const btimeSec = v.getBigInt64(80, true);
      const btimeNs = v.getBigInt64(88, true);
      const size = Number(v.getBigInt64(96, true));
      const blocks = Number(v.getBigInt64(104, true));
      const blksize = v.getInt32(112, true);
      return new Stat(dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, toMs(atimeSec, atimeNs), toMs(mtimeSec, mtimeNs), toMs(ctimeSec, ctimeNs), toMs(btimeSec, btimeNs));
    } else if (arch === 'aarch64') {
      // Linux aarch64 glibc struct stat (128 bytes):
      //  0: u64 dev     8: u64 ino    16: u32 mode   20: u32 nlink
      // 24: u32 uid    28: u32 gid    32: u64 rdev
      // 48: i64 size   56: i64 blksize 64: i64 blocks
      // 72: timespec atime  (tv_sec i64 @72, tv_nsec i64 @80)
      // 88: timespec mtime  (tv_sec i64 @88, tv_nsec i64 @96)
      // 104: timespec ctime (tv_sec i64 @104, tv_nsec i64 @112)
      const dev = Number(v.getBigUint64(0, true));
      const ino = Number(v.getBigUint64(8, true));
      const mode = v.getUint32(16, true);
      const nlink = v.getUint32(20, true);
      const uid = v.getUint32(24, true);
      const gid = v.getUint32(28, true);
      const rdev = Number(v.getBigUint64(32, true));
      const size = Number(v.getBigInt64(48, true));
      const blksize = Number(v.getBigInt64(56, true));
      const blocks = Number(v.getBigInt64(64, true));
      const atimeSec = v.getBigInt64(72, true);
      const atimeNs = v.getBigInt64(80, true);
      const mtimeSec = v.getBigInt64(88, true);
      const mtimeNs = v.getBigInt64(96, true);
      const ctimeSec = v.getBigInt64(104, true);
      const ctimeNs = v.getBigInt64(112, true);
      return new Stat(dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, toMs(atimeSec, atimeNs), toMs(mtimeSec, mtimeNs), toMs(ctimeSec, ctimeNs), 0);
    } else {
      // Linux x86_64 struct stat (144 bytes):
      //  0: u64 dev     8: u64 ino    16: u64 nlink
      // 24: u32 mode   28: u32 uid   32: u32 gid
      // 36: pad(4)     40: u64 rdev
      // 48: i64 size   56: i64 blksize  64: i64 blocks
      // 72: timespec atime  (tv_sec i64 @72, tv_nsec i64 @80)
      // 88: timespec mtime  (tv_sec i64 @88, tv_nsec i64 @96)
      // 104: timespec ctime (tv_sec i64 @104, tv_nsec i64 @112)
      const dev = Number(v.getBigUint64(0, true));
      const ino = Number(v.getBigUint64(8, true));
      const nlink = Number(v.getBigUint64(16, true));
      const mode = v.getUint32(24, true);
      const uid = v.getUint32(28, true);
      const gid = v.getUint32(32, true);
      const rdev = Number(v.getBigUint64(40, true));
      const size = Number(v.getBigInt64(48, true));
      const blksize = Number(v.getBigInt64(56, true));
      const blocks = Number(v.getBigInt64(64, true));
      const atimeSec = v.getBigInt64(72, true);
      const atimeNs = v.getBigInt64(80, true);
      const mtimeSec = v.getBigInt64(88, true);
      const mtimeNs = v.getBigInt64(96, true);
      const ctimeSec = v.getBigInt64(104, true);
      const ctimeNs = v.getBigInt64(112, true);
      return new Stat(dev, ino, mode, nlink, uid, gid, rdev, size, blksize, blocks, toMs(atimeSec, atimeNs), toMs(mtimeSec, mtimeNs), toMs(ctimeSec, ctimeNs), 0);
    }
  }
}
