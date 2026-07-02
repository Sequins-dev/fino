/**
* Parquet writer: Arrow → Parquet file bytes.
*
* Writes one row group of flat columns as DATA_PAGE v1 or v2, with PLAIN,
* dictionary, RLE (boolean), the DELTA family, or BYTE_STREAM_SPLIT value
* encodings, definition levels for nulls, and page compression.
*
* @internal
*/
import { Table, RecordBatch, Schema, Vector } from 'fino:data/arrow';
import { PType, Encoding, Compression, PageType, ParquetError } from './types.ts';
import { arrowSchemaToParquet, type ColumnDescriptor } from './schema.ts';
import { encodePlain } from './encoding.ts';
import { encodeDeltaBinaryPacked, encodeDeltaByteArray, encodeByteStreamSplit } from './delta.ts';
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
  /** Value encoding for non-dictionary pages (default 'plain'). Applied per
  * type where valid, falling back to PLAIN otherwise. */
  encoding?: 'plain' | 'delta' | 'byte-stream-split' | 'rle';
  /** Data page format version (default 1). */
  pageVersion?: 1 | 2;
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
  const dataEncoding = options?.encoding ?? 'plain';
  const pageVersion = options?.pageVersion ?? 1;
  const columnChunks: ColumnChunk[] = [];
  let totalUncompressed = 0n;
  for (let c = 0; c < columns.length; c++) {
    const descriptor = columns[c]!;
    const chunkVectors = table.batches.map((b) => b.columns[c]!);
    const chunk = writeColumnChunk(descriptor, chunkVectors, codec, useDictionary, dataEncoding, pageVersion, offset, push);
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
function writeColumnChunk(descriptor: ColumnDescriptor, vectors: Vector[], codec: number, useDictionary: boolean, dataEncoding: string, pageVersion: number, startOffset: number, push: (bytes: Uint8Array) => void): {
  columnChunk: ColumnChunk;
  uncompressedSize: bigint;
} {
  // Gather non-null values + definition levels across the column's chunks.
  const values: unknown[] = [];
  const defLevels: number[] = [];
  let numRows = 0;
  for (const vec of vectors) {
    for (let i = 0; i < vec.length; i++) {
      numRows++;
      if (vec.isValid(i)) {
        defLevels.push(descriptor.maxDefinitionLevel);
        values.push(descriptor.encode(vec.get(i)));
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
  // Non-dictionary data page (PLAIN by default, or the requested encoding).
  const encoded = encodeValues(dataEncoding, descriptor, values);
  encodings[1] = encoded.encoding;
  const valueBytes = encoded.bytes;
  let header: Uint8Array;
  let pageBody: Uint8Array;
  let uncompressedPageSize: number;
  if (pageVersion === 2) {
    // DATA_PAGE_V2: uncompressed levels (no length prefix) + compressed values.
    const defRaw = descriptor.maxDefinitionLevel > 0 ? encodeRleHybrid(defLevels, bitWidthForMax(descriptor.maxDefinitionLevel)) : new Uint8Array(0);
    const nonNull = values.length;
    const compressedValues = compressPage(codec, valueBytes);
    pageBody = concat([defRaw, compressedValues]);
    uncompressedPageSize = defRaw.byteLength + valueBytes.byteLength;
    header = writePageHeader({
      type: PageType.DATA_PAGE_V2,
      uncompressedPageSize,
      compressedPageSize: pageBody.byteLength,
      dataPageHeaderV2: {
        numValues: numRows,
        numNulls: numRows - nonNull,
        numRows,
        encoding: encoded.encoding,
        definitionLevelsByteLength: defRaw.byteLength,
        repetitionLevelsByteLength: 0,
        isCompressed: codec !== Compression.UNCOMPRESSED
      }
    });
  } else {
    const uncompressed = concat([defBytes, valueBytes]);
    pageBody = compressPage(codec, uncompressed);
    uncompressedPageSize = uncompressed.byteLength;
    header = writePageHeader({
      type: PageType.DATA_PAGE,
      uncompressedPageSize,
      compressedPageSize: pageBody.byteLength,
      dataPageHeader: {
        numValues: numRows,
        encoding: encoded.encoding,
        definitionLevelEncoding: Encoding.RLE,
        repetitionLevelEncoding: Encoding.RLE
      }
    });
  }
  const dataPageOffset = offset;
  push(header);
  push(pageBody);
  const compressed = pageBody;
  uncompressedTotal = header.byteLength + uncompressedPageSize;
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
const _encoder = new TextEncoder();
function toU8(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : _encoder.encode(String(value));
}
function encodeRleBool(values: unknown[]): Uint8Array {
  const bits = values.map((v) => v ? 1 : 0);
  const hybrid = encodeRleHybrid(bits, 1);
  const out = new Uint8Array(4 + hybrid.byteLength);
  new DataView(out.buffer).setUint32(0, hybrid.byteLength, true);
  out.set(hybrid, 4);
  return out;
}
// Select and apply the value encoding for a non-dictionary page.
function encodeValues(encoding: string, descriptor: ColumnDescriptor, values: unknown[]): {
  bytes: Uint8Array;
  encoding: number;
} {
  const pt = descriptor.physicalType;
  if (encoding === 'delta') {
    if (pt === PType.INT32 || pt === PType.INT64) return {
      bytes: encodeDeltaBinaryPacked(values as (number | bigint)[]),
      encoding: Encoding.DELTA_BINARY_PACKED
    };
    if (pt === PType.BYTE_ARRAY) return {
      bytes: encodeDeltaByteArray(values.map(toU8)),
      encoding: Encoding.DELTA_BYTE_ARRAY
    };
  } else if (encoding === 'byte-stream-split') {
    if (pt === PType.FLOAT || pt === PType.DOUBLE) return {
      bytes: encodeByteStreamSplit(values, pt),
      encoding: Encoding.BYTE_STREAM_SPLIT
    };
  } else if (encoding === 'rle') {
    if (pt === PType.BOOLEAN) return {
      bytes: encodeRleBool(values),
      encoding: Encoding.RLE
    };
  }
  return {
    bytes: encodePlain(pt, values, descriptor.typeLength),
    encoding: Encoding.PLAIN
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
