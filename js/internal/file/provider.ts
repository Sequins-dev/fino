/**
 * internal:file/provider — Abstract FileSystem and FileHandle interfaces.
 *
 * Defines the contract that all filesystem providers must satisfy. Concrete
 * implementations include:
 *   - DiskFileSystem — POSIX filesystem backed by libc syscalls (fino:file)
 *   - MemoryFileSystem — in-memory tree (fino:file/memory)
 *   - OverlayFileSystem — copy-on-write layer over a base provider (future)
 *   - RestrictedFileSystem — path-allowlist enforcement (future)
 *   - S3FileSystem — remote object storage via fetch() (future)
 *
 * The `readFile` and `writeFile` convenience methods are implemented here on
 * the abstract base class so all providers inherit them for free.
 *
 * ## Example
 *
 * ```typescript no_run
 * import { FileSystem } from 'internal:file/provider';
 *
 * class MemoryFileSystem extends FileSystem {
 *   // Implement stat, open, entry, mkdir, and the other provider primitives.
 * }
 *
 * const fs = new MemoryFileSystem();
 * await fs.writeFile('/tmp/message.txt', new TextEncoder().encode('hello'));
 * const message = new TextDecoder().decode(await fs.readFile('/tmp/message.txt'));
 * console.assert(message === 'hello');
 * ```
 *
 * @internal
 */
import type { Stat } from './stat.ts';
import type { Path } from '../../file/path.ts';
/**
 * A byte-oriented writer with flush and close.
 *
 * Providers implement this for opened writable handles. `write` is synchronous
 * buffering; `flush` and `close` are async so disk or remote providers can
 * commit pending data.
 *
 * ```typescript no_run
 * import type { ByteWriter } from 'internal:file/provider';
 * const writer: ByteWriter = file.writer();
 * writer.write(new Uint8Array([1, 2, 3]));
 * await writer.flush();
 * await writer.close();
 * ```
 *
 * @internal
 */
export interface ByteWriter {
  /**
   * Buffer a string or byte chunk for writing.
   *
   * Implementations may encode strings as UTF-8 or reject them depending on
   * provider semantics; disk-backed writers currently accept both.
   *
   * ```typescript no_run
   * writer.write('hello');
   * writer.write(new Uint8Array([10]));
   * ```
   */
  write(data: Uint8Array | string): void;
  /**
   * Flush buffered data to the underlying resource.
   *
   * Resolves when currently buffered bytes have been handed to the provider.
   * Throws provider-specific errors on write failure.
   *
   * ```typescript no_run
   * await writer.flush();
   * ```
   */
  flush(): Promise<void>;
  /**
   * Close the writer.
   *
   * Implementations should flush any pending data before releasing resources.
   * Calling after the owning file handle is closed may throw.
   *
   * ```typescript no_run
   * await writer.close();
   * ```
   */
  close(): Promise<void>;
}
/**
 * An open file handle. Provides read/write access and metadata.
 *
 * Returned by a provider's `open` method. The handle owns its resource
 * lifecycle — the caller must `close()` it when done, ideally in a `finally`
 * block so it is released even when a read or write throws. Which methods are
 * usable depends on the mode the file was opened with: `reader`/`text`/`bytes`
 * require a readable mode, `writer`/`pwrite`/`truncate` require a writable one.
 *
 * The `*Sync` members are optional and exist only for native callback
 * integrations (such as the SQLite VFS) that run inside synchronous C code and
 * cannot await; ordinary callers should use the async methods.
 *
 * ```ts no_run
 * import type { FileSystem } from 'internal:file/provider';
 *
 * async function readHeader(fs: FileSystem, path: string): Promise<Uint8Array> {
 *   const file = await fs.open(path, 'r');
 *   try {
 *     return await file.pread(0, 16);
 *   } finally {
 *     await file.close();
 *   }
 * }
 * ```
 */
export interface FileHandle {
  /**
   * Absolute or provider-normalized path of the opened file.
   *
   * ```typescript no_run
   * const path = file.path;
   * ```
   */
  readonly path: Path;
  /**
   * True after `close` has released the handle.
   *
   * ```typescript no_run
   * if (!file.closed) await file.close();
   * ```
   */
  readonly closed: boolean;
  /**
   * Stat the open file.
   *
   * Equivalent to `fstat` for disk providers and follows the open handle rather
   * than re-resolving the path.
   *
   * ```typescript no_run
   * const stat = await file.stat();
   * ```
   */
  stat(): Promise<Stat>;
  /**
   * Returns an async iterable that yields chunks of the file's contents.
   * Only valid for modes that allow reading ('r', 'r+', 'w+', 'a+', 'c+').
   *
   * ```typescript no_run
   * for await (const chunk of file.reader()) {
   *   void chunk;
   * }
   * ```
   */
  reader(): AsyncIterable<Uint8Array>;
  /**
   * Returns a writer for this file.
   * Only valid for modes that allow writing ('w', 'a', 'r+', 'w+', 'a+', 'c+').
   *
   * ```typescript no_run
   * const writer = file.writer();
   * writer.write(new Uint8Array([1]));
   * ```
   */
  writer(): ByteWriter;
  /**
   * Read the entire file contents as a byte array.
   *
   * ```typescript no_run
   * const bytes = await file.bytes();
   * ```
   */
  bytes(): Promise<Uint8Array>;
  /**
   * Read the entire file contents as a UTF-8 string.
   *
   * ```typescript no_run
   * const text = await file.text();
   * ```
   */
  text(): Promise<string>;
  /**
   * Read up to `len` bytes at byte position `pos` without moving the file offset.
   *
   * Short reads are returned at EOF. A zero length returns an empty array.
   *
   * ```typescript no_run
   * const header = await file.pread(0, 16);
   * ```
   */
  pread(pos: number | bigint, len: number): Promise<Uint8Array>;
  /**
   * Synchronous positional read for native callback integrations.
   *
   * Providers that support SQLite VFS or other synchronous C callback APIs can
   * implement this to avoid returning Promises while C is blocked on the
   * callback result.
   *
   * @internal
   */
  preadSync?(pos: number | bigint, len: number): Uint8Array;
  /**
   * Write `data` at byte position `pos` without moving the file offset.
   *
   * Returns the number of bytes written. Short writes are possible for some
   * providers and should be checked by callers that require full writes.
   *
   * ```typescript no_run
   * const written = await file.pwrite(0n, new Uint8Array([1, 2]));
   * ```
   */
  pwrite(pos: number | bigint, data: Uint8Array): Promise<number>;
  /**
   * Synchronous positional write for native callback integrations.
   *
   * @internal
   */
  pwriteSync?(pos: number | bigint, data: Uint8Array): number;
  /**
   * Flush provider write buffers to stable storage when supported.
   *
   * ```typescript no_run
   * await file.sync();
   * ```
   */
  sync(): Promise<void>;
  /**
   * Synchronous stable-storage flush for native callback integrations.
   *
   * @internal
   */
  syncSync?(): void;
  /**
   * Set the file size.
   *
   * Shrinks or extends with provider-defined zero fill semantics.
   *
   * ```typescript no_run
   * await file.truncate(1024n);
   * ```
   */
  truncate(len: number | bigint): Promise<void>;
  /**
   * Synchronous truncate for native callback integrations.
   *
   * @internal
   */
  truncateSync?(len: number | bigint): void;
  /**
   * Return the current file size in bytes.
   *
   * ```typescript no_run
   * const size = await file.size();
   * ```
   */
  size(): Promise<bigint>;
  /**
   * Synchronous file size query for native callback integrations.
   *
   * @internal
   */
  sizeSync?(): bigint;
  /**
   * Close the handle and release its underlying resource.
   *
   * Implementations should make repeated close calls harmless when practical.
   *
   * ```typescript no_run
   * await file.close();
   * ```
   */
  close(): Promise<void>;
  /**
   * Close this handle synchronously when the provider can do so safely.
   *
   * This is intended for low-level integrations such as SQLite VFS callbacks
   * that already run inside native lifecycle code and must release descriptors
   * without scheduling additional async work. Providers without a synchronous
   * close path can omit it; callers must fall back to `close()`.
   *
   * @internal
   */
  closeSync?(): void;
}
/**
 * Abstract base class for filesystem providers.
 *
 * Defines the contract every provider must satisfy: the abstract methods are
 * the core POSIX-like primitives (`stat`, `open`, `mkdir`, `rename`, and so on)
 * that each backend implements against its own storage. The concrete
 * convenience methods `readFile` and `writeFile` are implemented here in terms
 * of `open` and the returned handle's reader/writer, so every provider inherits
 * them for free; a provider may override them when it can do the whole-file
 * transfer more efficiently.
 *
 * The optional `*Sync` methods mirror the async primitives for native callback
 * integrations (such as the SQLite VFS) and can be omitted by providers that do
 * not need synchronous access.
 *
 * ```ts no_run
 * import { FileSystem } from 'internal:file/provider';
 *
 * class ReadOnlyFs extends FileSystem {
 *   // Implement stat, lstat, open, dir, entry, mkdir, rmdir, unlink,
 *   // rename, readlink, symlink, and realpath against the backing store.
 * }
 *
 * const fs: FileSystem = new ReadOnlyFs();
 * const text = new TextDecoder().decode(await fs.readFile('/etc/hostname'));
 * console.log(text.trim());
 * ```
 */
export abstract class FileSystem {
  // ---------------------------------------------------------------------------
  // Core operations — must be implemented by each provider
  // ---------------------------------------------------------------------------
  /**
   * Stat a path, following symlinks.
   *
   * ```typescript no_run
   * const stat = await fs.stat('/tmp/file.txt');
   * ```
   */
  abstract stat(path: Path | string): Promise<Stat>;
  /**
   * Synchronous `stat` for native callback integrations.
   *
   * @internal
   */
  statSync?(path: Path | string): Stat;
  /**
   * Stat a path without following symlinks.
   *
   * ```typescript no_run
   * const stat = await fs.lstat('/tmp/link');
   * ```
   */
  abstract lstat(path: Path | string): Promise<Stat>;
  /**
   * Open a file and return a handle.
   *
   * Mode defaults to `r`. Providers used by low-level integrations should also
   * support internal `c+`: read-write, create if missing, preserve if present.
   * Unsupported modes should throw before opening.
   *
   * ```typescript no_run
   * const file = await fs.open('/tmp/file.txt', 'r');
   * ```
   */
  abstract open(path: Path | string, mode?: string): Promise<FileHandle>;
  /**
   * Synchronous open for native callback integrations.
   *
   * SQLite VFS callbacks are synchronous C calls, so providers used with
   * `fino:database/sqlite` should implement this together with synchronous
   * handle methods.
   *
   * @internal
   */
  openSync?(path: Path | string, mode?: string): FileHandle;
  /**
   * Open a directory handle. Returns a `DirEntry` (fino:file) or equivalent
   * directory object. Typed as `unknown` here to avoid circular dependencies
   * between the provider interface and the concrete Entry types.
   *
   * ```typescript no_run
   * const dir = await fs.dir('/tmp');
   * ```
   */
  abstract dir(path: Path | string): Promise<unknown>;
  /**
   * Return an Entry object for a path. Returns an `Entry` subtype (fino:file)
   * or equivalent. Typed as `unknown` here to avoid circular dependencies.
   *
   * ```typescript no_run
   * const entry = await fs.entry('/tmp/file.txt');
   * ```
   */
  abstract entry(path: Path | string): Promise<unknown>;
  /**
   * List a directory's immediate children as `Entry` objects.
   *
   * Optional, and the seam that makes non-disk providers listable: `DirEntry`
   * iteration calls this when a provider offers it, and otherwise falls back to
   * reading the local directory through libc. Any provider not backed by the
   * local filesystem must implement it.
   *
   * ```typescript no_run
   * const children = await fs.readdir?.('/tmp');
   * ```
   */
  readdir?(path: Path | string): Promise<unknown[]>;
  /**
   * Create a directory.
   *
   * Mode defaults are provider-specific; disk providers use POSIX permissions.
   *
   * ```typescript no_run
   * await fs.mkdir('/tmp/new-dir', 0o755);
   * ```
   */
  abstract mkdir(path: Path | string, mode?: number): Promise<void>;
  /**
   * Remove an empty directory.
   *
   * Throws if the directory does not exist or is not empty.
   *
   * ```typescript no_run
   * await fs.rmdir('/tmp/empty-dir');
   * ```
   */
  abstract rmdir(path: Path | string): Promise<void>;
  /**
   * Delete a file or symlink.
   *
   * Directory removal should use `rmdir`.
   *
   * ```typescript no_run
   * await fs.unlink('/tmp/file.txt');
   * ```
   */
  abstract unlink(path: Path | string): Promise<void>;
  /**
   * Synchronous unlink for native callback integrations.
   *
   * @internal
   */
  unlinkSync?(path: Path | string): void;
  /**
   * Rename or move a file or directory.
   *
   * Replacement behavior follows provider semantics; disk providers use
   * `rename(2)`.
   *
   * ```typescript no_run
   * await fs.rename('/tmp/a.txt', '/tmp/b.txt');
   * ```
   */
  abstract rename(oldPath: Path | string, newPath: Path | string): Promise<void>;
  /**
   * Read the target of a symlink.
   *
   * ```typescript no_run
   * const target = await fs.readlink('/tmp/link');
   * ```
   */
  abstract readlink(path: Path | string): Promise<string>;
  /**
   * Create a symlink.
   *
   * ```typescript no_run
   * await fs.symlink('/tmp/target', '/tmp/link');
   * ```
   */
  abstract symlink(target: Path | string, linkpath: Path | string): Promise<void>;
  /**
   * Resolve the canonical absolute path.
   *
   * ```typescript no_run
   * const abs = await fs.realpath('.');
   * ```
   */
  abstract realpath(path: Path | string): Promise<string>;
  // ---------------------------------------------------------------------------
  // Convenience — built on core operations; may be overridden for efficiency
  // ---------------------------------------------------------------------------
  /**
   * Read the entire file contents as bytes.
   *
   * Opens the file in read mode and always closes the handle in a `finally`
   * block. Text decoding is intentionally caller-owned. Providers may override
   * this for efficiency.
   *
   * ```typescript no_run
   * const bytes = await fs.readFile('/tmp/file.txt');
   * ```
   */
  async readFile(path: Path | string): Promise<Uint8Array> {
    const f = await this.open(path, 'r');
    try {
      return await f.bytes();
    } finally {
      await f.close();
    }
  }
  /**
   * Write byte data to a file, creating or truncating as needed.
   *
   * The file is opened with mode `w`, flushed, and closed even when writing
   * fails. Text encoding is intentionally caller-owned.
   *
   * ```typescript no_run
   * await fs.writeFile('/tmp/file.txt', new TextEncoder().encode('hello'));
   * ```
   */
  async writeFile(
    path: Path | string,
    data: Uint8Array | ArrayBuffer | ArrayBufferView,
  ): Promise<void> {
    if (
      !(data instanceof Uint8Array) &&
      !(data instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(data)
    ) {
      throw new TypeError('writeFile data must be a Uint8Array, ArrayBuffer, or ArrayBufferView');
    }
    const f = await this.open(path, 'w');
    try {
      const w = f.writer();
      if (data instanceof Uint8Array) {
        w.write(data);
      } else if (data instanceof ArrayBuffer) {
        w.write(new Uint8Array(data));
      } else {
        w.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      await w.flush();
    } finally {
      await f.close();
    }
  }
}
