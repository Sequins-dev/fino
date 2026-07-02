/**
* Parquet DELTA encodings and a byte-stream-split codec.
*
* - DELTA_BINARY_PACKED: delta + zig-zag + bit-packed miniblocks (INT32/INT64).
* - DELTA_LENGTH_BYTE_ARRAY: delta-packed lengths then concatenated bytes.
* - DELTA_BYTE_ARRAY: incremental (prefix + suffix) with delta-packed lengths.
* - BYTE_STREAM_SPLIT: per-byte planes of a fixed-width type.
*
* All are implemented in both directions so the writer can emit them and the
* reader can decode any spec-compliant file.
*
* Reference: https://parquet.apache.org/docs/file-format/data-pages/encodings/
*
* @internal
*/
import { ByteReader, ByteWriter } from 'internal:format/thrift';
import { PType } from './types.ts';
const BLOCK_SIZE = 128;
const MINIBLOCKS = 4;
const VALUES_PER_MINIBLOCK = BLOCK_SIZE / MINIBLOCKS;
// LSB-first bit reader/writer over bigint (widths up to 64).
class BitReader {
  #r: ByteReader;
  #cur = 0n;
  #bits = 0;
  constructor(r: ByteReader) {
    this.#r = r;
  }
  read(bitWidth: number): bigint {
    while (this.#bits < bitWidth) {
      this.#cur |= BigInt(this.#r.readU8()) << BigInt(this.#bits);
      this.#bits += 8;
    }
    const mask = (1n << BigInt(bitWidth)) - 1n;
    const val = this.#cur & mask;
    this.#cur >>= BigInt(bitWidth);
    this.#bits -= bitWidth;
    return val;
  }
}
class BitWriter {
  #w: ByteWriter;
  #cur = 0n;
  #bits = 0;
  constructor(w: ByteWriter) {
    this.#w = w;
  }
  write(value: bigint, bitWidth: number): void {
    const mask = (1n << BigInt(bitWidth)) - 1n;
    this.#cur |= (value & mask) << BigInt(this.#bits);
    this.#bits += bitWidth;
    while (this.#bits >= 8) {
      this.#w.writeU8(Number(this.#cur & 255n));
      this.#cur >>= 8n;
      this.#bits -= 8;
    }
  }
  flush(): void {
    if (this.#bits > 0) {
      this.#w.writeU8(Number(this.#cur & 255n));
      this.#cur = 0n;
      this.#bits = 0;
    }
  }
}
function bitsFor(value: bigint): number {
  let n = value < 0n ? -value : value;
  let bits = 0;
  while (n > 0n) {
    n >>= 1n;
    bits++;
  }
  return bits;
}
// --- DELTA_BINARY_PACKED ---------------------------------------------------
/** Decode DELTA_BINARY_PACKED into signed `bigint`s. @internal */
export function decodeDeltaBinaryPacked(bytes: Uint8Array, count: number): bigint[] {
  const r = new ByteReader(bytes);
  const blockSize = Number(r.readVarint());
  const miniblocks = Number(r.readVarint());
  const totalCount = Number(r.readVarint());
  const valuesPerMiniblock = blockSize / miniblocks;
  const out: bigint[] = [];
  if (totalCount === 0) return out;
  let value = r.readZigzag64();
  out.push(value);
  while (out.length < totalCount && out.length < count) {
    const minDelta = r.readZigzag64();
    const widths: number[] = [];
    for (let m = 0; m < miniblocks; m++) widths.push(r.readU8());
    const bits = new BitReader(r);
    for (let m = 0; m < miniblocks && out.length < totalCount; m++) {
      const width = widths[m]!;
      for (let i = 0; i < valuesPerMiniblock; i++) {
        const rel = width === 0 ? 0n : bits.read(width);
        value += minDelta + rel;
        if (out.length < totalCount) out.push(value);
      }
    }
  }
  return out.slice(0, Math.min(count, totalCount));
}
/** Encode signed values (number|bigint) as DELTA_BINARY_PACKED. @internal */
export function encodeDeltaBinaryPacked(values: (number | bigint)[]): Uint8Array {
  const w = new ByteWriter();
  w.writeVarint(BLOCK_SIZE);
  w.writeVarint(MINIBLOCKS);
  w.writeVarint(values.length);
  if (values.length === 0) return w.bytes();
  const vals = values.map((v) => BigInt(v));
  w.writeZigzag64(vals[0]!);
  const deltas: bigint[] = [];
  for (let i = 1; i < vals.length; i++) deltas.push(vals[i]! - vals[i - 1]!);
  for (let start = 0; start < deltas.length; start += BLOCK_SIZE) {
    const block = deltas.slice(start, start + BLOCK_SIZE);
    let minDelta = block[0]!;
    for (const d of block) if (d < minDelta) minDelta = d;
    w.writeZigzag64(minDelta);
    // Compute per-miniblock bit widths.
    const rels = block.map((d) => d - minDelta);
    const widths: number[] = [];
    for (let m = 0; m < MINIBLOCKS; m++) {
      let maxBits = 0;
      for (let i = 0; i < VALUES_PER_MINIBLOCK; i++) {
        const idx = m * VALUES_PER_MINIBLOCK + i;
        if (idx < rels.length) maxBits = Math.max(maxBits, bitsFor(rels[idx]!));
      }
      widths.push(maxBits);
    }
    for (const width of widths) w.writeU8(width);
    const bits = new BitWriter(w);
    for (let m = 0; m < MINIBLOCKS; m++) {
      const width = widths[m]!;
      if (width === 0) continue;
      for (let i = 0; i < VALUES_PER_MINIBLOCK; i++) {
        const idx = m * VALUES_PER_MINIBLOCK + i;
        bits.write(idx < rels.length ? rels[idx]! : 0n, width);
      }
      bits.flush();
    }
  }
  return w.bytes();
}
// --- DELTA_LENGTH_BYTE_ARRAY -----------------------------------------------
/** Decode DELTA_LENGTH_BYTE_ARRAY into byte strings. @internal */
export function decodeDeltaLengthByteArray(bytes: Uint8Array, count: number): Uint8Array[] {
  const r = new ByteReader(bytes);
  const lengths = decodeDeltaHeaderInline(r, count);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) out.push(r.readBytes(Number(lengths[i]!)).slice());
  return out;
}
/** Encode byte strings as DELTA_LENGTH_BYTE_ARRAY. @internal */
export function encodeDeltaLengthByteArray(values: Uint8Array[]): Uint8Array {
  const lengths = values.map((v) => v.byteLength);
  const lengthBytes = encodeDeltaBinaryPacked(lengths);
  const w = new ByteWriter();
  w.writeBytes(lengthBytes);
  for (const v of values) w.writeBytes(v);
  return w.bytes();
}
// Decode a delta-binary-packed length stream embedded at the reader cursor.
function decodeDeltaHeaderInline(r: ByteReader, count: number): bigint[] {
  const blockSize = Number(r.readVarint());
  const miniblocks = Number(r.readVarint());
  const totalCount = Number(r.readVarint());
  const valuesPerMiniblock = blockSize / miniblocks;
  const out: bigint[] = [];
  if (totalCount === 0) return out;
  let value = r.readZigzag64();
  out.push(value);
  while (out.length < totalCount) {
    const minDelta = r.readZigzag64();
    const widths: number[] = [];
    for (let m = 0; m < miniblocks; m++) widths.push(r.readU8());
    const bits = new BitReader(r);
    for (let m = 0; m < miniblocks && out.length < totalCount; m++) {
      const width = widths[m]!;
      for (let i = 0; i < valuesPerMiniblock; i++) {
        const rel = width === 0 ? 0n : bits.read(width);
        value += minDelta + rel;
        if (out.length < totalCount) out.push(value);
      }
    }
  }
  void count;
  return out;
}
// --- DELTA_BYTE_ARRAY ------------------------------------------------------
/** Decode DELTA_BYTE_ARRAY (incremental prefix+suffix) into byte strings. @internal */
export function decodeDeltaByteArray(bytes: Uint8Array, count: number): Uint8Array[] {
  const r = new ByteReader(bytes);
  const prefixLengths = decodeDeltaHeaderInline(r, count);
  const suffixLengths = decodeDeltaHeaderInline(r, count);
  const out: Uint8Array[] = [];
  let prev = new Uint8Array(0);
  for (let i = 0; i < count; i++) {
    const prefixLen = Number(prefixLengths[i]!);
    const suffixLen = Number(suffixLengths[i]!);
    const suffix = r.readBytes(suffixLen);
    const value = new Uint8Array(prefixLen + suffixLen);
    value.set(prev.subarray(0, prefixLen), 0);
    value.set(suffix, prefixLen);
    out.push(value);
    prev = value;
  }
  return out;
}
/** Encode byte strings as DELTA_BYTE_ARRAY. @internal */
export function encodeDeltaByteArray(values: Uint8Array[]): Uint8Array {
  const prefixLengths: number[] = [];
  const suffixLengths: number[] = [];
  const suffixes: Uint8Array[] = [];
  let prev = new Uint8Array(0);
  for (const value of values) {
    let prefix = 0;
    const max = Math.min(prev.byteLength, value.byteLength);
    while (prefix < max && prev[prefix] === value[prefix]) prefix++;
    prefixLengths.push(prefix);
    suffixLengths.push(value.byteLength - prefix);
    suffixes.push(value.subarray(prefix));
    prev = value;
  }
  const w = new ByteWriter();
  w.writeBytes(encodeDeltaBinaryPacked(prefixLengths));
  w.writeBytes(encodeDeltaBinaryPacked(suffixLengths));
  for (const s of suffixes) w.writeBytes(s);
  return w.bytes();
}
// --- BYTE_STREAM_SPLIT -----------------------------------------------------
function elementWidth(physicalType: number, typeLength?: number): number {
  switch (physicalType) {
    case PType.FLOAT: return 4;
    case PType.DOUBLE: return 8;
    case PType.INT32: return 4;
    case PType.INT64: return 8;
    case PType.FIXED_LEN_BYTE_ARRAY: return typeLength ?? 0;
    default: return 0;
  }
}
/** Decode BYTE_STREAM_SPLIT: reconstruct interleaved fixed-width elements. @internal */
export function decodeByteStreamSplit(bytes: Uint8Array, count: number, physicalType: number, typeLength?: number): unknown[] {
  const width = elementWidth(physicalType, typeLength);
  const reassembled = new Uint8Array(count * width);
  for (let b = 0; b < width; b++) {
    for (let i = 0; i < count; i++) reassembled[i * width + b] = bytes[b * count + i]!;
  }
  return decodeFixedWidth(reassembled, count, physicalType, width);
}
/** Encode fixed-width values as BYTE_STREAM_SPLIT. @internal */
export function encodeByteStreamSplit(values: unknown[], physicalType: number, typeLength?: number): Uint8Array {
  const width = elementWidth(physicalType, typeLength);
  const interleaved = encodeFixedWidth(values, physicalType, width);
  const out = new Uint8Array(values.length * width);
  for (let b = 0; b < width; b++) {
    for (let i = 0; i < values.length; i++) out[b * values.length + i] = interleaved[i * width + b]!;
  }
  return out;
}
function decodeFixedWidth(bytes: Uint8Array, count: number, physicalType: number, width: number): unknown[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<unknown>(count);
  for (let i = 0; i < count; i++) {
    switch (physicalType) {
      case PType.FLOAT:
        out[i] = dv.getFloat32(i * 4, true);
        break;
      case PType.DOUBLE:
        out[i] = dv.getFloat64(i * 8, true);
        break;
      case PType.INT32:
        out[i] = dv.getInt32(i * 4, true);
        break;
      case PType.INT64:
        out[i] = dv.getBigInt64(i * 8, true);
        break;
      default: out[i] = bytes.subarray(i * width, (i + 1) * width).slice();
    }
  }
  return out;
}
function encodeFixedWidth(values: unknown[], physicalType: number, width: number): Uint8Array {
  const out = new Uint8Array(values.length * width);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    switch (physicalType) {
      case PType.FLOAT:
        dv.setFloat32(i * 4, Number(values[i]), true);
        break;
      case PType.DOUBLE:
        dv.setFloat64(i * 8, Number(values[i]), true);
        break;
      case PType.INT32:
        dv.setInt32(i * 4, Number(values[i]), true);
        break;
      case PType.INT64:
        dv.setBigInt64(i * 8, BigInt(values[i] as number | bigint), true);
        break;
      default: out.set((values[i] as Uint8Array).subarray(0, width), i * width);
    }
  }
  return out;
}
