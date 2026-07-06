/**
* Snappy compression backend for `fino:compress`.
*
* Loads the platform `libsnappy` through `fino:ffi` and implements the Snappy
* raw block format (the format Apache Parquet uses for page compression, and
* the one `snappy_compress`/`snappy_uncompress` produce and consume). This is
* the raw block encoding, not the Snappy framing format (`.sz`): output has no
* magic bytes or checksums, just a varint uncompressed length followed by
* compressed data.
*
* Snappy is a block codec, not a stream codec: the one-shot helpers
* compress/decompress a whole buffer in a single native call, and the
* streaming `SnappyCompressor`/`SnappyDecompressor` buffer all of their input
* and emit a single block on `finish()`. Streaming here only adapts the block
* codec to the `CompressionTransform` interface — it does not bound memory,
* since the entire input is held until `finish()`.
*
* The library is loaded fail-soft at module init: when no `libsnappy` can be
* found, `snappyAvailable` is `false` and every codec entry point throws.
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
* Format description: https://github.com/google/snappy/blob/main/format_description.txt
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
* The library is resolved once at module init from a small candidate list
* (Homebrew and `/usr/local` paths plus the bare dylib name on macOS, the
* `libsnappy.so.1`/`libsnappy.so` sonames elsewhere). Check this flag before
* offering the `snappy` format to callers — it is how `fino:compress` decides
* whether to expose the backend at all.
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
* Sizes the output with `snappy_max_compressed_length`, compresses in a single
* native call, and returns a tightly-sized copy of the written bytes. An empty
* input is valid and produces a one-byte block (the varint `0` length header),
* which `snappyDecompress` restores to an empty buffer.
*
* Throws if `libsnappy` is not available (`snappyAvailable` is `false`) or if
* the native call reports a non-OK status.
*
* ```typescript no_run
* import { snappyCompress } from 'internal:compress/snappy';
*
* const page = new TextEncoder().encode('column data destined for a Parquet page');
* const block = snappyCompress(page);
* console.log(`${page.byteLength} bytes -> ${block.byteLength} bytes`);
* ```
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
* Raw blocks begin with a varint declaring the uncompressed size, so no length
* hint is needed: the output buffer is sized from
* `snappy_uncompressed_length`, then decoded with `snappy_uncompress`. The
* input must be exactly one complete block — this is not a framing-format
* reader and does not handle concatenated blocks.
*
* Throws `TypeError` when the input is not a valid Snappy block (including an
* empty buffer, which has no length header). Throws `Error` if `libsnappy` is
* not available or the native decode reports a non-OK status.
*
* ```typescript no_run
* import { snappyCompress, snappyDecompress } from 'internal:compress/snappy';
*
* const block = snappyCompress(new TextEncoder().encode('payload'));
* const restored = snappyDecompress(block);
* console.assert(new TextDecoder().decode(restored) === 'payload');
* ```
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
* Because Snappy raw blocks are indivisible, this adapter cannot produce
* incremental output — `write` only buffers, and all output arrives at once
* from `finish()`. Memory usage therefore grows with the total input size.
* `emitEmpty` decides what a zero-input `finish()` does: the compressor skips
* the native call and emits nothing, while the decompressor still attempts to
* decode (an empty buffer is not a valid block, so that throws).
*
* @internal
*/
abstract class SnappyCodec implements CompressionTransform {
  #chunks: Uint8Array[] = [];
  #closed = false;
  #emitEmpty: boolean;
  /**
  * Configures zero-input `finish()` behavior: when `emitEmpty` is true the
  * buffered (empty) input is still passed to `block`, otherwise `finish()`
  * returns no chunks.
  */
  constructor(emitEmpty: boolean) {
    this.#emitEmpty = emitEmpty;
  }
  /**
  * Buffer one input chunk.
  *
  * Always returns an empty array — a block codec cannot emit anything until
  * the input is complete. Throws if the codec has been closed by `finish()`,
  * `close()`, or disposal.
  */
  write(chunk: ByteInput): Uint8Array[] {
    if (this.#closed) throw new Error('compression stream is closed');
    this.#chunks.push(toU8(chunk));
    return [];
  }
  /**
  * Concatenate everything written so far, transform it as one Snappy block,
  * and close the codec.
  *
  * Returns at most one chunk. The codec is closed even if the block transform
  * throws, so a failed `finish()` cannot be retried. Throws if already
  * closed.
  */
  finish(): Uint8Array[] {
    if (this.#closed) throw new Error('compression stream is closed');
    const input = concat(this.#chunks);
    this.#chunks = [];
    this.close();
    return input.byteLength === 0 && !this.#emitEmpty ? [] : [this.block(input)];
  }
  /** Compress or decompress the fully-buffered input as a single Snappy block. */
  protected abstract block(input: Uint8Array): Uint8Array;
  /**
  * Drain an async source through the codec, yielding the single output block
  * after the source ends.
  *
  * The codec is closed in a `finally` block, so abandoning the generator
  * early still releases the buffered input.
  */
  async *transform(source: AsyncIterable<ByteInput>): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of source) this.write(chunk);
      for (const part of this.finish()) yield part;
    } finally {
      this.close();
    }
  }
  /**
  * Mark the codec closed. There is no native state to release; this only
  * makes further `write`/`finish` calls throw. Safe to call repeatedly.
  */
  close(): void {
    this.#closed = true;
  }
  /** Close the codec when leaving a `using` block. */
  [Symbol.dispose](): void {
    this.close();
  }
}
/**
* Streaming Snappy compressor (buffers, then emits one block on finish).
*
* Adapts `snappyCompress` to the `CompressionTransform` interface used by
* `fino:compress` streaming APIs. Every `write` returns no output; `finish()`
* returns the whole input compressed as a single raw block. Finishing with no
* input written emits nothing at all — note this differs from the one-shot
* `snappyCompress(new Uint8Array(0))`, which produces a one-byte block.
*
* Throws from `finish()` if `libsnappy` is unavailable or compression fails,
* and from any method after the codec is closed.
*
* ```typescript no_run
* import { SnappyCompressor } from 'internal:compress/snappy';
* import { concat } from 'internal:compress/common';
*
* const compressor = new SnappyCompressor();
* const parts: Uint8Array[] = [];
* parts.push(...compressor.write(new TextEncoder().encode('first chunk ')));
* parts.push(...compressor.write(new TextEncoder().encode('second chunk')));
* parts.push(...compressor.finish());
* const block = concat(parts);
* ```
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
* Adapts `snappyDecompress` to the `CompressionTransform` interface used by
* `fino:compress` streaming APIs. The chunks written must reassemble into
* exactly one Snappy raw block; nothing is decoded until `finish()`, which
* returns the decompressed payload as a single chunk. Unlike the compressor,
* finishing with no input written is an error: an empty buffer has no length
* header, so the block decode throws `TypeError`.
*
* Throws `TypeError` from `finish()` when the buffered bytes are not a valid
* Snappy block, `Error` if `libsnappy` is unavailable or the decode fails, and
* from any method after the codec is closed.
*
* ```typescript no_run
* import { snappyCompress, SnappyDecompressor } from 'internal:compress/snappy';
* import { concat } from 'internal:compress/common';
*
* const block = snappyCompress(new TextEncoder().encode('payload'));
* const decompressor = new SnappyDecompressor();
* const parts: Uint8Array[] = [];
* parts.push(...decompressor.write(block.subarray(0, 3)));
* parts.push(...decompressor.write(block.subarray(3)));
* parts.push(...decompressor.finish());
* const payload = concat(parts);
* console.assert(new TextDecoder().decode(payload) === 'payload');
* ```
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
