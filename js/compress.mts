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
  type CompressOptions,
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
  ByteInput,
  CompressOptions,
  CompressionFormat,
  DecompressOptions,
} from './internal/compress/common.mts';

/** `true` when the Brotli encoder and decoder backend libraries are available. */
export const brotliAvailable = internalBrotliAvailable;

/** Compress one byte buffer and return a single compressed byte array. */
export function compress(data: ByteInput, options: CompressOptions): Uint8Array {
  const opts = validateCompressOptions(options);
  if (opts.format === 'brotli') return brotliCompress(data, opts);
  return zlibCompress(data, assertZlibFormat(opts.format), opts);
}

/** Decompress one byte buffer and return a single decompressed byte array. */
export function decompress(data: ByteInput, options: DecompressOptions): Uint8Array {
  const opts = validateDecompressOptions(options);
  if (opts.format === 'brotli') return brotliDecompress(data);
  return zlibDecompress(data, assertZlibFormat(opts.format));
}

/** Stateful compressor for chunked writes or async iterable transforms. */
export class Compressor implements CompressionTransform {
  #impl: CompressionTransform;

  constructor(options: CompressOptions) {
    const opts = validateCompressOptions(options);
    this.#impl = opts.format === 'brotli'
      ? new BrotliCompressor(opts)
      : new ZlibCompressor(assertZlibFormat(opts.format), opts.level);
  }

  /** Compress a chunk and return any output currently available. */
  write(chunk: ByteInput): Uint8Array[] {
    return this.#impl.write(chunk);
  }

  /** Finish the stream and return final output chunks. */
  finish(): Uint8Array[] {
    return this.#impl.finish();
  }

  /** Transform an async iterable of byte chunks into compressed chunks. */
  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array> {
    return this.#impl.transform(source);
  }

  /** Release native compression state. */
  close(): void {
    this.#impl.close();
  }
}

/** Stateful decompressor for chunked writes or async iterable transforms. */
export class Decompressor implements CompressionTransform {
  #impl: CompressionTransform;

  constructor(options: DecompressOptions) {
    const opts = validateDecompressOptions(options);
    this.#impl = opts.format === 'brotli'
      ? new BrotliDecompressor()
      : new ZlibDecompressor(assertZlibFormat(opts.format));
  }

  /** Decompress a chunk and return any output currently available. */
  write(chunk: ByteInput): Uint8Array[] {
    return this.#impl.write(chunk);
  }

  /** Finish the stream and return final output chunks. */
  finish(): Uint8Array[] {
    return this.#impl.finish();
  }

  /** Transform an async iterable of compressed chunks into decompressed chunks. */
  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array> {
    return this.#impl.transform(source);
  }

  /** Release native decompression state. */
  close(): void {
    this.#impl.close();
  }
}

/** Create a stateful compressor for the requested format. */
export function createCompressor(options: CompressOptions): Compressor {
  return new Compressor(options);
}

/** Create a stateful decompressor for the requested format. */
export function createDecompressor(options: DecompressOptions): Decompressor {
  return new Decompressor(options);
}
