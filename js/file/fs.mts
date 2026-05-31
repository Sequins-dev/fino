/**
 * fino:file — POSIX filesystem with async I/O and a virtualizable handle model.
 *
 * This module provides file and directory access via `libc` FFI. It exposes a
 * `DiskFileSystem` class that wraps every relevant POSIX syscall: `open(2)`,
 * `read(2)`, `write(2)`, `stat(2)`, `readdir(3)`, `rename(2)`, `symlink(2)`,
 * etc. The I/O is wired to the event loop so that reads and writes yield
 * control to other async tasks while waiting for the kernel.
 *
 *
 * ## Design: explicit filesystem instance
 *
 * Unlike Node.js's implicit global `fs` module, here callers construct a
 * `DiskFileSystem` explicitly and pass their loop handle:
 *
 * ```ts
 *   const fs = new DiskFileSystem(lp);
 * ```
 *
 * This is intentional. It makes the event-loop dependency visible, enables
 * future alternative backends (in-memory, zip archive, overlay), and avoids
 * shared global state that makes testing harder.
 *
 *
 * ## Object hierarchy
 *
 *   DiskFileSystem          — the factory; owns no fds itself
 *     .open()   → File      — an open fd; owns the fd lifecycle
 *       .reader()  → async iterable of Uint8Array chunks
 *       .writer()  → Writer (from fino:stream)
 *       .bytes()   → Promise<Uint8Array>  (reads entire file)
 *       .text()    → Promise<string>
 *     .dir()    → DirEntry  — directory handle (uses opendir/readdir/closedir)
 *       .entries() → Promise<Entry[]>
 *       [Symbol.asyncIterator]  — iterates entries
 *     .entry()  → Entry / FileEntry / DirEntry
 *
 * `File` owns its fd and closes it on `file.close()`. The Reader/Writer
 * produced by `file.reader()` / `file.writer()` borrow the fd with a no-op
 * `onClose` callback — do not close the Reader/Writer to release the fd; call
 * `file.close()` instead.
 */

import {
  lib, Pointer, isDarwin, loopModule, asyncOps,
  cstr, throwErrno, readCStr, _toStr, _toPath, joinPath,
  O_CREAT, O_RDONLY, O_WRONLY, O_RDWR, O_TRUNC, O_APPEND, O_EXCL,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFSOCK, S_IFIFO, S_IFBLK, S_IFCHR,
  SEEK_SET, SEEK_CUR, SEEK_END,
  DT_UNKNOWN, DT_FIFO, DT_CHR, DT_DIR, DT_BLK, DT_REG, DT_LNK, DT_SOCK,
  F_OK, R_OK, W_OK, X_OK,
  modeToFlags, encodeUtf8, decodeUtf8,
} from './bindings.mts';
import { Stat } from './stat.mts';
import { File } from './handle.mts';
import { Entry, FileEntry, DirEntry } from './entry.mts';
import { Glob, glob as globWalk, type GlobOptions } from './glob.mts';
import type { Path } from './path.mts';
import { FileSystem } from './provider.mts';

// Re-export the public API surface
export { FileSystem };
export {
  Stat, File, Entry, FileEntry, DirEntry,
  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFSOCK, S_IFIFO, S_IFBLK, S_IFCHR,
  SEEK_SET, SEEK_CUR, SEEK_END,
  DT_UNKNOWN, DT_FIFO, DT_CHR, DT_DIR, DT_BLK, DT_REG, DT_LNK, DT_SOCK,
  Glob,
};

/**
 * A POSIX filesystem backend backed by libc syscalls via FFI.
 *
 * ```ts
 * const fs = new DiskFileSystem(lp);
 * const text = await fs.readFile('/etc/hosts');
 * ```
 */
export class DiskFileSystem extends FileSystem {

  /**
   * Stat a path, following symlinks.
   * @param {string|Path} path
   * @returns {Promise<Stat>}
   */
  async stat(path: Path | string): Promise<Stat> {
    const s = _toStr(path);
    const buf = new ArrayBuffer(256);
    const rc = lib.symbols.stat(cstr(s), buf);
    if (rc !== 0) throwErrno('stat', s);
    return Stat.parse(buf);
  }

  /**
   * Stat a path without following symlinks.
   * @param {string|Path} path
   * @returns {Promise<Stat>}
   */
  async lstat(path: Path | string): Promise<Stat> {
    const s = _toStr(path);
    const buf = new ArrayBuffer(256);
    const rc = lib.symbols.lstat(cstr(s), buf);
    if (rc !== 0) throwErrno('lstat', s);
    return Stat.parse(buf);
  }

  /**
   * Open a file and return a File handle.
   * @param {string|Path} path
   * @param {string} [mode='r']
   * @returns {Promise<File>}
   */
  async open(path: Path | string, mode: string = 'r'): Promise<File> {
    const p = _toPath(path);
    const s = p.toString();
    const flags = modeToFlags(mode);
    let fd: number;
    if (asyncOps) {
      const loop = loopModule;
      const ops = asyncOps;
      if (loop === null || ops === null) throw new Error('Async file bindings are unavailable');
      // Linux: use io_uring IORING_OP_OPENAT for async open.
      const pathBuf = cstr(s);
      const result = await loop.submit(function submitAsyncOpen(raw: object, id: number) {
        ops.asyncOpen(raw, pathBuf.buffer as ArrayBuffer, flags, 0o666, id);
      });
      fd = result.res;
      if (fd < 0) throwErrno('open', s);
    } else {
      // macOS: synchronous open(2).
      // Note: libffi on macOS ARM64 may not correctly pass the mode argument
      // to the variadic open(2) syscall. Use fchmod to ensure newly-created
      // files get standard permissions (rw-r--r--) regardless.
      fd = lib.symbols.open(cstr(s), flags, 0o666);
      if (fd < 0) throwErrno('open', s);
    }
    if (flags & O_CREAT) lib.symbols.fchmod(fd, 0o644);
    return new File(fd, this, p, mode);
  }

  /**
   * Open a directory and return a DirEntry handle.
   * Throws if the path does not refer to a directory.
   * @param {string|Path} path
   * @returns {Promise<DirEntry>}
   */
  async dir(path: Path | string): Promise<DirEntry> {
    const p = _toPath(path);
    const s = p.toString();
    const st = await this.lstat(s);
    if (!st.isDirectory()) throw new Error(`'${s}' is not a directory`);
    return new DirEntry(p.basename(), p, this, DT_DIR);
  }

  /**
   * Construct an Entry (FileEntry / DirEntry / Entry) for any path using lstat.
   * @param {string|Path} path
   * @returns {Promise<Entry>}
   */
  async entry(path: Path | string): Promise<Entry> {
    const p  = _toPath(path);
    const st = await this.lstat(p.toString());
    if (st.isDirectory()) return new DirEntry(p.basename(),  p, this, DT_DIR);
    if (st.isFile())      return new FileEntry(p.basename(), p, this, DT_REG);
    if (st.isSymlink())   return new Entry(p.basename(),     p, this, DT_LNK);
    return new Entry(p.basename(), p, this, DT_UNKNOWN);
  }

  /**
   * Create a directory.
   * @param {string|Path} path
   * @param {number} [mode=0o755]
   */
  async mkdir(path: Path | string, mode: number = 0o755): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.mkdir(cstr(s), mode);
    if (rc !== 0) throwErrno('mkdir', s);
  }

  /**
   * Remove an empty directory.
   * @param {string|Path} path
   */
  async rmdir(path: Path | string): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.rmdir(cstr(s));
    if (rc !== 0) throwErrno('rmdir', s);
  }

  /**
   * Delete a file.
   * @param {string|Path} path
   */
  async unlink(path: Path | string): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.unlink(cstr(s));
    if (rc !== 0) throwErrno('unlink', s);
  }

  /**
   * Change the permissions of a file.
   * @param {string|Path} path
   * @param {number} mode
   */
  async chmod(path: Path | string, mode: number): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.chmod(cstr(s), mode);
    if (rc !== 0) throwErrno('chmod', s);
  }

  /**
   * Change the owner and group of a file, following symlinks.
   * @param {string|Path} path
   * @param {number} uid
   * @param {number} gid
   */
  async chown(path: Path | string, uid: number, gid: number): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.chown(cstr(s), uid, gid);
    if (rc !== 0) throwErrno('chown', s);
  }

  /**
   * Change the owner and group of a file without following symlinks.
   * @param {string|Path} path
   * @param {number} uid
   * @param {number} gid
   */
  async lchown(path: Path | string, uid: number, gid: number): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.lchown(cstr(s), uid, gid);
    if (rc !== 0) throwErrno('lchown', s);
  }

  /**
   * Set the access and modification times of a file.
   * @param {string|Path} path
   * @param {Date|number} atime  Access time (Date or seconds since epoch).
   * @param {Date|number} mtime  Modification time (Date or seconds since epoch).
   */
  async utimes(path: Path | string, atime: Date | number, mtime: Date | number): Promise<void> {
    const s = _toStr(path);
    const atimeSec = atime instanceof Date ? atime.getTime() / 1000 : atime;
    const mtimeSec = mtime instanceof Date ? mtime.getTime() / 1000 : mtime;
    // struct timeval[2]: each is { i64 tv_sec, i64 tv_usec }
    const buf = new ArrayBuffer(32);
    const view = new DataView(buf);
    view.setBigInt64(0,  BigInt(Math.trunc(atimeSec)), true);
    view.setBigInt64(8,  BigInt(Math.trunc((atimeSec % 1) * 1e6)), true);
    view.setBigInt64(16, BigInt(Math.trunc(mtimeSec)), true);
    view.setBigInt64(24, BigInt(Math.trunc((mtimeSec % 1) * 1e6)), true);
    const rc = lib.symbols.utimes(cstr(s), buf);
    if (rc !== 0) throwErrno('utimes', s);
  }

  /**
   * Truncate a file to a specified length.
   * @param {string|Path} path
   * @param {number} [size=0]
   */
  async truncate(path: Path | string, size = 0): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.truncate(cstr(s), BigInt(size));
    if (rc !== 0) throwErrno('truncate', s);
  }

  /**
   * Create a hard link.
   * @param {string|Path} existingPath  Path of the existing file.
   * @param {string|Path} newPath       Path of the new hard link to create.
   */
  async link(existingPath: Path | string, newPath: Path | string): Promise<void> {
    const existS = _toStr(existingPath);
    const newS   = _toStr(newPath);
    const rc = lib.symbols.link(cstr(existS), cstr(newS));
    if (rc !== 0) throwErrno('link', existS);
  }

  /**
   * Test access to a path.
   * @param {string|Path} path
   * @param {number} [mode=F_OK]  Bitwise-OR of F_OK, R_OK, W_OK, X_OK.
   */
  async access(path: Path | string, mode = F_OK): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.access(cstr(s), mode);
    if (rc !== 0) throwErrno('access', s);
  }

  /**
   * Copy a file, preserving permissions.
   * @param {string|Path} src   Source path.
   * @param {string|Path} dest  Destination path.
   */
  async copyFile(src: Path | string, dest: Path | string): Promise<void> {
    const srcFile = await this.open(src, 'r');
    let data: Uint8Array;
    let srcMode: number;
    try {
      data = await srcFile.bytes();
      const st = await srcFile.stat();
      srcMode = st.mode & 0o7777;
    } finally {
      await srcFile.close();
    }
    const destFile = await this.open(dest, 'w');
    try {
      const writer = destFile.writer();
      await writer.write(data!);
    } finally {
      await destFile.close();
    }
    await this.chmod(dest, srcMode!);
  }

  /**
   * Rename or move a file or directory.
   * @param {string|Path} oldPath
   * @param {string|Path} newPath
   */
  async rename(oldPath: Path | string, newPath: Path | string): Promise<void> {
    const oldS = _toStr(oldPath);
    const newS = _toStr(newPath);
    const rc = lib.symbols.rename(cstr(oldS), cstr(newS));
    if (rc !== 0) throwErrno('rename', oldS);
  }

  /**
   * Read the target of a symbolic link.
   * @param {string|Path} path
   * @returns {Promise<string>}
   */
  async readlink(path: Path | string): Promise<string> {
    const s = _toStr(path);
    const buf = new ArrayBuffer(4096);
    const n = Number(lib.symbols.readlink(cstr(s), buf, 4096));
    if (n < 0) throwErrno('readlink', s);
    return decodeUtf8(new Uint8Array(buf, 0, n));
  }

  /**
   * Create a symbolic link.
   * @param {string|Path} target   Link target (what the symlink points to).
   * @param {string|Path} linkpath Path of the symlink to create.
   */
  async symlink(target: Path | string, linkpath: Path | string): Promise<void> {
    const tS = _toStr(target);
    const lS = _toStr(linkpath);
    const rc = lib.symbols.symlink(cstr(tS), cstr(lS));
    if (rc !== 0) throwErrno('symlink', lS);
  }

  /**
   * Resolve the canonical absolute path, expanding symlinks.
   * @param {string|Path} path
   * @returns {Promise<Path>}
   */
  async realpath(path: Path | string): Promise<string> {
    const s = _toStr(path);
    const buf = new ArrayBuffer(4096);
    const ptr = lib.symbols.realpath(cstr(s), buf);
    if (ptr === null) throwErrno('realpath', s);
    // Read the result from the buffer (realpath fills buf in place).
    const bytes = new Uint8Array(buf);
    let len = 0;
    while (len < bytes.length && bytes[len] !== 0) len++;
    return decodeUtf8(bytes.subarray(0, len));
  }

  /**
   * Read an entire file and return its UTF-8 contents as a string.
   * @param {string|Path} path
   * @returns {Promise<string>}
   */
  async readFile(path: Path | string): Promise<string> {
    const file = await this.open(path, 'r');
    try {
      return await file.text();
    } finally {
      await file.close();
    }
  }

  /**
   * Write data to a file, creating or truncating it.
   * @param {string|Path} path
   * @param {string|Uint8Array|ArrayBuffer} data
   */
  async writeFile(path: Path | string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const file = await this.open(path, 'w');
    try {
      const buf = typeof data === 'string'      ? encodeUtf8(data) :
                  data instanceof Uint8Array     ? data :
                  new Uint8Array(data);
      const w = file.writer();
      await w.write(buf);
      w.close();
    } finally {
      await file.close();
    }
  }

  /**
   * Walk the filesystem matching entries against a glob pattern.
   * Yields `Entry` / `FileEntry` / `DirEntry` objects for each match.
   *
   * @param {string} pattern  Glob pattern, e.g. `**\/*.mts`, `src/lib/*.ts`.
   * @param {GlobOptions} [options]
   * @returns {AsyncGenerator<Entry>}
   *
   * ```ts
   * for await (const entry of fs.glob('**\/*.mts')) {
   *   console.log(entry.path.toString());
   * }
   * ```
   */
  glob(pattern: string, options?: GlobOptions): AsyncGenerator<Entry> {
    // Provide a listDir function that uses DirEntry.entries() — injected here to
    // keep glob.mts free of top-level imports.
    const listDir = async (path: string): Promise<Entry[]> => {
      const dirEntry = new DirEntry('', path, this, DT_DIR);
      return dirEntry.entries();
    };
    return globWalk(listDir, pattern, options) as AsyncGenerator<Entry>;
  }
}

export { F_OK, R_OK, W_OK, X_OK };
