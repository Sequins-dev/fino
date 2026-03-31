/**
 * internal:file-entry — Entry, FileEntry, DirEntry classes for boats:file.
 *
 * Entry hierarchy for filesystem directory listing results.
 * DirEntry additionally implements the async iterator protocol.
 */

import {
  lib, isDarwin, Pointer,
  cstr, throwErrno, readCStr, _toPath, joinPath,
  DT_UNKNOWN, DT_DIR, DT_REG, DT_LNK, decodeUtf8,
} from 'internal:file/bindings';
import { Stat } from 'internal:file/stat';
import { Path } from 'boats:file/path';

/**
 * Base handle for a filesystem entry. Holds the name, full path, a reference
 * to the parent FileSystem, and the `d_type` from the directory listing (used
 * for fast type checks without an extra stat call).
 */
export class Entry {
  #name: string;
  #path: Path;
  #fs: object;
  #dtype: number;

  constructor(name: string, path: Path | string, fs: object, dtype: number) {
    this.#name  = String(name);
    this.#path  = _toPath(path);
    this.#fs    = fs;
    this.#dtype = dtype;
  }

  get name() { return this.#name; }
  /** @returns {Path} */
  get path() { return this.#path; }

  /** Fast type check from dirent d_type — no syscall. */
  isFile():      boolean { return this.#dtype === DT_REG; }
  isDirectory(): boolean { return this.#dtype === DT_DIR; }
  isSymlink():   boolean { return this.#dtype === DT_LNK; }

  /**
   * Stat this entry, following symlinks.
   */
  async stat():  Promise<Stat> { return (this.#fs as any).stat(this.#path);  }

  /**
   * Lstat this entry, without following symlinks.
   */
  async lstat(): Promise<Stat> { return (this.#fs as any).lstat(this.#path); }
}

/**
 * A filesystem entry that represents a regular file.
 */
export class FileEntry extends Entry {
  #fs: object;

  constructor(name: string, path: Path | string, fs: object, dtype: number) {
    super(name, path, fs, dtype);
    this.#fs = fs;
  }

  /**
   * Open this file.
   * @param {string} [mode='r']
   * @returns {Promise<File>}
   */
  async open(mode: string = 'r') {
    return (this.#fs as any).open(this.path, mode);
  }
}

/**
 * A filesystem entry that represents a directory. Implements the async
 * iterator protocol so it can be used directly in `for await` loops.
 */
export class DirEntry extends Entry {
  #fs: object;

  constructor(name: string, path: Path | string, fs: object, dtype: number) {
    super(name, path, fs, dtype);
    this.#fs = fs;
  }

  /**
   * Read all children of this directory into an array, skipping `.` and `..`.
   * Returns FileEntry for regular files, DirEntry for directories, Entry for other types.
   * @returns {Promise<Entry[]>}
   */
  async entries(): Promise<Entry[]> {
    const fs   = this.#fs;
    const path = this.path;  // Path instance
    const s    = path.toString();
    const dirPtr = lib.symbols.opendir(cstr(s));
    if (dirPtr === null) throwErrno('opendir', s);

    const result = [];
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

    lib.symbols.closedir(dirPtr);
    return result;
  }

  [Symbol.asyncIterator]() {
    let iter = null;
    return {
      next: async () => {
        if (iter === null) {
          const arr = await this.entries();
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
   */
  async child(name: string): Promise<Entry> {
    return (this.#fs as any).entry(this.path.join(name));
  }

  /**
   * Return a FileEntry for a named child.
   */
  async childFile(name: string): Promise<FileEntry> {
    const e = await this.child(name);
    if (!(e instanceof FileEntry)) throw new Error(`'${name}' is not a file`);
    return e;
  }

  /**
   * Return a DirEntry for a named child directory.
   */
  async childDir(name: string): Promise<DirEntry> {
    const e = await this.child(name);
    if (!(e instanceof DirEntry)) throw new Error(`'${name}' is not a directory`);
    return e;
  }

  /**
   * Create a child directory.
   */
  async mkdir(name: string, mode: number = 0o755): Promise<void> {
    return (this.#fs as any).mkdir(this.path.join(name), mode);
  }

  /**
   * Remove a child entry. Uses unlink for files and rmdir for directories.
   */
  async remove(name: string): Promise<void> {
    const childPath = this.path.join(name);
    const st = await this.#fs.lstat(childPath);
    if (st.isDirectory()) {
      return (this.#fs as any).rmdir(childPath);
    }
    return (this.#fs as any).unlink(childPath);
  }
}
