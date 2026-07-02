/**
* Thrift compact protocol (`TCompactProtocol`).
*
* The dense protocol Apache Parquet uses for its metadata. Integers are zig-zag
* varints, doubles are little-endian, field headers pack a delta-from-previous
* field id (1..15) into the high nibble when possible, and a field's boolean
* value is folded into its type nibble (BOOLEAN_TRUE/FALSE) — which means the
* field header for a bool is deferred until `writeBool` and recovered in
* `readBool`. Container and message headers follow the compact spec exactly.
*
* Reference: https://github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md
*
* @internal
*/
import { ProtocolBase, type Protocol, type MessageHeader, type FieldHeader, type MapHeader, type ListHeader } from './protocol.ts';
import { TType, CType, ttypeToCompact, compactToTtype, _fail } from './types.ts';
const PROTOCOL_ID = 130;
const VERSION = 1;
const VERSION_MASK = 31;
const TYPE_SHIFT = 5;
const TYPE_BITS = 7;
const _encoder = new TextEncoder();
/**
* Dense Thrift compact protocol.
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
  constructor(input?: Uint8Array) {
    super(input);
    this.#source = input;
  }
  // --- writing -------------------------------------------------------------
  writeMessageBegin(name: string, type: number, seqid: number): void {
    this.writer.writeU8(PROTOCOL_ID);
    this.writer.writeU8(VERSION & VERSION_MASK | type << TYPE_SHIFT & 224);
    this.writer.writeVarint(seqid >>> 0);
    this.#writeStringValue(name);
  }
  writeMessageEnd(): void {}
  writeStructBegin(_name?: string): void {
    this.#fieldIdStack.push(this.#lastFieldId);
    this.#lastFieldId = 0;
  }
  writeStructEnd(): void {
    this.#lastFieldId = this.#fieldIdStack.pop() ?? 0;
  }
  writeFieldBegin(_name: string, type: number, id: number): void {
    if (type === TType.BOOL) {
      // Defer: the header nibble encodes the boolean value.
      this.#pendingBoolId = id;
      return;
    }
    this.#writeFieldHeader(id, ttypeToCompact(type));
  }
  writeFieldEnd(): void {}
  writeFieldStop(): void {
    this.writer.writeU8(CType.STOP);
  }
  #writeFieldHeader(id: number, compactType: number): void {
    const delta = id - this.#lastFieldId;
    if (delta > 0 && delta <= 15) {
      this.writer.writeU8(delta << 4 | compactType);
    } else {
      this.writer.writeU8(compactType);
      this.writer.writeZigzag32(id);
    }
    this.#lastFieldId = id;
  }
  writeMapBegin(keyType: number, valueType: number, size: number): void {
    if (size === 0) {
      this.writer.writeU8(0);
      return;
    }
    this.writer.writeVarint(size);
    this.writer.writeU8(ttypeToCompact(keyType) << 4 | ttypeToCompact(valueType));
  }
  writeMapEnd(): void {}
  writeListBegin(elemType: number, size: number): void {
    const ct = ttypeToCompact(elemType);
    if (size <= 14) {
      this.writer.writeU8(size << 4 | ct);
    } else {
      this.writer.writeU8(240 | ct);
      this.writer.writeVarint(size);
    }
  }
  writeListEnd(): void {}
  writeSetBegin(elemType: number, size: number): void {
    this.writeListBegin(elemType, size);
  }
  writeSetEnd(): void {}
  writeBool(value: boolean): void {
    if (this.#pendingBoolId !== null) {
      this.#writeFieldHeader(this.#pendingBoolId, value ? CType.BOOLEAN_TRUE : CType.BOOLEAN_FALSE);
      this.#pendingBoolId = null;
    } else {
      this.writer.writeU8(value ? CType.BOOLEAN_TRUE : CType.BOOLEAN_FALSE);
    }
  }
  writeByte(value: number): void {
    this.writer.writeU8(value);
  }
  writeI16(value: number): void {
    this.writer.writeZigzag32(value);
  }
  writeI32(value: number): void {
    this.writer.writeZigzag32(value);
  }
  writeI64(value: bigint): void {
    this.writer.writeZigzag64(value);
  }
  writeDouble(value: number): void {
    this.writer.writeF64LE(value);
  }
  writeString(value: string): void {
    this.#writeStringValue(value);
  }
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
  readMessageBegin(): MessageHeader {
    const protocolId = this.reader.readU8();
    if (protocolId !== PROTOCOL_ID) {
      _fail(this.#source!, this.reader.position, `bad compact protocol id 0x${protocolId.toString(16)}`);
    }
    const versionAndType = this.reader.readU8();
    const version = versionAndType & VERSION_MASK;
    if (version !== VERSION) {
      _fail(this.#source!, this.reader.position, `unsupported compact protocol version ${version}`);
    }
    const type = versionAndType >> TYPE_SHIFT & TYPE_BITS;
    const seqid = this.reader.readVarint32() | 0;
    const name = this.#readStringValue();
    return {
      name,
      type,
      seqid
    };
  }
  readMessageEnd(): void {}
  readStructBegin(): string | null {
    this.#fieldIdStackRead.push(this.#lastFieldIdRead);
    this.#lastFieldIdRead = 0;
    return null;
  }
  readStructEnd(): void {
    this.#lastFieldIdRead = this.#fieldIdStackRead.pop() ?? 0;
  }
  readFieldBegin(): FieldHeader {
    const byte = this.reader.readU8();
    const nibble = byte & 15;
    if (nibble === CType.STOP) return {
      name: '',
      type: TType.STOP,
      id: 0
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
      id
    };
  }
  readFieldEnd(): void {}
  readMapBegin(): MapHeader {
    const size = this.reader.readVarint32();
    if (size === 0) return {
      keyType: TType.STOP,
      valueType: TType.STOP,
      size: 0
    };
    const kv = this.reader.readU8();
    return {
      keyType: compactToTtype(kv >> 4 & 15),
      valueType: compactToTtype(kv & 15),
      size
    };
  }
  readMapEnd(): void {}
  readListBegin(): ListHeader {
    const sizeAndType = this.reader.readU8();
    let size = sizeAndType >> 4 & 15;
    if (size === 15) size = this.reader.readVarint32();
    return {
      elemType: compactToTtype(sizeAndType & 15),
      size
    };
  }
  readListEnd(): void {}
  readSetBegin(): ListHeader {
    return this.readListBegin();
  }
  readSetEnd(): void {}
  readBool(): boolean {
    if (this.#pendingBoolValue !== null) {
      const v = this.#pendingBoolValue;
      this.#pendingBoolValue = null;
      return v;
    }
    return this.reader.readU8() === CType.BOOLEAN_TRUE;
  }
  readByte(): number {
    return this.reader.readI8();
  }
  readI16(): number {
    return this.reader.readZigzag32();
  }
  readI32(): number {
    return this.reader.readZigzag32();
  }
  readI64(): bigint {
    return this.reader.readZigzag64();
  }
  readDouble(): number {
    return this.reader.readF64LE();
  }
  readString(): string {
    return this.#readStringValue();
  }
  readBinary(): Uint8Array {
    const size = this.reader.readVarint32();
    return this.reader.readBytes(size).slice();
  }
  #readStringValue(): string {
    const size = this.reader.readVarint32();
    return this.reader.readString(size);
  }
}
