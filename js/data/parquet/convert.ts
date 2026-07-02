/**
* Value conversions between Parquet physical representations and the JS values
* the Arrow model uses: two's-complement decimals, INT96 legacy timestamps, and
* IEEE-754 half floats.
*
* @internal
*/
/** Decode a big-endian two's-complement byte string into a signed `bigint`. @internal */
export function decimalBytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < bytes.byteLength; i++) value = value << 8n | BigInt(bytes[i]!);
  const bits = BigInt(bytes.byteLength * 8);
  if (bytes.byteLength > 0 && (bytes[0]! & 128) !== 0) value -= 1n << bits;
  return value;
}
/** Encode a signed `bigint` as a big-endian two's-complement byte string of `byteLength`. @internal */
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
/** Decode a 12-byte INT96 (nanos-of-day u64 LE + Julian day u32 LE) into epoch nanoseconds. @internal */
export function int96ToEpochNanos(bytes: Uint8Array): bigint {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nanosOfDay = dv.getBigUint64(0, true);
  const julianDay = BigInt(dv.getUint32(8, true));
  return (julianDay - JULIAN_UNIX_EPOCH) * NANOS_PER_DAY + nanosOfDay;
}
/** Encode epoch nanoseconds as a 12-byte INT96. @internal */
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
/** Decode a 2-byte little-endian IEEE-754 half float into a JS number. @internal */
export function float16BytesToNumber(bytes: Uint8Array): number {
  _f16buf.setUint8(0, bytes[0] ?? 0);
  _f16buf.setUint8(1, bytes[1] ?? 0);
  return _f16buf.getFloat16(0, true);
}
/** Encode a JS number as a 2-byte little-endian IEEE-754 half float. @internal */
export function numberToFloat16Bytes(value: number): Uint8Array {
  _f16buf.setFloat16(0, value, true);
  return new Uint8Array([_f16buf.getUint8(0), _f16buf.getUint8(1)]);
}
