/**
 * Brotli compression backend for `fino:compress`.
 *
 * This module loads platform Brotli libraries through `fino:ffi` and provides
 * the one-shot and streaming implementation used by the public compression
 * module. It is hidden from generated application docs; public availability and
 * option details are documented on `fino:compress`.
 *
 * ## Example
 *
 * ```typescript no_run
 * import * as brotli from 'internal:compress/brotli';
 *
 * if (brotli.brotliAvailable) {
 *   const input = new TextEncoder().encode('payload');
 *   const compressed = brotli.brotliCompress(input, { level: 5 });
 *   const restored = brotli.brotliDecompress(compressed);
 *   console.assert(new TextDecoder().decode(restored) === 'payload');
 * }
 * ```
 *
 * @internal
 */

import { dlopen, Pointer, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
import { concat, toU8, type ByteInput, type CompressionTransform } from './common.mts';

/**
 * Options used by the Brotli backend.
 *
 * `level` maps to Brotli quality and defaults to 11. The native encoder
 * validates accepted values.
 *
 * ```typescript no_run
 * import type { BrotliCompressionOptions } from 'internal:compress/brotli';
 * const opts: BrotliCompressionOptions = { level: 5 };
 * ```
 *
 * @internal
 */
export interface BrotliCompressionOptions {
  /**
   * Optional Brotli quality level.
   *
   * ```typescript no_run
   * import type { BrotliCompressionOptions } from 'internal:compress/brotli';
   * const opts: BrotliCompressionOptions = { level: 4 };
   * opts.level;
   * ```
   */
  level?: number;
}

const isDarwin = os === 'darwin';

function tryOpen<TSymbols extends NativeSymbolMap>(paths: string[], symbols: TSymbols): DynamicLibrary<TSymbols> | null {
  for (const p of paths) {
    try { return dlopen(p, symbols); } catch (_) {}
  }
  return null;
}

const brotliEncPaths = isDarwin
  ? ['/opt/homebrew/lib/libbrotlienc.dylib', '/usr/local/lib/libbrotlienc.dylib', 'libbrotlienc.dylib']
  : ['libbrotlienc.so.1', 'libbrotlienc.so'];

const brotliDecPaths = isDarwin
  ? ['/opt/homebrew/lib/libbrotlidec.dylib', '/usr/local/lib/libbrotlidec.dylib', 'libbrotlidec.dylib']
  : ['libbrotlidec.so.1', 'libbrotlidec.so'];

const brotliEncSymbols = {
  BrotliEncoderCreateInstance:   { parameters: ['pointer', 'pointer', 'pointer'], result: 'pointer' },
  BrotliEncoderDestroyInstance:  { parameters: ['pointer'], result: 'void' },
  BrotliEncoderSetParameter:     { parameters: ['pointer', 'i32', 'u32'], result: 'i32' },
  BrotliEncoderCompress:         { parameters: ['i32', 'i32', 'i32', 'usize', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliEncoderCompressStream:   { parameters: ['pointer', 'i32', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliEncoderHasMoreOutput:    { parameters: ['pointer'], result: 'i32' },
  BrotliEncoderIsFinished:       { parameters: ['pointer'], result: 'i32' },
  BrotliEncoderMaxCompressedSize: { parameters: ['usize'], result: 'usize' },
} satisfies NativeSymbolMap;

const brotliDecSymbols = {
  BrotliDecoderCreateInstance:      { parameters: ['pointer', 'pointer', 'pointer'], result: 'pointer' },
  BrotliDecoderDestroyInstance:     { parameters: ['pointer'], result: 'void' },
  BrotliDecoderDecompress:          { parameters: ['usize', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliDecoderDecompressStream:    { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliDecoderHasMoreOutput:       { parameters: ['pointer'], result: 'i32' },
  BrotliDecoderIsFinished:          { parameters: ['pointer'], result: 'i32' },
} satisfies NativeSymbolMap;

type BrotliEncoderLibrary = DynamicLibrary<typeof brotliEncSymbols>;
type BrotliDecoderLibrary = DynamicLibrary<typeof brotliDecSymbols>;

const brotliEncoder = tryOpen(brotliEncPaths, brotliEncSymbols);
const brotliDecoder = tryOpen(brotliDecPaths, brotliDecSymbols);

/**
 * Whether both Brotli encoder and decoder libraries were loaded.
 *
 * One-shot and streaming Brotli helpers throw when this is false. zlib formats
 * are unaffected.
 *
 * ```typescript no_run
 * import { brotliAvailable } from 'internal:compress/brotli';
 * if (!brotliAvailable) {
 *   // Fall back to gzip.
 * }
 * ```
 *
 * @internal
 */
export const brotliAvailable = brotliEncoder !== null && brotliDecoder !== null;

function requireBrotliEncoder(): BrotliEncoderLibrary {
  if (brotliEncoder === null) throw new Error('brotli library not available');
  return brotliEncoder;
}

function requireBrotliDecoder(): BrotliDecoderLibrary {
  if (brotliDecoder === null) throw new Error('brotli library not available');
  return brotliDecoder;
}

const CHUNK = 65536;
const BROTLI_PARAM_QUALITY = 1;
const BROTLI_PARAM_LGWIN = 2;
const BROTLI_DEFAULT_QUALITY = 11;
const BROTLI_DEFAULT_WINDOW = 22;
const BROTLI_MODE_GENERIC = 0;
const BROTLI_OPERATION_PROCESS = 0;
const BROTLI_OPERATION_FINISH = 2;
const BROTLI_DECODER_RESULT_SUCCESS = 1;
const BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT = 2;
const BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT = 3;

/**
 * Compress a complete buffer with Brotli.
 *
 * Returns a new `Uint8Array`. Throws when Brotli libraries are unavailable or
 * when native compression fails.
 *
 * ```typescript no_run
 * import { brotliCompress } from 'internal:compress/brotli';
 * const out = brotliCompress(new TextEncoder().encode('hello'), { level: 5 });
 * ```
 *
 * @internal
 */
export function brotliCompress(data: ByteInput, opts?: BrotliCompressionOptions): Uint8Array {
  const brotli = requireBrotliEncoder();
  const u8 = toU8(data);
  const quality = opts?.level ?? BROTLI_DEFAULT_QUALITY;

  const maxSize = Number(brotli.symbols.BrotliEncoderMaxCompressedSize(u8.byteLength));
  const outBuf = new ArrayBuffer(maxSize);
  const sizeBuf = new ArrayBuffer(8);
  new DataView(sizeBuf).setBigUint64(0, BigInt(maxSize), true);

  const ok = brotli.symbols.BrotliEncoderCompress(
    quality, BROTLI_DEFAULT_WINDOW, BROTLI_MODE_GENERIC,
    u8.byteLength, u8, sizeBuf, outBuf,
  );
  if (!ok) throw new Error('brotliCompress failed');

  const actual = Number(new DataView(sizeBuf).getBigUint64(0, true));
  return new Uint8Array(outBuf, 0, actual).slice();
}

/**
 * Decompress a complete Brotli buffer.
 *
 * The output buffer grows up to an internal 256 MiB limit. Throws when input is
 * malformed, output would exceed that limit, or Brotli is unavailable.
 *
 * ```typescript no_run
 * import { brotliCompress, brotliDecompress } from 'internal:compress/brotli';
 * const packed = brotliCompress(new Uint8Array([1, 2, 3]));
 * const plain = brotliDecompress(packed);
 * ```
 *
 * @internal
 */
export function brotliDecompress(data: ByteInput): Uint8Array {
  const decoder = new BrotliDecompressor();
  return collectBrotliTransform(decoder, [data]);
}

class BrotliCodec implements CompressionTransform {
  #state: Pointer | null;
  #closed = false;
  #finished = false;
  #pendingError: Error | null = null;
  #outBuf = new ArrayBuffer(CHUNK);
  #outBufAddr = Pointer.addr(this.#outBuf);
  #availInBuf = new ArrayBuffer(8);
  #nextInBuf = new ArrayBuffer(8);
  #availOutBuf = new ArrayBuffer(8);
  #nextOutBuf = new ArrayBuffer(8);
  #dvAI = new DataView(this.#availInBuf);
  #dvNI = new DataView(this.#nextInBuf);
  #dvAO = new DataView(this.#availOutBuf);
  #dvNO = new DataView(this.#nextOutBuf);

  constructor(state: Pointer) {
    this.#state = state;
  }

  write(_chunk: ByteInput): Uint8Array[] {
    throw new Error('not implemented');
  }

  finish(): Uint8Array[] {
    throw new Error('not implemented');
  }

  async *transform(source: AsyncIterable<ByteInput>): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of source) {
        for (const part of this.write(chunk)) yield part;
      }
      for (const part of this.finish()) yield part;
    } finally {
      this.close();
    }
  }

  close(): void {
    this.#closed = true;
  }

  protected get state(): Pointer {
    this.#assertOpen();
    return this.#state!;
  }

  protected get finished(): boolean { return this.#finished; }
  protected set finished(value: boolean) { this.#finished = value; }
  protected takePendingError(): Error | null {
    const error = this.#pendingError;
    this.#pendingError = null;
    return error;
  }
  protected setPendingError(error: Error): void {
    this.#pendingError = error;
  }
  protected get buffers() {
    return {
      outBuf: this.#outBuf,
      availInBuf: this.#availInBuf,
      nextInBuf: this.#nextInBuf,
      availOutBuf: this.#availOutBuf,
      nextOutBuf: this.#nextOutBuf,
      dvAI: this.#dvAI,
      dvNI: this.#dvNI,
      dvAO: this.#dvAO,
      dvNO: this.#dvNO,
      outBufAddr: this.#outBufAddr,
    };
  }

  protected assertOpen(): void {
    this.#assertOpen();
  }

  #assertOpen(): void {
    if (this.#closed || this.#state === null) throw new Error('compression stream is closed');
  }
}

/**
 * Streaming Brotli compressor.
 *
 * Feed chunks with `write` and call `finish` to emit final data and destroy the
 * native encoder. Calling `write` after `finish` throws.
 *
 * ```typescript no_run
 * import { BrotliCompressor } from 'internal:compress/brotli';
 * const codec = new BrotliCompressor({ level: 5 });
 * const parts = [...codec.write(new Uint8Array([1])), ...codec.finish()];
 * ```
 *
 * @internal
 */
export class BrotliCompressor extends BrotliCodec {
  /**
   * Private property `#brotli` used by `BrotliCompressor`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #brotli = undefined;
   *
   *   readInternalState() {
   *     return this.#brotli;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #brotli = requireBrotliEncoder();

  /**
   * Create a streaming Brotli compressor.
   *
   * The native encoder state is allocated immediately. Throws when Brotli is
   * unavailable or state allocation fails.
   *
   * ```typescript no_run
   * import { BrotliCompressor } from 'internal:compress/brotli';
   * const compressor = new BrotliCompressor();
   * ```
   */
  constructor(opts?: BrotliCompressionOptions) {
    const state = requireBrotliEncoder().symbols.BrotliEncoderCreateInstance(null, null, null);
    if (!state) throw new Error('BrotliEncoderCreateInstance failed');
    super(state);
    this.#brotli.symbols.BrotliEncoderSetParameter(this.state, BROTLI_PARAM_QUALITY, opts?.level ?? BROTLI_DEFAULT_QUALITY);
    this.#brotli.symbols.BrotliEncoderSetParameter(this.state, BROTLI_PARAM_LGWIN, BROTLI_DEFAULT_WINDOW);
  }

  /**
   * Feed one uncompressed chunk to the encoder.
   *
   * Returns zero or more compressed output chunks. The returned chunks are
   * copies and remain valid after the next write.
   *
   * ```typescript no_run
   * import { BrotliCompressor } from 'internal:compress/brotli';
   * const codec = new BrotliCompressor();
   * const chunks = codec.write(new Uint8Array([1, 2, 3]));
   * codec.close();
   * ```
   */
  write(chunk: ByteInput): Uint8Array[] {
    this.assertOpen();
    if (this.finished) throw new Error('compression stream already finished');
    const { outBuf, availInBuf, nextInBuf, availOutBuf, nextOutBuf, dvAI, dvNI, dvAO, dvNO, outBufAddr } = this.buffers;
    const u8 = toU8(chunk);
    const inputAddr = u8.byteLength > 0 ? Pointer.addr(u8) : 0n;
    const parts: Uint8Array[] = [];

    dvAI.setBigUint64(0, BigInt(u8.byteLength), true);
    dvNI.setBigUint64(0, inputAddr, true);

    let remaining;
    do {
      dvAO.setBigUint64(0, BigInt(CHUNK), true);
      dvNO.setBigUint64(0, outBufAddr, true);

      const ok = this.#brotli.symbols.BrotliEncoderCompressStream(
        this.state, BROTLI_OPERATION_PROCESS,
        availInBuf, nextInBuf, availOutBuf, nextOutBuf, null,
      );
      if (!ok) throw new Error('BrotliEncoderCompressStream failed');

      const produced = CHUNK - Number(dvAO.getBigUint64(0, true));
      if (produced > 0) parts.push(new Uint8Array(outBuf, 0, produced).slice());

      remaining = Number(dvAI.getBigUint64(0, true));
    } while (remaining > 0 || this.#brotli.symbols.BrotliEncoderHasMoreOutput(this.state));

    return parts;
  }

  /**
   * Finish the Brotli stream and close native encoder state.
   *
   * Returns final output chunks, including any trailer bytes. The compressor is
   * closed even if native finishing throws.
   *
   * ```typescript no_run
   * import { BrotliCompressor } from 'internal:compress/brotli';
   * const codec = new BrotliCompressor();
   * const final = codec.finish();
   * ```
   */
  finish(): Uint8Array[] {
    this.assertOpen();
    const { outBuf, availInBuf, nextInBuf, availOutBuf, nextOutBuf, dvAI, dvNI, dvAO, dvNO, outBufAddr } = this.buffers;
    const parts: Uint8Array[] = [];

    try {
      dvAI.setBigUint64(0, 0n, true);
      dvNI.setBigUint64(0, 0n, true);
      while (!this.#brotli.symbols.BrotliEncoderIsFinished(this.state)) {
        dvAO.setBigUint64(0, BigInt(CHUNK), true);
        dvNO.setBigUint64(0, outBufAddr, true);

        const ok = this.#brotli.symbols.BrotliEncoderCompressStream(
          this.state, BROTLI_OPERATION_FINISH,
          availInBuf, nextInBuf, availOutBuf, nextOutBuf, null,
        );
        if (!ok) throw new Error('BrotliEncoderCompressStream (finish) failed');

        const produced = CHUNK - Number(dvAO.getBigUint64(0, true));
        if (produced > 0) parts.push(new Uint8Array(outBuf, 0, produced).slice());
      }
      this.finished = true;
      return parts;
    } finally {
      this.close();
    }
  }

  /**
   * Destroy native Brotli encoder state.
   *
   * Safe to call after `finish`; failures from already-closed native state are
   * ignored.
   *
   * ```typescript no_run
   * import { BrotliCompressor } from 'internal:compress/brotli';
   * const codec = new BrotliCompressor();
   * codec.close();
   * ```
   */
  close(): void {
    try {
      this.#brotli.symbols.BrotliEncoderDestroyInstance(this.state);
    } catch (_) {
      // Already closed.
    }
    super.close();
  }
}

/**
 * Streaming Brotli decompressor.
 *
 * `write` returns decompressed chunks as input arrives. `finish` validates that
 * the stream reached EOF and throws when callers feed truncated Brotli input.
 *
 * ```typescript no_run
 * import { BrotliDecompressor } from 'internal:compress/brotli';
 * const codec = new BrotliDecompressor();
 * codec.close();
 * ```
 *
 * @internal
 */
export class BrotliDecompressor extends BrotliCodec {
  /**
   * Private property `#brotli` used by `BrotliDecompressor`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #brotli = undefined;
   *
   *   readInternalState() {
   *     return this.#brotli;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #brotli = requireBrotliDecoder();

  /**
   * Create a streaming Brotli decompressor.
   *
   * Throws when Brotli decoder libraries are unavailable or native state
   * allocation fails.
   *
   * ```typescript no_run
   * import { BrotliDecompressor } from 'internal:compress/brotli';
   * const decompressor = new BrotliDecompressor();
   * ```
   */
  constructor() {
    const state = requireBrotliDecoder().symbols.BrotliDecoderCreateInstance(null, null, null);
    if (!state) throw new Error('BrotliDecoderCreateInstance failed');
    super(state);
  }

  /**
   * Feed one compressed chunk to the decoder.
   *
   * Returns zero or more decompressed chunks. Malformed input throws with the
   * native decoder result code.
   *
   * ```typescript no_run
   * import { BrotliDecompressor } from 'internal:compress/brotli';
   * const codec = new BrotliDecompressor();
   * const chunks = codec.write(new Uint8Array());
   * codec.close();
   * ```
   */
  write(chunk: ByteInput): Uint8Array[] {
    this.assertOpen();
    const pendingError = this.takePendingError();
    if (pendingError !== null) throw pendingError;
    if (this.finished) return [];
    const { outBuf, availInBuf, nextInBuf, availOutBuf, nextOutBuf, dvAI, dvNI, dvAO, dvNO, outBufAddr } = this.buffers;
    const u8 = toU8(chunk);
    const inputAddr = u8.byteLength > 0 ? Pointer.addr(u8) : 0n;
    const parts: Uint8Array[] = [];

    dvAI.setBigUint64(0, BigInt(u8.byteLength), true);
    dvNI.setBigUint64(0, inputAddr, true);

    let remaining;
    do {
      dvAO.setBigUint64(0, BigInt(CHUNK), true);
      dvNO.setBigUint64(0, outBufAddr, true);

      const result = this.#brotli.symbols.BrotliDecoderDecompressStream(
        this.state, availInBuf, nextInBuf, availOutBuf, nextOutBuf, null,
      );

      const produced = CHUNK - Number(dvAO.getBigUint64(0, true));
      if (produced > 0) parts.push(new Uint8Array(outBuf, 0, produced).slice());

      if (result === BROTLI_DECODER_RESULT_SUCCESS) {
        remaining = Number(dvAI.getBigUint64(0, true));
        if (remaining > 0) {
          this.setPendingError(new TypeError('BrotliDecoderDecompressStream failed: trailing data after compressed stream'));
        }
        this.finished = true;
        break;
      }
      if (result !== BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT &&
          result !== BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
        throw new TypeError(`BrotliDecoderDecompressStream failed (result=${result})`);
      }

      remaining = Number(dvAI.getBigUint64(0, true));
    } while (remaining > 0 || this.#brotli.symbols.BrotliDecoderHasMoreOutput(this.state));

    return parts;
  }

  /**
   * Finish and close the Brotli decoder.
   *
   * Returns an empty array after a complete stream. Throws if the compressed
   * data ended before the Brotli EOF marker.
   *
   * ```typescript no_run
   * import { BrotliDecompressor } from 'internal:compress/brotli';
   * const codec = new BrotliDecompressor();
   * const final = codec.finish();
   * ```
   */
  finish(): Uint8Array[] {
    this.assertOpen();
    try {
      const pendingError = this.takePendingError();
      if (pendingError !== null) throw pendingError;
      if (!this.finished) {
        throw new TypeError('BrotliDecoderDecompressStream failed: unexpected end of compressed data');
      }
      this.finished = true;
      return [];
    } finally {
      this.close();
    }
  }

  /**
   * Destroy native Brotli decoder state.
   *
   * Safe to call after `finish`; failures from already-closed native state are
   * ignored.
   *
   * ```typescript no_run
   * import { BrotliDecompressor } from 'internal:compress/brotli';
   * const codec = new BrotliDecompressor();
   * codec.close();
   * ```
   */
  close(): void {
    try {
      this.#brotli.symbols.BrotliDecoderDestroyInstance(this.state);
    } catch (_) {
      // Already closed.
    }
    super.close();
  }
}

/**
 * Run a Brotli transform over a fixed list of chunks and concatenate output.
 *
 * Calls `finish` after all writes, so the codec is consumed and should not be
 * reused. Throws through any codec error.
 *
 * ```typescript no_run
 * import { BrotliCompressor, collectBrotliTransform } from 'internal:compress/brotli';
 * const out = collectBrotliTransform(new BrotliCompressor(), [new Uint8Array([1])]);
 * ```
 *
 * @internal
 */
export function collectBrotliTransform(codec: CompressionTransform, chunks: ByteInput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) parts.push(...codec.write(chunk));
  parts.push(...codec.finish());
  return concat(parts);
}
