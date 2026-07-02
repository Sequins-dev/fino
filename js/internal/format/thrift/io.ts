/**
* Byte cursor and growable buffer for the Thrift protocols.
*
* `ByteReader` is a bounds-checked forward cursor over a `Uint8Array` (throwing
* `ThriftError` on truncation); `ByteWriter` is a forward-growing buffer
* (doubling like the flatbuffers `Builder`). Both carry the ULEB128 varint and
* zig-zag helpers the compact protocol needs — 64-bit paths use `bigint` so
* values above 2^53 stay exact. No reusable varint helper exists elsewhere in
* the runtime (QUIC varints are a different encoding).
*
* @internal
*/
import { _fail } from './types.ts';
const _decoder = new TextDecoder();
const _encoder = new TextEncoder();
/**
* Bounds-checked byte reader.
*
* @internal
*/
export class ByteReader {
  /**
  * Backing bytes.
  *
  * @internal
  */
  #bytes: Uint8Array;
  /**
  * DataView over `#bytes` (respects byteOffset).
  *
  * @internal
  */
  #view: DataView;
  /**
  * Cursor position, relative to `#bytes[0]`.
  *
  * @internal
  */
  #pos: number;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#pos = 0;
  }
  /** Current cursor position. */
  get position(): number {
    return this.#pos;
  }
  /** Bytes remaining. */
  get remaining(): number {
    return this.#bytes.byteLength - this.#pos;
  }
  /** Whether the cursor is at end of input. */
  get done(): boolean {
    return this.#pos >= this.#bytes.byteLength;
  }
  /**
  * Ensure `n` bytes are available at the cursor, else raise `ThriftError`.
  *
  * @internal
  */
  #ensure(n: number): void {
    if (this.#pos + n > this.#bytes.byteLength) {
      _fail(this.#bytes, this.#pos, `unexpected end of input (need ${n} byte(s), have ${this.remaining})`);
    }
  }
  /** Read one unsigned byte. */
  readU8(): number {
    this.#ensure(1);
    return this.#bytes[this.#pos++]!;
  }
  /** Read one signed byte. */
  readI8(): number {
    this.#ensure(1);
    return this.#view.getInt8(this.#pos++);
  }
  /** Read `n` raw bytes as a view (no copy). */
  readBytes(n: number): Uint8Array {
    if (n < 0) _fail(this.#bytes, this.#pos, `negative length ${n}`);
    this.#ensure(n);
    const out = this.#bytes.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }
  /** Read a UTF-8 string of `n` bytes. */
  readString(n: number): string {
    return _decoder.decode(this.readBytes(n));
  }
  readI16BE(): number {
    this.#ensure(2);
    const v = this.#view.getInt16(this.#pos, false);
    this.#pos += 2;
    return v;
  }
  readI32BE(): number {
    this.#ensure(4);
    const v = this.#view.getInt32(this.#pos, false);
    this.#pos += 4;
    return v;
  }
  readI64BE(): bigint {
    this.#ensure(8);
    const v = this.#view.getBigInt64(this.#pos, false);
    this.#pos += 8;
    return v;
  }
  readF64BE(): number {
    this.#ensure(8);
    const v = this.#view.getFloat64(this.#pos, false);
    this.#pos += 8;
    return v;
  }
  readF64LE(): number {
    this.#ensure(8);
    const v = this.#view.getFloat64(this.#pos, true);
    this.#pos += 8;
    return v;
  }
  /**
  * Read an unsigned LEB128 varint (up to 64 bits) as a `bigint`.
  */
  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.readU8();
      result |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) break;
      shift += 7n;
      if (shift > 63n) _fail(this.#bytes, this.#pos, 'varint overflows 64 bits');
    }
    return result & 18446744073709551615n;
  }
  /** Read a varint that fits in 32 bits, as a `number`. */
  readVarint32(): number {
    return Number(BigInt.asUintN(32, this.readVarint()));
  }
  /** Read a zig-zag varint into a signed 32-bit `number`. */
  readZigzag32(): number {
    const v = this.readVarint32();
    return v >>> 1 ^ -(v & 1);
  }
  /** Read a zig-zag varint into a signed 64-bit `bigint`. */
  readZigzag64(): bigint {
    const v = this.readVarint();
    return v >> 1n ^ -(v & 1n);
  }
}
/**
* Forward-growing byte writer.
*
* @internal
*/
export class ByteWriter {
  /**
  * Backing buffer; used bytes are `#buf.subarray(0, #len)`.
  *
  * @internal
  */
  #buf: Uint8Array;
  /**
  * DataView over `#buf`.
  *
  * @internal
  */
  #view: DataView;
  /**
  * Number of bytes written.
  *
  * @internal
  */
  #len = 0;
  constructor(initialSize = 256) {
    const size = Math.max(16, initialSize);
    this.#buf = new Uint8Array(size);
    this.#view = new DataView(this.#buf.buffer);
  }
  /** Bytes written so far. */
  get length(): number {
    return this.#len;
  }
  /**
  * Ensure `n` more bytes fit, growing (doubling) as needed.
  *
  * @internal
  */
  #ensure(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let size = this.#buf.length;
    while (size < this.#len + n) size <<= 1;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#len), 0);
    this.#buf = next;
    this.#view = new DataView(next.buffer);
  }
  writeU8(value: number): void {
    this.#ensure(1);
    this.#buf[this.#len++] = value & 255;
  }
  writeBytes(bytes: Uint8Array): void {
    this.#ensure(bytes.byteLength);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.byteLength;
  }
  /** Write a UTF-8 string's bytes (no length prefix). */
  writeString(value: string): Uint8Array {
    const bytes = _encoder.encode(value);
    this.writeBytes(bytes);
    return bytes;
  }
  writeI16BE(value: number): void {
    this.#ensure(2);
    this.#view.setInt16(this.#len, value, false);
    this.#len += 2;
  }
  writeI32BE(value: number): void {
    this.#ensure(4);
    this.#view.setInt32(this.#len, value, false);
    this.#len += 4;
  }
  writeI64BE(value: bigint): void {
    this.#ensure(8);
    this.#view.setBigInt64(this.#len, value, false);
    this.#len += 8;
  }
  writeF64BE(value: number): void {
    this.#ensure(8);
    this.#view.setFloat64(this.#len, value, false);
    this.#len += 8;
  }
  writeF64LE(value: number): void {
    this.#ensure(8);
    this.#view.setFloat64(this.#len, value, true);
    this.#len += 8;
  }
  /** Write an unsigned LEB128 varint (accepts a non-negative number or bigint). */
  writeVarint(value: number | bigint): void {
    let v = typeof value === 'bigint' ? value : BigInt(value);
    if (v < 0n) throw new TypeError('thrift: varint value must be non-negative');
    v &= 18446744073709551615n;
    while (v >= 128n) {
      this.writeU8(Number(v & 127n) | 128);
      v >>= 7n;
    }
    this.writeU8(Number(v));
  }
  /** Write a signed 32-bit value as a zig-zag varint. */
  writeZigzag32(value: number): void {
    this.writeVarint(BigInt.asUintN(32, BigInt(value << 1 ^ value >> 31)));
  }
  /** Write a signed 64-bit value as a zig-zag varint. */
  writeZigzag64(value: bigint): void {
    this.writeVarint(BigInt.asUintN(64, value << 1n ^ value >> 63n));
  }
  /** The written bytes as a view (no copy). */
  bytes(): Uint8Array {
    return this.#buf.subarray(0, this.#len);
  }
}
