/**
 * zlib-backed compression backend for `fino:compress`.
 *
 * This module loads the platform zlib library through `fino:ffi` and implements
 * gzip, zlib-wrapped deflate, and raw deflate support for the public
 * compression module. It is hidden from generated application docs; public
 * formats and usage are documented on `fino:compress`.
 *
 * ## Example
 *
 * ```typescript no_run
 * import * as zlib from 'internal:compress/zlib';
 *
 * const input = new TextEncoder().encode('payload');
 * const compressed = zlib.zlibCompress(input, 'gzip', { level: 6 });
 * const restored = zlib.zlibDecompress(compressed, 'gzip');
 * console.assert(new TextDecoder().decode(restored) === 'payload');
 * ```
 *
 * @internal
 */

import { dlopen, Pointer, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
import {
  concat,
  toU8,
  type ByteInput,
  type CompressionTransform,
  type ZlibCompressionFormat,
} from './common.mts';

/**
 * Options used by zlib-backed compression.
 *
 * `level` defaults to zlib's `Z_DEFAULT_COMPRESSION` when omitted. The native
 * library validates the actual range and may reject unsupported values.
 *
 * ```typescript no_run
 * import type { ZlibCompressionOptions } from 'internal:compress/zlib';
 * const opts: ZlibCompressionOptions = { level: 6 };
 * ```
 *
 * @internal
 */
export interface ZlibCompressionOptions {
  /**
   * Optional zlib compression level.
   *
   * ```typescript no_run
   * import type { ZlibCompressionOptions } from 'internal:compress/zlib';
   * const opts: ZlibCompressionOptions = { level: 1 };
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

const zlibPaths = isDarwin
  ? ['/usr/lib/libz.1.dylib', '/opt/homebrew/lib/libz.dylib', 'libz.dylib']
  : ['libz.so.1', 'libz.so'];

const zlibSymbols = {
  deflateInit2_: { parameters: ['buffer', 'i32', 'i32', 'i32', 'i32', 'i32', 'buffer', 'i32'], result: 'i32' },
  deflate:       { parameters: ['buffer', 'i32'], result: 'i32' },
  deflateEnd:    { parameters: ['buffer'], result: 'i32' },
  inflateInit2_: { parameters: ['buffer', 'i32', 'buffer', 'i32'], result: 'i32' },
  inflate:       { parameters: ['buffer', 'i32'], result: 'i32' },
  inflateEnd:    { parameters: ['buffer'], result: 'i32' },
  compressBound: { parameters: ['usize'], result: 'usize' },
} satisfies NativeSymbolMap;

type ZlibLibrary = DynamicLibrary<typeof zlibSymbols>;

const zlib = tryOpen(zlibPaths, zlibSymbols);
if (!zlib) throw new Error('fino:compress: could not load zlib');

function requireZlib(): ZlibLibrary {
  if (zlib === null) throw new Error('fino:compress: could not load zlib');
  return zlib;
}

const Z_OK          = 0;
const Z_STREAM_END  = 1;
const Z_BUF_ERROR   = -5;
const Z_NO_FLUSH    = 0;
const Z_FINISH      = 4;
const Z_DEFLATED    = 8;
const Z_DEFAULT_STRATEGY = 0;
const Z_DEFAULT_COMPRESSION = -1;

const W_ZLIB = 15;
const W_GZIP = 15 + 16;
const W_RAW  = -15;
const W_AUTO = 15 + 32;

const Z_STREAM_SIZE = 112;
const CHUNK = 65536;
const ZLIB_VERSION_BUF = new Uint8Array([49, 46, 50, 46, 49, 50, 0]).buffer;

class ZStream {
  #buf = new ArrayBuffer(Z_STREAM_SIZE);
  #view = new DataView(this.#buf);

  get buffer() { return this.#buf; }

  setInput(u8: Uint8Array): void {
    const addr = u8.byteLength > 0 ? Pointer.addr(u8) : 0n;
    this.#view.setBigUint64(0, addr, true);
    this.#view.setUint32(8, u8.byteLength, true);
  }

  setOutput(buf: ArrayBuffer): void {
    const addr = Pointer.addr(buf);
    this.#view.setBigUint64(24, addr, true);
    this.#view.setUint32(32, buf.byteLength, true);
  }

  get availIn()  { return this.#view.getUint32(8, true); }
  get availOut() { return this.#view.getUint32(32, true); }
}

function windowBitsForCompress(format: ZlibCompressionFormat): number {
  if (format === 'gzip') return W_GZIP;
  if (format === 'deflate-raw') return W_RAW;
  return W_ZLIB;
}

function windowBitsForDecompress(format: ZlibCompressionFormat): number {
  if (format === 'deflate-raw') return W_RAW;
  return W_AUTO;
}

function deflateOneShot(data: ByteInput, windowBits: number, level: number): Uint8Array {
  const codec = new ZlibCompressor(windowBits, level);
  const parts = [...codec.write(data), ...codec.finish()];
  return concat(parts);
}

function inflateOneShot(data: ByteInput, windowBits: number): Uint8Array {
  const z = requireZlib();
  const u8 = toU8(data);
  const zs = new ZStream();
  const r0 = z.symbols.inflateInit2_(zs.buffer, windowBits, ZLIB_VERSION_BUF, Z_STREAM_SIZE);
  if (r0 !== Z_OK) throw new Error(`zlib inflateInit2_ failed (${r0})`);

  zs.setInput(u8);
  const outBuf = new ArrayBuffer(CHUNK);
  const parts: Uint8Array[] = [];
  let done = false;

  try {
    let r;
    do {
      zs.setOutput(outBuf);
      r = z.symbols.inflate(zs.buffer, Z_NO_FLUSH);
      const produced = CHUNK - zs.availOut;
      if (produced > 0) parts.push(new Uint8Array(outBuf, 0, produced).slice());
      if (r === Z_STREAM_END) { done = true; break; }
      if (r !== Z_OK && r !== Z_BUF_ERROR) throw new Error(`zlib inflate error (${r})`);
    } while (zs.availIn > 0 || zs.availOut === 0);
  } finally {
    z.symbols.inflateEnd(zs.buffer);
  }

  if (!done) throw new Error('zlib inflate: unexpected end of compressed data');
  return concat(parts);
}

/**
 * Compress a complete buffer with the zlib backend.
 *
 * Supports `gzip`, `deflate`, and `deflate-raw`. The output is a new
 * `Uint8Array`. Throws when zlib initialization or deflation fails.
 *
 * ```typescript no_run
 * import { zlibCompress } from 'internal:compress/zlib';
 * const out = zlibCompress(new TextEncoder().encode('hello'), 'gzip');
 * ```
 *
 * @internal
 */
export function zlibCompress(data: ByteInput, format: ZlibCompressionFormat, opts?: ZlibCompressionOptions): Uint8Array {
  return deflateOneShot(data, windowBitsForCompress(format), opts?.level ?? Z_DEFAULT_COMPRESSION);
}

/**
 * Decompress a complete buffer with the zlib backend.
 *
 * `gzip` and `deflate` use auto-detecting wrapped inflate; `deflate-raw` uses
 * raw inflate. Throws on malformed or truncated compressed input.
 *
 * ```typescript no_run
 * import { zlibCompress, zlibDecompress } from 'internal:compress/zlib';
 * const packed = zlibCompress(new Uint8Array([1, 2, 3]), 'deflate');
 * const plain = zlibDecompress(packed, 'deflate');
 * ```
 *
 * @internal
 */
export function zlibDecompress(data: ByteInput, format: ZlibCompressionFormat): Uint8Array {
  return inflateOneShot(data, windowBitsForDecompress(format));
}

class ZlibCodec implements CompressionTransform {
  #zlib = requireZlib();
  #zs = new ZStream();
  #outBuf = new ArrayBuffer(CHUNK);
  #isDeflate: boolean;
  #closed = false;
  #finished = false;

  constructor(windowBits: number, level: number, isDeflate: boolean) {
    this.#isDeflate = isDeflate;
    const r0 = isDeflate
      ? this.#zlib.symbols.deflateInit2_(this.#zs.buffer, level, Z_DEFLATED, windowBits, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION_BUF, Z_STREAM_SIZE)
      : this.#zlib.symbols.inflateInit2_(this.#zs.buffer, windowBits, ZLIB_VERSION_BUF, Z_STREAM_SIZE);
    if (r0 !== Z_OK) throw new Error(`zlib init failed (${r0})`);
  }

  write(chunk: ByteInput): Uint8Array[] {
    this.#assertOpen();
    if (this.#finished) throw new Error('compression stream already finished');

    const u8 = toU8(chunk);
    this.#zs.setInput(u8);
    const parts: Uint8Array[] = [];

    let r;
    do {
      this.#zs.setOutput(this.#outBuf);
      r = this.#isDeflate
        ? this.#zlib.symbols.deflate(this.#zs.buffer, Z_NO_FLUSH)
        : this.#zlib.symbols.inflate(this.#zs.buffer, Z_NO_FLUSH);

      const produced = CHUNK - this.#zs.availOut;
      if (produced > 0) parts.push(new Uint8Array(this.#outBuf, 0, produced).slice());

      if (r === Z_STREAM_END) { this.#finished = true; break; }
      if (r !== Z_OK && r !== Z_BUF_ERROR) throw new Error(`zlib error (${r})`);
    } while (this.#zs.availIn > 0 || this.#zs.availOut === 0);

    return parts;
  }

  finish(): Uint8Array[] {
    this.#assertOpen();
    if (this.#finished && this.#isDeflate) return [];

    const parts: Uint8Array[] = [];
    try {
      if (this.#isDeflate) {
        this.#zs.setInput(new Uint8Array(0));
        let r;
        do {
          this.#zs.setOutput(this.#outBuf);
          r = this.#zlib.symbols.deflate(this.#zs.buffer, Z_FINISH);
          const produced = CHUNK - this.#zs.availOut;
          if (produced > 0) parts.push(new Uint8Array(this.#outBuf, 0, produced).slice());
          if (r !== Z_OK && r !== Z_BUF_ERROR && r !== Z_STREAM_END) {
            throw new Error(`zlib finish error (${r})`);
          }
        } while (r !== Z_STREAM_END);
      }
      this.#finished = true;
      return parts;
    } finally {
      this.close();
    }
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
    if (this.#closed) return;
    if (this.#isDeflate) this.#zlib.symbols.deflateEnd(this.#zs.buffer);
    else this.#zlib.symbols.inflateEnd(this.#zs.buffer);
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('compression stream is closed');
  }
}

/**
 * Streaming zlib compressor.
 *
 * The constructor accepts either a public zlib format or raw zlib window bits.
 * `write` returns any output currently available; `finish` must be called to
 * flush trailers and close native state.
 *
 * ```typescript no_run
 * import { ZlibCompressor } from 'internal:compress/zlib';
 * const codec = new ZlibCompressor('gzip');
 * const chunks = [...codec.write(new Uint8Array([1])), ...codec.finish()];
 * ```
 *
 * @internal
 */
export class ZlibCompressor extends ZlibCodec {
  /**
   * Create a zlib compressor.
   *
   * `level` defaults to zlib's default compression. Passing a numeric first
   * argument bypasses format mapping and is intended only for backend internals.
   *
   * ```typescript no_run
   * import { ZlibCompressor } from 'internal:compress/zlib';
   * const gzip = new ZlibCompressor('gzip', 6);
   * ```
   */
  constructor(windowBitsOrFormat: number | ZlibCompressionFormat, level = Z_DEFAULT_COMPRESSION) {
    super(typeof windowBitsOrFormat === 'number' ? windowBitsOrFormat : windowBitsForCompress(windowBitsOrFormat), level, true);
  }
}

/**
 * Streaming zlib decompressor.
 *
 * `write` may produce chunks before the compressed stream is complete. `finish`
 * closes native state and returns no additional data for inflate streams.
 *
 * ```typescript no_run
 * import { ZlibCompressor, ZlibDecompressor } from 'internal:compress/zlib';
 * const packed = new ZlibCompressor('deflate').write(new Uint8Array([1]));
 * const codec = new ZlibDecompressor('deflate');
 * void packed;
 * codec.close();
 * ```
 *
 * @internal
 */
export class ZlibDecompressor extends ZlibCodec {
  /**
   * Create a zlib decompressor for a supported zlib format.
   *
   * Wrapped gzip and deflate inputs are auto-detected. Raw deflate requires the
   * explicit `deflate-raw` format.
   *
   * ```typescript no_run
   * import { ZlibDecompressor } from 'internal:compress/zlib';
   * const inflate = new ZlibDecompressor('gzip');
   * ```
   */
  constructor(format: ZlibCompressionFormat) {
    super(windowBitsForDecompress(format), Z_DEFAULT_COMPRESSION, false);
  }
}
