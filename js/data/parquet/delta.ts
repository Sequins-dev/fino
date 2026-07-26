/**
 * internal:data/parquet/delta — Parquet DELTA encodings and the BYTE_STREAM_SPLIT codec.
 *
 * Implements four Parquet data-page encodings, each in both directions so the
 * writer can emit them and the reader can decode any spec-compliant file:
 *
 * - DELTA_BINARY_PACKED — integers as a first value plus per-block minimum
 *   delta and bit-packed miniblock deltas (INT32/INT64 columns).
 * - DELTA_LENGTH_BYTE_ARRAY — a DELTA_BINARY_PACKED stream of lengths followed
 *   by the concatenated value bytes.
 * - DELTA_BYTE_ARRAY — incremental encoding: shared-prefix lengths and suffix
 *   lengths as two DELTA_BINARY_PACKED streams, then the suffix bytes.
 * - BYTE_STREAM_SPLIT — fixed-width values scattered into per-byte planes so
 *   a downstream compressor sees the (highly repetitive) exponent/sign bytes
 *   of floats grouped together.
 *
 * The encoders always emit the block geometry recommended by the spec —
 * 128 values per block split into 4 miniblocks — while the decoders honour
 * whatever geometry the stream header declares, so files written by other
 * implementations decode correctly. All delta arithmetic runs in `bigint`,
 * keeping INT64 columns exact across the full 64-bit range.
 *
 * These are streaming codecs for a single data page: decoders take the page's
 * raw (already decompressed) bytes plus the value count from the page header,
 * and encoders return the bytes to place in a page. The column reader/writer
 * pair (`internal:data/parquet/column-reader`, `internal:data/parquet/writer`)
 * choose when each encoding applies; `internal:data/parquet/encoding` covers
 * PLAIN and dictionary pages.
 *
 * ```ts no_run
 * import {
 *   encodeDeltaBinaryPacked,
 *   decodeDeltaBinaryPacked,
 * } from 'internal:data/parquet/delta';
 *
 * const page = encodeDeltaBinaryPacked([100, 101, 103, 106]);
 * const values = decodeDeltaBinaryPacked(page, 4);
 * // values → [100n, 101n, 103n, 106n]
 * ```
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
/**
 * Decode a DELTA_BINARY_PACKED stream into signed `bigint`s.
 *
 * Block size, miniblock count, and total value count are read from the stream
 * header, so any spec-compliant geometry decodes — not just the 128/4 layout
 * this module's encoder emits. Values are always returned as `bigint`, even
 * for INT32 columns; the column reader narrows them afterwards. At most
 * `count` values are returned (and never more than the header's own total),
 * letting a caller stop early when the page header promises fewer values than
 * the stream contains.
 *
 * Throws if the input is truncated mid-header or mid-block.
 *
 * ```ts no_run
 * import { decodeDeltaBinaryPacked } from 'internal:data/parquet/delta';
 *
 * // pageBytes: decompressed DELTA_BINARY_PACKED data from an INT64 column.
 * const timestamps = decodeDeltaBinaryPacked(pageBytes, pageHeader.numValues);
 * const first = timestamps[0]; // bigint
 * ```
 *
 * @internal
 */
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
/**
 * Encode signed integers as a DELTA_BINARY_PACKED stream.
 *
 * Accepts a mix of `number` and `bigint`; everything is widened to `bigint`
 * before the delta math so 64-bit values stay exact. The output uses the
 * spec-recommended geometry (blocks of 128 values, 4 miniblocks of 32) with
 * the first value stored zig-zag in the header. Each miniblock's bit width is
 * the minimum that fits its largest delta, and a miniblock whose deltas are
 * all equal to the block minimum packs to zero bits. A short final block is
 * padded with zero deltas as the spec requires; an empty input produces just
 * the header.
 *
 * Throws if a `number` value is not a safe integer (the `BigInt` conversion
 * rejects fractional values).
 *
 * ```ts no_run
 * import { encodeDeltaBinaryPacked } from 'internal:data/parquet/delta';
 *
 * // Sorted ids compress to ~1 bit per value after the header.
 * const bytes = encodeDeltaBinaryPacked([1000n, 1001n, 1002n, 1004n]);
 * ```
 *
 * @internal
 */
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
/**
 * Decode a DELTA_LENGTH_BYTE_ARRAY stream into `count` byte strings.
 *
 * First decodes the embedded DELTA_BINARY_PACKED length stream, then slices
 * `count` values off the concatenated data that follows it. Each returned
 * `Uint8Array` is an independent copy, safe to hold after the page buffer is
 * reused. For UTF8 columns the caller decodes the bytes to strings.
 *
 * Throws if the stream is truncated — either inside the length header or when
 * the data section is shorter than the lengths promise.
 *
 * ```ts no_run
 * import { decodeDeltaLengthByteArray } from 'internal:data/parquet/delta';
 *
 * const raw = decodeDeltaLengthByteArray(pageBytes, pageHeader.numValues);
 * const names = raw.map((b) => new TextDecoder().decode(b));
 * ```
 *
 * @internal
 */
export function decodeDeltaLengthByteArray(bytes: Uint8Array, count: number): Uint8Array[] {
  const r = new ByteReader(bytes);
  const lengths = decodeDeltaHeaderInline(r, count);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) out.push(r.readBytes(Number(lengths[i]!)).slice());
  return out;
}
/**
 * Encode byte strings as a DELTA_LENGTH_BYTE_ARRAY stream.
 *
 * Writes the value lengths as one DELTA_BINARY_PACKED stream, then appends
 * every value's bytes back-to-back. Compared to PLAIN this drops the per-value
 * 4-byte length prefix and lets similar lengths compress to a few bits each,
 * while keeping the value bytes contiguous for the page compressor.
 *
 * ```ts no_run
 * import { encodeDeltaLengthByteArray } from 'internal:data/parquet/delta';
 *
 * const enc = new TextEncoder();
 * const bytes = encodeDeltaLengthByteArray(
 *   ['alpha', 'beta', 'gamma'].map((s) => enc.encode(s)),
 * );
 * ```
 *
 * @internal
 */
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
/**
 * Decode a DELTA_BYTE_ARRAY (incremental) stream into `count` byte strings.
 *
 * The stream carries two embedded DELTA_BINARY_PACKED streams — shared-prefix
 * lengths and suffix lengths — followed by the concatenated suffix bytes. Each
 * value is rebuilt by copying its prefix from the previously decoded value and
 * appending its own suffix, so decoding is inherently sequential. Every result
 * is a freshly allocated `Uint8Array` that does not alias the input page.
 *
 * Throws if either length header or the suffix data is truncated.
 *
 * ```ts no_run
 * import { decodeDeltaByteArray } from 'internal:data/parquet/delta';
 *
 * // Typical for sorted string columns: 'apple', 'apples', 'apricot', ...
 * const values = decodeDeltaByteArray(pageBytes, pageHeader.numValues);
 * ```
 *
 * @internal
 */
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
/**
 * Encode byte strings as a DELTA_BYTE_ARRAY (incremental) stream.
 *
 * For each value the longest byte prefix shared with the immediately previous
 * value is factored out; only the suffix bytes are stored, alongside two
 * DELTA_BINARY_PACKED streams of prefix and suffix lengths. Highly effective
 * on sorted or clustered string data (keys, paths, timestamps-as-text), and
 * never worse than DELTA_LENGTH_BYTE_ARRAY by more than the second length
 * stream. The input order is preserved — no sorting happens here.
 *
 * ```ts no_run
 * import { encodeDeltaByteArray } from 'internal:data/parquet/delta';
 *
 * const enc = new TextEncoder();
 * const bytes = encodeDeltaByteArray(
 *   ['user/1/avatar', 'user/1/profile', 'user/2/avatar'].map((s) => enc.encode(s)),
 * );
 * ```
 *
 * @internal
 */
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
    case PType.FLOAT:
      return 4;
    case PType.DOUBLE:
      return 8;
    case PType.INT32:
      return 4;
    case PType.INT64:
      return 8;
    case PType.FIXED_LEN_BYTE_ARRAY:
      return typeLength ?? 0;
    default:
      return 0;
  }
}
/**
 * Decode a BYTE_STREAM_SPLIT stream back into `count` fixed-width values.
 *
 * The input holds one plane per byte position — all first bytes, then all
 * second bytes, and so on — each plane exactly `count` bytes long. This
 * gathers the planes back into little-endian elements and materialises them
 * by physical type: `number` for FLOAT, DOUBLE, and INT32; `bigint` for
 * INT64; a copied `Uint8Array` for FIXED_LEN_BYTE_ARRAY (which requires
 * `typeLength`, the column's declared byte width).
 *
 * ```ts no_run
 * import { decodeByteStreamSplit } from 'internal:data/parquet/delta';
 * import { PType } from 'internal:data/parquet/types';
 *
 * const doubles = decodeByteStreamSplit(
 *   pageBytes,
 *   pageHeader.numValues,
 *   PType.DOUBLE,
 * ) as number[];
 * ```
 *
 * @internal
 */
export function decodeByteStreamSplit(
  bytes: Uint8Array,
  count: number,
  physicalType: number,
  typeLength?: number,
): unknown[] {
  const width = elementWidth(physicalType, typeLength);
  const reassembled = new Uint8Array(count * width);
  for (let b = 0; b < width; b++) {
    for (let i = 0; i < count; i++) reassembled[i * width + b] = bytes[b * count + i]!;
  }
  return decodeFixedWidth(reassembled, count, physicalType, width);
}
/**
 * Encode fixed-width values as a BYTE_STREAM_SPLIT stream.
 *
 * Serialises the values little-endian, then scatters them into per-byte
 * planes: byte 0 of every value, then byte 1 of every value, and so on. The
 * transform is size-neutral on its own — its value is that grouping the
 * slowly-varying bytes of floats (sign/exponent) makes the subsequent page
 * compression far more effective. Supported physical types are FLOAT, DOUBLE,
 * INT32, INT64 (as `number` or `bigint`), and FIXED_LEN_BYTE_ARRAY, which
 * takes `Uint8Array` values and requires `typeLength`.
 *
 * ```ts no_run
 * import { encodeByteStreamSplit } from 'internal:data/parquet/delta';
 * import { PType } from 'internal:data/parquet/types';
 *
 * const bytes = encodeByteStreamSplit([1.5, 2.5, 3.5], PType.DOUBLE);
 * ```
 *
 * @internal
 */
export function encodeByteStreamSplit(
  values: unknown[],
  physicalType: number,
  typeLength?: number,
): Uint8Array {
  const width = elementWidth(physicalType, typeLength);
  const interleaved = encodeFixedWidth(values, physicalType, width);
  const out = new Uint8Array(values.length * width);
  for (let b = 0; b < width; b++) {
    for (let i = 0; i < values.length; i++)
      out[b * values.length + i] = interleaved[i * width + b]!;
  }
  return out;
}
function decodeFixedWidth(
  bytes: Uint8Array,
  count: number,
  physicalType: number,
  width: number,
): unknown[] {
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
      default:
        out[i] = bytes.subarray(i * width, (i + 1) * width).slice();
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
      default:
        out.set((values[i] as Uint8Array).subarray(0, width), i * width);
    }
  }
  return out;
}
