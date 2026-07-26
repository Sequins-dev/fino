/**
 * Thrift binary protocol (`TBinaryProtocol`).
 *
 * This is the simplest, most portable Thrift wire format: every scalar is laid
 * out big-endian with a fixed width, so encoding is a direct byte copy with no
 * varint or zig-zag tricks. It trades the density of the compact protocol for
 * speed and transparency. Reach for it when interoperating with a peer that
 * speaks `TBinaryProtocol`, or when you want the on-wire bytes to be easy to
 * inspect; prefer the compact protocol (used by Parquet metadata) when size
 * matters.
 *
 * Messages are written in the strict, version-prefixed form
 * (`0x80010000 | type`) and read in either the strict form or the legacy
 * (name-length-first) form, so this reader accepts output from old servers that
 * predate the version prefix. Structs are a sequence of field triples
 * (`byte type`, `i16 id`, value) terminated by a `STOP` byte and carry no
 * header of their own; containers are prefixed with their element type(s) and an
 * `i32` element count. Strings and binary are an `i32` byte-length followed by
 * the raw (UTF-8, for strings) bytes.
 *
 * A single instance is either a writer or a reader, fixed at construction:
 * `new BinaryProtocol()` builds a writer whose bytes you collect with `bytes()`,
 * while `new BinaryProtocol(input)` builds a reader over `input`.
 *
 * ```ts no_run
 * import { BinaryProtocol, TType } from 'internal:format/thrift';
 *
 * // Encode a one-field struct { 1: i32 = 42 }.
 * const w = new BinaryProtocol();
 * w.writeStructBegin();
 * w.writeFieldBegin('', TType.I32, 1);
 * w.writeI32(42);
 * w.writeFieldEnd();
 * w.writeFieldStop();
 * w.writeStructEnd();
 * const bytes = w.bytes();
 *
 * // Decode it back.
 * const r = new BinaryProtocol(bytes);
 * r.readStructBegin();
 * const field = r.readFieldBegin(); // { type: TType.I32, id: 1, name: '' }
 * const value = r.readI32();        // 42
 * r.readFieldEnd();
 * r.readFieldBegin();               // { type: TType.STOP, ... }
 * r.readStructEnd();
 * ```
 *
 * Reference: https://github.com/apache/thrift/blob/master/doc/specs/thrift-binary-protocol.md
 *
 * @internal
 */
import {
  ProtocolBase,
  type Protocol,
  type MessageHeader,
  type FieldHeader,
  type MapHeader,
  type ListHeader,
} from './protocol.ts';
import { TType, _fail } from './types.ts';
const VERSION_1 = 2147549184;
const VERSION_MASK = 4294901760;
const TYPE_MASK = 255;
/**
 * Big-endian Thrift binary protocol codec implementing the shared `Protocol`
 * contract.
 *
 * Construct with no argument for a writer and drive the `write*` calls in the
 * structure order the Thrift schema implies (`writeStructBegin`, then a
 * `writeFieldBegin`/value/`writeFieldEnd` per field, then `writeFieldStop`,
 * then `writeStructEnd`), finally collecting the encoded bytes with `bytes()`.
 * Construct with a `Uint8Array` for a reader and mirror those calls with the
 * `read*` counterparts against the buffer. The two modes are mutually exclusive:
 * calling a `write*` method on a reader, or a `read*` method past the end of the
 * buffer, throws.
 *
 * ```ts no_run
 * import { BinaryProtocol, TType, TMessageType } from 'internal:format/thrift';
 *
 * const w = new BinaryProtocol();
 * w.writeMessageBegin('ping', TMessageType.CALL, 7);
 * w.writeStructBegin();
 * w.writeFieldStop();
 * w.writeStructEnd();
 * w.writeMessageEnd();
 *
 * const r = new BinaryProtocol(w.bytes());
 * const header = r.readMessageBegin(); // { name: 'ping', type: CALL, seqid: 7 }
 * ```
 *
 * @internal
 */
export class BinaryProtocol extends ProtocolBase implements Protocol {
  #source: Uint8Array | undefined;
  constructor(input?: Uint8Array) {
    super(input);
    this.#source = input;
  }
  // --- writing -------------------------------------------------------------
  /**
   * Writes a strict, version-prefixed message envelope.
   *
   * Emits the i32 `0x80010000 | (type & 0xff)`, then the length-prefixed UTF-8
   * `name`, then the i32 `seqid`. `type` is a `TMessageType` (CALL, REPLY,
   * EXCEPTION, ONEWAY); `seqid` is the request/response correlation number.
   */
  writeMessageBegin(name: string, type: number, seqid: number): void {
    this.writer.writeI32BE(VERSION_1 | (type & TYPE_MASK));
    this.#writeStringValue(name);
    this.writer.writeI32BE(seqid);
  }
  /** No-op; the binary protocol writes no message terminator. */
  writeMessageEnd(): void {}
  /** No-op; binary structs carry no header (`_name` is ignored). */
  writeStructBegin(_name?: string): void {}
  /** No-op; struct extent is delimited by the `STOP` byte, not an end marker. */
  writeStructEnd(): void {}
  /**
   * Writes a field header: the `type` byte (a `TType` code) followed by the
   * i16 field `id`. The declared `_name` is not on the wire and is ignored.
   */
  writeFieldBegin(_name: string, type: number, id: number): void {
    this.writer.writeU8(type);
    this.writer.writeI16BE(id);
  }
  /** No-op; a field's extent is fixed by its type, so no end marker is written. */
  writeFieldEnd(): void {}
  /** Writes the single `STOP` byte that terminates the current struct's fields. */
  writeFieldStop(): void {
    this.writer.writeU8(TType.STOP);
  }
  /**
   * Writes a map header: the key type byte, the value type byte, then the i32
   * entry count. The caller writes the `size` key/value pairs that follow.
   */
  writeMapBegin(keyType: number, valueType: number, size: number): void {
    this.writer.writeU8(keyType);
    this.writer.writeU8(valueType);
    this.writer.writeI32BE(size);
  }
  /** No-op; a map's extent is fixed by its declared size. */
  writeMapEnd(): void {}
  /**
   * Writes a list header: the element type byte then the i32 element count.
   * The caller writes the `size` elements that follow.
   */
  writeListBegin(elemType: number, size: number): void {
    this.writer.writeU8(elemType);
    this.writer.writeI32BE(size);
  }
  /** No-op; a list's extent is fixed by its declared size. */
  writeListEnd(): void {}
  /** Writes a set header; binary sets share the list wire form exactly. */
  writeSetBegin(elemType: number, size: number): void {
    this.writeListBegin(elemType, size);
  }
  /** No-op; a set's extent is fixed by its declared size. */
  writeSetEnd(): void {}
  /** Writes a boolean as a single byte, `1` for true and `0` for false. */
  writeBool(value: boolean): void {
    this.writer.writeU8(value ? 1 : 0);
  }
  /** Writes a signed 8-bit integer as one byte. */
  writeByte(value: number): void {
    this.writer.writeU8(value);
  }
  /** Writes a signed 16-bit integer, big-endian. */
  writeI16(value: number): void {
    this.writer.writeI16BE(value);
  }
  /** Writes a signed 32-bit integer, big-endian. */
  writeI32(value: number): void {
    this.writer.writeI32BE(value);
  }
  /** Writes a signed 64-bit integer (as a `bigint`), big-endian. */
  writeI64(value: bigint): void {
    this.writer.writeI64BE(value);
  }
  /** Writes an IEEE-754 double, big-endian. */
  writeDouble(value: number): void {
    this.writer.writeF64BE(value);
  }
  /** Writes a UTF-8 string with an i32 byte-length prefix. */
  writeString(value: string): void {
    this.#writeStringValue(value);
  }
  /** Writes a raw byte string with an i32 byte-length prefix. */
  writeBinary(value: Uint8Array): void {
    this.writer.writeI32BE(value.byteLength);
    this.writer.writeBytes(value);
  }
  #writeStringValue(value: string): void {
    // Encode first so the i32 length prefix is exact for multi-byte UTF-8.
    const bytes = new TextEncoder().encode(value);
    this.writer.writeI32BE(bytes.byteLength);
    this.writer.writeBytes(bytes);
  }
  // --- reading -------------------------------------------------------------
  /**
   * Reads a message envelope, accepting both wire forms.
   *
   * When the leading i32 is negative it is the strict, version-prefixed form:
   * the high half is validated against `VERSION_1` and the low byte is the
   * message type, followed by the length-prefixed name and the i32 seqid. When
   * it is non-negative it is treated as the legacy form, where that i32 is the
   * name's byte length, followed by a single type byte and the i32 seqid.
   *
   * Throws if the strict-form version bits do not match `VERSION_1` (a
   * `ThriftError` pointing at the offending offset), which usually means the
   * buffer is not a Thrift binary message or is misaligned.
   */
  readMessageBegin(): MessageHeader {
    const size = this.reader.readI32BE();
    if (size < 0) {
      const version = (size & VERSION_MASK) >>> 0;
      if (version !== VERSION_1) {
        _fail(
          this.#source!,
          this.reader.position,
          `bad binary protocol version 0x${version.toString(16)}`,
        );
      }
      const type = size & TYPE_MASK;
      const name = this.#readStringValue();
      const seqid = this.reader.readI32BE();
      return {
        name,
        type,
        seqid,
      };
    }
    // Legacy (non-strict): `size` is the name length.
    const name = this.reader.readString(size);
    const type = this.reader.readU8();
    const seqid = this.reader.readI32BE();
    return {
      name,
      type,
      seqid,
    };
  }
  /** No-op; there is no message terminator to consume. */
  readMessageEnd(): void {}
  /**
   * Enters a struct. Always returns `null` because the binary protocol does not
   * carry a struct name on the wire; the return type exists only to satisfy the
   * shared `Protocol` contract.
   */
  readStructBegin(): string | null {
    return null;
  }
  /** No-op; struct end is signalled by the `STOP` field, not a separate marker. */
  readStructEnd(): void {}
  /**
   * Reads the next field header. Reads the type byte first; if it is `STOP` the
   * struct is finished and a header with `type: TType.STOP` and `id: 0` is
   * returned without consuming an id. Otherwise the i16 field `id` follows.
   * `name` is always `''` because field names are not on the wire.
   *
   * ```ts no_run
   * import { TType } from 'internal:format/thrift';
   *
   * for (;;) {
   *   const f = r.readFieldBegin();
   *   if (f.type === TType.STOP) break;
   *   // dispatch on f.id / f.type, read the value, then:
   *   r.readFieldEnd();
   * }
   * ```
   */
  readFieldBegin(): FieldHeader {
    const type = this.reader.readU8();
    if (type === TType.STOP)
      return {
        name: '',
        type,
        id: 0,
      };
    const id = this.reader.readI16BE();
    return {
      name: '',
      type,
      id,
    };
  }
  /** No-op; nothing follows a field value in the binary form. */
  readFieldEnd(): void {}
  /**
   * Reads a map header: the key type byte, the value type byte, then the i32
   * entry count the caller should iterate.
   */
  readMapBegin(): MapHeader {
    const keyType = this.reader.readU8();
    const valueType = this.reader.readU8();
    const size = this.reader.readI32BE();
    return {
      keyType,
      valueType,
      size,
    };
  }
  /** No-op; the map's element count fully determines its extent. */
  readMapEnd(): void {}
  /**
   * Reads a list header: the element type byte then the i32 element count the
   * caller should iterate.
   */
  readListBegin(): ListHeader {
    const elemType = this.reader.readU8();
    const size = this.reader.readI32BE();
    return {
      elemType,
      size,
    };
  }
  /** No-op; the list's element count fully determines its extent. */
  readListEnd(): void {}
  /** Reads a set header; identical to a list header on the wire. */
  readSetBegin(): ListHeader {
    return this.readListBegin();
  }
  /** No-op; the set's element count fully determines its extent. */
  readSetEnd(): void {}
  /** Reads a boolean; any non-zero byte is true. */
  readBool(): boolean {
    return this.reader.readU8() !== 0;
  }
  /** Reads a signed 8-bit integer. */
  readByte(): number {
    return this.reader.readI8();
  }
  /** Reads a signed 16-bit integer, big-endian. */
  readI16(): number {
    return this.reader.readI16BE();
  }
  /** Reads a signed 32-bit integer, big-endian. */
  readI32(): number {
    return this.reader.readI32BE();
  }
  /** Reads a signed 64-bit integer as a `bigint`, big-endian. */
  readI64(): bigint {
    return this.reader.readI64BE();
  }
  /** Reads an IEEE-754 double, big-endian. */
  readDouble(): number {
    return this.reader.readF64BE();
  }
  /** Reads an i32-length-prefixed UTF-8 string. */
  readString(): string {
    return this.#readStringValue();
  }
  /**
   * Reads an i32-length-prefixed raw byte string. The result is a fresh copy
   * (`slice`), so it is safe to retain after the reader advances or the backing
   * buffer is reused.
   */
  readBinary(): Uint8Array {
    const size = this.reader.readI32BE();
    return this.reader.readBytes(size).slice();
  }
  #readStringValue(): string {
    const size = this.reader.readI32BE();
    return this.reader.readString(size);
  }
}
