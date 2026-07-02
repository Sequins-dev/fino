/**
* Parquet value encodings.
*
* This milestone implements PLAIN (all common physical types) plus decoding of
* dictionary-encoded data pages (RLE_DICTIONARY / PLAIN_DICTIONARY), which real
* files use by default. Delta and byte-stream-split encodings are added in a
* later phase.
*
* @internal
*/
import { ByteReader } from 'internal:format/thrift';
import { PType, ParquetError } from './types.ts';
import { decodeRleHybrid } from './levels.ts';
/**
* Decode `count` PLAIN-encoded values of the given physical type. Returns
* `number` for 32-bit ints/floats, `bigint` for INT64, `boolean` for BOOLEAN,
* and `Uint8Array` for BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY.
*/
export function decodePlain(physicalType: number, bytes: Uint8Array, count: number, typeLength?: number): unknown[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<unknown>(count);
  switch (physicalType) {
    case PType.BOOLEAN:
      for (let i = 0; i < count; i++) out[i] = (bytes[i >> 3]! & 1 << (i & 7)) !== 0;
      return out;
    case PType.INT32:
      for (let i = 0; i < count; i++) out[i] = dv.getInt32(i * 4, true);
      return out;
    case PType.INT64:
      for (let i = 0; i < count; i++) out[i] = dv.getBigInt64(i * 8, true);
      return out;
    case PType.FLOAT:
      for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
      return out;
    case PType.DOUBLE:
      for (let i = 0; i < count; i++) out[i] = dv.getFloat64(i * 8, true);
      return out;
    case PType.BYTE_ARRAY: {
      let pos = 0;
      for (let i = 0; i < count; i++) {
        const len = dv.getUint32(pos, true);
        pos += 4;
        out[i] = bytes.subarray(pos, pos + len).slice();
        pos += len;
      }
      return out;
    }
    case PType.FIXED_LEN_BYTE_ARRAY: {
      const width = typeLength ?? 0;
      for (let i = 0; i < count; i++) out[i] = bytes.subarray(i * width, (i + 1) * width).slice();
      return out;
    }
    case PType.INT96: {
      // 12 bytes each; surfaced as raw bytes (legacy nanosecond timestamps).
      for (let i = 0; i < count; i++) out[i] = bytes.subarray(i * 12, (i + 1) * 12).slice();
      return out;
    }
    default: throw new ParquetError(`PLAIN decode: unsupported physical type ${physicalType}`);
  }
}
/**
* PLAIN-encode `values` of the given physical type into bytes.
*/
export function encodePlain(physicalType: number, values: unknown[], typeLength?: number): Uint8Array {
  switch (physicalType) {
    case PType.BOOLEAN: {
      const out = new Uint8Array(values.length + 7 >> 3);
      for (let i = 0; i < values.length; i++) if (values[i]) out[i >> 3]! |= 1 << (i & 7);
      return out;
    }
    case PType.INT32: {
      const out = new Uint8Array(values.length * 4);
      const dv = new DataView(out.buffer);
      for (let i = 0; i < values.length; i++) dv.setInt32(i * 4, Number(values[i]), true);
      return out;
    }
    case PType.INT64: {
      const out = new Uint8Array(values.length * 8);
      const dv = new DataView(out.buffer);
      for (let i = 0; i < values.length; i++) dv.setBigInt64(i * 8, BigInt(values[i] as number | bigint), true);
      return out;
    }
    case PType.FLOAT: {
      const out = new Uint8Array(values.length * 4);
      const dv = new DataView(out.buffer);
      for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, Number(values[i]), true);
      return out;
    }
    case PType.DOUBLE: {
      const out = new Uint8Array(values.length * 8);
      const dv = new DataView(out.buffer);
      for (let i = 0; i < values.length; i++) dv.setFloat64(i * 8, Number(values[i]), true);
      return out;
    }
    case PType.BYTE_ARRAY: {
      const encoded = values.map((v) => toBytes(v));
      let total = 0;
      for (const b of encoded) total += 4 + b.byteLength;
      const out = new Uint8Array(total);
      const dv = new DataView(out.buffer);
      let pos = 0;
      for (const b of encoded) {
        dv.setUint32(pos, b.byteLength, true);
        pos += 4;
        out.set(b, pos);
        pos += b.byteLength;
      }
      return out;
    }
    case PType.FIXED_LEN_BYTE_ARRAY: {
      const width = typeLength ?? 0;
      const out = new Uint8Array(values.length * width);
      for (let i = 0; i < values.length; i++) out.set(toBytes(values[i]).subarray(0, width), i * width);
      return out;
    }
    default: throw new ParquetError(`PLAIN encode: unsupported physical type ${physicalType}`);
  }
}
const _encoder = new TextEncoder();
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return _encoder.encode(value);
  throw new ParquetError('BYTE_ARRAY value must be a string or Uint8Array');
}
/**
* Decode dictionary indices from a dictionary-encoded data page body: a leading
* bit-width byte followed by an RLE/bit-packed hybrid run of `count` indices.
*/
export function decodeDictionaryIndices(bytes: Uint8Array, count: number): number[] {
  if (bytes.byteLength === 0) return count === 0 ? [] : new Array(count).fill(0);
  const r = new ByteReader(bytes);
  const bitWidth = r.readU8();
  return decodeRleHybrid(r, bitWidth, count);
}
