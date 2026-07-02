/**
* Zstandard compression backend for `fino:compress`.
*
* Loads the platform `libzstd` through `fino:ffi` and implements the one-shot
* and streaming Zstandard codecs used by the public compression module. Hidden
* from generated application docs; availability and options are documented on
* `fino:compress`.
*
* ## Example
*
* ```typescript no_run
* import * as zstd from 'internal:compress/zstd';
*
* if (zstd.zstdAvailable) {
*   const input = new TextEncoder().encode('payload');
*   const compressed = zstd.zstdCompress(input, { level: 5 });
*   const restored = zstd.zstdDecompress(compressed);
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
* Options used by the Zstandard backend.
*
* `level` maps to the Zstandard compression level (roughly 1..22) and defaults
* to 3, matching the library default.
*
* @internal
*/
export interface ZstdCompressionOptions {
  /**
  * Optional Zstandard compression level.
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
const zstdPaths = isDarwin ? [
  '/opt/homebrew/lib/libzstd.dylib',
  '/usr/local/lib/libzstd.dylib',
  'libzstd.dylib'
] : ['libzstd.so.1', 'libzstd.so'];
const zstdSymbols = {
  ZSTD_compressBound: {
    parameters: ['usize'],
    result: 'usize'
  },
  ZSTD_compress: {
    parameters: [
      'buffer',
      'usize',
      'buffer',
      'usize',
      'i32'
    ],
    result: 'usize'
  },
  ZSTD_isError: {
    parameters: ['usize'],
    result: 'u32'
  },
  ZSTD_getErrorName: {
    parameters: ['usize'],
    result: 'pointer'
  },
  ZSTD_createCCtx: {
    parameters: [],
    result: 'pointer'
  },
  ZSTD_freeCCtx: {
    parameters: ['pointer'],
    result: 'usize'
  },
  ZSTD_CCtx_setParameter: {
    parameters: [
      'pointer',
      'i32',
      'i32'
    ],
    result: 'usize'
  },
  ZSTD_compressStream2: {
    parameters: [
      'pointer',
      'buffer',
      'buffer',
      'i32'
    ],
    result: 'usize'
  },
  ZSTD_createDCtx: {
    parameters: [],
    result: 'pointer'
  },
  ZSTD_freeDCtx: {
    parameters: ['pointer'],
    result: 'usize'
  },
  ZSTD_decompressStream: {
    parameters: [
      'pointer',
      'buffer',
      'buffer'
    ],
    result: 'usize'
  },
  ZSTD_CStreamOutSize: {
    parameters: [],
    result: 'usize'
  },
  ZSTD_DStreamOutSize: {
    parameters: [],
    result: 'usize'
  }
} satisfies NativeSymbolMap;
type ZstdLibrary = DynamicLibrary<typeof zstdSymbols>;
const zstd = tryOpen(zstdPaths, zstdSymbols);
/**
* Whether `libzstd` was loaded. Zstandard helpers throw when this is false.
*
* @internal
*/
export const zstdAvailable = zstd !== null;
function requireZstd(): ZstdLibrary {
  if (zstd === null) throw new Error('zstd library not available');
  return zstd;
}
// ZSTD_cParameter: ZSTD_c_compressionLevel.
const ZSTD_C_COMPRESSION_LEVEL = 100;
// ZSTD_EndDirective.
const ZSTD_E_CONTINUE = 0;
const ZSTD_E_END = 2;
const ZSTD_DEFAULT_LEVEL = 3;
// ZSTD_inBuffer / ZSTD_outBuffer are { ptr; size_t size; size_t pos; } = 24 bytes.
const BUFFER_STRUCT_SIZE = 24;
function throwZstd(lib: ZstdLibrary, code: bigint | number, op: string): never {
  const namePtr = lib.symbols.ZSTD_getErrorName(BigInt(code));
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
function checkZstd(lib: ZstdLibrary, code: bigint, op: string): bigint {
  if (lib.symbols.ZSTD_isError(code) !== 0) throwZstd(lib, code, op);
  return code;
}
/**
* Compress a complete buffer with Zstandard.
*
* @internal
*/
export function zstdCompress(data: ByteInput, opts?: ZstdCompressionOptions): Uint8Array {
  const lib = requireZstd();
  const u8 = toU8(data);
  const bound = Number(lib.symbols.ZSTD_compressBound(u8.byteLength));
  const out = new Uint8Array(bound);
  const written = checkZstd(lib, BigInt(lib.symbols.ZSTD_compress(out, bound, u8, u8.byteLength, opts?.level ?? ZSTD_DEFAULT_LEVEL)), 'ZSTD_compress');
  return out.subarray(0, Number(written)).slice();
}
/**
* Decompress a complete Zstandard buffer (one or more frames).
*
* @internal
*/
export function zstdDecompress(data: ByteInput): Uint8Array {
  const decoder = new ZstdDecompressor();
  const parts: Uint8Array[] = [];
  for (const part of decoder.write(data)) parts.push(part);
  for (const part of decoder.finish()) parts.push(part);
  return concat(parts);
}
/**
* Shared state for the streaming Zstandard codecs: an output scratch buffer and
* two reusable 24-byte `ZSTD_inBuffer`/`ZSTD_outBuffer` structs.
*
* @internal
*/
abstract class ZstdCodec implements CompressionTransform {
  #closed = false;
  protected chunkSize: number;
  protected outBuf: ArrayBuffer;
  protected outAddr: bigint;
  protected inStruct = new ArrayBuffer(BUFFER_STRUCT_SIZE);
  protected outStruct = new ArrayBuffer(BUFFER_STRUCT_SIZE);
  protected inDv = new DataView(this.inStruct);
  protected outDv = new DataView(this.outStruct);
  constructor(chunkSize: number) {
    this.chunkSize = chunkSize;
    this.outBuf = new ArrayBuffer(chunkSize);
    this.outAddr = Pointer.addr(this.outBuf);
  }
  protected setIn(u8: Uint8Array): void {
    this.inDv.setBigUint64(0, u8.byteLength > 0 ? Pointer.addr(u8) : 0n, true);
    this.inDv.setBigUint64(8, BigInt(u8.byteLength), true);
    this.inDv.setBigUint64(16, 0n, true);
  }
  protected resetOut(): void {
    this.outDv.setBigUint64(0, this.outAddr, true);
    this.outDv.setBigUint64(8, BigInt(this.chunkSize), true);
    this.outDv.setBigUint64(16, 0n, true);
  }
  protected get inPos(): number {
    return Number(this.inDv.getBigUint64(16, true));
  }
  protected get inSize(): number {
    return Number(this.inDv.getBigUint64(8, true));
  }
  protected takeOut(parts: Uint8Array[]): void {
    const produced = Number(this.outDv.getBigUint64(16, true));
    if (produced > 0) parts.push(new Uint8Array(this.outBuf, 0, produced).slice());
  }
  protected assertOpen(): void {
    if (this.#closed) throw new Error('compression stream is closed');
  }
  abstract write(chunk: ByteInput): Uint8Array[];
  abstract finish(): Uint8Array[];
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
    this.dispose();
  }
  protected abstract dispose(): void;
  [Symbol.dispose](): void {
    this.close();
  }
}
/**
* Streaming Zstandard compressor.
*
* @internal
*/
export class ZstdCompressor extends ZstdCodec {
  #lib = requireZstd();
  #cctx: Pointer;
  constructor(opts?: ZstdCompressionOptions) {
    const lib = requireZstd();
    super(Number(lib.symbols.ZSTD_CStreamOutSize()));
    const cctx = lib.symbols.ZSTD_createCCtx();
    if (!cctx) throw new Error('ZSTD_createCCtx failed');
    this.#cctx = cctx;
    checkZstd(lib, BigInt(lib.symbols.ZSTD_CCtx_setParameter(cctx, ZSTD_C_COMPRESSION_LEVEL, opts?.level ?? ZSTD_DEFAULT_LEVEL)), 'ZSTD_CCtx_setParameter');
  }
  write(chunk: ByteInput): Uint8Array[] {
    this.assertOpen();
    const u8 = toU8(chunk);
    this.setIn(u8);
    const parts: Uint8Array[] = [];
    while (this.inPos < this.inSize) {
      this.resetOut();
      checkZstd(this.#lib, BigInt(this.#lib.symbols.ZSTD_compressStream2(this.#cctx, this.outStruct, this.inStruct, ZSTD_E_CONTINUE)), 'ZSTD_compressStream2');
      this.takeOut(parts);
    }
    return parts;
  }
  finish(): Uint8Array[] {
    this.assertOpen();
    this.setIn(new Uint8Array(0));
    const parts: Uint8Array[] = [];
    try {
      let remaining;
      do {
        this.resetOut();
        remaining = Number(checkZstd(this.#lib, BigInt(this.#lib.symbols.ZSTD_compressStream2(this.#cctx, this.outStruct, this.inStruct, ZSTD_E_END)), 'ZSTD_compressStream2'));
        this.takeOut(parts);
      } while (remaining !== 0);
      return parts;
    } finally {
      this.close();
    }
  }
  protected dispose(): void {
    try {
      this.#lib.symbols.ZSTD_freeCCtx(this.#cctx);
    } catch (_) {}
  }
}
/**
* Streaming Zstandard decompressor.
*
* @internal
*/
export class ZstdDecompressor extends ZstdCodec {
  #lib = requireZstd();
  #dctx: Pointer;
  constructor() {
    const lib = requireZstd();
    super(Number(lib.symbols.ZSTD_DStreamOutSize()));
    const dctx = lib.symbols.ZSTD_createDCtx();
    if (!dctx) throw new Error('ZSTD_createDCtx failed');
    this.#dctx = dctx;
  }
  write(chunk: ByteInput): Uint8Array[] {
    this.assertOpen();
    const u8 = toU8(chunk);
    this.setIn(u8);
    const parts: Uint8Array[] = [];
    while (this.inPos < this.inSize) {
      this.resetOut();
      checkZstd(this.#lib, BigInt(this.#lib.symbols.ZSTD_decompressStream(this.#dctx, this.outStruct, this.inStruct)), 'ZSTD_decompressStream');
      this.takeOut(parts);
    }
    return parts;
  }
  finish(): Uint8Array[] {
    this.assertOpen();
    this.close();
    return [];
  }
  protected dispose(): void {
    try {
      this.#lib.symbols.ZSTD_freeDCtx(this.#dctx);
    } catch (_) {}
  }
}
