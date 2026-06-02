/**
 * Shared compression contracts and validation helpers.
 *
 * These declarations back `fino:compress` but are not an application-facing
 * module. Public aliases are documented from `fino:compress` so generated docs
 * do not need to expose this internal implementation path.
 *
 * @internal
 */

/** Compression formats accepted by `fino:compress`. */
export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli';

/** @internal Compression formats implemented by the zlib backend. */
export type ZlibCompressionFormat = Exclude<CompressionFormat, 'brotli'>;

/** Binary input accepted by compression helpers. */
export type ByteInput = Uint8Array | ArrayBuffer;

/** Options for one-shot or streaming compression. */
export interface CompressOptions {
  format: CompressionFormat;
  level?: number;
}

/** Options for one-shot or streaming decompression. */
export interface DecompressOptions {
  format: CompressionFormat;
}

/** @internal Stateful compressor/decompressor interface shared by backends. */
export interface CompressionTransform {
  write(chunk: ByteInput): Uint8Array[];
  finish(): Uint8Array[];
  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array>;
  close(): void;
}

/** @internal Convert accepted binary input into a `Uint8Array` view. */
export function toU8(data: ByteInput): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** @internal Concatenate output chunks into one `Uint8Array`. */
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

/** @internal Validate and return a supported compression format. */
export function validateFormat(format: unknown): CompressionFormat {
  if (format === 'gzip' || format === 'deflate' || format === 'deflate-raw' || format === 'brotli') {
    return format;
  }
  throw new TypeError(`unsupported compression format '${String(format)}'`);
}

/** @internal Validate compression options, throwing `TypeError` for invalid input. */
export function validateCompressOptions(options: CompressOptions): CompressOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('compress options must be an object');
  }
  return { ...options, format: validateFormat(options.format) };
}

/** @internal Validate decompression options, throwing `TypeError` for invalid input. */
export function validateDecompressOptions(options: DecompressOptions): DecompressOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('decompress options must be an object');
  }
  return { ...options, format: validateFormat(options.format) };
}

/** @internal Narrow a non-Brotli format for zlib-backed operations. */
export function assertZlibFormat(format: CompressionFormat): ZlibCompressionFormat {
  if (format === 'brotli') throw new TypeError(`unsupported zlib compression format '${format}'`);
  return format;
}
