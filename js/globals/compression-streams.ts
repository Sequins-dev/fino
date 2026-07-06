/**
* CompressionStream and DecompressionStream globals (WHATWG Compression Streams).
*
* Both classes are installed on `globalThis`, so application code uses them
* without importing anything. Each instance is a transform pair — a `writable`
* side that accepts raw bytes and a `readable` side that emits the transformed
* bytes — designed to be dropped into a stream pipeline with `pipeThrough()`.
*
* Supported formats are the three the spec defines — `gzip`, `deflate`
* (zlib-wrapped DEFLATE), and `deflate-raw` (bare DEFLATE with no wrapper) —
* plus `brotli` as a runtime extension when the system Brotli library is
* available. Constructing a stream with `'brotli'` on a machine without the
* backend throws; portable code should check `brotliAvailable` from
* `fino:compress` before selecting it.
*
* DecompressionStream mirrors the web API and does not expose a maximum output
* size option. Consumers that handle untrusted compressed input should read the
* decompressed stream with an application byte budget and cancel it when the
* budget is exceeded.
*
*
* ## Bridging the two streaming APIs
*
* All actual compression work lives in `fino:compress`, whose streaming shape
* is factory-based: `createCompressor(opts)` returns an object with
* `transform(asyncIterable) → asyncIterable`. That API does not speak Web
* Streams. To bridge:
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
* ```ts no_run
* const source = new Blob(['hello']).stream();
* const compressed = source.pipeThrough(new CompressionStream('gzip'));
* const restored = compressed.pipeThrough(new DecompressionStream('gzip'));
*
* const text = await new Response(restored).text();
* console.log(text); // 'hello'
* ```
*
* WHATWG Compression Streams specification: https://compression.spec.whatwg.org/
*/
import { ReadableStream, WritableStream } from './webstreams.ts';
import { createCompressor, createDecompressor } from 'fino:compress';
// ---------------------------------------------------------------------------
// Format maps
// ---------------------------------------------------------------------------
/**
* Format names accepted by the CompressionStream and DecompressionStream
* constructors.
*
* `'gzip'`, `'deflate'` (zlib-wrapped DEFLATE), and `'deflate-raw'` (bare
* DEFLATE without any wrapper) are always available. `'brotli'` is a runtime
* extension beyond the WHATWG spec: it requires the system Brotli library, and
* constructing a stream with it throws when that backend is missing.
*
* ```ts no_run
* const format: CompressionFormat = 'gzip';
* new CompressionStream(format);
* ```
*
* @internal
*/
type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli';
const COMPRESS_FORMATS: Record<string, () => {
  transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
}> = {
  'gzip': () => createCompressor({ format: 'gzip' }),
  'deflate': () => createCompressor({ format: 'deflate' }),
  'deflate-raw': () => createCompressor({ format: 'deflate-raw' }),
  'brotli': () => createCompressor({ format: 'brotli' })
};
const DECOMPRESS_FORMATS: Record<string, () => {
  transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
}> = {
  'gzip': () => createDecompressor({ format: 'gzip' }),
  'deflate': () => createDecompressor({ format: 'deflate' }),
  'deflate-raw': () => createDecompressor({ format: 'deflate-raw' }),
  'brotli': () => createDecompressor({ format: 'brotli' })
};
// ---------------------------------------------------------------------------
// Internal bridge
// ---------------------------------------------------------------------------
/**
* Create a `{ readable, writable }` Web Streams pair backed by one of the
* fino:compress streaming factories.
*
* The writable side normalizes each BufferSource chunk to a `Uint8Array` view
* and pushes it into a buffered async-iterable channel. The factory's
* `transform()` consumes that channel, and its output iterable becomes the
* readable side via `ReadableStream.from()`. Closing the writable ends the
* channel so the transformer can flush its final block; aborting it fails the
* channel, which propagates the abort reason to the readable side.
*/
function _makeStreams(factory: () => {
  transform(input: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>;
}): {
  readable: ReadableStream;
  writable: WritableStream;
} {
  // ---- Input channel -------------------------------------------------------
  // A simple buffered async iterable. The WritableStream sink enqueues chunks
  // here; the compression generator pulls from here.
  const inputChunks: Uint8Array[] = [];
  let inputResolve: ((value: IteratorResult<Uint8Array>) => void) | null = null;
  let inputReject: ((reason?: unknown) => void) | null = null;
  let inputDone = false;
  let inputError: unknown = null;
  const inputIterable: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return { next(): Promise<IteratorResult<Uint8Array>> {
      if (inputChunks.length > 0) {
        return Promise.resolve({
          value: inputChunks.shift()!,
          done: false
        });
      }
      if (inputDone && inputError !== null) return Promise.reject(inputError);
      if (inputDone) return Promise.resolve({
        done: true,
        value: undefined
      });
      return new Promise(function parkInput(resolve, reject) {
        inputResolve = resolve;
        inputReject = reject;
      });
    } };
  } };
  function _enqueue(chunk: Uint8Array): void {
    if (inputResolve) {
      const r = inputResolve;
      inputResolve = null;
      inputReject = null;
      r({
        value: chunk,
        done: false
      });
    } else {
      inputChunks.push(chunk);
    }
  }
  function _close() {
    inputDone = true;
    if (inputResolve) {
      const r = inputResolve;
      inputResolve = null;
      inputReject = null;
      r({
        done: true,
        value: undefined
      });
    }
  }
  function _error(reason: unknown): void {
    inputDone = true;
    inputError = reason ?? new Error('stream aborted');
    if (inputReject) {
      const r = inputReject;
      inputResolve = null;
      inputReject = null;
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
    close() {
      _close();
    },
    abort(reason: unknown) {
      _error(reason);
    }
  }, undefined);
  // ---- Compression / decompression chain -----------------------------------
  const outputIterable = factory().transform(inputIterable);
  const readable = ReadableStream.from(outputIterable);
  return {
    readable,
    writable
  };
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
* Transforms a stream of bytes by compressing it using gzip, deflate,
* deflate-raw (raw DEFLATE without a wrapper), or Brotli.
*
* Available as a global — no import required. The usual shape is
* `source.pipeThrough(new CompressionStream(format))`, which yields a
* compressed byte stream ready for further piping:
*
* ```ts no_run
* const cs = new CompressionStream('gzip');
* readableSource.pipeThrough(cs);  // cs.readable yields compressed chunks
* ```
*
* For buffered use, write chunks through `writable` and collect `readable`:
*
* ```ts no_run
* const cs = new CompressionStream('gzip');
* const writer = cs.writable.getWriter();
* await writer.write(new TextEncoder().encode('hello '.repeat(1000)));
* await writer.close();
* const compressed = await new Response(cs.readable).bytes();
* ```
*
* Output is standard for each format: anything framed as gzip, deflate, or
* deflate-raw here is interchangeable with the one-shot
* `compress()`/`decompress()` functions in `fino:compress` and with any other
* conforming implementation.
*/
export class CompressionStream {
  /**
  * Compressed-output stream handed out by the `readable` getter; created once
  * in the constructor by the fino:compress bridge.
  *
  * @internal
  */
  #readable: ReadableStream;
  /**
  * Byte-input stream handed out by the `writable` getter; feeds the
  * compressor's input channel.
  *
  * @internal
  */
  #writable: WritableStream;
  /**
  * String tag used by Object.prototype.toString.
  *
  * ```ts no_run
  * const stream = new CompressionStream('gzip');
  * Object.prototype.toString.call(stream); // "[object CompressionStream]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'CompressionStream';
  }
  /**
  * Create a compression transform for the selected format.
  *
  * The writable side accepts BufferSource chunks and the readable side emits
  * compressed Uint8Array chunks.
  *
  * Throws TypeError if the format is not one of the supported names. Throws
  * if the format is `'brotli'` and the system Brotli library is unavailable —
  * portable code should check `brotliAvailable` from `fino:compress` first.
  *
  * ```ts no_run
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
  * Readable side that yields compressed bytes as Uint8Array chunks.
  *
  * Chunks become available as the compressor produces them. The stream closes
  * after the writable side is closed and all compressor output — including the
  * final flush block — has been emitted.
  *
  * ```ts no_run
  * const cs = new CompressionStream('deflate');
  * const compressed = cs.readable;
  * ```
  */
  get readable() {
    return this.#readable;
  }
  /**
  * Writable side that accepts uncompressed BufferSource chunks.
  *
  * Writing anything other than an ArrayBuffer or ArrayBufferView rejects the
  * write with TypeError. Closing this side completes the compression stream
  * and flushes final bytes; aborting it errors the readable side with the
  * abort reason.
  *
  * ```ts no_run
  * const cs = new CompressionStream('gzip');
  * const writer = cs.writable.getWriter();
  * await writer.write(new Uint8Array([1, 2, 3]));
  * await writer.close();
  * ```
  */
  get writable() {
    return this.#writable;
  }
}
/**
* Transforms a stream of compressed bytes (gzip, deflate, deflate-raw, or
* Brotli) into the original uncompressed data.
*
* Available as a global — no import required. Corrupt or truncated input does
* not throw synchronously: the error surfaces on the readable side when the
* backend decompressor detects it, rejecting the pending read or `pipeTo`
* promise.
*
* Matching the web API, there is no maximum output size option. When
* decompressing untrusted input, count bytes as you read and cancel the
* stream if an application budget is exceeded.
*
* ```ts no_run
* const ds = new DecompressionStream('gzip');
* compressedReadable.pipeThrough(ds);  // ds.readable yields decompressed chunks
* ```
*
* Decoding a fetched gzip payload to text:
*
* ```ts no_run
* const response = await fetch('https://example.com/logs.gz');
* const restored = response.body.pipeThrough(new DecompressionStream('gzip'));
* const text = await new Response(restored).text();
* ```
*/
export class DecompressionStream {
  /**
  * Decompressed-output stream handed out by the `readable` getter; created
  * once in the constructor by the fino:compress bridge.
  *
  * @internal
  */
  #readable: ReadableStream;
  /**
  * Compressed-input stream handed out by the `writable` getter; feeds the
  * decompressor's input channel.
  *
  * @internal
  */
  #writable: WritableStream;
  /**
  * String tag used by Object.prototype.toString.
  *
  * ```ts no_run
  * const stream = new DecompressionStream('gzip');
  * Object.prototype.toString.call(stream); // "[object DecompressionStream]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'DecompressionStream';
  }
  /**
  * Create a decompression transform for the selected format.
  *
  * The format must match how the input was actually compressed — the stream
  * does not sniff; mismatched or invalid compressed input causes the readable
  * side to error when the backend decompressor detects it.
  *
  * Throws TypeError if the format is not one of the supported names. Throws
  * if the format is `'brotli'` and the system Brotli library is unavailable.
  *
  * ```ts no_run
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
  * Readable side that yields decompressed bytes as Uint8Array chunks.
  *
  * Errors here if the compressed input is invalid for the selected format.
  *
  * ```ts no_run
  * const ds = new DecompressionStream('deflate-raw');
  * const output = ds.readable;
  * ```
  */
  get readable() {
    return this.#readable;
  }
  /**
  * Writable side that accepts compressed BufferSource chunks.
  *
  * Chunk boundaries do not matter — compressed input may be split anywhere.
  * Close the writer to finish the decompressor and surface final output or
  * truncation errors.
  *
  * ```ts no_run
  * const ds = new DecompressionStream('gzip');
  * const writer = ds.writable.getWriter();
  * await writer.write(compressedBytes);
  * await writer.close();
  * ```
  */
  get writable() {
    return this.#writable;
  }
}
