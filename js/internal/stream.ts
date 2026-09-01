/**
 * fino:stream — channel-backed readers, writers, and byte I/O endpoints.
 *
 * Three public endpoint levels share the same delivery model:
 *
 *   Reader<T> / Writer<T>
 *     Generic async producers/consumers of any value type T. They are stable
 *     facades over state that owns ordering, back-pressure, closure, and error
 *     propagation. Reader also implements the async iterator protocol.
 *     Channel connects one Reader and Writer as a zero-capacity rendezvous:
 *     each write remains pending until one read accepts it. UnboundedChannel is
 *     the explicit producer-ahead specialization.
 *
 *   BytesReader extends Reader<Uint8Array>
 *   BytesWriter extends Writer<ArrayBuffer | ArrayBufferView>
 *     Byte specializations. BytesReader adds structural read primitives and
 *     direct reads into caller-owned views. A byte write need not correspond to
 *     one byte read: state preserves a continuous byte sequence while
 *     satisfying independently sized operations.
 *
 *   BytesChannel / BufferedBytesChannel / UnboundedBytesChannel
 *     One byte endpoint contract with different storage policies. BytesChannel
 *     is a storage-free rendezvous: reserve returns exactly the reader's
 *     readInto view. BufferedBytesChannel owns one capacity-sized segment.
 *     UnboundedBytesChannel appends capacity-sized segments as needed.
 *
 *   FdReader / FdWriter   — libc read(2) / write(2)
 *   TlsReader / TlsWriter — SSL_read / SSL_write (in fino:tls)
 *     Concrete I/O implementations extending the buffered variants. Each
 *     implements one template method (doPullInto / doFlush) with the syscall loop.
 *
 *
 * ## Transforms are external
 *
 * Channels deliver values; they do not map one type to another. Mapping,
 * filtering, framing, and decoding use ordinary async iterables. Reader.from()
 * wraps a transformed iterable when another Reader endpoint is useful.
 *
 * ## The close() contract
 *
 * Reader.close() stops new source operations immediately, invokes onClose to
 * cancel an active read, and resolves queued reads without entering the source.
 * Writer.close() stops new writes immediately, drains operations admitted before
 * close in FIFO order, flushes buffered writers, and then invokes onClose. Both
 * methods are idempotent and every caller observes the same cleanup promise.
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
 * I/O backends own their scenario-specific state and expose only the relevant
 * public endpoint. Incoming I/O exposes a Reader; outgoing I/O exposes a
 * Writer; duplex resources compose one state in each direction.
 *
 * ```ts no_run
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
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
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
const F_GETFL = 3;
const O_NONBLOCK = os === 'darwin' ? 4 : 2048;
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
interface ReaderQueueState {
  queue: ChannelSequence;
  closed: () => boolean;
}
const readerQueues = new WeakMap<object, ReaderQueueState>();
function queueReaderOperation<R>(
  reader: object,
  operation: () => Promise<R>,
  closedValue: () => R,
): Promise<R> {
  const state = readerQueues.get(reader)!;
  if (state.closed()) return Promise.resolve(closedValue());
  return state.queue.run(() => (state.closed() ? Promise.resolve(closedValue()) : operation()));
}
interface WriterQueueState {
  queue: ChannelSequence;
  closed: () => boolean;
  pending: number;
}
const writerQueues = new WeakMap<object, WriterQueueState>();
function queueWriterOperation<R>(writer: object, operation: () => Promise<R>): Promise<R> {
  const state = writerQueues.get(writer)!;
  if (state.closed()) return Promise.reject(new Error('Writer is closed'));
  state.pending++;
  return state.queue.run(operation).then(
    (value) => {
      state.pending--;
      return value;
    },
    (error) => {
      state.pending--;
      throw error;
    },
  );
}
function queueWriterClose(writer: object, operation: () => Promise<void>): Promise<void> {
  return writerQueues.get(writer)!.queue.run(operation);
}

/**
 * Channel-backed operation sequence used by subclass-defined endpoints.
 *
 * State-backed endpoints put ordering in their state directly. Subclass-defined
 * endpoints feed their operations through a rendezvous channel so they retain
 * the same ordering contract without a parallel queue implementation.
 */
class ChannelSequence {
  #channel = new Channel<() => Promise<void>>();
  constructor() {
    void this.#consume();
  }
  run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const accepted = this.#channel.writer.write(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error);
        }
      });
      void accepted.catch(reject);
    });
  }
  async #consume(): Promise<void> {
    for await (const operation of this.#channel.reader) await operation();
  }
}
/** Internal state consumed by the public `Reader` facade. */
export interface ReadableState<T, Options = void> {
  read(options?: Options): Promise<T | null>;
  closeReader(): void | Promise<void>;
}
/** Internal state consumed by the public `Writer` facade. */
export interface WritableState<T> {
  write(value: T): Promise<void>;
  flush(): Promise<void>;
  closeWriter(): Promise<void>;
  fail(error: unknown): void;
}
/** Internal byte-readable state used by `BytesReader`. */
export interface BytesReadableState extends ReadableState<Uint8Array, number | BytesReadOptions> {
  readInto(
    buffer: ArrayBufferView,
    options?: Omit<BytesReadOptions, 'maxBytes'>,
  ): Promise<number | null>;
}
/** Internal byte-writable state with direct writable-region acquisition. */
export interface BytesWritableState extends WritableState<ArrayBuffer | ArrayBufferView> {
  reserve(): Promise<Uint8Array>;
  commit(bytesWritten: number): void;
}

interface ByteReadRequest {
  buffer: Uint8Array;
  view: boolean;
  resolve(value: Uint8Array | number | null): void;
  reject(error: unknown): void;
}

/**
 * Zero-capacity byte rendezvous used between a byte producer and consumer.
 *
 * `readInto()` supplies the storage. `reserve()` waits for the oldest read and
 * returns that exact region to the producer; `commit()` publishes its filled
 * prefix. The state never allocates or retains a byte buffer of its own.
 *
 * @internal
 */
export class BytesChannelState implements BytesReadableState, BytesWritableState {
  #reads: ByteReadRequest[] = [];
  #reserves: Array<{
    resolve(buffer: Uint8Array): void;
    reject(error: unknown): void;
  }> = [];
  #active: ByteReadRequest | null = null;
  #readerClosed = false;
  #writerClosed = false;
  #error: unknown = null;

  read(options?: number | BytesReadOptions): Promise<Uint8Array | null> {
    const maxBytes = normalizeReadOptions(options).maxBytes ?? 65536;
    if (maxBytes === 0) return Promise.resolve(new Uint8Array(0));
    const buffer = new Uint8Array(maxBytes);
    return new Promise((resolve, reject) => {
      this.#enqueue({
        buffer,
        view: true,
        resolve: (value) => resolve(value as Uint8Array | null),
        reject,
      });
    });
  }

  readInto(buffer: ArrayBufferView): Promise<number | null> {
    if (!ArrayBuffer.isView(buffer))
      return Promise.reject(new TypeError('readInto buffer must be a view'));
    const destination = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (destination.byteLength === 0) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      this.#enqueue({
        buffer: destination,
        view: false,
        resolve: (value) => resolve(value as number | null),
        reject,
      });
    });
  }

  #enqueue(request: ByteReadRequest): void {
    if (this.#error !== null) return request.reject(this.#error);
    if (this.#readerClosed || this.#writerClosed) return request.resolve(null);
    this.#reads.push(request);
    this.#pump();
  }

  reserve(): Promise<Uint8Array> {
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#readerClosed) return Promise.reject(new Error('Reader is closed'));
    if (this.#writerClosed) return Promise.reject(new Error('Writer is closed'));
    return new Promise((resolve, reject) => {
      this.#reserves.push({ resolve, reject });
      this.#pump();
    });
  }

  commit(bytesWritten: number): void {
    const request = this.#active;
    if (request === null) throw new Error('No active byte reservation');
    bytesWritten = normalizeMaxBytes(bytesWritten, 'bytesWritten');
    if (bytesWritten > request.buffer.byteLength)
      throw new RangeError('commit exceeds reserved capacity');
    this.#active = null;
    request.resolve(request.view ? request.buffer.subarray(0, bytesWritten) : bytesWritten);
    this.#pump();
  }

  #pump(): void {
    if (this.#active !== null) return;
    const read = this.#reads.shift();
    const reserve = this.#reserves.shift();
    if (read === undefined || reserve === undefined) {
      if (read !== undefined) this.#reads.unshift(read);
      if (reserve !== undefined) this.#reserves.unshift(reserve);
      return;
    }
    this.#active = read;
    reserve.resolve(read.buffer);
  }

  async write(value: ArrayBuffer | ArrayBufferView): Promise<void> {
    const source = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    let offset = 0;
    while (offset < source.byteLength) {
      const region = await this.reserve();
      const n = Math.min(region.byteLength, source.byteLength - offset);
      region.set(source.subarray(offset, offset + n));
      this.commit(n);
      offset += n;
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  closeReader(): void {
    if (this.#readerClosed) return;
    this.#readerClosed = true;
    const error = new Error('Reader is closed');
    for (const request of this.#reads.splice(0)) request.resolve(null);
    for (const reserve of this.#reserves.splice(0)) reserve.reject(error);
    if (this.#active !== null) {
      this.#active.reject(error);
      this.#active = null;
    }
  }

  closeWriter(): Promise<void> {
    if (this.#writerClosed) return Promise.resolve();
    this.#writerClosed = true;
    const error = new Error('Writer is closed');
    for (const reserve of this.#reserves.splice(0)) reserve.reject(error);
    if (this.#active === null) {
      for (const request of this.#reads.splice(0)) request.resolve(null);
    }
    return Promise.resolve();
  }

  fail(error: unknown): void {
    if (this.#error !== null) return;
    this.#error = error;
    for (const request of this.#reads.splice(0)) request.reject(error);
    for (const reserve of this.#reserves.splice(0)) reserve.reject(error);
    if (this.#active !== null) {
      this.#active.reject(error);
      this.#active = null;
    }
  }
}

interface ByteSegment {
  buffer: Uint8Array;
  committed: number;
  offset: number;
}

/** Byte-buffered channel state with capacity measured in bytes. @internal */
export class BufferedBytesChannelState implements BytesReadableState, BytesWritableState {
  protected readonly capacity: number;
  protected readonly growable: boolean;
  #available: ByteSegment[] = [];
  #committed: ByteSegment[] = [];
  #reads: ByteReadRequest[] = [];
  #reserves: Array<{ resolve(buffer: Uint8Array): void; reject(error: unknown): void }> = [];
  #reservation: ByteSegment | null = null;
  #lease: ByteSegment | null = null;
  #readerClosed = false;
  #writerClosed = false;
  #error: unknown = null;

  constructor(capacity: number = 65536, options: { growable?: boolean } = {}) {
    capacity = normalizeMaxBytes(capacity, 'capacity');
    if (capacity === 0) throw new RangeError('capacity must be greater than zero');
    this.capacity = capacity;
    this.growable = options.growable ?? false;
    if (!this.growable) this.#available.push(this.#allocate());
  }

  #allocate(): ByteSegment {
    return { buffer: new Uint8Array(this.capacity), committed: 0, offset: 0 };
  }

  #releaseLease(): void {
    const segment = this.#lease;
    if (segment === null) return;
    this.#lease = null;
    if (segment.offset === segment.committed) this.#recycle(segment);
  }

  #recycle(segment: ByteSegment): void {
    segment.committed = 0;
    segment.offset = 0;
    if (!this.growable) this.#available.push(segment);
    this.#pumpReserves();
  }

  read(options?: number | BytesReadOptions): Promise<Uint8Array | null> {
    this.#releaseLease();
    const maxBytes = normalizeReadOptions(options).maxBytes ?? 65536;
    if (maxBytes === 0) return Promise.resolve(new Uint8Array(0));
    return new Promise((resolve, reject) => {
      this.#reads.push({
        buffer: new Uint8Array(maxBytes),
        view: true,
        resolve: (value) => resolve(value as Uint8Array | null),
        reject,
      });
      this.#pumpReads();
    });
  }

  readInto(buffer: ArrayBufferView): Promise<number | null> {
    this.#releaseLease();
    if (!ArrayBuffer.isView(buffer))
      return Promise.reject(new TypeError('readInto buffer must be a view'));
    const destination = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (destination.byteLength === 0) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      this.#reads.push({
        buffer: destination,
        view: false,
        resolve: (value) => resolve(value as number | null),
        reject,
      });
      this.#pumpReads();
    });
  }

  reserve(): Promise<Uint8Array> {
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#readerClosed) return Promise.reject(new Error('Reader is closed'));
    if (this.#writerClosed) return Promise.reject(new Error('Writer is closed'));
    return new Promise((resolve, reject) => {
      this.#reserves.push({ resolve, reject });
      this.#pumpReserves();
    });
  }

  #pumpReserves(): void {
    if (this.#reservation !== null || this.#reserves.length === 0) return;
    const segment = this.growable ? this.#allocate() : this.#available.shift();
    if (segment === undefined) return;
    this.#reservation = segment;
    this.#reserves.shift()!.resolve(segment.buffer);
  }

  commit(bytesWritten: number): void {
    const segment = this.#reservation;
    if (segment === null) throw new Error('No active byte reservation');
    bytesWritten = normalizeMaxBytes(bytesWritten, 'bytesWritten');
    if (bytesWritten > segment.buffer.byteLength)
      throw new RangeError('commit exceeds reserved capacity');
    this.#reservation = null;
    if (bytesWritten === 0) this.#recycle(segment);
    else {
      segment.committed = bytesWritten;
      this.#committed.push(segment);
      this.#pumpReads();
    }
    this.#pumpReserves();
  }

  #pumpReads(): void {
    while (this.#reads.length > 0 && this.#committed.length > 0) {
      const request = this.#reads.shift()!;
      if (request.view) {
        const segment = this.#committed[0]!;
        const n = Math.min(request.buffer.byteLength, segment.committed - segment.offset);
        const result = segment.buffer.subarray(segment.offset, segment.offset + n);
        segment.offset += n;
        if (segment.offset === segment.committed) this.#committed.shift();
        this.#lease = segment;
        request.resolve(result);
        continue;
      }
      let written = 0;
      while (written < request.buffer.byteLength && this.#committed.length > 0) {
        const segment = this.#committed[0]!;
        const n = Math.min(request.buffer.byteLength - written, segment.committed - segment.offset);
        request.buffer.set(segment.buffer.subarray(segment.offset, segment.offset + n), written);
        written += n;
        segment.offset += n;
        if (segment.offset === segment.committed) {
          this.#committed.shift();
          this.#recycle(segment);
        }
      }
      request.resolve(written);
    }
    if (this.#writerClosed && this.#reservation === null && this.#committed.length === 0) {
      for (const request of this.#reads.splice(0)) request.resolve(null);
    }
  }

  async write(value: ArrayBuffer | ArrayBufferView): Promise<void> {
    const source = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    let offset = 0;
    while (offset < source.byteLength) {
      const region = await this.reserve();
      const n = Math.min(region.byteLength, source.byteLength - offset);
      region.set(source.subarray(offset, offset + n));
      this.commit(n);
      offset += n;
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  closeReader(): void {
    if (this.#readerClosed) return;
    this.#readerClosed = true;
    this.#releaseLease();
    const error = new Error('Reader is closed');
    for (const request of this.#reads.splice(0)) request.resolve(null);
    for (const reserve of this.#reserves.splice(0)) reserve.reject(error);
    if (this.#reservation !== null) {
      const segment = this.#reservation;
      this.#reservation = null;
      this.#recycle(segment);
    }
  }

  closeWriter(): Promise<void> {
    if (this.#writerClosed) return Promise.resolve();
    this.#writerClosed = true;
    for (const reserve of this.#reserves.splice(0)) reserve.reject(new Error('Writer is closed'));
    if (this.#reservation !== null) {
      const segment = this.#reservation;
      this.#reservation = null;
      this.#recycle(segment);
    }
    this.#pumpReads();
    return Promise.resolve();
  }

  fail(error: unknown): void {
    if (this.#error !== null) return;
    this.#error = error;
    for (const request of this.#reads.splice(0)) request.reject(error);
    for (const reserve of this.#reserves.splice(0)) reserve.reject(error);
  }
}

/** Producer-ahead buffered byte state backed by capacity-sized segments. @internal */
export class UnboundedBytesChannelState extends BufferedBytesChannelState {
  constructor(capacity: number = 65536) {
    super(capacity, { growable: true });
  }
}
/**
 * Pull endpoint for an asynchronous value source.
 *
 * Reader delegates delivery, ordering, and closure to shared state and exposes
 * the async iterator protocol. `Reader.from()` adapts an async iterable without
 * adding transformation semantics to channels.
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
export class Reader<T, Options = void> implements AsyncIterator<T> {
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
  #closePromise: Promise<void> | null = null;
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
  #state: ReadableState<T, Options> | null;
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
  constructor(stateOrClose: ReadableState<T, Options> | ReaderCloseCallback = () => {}) {
    this.#state = typeof stateOrClose === 'function' ? null : stateOrClose;
    this.#onClose =
      typeof stateOrClose === 'function' ? stateOrClose : () => stateOrClose.closeReader();
    if (this.#state === null)
      readerQueues.set(this, { queue: new ChannelSequence(), closed: () => this.#closed });
  }
  /** Wrap an async iterable in the standard pull-based reader facade. */
  static from<T>(source: AsyncIterable<T>): Reader<T> {
    const iterator = source[Symbol.asyncIterator]();
    return new Reader<T>({
      async read() {
        const result = await iterator.next();
        return result.done ? null : result.value;
      },
      async closeReader() {
        await iterator.return?.();
      },
    });
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
   * Pull the next value from the state. `null` signals EOF.
   *
   * ```js
   * import { Reader } from 'fino:stream';
   * class EmptyReader extends Reader { async read() { return null; } }
   * console.log(await new EmptyReader().read());
   * ```
   *
   * @returns The next value, or `null` on EOF.
   */
  read(options?: Options): Promise<T | null> {
    if (this.#closed) return Promise.resolve(null);
    if (this.#state === null) return Promise.reject(new Error('Reader has no channel state'));
    return this.#state.read(options);
  }
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
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    try {
      this.#closePromise = Promise.resolve(this.#onClose());
    } catch (error) {
      this.#closePromise = Promise.reject(error);
    }
    return this.#closePromise;
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
 * Subclasses implement `doReadInto(buffer, options)` and fill caller-provided
 * storage, returning the number of bytes written or `null` on EOF.
 * `readExactly()`, `readUntil()`, and `readByte()` are
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
 *   async doReadInto(buffer) {
 *     if (this.data.byteLength === 0) return null;
 *     const n = Math.min(buffer.byteLength, this.data.byteLength);
 *     buffer.set(this.data.subarray(0, n));
 *     this.data = this.data.subarray(n);
 *     return n;
 *   }
 * }
 * console.log(await new MemoryReader().readByte());
 * ```
 */
export class BytesReader extends Reader<Uint8Array> {
  // Bytes stashed by readExactly/readUntil on EOF before their condition was
  // met. Returned on the next read call so no data is lost. BufferedBytesReader
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
  #byteState: BytesReadableState | null;
  constructor(stateOrClose: BytesReadableState | ReaderCloseCallback = () => {}) {
    super(typeof stateOrClose === 'function' ? stateOrClose : () => stateOrClose.closeReader());
    this.#byteState = typeof stateOrClose === 'function' ? null : stateOrClose;
  }
  /**
   * Read bytes from the underlying source.
   *
   * Implementations fill at most `buffer.byteLength` bytes, may fill fewer, and
   * return the number written or `null` on EOF. Backends should avoid returning
   * zero when possible because structural helpers may need to retry.
   *
   * ```js
   * import { BytesReader } from 'fino:stream';
   * class EmptyBytes extends BytesReader {
   *   async doReadInto(_buffer) { return null; }
   * }
   * console.log(await new EmptyBytes().read());
   * ```
   *
   * @param buffer Destination storage supplied by the caller.
   * @returns Number of bytes written, or `null` on EOF.
   */
  protected async doReadInto(
    buffer: Uint8Array,
    options?: BytesReadOptions,
  ): Promise<number | null> {
    if (this.#byteState !== null) return this.#byteState.readInto(buffer, options);
    throw new Error('BytesReader has no byte state');
  }
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
  // Internal: drain the stash before calling doReadInto. Used by all structural
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
  async #fetchInto(buffer: Uint8Array, options?: BytesReadOptions): Promise<number | null> {
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.#stash !== null) {
      const s = this.#stash;
      const n = Math.min(s.byteLength, buffer.byteLength);
      buffer.set(s.subarray(0, n));
      if (n === s.byteLength) {
        this.#stash = null;
      } else {
        this.#stash = s.subarray(n);
      }
      return n;
    }
    return this.doReadInto(buffer, options);
  }
  async #fetch(maxBytes: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
    const buffer = new Uint8Array(maxBytes);
    const n = await this.#fetchInto(buffer, options);
    if (n === null) return null;
    if (n < 0 || n > buffer.byteLength) throw new RangeError('doReadInto returned invalid length');
    return buffer.subarray(0, n);
  }
  /**
   * Read one byte chunk.
   *
   * The default request size is 64 KiB, but subclasses may return fewer bytes.
   * Any bytes stashed by an earlier partial structural read are returned before
   * the underlying `doReadInto()` hook is called. `null` means EOF.
   *
   * ```js
   * import { BytesReader } from 'fino:stream';
   * class EmptyBytes extends BytesReader {
   *   async doReadInto(_buffer) { return null; }
   * }
   * console.log(await new EmptyBytes().read());
   * ```
   *
   * @returns A byte chunk, or `null` on EOF.
   */
  read(options?: number | BytesReadOptions): Promise<Uint8Array | null> {
    return queueReaderOperation(
      this,
      () => this.#readBytes(options),
      () => null,
    );
  }
  async #readBytes(options?: number | BytesReadOptions): Promise<Uint8Array | null> {
    const readOptions = normalizeReadOptions(options);
    const maxBytes = readOptions.maxBytes ?? 65536;
    if (maxBytes === 0) return new Uint8Array(0);
    if (this.#stash === null && this.#byteState !== null) {
      const bytes = await this.#byteState.read(readOptions);
      if (bytes !== null && bytes.byteLength > 0) this.onConsume(bytes.byteLength);
      return bytes;
    }
    const buffer = new Uint8Array(maxBytes);
    const n = await this.#fetchInto(buffer, readOptions);
    if (n === null) return null;
    if (n > 0) this.onConsume(n);
    return buffer.subarray(0, n);
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
   * Read bytes directly into caller-provided view storage.
   *
   * Returns the number of bytes copied, or `null` on EOF. The method never
   * copies more than `buffer.byteLength` and relies on `readAtMost()` for
   * consumption accounting.
   *
   * The view's byte offset and length are preserved, allowing slices of pooled
   * or arena-allocated buffers to be filled without an intermediate copy.
   *
   * @param buffer Destination buffer view.
   * @param options Optional abort signal.
   * @returns Number of bytes copied, or `null` on EOF.
   */
  readInto(
    buffer: ArrayBufferView,
    options: Omit<BytesReadOptions, 'maxBytes'> = {},
  ): Promise<number | null> {
    if (!ArrayBuffer.isView(buffer)) throw new TypeError('readInto buffer must be a view');
    const destination = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (destination.byteLength === 0) return 0;
    return queueReaderOperation(
      this,
      async () => {
        const n =
          this.#stash === null && this.#byteState !== null
            ? await this.#byteState.readInto(destination, options)
            : await this.#fetchInto(destination, options);
        if (n !== null) {
          if (n < 0 || n > destination.byteLength)
            throw new RangeError('doReadInto returned invalid length');
          if (n > 0) this.onConsume(n);
        }
        return n;
      },
      () => null,
    );
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
   *   async doReadInto(buffer) {
   *     if (!this.data.byteLength) return null;
   *     const n = Math.min(buffer.byteLength, this.data.byteLength);
   *     buffer.set(this.data.subarray(0, n));
   *     this.data = this.data.subarray(n);
   *     return n;
   *   }
   * }
   * const reader = new MemoryReader();
   * console.log((await reader.readExactly(2))?.byteLength);
   * ```
   *
   * @param n Number of bytes required.
   * @returns Exactly `n` bytes, or `null` if EOF arrives first.
   */
  readExactly(n: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
    return queueReaderOperation(
      this,
      () => this.#readExactly(n, options),
      () => null,
    );
  }
  async #readExactly(n: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
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
   *   async doReadInto(buffer) {
   *     if (this.done) return null;
   *     this.done = true;
   *     buffer[0] = 97;
   *     return 1;
   *   }
   * }
   * console.log(await new OneByte().readByte());
   * ```
   *
   * @returns One byte as a number, or `null` on EOF.
   */
  readByte(options?: BytesReadOptions): Promise<number | null> {
    return queueReaderOperation(
      this,
      () => this.#readByte(options),
      () => null,
    );
  }
  async #readByte(options?: BytesReadOptions): Promise<number | null> {
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
   *   async doReadInto(buffer) {
   *     if (!this.data.byteLength) return null;
   *     const n = Math.min(buffer.byteLength, this.data.byteLength);
   *     buffer.set(this.data.subarray(0, n));
   *     this.data = this.data.subarray(n);
   *     return n;
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
  readUntil(
    delim: Uint8Array,
    max: number = 1 << 20,
    options?: BytesReadOptions,
  ): Promise<Uint8Array | null> {
    return queueReaderOperation(
      this,
      () => this.#readUntil(delim, max, options),
      () => null,
    );
  }
  async #readUntil(
    delim: Uint8Array,
    max: number,
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
 * The base `doReadInto()` implementation serves from buffered chunks and calls
 * `doPullInto()` only when the buffer is empty. Structural reads can therefore scan
 * cheaply while upstream backends pull larger chunks. `peek()`,
 * `scanBuffered()`, and `takeBuffered()` expose the current buffer for parsers
 * that need to inspect pipelined data without forcing another read.
 *
 * ```js
 * import { BufferedBytesReader, BytesReader } from 'fino:stream';
 * class EmptyBytes extends BytesReader { async doReadInto() { return null; } }
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
   *   async doPullInto() { return null; }
   * }
   * console.log(await new EmptyBuffered().read());
   * ```
   *
   * @returns A raw byte chunk, or `null` on EOF.
   */
  protected abstract doPullInto(buffer: Uint8Array): Promise<number | null>;

  async #pullChunk(): Promise<Uint8Array | null> {
    const buffer = new Uint8Array(65536);
    const n = await this.doPullInto(buffer);
    if (n === null) return null;
    if (n < 0 || n > buffer.byteLength) throw new RangeError('doPullInto returned invalid length');
    return buffer.subarray(0, n);
  }
  /**
   * Wrap an existing byte reader in a buffered reader.
   *
   * The wrapper pulls from `source.read()` and closes the source when the
   * buffered reader closes. This is useful for tests and for adding non-
   * consuming `peek()` and `readUntil()` behavior to an unbuffered source.
   *
   * ```js
   * import { BufferedBytesReader, BytesReader } from 'fino:stream';
   * class EmptyBytes extends BytesReader { async doReadInto() { return null; } }
   * const buffered = BufferedBytesReader.over(new EmptyBytes());
   * console.log(buffered.buffered);
   * ```
   *
   * @param source Source byte reader to buffer.
   * @returns A buffered wrapper around `source`.
   */
  static over(source: BytesReader): BufferedBytesReader {
    return new (class WrappedBufferedReader extends BufferedBytesReader {
      protected doPullInto(buffer: Uint8Array): Promise<number | null> {
        return source.readInto(buffer);
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
   *   async doPullInto(buffer) { if (this.done) return null; this.done = true; buffer.set([1, 2]); return 2; }
   * }
   * console.log((await new OneChunk().read())?.byteLength);
   * ```
   *
   * @param maxBytes Maximum bytes to return.
   * @returns A byte chunk, or `null` on EOF.
   */
  protected async doReadInto(
    buffer: Uint8Array,
    _options?: BytesReadOptions,
  ): Promise<number | null> {
    while (this.#chunks.length === 0) {
      if (this.#upstreamDone) return null;
      const n = await this.doPullInto(buffer);
      if (n === null) {
        this.#upstreamDone = true;
        return null;
      }
      if (n < 0 || n > buffer.byteLength)
        throw new RangeError('doPullInto returned invalid length');
      if (n === 0) continue;
      return n;
    }
    const head = this.#chunks[0]!;
    const n = Math.min(head.byteLength, buffer.byteLength);
    buffer.set(head.subarray(0, n));
    if (head.byteLength === n) {
      this.#chunks.shift();
    } else {
      this.#chunks[0] = head.subarray(n);
    }
    this.#bufferedBytes -= n;
    return n;
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
   * class EmptyBuffered extends BufferedBytesReader { async doPullInto() { return null; } }
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
   * class EmptyBuffered extends BufferedBytesReader { async doPullInto() { return null; } }
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
   *   async doPullInto(buffer) {
   *     if (this.done) return null;
   *     this.done = true;
   *     buffer.set([1, 2]);
   *     return 2;
   *   }
   * }
   * const reader = new OneChunk();
   * console.log((await reader.peek(1))[0]);
   * ```
   *
   * @param n Desired number of bytes.
   * @returns A non-consuming copy of available bytes.
   */
  peek(n: number): Promise<Uint8Array> {
    return queueReaderOperation(
      this,
      () => this.#peek(n),
      () => new Uint8Array(0),
    );
  }
  async #peek(n: number): Promise<Uint8Array> {
    while (this.#bufferedBytes < n && !this.#upstreamDone) {
      const chunk = await this.#pullChunk();
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
   *   async doPullInto(buffer) { const chunk = this.chunks.shift(); if (!chunk) return null; buffer.set(chunk); return chunk.length; }
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
   *   async doPullInto(buffer) {
   *     if (this.done) return null;
   *     this.done = true;
   *     buffer.set([1, 2]);
   *     return 2;
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
   *   async doPullInto(buffer) { if (this.done) return null; this.done = true; buffer[0] = 1; return 1; }
   * }
   * const reader = new OneChunk();
   * console.log(await reader.readExactly(2));
   * console.log(reader.buffered);
   * ```
   *
   * @param n Number of bytes required.
   * @returns Exactly `n` bytes, or `null` if EOF arrives first.
   */
  override readExactly(n: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
    return queueReaderOperation(
      this,
      () => this.#readExactlyBuffered(n, options),
      () => null,
    );
  }
  async #readExactlyBuffered(n: number, options?: BytesReadOptions): Promise<Uint8Array | null> {
    n = normalizeMaxBytes(n, 'n');
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    if (n === 0) return new Uint8Array(0);
    const peeked = await this.#peek(n);
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
   *   async doPullInto(buffer) { const chunk = this.chunks.shift(); if (!chunk) return null; buffer.set(chunk); return chunk.length; }
   * }
   * const reader = new Lines();
   * console.log(new TextDecoder().decode(await reader.readUntil(new Uint8Array([10]))));
   * ```
   *
   * @param delim Delimiter bytes to include in the returned chunk.
   * @param max Maximum buffered bytes to scan before throwing. Defaults to 1 MiB.
   * @returns Bytes through the delimiter, or `null` on EOF before a match.
   */
  override readUntil(
    delim: Uint8Array,
    max: number = 1 << 20,
    options?: BytesReadOptions,
  ): Promise<Uint8Array | null> {
    return queueReaderOperation(
      this,
      () => this.#readUntilBuffered(delim, max, options),
      () => null,
    );
  }
  async #readUntilBuffered(
    delim: Uint8Array,
    max: number,
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
      const chunk = await this.#pullChunk();
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
   * Bytes reported available by the last readiness event.
   *
   * A positive count lets readiness-first platforms consume the remainder of
   * an event without installing another one-shot watch.
   *
   * @internal
   */
  #avail: number = 0;
  /**
   * Whether this descriptor can be read safely before installing a watch.
   *
   * Linux nonblocking descriptors use the usual read-until-`EAGAIN` pattern so
   * data that arrived before watch registration cannot be stranded. Blocking
   * descriptors and macOS retain readiness-first behavior.
   *
   * @internal
   */
  #readBeforeReady: boolean;
  /** Resolve the currently pending readiness wait as EOF during close. */
  #cancelPendingRead: (() => void) | null = null;
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
    super(async () => {
      loop.removeRead(fd);
      this.#cancelPendingRead?.();
      await onClose();
    });
    this.#fd = fd;
    const flags = lib.symbols.fcntl(fd, F_GETFL, 0) as number;
    this.#readBeforeReady = os === 'linux' && flags >= 0 && (flags & O_NONBLOCK) !== 0;
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
  /** Wait for readability while allowing `close()` to settle the wait as EOF. */
  #waitReadable(): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      let settled = false;
      this.#cancelPendingRead = () => {
        if (settled) return;
        settled = true;
        this.#cancelPendingRead = null;
        resolve(null);
      };
      void loop.readable(this.#fd).then((available) => {
        if (settled) return;
        settled = true;
        this.#cancelPendingRead = null;
        resolve(available);
      });
    });
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
  protected async doPullInto(buffer: Uint8Array): Promise<number | null> {
    while (true) {
      if (this.closed) return null;
      if (this.#fd < 0) throw new Error('read failed');
      if (!this.#readBeforeReady && this.#avail <= 0) {
        const available = await this.#waitReadable();
        if (available === null) return null;
        this.#avail = available;
      }
      const n = lib.symbols.read(this.#fd, buffer, buffer.byteLength) as number;
      if (n > 0) {
        this.#avail = Math.max(0, this.#avail - n);
        return n;
      }
      if (n === 0) return null;
      if (getErrno() !== EAGAIN) return null;
      const available = await this.#waitReadable();
      if (available === null) return null;
      this.#avail = available;
    }
  }
}
// ---------------------------------------------------------------------------
// Writer<T> — generic async consumer of values
// ---------------------------------------------------------------------------
/**
 * Acceptance endpoint for an asynchronous value sink.
 *
 * Writer delegates acceptance order, back-pressure, flushing, closure, and
 * failure to shared state. The endpoint keeps that machinery out of the user
 * API: callers use `write()`, `flush()`, and `close()`.
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
export class Writer<T> {
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
  #closePromise: Promise<void> | null = null;
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
  #state: WritableState<T> | null;
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
  constructor(stateOrClose: WritableState<T> | (() => void | Promise<void>) = () => {}) {
    this.#state = typeof stateOrClose === 'function' ? null : stateOrClose;
    this.#onClose =
      typeof stateOrClose === 'function' ? stateOrClose : () => stateOrClose.closeWriter();
    if (this.#state === null) {
      const state = { queue: new ChannelSequence(), closed: () => this.#closed, pending: 0 };
      writerQueues.set(this, state);
    }
  }
  /**
   * Whether the writer has been closed.
   *
   * The flag is set as soon as `close()` begins, before admitted work drains and
   * before the close callback is awaited. The base class rejects later writes.
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
   * Write one value to the state.
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
  write(value: T): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Writer is closed'));
    if (this.#state === null) return Promise.reject(new Error('Writer has no channel state'));
    return this.#state.write(value);
  }
  /**
   * Write one value synchronously when the writer supports synchronous
   * acceptance.
   *
   * This method is an optional capability for hot paths that must not yield
   * between producing bytes and updating native state. Implementations should
   * either accept the value completely or throw. The base automatically
   * prevents it from overtaking pending asynchronous work. `Writer` does not
   * provide a fallback because calling async `write()` from a sync-only path
   * would hide an ordering bug.
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
   * Subclass hook for flushing internally buffered data.
   *
   * ```js
   * import { Writer } from 'fino:stream';
   * class NullWriter extends Writer { async write(_value) {} }
   * await new NullWriter().flush();
   * ```
   *
   * @returns A promise that resolves after pending data is flushed.
   */
  flush(): Promise<void> {
    if (this.#state === null) return Promise.resolve();
    return this.#state.flush();
  }
  /**
   * Close the writer and run its close callback once.
   *
   * Multiple calls return the same cleanup promise. New operations are rejected
   * immediately; operations admitted earlier drain in FIFO order before the
   * subclass close hook and cleanup callback run.
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
  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    try {
      this.#closePromise =
        this.#state === null
          ? queueWriterClose(this, () => Promise.resolve(this.#onClose()))
          : Promise.resolve(this.#onClose());
    } catch (error) {
      this.#closePromise = Promise.reject(error);
    }
    return this.#closePromise;
  }
  /** Fail the shared channel state. */
  fail(error: unknown): void {
    if (this.#state === null) throw error;
    this.#state.fail(error);
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
// BytesWriter extends Writer<ArrayBuffer | ArrayBufferView> — byte write API
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
export class BytesWriter extends Writer<ArrayBuffer | ArrayBufferView> {
  #byteState: BytesWritableState | null;
  constructor(stateOrClose: BytesWritableState | (() => void | Promise<void>) = () => {}) {
    super(typeof stateOrClose === 'function' ? stateOrClose : () => stateOrClose.closeWriter());
    this.#byteState = typeof stateOrClose === 'function' ? null : stateOrClose;
  }
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
  protected doWrite(buf: Uint8Array): Promise<void> {
    if (this.#byteState === null) return Promise.reject(new Error('BytesWriter has no byte state'));
    return this.#byteState.write(buf);
  }
  /**
   * Normalize one byte source admitted by the base writer.
   *
   * `ArrayBuffer` and `ArrayBufferView` inputs are wrapped in a `Uint8Array`
   * preserving view byte offsets, then forwarded to `doWrite()` as one
   * ordered writer operation.
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
    const arr = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    await queueWriterOperation(this, () => this.doWrite(arr));
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
  writev(vecs: Uint8Array[], count: number = vecs.length): Promise<void> {
    return queueWriterOperation(this, async () => {
      for (let i = 0; i < count; i++) {
        const v = vecs[i];
        if (v && v.byteLength > 0) await this.doWrite(v);
      }
    });
  }
}

/**
 * A zero-capacity byte rendezvous with standard byte endpoints.
 *
 * The channel owns no byte buffer. A write waits for reader-provided storage,
 * so producer progress follows consumer demand. `read(n)` allocates the offered
 * region; `readInto(view)` lets the caller supply it.
 *
 * ```ts no_run
 * import { BytesChannel } from 'fino:stream';
 * const channel = new BytesChannel();
 * const read = channel.reader.read(4);
 * await channel.writer.write(new Uint8Array([1, 2]));
 * console.log(await read);
 * ```
 */
export class BytesChannel {
  readonly reader: BytesReader;
  readonly writer: BytesWriter;
  constructor() {
    const state = new BytesChannelState();
    this.reader = new BytesReader(state);
    this.writer = new BytesWriter(state);
  }
}

/**
 * A fixed-capacity byte channel backed by one reusable segment.
 *
 * Writes wait while the segment is full or leased by a returned `read()` view.
 * The segment capacity defaults to 64 KiB. Prefer `readInto()` when the caller
 * wants ownership of the destination storage.
 *
 * ```ts no_run
 * import { BufferedBytesChannel } from 'fino:stream';
 * const channel = new BufferedBytesChannel(4096);
 * await channel.writer.write(new Uint8Array([1]));
 * console.log(await channel.reader.read());
 * ```
 */
export class BufferedBytesChannel {
  readonly reader: BytesReader;
  readonly writer: BytesWriter;
  constructor(capacity: number = 65536) {
    const state = new BufferedBytesChannelState(capacity);
    this.reader = new BytesReader(state);
    this.writer = new BytesWriter(state);
  }
}

/**
 * An unbounded byte channel backed by capacity-sized segments.
 *
 * Writes can run ahead by allocating another segment, so memory use grows with
 * producer lead. Segment capacity defaults to 64 KiB; it controls allocation
 * granularity rather than a total bound.
 *
 * ```ts no_run
 * import { UnboundedBytesChannel } from 'fino:stream';
 * const channel = new UnboundedBytesChannel(4096);
 * await channel.writer.write(new Uint8Array([1]));
 * console.log(await channel.reader.read());
 * ```
 */
export class UnboundedBytesChannel {
  readonly reader: BytesReader;
  readonly writer: BytesWriter;
  constructor(segmentCapacity: number = 65536) {
    const state = new UnboundedBytesChannelState(segmentCapacity);
    this.reader = new BytesReader(state);
    this.writer = new BytesWriter(state);
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
   * Emit the coalesce buffer while the inherited writer operation is active.
   *
   * This hook does not admit a new operation and is only used from writer hooks
   * that already own the base writer queue.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter {
   *   async doFlush(_buf) {}
   *   drainHeld() { return this._flushHeld(); }
   * }
   * await new Sink().drainHeld();
   * ```
   *
   * @returns A promise that resolves after pending bytes are emitted.
   * @internal
   */
  protected async _flushHeld(): Promise<void> {
    const slice = this._takePending();
    if (slice === null) return;
    await this.doFlush(slice);
  }
  /**
   * Coalesce or emit one buffer, assuming the queue is already held.
   *
   * @param buf Bytes to write.
   * @returns A promise that resolves after bytes are buffered or emitted.
   */
  async #writeHeld(buf: Uint8Array): Promise<void> {
    if (buf.byteLength >= this.#buf.byteLength) {
      // Bypass: write is large enough that coalescing doesn't help.
      await this._flushHeld();
      return this.doFlush(buf);
    }
    if (!this._directAccumulate(buf)) {
      await this._flushHeld();
      this._directAccumulate(buf);
    }
  }
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
    let flush: () => Promise<void>;
    super(async () => {
      await flush();
      await onClose();
    });
    this.#buf = new Uint8Array(bufferSize);
    flush = () => this._flushHeld();
  }
  /**
   * Flush a coalesced byte slice to the underlying resource.
   *
   * Implementations must emit all bytes in `buf` or throw. Calls are serialized
   * per writer, so an implementation that suspends on backpressure keeps the
   * descriptor to itself until it returns.
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
   * The base `Writer` invokes this hook while holding the per-instance FIFO, so
   * callers cannot contend for buffer room or overlap flushes.
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
  protected doWrite(buf: Uint8Array): Promise<void> {
    return this.#writeHeld(buf);
  }
  /**
   * Write multiple byte buffers through the coalescing buffer.
   *
   * The complete vector batch occupies one writer operation. Small vectors are
   * accumulated and flushed only when the buffer fills. A vector at least as
   * large as the coalesce buffer flushes pending bytes first and then bypasses
   * accumulation.
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
  writev(vecs: Uint8Array[], count: number = vecs.length): Promise<void> {
    return queueWriterOperation(this, async () => {
      for (let i = 0; i < count; i++) {
        const v = vecs[i];
        if (!v || v.byteLength === 0) continue;
        await this.#writeHeld(v);
      }
    });
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
   * Flush-hook implementation that drains the coalesce buffer.
   *
   * The public base `flush()` method invokes this after earlier writes. With no
   * pending bytes it is a no-op. Errors from `doFlush()` reject the caller and
   * the pending count has already been reset.
   *
   * The pending bytes are taken as a copy: `doFlush()` can suspend on
   * backpressure, and the coalesce buffer it was handed would otherwise be
   * refilled from offset zero by the next write while those bytes were still
   * on their way out.
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
  override async flush(): Promise<void> {
    await queueWriterOperation(this, () => this._flushHeld());
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
   * Drain pending bytes before writer cleanup.
   *
   * The base `close()` method invokes this hook after every previously admitted
   * operation. Its `finally` path still invokes the cleanup callback if
   * flushing fails.
   *
   * ```js
   * import { BufferedBytesWriter } from 'fino:stream';
   * class Sink extends BufferedBytesWriter { async doFlush(_buf) {} }
   * const writer = new Sink();
   * await writer.close();
   * ```
   *
   * @returns A promise that resolves after pending bytes are flushed.
   * @internal
   */
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
   * (partial writes are accepted on a best-effort basis). The method throws if
   * an asynchronous writer operation is pending rather than overtaking it.
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
  writev(vecs: Uint8Array[], count: number = vecs.length): Promise<void> {
    if (count === 0) return queueWriterOperation(this, async () => {});
    if (count > MAX_IOV)
      return Promise.reject(new Error(`writev: too many vectors (max ${MAX_IOV})`));
    let totalLen = 0;
    for (let i = 0; i < count; i++) totalLen += vecs[i]!.byteLength;
    if (totalLen <= COALESCE_LIMIT) {
      // Fast path: accumulate synchronously into the coalesce buffer — no Promises
      // until the buffer is full and a flush is needed (rare for typical responses),
      // or until another caller already holds the writer.
      return super.writev(vecs, count);
    }
    // Slow path: scatter/gather writev(2) — zero copy for large writes. Takes
    // one turn on the queue covering both the coalesce flush that has to
    // precede it and the gather loop itself: the iovec block and the cursor
    // array are per-writer scratch, so a second writev running against them
    // concurrently would rewrite this one's vectors mid-syscall.
    return queueWriterOperation(this, async () => {
      await this._flushHeld();
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
    });
  }
}
// ---------------------------------------------------------------------------
// Channel<T> — connected Writer/Reader pair sharing an in-memory buffer
// ---------------------------------------------------------------------------
// Shared internal state contract between channel halves — not exported.
interface ChannelState<T> extends ReadableState<T>, WritableState<T> {
  push(value: T): Promise<void>;
  end(): void;
  fail(error: unknown): void;
  read(): Promise<T | null>;
  cancelWaiters(): void;
}
class RendezvousChannelState<T> implements ChannelState<T> {
  done = false;
  closing = false;
  readerClosed = false;
  hasErr = false;
  err: unknown;
  writes: Array<{
    value: T;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  closeWaiters: Array<() => void> = [];
  waiters: Array<{
    resolve: (v: T | null) => void;
    reject: (e: unknown) => void;
  }> = [];
  push(value: T): Promise<void> {
    if (this.readerClosed) return Promise.reject(new Error('Channel reader is closed'));
    if (this.hasErr) return Promise.reject(this.err);
    const w = this.waiters.shift();
    if (w) {
      w.resolve(value);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.writes.push({ value, resolve, reject });
    });
  }
  write(value: T): Promise<void> {
    return this.push(value);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  closeWriter(): Promise<void> {
    this.closing = true;
    this.#finishClose();
    if (this.done) return Promise.resolve();
    return new Promise<void>((resolve) => this.closeWaiters.push(resolve));
  }
  closeReader(): void {
    this.cancelWaiters();
  }
  end(): void {
    this.closing = true;
    this.#finishClose();
  }
  #finishClose(): void {
    if (this.done || !this.closing || this.writes.length > 0) return;
    this.done = true;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve(null);
    const closes = this.closeWaiters;
    this.closeWaiters = [];
    for (const close of closes) close();
  }
  fail(err: unknown): void {
    this.hasErr = true;
    this.err = err;
    const writes = this.writes;
    this.writes = [];
    for (const write of writes) write.reject(err);
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.reject(err);
  }
  read(): Promise<T | null> {
    const write = this.writes.shift();
    if (write !== undefined) {
      write.resolve();
      this.#finishClose();
      return Promise.resolve(write.value);
    }
    if (this.hasErr) return Promise.reject(this.err);
    if (this.done) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      this.waiters.push({
        resolve,
        reject,
      });
    });
  }
  cancelWaiters(): void {
    this.readerClosed = true;
    const writes = this.writes;
    this.writes = [];
    for (const write of writes) write.reject(new Error('Channel reader is closed'));
    this.#finishClose();
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.resolve(null);
  }
}
interface ChannelNode<T> {
  value: T;
  next: ChannelNode<T> | null;
}
class UnboundedChannelState<T> implements ChannelState<T> {
  #head: ChannelNode<T> | null = null;
  #tail: ChannelNode<T> | null = null;
  #done = false;
  #readerClosed = false;
  #hasError = false;
  #error: unknown;
  #waiters: Array<{
    resolve: (value: T | null) => void;
    reject: (error: unknown) => void;
  }> = [];
  push(value: T): Promise<void> {
    if (this.#readerClosed) return Promise.reject(new Error('Channel reader is closed'));
    if (this.#hasError) return Promise.reject(this.#error);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(value);
      return Promise.resolve();
    }
    const node = { value, next: null };
    if (this.#tail === null) {
      this.#head = node;
    } else {
      this.#tail.next = node;
    }
    this.#tail = node;
    return Promise.resolve();
  }
  write(value: T): Promise<void> {
    return this.push(value);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
  closeWriter(): Promise<void> {
    this.end();
    return Promise.resolve();
  }
  closeReader(): void {
    this.cancelWaiters();
  }
  end(): void {
    if (this.#done) return;
    this.#done = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.resolve(null);
  }
  fail(error: unknown): void {
    this.#hasError = true;
    this.#error = error;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }
  read(): Promise<T | null> {
    const node = this.#head;
    if (node !== null) {
      this.#head = node.next;
      if (this.#head === null) this.#tail = null;
      return Promise.resolve(node.value);
    }
    if (this.#hasError) return Promise.reject(this.#error);
    if (this.#done) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }
  cancelWaiters(): void {
    this.#readerClosed = true;
    this.#head = null;
    this.#tail = null;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.resolve(null);
  }
}
/**
 * Zero-capacity in-memory Writer/Reader pair.
 *
 * Each `writer.write(value)` remains pending until one `reader.read()` accepts
 * that value. Overlapping reads and writes pair in FIFO order, providing
 * back-pressure without retaining producer-ahead values. `writer.close()`
 * signals EOF after admitted writes are consumed. Closing the reader rejects
 * unread writes, and `writer.fail(error)` rejects pending operations.
 *
 * Use `UnboundedChannel` only when producers must run ahead of consumers and
 * unbounded memory growth is acceptable.
 *
 * ```ts no_run
 * import { Channel } from 'fino:stream';
 * const ch = new Channel();
 * const consume = (async () => {
 *   for await (const value of ch.reader) console.log(value);
 * })();
 * await ch.writer.write(1);
 * await ch.writer.write(2);
 * await ch.writer.close();
 * await consume;
 * ```
 */
export class Channel<T> {
  /**
   * Producer half of the channel.
   *
   * `write(value)` waits for the reader to accept the value. `close()` signals
   * EOF after admitted values, and `fail(error)` surfaces a terminal error.
   */
  readonly writer: Writer<T>;
  /**
   * Consumer half of the channel.
   *
   * A standard `Reader<T>`: iterate it with `for await`, drive it with
   * `reader.read()`, or feed another `Writer` with `writer.pipe(reader)`.
   */
  readonly reader: Reader<T>;
  /**
   * Create a connected zero-capacity writer/reader pair.
   *
   * The two halves share rendezvous state but no value buffer. Reads and writes
   * pair in FIFO order.
   */
  constructor() {
    const buf = new RendezvousChannelState<T>();
    this.writer = new Writer(buf);
    this.reader = new Reader(buf);
  }
}
/**
 * Unbounded in-memory Writer/Reader pair.
 *
 * Writes resolve after appending to an internal linked FIFO, without waiting
 * for a reader. Reads remove values from the head in constant time. The queue
 * has no capacity limit, so a producer can retain arbitrary memory if it
 * outpaces its consumer. Writer close drains accepted values before EOF;
 * reader close releases unread values.
 *
 * ```ts no_run
 * import { UnboundedChannel } from 'fino:stream';
 *
 * const channel = new UnboundedChannel<number>();
 * await channel.writer.write(1);
 * await channel.writer.write(2);
 * await channel.writer.close();
 * for await (const value of channel.reader) console.log(value);
 * ```
 */
export class UnboundedChannel<T> {
  /** Writer that accepts values into the unbounded FIFO. */
  readonly writer: Writer<T>;
  /** Reader that removes accepted values in FIFO order. */
  readonly reader: Reader<T>;
  /** Create an empty unbounded channel. */
  constructor() {
    const state = new UnboundedChannelState<T>();
    this.writer = new Writer(state);
    this.reader = new Reader(state);
  }
}
