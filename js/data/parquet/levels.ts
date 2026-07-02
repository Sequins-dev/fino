/**
* The RLE / bit-packed hybrid used by Parquet for definition and repetition
* levels and for dictionary indices, plus definition-level packing for flat
* optional columns.
*
* Reference: https://parquet.apache.org/docs/file-format/data-pages/encodings/
* (RLE / bit-packing hybrid).
*
* @internal
*/
import { ByteReader, ByteWriter } from 'internal:format/thrift';
/** Minimum bit width to represent values `0..maxValue`. @internal */
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
* stream. Runs of ≥8 equal values become RLE runs; the rest are bit-packed in
* groups of 8 (the final group is zero-padded). No length prefix.
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
* Decode `count` values from an RLE/bit-packed hybrid run stream at the reader's
* cursor.
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
* with its 4-byte little-endian byte length (the DATA_PAGE v1 layout). Returns
* an empty array when `maxLevel` is 0 (required column — no levels are stored).
*/
export function encodeDefinitionLevels(levels: number[], maxLevel: number): Uint8Array {
  if (maxLevel === 0) return new Uint8Array(0);
  const body = encodeRleHybrid(levels, bitWidthForMax(maxLevel));
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, 4);
  return out;
}
