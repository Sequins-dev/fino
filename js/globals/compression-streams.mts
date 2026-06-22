/**
 * CompressionStream and DecompressionStream globals.
 *
 * WHATWG Compression Streams specification implementation:
 * https://compression.spec.whatwg.org/
 * Wraps the streaming compression API from fino:compress in the
 * standard Web Streams interface (ReadableStream / WritableStream pair).
 *
 * Supported formats: 'gzip', 'deflate', 'deflate-raw'
 * (Brotli is not part of the WHATWG spec.)
 *
 * DecompressionStream mirrors the web API and does not expose a maximum output
 * size option. Consumers that handle untrusted compressed input should read the
 * decompressed stream with an application byte budget and cancel it when the
 * budget is exceeded.
 *
 *
 * ## Bridging the two streaming APIs
 *
 * fino:compress provides streaming via factories: `createCompressor(opts)` returns
 * an object with `transform(asyncIterable) → asyncIterable`. This does not speak
 * Web Streams. To bridge:
 *
 *   1. A simple async-iterable input channel is created.
 *   2. The compression factory is connected to it: `factory().transform(channel)`.
 *   3. The output iterable is wrapped in `ReadableStream.from()`.
 *   4. A `WritableStream` sink feeds incoming writes into the channel.
 *
 * This keeps all the actual compression work in the existing FFI-backed
 * generators and avoids duplicating the zlib/brotli logic here.
 *
 * ## Example
 *
 * ```typescript no_run
 * const source = new Blob(['hello']).stream();
 * const compressed = source.pipeThrough(new CompressionStream('gzip'));
 * const restored = compressed.pipeThrough(new DecompressionStream('gzip'));
 *
 * const text = await new Response(restored).text();
 * console.log(text);
 * ```
 *
 */

import { ReadableStream, WritableStream } from './webstreams.mts';
import { createCompressor, createDecompressor } from 'fino:compress';

// ---------------------------------------------------------------------------
// Format maps
// ---------------------------------------------------------------------------

/**
 * Compression formats supported by WHATWG CompressionStream.
 *
 * Brotli is intentionally excluded because it is not part of the standard
 * Compression Streams constructor format set.
 *
 * ```typescript no_run
 * const format: CompressionFormat = 'gzip';
 * new CompressionStream(format);
 * ```
 *
 * @internal
 */
type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';

const COMPRESS_FORMATS: Record<string, () => { transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> }> = {
  'gzip':        () => createCompressor({ format: 'gzip' }),
  'deflate':     () => createCompressor({ format: 'deflate' }),
  'deflate-raw': () => createCompressor({ format: 'deflate-raw' }),
};

const DECOMPRESS_FORMATS: Record<string, () => { transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> }> = {
  'gzip':        () => createDecompressor({ format: 'gzip' }),
  'deflate':     () => createDecompressor({ format: 'deflate' }),
  'deflate-raw': () => createDecompressor({ format: 'deflate-raw' }),
};

// ---------------------------------------------------------------------------
// Internal bridge
// ---------------------------------------------------------------------------

/**
 * Create a (readable, writable) Web Streams pair backed by one of the
 * fino:compress streaming factories.
 *
 * @param {Function} factory — e.g. createCompressor/createDecompressor wrapper
 * @returns {{ readable: ReadableStream, writable: WritableStream }}
 */
function _makeStreams(factory: () => { transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> }): { readable: ReadableStream; writable: WritableStream } {
  // ---- Input channel -------------------------------------------------------
  // A simple buffered async iterable. The WritableStream sink enqueues chunks
  // here; the compression generator pulls from here.

  const inputChunks: Uint8Array[] = [];
  let inputResolve: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  let inputReject: ((reason?: unknown) => void) | null = null;
  let inputDone    = false;
  let inputError: unknown = null;

  const inputIterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (inputChunks.length > 0) {
            return Promise.resolve({ value: inputChunks.shift()!, done: false });
          }
          if (inputDone && inputError !== null) return Promise.reject(inputError);
          if (inputDone) return Promise.resolve({ done: true, value: undefined });
          return new Promise(function parkInput(resolve, reject) {
            inputResolve = resolve;
            inputReject  = reject;
          });
        },
      };
    },
  };

  function _enqueue(chunk: Uint8Array): void {
    if (inputResolve) {
      const r = inputResolve; inputResolve = null; inputReject = null;
      r({ value: chunk, done: false });
    } else {
      inputChunks.push(chunk);
    }
  }

  function _close() {
    inputDone = true;
    if (inputResolve) {
      const r = inputResolve; inputResolve = null; inputReject = null;
      r({ done: true, value: undefined });
    }
  }

  function _error(reason: unknown): void {
    inputDone  = true;
    inputError = reason ?? new Error('stream aborted');
    if (inputReject) {
      const r = inputReject; inputResolve = null; inputReject = null;
      r(inputError);
    }
  }

  // ---- Writable side -------------------------------------------------------

  const writable = new WritableStream({
    write(chunk: BufferSource) {
      if (!(chunk instanceof ArrayBuffer) && !ArrayBuffer.isView(chunk)) {
        throw new TypeError('CompressionStream: chunk must be a BufferSource (ArrayBuffer or ArrayBufferView)');
      }
      let bytes: Uint8Array;
      if (chunk instanceof Uint8Array) {
        bytes = chunk;
      } else if (ArrayBuffer.isView(chunk)) {
        bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      } else {
        bytes = new Uint8Array(chunk as ArrayBuffer);
      }
      _enqueue(bytes);
    },
    close() { _close(); },
    abort(reason: unknown) { _error(reason); },
  }, undefined);

  // ---- Compression / decompression chain -----------------------------------

  const outputIterable = factory().transform(inputIterable);
  const readable       = ReadableStream.from(outputIterable);

  return { readable, writable };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transforms a stream of bytes by compressing it using gzip, deflate, or
 * deflate-raw (raw DEFLATE without a wrapper).
 *
 * ```ts no_run
 * const cs = new CompressionStream('gzip');
 * readableSource.pipeThrough(cs);  // cs.readable yields compressed chunks
 * ```
 *
 * ```ts no_run
 * const cs  = new CompressionStream('gzip');
 * const writer = cs.writable.getWriter();
 * await writer.write(data);
 * await writer.close();
 * const compressed = await new Response(cs.readable).bytes();
 * ```
 */
export class CompressionStream {
  /**
   * Private property `#readable` used by `CompressionStream`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readable = undefined;
   *
   *   readInternalState() {
   *     return this.#readable;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readable: ReadableStream;
  /**
   * Private property `#writable` used by `CompressionStream`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writable = undefined;
   *
   *   readInternalState() {
   *     return this.#writable;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #writable: WritableStream;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * const stream = new CompressionStream('gzip');
   * Object.prototype.toString.call(stream); // "[object CompressionStream]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'CompressionStream'; }

  /**
   * Create a compression transform for the selected format.
   *
   * Unsupported formats throw TypeError. The writable side accepts BufferSource
   * chunks and the readable side emits compressed Uint8Array chunks.
   *
   * ```typescript no_run
   * const gzip = new CompressionStream('gzip');
   * await new Blob(['hello']).stream().pipeTo(gzip.writable);
   * ```
   */
  constructor(format: CompressionFormat) {
    const factory = COMPRESS_FORMATS[format];
    if (!factory) {
      throw new TypeError(`CompressionStream: unsupported format '${format}'`);
    }
    const { readable, writable } = _makeStreams(factory);
    this.#readable = readable;
    this.#writable = writable;
  }

  /**
   * Readable side that yields compressed bytes.
   *
   * It closes after the writable side is closed and all compressor output has
   * been emitted.
   *
   * ```typescript no_run
   * const cs = new CompressionStream('deflate');
   * const compressed = cs.readable;
   * ```
   */
  get readable() { return this.#readable; }

  /**
   * Writable side that accepts uncompressed BufferSource chunks.
   *
   * Writing a non-buffer chunk throws TypeError. Closing this side completes the
   * compression stream and flushes final bytes.
   *
   * ```typescript no_run
   * const cs = new CompressionStream('gzip');
   * const writer = cs.writable.getWriter();
   * await writer.write(new Uint8Array([1, 2, 3]));
   * ```
   */
  get writable() { return this.#writable; }
}

/**
 * Transforms a stream of compressed bytes (gzip, deflate, or deflate-raw)
 * into the original uncompressed data.
 *
 * ```ts no_run
 * const ds = new DecompressionStream('gzip');
 * compressedReadable.pipeThrough(ds);  // ds.readable yields decompressed chunks
 * ```
 */
export class DecompressionStream {
  /**
   * Private property `#readable` used by `DecompressionStream`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readable = undefined;
   *
   *   readInternalState() {
   *     return this.#readable;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readable: ReadableStream;
  /**
   * Private property `#writable` used by `DecompressionStream`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writable = undefined;
   *
   *   readInternalState() {
   *     return this.#writable;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #writable: WritableStream;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * const stream = new DecompressionStream('gzip');
   * Object.prototype.toString.call(stream); // "[object DecompressionStream]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'DecompressionStream'; }

  /**
   * Create a decompression transform for the selected format.
   *
   * Unsupported formats throw TypeError. Invalid compressed input causes the
   * readable side to error when the backend decompressor detects it.
   *
   * ```typescript no_run
   * const gunzip = new DecompressionStream('gzip');
   * compressedReadable.pipeThrough(gunzip);
   * ```
   */
  constructor(format: CompressionFormat) {
    const factory = DECOMPRESS_FORMATS[format];
    if (!factory) {
      throw new TypeError(`DecompressionStream: unsupported format '${format}'`);
    }
    const { readable, writable } = _makeStreams(factory);
    this.#readable = readable;
    this.#writable = writable;
  }

  /**
   * Readable side that yields decompressed bytes.
   *
   * ```typescript no_run
   * const ds = new DecompressionStream('deflate-raw');
   * const output = ds.readable;
   * ```
   */
  get readable() { return this.#readable; }

  /**
   * Writable side that accepts compressed BufferSource chunks.
   *
   * Close the writer to finish the decompressor and surface final output or
   * format errors.
   *
   * ```typescript no_run
   * const ds = new DecompressionStream('gzip');
   * await ds.writable.getWriter().close();
   * ```
   */
  get writable() { return this.#writable; }
}
