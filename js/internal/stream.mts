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
 * @internal
 */

import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import * as loop from 'fino:runtime/loop';

const LIBC    = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = os === 'darwin' ? '__error' : '__errno_location';
const EAGAIN  = os === 'darwin' ? 35 : 11;

const lib = dlopen(LIBC, {
  read:      { parameters: ['i32', 'buffer', 'i32'], result: 'i32'     },
  write:     { parameters: ['i32', 'buffer', 'i32'], result: 'i32'     },
  writev:    { parameters: ['i32', 'buffer', 'i32'], result: 'i32'     },
  [errnoFn]: { parameters: [],                       result: 'pointer' },
});

// iovec layout on 64-bit: { void *iov_base (8 bytes), size_t iov_len (8 bytes) }
const IOVEC_SIZE    = 16;
const MAX_IOV       = 16;

const errnoPtr = lib.symbols[errnoFn]!() as ArrayBuffer;

function getErrno(): number {
  return Pointer.readI32(errnoPtr, 0);
}

// ---------------------------------------------------------------------------
// Reader<T> — generic async producer of values
// ---------------------------------------------------------------------------

type ReaderCloseCallback = () => void | Promise<void>;

/**
 * Abstract base class for any async producer of values of type T.
 *
 * Provides:
 *   - async iterator protocol (for await … of reader)
 *   - async close() that invokes the onClose callback
 *
 * Subclasses implement read() to produce the next value or null on EOF.
 */
export abstract class Reader<T> implements AsyncIterator<T> {
  #closed  = false;
  #onClose: ReaderCloseCallback;

  constructor(onClose: ReaderCloseCallback = () => {}) {
    this.#onClose = onClose;
  }

  get closed(): boolean { return this.#closed; }

  /** Produce the next value, or null on EOF. */
  abstract read(): Promise<T | null>;

  /** Close this reader. Idempotent; awaits the onClose callback. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#onClose();
  }

  async next(): Promise<IteratorResult<T>> {
    const v = await this.read();
    if (v === null) {
      await this.close();
      return { done: true, value: undefined };
    }
    return { done: false, value: v };
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

// ---------------------------------------------------------------------------
// BytesReader extends Reader<Uint8Array> — structural byte read API
// ---------------------------------------------------------------------------

/**
 * Abstract byte-stream reader. Adds structural-read primitives on top of
 * a single template method, doRead(maxBytes).
 *
 * doRead(maxBytes) returns AT MOST maxBytes bytes; it may return fewer.
 * The structural methods (readExactly, readUntil, readByte) call doRead
 * with only as many bytes as they still need, so no bytes are ever
 * over-fetched or buffered at this layer.
 */
export abstract class BytesReader extends Reader<Uint8Array> {
  // Bytes stashed by readExactly/readUntil on EOF before their condition was
  // met. Returned on the next doRead call so no data is lost. BufferedBytesReader
  // overrides readExactly/readUntil with peek-based semantics that don't need
  // this, but the stash ensures correctness for any unbuffered BytesReader subclass.
  #stash: Uint8Array | null = null;

  /** Read up to maxBytes from the underlying source. May return fewer.
   *  Returns null on EOF. */
  protected abstract doRead(maxBytes: number): Promise<Uint8Array | null>;

  // Internal: drain the stash before calling doRead. Used by all structural
  // read methods so that bytes saved on a previous partial failure are replayed.
  #fetch(maxBytes: number): Promise<Uint8Array | null> {
    if (this.#stash !== null) {
      const s = this.#stash;
      if (s.byteLength <= maxBytes) {
        this.#stash = null;
        return Promise.resolve(s);
      }
      this.#stash = s.subarray(maxBytes);
      return Promise.resolve(s.subarray(0, maxBytes).slice());
    }
    return this.doRead(maxBytes);
  }

  /** Read one chunk of arbitrary size (default: up to 64 KiB). */
  async read(): Promise<Uint8Array | null> {
    return this.#fetch(65536);
  }

  /**
   * Read exactly n bytes. Returns null if EOF arrives before n bytes are
   * available. On null return, any bytes already read are stashed and will
   * be returned by the next read operation — no data is lost.
   *
   * BufferedBytesReader overrides this with a more efficient peek-based
   * implementation that avoids intermediate copies.
   */
  async readExactly(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0);
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const chunk = await this.#fetch(n - off);
      if (chunk === null) {
        // Stash whatever was read so the caller can still see it on the next read.
        if (off > 0) this.#stash = out.subarray(0, off).slice();
        return null;
      }
      out.set(chunk, off);
      off += chunk.byteLength;
    }
    return out;
  }

  /** Read one byte. Returns null on EOF. */
  async readByte(): Promise<number | null> {
    const c = await this.#fetch(1);
    if (c === null || c.byteLength === 0) return null;
    return c[0]!;
  }

  /**
   * Read until and including `delim`. Returns the bytes read, including the
   * delimiter. Returns null on EOF before the delimiter is found; any bytes
   * already scanned are stashed and available to the next read operation.
   * Throws if `max` bytes are scanned without finding the delimiter.
   *
   * Internally reads byte-by-byte via readByte(). With a BufferedBytesReader
   * below, each readByte() is a cheap chunk-list pop. BufferedBytesReader
   * overrides this with a scan-based implementation that avoids byte-at-a-time
   * overhead and uses its internal chunk list directly.
   */
  async readUntil(delim: Uint8Array, max: number = 1 << 20): Promise<Uint8Array | null> {
    if (delim.byteLength === 0) throw new Error('readUntil: empty delimiter');
    // Growable accumulator — starts at 256, doubles up to max.
    let buf = new Uint8Array(256);
    let len = 0;
    while (true) {
      const b = await this.readByte();
      if (b === null) {
        // Stash whatever was read so the caller can still see it on the next read.
        if (len > 0) this.#stash = buf.subarray(0, len).slice();
        return null;
      }
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
          if (buf[start + i] !== delim[i]) { match = false; break; }
        }
        if (match) return buf.subarray(0, len);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BufferedBytesReader extends BytesReader — upstream read coalescing
// ---------------------------------------------------------------------------

/**
 * Byte reader with an internal chunk-list buffer and upstream pull coalescing.
 *
 * Overrides doRead(maxBytes) to serve from the buffer, pulling a new chunk
 * from doPull() only when the buffer is empty. Because doPull() typically
 * returns 64 KiB at a time, callers making many small doRead(1) calls (as
 * readUntil does) pay only one syscall per large chunk.
 *
 * Also exposes peek / scanBuffered / takeBuffered for callers that need
 * synchronous buffer inspection without pulling from upstream (e.g. the
 * HTTP pipelined-request fast path).
 *
 * Subclasses implement doPull() to fetch one chunk from the underlying
 * resource. Use BufferedBytesReader.over(source) to wrap an existing
 * BytesReader without subclassing.
 */
export abstract class BufferedBytesReader extends BytesReader {
  #chunks:       Uint8Array[] = [];
  #bufferedBytes             = 0;
  #upstreamDone              = false;

  /**
   * Subclass: pull one raw chunk from the underlying resource.
   * May return any size. Returns null on EOF.
   */
  protected abstract doPull(): Promise<Uint8Array | null>;

  /**
   * Wrap an existing BytesReader as a BufferedBytesReader without subclassing.
   * Useful for tests or for layering buffering over a non-fd byte source.
   */
  static over(source: BytesReader): BufferedBytesReader {
    return new (class WrappedBufferedReader extends BufferedBytesReader {
      protected doPull(): Promise<Uint8Array | null> {
        return source.read();
      }
    })(() => source.close());
  }

  // BytesReader.doRead override: serve from buffer; pull on miss.
  protected async doRead(maxBytes: number): Promise<Uint8Array | null> {
    while (this.#chunks.length === 0) {
      if (this.#upstreamDone) return null;
      const chunk = await this.doPull();
      if (chunk === null) { this.#upstreamDone = true; return null; }
      if (chunk.byteLength === 0) continue; // skip empty pulls
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

  /** Number of bytes currently buffered (available without a pull). */
  get buffered(): number { return this.#bufferedBytes; }

  /** True once upstream has returned EOF and the buffer is fully drained. */
  get eof(): boolean { return this.#upstreamDone && this.#bufferedBytes === 0; }

  /**
   * Ensure at least n bytes are buffered (pulling from upstream if needed),
   * then return the first min(n, buffered) bytes without consuming them.
   */
  async peek(n: number): Promise<Uint8Array> {
    while (this.#bufferedBytes < n && !this.#upstreamDone) {
      const chunk = await this.doPull();
      if (chunk === null) { this.#upstreamDone = true; break; }
      if (chunk.byteLength === 0) continue;
      this.#chunks.push(chunk);
      this.#bufferedBytes += chunk.byteLength;
    }
    const want = Math.min(n, this.#bufferedBytes);
    if (want === 0) return new Uint8Array(0);
    return this.#sliceBuffered(want, false);
  }

  /**
   * Synchronous: scan the currently-buffered chunks for `delim`.
   * No upstream pulls. Returns the offset one past the end of the first
   * match, or -1 if not found.
   */
  scanBuffered(delim: Uint8Array): number {
    if (delim.byteLength === 0 || this.#bufferedBytes < delim.byteLength) return -1;
    // Flatten view (virtual index across chunk list).
    // We only materialize cross-chunk checks for the overlap window.
    let pos = 0; // virtual byte index within the buffer
    for (let ci = 0; ci < this.#chunks.length; ci++) {
      const chunk = this.#chunks[ci]!;
      // Scan within this chunk.
      const limit = chunk.byteLength - (delim.byteLength - 1);
      for (let i = 0; i < limit; i++) {
        if (chunk[i] !== delim[0]) continue;
        // Check remainder of delim.
        let match = true;
        for (let d = 1; d < delim.byteLength; d++) {
          if (chunk[i + d] !== delim[d]) { match = false; break; }
        }
        if (match) return pos + i + delim.byteLength;
      }
      // Check the cross-chunk overlap window at the end of this chunk.
      const overlapStart = Math.max(0, chunk.byteLength - (delim.byteLength - 1));
      outer: for (let i = overlapStart; i < chunk.byteLength; i++) {
        if (chunk[i] !== delim[0]) continue;
        // Build a virtual slice across chunks to compare against delim.
        let virtIdx = 0; // index into delim
        let globalOff = pos + i; // virtual offset of delim candidate start
        let g = globalOff; // walk virtual index
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
   * Synchronous: pop exactly n bytes off the head of the chunk list.
   * Does NOT pull from upstream. Throws if buffered < n.
   */
  takeBuffered(n: number): Uint8Array {
    if (n > this.#bufferedBytes) {
      throw new Error(`takeBuffered: requested ${n} but only ${this.#bufferedBytes} buffered`);
    }
    return this.#sliceBuffered(n, true);
  }

  // ── Structural read overrides with non-consuming-on-failure semantics ─────

  /**
   * Read exactly n bytes without consuming on failure.
   *
   * Uses peek to accumulate n bytes in the internal buffer, then consumes
   * them atomically. If EOF arrives before n bytes, returns null without
   * consuming any bytes — unlike BytesReader.readExactly which discards
   * already-consumed bytes on EOF.
   */
  async readExactly(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0);
    const peeked = await this.peek(n);
    if (peeked.byteLength < n) return null; // EOF before n bytes — nothing consumed
    return this.takeBuffered(n);
  }

  /**
   * Read until (and including) `delim`, without consuming on failure.
   *
   * Incrementally pulls data into the internal buffer and scans for `delim`.
   * If found: consumes and returns all bytes up to and including the delimiter.
   * If EOF without finding the delimiter: returns null without consuming anything.
   * Throws if `max` bytes are buffered without finding the delimiter.
   */
  async readUntil(delim: Uint8Array, max: number = 1 << 20): Promise<Uint8Array | null> {
    if (delim.byteLength === 0) throw new Error('readUntil: empty delimiter');
    while (true) {
      // Scan buffered data first (no upstream pull needed if already buffered).
      const end = this.scanBuffered(delim);
      if (end >= 0) {
        if (end > max) throw new Error(`readUntil: max ${max} bytes exceeded`);
        return this.takeBuffered(end);
      }
      if (this.#bufferedBytes > max) throw new Error(`readUntil: max ${max} bytes exceeded`);
      if (this.#upstreamDone) return null; // EOF without delimiter — nothing consumed
      // Pull one more chunk and scan again.
      const chunk = await this.doPull();
      if (chunk === null) { this.#upstreamDone = true; return null; }
      if (chunk.byteLength > 0) {
        this.#chunks.push(chunk);
        this.#bufferedBytes += chunk.byteLength;
      }
    }
  }

  // Shared helper: return n bytes from head of chunk list.
  // If consume=true, removes them from the buffer.
  #sliceBuffered(n: number, consume: boolean): Uint8Array {
    if (n === 0) return new Uint8Array(0);
    // Fast path: first chunk has at least n bytes.
    const head = this.#chunks[0]!;
    if (head.byteLength >= n) {
      const out = head.subarray(0, n);
      if (consume) {
        if (head.byteLength === n) { this.#chunks.shift(); }
        else { this.#chunks[0] = head.subarray(n); }
        this.#bufferedBytes -= n;
      }
      return out.slice(); // copy so caller owns the bytes
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
        if (take === c.byteLength) { idx++; }
        else { this.#chunks[idx] = c.subarray(take); break; }
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
 * Read half of a plain POSIX file descriptor. Uses libc read(2) with a
 * 64 KiB arena buffer; EAGAIN causes the loop to await fd readability.
 * Buffering is provided by the BufferedBytesReader base class.
 */
export class FdReader extends BufferedBytesReader {
  #fd:       number;
  #readBuf:  ArrayBuffer = new ArrayBuffer(65536);
  // Pre-allocated view — subarray() is cheaper than new Uint8Array(buf, off, len).
  #readView: Uint8Array  = new Uint8Array(this.#readBuf);
  // Bytes kqueue reported available at last EVFILT_READ event. When > 0 we can
  // skip the next loop.readable() call because the kernel already told us data
  // is present. Reset to 0 after each read() or on unexpected EAGAIN.
  #avail:    number      = 0;

  constructor(fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#fd = fd;
  }

  /** Raw file descriptor. Available to subclasses and close callbacks. */
  get fd(): number { return this.#fd; }

  protected async doPull(): Promise<Uint8Array | null> {
    while (true) {
      if (this.closed) return null;
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
      if (n === 0) return null;               // EOF
      if (getErrno() !== EAGAIN) return null; // ECONNRESET or other fatal error → treat as EOF
      this.#avail = 0;                        // unexpected EAGAIN — reset and wait next time
    }
  }
}

// ---------------------------------------------------------------------------
// Writer<T> — generic async consumer of values
// ---------------------------------------------------------------------------

/**
 * Abstract base class for any async consumer of values of type T.
 *
 * Provides:
 *   - write(value) template (subclasses implement)
 *   - pipe(source) — iterate source and write each value
 *   - async close() that invokes the onClose callback
 */
export abstract class Writer<T> {
  #closed  = false;
  #onClose: () => void | Promise<void>;

  constructor(onClose: () => void | Promise<void> = () => {}) {
    this.#onClose = onClose;
  }

  get closed(): boolean { return this.#closed; }

  /** Write one value. Subclasses implement. */
  abstract write(value: T): Promise<void>;

  /** Consume an async iterable and write each value in order. */
  async pipe(source: AsyncIterable<T>): Promise<void> {
    for await (const v of source) await this.write(v);
  }

  /** Flush any internally buffered bytes to the underlying resource.
   *  No-op for unbuffered writers. Overridden by BufferedBytesWriter. */
  async flush(): Promise<void> {}

  /** Close this writer. Idempotent; awaits the onClose callback. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#onClose();
  }
}

// ---------------------------------------------------------------------------
// BytesWriter extends Writer<Uint8Array> — structural byte write API
// ---------------------------------------------------------------------------

/**
 * Abstract byte-stream writer. Adds a doWrite(buf) template method;
 * write(data) delegates through. Subclasses implement doWrite to actually
 * emit bytes to the underlying resource.
 *
 * writev() defaults to sequential write() calls; subclasses may override
 * for scatter/gather.
 */
export abstract class BytesWriter extends Writer<Uint8Array> {
  /** Subclass: emit all bytes in buf to the underlying resource.
   *  Must handle partial writes / backpressure internally. */
  protected abstract doWrite(buf: Uint8Array): Promise<void>;

  async write(data: Uint8Array | ArrayBuffer): Promise<void> {
    if (this.closed) throw new Error('Writer is closed');
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.doWrite(arr);
  }

  /** Write multiple buffers in order. Override for scatter/gather. */
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
 * Byte writer with a coalesce buffer. Small write() calls accumulate in the
 * buffer; the buffer is flushed via doFlush() when it fills, on explicit
 * flush(), or when close() is called.
 *
 * Subclasses implement doFlush(buf) to emit the coalesced bytes to the
 * underlying resource. Use BufferedBytesWriter.over(target) to wrap an
 * existing BytesWriter without subclassing.
 */
export abstract class BufferedBytesWriter extends BytesWriter {
  #buf:     Uint8Array;
  #pending: number = 0;
  static readonly #COALESCE_LIMIT = 65536;

  constructor(onClose: () => void | Promise<void> = () => {}, bufferSize: number = 65536) {
    super(onClose);
    this.#buf = new Uint8Array(bufferSize);
  }

  /** Subclass: emit all bytes in buf to the underlying resource. */
  protected abstract doFlush(buf: Uint8Array): Promise<void>;

  /** Wrap an existing BytesWriter as a BufferedBytesWriter. */
  static over(target: BytesWriter, bufferSize: number = 65536): BufferedBytesWriter {
    return new (class WrappedBufferedWriter extends BufferedBytesWriter {
      protected doFlush(buf: Uint8Array): Promise<void> {
        return target.write(buf);
      }
    })(() => target.close(), bufferSize);
  }

  // BytesWriter.doWrite override: coalesce small writes; bypass for large ones.
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
   * Synchronously copy `buf` into the coalesce buffer.
   *
   * Returns true if the bytes were accumulated; false if the buffer
   * doesn't have enough room (caller must await flush() first, then retry).
   * Only safe to call when `buf.byteLength < this.#buf.byteLength`.
   */
  protected _directAccumulate(buf: Uint8Array): boolean {
    if (this.#pending + buf.byteLength > this.#buf.byteLength) return false;
    this.#buf.set(buf, this.#pending);
    this.#pending += buf.byteLength;
    return true;
  }

  /** Drain the coalesce buffer. Idempotent. */
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
   */
  protected _takePending(): Uint8Array | null {
    if (this.#pending === 0) return null;
    const out = this.#buf.slice(0, this.#pending);
    this.#pending = 0;
    return out;
  }

  /** Flush the coalesce buffer, then close. */
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
 * Write half of a plain POSIX file descriptor. Uses libc write(2) and
 * writev(2). Buffering is provided by the BufferedBytesWriter base class.
 *
 * writev() override: small batches (≤ 64 KiB total) go through the inherited
 * coalesce buffer (one syscall). Large batches use true scatter/gather
 * writev(2) for zero-copy writes.
 */
export class FdWriter extends BufferedBytesWriter {
  #fd:      number;
  // Pre-allocated iovec buffer for the large-write scatter/gather slow path.
  #iovBuf   = new ArrayBuffer(MAX_IOV * IOVEC_SIZE);
  #iovView  = new DataView(this.#iovBuf);
  // Per-vector write cursors for partial-writev tracking.
  #cursors  = new Int32Array(MAX_IOV);

  constructor(fd: number, onClose: () => void | Promise<void>) {
    super(onClose);
    this.#fd = fd;
  }

  /** Raw file descriptor. Available to subclasses and close callbacks. */
  get fd(): number { return this.#fd; }

  /**
   * Synchronous flush of the coalesce buffer via write(2). Used in contexts
   * where async is not available (e.g. `process.exit()`). EAGAIN is ignored
   * (partial writes are accepted on a best-effort basis).
   */
  flushSync(): void {
    const pending = this._takePending();
    if (pending === null) return;
    let off = 0;
    while (off < pending.byteLength) {
      const slice = off === 0 ? pending : pending.subarray(off);
      const n = lib.symbols.write(this.#fd, slice, slice.byteLength) as number;
      if (n > 0) { off += n; continue; }
      break; // EAGAIN or error — best-effort
    }
  }

  protected async doFlush(buf: Uint8Array): Promise<void> {
    let off = 0;
    while (off < buf.byteLength) {
      const slice = off === 0 ? buf : buf.subarray(off);
      const n = lib.symbols.write(this.#fd, slice, slice.byteLength) as number;
      if (n > 0) { off += n; continue; }
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
   * Fast path (total ≤ 64 KiB): push each vec through the inherited coalesce
   * buffer — one syscall via doFlush when it flushes.
   *
   * Slow path (total > 64 KiB): true scatter/gather via writev(2) — no copy.
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
          this._directAccumulate(v); // always fits after a flush (totalLen ≤ COALESCE_LIMIT)
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

    outer: while (true) {
      let iovcnt = 0;
      for (let i = 0; i < count; i++) {
        const vec    = vecs[i]!;
        const cursor = cursors[i]!;
        const rem    = vec.byteLength - cursor;
        if (rem <= 0) continue;
        const off = iovcnt * IOVEC_SIZE;
        view.setBigUint64(off,     Pointer.addr(vec) + BigInt(cursor), true);
        view.setBigUint64(off + 8, BigInt(rem),                        true);
        iovcnt++;
      }
      if (iovcnt === 0) break;

      const n = lib.symbols.writev(this.#fd, this.#iovBuf, iovcnt) as number;
      if (n < 0) {
        if (getErrno() === EAGAIN) { await loop.writable(this.#fd); continue; }
        throw new Error('writev failed');
      }

      let rem = n;
      for (let i = 0; i < count && rem > 0; i++) {
        const vec    = vecs[i]!;
        const cursor = cursors[i]!;
        const avail  = vec.byteLength - cursor;
        if (avail <= 0) continue;
        if (rem >= avail) { cursors[i] = cursor + avail; rem -= avail; }
        else              { cursors[i] = cursor + rem;   rem  = 0;     }
      }
      if (rem === 0) break outer;
    }
  }
}
