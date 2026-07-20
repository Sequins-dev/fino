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
* streams are finished. All reads ride the reactor's fused read: a regular
* file completes synchronously, anything that would block parks on the loop.
*
* ## Example
*
* ```ts no_run
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
import { lib, isDarwin, loopModule, throwErrno, throwErrnoCode, _toPath, modeIsReadable, modeIsWritable, SEEK_CUR, O_CREAT, decodeUtf8, Pointer } from './bindings.ts';
import { Stat } from './stat.ts';
import { FdWriter } from '../stream.ts';
import type { Path } from '../../file/path.ts';
/**
* An opened file handle over a single POSIX descriptor.
*
* Provides metadata access, whole-file reads, chunked reader and writer
* factories, positional (`pread`/`pwrite`) I/O, advisory locking, syncing, and
* truncation. The handle owns the descriptor lifecycle: call `close()` (or use
* `await using`) exactly once when finished. Readers and writers produced by a
* handle share the same underlying fd, so close the `File` — not the individual
* stream — to release it. Closing flushes any writer created by `writer()`.
*
* Reads use the reactor's fused read (synchronous completion for regular
* files, a parked completion otherwise). Every method throws if the handle is
* already closed, and `reader()`/`writer()` also throw when the open mode
* disallows the requested direction.
*
* ```ts no_run
* import { File } from 'internal:file/handle';
*
* const file = new File(fd, fs, '/tmp/log.txt', 'r+');
* try {
*   for await (const chunk of file.reader()) {
*     process.stdout.write(chunk);
*   }
* } finally {
*   await file.close();
* }
* ```
*
*/
export class File {
  /**
  * The underlying POSIX file descriptor this handle owns.
  *
  * @internal
  */
  #fd: number;
  /**
  * The owning filesystem provider, retained for lifecycle bookkeeping.
  *
  * @internal
  */
  #fs: object;
  /**
  * Normalized path the descriptor was opened from, used only for diagnostics.
  *
  * @internal
  */
  #path: Path;
  /**
  * The open mode string (`r`, `w`, `a`, `r+`, `w+`, `a+`, `c+`) that gates the
  * readable and writable helpers.
  *
  * @internal
  */
  #mode: string;
  /**
  * Whether `close` has run; guards every fd-touching method against reuse.
  *
  * @internal
  */
  #closed: boolean;
  /**
  * The most recent writer handed out by `writer()`, flushed automatically when
  * the file is closed.
  *
  * @internal
  */
  #activeWriter: FdWriter | null = null;
  /**
  * Splits the handle into a reader and writer over the same descriptor.
  *
  * Present only when the file was opened in a read-write mode (`r+`, `w+`,
  * `a+`, `c+`); it is left `undefined` for read-only or write-only modes so a
  * simple truthiness check reveals whether both directions are available.
  *
  * @internal
  */
  split?: () => [AsyncIterable<Uint8Array>, FdWriter];
  /**
  * Wrap an already-open file descriptor as a `File` handle.
  *
  * The descriptor must already be opened by the calling provider; the
  * constructor takes ownership of its lifecycle but does not open or `dup` it.
  * `path` is normalized and kept for diagnostics only. `mode` gates the
  * high-level helpers: readable modes enable `reader()`/`bytes()`/`text()`,
  * writable modes enable `writer()`, and read-write modes (`r+`, `w+`, `a+`,
  * `c+`) additionally install `split()`.
  *
  * ```ts no_run
  * import { File } from 'internal:file/handle';
  *
  * const file = new File(fd, fs, '/tmp/file.txt', 'r+');
  * const [reader, writer] = file.split!();
  * ```
  */
  constructor(fd: number, fs: object, path: Path | string, mode: string) {
    this.#fd = fd;
    this.#fs = fs;
    this.#path = _toPath(path);
    this.#mode = mode;
    this.#closed = false;
    // split() is only available for read-write modes (r+, w+, a+, c+). Defined as
    // an instance property so `file.split` is undefined (falsy) for r/w/a modes.
    if (modeIsReadable(mode) && modeIsWritable(mode)) {
      this.split = () => [this.reader(), this.writer()];
    }
  }
  /**
  * The path this handle was opened from.
  *
  * Retained for diagnostics and error messages only; reading it never touches
  * the filesystem or re-opens the descriptor.
  *
  * ```ts no_run
  * console.log(`reading ${file.path.toString()}`);
  * ```
  */
  get path() {
    return this.#path;
  }
  /**
  * Whether `close` has been called on this handle.
  *
  * Once `true`, methods that touch the descriptor throw `File is closed`, and a
  * live `reader()` iterator reports completion instead of yielding. Use it to
  * make cleanup idempotent.
  *
  * ```ts no_run
  * if (!file.closed) await file.close();
  * ```
  */
  get closed() {
    return this.#closed;
  }
  /**
  * Return file metadata by running `fstat(2)` against the open descriptor.
  *
  * Reflects the current state of the file (size, mode, timestamps) even if it
  * was renamed or unlinked after opening. Throws if the handle is closed or the
  * syscall fails.
  *
  * ```ts no_run
  * const stat = await file.stat();
  * console.log(`${stat.size} bytes, mode ${stat.mode.toString(8)}`);
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
  * Return an async iterable that streams the file in up-to-64 KiB chunks from
  * the current offset to EOF.
  *
  * Reading advances the shared file offset, so consuming the iterator, then
  * calling `bytes()` or another `reader()`, continues from where iteration
  * stopped. If the file is closed mid-iteration the iterator completes cleanly.
  * Throws immediately if the handle was opened in a non-readable mode (`w`,
  * `a`).
  *
  * Each chunk is one fused reactor read straight into the chunk buffer: a
  * regular file completes synchronously (returning 0 at EOF), and a
  * descriptor that would block parks on the loop until readable.
  *
  * ```ts no_run
  * let total = 0;
  * for await (const chunk of file.reader()) {
  *   total += chunk.byteLength;
  * }
  * console.log(`streamed ${total} bytes`);
  * ```
  */
  reader(): AsyncIterable<Uint8Array> {
    if (!modeIsReadable(this.#mode)) {
      throw new Error(`File opened in mode '${this.#mode}' is not readable`);
    }
    const fd = this.#fd;
    const isClosed = (): boolean => this.#closed;
    const bufSize = 65536;
    const iterable: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return { async next(): Promise<IteratorResult<Uint8Array>> {
        if (isClosed()) return {
          done: true,
          value: undefined
        };
        const buf = new ArrayBuffer(bufSize);
        // The reactor reads directly into `buf`. A regular file takes the
        // sync fast path (no readiness park) — read returns 0 at EOF.
        const n = await loopModule.readAwaited(fd, buf, 0, bufSize);
        if (n <= 0) return {
          done: true,
          value: undefined
        };
        return {
          done: false,
          value: new Uint8Array(buf, 0, n)
        };
      } };
    } };
    return iterable;
  }
  /**
  * Return a buffered `FdWriter` that appends to this file at the current
  * offset.
  *
  * The writer shares the handle's descriptor, so close the `File` — not the
  * writer — to release it; `close()` flushes the most recently created writer
  * first. Valid only for writable modes (`w`, `a`, `r+`, `w+`, `a+`, `c+`);
  * throws otherwise. Each call installs a fresh writer as the one flushed on
  * close.
  *
  * ```ts no_run
  * const writer = file.writer();
  * writer.write(new TextEncoder().encode('hello\n'));
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
  * Read the file from the current offset to EOF and return it as one
  * `Uint8Array`.
  *
  * Drains the same chunked read loop as `reader()` and concatenates the result,
  * so it advances the shared file offset and returns an empty array when
  * already at EOF. Throws if the handle is closed. For large files prefer
  * `reader()` to avoid holding the whole contents in memory. Reads use the
  * same fused-reactor path documented on `reader()`.
  *
  * ```ts no_run
  * const bytes = await file.bytes();
  * console.log(`loaded ${bytes.byteLength} bytes`);
  * ```
  */
  async bytes(): Promise<Uint8Array> {
    if (this.#closed) throw new Error('File is closed');
    const fd = this.#fd;
    // Size the destination once from fstat and read straight into it, so a
    // regular file needs a single allocation (the array returned to the caller)
    // and zero per-chunk scratch. Repeated 64 KiB scratch buffers were the
    // dominant external-memory-GC source under the reactor engine's non-yielding
    // pump (profiled at ~30% of the reactor thread's CPU); reading in place
    // removes that churn.
    const statBuf = new ArrayBuffer(256);
    lib.symbols.fstat(fd, statBuf);
    const size = Stat.parse(statBuf).size;
    const startOffset = Number(lib.symbols.lseek(fd, 0n, SEEK_CUR));
    const remaining = size > startOffset ? size - startOffset : 0;
    // Empty file, or a special file whose fstat size is not its readable length
    // (pipe, device, /proc): fall back to chunked growth.
    if (remaining === 0) return this.#bytesChunked();

    const out = new Uint8Array(remaining);
    let pos = 0;
    while (pos < remaining) {
      const n = await this.#readInto(out, pos, remaining - pos);
      if (n <= 0) break;
      pos += n;
    }
    // `bytes()` captures the file as of its fstat size (like a snapshot read); a
    // shorter read means a concurrent truncation. Content appended after the
    // fstat is not chased here — probing for it would cost a per-call scratch
    // buffer, the churn this path exists to avoid; use `reader()` for a file
    // being actively appended to.
    return pos === remaining ? out : out.subarray(0, pos);
  }
  /**
  * Read `len` bytes from the descriptor into `out` starting at byte offset
  * `pos`, filling the destination in place (no scratch allocation) via the
  * reactor's fused read. Returns the byte count, or 0 at EOF. Helper for
  * {@link bytes}; pipes/sockets/other unsized descriptors go through
  * {@link #bytesChunked}.
  *
  * @internal
  */
  async #readInto(out: Uint8Array, pos: number, len: number): Promise<number> {
    const fd = this.#fd;
    return loopModule.readAwaited(fd, out.buffer, out.byteOffset + pos, len);
  }
  /**
  * Chunked read-to-EOF fallback: allocates a fresh buffer per chunk and
  * concatenates. Used for special/empty files whose size is unknown and the
  * grown-file tail; sized in-place reads in {@link bytes} avoid this for the
  * common case.
  *
  * @internal
  */
  async #bytesChunked(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const bufSize = 65536;
    const fd = this.#fd;
    while (true) {
      const buf = new ArrayBuffer(bufSize);
      const n = await loopModule.readAwaited(fd, buf, 0, bufSize);
      if (n <= 0) break;
      chunks.push(new Uint8Array(buf, 0, n));
      total += n;
    }
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return new Uint8Array(chunks[0]!);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.byteLength;
    }
    return out;
  }
  /**
  * Read the file from the current offset to EOF and decode it as UTF-8 text.
  *
  * A convenience wrapper over `bytes()` with the same offset and EOF behavior;
  * invalid UTF-8 is replaced with the Unicode replacement character rather than
  * throwing. Throws if the handle is closed.
  *
  * ```ts no_run
  * const config = JSON.parse(await file.text());
  * ```
  */
  async text(): Promise<string> {
    return decodeUtf8(await this.bytes());
  }
  /**
  * Read up to `len` bytes starting at absolute offset `pos` without moving the
  * shared file offset.
  *
  * Because it is positional, `pread` is safe to interleave with `reader()` or
  * other positional calls on the same handle. It returns a buffer shorter than
  * `len` when `pos` lands near EOF and an empty buffer when `len` is `0`. Throws
  * if the handle is closed or `pread(2)` fails.
  *
  * ```ts no_run
  * const header = await file.pread(0n, 16);
  * if (header.byteLength < 16) throw new Error('file truncated');
  * ```
  */
  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    return this.preadSync(pos, len);
  }
  /**
  * Try to acquire, downgrade, or release an advisory lock on this file
  * without blocking (`flock(2)` with `LOCK_NB`).
  *
  * `flock` locks attach to the open file description, so two handles on the
  * same file conflict correctly both within one process (across realms and
  * threads) and across processes. Returns `false` when the lock is held
  * elsewhere; releasing (`'none'`) always succeeds.
  *
  * @internal
  */
  tryLockSync(mode: 'shared' | 'exclusive' | 'none'): boolean {
    if (this.#closed) throw new Error('File is closed');
    // LOCK_SH=1, LOCK_EX=2, LOCK_NB=4, LOCK_UN=8 (identical on macOS/Linux).
    const op = mode === 'shared' ? 1 | 4 : mode === 'exclusive' ? 2 | 4 : 8;
    const rc = lib.symbols.flock(this.#fd, op) as number;
    return rc === 0;
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
  * Write `data` at absolute offset `pos` without moving the shared file offset.
  *
  * Returns the number of bytes actually written, which may be fewer than
  * `data.byteLength`; callers needing a complete write should loop until the
  * whole buffer is consumed. Writing past the current end of the file extends
  * it. Throws if the handle is closed or `pwrite(2)` fails.
  *
  * ```ts no_run
  * let off = 0;
  * const data = new TextEncoder().encode('record');
  * while (off < data.byteLength) {
  *   off += await file.pwrite(1024 + off, data.subarray(off));
  * }
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
  * Flush file data and metadata to stable storage with `fsync(2)`.
  *
  * Buffered writes go through an `FdWriter`, so flush the writer before calling
  * `sync()` to guarantee the bytes have reached the descriptor. Throws if the
  * handle is closed or the syscall fails.
  *
  * ```ts no_run
  * const writer = file.writer();
  * writer.write(new Uint8Array([1, 2, 3]));
  * await writer.flush();
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
  * Set the file to exactly `len` bytes with `ftruncate(2)`.
  *
  * Shrinking discards the trailing bytes; extending grows the file with a
  * zero-filled (typically sparse) region. The shared file offset is unchanged,
  * so it can point past the new end. Throws if the handle is closed or the
  * syscall fails.
  *
  * ```ts no_run
  * await file.truncate(0); // reset the file to empty
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
  * Return the current file size in bytes as a `bigint`.
  *
  * Queries `fstat(2)` on the open descriptor; the `bigint` return keeps the
  * full 64-bit range for large files and matches the provider interface. Throws
  * if the handle is closed or the syscall fails.
  *
  * ```ts no_run
  * const size = await file.size();
  * const tail = await file.pread(size - 64n, 64);
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
  * Flush any active writer, then close the handle and release the descriptor.
  *
  * Idempotent: a second call is a no-op. Any pending writer created by
  * `writer()` is flushed before the fd is released, so buffered bytes are not
  * lost. This method also backs `Symbol.asyncDispose`,
  * so an `await using` binding closes the handle when it leaves scope.
  *
  * ```ts no_run
  * await using file = new File(fd, fs, '/tmp/scratch', 'w');
  * file.writer().write(new Uint8Array([0]));
  * // handle is flushed and closed automatically at end of scope
  * ```
  */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Flush any buffered writes before closing the fd.
    if (this.#activeWriter !== null && !this.#activeWriter.closed) {
      await this.#activeWriter.flush();
    }
    lib.symbols.close(this.#fd);
  }
  /**
  * Dispose hook that closes the handle when an `await using` binding goes out
  * of scope.
  *
  * Delegates to `close()`, so it flushes an active writer and is idempotent.
  * Prefer `await using` over manual `close()` in `finally` blocks when the
  * handle does not escape the current scope.
  *
  * ```ts no_run
  * {
  *   await using file = new File(fd, fs, '/tmp/data', 'r');
  *   await file.text();
  * } // Symbol.asyncDispose runs here
  * ```
  */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /**
  * Close this file handle synchronously with `close(2)`.
  *
  * This low-level path is for native callbacks that must release descriptors
  * without scheduling reactor work from inside another async FFI operation.
  * Flushes any active writer synchronously first and is idempotent. Normal
  * application code should use `close()` instead.
  *
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
