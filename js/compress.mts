import {
  assertZlibFormat,
  validateCompressOptions,
  validateDecompressOptions,
  type ByteInput,
  type CompressOptions,
  type CompressionFormat,
  type CompressionTransform,
  type DecompressOptions,
} from './internal/compress/common.mts';
import { zlibCompress, zlibDecompress, ZlibCompressor, ZlibDecompressor } from './internal/compress/zlib.mts';
import {
  brotliAvailable,
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
};
export { brotliAvailable };

export function compress(data: ByteInput, options: CompressOptions): Uint8Array {
  const opts = validateCompressOptions(options);
  if (opts.format === 'brotli') return brotliCompress(data, opts);
  return zlibCompress(data, assertZlibFormat(opts.format), opts);
}

export function decompress(data: ByteInput, options: DecompressOptions): Uint8Array {
  const opts = validateDecompressOptions(options);
  if (opts.format === 'brotli') return brotliDecompress(data);
  return zlibDecompress(data, assertZlibFormat(opts.format));
}

export class Compressor implements CompressionTransform {
  #impl: CompressionTransform;

  constructor(options: CompressOptions) {
    const opts = validateCompressOptions(options);
    this.#impl = opts.format === 'brotli'
      ? new BrotliCompressor(opts)
      : new ZlibCompressor(assertZlibFormat(opts.format), opts.level);
  }

  write(chunk: ByteInput): Uint8Array[] {
    return this.#impl.write(chunk);
  }

  finish(): Uint8Array[] {
    return this.#impl.finish();
  }

  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array> {
    return this.#impl.transform(source);
  }

  close(): void {
    this.#impl.close();
  }
}

export class Decompressor implements CompressionTransform {
  #impl: CompressionTransform;

  constructor(options: DecompressOptions) {
    const opts = validateDecompressOptions(options);
    this.#impl = opts.format === 'brotli'
      ? new BrotliDecompressor()
      : new ZlibDecompressor(assertZlibFormat(opts.format));
  }

  write(chunk: ByteInput): Uint8Array[] {
    return this.#impl.write(chunk);
  }

  finish(): Uint8Array[] {
    return this.#impl.finish();
  }

  transform(source: AsyncIterable<ByteInput>): AsyncIterable<Uint8Array> {
    return this.#impl.transform(source);
  }

  close(): void {
    this.#impl.close();
  }
}

export function createCompressor(options: CompressOptions): Compressor {
  return new Compressor(options);
}

export function createDecompressor(options: DecompressOptions): Decompressor {
  return new Decompressor(options);
}
