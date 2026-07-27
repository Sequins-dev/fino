/**
 * fino:stream — generic, byte-specialized, and buffered async I/O abstractions.
 *
 * Four layers, each with a single responsibility:
 *
 *   Reader<T> / Writer<T>
 *     Generic async producers/consumers of any value type T. Provide the async
 *     iterator protocol, pipe(), and async close().
 *
 *   BytesReader extends Reader<Uint8Array>
 *   BytesWriter extends Writer<Uint8Array>
 *     Byte specializations. BytesReader adds structural read primitives
 *     (readExactly, readUntil, readByte) built on a single abstract template
 *     method doRead(maxBytes) that returns AT MOST maxBytes bytes. Each structural
 *     call only consumes what it needs — no over-fetching, no per-layer buffer.
 *     BytesWriter adds a doWrite(buf) template method; write() delegates through.
 *
 *   BufferedBytesReader extends BytesReader
 *   BufferedBytesWriter extends BytesWriter
 *     Coalescing layers. BufferedBytesReader maintains an internal chunk list and
 *     overrides doRead(n) to serve from it, pulling larger chunks via doPull()
 *     when empty. BufferedBytesWriter coalesces small write() calls into a single
 *     output buffer, flushed via flush() / doFlush(). Both override close() to
 *     coordinate async teardown. Also exposes peek/scanBuffered/takeBuffered for
 *     callers that need synchronous buffer inspection (e.g. HTTP pipelining).
 *
 *   FdReader / FdWriter   — libc read(2) / write(2)
 *   TlsReader / TlsWriter — SSL_read / SSL_write (in fino:tls)
 *     Concrete I/O implementations extending the buffered variants. Each
 *     implements one template method (doPull / doFlush) with the syscall loop.
 *
 *
 * ## Structural reads do not buffer
 *
 * BytesReader.readExactly(n) calls doRead(n - emitted) on each iteration,
 * requesting exactly the remaining bytes needed. With a BufferedBytesReader
 * below, each doRead call is a cheap chunk-list pop amortized over one large
 * syscall. Without a buffered reader below, it makes one syscall per call —
 * correct but less efficient. Layers above never accumulate state of their own.
 *
 * ## The close() contract
 *
 * Reader.close() and Writer.close() are async and await the onClose callback.
 * BufferedBytesWriter.close() additionally flushes the coalesce buffer first.
 * All close() call sites must use await.
 *
 * ## The fd and split-socket pattern
 *
 * FdReader and FdWriter do not own their fd — they borrow it. The onClose
 * callback handles fd cleanup. Socket.split() wires the callbacks so that:
 *   - FdReader's close calls shutdown(fd, SHUT_RD)
 *   - FdWriter's close calls shutdown(fd, SHUT_WR) + flush
 *   - When both have closed, the fd is close()'d
 *
 * ## Contributing
 *
 * To add a new I/O backend: extend BufferedBytesReader and implement doPull(),
 * or extend BufferedBytesWriter and implement doFlush(). The structural API,
 * coalescing, and async-iterator protocol are all inherited.
 *
 * ```js
 * import { BufferedBytesReader } from 'fino:stream';
 * console.log(typeof BufferedBytesReader.over);
 * ```
 *
 * @internal
 */
import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import * as loop from 'internal:runtime/loop';
const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = os === 'darwin' ? '__error' : '__errno_location';
const EAGAIN = os === 'darwin' ? 35 : 11;
const lib = dlopen(LIBC, {
  read: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  write: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  writev: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'i32',
  },
  [errnoFn]: {
    parameters: [],
    result: 'pointer',
  },
});
// iovec layout on 64-bit: { void *iov_base (8 bytes), size_t iov_len (8 bytes) }
const IOVEC_SIZE = 16;
const MAX_IOV = 16;
function getErrno(): number {
  return Pointer.readI32(lib.symbols[errnoFn]!() as ArrayBuffer, 0);
}
// ---------------------------------------------------------------------------
// Reader<T> — generic async producer of values
// ---------------------------------------------------------------------------
/**
 * Cleanup callback invoked when a `Reader` closes.
 *
 * The callback may perform synchronous or asynchronous cleanup. `Reader`
 * invokes it at most once, and `close()` rejects if the callback throws or
 * returns a rejected promise.
 */
export type ReaderCloseCallback = () => void | Promise<void>;
/**
 * Options for byte-reader pull operations.
 *
 * `maxBytes` bounds the returned chunk size. `signal` lets backends cancel a
 * pending source read without consuming future bytes for an abandoned caller.
 * Every structural read method (`read`, `readAtMost`, `readExactly`, `readByte`,
 * `readUntil`) accepts this object; a bare number is shorthand for `maxBytes`.
 *
 * ```ts no_run
 * import { FdReader } from 'fino:stream';
 *
 * const reader = new FdReader(0, () => {});
 * const controller = new AbortController();
 * setTimeout(() => controller.abort(new Error('slow input')), 1000);
 * const chunk = await reader.read({ maxBytes: 4096, signal: controller.signal });
 * console.log(chunk?.byteLength ?? 'eof');
 * ```
 */
export interface BytesReadOptions {
  /**
   * Upper bound on the number of bytes a single read may return.
   *
   * The reader is free to return fewer bytes, and never returns more. Omitting
   * it lets each method choose its own default: 64 KiB for `read`, one byte for
   * `readByte`, and the exact requested count for `readExactly`.
   */
  maxBytes?: number;
  /**
   * Abort signal that cancels the read.
   *
   * The signal is checked before each underlying source pull, so an
   * already-aborted signal rejects before any bytes are touched and an abort
   * that lands between chunks stops a multi-chunk structural read. The rejection
   * carries the signal's `reason`. Passing `null` is equivalent to omitting it.
   */
  signal?: AbortSignal | null;
}
function normalizeMaxBytes(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`${label} must be a non-negative integer`);
  return value;
}
function normalizeReadOptions(input?: number | BytesReadOptions): BytesReadOptions {
  if (input === undefined) return {};
  if (typeof input === 'number') return { maxBytes: normalizeMaxBytes(input, 'maxBytes') };
  const out: BytesReadOptions = {};
  if (input.maxBytes !== undefined) out.maxBytes = normalizeMaxBytes(input.maxBytes, 'maxBytes');
  if (input.signal !== undefined) out.signal = input.signal;
  return out;
}
/**
 * Abstract base class for asynchronous producers.
 *
 * Subclasses implement `read()` and return either the next value or `null` for
 * EOF. The base class provides idempotent asynchronous close handling plus the
 * async iterator protocol. `close()` awaits the optional `onClose` callback, so
 * callers should always await it when resources are involved.
 *
 * ```js
 * import { Reader } from 'fino:stream';
 * class OnceReader extends Reader {
 *   value = 'hello';
 *   async read() {
 *     const value = this.value;
 *     this.value = null;
 *     return value;
 *   }
 * }
 * const reader = new OnceReader();
 * for await (const value of reader) console.log(value);
 * ```
 *
 * @typeParam T Value type produced by `read()`.
 */
export abstract class Reader<T> implements AsyncIterator<T> {
  /**
   * Private property `#closed` used by `Reader`.
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
  #closed = false;
  /**
   * Private property `#onClose` used by `Reader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onClose = undefined;
   *
   *   readInternalState() {
   *     return this.#onClose;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onClose: ReaderCloseCallback;
  /**
   * Create a reader with an optional close callback.
   *
   * The callback defaults to a no-op and is invoked at most once, the first time
   * `close()` is awaited or when iteration reaches EOF. Callback errors reject
   * the close operation.
   *
   * ```js
   * import { Reader } from 'fino:stream';
   * class EmptyReader extends Reader { async read() { return null; } }
   * const reader = new EmptyReader(() => console.log('closed'));
   * await reader.close();
   * ```
   *
   * @param onClose Optional cleanup callback.
   */
  constructor(onClose: ReaderCloseCallback = () => {}) {
    this.#onClose = onClose;
  }
  /**
   * Whether the reader has been closed.
   *
   * The flag flips before the close callback is awaited. It remains false while
   * the reader is open, even if EOF has not yet been checked.
   *
   * ```js
   * import { Reader } from 'fino:stream';
   * class EmptyReader extends Reader { async read() { return null; } }
   * const reader = new EmptyReader();
   * console.log(reader.closed);
   * await reader.close();
   * console.log(reader.closed);
   * ```
   *
   * @returns True after `close()` starts.
   */
  get closed(): boolean {
    return this.#closed;
  }
  /**
   * Produce the next value from the stream.
   *
   * Subclasses must return `null` to signal EOF. Returning `undefined` is a
   * value, not EOF, for generic readers. Implementations may throw for source
   * errors; the async iterator forwards those errors to the caller.
   *
   * ```js
   * import { Reader } from 'fino:stream';
   * class EmptyReader extends Reader { async read() { return null; } }
   * console.log(await new EmptyReader().read());
   * ```
   *
   * @returns The next value, or `null` on EOF.
   */
  abstract read(): Promise<T | null>;
  /**
   * Close the reader and run its close callback once.
   *
   * Multiple calls are safe; only the first one invokes `onClose`. The method
   * does not call `read()` and does not require EOF. Callback failures reject
   * the returned promise.
   *
   * ```js
   * import { Reader } from 'fino:stream';
   * class EmptyReader extends Reader { async read() { return null; } }
   * const reader = new EmptyReader();
   * await reader.close();
   * await reader.close();
   * ```
   *
   * @returns A promise that resolves after cleanup.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#onClose();
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
  /**
   * Advance the async iterator.
   *
   * `next()` calls `read()`. When `read()` returns `null`, the reader is closed
   * and the iterator result is `{ done: true }`. Source errors or close callback
   * errors reject the returned promise.
   *
   * ```js
   * import { Reader } from 'fino:stream';
   * class EmptyReader extends Reader { async read() { return null; } }
   * const result = await new EmptyReader().next();
   * console.log(result.done);
   * ```
   *
   * @returns The next iterator result.
   */
  async next(): Promise<IteratorResult<T>> {
    const v = await this.read();
    if (v === null) {
      await this.close();
      return {
        done: true,
        value: undefined,
      };
    }
    return {
      done: false,
      value: v,
    };
  }
  /**
   * Return this reader as its own async iterator.
   *
   * This enables `for await` consumption without allocating a wrapper iterator.
   *
   * ```js
   * import { Reader } from 'fino:stream';
   * class EmptyReader extends Reader { async read() { return null; } }
   * const reader = new EmptyReader();
   * console.log(reader[Symbol.asyncIterator]() === reader);
   * ```
   *
   * @returns This reader.
   */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
// ---------------------------------------------------------------------------
// BytesReader extends Reader<Uint8Array> — structural byte read API
// ---------------------------------------------------------------------------
/**
 * Abstract byte-stream reader with structural read helpers.
 *
 * Subclasses implement `doRead(maxBytes, options)` and must return at most `maxBytes`
 * bytes or `null` on EOF. `readExactly()`, `readUntil()`, and `readByte()` are
 * built on that hook and avoid over-fetching. If EOF interrupts an unbuffered
 * structural read, partially consumed bytes are stashed and replayed on the
 * next read operation. `onConsume(bytes)` is invoked only after bytes are
 * delivered to the caller, which lets transports such as QUIC return receive
 * credit when application code actually pulls buffered data.
 *
 * ```js
 * import { BytesReader } from 'fino:stream';
 * class MemoryReader extends BytesReader {
 *   data = new Uint8Array([65, 10]);
 *   async doRead(maxBytes) {
 *     if (this.data.byteLength === 0) return null;
 *     const out = this.data.subarray(0, maxBytes);
 *     this.data = this.data.subarray(out.byteLength);
 *     return out;
 *   }
 * }
 * console.log(await new MemoryReader().readByte());
 * ```
 */
export abstract class BytesReader extends Reader<Uint8Array> {
  // Bytes stashed by readExactly/readUntil on EOF before their condition was
  // met. Returned on the next doRead call so no data is lost. BufferedBytesReader
  // overrides readExactly/readUntil with peek-based semantics that don't need
  // this, but the stash ensures correctness for any unbuffered BytesReader subclass.
  /**
   * Private property `#stash` used by `BytesReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #stash = undefined;
   *
   *   readInternalState() {
   *     return this.#stash;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #stash: Uint8Array | null = null;
  /**
   * Read bytes from the underlying source.
   *
   * Implementations must return at most `maxBytes` bytes, may return fewer, and
   * must return `null` on EOF. Empty chunks are allowed but can cause structural
   * helpers to loop, so backends should avoid returning them when possible.
   *
   * ```js
   * import { BytesReader } from 'fino:stream';
   * class EmptyBytes extends BytesReader {
   *   async doRead(_maxBytes) { return null; }
   * }
   * console.log(await new EmptyBytes().read());
   * ```
   *
   * @param maxBytes Maximum number of bytes requested by the caller.
   * @returns A byte chunk, or `null` on EOF.
   */
  protected abstract doRead(
    maxBytes: number,
    options?: BytesReadOptions,
  ): Promise<Uint8Array | null>;
  /**
   * Called after bytes are delivered to the public reader caller.
   *
   * The default implementation is a no-op. Protocol adapters can override this
   * to report backpressure progress, for example by extending QUIC stream and
   * connection flow-control credit. The hook is not called for bytes pulled
   * internally and then stashed after an incomplete structural read.
   *
   * @param bytes Number of bytes consumed by the caller-facing read operation.
   */
  protected onConsume(_bytes: number): void {}
  // Internal: drain the stash before calling doRead. Used by all structural
  // read methods so that bytes saved on a previous partial failure are replayed.
  /**
   * Private method `#fetch` used by `BytesReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fetch() {
   *     return 'fetch';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#fetch();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fetch(maxBytes: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.#stash !== null) {
      const s = this.#stash;
      if (s.byteLength <= maxBytes) {
        this.#stash = null;
        return Promise.resolve(s);
      }
      this.#stash = s.subarray(maxBytes);
      return Promise.resolve(s.subarray(0, maxBytes).slice());
    }
    return this.doRead(maxBytes, options);
  }
  /**
   * Read one byte chunk.
   *
   * The default request size is 64 KiB, but subclasses may return fewer bytes.
   * Any bytes stashed by an earlier partial structural read are returned before
   * the underlying `doRead()` hook is called. `null` means EOF.
   *
   * ```js
   * import { BytesReader } from 'fino:stream';
   * class EmptyBytes extends BytesReader {
   *   async doRead(_maxBytes) { return null; }
   * }
   * console.log(await new EmptyBytes().read());
   * ```
   *
   * @returns A byte chunk, or `null` on EOF.
   */
  async read(options?: number | BytesReadOptions): Promise<Uint8Array | null> {
    const readOptions = normalizeReadOptions(options);
    const maxBytes = readOptions.maxBytes ?? 65536;
    if (maxBytes === 0) return new Uint8Array(0);
    const chunk = await this.#fetch(maxBytes, readOptions);
    if (chunk !== null && chunk.byteLength > 0) this.onConsume(chunk.byteLength);
    return chunk;
  }
  /**
   * Read at most `maxBytes` bytes.
   *
   * This is a named convenience around `read({ maxBytes })` for protocols that
   * need explicit bounded consumption.
   *
   * @param maxBytes Maximum returned byte count.
   * @param options Optional abort signal.
   * @returns A byte chunk, or `null` on EOF.
   */
  readAtMost(
    maxBytes: number,
    options: Omit<BytesReadOptions, 'maxBytes'> = {},
  ): Promise<Uint8Array | null> {
    return this.read({
      ...options,
      maxBytes,
    });
  }
  /**
   * Read bytes directly into caller-provided storage.
   *
   * Returns the number of bytes copied, or `null` on EOF. The method never
   * copies more than `buffer.byteLength` and relies on `readAtMost()` for
   * consumption accounting.
   *
   * @param buffer Destination byte buffer.
   * @param options Optional abort signal.
   * @returns Number of bytes copied, or `null` on EOF.
   */
  async readInto(
    buffer: Uint8Array,
    options: Omit<BytesReadOptions, 'maxBytes'> = {},
  ): Promise<number | null> {
    if (!(buffer instanceof Uint8Array))
      throw new TypeError('readInto buffer must be a Uint8Array');
    if (buffer.byteLength === 0) return 0;
    const chunk = await this.readAtMost(buffer.byteLength, options);
    if (chunk === null) return null;
    buffer.set(chunk);
    return chunk.byteLength;
  }
  /**
   * Read exactly `n` bytes.
   *
   * Returns an empty array for `n === 0`. If EOF arrives before `n` bytes are
   * available, returns `null` and stashes bytes already read so the next read
   * operation can replay them. Buffered readers override this with atomic,
   * non-consuming failure semantics.
   *
   * ```js
   * import { BytesReader } from 'fino:stream';
   * class MemoryReader extends BytesReader {
   *   data = new Uint8Array([1, 2]);
   *   async doRead(maxBytes) {
   *     if (!this.data.byteLength) return null;
   *     const out = this.data.subarray(0, maxBytes);
   *     this.data = this.data.subarray(out.byteLength);
   *     return out;
   *   }
   * }
   * const reader = new MemoryReader();
   * console.log((await reader.readExactly(2))?.byteLength);
   * ```
   *
   * @param n Number of bytes required.
   * @returns Exactly `n` bytes, or `null` if EOF arrives first.
   */
  async readExactly(n: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
    n = normalizeMaxBytes(n, 'n');
    if (n === 0) return new Uint8Array(0);
    const out = new Uint8Array(n);
    let off = 0;
    const readOptions = normalizeReadOptions(options);
    while (off < n) {
      const chunk = await this.#fetch(n - off, readOptions);
      if (chunk === null) {
        // Stash whatever was read so the caller can still see it on the next read.
        if (off > 0) this.#stash = out.subarray(0, off).slice();
        return null;
      }
      out.set(chunk, off);
      off += chunk.byteLength;
    }
    this.onConsume(n);
    return out;
  }
  /**
   * Read a single byte.
   *
   * The returned number is in the range 0 through 255. `null` indicates EOF.
   * Stashed bytes from a previous partial structural read are consumed before
   * the underlying source is queried.
   *
   * ```js
   * import { BytesReader } from 'fino:stream';
   * class OneByte extends BytesReader {
   *   done = false;
   *   async doRead(_maxBytes) {
   *     if (this.done) return null;
   *     this.done = true;
   *     return new Uint8Array([97]);
   *   }
   * }
   * console.log(await new OneByte().readByte());
   * ```
   *
   * @returns One byte as a number, or `null` on EOF.
   */
  async readByte(options?: BytesReadOptions): Promise<number | null> {
    const readOptions = normalizeReadOptions(options);
    const c = await this.#fetch(1, readOptions);
    if (c === null || c.byteLength === 0) return null;
    this.onConsume(1);
    return c[0]!;
  }
  /**
   * Read through the first delimiter occurrence.
   *
   * The returned bytes include `delim`. An empty delimiter throws. EOF before
   * the delimiter returns `null`; bytes scanned before EOF are stashed for the
   * next read. Scanning more than `max` bytes without a delimiter throws.
   *
   * ```js
   * import { BytesReader } from 'fino:stream';
   * class MemoryReader extends BytesReader {
   *   data = new TextEncoder().encode('ok\\nrest');
   *   async doRead(maxBytes) {
   *     if (!this.data.byteLength) return null;
   *     const out = this.data.subarray(0, maxBytes);
   *     this.data = this.data.subarray(out.byteLength);
   *     return out;
   *   }
   * }
   * const line = await new MemoryReader().readUntil(new Uint8Array([10]));
   * console.log(new TextDecoder().decode(line));
   * ```
   *
   * @param delim Delimiter bytes to include in the returned chunk.
   * @param max Maximum bytes to scan before throwing. Defaults to 1 MiB.
   * @returns Bytes through the delimiter, or `null` on EOF before a match.
   */
  async readUntil(
    delim: Uint8Array,
    max: number = 1 << 20,
    options?: BytesReadOptions,
  ): Promise<Uint8Array | null> {
    if (delim.byteLength === 0) throw new Error('readUntil: empty delimiter');
    max = normalizeMaxBytes(max, 'max');
    const readOptions = normalizeReadOptions(options);
    // Growable accumulator — starts at 256, doubles up to max.
    let buf = new Uint8Array(256);
    let len = 0;
    while (true) {
      const chunk = await this.#fetch(1, readOptions);
      if (chunk === null || chunk.byteLength === 0) {
        // Stash whatever was read so the caller can still see it on the next read.
        if (len > 0) this.#stash = buf.subarray(0, len).slice();
        return null;
      }
      const b = chunk[0]!;
      if (len >= buf.byteLength) {
        if (len >= max) throw new Error(`readUntil: max ${max} bytes exceeded`);
        const grown = new Uint8Array(Math.min(buf.byteLength * 2, max + 1));
        grown.set(buf);
        buf = grown;
      }
      buf[len++] = b;
      // Tail-match: compare the last delim.byteLength bytes against delim.
      if (len >= delim.byteLength) {
        const start = len - delim.byteLength;
        let match = true;
        for (let i = 0; i < delim.byteLength; i++) {
          if (buf[start + i] !== delim[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          this.onConsume(len);
          return buf.subarray(0, len);
        }
      }
    }
  }
  /**
   * Bytes already held by this reader before another source pull is required.
   *
   * For the base unbuffered reader this only includes bytes stashed after a
   * partial structural read. Buffered readers include their chunk-list buffer.
   *
   * @returns Number of immediately buffered bytes.
   */
  get bufferedBytes(): number {
    return this.#stash?.byteLength ?? 0;
  }
}
// ---------------------------------------------------------------------------
// BufferedBytesReader extends BytesReader — upstream read coalescing
// ---------------------------------------------------------------------------
/**
 * Byte reader with a chunk-list buffer and upstream pull coalescing.
 *
 * The base `doRead()` implementation serves from buffered chunks and calls
 * `doPull()` only when the buffer is empty. Structural reads can therefore scan
 * cheaply while upstream backends pull larger chunks. `peek()`,
 * `scanBuffered()`, and `takeBuffered()` expose the current buffer for parsers
 * that need to inspect pipelined data without forcing another read.
 *
 * ```js
 * import { BufferedBytesReader, BytesReader } from 'fino:stream';
 * class EmptyBytes extends BytesReader { async doRead() { return null; } }
 * const reader = BufferedBytesReader.over(new EmptyBytes());
 * console.log(await reader.peek(1));
 * ```
 */
export abstract class BufferedBytesReader extends BytesReader {
  /**
   * Private property `#chunks` used by `BufferedBytesReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #chunks = undefined;
   *
   *   readInternalState() {
   *     return this.#chunks;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #chunks: Uint8Array[] = [];
  /**
   * Private property `#bufferedBytes` used by `BufferedBytesReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bufferedBytes = undefined;
   *
   *   readInternalState() {
   *     return this.#bufferedBytes;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bufferedBytes = 0;
  /**
   * Private property `#upstreamDone` used by `BufferedBytesReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #upstreamDone = undefined;
   *
   *   readInternalState() {
   *     return this.#upstreamDone;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #upstreamDone = false;
  /**
   * Pull one raw chunk from the underlying resource.
   *
   * Subclasses may return any positive chunk size and must return `null` on
   * EOF. Empty chunks are ignored by the buffering layer and should be rare to
   * avoid busy loops.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class EmptyBuffered extends BufferedBytesReader {
   *   async doPull() { return null; }
   * }
   * console.log(await new EmptyBuffered().read());
   * ```
   *
   * @returns A raw byte chunk, or `null` on EOF.
   */
  protected abstract doPull(): Promise<Uint8Array | null>;
  /**
   * Wrap an existing byte reader in a buffered reader.
   *
   * The wrapper pulls from `source.read()` and closes the source when the
   * buffered reader closes. This is useful for tests and for adding non-
   * consuming `peek()` and `readUntil()` behavior to an unbuffered source.
   *
   * ```js
   * import { BufferedBytesReader, BytesReader } from 'fino:stream';
   * class EmptyBytes extends BytesReader { async doRead() { return null; } }
   * const buffered = BufferedBytesReader.over(new EmptyBytes());
   * console.log(buffered.buffered);
   * ```
   *
   * @param source Source byte reader to buffer.
   * @returns A buffered wrapper around `source`.
   */
  static over(source: BytesReader): BufferedBytesReader {
    return new (class WrappedBufferedReader extends BufferedBytesReader {
      protected doPull(): Promise<Uint8Array | null> {
        return source.read();
      }
    })(() => source.close());
  }
  /**
   * Serve a bounded read from the internal buffer.
   *
   * The method pulls upstream only while the buffer is empty, skips empty pulls,
   * and returns at most `maxBytes`. It returns `null` after upstream EOF and
   * does not over-read from the buffered chunk list.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class OneChunk extends BufferedBytesReader {
   *   done = false;
   *   async doPull() { if (this.done) return null; this.done = true; return new Uint8Array([1, 2]); }
   * }
   * console.log((await new OneChunk().read())?.byteLength);
   * ```
   *
   * @param maxBytes Maximum bytes to return.
   * @returns A byte chunk, or `null` on EOF.
   */
  protected async doRead(
    maxBytes: number,
    _options?: BytesReadOptions,
  ): Promise<Uint8Array | null> {
    while (this.#chunks.length === 0) {
      if (this.#upstreamDone) return null;
      const chunk = await this.doPull();
      if (chunk === null) {
        this.#upstreamDone = true;
        return null;
      }
      if (chunk.byteLength === 0) continue;
      this.#chunks.push(chunk);
      this.#bufferedBytes += chunk.byteLength;
    }
    const head = this.#chunks[0]!;
    if (head.byteLength <= maxBytes) {
      this.#chunks.shift();
      this.#bufferedBytes -= head.byteLength;
      return head;
    }
    const out = head.subarray(0, maxBytes);
    this.#chunks[0] = head.subarray(maxBytes);
    this.#bufferedBytes -= maxBytes;
    return out;
  }
  // ── extra methods: only available on the buffered variant ─────────
  /**
   * Number of bytes currently buffered.
   *
   * These bytes can be consumed by `takeBuffered()` without awaiting upstream
   * I/O. The value does not include bytes that may still be available from the
   * underlying resource.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class EmptyBuffered extends BufferedBytesReader { async doPull() { return null; } }
   * console.log(new EmptyBuffered().buffered);
   * ```
   *
   * @returns Buffered byte count.
   */
  get buffered(): number {
    return this.#bufferedBytes;
  }
  override get bufferedBytes(): number {
    return super.bufferedBytes + this.#bufferedBytes;
  }
  /**
   * Whether upstream EOF has been reached and all buffered bytes are drained.
   *
   * The value is false before the first EOF-producing pull, even if no bytes are
   * currently buffered. Use `peek()` or `read()` to discover EOF.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class EmptyBuffered extends BufferedBytesReader { async doPull() { return null; } }
   * const reader = new EmptyBuffered();
   * await reader.peek(1);
   * console.log(reader.eof);
   * ```
   *
   * @returns True after EOF and buffer drain.
   */
  get eof(): boolean {
    return this.#upstreamDone && this.#bufferedBytes === 0;
  }
  /**
   * Return up to `n` buffered bytes without consuming them.
   *
   * The method pulls upstream until at least `n` bytes are buffered or EOF is
   * reached. It returns a copy of the first `min(n, buffered)` bytes, so callers
   * can mutate the returned array without changing the internal buffer.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class OneChunk extends BufferedBytesReader {
   *   done = false;
   *   async doPull() {
   *     if (this.done) return null;
   *     this.done = true;
   *     return new Uint8Array([1, 2]);
   *   }
   * }
   * const reader = new OneChunk();
   * console.log((await reader.peek(1))[0]);
   * ```
   *
   * @param n Desired number of bytes.
   * @returns A non-consuming copy of available bytes.
   */
  async peek(n: number): Promise<Uint8Array> {
    while (this.#bufferedBytes < n && !this.#upstreamDone) {
      const chunk = await this.doPull();
      if (chunk === null) {
        this.#upstreamDone = true;
        break;
      }
      if (chunk.byteLength === 0) continue;
      this.#chunks.push(chunk);
      this.#bufferedBytes += chunk.byteLength;
    }
    const want = Math.min(n, this.#bufferedBytes);
    if (want === 0) return new Uint8Array(0);
    return this.#sliceBuffered(want, false);
  }
  /**
   * Scan currently buffered bytes for a delimiter without pulling upstream.
   *
   * Returns the offset one past the first delimiter match, or `-1` if the
   * delimiter is absent from the current buffer. Empty delimiters return `-1`.
   * The method can match delimiters that cross chunk boundaries.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class Chunked extends BufferedBytesReader {
   *   chunks = [new Uint8Array([65]), new Uint8Array([10])];
   *   async doPull() { return this.chunks.shift() ?? null; }
   * }
   * const reader = new Chunked();
   * await reader.peek(2);
   * console.log(reader.scanBuffered(new Uint8Array([10])));
   * ```
   *
   * @param delim Delimiter bytes to find.
   * @returns Offset after the match, or `-1` when not found.
   */
  scanBuffered(delim: Uint8Array): number {
    if (delim.byteLength === 0 || this.#bufferedBytes < delim.byteLength) return -1;
    // Flatten view (virtual index across chunk list).
    // We only materialize cross-chunk checks for the overlap window.
    let pos = 0;
    for (let ci = 0; ci < this.#chunks.length; ci++) {
      const chunk = this.#chunks[ci]!;
      // Scan within this chunk.
      const limit = chunk.byteLength - (delim.byteLength - 1);
      for (let i = 0; i < limit; i++) {
        if (chunk[i] !== delim[0]) continue;
        // Check remainder of delim.
        let match = true;
        for (let d = 1; d < delim.byteLength; d++) {
          if (chunk[i + d] !== delim[d]) {
            match = false;
            break;
          }
        }
        if (match) return pos + i + delim.byteLength;
      }
      // Check the cross-chunk overlap window at the end of this chunk.
      const overlapStart = Math.max(0, chunk.byteLength - (delim.byteLength - 1));
      outer: for (let i = overlapStart; i < chunk.byteLength; i++) {
        if (chunk[i] !== delim[0]) continue;
        // Build a virtual slice across chunks to compare against delim.
        let virtIdx = 0;
        let globalOff = pos + i;
        let g = globalOff;
        // Walk chunk-list from this point.
        let cj = ci;
        let cOff = i;
        for (; virtIdx < delim.byteLength; virtIdx++, g++, cOff++) {
          // Advance chunk if needed.
          while (cj < this.#chunks.length && cOff >= this.#chunks[cj]!.byteLength) {
            cOff -= this.#chunks[cj]!.byteLength;
            cj++;
          }
          if (cj >= this.#chunks.length) continue outer;
          if (this.#chunks[cj]![cOff] !== delim[virtIdx]) continue outer;
        }
        return globalOff + delim.byteLength;
      }
      pos += chunk.byteLength;
    }
    return -1;
  }
  /**
   * Remove and return exactly `n` bytes from the current buffer.
   *
   * This method never pulls upstream. It throws if fewer than `n` bytes are
   * buffered. The returned bytes are copied so callers own the buffer.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class OneChunk extends BufferedBytesReader {
   *   done = false;
   *   async doPull() {
   *     if (this.done) return null;
   *     this.done = true;
   *     return new Uint8Array([1, 2]);
   *   }
   * }
   * const reader = new OneChunk();
   * await reader.peek(2);
   * console.log(reader.takeBuffered(1)[0]);
   * ```
   *
   * @param n Number of bytes to consume.
   * @returns Exactly `n` buffered bytes.
   */
  takeBuffered(n: number): Uint8Array {
    n = normalizeMaxBytes(n, 'n');
    if (n > this.#bufferedBytes) {
      throw new Error(`takeBuffered: requested ${n} but only ${this.#bufferedBytes} buffered`);
    }
    const out = this.#sliceBuffered(n, true);
    if (n > 0) this.onConsume(n);
    return out;
  }
  // ── Structural read overrides with non-consuming-on-failure semantics ─────
  /**
   * Read exactly `n` bytes without consuming on failure.
   *
   * The method first accumulates bytes with `peek()`. If EOF arrives before
   * `n` bytes are available, it returns `null` and leaves buffered bytes
   * untouched. For `n === 0`, it returns an empty array.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class OneChunk extends BufferedBytesReader {
   *   done = false;
   *   async doPull() { if (this.done) return null; this.done = true; return new Uint8Array([1]); }
   * }
   * const reader = new OneChunk();
   * console.log(await reader.readExactly(2));
   * console.log(reader.buffered);
   * ```
   *
   * @param n Number of bytes required.
   * @returns Exactly `n` bytes, or `null` if EOF arrives first.
   */
  override async readExactly(n: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
    n = normalizeMaxBytes(n, 'n');
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    if (n === 0) return new Uint8Array(0);
    const peeked = await this.peek(n);
    if (peeked.byteLength < n) return null;
    return this.takeBuffered(n);
  }
  /**
   * Read through a delimiter without consuming on failure.
   *
   * The method scans buffered bytes first, pulls one chunk at a time as needed,
   * and consumes only when a delimiter is found. EOF before a match returns
   * `null` with buffered bytes preserved. Empty delimiters and scans beyond
   * `max` throw.
   *
   * ```js
   * import { BufferedBytesReader } from 'fino:stream';
   * class Lines extends BufferedBytesReader {
   *   chunks = [new TextEncoder().encode('a\\n')];
   *   async doPull() { return this.chunks.shift() ?? null; }
   * }
   * const reader = new Lines();
   * console.log(new TextDecoder().decode(await reader.readUntil(new Uint8Array([10]))));
   * ```
   *
   * @param delim Delimiter bytes to include in the returned chunk.
   * @param max Maximum buffered bytes to scan before throwing. Defaults to 1 MiB.
   * @returns Bytes through the delimiter, or `null` on EOF before a match.
   */
  override async readUntil(
    delim: Uint8Array,
    max: number = 1 << 20,
    options?: BytesReadOptions,
  ): Promise<Uint8Array | null> {
    if (delim.byteLength === 0) throw new Error('readUntil: empty delimiter');
    max = normalizeMaxBytes(max, 'max');
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    while (true) {
      // Scan buffered data first (no upstream pull needed if already buffered).
      const end = this.scanBuffered(delim);
      if (end >= 0) {
        if (end > max) throw new Error(`readUntil: max ${max} bytes exceeded`);
        return this.takeBuffered(end);
      }
      if (this.#bufferedBytes > max) throw new Error(`readUntil: max ${max} bytes exceeded`);
      if (this.#upstreamDone) return null;
      // Pull one more chunk and scan again.
      const chunk = await this.doPull();
      if (chunk === null) {
        this.#upstreamDone = true;
        return null;
      }
      if (chunk.byteLength > 0) {
        this.#chunks.push(chunk);
        this.#bufferedBytes += chunk.byteLength;
      }
    }
  }
  // Shared helper: return n bytes from head of chunk list.
  // If consume=true, removes them from the buffer.
  /**
   * Private method `#sliceBuffered` used by `BufferedBytesReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #sliceBuffered() {
   *     return 'sliceBuffered';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#sliceBuffered();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #sliceBuffered(n: number, consume: boolean): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    // Fast path: first chunk has at least n bytes.
    const head = this.#chunks[0]!;
    if (head.byteLength >= n) {
      const out = head.subarray(0, n);
      if (consume) {
        if (head.byteLength === n) {
          this.#chunks.shift();
        } else {
          this.#chunks[0] = head.subarray(n);
        }
        this.#bufferedBytes -= n;
      }
      return out.slice();
    }
    // Multi-chunk path.
    const out = new Uint8Array(n);
    let off = 0;
    let idx = 0;
    while (off < n && idx < this.#chunks.length) {
      const c = this.#chunks[idx]!;
      const take = Math.min(c.byteLength, n - off);
      out.set(c.subarray(0, take), off);
      off += take;
      if (consume) {
        if (take === c.byteLength) {
          idx++;
        } else {
          this.#chunks[idx] = c.subarray(take);
          break;
        }
      } else {
        idx++;
      }
    }
    if (consume) {
      this.#chunks.splice(0, idx);
      this.#bufferedBytes -= n;
    }
    return out;
  }
}
// ---------------------------------------------------------------------------
// FdReader — libc read(2) backed BufferedBytesReader
// ---------------------------------------------------------------------------
/**
 * Buffered reader backed by a POSIX file descriptor.
 *
 * `FdReader` borrows the descriptor; it does not close it directly. The
 * `onClose` callback owns descriptor shutdown policy. Reads use libc `read(2)`
 * with a reusable 64 KiB arena and wait for runtime readability on EAGAIN.
 * Fatal read errors are treated as EOF by this low-level adapter.
 *
 * ```js
 * import { FdReader } from 'fino:stream';
 * const reader = new FdReader(0, () => {});
 * console.log(reader.fd);
 * await reader.close();
 * ```
 *
 * @internal
 */
export class FdReader extends BufferedBytesReader {
  /**
   * Private property `#fd` used by `FdReader`.
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
   * Private property `#readBuf` used by `FdReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readBuf = undefined;
   *
   *   readInternalState() {
   *     return this.#readBuf;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readBuf: ArrayBuffer = new ArrayBuffer(65536);
  // Pre-allocated view — subarray() is cheaper than new Uint8Array(buf, off, len).
  /**
   * Private property `#readView` used by `FdReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readView = undefined;
   *
   *   readInternalState() {
   *     return this.#readView;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readView: Uint8Array = new Uint8Array(this.#readBuf);
  // Bytes kqueue reported available at last EVFILT_READ event. When > 0 we can
  // skip the next loop.readable() call because the kernel already told us data
  // is present. Reset to 0 after each read() or on unexpected EAGAIN.
  /**
   * Private property `#avail` used by `FdReader`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #avail = undefined;
   *
   *   readInternalState() {
   *     return this.#avail;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #avail: number = 0;
  /**
   * Create a reader for an existing file descriptor.
   *
   * The descriptor is borrowed and must remain valid until the reader closes.
   * `onClose` is required so callers can wire descriptor shutdown, socket
   * half-close, or reference counting in the owning abstraction.
   *
   * ```js
   * import { FdReader } from 'fino:stream';
   * const reader = new FdReader(0, () => console.log('stdin reader closed'));
   * console.log(reader.closed);
   * ```
   *
   * @param fd POSIX file descriptor to read from.
   * @param onClose Cleanup callback invoked by `close()`.
   * @internal
   */
  constructor(fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#fd = fd;
  }
  /**
   * Raw borrowed file descriptor.
   *
   * The value is exposed for subclasses and close callbacks. Ownership remains
   * with the creator; reading this property does not keep the descriptor alive.
   *
   * ```js
   * import { FdReader } from 'fino:stream';
   * const reader = new FdReader(0, () => {});
   * console.log(reader.fd);
   * ```
   *
   * @returns The borrowed descriptor number.
   * @internal
   */
  get fd(): number {
    return this.#fd;
  }
  /**
   * Pull one descriptor chunk for the buffered reader.
   *
   * The method waits for readability when needed, copies read bytes out of the
   * reusable arena, returns `null` on EOF or after close, and treats non-EAGAIN
   * read failures as EOF.
   *
   * ```js
   * import { FdReader } from 'fino:stream';
   * const reader = new FdReader(0, () => {});
   * console.log(typeof reader.read);
   * ```
   *
   * @returns A byte chunk, or `null` on EOF/close.
   * @internal
   */
  protected async doPull(): Promise<Uint8Array | null> {
    while (true) {
      if (this.closed) return null;
      if (this.#fd < 0) throw new Error('read failed');
      if (this.#avail <= 0) {
        this.#avail = await loop.readable(this.#fd);
        if (this.closed) return null;
      }
      const n = lib.symbols.read(this.#fd, this.#readBuf, 65536) as number;
      if (n > 0) {
        this.#avail = Math.max(0, this.#avail - n);
        const out = new Uint8Array(n);
        out.set(this.#readView.subarray(0, n));
        return out;
      }
      if (n === 0) return null;
      if (getErrno() !== EAGAIN) return null;
      this.#avail = 0;
    }
  }
}
// ---------------------------------------------------------------------------
// Writer<T> — generic async consumer of values
// ---------------------------------------------------------------------------
/**
 * Abstract base class for asynchronous consumers.
 *
 * Subclasses implement `write(value)`. The base class supplies ordered
 * `pipe()` consumption, a no-op `flush()` hook, and idempotent asynchronous
 * close handling. `close()` awaits the optional callback and does not flush
 * unless a subclass overrides it.
 *
 * ```js
 * import { Writer } from 'fino:stream';
 * class ArrayWriter extends Writer {
 *   values = [];
 *   async write(value) { this.values.push(value); }
 * }
 * const writer = new ArrayWriter();
 * await writer.write('hello');
 * ```
 *
 * @typeParam T Value type consumed by `write()`.
 */
export abstract class Writer<T> {
  /**
   * Private property `#closed` used by `Writer`.
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
  #closed = false;
  /**
   * Private property `#onClose` used by `Writer`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onClose = undefined;
   *
   *   readInternalState() {
   *     return this.#onClose;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onClose: () => void | Promise<void>;
  /**
   * Create a writer with an optional close callback.
   *
   * The callback defaults to a no-op and is invoked at most once. Callback
   * failures reject `close()`.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * class NullWriter extends Writer { async write(_value) {} }
   * const writer = new NullWriter(() => console.log('closed'));
   * await writer.close();
   * ```
   *
   * @param onClose Optional cleanup callback.
   */
  constructor(onClose: () => void | Promise<void> = () => {}) {
    this.#onClose = onClose;
  }
  /**
   * Whether the writer has been closed.
   *
   * Subclasses should reject writes after this flag is true. The flag is set
   * before the close callback is awaited.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * class NullWriter extends Writer { async write(_value) {} }
   * const writer = new NullWriter();
   * await writer.close();
   * console.log(writer.closed);
   * ```
   *
   * @returns True after `close()` starts.
   */
  get closed(): boolean {
    return this.#closed;
  }
  /**
   * Write one value to the sink.
   *
   * Subclasses define ordering, backpressure, and failure behavior. Generic
   * `Writer` does not enforce the closed state; byte writers do.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * class ArrayWriter extends Writer {
   *   values = [];
   *   async write(value) { this.values.push(value); }
   * }
   * await new ArrayWriter().write('x');
   * ```
   *
   * @param value Value to write.
   * @returns A promise that resolves after the value is accepted.
   */
  abstract write(value: T): Promise<void>;
  /**
   * Write one value synchronously when the writer supports synchronous
   * acceptance.
   *
   * This method is an optional capability for hot paths that must not yield
   * between producing bytes and updating native state. Implementations should
   * either accept the value completely before returning or throw. The base
   * `Writer` does not provide a fallback because calling async `write()` from a
   * sync-only path would hide an ordering bug.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * function writeNow(writer, value) {
   *   if (writer.writeSync === undefined) throw new Error('sync writes unavailable');
   *   writer.writeSync(value);
   * }
   * ```
   */
  writeSync?(value: T): void;
  /**
   * Consume an async iterable and write each value in order.
   *
   * The method awaits each `write()` before reading the next source value,
   * preserving backpressure. It does not close the writer or the source.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * class ArrayWriter extends Writer {
   *   values = [];
   *   async write(value) { this.values.push(value); }
   * }
   * const writer = new ArrayWriter();
   * await writer.pipe(['a', 'b']);
   * console.log(writer.values.length);
   * ```
   *
   * @param source Async iterable source.
   * @returns A promise that resolves after all values are written.
   */
  async pipe(source: AsyncIterable<T>): Promise<void> {
    for await (const v of source) await this.write(v);
  }
  /**
   * Flush internally buffered data.
   *
   * The base implementation is a no-op for unbuffered writers. Buffered
   * subclasses override this to write pending bytes and may throw on sink
   * failures.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * class NullWriter extends Writer { async write(_value) {} }
   * await new NullWriter().flush();
   * ```
   *
   * @returns A promise that resolves after pending data is flushed.
   */
  async flush(): Promise<void> {}
  /**
   * Close the writer and run its close callback once.
   *
   * Multiple calls are safe. The base class does not flush; subclasses with
   * buffers should override close to flush first.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * class NullWriter extends Writer { async write(_value) {} }
   * const writer = new NullWriter();
   * await writer.close();
   * await writer.close();
   * ```
   *
   * @returns A promise that resolves after cleanup.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#onClose();
  }
  /**
   * Close the writer synchronously when the writer supports synchronous close.
   *
   * This optional capability is for callers that need close state to be visible
   * immediately. Implementations should mark the writer closed before returning
   * and perform only synchronous cleanup. Callers that can yield should continue
   * to use `close()`.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * function closeNow(writer) {
   *   if (writer.closeSync === undefined) throw new Error('sync close unavailable');
   *   writer.closeSync();
   * }
   * ```
   */
  closeSync?(): void;
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
// ---------------------------------------------------------------------------
// BytesWriter extends Writer<Uint8Array> — structural byte write API
// ---------------------------------------------------------------------------
/**
 * Abstract byte-stream writer.
 *
 * Subclasses implement `doWrite(buf)` to emit all bytes to the underlying
 * resource. `write()` accepts `ArrayBuffer` and `ArrayBufferView` sources,
 * rejects writes after close, and delegates to the hook. `writev()` defaults to
 * sequential writes and can be overridden for scatter/gather implementations.
 *
 * ```js
 * import { BytesWriter } from 'fino:stream';
 * class MemoryWriter extends BytesWriter {
 *   chunks = [];
 *   async doWrite(buf) { this.chunks.push(buf.slice()); }
 * }
 * const writer = new MemoryWriter();
 * await writer.write(new Uint8Array([1]));
 * ```
 */
export abstract class BytesWriter extends Writer<Uint8Array> {
  /**
   * Emit all bytes in `buf` to the underlying resource.
   *
   * Implementations must handle partial writes, backpressure, and sink errors
   * internally. The base `write()` method has already converted input to a
   * `Uint8Array` and checked the closed state.
   *
   * ```js
   * import { BytesWriter } from 'fino:stream';
   * class MemoryWriter extends BytesWriter {
   *   async doWrite(buf) { console.log(buf.byteLength); }
   * }
   * await new MemoryWriter().write(new Uint8Array([1, 2]));
   * ```
   *
   * @param buf Bytes to emit completely.
   * @returns A promise that resolves after bytes are written.
   */
  protected abstract doWrite(buf: Uint8Array): Promise<void>;
  /**
   * Write one byte buffer.
   *
   * `ArrayBuffer` and `ArrayBufferView` inputs are wrapped in a `Uint8Array`
   * preserving view byte offsets. The method throws `Writer is closed` after
   * close and forwards errors from `doWrite()`.
   *
   * ```js
   * import { BytesWriter } from 'fino:stream';
   * class MemoryWriter extends BytesWriter {
   *   bytes = 0;
   *   async doWrite(buf) { this.bytes += buf.byteLength; }
   * }
   * const writer = new MemoryWriter();
   * await writer.write(new ArrayBuffer(4));
   * console.log(writer.bytes);
   * ```
   *
   * @param data Bytes to write.
   * @returns A promise that resolves after all bytes are accepted.
   */
  async write(data: ArrayBuffer | ArrayBufferView): Promise<void> {
    if (this.closed) throw new Error('Writer is closed');
    const arr = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    await this.doWrite(arr);
  }
  /**
   * Write multiple buffers in order.
   *
   * The default implementation writes up to `count` vectors sequentially and
   * skips missing or empty entries. Subclasses may override for vectorized
   * system calls. Errors from any individual write abort the sequence.
   *
   * ```js
   * import { BytesWriter } from 'fino:stream';
   * class MemoryWriter extends BytesWriter {
   *   bytes = 0;
   *   async doWrite(buf) { this.bytes += buf.byteLength; }
   * }
   * const writer = new MemoryWriter();
   * await writer.writev([new Uint8Array([1]), new Uint8Array([2])]);
   * console.log(writer.bytes);
   * ```
   *
   * @param vecs Byte vectors to write.
   * @param count Number of vectors from `vecs` to consider. Defaults to all.
   * @returns A promise that resolves after all selected vectors are written.
   */
  async writev(vecs: Uint8Array[], count: number = vecs.length): Promise<void> {
    for (let i = 0; i < count; i++) {
      const v = vecs[i];
      if (v && v.byteLength > 0) await this.write(v);
    }
  }
}
// ---------------------------------------------------------------------------
// BufferedBytesWriter extends BytesWriter — downstream write coalescing
// ---------------------------------------------------------------------------
/**
 * Byte writer with a coalescing buffer.
 *
 * Small writes accumulate in an internal buffer and are emitted by `doFlush()`
 * when the buffer fills, when `flush()` is called, or before `close()`
 * completes. Writes at least as large as the buffer bypass coalescing after
 * pending bytes are flushed. `writev()` accumulates small vector batches through
 * the same coalescing buffer without routing each vector through `write()`.
 *
 * ```js
 * import { BufferedBytesWriter, BytesWriter } from 'fino:stream';
 * class Sink extends BytesWriter { async doWrite(_buf) {} }
 * const writer = BufferedBytesWriter.over(new Sink());
 * await writer.write(new Uint8Array([1]));
 * await writer.flush();
 * ```
 */
export abstract class BufferedBytesWriter extends BytesWriter {
  /**
   * Private property `#buf` used by `BufferedBytesWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #buf = undefined;
   *
   *   readInternalState() {
   *     return this.#buf;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #buf: Uint8Array;
  /**
   * Private property `#pending` used by `BufferedBytesWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #pending = undefined;
   *
   *   readInternalState() {
   *     return this.#pending;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #pending: number = 0;
  /**
   * Private static readonly property `#COALESCE_LIMIT` used by `BufferedBytesWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   static #COALESCE_LIMIT = undefined;
   *
   *   static readInternalState() {
   *     return this.#COALESCE_LIMIT;
   *   }
   * }
   * ```
   *
   * @internal
   */
  static readonly #COALESCE_LIMIT = 65536;
  /**
   * Create a buffered byte writer.
   *
   * `bufferSize` defaults to 64 KiB. A smaller buffer flushes more often; a
   * larger buffer can reduce syscall frequency at the cost of memory. `onClose`
   * is invoked after pending bytes are flushed.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter { async doFlush(_buf) {} }
   * const writer = new Sink(() => {}, 1024);
   * await writer.close();
   * ```
   *
   * @param onClose Optional cleanup callback.
   * @param bufferSize Coalesce buffer size in bytes. Defaults to 65536.
   */
  constructor(onClose: () => void | Promise<void> = () => {}, bufferSize: number = 65536) {
    super(onClose);
    this.#buf = new Uint8Array(bufferSize);
  }
  /**
   * Flush a coalesced byte slice to the underlying resource.
   *
   * Implementations must emit all bytes in `buf` or throw. The slice is backed
   * by the writer's internal buffer and should not be retained after the promise
   * resolves.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter {
   *   async doFlush(buf) { console.log(buf.byteLength); }
   * }
   * await new Sink().write(new Uint8Array([1]));
   * ```
   *
   * @param buf Pending bytes to emit.
   * @returns A promise that resolves after all bytes are flushed.
   */
  protected abstract doFlush(buf: Uint8Array): Promise<void>;
  /**
   * Wrap an existing byte writer with coalescing behavior.
   *
   * The wrapper flushes by calling `target.write(buf)` and closes the target
   * when the wrapper closes. `bufferSize` defaults to 64 KiB.
   *
   * ```js
   * import { BufferedBytesWriter, BytesWriter } from 'fino:stream';
   * class Sink extends BytesWriter { async doWrite(_buf) {} }
   * const buffered = BufferedBytesWriter.over(new Sink(), 4096);
   * await buffered.close();
   * ```
   *
   * @param target Byte writer to wrap.
   * @param bufferSize Coalesce buffer size in bytes. Defaults to 65536.
   * @returns A buffered wrapper around `target`.
   */
  static over(target: BytesWriter, bufferSize: number = 65536): BufferedBytesWriter {
    return new (class WrappedBufferedWriter extends BufferedBytesWriter {
      protected doFlush(buf: Uint8Array): Promise<void> {
        return target.write(buf);
      }
    })(() => target.close(), bufferSize);
  }
  // BytesWriter.doWrite override: coalesce small writes; bypass for large ones.
  /**
   * Coalesce or immediately flush one byte buffer.
   *
   * Buffers at least as large as the coalesce buffer bypass accumulation after
   * pending bytes are flushed. Smaller buffers are copied into the internal
   * buffer, flushing first if needed.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter { async doFlush(_buf) {} }
   * await new Sink().write(new Uint8Array([1, 2]));
   * ```
   *
   * @param buf Bytes to write.
   * @returns A promise that resolves after bytes are buffered or flushed.
   */
  protected async doWrite(buf: Uint8Array): Promise<void> {
    if (buf.byteLength >= this.#buf.byteLength) {
      // Bypass: write is large enough that coalescing doesn't help.
      await this.flush();
      return this.doFlush(buf);
    }
    if (this.#pending + buf.byteLength > this.#buf.byteLength) {
      await this.flush();
    }
    this.#buf.set(buf, this.#pending);
    this.#pending += buf.byteLength;
  }
  /**
   * Write multiple byte buffers through the coalescing buffer.
   *
   * Small vectors are accumulated synchronously and flushed only when the
   * buffer fills. A vector at least as large as the coalesce buffer flushes
   * pending bytes first and then bypasses accumulation.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter { async doFlush(_buf) {} }
   * await new Sink().writev([new Uint8Array([1]), new Uint8Array([2])]);
   * ```
   *
   * @param vecs Byte vectors to write.
   * @param count Number of vectors from `vecs` to consider. Defaults to all.
   * @returns A promise that resolves after all selected vectors are buffered or flushed.
   */
  async writev(vecs: Uint8Array[], count: number = vecs.length): Promise<void> {
    if (this.closed) throw new Error('Writer is closed');
    for (let i = 0; i < count; i++) {
      const v = vecs[i];
      if (!v || v.byteLength === 0) continue;
      if (v.byteLength >= this.#buf.byteLength) {
        await this.flush();
        await this.doFlush(v);
        continue;
      }
      if (!this._directAccumulate(v)) {
        await this.flush();
        this._directAccumulate(v);
      }
    }
  }
  /**
   * Synchronously copy `buf` into the coalesce buffer.
   *
   * Returns true if the bytes were accumulated; false if the buffer
   * doesn't have enough room (caller must await flush() first, then retry).
   * Only safe to call when `buf.byteLength < this.#buf.byteLength`.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter {
   *   async doFlush(_buf) {}
   *   tryAccumulate(buf) { return this._directAccumulate(buf); }
   * }
   * console.log(new Sink().tryAccumulate(new Uint8Array([1])));
   * ```
   *
   * @param buf Bytes to copy into the coalesce buffer.
   * @returns True when bytes were accumulated; false when a flush is needed.
   */
  protected _directAccumulate(buf: Uint8Array): boolean {
    if (this.#pending + buf.byteLength > this.#buf.byteLength) return false;
    this.#buf.set(buf, this.#pending);
    this.#pending += buf.byteLength;
    return true;
  }
  /**
   * Drain the coalesce buffer.
   *
   * Calling `flush()` with no pending bytes is a no-op. Errors from `doFlush()`
   * reject the returned promise and the pending count has already been reset.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter { async doFlush(_buf) {} }
   * const writer = new Sink();
   * await writer.write(new Uint8Array([1]));
   * await writer.flush();
   * ```
   *
   * @returns A promise that resolves after pending bytes are emitted.
   */
  async flush(): Promise<void> {
    if (this.#pending === 0) return;
    const slice = this.#buf.subarray(0, this.#pending);
    this.#pending = 0;
    await this.doFlush(slice);
  }
  /**
   * Return the buffered bytes (a copy) and reset the pending count.
   * Used by subclasses that need to perform a synchronous flush (e.g. on
   * process exit) without going through the async flush path.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter {
   *   async doFlush(_buf) {}
   *   take() { return this._takePending(); }
   * }
   * const writer = new Sink();
   * await writer.write(new Uint8Array([1]));
   * console.log(writer.take()?.byteLength);
   * ```
   *
   * @returns Pending bytes, or `null` when the buffer is empty.
   */
  protected _takePending(): Uint8Array | null {
    if (this.#pending === 0) return null;
    const out = this.#buf.slice(0, this.#pending);
    this.#pending = 0;
    return out;
  }
  /**
   * Flush pending bytes, then close the writer.
   *
   * The method is idempotent. If flushing throws, the close callback still runs
   * through the `finally` block and the flush error is rethrown.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter { async doFlush(_buf) {} }
   * const writer = new Sink();
   * await writer.close();
   * ```
   *
   * @returns A promise that resolves after flush and cleanup.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.flush();
    } finally {
      await super.close();
    }
  }
}
// ---------------------------------------------------------------------------
// FdWriter — libc write(2) backed BufferedBytesWriter
// ---------------------------------------------------------------------------
// Coalesce threshold: responses smaller than this use a single write(2)
// instead of scatter-gather writev(2). 64 KiB covers all normal HTTP responses.
const COALESCE_LIMIT = 65536;
/**
 * Buffered writer backed by a POSIX file descriptor.
 *
 * `FdWriter` borrows the descriptor; the `onClose` callback owns descriptor
 * cleanup. Normal flushing uses libc `write(2)` and waits for runtime
 * writability on EAGAIN. `writev()` coalesces small batches and uses
 * scatter/gather `writev(2)` for large batches.
 *
 * ```js
 * import { FdWriter } from 'fino:stream';
 * const writer = new FdWriter(1, () => {});
 * console.log(writer.fd);
 * await writer.close();
 * ```
 *
 * @internal
 */
export class FdWriter extends BufferedBytesWriter {
  /**
   * Private property `#fd` used by `FdWriter`.
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
  // Pre-allocated iovec buffer for the large-write scatter/gather slow path.
  /**
   * Private property `#iovBuf` used by `FdWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #iovBuf = undefined;
   *
   *   readInternalState() {
   *     return this.#iovBuf;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #iovBuf = new ArrayBuffer(MAX_IOV * IOVEC_SIZE);
  /**
   * Private property `#iovView` used by `FdWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #iovView = undefined;
   *
   *   readInternalState() {
   *     return this.#iovView;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #iovView = new DataView(this.#iovBuf);
  // Per-vector write cursors for partial-writev tracking.
  /**
   * Private property `#cursors` used by `FdWriter`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #cursors = undefined;
   *
   *   readInternalState() {
   *     return this.#cursors;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #cursors = new Int32Array(MAX_IOV);
  /**
   * Create a writer for an existing file descriptor.
   *
   * The descriptor is borrowed and must remain valid until the writer closes.
   * `onClose` is required so callers can wire descriptor shutdown, socket
   * half-close, or reference counting in the owning abstraction.
   *
   * ```js
   * import { FdWriter } from 'fino:stream';
   * const writer = new FdWriter(1, () => console.log('stdout writer closed'));
   * console.log(writer.closed);
   * ```
   *
   * @param fd POSIX file descriptor to write to.
   * @param onClose Cleanup callback invoked by `close()`.
   * @internal
   */
  constructor(fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#fd = fd;
  }
  /**
   * Raw borrowed file descriptor.
   *
   * The value is exposed for subclasses and close callbacks. Ownership remains
   * with the creator; reading this property does not keep the descriptor alive.
   *
   * ```js
   * import { FdWriter } from 'fino:stream';
   * const writer = new FdWriter(1, () => {});
   * console.log(writer.fd);
   * ```
   *
   * @returns The borrowed descriptor number.
   * @internal
   */
  get fd(): number {
    return this.#fd;
  }
  /**
   * Synchronous flush of the coalesce buffer via write(2). Used in contexts
   * where async is not available (e.g. `process.exit()`). EAGAIN is ignored
   * (partial writes are accepted on a best-effort basis).
   *
   * ```js
   * import { FdWriter } from 'fino:stream';
   * const writer = new FdWriter(1, () => {});
   * writer.flushSync();
   * ```
   *
   * @returns Nothing. Pending bytes may remain unwritten on EAGAIN or error.
   * @internal
   */
  flushSync(): void {
    const pending = this._takePending();
    if (pending === null) return;
    let off = 0;
    while (off < pending.byteLength) {
      const slice = off === 0 ? pending : pending.subarray(off);
      const n = lib.symbols.write(this.#fd, slice, slice.byteLength) as number;
      if (n > 0) {
        off += n;
        continue;
      }
      break;
    }
  }
  /**
   * Flush all bytes in `buf` with `write(2)`.
   *
   * Partial writes advance through the buffer. EAGAIN waits for descriptor
   * writability and retries. Closing the writer during the wait throws
   * `Writer closed during write`; other failures throw `write failed`.
   *
   * ```js
   * import { FdWriter } from 'fino:stream';
   * const writer = new FdWriter(1, () => {});
   * await writer.write(new Uint8Array());
   * ```
   *
   * @param buf Bytes to flush completely.
   * @returns A promise that resolves after all bytes are written.
   * @internal
   */
  protected async doFlush(buf: Uint8Array): Promise<void> {
    let off = 0;
    while (off < buf.byteLength) {
      const slice = off === 0 ? buf : buf.subarray(off);
      const n = lib.symbols.write(this.#fd, slice, slice.byteLength) as number;
      if (n > 0) {
        off += n;
        continue;
      }
      if (n < 0 && getErrno() === EAGAIN) {
        await loop.writable(this.#fd);
        if (this.closed) throw new Error('Writer closed during write');
        continue;
      }
      throw new Error('write failed');
    }
  }
  /**
   * Write multiple buffers.
   *
   * Fast path (total at most 64 KiB): push each vec through the inherited
   * coalesce buffer, usually producing one syscall when it flushes.
   *
   * Slow path (total over 64 KiB): flush pending bytes, then use true
   * scatter/gather via `writev(2)` with no data copy. `count` must not exceed
   * the internal iovec limit. Closed writers, too many vectors, EAGAIN retry
   * failures, and writev errors throw.
   *
   * ```js
   * import { FdWriter } from 'fino:stream';
   * const writer = new FdWriter(1, () => {});
   * await writer.writev([new Uint8Array(), new Uint8Array()], 2);
   * ```
   *
   * @param vecs Byte vectors to write.
   * @param count Number of vectors from `vecs` to consider. Defaults to all.
   * @returns A promise that resolves after all selected vectors are written.
   * @internal
   */
  async writev(vecs: Uint8Array[], count: number = vecs.length): Promise<void> {
    if (this.closed) throw new Error('Writer is closed');
    if (count === 0) return;
    if (count > MAX_IOV) throw new Error(`writev: too many vectors (max ${MAX_IOV})`);
    let totalLen = 0;
    for (let i = 0; i < count; i++) totalLen += vecs[i]!.byteLength;
    if (totalLen <= COALESCE_LIMIT) {
      // Fast path: accumulate synchronously into the coalesce buffer — no Promises
      // until the buffer is full and a flush is needed (rare for typical responses).
      for (let i = 0; i < count; i++) {
        const v = vecs[i];
        if (!v || v.byteLength === 0) continue;
        if (!this._directAccumulate(v)) {
          await this.flush();
          this._directAccumulate(v);
        }
      }
      return;
    }
    // Slow path: scatter/gather writev(2) — zero copy for large writes.
    // Flush the coalesce buffer first so bytes stay ordered.
    await this.flush();
    const cursors = this.#cursors;
    cursors.fill(0, 0, count);
    const view = this.#iovView;
    while (true) {
      let iovcnt = 0;
      for (let i = 0; i < count; i++) {
        const vec = vecs[i]!;
        const cursor = cursors[i]!;
        const rem = vec.byteLength - cursor;
        if (rem <= 0) continue;
        const off = iovcnt * IOVEC_SIZE;
        view.setBigUint64(off, Pointer.addr(vec) + BigInt(cursor), true);
        view.setBigUint64(off + 8, BigInt(rem), true);
        iovcnt++;
      }
      if (iovcnt === 0) break;
      const n = lib.symbols.writev(this.#fd, this.#iovBuf, iovcnt) as number;
      if (n < 0) {
        if (getErrno() === EAGAIN) {
          await loop.writable(this.#fd);
          continue;
        }
        throw new Error('writev failed');
      }
      if (n === 0) {
        await loop.writable(this.#fd);
        continue;
      }
      let rem = n;
      for (let i = 0; i < count && rem > 0; i++) {
        const vec = vecs[i]!;
        const cursor = cursors[i]!;
        const avail = vec.byteLength - cursor;
        if (avail <= 0) continue;
        if (rem >= avail) {
          cursors[i] = cursor + avail;
          rem -= avail;
        } else {
          cursors[i] = cursor + rem;
          rem = 0;
        }
      }
    }
  }
}
// ---------------------------------------------------------------------------
// Channel<T> — connected Writer/Reader pair sharing an in-memory buffer
// ---------------------------------------------------------------------------
// Shared internal state between the two halves — not exported.
class PipeBuf<T> {
  buf: T[] = [];
  idx = 0;
  done = false;
  hasErr = false;
  err: unknown;
  waiters: Array<{
    resolve: (v: T | null) => void;
    reject: (e: unknown) => void;
  }> = [];
  push(value: T): void {
    const w = this.waiters.shift();
    if (w) {
      w.resolve(value);
    } else {
      this.buf.push(value);
    }
  }
  end(): void {
    if (this.done) return;
    this.done = true;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve(null);
  }
  fail(err: unknown): void {
    this.hasErr = true;
    this.err = err;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.reject(err);
  }
  read(): Promise<T | null> {
    if (this.idx < this.buf.length) return Promise.resolve(this.buf[this.idx++]!);
    if (this.done) return Promise.resolve(null);
    if (this.hasErr) return Promise.reject(this.err);
    return new Promise<T | null>((resolve, reject) => {
      this.waiters.push({
        resolve,
        reject,
      });
    });
  }
  cancelWaiters(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve(null);
  }
}
/**
 * Writer end of a `Channel`.
 *
 * `write()` enqueues a value for the reader, `close()` signals EOF, and
 * `fail(err)` propagates an error to the reader. A value written while a reader
 * is blocked in `read()` is handed straight to that pending read; otherwise it
 * queues in the shared FIFO buffer. Writes after `close()` are silently dropped,
 * which lets a producer over-run a consumer that has already stopped without
 * raising.
 *
 * Instances are obtained from a `Channel`, never constructed directly.
 *
 * ```ts no_run
 * import { Channel } from 'fino:stream';
 *
 * const ch = new Channel<number>();
 * const writer = ch.writer;
 * await writer.write(1);
 * await writer.write(2);
 * await writer.close();
 * ```
 *
 * @internal
 */
export class PipeWriter<T> extends Writer<T> {
  #buf: PipeBuf<T>;
  /**
   * Bind the writer to a shared pipe buffer.
   *
   * The `onClose` callback ends the buffer, which resolves any pending reader
   * `read()` with EOF. This is called by `Channel`; application code should
   * construct a `Channel` instead.
   *
   * @internal
   */
  constructor(buf: PipeBuf<T>) {
    super(() => buf.end());
    this.#buf = buf;
  }
  /**
   * Enqueue a value for the connected reader.
   *
   * Resolves immediately: this channel applies no backpressure and never blocks
   * the producer. If the reader is currently awaiting a value, it receives this
   * one directly; otherwise the value is appended to the buffer.
   *
   * @internal
   */
  override async write(value: T): Promise<void> {
    this.#buf.push(value);
  }
  /**
   * Signal an error to the connected reader.
   *
   * The next `reader.read()` (or any read already pending) rejects with `err`.
   * Unlike `close()`, this surfaces a failure rather than a clean EOF, so a
   * `for await` loop over the reader throws.
   *
   * ```ts no_run
   * import { Channel } from 'fino:stream';
   *
   * const ch = new Channel<number>();
   * ch.writer.fail(new Error('upstream reset'));
   * await ch.reader.read(); // rejects with the same error
   * ```
   *
   * @internal
   */
  fail(err: unknown): void {
    this.#buf.fail(err);
  }
}
/**
 * Reader end of a `Channel`.
 *
 * Values are delivered in the order they were written. `read()` returns the
 * next buffered value, or waits when the buffer is empty, resolving with `null`
 * once the writer closes or rejecting if the writer called `fail()`. As a
 * `Reader<T>` it also supports `for await` iteration and `pipe()`. Closing the
 * reader cancels any waiting reads (resolving them with EOF) and releases the
 * shared buffer.
 *
 * Instances are obtained from a `Channel`, never constructed directly.
 *
 * ```ts no_run
 * import { Channel } from 'fino:stream';
 *
 * const ch = new Channel<string>();
 * void ch.writer.write('a');
 * void ch.writer.close();
 * for await (const v of ch.reader) console.log(v); // "a"
 * ```
 *
 * @internal
 */
export class PipeReader<T> extends Reader<T> {
  #buf: PipeBuf<T>;
  /**
   * Bind the reader to a shared pipe buffer.
   *
   * The `onClose` callback cancels any waiting reads so a closed reader never
   * leaves a promise pending. This is called by `Channel`; application code
   * should construct a `Channel` instead.
   *
   * @internal
   */
  constructor(buf: PipeBuf<T>) {
    super(() => buf.cancelWaiters());
    this.#buf = buf;
  }
  /**
   * Pull the next value from the channel.
   *
   * Returns a buffered value when one is available, otherwise waits until the
   * writer produces a value, closes (resolving `null`), or fails (rejecting).
   *
   * @internal
   */
  override read(): Promise<T | null> {
    return this.#buf.read();
  }
}
/**
 * In-memory connected Writer/Reader pair.
 *
 * The `writer` and `reader` share a FIFO buffer. Write values with
 * `writer.write(v)`, signal EOF with `writer.close()`, or propagate
 * an error with `writer.fail(err)`. The `reader` is a standard
 * `Reader<T>` — iterate with `for await` or `reader.read()`.
 *
 * ```js
 * import { Channel } from 'fino:stream';
 * const ch = new Channel();
 * void ch.writer.write(1); void ch.writer.write(2); void ch.writer.close();
 * for await (const v of ch.reader) console.log(v); // 1, 2
 * ```
 *
 * @internal
 */
export class Channel<T> {
  /**
   * Producer half of the channel.
   *
   * Use `writer.write(v)` to enqueue values, `writer.close()` to signal EOF, and
   * `writer.fail(err)` to surface an error to the reader.
   *
   * @internal
   */
  readonly writer: PipeWriter<T>;
  /**
   * Consumer half of the channel.
   *
   * A standard `Reader<T>`: iterate it with `for await`, drive it with
   * `reader.read()`, or feed another `Writer` with `writer.pipe(reader)`.
   *
   * @internal
   */
  readonly reader: PipeReader<T>;
  /**
   * Create a connected writer/reader pair over a fresh in-memory buffer.
   *
   * The two halves share one FIFO buffer, so values written on `writer` become
   * readable on `reader` in order.
   *
   * @internal
   */
  constructor() {
    const buf = new PipeBuf<T>();
    this.writer = new PipeWriter(buf);
    this.reader = new PipeReader(buf);
  }
}
