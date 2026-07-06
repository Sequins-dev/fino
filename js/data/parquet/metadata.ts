/**
* Parquet metadata structures, encoded with Thrift's compact protocol.
*
* Mirrors the `parquet.thrift` definitions (FileMetaData, SchemaElement,
* RowGroup, ColumnChunk, ColumnMetaData, PageHeader and its page variants,
* Statistics, LogicalType) as plain TypeScript interfaces, with hand-rolled
* decoders and encoders on top of `internal:format/thrift` — no generated
* code. Backs `fino:data/parquet`: the reader decodes the file footer and
* per-page headers from here, the writer encodes them back.
*
* Decoding is forward-compatible: fields with unrecognized ids are skipped
* wholesale, so files written by newer Parquet implementations still read.
* It is also lenient — a field the spec marks `required` that is absent from
* the stream decodes to a zero value (`0`, `0n`, `''`, `[]`) rather than
* throwing; validation is left to callers. Encoding writes optional fields
* only when they are present (`!== undefined`) and always uses field-id
* numbering from `parquet.thrift`, so output round-trips through other
* Parquet readers.
*
* A truncated or malformed buffer surfaces as a `ThriftError` from the
* underlying protocol layer.
*
* ```ts no_run
* import { readFileMetaData, readPageHeader } from 'internal:data/parquet/metadata';
*
* // The footer sits before the trailing `footerLen (u32 LE) + 'PAR1'`.
* const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
* const footerLen = dv.getUint32(file.byteLength - 8, true);
* const meta = readFileMetaData(file.subarray(file.byteLength - 8 - footerLen, file.byteLength - 8));
*
* const chunk = meta.rowGroups[0].columns[0].metaData!;
* const { header, end } = readPageHeader(file, Number(chunk.dataPageOffset));
* const pageBody = file.subarray(end, end + header.compressedPageSize);
* ```
*
* Thrift schema: https://github.com/apache/parquet-format/blob/master/src/main/thrift/parquet.thrift
*
* @internal
*/
import { CompactProtocol, TType, skip, type Protocol } from 'internal:format/thrift';
import { LogicalTypeId, TimeUnitId } from './types.ts';
// --- interfaces ------------------------------------------------------------
/**
* Min/max/null-count statistics for a column chunk or page (`Statistics`).
*
* Bounds are plain-encoded bytes of the column's physical type — decode them
* with knowledge of the column before comparing. Prefer `minValue`/`maxValue`,
* which are ordered by the column's logical type; the unsuffixed `min`/`max`
* are the deprecated originals whose ordering was ambiguous for signed
* comparisons, kept only for files written by older tools.
*
* ```ts no_run
* import { readFileMetaData } from 'internal:data/parquet/metadata';
*
* const meta = readFileMetaData(footerBytes);
* const stats = meta.rowGroups[0].columns[0].metaData?.statistics;
* if (stats?.minValue && stats.maxValue) {
*   // e.g. INT32 column: bounds are 4-byte little-endian values
*   const min = new DataView(stats.minValue.buffer, stats.minValue.byteOffset).getInt32(0, true);
* }
* ```
*
* @internal
*/
export interface Statistics {
  /** Deprecated upper bound (plain-encoded physical value, signed-comparison ordering). */
  max?: Uint8Array;
  /** Deprecated lower bound (plain-encoded physical value, signed-comparison ordering). */
  min?: Uint8Array;
  /** Number of null values in the chunk or page. */
  nullCount?: bigint;
  /** Number of distinct values, when the writer tracked it. */
  distinctCount?: bigint;
  /** Upper bound ordered by the column's logical type; prefer over `max`. */
  maxValue?: Uint8Array;
  /** Lower bound ordered by the column's logical type; prefer over `min`. */
  minValue?: Uint8Array;
}
/**
* Payload of a `decimal` logical type: unscaled integer × 10^-scale.
*
* A stored value `v` represents `v * 10 ** -scale`, with at most `precision`
* significant digits.
*
* ```ts no_run
* import type { DecimalType } from 'internal:data/parquet/metadata';
*
* const money: DecimalType = { precision: 12, scale: 2 }; // e.g. 1234 -> 12.34
* ```
*
* @internal
*/
export interface DecimalType {
  /** Number of digits after the decimal point. */
  scale: number;
  /** Maximum number of significant digits. */
  precision: number;
}
/**
* Time resolution for `time`/`timestamp` logical types.
*
* Thrift models this as a union of empty structs; here it is flattened to the
* variant's field id — a `TimeUnitId` value (`MILLIS`, `MICROS`, or `NANOS`).
*
* ```ts no_run
* import type { TimeUnit } from 'internal:data/parquet/metadata';
* import { TimeUnitId } from 'internal:data/parquet/types';
*
* const micros: TimeUnit = { unit: TimeUnitId.MICROS };
* ```
*
* @internal
*/
export interface TimeUnit {
  /** A `TimeUnitId` value naming the resolution. */
  unit: number;
}
/**
* Payload of a `time` logical type: time of day at a given resolution.
*
* ```ts no_run
* import type { TimeType } from 'internal:data/parquet/metadata';
* import { TimeUnitId } from 'internal:data/parquet/types';
*
* const t: TimeType = { isAdjustedToUTC: true, unit: { unit: TimeUnitId.MILLIS } };
* ```
*
* @internal
*/
export interface TimeType {
  /** True when values are UTC-normalized instants rather than local (wall-clock) times. */
  isAdjustedToUTC: boolean;
  /** Resolution of the stored integers. */
  unit: TimeUnit;
}
/**
* Payload of a `timestamp` logical type: instant or local datetime.
*
* Values are integers counting `unit`s since the Unix epoch when
* `isAdjustedToUTC` is true, or since an unspecified local epoch otherwise.
*
* ```ts no_run
* import type { TimestampType } from 'internal:data/parquet/metadata';
* import { TimeUnitId } from 'internal:data/parquet/types';
*
* const ts: TimestampType = { isAdjustedToUTC: true, unit: { unit: TimeUnitId.MICROS } };
* ```
*
* @internal
*/
export interface TimestampType {
  /** True when values are UTC-normalized instants rather than local (wall-clock) datetimes. */
  isAdjustedToUTC: boolean;
  /** Resolution of the stored integers. */
  unit: TimeUnit;
}
/**
* Payload of an `integer` logical type: exact width and signedness.
*
* Narrows a physical INT32/INT64 to the intended integer kind (e.g. `uint8`
* is `{ bitWidth: 8, isSigned: false }` stored in an INT32 column).
*
* ```ts no_run
* import type { IntType } from 'internal:data/parquet/metadata';
*
* const u16: IntType = { bitWidth: 16, isSigned: false };
* ```
*
* @internal
*/
export interface IntType {
  /** Logical width in bits: 8, 16, 32, or 64. */
  bitWidth: number;
  /** Whether the logical type is signed. */
  isSigned: boolean;
}
/**
* A column's logical type — the `LogicalType` Thrift union, flattened.
*
* Instead of one optional field per variant, the active variant's name is in
* `kind` (`'string'`, `'map'`, `'list'`, `'enum'`, `'decimal'`, `'date'`,
* `'time'`, `'timestamp'`, `'integer'`, `'json'`, `'bson'`, `'uuid'`,
* `'float16'`, or `'unknown'`). Variants that carry parameters put them in
* the matching payload field; the empty-struct variants carry only `kind`.
* Decoding an unrecognized variant yields `kind: 'unknown'`, which also
* round-trips on encode (as the spec's `UNKNOWN` variant).
*
* ```ts no_run
* import type { LogicalType } from 'internal:data/parquet/metadata';
*
* const utf8: LogicalType = { kind: 'string' };
* const price: LogicalType = { kind: 'decimal', decimal: { precision: 10, scale: 2 } };
* ```
*
* @internal
*/
export interface LogicalType {
  /** Name of the active union variant. */
  kind: string;
  /** Parameters when `kind` is `'decimal'`. */
  decimal?: DecimalType;
  /** Parameters when `kind` is `'time'`. */
  time?: TimeType;
  /** Parameters when `kind` is `'timestamp'`. */
  timestamp?: TimestampType;
  /** Parameters when `kind` is `'integer'`. */
  integer?: IntType;
}
/**
* One node of the schema tree (`SchemaElement`).
*
* `FileMetaData.schema` stores the tree as a flat depth-first list: element 0
* is the root, group nodes announce how many direct children follow via
* `numChildren`, and leaves carry a physical `type`. Reassembling the tree
* from this list is `internal:data/parquet/schema`'s job.
*
* ```ts no_run
* import type { SchemaElement } from 'internal:data/parquet/metadata';
* import { PType, Repetition } from 'internal:data/parquet/types';
*
* const leaf: SchemaElement = {
*   name: 'title',
*   type: PType.BYTE_ARRAY,
*   repetitionType: Repetition.OPTIONAL,
*   logicalType: { kind: 'string' },
* };
* ```
*
* @internal
*/
export interface SchemaElement {
  /** Physical type (`PType`); present on leaves, absent on group nodes. */
  type?: number;
  /** Byte width for `FIXED_LEN_BYTE_ARRAY` leaves. */
  typeLength?: number;
  /** `Repetition` value (required/optional/repeated); absent only on the root. */
  repetitionType?: number;
  /** Field name; path segments in `ColumnMetaData.pathInSchema` refer to these. */
  name: string;
  /** Number of direct children; present (and > 0) on group nodes, absent on leaves. */
  numChildren?: number;
  /** Legacy `ConvertedType` annotation, superseded by `logicalType`. */
  convertedType?: number;
  /** Legacy decimal scale (pairs with `convertedType` DECIMAL). */
  scale?: number;
  /** Legacy decimal precision (pairs with `convertedType` DECIMAL). */
  precision?: number;
  /** Original field id from the writer's schema (e.g. protobuf/Thrift field number). */
  fieldId?: number;
  /** Logical type annotation; the modern replacement for `convertedType`. */
  logicalType?: LogicalType;
}
/**
* Application-defined metadata pair (`KeyValue`).
*
* Appears on `FileMetaData.keyValueMetadata` and
* `ColumnMetaData.keyValueMetadata`; this is where conventions like the
* Arrow schema (`ARROW:schema`) live.
*
* ```ts no_run
* import type { KeyValue } from 'internal:data/parquet/metadata';
*
* const kv: KeyValue = { key: 'writer.model.version', value: '1.2' };
* ```
*
* @internal
*/
export interface KeyValue {
  key: string;
  value?: string;
}
/**
* Everything needed to read one column chunk (`ColumnMetaData`).
*
* Locates the chunk's pages in the file (dictionary page first when present,
* then data pages starting at `dataPageOffset`) and describes how to decode
* them: physical type, encodings in play, and compression codec. `numValues`
* counts leaf values including nulls — page reading stops once that many
* values have been consumed.
*
* ```ts no_run
* import { readFileMetaData, readPageHeader } from 'internal:data/parquet/metadata';
*
* const meta = readFileMetaData(footerBytes);
* const cm = meta.rowGroups[0].columns[0].metaData!;
* const start = cm.dictionaryPageOffset ?? cm.dataPageOffset;
* const { header } = readPageHeader(fileBytes, Number(start));
* ```
*
* @internal
*/
export interface ColumnMetaData {
  /** Physical type of the column's values (`PType`). */
  type: number;
  /** All `Encoding` values used by this chunk's pages and levels. */
  encodings: number[];
  /** Path from the schema root to this leaf, as `SchemaElement.name` segments. */
  pathInSchema: string[];
  /** `Compression` codec applied to page bodies. */
  codec: number;
  /** Total leaf values in the chunk, nulls included. */
  numValues: bigint;
  /** Byte size of all pages after decompression. */
  totalUncompressedSize: bigint;
  /** Byte size of all pages as stored. */
  totalCompressedSize: bigint;
  /** Per-column application metadata. */
  keyValueMetadata?: KeyValue[];
  /** Absolute file offset of the first data page. */
  dataPageOffset: bigint;
  /** Absolute file offset of the index page, if one was written. */
  indexPageOffset?: bigint;
  /** Absolute file offset of the dictionary page; absent when not dictionary-encoded. */
  dictionaryPageOffset?: bigint;
  /** Chunk-level min/max/null statistics. */
  statistics?: Statistics;
}
/**
* A column's slice of one row group (`ColumnChunk`).
*
* In practice `metaData` is written inline and `filePath` is absent — the
* chunk lives in the same file. `filePath` exists for the rarely-used
* external-reference layout, which `fino:data/parquet` does not follow.
*
* ```ts no_run
* import type { ColumnChunk } from 'internal:data/parquet/metadata';
*
* const chunk: ColumnChunk = { fileOffset: 4n, metaData: columnMeta };
* ```
*
* @internal
*/
export interface ColumnChunk {
  /** File containing the chunk when stored externally; absent for same-file chunks. */
  filePath?: string;
  /** Absolute offset of the chunk's metadata (or start) in its file. */
  fileOffset: bigint;
  /** The chunk's column metadata; effectively always present in same-file layouts. */
  metaData?: ColumnMetaData;
}
/**
* A horizontal slice of the table (`RowGroup`): one chunk per leaf column.
*
* `columns` is ordered to match the depth-first leaf order of the schema, so
* the i-th chunk belongs to the i-th leaf. All chunks in a group cover the
* same `numRows` rows.
*
* ```ts no_run
* import { readFileMetaData } from 'internal:data/parquet/metadata';
*
* const meta = readFileMetaData(footerBytes);
* for (const rg of meta.rowGroups) {
*   console.log(`${rg.numRows} rows, ${rg.columns.length} leaf columns`);
* }
* ```
*
* @internal
*/
export interface RowGroup {
  /** One chunk per leaf column, in schema depth-first leaf order. */
  columns: ColumnChunk[];
  /** Total uncompressed byte size of the group's data. */
  totalByteSize: bigint;
  /** Row count covered by every chunk in this group. */
  numRows: bigint;
  /** Absolute file offset of the group's first page. */
  fileOffset?: bigint;
  /** Total compressed byte size of the group's data. */
  totalCompressedSize?: bigint;
  /** Zero-based position of this group within the file. */
  ordinal?: number;
}
/**
* The file footer (`FileMetaData`) — the root of all Parquet metadata.
*
* Holds the flattened schema tree, the row-group index into the file's
* column chunks, and file-level key/value metadata. Everything a reader
* needs starts here; see `readFileMetaData` for how to locate and decode it.
*
* ```ts no_run
* import { readFileMetaData } from 'internal:data/parquet/metadata';
*
* const meta = readFileMetaData(footerBytes);
* console.log(meta.createdBy, meta.numRows);
* const names = meta.schema.slice(1).map((el) => el.name);
* ```
*
* @internal
*/
export interface FileMetaData {
  /** Format version written by the producer (this writer emits 2). */
  version: number;
  /** Schema tree flattened depth-first; element 0 is the root group. */
  schema: SchemaElement[];
  /** Total rows across all row groups. */
  numRows: bigint;
  /** Row groups in file order. */
  rowGroups: RowGroup[];
  /** File-level application metadata (e.g. an `ARROW:schema` entry). */
  keyValueMetadata?: KeyValue[];
  /** Writer identification string, e.g. `'fino'`. */
  createdBy?: string;
}
/**
* Header payload for a v1 data page (`DataPageHeader`).
*
* A v1 page body is compressed as a single unit: repetition levels,
* definition levels, then values. The level runs inside are length-prefixed
* RLE/bit-packed hybrids.
*
* ```ts no_run
* import { readPageHeader } from 'internal:data/parquet/metadata';
* import { PageType } from 'internal:data/parquet/types';
*
* const { header } = readPageHeader(fileBytes, pageOffset);
* if (header.type === PageType.DATA_PAGE) {
*   const { numValues, encoding } = header.dataPageHeader!;
* }
* ```
*
* @internal
*/
export interface DataPageHeader {
  /** Leaf values in this page, nulls included. */
  numValues: number;
  /** `Encoding` of the value section. */
  encoding: number;
  /** `Encoding` of the definition-level run (RLE in practice). */
  definitionLevelEncoding: number;
  /** `Encoding` of the repetition-level run (RLE in practice). */
  repetitionLevelEncoding: number;
  /** Page-level min/max/null statistics. */
  statistics?: Statistics;
}
/**
* Header payload for a dictionary page (`DictionaryPageHeader`).
*
* At most one per column chunk, stored before the data pages; its body is
* the PLAIN-encoded dictionary that later `RLE_DICTIONARY`/
* `PLAIN_DICTIONARY` data pages index into.
*
* ```ts no_run
* import { readPageHeader } from 'internal:data/parquet/metadata';
* import { PageType } from 'internal:data/parquet/types';
*
* const { header } = readPageHeader(fileBytes, Number(cm.dictionaryPageOffset!));
* if (header.type === PageType.DICTIONARY_PAGE) {
*   const entries = header.dictionaryPageHeader!.numValues;
* }
* ```
*
* @internal
*/
export interface DictionaryPageHeader {
  /** Number of dictionary entries. */
  numValues: number;
  /** `Encoding` of the dictionary values (PLAIN in practice). */
  encoding: number;
  /** True when entries are stored in ascending order. */
  isSorted?: boolean;
}
/**
* Header payload for a v2 data page (`DataPageHeaderV2`).
*
* Unlike v1, the level runs are stored uncompressed (and without length
* prefixes — their byte lengths live here in the header), so readers can
* reach the levels without decompressing; only the value section is subject
* to the chunk codec, and only when `isCompressed` is true.
*
* ```ts no_run
* import { readPageHeader } from 'internal:data/parquet/metadata';
* import { PageType } from 'internal:data/parquet/types';
*
* const { header, end } = readPageHeader(fileBytes, pageOffset);
* if (header.type === PageType.DATA_PAGE_V2) {
*   const h = header.dataPageHeaderV2!;
*   const valuesStart = end + h.repetitionLevelsByteLength + h.definitionLevelsByteLength;
* }
* ```
*
* @internal
*/
export interface DataPageHeaderV2 {
  /** Leaf values in this page, nulls included. */
  numValues: number;
  /** How many of `numValues` are null. */
  numNulls: number;
  /** Rows covered by this page (differs from `numValues` for nested columns). */
  numRows: number;
  /** `Encoding` of the value section. */
  encoding: number;
  /** Byte length of the uncompressed definition-level run at the start of the body. */
  definitionLevelsByteLength: number;
  /** Byte length of the uncompressed repetition-level run at the start of the body. */
  repetitionLevelsByteLength: number;
  /** Whether the value section is compressed with the chunk codec. */
  isCompressed: boolean;
  /** Page-level min/max/null statistics. */
  statistics?: Statistics;
}
/**
* The common page header (`PageHeader`) preceding every page body.
*
* `type` (a `PageType`) selects which of the per-kind payloads is present:
* `dataPageHeader`, `dictionaryPageHeader`, or `dataPageHeaderV2` (index
* pages carry none of these). The page body — `compressedPageSize` bytes —
* immediately follows the header in the file, which is what makes
* `readPageHeader`'s `end` offset useful for walking a chunk.
*
* ```ts no_run
* import { readPageHeader, type PageHeader } from 'internal:data/parquet/metadata';
*
* let offset = Number(cm.dataPageOffset);
* const { header, end }: { header: PageHeader; end: number } = readPageHeader(fileBytes, offset);
* const body = fileBytes.subarray(end, end + header.compressedPageSize);
* offset = end + header.compressedPageSize; // next page
* ```
*
* @internal
*/
export interface PageHeader {
  /** Page kind (`PageType`); selects which payload field is set. */
  type: number;
  /** Byte size of the page body after decompression. */
  uncompressedPageSize: number;
  /** Byte size of the page body as stored in the file. */
  compressedPageSize: number;
  /** CRC32 of the page body, when the writer computed one. */
  crc?: number;
  /** Payload when `type` is DATA_PAGE. */
  dataPageHeader?: DataPageHeader;
  /** Payload when `type` is DICTIONARY_PAGE. */
  dictionaryPageHeader?: DictionaryPageHeader;
  /** Payload when `type` is DATA_PAGE_V2. */
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
/**
* Decode the `PageHeader` starting at `offset` in `bytes`.
*
* Page headers are variable-length, so `end` — the index of the first byte
* after the header, relative to the start of `bytes` — is returned alongside
* the decoded header. The page body occupies the next
* `header.compressedPageSize` bytes, which makes
* `end + header.compressedPageSize` the offset of the following page.
*
* Throws `ThriftError` if the buffer ends inside the header.
*
* ```ts no_run
* import { readPageHeader } from 'internal:data/parquet/metadata';
*
* let offset = Number(cm.dictionaryPageOffset ?? cm.dataPageOffset);
* let seen = 0;
* while (seen < Number(cm.numValues)) {
*   const { header, end } = readPageHeader(fileBytes, offset);
*   const body = fileBytes.subarray(end, end + header.compressedPageSize);
*   offset = end + header.compressedPageSize;
*   seen += header.dataPageHeader?.numValues ?? header.dataPageHeaderV2?.numValues ?? 0;
* }
* ```
*
* @internal
*/
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
/**
* Encode a `PageHeader` to compact-protocol bytes.
*
* The result goes into the file immediately before the page body it
* describes. Optional fields (`crc` and the per-kind payloads) are written
* only when present; the caller is responsible for setting the payload that
* matches `type`.
*
* ```ts no_run
* import { writePageHeader } from 'internal:data/parquet/metadata';
* import { PageType, Encoding } from 'internal:data/parquet/types';
*
* const header = writePageHeader({
*   type: PageType.DATA_PAGE_V2,
*   uncompressedPageSize: body.byteLength,
*   compressedPageSize: compressedBody.byteLength,
*   dataPageHeaderV2: {
*     numValues, numNulls, numRows,
*     encoding: Encoding.PLAIN,
*     definitionLevelsByteLength: defLevels.byteLength,
*     repetitionLevelsByteLength: 0,
*     isCompressed: true,
*   },
* });
* // file layout: ...header bytes, then compressedBody...
* ```
*
* @internal
*/
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
/**
* Decode a `FileMetaData` footer from compact-protocol bytes.
*
* `bytes` should be the footer slice of a Parquet file: the file ends with
* `footer, footerLen (u32 little-endian), 'PAR1'`, so the footer occupies
* `footerLen` bytes ending 8 bytes before EOF. Decoding starts at byte 0 and
* stops at the struct's STOP marker; unknown fields are skipped and absent
* required fields decode to zero values.
*
* Throws `ThriftError` if the slice is truncated mid-structure.
*
* ```ts no_run
* import { readFileMetaData } from 'internal:data/parquet/metadata';
*
* const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
* const footerLen = dv.getUint32(file.byteLength - 8, true);
* const meta = readFileMetaData(file.subarray(file.byteLength - 8 - footerLen, file.byteLength - 8));
* console.log(meta.numRows, meta.rowGroups.length);
* ```
*
* @internal
*/
export function readFileMetaData(bytes: Uint8Array): FileMetaData {
  return readFileMetaDataStruct(new CompactProtocol(bytes));
}
/**
* Encode a `FileMetaData` footer to compact-protocol bytes.
*
* Produces only the Thrift struct; to finish a Parquet file the caller
* appends the footer's byte length as a little-endian u32 followed by the
* `'PAR1'` magic.
*
* ```ts no_run
* import { writeFileMetaData } from 'internal:data/parquet/metadata';
*
* const footer = writeFileMetaData(meta);
* const len = new Uint8Array(4);
* new DataView(len.buffer).setUint32(0, footer.byteLength, true);
* // file layout: 'PAR1', ...pages..., footer, len, 'PAR1'
* ```
*
* @internal
*/
export function writeFileMetaData(fm: FileMetaData): Uint8Array {
  const p = new CompactProtocol();
  writeFileMetaDataStruct(p, fm);
  return p.bytes();
}
