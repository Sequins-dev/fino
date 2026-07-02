/**
* Parquet writer: Arrow → Parquet file bytes.
*
* This milestone writes one row group of flat columns using PLAIN-encoded
* DATA_PAGE (v1) pages with optional page compression. Definition levels encode
* nulls for optional columns. Dictionary and delta encodings are a later phase.
*
* @internal
*/
import { Table, RecordBatch, Schema, Vector } from 'fino:data/arrow';
import { PType, Encoding, Compression, PageType, ParquetError } from './types.ts';
import { arrowSchemaToParquet, type ColumnDescriptor } from './schema.ts';
import { encodePlain } from './encoding.ts';
import { encodeDefinitionLevels, encodeRleHybrid, bitWidthForMax } from './levels.ts';
import { compressPage, isCodecSupported } from './compression.ts';
import { writePageHeader, writeFileMetaData, type FileMetaData, type RowGroup, type ColumnChunk, type ColumnMetaData, type PageHeader } from './metadata.ts';
const MAGIC = new Uint8Array([
  80,
  65,
  82,
  49
]);
/** Options for `writeParquet`. @internal */
export interface ParquetWriteOptions {
  /** Page compression codec name; defaults to snappy. */
  compression?: 'uncompressed' | 'snappy' | 'gzip' | 'zstd' | 'brotli';
  /** Dictionary-encode column values (default false — PLAIN pages). */
  dictionary?: boolean;
}
const CODEC_BY_NAME: Record<string, number> = {
  uncompressed: Compression.UNCOMPRESSED,
  snappy: Compression.SNAPPY,
  gzip: Compression.GZIP,
  zstd: Compression.ZSTD,
  brotli: Compression.BROTLI
};
/** Serialize an Arrow table or batch to Parquet bytes. */
export function writeParquet(source: Table | RecordBatch, options?: ParquetWriteOptions): Uint8Array {
  const table = source instanceof Table ? source : Table.from([source]);
  const codec = CODEC_BY_NAME[options?.compression ?? 'snappy'] ?? Compression.SNAPPY;
  if (!isCodecSupported(codec)) throw new ParquetError(`compression '${options?.compression}' is not supported`);
  const { elements, columns } = arrowSchemaToParquet(table.schema);
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    offset += bytes.byteLength;
  };
  push(MAGIC);
  // One row group per table (concatenating the table's columns across batches).
  const useDictionary = options?.dictionary ?? false;
  const columnChunks: ColumnChunk[] = [];
  let totalUncompressed = 0n;
  for (let c = 0; c < columns.length; c++) {
    const descriptor = columns[c]!;
    const chunkVectors = table.batches.map((b) => b.columns[c]!);
    const chunk = writeColumnChunk(descriptor, chunkVectors, codec, useDictionary, offset, push);
    columnChunks.push(chunk.columnChunk);
    totalUncompressed += chunk.uncompressedSize;
  }
  const rowGroup: RowGroup = {
    columns: columnChunks,
    totalByteSize: totalUncompressed,
    numRows: BigInt(table.numRows)
  };
  const meta: FileMetaData = {
    version: 2,
    schema: elements,
    numRows: BigInt(table.numRows),
    rowGroups: [rowGroup],
    createdBy: 'fino'
  };
  const footer = writeFileMetaData(meta);
  push(footer);
  const footerLen = new Uint8Array(4);
  new DataView(footerLen.buffer).setUint32(0, footer.byteLength, true);
  push(footerLen);
  push(MAGIC);
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}
function writeColumnChunk(descriptor: ColumnDescriptor, vectors: Vector[], codec: number, useDictionary: boolean, startOffset: number, push: (bytes: Uint8Array) => void): {
  columnChunk: ColumnChunk;
  uncompressedSize: bigint;
} {
  // Gather non-null values + definition levels across the column's chunks.
  const values: unknown[] = [];
  const defLevels: number[] = [];
  let numRows = 0;
  const utf8 = descriptor.arrowField.type.kind === 'utf8';
  for (const vec of vectors) {
    for (let i = 0; i < vec.length; i++) {
      numRows++;
      if (vec.isValid(i)) {
        defLevels.push(descriptor.maxDefinitionLevel);
        const v = vec.get(i);
        values.push(utf8 ? String(v) : v);
      } else {
        defLevels.push(0);
      }
    }
  }
  const defBytes = encodeDefinitionLevels(defLevels, descriptor.maxDefinitionLevel);
  let offset = startOffset;
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  let dictionaryPageOffset: bigint | undefined;
  const encodings: number[] = [Encoding.RLE, Encoding.PLAIN];
  if (useDictionary) {
    const { dictionary, indices } = buildDictionary(values);
    // Dictionary page: PLAIN-encoded distinct values.
    const dictBody = encodePlain(descriptor.physicalType, dictionary, descriptor.typeLength);
    const dictCompressed = compressPage(codec, dictBody);
    const dictHeader = writePageHeader({
      type: PageType.DICTIONARY_PAGE,
      uncompressedPageSize: dictBody.byteLength,
      compressedPageSize: dictCompressed.byteLength,
      dictionaryPageHeader: {
        numValues: dictionary.length,
        encoding: Encoding.PLAIN
      }
    });
    dictionaryPageOffset = BigInt(offset);
    push(dictHeader);
    push(dictCompressed);
    offset += dictHeader.byteLength + dictCompressed.byteLength;
    uncompressedTotal += dictHeader.byteLength + dictBody.byteLength;
    compressedTotal += dictHeader.byteLength + dictCompressed.byteLength;
    encodings.push(Encoding.RLE_DICTIONARY);
    // Data page: definition levels + [bit-width byte][RLE-hybrid indices].
    const bitWidth = bitWidthForMax(Math.max(0, dictionary.length - 1));
    const idxHybrid = encodeRleHybrid(indices, bitWidth);
    const idxBody = new Uint8Array(1 + idxHybrid.byteLength);
    idxBody[0] = bitWidth;
    idxBody.set(idxHybrid, 1);
    const uncompressed = concat([defBytes, idxBody]);
    const compressed = compressPage(codec, uncompressed);
    const dataHeader = writePageHeader({
      type: PageType.DATA_PAGE,
      uncompressedPageSize: uncompressed.byteLength,
      compressedPageSize: compressed.byteLength,
      dataPageHeader: {
        numValues: numRows,
        encoding: Encoding.RLE_DICTIONARY,
        definitionLevelEncoding: Encoding.RLE,
        repetitionLevelEncoding: Encoding.RLE
      }
    });
    const dataPageOffset = offset;
    push(dataHeader);
    push(compressed);
    offset += dataHeader.byteLength + compressed.byteLength;
    uncompressedTotal += dataHeader.byteLength + uncompressed.byteLength;
    compressedTotal += dataHeader.byteLength + compressed.byteLength;
    const meta: ColumnMetaData = {
      type: descriptor.physicalType,
      encodings,
      pathInSchema: descriptor.path,
      codec,
      numValues: BigInt(numRows),
      totalUncompressedSize: BigInt(uncompressedTotal),
      totalCompressedSize: BigInt(compressedTotal),
      dataPageOffset: BigInt(dataPageOffset),
      dictionaryPageOffset
    };
    return {
      columnChunk: {
        fileOffset: dictionaryPageOffset,
        metaData: meta
      },
      uncompressedSize: BigInt(uncompressedTotal)
    };
  }
  // PLAIN data page.
  const valueBytes = encodePlain(descriptor.physicalType, values, descriptor.typeLength);
  const uncompressed = concat([defBytes, valueBytes]);
  const compressed = compressPage(codec, uncompressed);
  const header = writePageHeader({
    type: PageType.DATA_PAGE,
    uncompressedPageSize: uncompressed.byteLength,
    compressedPageSize: compressed.byteLength,
    dataPageHeader: {
      numValues: numRows,
      encoding: Encoding.PLAIN,
      definitionLevelEncoding: Encoding.RLE,
      repetitionLevelEncoding: Encoding.RLE
    }
  });
  const dataPageOffset = offset;
  push(header);
  push(compressed);
  uncompressedTotal = header.byteLength + uncompressed.byteLength;
  const meta: ColumnMetaData = {
    type: descriptor.physicalType,
    encodings,
    pathInSchema: descriptor.path,
    codec,
    numValues: BigInt(numRows),
    totalUncompressedSize: BigInt(uncompressedTotal),
    totalCompressedSize: BigInt(header.byteLength + compressed.byteLength),
    dataPageOffset: BigInt(dataPageOffset)
  };
  return {
    columnChunk: {
      fileOffset: BigInt(dataPageOffset),
      metaData: meta
    },
    uncompressedSize: BigInt(uncompressedTotal)
  };
}
function buildDictionary(values: unknown[]): {
  dictionary: unknown[];
  indices: number[];
} {
  const dictionary: unknown[] = [];
  const indexByKey = new Map<unknown, number>();
  const indices: number[] = [];
  for (const v of values) {
    const key = v instanceof Uint8Array ? `b:${String.fromCharCode(...v)}` : v;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = dictionary.length;
      dictionary.push(v);
      indexByKey.set(key, idx);
    }
    indices.push(idx);
  }
  return {
    dictionary,
    indices
  };
}
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}
export { MAGIC };
