/**
* Byte cursor and growable buffer for the Thrift protocols.
*
* These are the two low-level byte primitives the binary, compact, and JSON
* Thrift protocols build on. `ByteReader` is a bounds-checked forward cursor
* over an existing `Uint8Array`: every read advances the cursor and raises a
* `ThriftError` (with a hex-dump offset) rather than reading past the end.
* `ByteWriter` is a forward-only growable buffer that doubles its backing store
* on demand — the same strategy as the flatbuffers `Builder` — so callers never
* size the output up front.
*
* Both classes carry the encoding tricks the compact protocol needs but that
* the standard `DataView` lacks: unsigned LEB128 varints and zig-zag signed
* varints. The 64-bit varint paths are expressed in `bigint` so values above
* 2^53 round-trip exactly; the 32-bit helpers hand back plain `number`s for the
* common case. No other varint helper in the runtime fits — the QUIC varint is
* a different, length-self-describing encoding.
*
* Reads and writes are big-endian for the fixed-width integer and float methods
* (matching `TBinaryProtocol` on the wire); the compact protocol reaches for the
* varint and zig-zag methods instead, and the little-endian `F64LE` pair exists
* for the Thrift-JSON double representation. Neither class is a general-purpose
* stream: there is no seeking, no rewind, and a `ByteWriter` cannot be reused as
* a reader.
*
* ```ts no_run
* import { ByteReader, ByteWriter } from 'internal:format/thrift';
*
* const w = new ByteWriter();
* w.writeVarint(300);        // ULEB128: two bytes
* w.writeZigzag32(-1);       // zig-zag: one byte
* w.writeI32BE(0x01020304);  // fixed 4 bytes, big-endian
*
* const r = new ByteReader(w.bytes());
* r.readVarint();            // 300n
* r.readZigzag32();          // -1
* r.readI32BE();             // 0x01020304
* r.done;                    // true
* ```
*
* @internal
*/
import { _fail } from './types.ts';
const _decoder = new TextDecoder();
const _encoder = new TextEncoder();
/**
* Bounds-checked forward cursor over a `Uint8Array`.
*
* Wraps a byte slice with a moving read position. Every method reads at the
* cursor and advances it; if the requested bytes would run past the end the
* reader raises a `ThriftError` carrying the offset, so a truncated stream fails
* loudly rather than returning garbage. The reader never copies except when
* decoding a string — `readBytes` returns a view aliasing the input buffer.
*
* The cursor is one-directional: there is no seek or rewind, so decode in the
* order the bytes were written. Construct one reader per message.
*
* ```ts no_run
* import { ByteReader } from 'internal:format/thrift';
*
* const r = new ByteReader(new Uint8Array([0x00, 0x2a]));
* r.readU8();      // 0 — cursor now at 1
* r.readU8();      // 42
* r.remaining;     // 0
* r.readU8();      // throws ThriftError: unexpected end of input
* ```
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
  /**
  * Wrap `bytes` and position the cursor at its start.
  *
  * The reader aliases the given array — including its `byteOffset` into a larger
  * `ArrayBuffer` — rather than copying, so mutating `bytes` after construction
  * changes what the reader sees.
  */
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#pos = 0;
  }
  /** Current cursor position, in bytes from the start of the input. */
  get position(): number {
    return this.#pos;
  }
  /** Number of unread bytes between the cursor and the end of the input. */
  get remaining(): number {
    return this.#bytes.byteLength - this.#pos;
  }
  /** Whether the cursor has reached the end of the input (nothing left to read). */
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
  /** Read one byte as an unsigned integer (0–255) and advance one byte. */
  readU8(): number {
    this.#ensure(1);
    return this.#bytes[this.#pos++]!;
  }
  /** Read one byte as a signed integer (-128–127) and advance one byte. */
  readI8(): number {
    this.#ensure(1);
    return this.#view.getInt8(this.#pos++);
  }
  /**
  * Read `n` raw bytes and advance the cursor past them.
  *
  * The result is a `subarray` view aliasing the reader's backing buffer, not a
  * copy — cheap, but it stays valid only as long as that buffer does, and it
  * mutates if the buffer does. Copy it (`.slice()`) if it must outlive the
  * reader. Throws `ThriftError` if `n` is negative or exceeds the bytes left.
  */
  readBytes(n: number): Uint8Array {
    if (n < 0) _fail(this.#bytes, this.#pos, `negative length ${n}`);
    this.#ensure(n);
    const out = this.#bytes.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }
  /**
  * Read `n` bytes and decode them as UTF-8 into a string.
  *
  * `n` is a byte count, not a character count. Invalid UTF-8 is replaced with
  * U+FFFD by the decoder rather than throwing; a short input still throws
  * `ThriftError` via the underlying `readBytes`.
  */
  readString(n: number): string {
    return _decoder.decode(this.readBytes(n));
  }
  /** Read a big-endian signed 16-bit integer and advance two bytes. */
  readI16BE(): number {
    this.#ensure(2);
    const v = this.#view.getInt16(this.#pos, false);
    this.#pos += 2;
    return v;
  }
  /** Read a big-endian signed 32-bit integer and advance four bytes. */
  readI32BE(): number {
    this.#ensure(4);
    const v = this.#view.getInt32(this.#pos, false);
    this.#pos += 4;
    return v;
  }
  /** Read a big-endian signed 64-bit integer as a `bigint` and advance eight bytes. */
  readI64BE(): bigint {
    this.#ensure(8);
    const v = this.#view.getBigInt64(this.#pos, false);
    this.#pos += 8;
    return v;
  }
  /** Read a big-endian IEEE-754 double and advance eight bytes. */
  readF64BE(): number {
    this.#ensure(8);
    const v = this.#view.getFloat64(this.#pos, false);
    this.#pos += 8;
    return v;
  }
  /** Read a little-endian IEEE-754 double (used by the Thrift-JSON protocol) and advance eight bytes. */
  readF64LE(): number {
    this.#ensure(8);
    const v = this.#view.getFloat64(this.#pos, true);
    this.#pos += 8;
    return v;
  }
  /**
  * Read an unsigned LEB128 varint (up to 64 bits) as a `bigint`.
  *
  * Consumes continuation bytes until one with the high bit clear, so the width
  * is not known in advance. The result is masked to 64 bits. Throws
  * `ThriftError` if the encoding would shift past bit 63 (overlong / overflowing
  * varint) or if the stream ends mid-varint.
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
  /**
  * Read an unsigned varint and return it as a `number`, truncated to 32 bits.
  *
  * A convenience over `readVarint` for the common case where the value is known
  * to fit in 32 bits; bits above the low 32 are discarded.
  */
  readVarint32(): number {
    return Number(BigInt.asUintN(32, this.readVarint()));
  }
  /**
  * Read a zig-zag-encoded varint and decode it to a signed 32-bit `number`.
  *
  * Zig-zag maps signed integers onto unsigned varints so that small-magnitude
  * negatives stay compact (0 → 0, -1 → 1, 1 → 2, -2 → 3, …). Use this to read
  * values the writer produced with `writeZigzag32`.
  */
  readZigzag32(): number {
    const v = this.readVarint32();
    return v >>> 1 ^ -(v & 1);
  }
  /**
  * Read a zig-zag-encoded varint and decode it to a signed 64-bit `bigint`.
  *
  * The 64-bit counterpart of `readZigzag32`; pairs with `writeZigzag64` and
  * keeps full precision for magnitudes beyond 2^53.
  */
  readZigzag64(): bigint {
    const v = this.readVarint();
    return v >> 1n ^ -(v & 1n);
  }
}
/**
* Forward-only growable byte buffer.
*
* Accumulates bytes in append order, doubling its backing store whenever the
* next write would not fit, so callers never have to predict the output size.
* Every `write*` method appends at the end; there is no way to overwrite or seek
* back. When done, `bytes()` hands back a view of exactly the bytes written.
*
* The mirror image of `ByteReader`: values written with a given method are read
* back with the matching reader method (`writeI32BE` ↔ `readI32BE`,
* `writeZigzag64` ↔ `readZigzag64`, and so on).
*
* ```ts no_run
* import { ByteWriter, ByteReader } from 'internal:format/thrift';
*
* const w = new ByteWriter();
* w.writeU8(0x0b);                 // a STRING field type, say
* const utf8 = w.writeString('hi');
* w.length;                        // 3 — one type byte plus two string bytes
*
* const r = new ByteReader(w.bytes());
* r.readU8();                      // 0x0b
* r.readString(utf8.byteLength);   // 'hi'
* ```
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
  /**
  * Create an empty writer with `initialSize` bytes of backing capacity.
  *
  * The capacity is only a starting hint — the buffer grows automatically as
  * needed — but a good estimate avoids reallocation. Sizes below 16 are clamped
  * up to 16.
  */
  constructor(initialSize = 256) {
    const size = Math.max(16, initialSize);
    this.#buf = new Uint8Array(size);
    this.#view = new DataView(this.#buf.buffer);
  }
  /** Number of bytes written so far (the logical length, not the backing capacity). */
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
  /** Append one byte; `value` is masked to its low 8 bits. */
  writeU8(value: number): void {
    this.#ensure(1);
    this.#buf[this.#len++] = value & 255;
  }
  /** Append a raw byte slice verbatim (the bytes are copied into the buffer). */
  writeBytes(bytes: Uint8Array): void {
    this.#ensure(bytes.byteLength);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.byteLength;
  }
  /**
  * UTF-8-encode `value` and append its bytes, with no length prefix.
  *
  * Returns the encoded bytes so the caller can prefix the byte length itself
  * (Thrift strings are a length followed by the UTF-8 payload, and the byte
  * length differs from the string's `.length` for non-ASCII text).
  *
  * ```ts no_run
  * import { ByteWriter } from 'internal:format/thrift';
  *
  * const w = new ByteWriter();
  * const utf8 = w.writeString('héllo');
  * // prepend the length elsewhere: w.writeI32BE(utf8.byteLength)
  * ```
  */
  writeString(value: string): Uint8Array {
    const bytes = _encoder.encode(value);
    this.writeBytes(bytes);
    return bytes;
  }
  /** Append a signed 16-bit integer big-endian (two bytes). */
  writeI16BE(value: number): void {
    this.#ensure(2);
    this.#view.setInt16(this.#len, value, false);
    this.#len += 2;
  }
  /** Append a signed 32-bit integer big-endian (four bytes). */
  writeI32BE(value: number): void {
    this.#ensure(4);
    this.#view.setInt32(this.#len, value, false);
    this.#len += 4;
  }
  /** Append a signed 64-bit integer big-endian (eight bytes); takes a `bigint` to keep full precision. */
  writeI64BE(value: bigint): void {
    this.#ensure(8);
    this.#view.setBigInt64(this.#len, value, false);
    this.#len += 8;
  }
  /** Append an IEEE-754 double big-endian (eight bytes). */
  writeF64BE(value: number): void {
    this.#ensure(8);
    this.#view.setFloat64(this.#len, value, false);
    this.#len += 8;
  }
  /** Append an IEEE-754 double little-endian (eight bytes); the layout the Thrift-JSON protocol expects. */
  writeF64LE(value: number): void {
    this.#ensure(8);
    this.#view.setFloat64(this.#len, value, true);
    this.#len += 8;
  }
  /**
  * Append an unsigned LEB128 varint.
  *
  * Accepts a `number` or `bigint`; the value is masked to 64 bits and emitted in
  * seven-bit groups, low group first, each but the last flagged with a
  * continuation bit. Read it back with `readVarint` (or `readVarint32` when it
  * fits). Throws `TypeError` if `value` is negative — signed values go through
  * `writeZigzag32` / `writeZigzag64` instead.
  */
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
  /**
  * Zig-zag-encode a signed 32-bit `value` and append it as a varint.
  *
  * Zig-zag interleaves positive and negative integers so small magnitudes of
  * either sign encode compactly. Pairs with `readZigzag32`.
  */
  writeZigzag32(value: number): void {
    this.writeVarint(BigInt.asUintN(32, BigInt(value << 1 ^ value >> 31)));
  }
  /**
  * Zig-zag-encode a signed 64-bit `value` and append it as a varint.
  *
  * The 64-bit counterpart of `writeZigzag32`, taking a `bigint` for full
  * precision. Pairs with `readZigzag64`.
  */
  writeZigzag64(value: bigint): void {
    this.writeVarint(BigInt.asUintN(64, value << 1n ^ value >> 63n));
  }
  /**
  * Return the written bytes as a view over the internal buffer (no copy).
  *
  * The view spans exactly `length` bytes. It aliases the writer's buffer, so
  * later writes may invalidate it (a growth reallocates, and further appends
  * overwrite trailing capacity) — take a `.slice()` if the bytes must outlive
  * further use of the writer.
  */
  bytes(): Uint8Array {
    return this.#buf.subarray(0, this.#len);
  }
}
