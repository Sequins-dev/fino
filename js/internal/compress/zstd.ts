/**
* internal:compress/zstd — Zstandard codec backend for `fino:compress`.
*
* Loads the platform `libzstd` through `fino:ffi` when the module is first
* imported, probing a short list of candidate paths (the Homebrew and
* `/usr/local` dylibs on macOS, `libzstd.so.1` then `libzstd.so` elsewhere).
* A missing library is not an import-time error: `zstdAvailable` records
* whether the load succeeded, and every helper throws a plain `Error` when it
* did not. `fino:compress` branches on that flag to report the `zstd` format
* as unavailable instead of failing.
*
* Two API shapes are provided. The one-shot helpers `zstdCompress` and
* `zstdDecompress` handle complete in-memory buffers. The streaming codecs
* `ZstdCompressor` and `ZstdDecompressor` implement the shared
* `CompressionTransform` contract from `internal:compress/common`, which is
* how `fino:compress` exposes them behind its format-dispatching stream API.
* The streaming path drives `ZSTD_compressStream2` / `ZSTD_decompressStream`
* directly, reusing one output scratch buffer and two 24-byte
* `ZSTD_inBuffer`/`ZSTD_outBuffer` structs per codec, so the only per-codec
* native allocation is the zstd context itself.
*
* Hidden from generated application docs; availability and options are
* documented on `fino:compress`.
*
* ```ts no_run
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
* Zstandard format: https://www.rfc-editor.org/rfc/rfc8878
* libzstd manual: https://facebook.github.io/zstd/zstd_manual.html
*
* @internal
*/
import { dlopen, Pointer, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
import { concat, toU8, type ByteInput, type CompressionTransform } from './common.ts';
/**
* Options accepted by the Zstandard compression entry points.
*
* Both the one-shot `zstdCompress` and the streaming `ZstdCompressor` take
* this shape; decompression has no options because the frame header carries
* everything the decoder needs.
*
* ```ts no_run
* import { zstdCompress, type ZstdCompressionOptions } from 'internal:compress/zstd';
*
* const opts: ZstdCompressionOptions = { level: 19 };
* const packed = zstdCompress(new Uint8Array(1024), opts);
* ```
*
* @internal
*/
export interface ZstdCompressionOptions {
  /**
  * Zstandard compression level, forwarded to the library unchanged.
  *
  * Defaults to 3 — libzstd's own default. Regular levels run 1..22 (higher
  * is smaller and slower). Because the value is passed straight through,
  * zstd's special values also work: 0 selects the library default and
  * negative values select the "fast" levels. Out-of-range levels are
  * clamped by libzstd rather than rejected here.
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
* Whether the platform `libzstd` could be loaded.
*
* Probed once at module load. When this is `false`, `zstdCompress`,
* `zstdDecompress`, and both streaming codec constructors throw
* `Error('zstd library not available')`, so callers should branch on this
* flag before offering the format.
*
* ```ts no_run
* import { zstdAvailable, zstdCompress } from 'internal:compress/zstd';
*
* const payload = new TextEncoder().encode('body');
* const encoded = zstdAvailable ? zstdCompress(payload) : payload;
* ```
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
* Compress a complete buffer into a single Zstandard frame.
*
* Allocates a worst-case output buffer sized by `ZSTD_compressBound` and
* returns a trimmed copy of exactly the compressed bytes, so the result does
* not pin the oversized scratch allocation. The whole input must already be
* in memory; use `ZstdCompressor` for incremental or large data.
*
* Throws if `libzstd` is unavailable, or if the library reports an error —
* the message then includes the `ZSTD_getErrorName` text.
*
* ```ts no_run
* import { zstdCompress } from 'internal:compress/zstd';
*
* const data = new TextEncoder().encode(JSON.stringify({ hello: 'world' }));
* const frame = zstdCompress(data, { level: 12 });
* console.log(`${data.byteLength} -> ${frame.byteLength} bytes`);
* ```
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
* Runs a `ZstdDecompressor` over the input internally, so no
* decompressed-size hint is required and a buffer made of several
* concatenated frames decodes into one contiguous result.
*
* Throws if `libzstd` is unavailable or the input is not valid Zstandard
* data. Input truncated mid-frame is not detected — the streaming decoder
* simply stops — so integrity-sensitive callers should verify lengths or
* checksums separately.
*
* ```ts no_run
* import { zstdCompress, zstdDecompress } from 'internal:compress/zstd';
*
* const frame = zstdCompress(new TextEncoder().encode('hello'));
* const text = new TextDecoder().decode(zstdDecompress(frame));
* console.assert(text === 'hello');
* ```
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
* Shared streaming machinery for the Zstandard codecs.
*
* Owns the output scratch buffer — sized to the library's recommended
* `ZSTD_CStreamOutSize`/`ZSTD_DStreamOutSize` — and two reusable 24-byte
* `ZSTD_inBuffer`/`ZSTD_outBuffer` structs that subclasses point at each
* chunk. It also implements the lifetime half of `CompressionTransform`:
* `close` is idempotent and frees the native context through the subclass
* `dispose`, `transform` closes in a `finally` even when the consumer stops
* early, and `[Symbol.dispose]` supports `using` declarations. Once closed,
* `write` and `finish` throw `Error('compression stream is closed')`.
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
  /**
  * Feed one chunk of input and return any output chunks produced.
  */
  abstract write(chunk: ByteInput): Uint8Array[];
  /**
  * Finalize the stream, returning any trailing output, and close the codec.
  */
  abstract finish(): Uint8Array[];
  /**
  * Pipe an async source of chunks through the codec.
  *
  * Yields every chunk produced by `write` for each input, then the chunks
  * from `finish`. The codec is closed in a `finally` block, so native state
  * is released even when the consumer breaks out early or the source throws
  * — either way the codec is single-use.
  *
  * ```ts no_run
  * import { ZstdCompressor } from 'internal:compress/zstd';
  *
  * async function* chunks() {
  *   yield new TextEncoder().encode('hello ');
  *   yield new TextEncoder().encode('world');
  * }
  * for await (const part of new ZstdCompressor().transform(chunks())) {
  *   console.log(part.byteLength);
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
  * Release the native Zstandard context.
  *
  * Idempotent: the first call frees the context and marks the codec closed;
  * later calls return immediately. `finish` and `transform` close
  * automatically, so an explicit `close` is only needed when abandoning a
  * stream midway.
  */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispose();
  }
  protected abstract dispose(): void;
  /**
  * Alias for `close` so codecs work with `using` declarations.
  */
  [Symbol.dispose](): void {
    this.close();
  }
}
/**
* Streaming Zstandard compressor producing a single frame.
*
* Wraps a `ZSTD_CCtx`: each `write` feeds a chunk with `ZSTD_e_continue` and
* returns whatever compressed bytes the library emits (possibly none — zstd
* buffers input internally until it has enough to compress), and `finish`
* flushes with `ZSTD_e_end` until the frame epilogue is fully written, then
* closes the codec. The native context is freed by `finish` even when
* flushing fails, and any use after that throws.
*
* ```ts no_run
* import { ZstdCompressor } from 'internal:compress/zstd';
*
* const incoming = [new Uint8Array(65536), new Uint8Array(1024)];
* using codec = new ZstdCompressor({ level: 9 });
* const parts: Uint8Array[] = [];
* for (const chunk of incoming) parts.push(...codec.write(chunk));
* parts.push(...codec.finish());
* ```
*
* @internal
*/
export class ZstdCompressor extends ZstdCodec {
  #lib = requireZstd();
  #cctx: Pointer;
  /**
  * Create a compression context and apply the requested level.
  *
  * Throws if `libzstd` is unavailable, if `ZSTD_createCCtx` fails, or if
  * setting the compression level is rejected by the library.
  */
  constructor(opts?: ZstdCompressionOptions) {
    const lib = requireZstd();
    super(Number(lib.symbols.ZSTD_CStreamOutSize()));
    const cctx = lib.symbols.ZSTD_createCCtx();
    if (!cctx) throw new Error('ZSTD_createCCtx failed');
    this.#cctx = cctx;
    checkZstd(lib, BigInt(lib.symbols.ZSTD_CCtx_setParameter(cctx, ZSTD_C_COMPRESSION_LEVEL, opts?.level ?? ZSTD_DEFAULT_LEVEL)), 'ZSTD_CCtx_setParameter');
  }
  /**
  * Compress one chunk, returning zero or more output chunks.
  *
  * Loops until zstd has consumed the whole input, copying the scratch
  * buffer out each time compressed bytes are produced. An empty result just
  * means the data is buffered inside the compressor; it will surface in a
  * later `write` or in `finish`. Throws if the codec is closed or the
  * library reports an error.
  */
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
  /**
  * Flush buffered data, terminate the frame, and close the codec.
  *
  * Repeats `ZSTD_e_end` flushes until zstd reports the epilogue complete,
  * so the returned chunks always end a well-formed frame. The codec is
  * closed on the way out — including when an error is thrown — so a
  * compressor cannot be reused after `finish`. Throws if already closed.
  */
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
* Wraps a `ZSTD_DCtx` and drives `ZSTD_decompressStream`: each `write`
* consumes one compressed chunk and returns the plaintext produced so far.
* Chunk boundaries are arbitrary — input may split frames anywhere, and
* several concatenated frames decode back-to-back through one instance. All
* output is produced during `write`; `finish` only closes the native
* context.
*
* ```ts no_run
* import { ZstdDecompressor } from 'internal:compress/zstd';
*
* async function inflate(source: AsyncIterable<Uint8Array>) {
*   const codec = new ZstdDecompressor();
*   const plain: Uint8Array[] = [];
*   try {
*     for await (const chunk of source) plain.push(...codec.write(chunk));
*     codec.finish();
*   } finally {
*     codec.close();
*   }
*   return plain;
* }
* ```
*
* @internal
*/
export class ZstdDecompressor extends ZstdCodec {
  #lib = requireZstd();
  #dctx: Pointer;
  /**
  * Create a decompression context.
  *
  * Throws if `libzstd` is unavailable or `ZSTD_createDCtx` fails.
  */
  constructor() {
    const lib = requireZstd();
    super(Number(lib.symbols.ZSTD_DStreamOutSize()));
    const dctx = lib.symbols.ZSTD_createDCtx();
    if (!dctx) throw new Error('ZSTD_createDCtx failed');
    this.#dctx = dctx;
  }
  /**
  * Decompress one chunk, returning zero or more plaintext chunks.
  *
  * Loops until the whole input is consumed, so a single call can emit many
  * chunks when the data expands well past the scratch buffer size. Throws
  * if the codec is closed or the input is not valid Zstandard data.
  */
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
  /**
  * Close the codec and return an empty array.
  *
  * Decompression produces all output during `write`, so there is nothing to
  * flush. No end-of-frame validation happens here: input truncated
  * mid-frame is not reported as an error. Throws if the codec was already
  * closed.
  */
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
