/**
 * internal:format/thrift/compact — Thrift compact protocol (`TCompactProtocol`).
 *
 * The dense wire protocol Apache Parquet uses for its file metadata, and the
 * smallest of the three Thrift codecs. It trades a little encode/decode work for
 * a much tighter byte stream: integers are zig-zag varints (small magnitudes
 * cost one byte), doubles are eight little-endian bytes, and struct field
 * headers pack a delta-from-the-previous-field id (1..15) into the high nibble
 * of a single byte whenever the gap is small enough, falling back to an explicit
 * zig-zag id only when it is not.
 *
 * The one genuinely surprising rule is booleans. A boolean field folds its value
 * directly into the field header's type nibble (`BOOLEAN_TRUE` / `BOOLEAN_FALSE`)
 * rather than emitting a value byte, so the header cannot be written until the
 * value is known. This codec therefore defers the header at `writeFieldBegin` and
 * emits it inside `writeBool`; on the read side `readFieldBegin` stashes the
 * folded value for the following `readBool`. A boolean that is a container element
 * (not a struct field) has no header to fold into and is written as a plain
 * true/false byte. Container and message headers otherwise follow the compact
 * spec exactly.
 *
 * A single instance is either a writer or a reader, fixed at construction: pass
 * no argument to build a writer and call `bytes()` when done, or pass the input
 * buffer to build a reader. Do not mix the two on one instance.
 *
 * ```ts no_run
 *   import { CompactProtocol } from 'internal:format/thrift/compact';
 *   import { TType } from 'internal:format/thrift/types';
 *
 *   // Encode the struct { 1: i32 = 7, 2: bool = true }.
 *   const w = new CompactProtocol();
 *   w.writeStructBegin();
 *   w.writeFieldBegin('', TType.I32, 1);
 *   w.writeI32(7);
 *   w.writeFieldEnd();
 *   w.writeFieldBegin('', TType.BOOL, 2);
 *   w.writeBool(true);
 *   w.writeFieldEnd();
 *   w.writeFieldStop();
 *   w.writeStructEnd();
 *   const wire = w.bytes();
 *
 *   // Decode it back.
 *   const r = new CompactProtocol(wire);
 *   r.readStructBegin();
 *   for (;;) {
 *     const f = r.readFieldBegin();
 *     if (f.type === TType.STOP) break;
 *     if (f.type === TType.I32) r.readI32();   // 7 for field 1
 *     else if (f.type === TType.BOOL) r.readBool(); // true for field 2
 *     r.readFieldEnd();
 *   }
 *   r.readStructEnd();
 * ```
 *
 * Reference: https://github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md
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
import { TType, CType, ttypeToCompact, compactToTtype, _fail } from './types.ts';
const PROTOCOL_ID = 130;
const VERSION = 1;
const VERSION_MASK = 31;
const TYPE_SHIFT = 5;
const TYPE_BITS = 7;
const _encoder = new TextEncoder();
/**
 * Dense `TCompactProtocol` reader/writer.
 *
 * Implements the full `Protocol` contract over the compact wire form. Field-id
 * delta state and the deferred-boolean state are tracked internally and pushed
 * onto a stack across nested structs, so callers just drive the ordinary
 * begin/end/scalar sequence — the delta and bool-folding bookkeeping is handled
 * here. The instance is a writer when constructed with no input and a reader when
 * constructed with a buffer.
 *
 * ```ts no_run
 *   import { CompactProtocol } from 'internal:format/thrift/compact';
 *   import { TType } from 'internal:format/thrift/types';
 *
 *   // A boolean field folds its value into the header, so writeBool emits it.
 *   const w = new CompactProtocol();
 *   w.writeStructBegin();
 *   w.writeFieldBegin('', TType.BOOL, 1);
 *   w.writeBool(true);
 *   w.writeFieldEnd();
 *   w.writeFieldStop();
 *   w.writeStructEnd();
 *
 *   const r = new CompactProtocol(w.bytes());
 *   r.readStructBegin();
 *   const f = r.readFieldBegin(); // f.type === TType.BOOL, f.id === 1
 *   const value = r.readBool();   // true, recovered from the field header
 *   r.readFieldEnd();
 *   r.readStructEnd();
 * ```
 *
 * @internal
 */
export class CompactProtocol extends ProtocolBase implements Protocol {
  #source: Uint8Array | undefined;
  // Writer field-id state.
  #lastFieldId = 0;
  #fieldIdStack: number[] = [];
  #pendingBoolId: number | null = null;
  // Reader field-id state.
  #lastFieldIdRead = 0;
  #fieldIdStackRead: number[] = [];
  #pendingBoolValue: boolean | null = null;
  /**
   * Builds a writer when `input` is omitted, or a reader over `input` when it is
   * supplied. The two modes never mix on one instance: reader-only calls throw in
   * writer mode and vice versa.
   */
  constructor(input?: Uint8Array) {
    super(input);
    this.#source = input;
  }
  // --- writing -------------------------------------------------------------
  /**
   * Writes the compact message envelope: the protocol-id byte, a byte packing the
   * version and message type, the sequence id as a varint, then the method name.
   */
  writeMessageBegin(name: string, type: number, seqid: number): void {
    this.writer.writeU8(PROTOCOL_ID);
    this.writer.writeU8((VERSION & VERSION_MASK) | ((type << TYPE_SHIFT) & 224));
    this.writer.writeVarint(seqid >>> 0);
    this.#writeStringValue(name);
  }
  /** No-op; the compact message body carries no trailing envelope bytes. */
  writeMessageEnd(): void {}
  /**
   * Opens a struct, saving the current field-id delta base on a stack and
   * resetting it to zero so this struct's field ids delta from scratch. The name
   * is ignored — compact structs carry no name on the wire.
   */
  writeStructBegin(_name?: string): void {
    this.#fieldIdStack.push(this.#lastFieldId);
    this.#lastFieldId = 0;
  }
  /** Closes a struct, restoring the enclosing struct's field-id delta base. */
  writeStructEnd(): void {
    this.#lastFieldId = this.#fieldIdStack.pop() ?? 0;
  }
  /**
   * Writes a field header, delta-encoding the id against the previous field when
   * the gap fits in a nibble (1..15) and falling back to an explicit zig-zag id
   * otherwise. Boolean fields are special: no header is emitted here because the
   * value must be folded into the type nibble, so the id is stashed and the header
   * is written by the next `writeBool`.
   */
  writeFieldBegin(_name: string, type: number, id: number): void {
    if (type === TType.BOOL) {
      // Defer: the header nibble encodes the boolean value.
      this.#pendingBoolId = id;
      return;
    }
    this.#writeFieldHeader(id, ttypeToCompact(type));
  }
  /** No-op; a compact field value is self-delimiting, so nothing trails it. */
  writeFieldEnd(): void {}
  /** Writes the STOP byte that terminates a struct's field list. */
  writeFieldStop(): void {
    this.writer.writeU8(CType.STOP);
  }
  #writeFieldHeader(id: number, compactType: number): void {
    const delta = id - this.#lastFieldId;
    if (delta > 0 && delta <= 15) {
      this.writer.writeU8((delta << 4) | compactType);
    } else {
      this.writer.writeU8(compactType);
      this.writer.writeZigzag32(id);
    }
    this.#lastFieldId = id;
  }
  /**
   * Writes a map header: the varint size followed by one byte packing the compact
   * key type (high nibble) and value type (low nibble). An empty map collapses to
   * a single zero byte with no trailing type byte.
   */
  writeMapBegin(keyType: number, valueType: number, size: number): void {
    if (size === 0) {
      this.writer.writeU8(0);
      return;
    }
    this.writer.writeVarint(size);
    this.writer.writeU8((ttypeToCompact(keyType) << 4) | ttypeToCompact(valueType));
  }
  /** No-op; the map body ends after `size` key/value pairs. */
  writeMapEnd(): void {}
  /**
   * Writes a list header, packing size and element type into one byte when the
   * size is 14 or fewer, otherwise setting the 0xF short-size sentinel and
   * trailing the real size as a varint.
   */
  writeListBegin(elemType: number, size: number): void {
    const ct = ttypeToCompact(elemType);
    if (size <= 14) {
      this.writer.writeU8((size << 4) | ct);
    } else {
      this.writer.writeU8(240 | ct);
      this.writer.writeVarint(size);
    }
  }
  /** No-op; the list body ends after `size` elements. */
  writeListEnd(): void {}
  /** Writes a set header, which is byte-for-byte identical to a list header. */
  writeSetBegin(elemType: number, size: number): void {
    this.writeListBegin(elemType, size);
  }
  /** No-op; the set body ends after `size` elements. */
  writeSetEnd(): void {}
  /**
   * Writes a boolean. When a boolean field header is pending (from a preceding
   * `writeFieldBegin`), it emits that header with the value folded into the type
   * nibble; otherwise — as a container element — it writes a standalone true/false
   * byte.
   */
  writeBool(value: boolean): void {
    if (this.#pendingBoolId !== null) {
      this.#writeFieldHeader(this.#pendingBoolId, value ? CType.BOOLEAN_TRUE : CType.BOOLEAN_FALSE);
      this.#pendingBoolId = null;
    } else {
      this.writer.writeU8(value ? CType.BOOLEAN_TRUE : CType.BOOLEAN_FALSE);
    }
  }
  /** Writes a single raw byte value. */
  writeByte(value: number): void {
    this.writer.writeU8(value);
  }
  /** Writes a 16-bit integer as a zig-zag varint. */
  writeI16(value: number): void {
    this.writer.writeZigzag32(value);
  }
  /** Writes a 32-bit integer as a zig-zag varint. */
  writeI32(value: number): void {
    this.writer.writeZigzag32(value);
  }
  /** Writes a 64-bit integer as a zig-zag varint. */
  writeI64(value: bigint): void {
    this.writer.writeZigzag64(value);
  }
  /** Writes a double as eight little-endian bytes. */
  writeDouble(value: number): void {
    this.writer.writeF64LE(value);
  }
  /** Writes a UTF-8 string prefixed with its varint byte length. */
  writeString(value: string): void {
    this.#writeStringValue(value);
  }
  /** Writes a raw byte buffer prefixed with its varint byte length. */
  writeBinary(value: Uint8Array): void {
    this.writer.writeVarint(value.byteLength);
    this.writer.writeBytes(value);
  }
  #writeStringValue(value: string): void {
    const bytes = _encoder.encode(value);
    this.writer.writeVarint(bytes.byteLength);
    this.writer.writeBytes(bytes);
  }
  // --- reading -------------------------------------------------------------
  /**
   * Reads and validates the message envelope, returning the decoded name, message
   * type, and sequence id. Throws if the protocol-id byte is not the compact id or
   * the version field is not the supported version.
   */
  readMessageBegin(): MessageHeader {
    const protocolId = this.reader.readU8();
    if (protocolId !== PROTOCOL_ID) {
      _fail(
        this.#source!,
        this.reader.position,
        `bad compact protocol id 0x${protocolId.toString(16)}`,
      );
    }
    const versionAndType = this.reader.readU8();
    const version = versionAndType & VERSION_MASK;
    if (version !== VERSION) {
      _fail(this.#source!, this.reader.position, `unsupported compact protocol version ${version}`);
    }
    const type = (versionAndType >> TYPE_SHIFT) & TYPE_BITS;
    const seqid = this.reader.readVarint32() | 0;
    const name = this.#readStringValue();
    return {
      name,
      type,
      seqid,
    };
  }
  /** No-op; there is nothing to consume after a compact message body. */
  readMessageEnd(): void {}
  /**
   * Opens a struct for reading, saving and resetting the field-id delta base so
   * ids resolve relative to this struct. Always returns null: compact struct names
   * are not present on the wire.
   */
  readStructBegin(): string | null {
    this.#fieldIdStackRead.push(this.#lastFieldIdRead);
    this.#lastFieldIdRead = 0;
    return null;
  }
  /** Closes a struct, restoring the enclosing struct's field-id delta base. */
  readStructEnd(): void {
    this.#lastFieldIdRead = this.#fieldIdStackRead.pop() ?? 0;
  }
  /**
   * Reads a field header and returns its resolved `id` and logical `TType`. The id
   * comes from the header's delta nibble added to the running field id, or from a
   * trailing explicit zig-zag id when the nibble is zero. A STOP nibble yields a
   * STOP field; a boolean type nibble stashes the folded value for the next
   * `readBool`. The `name` is always empty — it is not on the wire.
   */
  readFieldBegin(): FieldHeader {
    const byte = this.reader.readU8();
    const nibble = byte & 15;
    if (nibble === CType.STOP)
      return {
        name: '',
        type: TType.STOP,
        id: 0,
      };
    const modifier = (byte & 240) >> 4;
    let id: number;
    if (modifier === 0) {
      id = this.reader.readZigzag32();
    } else {
      id = this.#lastFieldIdRead + modifier;
    }
    this.#lastFieldIdRead = id;
    let type = compactToTtype(nibble);
    if (nibble === CType.BOOLEAN_TRUE) {
      this.#pendingBoolValue = true;
      type = TType.BOOL;
    } else if (nibble === CType.BOOLEAN_FALSE) {
      this.#pendingBoolValue = false;
      type = TType.BOOL;
    }
    return {
      name: '',
      type,
      id,
    };
  }
  /** No-op; a compact field value is self-delimiting, so nothing trails it. */
  readFieldEnd(): void {}
  /**
   * Reads a map header, returning the key/value `TType`s and the element count. A
   * zero size returns an empty header (STOP key/value types) with no following
   * type byte consumed, matching how `writeMapBegin` collapses empty maps.
   */
  readMapBegin(): MapHeader {
    const size = this.reader.readVarint32();
    if (size === 0)
      return {
        keyType: TType.STOP,
        valueType: TType.STOP,
        size: 0,
      };
    const kv = this.reader.readU8();
    return {
      keyType: compactToTtype((kv >> 4) & 15),
      valueType: compactToTtype(kv & 15),
      size,
    };
  }
  /** No-op; the map body ends after `size` key/value pairs. */
  readMapEnd(): void {}
  /**
   * Reads a list header, returning the element `TType` and count. The 0xF
   * short-size sentinel is expanded by reading a trailing varint size.
   */
  readListBegin(): ListHeader {
    const sizeAndType = this.reader.readU8();
    let size = (sizeAndType >> 4) & 15;
    if (size === 15) size = this.reader.readVarint32();
    return {
      elemType: compactToTtype(sizeAndType & 15),
      size,
    };
  }
  /** No-op; the list body ends after `size` elements. */
  readListEnd(): void {}
  /** Reads a set header, which is decoded identically to a list header. */
  readSetBegin(): ListHeader {
    return this.readListBegin();
  }
  /** No-op; the set body ends after `size` elements. */
  readSetEnd(): void {}
  /**
   * Reads a boolean. When a field header already carried the folded value (from
   * `readFieldBegin`), that stashed value is returned and cleared; otherwise — as
   * a container element — a standalone true/false byte is consumed.
   */
  readBool(): boolean {
    if (this.#pendingBoolValue !== null) {
      const v = this.#pendingBoolValue;
      this.#pendingBoolValue = null;
      return v;
    }
    return this.reader.readU8() === CType.BOOLEAN_TRUE;
  }
  /** Reads a single signed byte. */
  readByte(): number {
    return this.reader.readI8();
  }
  /** Reads a zig-zag varint as a 16-bit integer. */
  readI16(): number {
    return this.reader.readZigzag32();
  }
  /** Reads a zig-zag varint as a 32-bit integer. */
  readI32(): number {
    return this.reader.readZigzag32();
  }
  /** Reads a zig-zag varint as a 64-bit integer. */
  readI64(): bigint {
    return this.reader.readZigzag64();
  }
  /** Reads eight little-endian bytes as a double. */
  readDouble(): number {
    return this.reader.readF64LE();
  }
  /** Reads a varint-length-prefixed UTF-8 string. */
  readString(): string {
    return this.#readStringValue();
  }
  /**
   * Reads a varint-length-prefixed byte buffer, returning an owned copy that is
   * safe to retain after the reader advances.
   */
  readBinary(): Uint8Array {
    const size = this.reader.readVarint32();
    return this.reader.readBytes(size).slice();
  }
  #readStringValue(): string {
    const size = this.reader.readVarint32();
    return this.reader.readString(size);
  }
}
