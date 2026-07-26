/**
 * internal:data/parquet/writer — Arrow → Parquet file serialization.
 *
 * Backs the public `writeParquet` re-exported from `fino:data/parquet`. The
 * whole file is produced in memory: `PAR1` magic, one column chunk per schema
 * leaf, the Thrift compact `FileMetaData` footer, the little-endian footer
 * length, and the trailing magic, returned as a single `Uint8Array`.
 *
 * The writer emits exactly one row group, and within it one data page per
 * column chunk (plus an optional dictionary page). Nested columns
 * (list/struct/map, at any depth) are shredded via `internal:data/parquet/nested`
 * into per-leaf value + repetition/definition level streams — each leaf becomes
 * its own column chunk; flat columns are the degenerate case with no repetition
 * levels. Levels are RLE/bit-packed hybrid encoded, length-prefixed inside the
 * v1 page body or stored raw ahead of the values in DATA_PAGE_V2.
 *
 * Value encoding is chosen per column from the options: PLAIN by default,
 * dictionary (PLAIN dictionary page + RLE_DICTIONARY indices) when
 * `dictionary` is set, or one of the alternative encodings (`delta`,
 * `byte-stream-split`, `rle`) where the column's physical type supports it,
 * falling back to PLAIN where it does not. Page bodies are compressed with
 * `internal:data/parquet/compression` (snappy by default).
 *
 * ```ts no_run
 * import { writeParquet } from 'internal:data/parquet/writer';
 * import { RecordBatch } from 'fino:data/arrow';
 *
 * const batch = RecordBatch.from({ id: [1, 2, 3], tag: ['a', 'b', 'a'] });
 * const bytes = writeParquet(batch, { compression: 'zstd', dictionary: true });
 * // bytes is a complete .parquet file, ready to hand to any reader.
 * ```
 *
 * Reference: https://parquet.apache.org/docs/file-format/
 *
 * @internal
 */
import { Table, RecordBatch } from 'fino:data/arrow';
import { PType, Encoding, Compression, PageType, ParquetError } from './types.ts';
import { encodePlain } from './encoding.ts';
import { encodeDeltaBinaryPacked, encodeDeltaByteArray, encodeByteStreamSplit } from './delta.ts';
import { encodeRleHybrid, bitWidthForMax } from './levels.ts';
import { compressPage, isCodecSupported } from './compression.ts';
import {
  writePageHeader,
  writeFileMetaData,
  type FileMetaData,
  type RowGroup,
  type ColumnChunk,
  type ColumnMetaData,
} from './metadata.ts';
import {
  buildNodes,
  nodesToSchemaElements,
  collectLeaves,
  shredColumn,
  type LeafStream,
} from './nested.ts';
import type { ColumnDescriptor } from './schema.ts';
const MAGIC = new Uint8Array([80, 65, 82, 49]);
/**
 * Options controlling how `writeParquet` encodes and compresses pages.
 *
 * All fields are optional; the defaults (snappy compression, PLAIN encoding,
 * no dictionary, DATA_PAGE v1) produce files any Parquet reader can consume.
 * `dictionary` and `encoding` are independent axes: when `dictionary` is true
 * the pages are RLE_DICTIONARY-encoded and `encoding` has no effect.
 *
 * ```ts no_run
 * import { writeParquet, type ParquetWriteOptions } from 'internal:data/parquet/writer';
 * import { RecordBatch } from 'fino:data/arrow';
 *
 * const options: ParquetWriteOptions = {
 *   compression: 'zstd',
 *   encoding: 'delta',   // DELTA_BINARY_PACKED for the int64 column
 *   pageVersion: 2,
 * };
 * const bytes = writeParquet(RecordBatch.from({ n: [1n, 2n, 4n] }), options);
 * ```
 *
 * @internal
 */
export interface ParquetWriteOptions {
  /**
   * Page compression codec name; defaults to snappy. Availability depends on
   * what `fino:compress` provides on this system — `writeParquet` throws for
   * a codec that is not loadable.
   */
  compression?: 'uncompressed' | 'snappy' | 'gzip' | 'zstd' | 'brotli';
  /**
   * Dictionary-encode column values (default false — PLAIN pages). When set,
   * every column chunk gets a PLAIN dictionary page followed by a data page of
   * RLE_DICTIONARY indices, which pays off when values repeat.
   */
  dictionary?: boolean;
  /**
   * Value encoding for non-dictionary pages (default 'plain'). Applied per
   * column where the physical type supports it, falling back to PLAIN
   * otherwise: `delta` covers INT32/INT64 (DELTA_BINARY_PACKED) and
   * BYTE_ARRAY (DELTA_BYTE_ARRAY), `byte-stream-split` covers FLOAT/DOUBLE,
   * and `rle` covers BOOLEAN.
   */
  encoding?: 'plain' | 'delta' | 'byte-stream-split' | 'rle';
  /**
   * Data page format version (default 1). Version 2 stores repetition and
   * definition levels uncompressed ahead of the (individually compressed)
   * values instead of compressing the whole page body.
   */
  pageVersion?: 1 | 2;
}
const CODEC_BY_NAME: Record<string, number> = {
  uncompressed: Compression.UNCOMPRESSED,
  snappy: Compression.SNAPPY,
  gzip: Compression.GZIP,
  zstd: Compression.ZSTD,
  brotli: Compression.BROTLI,
};
interface WriteConfig {
  codec: number;
  useDictionary: boolean;
  dataEncoding: string;
  pageVersion: number;
}
/**
 * Serialize an Arrow table or batch to a complete Parquet file in memory.
 *
 * A `RecordBatch` is wrapped into a single-batch `Table`; a multi-batch
 * `Table` has its batches concatenated column-wise, so the output always
 * contains exactly one row group holding every row. The returned bytes are
 * the full file — magic, column chunks, footer — suitable for writing to
 * disk as-is or feeding straight back to `readParquet`.
 *
 * The Parquet schema is derived from the Arrow schema, including nested
 * list/struct/map columns, nullability (definition levels), and logical type
 * annotations. Encoding and compression choices come from `options`; see
 * `ParquetWriteOptions` for the per-column fallback rules.
 *
 * Throws a `ParquetError` if the requested compression codec's system
 * library is not available.
 *
 * ```ts no_run
 * import { writeParquet } from 'internal:data/parquet/writer';
 * import { RecordBatch, Schema, Field, list, int32, utf8, vectorFromArray } from 'fino:data/arrow';
 * import { DiskFileSystem } from 'fino:file';
 *
 * const scoresType = list(new Field('item', int32(), true));
 * const batch = new RecordBatch(
 *   new Schema([new Field('user', utf8(), false), new Field('scores', scoresType, true)]),
 *   [vectorFromArray(['ada', 'lin'], utf8()), vectorFromArray([[1, 2], [3]], scoresType)],
 * );
 * const bytes = writeParquet(batch, { compression: 'gzip', pageVersion: 2 });
 * await new DiskFileSystem().writeFile('scores.parquet', bytes);
 * ```
 */
export function writeParquet(
  source: Table | RecordBatch,
  options?: ParquetWriteOptions,
): Uint8Array {
  const table = source instanceof Table ? source : Table.from([source]);
  const codec = CODEC_BY_NAME[options?.compression ?? 'snappy'] ?? Compression.SNAPPY;
  if (!isCodecSupported(codec))
    throw new ParquetError(`compression '${options?.compression}' is not supported`);
  const config: WriteConfig = {
    codec,
    useDictionary: options?.dictionary ?? false,
    dataEncoding: options?.encoding ?? 'plain',
    pageVersion: options?.pageVersion ?? 1,
  };
  const nodes = buildNodes(table.schema);
  const elements = nodesToSchemaElements(nodes);
  // Shred each top column (across batches) into per-leaf streams, in leaf order.
  const leafStreams: LeafStream[] = [];
  nodes.forEach((node, columnIndex) => {
    const leaves = collectLeaves(node);
    const acc: LeafStream[] = leaves.map((d) => ({
      descriptor: d,
      values: [],
      defLevels: [],
      repLevels: [],
    }));
    for (const batch of table.batches) {
      const partial = shredColumn(node, batch.columns[columnIndex]!, batch.numRows);
      for (let i = 0; i < leaves.length; i++) {
        acc[i]!.values.push(...partial[i]!.values);
        acc[i]!.defLevels.push(...partial[i]!.defLevels);
        acc[i]!.repLevels.push(...partial[i]!.repLevels);
      }
    }
    leafStreams.push(...acc);
  });
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    offset += bytes.byteLength;
  };
  push(MAGIC);
  const columnChunks: ColumnChunk[] = [];
  let totalUncompressed = 0n;
  for (const stream of leafStreams) {
    const chunk = writeLeafChunk(stream, config, offset, push);
    columnChunks.push(chunk.columnChunk);
    totalUncompressed += chunk.uncompressedSize;
  }
  const meta: FileMetaData = {
    version: 2,
    schema: elements,
    numRows: BigInt(table.numRows),
    rowGroups: [
      {
        columns: columnChunks,
        totalByteSize: totalUncompressed,
        numRows: BigInt(table.numRows),
      } as RowGroup,
    ],
    createdBy: 'fino',
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
function lengthPrefixed(levels: number[], maxLevel: number): Uint8Array {
  if (maxLevel === 0) return new Uint8Array(0);
  const body = encodeRleHybrid(levels, bitWidthForMax(maxLevel));
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength, true);
  out.set(body, 4);
  return out;
}
function writeLeafChunk(
  stream: LeafStream,
  config: WriteConfig,
  startOffset: number,
  push: (bytes: Uint8Array) => void,
): {
  columnChunk: ColumnChunk;
  uncompressedSize: bigint;
} {
  const descriptor = stream.descriptor;
  const maxDef = descriptor.maxDefinitionLevel;
  const maxRep = descriptor.maxRepetitionLevel;
  const numLeafSlots = stream.defLevels.length;
  const numRecords =
    maxRep > 0 ? stream.repLevels.reduce((n, r) => n + (r === 0 ? 1 : 0), 0) : numLeafSlots;
  const values = stream.values;
  const { codec, useDictionary, dataEncoding, pageVersion } = config;
  let offset = startOffset;
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  let dictionaryPageOffset: bigint | undefined;
  const encodings: number[] = [Encoding.RLE, Encoding.PLAIN];
  // Level bytes shared by both page versions (v1 prefixed, v2 raw).
  const repRawV2 =
    maxRep > 0 ? encodeRleHybrid(stream.repLevels, bitWidthForMax(maxRep)) : new Uint8Array(0);
  const defRawV2 =
    maxDef > 0 ? encodeRleHybrid(stream.defLevels, bitWidthForMax(maxDef)) : new Uint8Array(0);
  const levelsV1 = concat([
    lengthPrefixed(stream.repLevels, maxRep),
    lengthPrefixed(stream.defLevels, maxDef),
  ]);
  let valueBytes: Uint8Array;
  let valueEncoding: number;
  if (useDictionary) {
    const { dictionary, indices } = buildDictionary(values);
    const dictBody = encodePlain(descriptor.physicalType, dictionary, descriptor.typeLength);
    const dictCompressed = compressPage(codec, dictBody);
    const dictHeader = writePageHeader({
      type: PageType.DICTIONARY_PAGE,
      uncompressedPageSize: dictBody.byteLength,
      compressedPageSize: dictCompressed.byteLength,
      dictionaryPageHeader: {
        numValues: dictionary.length,
        encoding: Encoding.PLAIN,
      },
    });
    dictionaryPageOffset = BigInt(offset);
    push(dictHeader);
    push(dictCompressed);
    offset += dictHeader.byteLength + dictCompressed.byteLength;
    uncompressedTotal += dictHeader.byteLength + dictBody.byteLength;
    compressedTotal += dictHeader.byteLength + dictCompressed.byteLength;
    encodings.push(Encoding.RLE_DICTIONARY);
    const bitWidth = bitWidthForMax(Math.max(0, dictionary.length - 1));
    const idxHybrid = encodeRleHybrid(indices, bitWidth);
    valueBytes = new Uint8Array(1 + idxHybrid.byteLength);
    valueBytes[0] = bitWidth;
    valueBytes.set(idxHybrid, 1);
    valueEncoding = Encoding.RLE_DICTIONARY;
  } else {
    const encoded = encodeValues(dataEncoding, descriptor, values);
    valueBytes = encoded.bytes;
    valueEncoding = encoded.encoding;
    encodings[1] = valueEncoding;
  }
  // Emit the data page (v1 or v2).
  const dataPageOffset = offset;
  let header: Uint8Array;
  let pageBody: Uint8Array;
  let uncompressedPageSize: number;
  if (pageVersion === 2) {
    const compressedValues = compressPage(codec, valueBytes);
    pageBody = concat([repRawV2, defRawV2, compressedValues]);
    uncompressedPageSize = repRawV2.byteLength + defRawV2.byteLength + valueBytes.byteLength;
    header = writePageHeader({
      type: PageType.DATA_PAGE_V2,
      uncompressedPageSize,
      compressedPageSize: pageBody.byteLength,
      dataPageHeaderV2: {
        numValues: numLeafSlots,
        numNulls: numLeafSlots - values.length,
        numRows: numRecords,
        encoding: valueEncoding,
        definitionLevelsByteLength: defRawV2.byteLength,
        repetitionLevelsByteLength: repRawV2.byteLength,
        isCompressed: codec !== Compression.UNCOMPRESSED,
      },
    });
  } else {
    const uncompressed = concat([levelsV1, valueBytes]);
    pageBody = compressPage(codec, uncompressed);
    uncompressedPageSize = uncompressed.byteLength;
    header = writePageHeader({
      type: PageType.DATA_PAGE,
      uncompressedPageSize,
      compressedPageSize: pageBody.byteLength,
      dataPageHeader: {
        numValues: numLeafSlots,
        encoding: valueEncoding,
        definitionLevelEncoding: Encoding.RLE,
        repetitionLevelEncoding: Encoding.RLE,
      },
    });
  }
  push(header);
  push(pageBody);
  offset += header.byteLength + pageBody.byteLength;
  uncompressedTotal += header.byteLength + uncompressedPageSize;
  compressedTotal += header.byteLength + pageBody.byteLength;
  const meta: ColumnMetaData = {
    type: descriptor.physicalType,
    encodings,
    pathInSchema: descriptor.path,
    codec,
    numValues: BigInt(numLeafSlots),
    totalUncompressedSize: BigInt(uncompressedTotal),
    totalCompressedSize: BigInt(compressedTotal),
    dataPageOffset: BigInt(dataPageOffset),
    dictionaryPageOffset,
  };
  return {
    columnChunk: {
      fileOffset: dictionaryPageOffset ?? BigInt(dataPageOffset),
      metaData: meta,
    },
    uncompressedSize: BigInt(uncompressedTotal),
  };
}
const _encoder = new TextEncoder();
function toU8(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : _encoder.encode(String(value));
}
function encodeRleBool(values: unknown[]): Uint8Array {
  const bits = values.map((v) => (v ? 1 : 0));
  const hybrid = encodeRleHybrid(bits, 1);
  const out = new Uint8Array(4 + hybrid.byteLength);
  new DataView(out.buffer).setUint32(0, hybrid.byteLength, true);
  out.set(hybrid, 4);
  return out;
}
function encodeValues(
  encoding: string,
  descriptor: ColumnDescriptor,
  values: unknown[],
): {
  bytes: Uint8Array;
  encoding: number;
} {
  const pt = descriptor.physicalType;
  if (encoding === 'delta') {
    if (pt === PType.INT32 || pt === PType.INT64)
      return {
        bytes: encodeDeltaBinaryPacked(values as (number | bigint)[]),
        encoding: Encoding.DELTA_BINARY_PACKED,
      };
    if (pt === PType.BYTE_ARRAY)
      return {
        bytes: encodeDeltaByteArray(values.map(toU8)),
        encoding: Encoding.DELTA_BYTE_ARRAY,
      };
  } else if (encoding === 'byte-stream-split') {
    if (pt === PType.FLOAT || pt === PType.DOUBLE)
      return {
        bytes: encodeByteStreamSplit(values, pt),
        encoding: Encoding.BYTE_STREAM_SPLIT,
      };
  } else if (encoding === 'rle') {
    if (pt === PType.BOOLEAN)
      return {
        bytes: encodeRleBool(values),
        encoding: Encoding.RLE,
      };
  }
  return {
    bytes: encodePlain(pt, values, descriptor.typeLength),
    encoding: Encoding.PLAIN,
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
    indices,
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
