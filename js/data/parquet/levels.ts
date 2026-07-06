/**
* The RLE / bit-packed hybrid used by Parquet for definition and repetition
* levels and for dictionary indices, plus definition-level packing for flat
* optional columns.
*
* Parquet stores small unsigned integers — nullability levels, list-nesting
* levels, and dictionary indices — in a hybrid stream of runs. Each run is
* either an RLE run (one value repeated) or a bit-packed group (eight values
* packed at a fixed bit width), chosen per run by the encoder. The stream has
* no self-describing length or value count: both sides must agree on the bit
* width (derived from the column's max level or dictionary size) and the
* number of values, which is why every function here takes them explicitly.
*
* The writer (`writer.ts`) uses `encodeRleHybrid` for v1/v2 level streams and
* dictionary indices; the column reader (`column-reader.ts`) mirrors it with
* `decodeRleHybrid`. `encodeDefinitionLevels` adds the 4-byte length prefix
* that DATA_PAGE v1 requires around the definition-level block of a flat
* optional column.
*
* ```ts no_run
* import { ByteReader } from 'internal:format/thrift';
* import {
*   bitWidthForMax,
*   encodeRleHybrid,
*   decodeRleHybrid,
* } from 'internal:data/parquet/levels';
*
* // Definition levels for a flat optional column: 1 = present, 0 = null.
* const levels = [1, 1, 0, 1, 1, 1, 1, 1, 1, 0];
* const bitWidth = bitWidthForMax(1);
* const encoded = encodeRleHybrid(levels, bitWidth);
*
* const decoded = decodeRleHybrid(new ByteReader(encoded), bitWidth, levels.length);
* // decoded deep-equals levels
* ```
*
* Reference: https://parquet.apache.org/docs/file-format/data-pages/encodings/
* (RLE / bit-packing hybrid).
*
* @internal
*/
import { ByteReader, ByteWriter } from 'internal:format/thrift';
/**
* Minimum bit width needed to represent every value in `0..maxValue`.
*
* Returns 0 when `maxValue` is 0 — the degenerate width Parquet uses for
* required columns (max definition level 0), where no level bytes are stored
* at all. This is the canonical way to derive the `bitWidth` argument for the
* encode/decode functions in this module: pass the column's max definition or
* repetition level, or `dictionary.length - 1` for dictionary indices.
*
* `maxValue` is treated as an unsigned 32-bit integer; levels and dictionary
* indices never approach that bound in practice.
*
* ```ts no_run
* import { bitWidthForMax } from 'internal:data/parquet/levels';
*
* bitWidthForMax(0);   // 0 — required column, no level stream
* bitWidthForMax(1);   // 1 — flat optional column
* bitWidthForMax(3);   // 2 — e.g. optional list of optional values
* bitWidthForMax(255); // 8 — dictionary with 256 entries
* ```
*
* @internal
*/
export function bitWidthForMax(maxValue: number): number {
  return maxValue === 0 ? 0 : 32 - Math.clz32(maxValue);
}
function writeIntLE(w: ByteWriter, value: number, byteLength: number): void {
  for (let i = 0; i < byteLength; i++) w.writeU8(value >>> i * 8 & 255);
}
function readIntLE(r: ByteReader, byteLength: number): number {
  let value = 0;
  for (let i = 0; i < byteLength; i++) value |= r.readU8() << i * 8;
  return value >>> 0;
}
/**
* Encode `values` (each in `0..2^bitWidth-1`) as an RLE/bit-packed hybrid run
* stream.
*
* Runs of 8 or more equal values become RLE runs (a varint header followed by
* the value in `ceil(bitWidth / 8)` little-endian bytes). Everything between
* such runs is collected into one bit-packed segment, padded with zeros to a
* multiple of 8 values; the decoder relies on its `count` argument to discard
* the padding. With `bitWidth` 0 the whole input collapses to a single RLE
* run header with no value bytes (or an empty array for empty input).
*
* The output has no length prefix and no value count — it is the raw run
* stream. DATA_PAGE v1 wraps it in a 4-byte length prefix (see
* `encodeDefinitionLevels`); v2 pages record the level-stream byte lengths in
* the page header; dictionary-index streams get a single leading bit-width
* byte and run to the end of the page.
*
* Values wider than `bitWidth` bits are silently truncated to the low
* `bitWidth` bits, so callers must size the width with `bitWidthForMax`.
*
* ```ts no_run
* import { encodeRleHybrid, bitWidthForMax } from 'internal:data/parquet/levels';
*
* // Dictionary indices into a 5-entry dictionary.
* const indices = [0, 1, 1, 2, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0];
* const bytes = encodeRleHybrid(indices, bitWidthForMax(4));
* // → one bit-packed group for the mixed prefix, one RLE run for the zeros
* ```
*/
export function encodeRleHybrid(values: number[], bitWidth: number): Uint8Array {
  const w = new ByteWriter();
  if (bitWidth === 0) {
    // Every value is 0; a single RLE run of the count with no value bytes.
    if (values.length > 0) w.writeVarint(values.length << 1);
    return w.bytes();
  }
  const valueBytes = Math.ceil(bitWidth / 8);
  let i = 0;
  while (i < values.length) {
    let runLen = 1;
    while (i + runLen < values.length && values[i + runLen] === values[i]) runLen++;
    if (runLen >= 8) {
      w.writeVarint(runLen << 1);
      writeIntLE(w, values[i]!, valueBytes);
      i += runLen;
    } else {
      const group: number[] = [];
      while (i < values.length) {
        let rl = 1;
        while (i + rl < values.length && values[i + rl] === values[i]) rl++;
        if (rl >= 8) break;
        group.push(values[i]!);
        i++;
      }
      const numGroups = Math.ceil(group.length / 8);
      while (group.length < numGroups * 8) group.push(0);
      w.writeVarint(numGroups << 1 | 1);
      packBits(w, group, bitWidth);
    }
  }
  return w.bytes();
}
function packBits(w: ByteWriter, values: number[], bitWidth: number): void {
  let cur = 0;
  let curBits = 0;
  for (const value of values) {
    let val = value >>> 0;
    let valBits = bitWidth;
    while (valBits > 0) {
      const take = Math.min(8 - curBits, valBits);
      cur |= (val & (1 << take) - 1) << curBits;
      val >>>= take;
      curBits += take;
      valBits -= take;
      if (curBits === 8) {
        w.writeU8(cur);
        cur = 0;
        curBits = 0;
      }
    }
  }
  if (curBits > 0) w.writeU8(cur);
}
/**
* Decode `count` values from an RLE/bit-packed hybrid run stream at the
* reader's cursor.
*
* Reads run headers until `count` values have been produced, leaving the
* cursor on the first byte after the stream. Bit-packed groups always encode
* a multiple of 8 values, so a final group's zero-padding beyond `count` is
* consumed from the stream but not returned — this is why the caller must
* supply the exact value count from the page header. With `bitWidth` 0 the
* result is `count` zeros and no bytes are consumed.
*
* Throws if the stream is truncated (the reader runs out of bytes before
* `count` values are decoded).
*
* ```ts no_run
* import { ByteReader } from 'internal:format/thrift';
* import { decodeRleHybrid, bitWidthForMax } from 'internal:data/parquet/levels';
*
* // Definition levels of a v2 data page: numValues entries, one per record.
* const reader = new ByteReader(defLevelBytes);
* const defLevels = decodeRleHybrid(
*   reader,
*   bitWidthForMax(descriptor.maxDefinitionLevel),
*   pageHeader.numValues,
* );
* const nulls = defLevels.filter((l) => l < descriptor.maxDefinitionLevel).length;
* ```
*/
export function decodeRleHybrid(r: ByteReader, bitWidth: number, count: number): number[] {
  const out: number[] = [];
  if (bitWidth === 0) {
    for (let i = 0; i < count; i++) out.push(0);
    return out;
  }
  const valueBytes = Math.ceil(bitWidth / 8);
  while (out.length < count) {
    const header = r.readVarint32();
    if ((header & 1) === 0) {
      const runLen = header >>> 1;
      const value = readIntLE(r, valueBytes);
      for (let i = 0; i < runLen && out.length < count; i++) out.push(value);
    } else {
      const numValues = (header >>> 1) * 8;
      unpackBits(r, bitWidth, numValues, out, count);
    }
  }
  return out;
}
function unpackBits(r: ByteReader, bitWidth: number, numValues: number, out: number[], count: number): void {
  let cur = 0;
  let curBits = 0;
  for (let g = 0; g < numValues; g++) {
    let val = 0;
    let gotBits = 0;
    while (gotBits < bitWidth) {
      if (curBits === 0) {
        cur = r.readU8();
        curBits = 8;
      }
      const take = Math.min(curBits, bitWidth - gotBits);
      val |= (cur & (1 << take) - 1) << gotBits;
      cur >>>= take;
      curBits -= take;
      gotBits += take;
    }
    if (out.length < count) out.push(val >>> 0);
  }
}
/**
* Encode definition levels for a flat column as an RLE-hybrid block prefixed
* with its 4-byte little-endian byte length (the DATA_PAGE v1 layout).
*
* Returns an empty array when `maxLevel` is 0 — a required column stores no
* definition levels, and the result is meant to be concatenated directly in
* front of the encoded values, so "nothing" is the correct output rather than
* a zero-length prefix. For a flat optional column `maxLevel` is 1 and each
* level is 0 (null) or 1 (value present).
*
* DATA_PAGE v2 does not use this layout: v2 stores the raw un-prefixed run
* stream (`encodeRleHybrid`) and records its byte length in the page header
* instead.
*
* ```ts no_run
* import { encodeDefinitionLevels } from 'internal:data/parquet/levels';
*
* // Rows: [3, null, 7] for an optional INT32 column.
* const defBlock = encodeDefinitionLevels([1, 0, 1], 1);
* // pageData = defBlock ++ plainEncode([3, 7])
* ```
*/
export function encodeDefinitionLevels(levels: number[], maxLevel: number): Uint8Array {
  if (maxLevel === 0) return new Uint8Array(0);
  const body = encodeRleHybrid(levels, bitWidthForMax(maxLevel));
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, 4);
  return out;
}
