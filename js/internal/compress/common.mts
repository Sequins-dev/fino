/**
 * Shared compression contracts and validation helpers.
 *
 * These declarations back `fino:compress` but are not an application-facing
 * module. Public aliases are documented from `fino:compress` so generated docs
 * do not need to expose this internal implementation path.
 *
 * ## Example
 *
 * ```typescript no_run
 * import * as common from 'internal:compress/common';
 *
 * const options = common.validateCompressOptions({ format: 'gzip', level: 6 });
 * const input = common.toU8(new TextEncoder().encode('payload'));
 * const output = common.concat([input]);
 * console.assert(options.format === 'gzip' && output.byteLength === input.byteLength);
 * ```
 *
 * @internal
 */

/**
 * Compression formats accepted by `fino:compress`.
 *
 * `gzip`, `deflate`, and `deflate-raw` are handled by zlib. `brotli` is
 * handled by the Brotli backend and may be unavailable when system libraries
 * cannot be loaded.
 *
 * ```typescript no_run
 * import type { CompressionFormat } from 'internal:compress/common';
 * const format: CompressionFormat = 'gzip';
 * ```
 *
 * @internal
 */
export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli';

/**
 * Compression formats implemented by the zlib backend.
 *
 * This narrows `CompressionFormat` by excluding Brotli before dispatching to
 * zlib. Passing Brotli to zlib helpers throws before native calls are made.
 *
 * ```typescript no_run
 * import type { ZlibCompressionFormat } from 'internal:compress/common';
 * const format: ZlibCompressionFormat = 'deflate';
 * ```
 *
 * @internal
 */
export type ZlibCompressionFormat = Exclude<CompressionFormat, 'brotli'>;

/**
 * Binary input accepted by compression helpers.
 *
 * `Uint8Array` values are used directly; `ArrayBuffer` values become views.
 * Strings are intentionally not accepted here so callers choose their own text
 * encoding before compression.
 *
 * ```typescript no_run
 * import type { ByteInput } from 'internal:compress/common';
 * const input: ByteInput = new Uint8Array([1, 2, 3]);
 * ```
 *
 * @internal
 */
export type ByteInput = Uint8Array | ArrayBuffer;

/**
 * Options for one-shot or streaming compression.
 *
 * `format` is required. `level` is backend-specific and optional; zlib accepts
 * its normal level range and Brotli interprets it as quality.
 *
 * ```typescript no_run
 * import type { CompressOptions } from 'internal:compress/common';
 * const opts: CompressOptions = { format: 'gzip', level: 6 };
 * ```
 *
 * @internal
 */
export interface CompressOptions {
  /**
   * Compression format to use.
   *
   * ```typescript no_run
   * import type { CompressOptions } from 'internal:compress/common';
   * const options: CompressOptions = { format: 'brotli' };
   * options.format;
   * ```
   */
  format: CompressionFormat;
  /**
   * Optional backend compression level.
   *
   * Omitted values use backend defaults. Invalid ranges are currently left to
   * the native backend to reject.
   *
   * ```typescript no_run
   * import type { CompressOptions } from 'internal:compress/common';
   * const options: CompressOptions = { format: 'deflate', level: 1 };
   * options.level;
   * ```
   */
  level?: number;
}

/**
 * Options for one-shot or streaming decompression.
 *
 * Only `format` is accepted because decompression does not use a level.
 *
 * ```typescript no_run
 * import type { DecompressOptions } from 'internal:compress/common';
 * const opts: DecompressOptions = { format: 'deflate-raw' };
 * ```
 *
 * @internal
 */
export interface DecompressOptions {
  /**
   * Compression format expected in the input stream.
   *
   * ```typescript no_run
   * import type { DecompressOptions } from 'internal:compress/common';
   * const options: DecompressOptions = { format: 'gzip' };
   * options.format;
   * ```
   */
  format: CompressionFormat;
}

/**
 * Stateful compressor/decompressor interface shared by backends.
 *
 * `write` may return zero or more chunks for each input. `finish` finalizes the
 * stream and closes native state. Calling methods after close may throw.
 *
 * ```typescript no_run
 * import * as common from 'internal:compress/common';
 * function drain(codec: common.CompressionTransform, chunk: common.ByteInput) {
 *   return [...codec.write(chunk), ...codec.finish()];
 * }
 * ```
 *
 * @internal
 */
export interface CompressionTransform {
  /**
   * Feed one binary chunk and return produced output chunks.
   *
   * ```typescript no_run
   * const parts = codec.write(new Uint8Array([1, 2, 3]));
   * ```
   */
  write(chunk: ByteInput): Uint8Array[];
  /**
   * Finish the stream and return final output chunks.
   *
   * ```typescript no_run
   * const finalParts = codec.finish();
   * ```
   */
  finish(): Uint8Array[];
  /**
   * Transform an async iterable of input chunks into output chunks.
   *
   * The implementation closes the codec in a `finally` block, including when
   * the consumer stops early.
   *
   * ```typescript no_run
   * for await (const part of codec.transform(source)) {
   *   void part;
   * }
   * ```
   */
  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array>;
  /**
   * Release native codec state.
   *
   * Multiple calls should be harmless for concrete codecs unless native state
   * has already been destroyed by `finish`.
   *
   * ```typescript no_run
   * codec.close();
   * ```
   */
  close(): void;
}

/**
 * Convert accepted binary input into a `Uint8Array` view.
 *
 * `Uint8Array` inputs are returned unchanged. `ArrayBuffer` inputs share memory
 * with the returned view.
 *
 * ```typescript no_run
 * import { toU8 } from 'internal:compress/common';
 * const view = toU8(new ArrayBuffer(4));
 * ```
 *
 * @internal
 */
export function toU8(data: ByteInput): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('compression binary input must be a Uint8Array or ArrayBuffer');
}

/**
 * Concatenate output chunks into one `Uint8Array`.
 *
 * When `total` is omitted the byte length is computed from the parts. Empty
 * inputs return an empty array; a single input is returned as-is.
 *
 * ```typescript no_run
 * import { concat } from 'internal:compress/common';
 * const bytes = concat([new Uint8Array([1]), new Uint8Array([2])]);
 * ```
 *
 * @internal
 */
export function concat(parts: Uint8Array[], total?: number): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0] ?? new Uint8Array(0);
  let size = total;
  if (size === undefined) {
    size = 0;
    for (const part of parts) size += part.byteLength;
  }
  const out = new Uint8Array(size);
  let pos = 0;
  for (const part of parts) { out.set(part, pos); pos += part.byteLength; }
  return out;
}

/**
 * Validate and return a supported compression format.
 *
 * Throws `TypeError` for unknown values. The return type is narrowed to
 * `CompressionFormat`.
 *
 * ```typescript no_run
 * import { validateFormat } from 'internal:compress/common';
 * const format = validateFormat('gzip');
 * ```
 *
 * @internal
 */
export function validateFormat(format: unknown): CompressionFormat {
  if (format === 'gzip' || format === 'deflate' || format === 'deflate-raw' || format === 'brotli') {
    return format;
  }
  throw new TypeError(`unsupported compression format '${String(format)}'`);
}

/**
 * Validate compression options.
 *
 * Requires an object and validates `format`. Other fields are shallow-copied
 * through unchanged so backend-specific options can be added later.
 *
 * ```typescript no_run
 * import { validateCompressOptions } from 'internal:compress/common';
 * const opts = validateCompressOptions({ format: 'brotli', level: 5 });
 * ```
 *
 * @internal
 */
export function validateCompressOptions(options: CompressOptions): CompressOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('compress options must be an object');
  }
  return { ...options, format: validateFormat(options.format) };
}

/**
 * Validate decompression options.
 *
 * Requires an object and validates `format`. Throws `TypeError` for `null`,
 * primitives, or unsupported formats.
 *
 * ```typescript no_run
 * import { validateDecompressOptions } from 'internal:compress/common';
 * const opts = validateDecompressOptions({ format: 'deflate' });
 * ```
 *
 * @internal
 */
export function validateDecompressOptions(options: DecompressOptions): DecompressOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('decompress options must be an object');
  }
  return { ...options, format: validateFormat(options.format) };
}

/**
 * Narrow a non-Brotli format for zlib-backed operations.
 *
 * Returns the original format when zlib can handle it. Passing `brotli` throws
 * `TypeError` before native zlib is invoked.
 *
 * ```typescript no_run
 * import { assertZlibFormat } from 'internal:compress/common';
 * const zlibFormat = assertZlibFormat('gzip');
 * ```
 *
 * @internal
 */
export function assertZlibFormat(format: CompressionFormat): ZlibCompressionFormat {
  if (format === 'brotli') throw new TypeError(`unsupported zlib compression format '${format}'`);
  return format;
}
