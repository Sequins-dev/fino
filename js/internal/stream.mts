/**
 * boats:stream — non-blocking Reader and Writer for any file descriptor.
 *
 * `Reader` and `Writer` are abstract base classes that provide fully async,
 * backpressure-aware I/O for any POSIX file descriptor. They implement the
 * async iterator protocol (`for await`) and handle all the machinery:
 *   - readability/writability waiting via `boats:loop`
 *   - retry on transient errors (EAGAIN, SSL_WANT_READ, etc.)
 *   - partial-write looping
 *   - close coordination via `onClose` callbacks
 *
 * Subclasses implement three template methods:
 *   - `doRead(buf, len) → number`
 *   - `hasPending() → boolean`  (optional, default false)
 *   - `classifyRead(n) → 'data'|'eof'|'retry-read'|'retry-write'`
 *
 * And two for writers:
 *   - `doWrite(buf, len) → number`
 *   - `classifyWrite(n) → 'ok'|'retry-write'|'retry-read'|'fatal'`
 *
 * `FdReader` / `FdWriter` are the concrete implementations for plain POSIX
 * fds (sockets, pipes, regular files) using `read(2)` / `write(2)`.
 *
 * `boats:tls` provides `TlsReader` / `TlsWriter` using `SSL_read` / `SSL_write`.
 *
 *
 * ## How non-blocking I/O works here
 *
 * The fd must be set to non-blocking mode (O_NONBLOCK) before passing it to
 * Reader or Writer. When `doRead()` returns a negative value, `classifyRead()`
 * returns `'retry-read'` and the loop awaits `loop.readable()`. This is the
 * "wait then read" pattern. TLS subclasses additionally call `hasPending()`
 * first — if OpenSSL has buffered decrypted data, they skip the wait entirely.
 *
 *
 * ## Reader: async iteration
 *
 * Reader implements `[Symbol.asyncIterator]` so it can be used directly in
 * `for await` loops or passed to any function expecting an async iterable:
 *
 *   for await (const chunk of reader) { process(chunk); }
 *
 *
 * ## Writer: partial writes and backpressure
 *
 * `write(2)` on a non-blocking socket may write fewer bytes than requested.
 * Writer handles this transparently, looping until all bytes are written and
 * awaiting writability between attempts.
 *
 *
 * ## The onClose callback and fd lifetime
 *
 * Reader and Writer do not own the fd — they borrow it. The `onClose`
 * callback provided at construction time handles fd cleanup.
 *
 * This supports the split-socket pattern in `boats:socket`, where a single
 * fd is shared between an FdReader and FdWriter. The fd is only closed when
 * both halves have closed. `Socket.split()` wires up the callbacks so that:
 *   - FdReader's close calls `shutdown(fd, SHUT_RD)` (signals EOF to readers)
 *   - FdWriter's close calls `shutdown(fd, SHUT_WR)` (sends FIN to peer)
 *   - When both have closed, the fd is `close()`d
 *
 *
 * ## Contributing
 *
 * - Do not use `Writer.write()` concurrently without external synchronization.
 *   The partial-write loop uses a local `offset`, so concurrent writes interleave.
 * - Both Reader and Writer are idempotent on `close()` — safe to call multiple times.
 * - When adding a new I/O backend, extend Reader/Writer and implement the template
 *   methods. No changes to the base classes are needed.
 */

import { dlopen, Pointer } from 'boats:ffi';
import { os } from 'internal:process';
import * as loop from 'boats:runtime/loop';
import type { LoopHandle } from 'boats:runtime/loop';

type ReadClassification  = 'data' | 'eof' | 'retry-read' | 'retry-write';
type WriteClassification = 'ok'   | 'retry-write' | 'retry-read' | 'fatal';

const LIBC    = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = os === 'darwin' ? '__error' : '__errno_location';
const EAGAIN  = os === 'darwin' ? 35 : 11;

const lib = dlopen(LIBC, {
  read:      { parameters: ['i32', 'buffer', 'usize'], result: 'isize'   },
  write:     { parameters: ['i32', 'buffer', 'usize'], result: 'isize'   },
  [errnoFn]: { parameters: [],                         result: 'pointer' },
});

/** Read the current thread-local errno value. */
function getErrno(): number {
  return Pointer.readI32(lib.symbols[errnoFn](), 0);
}

// ---------------------------------------------------------------------------
// Base Reader
// ---------------------------------------------------------------------------

/**
 * Abstract base class for the read half of a split I/O resource.
 *
 * Implements the async iterator protocol and all retry/backpressure logic.
 * Subclasses implement `doRead()`, `classifyRead()`, and optionally `hasPending()`.
 *
 * @example
 * const [reader, writer] = socket.split();
 * for await (const chunk of reader) { ... }
 */
export class Reader {
  #fd: number;
  #lp: LoopHandle;
  #onClose: () => void;
  #closed: boolean;

  constructor(fd: number, lp: LoopHandle, onClose: () => void) {
    this.#fd = fd;
    this.#lp = lp;
    this.#onClose = onClose;
    this.#closed = false;
  }

  /** Raw file descriptor. Available to subclasses for their doRead implementations. */
  get fd() { return this.#fd; }

  /** Loop handle. Available to subclasses that need to wait on alternative directions. */
  get lp() { return this.#lp; }

  get closed() { return this.#closed; }

  // ---------------------------------------------------------------------------
  // Template methods — subclasses implement these
  // ---------------------------------------------------------------------------

  /**
   * Perform the actual read syscall or library call.
   * @param {ArrayBuffer} buf — pre-allocated buffer of `len` bytes
   * @param {number} len
   * @returns {number} bytes read (>0), EOF indicator (0), or error (<0)
   */
  doRead(buf: ArrayBuffer, len: number): number { throw new Error('Reader.doRead not implemented'); }

  /**
   * Return true if there are buffered bytes available without waiting for fd
   * readability. Default returns false (correct for plain fds). SSL subclasses
   * override to call SSL_pending().
   */
  hasPending(): boolean { return false; }

  /**
   * Classify the return value of doRead() into an action for the read loop.
   * @param n — return value from doRead()
   */
  classifyRead(n: number): ReadClassification { throw new Error('Reader.classifyRead not implemented'); }

  // ---------------------------------------------------------------------------
  // Generic read loop
  // ---------------------------------------------------------------------------

  /**
   * Read the next available chunk. Awaits readability (unless hasPending()),
   * calls doRead(), and retries as directed by classifyRead().
   *
   * @param {number} [maxBytes=65536]
   * @returns {Promise<Uint8Array|null>} data chunk, or null on EOF / close
   */
  async read(maxBytes: number = 65536): Promise<Uint8Array | null> {
    while (true) {
      if (this.#closed) return null;
      if (!this.hasPending()) {
        await loop.readable(this.#lp, this.#fd);
        if (this.#closed) return null;
      }
      const buf = new ArrayBuffer(maxBytes);
      const n = this.doRead(buf, maxBytes);
      const action = this.classifyRead(n);
      if (action === 'data') return new Uint8Array(buf, 0, n);
      if (action === 'eof') return null;
      if (action === 'retry-read') continue;
      if (action === 'retry-write') {
        await loop.writable(this.#lp, this.#fd);
        continue;
      }
      return null;
    }
  }

  /**
   * Close this read half. Invokes the onClose callback. Idempotent.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
  }

  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        const chunk = await this.read();
        if (chunk === null) return { done: true, value: undefined };
        return { done: false, value: chunk };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Base Writer
// ---------------------------------------------------------------------------

/**
 * Abstract base class for the write half of a split I/O resource.
 *
 * Handles partial writes and backpressure. Subclasses implement `doWrite()`
 * and `classifyWrite()`.
 *
 * @example
 * const [reader, writer] = socket.split();
 * await writer.write(encodeUtf8('hello'));
 * await writer.pipe(response.body);
 * writer.close();
 */
export class Writer {
  #fd: number;
  #lp: LoopHandle;
  #onClose: () => void;
  #closed: boolean;

  constructor(fd: number, lp: LoopHandle, onClose: () => void) {
    this.#fd = fd;
    this.#lp = lp;
    this.#onClose = onClose;
    this.#closed = false;
  }

  /** Raw file descriptor. Available to subclasses for their doWrite implementations. */
  get fd() { return this.#fd; }

  /** Loop handle. Available to subclasses that need to wait on alternative directions. */
  get lp() { return this.#lp; }

  get closed() { return this.#closed; }

  // ---------------------------------------------------------------------------
  // Template methods — subclasses implement these
  // ---------------------------------------------------------------------------

  /**
   * Perform the actual write syscall or library call.
   * @param {Uint8Array} buf — slice of the data to write (respects byteOffset)
   * @param {number} len
   * @returns {number} bytes written (>0), or error (<=0)
   */
  doWrite(buf: Uint8Array, len: number): number { throw new Error('Writer.doWrite not implemented'); }

  /**
   * Classify the return value of doWrite() into an action for the write loop.
   * @param n — return value from doWrite()
   */
  classifyWrite(n: number): WriteClassification { throw new Error('Writer.classifyWrite not implemented'); }

  // ---------------------------------------------------------------------------
  // Generic write loop
  // ---------------------------------------------------------------------------

  /**
   * Write data, handling partial writes and kernel-buffer backpressure.
   *
   * @param {Uint8Array|ArrayBuffer} data
   * @returns {Promise<number>} total bytes written (always equals data.byteLength)
   */
  async write(data: Uint8Array | ArrayBuffer): Promise<number> {
    if (this.#closed) throw new Error('Writer is closed');
    const arr = data instanceof Uint8Array ? data : new Uint8Array(data);
    let offset = 0;
    while (offset < arr.byteLength) {
      const chunk = arr.subarray(offset);
      const n = this.doWrite(chunk, chunk.byteLength);
      const action = this.classifyWrite(n);
      if (action === 'ok') {
        offset += n;
        continue;
      }
      if (action === 'retry-write') {
        await loop.writable(this.#lp, this.#fd);
        if (this.#closed) throw new Error('Writer closed during write');
        continue;
      }
      if (action === 'retry-read') {
        await loop.readable(this.#lp, this.#fd);
        if (this.#closed) throw new Error('Writer closed during write');
        continue;
      }
      throw new Error('write failed');
    }
    return arr.byteLength;
  }

  /**
   * Consume an async iterable and write each chunk to the fd in order.
   *
   * @param {AsyncIterable<Uint8Array|ArrayBuffer>} iterable
   */
  async pipe(iterable: AsyncIterable<Uint8Array | ArrayBuffer>): Promise<void> {
    for await (const chunk of iterable) {
      await this.write(chunk);
    }
  }

  /**
   * Close this write half. Invokes the onClose callback. Idempotent.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
  }
}

// ---------------------------------------------------------------------------
// FdReader / FdWriter — plain POSIX fd I/O via libc read(2) / write(2)
// ---------------------------------------------------------------------------

/**
 * Reader implementation for plain POSIX file descriptors (sockets, pipes, files).
 * Uses `read(2)` from libc. On non-blocking fds, any negative return means
 * EAGAIN — the loop awaits readability and retries.
 */
export class FdReader extends Reader {
  doRead(buf: ArrayBuffer, len: number): number {
    return Number(lib.symbols.read(this.fd, buf, len));
  }

  // hasPending() inherited from Reader — returns false (correct for plain fds)

  classifyRead(n: number): ReadClassification {
    if (n > 0) return 'data';
    if (n === 0) return 'eof';
    if (getErrno() === EAGAIN) return 'retry-read';
    return 'eof'; // ECONNRESET or other fatal error — treat as EOF
  }
}

/**
 * Writer implementation for plain POSIX file descriptors (sockets, pipes, files).
 * Uses `write(2)` from libc. On non-blocking fds, any negative return means
 * EAGAIN — the loop awaits writability and retries.
 */
export class FdWriter extends Writer {
  doWrite(buf: Uint8Array, len: number): number {
    return Number(lib.symbols.write(this.fd, buf, len));
  }

  classifyWrite(n: number): WriteClassification {
    if (n > 0) return 'ok';
    if (n < 0 && getErrno() === EAGAIN) return 'retry-write';
    return 'fatal'; // EPIPE, ECONNRESET, or other non-retryable error
  }
}
