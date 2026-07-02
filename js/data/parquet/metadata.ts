/**
* Parquet metadata structures, encoded with Thrift's compact protocol.
*
* Mirrors the `parquet.thrift` definitions (FileMetaData, SchemaElement,
* RowGroup, ColumnChunk, ColumnMetaData, PageHeader and its page variants,
* Statistics, LogicalType). Unknown fields are skipped, so forward-compatible
* files still read. Backs `fino:data/parquet`.
*
* @internal
*/
import { CompactProtocol, TType, skip, type Protocol } from 'internal:format/thrift';
import { LogicalTypeId, TimeUnitId } from './types.ts';
// --- interfaces ------------------------------------------------------------
/** @internal */ export interface Statistics {
  max?: Uint8Array;
  min?: Uint8Array;
  nullCount?: bigint;
  distinctCount?: bigint;
  maxValue?: Uint8Array;
  minValue?: Uint8Array;
}
/** @internal */ export interface DecimalType {
  scale: number;
  precision: number;
}
/** @internal */ export interface TimeUnit {
  unit: number;
}
/** @internal */ export interface TimeType {
  isAdjustedToUTC: boolean;
  unit: TimeUnit;
}
/** @internal */ export interface TimestampType {
  isAdjustedToUTC: boolean;
  unit: TimeUnit;
}
/** @internal */ export interface IntType {
  bitWidth: number;
  isSigned: boolean;
}
/** @internal */ export interface LogicalType {
  kind: string;
  decimal?: DecimalType;
  time?: TimeType;
  timestamp?: TimestampType;
  integer?: IntType;
}
/** @internal */ export interface SchemaElement {
  type?: number;
  typeLength?: number;
  repetitionType?: number;
  name: string;
  numChildren?: number;
  convertedType?: number;
  scale?: number;
  precision?: number;
  fieldId?: number;
  logicalType?: LogicalType;
}
/** @internal */ export interface KeyValue {
  key: string;
  value?: string;
}
/** @internal */ export interface ColumnMetaData {
  type: number;
  encodings: number[];
  pathInSchema: string[];
  codec: number;
  numValues: bigint;
  totalUncompressedSize: bigint;
  totalCompressedSize: bigint;
  keyValueMetadata?: KeyValue[];
  dataPageOffset: bigint;
  indexPageOffset?: bigint;
  dictionaryPageOffset?: bigint;
  statistics?: Statistics;
}
/** @internal */ export interface ColumnChunk {
  filePath?: string;
  fileOffset: bigint;
  metaData?: ColumnMetaData;
}
/** @internal */ export interface RowGroup {
  columns: ColumnChunk[];
  totalByteSize: bigint;
  numRows: bigint;
  fileOffset?: bigint;
  totalCompressedSize?: bigint;
  ordinal?: number;
}
/** @internal */ export interface FileMetaData {
  version: number;
  schema: SchemaElement[];
  numRows: bigint;
  rowGroups: RowGroup[];
  keyValueMetadata?: KeyValue[];
  createdBy?: string;
}
/** @internal */ export interface DataPageHeader {
  numValues: number;
  encoding: number;
  definitionLevelEncoding: number;
  repetitionLevelEncoding: number;
  statistics?: Statistics;
}
/** @internal */ export interface DictionaryPageHeader {
  numValues: number;
  encoding: number;
  isSorted?: boolean;
}
/** @internal */ export interface DataPageHeaderV2 {
  numValues: number;
  numNulls: number;
  numRows: number;
  encoding: number;
  definitionLevelsByteLength: number;
  repetitionLevelsByteLength: number;
  isCompressed: boolean;
  statistics?: Statistics;
}
/** @internal */ export interface PageHeader {
  type: number;
  uncompressedPageSize: number;
  compressedPageSize: number;
  crc?: number;
  dataPageHeader?: DataPageHeader;
  dictionaryPageHeader?: DictionaryPageHeader;
  dataPageHeaderV2?: DataPageHeaderV2;
}
// --- read helpers ----------------------------------------------------------
/**
* Iterate a struct's fields, dispatching to `handler`; unhandled fields are
* skipped so unknown/forward-compatible fields don't break decoding.
*
* @internal
*/
function readFields(p: Protocol, handler: (id: number, type: number) => boolean): void {
  p.readStructBegin();
  for (;;) {
    const field = p.readFieldBegin();
    if (field.type === TType.STOP) break;
    if (!handler(field.id, field.type)) skip(p, field.type);
    p.readFieldEnd();
  }
  p.readStructEnd();
}
function readI32List(p: Protocol): number[] {
  const out: number[] = [];
  const header = p.readListBegin();
  for (let i = 0; i < header.size; i++) out.push(p.readI32());
  p.readListEnd();
  return out;
}
function readStringList(p: Protocol): string[] {
  const out: string[] = [];
  const header = p.readListBegin();
  for (let i = 0; i < header.size; i++) out.push(p.readString());
  p.readListEnd();
  return out;
}
function readStructList<T>(p: Protocol, readOne: (p: Protocol) => T): T[] {
  const out: T[] = [];
  const header = p.readListBegin();
  for (let i = 0; i < header.size; i++) out.push(readOne(p));
  p.readListEnd();
  return out;
}
// --- Statistics ------------------------------------------------------------
function readStatistics(p: Protocol): Statistics {
  const s: Statistics = {};
  readFields(p, (id) => {
    switch (id) {
      case 1:
        s.max = p.readBinary();
        return true;
      case 2:
        s.min = p.readBinary();
        return true;
      case 3:
        s.nullCount = p.readI64();
        return true;
      case 4:
        s.distinctCount = p.readI64();
        return true;
      case 5:
        s.maxValue = p.readBinary();
        return true;
      case 6:
        s.minValue = p.readBinary();
        return true;
      default: return false;
    }
  });
  return s;
}
function writeStatistics(p: Protocol, s: Statistics): void {
  p.writeStructBegin();
  if (s.max !== undefined) {
    p.writeFieldBegin('', TType.STRING, 1);
    p.writeBinary(s.max);
    p.writeFieldEnd();
  }
  if (s.min !== undefined) {
    p.writeFieldBegin('', TType.STRING, 2);
    p.writeBinary(s.min);
    p.writeFieldEnd();
  }
  if (s.nullCount !== undefined) {
    p.writeFieldBegin('', TType.I64, 3);
    p.writeI64(s.nullCount);
    p.writeFieldEnd();
  }
  if (s.distinctCount !== undefined) {
    p.writeFieldBegin('', TType.I64, 4);
    p.writeI64(s.distinctCount);
    p.writeFieldEnd();
  }
  if (s.maxValue !== undefined) {
    p.writeFieldBegin('', TType.STRING, 5);
    p.writeBinary(s.maxValue);
    p.writeFieldEnd();
  }
  if (s.minValue !== undefined) {
    p.writeFieldBegin('', TType.STRING, 6);
    p.writeBinary(s.minValue);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- LogicalType (union) ---------------------------------------------------
function readTimeUnit(p: Protocol): TimeUnit {
  let unit = TimeUnitId.MILLIS;
  readFields(p, (id) => {
    if (id === TimeUnitId.MILLIS || id === TimeUnitId.MICROS || id === TimeUnitId.NANOS) {
      unit = id;
      // The variant is an empty struct.
      skip(p, TType.STRUCT);
      return true;
    }
    return false;
  });
  return { unit };
}
function writeTimeUnit(p: Protocol, u: TimeUnit): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.STRUCT, u.unit);
  p.writeStructBegin();
  p.writeFieldStop();
  p.writeStructEnd();
  p.writeFieldEnd();
  p.writeFieldStop();
  p.writeStructEnd();
}
function readLogicalType(p: Protocol): LogicalType {
  const lt: LogicalType = { kind: 'unknown' };
  readFields(p, (id) => {
    switch (id) {
      case LogicalTypeId.STRING:
        lt.kind = 'string';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.MAP:
        lt.kind = 'map';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.LIST:
        lt.kind = 'list';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.ENUM:
        lt.kind = 'enum';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.DECIMAL: {
        lt.kind = 'decimal';
        let scale = 0;
        let precision = 0;
        readFields(p, (fid) => {
          if (fid === 1) {
            scale = p.readI32();
            return true;
          }
          if (fid === 2) {
            precision = p.readI32();
            return true;
          }
          return false;
        });
        lt.decimal = {
          scale,
          precision
        };
        return true;
      }
      case LogicalTypeId.DATE:
        lt.kind = 'date';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.TIME: {
        lt.kind = 'time';
        let isAdjustedToUTC = false;
        let unit: TimeUnit = { unit: TimeUnitId.MILLIS };
        readFields(p, (fid) => {
          if (fid === 1) {
            isAdjustedToUTC = p.readBool();
            return true;
          }
          if (fid === 2) {
            unit = readTimeUnit(p);
            return true;
          }
          return false;
        });
        lt.time = {
          isAdjustedToUTC,
          unit
        };
        return true;
      }
      case LogicalTypeId.TIMESTAMP: {
        lt.kind = 'timestamp';
        let isAdjustedToUTC = false;
        let unit: TimeUnit = { unit: TimeUnitId.MILLIS };
        readFields(p, (fid) => {
          if (fid === 1) {
            isAdjustedToUTC = p.readBool();
            return true;
          }
          if (fid === 2) {
            unit = readTimeUnit(p);
            return true;
          }
          return false;
        });
        lt.timestamp = {
          isAdjustedToUTC,
          unit
        };
        return true;
      }
      case LogicalTypeId.INTEGER: {
        lt.kind = 'integer';
        let bitWidth = 0;
        let isSigned = true;
        readFields(p, (fid) => {
          if (fid === 1) {
            bitWidth = p.readByte();
            return true;
          }
          if (fid === 2) {
            isSigned = p.readBool();
            return true;
          }
          return false;
        });
        lt.integer = {
          bitWidth,
          isSigned
        };
        return true;
      }
      case LogicalTypeId.JSON:
        lt.kind = 'json';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.BSON:
        lt.kind = 'bson';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.UUID:
        lt.kind = 'uuid';
        skip(p, TType.STRUCT);
        return true;
      case LogicalTypeId.FLOAT16:
        lt.kind = 'float16';
        skip(p, TType.STRUCT);
        return true;
      default: return false;
    }
  });
  return lt;
}
function writeEmptyVariant(p: Protocol, id: number): void {
  p.writeFieldBegin('', TType.STRUCT, id);
  p.writeStructBegin();
  p.writeFieldStop();
  p.writeStructEnd();
  p.writeFieldEnd();
}
function writeLogicalType(p: Protocol, lt: LogicalType): void {
  p.writeStructBegin();
  switch (lt.kind) {
    case 'string':
      writeEmptyVariant(p, LogicalTypeId.STRING);
      break;
    case 'map':
      writeEmptyVariant(p, LogicalTypeId.MAP);
      break;
    case 'list':
      writeEmptyVariant(p, LogicalTypeId.LIST);
      break;
    case 'enum':
      writeEmptyVariant(p, LogicalTypeId.ENUM);
      break;
    case 'date':
      writeEmptyVariant(p, LogicalTypeId.DATE);
      break;
    case 'json':
      writeEmptyVariant(p, LogicalTypeId.JSON);
      break;
    case 'bson':
      writeEmptyVariant(p, LogicalTypeId.BSON);
      break;
    case 'uuid':
      writeEmptyVariant(p, LogicalTypeId.UUID);
      break;
    case 'float16':
      writeEmptyVariant(p, LogicalTypeId.FLOAT16);
      break;
    case 'unknown':
      writeEmptyVariant(p, LogicalTypeId.UNKNOWN);
      break;
    case 'decimal':
      p.writeFieldBegin('', TType.STRUCT, LogicalTypeId.DECIMAL);
      p.writeStructBegin();
      p.writeFieldBegin('', TType.I32, 1);
      p.writeI32(lt.decimal!.scale);
      p.writeFieldEnd();
      p.writeFieldBegin('', TType.I32, 2);
      p.writeI32(lt.decimal!.precision);
      p.writeFieldEnd();
      p.writeFieldStop();
      p.writeStructEnd();
      p.writeFieldEnd();
      break;
    case 'time':
      p.writeFieldBegin('', TType.STRUCT, LogicalTypeId.TIME);
      p.writeStructBegin();
      p.writeFieldBegin('', TType.BOOL, 1);
      p.writeBool(lt.time!.isAdjustedToUTC);
      p.writeFieldEnd();
      p.writeFieldBegin('', TType.STRUCT, 2);
      writeTimeUnit(p, lt.time!.unit);
      p.writeFieldEnd();
      p.writeFieldStop();
      p.writeStructEnd();
      p.writeFieldEnd();
      break;
    case 'timestamp':
      p.writeFieldBegin('', TType.STRUCT, LogicalTypeId.TIMESTAMP);
      p.writeStructBegin();
      p.writeFieldBegin('', TType.BOOL, 1);
      p.writeBool(lt.timestamp!.isAdjustedToUTC);
      p.writeFieldEnd();
      p.writeFieldBegin('', TType.STRUCT, 2);
      writeTimeUnit(p, lt.timestamp!.unit);
      p.writeFieldEnd();
      p.writeFieldStop();
      p.writeStructEnd();
      p.writeFieldEnd();
      break;
    case 'integer':
      p.writeFieldBegin('', TType.STRUCT, LogicalTypeId.INTEGER);
      p.writeStructBegin();
      p.writeFieldBegin('', TType.BYTE, 1);
      p.writeByte(lt.integer!.bitWidth);
      p.writeFieldEnd();
      p.writeFieldBegin('', TType.BOOL, 2);
      p.writeBool(lt.integer!.isSigned);
      p.writeFieldEnd();
      p.writeFieldStop();
      p.writeStructEnd();
      p.writeFieldEnd();
      break;
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- SchemaElement ---------------------------------------------------------
function readSchemaElement(p: Protocol): SchemaElement {
  const el: SchemaElement = { name: '' };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        el.type = p.readI32();
        return true;
      case 2:
        el.typeLength = p.readI32();
        return true;
      case 3:
        el.repetitionType = p.readI32();
        return true;
      case 4:
        el.name = p.readString();
        return true;
      case 5:
        el.numChildren = p.readI32();
        return true;
      case 6:
        el.convertedType = p.readI32();
        return true;
      case 7:
        el.scale = p.readI32();
        return true;
      case 8:
        el.precision = p.readI32();
        return true;
      case 9:
        el.fieldId = p.readI32();
        return true;
      case 10:
        el.logicalType = readLogicalType(p);
        return true;
      default: return false;
    }
  });
  return el;
}
function writeSchemaElement(p: Protocol, el: SchemaElement): void {
  p.writeStructBegin();
  if (el.type !== undefined) {
    p.writeFieldBegin('', TType.I32, 1);
    p.writeI32(el.type);
    p.writeFieldEnd();
  }
  if (el.typeLength !== undefined) {
    p.writeFieldBegin('', TType.I32, 2);
    p.writeI32(el.typeLength);
    p.writeFieldEnd();
  }
  if (el.repetitionType !== undefined) {
    p.writeFieldBegin('', TType.I32, 3);
    p.writeI32(el.repetitionType);
    p.writeFieldEnd();
  }
  p.writeFieldBegin('', TType.STRING, 4);
  p.writeString(el.name);
  p.writeFieldEnd();
  if (el.numChildren !== undefined) {
    p.writeFieldBegin('', TType.I32, 5);
    p.writeI32(el.numChildren);
    p.writeFieldEnd();
  }
  if (el.convertedType !== undefined) {
    p.writeFieldBegin('', TType.I32, 6);
    p.writeI32(el.convertedType);
    p.writeFieldEnd();
  }
  if (el.scale !== undefined) {
    p.writeFieldBegin('', TType.I32, 7);
    p.writeI32(el.scale);
    p.writeFieldEnd();
  }
  if (el.precision !== undefined) {
    p.writeFieldBegin('', TType.I32, 8);
    p.writeI32(el.precision);
    p.writeFieldEnd();
  }
  if (el.fieldId !== undefined) {
    p.writeFieldBegin('', TType.I32, 9);
    p.writeI32(el.fieldId);
    p.writeFieldEnd();
  }
  if (el.logicalType !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 10);
    writeLogicalType(p, el.logicalType);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- KeyValue --------------------------------------------------------------
function readKeyValue(p: Protocol): KeyValue {
  const kv: KeyValue = { key: '' };
  readFields(p, (id) => {
    if (id === 1) {
      kv.key = p.readString();
      return true;
    }
    if (id === 2) {
      kv.value = p.readString();
      return true;
    }
    return false;
  });
  return kv;
}
function writeKeyValue(p: Protocol, kv: KeyValue): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.STRING, 1);
  p.writeString(kv.key);
  p.writeFieldEnd();
  if (kv.value !== undefined) {
    p.writeFieldBegin('', TType.STRING, 2);
    p.writeString(kv.value);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- ColumnMetaData --------------------------------------------------------
function readColumnMetaData(p: Protocol): ColumnMetaData {
  const cm: ColumnMetaData = {
    type: 0,
    encodings: [],
    pathInSchema: [],
    codec: 0,
    numValues: 0n,
    totalUncompressedSize: 0n,
    totalCompressedSize: 0n,
    dataPageOffset: 0n
  };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        cm.type = p.readI32();
        return true;
      case 2:
        cm.encodings = readI32List(p);
        return true;
      case 3:
        cm.pathInSchema = readStringList(p);
        return true;
      case 4:
        cm.codec = p.readI32();
        return true;
      case 5:
        cm.numValues = p.readI64();
        return true;
      case 6:
        cm.totalUncompressedSize = p.readI64();
        return true;
      case 7:
        cm.totalCompressedSize = p.readI64();
        return true;
      case 8:
        cm.keyValueMetadata = readStructList(p, readKeyValue);
        return true;
      case 9:
        cm.dataPageOffset = p.readI64();
        return true;
      case 10:
        cm.indexPageOffset = p.readI64();
        return true;
      case 11:
        cm.dictionaryPageOffset = p.readI64();
        return true;
      case 12:
        cm.statistics = readStatistics(p);
        return true;
      default: return false;
    }
  });
  return cm;
}
function writeColumnMetaData(p: Protocol, cm: ColumnMetaData): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.I32, 1);
  p.writeI32(cm.type);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.LIST, 2);
  p.writeListBegin(TType.I32, cm.encodings.length);
  for (const e of cm.encodings) p.writeI32(e);
  p.writeListEnd();
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.LIST, 3);
  p.writeListBegin(TType.STRING, cm.pathInSchema.length);
  for (const s of cm.pathInSchema) p.writeString(s);
  p.writeListEnd();
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 4);
  p.writeI32(cm.codec);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I64, 5);
  p.writeI64(cm.numValues);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I64, 6);
  p.writeI64(cm.totalUncompressedSize);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I64, 7);
  p.writeI64(cm.totalCompressedSize);
  p.writeFieldEnd();
  if (cm.keyValueMetadata !== undefined) {
    p.writeFieldBegin('', TType.LIST, 8);
    p.writeListBegin(TType.STRUCT, cm.keyValueMetadata.length);
    for (const kv of cm.keyValueMetadata) writeKeyValue(p, kv);
    p.writeListEnd();
    p.writeFieldEnd();
  }
  p.writeFieldBegin('', TType.I64, 9);
  p.writeI64(cm.dataPageOffset);
  p.writeFieldEnd();
  if (cm.indexPageOffset !== undefined) {
    p.writeFieldBegin('', TType.I64, 10);
    p.writeI64(cm.indexPageOffset);
    p.writeFieldEnd();
  }
  if (cm.dictionaryPageOffset !== undefined) {
    p.writeFieldBegin('', TType.I64, 11);
    p.writeI64(cm.dictionaryPageOffset);
    p.writeFieldEnd();
  }
  if (cm.statistics !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 12);
    writeStatistics(p, cm.statistics);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- ColumnChunk -----------------------------------------------------------
function readColumnChunk(p: Protocol): ColumnChunk {
  const cc: ColumnChunk = { fileOffset: 0n };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        cc.filePath = p.readString();
        return true;
      case 2:
        cc.fileOffset = p.readI64();
        return true;
      case 3:
        cc.metaData = readColumnMetaData(p);
        return true;
      default: return false;
    }
  });
  return cc;
}
function writeColumnChunk(p: Protocol, cc: ColumnChunk): void {
  p.writeStructBegin();
  if (cc.filePath !== undefined) {
    p.writeFieldBegin('', TType.STRING, 1);
    p.writeString(cc.filePath);
    p.writeFieldEnd();
  }
  p.writeFieldBegin('', TType.I64, 2);
  p.writeI64(cc.fileOffset);
  p.writeFieldEnd();
  if (cc.metaData !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 3);
    writeColumnMetaData(p, cc.metaData);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- RowGroup --------------------------------------------------------------
function readRowGroup(p: Protocol): RowGroup {
  const rg: RowGroup = {
    columns: [],
    totalByteSize: 0n,
    numRows: 0n
  };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        rg.columns = readStructList(p, readColumnChunk);
        return true;
      case 2:
        rg.totalByteSize = p.readI64();
        return true;
      case 3:
        rg.numRows = p.readI64();
        return true;
      case 5:
        rg.fileOffset = p.readI64();
        return true;
      case 6:
        rg.totalCompressedSize = p.readI64();
        return true;
      case 7:
        rg.ordinal = p.readI16();
        return true;
      default: return false;
    }
  });
  return rg;
}
function writeRowGroup(p: Protocol, rg: RowGroup): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.LIST, 1);
  p.writeListBegin(TType.STRUCT, rg.columns.length);
  for (const c of rg.columns) writeColumnChunk(p, c);
  p.writeListEnd();
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I64, 2);
  p.writeI64(rg.totalByteSize);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I64, 3);
  p.writeI64(rg.numRows);
  p.writeFieldEnd();
  if (rg.fileOffset !== undefined) {
    p.writeFieldBegin('', TType.I64, 5);
    p.writeI64(rg.fileOffset);
    p.writeFieldEnd();
  }
  if (rg.totalCompressedSize !== undefined) {
    p.writeFieldBegin('', TType.I64, 6);
    p.writeI64(rg.totalCompressedSize);
    p.writeFieldEnd();
  }
  if (rg.ordinal !== undefined) {
    p.writeFieldBegin('', TType.I16, 7);
    p.writeI16(rg.ordinal);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- FileMetaData ----------------------------------------------------------
function readFileMetaDataStruct(p: Protocol): FileMetaData {
  const fm: FileMetaData = {
    version: 0,
    schema: [],
    numRows: 0n,
    rowGroups: []
  };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        fm.version = p.readI32();
        return true;
      case 2:
        fm.schema = readStructList(p, readSchemaElement);
        return true;
      case 3:
        fm.numRows = p.readI64();
        return true;
      case 4:
        fm.rowGroups = readStructList(p, readRowGroup);
        return true;
      case 5:
        fm.keyValueMetadata = readStructList(p, readKeyValue);
        return true;
      case 6:
        fm.createdBy = p.readString();
        return true;
      default: return false;
    }
  });
  return fm;
}
function writeFileMetaDataStruct(p: Protocol, fm: FileMetaData): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.I32, 1);
  p.writeI32(fm.version);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.LIST, 2);
  p.writeListBegin(TType.STRUCT, fm.schema.length);
  for (const el of fm.schema) writeSchemaElement(p, el);
  p.writeListEnd();
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I64, 3);
  p.writeI64(fm.numRows);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.LIST, 4);
  p.writeListBegin(TType.STRUCT, fm.rowGroups.length);
  for (const rg of fm.rowGroups) writeRowGroup(p, rg);
  p.writeListEnd();
  p.writeFieldEnd();
  if (fm.keyValueMetadata !== undefined) {
    p.writeFieldBegin('', TType.LIST, 5);
    p.writeListBegin(TType.STRUCT, fm.keyValueMetadata.length);
    for (const kv of fm.keyValueMetadata) writeKeyValue(p, kv);
    p.writeListEnd();
    p.writeFieldEnd();
  }
  if (fm.createdBy !== undefined) {
    p.writeFieldBegin('', TType.STRING, 6);
    p.writeString(fm.createdBy);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
// --- PageHeader ------------------------------------------------------------
function readDataPageHeader(p: Protocol): DataPageHeader {
  const h: DataPageHeader = {
    numValues: 0,
    encoding: 0,
    definitionLevelEncoding: 0,
    repetitionLevelEncoding: 0
  };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        h.numValues = p.readI32();
        return true;
      case 2:
        h.encoding = p.readI32();
        return true;
      case 3:
        h.definitionLevelEncoding = p.readI32();
        return true;
      case 4:
        h.repetitionLevelEncoding = p.readI32();
        return true;
      case 5:
        h.statistics = readStatistics(p);
        return true;
      default: return false;
    }
  });
  return h;
}
function writeDataPageHeader(p: Protocol, h: DataPageHeader): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.I32, 1);
  p.writeI32(h.numValues);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 2);
  p.writeI32(h.encoding);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 3);
  p.writeI32(h.definitionLevelEncoding);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 4);
  p.writeI32(h.repetitionLevelEncoding);
  p.writeFieldEnd();
  if (h.statistics !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 5);
    writeStatistics(p, h.statistics);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
function readDictionaryPageHeader(p: Protocol): DictionaryPageHeader {
  const h: DictionaryPageHeader = {
    numValues: 0,
    encoding: 0
  };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        h.numValues = p.readI32();
        return true;
      case 2:
        h.encoding = p.readI32();
        return true;
      case 3:
        h.isSorted = p.readBool();
        return true;
      default: return false;
    }
  });
  return h;
}
function writeDictionaryPageHeader(p: Protocol, h: DictionaryPageHeader): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.I32, 1);
  p.writeI32(h.numValues);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 2);
  p.writeI32(h.encoding);
  p.writeFieldEnd();
  if (h.isSorted !== undefined) {
    p.writeFieldBegin('', TType.BOOL, 3);
    p.writeBool(h.isSorted);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
function readDataPageHeaderV2(p: Protocol): DataPageHeaderV2 {
  const h: DataPageHeaderV2 = {
    numValues: 0,
    numNulls: 0,
    numRows: 0,
    encoding: 0,
    definitionLevelsByteLength: 0,
    repetitionLevelsByteLength: 0,
    isCompressed: true
  };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        h.numValues = p.readI32();
        return true;
      case 2:
        h.numNulls = p.readI32();
        return true;
      case 3:
        h.numRows = p.readI32();
        return true;
      case 4:
        h.encoding = p.readI32();
        return true;
      case 5:
        h.definitionLevelsByteLength = p.readI32();
        return true;
      case 6:
        h.repetitionLevelsByteLength = p.readI32();
        return true;
      case 7:
        h.isCompressed = p.readBool();
        return true;
      case 8:
        h.statistics = readStatistics(p);
        return true;
      default: return false;
    }
  });
  return h;
}
function writeDataPageHeaderV2(p: Protocol, h: DataPageHeaderV2): void {
  p.writeStructBegin();
  p.writeFieldBegin('', TType.I32, 1);
  p.writeI32(h.numValues);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 2);
  p.writeI32(h.numNulls);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 3);
  p.writeI32(h.numRows);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 4);
  p.writeI32(h.encoding);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 5);
  p.writeI32(h.definitionLevelsByteLength);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 6);
  p.writeI32(h.repetitionLevelsByteLength);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.BOOL, 7);
  p.writeBool(h.isCompressed);
  p.writeFieldEnd();
  if (h.statistics !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 8);
    writeStatistics(p, h.statistics);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
}
/** Read a `PageHeader` from a compact-protocol byte stream at `offset`; returns the header and the byte position after it. @internal */
export function readPageHeader(bytes: Uint8Array, offset: number): {
  header: PageHeader;
  end: number;
} {
  const p = new CompactProtocol(bytes.subarray(offset));
  const h: PageHeader = {
    type: 0,
    uncompressedPageSize: 0,
    compressedPageSize: 0
  };
  readFields(p, (id) => {
    switch (id) {
      case 1:
        h.type = p.readI32();
        return true;
      case 2:
        h.uncompressedPageSize = p.readI32();
        return true;
      case 3:
        h.compressedPageSize = p.readI32();
        return true;
      case 4:
        h.crc = p.readI32();
        return true;
      case 5:
        h.dataPageHeader = readDataPageHeader(p);
        return true;
      case 7:
        h.dictionaryPageHeader = readDictionaryPageHeader(p);
        return true;
      case 8:
        h.dataPageHeaderV2 = readDataPageHeaderV2(p);
        return true;
      default: return false;
    }
  });
  return {
    header: h,
    end: offset + p.position()
  };
}
/** Encode a `PageHeader` to compact-protocol bytes. @internal */
export function writePageHeader(h: PageHeader): Uint8Array {
  const p = new CompactProtocol();
  p.writeStructBegin();
  p.writeFieldBegin('', TType.I32, 1);
  p.writeI32(h.type);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 2);
  p.writeI32(h.uncompressedPageSize);
  p.writeFieldEnd();
  p.writeFieldBegin('', TType.I32, 3);
  p.writeI32(h.compressedPageSize);
  p.writeFieldEnd();
  if (h.crc !== undefined) {
    p.writeFieldBegin('', TType.I32, 4);
    p.writeI32(h.crc);
    p.writeFieldEnd();
  }
  if (h.dataPageHeader !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 5);
    writeDataPageHeader(p, h.dataPageHeader);
    p.writeFieldEnd();
  }
  if (h.dictionaryPageHeader !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 7);
    writeDictionaryPageHeader(p, h.dictionaryPageHeader);
    p.writeFieldEnd();
  }
  if (h.dataPageHeaderV2 !== undefined) {
    p.writeFieldBegin('', TType.STRUCT, 8);
    writeDataPageHeaderV2(p, h.dataPageHeaderV2);
    p.writeFieldEnd();
  }
  p.writeFieldStop();
  p.writeStructEnd();
  return p.bytes();
}
/** Decode `FileMetaData` from compact-protocol bytes. @internal */
export function readFileMetaData(bytes: Uint8Array): FileMetaData {
  return readFileMetaDataStruct(new CompactProtocol(bytes));
}
/** Encode `FileMetaData` to compact-protocol bytes. @internal */
export function writeFileMetaData(fm: FileMetaData): Uint8Array {
  const p = new CompactProtocol();
  writeFileMetaDataStruct(p, fm);
  return p.bytes();
}
