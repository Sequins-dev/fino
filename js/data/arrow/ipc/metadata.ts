/**
* internal:data/arrow/ipc/metadata — encode and decode the flatbuffer metadata
* of the Arrow IPC format (Schema, Message, RecordBatch, DictionaryBatch) over
* `fino:format/flatbuffers`.
*
* This is the metadata layer shared by the IPC stream/file writer and reader.
* The flatbuffer tables are hand-rolled rather than generated: field ids
* follow Arrow's Schema.fbs, Message.fbs, and File.fbs, and a union field
* occupies two consecutive ids — the u8 type tag, then the value offset. The
* `Block` and `Footer` interfaces describe the file-format footer shapes from
* File.fbs; the footer itself is encoded by the file writer.
*
* Everything here operates on *bare* flatbuffers. The encapsulation that
* surrounds each message on the wire — the `0xFFFFFFFF` continuation marker,
* the little-endian size prefix, and 8-byte padding — is added by the writer
* and must already be stripped before `decodeMessage` is called. Message
* bodies (the actual column buffers) never pass through this module; headers
* only describe them.
*
* Wire-level 64-bit integers (lengths, offsets, dictionary ids) are narrowed
* to JS numbers when decoding, which is exact below 2^53 — far beyond any
* practical batch.
*
* ```ts no_run
* import { schemaMessage, decodeMessage, MessageHeader } from 'internal:data/arrow/ipc/metadata';
* import { Schema, Field, int32, utf8 } from 'fino:data/arrow';
*
* const schema = new Schema([
*   Field.new('id', int32(), false),
*   Field.new('name', utf8()),
* ]);
* const bytes = schemaMessage(schema);       // bare Message flatbuffer
* const info = decodeMessage(bytes);         // round-trip
* info.headerType === MessageHeader.Schema;  // true
* info.schema!.fields[1]!.name;              // 'name'
* ```
*
* Arrow IPC format: https://arrow.apache.org/docs/format/Columnar.html#serialization-and-interprocess-communication
* Flatbuffer definitions: https://github.com/apache/arrow/tree/main/format
*
* @internal
*/
import { Builder, FlatBuffer, type Table as FbTable } from 'fino:format/flatbuffers';
import { Field, Schema } from '../schema.ts';
import { type DataType, Type, UnionMode, dictionary, int32, nullType, bool, int8, int16, int32 as int32t, int64, uint8, uint16, uint32, uint64, float16, float32, float64, decimal, date32, date64, time32, time64, timestamp, duration, interval, utf8, largeUtf8, binary, largeBinary, utf8View, binaryView, fixedSizeBinary, list, largeList, listView, largeListView, fixedSizeList, struct, map, union, runEndEncoded } from '../type.ts';
import type { IntType } from '../type.ts';
import { ArrowError } from '../errors.ts';
/**
* Numeric value of `MetadataVersion.V5` (Message.fbs), the metadata version
* stamped into every message this module encodes. V5 is the stable Arrow
* 1.0+ format; the enum counts from `V1 = 0`, so V5 encodes as `4`.
*/
export const METADATA_VERSION_V5 = 4;
/**
* Tags of the `MessageHeader` union (Message.fbs), identifying which header
* table a `Message` carries. Tag `0` is the union's NONE value; the `Tensor`
* (4) and `SparseTensor` (5) tags are not supported by this implementation,
* so `decodeMessage` leaves such messages with only `headerType` and
* `bodyLength` populated.
*
* ```ts no_run
* import { decodeMessage, MessageHeader } from 'internal:data/arrow/ipc/metadata';
*
* const info = decodeMessage(metadataBytes);
* if (info.headerType === MessageHeader.RecordBatch) {
*   console.log(`batch of ${info.recordBatch!.length} rows`);
* }
* ```
*/
export const MessageHeader = {
  Schema: 1,
  DictionaryBatch: 2,
  RecordBatch: 3
} as const;
/**
* Body-compression codec tags (Message.fbs `CompressionType`), recorded in a
* RecordBatch header's `BodyCompression` table via the `compression`
* argument of the encode functions. This module only records the codec —
* compressing and decompressing the body buffers themselves is done by the
* IPC writer and reader through `fino:compress`.
*/
export const CompressionType = {
  LZ4_FRAME: 0,
  ZSTD: 1
} as const;
/**
* One `FieldNode` struct from a RecordBatch header: the value count and null
* count of a single array. Nodes are listed in depth-first pre-order over the
* schema's fields, each parent immediately followed by its children.
*
* ```ts no_run
* import type { FieldNode } from 'internal:data/arrow/ipc/metadata';
*
* // An array of 100 values, 3 of them null.
* const node: FieldNode = { length: 100, nullCount: 3 };
* ```
*/
export interface FieldNode {
  /** Number of value slots in the array. */
  length: number;
  /** Number of null slots; `0` lets writers omit and readers skip the validity bitmap. */
  nullCount: number;
}
/**
* One `Buffer` struct from a RecordBatch header: the location of a single
* column buffer within the message body that follows the metadata on the
* wire.
*
* ```ts no_run
* import type { BufferRegion } from 'internal:data/arrow/ipc/metadata';
*
* // A validity bitmap at the start of the body, 13 bytes long.
* const region: BufferRegion = { offset: 0, length: 13 };
* ```
*/
export interface BufferRegion {
  /** Byte offset from the start of the message body; the writer aligns each buffer to 8 bytes. */
  offset: number;
  /** Exact byte length of the buffer, excluding any trailing alignment padding. */
  length: number;
}
/**
* A decoded RecordBatch header: everything needed to slice the message body
* back into per-column buffers. Buffers appear in the same depth-first field
* order as `nodes`, expanded per each type's buffer layout (validity,
* offsets, data, ...).
*
* ```ts no_run
* import { decodeMessage, MessageHeader } from 'internal:data/arrow/ipc/metadata';
*
* const info = decodeMessage(metadataBytes);
* if (info.headerType === MessageHeader.RecordBatch) {
*   const { length, nodes, buffers, compression } = info.recordBatch!;
*   // slice the body with `buffers`, rebuild arrays with `nodes`...
* }
* ```
*/
export interface RecordBatchHeader {
  /** Number of rows in the batch. */
  length: number;
  /** Per-array value/null counts, depth-first over the schema's fields. */
  nodes: FieldNode[];
  /** Body buffer locations, in buffer-layout order. */
  buffers: BufferRegion[];
  /** `CompressionType` codec of the body buffers, or `null` when the batch is uncompressed. */
  compression: number | null;
  /** For each view-typed column (`utf8View`/`binaryView`), how many variadic data buffers it owns; empty when the schema has no view columns. */
  variadicBufferCounts: number[];
}
/**
* A decoded Message envelope. `headerType` and `bodyLength` are always
* present; at most one of `schema`, `recordBatch`, or `dictionaryBatch` is
* set, matching `headerType` (none for unrecognized header types, which
* callers can skip using `bodyLength`).
*
* ```ts no_run
* import { decodeMessage, MessageHeader } from 'internal:data/arrow/ipc/metadata';
*
* const info = decodeMessage(metadataBytes);
* switch (info.headerType) {
*   case MessageHeader.Schema:
*     useSchema(info.schema!);
*     break;
*   case MessageHeader.RecordBatch:
*     readBody(info.recordBatch!, body);
*     break;
*   case MessageHeader.DictionaryBatch:
*     loadDictionary(info.dictionaryBatch!);
*     break;
* }
* ```
*/
export interface MessageInfo {
  /** `MessageHeader` tag of the header this message carries. */
  headerType: number;
  /** Byte length of the body that follows the metadata on the wire, excluding trailing padding. */
  bodyLength: number;
  /** The decoded schema, present on Schema messages. */
  schema?: Schema;
  /** The decoded batch header, present on RecordBatch messages. */
  recordBatch?: RecordBatchHeader;
  /** The dictionary id, delta flag, and wrapped batch header, present on DictionaryBatch messages. */
  dictionaryBatch?: {
    id: number;
    isDelta: boolean;
    batch: RecordBatchHeader;
  };
}
/**
* A `Block` struct from the file footer (File.fbs): where one encapsulated
* message lives within an Arrow file, enabling random access to any batch
* without rescanning the stream.
*
* ```ts no_run
* import type { Block } from 'internal:data/arrow/ipc/metadata';
*
* const block: Block = { offset: 392, metaDataLength: 216, bodyLength: 1024 };
* // The message's metadata starts at byte 392 of the file; its body
* // follows at 392 + 216 and runs for 1024 bytes.
* ```
*/
export interface Block {
  /** Absolute byte offset within the file of the message's encapsulation (its continuation marker). */
  offset: number;
  /** Byte length of the metadata section, including the continuation marker, size prefix, and padding. */
  metaDataLength: number;
  /** Byte length of the message body. */
  bodyLength: number;
}
/**
* The shape of an Arrow file footer (File.fbs `Footer`): the schema plus
* block indexes locating every dictionary batch and record batch in the
* file. The streaming format has no footer; the file writer encodes one and
* appends it before the trailing `ARROW1` magic.
*
* ```ts no_run
* import type { Footer } from 'internal:data/arrow/ipc/metadata';
*
* function lastBatch(footer: Footer) {
*   return footer.recordBatches[footer.recordBatches.length - 1];
* }
* ```
*/
export interface Footer {
  /** The file's schema (identical to the stream's leading Schema message). */
  schema: Schema;
  /** Locations of the dictionary-batch messages, in write order. */
  dictionaries: Block[];
  /** Locations of the record-batch messages, in row order. */
  recordBatches: Block[];
}
// ---------------------------------------------------------------------------
// Type encoding
// ---------------------------------------------------------------------------
/**
* Encode a metadata map as a flatbuffer vector of `KeyValue` tables,
* returning the vector's offset — or `0` when the map is `null` or empty, so
* the result can be passed straight to `addFieldOffset` (which omits fields
* whose offset is `0`). Shared by the field and schema encoders.
*
* ```ts no_run
* import { Builder } from 'fino:format/flatbuffers';
* import { encodeKeyValues } from 'internal:data/arrow/ipc/metadata';
*
* const b = new Builder();
* const metaOff = encodeKeyValues(b, new Map([['creator', 'fino']]));
* // ...start a table, then: b.addFieldOffset(slot, metaOff)
* ```
*/
function encodeKeyValues(b: Builder, metadata: Map<string, string> | null): number {
  if (metadata === null || metadata.size === 0) return 0;
  const offsets: number[] = [];
  for (const [key, value] of metadata) {
    const k = b.createString(key);
    const v = b.createString(value);
    b.startTable(2);
    b.addFieldOffset(0, k);
    b.addFieldOffset(1, v);
    offsets.push(b.endTable());
  }
  b.startVector(4, offsets.length, 4);
  for (let i = offsets.length - 1; i >= 0; i--) b.addOffset(offsets[i]!);
  return b.endVector();
}
/** Encode the type-specific table; returns its offset (0 for empty tables). */
function encodeTypeTable(b: Builder, type: DataType): number {
  const t = type.kind === 'dictionary' ? type.valueType : type;
  switch (t.kind) {
    case 'null':
      b.startTable(0);
      return b.endTable();
    case 'bool':
      b.startTable(0);
      return b.endTable();
    case 'int':
      b.startTable(2);
      b.addFieldInt32(0, t.bitWidth, 0);
      b.addFieldBool(1, t.signed, false);
      return b.endTable();
    case 'float':
      b.startTable(1);
      b.addFieldInt16(0, t.precision, 0);
      return b.endTable();
    case 'decimal':
      b.startTable(3);
      b.addFieldInt32(0, t.precision, 0);
      b.addFieldInt32(1, t.scale, 0);
      b.addFieldInt32(2, t.bitWidth, 128);
      return b.endTable();
    case 'date':
      b.startTable(1);
      b.addFieldInt16(0, t.unit, 1);
      return b.endTable();
    case 'time':
      b.startTable(2);
      b.addFieldInt16(0, t.unit, 1);
      b.addFieldInt32(1, t.bitWidth, 32);
      return b.endTable();
    case 'timestamp': {
      const tz = t.timezone !== null ? b.createString(t.timezone) : 0;
      b.startTable(2);
      b.addFieldInt16(0, t.unit, 0);
      b.addFieldOffset(1, tz);
      return b.endTable();
    }
    case 'interval':
      b.startTable(1);
      b.addFieldInt16(0, t.unit, 0);
      return b.endTable();
    case 'duration':
      b.startTable(1);
      b.addFieldInt16(0, t.unit, 1);
      return b.endTable();
    case 'utf8':
    case 'largeutf8':
    case 'binary':
    case 'largebinary':
    case 'utf8view':
    case 'binaryview':
    case 'list':
    case 'largelist':
    case 'listview':
    case 'largelistview':
    case 'struct':
    case 'runendencoded':
      b.startTable(0);
      return b.endTable();
    case 'fixedsizebinary':
      b.startTable(1);
      b.addFieldInt32(0, t.byteWidth, 0);
      return b.endTable();
    case 'fixedsizelist':
      b.startTable(1);
      b.addFieldInt32(0, t.listSize, 0);
      return b.endTable();
    case 'map':
      b.startTable(1);
      b.addFieldBool(0, t.keysSorted, false);
      return b.endTable();
    case 'union': {
      const typeIdsVec = (() => {
        b.startVector(4, t.typeIds.length, 4);
        for (let i = t.typeIds.length - 1; i >= 0; i--) b.addInt32(t.typeIds[i]!);
        return b.endVector();
      })();
      b.startTable(2);
      b.addFieldInt16(0, t.mode, 0);
      b.addFieldOffset(1, typeIdsVec);
      return b.endTable();
    }
    default: throw new ArrowError(`cannot encode Arrow type ${type.kind}`);
  }
}
function encodeDictionaryEncoding(b: Builder, type: DataType): number {
  if (type.kind !== 'dictionary') return 0;
  const indexType = encodeTypeTable(b, type.indexType);
  b.startTable(4);
  b.addFieldInt64(0, BigInt(type.id), 0n);
  b.addFieldOffset(1, indexType);
  b.addFieldBool(2, type.isOrdered, false);
  return b.endTable();
}
function encodeField(b: Builder, field: Field): number {
  const childFieldsList = childFieldsOf(field.type);
  const childOffsets = childFieldsList.map((f) => encodeField(b, f));
  const nameOff = b.createString(field.name);
  const typeOff = encodeTypeTable(b, field.type);
  const dictOff = encodeDictionaryEncoding(b, field.type);
  const metaOff = encodeKeyValues(b, field.metadata);
  let childrenVec = 0;
  if (childOffsets.length > 0) {
    b.startVector(4, childOffsets.length, 4);
    for (let i = childOffsets.length - 1; i >= 0; i--) b.addOffset(childOffsets[i]!);
    childrenVec = b.endVector();
  }
  b.startTable(7);
  b.addFieldOffset(0, nameOff);
  b.addFieldBool(1, field.nullable, false);
  b.addFieldInt8(2, unionTypeTag(field.type), 0);
  b.addFieldOffset(3, typeOff);
  b.addFieldOffset(4, dictOff);
  b.addFieldOffset(5, childrenVec);
  b.addFieldOffset(6, metaOff);
  return b.endTable();
}
function childFieldsOf(type: DataType): Field[] {
  switch (type.kind) {
    case 'list':
    case 'largelist':
    case 'listview':
    case 'largelistview':
    case 'fixedsizelist':
    case 'map': return [type.child];
    case 'struct':
    case 'union': return type.children;
    case 'runendencoded': return [type.runEnds, type.values];
    default: return [];
  }
}
function unionTypeTag(type: DataType): number {
  return type.kind === 'dictionary' ? type.valueType.typeId : type.typeId;
}
/**
* Encode a `Schema` as a Schema flatbuffer table on `b`, returning the table
* offset.
*
* Fields are encoded recursively — nested children, dictionary encodings,
* and per-field metadata included — and the endianness field is written as
* little-endian. `schemaMessage` finishes the returned offset into a
* standalone message; the file writer embeds the same table inside the
* footer.
*
* Throws `ArrowError` if a field's type has no IPC encoding.
*
* ```ts no_run
* import { Builder } from 'fino:format/flatbuffers';
* import { encodeSchema } from 'internal:data/arrow/ipc/metadata';
* import { Schema, Field, float64 } from 'fino:data/arrow';
*
* const b = new Builder();
* const off = encodeSchema(b, new Schema([Field.new('x', float64())]));
* b.finish(off);
* const bytes = b.bytes(); // a bare Schema table, not a Message
* ```
*/
export function encodeSchema(b: Builder, schema: Schema): number {
  const fieldOffsets = schema.fields.map((f) => encodeField(b, f));
  b.startVector(4, fieldOffsets.length, 4);
  for (let i = fieldOffsets.length - 1; i >= 0; i--) b.addOffset(fieldOffsets[i]!);
  const fieldsVec = b.endVector();
  const metaOff = encodeKeyValues(b, schema.metadata);
  b.startTable(4);
  b.addFieldInt16(0, 0, 0);
  b.addFieldOffset(1, fieldsVec);
  b.addFieldOffset(2, metaOff);
  return b.endTable();
}
// ---------------------------------------------------------------------------
// Message / RecordBatch encoding
// ---------------------------------------------------------------------------
/**
* Encode a RecordBatch header table on `b`, returning the table offset.
*
* `nodes` and `buffers` are written as vectors of inline 16-byte structs
* (two i64s each). `variadicCounts` becomes an i64 vector only when
* non-empty, and a non-null `compression` codec produces a `BodyCompression`
* table (the method is always BUFFER). The header only *describes* a body —
* the caller lays out the body bytes separately and must keep the buffer
* regions consistent with that layout.
*
* Prefer `recordBatchMessage` unless the header table needs to be embedded
* in another table, as `dictionaryBatchMessage` does.
*
* ```ts no_run
* import { Builder } from 'fino:format/flatbuffers';
* import { encodeRecordBatch } from 'internal:data/arrow/ipc/metadata';
*
* const b = new Builder();
* const off = encodeRecordBatch(
*   b,
*   100,                             // rows
*   [{ length: 100, nullCount: 0 }], // one leaf column, no nulls
*   [{ offset: 0, length: 0 }, { offset: 0, length: 400 }],
*   [],                              // no view columns
*   null,                            // uncompressed
* );
* ```
*/
export function encodeRecordBatch(b: Builder, length: number, nodes: FieldNode[], buffers: BufferRegion[], variadicCounts: number[], compression: number | null): number {
  // nodes: struct FieldNode { long length; long null_count; } (16 bytes)
  b.startVector(16, nodes.length, 8);
  for (let i = nodes.length - 1; i >= 0; i--) {
    b.prep(8, 16);
    b.writeInt64(BigInt(nodes[i]!.nullCount));
    b.writeInt64(BigInt(nodes[i]!.length));
  }
  const nodesVec = b.endVector();
  // buffers: struct Buffer { long offset; long length; } (16 bytes)
  b.startVector(16, buffers.length, 8);
  for (let i = buffers.length - 1; i >= 0; i--) {
    b.prep(8, 16);
    b.writeInt64(BigInt(buffers[i]!.length));
    b.writeInt64(BigInt(buffers[i]!.offset));
  }
  const buffersVec = b.endVector();
  let variadicVec = 0;
  if (variadicCounts.length > 0) {
    b.startVector(8, variadicCounts.length, 8);
    for (let i = variadicCounts.length - 1; i >= 0; i--) b.addInt64(BigInt(variadicCounts[i]!));
    variadicVec = b.endVector();
  }
  let compressionOff = 0;
  if (compression !== null) {
    b.startTable(2);
    b.addFieldInt8(0, compression, 0);
    b.addFieldInt8(1, 0, 0);
    compressionOff = b.endTable();
  }
  b.startTable(5);
  b.addFieldInt64(0, BigInt(length), 0n);
  b.addFieldOffset(1, nodesVec);
  b.addFieldOffset(2, buffersVec);
  b.addFieldOffset(3, compressionOff);
  b.addFieldOffset(4, variadicVec);
  return b.endTable();
}
/**
* Encode a complete Message flatbuffer and return its finished bytes.
*
* A fresh `Builder` is created and handed to `build`, which encodes the
* header table and returns its offset together with the body length to
* record. The `headerOffset` and `bodyLength` positional arguments are
* ignored — both values come from `build`'s return. The result is a bare
* flatbuffer: the on-wire encapsulation (continuation marker, size prefix,
* 8-byte padding) and the body bytes themselves are the caller's
* responsibility.
*
* `schemaMessage`, `recordBatchMessage`, and `dictionaryBatchMessage` wrap
* this for the three supported header types.
*
* ```ts no_run
* import { encodeMessage, encodeSchema, MessageHeader } from 'internal:data/arrow/ipc/metadata';
*
* const bytes = encodeMessage(MessageHeader.Schema, 0, 0, (b) => ({
*   header: encodeSchema(b, schema),
*   body: 0,
* }));
* ```
*/
export function encodeMessage(headerType: number, headerOffset: number, bodyLength: number, build: (b: Builder) => {
  header: number;
  body: number;
}): Uint8Array {
  const b = new Builder();
  const built = build(b);
  b.startTable(5);
  b.addFieldInt16(0, METADATA_VERSION_V5, 0);
  b.addFieldInt8(1, headerType, 0);
  b.addFieldOffset(2, built.header);
  b.addFieldInt64(3, BigInt(built.body), 0n);
  const msg = b.endTable();
  b.finish(msg);
  void headerOffset;
  return b.bytes();
}
/**
* Build a finished Schema message. Schema messages carry no body, so the
* recorded body length is `0`. Every IPC stream begins with one, and the
* record batches that follow must match it.
*
* ```ts no_run
* import { schemaMessage } from 'internal:data/arrow/ipc/metadata';
* import { Schema, Field, utf8 } from 'fino:data/arrow';
*
* const bytes = schemaMessage(new Schema([Field.new('name', utf8())]));
* ```
*/
export function schemaMessage(schema: Schema): Uint8Array {
  return encodeMessage(MessageHeader.Schema, 0, 0, (b) => ({
    header: encodeSchema(b, schema),
    body: 0
  }));
}
/**
* Build a finished RecordBatch message header for a body that has already
* been laid out: `nodes`, `buffers`, and `variadicCounts` must describe that
* body, and `bodyLength` is its byte length as laid out (buffers 8-byte
* aligned internally; trailing wire padding excluded). Only the metadata
* bytes are produced — the body is transmitted separately, after the
* encapsulated metadata.
*
* ```ts no_run
* import { recordBatchMessage } from 'internal:data/arrow/ipc/metadata';
*
* const meta = recordBatchMessage(
*   100,                             // rows
*   [{ length: 100, nullCount: 0 }], // one leaf column, no nulls
*   [{ offset: 0, length: 0 }, { offset: 0, length: 400 }],
*   [],                              // no view columns
*   null,                            // uncompressed
*   400,                             // body byte length
* );
* ```
*/
export function recordBatchMessage(length: number, nodes: FieldNode[], buffers: BufferRegion[], variadicCounts: number[], compression: number | null, bodyLength: number): Uint8Array {
  return encodeMessage(MessageHeader.RecordBatch, 0, bodyLength, (b) => ({
    header: encodeRecordBatch(b, length, nodes, buffers, variadicCounts, compression),
    body: bodyLength
  }));
}
/**
* Build a finished DictionaryBatch message: a RecordBatch header wrapped in
* a DictionaryBatch table carrying the dictionary `id` and the `isDelta`
* flag. The wrapped batch holds the dictionary's *values* as a single
* column; every dictionary-encoded field declaring `id` shares those values.
* Dictionary batches must precede the record batches that reference them on
* the stream. `isDelta` marks a batch that appends to an earlier dictionary
* rather than replacing it — this runtime's IPC reader rejects delta
* batches.
*
* ```ts no_run
* import { dictionaryBatchMessage } from 'internal:data/arrow/ipc/metadata';
*
* // Dictionary 0: three utf8 values in a 64-byte body
* // (validity, offsets, data buffers).
* const meta = dictionaryBatchMessage(
*   0, false, 3,
*   [{ length: 3, nullCount: 0 }],
*   [{ offset: 0, length: 0 }, { offset: 0, length: 16 }, { offset: 16, length: 44 }],
*   [], null, 64,
* );
* ```
*/
export function dictionaryBatchMessage(id: number, isDelta: boolean, length: number, nodes: FieldNode[], buffers: BufferRegion[], variadicCounts: number[], compression: number | null, bodyLength: number): Uint8Array {
  return encodeMessage(MessageHeader.DictionaryBatch, 0, bodyLength, (b) => {
    const rb = encodeRecordBatch(b, length, nodes, buffers, variadicCounts, compression);
    b.startTable(3);
    b.addFieldInt64(0, BigInt(id), 0n);
    b.addFieldOffset(1, rb);
    b.addFieldBool(2, isDelta, false);
    return {
      header: b.endTable(),
      body: bodyLength
    };
  });
}
// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------
function decodeKeyValues(vec: ReturnType<FbTable['vector']>): Map<string, string> | null {
  if (vec === null || vec.length === 0) return null;
  const out = new Map<string, string>();
  for (let i = 0; i < vec.length; i++) {
    const kv = vec.table(i);
    out.set(kv.string(0) ?? '', kv.string(1) ?? '');
  }
  return out;
}
function decodeBaseType(typeTag: number, table: FbTable | null, children: Field[]): DataType {
  switch (typeTag) {
    case Type.Null: return nullType();
    case Type.Bool: return bool();
    case Type.Int: {
      const bitWidth = table!.i32(0, 0);
      const signed = table!.bool(1, false);
      return intOf(bitWidth, signed);
    }
    case Type.Float: {
      const p = table!.i16(0, 0);
      return p === 0 ? float16() : p === 1 ? float32() : float64();
    }
    case Type.Decimal: return decimal(table!.i32(0, 0), table!.i32(1, 0), table!.i32(2, 128) as 32 | 64 | 128 | 256);
    case Type.Date: return table!.i16(0, 1) === 0 ? date32() : date64();
    case Type.Time: return table!.i32(1, 32) === 32 ? time32(table!.i16(0, 1)) : time64(table!.i16(0, 1));
    case Type.Timestamp: return timestamp(table!.i16(0, 0), table!.string(1));
    case Type.Interval: return interval(table!.i16(0, 0));
    case Type.Duration: return duration(table!.i16(0, 1));
    case Type.Utf8: return utf8();
    case Type.LargeUtf8: return largeUtf8();
    case Type.Binary: return binary();
    case Type.LargeBinary: return largeBinary();
    case Type.Utf8View: return utf8View();
    case Type.BinaryView: return binaryView();
    case Type.FixedSizeBinary: return fixedSizeBinary(table!.i32(0, 0));
    case Type.List: return list(children[0]!);
    case Type.LargeList: return largeList(children[0]!);
    case Type.ListView: return listView(children[0]!);
    case Type.LargeListView: return largeListView(children[0]!);
    case Type.FixedSizeList: return fixedSizeList(table!.i32(0, 0), children[0]!);
    case Type.Struct: return struct(children);
    case Type.Map: return map(children[0]!, table!.bool(0, false));
    case Type.Union: {
      const mode = table!.i16(0, 0);
      const idsVec = table!.vector(1);
      const ids: number[] = [];
      if (idsVec) for (let i = 0; i < idsVec.length; i++) ids.push(idsVec.i32(i));
      else for (let i = 0; i < children.length; i++) ids.push(i);
      return union(mode, ids, children);
    }
    case Type.RunEndEncoded: return runEndEncoded(children[0]!, children[1]!);
    default: throw new ArrowError(`unsupported Arrow type tag ${typeTag}`);
  }
}
function intOf(bitWidth: number, signed: boolean): IntType {
  if (signed) return bitWidth === 8 ? int8() : bitWidth === 16 ? int16() : bitWidth === 32 ? int32t() : int64();
  return bitWidth === 8 ? uint8() : bitWidth === 16 ? uint16() : bitWidth === 32 ? uint32() : uint64();
}
function decodeField(table: FbTable): Field {
  const name = table.string(0) ?? '';
  const nullable = table.bool(1, false);
  const typeTag = table.u8(2, 0);
  const typeTable = table.table(3);
  const dictTable = table.table(4);
  const childrenVec = table.vector(5);
  const children: Field[] = [];
  if (childrenVec) for (let i = 0; i < childrenVec.length; i++) children.push(decodeField(childrenVec.table(i)));
  const metadata = decodeKeyValues(table.vector(6));
  let type = decodeBaseType(typeTag, typeTable, children);
  if (dictTable !== null) {
    const id = Number(dictTable.i64(0, 0n));
    const indexTable = dictTable.table(1);
    const indexType = indexTable ? decodeBaseType(Type.Int, indexTable, []) as IntType : int32();
    const isOrdered = dictTable.bool(2, false);
    type = dictionary(id, indexType, type, isOrdered);
  }
  return new Field(name, type, nullable, metadata);
}
/**
* Decode a Schema flatbuffer table into a `Schema`.
*
* Rebuilds fields recursively, including nested children, per-field and
* schema-level metadata, and dictionary encodings (a dictionary encoding
* with no explicit index type defaults to `int32`). `decodeMessage` calls
* this for Schema messages; it is exported separately because the file
* footer embeds the same table.
*
* Throws `ArrowError` on a type tag this implementation does not recognize.
*
* ```ts no_run
* import { FlatBuffer } from 'fino:format/flatbuffers';
* import { decodeSchema } from 'internal:data/arrow/ipc/metadata';
*
* // In File.fbs the footer's schema sits at field 1.
* const footerTable = FlatBuffer.from(footerBytes).rootTable();
* const schema = decodeSchema(footerTable.table(1)!);
* ```
*/
export function decodeSchema(table: FbTable): Schema {
  const fieldsVec = table.vector(1);
  const fields: Field[] = [];
  if (fieldsVec) for (let i = 0; i < fieldsVec.length; i++) fields.push(decodeField(fieldsVec.table(i)));
  return new Schema(fields, decodeKeyValues(table.vector(2)));
}
function decodeRecordBatchTable(rb: FbTable): RecordBatchHeader {
  const length = Number(rb.i64(0, 0n));
  const nodesVec = rb.vector(1);
  const nodes: FieldNode[] = [];
  if (nodesVec) {
    for (let i = 0; i < nodesVec.length; i++) {
      const pos = nodesVec.structAt(i, 16);
      nodes.push({
        length: Number(nodesVec.buffer.i64At(pos)),
        nullCount: Number(nodesVec.buffer.i64At(pos + 8))
      });
    }
  }
  const buffersVec = rb.vector(2);
  const buffers: BufferRegion[] = [];
  if (buffersVec) {
    for (let i = 0; i < buffersVec.length; i++) {
      const pos = buffersVec.structAt(i, 16);
      buffers.push({
        offset: Number(buffersVec.buffer.i64At(pos)),
        length: Number(buffersVec.buffer.i64At(pos + 8))
      });
    }
  }
  const compressionTable = rb.table(3);
  const compression = compressionTable ? compressionTable.i8(0, 0) : null;
  const variadicVec = rb.vector(4);
  const variadicBufferCounts: number[] = [];
  if (variadicVec) for (let i = 0; i < variadicVec.length; i++) variadicBufferCounts.push(Number(variadicVec.i64(i)));
  return {
    length,
    nodes,
    buffers,
    compression,
    variadicBufferCounts
  };
}
/**
* Decode a Message flatbuffer into a `MessageInfo`.
*
* `bytes` must be the metadata flatbuffer alone: the IPC encapsulation
* (continuation marker and size prefix) already stripped, and the body not
* included. The header matching the message's type tag is decoded into
* `schema`, `recordBatch`, or `dictionaryBatch`; a message with an
* unrecognized header type (e.g. Tensor) decodes to just `headerType` and
* `bodyLength`, letting callers skip its body.
*
* Throws `ArrowError` if a Schema header contains an unsupported type tag.
*
* ```ts no_run
* import { decodeMessage } from 'internal:data/arrow/ipc/metadata';
*
* // `chunk` points at one encapsulated message on the wire:
* // [0xFFFFFFFF][i32 metaLen][metadata...][body...]
* const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
* const metaLen = dv.getInt32(4, true);
* const info = decodeMessage(chunk.subarray(8, 8 + metaLen));
* const body = chunk.subarray(8 + metaLen, 8 + metaLen + info.bodyLength);
* ```
*/
export function decodeMessage(bytes: Uint8Array): MessageInfo {
  const fb = FlatBuffer.from(bytes);
  const msg = fb.rootTable();
  const headerType = msg.u8(1, 0);
  const bodyLength = Number(msg.i64(3, 0n));
  const header = msg.table(2);
  const info: MessageInfo = {
    headerType,
    bodyLength
  };
  if (headerType === MessageHeader.Schema && header) {
    info.schema = decodeSchema(header);
  } else if (headerType === MessageHeader.RecordBatch && header) {
    info.recordBatch = decodeRecordBatchTable(header);
  } else if (headerType === MessageHeader.DictionaryBatch && header) {
    const id = Number(header.i64(0, 0n));
    const rb = header.table(1)!;
    const isDelta = header.bool(2, false);
    info.dictionaryBatch = {
      id,
      isDelta,
      batch: decodeRecordBatchTable(rb)
    };
  }
  return info;
}
export { encodeKeyValues };
