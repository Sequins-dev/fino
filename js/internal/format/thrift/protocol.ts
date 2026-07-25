/**
* The Thrift protocol contract shared by the binary, compact, and JSON codecs.
*
* This is the standard `TProtocol` surface that generated-style code (and the
* Parquet metadata reader) drives: structured begin/end calls plus scalar
* read/write. A protocol instance is either a writer (`new X()`, then `bytes()`)
* or a reader (`new X(input)`), determined at construction — there is no mode
* that both reads and writes, and calling the wrong side (for example `bytes()`
* on a reader) throws.
*
* The contract is deliberately schema-less and stateful. Serialization is a
* sequence of paired begin/end calls that mirror the structure of the value:
* open a struct, open each field with its `TType` and numeric id, write the
* scalar, close the field, write the field-stop sentinel, close the struct.
* Deserialization walks the same shape, with the reader returning the header
* records defined here (`MessageHeader`, `FieldHeader`, `MapHeader`,
* `ListHeader`) so the caller knows what comes next. The logical types crossing
* this interface are always `TType` codes; each concrete protocol is free to
* re-encode them in its own wire form (the compact protocol, for instance, packs
* them into nibbles), but the interface never speaks those wire encodings.
*
* Use this module when you need the type shared across the three protocols — for
* a codec-agnostic reader/writer signature, or to subclass `ProtocolBase` when
* implementing a new protocol. To actually serialize, construct one of the
* concrete protocols (`BinaryProtocol`, `CompactProtocol`, `JSONProtocol`) from
* `internal:format/thrift`, all of which implement `Protocol` and extend
* `ProtocolBase`.
*
* ```ts no_run
* import { BinaryProtocol, TType, type Protocol } from 'internal:format/thrift';
*
* // A single function that works against any protocol.
* function writePoint(p: Protocol, x: number, y: number): void {
*   p.writeStructBegin();
*   p.writeFieldBegin('x', TType.I32, 1);
*   p.writeI32(x);
*   p.writeFieldEnd();
*   p.writeFieldBegin('y', TType.I32, 2);
*   p.writeI32(y);
*   p.writeFieldEnd();
*   p.writeFieldStop();
*   p.writeStructEnd();
* }
*
* const w = new BinaryProtocol();
* writePoint(w, 3, 4);
* const bytes = w.bytes();
*
* const r = new BinaryProtocol(bytes);
* r.readStructBegin();
* let f = r.readFieldBegin();
* while (f.type !== TType.STOP) {
*   const value = r.readI32();
*   r.readFieldEnd();
*   f = r.readFieldBegin();
* }
* r.readStructEnd();
* ```
*
* @internal
*/
import { ByteReader, ByteWriter } from './io.ts';
/**
* Envelope header returned by `readMessageBegin` for the RPC framing layer.
*
* A Thrift message wraps a struct payload with a name, a kind, and a sequence id
* so a reply can be matched to its call. Only the RPC message envelope carries
* one; plain struct serialization (as used by the Parquet metadata reader) never
* opens a message.
*
* ```ts no_run
* import { BinaryProtocol, TMessageType } from 'internal:format/thrift';
*
* const w = new BinaryProtocol();
* w.writeMessageBegin('ping', TMessageType.CALL, 7);
* w.writeMessageEnd();
*
* const r = new BinaryProtocol(w.bytes());
* const h = r.readMessageBegin(); // { name: 'ping', type: TMessageType.CALL, seqid: 7 }
* ```
*
* @internal
*/
export interface MessageHeader {
  /** Logical method name being invoked or replied to. */
  name: string;
  /** Message kind — one of the `TMessageType` codes (call, reply, exception, oneway). */
  type: number;
  /** Sequence id echoed back in the reply so callers can correlate it with the call. */
  seqid: number;
}
/**
* Field header returned by `readFieldBegin` as a struct is decoded.
*
* Each struct is a flat sequence of fields, each introduced by its wire `TType`
* and numeric id; the reader hands back one of these per field. A `type` equal
* to `TType.STOP` signals the field-stop sentinel and thus the end of the
* struct — this is the loop condition when reading. The `name` is not on the
* wire for the binary and compact protocols, so it is synthesized (typically
* empty) rather than recovered.
*
* ```ts no_run
* import { CompactProtocol, TType } from 'internal:format/thrift';
*
* const r = new CompactProtocol(bytes);
* r.readStructBegin();
* let f = r.readFieldBegin();
* while (f.type !== TType.STOP) {
*   if (f.id === 1 && f.type === TType.I32) console.log('field 1 =', r.readI32());
*   r.readFieldEnd();
*   f = r.readFieldBegin();
* }
* r.readStructEnd();
* ```
*
* @internal
*/
export interface FieldHeader {
  /** Field name; informational only and not carried on the wire by binary/compact. */
  name: string;
  /** Field's wire `TType`; `TType.STOP` marks the end of the struct. */
  type: number;
  /** Numeric field id from the schema, used to route the value to a struct member. */
  id: number;
}
/**
* Map header returned by `readMapBegin`, describing the entries that follow.
*
* A map is written as a header (key type, value type, entry count) followed by
* `size` interleaved key/value pairs, each encoded per its declared `TType`. The
* reader returns this record so the caller knows how many pairs to read and how
* to decode each half.
*
* ```ts no_run
* import { CompactProtocol, TType } from 'internal:format/thrift';
*
* const r = new CompactProtocol(bytes);
* const h = r.readMapBegin();
* const out = new Map<string, number>();
* for (let i = 0; i < h.size; i++) {
*   const k = r.readString(); // h.keyType === TType.STRING
*   const v = r.readI32();     // h.valueType === TType.I32
*   out.set(k, v);
* }
* r.readMapEnd();
* ```
*
* @internal
*/
export interface MapHeader {
  /** Wire `TType` of every key in the map. */
  keyType: number;
  /** Wire `TType` of every value in the map. */
  valueType: number;
  /** Number of key/value pairs that follow the header. */
  size: number;
}
/**
* List or set header returned by `readListBegin` / `readSetBegin`.
*
* Lists and sets share the same shape on the wire — a uniform element type and a
* count — and both readers return this record. `size` elements of `elemType`
* follow, to be read with the scalar or container method matching that type.
*
* ```ts no_run
* import { BinaryProtocol, TType } from 'internal:format/thrift';
*
* const r = new BinaryProtocol(bytes);
* const h = r.readListBegin();
* const items: number[] = [];
* for (let i = 0; i < h.size; i++) items.push(r.readI32()); // h.elemType === TType.I32
* r.readListEnd();
* ```
*
* @internal
*/
export interface ListHeader {
  /** Wire `TType` shared by every element of the list or set. */
  elemType: number;
  /** Number of elements that follow the header. */
  size: number;
}
/**
* The Thrift protocol read/write contract. All three protocols implement it;
* the logical types are always `TType` codes (each protocol encodes them in its
* own wire form).
*
* A single instance is one-directional: a writer accumulates bytes retrieved
* with `bytes()`, a reader walks an input buffer and reports its `position()`.
* The methods come in structural pairs — `begin`/`end` for messages, structs,
* fields, maps, lists, and sets — that must nest exactly as the value does; the
* scalar methods encode the leaf values. Writing is driven by the value being
* serialized, while reading is driven by the header records this interface
* returns (loop on `readFieldBegin` until `TType.STOP`, then close). Because the
* contract is codec-agnostic, code written against `Protocol` round-trips
* unchanged across binary, compact, and JSON.
*
* Reader methods throw a `ThriftError` on malformed or truncated input; writer
* methods throw when given a value the wire form cannot represent.
*
* ```ts no_run
* import { JSONProtocol, TType, type Protocol } from 'internal:format/thrift';
*
* function roundTrip(make: () => Protocol, read: (p: Protocol) => Uint8Array) {
*   const w = make();
*   w.writeStructBegin();
*   w.writeFieldBegin('id', TType.I64, 1);
*   w.writeI64(9007199254740993n); // exact past 2^53
*   w.writeFieldEnd();
*   w.writeFieldStop();
*   w.writeStructEnd();
*   return read(new JSONProtocol(w.bytes()) as unknown as Protocol);
* }
* ```
*
* @internal
*/
export interface Protocol {
  /** Opens an RPC message envelope with its method name, `TMessageType` kind, and sequence id. */
  writeMessageBegin(name: string, type: number, seqid: number): void;
  /** Closes the envelope opened by `writeMessageBegin`. */
  writeMessageEnd(): void;
  /** Opens a struct; the optional name is informational and not all protocols emit it. */
  writeStructBegin(name?: string): void;
  /** Closes the struct opened by `writeStructBegin`. */
  writeStructEnd(): void;
  /** Opens a field with its `TType` and numeric id; the name is informational. */
  writeFieldBegin(name: string, type: number, id: number): void;
  /** Closes the field opened by `writeFieldBegin`. */
  writeFieldEnd(): void;
  /** Writes the stop sentinel that terminates a struct's field list. */
  writeFieldStop(): void;
  /** Opens a map with its key and value `TType` codes and entry count. */
  writeMapBegin(keyType: number, valueType: number, size: number): void;
  /** Closes the map opened by `writeMapBegin`. */
  writeMapEnd(): void;
  /** Opens a list with its element `TType` and length. */
  writeListBegin(elemType: number, size: number): void;
  /** Closes the list opened by `writeListBegin`. */
  writeListEnd(): void;
  /** Opens a set with its element `TType` and length (same wire shape as a list). */
  writeSetBegin(elemType: number, size: number): void;
  /** Closes the set opened by `writeSetBegin`. */
  writeSetEnd(): void;
  /** Writes a boolean leaf value. */
  writeBool(value: boolean): void;
  /** Writes a signed 8-bit integer (`TType.BYTE`/`I8`). */
  writeByte(value: number): void;
  /** Writes a signed 16-bit integer. */
  writeI16(value: number): void;
  /** Writes a signed 32-bit integer. */
  writeI32(value: number): void;
  /** Writes a signed 64-bit integer; takes a `bigint` so values past 2^53 round-trip exactly. */
  writeI64(value: bigint): void;
  /** Writes an IEEE-754 double. */
  writeDouble(value: number): void;
  /** Writes a UTF-8 string. */
  writeString(value: string): void;
  /** Writes an opaque binary blob (length-prefixed bytes). */
  writeBinary(value: Uint8Array): void;
  /** Reads the message envelope header; throws `ThriftError` if the framing is malformed. */
  readMessageBegin(): MessageHeader;
  /** Consumes the end of the message envelope. */
  readMessageEnd(): void;
  /** Enters a struct, returning its name when the protocol carries one and `null` otherwise. */
  readStructBegin(): string | null;
  /** Consumes the end of the current struct. */
  readStructEnd(): void;
  /** Reads the next field header; a returned `type` of `TType.STOP` marks the end of the struct. */
  readFieldBegin(): FieldHeader;
  /** Consumes the end of the current field. */
  readFieldEnd(): void;
  /** Reads a map header describing the `size` key/value pairs that follow. */
  readMapBegin(): MapHeader;
  /** Consumes the end of the current map. */
  readMapEnd(): void;
  /** Reads a list header describing the `size` elements that follow. */
  readListBegin(): ListHeader;
  /** Consumes the end of the current list. */
  readListEnd(): void;
  /** Reads a set header (same shape as a list header). */
  readSetBegin(): ListHeader;
  /** Consumes the end of the current set. */
  readSetEnd(): void;
  /** Reads a boolean leaf value. */
  readBool(): boolean;
  /** Reads a signed 8-bit integer. */
  readByte(): number;
  /** Reads a signed 16-bit integer. */
  readI16(): number;
  /** Reads a signed 32-bit integer. */
  readI32(): number;
  /** Reads a signed 64-bit integer as a `bigint` so the full range survives. */
  readI64(): bigint;
  /** Reads an IEEE-754 double. */
  readDouble(): number;
  /** Reads a UTF-8 string. */
  readString(): string;
  /** Reads an opaque binary blob. */
  readBinary(): Uint8Array;
  /** Finished output bytes (writer mode only). */
  bytes(): Uint8Array;
  /** Reader cursor position in bytes (reader mode); how much has been consumed. */
  position(): number;
}
/**
* Shared reader/writer plumbing for the concrete protocols.
*
* A base class that carries the one-directional state and the two methods
* (`bytes()`, `position()`) common to every protocol, so `BinaryProtocol`,
* `CompactProtocol`, and `JSONProtocol` only implement the codec-specific
* begin/end and scalar logic. The constructor decides direction from its
* argument: pass an input buffer to build a reader, pass nothing to build a
* writer. Subclasses reach for `this.reader` or `this.writer` accordingly.
*
* Extend this when adding a new Thrift protocol; construct a concrete subclass
* when you just want to serialize.
*
* ```ts no_run
* import { ProtocolBase, type Protocol, TType } from 'internal:format/thrift';
* import { ByteWriter } from 'internal:format/thrift';
*
* // Sketch of a subclass; the real protocols implement every Protocol method.
* class MyProtocol extends ProtocolBase implements Protocol {
*   writeI32(value: number): void {
*     // this.writer is present because the instance was built without input
*     this.writer.writeI32BE(value);
*   }
*   // ...remaining Protocol methods
* }
* ```
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
  /**
  * Builds a reader when given an input buffer, or a writer when given nothing.
  *
  * The direction is fixed for the life of the instance: a reader populates
  * `this.reader` over `input`, a writer populates `this.writer` with a fresh
  * growable buffer. There is no bidirectional mode.
  */
  constructor(input?: Uint8Array) {
    if (input !== undefined) this.reader = new ByteReader(input);
    else this.writer = new ByteWriter();
  }
  /**
  * Returns the accumulated output bytes; valid only in writer mode.
  *
  * Throws if called on a reader-mode instance (one constructed with an input
  * buffer), since there is no writer to drain.
  */
  bytes(): Uint8Array {
    if (this.writer === undefined) throw new Error('thrift: bytes() called on a reader protocol');
    return this.writer.bytes();
  }
  /**
  * Returns how many input bytes the reader has consumed so far, or `0` in
  * writer mode.
  *
  * Useful for framing — after decoding one message you can tell how much of a
  * concatenated buffer remains.
  */
  position(): number {
    return this.reader === undefined ? 0 : this.reader.position;
  }
}
