/**
* Snappy compression backend for `fino:compress`.
*
* Loads the platform `libsnappy` through `fino:ffi` and implements the Snappy
* raw block format (the format Apache Parquet uses for page compression, and
* the one `snappy_compress`/`snappy_uncompress` produce and consume). Snappy is
* a block codec, not a stream codec: the one-shot helpers compress/decompress a
* whole buffer, and the streaming `Compressor`/`Decompressor` buffer their
* input and emit a single block on `finish()`.
*
* Hidden from generated application docs; availability and options are
* documented on `fino:compress`.
*
* ## Example
*
* ```typescript no_run
* import * as snappy from 'internal:compress/snappy';
*
* if (snappy.snappyAvailable) {
*   const input = new TextEncoder().encode('payload');
*   const compressed = snappy.snappyCompress(input);
*   const restored = snappy.snappyDecompress(compressed);
*   console.assert(new TextDecoder().decode(restored) === 'payload');
* }
* ```
*
* @internal
*/
import { dlopen, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
import { concat, toU8, type ByteInput, type CompressionTransform } from './common.ts';
const isDarwin = os === 'darwin';
function tryOpen<TSymbols extends NativeSymbolMap>(paths: string[], symbols: TSymbols): DynamicLibrary<TSymbols> | null {
  for (const p of paths) {
    try {
      return dlopen(p, symbols);
    } catch (_) {}
  }
  return null;
}
const snappyPaths = isDarwin ? [
  '/opt/homebrew/lib/libsnappy.dylib',
  '/usr/local/lib/libsnappy.dylib',
  'libsnappy.dylib'
] : ['libsnappy.so.1', 'libsnappy.so'];
const snappySymbols = {
  snappy_compress: {
    parameters: [
      'buffer',
      'usize',
      'buffer',
      'buffer'
    ],
    result: 'i32'
  },
  snappy_uncompress: {
    parameters: [
      'buffer',
      'usize',
      'buffer',
      'buffer'
    ],
    result: 'i32'
  },
  snappy_max_compressed_length: {
    parameters: ['usize'],
    result: 'usize'
  },
  snappy_uncompressed_length: {
    parameters: [
      'buffer',
      'usize',
      'buffer'
    ],
    result: 'i32'
  }
} satisfies NativeSymbolMap;
type SnappyLibrary = DynamicLibrary<typeof snappySymbols>;
const snappy = tryOpen(snappyPaths, snappySymbols);
/**
* Whether `libsnappy` was loaded. Snappy helpers throw when this is false.
*
* @internal
*/
export const snappyAvailable = snappy !== null;
function requireSnappy(): SnappyLibrary {
  if (snappy === null) throw new Error('snappy library not available');
  return snappy;
}
const SNAPPY_OK = 0;
/**
* Compress a complete buffer into one Snappy raw block.
*
* @internal
*/
export function snappyCompress(data: ByteInput): Uint8Array {
  const lib = requireSnappy();
  const u8 = toU8(data);
  const bound = Number(lib.symbols.snappy_max_compressed_length(u8.byteLength));
  const out = new Uint8Array(bound);
  const lenBuf = new ArrayBuffer(8);
  new DataView(lenBuf).setBigUint64(0, BigInt(bound), true);
  const status = lib.symbols.snappy_compress(u8, u8.byteLength, out, lenBuf);
  if (status !== SNAPPY_OK) throw new Error(`snappy_compress failed (status ${status})`);
  const written = Number(new DataView(lenBuf).getBigUint64(0, true));
  return out.subarray(0, written).slice();
}
/**
* Decompress one Snappy raw block (self-describing length).
*
* @internal
*/
export function snappyDecompress(data: ByteInput): Uint8Array {
  const lib = requireSnappy();
  const u8 = toU8(data);
  const lenBuf = new ArrayBuffer(8);
  if (lib.symbols.snappy_uncompressed_length(u8, u8.byteLength, lenBuf) !== SNAPPY_OK) {
    throw new TypeError('snappy_uncompressed_length failed: not a valid Snappy block');
  }
  const size = Number(new DataView(lenBuf).getBigUint64(0, true));
  const out = new Uint8Array(size);
  new DataView(lenBuf).setBigUint64(0, BigInt(size), true);
  const status = lib.symbols.snappy_uncompress(u8, u8.byteLength, out, lenBuf);
  if (status !== SNAPPY_OK) throw new Error(`snappy_uncompress failed (status ${status})`);
  const written = Number(new DataView(lenBuf).getBigUint64(0, true));
  return written === size ? out : out.subarray(0, written).slice();
}
/**
* Buffering base for the block-oriented streaming codecs: accumulate all
* input, transform once on `finish()`.
*
* @internal
*/
abstract class SnappyCodec implements CompressionTransform {
  #chunks: Uint8Array[] = [];
  #closed = false;
  #emitEmpty: boolean;
  constructor(emitEmpty: boolean) {
    this.#emitEmpty = emitEmpty;
  }
  write(chunk: ByteInput): Uint8Array[] {
    if (this.#closed) throw new Error('compression stream is closed');
    this.#chunks.push(toU8(chunk));
    return [];
  }
  finish(): Uint8Array[] {
    if (this.#closed) throw new Error('compression stream is closed');
    const input = concat(this.#chunks);
    this.#chunks = [];
    this.close();
    return input.byteLength === 0 && !this.#emitEmpty ? [] : [this.block(input)];
  }
  /** Compress or decompress the fully-buffered input as a single Snappy block. */
  protected abstract block(input: Uint8Array): Uint8Array;
  async *transform(source: AsyncIterable<ByteInput>): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of source) this.write(chunk);
      for (const part of this.finish()) yield part;
    } finally {
      this.close();
    }
  }
  close(): void {
    this.#closed = true;
  }
  [Symbol.dispose](): void {
    this.close();
  }
}
/**
* Streaming Snappy compressor (buffers, then emits one block on finish).
*
* @internal
*/
export class SnappyCompressor extends SnappyCodec {
  constructor() {
    super(false);
  }
  protected block(input: Uint8Array): Uint8Array {
    return snappyCompress(input);
  }
}
/**
* Streaming Snappy decompressor (buffers, then emits one block on finish).
*
* @internal
*/
export class SnappyDecompressor extends SnappyCodec {
  constructor() {
    super(true);
  }
  protected block(input: Uint8Array): Uint8Array {
    return snappyDecompress(input);
  }
}
