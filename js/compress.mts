/**
 * fino:compress — one-shot and streaming compression helpers.
 *
 * This module exposes the compression formats commonly used by HTTP payloads,
 * archive formats, and data interchange tools: gzip, zlib-wrapped deflate,
 * raw deflate, and Brotli. The one-shot helpers are convenient when the entire
 * input already fits in memory. The `Compressor` and `Decompressor` classes
 * support incremental writes and async iterable transforms for pipelines that
 * produce or consume chunks over time.
 *
 * Format names map to the wire formats rather than implementation details:
 *   - `gzip`: RFC 1952 gzip member format.
 *   - `deflate`: RFC 1950 zlib wrapper around RFC 1951 DEFLATE data.
 *   - `deflate-raw`: raw RFC 1951 DEFLATE stream with no wrapper.
 *   - `brotli`: RFC 7932 Brotli stream when the runtime Brotli backend is
 *     available.
 *
 * `compress()` and `decompress()` return a single `Uint8Array`. Streaming
 * objects return arrays of output chunks from `write()` and `finish()` because
 * compressors may buffer internally and may produce zero, one, or many chunks
 * for each input chunk. Always call `finish()` before using the final output,
 * and call `close()` when abandoning a stream early.
 *
 * The release option surface is intentionally compact: `format` is required,
 * `level` is the only compression tuning option, and byte input must be a
 * `Uint8Array` or `ArrayBuffer`. Dictionaries, custom flush strategy, window
 * tuning, zlib constants, and public output-limit controls are not exposed.
 * Use one-shot `decompress()` only for trusted or externally bounded input.
 * For untrusted compressed data, prefer `Decompressor.transform()` and enforce
 * an application byte budget while consuming yielded chunks.
 *
 * ## Examples
 *
 * ```ts no_run
 * import { compress, decompress } from 'fino:compress';
 *
 * const encoded = new TextEncoder().encode('hello');
 * const gzipped = compress(encoded, { format: 'gzip', level: 6 });
 * const plain = decompress(gzipped, { format: 'gzip' });
 * ```
 *
 * ```ts no_run
 * import { Compressor } from 'fino:compress';
 *
 * const compressor = new Compressor({ format: 'deflate' });
 * const chunks = [
 *   ...compressor.write(new TextEncoder().encode('part one')),
 *   ...compressor.write(new TextEncoder().encode('part two')),
 *   ...compressor.finish(),
 * ];
 * compressor.close();
 * ```
 *
 * ```ts no_run
 * import { createDecompressor } from 'fino:compress';
 *
 * const decoder = createDecompressor({ format: 'brotli' });
 * for await (const chunk of decoder.transform(compressedChunks)) {
 *   await output.write(chunk);
 * }
 * decoder.close();
 * ```
 *
 * Useful references:
 *   - zlib format: https://www.rfc-editor.org/rfc/rfc1950
 *   - DEFLATE format: https://www.rfc-editor.org/rfc/rfc1951
 *   - gzip format: https://www.rfc-editor.org/rfc/rfc1952
 *   - Brotli format: https://www.rfc-editor.org/rfc/rfc7932
 */

import {
  assertZlibFormat,
  validateCompressOptions,
  validateDecompressOptions,
  type ByteInput,
  type CompressOptions as InternalCompressOptions,
  type CompressionTransform,
  type DecompressOptions,
} from './internal/compress/common.mts';
import { zlibCompress, zlibDecompress, ZlibCompressor, ZlibDecompressor } from './internal/compress/zlib.mts';
import {
  brotliAvailable as internalBrotliAvailable,
  brotliCompress,
  brotliDecompress,
  BrotliCompressor,
  BrotliDecompressor,
} from './internal/compress/brotli.mts';

export type {
  /**
   * Binary input accepted by compression helpers.
   *
   * `Uint8Array` inputs are used as-is. `ArrayBuffer` inputs are wrapped in a
   * byte view. The helpers do not accept strings; encode text explicitly.
   *
   * ```ts no_run
   * const input = new TextEncoder().encode('hello');
   * console.log(input.byteLength);
   * ```
   */
  ByteInput,
  /**
   * Supported compression wire formats.
   *
   * `gzip`, `deflate`, and `deflate-raw` are zlib-backed formats. `brotli`
   * requires Brotli backend support; check `brotliAvailable` before selecting
   * it dynamically.
   *
   * ```ts no_run
   * const format = 'deflate-raw';
   * console.log(format);
   * ```
   */
  CompressionFormat,
  /**
   * Options for one-shot and streaming decompression.
   *
   * `format` must match the compressed byte stream. Passing the wrong format
   * raises a backend decompression error rather than returning partial data.
   *
   * ```ts no_run
   * const options = { format: 'gzip' };
   * console.log(options.format);
   * ```
   */
  DecompressOptions,
} from './internal/compress/common.mts';

/**
 * Options for one-shot and streaming compression.
 *
 * `format` selects the wire format to produce and is required for all public
 * compression helpers. `level` is optional and backend-dependent: zlib formats
 * use the usual compression level range, while Brotli support depends on the
 * runtime Brotli backend being available. Invalid options throw `TypeError`
 * before native compression is attempted.
 *
 * ```ts no_run
 * import { compress, type CompressOptions } from 'fino:compress';
 *
 * const options: CompressOptions = { format: 'gzip', level: 6 };
 * const output = compress(new TextEncoder().encode('hello'), options);
 * console.log(output.byteLength);
 * ```
 */
export type CompressOptions = InternalCompressOptions;

export type {
  /**
   * Internal streaming backend contract shared by concrete compressor classes.
   *
   * Public code usually uses `Compressor` or `Decompressor` instead of this
   * low-level transform shape.
   *
   * ```ts no_run
   * const transformName = 'CompressionTransform';
   * console.log(transformName);
   * ```
   *
   * @internal
   */
  CompressionTransform,
} from './internal/compress/common.mts';

/**
 * `true` when the Brotli encoder and decoder backend libraries are available.
 *
 * Use this before selecting `{ format: 'brotli' }` in portable code. When this
 * value is false, Brotli operations throw from the underlying backend.
 *
 * ```ts no_run
 * import { brotliAvailable, compress } from 'fino:compress';
 *
 * const format = brotliAvailable ? 'brotli' : 'gzip';
 * const bytes = compress(new Uint8Array([1, 2, 3]), { format });
 * console.log(bytes.byteLength);
 * ```
 */
export const brotliAvailable = internalBrotliAvailable;

/**
 * Compress one byte buffer and return a single compressed byte array.
 *
 * This one-shot helper keeps both input and output in memory. `options.format`
 * is required, and invalid options throw `TypeError`. Backend compression
 * failures propagate as errors.
 *
 * @param {ByteInput} data Bytes to compress.
 * @param {CompressOptions} options Compression format and optional level.
 * @returns {Uint8Array} Complete compressed byte stream.
 *
 * ```ts no_run
 * import { compress } from 'fino:compress';
 *
 * const input = new TextEncoder().encode('hello');
 * const gzipped = compress(input, { format: 'gzip', level: 6 });
 * console.log(gzipped.byteLength);
 * ```
 */
export function compress(data: ByteInput, options: CompressOptions): Uint8Array {
  const opts = validateCompressOptions(options);
  if (opts.format === 'brotli') return brotliCompress(data, opts);
  return zlibCompress(data, assertZlibFormat(opts.format), opts);
}

/**
 * Decompress one byte buffer and return a single decompressed byte array.
 *
 * The input format must match `options.format`. The helper keeps the full
 * decompressed output in memory and throws when the stream is invalid,
 * truncated, or uses a format that is unavailable. It does not cap the
 * decompressed output size; callers should use streaming decompression when
 * handling untrusted or potentially large compressed input.
 *
 * @param {ByteInput} data Compressed bytes.
 * @param {DecompressOptions} options Decompression format.
 * @returns {Uint8Array} Complete decompressed bytes.
 *
 * ```ts no_run
 * import { compress, decompress } from 'fino:compress';
 *
 * const packed = compress(new Uint8Array([1, 2, 3]), { format: 'deflate' });
 * const plain = decompress(packed, { format: 'deflate' });
 * console.log(plain.length);
 * ```
 */
export function decompress(data: ByteInput, options: DecompressOptions): Uint8Array {
  const opts = validateDecompressOptions(options);
  if (opts.format === 'brotli') return brotliDecompress(data);
  return zlibDecompress(data, assertZlibFormat(opts.format));
}

/**
 * Stateful compressor for chunked writes or async iterable transforms.
 *
 * A compressor may buffer internally and return zero or more output chunks for
 * each `write()`. Always call `finish()` to flush final bytes. Call `close()`
 * when abandoning the stream early.
 *
 * ```ts no_run
 * import { Compressor } from 'fino:compress';
 *
 * const compressor = new Compressor({ format: 'gzip' });
 * const chunks = [
 *   ...compressor.write(new Uint8Array([1, 2])),
 *   ...compressor.finish(),
 * ];
 * compressor.close();
 * console.log(chunks.length);
 * ```
 */
export class Compressor implements CompressionTransform {
  /**
   * Private property `#impl` used by `Compressor`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #impl = undefined;
   *
   *   readInternalState() {
   *     return this.#impl;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #impl: CompressionTransform;

  /**
   * Create a compressor for the requested format.
   *
   * Invalid options throw `TypeError`. Brotli construction requires the Brotli
   * backend to be available. The created compressor owns native state until
   * `finish()` or `close()` is called.
   *
   * @param {CompressOptions} options Compression format and optional level.
   *
   * ```ts no_run
   * import { Compressor } from 'fino:compress';
   *
   * const compressor = new Compressor({ format: 'deflate-raw' });
   * compressor.close();
   * ```
   */
  constructor(options: CompressOptions) {
    const opts = validateCompressOptions(options);
    this.#impl = opts.format === 'brotli'
      ? new BrotliCompressor(opts)
      : new ZlibCompressor(assertZlibFormat(opts.format), opts.level);
  }

  /**
   * Compress a chunk and return any output currently available.
   *
   * The returned array may be empty when the backend buffers data. Do not treat
   * an empty array as EOF; call `finish()` when no more input remains.
   *
   * @param {ByteInput} chunk Bytes to append to the compression stream.
   * @returns {Uint8Array[]} Zero or more compressed chunks.
   *
   * ```ts no_run
   * import { Compressor } from 'fino:compress';
   *
   * const compressor = new Compressor({ format: 'gzip' });
   * const chunks = compressor.write(new Uint8Array([1, 2, 3]));
   * chunks.push(...compressor.finish());
   * compressor.close();
   * ```
   */
  write(chunk: ByteInput): Uint8Array[] {
    return this.#impl.write(chunk);
  }

  /**
   * Finish the compression stream and return final output chunks.
   *
   * Call this exactly once after all writes. It flushes backend state and may
   * return zero or more chunks. Writing after finish is backend-dependent and
   * should be avoided; create a new compressor for a new stream.
   *
   * @returns {Uint8Array[]} Final compressed chunks.
   *
   * ```ts no_run
   * import { Compressor } from 'fino:compress';
   *
   * const compressor = new Compressor({ format: 'deflate' });
   * const finalChunks = compressor.finish();
   * compressor.close();
   * console.log(finalChunks.length);
   * ```
   */
  finish(): Uint8Array[] {
    return this.#impl.finish();
  }

  /**
   * Transform an async iterable of byte chunks into compressed chunks.
   *
   * Output chunks are yielded as the backend produces them, followed by final
   * flush chunks. Errors from the source iterable or compression backend
   * propagate through iteration.
   *
   * @param {AsyncIterable<ByteInput>} source Source byte chunks.
   * @returns {AsyncIterable<Uint8Array>} Async iterable of compressed chunks.
   *
   * ```ts no_run
   * import { Compressor } from 'fino:compress';
   *
   * async function* source() {
   *   yield new Uint8Array([1, 2, 3]);
   * }
   * const compressor = new Compressor({ format: 'gzip' });
   * for await (const chunk of compressor.transform(source())) {
   *   console.log(chunk.byteLength);
   * }
   * compressor.close();
   * ```
   */
  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array> {
    return this.#impl.transform(source);
  }

  /**
   * Release native compression state.
   *
   * Use `close()` when abandoning a compressor before `finish()`, or after
   * consuming a transformed stream. Repeated calls are delegated to the backend.
   *
   * ```ts no_run
   * import { Compressor } from 'fino:compress';
   *
   * const compressor = new Compressor({ format: 'gzip' });
   * compressor.close();
   * ```
   */
  close(): void {
    this.#impl.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Stateful decompressor for chunked writes or async iterable transforms.
 *
 * A decompressor may buffer partial frames internally. Always call `finish()`
 * after the last compressed chunk so truncated streams are detected and final
 * output is flushed. The decompressor does not enforce an output-size limit;
 * count returned chunk sizes in the caller when processing untrusted input.
 *
 * ```ts no_run
 * import { Decompressor, compress } from 'fino:compress';
 *
 * const packed = compress(new Uint8Array([1, 2]), { format: 'gzip' });
 * const decompressor = new Decompressor({ format: 'gzip' });
 * const chunks = [...decompressor.write(packed), ...decompressor.finish()];
 * decompressor.close();
 * console.log(chunks.length);
 * ```
 */
export class Decompressor implements CompressionTransform {
  /**
   * Private property `#impl` used by `Decompressor`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #impl = undefined;
   *
   *   readInternalState() {
   *     return this.#impl;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #impl: CompressionTransform;

  /**
   * Create a decompressor for the requested format.
   *
   * `options.format` must match the compressed stream. Invalid options throw
   * `TypeError`; unavailable Brotli support throws from the Brotli backend.
   *
   * @param {DecompressOptions} options Decompression format.
   *
   * ```ts no_run
   * import { Decompressor } from 'fino:compress';
   *
   * const decompressor = new Decompressor({ format: 'deflate' });
   * decompressor.close();
   * ```
   */
  constructor(options: DecompressOptions) {
    const opts = validateDecompressOptions(options);
    this.#impl = opts.format === 'brotli'
      ? new BrotliDecompressor()
      : new ZlibDecompressor(assertZlibFormat(opts.format));
  }

  /**
   * Decompress a chunk and return any output currently available.
   *
   * The returned array may be empty while the backend waits for more input.
   * Invalid or mismatched compressed data throws.
   *
   * @param {ByteInput} chunk Compressed bytes to append.
   * @returns {Uint8Array[]} Zero or more decompressed chunks.
   *
   * ```ts no_run
   * import { Decompressor, compress } from 'fino:compress';
   *
   * const packed = compress(new Uint8Array([1]), { format: 'gzip' });
   * const decompressor = new Decompressor({ format: 'gzip' });
   * const chunks = decompressor.write(packed);
   * chunks.push(...decompressor.finish());
   * decompressor.close();
   * ```
   */
  write(chunk: ByteInput): Uint8Array[] {
    return this.#impl.write(chunk);
  }

  /**
   * Finish the decompression stream and return final output chunks.
   *
   * This checks for a complete compressed stream and flushes pending output.
   * Truncated data or malformed trailing state throws.
   *
   * @returns {Uint8Array[]} Final decompressed chunks.
   *
   * ```ts no_run
   * import { Decompressor } from 'fino:compress';
   *
   * const decompressor = new Decompressor({ format: 'gzip' });
   * const finalChunks = decompressor.finish();
   * decompressor.close();
   * console.log(finalChunks.length);
   * ```
   */
  finish(): Uint8Array[] {
    return this.#impl.finish();
  }

  /**
   * Transform an async iterable of compressed chunks into decompressed chunks.
   *
   * The returned iterable yields output as it becomes available and validates
   * the end of stream when the source completes. Source and backend errors
   * propagate through iteration.
   *
   * @param {AsyncIterable<ByteInput>} source Source compressed chunks.
   * @returns {AsyncIterable<Uint8Array>} Async iterable of decompressed chunks.
   *
   * ```ts no_run
   * import { Decompressor } from 'fino:compress';
   *
   * async function* compressedChunks() {
   *   yield new Uint8Array();
   * }
   * const decompressor = new Decompressor({ format: 'gzip' });
   * for await (const chunk of decompressor.transform(compressedChunks())) {
   *   console.log(chunk.byteLength);
   * }
   * decompressor.close();
   * ```
   */
  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array> {
    return this.#impl.transform(source);
  }

  /**
   * Release native decompression state.
   *
   * Call this when abandoning a stream early or after a transform has finished.
   * Repeated calls are delegated to the backend.
   *
   * ```ts no_run
   * import { Decompressor } from 'fino:compress';
   *
   * const decompressor = new Decompressor({ format: 'deflate-raw' });
   * decompressor.close();
   * ```
   */
  close(): void {
    this.#impl.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

/**
 * Create a stateful compressor for the requested format.
 *
 * This is a factory wrapper around `new Compressor(options)`. It returns an
 * object that must be finished or closed to release backend state.
 *
 * @param {CompressOptions} options Compression format and optional level.
 * @returns {Compressor} New stateful compressor.
 *
 * ```ts no_run
 * import { createCompressor } from 'fino:compress';
 *
 * const compressor = createCompressor({ format: 'gzip' });
 * compressor.close();
 * ```
 */
export function createCompressor(options: CompressOptions): Compressor {
  return new Compressor(options);
}

/**
 * Create a stateful decompressor for the requested format.
 *
 * This is a factory wrapper around `new Decompressor(options)`. The selected
 * format must match the stream that will be written.
 *
 * @param {DecompressOptions} options Decompression format.
 * @returns {Decompressor} New stateful decompressor.
 *
 * ```ts no_run
 * import { createDecompressor } from 'fino:compress';
 *
 * const decompressor = createDecompressor({ format: 'gzip' });
 * decompressor.close();
 * ```
 */
export function createDecompressor(options: DecompressOptions): Decompressor {
  return new Decompressor(options);
}
