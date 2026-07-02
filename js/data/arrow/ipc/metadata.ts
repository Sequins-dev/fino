/**
* Encode and decode Arrow IPC flatbuffer metadata (Schema, Message,
* RecordBatch, DictionaryBatch, Footer) over `fino:format/flatbuffers`.
*
* Field ids below follow Arrow's Schema.fbs, Message.fbs, and File.fbs. Union
* fields occupy two consecutive ids: the u8 type tag then the value offset.
*
* @internal
*/
import { Builder, FlatBuffer, type Table as FbTable } from 'fino:format/flatbuffers';
import { Field, Schema } from '../schema.ts';
import { type DataType, Type, UnionMode, dictionary, int32, nullType, bool, int8, int16, int32 as int32t, int64, uint8, uint16, uint32, uint64, float16, float32, float64, decimal, date32, date64, time32, time64, timestamp, duration, interval, utf8, largeUtf8, binary, largeBinary, utf8View, binaryView, fixedSizeBinary, list, largeList, listView, largeListView, fixedSizeList, struct, map, union, runEndEncoded } from '../type.ts';
import type { IntType } from '../type.ts';
import { ArrowError } from '../errors.ts';
export const METADATA_VERSION_V5 = 4;
/** MessageHeader union tags. */
export const MessageHeader = {
  Schema: 1,
  DictionaryBatch: 2,
  RecordBatch: 3
} as const;
/** Body compression codecs (Message.fbs CompressionType). */
export const CompressionType = {
  LZ4_FRAME: 0,
  ZSTD: 1
} as const;
/** A parsed FieldNode (per-column length and null count). */
export interface FieldNode {
  length: number;
  nullCount: number;
}
/** A parsed Buffer region (offset and length within the message body). */
export interface BufferRegion {
  offset: number;
  length: number;
}
/** A parsed RecordBatch header. */
export interface RecordBatchHeader {
  length: number;
  nodes: FieldNode[];
  buffers: BufferRegion[];
  compression: number | null;
  variadicBufferCounts: number[];
}
/** A parsed Message envelope. */
export interface MessageInfo {
  headerType: number;
  bodyLength: number;
  schema?: Schema;
  recordBatch?: RecordBatchHeader;
  dictionaryBatch?: {
    id: number;
    isDelta: boolean;
    batch: RecordBatchHeader;
  };
}
/** A file footer Block (points at a message + body region). */
export interface Block {
  offset: number;
  metaDataLength: number;
  bodyLength: number;
}
/** A parsed file footer. */
export interface Footer {
  schema: Schema;
  dictionaries: Block[];
  recordBatches: Block[];
}
// ---------------------------------------------------------------------------
// Type encoding
// ---------------------------------------------------------------------------
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
/** Encode a `Schema` as a finished flatbuffer message body. */
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
/** Encode a RecordBatch header table. */
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
/** Encode a complete Message flatbuffer (not size-prefixed). */
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
/** Build a Schema message. */
export function schemaMessage(schema: Schema): Uint8Array {
  return encodeMessage(MessageHeader.Schema, 0, 0, (b) => ({
    header: encodeSchema(b, schema),
    body: 0
  }));
}
/** Build a RecordBatch message. */
export function recordBatchMessage(length: number, nodes: FieldNode[], buffers: BufferRegion[], variadicCounts: number[], compression: number | null, bodyLength: number): Uint8Array {
  return encodeMessage(MessageHeader.RecordBatch, 0, bodyLength, (b) => ({
    header: encodeRecordBatch(b, length, nodes, buffers, variadicCounts, compression),
    body: bodyLength
  }));
}
/** Build a DictionaryBatch message. */
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
/** Decode a Schema flatbuffer table. */
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
/** Decode a Message flatbuffer (already stripped of the IPC envelope). */
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
