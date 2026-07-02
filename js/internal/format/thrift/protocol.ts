/**
* The Thrift protocol contract shared by the binary, compact, and JSON codecs.
*
* This is the standard `TProtocol` surface that generated-style code (and the
* Parquet metadata reader) drives: structured begin/end calls plus scalar
* read/write. A protocol instance is either a writer (`new X()`, then `bytes()`)
* or a reader (`new X(input)`), determined at construction.
*
* @internal
*/
import { ByteReader, ByteWriter } from './io.ts';
/** Parsed message envelope. @internal */
export interface MessageHeader {
  name: string;
  type: number;
  seqid: number;
}
/** Parsed struct field header (`id`/`type`; `name` is not on the wire). @internal */
export interface FieldHeader {
  name: string;
  type: number;
  id: number;
}
/** Parsed map header. @internal */
export interface MapHeader {
  keyType: number;
  valueType: number;
  size: number;
}
/** Parsed list or set header. @internal */
export interface ListHeader {
  elemType: number;
  size: number;
}
/**
* The Thrift protocol read/write contract. All three protocols implement it;
* the logical types are always `TType` codes (each protocol encodes them in its
* own wire form).
*
* @internal
*/
export interface Protocol {
  writeMessageBegin(name: string, type: number, seqid: number): void;
  writeMessageEnd(): void;
  writeStructBegin(name?: string): void;
  writeStructEnd(): void;
  writeFieldBegin(name: string, type: number, id: number): void;
  writeFieldEnd(): void;
  writeFieldStop(): void;
  writeMapBegin(keyType: number, valueType: number, size: number): void;
  writeMapEnd(): void;
  writeListBegin(elemType: number, size: number): void;
  writeListEnd(): void;
  writeSetBegin(elemType: number, size: number): void;
  writeSetEnd(): void;
  writeBool(value: boolean): void;
  writeByte(value: number): void;
  writeI16(value: number): void;
  writeI32(value: number): void;
  writeI64(value: bigint): void;
  writeDouble(value: number): void;
  writeString(value: string): void;
  writeBinary(value: Uint8Array): void;
  readMessageBegin(): MessageHeader;
  readMessageEnd(): void;
  readStructBegin(): string | null;
  readStructEnd(): void;
  readFieldBegin(): FieldHeader;
  readFieldEnd(): void;
  readMapBegin(): MapHeader;
  readMapEnd(): void;
  readListBegin(): ListHeader;
  readListEnd(): void;
  readSetBegin(): ListHeader;
  readSetEnd(): void;
  readBool(): boolean;
  readByte(): number;
  readI16(): number;
  readI32(): number;
  readI64(): bigint;
  readDouble(): number;
  readString(): string;
  readBinary(): Uint8Array;
  /** Finished output bytes (writer mode only). */
  bytes(): Uint8Array;
}
/**
* Shared reader/writer plumbing for the concrete protocols.
*
* @internal
*/
export abstract class ProtocolBase {
  /**
  * Present in reader mode.
  *
  * @internal
  */
  protected reader!: ByteReader;
  /**
  * Present in writer mode.
  *
  * @internal
  */
  protected writer!: ByteWriter;
  constructor(input?: Uint8Array) {
    if (input !== undefined) this.reader = new ByteReader(input);
    else this.writer = new ByteWriter();
  }
  /** Finished output bytes (writer mode only). */
  bytes(): Uint8Array {
    if (this.writer === undefined) throw new Error('thrift: bytes() called on a reader protocol');
    return this.writer.bytes();
  }
}
