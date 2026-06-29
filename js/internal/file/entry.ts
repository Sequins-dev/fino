/**
 * Directory entry wrappers for internal `fino:file` providers.
 *
 * The entry hierarchy represents results returned by filesystem directory
 * listings. `Entry` stores the reported basename, normalized path, owning
 * provider reference, and `dirent.d_type` value for fast type checks. `FileEntry`
 * adds open support for regular files, while `DirEntry` exposes directory
 * mutation helpers and async iteration over child entries.
 *
 * Entries may also be detached from a provider for tests or synthetic listings.
 * Detached entries can still report name, path, and cheap type checks, but
 * methods that require a filesystem throw because there is no provider to call.
 *
 * ## Example
 *
 * ```typescript no_run
 * import { DirEntry } from 'internal:file/entry';
 *
 * const root = new DirEntry('tmp', '/tmp', fileSystem, 4);
 * for await (const child of root) {
 *   if (child.isFile()) {
 *     const stat = await child.stat();
 *     console.log(child.name, stat.size);
 *   }
 * }
 * ```
 *
 * @internal
 */

import {
  lib, isDarwin, Pointer,
  cstr, throwErrno, readCStr, _toPath, joinPath,
  DT_UNKNOWN, DT_DIR, DT_REG, DT_LNK, decodeUtf8,
} from './bindings.ts';
import { Stat } from './stat.ts';
import { Path } from '../../file/path.ts';

interface EntryFileSystem {
  stat(path: Path | string): Promise<Stat>;
  lstat(path: Path | string): Promise<Stat>;
  open(path: Path | string, mode?: string): Promise<unknown>;
  entry(path: Path | string): Promise<Entry>;
  mkdir(path: Path | string, mode?: number): Promise<void>;
  rmdir(path: Path | string): Promise<void>;
  unlink(path: Path | string): Promise<void>;
}

/**
 * Base handle for a filesystem entry. Holds the name, full path, a reference
 * to the parent FileSystem, and the `d_type` from the directory listing (used
 * for fast type checks without an extra stat call).
 *
 * Detached entries (`fs === null`) can still expose name, path, and d_type
 * checks, but `stat` and `lstat` throw because no provider is available.
 *
 * ```typescript no_run
 * import { Entry } from 'internal:file/entry';
 * const entry = new Entry('file.txt', '/tmp/file.txt', null, 8);
 * entry.name; // 'file.txt'
 * ```
 *
 * @internal
 */
export class Entry {
  /**
   * Private property `#name` used by `Entry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #name = undefined;
   *
   *   readInternalState() {
   *     return this.#name;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #name: string;
  /**
   * Private property `#path` used by `Entry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #path = undefined;
   *
   *   readInternalState() {
   *     return this.#path;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #path: Path;
  /**
   * Private property `#fs` used by `Entry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fs = undefined;
   *
   *   readInternalState() {
   *     return this.#fs;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fs: EntryFileSystem | null;
  /**
   * Private property `#dtype` used by `Entry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #dtype = undefined;
   *
   *   readInternalState() {
   *     return this.#dtype;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #dtype: number;

  /**
   * Create an entry wrapper.
   *
   * `dtype` is the platform `dirent.d_type` value and may be `DT_UNKNOWN` when
   * the filesystem cannot provide a cheap type.
   *
   * ```typescript no_run
   * import { Entry } from 'internal:file/entry';
   * const entry = new Entry('unknown', '/tmp/unknown', null, 0);
   * ```
   */
  constructor(name: string, path: Path | string, fs: EntryFileSystem | null, dtype: number) {
    this.#name  = String(name);
    this.#path  = _toPath(path);
    this.#fs    = fs;
    this.#dtype = dtype;
  }

  /**
   * Entry basename as reported by the directory listing.
   *
   * ```typescript no_run
   * const name = entry.name;
   * ```
   */
  get name() { return this.#name; }
  /**
   * Full entry path as a `Path` instance.
   *
   * ```typescript no_run
   * const path = entry.path.toString();
   * ```
   *
   * @returns {Path}
   */
  get path() { return this.#path; }

  /**
   * Fast type check from `dirent.d_type`.
   *
   * No syscall is performed, so this returns false for `DT_UNKNOWN` even if the
   * path is actually a file. Use `stat` when accuracy is required.
   *
   * ```typescript no_run
   * const isFile = entry.isFile();
   * ```
   */
  isFile():      boolean { return this.#dtype === DT_REG; }
  /**
   * Fast directory check from `dirent.d_type`.
   *
   * ```typescript no_run
   * const isDir = entry.isDirectory();
   * ```
   */
  isDirectory(): boolean { return this.#dtype === DT_DIR; }
  /**
   * Fast symlink check from `dirent.d_type`.
   *
   * ```typescript no_run
   * const isLink = entry.isSymlink();
   * ```
   */
  isSymlink():   boolean { return this.#dtype === DT_LNK; }

  /**
   * Stat this entry, following symlinks.
   *
   * Throws when the entry is detached from a filesystem.
   *
   * ```typescript no_run
   * const stat = await entry.stat();
   * ```
   */
  async stat(): Promise<Stat> {
    if (this.#fs === null) throw new Error('Entry is not attached to a filesystem');
    return this.#fs.stat(this.#path);
  }

  /**
   * Lstat this entry, without following symlinks.
   *
   * Throws when the entry is detached from a filesystem.
   *
   * ```typescript no_run
   * const stat = await entry.lstat();
   * ```
   */
  async lstat(): Promise<Stat> {
    if (this.#fs === null) throw new Error('Entry is not attached to a filesystem');
    return this.#fs.lstat(this.#path);
  }
}

/**
 * A filesystem entry that represents a regular file.
 *
 * ```typescript no_run
 * import { FileEntry } from 'internal:file/entry';
 * const fileEntry = new FileEntry('file.txt', '/tmp/file.txt', null, 8);
 * fileEntry.isFile(); // true
 * ```
 *
 * @internal
 */
export class FileEntry extends Entry {
  /**
   * Private property `#fs` used by `FileEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fs = undefined;
   *
   *   readInternalState() {
   *     return this.#fs;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fs: EntryFileSystem | null;

  /**
   * Create a regular-file entry.
   *
   * The filesystem reference is required for `open`; detached entries can only
   * be inspected.
   *
   * ```typescript no_run
   * import { FileEntry } from 'internal:file/entry';
   * const fileEntry = new FileEntry('file.txt', '/tmp/file.txt', null, 8);
   * ```
   */
  constructor(name: string, path: Path | string, fs: EntryFileSystem | null, dtype: number) {
    super(name, path, fs, dtype);
    this.#fs = fs;
  }

  /**
   * Open this file.
   *
   * Mode defaults to `r`. Throws when the entry is detached from a filesystem or
   * when the provider rejects the mode/path.
   *
   * @param {string} [mode='r']
   * @returns {Promise<File>}
   *
   * ```typescript no_run
   * const file = await fileEntry.open('r');
   * await file.close();
   * ```
   */
  async open(mode: string = 'r') {
    if (this.#fs === null) throw new Error('Entry is not attached to a filesystem');
    return this.#fs.open(this.path, mode);
  }
}

/**
 * A filesystem entry that represents a directory. Implements the async
 * iterator protocol so it can be used directly in `for await` loops.
 *
 * ```typescript no_run
 * import { DirEntry } from 'internal:file/entry';
 * const dir = new DirEntry('tmp', '/tmp', null, 4);
 * dir.isDirectory(); // true
 * ```
 *
 * @internal
 */
export class DirEntry extends Entry {
  /**
   * Private property `#fs` used by `DirEntry`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fs = undefined;
   *
   *   readInternalState() {
   *     return this.#fs;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fs: EntryFileSystem | null;

  /**
   * Create a directory entry.
   *
   * The filesystem reference is required for listing children and mutating the
   * directory.
   *
   * ```typescript no_run
   * import { DirEntry } from 'internal:file/entry';
   * const dir = new DirEntry('tmp', '/tmp', null, 4);
   * ```
   */
  constructor(name: string, path: Path | string, fs: EntryFileSystem | null, dtype: number) {
    super(name, path, fs, dtype);
    this.#fs = fs;
  }

  /**
   * Read all children of this directory into an array, skipping `.` and `..`.
   * Returns FileEntry for regular files, DirEntry for directories, Entry for other types.
   * @returns {Promise<Entry[]>}
   *
   * ```typescript no_run
   * const children = await dir.entries();
   * ```
   */
  async entries(): Promise<Entry[]> {
    const fs   = this.#fs;
    const path = this.path;  // Path instance
    const s    = path.toString();
    const dirPtr = lib.symbols.opendir(cstr(s));
    if (dirPtr === null) throwErrno('opendir', s);

    const result: Entry[] = [];
    try {
      while (true) {
        const direntPtr = lib.symbols.readdir(dirPtr);
        if (direntPtr === null) break;

        let dtype, name;
        if (isDarwin) {
          // macOS struct dirent: d_namlen at 18 (u16), d_type at 20 (u8), d_name at 21
          const namlen = Pointer.readU16(direntPtr, 18);
          dtype = Pointer.readU8(direntPtr, 20);
          const nameBytes = new Uint8Array(namlen);
          for (let i = 0; i < namlen; i++) {
            nameBytes[i] = Pointer.readU8(direntPtr, 21 + i);
          }
          name = decodeUtf8(nameBytes);
        } else {
          // Linux struct dirent: d_type at 18 (u8), d_name at 19 (null-terminated)
          dtype = Pointer.readU8(direntPtr, 18);
          name = readCStr(direntPtr, 19);
        }

        if (name === '.' || name === '..') continue;

        const childPath = path.join(name);
        if (dtype === DT_DIR) {
          result.push(new DirEntry(name, childPath, fs, dtype));
        } else if (dtype === DT_REG) {
          result.push(new FileEntry(name, childPath, fs, dtype));
        } else {
          result.push(new Entry(name, childPath, fs, dtype));
        }
      }
    } finally {
      lib.symbols.closedir(dirPtr);
    }
    return result;
  }

  /**
   * Iterate directory entries asynchronously.
   *
   * The current implementation reads the full entry list on the first `next`
   * call, then yields from memory.
   *
   * ```typescript no_run
   * for await (const child of dir) {
   *   void child.name;
   * }
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterator<Entry> {
    const dirEntry = this;
    let iter: Iterator<Entry> | null = null;
    return {
      async next(): Promise<IteratorResult<Entry>> {
        if (iter === null) {
          const arr = await dirEntry.entries();
          iter = arr[Symbol.iterator]();
        }
        return iter.next();
      },
    };
  }

  /**
   * Return an Entry for a named child, determined via lstat.
   * Does not scan the directory — single lstat call.
   * @param {string} name
   * @returns {Promise<Entry>}
   *
   * ```typescript no_run
   * const child = await dir.child('file.txt');
   * ```
   */
  async child(name: string): Promise<Entry> {
    if (this.#fs === null) throw new Error('Entry is not attached to a filesystem');
    return this.#fs.entry(this.path.join(name));
  }

  /**
   * Return a FileEntry for a named child.
   *
   * Throws when the child exists but is not a regular file according to the
   * provider entry type.
   *
   * ```typescript no_run
   * const file = await dir.childFile('file.txt');
   * ```
   */
  async childFile(name: string): Promise<FileEntry> {
    const e = await this.child(name);
    if (!(e instanceof FileEntry)) throw new Error(`'${name}' is not a file`);
    return e;
  }

  /**
   * Return a DirEntry for a named child directory.
   *
   * Throws when the child exists but is not a directory according to the
   * provider entry type.
   *
   * ```typescript no_run
   * const subdir = await dir.childDir('nested');
   * ```
   */
  async childDir(name: string): Promise<DirEntry> {
    const e = await this.child(name);
    if (!(e instanceof DirEntry)) throw new Error(`'${name}' is not a directory`);
    return e;
  }

  /**
   * Create a child directory.
   *
   * Mode defaults to `0o755` for disk-backed providers.
   *
   * ```typescript no_run
   * await dir.mkdir('nested');
   * ```
   */
  async mkdir(name: string, mode: number = 0o755): Promise<void> {
    if (this.#fs === null) throw new Error('Entry is not attached to a filesystem');
    return this.#fs.mkdir(this.path.join(name), mode);
  }

  /**
   * Remove a child entry. Uses unlink for files and rmdir for directories.
   *
   * The child is first inspected with `lstat`. Directory removal requires the
   * directory to be empty.
   *
   * ```typescript no_run
   * await dir.remove('old.txt');
   * ```
   */
  async remove(name: string): Promise<void> {
    if (this.#fs === null) throw new Error('Entry is not attached to a filesystem');
    const childPath = this.path.join(name);
    const st = await this.#fs.lstat(childPath);
    if (st.isDirectory()) {
      return this.#fs.rmdir(childPath);
    }
    return this.#fs.unlink(childPath);
  }
}
