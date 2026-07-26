/**
 * internal:data/parquet/convert — value conversions between Parquet physical
 * representations and the JS values the Arrow model uses.
 *
 * Parquet stores several logical types as raw byte strings whose layout has no
 * direct JS equivalent. This module holds the pure byte-level codecs that
 * `internal:data/parquet/schema` composes into per-column decode/encode
 * functions:
 *
 * - DECIMAL backed by BYTE_ARRAY or FIXED_LEN_BYTE_ARRAY: the unscaled value
 *   as a big-endian two's-complement integer of arbitrary width, mapped to
 *   `bigint`.
 * - INT96 timestamps: the legacy 12-byte Impala/Hive layout (nanoseconds of
 *   day plus Julian day number), mapped to nanoseconds since the Unix epoch.
 * - FLOAT16: 2-byte little-endian IEEE-754 half floats, mapped to `number`.
 *
 * Every conversion is implemented in both directions so the reader and writer
 * stay symmetric: for in-range inputs each decode function is the exact
 * inverse of its encode counterpart. All functions are synchronous, operate
 * on plain `Uint8Array`s, and allocate nothing beyond the returned buffer.
 *
 * ```ts no_run
 * import {
 *   decimalBytesToBigInt,
 *   bigIntToDecimalBytes,
 *   int96ToEpochNanos,
 *   float16BytesToNumber,
 * } from 'internal:data/parquet/convert';
 *
 * decimalBytesToBigInt(new Uint8Array([0xff, 0x85]));   // -123n
 * bigIntToDecimalBytes(-123n, 2);                       // Uint8Array [0xff, 0x85]
 * int96ToEpochNanos(int96Bytes);                        // bigint epoch nanoseconds
 * float16BytesToNumber(new Uint8Array([0x00, 0x3c]));   // 1
 * ```
 *
 * Reference: https://github.com/apache/parquet-format/blob/master/LogicalTypes.md
 *
 * @internal
 */
/**
 * Decode a big-endian two's-complement byte string into a signed `bigint`.
 *
 * This is the unscaled-integer representation Parquet uses for DECIMAL values
 * stored as BYTE_ARRAY or FIXED_LEN_BYTE_ARRAY. Any byte length is accepted —
 * the sign comes from the high bit of the first byte — and an empty input
 * decodes to `0n`. The caller applies the column's decimal scale afterwards.
 *
 * ```ts no_run
 * import { decimalBytesToBigInt } from 'internal:data/parquet/convert';
 *
 * decimalBytesToBigInt(new Uint8Array([0x04, 0xd2])); // 1234n
 * decimalBytesToBigInt(new Uint8Array([0xff, 0x85])); // -123n
 * ```
 *
 * @internal
 */
export function decimalBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.byteLength; i++) value = (value << 8n) | BigInt(bytes[i]!);
  const bits = BigInt(bytes.byteLength * 8);
  if (bytes.byteLength > 0 && (bytes[0]! & 128) !== 0) value -= 1n << bits;
  return value;
}
/**
 * Encode a signed `bigint` as a big-endian two's-complement byte string of
 * exactly `byteLength` bytes.
 *
 * Inverse of `decimalBytesToBigInt` for values that fit the width. The caller
 * is responsible for choosing a `byteLength` large enough for the column's
 * decimal precision — values outside the signed range of the width wrap
 * silently modulo 2^(8·byteLength) rather than throwing.
 *
 * ```ts no_run
 * import { bigIntToDecimalBytes } from 'internal:data/parquet/convert';
 *
 * bigIntToDecimalBytes(1234n, 2);  // Uint8Array [0x04, 0xd2]
 * bigIntToDecimalBytes(-123n, 2);  // Uint8Array [0xff, 0x85]
 * bigIntToDecimalBytes(-1n, 4);    // Uint8Array [0xff, 0xff, 0xff, 0xff]
 * ```
 *
 * @internal
 */
export function bigIntToDecimalBytes(value: bigint, byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let v = value;
  if (v < 0n) v += 1n << BigInt(byteLength * 8);
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = Number(v & 255n);
    v >>= 8n;
  }
  return out;
}
const JULIAN_UNIX_EPOCH = 2440588n;
const NANOS_PER_DAY = 86400n * 1000000000n;
/**
 * Decode a 12-byte INT96 timestamp into nanoseconds since the Unix epoch.
 *
 * INT96 is the deprecated timestamp layout written by legacy Impala/Hive
 * files: an unsigned 64-bit little-endian count of nanoseconds within the day
 * followed by an unsigned 32-bit little-endian Julian day number. Julian day
 * 2440588 corresponds to 1970-01-01, so days before that yield a negative
 * result. The returned `bigint` preserves full nanosecond precision, which a
 * JS `number` could not.
 *
 * Throws a `RangeError` if `bytes` is shorter than 12 bytes.
 *
 * ```ts no_run
 * import { int96ToEpochNanos } from 'internal:data/parquet/convert';
 *
 * // 1970-01-02T00:00:00.000000001Z
 * const bytes = new Uint8Array(12);
 * new DataView(bytes.buffer).setBigUint64(0, 1n, true);
 * new DataView(bytes.buffer).setUint32(8, 2440589, true);
 * int96ToEpochNanos(bytes); // 86400000000001n
 * ```
 *
 * @internal
 */
export function int96ToEpochNanos(bytes: Uint8Array): bigint {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nanosOfDay = dv.getBigUint64(0, true);
  const julianDay = BigInt(dv.getUint32(8, true));
  return (julianDay - JULIAN_UNIX_EPOCH) * NANOS_PER_DAY + nanosOfDay;
}
/**
 * Encode nanoseconds since the Unix epoch as a 12-byte INT96 timestamp.
 *
 * Inverse of `int96ToEpochNanos`. Negative inputs (timestamps before 1970)
 * are floor-adjusted so the nanos-of-day field is always non-negative and the
 * Julian day field simply lands before 2440588, matching how legacy writers
 * represent pre-epoch instants.
 *
 * ```ts no_run
 * import { epochNanosToInt96, int96ToEpochNanos } from 'internal:data/parquet/convert';
 *
 * const bytes = epochNanosToInt96(-1n); // last nanosecond of 1969-12-31
 * int96ToEpochNanos(bytes);             // -1n — round-trips exactly
 * ```
 *
 * @internal
 */
export function epochNanosToInt96(nanos: bigint): Uint8Array {
  let days = nanos / NANOS_PER_DAY;
  let nanosOfDay = nanos % NANOS_PER_DAY;
  if (nanosOfDay < 0n) {
    nanosOfDay += NANOS_PER_DAY;
    days -= 1n;
  }
  const out = new Uint8Array(12);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, nanosOfDay, true);
  dv.setUint32(8, Number(days + JULIAN_UNIX_EPOCH), true);
  return out;
}
const _f16buf = new DataView(new ArrayBuffer(2));
/**
 * Decode a 2-byte little-endian IEEE-754 half float into a JS number.
 *
 * Used for the FLOAT16 logical type (FIXED_LEN_BYTE_ARRAY of length 2). Every
 * half-float value is exactly representable as a JS double, so decoding is
 * lossless, including ±Infinity, NaN, and subnormals. Missing bytes are
 * treated as zero, so a short or empty input decodes as if zero-padded rather
 * than throwing.
 *
 * ```ts no_run
 * import { float16BytesToNumber } from 'internal:data/parquet/convert';
 *
 * float16BytesToNumber(new Uint8Array([0x00, 0x3c])); // 1
 * float16BytesToNumber(new Uint8Array([0x00, 0xc0])); // -2
 * ```
 *
 * @internal
 */
export function float16BytesToNumber(bytes: Uint8Array): number {
  _f16buf.setUint8(0, bytes[0] ?? 0);
  _f16buf.setUint8(1, bytes[1] ?? 0);
  return _f16buf.getFloat16(0, true);
}
/**
 * Encode a JS number as a 2-byte little-endian IEEE-754 half float.
 *
 * Inverse of `float16BytesToNumber` for values the half format can represent.
 * Doubles that are not exact half floats are rounded to the nearest
 * representable value (ties to even); magnitudes beyond the half-float range
 * (about ±65504) become ±Infinity and tiny magnitudes flush toward zero
 * through the subnormal range. This is the lossy step of a FLOAT16 column —
 * decoding the result back never recovers the discarded precision.
 *
 * ```ts no_run
 * import { numberToFloat16Bytes } from 'internal:data/parquet/convert';
 *
 * numberToFloat16Bytes(1);      // Uint8Array [0x00, 0x3c]
 * numberToFloat16Bytes(100000); // encodes as +Infinity — out of half range
 * ```
 *
 * @internal
 */
export function numberToFloat16Bytes(value: number): Uint8Array {
  _f16buf.setFloat16(0, value, true);
  return new Uint8Array([_f16buf.getUint8(0), _f16buf.getUint8(1)]);
}
