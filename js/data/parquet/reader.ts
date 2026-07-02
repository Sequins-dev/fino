/**
* Parquet reader: Parquet file bytes → Arrow.
*
* Reads flat columns from DATA_PAGE (v1) pages, PLAIN or dictionary-encoded
* (RLE_DICTIONARY / PLAIN_DICTIONARY, which real files use by default), with
* definition levels for nulls and page compression. Row groups are concatenated
* into one Arrow `Table`.
*
* @internal
*/
import { RecordBatch, Table, vectorFromArray } from 'fino:data/arrow';
import { ByteReader } from 'internal:format/thrift';
import { Encoding, PageType, ParquetError } from './types.ts';
import { parquetSchemaToArrow, type ColumnDescriptor } from './schema.ts';
import { readFileMetaData, readPageHeader, type ColumnMetaData } from './metadata.ts';
import { decodePlain, decodeDictionaryIndices } from './encoding.ts';
import { decodeRleHybrid, bitWidthForMax } from './levels.ts';
import { decompressPage } from './compression.ts';
const MAGIC = [
  80,
  65,
  82,
  49
];
const _decoder = new TextDecoder();
function checkMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) throw new ParquetError('not a Parquet file (too short)');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i] || bytes[bytes.byteLength - 4 + i] !== MAGIC[i]) {
      throw new ParquetError('not a Parquet file (missing PAR1 magic)');
    }
  }
}
/** Decode a Parquet file into an Arrow `Table`. */
export function readParquet(input: Uint8Array | ArrayBuffer): Table {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  checkMagic(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLen = dv.getUint32(bytes.byteLength - 8, true);
  const footerStart = bytes.byteLength - 8 - footerLen;
  if (footerStart < 4) throw new ParquetError('corrupt Parquet footer length');
  const meta = readFileMetaData(bytes.subarray(footerStart, bytes.byteLength - 8));
  const { schema, columns } = parquetSchemaToArrow(meta.schema);
  const batches: RecordBatch[] = [];
  for (const rowGroup of meta.rowGroups) {
    if (rowGroup.columns.length !== columns.length) {
      throw new ParquetError(`row group has ${rowGroup.columns.length} columns, schema has ${columns.length}`);
    }
    const columnVectors = columns.map((descriptor, c) => {
      const chunk = rowGroup.columns[c]!;
      if (chunk.metaData === undefined) throw new ParquetError(`column chunk ${c} has no metadata`);
      const rows = readColumnChunk(bytes, descriptor, chunk.metaData);
      return vectorFromArray(rows, descriptor.arrowField.type);
    });
    batches.push(new RecordBatch(schema, columnVectors));
  }
  if (batches.length === 0) {
    return new Table(schema, [new RecordBatch(schema, columns.map((d) => vectorFromArray([], d.arrowField.type)))]);
  }
  return new Table(schema, batches);
}
function readColumnChunk(bytes: Uint8Array, descriptor: ColumnDescriptor, meta: ColumnMetaData): unknown[] {
  const totalRows = Number(meta.numValues);
  const start = meta.dictionaryPageOffset !== undefined ? Number(meta.dictionaryPageOffset) : Number(meta.dataPageOffset);
  const utf8 = descriptor.arrowField.type.kind === 'utf8';
  let dictionary: unknown[] | null = null;
  const rows: unknown[] = [];
  let offset = start;
  while (rows.length < totalRows) {
    const { header, end } = readPageHeader(bytes, offset);
    const pageData = bytes.subarray(end, end + header.compressedPageSize);
    const uncompressed = decompressPage(meta.codec, pageData);
    offset = end + header.compressedPageSize;
    if (header.type === PageType.DICTIONARY_PAGE) {
      const dh = header.dictionaryPageHeader!;
      dictionary = finalize(decodePlain(descriptor.physicalType, uncompressed, dh.numValues, descriptor.typeLength), utf8);
      continue;
    }
    if (header.type !== PageType.DATA_PAGE) {
      // DATA_PAGE_V2 and index pages are handled in a later phase.
      throw new ParquetError(`page type ${header.type} is not supported in this milestone`);
    }
    const dph = header.dataPageHeader!;
    const numValues = dph.numValues;
    const reader = new ByteReader(uncompressed);
    // Definition levels (flat column: repetition levels are absent).
    let defLevels: number[] | null = null;
    if (descriptor.maxDefinitionLevel > 0) {
      reader.readBytes(4);
      defLevels = decodeRleHybrid(reader, bitWidthForMax(descriptor.maxDefinitionLevel), numValues);
    }
    const valueBytes = reader.readBytes(reader.remaining);
    const nonNull = defLevels === null ? numValues : defLevels.reduce((n, l) => n + (l === descriptor.maxDefinitionLevel ? 1 : 0), 0);
    let pageValues: unknown[];
    if (dph.encoding === Encoding.PLAIN) {
      pageValues = finalize(decodePlain(descriptor.physicalType, valueBytes, nonNull, descriptor.typeLength), utf8);
    } else if (dph.encoding === Encoding.RLE_DICTIONARY || dph.encoding === Encoding.PLAIN_DICTIONARY) {
      if (dictionary === null) throw new ParquetError('dictionary-encoded page before its dictionary page');
      const indices = decodeDictionaryIndices(valueBytes, nonNull);
      pageValues = indices.map((idx) => dictionary![idx]);
    } else {
      throw new ParquetError(`data page encoding ${dph.encoding} is not supported in this milestone`);
    }
    if (defLevels === null) {
      for (const v of pageValues) rows.push(v);
    } else {
      let vi = 0;
      for (let i = 0; i < numValues; i++) {
        rows.push(defLevels[i] === descriptor.maxDefinitionLevel ? pageValues[vi++] : null);
      }
    }
  }
  return rows;
}
// Decode BYTE_ARRAY bytes to strings when the target Arrow type is utf8.
function finalize(values: unknown[], utf8: boolean): unknown[] {
  if (!utf8) return values;
  return values.map((v) => v instanceof Uint8Array ? _decoder.decode(v) : v);
}
