/**
 * internal:file/provider — Abstract FileSystem and FileHandle interfaces.
 *
 * Defines the contract that all filesystem providers must satisfy. Concrete
 * implementations include:
 *   - DiskFileSystem — POSIX filesystem backed by libc syscalls (fino:file)
 *   - MemoryFileSystem — in-memory Map<path, Uint8Array> (future)
 *   - OverlayFileSystem — copy-on-write layer over a base provider (future)
 *   - RestrictedFileSystem — path-allowlist enforcement (future)
 *   - S3FileSystem — remote object storage via fetch() (future)
 *
 * The `readFile` and `writeFile` convenience methods are implemented here on
 * the abstract base class so all providers inherit them for free.
 */

import type { Stat } from './stat.mts';
import type { Path } from './path.mts';

/** A byte-oriented writer with flush and close. */
export interface ByteWriter {
  write(data: Uint8Array | string): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * An open file handle. Provides read/write access and metadata.
 * The handle owns its resource lifecycle — call `close()` when done.
 */
export interface FileHandle {
  /** Absolute path of the opened file. */
  readonly path: Path;
  /** True if the handle has been closed. */
  readonly closed: boolean;
  /** Stat the open file (equivalent to fstat). */
  stat(): Promise<Stat>;
  /**
   * Returns an async iterable that yields chunks of the file's contents.
   * Only valid for modes that allow reading ('r', 'r+', 'w+', 'a+').
   */
  reader(): AsyncIterable<Uint8Array>;
  /**
   * Returns a writer for this file.
   * Only valid for modes that allow writing ('w', 'a', 'r+', 'w+', 'a+').
   */
  writer(): ByteWriter;
  /** Read the entire file contents as a byte array. */
  bytes(): Promise<Uint8Array>;
  /** Read the entire file contents as a UTF-8 string. */
  text(): Promise<string>;
  /** Read exactly `len` bytes at byte position `pos` without moving the file offset. */
  pread(pos: number | bigint, len: number): Promise<Uint8Array>;
  /** Write `data` at byte position `pos` without moving the file offset. Returns bytes written. */
  pwrite(pos: number | bigint, data: Uint8Array): Promise<number>;
  /** Flush OS write buffers to disk. */
  sync(): Promise<void>;
  /** Set the file size (truncate or extend with zeros). */
  truncate(len: number | bigint): Promise<void>;
  /** Return the current file size in bytes. */
  size(): Promise<bigint>;
  /** Close the handle and release its underlying resource. */
  close(): Promise<void>;
}

/**
 * Abstract base class for filesystem providers.
 *
 * Implementations must provide the core POSIX-like operations. The convenience
 * methods `readFile` and `writeFile` are implemented here using `open` and
 * the handle's reader/writer, so providers get them for free.
 */
export abstract class FileSystem {
  // ---------------------------------------------------------------------------
  // Core operations — must be implemented by each provider
  // ---------------------------------------------------------------------------

  /** Stat a path, following symlinks. */
  abstract stat(path: Path | string): Promise<Stat>;

  /** Stat a path without following symlinks. */
  abstract lstat(path: Path | string): Promise<Stat>;

  /** Open a file and return a handle. Mode defaults to 'r'. */
  abstract open(path: Path | string, mode?: string): Promise<FileHandle>;

  /**
   * Open a directory handle. Returns a `DirEntry` (fino:file) or equivalent
   * directory object. Typed as `unknown` here to avoid circular dependencies
   * between the provider interface and the concrete Entry types.
   */
  abstract dir(path: Path | string): Promise<unknown>;

  /**
   * Return an Entry object for a path. Returns an `Entry` subtype (fino:file)
   * or equivalent. Typed as `unknown` here to avoid circular dependencies.
   */
  abstract entry(path: Path | string): Promise<unknown>;

  /** Create a directory. */
  abstract mkdir(path: Path | string, mode?: number): Promise<void>;

  /** Remove an empty directory. */
  abstract rmdir(path: Path | string): Promise<void>;

  /** Delete a file. */
  abstract unlink(path: Path | string): Promise<void>;

  /** Rename / move a file or directory. */
  abstract rename(oldPath: Path | string, newPath: Path | string): Promise<void>;

  /** Read the target of a symlink. */
  abstract readlink(path: Path | string): Promise<string>;

  /** Create a symlink. */
  abstract symlink(target: Path | string, linkpath: Path | string): Promise<void>;

  /** Resolve the canonical absolute path. */
  abstract realpath(path: Path | string): Promise<string>;

  // ---------------------------------------------------------------------------
  // Convenience — built on core operations; may be overridden for efficiency
  // ---------------------------------------------------------------------------

  /** Read the entire file contents as a UTF-8 string. */
  async readFile(path: Path | string): Promise<string> {
    const f = await this.open(path, 'r');
    try {
      return await f.text();
    } finally {
      await f.close();
    }
  }

  /** Write data to a file, creating or truncating as needed. */
  async writeFile(path: Path | string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
    const f = await this.open(path, 'w');
    try {
      const w = f.writer();
      if (typeof data === 'string') {
        w.write(new TextEncoder().encode(data));
      } else if (data instanceof ArrayBuffer) {
        w.write(new Uint8Array(data));
      } else {
        w.write(data);
      }
      await w.flush();
    } finally {
      await f.close();
    }
  }
}
