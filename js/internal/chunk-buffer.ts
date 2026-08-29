/**
 * internal:chunk-buffer — bounded asynchronous byte-chunk buffering.
 *
 * `ChunkBuffer` is the byte-specific companion to `AsyncChannel`. It owns
 * byte slicing, coalescing, copy-versus-retain semantics, byte-weighted
 * backpressure, abortable reads and writes, and terminal cleanup. Protocols
 * retain responsibility for flow-control errors, window updates, framing, and
 * other policy.
 *
 * Writes copy their input by default, so callers may reuse or mutate the source
 * as soon as `write()` returns. Passing `{ owned: true }` retains the supplied
 * byte view instead and is only safe when the caller will never mutate it
 * again. Reads may return a view into that private or caller-owned chunk when
 * no coalescing is needed; combining multiple chunks allocates one result.
 *
 * A graceful `close()` rejects writes not yet admitted and lets buffered bytes
 * drain before reads return `null`. `fail(reason)` discards buffered bytes and
 * rejects immediately. Async-iterator `return()` cancels the buffer, releases
 * retained bytes, and settles blocked operations. Terminal calls are
 * idempotent and the first one wins.
 *
 * ```ts no_run
 * import { ChunkBuffer } from 'internal:chunk-buffer';
 *
 * const chunks = new ChunkBuffer({ maxBufferedBytes: 64 * 1024 });
 * await chunks.write(new Uint8Array([1, 2, 3, 4]));
 * console.log(await chunks.read(2)); // Uint8Array [1, 2]
 * chunks.close();
 * console.log(await chunks.read(2)); // Uint8Array [3, 4]
 * console.log(await chunks.read(2)); // null
 * ```
 *
 * @internal
 */
import { asByteView, copyBytes } from 'internal:bytes';

/** Construction options for a `ChunkBuffer`. @internal */
export interface ChunkBufferOptions {
  /**
   * Maximum bytes admitted to the internal chunk queue.
   *
   * Defaults to `Infinity`. A finite bound must be a positive safe integer;
   * individual writes larger than it are rejected rather than permanently
   * blocking the producer.
   */
  maxBufferedBytes?: number;
  /** Maximum chunk size yielded by async iteration. Defaults to 64 KiB. */
  iterationChunkBytes?: number;
}

/** Options controlling one `ChunkBuffer.write()` call. @internal */
export interface ChunkWriteOptions {
  /** Abort a write that is waiting for buffer capacity. */
  signal?: AbortSignal | null;
  /**
   * Retain the input view instead of copying it.
   *
   * The caller must not mutate or reuse the bytes after setting this flag.
   */
  owned?: boolean;
}

/** Options controlling one `ChunkBuffer.read()` call. @internal */
export interface ChunkReadOptions {
  /** Abort a read that is waiting for bytes. */
  signal?: AbortSignal | null;
}

/** Error used when buffer shutdown prevents a producer from writing. @internal */
export class ChunkBufferClosedError extends Error {
  /** Stable error name for buffer shutdown failures. @internal */
  override name = 'ChunkBufferClosedError';

  /** Create a buffer-closed error with an optional diagnostic message. @internal */
  constructor(message = 'ChunkBuffer is closed') {
    super(message);
  }
}

interface WriteWaiter {
  bytes: Uint8Array;
  offset: number;
  resolve(): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

interface ReadWaiter {
  maxBytes: number;
  resolve(value: Uint8Array | null): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

type BufferState = 'open' | 'closed' | 'failed' | 'cancelled';

/**
 * A FIFO asynchronous byte buffer with bounded admitted storage.
 *
 * `write()` resolves when all bytes have either reached waiting readers or
 * entered the bounded queue. An oversized or capacity-blocked write may be
 * delivered incrementally to reads before its promise resolves; aborting such
 * a write drops only the still-pending suffix. `tryWrite()` is atomic and
 * returns `false` unless the complete chunk can be accepted immediately.
 *
 * @internal
 */
export class ChunkBuffer implements AsyncIterableIterator<Uint8Array> {
  readonly #maxBufferedBytes: number;
  readonly #iterationChunkBytes: number;
  readonly #chunks: Uint8Array[] = [];
  #chunkIndex = 0;
  #chunkOffset = 0;
  #bufferedBytes = 0;
  readonly #writeWaiters: WriteWaiter[] = [];
  readonly #readWaiters: ReadWaiter[] = [];
  #state: BufferState = 'open';
  #failure: unknown;
  readonly #closedError = new ChunkBufferClosedError();

  /** Create an empty chunk buffer with an optional byte bound. */
  constructor(options: ChunkBufferOptions = {}) {
    const maxBufferedBytes = options.maxBufferedBytes ?? Infinity;
    if (
      maxBufferedBytes !== Infinity &&
      (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1)
    ) {
      throw new RangeError(
        'ChunkBuffer maxBufferedBytes must be a positive safe integer or Infinity',
      );
    }
    const iterationChunkBytes = options.iterationChunkBytes ?? 65536;
    if (!Number.isSafeInteger(iterationChunkBytes) || iterationChunkBytes < 1) {
      throw new RangeError('ChunkBuffer iterationChunkBytes must be a positive safe integer');
    }
    this.#maxBufferedBytes = maxBufferedBytes;
    this.#iterationChunkBytes = iterationChunkBytes;
  }

  /** Maximum bytes that may wait in the admitted chunk queue. */
  get maxBufferedBytes(): number {
    return this.#maxBufferedBytes;
  }

  /** Number of admitted unread bytes. Pending producer bytes are excluded. */
  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  /** Whether a terminal operation has stopped new writes. */
  get closed(): boolean {
    return this.#state !== 'open';
  }

  /**
   * Write bytes, waiting for bounded capacity when necessary.
   *
   * Input is copied immediately unless `owned` is true. Empty writes resolve
   * without consuming capacity. Finite buffers reject any single chunk larger
   * than `maxBufferedBytes`.
   */
  write(input: ArrayBuffer | ArrayBufferView, options: ChunkWriteOptions = {}): Promise<void> {
    if (this.#state !== 'open') return Promise.reject(this.#writeError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const view = asByteView(input);
    this.#validateChunkLength(view.byteLength);
    if (view.byteLength === 0) return Promise.resolve();
    const bytes = options.owned === true ? view : copyBytes(view);
    if (this.#writeWaiters.length === 0 && this.#canAcceptImmediately(bytes.byteLength)) {
      this.#acceptImmediate(bytes);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let cleanup = () => {};
      const waiter: WriteWaiter = {
        bytes,
        offset: 0,
        resolve,
        reject,
        cleanup: () => cleanup(),
      };
      const onAbort = () => {
        const index = this.#writeWaiters.indexOf(waiter);
        if (index < 0) return;
        this.#writeWaiters.splice(index, 1);
        cleanup();
        reject(options.signal!.reason);
        this.#drain();
      };
      if (options.signal !== undefined && options.signal !== null) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => options.signal!.removeEventListener('abort', onAbort);
      }
      this.#writeWaiters.push(waiter);
      this.#drain();
    });
  }

  /**
   * Attempt to write a complete chunk without waiting.
   *
   * Returns `false` on terminal state, when an earlier producer is blocked, or
   * when waiting readers plus available capacity cannot accept the whole chunk.
   */
  tryWrite(input: ArrayBuffer | ArrayBufferView, options: { owned?: boolean } = {}): boolean {
    if (this.#state !== 'open' || this.#writeWaiters.length > 0) return false;
    const view = asByteView(input);
    this.#validateChunkLength(view.byteLength);
    if (view.byteLength === 0) return true;
    if (!this.#canAcceptImmediately(view.byteLength)) return false;
    this.#acceptImmediate(options.owned === true ? view : copyBytes(view));
    return true;
  }

  /**
   * Read up to `maxBytes`, coalescing adjacent chunks when useful.
   *
   * A zero-byte read resolves with an empty array without consuming input.
   * Graceful close returns `null` after buffered bytes drain; failure rejects.
   */
  read(maxBytes = 65536, options: ChunkReadOptions = {}): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('ChunkBuffer read size must be a non-negative safe integer');
    }
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (maxBytes === 0) return Promise.resolve(new Uint8Array(0));
    const bytes = this.#take(maxBytes);
    if (bytes !== null) {
      this.#drain();
      return Promise.resolve(bytes);
    }
    if (this.#state === 'failed') return Promise.reject(this.#failure);
    if (this.#state !== 'open') return Promise.resolve(null);
    return new Promise<Uint8Array | null>((resolve, reject) => {
      let cleanup = () => {};
      const waiter: ReadWaiter = {
        maxBytes,
        resolve,
        reject,
        cleanup: () => cleanup(),
      };
      const onAbort = () => {
        const index = this.#readWaiters.indexOf(waiter);
        if (index < 0) return;
        this.#readWaiters.splice(index, 1);
        cleanup();
        reject(options.signal!.reason);
      };
      if (options.signal !== undefined && options.signal !== null) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => options.signal!.removeEventListener('abort', onAbort);
      }
      this.#readWaiters.push(waiter);
      this.#drain();
    });
  }

  /** Stop new writes and return EOF after admitted bytes drain. */
  close(): void {
    if (this.#state !== 'open') return;
    this.#state = 'closed';
    this.#rejectWriters(this.#closedError);
    this.#drain();
  }

  /** Discard retained bytes and reject pending and future reads with `reason`. */
  fail(reason: unknown): void {
    if (this.#state !== 'open') return;
    this.#state = 'failed';
    this.#failure = reason;
    this.#clearChunks();
    this.#rejectWriters(reason);
    const readers = this.#readWaiters.splice(0);
    for (const reader of readers) {
      reader.cleanup();
      reader.reject(reason);
    }
  }

  /** Read the next iterator-sized chunk. */
  async next(): Promise<IteratorResult<Uint8Array>> {
    const value = await this.read(this.#iterationChunkBytes);
    return value === null ? { done: true, value: undefined as Uint8Array } : { done: false, value };
  }

  /** Cancel consumption, release bytes, and settle blocked operations. */
  return(): Promise<IteratorResult<Uint8Array>> {
    if (this.#state === 'open') {
      this.#state = 'cancelled';
      this.#clearChunks();
      this.#rejectWriters(this.#closedError);
      this.#finishReaders();
    }
    return Promise.resolve({ done: true, value: undefined as Uint8Array });
  }

  /** Return this Realm-local buffer as its single async iterator. */
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }

  #validateChunkLength(length: number): void {
    if (length > this.#maxBufferedBytes) {
      throw new RangeError(
        `ChunkBuffer chunk is ${length} bytes; maximum is ${this.#maxBufferedBytes}`,
      );
    }
  }

  #canAcceptImmediately(length: number): boolean {
    let directBytes = 0;
    for (const reader of this.#readWaiters) {
      directBytes = Math.min(length, directBytes + reader.maxBytes);
      if (directBytes >= length) return true;
    }
    return length - directBytes <= this.#maxBufferedBytes - this.#bufferedBytes;
  }

  #acceptImmediate(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength && this.#readWaiters.length > 0) {
      const reader = this.#readWaiters.shift()!;
      const count = Math.min(reader.maxBytes, bytes.byteLength - offset);
      const value =
        offset === 0 && count === bytes.byteLength ? bytes : bytes.subarray(offset, offset + count);
      offset += count;
      reader.cleanup();
      reader.resolve(value);
    }
    if (offset < bytes.byteLength) {
      this.#append(offset === 0 ? bytes : bytes.subarray(offset));
    }
  }

  #append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#chunks.push(bytes);
    this.#bufferedBytes += bytes.byteLength;
  }

  #take(maxBytes: number): Uint8Array | null {
    if (this.#bufferedBytes === 0) return null;
    const outputLength = Math.min(maxBytes, this.#bufferedBytes);
    const first = this.#chunks[this.#chunkIndex]!;
    const firstRemaining = first.byteLength - this.#chunkOffset;
    if (firstRemaining >= outputLength) {
      const start = this.#chunkOffset;
      const output =
        start === 0 && outputLength === first.byteLength
          ? first
          : first.subarray(start, start + outputLength);
      this.#chunkOffset += outputLength;
      this.#bufferedBytes -= outputLength;
      if (this.#chunkOffset === first.byteLength) this.#advanceChunk();
      return output;
    }
    const output = new Uint8Array(outputLength);
    let written = 0;
    while (written < outputLength) {
      const chunk = this.#chunks[this.#chunkIndex]!;
      const available = chunk.byteLength - this.#chunkOffset;
      const take = Math.min(available, outputLength - written);
      output.set(chunk.subarray(this.#chunkOffset, this.#chunkOffset + take), written);
      written += take;
      this.#chunkOffset += take;
      this.#bufferedBytes -= take;
      if (this.#chunkOffset === chunk.byteLength) this.#advanceChunk();
    }
    return output;
  }

  #advanceChunk(): void {
    this.#chunkIndex++;
    this.#chunkOffset = 0;
    if (this.#chunkIndex >= 64 && this.#chunkIndex * 2 >= this.#chunks.length) {
      this.#chunks.splice(0, this.#chunkIndex);
      this.#chunkIndex = 0;
    }
  }

  #drain(): void {
    while (this.#readWaiters.length > 0) {
      const buffered = this.#take(this.#readWaiters[0]!.maxBytes);
      if (buffered !== null) {
        const reader = this.#readWaiters.shift()!;
        reader.cleanup();
        reader.resolve(buffered);
        continue;
      }
      if (this.#state !== 'open' || this.#writeWaiters.length === 0) break;
      const writer = this.#writeWaiters[0]!;
      const reader = this.#readWaiters.shift()!;
      const remaining = writer.bytes.byteLength - writer.offset;
      const count = Math.min(reader.maxBytes, remaining);
      const value =
        writer.offset === 0 && count === writer.bytes.byteLength
          ? writer.bytes
          : writer.bytes.subarray(writer.offset, writer.offset + count);
      writer.offset += count;
      reader.cleanup();
      reader.resolve(value);
      if (writer.offset === writer.bytes.byteLength) {
        this.#writeWaiters.shift();
        writer.cleanup();
        writer.resolve();
      }
    }
    if (this.#state === 'open' && this.#readWaiters.length === 0) {
      while (this.#writeWaiters.length > 0) {
        const writer = this.#writeWaiters[0]!;
        const remaining = writer.bytes.byteLength - writer.offset;
        if (remaining > this.#maxBufferedBytes - this.#bufferedBytes) break;
        this.#writeWaiters.shift();
        this.#append(writer.offset === 0 ? writer.bytes : writer.bytes.subarray(writer.offset));
        writer.cleanup();
        writer.resolve();
      }
    }
    if (this.#state === 'closed' && this.#bufferedBytes === 0) this.#finishReaders();
  }

  #clearChunks(): void {
    this.#chunks.length = 0;
    this.#chunkIndex = 0;
    this.#chunkOffset = 0;
    this.#bufferedBytes = 0;
  }

  #rejectWriters(reason: unknown): void {
    const writers = this.#writeWaiters.splice(0);
    for (const writer of writers) {
      writer.cleanup();
      writer.reject(reason);
    }
  }

  #finishReaders(): void {
    const readers = this.#readWaiters.splice(0);
    for (const reader of readers) {
      reader.cleanup();
      reader.resolve(null);
    }
  }

  #writeError(): unknown {
    return this.#state === 'failed' ? this.#failure : this.#closedError;
  }
}
