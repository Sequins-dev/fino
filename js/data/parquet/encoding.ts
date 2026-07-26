/**
 * Parquet PLAIN value encoding and dictionary-index decoding.
 *
 * PLAIN is the flat little-endian layout defined by the Parquet format:
 * booleans bit-packed LSB-first, fixed-width numerics laid out back to back,
 * and BYTE_ARRAY values as a 4-byte length prefix followed by the raw bytes.
 * This module implements PLAIN in both directions for every physical type
 * (INT96 is decode-only) and decodes the index runs of dictionary-encoded
 * data pages (RLE_DICTIONARY / PLAIN_DICTIONARY), which most real-world
 * writers emit by default. Dictionary pages themselves are PLAIN-encoded, so
 * `decodePlain` serves both plain data pages and dictionary pages.
 *
 * Decoded values map to JS as: BOOLEAN → `boolean`, INT32 / FLOAT / DOUBLE →
 * `number`, INT64 → `bigint`, and BYTE_ARRAY / FIXED_LEN_BYTE_ARRAY / INT96 →
 * `Uint8Array`. Conversion to logical-type values (UTF-8 strings, decimals,
 * timestamps) happens downstream in `internal:data/parquet/convert`.
 *
 * The DELTA_* family and BYTE_STREAM_SPLIT live in
 * `internal:data/parquet/delta`; the definition/repetition level codec (also
 * the RLE/bit-packed hybrid backing dictionary indices) lives in
 * `internal:data/parquet/levels`. The consumers of this module are
 * `internal:data/parquet/column-reader` and `internal:data/parquet/writer`.
 *
 * ```ts no_run
 *   import { decodePlain, encodePlain } from 'internal:data/parquet/encoding';
 *   import { PType } from 'internal:data/parquet/types';
 *
 *   const bytes = encodePlain(PType.INT64, [1n, 2n, 3n]);
 *   const values = decodePlain(PType.INT64, bytes, 3); // [1n, 2n, 3n]
 * ```
 *
 * Encoding spec: https://parquet.apache.org/docs/file-format/data-pages/encodings/
 *
 * @internal
 */
import { ByteReader } from 'internal:format/thrift';
import { PType, ParquetError } from './types.ts';
import { decodeRleHybrid } from './levels.ts';
/**
 * Decode `count` PLAIN-encoded values of the given physical type from the
 * start of `bytes`.
 *
 * Callers pass the value section of a page only — definition and repetition
 * levels must already have been stripped off the front. Element types follow
 * the module-level mapping: `boolean` for BOOLEAN, `number` for INT32 / FLOAT
 * / DOUBLE, `bigint` for INT64, and `Uint8Array` for BYTE_ARRAY,
 * FIXED_LEN_BYTE_ARRAY, and INT96 (12 raw bytes per value — the legacy
 * nanosecond-timestamp layout, surfaced undecoded). Byte-array results are
 * copied out of `bytes`, so they remain valid after the page buffer is
 * discarded or reused.
 *
 * `typeLength` is the per-element width for FIXED_LEN_BYTE_ARRAY and is
 * ignored for every other type. Throws `ParquetError` for an unrecognized
 * physical type.
 *
 * ```ts no_run
 *   import { decodePlain } from 'internal:data/parquet/encoding';
 *   import { PType } from 'internal:data/parquet/types';
 *
 *   // BYTE_ARRAY: each value is a u32 length prefix + raw bytes.
 *   const raw = decodePlain(PType.BYTE_ARRAY, valueBytes, header.numValues);
 *   const decoder = new TextDecoder();
 *   const names = raw.map((b) => decoder.decode(b as Uint8Array));
 * ```
 */
export function decodePlain(
  physicalType: number,
  bytes: Uint8Array,
  count: number,
  typeLength?: number,
): unknown[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<unknown>(count);
  switch (physicalType) {
    case PType.BOOLEAN:
      for (let i = 0; i < count; i++) out[i] = (bytes[i >> 3]! & (1 << (i & 7))) !== 0;
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
    default:
      throw new ParquetError(`PLAIN decode: unsupported physical type ${physicalType}`);
  }
}
/**
 * PLAIN-encode `values` of the given physical type into a single byte buffer.
 *
 * Numeric inputs are coerced: INT32 / FLOAT / DOUBLE accept anything
 * `Number()` accepts, INT64 accepts `number` or `bigint`, and BOOLEAN packs
 * truthiness one bit per value, LSB-first, with the final byte zero-padded.
 * BYTE_ARRAY and FIXED_LEN_BYTE_ARRAY accept `Uint8Array` values or strings
 * (UTF-8 encoded); any other value type throws `ParquetError`.
 * FIXED_LEN_BYTE_ARRAY values longer than `typeLength` are truncated to the
 * fixed width and shorter ones are zero-padded.
 *
 * INT96 cannot be encoded — it is a deprecated type the writer never emits —
 * so it throws `ParquetError` like any other unsupported physical type.
 *
 * ```ts no_run
 *   import { encodePlain } from 'internal:data/parquet/encoding';
 *   import { PType } from 'internal:data/parquet/types';
 *
 *   // Length-prefixed: 03 'red' 05 'green' 04 'blue' (u32 LE prefixes).
 *   const page = encodePlain(PType.BYTE_ARRAY, ['red', 'green', 'blue']);
 * ```
 */
export function encodePlain(
  physicalType: number,
  values: unknown[],
  typeLength?: number,
): Uint8Array {
  switch (physicalType) {
    case PType.BOOLEAN: {
      const out = new Uint8Array((values.length + 7) >> 3);
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
      for (let i = 0; i < values.length; i++)
        dv.setBigInt64(i * 8, BigInt(values[i] as number | bigint), true);
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
      for (let i = 0; i < values.length; i++)
        out.set(toBytes(values[i]).subarray(0, width), i * width);
      return out;
    }
    default:
      throw new ParquetError(`PLAIN encode: unsupported physical type ${physicalType}`);
  }
}
const _encoder = new TextEncoder();
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return _encoder.encode(value);
  throw new ParquetError('BYTE_ARRAY value must be a string or Uint8Array');
}
/**
 * Decode `count` dictionary indices from a dictionary-encoded data page body.
 *
 * RLE_DICTIONARY / PLAIN_DICTIONARY data pages store their values as a single
 * bit-width byte followed by an RLE/bit-packed hybrid run of indices into the
 * column chunk's dictionary page. Each returned index selects a value from
 * the dictionary previously decoded with `decodePlain`.
 *
 * A completely empty body decodes to all-zero indices (an empty array when
 * `count` is 0), tolerating writers that omit index data entirely when every
 * value maps to the dictionary's single entry. A bit width of 0 after a
 * one-entry dictionary decodes the same way, via the hybrid codec's zero-run
 * path.
 *
 * ```ts no_run
 *   import { decodeDictionaryIndices, decodePlain } from 'internal:data/parquet/encoding';
 *   import { PType } from 'internal:data/parquet/types';
 *
 *   const dictionary = decodePlain(PType.BYTE_ARRAY, dictPageBytes, dictHeader.numValues);
 *   const indices = decodeDictionaryIndices(dataPageValueBytes, nonNullCount);
 *   const values = indices.map((i) => dictionary[i]);
 * ```
 */
export function decodeDictionaryIndices(bytes: Uint8Array, count: number): number[] {
  if (bytes.byteLength === 0) return count === 0 ? [] : new Array(count).fill(0);
  const r = new ByteReader(bytes);
  const bitWidth = r.readU8();
  return decodeRleHybrid(r, bitWidth, count);
}
