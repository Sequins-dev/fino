/**
* Thrift binary protocol (`TBinaryProtocol`).
*
* Everything is big-endian. Messages are written in the strict, version-prefixed
* form (`0x80010000 | type`) and read in either the strict or the legacy
* (name-length-first) form. Structs are field triples (`byte type`, `i16 id`,
* value) terminated by a `STOP` byte; containers carry element type(s) and an
* `i32` size.
*
* @internal
*/
import { ProtocolBase, type Protocol, type MessageHeader, type FieldHeader, type MapHeader, type ListHeader } from './protocol.ts';
import { TType, _fail } from './types.ts';
const VERSION_1 = 2147549184;
const VERSION_MASK = 4294901760;
const TYPE_MASK = 255;
/**
* Big-endian Thrift binary protocol.
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
  writeMessageBegin(name: string, type: number, seqid: number): void {
    this.writer.writeI32BE(VERSION_1 | type & TYPE_MASK);
    this.#writeStringValue(name);
    this.writer.writeI32BE(seqid);
  }
  writeMessageEnd(): void {}
  writeStructBegin(_name?: string): void {}
  writeStructEnd(): void {}
  writeFieldBegin(_name: string, type: number, id: number): void {
    this.writer.writeU8(type);
    this.writer.writeI16BE(id);
  }
  writeFieldEnd(): void {}
  writeFieldStop(): void {
    this.writer.writeU8(TType.STOP);
  }
  writeMapBegin(keyType: number, valueType: number, size: number): void {
    this.writer.writeU8(keyType);
    this.writer.writeU8(valueType);
    this.writer.writeI32BE(size);
  }
  writeMapEnd(): void {}
  writeListBegin(elemType: number, size: number): void {
    this.writer.writeU8(elemType);
    this.writer.writeI32BE(size);
  }
  writeListEnd(): void {}
  writeSetBegin(elemType: number, size: number): void {
    this.writeListBegin(elemType, size);
  }
  writeSetEnd(): void {}
  writeBool(value: boolean): void {
    this.writer.writeU8(value ? 1 : 0);
  }
  writeByte(value: number): void {
    this.writer.writeU8(value);
  }
  writeI16(value: number): void {
    this.writer.writeI16BE(value);
  }
  writeI32(value: number): void {
    this.writer.writeI32BE(value);
  }
  writeI64(value: bigint): void {
    this.writer.writeI64BE(value);
  }
  writeDouble(value: number): void {
    this.writer.writeF64BE(value);
  }
  writeString(value: string): void {
    this.#writeStringValue(value);
  }
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
  readMessageBegin(): MessageHeader {
    const size = this.reader.readI32BE();
    if (size < 0) {
      const version = (size & VERSION_MASK) >>> 0;
      if (version !== VERSION_1) {
        _fail(this.#source!, this.reader.position, `bad binary protocol version 0x${version.toString(16)}`);
      }
      const type = size & TYPE_MASK;
      const name = this.#readStringValue();
      const seqid = this.reader.readI32BE();
      return {
        name,
        type,
        seqid
      };
    }
    // Legacy (non-strict): `size` is the name length.
    const name = this.reader.readString(size);
    const type = this.reader.readU8();
    const seqid = this.reader.readI32BE();
    return {
      name,
      type,
      seqid
    };
  }
  readMessageEnd(): void {}
  readStructBegin(): string | null {
    return null;
  }
  readStructEnd(): void {}
  readFieldBegin(): FieldHeader {
    const type = this.reader.readU8();
    if (type === TType.STOP) return {
      name: '',
      type,
      id: 0
    };
    const id = this.reader.readI16BE();
    return {
      name: '',
      type,
      id
    };
  }
  readFieldEnd(): void {}
  readMapBegin(): MapHeader {
    const keyType = this.reader.readU8();
    const valueType = this.reader.readU8();
    const size = this.reader.readI32BE();
    return {
      keyType,
      valueType,
      size
    };
  }
  readMapEnd(): void {}
  readListBegin(): ListHeader {
    const elemType = this.reader.readU8();
    const size = this.reader.readI32BE();
    return {
      elemType,
      size
    };
  }
  readListEnd(): void {}
  readSetBegin(): ListHeader {
    return this.readListBegin();
  }
  readSetEnd(): void {}
  readBool(): boolean {
    return this.reader.readU8() !== 0;
  }
  readByte(): number {
    return this.reader.readI8();
  }
  readI16(): number {
    return this.reader.readI16BE();
  }
  readI32(): number {
    return this.reader.readI32BE();
  }
  readI64(): bigint {
    return this.reader.readI64BE();
  }
  readDouble(): number {
    return this.reader.readF64BE();
  }
  readString(): string {
    return this.#readStringValue();
  }
  readBinary(): Uint8Array {
    const size = this.reader.readI32BE();
    return this.reader.readBytes(size).slice();
  }
  #readStringValue(): string {
    const size = this.reader.readI32BE();
    return this.reader.readString(size);
  }
}
