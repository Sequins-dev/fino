/**
 * internal:file-stat — Stat class for fino:file.
 *
 * Parses a struct stat buffer returned by stat(2) / lstat(2) / fstat(2).
 * Layout differs between macOS arm64 and Linux x86_64.
 *
 * @internal
 */

import {
  isDarwin,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFSOCK, S_IFIFO, S_IFBLK, S_IFCHR,
} from './bindings.mts';

/**
 * File metadata parsed from a struct stat buffer.
 *
 * Numeric fields that may be large (ino, dev, size, blocks) are returned as
 * Numbers; they fit within JS safe-integer range for all practical file sizes.
 */
export class Stat {
  #dev: number; #ino: number; #mode: number; #nlink: number;
  #uid: number; #gid: number; #rdev: number;
  #size: number; #blksize: number; #blocks: number;
  #atimeMs: number; #mtimeMs: number; #ctimeMs: number; #birthtimeMs: number;

  constructor(dev: number, ino: number, mode: number, nlink: number,
              uid: number, gid: number, rdev: number,
              size: number, blksize: number, blocks: number,
              atimeMs: number, mtimeMs: number, ctimeMs: number, birthtimeMs: number) {
    this.#dev        = dev;
    this.#ino        = ino;
    this.#mode       = mode;
    this.#nlink      = nlink;
    this.#uid        = uid;
    this.#gid        = gid;
    this.#rdev       = rdev;
    this.#size       = size;
    this.#blksize    = blksize;
    this.#blocks     = blocks;
    this.#atimeMs    = atimeMs;
    this.#mtimeMs    = mtimeMs;
    this.#ctimeMs    = ctimeMs;
    this.#birthtimeMs = birthtimeMs;
  }

  get dev()          { return this.#dev;        }
  get ino()          { return this.#ino;        }
  get mode()         { return this.#mode;       }
  get nlink()        { return this.#nlink;      }
  get uid()          { return this.#uid;        }
  get gid()          { return this.#gid;        }
  get rdev()         { return this.#rdev;       }
  get size()         { return this.#size;       }
  get blksize()      { return this.#blksize;    }
  get blocks()       { return this.#blocks;     }
  get atimeMs()      { return this.#atimeMs;    }
  get mtimeMs()      { return this.#mtimeMs;    }
  get ctimeMs()      { return this.#ctimeMs;    }
  get birthtimeMs()  { return this.#birthtimeMs;}

  /** Permission bits (mode & 0o7777). */
  get permissions(): number { return this.#mode & 0o7777; }

  isFile():            boolean { return (this.#mode & S_IFMT) === S_IFREG;  }
  isDirectory():       boolean { return (this.#mode & S_IFMT) === S_IFDIR;  }
  isSymlink():         boolean { return (this.#mode & S_IFMT) === S_IFLNK;  }
  isSocket():          boolean { return (this.#mode & S_IFMT) === S_IFSOCK; }
  isFIFO():            boolean { return (this.#mode & S_IFMT) === S_IFIFO;  }
  isBlockDevice():     boolean { return (this.#mode & S_IFMT) === S_IFBLK;  }
  isCharacterDevice(): boolean { return (this.#mode & S_IFMT) === S_IFCHR;  }

  /**
   * Parse a struct stat from a 256-byte ArrayBuffer.
   * Layout differs between macOS arm64 and Linux x86_64.
   */
  static parse(buf: ArrayBuffer | ArrayBufferView): Stat {
    const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer);
    const toMs = (sec: number | bigint, ns: number | bigint): number => Number(sec) * 1000 + Number(ns) / 1_000_000;

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
      const dev       = v.getInt32(0,   true);
      const mode      = v.getUint16(4,  true);
      const nlink     = v.getUint16(6,  true);
      const ino       = Number(v.getBigUint64(8,  true));
      const uid       = v.getUint32(16, true);
      const gid       = v.getUint32(20, true);
      const rdev      = v.getInt32(24,  true);
      const atimeSec  = v.getBigInt64(32, true);
      const atimeNs   = v.getBigInt64(40, true);
      const mtimeSec  = v.getBigInt64(48, true);
      const mtimeNs   = v.getBigInt64(56, true);
      const ctimeSec  = v.getBigInt64(64, true);
      const ctimeNs   = v.getBigInt64(72, true);
      const btimeSec  = v.getBigInt64(80, true);
      const btimeNs   = v.getBigInt64(88, true);
      const size      = Number(v.getBigInt64(96,  true));
      const blocks    = Number(v.getBigInt64(104, true));
      const blksize   = v.getInt32(112, true);
      return new Stat(dev, ino, mode, nlink, uid, gid, rdev,
        size, blksize, blocks,
        toMs(atimeSec, atimeNs), toMs(mtimeSec, mtimeNs),
        toMs(ctimeSec, ctimeNs), toMs(btimeSec, btimeNs));
    } else {
      // Linux x86_64 struct stat (144 bytes):
      //  0: u64 dev     8: u64 ino    16: u64 nlink
      // 24: u32 mode   28: u32 uid   32: u32 gid
      // 36: pad(4)     40: u64 rdev
      // 48: i64 size   56: i64 blksize  64: i64 blocks
      // 72: timespec atime  (tv_sec i64 @72, tv_nsec i64 @80)
      // 88: timespec mtime  (tv_sec i64 @88, tv_nsec i64 @96)
      // 104: timespec ctime (tv_sec i64 @104, tv_nsec i64 @112)
      const dev       = Number(v.getBigUint64(0,  true));
      const ino       = Number(v.getBigUint64(8,  true));
      const nlink     = Number(v.getBigUint64(16, true));
      const mode      = v.getUint32(24, true);
      const uid       = v.getUint32(28, true);
      const gid       = v.getUint32(32, true);
      const rdev      = Number(v.getBigUint64(40, true));
      const size      = Number(v.getBigInt64(48,  true));
      const blksize   = Number(v.getBigInt64(56,  true));
      const blocks    = Number(v.getBigInt64(64,  true));
      const atimeSec  = v.getBigInt64(72,  true);
      const atimeNs   = v.getBigInt64(80,  true);
      const mtimeSec  = v.getBigInt64(88,  true);
      const mtimeNs   = v.getBigInt64(96,  true);
      const ctimeSec  = v.getBigInt64(104, true);
      const ctimeNs   = v.getBigInt64(112, true);
      return new Stat(dev, ino, mode, nlink, uid, gid, rdev,
        size, blksize, blocks,
        toMs(atimeSec, atimeNs), toMs(mtimeSec, mtimeNs),
        toMs(ctimeSec, ctimeNs), 0); // Linux has no birthtime
    }
  }
}
