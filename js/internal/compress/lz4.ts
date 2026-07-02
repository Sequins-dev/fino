/**
* LZ4 frame compression backend for `fino:compress`.
*
* Loads the platform `liblz4` through `fino:ffi` and implements the one-shot
* and streaming LZ4 Frame (`.lz4`) codecs used by the public compression
* module. This is the interoperable frame format (magic `0x184D2204`), not the
* raw LZ4 block format. Hidden from generated application docs; availability
* and options are documented on `fino:compress`.
*
* ## Example
*
* ```typescript no_run
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
* @internal
*/
import { dlopen, Pointer, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
import { concat, toU8, type ByteInput, type CompressionTransform } from './common.ts';
/**
* Options used by the LZ4 backend.
*
* `level` maps to the LZ4 Frame compression level (0 for fast mode, up to ~12
* for LZ4-HC) and defaults to 0.
*
* @internal
*/
export interface Lz4CompressionOptions {
  /**
  * Optional LZ4 Frame compression level.
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
* Whether `liblz4` was loaded. LZ4 helpers throw when this is false.
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
* Compress a complete buffer as a single LZ4 frame.
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
* Decompress a complete LZ4 frame buffer (one or more frames).
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
* @internal
*/
export class Lz4Compressor implements CompressionTransform {
  #lib = requireLz4();
  #cctx: Pointer;
  #closed = false;
  #begun = false;
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
    this.#closed = true;
    try {
      this.#lib.symbols.LZ4F_freeCompressionContext(this.#cctx);
    } catch (_) {}
  }
  [Symbol.dispose](): void {
    this.close();
  }
}
/**
* Streaming LZ4 Frame decompressor.
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
  constructor() {
    const ctxBuf = new ArrayBuffer(8);
    check(this.#lib, BigInt(this.#lib.symbols.LZ4F_createDecompressionContext(ctxBuf, LZ4F_VERSION)), 'LZ4F_createDecompressionContext');
    this.#dctx = ctxBuf;
  }
  #assertOpen(): void {
    if (this.#closed) throw new Error('compression stream is closed');
  }
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
  finish(): Uint8Array[] {
    this.#assertOpen();
    this.close();
    return [];
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
    this.#closed = true;
    try {
      this.#lib.symbols.LZ4F_freeDecompressionContext(this.#dctx);
    } catch (_) {}
  }
  [Symbol.dispose](): void {
    this.close();
  }
}
