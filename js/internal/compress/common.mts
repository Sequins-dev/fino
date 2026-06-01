export type CompressionFormat = 'gzip' | 'deflate' | 'deflate-raw' | 'brotli';
export type ZlibCompressionFormat = Exclude<CompressionFormat, 'brotli'>;
export type ByteInput = Uint8Array | ArrayBuffer;

export interface CompressOptions {
  format: CompressionFormat;
  level?: number;
}

export interface DecompressOptions {
  format: CompressionFormat;
}

export interface CompressionTransform {
  write(chunk: ByteInput): Uint8Array[];
  finish(): Uint8Array[];
  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array>;
  close(): void;
}

export function toU8(data: ByteInput): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

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

export function validateFormat(format: unknown): CompressionFormat {
  if (format === 'gzip' || format === 'deflate' || format === 'deflate-raw' || format === 'brotli') {
    return format;
  }
  throw new TypeError(`unsupported compression format '${String(format)}'`);
}

export function validateCompressOptions(options: CompressOptions): CompressOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('compress options must be an object');
  }
  return { ...options, format: validateFormat(options.format) };
}

export function validateDecompressOptions(options: DecompressOptions): DecompressOptions {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('decompress options must be an object');
  }
  return { ...options, format: validateFormat(options.format) };
}

export function assertZlibFormat(format: CompressionFormat): ZlibCompressionFormat {
  if (format === 'brotli') throw new TypeError(`unsupported zlib compression format '${format}'`);
  return format;
}
