/**
 * internal:file-handle — File class for fino:file.
 *
 * An opened file handle. Provides metadata access and Reader/Writer factories.
 * The File owns the fd lifecycle — call close() when done.
 *
 * @internal
 */

import {
  lib, isDarwin, loopModule, asyncOps,
  throwErrno, _toPath, modeIsReadable, modeIsWritable,
  SEEK_CUR, O_CREAT, decodeUtf8,
  Pointer,
} from './bindings.mts';
import { Stat } from './stat.mts';
import { FdWriter } from '../stream.mts';
import type { Path } from '../../file/path.mts';

/**
 * An opened file handle. Provides metadata access and Reader/Writer factories.
 *
 * The File owns the fd lifecycle — call `close()` when done. Readers and
 * Writers produced by this File share the same underlying fd; close the File
 * (not the Reader/Writer) to release it.
 */
export class File {
  #fd: number;
  #fs: object;
  #path: Path;
  #mode: string;
  #closed: boolean;
  #activeWriter: FdWriter | null = null;
  split?: () => [AsyncIterable<Uint8Array>, FdWriter];

  constructor(fd: number, fs: object, path: Path | string, mode: string) {
    this.#fd     = fd;
    this.#fs     = fs;
    this.#path   = _toPath(path);
    this.#mode   = mode;
    this.#closed = false;
    // split() is only available for read-write modes (r+, w+, a+). Defined as
    // an instance property so `file.split` is undefined (falsy) for r/w/a modes.
    if (modeIsReadable(mode) && modeIsWritable(mode)) {
      this.split = () => [this.reader(), this.writer()];
    }
  }

  /** @returns {Path} */
  get path()   { return this.#path;   }
  get closed() { return this.#closed; }

  /**
   * Return file metadata via fstat(2) on the open fd.
   * @returns {Promise<Stat>}
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
   * Only valid for readable modes (r, r+, w+, a+).
   *
   * On Linux: uses IORING_OP_READ for genuine async I/O.
   * On macOS: uses kqueue EVFILT_READ to yield to the event loop between reads.
   *   EVFILT_READ on a vnode fires immediately when current_offset < file_size.
   *   It does not fire at EOF (offset == file_size), so we check lseek(SEEK_CUR)
   *   before each loop.readable() call to exit the loop cleanly at EOF.
   *
   * @returns {AsyncIterable<Uint8Array>}
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
   * Return a Writer for this file. Only valid for writable modes (w, a, r+, w+, a+).
   * The writer shares the fd; close the File when done, not the writer.
   * @returns {FdWriter}
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
   */
  async text(): Promise<string> {
    return decodeUtf8(await this.bytes());
  }

  async pread(pos: number | bigint, len: number): Promise<Uint8Array> {
    if (this.#closed) throw new Error('File is closed');
    if (len === 0) return new Uint8Array(0);
    const buf = new ArrayBuffer(len);
    const n = Number(lib.symbols.pread(this.#fd, buf, len, BigInt(pos)));
    if (n < 0) throwErrno('pread', this.#path.toString());
    return new Uint8Array(buf, 0, n);
  }

  async pwrite(pos: number | bigint, data: Uint8Array): Promise<number> {
    if (this.#closed) throw new Error('File is closed');
    const n = Number(lib.symbols.pwrite(this.#fd, data, data.byteLength, BigInt(pos)));
    if (n < 0) throwErrno('pwrite', this.#path.toString());
    return n;
  }

  async sync(): Promise<void> {
    if (this.#closed) throw new Error('File is closed');
    const rc = lib.symbols.fsync(this.#fd);
    if (rc !== 0) throwErrno('fsync', this.#path.toString());
  }

  async truncate(len: number | bigint): Promise<void> {
    if (this.#closed) throw new Error('File is closed');
    const rc = lib.symbols.ftruncate(this.#fd, BigInt(len));
    if (rc !== 0) throwErrno('ftruncate', this.#path.toString());
  }

  async size(): Promise<bigint> {
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
}
