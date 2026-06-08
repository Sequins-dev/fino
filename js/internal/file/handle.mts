/**
 * Open file handle implementation for internal `fino:file` providers.
 *
 * This module wraps a POSIX file descriptor with the `FileHandle` behavior used
 * by disk-backed filesystem providers. It exposes metadata, whole-file reads,
 * chunked readers, writers, positional reads and writes, syncing, truncation,
 * and explicit lifecycle management.
 *
 * The `File` owns the descriptor lifecycle. Readers and writers created from a
 * file share the same descriptor, so callers close the `File` once all derived
 * streams are finished. Linux uses io_uring-backed async operations where
 * available; macOS yields through the runtime loop around synchronous syscalls.
 *
 * ## Example
 *
 * ```typescript no_run
 * import { File } from 'internal:file/handle';
 *
 * const file = new File(fd, fileSystem, '/tmp/data.txt', 'r');
 * try {
 *   const text = await file.text();
 *   console.log(text);
 * } finally {
 *   await file.close();
 * }
 * ```
 *
 * @internal
 */

import {
  lib, isDarwin, loopModule, asyncOps,
  throwErrno, throwErrnoCode, _toPath, modeIsReadable, modeIsWritable,
  SEEK_CUR, O_CREAT, decodeUtf8,
  Pointer,
} from './bindings.mts';
import { Stat } from './stat.mts';
import { FdWriter } from '../stream.mts';
import type { Path } from '../../file/path.mts';

/**
 * An opened file handle. Provides metadata access and Reader/Writer factories.
 *
 * The File owns the fd lifecycle - call `close()` when done. Readers and
 * Writers produced by this File share the same underlying fd; close the File
 * (not the Reader/Writer) to release it.
 *
 * ```typescript no_run
 * import { File } from 'internal:file/handle';
 * const file = new File(fd, fs, '/tmp/file.txt', 'r');
 * await file.close();
 * ```
 *
 * @internal
 */
export class File {
  /**
   * Private property `#fd` used by `File`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fd = undefined;
   *
   *   readInternalState() {
   *     return this.#fd;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fd: number;
  /**
   * Private property `#fs` used by `File`.
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
  #fs: object;
  /**
   * Private property `#path` used by `File`.
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
   * Private property `#mode` used by `File`.
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
  #mode: string;
  /**
   * Private property `#closed` used by `File`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closed = undefined;
   *
   *   readInternalState() {
   *     return this.#closed;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closed: boolean;
  /**
   * Private property `#activeWriter` used by `File`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #activeWriter = undefined;
   *
   *   readInternalState() {
   *     return this.#activeWriter;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #activeWriter: FdWriter | null = null;
  /**
   * Generated-doc-visible property `split`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * const includePrivateShape = { split: undefined };
   * console.log(includePrivateShape.split);
   * ```
   *
   * @internal
   */
  split?: () => [AsyncIterable<Uint8Array>, FdWriter];

  /**
   * Create a file handle around an existing file descriptor.
   *
   * `mode` controls which high-level helpers are allowed. Read-write modes
   * expose `split`, which returns a reader and writer over the same fd.
   *
   * ```typescript no_run
   * import { File } from 'internal:file/handle';
   * const file = new File(fd, fs, '/tmp/file.txt', 'r+');
   * ```
   */
  constructor(fd: number, fs: object, path: Path | string, mode: string) {
    this.#fd     = fd;
    this.#fs     = fs;
    this.#path   = _toPath(path);
    this.#mode   = mode;
    this.#closed = false;
    // split() is only available for read-write modes (r+, w+, a+, c+). Defined as
    // an instance property so `file.split` is undefined (falsy) for r/w/a modes.
    if (modeIsReadable(mode) && modeIsWritable(mode)) {
      this.split = () => [this.reader(), this.writer()];
    }
  }

  /**
   * Path associated with this file handle.
   *
   * The path is used for diagnostics and does not re-open the file.
   *
   * ```typescript no_run
   * const path = file.path.toString();
   * ```
   *
   * @returns {Path}
   */
  get path()   { return this.#path;   }
  /**
   * Whether `close` has been called.
   *
   * Once true, methods that touch the fd throw or return completed iteration.
   *
   * ```typescript no_run
   * if (!file.closed) await file.close();
   * ```
   */
  get closed() { return this.#closed; }

  /**
   * Return file metadata via fstat(2) on the open fd.
   * @returns {Promise<Stat>}
   *
   * ```typescript no_run
   * const stat = await file.stat();
   * ```
   */
  async stat(): Promise<Stat> {
    if (this.#closed) throw new Error('File is closed');
    const buf = new ArrayBuffer(256);
    const rc = lib.symbols.fstat(this.#fd, buf);
    if (rc !== 0) throwErrno('fstat', this.#path.toString());
    return Stat.parse(buf);
  }

  /**
   * Return an async iterable that yields Uint8Array chunks for this file.
   * Only valid for readable modes (r, r+, w+, a+, c+).
   *
   * On Linux: uses IORING_OP_READ for genuine async I/O.
   * On macOS: uses kqueue EVFILT_READ to yield to the event loop between reads.
   *   EVFILT_READ on a vnode fires immediately when current_offset < file_size.
   *   It does not fire at EOF (offset == file_size), so we check lseek(SEEK_CUR)
   *   before each loop.readable() call to exit the loop cleanly at EOF.
   *
   * @returns {AsyncIterable<Uint8Array>}
   *
   * ```typescript no_run
   * for await (const chunk of file.reader()) {
   *   void chunk.byteLength;
   * }
   * ```
   */
  reader(): AsyncIterable<Uint8Array> {
    if (!modeIsReadable(this.#mode)) {
      throw new Error(`File opened in mode '${this.#mode}' is not readable`);
    }
    const fd = this.#fd;
    const isClosed = (): boolean => this.#closed;
    const bufSize = 65536;

    // macOS: capture file size once at reader() creation time for EOF detection.
    // lseek(SEEK_CUR) is called per-iteration to get the current offset.
    let fileSize: number | null = null;
    if (!asyncOps) {
      const statBuf = new ArrayBuffer(256);
      lib.symbols.fstat(fd, statBuf);
      fileSize = Stat.parse(statBuf).size;
    }

    const iterable: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            if (isClosed()) return { done: true, value: undefined };
            const buf = new ArrayBuffer(bufSize);
            let n: number;
            if (asyncOps) {
              const loop = loopModule;
              const ops = asyncOps;
              if (loop === null || ops === null) throw new Error('Async file bindings are unavailable');
              // Linux: io_uring IORING_OP_READ.
              const result = await loop.submit(function submitAsyncRead(raw: object, id: number) {
                ops.asyncRead(raw, fd, buf, bufSize, id);
              });
              n = result.res;
              if (n < 0) throwErrnoCode('read', this.#path.toString(), n);
            } else {
              // macOS: check EOF via lseek before calling readable() to avoid
              // hanging (EVFILT_READ does not fire when offset == file_size).
              const offset = Number(lib.symbols.lseek(fd, 0n, SEEK_CUR));
              if (fileSize !== null && offset >= fileSize) {
                // Re-stat: the file may have grown since we last checked.
                const refreshBuf = new ArrayBuffer(256);
                lib.symbols.fstat(fd, refreshBuf);
                fileSize = Stat.parse(refreshBuf).size;
                if (offset >= fileSize) return { done: true, value: undefined };
              }
              // Yield to the event loop. For a vnode with remaining data,
              // EVFILT_READ fires immediately on the next tick.
              await loopModule!.readable(fd);
              n = Number(lib.symbols.read(fd, buf, bufSize));
            }
            if (n <= 0) return { done: true, value: undefined };
            return { done: false, value: new Uint8Array(buf, 0, n) };
          },
        };
      },
    };
    return iterable;
  }

  /**
   * Return a Writer for this file. Only valid for writable modes (w, a, r+, w+, a+, c+).
   * The writer shares the fd; close the File when done, not the writer.
   * @returns {FdWriter}
   *
   * ```typescript no_run
   * const writer = file.writer();
   * writer.write(new Uint8Array([1, 2, 3]));
   * await writer.flush();
   * ```
   */
  writer(): FdWriter {
    if (!modeIsWritable(this.#mode)) {
      throw new Error(`File opened in mode '${this.#mode}' is not writable`);
    }
    const w = new FdWriter(this.#fd, function noop() {});
    this.#activeWriter = w;
    return w;
  }

  /**
   * Read the entire file contents as a Uint8Array.
   *
   * On Linux: uses IORING_OP_READ for genuine async I/O.
   * On macOS: uses kqueue EVFILT_READ to yield to the event loop between reads.
   *   Same lseek(SEEK_CUR) EOF guard as reader() — see reader() for details.
   *
   * @returns {Promise<Uint8Array>}
   *
   * ```typescript no_run
   * const bytes = await file.bytes();
   * ```
   */
  async bytes(): Promise<Uint8Array> {
    if (this.#closed) throw new Error('File is closed');
    const chunks: Uint8Array[] = [];
    let total = 0;
    const bufSize = 65536;
    const fd = this.#fd;

    // macOS: capture file size once for EOF detection (same strategy as reader()).
    let fileSize: number | null = null;
    if (!asyncOps) {
      const statBuf = new ArrayBuffer(256);
      lib.symbols.fstat(fd, statBuf);
      fileSize = Stat.parse(statBuf).size;
    }

    while (true) {
      const buf = new ArrayBuffer(bufSize);
      let n: number;
      if (asyncOps) {
        const loop = loopModule;
        const ops = asyncOps;
        if (loop === null || ops === null) throw new Error('Async file bindings are unavailable');
        const result = await loop.submit(function submitAsyncRead(raw: object, id: number) {
          ops.asyncRead(raw, fd, buf, bufSize, id);
        });
        n = result.res;
        if (n < 0) throwErrnoCode('read', this.#path.toString(), n);
      } else {
        // macOS: check EOF via lseek before calling readable() to avoid
        // hanging (EVFILT_READ does not fire when offset == file_size).
        const offset = Number(lib.symbols.lseek(fd, 0n, SEEK_CUR));
        if (fileSize !== null && offset >= fileSize) break;
        await loopModule!.readable(fd);
        n = Number(lib.symbols.read(fd, buf, bufSize));
      }
      if (n <= 0) break;
      chunks.push(new Uint8Array(buf, 0, n));
      total += n;
    }
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return new Uint8Array(chunks[0]!);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.byteLength; }
    return out;
  }

  /**
   * Read the entire file contents as a UTF-8 string.
   * @returns {Promise<string>}
   *
   * ```typescript no_run
   * const text = await file.text();
   * ```
   */
  async text(): Promise<string> {
    return decodeUtf8(await this.bytes());
  }

  /**
   * Read up to `len` bytes at `pos` without changing the file offset.
   *
   * Returns a short buffer at EOF and an empty buffer for `len === 0`. Throws
   * when the handle is closed or `pread(2)` fails.
   *
   * ```typescript no_run
   * const header = await file.pread(0n, 16);
   * ```
   */
  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    return this.preadSync(pos, len);
  }

  /**
   * Synchronous `pread(2)` for native callback integrations.
   *
   * @internal
   */
  preadSync(pos: number | bigint, len: number): Uint8Array {
    if (this.#closed) throw new Error('File is closed');
    if (len === 0) return new Uint8Array(0);
    const buf = new ArrayBuffer(len);
    const n = Number(lib.symbols.pread(this.#fd, buf, len, BigInt(pos)));
    if (n < 0) throwErrno('pread', this.#path.toString());
    return new Uint8Array(buf, 0, n);
  }

  /**
   * Write bytes at `pos` without changing the file offset.
   *
   * Returns the number of bytes written. Callers that require full writes
   * should compare the result with `data.byteLength`.
   *
   * ```typescript no_run
   * const written = await file.pwrite(0, new Uint8Array([1, 2]));
   * ```
   */
  async pwrite(pos: number | bigint, data: Uint8Array): Promise<number> {
    return this.pwriteSync(pos, data);
  }

  /**
   * Synchronous `pwrite(2)` for native callback integrations.
   *
   * @internal
   */
  pwriteSync(pos: number | bigint, data: Uint8Array): number {
    if (this.#closed) throw new Error('File is closed');
    const n = Number(lib.symbols.pwrite(this.#fd, data, data.byteLength, BigInt(pos)));
    if (n < 0) throwErrno('pwrite', this.#path.toString());
    return n;
  }

  /**
   * Flush file contents to stable storage with `fsync(2)`.
   *
   * Throws when the handle is closed or the syscall fails.
   *
   * ```typescript no_run
   * await file.sync();
   * ```
   */
  async sync(): Promise<void> {
    this.syncSync();
  }

  /**
   * Synchronous `fsync(2)` for native callback integrations.
   *
   * @internal
   */
  syncSync(): void {
    if (this.#closed) throw new Error('File is closed');
    const rc = lib.symbols.fsync(this.#fd);
    if (rc !== 0) throwErrno('fsync', this.#path.toString());
  }

  /**
   * Set the file length with `ftruncate(2)`.
   *
   * Extending a file creates zero-filled space according to the filesystem.
   *
   * ```typescript no_run
   * await file.truncate(0);
   * ```
   */
  async truncate(len: number | bigint): Promise<void> {
    this.truncateSync(len);
  }

  /**
   * Synchronous `ftruncate(2)` for native callback integrations.
   *
   * @internal
   */
  truncateSync(len: number | bigint): void {
    if (this.#closed) throw new Error('File is closed');
    const rc = lib.symbols.ftruncate(this.#fd, BigInt(len));
    if (rc !== 0) throwErrno('ftruncate', this.#path.toString());
  }

  /**
   * Return the current file size in bytes.
   *
   * Uses `fstat(2)` on the open descriptor and returns a bigint for provider
   * interface compatibility.
   *
   * ```typescript no_run
   * const size = await file.size();
   * ```
   */
  async size(): Promise<bigint> {
    return this.sizeSync();
  }

  /**
   * Synchronous `fstat(2)` size query for native callback integrations.
   *
   * @internal
   */
  sizeSync(): bigint {
    if (this.#closed) throw new Error('File is closed');
    const buf = new ArrayBuffer(256);
    const rc = lib.symbols.fstat(this.#fd, buf);
    if (rc !== 0) throwErrno('fstat', this.#path.toString());
    return BigInt(Stat.parse(buf).size);
  }

  /**
   * Close this file handle and release the underlying fd.
   *
   * On Linux: uses IORING_OP_CLOSE for async close.
   * On macOS: closes synchronously via close(2).
   *
   * ```typescript no_run
   * await file.close();
   * ```
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Flush any buffered writes before closing the fd.
    if (this.#activeWriter !== null && !this.#activeWriter.closed) {
      await this.#activeWriter.flush();
    }
    if (asyncOps) {
      const loop = loopModule;
      const ops = asyncOps;
      if (loop === null || ops === null) throw new Error('Async file bindings are unavailable');
      const fd = this.#fd;
      await loop.submit(function submitAsyncClose(raw: object, id: number) {
        ops.asyncClose(raw, fd, id);
      });
    } else {
      lib.symbols.close(this.#fd);
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Close this file handle synchronously with `close(2)`.
   *
   * This low-level path is for native callbacks that must release descriptors
   * without scheduling io_uring work from inside another async FFI operation.
   * Normal application code should use `close()`.
   *
   * @returns Nothing.
   * @internal
   */
  closeSync(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeWriter !== null && !this.#activeWriter.closed) {
      this.#activeWriter.flushSync();
    }
    lib.symbols.close(this.#fd);
  }
}
