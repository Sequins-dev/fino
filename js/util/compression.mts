/**
 * fino:compression — gzip, deflate, brotli
 *
 * Wraps system zlib (always available) and optional brotli (homebrew on macOS,
 * libbrotli on Linux) via FFI.
 *
 * ## One-shot API
 *
 * ```ts
 *   import { gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw,
 *            brotliCompress, brotliDecompress, brotliAvailable } from './compression.mts';
 *
 *   const compressed = gzip(new Uint8Array([...]));          // → Uint8Array
 *   const original   = gunzip(compressed);                  // → Uint8Array
 * ```
 *
 * ## Streaming API
 *
 * ```ts
 *   import { createGzip, createGunzip } from './compression.mts';
 *
 *   const gz = createGzip({ level: 6 });
 *   for await (const chunk of gz.transform(source)) { ... }
 *   // or: await writer.pipe(gz.transform(reader));
 * ```
 *
 * Options: { level } — 0-9 for zlib, 0-11 for brotli.
 */

import { dlopen, Pointer, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';

export interface CompressionOptions { level?: number; }

// ---------------------------------------------------------------------------
// Library loading
// ---------------------------------------------------------------------------

const _isDarwin = os === 'darwin';

function _tryOpen<TSymbols extends NativeSymbolMap>(paths: string[], symbols: TSymbols): DynamicLibrary<TSymbols> | null {
  for (const p of paths) {
    try { return dlopen(p, symbols); } catch (_) {}
  }
  return null;
}

const _zlibPaths = _isDarwin
  ? ['/usr/lib/libz.1.dylib', '/opt/homebrew/lib/libz.dylib', 'libz.dylib']
  : ['libz.so.1', 'libz.so'];

const _brotliEncPaths = _isDarwin
  ? ['/opt/homebrew/lib/libbrotlienc.dylib', '/usr/local/lib/libbrotlienc.dylib', 'libbrotlienc.dylib']
  : ['libbrotlienc.so.1', 'libbrotlienc.so'];

const _brotliDecPaths = _isDarwin
  ? ['/opt/homebrew/lib/libbrotlidec.dylib', '/usr/local/lib/libbrotlidec.dylib', 'libbrotlidec.dylib']
  : ['libbrotlidec.so.1', 'libbrotlidec.so'];

const _zlibSymbols = {
  deflateInit2_: { parameters: ['buffer', 'i32', 'i32', 'i32', 'i32', 'i32', 'buffer', 'i32'], result: 'i32' },
  deflate:       { parameters: ['buffer', 'i32'], result: 'i32' },
  deflateEnd:    { parameters: ['buffer'], result: 'i32' },
  inflateInit2_: { parameters: ['buffer', 'i32', 'buffer', 'i32'], result: 'i32' },
  inflate:       { parameters: ['buffer', 'i32'], result: 'i32' },
  inflateEnd:    { parameters: ['buffer'], result: 'i32' },
  compressBound: { parameters: ['usize'], result: 'usize' },
} satisfies NativeSymbolMap;

const _brotliEncSymbols = {
  BrotliEncoderCreateInstance:   { parameters: ['pointer', 'pointer', 'pointer'], result: 'pointer' },
  BrotliEncoderDestroyInstance:  { parameters: ['pointer'], result: 'void' },
  BrotliEncoderSetParameter:     { parameters: ['pointer', 'i32', 'u32'], result: 'i32' },
  BrotliEncoderCompress:         { parameters: ['i32', 'i32', 'i32', 'usize', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliEncoderCompressStream:   { parameters: ['pointer', 'i32', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliEncoderHasMoreOutput:    { parameters: ['pointer'], result: 'i32' },
  BrotliEncoderIsFinished:       { parameters: ['pointer'], result: 'i32' },
  BrotliEncoderMaxCompressedSize: { parameters: ['usize'], result: 'usize' },
} satisfies NativeSymbolMap;

const _brotliDecSymbols = {
  BrotliDecoderCreateInstance:      { parameters: ['pointer', 'pointer', 'pointer'], result: 'pointer' },
  BrotliDecoderDestroyInstance:     { parameters: ['pointer'], result: 'void' },
  BrotliDecoderDecompress:          { parameters: ['usize', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliDecoderDecompressStream:    { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  BrotliDecoderHasMoreOutput:       { parameters: ['pointer'], result: 'i32' },
  BrotliDecoderIsFinished:          { parameters: ['pointer'], result: 'i32' },
} satisfies NativeSymbolMap;

type ZlibLibrary = DynamicLibrary<typeof _zlibSymbols>;
type BrotliEncoderLibrary = DynamicLibrary<typeof _brotliEncSymbols>;
type BrotliDecoderLibrary = DynamicLibrary<typeof _brotliDecSymbols>;

const _zlib    = _tryOpen(_zlibPaths, _zlibSymbols);
const _brotliE = _tryOpen(_brotliEncPaths, _brotliEncSymbols);
const _brotliD = _tryOpen(_brotliDecPaths, _brotliDecSymbols);

if (!_zlib) throw new Error('fino:compression: could not load zlib');

/** True when brotli encode/decode libraries are available. */
export const brotliAvailable = _brotliE !== null && _brotliD !== null;

function _requireZlib(): ZlibLibrary {
  if (_zlib === null) throw new Error('fino:compression: could not load zlib');
  return _zlib;
}

function _requireBrotliEncoder(): BrotliEncoderLibrary {
  if (_brotliE === null) throw new Error('brotli library not available');
  return _brotliE;
}

function _requireBrotliDecoder(): BrotliDecoderLibrary {
  if (_brotliD === null) throw new Error('brotli library not available');
  return _brotliD;
}

// ---------------------------------------------------------------------------
// zlib constants
// ---------------------------------------------------------------------------

const Z_OK         = 0;
const Z_STREAM_END = 1;
const Z_BUF_ERROR  = -5;

const Z_NO_FLUSH  = 0;
const Z_FINISH    = 4;

const Z_DEFLATED         = 8;
const Z_DEFAULT_STRATEGY = 0;
const Z_DEFAULT_COMPRESSION = -1;

// windowBits encoding:
//   +16   → gzip header/trailer
//   +32   → auto-detect zlib or gzip on inflate
//   negative → raw deflate (no header)
const W_ZLIB   = 15;
const W_GZIP   = 15 + 16;   // 31
const W_RAW    = -15;
const W_AUTO   = 15 + 32;   // 47  (inflate auto-detect)

// z_stream struct size on LP64 (64-bit macOS and Linux): 112 bytes.
const Z_STREAM_SIZE = 112;

// Output chunk size for streaming operations.
const CHUNK = 65536;

// "1.2.12\0" — zlib's deflateInit2_/inflateInit2_ only checks version[0] == '1'.
const _ZLIB_VERSION_BUF = new Uint8Array([49, 46, 50, 46, 49, 50, 0]).buffer;

// ---------------------------------------------------------------------------
// brotli constants
// ---------------------------------------------------------------------------

const BROTLI_PARAM_QUALITY    = 1;
const BROTLI_PARAM_LGWIN      = 2;
const BROTLI_DEFAULT_QUALITY  = 11;
const BROTLI_DEFAULT_WINDOW   = 22;
const BROTLI_MODE_GENERIC     = 0;
const BROTLI_OPERATION_PROCESS = 0;
const BROTLI_OPERATION_FINISH  = 2;
const BROTLI_DECODER_RESULT_SUCCESS         = 1;
const BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT = 3;

// ---------------------------------------------------------------------------
// z_stream struct wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps a 112-byte z_stream ArrayBuffer, exposing helpers to read/write
 * the fields zlib cares about between calls.
 *
 * z_stream layout on LP64 (offsets in bytes):
 *   0   next_in   (pointer, 8)
 *   8   avail_in  (uint32, 4) + 4 padding
 *  16   total_in  (uint64, 8)
 *  24   next_out  (pointer, 8)
 *  32   avail_out (uint32, 4) + 4 padding
 *  40   total_out (uint64, 8)
 *  64   zalloc    (pointer, 8) — zero → use default malloc
 *  72   zfree     (pointer, 8) — zero → use default free
 *  80   opaque    (pointer, 8)
 */
class ZStream {
  #buf  = new ArrayBuffer(Z_STREAM_SIZE);
  #view = new DataView(this.#buf);

  get buffer() { return this.#buf; }

  /**
   * Point next_in at the given Uint8Array's data (including byteOffset).
   * Sets avail_in to u8.byteLength.
   */
  setInput(u8: Uint8Array): void {
    const addr = u8.byteLength > 0 ? Pointer.addr(u8) : 0n;
    this.#view.setBigUint64(0, addr, true);
    this.#view.setUint32(8, u8.byteLength, true);
  }

  /**
   * Point next_out at the given ArrayBuffer (byteOffset 0 assumed).
   * Sets avail_out to buf.byteLength.
   */
  setOutput(buf: ArrayBuffer): void {
    const addr = Pointer.addr(buf);
    this.#view.setBigUint64(24, addr, true);
    this.#view.setUint32(32, buf.byteLength, true);
  }

  /** Bytes of input remaining after the last call. */
  get availIn()  { return this.#view.getUint32(8,  true); }
  /** Free bytes in the output buffer after the last call. */
  get availOut() { return this.#view.getUint32(32, true); }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _toU8(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function _concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) {
    const part = parts[0];
    if (part === undefined) return new Uint8Array(0);
    return part;
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
  return out;
}

// ---------------------------------------------------------------------------
// One-shot zlib
// ---------------------------------------------------------------------------

/**
 * Compress data using deflate (all-in-one).
 * windowBits controls the format (gzip, zlib, raw).
 */
function _deflateOneShot(data: Uint8Array | ArrayBuffer, windowBits: number, level: number): Uint8Array {
  const zlib = _requireZlib();
  const u8  = _toU8(data);
  const zs  = new ZStream();
  const r0  = zlib.symbols.deflateInit2_(
    zs.buffer, level, Z_DEFLATED, windowBits, 8, Z_DEFAULT_STRATEGY,
    _ZLIB_VERSION_BUF, Z_STREAM_SIZE,
  );
  if (r0 !== Z_OK) throw new Error(`zlib deflateInit2_ failed (${r0})`);

  zs.setInput(u8);
  const outBuf = new ArrayBuffer(CHUNK);
  const parts  = [];
  let total = 0;

  try {
    let r;
    do {
      zs.setOutput(outBuf);
      r = zlib.symbols.deflate(zs.buffer, Z_FINISH);
      const produced = CHUNK - zs.availOut;
      if (produced > 0) {
        parts.push(new Uint8Array(outBuf, 0, produced).slice());
        total += produced;
      }
      if (r !== Z_OK && r !== Z_BUF_ERROR && r !== Z_STREAM_END)
        throw new Error(`zlib deflate error (${r})`);
    } while (r !== Z_STREAM_END);
  } finally {
    zlib.symbols.deflateEnd(zs.buffer);
  }

  return _concat(parts, total);
}

/**
 * Decompress data using inflate (all-in-one).
 * windowBits controls format detection.
 */
function _inflateOneShot(data: Uint8Array | ArrayBuffer, windowBits: number): Uint8Array {
  const zlib = _requireZlib();
  const u8  = _toU8(data);
  const zs  = new ZStream();
  const r0  = zlib.symbols.inflateInit2_(
    zs.buffer, windowBits, _ZLIB_VERSION_BUF, Z_STREAM_SIZE,
  );
  if (r0 !== Z_OK) throw new Error(`zlib inflateInit2_ failed (${r0})`);

  zs.setInput(u8);
  const outBuf = new ArrayBuffer(CHUNK);
  const parts  = [];
  let total = 0;
  let done  = false;

  try {
    let r;
    do {
      zs.setOutput(outBuf);
      r = zlib.symbols.inflate(zs.buffer, Z_NO_FLUSH);
      const produced = CHUNK - zs.availOut;
      if (produced > 0) {
        parts.push(new Uint8Array(outBuf, 0, produced).slice());
        total += produced;
      }
      if (r === Z_STREAM_END) { done = true; break; }
      if (r !== Z_OK && r !== Z_BUF_ERROR)
        throw new Error(`zlib inflate error (${r})`);
    } while (zs.availIn > 0 || zs.availOut === 0);
  } finally {
    zlib.symbols.inflateEnd(zs.buffer);
  }

  if (!done) throw new Error('zlib inflate: unexpected end of compressed data');
  return _concat(parts, total);
}

// ---------------------------------------------------------------------------
// One-shot public API — zlib
// ---------------------------------------------------------------------------

/** Compress data to gzip format. */
export function gzip(data: Uint8Array | ArrayBuffer, opts?: CompressionOptions): Uint8Array {
  return _deflateOneShot(data, W_GZIP, opts?.level ?? Z_DEFAULT_COMPRESSION);
}

/** Decompress gzip data (auto-detects zlib or gzip). */
export function gunzip(data: Uint8Array | ArrayBuffer): Uint8Array {
  return _inflateOneShot(data, W_AUTO);
}

/** Compress data to zlib format. */
export function deflate(data: Uint8Array | ArrayBuffer, opts?: CompressionOptions): Uint8Array {
  return _deflateOneShot(data, W_ZLIB, opts?.level ?? Z_DEFAULT_COMPRESSION);
}

/** Decompress zlib data (auto-detects zlib or gzip). */
export function inflate(data: Uint8Array | ArrayBuffer): Uint8Array {
  return _inflateOneShot(data, W_AUTO);
}

/** Compress data to raw deflate format (no zlib/gzip header). */
export function deflateRaw(data: Uint8Array | ArrayBuffer, opts?: CompressionOptions): Uint8Array {
  return _deflateOneShot(data, W_RAW, opts?.level ?? Z_DEFAULT_COMPRESSION);
}

/** Decompress raw deflate data. */
export function inflateRaw(data: Uint8Array | ArrayBuffer): Uint8Array {
  return _inflateOneShot(data, W_RAW);
}

// ---------------------------------------------------------------------------
// Streaming zlib transform
// ---------------------------------------------------------------------------

/**
 * Creates a zlib streaming transform factory.
 *
 * The returned function accepts `{ level }` options and returns an object
 * with a `transform(asyncIterable)` method that yields compressed/decompressed
 * Uint8Array chunks.
 */
function _makeZlibTransformFactory(windowBits: number, defaultLevel: number, isDeflate: boolean) {
  return function(opts?: CompressionOptions) {
    const level = opts?.level ?? defaultLevel;
    return {
      transform(source: AsyncIterable<Uint8Array | ArrayBuffer>) {
        return {
          [Symbol.asyncIterator]() {
            return _zlibTransformIterator(source, windowBits, level, isDeflate);
          },
        };
      },
    };
  };
}

async function* _zlibTransformIterator(source: AsyncIterable<Uint8Array | ArrayBuffer>, windowBits: number, level: number, isDeflate: boolean): AsyncGenerator<Uint8Array> {
  const zlib = _requireZlib();
  const zs  = new ZStream();
  const r0  = isDeflate
    ? zlib.symbols.deflateInit2_(zs.buffer, level, Z_DEFLATED, windowBits, 8, Z_DEFAULT_STRATEGY, _ZLIB_VERSION_BUF, Z_STREAM_SIZE)
    : zlib.symbols.inflateInit2_(zs.buffer, windowBits, _ZLIB_VERSION_BUF, Z_STREAM_SIZE);
  if (r0 !== Z_OK) throw new Error(`zlib init failed (${r0})`);

  const outBuf = new ArrayBuffer(CHUNK);

  try {
    for await (const chunk of source) {
      const u8 = _toU8(chunk);
      zs.setInput(u8);

      let r;
      do {
        zs.setOutput(outBuf);
        r = isDeflate
          ? zlib.symbols.deflate(zs.buffer, Z_NO_FLUSH)
          : zlib.symbols.inflate(zs.buffer, Z_NO_FLUSH);

        const produced = CHUNK - zs.availOut;
        if (produced > 0) yield new Uint8Array(outBuf, 0, produced).slice();

        if (r === Z_STREAM_END) return;
        if (r !== Z_OK && r !== Z_BUF_ERROR) throw new Error(`zlib error (${r})`);
      } while (zs.availIn > 0 || zs.availOut === 0);
    }

    // For deflate: flush any buffered output.
    if (isDeflate) {
      zs.setInput(new Uint8Array(0));
      let r;
      do {
        zs.setOutput(outBuf);
        r = zlib.symbols.deflate(zs.buffer, Z_FINISH);
        const produced = CHUNK - zs.availOut;
        if (produced > 0) yield new Uint8Array(outBuf, 0, produced).slice();
        if (r !== Z_OK && r !== Z_BUF_ERROR && r !== Z_STREAM_END)
          throw new Error(`zlib finish error (${r})`);
      } while (r !== Z_STREAM_END);
    }
  } finally {
    if (isDeflate) zlib.symbols.deflateEnd(zs.buffer);
    else           zlib.symbols.inflateEnd(zs.buffer);
  }
}

// ---------------------------------------------------------------------------
// Streaming public API — zlib
// ---------------------------------------------------------------------------

export const createGzip       = _makeZlibTransformFactory(W_GZIP, Z_DEFAULT_COMPRESSION, true);
export const createGunzip     = _makeZlibTransformFactory(W_AUTO, Z_DEFAULT_COMPRESSION, false);
export const createDeflate    = _makeZlibTransformFactory(W_ZLIB, Z_DEFAULT_COMPRESSION, true);
export const createInflate    = _makeZlibTransformFactory(W_AUTO, Z_DEFAULT_COMPRESSION, false);
export const createDeflateRaw = _makeZlibTransformFactory(W_RAW,  Z_DEFAULT_COMPRESSION, true);
export const createInflateRaw = _makeZlibTransformFactory(W_RAW,  Z_DEFAULT_COMPRESSION, false);

// ---------------------------------------------------------------------------
// One-shot brotli
// ---------------------------------------------------------------------------

/** Compress data using brotli. Throws if brotli is not available. */
export function brotliCompress(data: Uint8Array | ArrayBuffer, opts?: CompressionOptions): Uint8Array {
  if (!brotliAvailable) throw new Error('brotli library not available');
  const brotli = _requireBrotliEncoder();
  const u8      = _toU8(data);
  const quality = opts?.level ?? BROTLI_DEFAULT_QUALITY;

  const maxSize = Number(brotli.symbols.BrotliEncoderMaxCompressedSize(u8.byteLength));
  const outBuf  = new ArrayBuffer(maxSize);
  // encoded_size is an in/out parameter: pass max, read back actual.
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

/** Decompress brotli data. Throws if brotli is not available. */
export function brotliDecompress(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (!brotliAvailable) throw new Error('brotli library not available');
  const brotli = _requireBrotliDecoder();
  const u8 = _toU8(data);

  // BrotliDecoderDecompress (one-shot) returns ERROR for both corrupt data AND
  // output buffer too small — it can't distinguish them. Retry with exponentially
  // larger buffers. Start at 256× the compressed size so highly-compressible data
  // (e.g. 'A'×100K at low quality) succeeds on the first try without wasting memory.
  // After enough retries the output ceiling makes corrupt-data failures terminal.
  let outSize = Math.max(u8.byteLength * 256, 65536);
  const MAX_OUT = 256 * 1024 * 1024; // 256 MB ceiling
  while (outSize <= MAX_OUT) {
    const outBuf  = new ArrayBuffer(outSize);
    const sizeBuf = new ArrayBuffer(8);
    new DataView(sizeBuf).setBigUint64(0, BigInt(outSize), true);

    const result = brotli.symbols.BrotliDecoderDecompress(
      u8.byteLength, u8, sizeBuf, outBuf,
    );

    if (result === BROTLI_DECODER_RESULT_SUCCESS) {
      const actual = Number(new DataView(sizeBuf).getBigUint64(0, true));
      return new Uint8Array(outBuf, 0, actual).slice();
    }
    outSize *= 4;
  }
  throw new Error('brotliDecompress failed');
}

// ---------------------------------------------------------------------------
// Streaming brotli transform
// ---------------------------------------------------------------------------

function _makeBrotliTransformFactory(isEncode: boolean, defaultLevel: number) {
  return function(opts?: CompressionOptions) {
    const level = opts?.level ?? defaultLevel;
    return {
      transform(source: AsyncIterable<Uint8Array | ArrayBuffer>) {
        return {
          [Symbol.asyncIterator]() {
            return isEncode
              ? _brotliEncodeIterator(source, level)
              : _brotliDecodeIterator(source);
          },
        };
      },
    };
  };
}

async function* _brotliEncodeIterator(source: AsyncIterable<Uint8Array | ArrayBuffer>, level: number): AsyncGenerator<Uint8Array> {
  if (!brotliAvailable) throw new Error('brotli library not available');
  const brotli = _requireBrotliEncoder();

  const state = brotli.symbols.BrotliEncoderCreateInstance(null, null, null);
  if (!state) throw new Error('BrotliEncoderCreateInstance failed');

  brotli.symbols.BrotliEncoderSetParameter(state, BROTLI_PARAM_QUALITY, level);
  brotli.symbols.BrotliEncoderSetParameter(state, BROTLI_PARAM_LGWIN, BROTLI_DEFAULT_WINDOW);

  // Reusable output buffer and the 8-byte buffers for pointer-size in/out parameters.
  const outBuf    = new ArrayBuffer(CHUNK);
  const outBufAddr = Pointer.addr(outBuf);
  const availInBuf = new ArrayBuffer(8);
  const nextInBuf  = new ArrayBuffer(8);
  const availOutBuf = new ArrayBuffer(8);
  const nextOutBuf  = new ArrayBuffer(8);
  const dvAI = new DataView(availInBuf);
  const dvNI = new DataView(nextInBuf);
  const dvAO = new DataView(availOutBuf);
  const dvNO = new DataView(nextOutBuf);

  try {
    for await (const chunk of source) {
      const u8 = _toU8(chunk);
      const inputAddr = u8.byteLength > 0 ? Pointer.addr(u8) : 0n;

      dvAI.setBigUint64(0, BigInt(u8.byteLength), true);
      dvNI.setBigUint64(0, inputAddr, true);

      let remaining;
      do {
        dvAO.setBigUint64(0, BigInt(CHUNK), true);
        dvNO.setBigUint64(0, outBufAddr, true);

        const ok = brotli.symbols.BrotliEncoderCompressStream(
          state, BROTLI_OPERATION_PROCESS,
          availInBuf, nextInBuf, availOutBuf, nextOutBuf, null,
        );
        if (!ok) throw new Error('BrotliEncoderCompressStream failed');

        const produced = CHUNK - Number(dvAO.getBigUint64(0, true));
        if (produced > 0) yield new Uint8Array(outBuf, 0, produced).slice();

        remaining = Number(dvAI.getBigUint64(0, true));
      } while (remaining > 0 || brotli.symbols.BrotliEncoderHasMoreOutput(state));
    }

    // Finish — flush all remaining compressed output.
    dvAI.setBigUint64(0, 0n, true);
    dvNI.setBigUint64(0, 0n, true);
    while (!brotli.symbols.BrotliEncoderIsFinished(state)) {
      dvAO.setBigUint64(0, BigInt(CHUNK), true);
      dvNO.setBigUint64(0, outBufAddr, true);

      const ok = brotli.symbols.BrotliEncoderCompressStream(
        state, BROTLI_OPERATION_FINISH,
        availInBuf, nextInBuf, availOutBuf, nextOutBuf, null,
      );
      if (!ok) throw new Error('BrotliEncoderCompressStream (finish) failed');

      const produced = CHUNK - Number(dvAO.getBigUint64(0, true));
      if (produced > 0) yield new Uint8Array(outBuf, 0, produced).slice();
    }
  } finally {
    brotli.symbols.BrotliEncoderDestroyInstance(state);
  }
}

async function* _brotliDecodeIterator(source: AsyncIterable<Uint8Array | ArrayBuffer>): AsyncGenerator<Uint8Array> {
  if (!brotliAvailable) throw new Error('brotli library not available');
  const brotli = _requireBrotliDecoder();

  const state = brotli.symbols.BrotliDecoderCreateInstance(null, null, null);
  if (!state) throw new Error('BrotliDecoderCreateInstance failed');

  const outBuf     = new ArrayBuffer(CHUNK);
  const outBufAddr = Pointer.addr(outBuf);
  const availInBuf = new ArrayBuffer(8);
  const nextInBuf  = new ArrayBuffer(8);
  const availOutBuf = new ArrayBuffer(8);
  const nextOutBuf  = new ArrayBuffer(8);
  const dvAI = new DataView(availInBuf);
  const dvNI = new DataView(nextInBuf);
  const dvAO = new DataView(availOutBuf);
  const dvNO = new DataView(nextOutBuf);

  try {
    let finished = false;
    for await (const chunk of source) {
      const u8 = _toU8(chunk);
      const inputAddr = u8.byteLength > 0 ? Pointer.addr(u8) : 0n;

      dvAI.setBigUint64(0, BigInt(u8.byteLength), true);
      dvNI.setBigUint64(0, inputAddr, true);

      let remaining;
      do {
        dvAO.setBigUint64(0, BigInt(CHUNK), true);
        dvNO.setBigUint64(0, outBufAddr, true);

        const result = brotli.symbols.BrotliDecoderDecompressStream(
          state, availInBuf, nextInBuf, availOutBuf, nextOutBuf, null,
        );

        const produced = CHUNK - Number(dvAO.getBigUint64(0, true));
        if (produced > 0) yield new Uint8Array(outBuf, 0, produced).slice();

        if (result === BROTLI_DECODER_RESULT_SUCCESS) { finished = true; break; }
        if (result !== BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT &&
            result !== 2 /* NEEDS_MORE_INPUT */)
          throw new Error(`BrotliDecoderDecompressStream failed (result=${result})`);

        remaining = Number(dvAI.getBigUint64(0, true));
      } while (remaining > 0 || brotli.symbols.BrotliDecoderHasMoreOutput(state));

      if (finished) break;
    }
  } finally {
    brotli.symbols.BrotliDecoderDestroyInstance(state);
  }
}

// ---------------------------------------------------------------------------
// Streaming public API — brotli
// ---------------------------------------------------------------------------

export const createBrotliCompress   = _makeBrotliTransformFactory(true,  BROTLI_DEFAULT_QUALITY);
export const createBrotliDecompress = _makeBrotliTransformFactory(false, BROTLI_DEFAULT_QUALITY);
