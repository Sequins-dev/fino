import { dlopen, Pointer, type DynamicLibrary, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
import { concat, toU8, type ByteInput, type CompressionTransform } from './common.mts';

export interface BrotliCompressionOptions { level?: number; }

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

export function brotliDecompress(data: ByteInput): Uint8Array {
  const brotli = requireBrotliDecoder();
  const u8 = toU8(data);

  let outSize = Math.max(u8.byteLength * 256, 65536);
  const maxOut = 256 * 1024 * 1024;
  while (outSize <= maxOut) {
    const outBuf = new ArrayBuffer(outSize);
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

class BrotliCodec implements CompressionTransform {
  #state: Pointer | null;
  #closed = false;
  #finished = false;
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

export class BrotliCompressor extends BrotliCodec {
  #brotli = requireBrotliEncoder();

  constructor(opts?: BrotliCompressionOptions) {
    const state = requireBrotliEncoder().symbols.BrotliEncoderCreateInstance(null, null, null);
    if (!state) throw new Error('BrotliEncoderCreateInstance failed');
    super(state);
    this.#brotli.symbols.BrotliEncoderSetParameter(this.state, BROTLI_PARAM_QUALITY, opts?.level ?? BROTLI_DEFAULT_QUALITY);
    this.#brotli.symbols.BrotliEncoderSetParameter(this.state, BROTLI_PARAM_LGWIN, BROTLI_DEFAULT_WINDOW);
  }

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

  close(): void {
    try {
      this.#brotli.symbols.BrotliEncoderDestroyInstance(this.state);
    } catch (_) {
      // Already closed.
    }
    super.close();
  }
}

export class BrotliDecompressor extends BrotliCodec {
  #brotli = requireBrotliDecoder();

  constructor() {
    const state = requireBrotliDecoder().symbols.BrotliDecoderCreateInstance(null, null, null);
    if (!state) throw new Error('BrotliDecoderCreateInstance failed');
    super(state);
  }

  write(chunk: ByteInput): Uint8Array[] {
    this.assertOpen();
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

      if (result === BROTLI_DECODER_RESULT_SUCCESS) { this.finished = true; break; }
      if (result !== BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT &&
          result !== BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT) {
        throw new Error(`BrotliDecoderDecompressStream failed (result=${result})`);
      }

      remaining = Number(dvAI.getBigUint64(0, true));
    } while (remaining > 0 || this.#brotli.symbols.BrotliDecoderHasMoreOutput(this.state));

    return parts;
  }

  finish(): Uint8Array[] {
    this.assertOpen();
    try {
      this.finished = true;
      return [];
    } finally {
      this.close();
    }
  }

  close(): void {
    try {
      this.#brotli.symbols.BrotliDecoderDestroyInstance(this.state);
    } catch (_) {
      // Already closed.
    }
    super.close();
  }
}

export function collectBrotliTransform(codec: CompressionTransform, chunks: ByteInput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const chunk of chunks) parts.push(...codec.write(chunk));
  parts.push(...codec.finish());
  return concat(parts);
}
