/**
* LZ4 frame compression backend for `fino:compress`.
*
* Loads the platform `liblz4` through `fino:ffi` (Homebrew and system paths on
* macOS, `liblz4.so.1`/`liblz4.so` on Linux) and implements the one-shot and
* streaming LZ4 Frame (`.lz4`) codecs used by the public compression module.
* This is the interoperable frame format (magic `0x184D2204`) understood by
* the `lz4` CLI and other LZ4 Frame implementations, not the raw LZ4 block
* format. Hidden from generated application docs; availability and options are
* documented on `fino:compress`.
*
* Library loading happens once at module import. When no candidate path can be
* opened, `lz4Available` is `false` and every codec entry point throws rather
* than silently degrading — callers are expected to guard on the flag.
*
* The one-shot helpers (`lz4Compress` / `lz4Decompress`) are thin wrappers
* over the streaming classes (`Lz4Compressor` / `Lz4Decompressor`), so there
* is a single frame-construction path and one-shot output is byte-identical to
* streamed output. The streaming classes implement the shared
* `CompressionTransform` contract from `internal:compress/common`: synchronous
* `write`/`finish` calls that return zero or more output chunks, an async
* `transform` adapter, and explicit `close` (plus `Symbol.dispose`) to free
* the native LZ4F contexts.
*
* ## Example
*
* ```ts no_run
* import * as lz4 from 'internal:compress/lz4';
*
* if (lz4.lz4Available) {
*   const input = new TextEncoder().encode('payload');
*   const compressed = lz4.lz4Compress(input);
*   const restored = lz4.lz4Decompress(compressed);
*   console.assert(new TextDecoder().decode(restored) === 'payload');
* }
* ```
*
* LZ4 Frame format:
* https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md
*
* @internal
*/
import { dlopen, Pointer, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
import { concat, toU8, type ByteInput, type CompressionTransform } from './common.ts';
/**
* Options accepted by the LZ4 backend.
*
* The shape mirrors the other backend option types so `fino:compress` can hand
* a uniform `{ level }` bag to whichever format is selected. In liblz4 terms
* `level` would select the LZ4 Frame compression level (0 for fast mode,
* higher values for LZ4-HC); this backend currently writes every frame with
* the library's default preferences — level 0, fast mode — so a supplied
* `level` is accepted but not yet applied to the native compressor.
*
* ```ts no_run
* import { Lz4Compressor, type Lz4CompressionOptions } from 'internal:compress/lz4';
*
* const opts: Lz4CompressionOptions = { level: 0 };
* const compressor = new Lz4Compressor(opts);
* ```
*
* @internal
*/
export interface Lz4CompressionOptions {
  /**
  * Requested LZ4 Frame compression level.
  *
  * Present for interface parity with the other backends; frames are
  * currently produced with default (level 0) preferences regardless of this
  * value.
  */
  level?: number;
}
const isDarwin = os === 'darwin';
function tryOpen<TSymbols extends NativeSymbolMap>(paths: string[], symbols: TSymbols): DynamicLibrary<TSymbols> | null {
  for (const p of paths) {
    try {
      return dlopen(p, symbols);
    } catch (_) {}
  }
  return null;
}
const lz4Paths = isDarwin ? [
  '/opt/homebrew/lib/liblz4.dylib',
  '/usr/local/lib/liblz4.dylib',
  'liblz4.dylib'
] : ['liblz4.so.1', 'liblz4.so'];
const lz4Symbols = {
  LZ4F_isError: {
    parameters: ['usize'],
    result: 'u32'
  },
  LZ4F_getErrorName: {
    parameters: ['usize'],
    result: 'pointer'
  },
  LZ4F_compressBound: {
    parameters: ['usize', 'pointer'],
    result: 'usize'
  },
  LZ4F_createCompressionContext: {
    parameters: ['buffer', 'u32'],
    result: 'usize'
  },
  LZ4F_freeCompressionContext: {
    parameters: ['pointer'],
    result: 'usize'
  },
  LZ4F_compressBegin: {
    parameters: [
      'pointer',
      'buffer',
      'usize',
      'pointer'
    ],
    result: 'usize'
  },
  LZ4F_compressUpdate: {
    parameters: [
      'pointer',
      'buffer',
      'usize',
      'buffer',
      'usize',
      'pointer'
    ],
    result: 'usize'
  },
  LZ4F_compressEnd: {
    parameters: [
      'pointer',
      'buffer',
      'usize',
      'pointer'
    ],
    result: 'usize'
  },
  LZ4F_createDecompressionContext: {
    parameters: ['buffer', 'u32'],
    result: 'usize'
  },
  LZ4F_freeDecompressionContext: {
    parameters: ['pointer'],
    result: 'usize'
  },
  LZ4F_decompress: {
    parameters: [
      'pointer',
      'buffer',
      'buffer',
      'buffer',
      'buffer',
      'pointer'
    ],
    result: 'usize'
  }
} satisfies NativeSymbolMap;
type Lz4Library = DynamicLibrary<typeof lz4Symbols>;
const lz4 = tryOpen(lz4Paths, lz4Symbols);
/**
* Whether the platform `liblz4` library was found and loaded.
*
* Determined once at module load by probing the platform-specific candidate
* paths. When `false`, `lz4Compress`, `lz4Decompress`, and both streaming
* class constructors throw `lz4 library not available` — guard on this flag
* before offering LZ4 as a format.
*
* ```ts no_run
* import { lz4Available, lz4Compress } from 'internal:compress/lz4';
*
* if (lz4Available) {
*   const frame = lz4Compress(new Uint8Array([1, 2, 3]));
* }
* ```
*
* @internal
*/
export const lz4Available = lz4 !== null;
function requireLz4(): Lz4Library {
  if (lz4 === null) throw new Error('lz4 library not available');
  return lz4;
}
const LZ4F_VERSION = 100;
const CHUNK = 65536;
function throwLz4(lib: Lz4Library, code: bigint | number, op: string): never {
  const namePtr = lib.symbols.LZ4F_getErrorName(BigInt(code));
  let name = '';
  if (namePtr !== null) {
    for (let i = 0; i < 256; i++) {
      const byte = Pointer.readU8(namePtr, i);
      if (byte === 0) break;
      name += String.fromCharCode(byte);
    }
  }
  throw new Error(`${op} failed: ${name || `code ${code}`}`);
}
function check(lib: Lz4Library, code: bigint, op: string): bigint {
  if (lib.symbols.LZ4F_isError(code) !== 0) throwLz4(lib, code, op);
  return code;
}
/**
* Compress a complete buffer into a single LZ4 frame.
*
* Accepts a `Uint8Array` or `ArrayBuffer` and returns a self-contained `.lz4`
* frame — header, compressed blocks, and end mark — that any LZ4 Frame
* decoder can read. Internally drives a temporary `Lz4Compressor`, so
* one-shot output is byte-identical to streaming the same input. Empty input
* still produces a valid (empty) frame.
*
* Throws if `liblz4` is not available or the native compressor reports an
* error.
*
* ```ts no_run
* import { lz4Compress } from 'internal:compress/lz4';
*
* const input = new TextEncoder().encode('hello '.repeat(1000));
* const frame = lz4Compress(input);
* console.assert(frame.byteLength < input.byteLength);
* ```
*
* @internal
*/
export function lz4Compress(data: ByteInput, opts?: Lz4CompressionOptions): Uint8Array {
  // LZ4F_compressFrame with NULL prefs uses default (level 0) settings; route
  // through the streaming compressor so the level option is honored and there
  // is a single frame-construction path.
  const compressor = new Lz4Compressor(opts);
  const parts: Uint8Array[] = [];
  for (const part of compressor.write(data)) parts.push(part);
  for (const part of compressor.finish()) parts.push(part);
  return concat(parts);
}
/**
* Decompress a buffer containing one or more complete LZ4 frames.
*
* The whole input must be present up front; use `Lz4Decompressor` for
* incremental input. Frames concatenated back to back are all decoded and
* their contents returned as one contiguous `Uint8Array`.
*
* Throws if `liblz4` is not available or the input is not valid LZ4 Frame
* data. A truncated final frame is not detected: decoding stops at the end of
* the available bytes and returns the partial output without error.
*
* ```ts no_run
* import { lz4Compress, lz4Decompress } from 'internal:compress/lz4';
*
* const frame = lz4Compress(new TextEncoder().encode('payload'));
* const restored = lz4Decompress(frame);
* console.assert(new TextDecoder().decode(restored) === 'payload');
* ```
*
* @internal
*/
export function lz4Decompress(data: ByteInput): Uint8Array {
  const decoder = new Lz4Decompressor();
  const parts: Uint8Array[] = [];
  for (const part of decoder.write(data)) parts.push(part);
  for (const part of decoder.finish()) parts.push(part);
  return concat(parts);
}
/**
* Streaming LZ4 Frame compressor.
*
* Wraps a native `LZ4F_cctx`. The frame header is emitted lazily by the first
* `write` (or by `finish` for an empty stream), each `write` returns zero or
* more compressed chunks, and `finish` flushes the frame end mark and
* releases the native context. Once finished or closed the instance is dead:
* further `write`/`finish` calls throw `compression stream is closed`.
*
* Returned chunks are freshly copied `Uint8Array`s; concatenated in order
* they form exactly one valid `.lz4` frame. For async byte streams prefer
* `transform`, which guarantees cleanup even when the consumer stops early.
*
* ```ts no_run
* import { Lz4Compressor } from 'internal:compress/lz4';
*
* const compressor = new Lz4Compressor();
* const parts: Uint8Array[] = [];
* parts.push(...compressor.write(new TextEncoder().encode('hello ')));
* parts.push(...compressor.write(new TextEncoder().encode('world')));
* parts.push(...compressor.finish()); // frame is now complete
* ```
*
* @internal
*/
export class Lz4Compressor implements CompressionTransform {
  #lib = requireLz4();
  #cctx: Pointer;
  #closed = false;
  #begun = false;
  /**
  * Create a compressor and allocate its native compression context.
  *
  * Options are accepted for parity with the other backends; see
  * `Lz4CompressionOptions` for what is currently honored. Throws if `liblz4`
  * is unavailable or the context cannot be allocated.
  */
  constructor(_opts?: Lz4CompressionOptions) {
    const ctxBuf = new ArrayBuffer(8);
    check(this.#lib, BigInt(this.#lib.symbols.LZ4F_createCompressionContext(ctxBuf, LZ4F_VERSION)), 'LZ4F_createCompressionContext');
    // The 8-byte buffer now holds the cctx pointer; reuse it as the pointer arg.
    this.#cctx = ctxBuf;
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('compression stream is closed');
  }
  #begin(): Uint8Array[] {
    if (this.#begun) return [];
    this.#begun = true;
    const header = new Uint8Array(64);
    const n = Number(check(this.#lib, BigInt(this.#lib.symbols.LZ4F_compressBegin(this.#cctx, header, header.byteLength, null)), 'LZ4F_compressBegin'));
    return n > 0 ? [header.subarray(0, n).slice()] : [];
  }
  /**
  * Compress one chunk, returning zero or more output chunks.
  *
  * The first call also emits the frame header. An empty chunk is legal and
  * produces at most the header. Because the native compressor accumulates
  * data into full blocks, a call may return only the header — or nothing —
  * until enough input has been buffered; `finish` flushes whatever remains.
  *
  * Throws if the stream is already closed or the native compressor reports
  * an error.
  */
  write(chunk: ByteInput): Uint8Array[] {
    this.#assertOpen();
    const parts = this.#begin();
    const u8 = toU8(chunk);
    if (u8.byteLength === 0) return parts;
    const bound = Number(this.#lib.symbols.LZ4F_compressBound(u8.byteLength, null));
    const out = new Uint8Array(bound);
    const n = Number(check(this.#lib, BigInt(this.#lib.symbols.LZ4F_compressUpdate(this.#cctx, out, bound, u8, u8.byteLength, null)), 'LZ4F_compressUpdate'));
    if (n > 0) parts.push(out.subarray(0, n).slice());
    return parts;
  }
  /**
  * Finalize the frame and close the compressor.
  *
  * Flushes any buffered input plus the frame end mark, emitting the header
  * first if nothing was ever written — so finishing an untouched compressor
  * yields a well-formed empty frame. The native context is released even
  * when the native call fails, and subsequent `write`/`finish` calls throw.
  */
  finish(): Uint8Array[] {
    this.#assertOpen();
    const parts = this.#begin();
    try {
      const bound = Number(this.#lib.symbols.LZ4F_compressBound(0, null)) + 8;
      const out = new Uint8Array(bound);
      const n = Number(check(this.#lib, BigInt(this.#lib.symbols.LZ4F_compressEnd(this.#cctx, out, bound, null)), 'LZ4F_compressEnd'));
      if (n > 0) parts.push(out.subarray(0, n).slice());
      return parts;
    } finally {
      this.close();
    }
  }
  /**
  * Compress an async stream of chunks into an async stream of frame bytes.
  *
  * Feeds each chunk of `source` through `write`, then yields the `finish`
  * output. The compressor is closed in a `finally` block, so an error or an
  * early-terminating consumer still frees the native context.
  *
  * ```ts no_run
  * for await (const part of compressor.transform(chunks)) {
  *   sink.write(part);
  * }
  * ```
  */
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
  /**
  * Release the native compression context.
  *
  * Idempotent. `finish` and `transform` call this automatically; call it
  * directly only when abandoning a stream mid-frame, in which case the
  * output produced so far is not a complete frame.
  */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#lib.symbols.LZ4F_freeCompressionContext(this.#cctx);
    } catch (_) {}
  }
  /**
  * Disposes the compressor for `using` declarations by delegating to
  * `close`.
  */
  [Symbol.dispose](): void {
    this.close();
  }
}
/**
* Streaming LZ4 Frame decompressor.
*
* Wraps a native `LZ4F_dctx`. Input may be split at arbitrary byte
* boundaries: each `write` consumes the entire chunk (looping the native
* decoder as needed) and returns whatever decoded bytes it produced.
* Back-to-back frames in the input are all decoded by the same instance.
*
* `finish` only releases the native context — it does not verify that the
* final frame terminated cleanly, so truncated input yields partial output
* without error. Structurally invalid data (bad magic, corrupt blocks,
* checksum mismatch) makes `write` throw.
*
* ```ts no_run
* import { Lz4Decompressor } from 'internal:compress/lz4';
*
* const decoder = new Lz4Decompressor();
* const out: Uint8Array[] = [];
* for (const piece of framePieces) {
*   out.push(...decoder.write(piece));
* }
* decoder.finish();
* ```
*
* @internal
*/
export class Lz4Decompressor implements CompressionTransform {
  #lib = requireLz4();
  #dctx: Pointer;
  #closed = false;
  #srcSizeBuf = new ArrayBuffer(8);
  #dstSizeBuf = new ArrayBuffer(8);
  #srcSizeDv = new DataView(this.#srcSizeBuf);
  #dstSizeDv = new DataView(this.#dstSizeBuf);
  #out = new Uint8Array(CHUNK);
  /**
  * Create a decompressor and allocate its native decompression context.
  *
  * Throws if `liblz4` is unavailable or the context cannot be allocated.
  */
  constructor() {
    const ctxBuf = new ArrayBuffer(8);
    check(this.#lib, BigInt(this.#lib.symbols.LZ4F_createDecompressionContext(ctxBuf, LZ4F_VERSION)), 'LZ4F_createDecompressionContext');
    this.#dctx = ctxBuf;
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('compression stream is closed');
  }
  /**
  * Decode one chunk of frame bytes, returning zero or more output chunks.
  *
  * A single call can span block, frame-header, and frame boundaries, so
  * callers never need to align input with the frame structure. Returns an
  * empty array when the bytes only advance internal state (for example a
  * partial frame header). Output chunks are freshly copied and at most 64
  * KiB each.
  *
  * Throws if the stream is closed or the data is not valid LZ4 Frame
  * content.
  */
  write(chunk: ByteInput): Uint8Array[] {
    this.#assertOpen();
    const u8 = toU8(chunk);
    const parts: Uint8Array[] = [];
    let offset = 0;
    // LZ4F_decompress consumes a prefix of the input each call; loop until the
    // whole chunk is consumed, growing output through the reusable scratch.
    while (offset < u8.byteLength || u8.byteLength === 0) {
      const remaining = u8.subarray(offset);
      this.#srcSizeDv.setBigUint64(0, BigInt(remaining.byteLength), true);
      this.#dstSizeDv.setBigUint64(0, BigInt(this.#out.byteLength), true);
      check(this.#lib, BigInt(this.#lib.symbols.LZ4F_decompress(this.#dctx, this.#out, this.#dstSizeBuf, remaining, this.#srcSizeBuf, null)), 'LZ4F_decompress');
      const produced = Number(this.#dstSizeDv.getBigUint64(0, true));
      const consumed = Number(this.#srcSizeDv.getBigUint64(0, true));
      if (produced > 0) parts.push(this.#out.subarray(0, produced).slice());
      offset += consumed;
      if (u8.byteLength === 0) break;
      if (consumed === 0 && produced === 0) break;
    }
    return parts;
  }
  /**
  * Close the decompressor.
  *
  * Always returns an empty array — all decoded bytes come from `write`.
  * Releases the native context without validating that the final frame
  * terminated cleanly; callers that must detect truncation need to track
  * expected sizes themselves. Subsequent `write`/`finish` calls throw.
  */
  finish(): Uint8Array[] {
    this.#assertOpen();
    this.close();
    return [];
  }
  /**
  * Decode an async stream of frame bytes into an async stream of output.
  *
  * Feeds each chunk of `source` through `write`, then finishes. The
  * decompressor is closed in a `finally` block, so an error or an
  * early-terminating consumer still frees the native context.
  *
  * ```ts no_run
  * for await (const part of decoder.transform(frameChunks)) {
  *   sink.write(part);
  * }
  * ```
  */
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
  /**
  * Release the native decompression context.
  *
  * Idempotent. `finish` and `transform` call this automatically; call it
  * directly only when abandoning a stream before the input is exhausted.
  */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#lib.symbols.LZ4F_freeDecompressionContext(this.#dctx);
    } catch (_) {}
  }
  /**
  * Disposes the decompressor for `using` declarations by delegating to
  * `close`.
  */
  [Symbol.dispose](): void {
    this.close();
  }
}
