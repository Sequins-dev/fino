/**
 * internal:compression-streams — CompressionStream and DecompressionStream.
 *
 * WHATWG Compression Streams specification implementation.
 * Wraps the streaming compression API from fino:compression in the
 * standard Web Streams interface (ReadableStream / WritableStream pair).
 *
 * Supported formats: 'gzip', 'deflate', 'deflate-raw'
 * (Brotli is not part of the WHATWG spec.)
 *
 *
 * ## Bridging the two streaming APIs
 *
 * fino:compression provides streaming via factories: `createGzip(opts)` returns
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
 * @internal
 */

import { ReadableStream, WritableStream } from './webstreams.mts';
import {
  createGzip, createGunzip,
  createDeflate, createInflate,
  createDeflateRaw, createInflateRaw,
} from 'fino:util/compression';

// ---------------------------------------------------------------------------
// Format maps
// ---------------------------------------------------------------------------

type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw';

const COMPRESS_FORMATS: Record<string, () => { transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> }> = {
  'gzip':        createGzip,
  'deflate':     createDeflate,
  'deflate-raw': createDeflateRaw,
};

const DECOMPRESS_FORMATS: Record<string, () => { transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> }> = {
  'gzip':        createGunzip,
  'deflate':     createInflate,
  'deflate-raw': createInflateRaw,
};

// ---------------------------------------------------------------------------
// Internal bridge
// ---------------------------------------------------------------------------

/**
 * Create a (readable, writable) Web Streams pair backed by one of the
 * fino:compression streaming factories.
 *
 * @param {Function} factory — e.g. createGzip, createGunzip
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
 * ```ts
 * const cs = new CompressionStream('gzip');
 * readableSource.pipeThrough(cs);  // cs.readable yields compressed chunks
 * ```
 *
 * ```ts
 * const cs  = new CompressionStream('gzip');
 * const writer = cs.writable.getWriter();
 * await writer.write(data);
 * await writer.close();
 * const compressed = await new Response(cs.readable).bytes();
 * ```
 */
export class CompressionStream {
  #readable: ReadableStream;
  #writable: WritableStream;

  get [Symbol.toStringTag]() { return 'CompressionStream'; }

  constructor(format: CompressionFormat) {
    const factory = COMPRESS_FORMATS[format];
    if (!factory) {
      throw new TypeError(`CompressionStream: unsupported format '${format}'`);
    }
    const { readable, writable } = _makeStreams(factory);
    this.#readable = readable;
    this.#writable = writable;
  }

  get readable() { return this.#readable; }
  get writable() { return this.#writable; }
}

/**
 * Transforms a stream of compressed bytes (gzip, deflate, or deflate-raw)
 * into the original uncompressed data.
 *
 * ```ts
 * const ds = new DecompressionStream('gzip');
 * compressedReadable.pipeThrough(ds);  // ds.readable yields decompressed chunks
 * ```
 */
export class DecompressionStream {
  #readable: ReadableStream;
  #writable: WritableStream;

  get [Symbol.toStringTag]() { return 'DecompressionStream'; }

  constructor(format: CompressionFormat) {
    const factory = DECOMPRESS_FORMATS[format];
    if (!factory) {
      throw new TypeError(`DecompressionStream: unsupported format '${format}'`);
    }
    const { readable, writable } = _makeStreams(factory);
    this.#readable = readable;
    this.#writable = writable;
  }

  get readable() { return this.#readable; }
  get writable() { return this.#writable; }
}
