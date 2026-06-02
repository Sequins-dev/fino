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
 * ```ts no_run
 *   const fs = new DiskFileSystem();
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
} from '../internal/file/bindings.mts';
import { Stat } from '../internal/file/stat.mts';
import { File } from '../internal/file/handle.mts';
import { Entry, FileEntry, DirEntry } from '../internal/file/entry.mts';
import { Glob, glob as globWalk, type GlobOptions } from '../internal/file/glob.mts';
import type { Path } from './path.mts';
import { FileSystem } from '../internal/file/provider.mts';

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
 * Each method accepts either a raw path string or a `Path` instance. Methods
 * throw errno-backed errors when the underlying syscall fails; they do not
 * return `null` for missing paths unless documented by a lower-level handle
 * API. File handles returned from `open()` must be closed by the caller.
 *
 * ```ts no_run
 * import { DiskFileSystem } from 'fino:file';
 *
 * const fs = new DiskFileSystem();
 * const text = await fs.readFile('/etc/hosts');
 * ```
 */
export class DiskFileSystem extends FileSystem {

  /**
   * Stat a path, following symlinks.
   *
   * Returns parsed POSIX metadata for the target. If `path` is a symlink, the
   * returned `Stat` describes the symlink target. Throws when the path cannot
   * be resolved or the process lacks permission.
   *
   * @param {string|Path} path Path to inspect.
   * @returns {Promise<Stat>} Metadata for the resolved file.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * const stat = await fs.stat('/tmp/app.log');
   * console.log(stat.isFile(), stat.size);
   * ```
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
   *
   * Returns metadata for the directory entry itself. For symlinks, this
   * describes the link rather than the linked target. Throws on missing paths,
   * permission failures, or other `lstat(2)` errors.
   *
   * @param {string|Path} path Path to inspect.
   * @returns {Promise<Stat>} Metadata for the directory entry.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * const stat = await fs.lstat('/tmp/current');
   * console.log(stat.isSymlink());
   * ```
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
   *
   * The default mode is `'r'`. Mode strings are translated to POSIX open flags
   * by the file bindings; create modes use `0o666` before the process umask and
   * then normalize new files to `0o644`. Throws if the file cannot be opened.
   * Close the returned `File` when finished.
   *
   * @param {string|Path} path File path to open.
   * @param {string} [mode='r'] Open mode such as `'r'`, `'w'`, or `'a'`.
   * @returns {Promise<File>} Open file handle owning the file descriptor.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * const file = await fs.open('/tmp/out.txt', 'w');
   * try {
   *   await file.writer().write(new TextEncoder().encode('hello'));
   * } finally {
   *   await file.close();
   * }
   * ```
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
   *
   * The returned entry can enumerate children with `entries()` or async
   * iteration. Symlinks are not followed for the directory check.
   *
   * @param {string|Path} path Directory path to inspect.
   * @returns {Promise<DirEntry>} Directory entry wrapper.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * const dir = await fs.dir('/tmp');
   * for (const entry of await dir.entries()) console.log(entry.name);
   * ```
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
   *
   * Directories become `DirEntry`, regular files become `FileEntry`, symlinks
   * become a generic `Entry` with link type, and other filesystem nodes become
   * a generic `Entry` with unknown type. Throws if `path` cannot be lstat'ed.
   *
   * @param {string|Path} path Path to classify.
   * @returns {Promise<Entry>} Entry wrapper for the detected type.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * const entry = await fs.entry('/tmp/app.log');
   * console.log(entry.name, entry.isFile());
   * ```
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
   *
   * Creates exactly one directory. Parent directories are not created
   * automatically. The default mode is `0o755` before the process umask.
   * Throws if the path exists, a parent is missing, or permissions fail.
   *
   * @param {string|Path} path Directory path to create.
   * @param {number} [mode=0o755] POSIX permission mode.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.mkdir('/tmp/fino-cache', 0o700);
   * ```
   */
  async mkdir(path: Path | string, mode: number = 0o755): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.mkdir(cstr(s), mode);
    if (rc !== 0) throwErrno('mkdir', s);
  }

  /**
   * Remove an empty directory.
   *
   * This wraps `rmdir(2)`, so it only succeeds for empty directories. It
   * throws if the path is not a directory, is not empty, is missing, or cannot
   * be removed.
   *
   * @param {string|Path} path Empty directory to remove.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.rmdir('/tmp/empty-cache');
   * ```
   */
  async rmdir(path: Path | string): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.rmdir(cstr(s));
    if (rc !== 0) throwErrno('rmdir', s);
  }

  /**
   * Delete a file.
   *
   * Removes a directory entry with `unlink(2)`. For symlinks, the link itself
   * is removed and the target is left untouched. Throws for directories,
   * missing paths, or permission failures.
   *
   * @param {string|Path} path File or symlink to remove.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.unlink('/tmp/output.tmp');
   * ```
   */
  async unlink(path: Path | string): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.unlink(cstr(s));
    if (rc !== 0) throwErrno('unlink', s);
  }

  /**
   * Change the permissions of a file.
   *
   * Follows symlinks, matching `chmod(2)`. Throws when the target is missing or
   * the process cannot change permissions.
   *
   * @param {string|Path} path Path whose permissions should change.
   * @param {number} mode POSIX mode bits, for example `0o644`.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.chmod('/tmp/run.sh', 0o755);
   * ```
   */
  async chmod(path: Path | string, mode: number): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.chmod(cstr(s), mode);
    if (rc !== 0) throwErrno('chmod', s);
  }

  /**
   * Change the owner and group of a file, following symlinks.
   *
   * Pass numeric user and group IDs. This follows symlinks and usually
   * requires elevated privileges. Throws for missing paths, invalid IDs, or
   * permission failures.
   *
   * @param {string|Path} path Path whose owner should change.
   * @param {number} uid Numeric user ID.
   * @param {number} gid Numeric group ID.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.chown('/tmp/app.log', 501, 20);
   * ```
   */
  async chown(path: Path | string, uid: number, gid: number): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.chown(cstr(s), uid, gid);
    if (rc !== 0) throwErrno('chown', s);
  }

  /**
   * Change the owner and group of a file without following symlinks.
   *
   * For symlinks, changes ownership of the link itself. The same permission
   * and platform caveats as `lchown(2)` apply.
   *
   * @param {string|Path} path Path whose directory entry owner should change.
   * @param {number} uid Numeric user ID.
   * @param {number} gid Numeric group ID.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.lchown('/tmp/current-link', 501, 20);
   * ```
   */
  async lchown(path: Path | string, uid: number, gid: number): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.lchown(cstr(s), uid, gid);
    if (rc !== 0) throwErrno('lchown', s);
  }

  /**
   * Set the access and modification times of a file.
   *
   * Numeric timestamps are interpreted as seconds since the Unix epoch. `Date`
   * values are converted to fractional seconds. Throws when the target is
   * missing or timestamp updates are not permitted.
   *
   * @param {string|Path} path Path whose timestamps should change.
   * @param {Date|number} atime Access time as a `Date` or seconds since epoch.
   * @param {Date|number} mtime Modification time as a `Date` or seconds since epoch.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.utimes('/tmp/app.log', new Date(), new Date());
   * ```
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
   *
   * The default size is `0`, which empties the file. Growing a file may create
   * sparse zero-filled space depending on the filesystem. Throws if the path is
   * missing, not writable, or invalid for truncation.
   *
   * @param {string|Path} path File to truncate.
   * @param {number} [size=0] Target byte length.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.truncate('/tmp/app.log');
   * ```
   */
  async truncate(path: Path | string, size = 0): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.truncate(cstr(s), BigInt(size));
    if (rc !== 0) throwErrno('truncate', s);
  }

  /**
   * Create a hard link.
   *
   * Creates `newPath` as another directory entry for `existingPath`. The source
   * and destination must usually be on the same filesystem. Throws when the
   * target exists, the source is missing, or hard links are not allowed.
   *
   * @param {string|Path} existingPath Path of the existing file.
   * @param {string|Path} newPath Path of the hard link to create.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.link('/tmp/report.txt', '/tmp/report-copy.txt');
   * ```
   */
  async link(existingPath: Path | string, newPath: Path | string): Promise<void> {
    const existS = _toStr(existingPath);
    const newS   = _toStr(newPath);
    const rc = lib.symbols.link(cstr(existS), cstr(newS));
    if (rc !== 0) throwErrno('link', existS);
  }

  /**
   * Test access to a path.
   *
   * Wraps `access(2)`. The default mode is `F_OK`, which only checks
   * existence. Combine `R_OK`, `W_OK`, and `X_OK` to check permissions from
   * the process perspective. Throws when the requested access is unavailable.
   *
   * @param {string|Path} path Path to check.
   * @param {number} [mode=F_OK] Bitwise OR of `F_OK`, `R_OK`, `W_OK`, and `X_OK`.
   *
   * ```ts no_run
   * import { DiskFileSystem, R_OK, W_OK } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.access('/tmp/app.log', R_OK | W_OK);
   * ```
   */
  async access(path: Path | string, mode = F_OK): Promise<void> {
    const s = _toStr(path);
    const rc = lib.symbols.access(cstr(s), mode);
    if (rc !== 0) throwErrno('access', s);
  }

  /**
   * Copy a file, preserving permissions.
   *
   * Reads the entire source file into memory, writes the destination with
   * truncation, then applies the source mode bits. This is intended for modest
   * files; stream manually for very large files. Throws if either open, read,
   * write, or chmod step fails.
   *
   * @param {string|Path} src Source file path.
   * @param {string|Path} dest Destination file path.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.copyFile('/tmp/input.txt', '/tmp/output.txt');
   * ```
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
   *
   * Wraps `rename(2)`. Existing destination behavior follows the host POSIX
   * rules. Moving across filesystems may fail. Throws on missing sources,
   * invalid destinations, or permission errors.
   *
   * @param {string|Path} oldPath Existing path.
   * @param {string|Path} newPath New path.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.rename('/tmp/upload.tmp', '/tmp/upload.txt');
   * ```
   */
  async rename(oldPath: Path | string, newPath: Path | string): Promise<void> {
    const oldS = _toStr(oldPath);
    const newS = _toStr(newPath);
    const rc = lib.symbols.rename(cstr(oldS), cstr(newS));
    if (rc !== 0) throwErrno('rename', oldS);
  }

  /**
   * Read the target of a symbolic link.
   *
   * Returns the raw link target string exactly as stored by the symlink. The
   * target may be relative and may not exist. Throws if `path` is not a symlink
   * or cannot be read.
   *
   * @param {string|Path} path Symlink path.
   * @returns {Promise<string>} Link target text.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * console.log(await fs.readlink('/tmp/current'));
   * ```
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
   *
   * The `target` is stored as provided; it is not required to exist and is not
   * normalized. Throws if `linkpath` already exists or the platform rejects the
   * link creation.
   *
   * @param {string|Path} target Link target, as stored in the symlink.
   * @param {string|Path} linkpath Path of the symlink to create.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.symlink('releases/current', '/tmp/app-current');
   * ```
   */
  async symlink(target: Path | string, linkpath: Path | string): Promise<void> {
    const tS = _toStr(target);
    const lS = _toStr(linkpath);
    const rc = lib.symbols.symlink(cstr(tS), cstr(lS));
    if (rc !== 0) throwErrno('symlink', lS);
  }

  /**
   * Resolve the canonical absolute path, expanding symlinks.
   *
   * Wraps `realpath(3)` and returns a string. The path and all required
   * components must exist. Throws for missing components, loops, or permission
   * failures.
   *
   * @param {string|Path} path Path to resolve.
   * @returns {Promise<string>} Canonical absolute path.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * console.log(await fs.realpath('/tmp/../tmp'));
   * ```
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
   *
   * Opens the file in read mode, reads all bytes, decodes them as UTF-8, and
   * closes the handle. This loads the full file into memory. Throws on open,
   * read, or decode-related filesystem errors.
   *
   * @param {string|Path} path File to read.
   * @returns {Promise<string>} UTF-8 decoded file contents.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * const text = await fs.readFile('/tmp/config.json');
   * ```
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
   *
   * Opens the path with mode `'w'`, writes the full buffer, and closes the
   * handle. Strings are encoded as UTF-8. Parent directories are not created.
   * Throws on open or write failure.
   *
   * @param {string|Path} path File to create or replace.
   * @param {string|Uint8Array|ArrayBuffer} data Data to write.
   *
   * ```ts no_run
   * import { DiskFileSystem } from 'fino:file';
   *
   * const fs = new DiskFileSystem();
   * await fs.writeFile('/tmp/message.txt', 'hello\n');
   * ```
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
   * Pattern evaluation is delegated to the internal glob walker. Directory
   * reads happen lazily as iteration advances. Errors from directory listing or
   * entry inspection propagate through the async iterator.
   *
   * @param {string} pattern  Glob pattern, e.g. `**\/*.mts`, `src/lib/*.ts`.
   * @param {GlobOptions} [options]
   * @returns {AsyncGenerator<Entry>}
   *
   * ```ts no_run
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
