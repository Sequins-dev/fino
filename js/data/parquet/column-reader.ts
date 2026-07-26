/**
 * Column-chunk page iteration and value decoding, shared by the flat and nested
 * readers. Handles DATA_PAGE v1 and DATA_PAGE_V2, dictionary pages, and every
 * value encoding (PLAIN, dictionary, RLE, the DELTA family, BYTE_STREAM_SPLIT).
 *
 * This is the page-level layer of the Parquet reader: `reader.ts` resolves the
 * schema into per-leaf `ColumnDescriptor`s and hands each leaf's `ColumnMetaData`
 * here, and this module walks that chunk's page stream — decompressing page
 * bodies with the chunk codec, decoding repetition/definition levels, retaining
 * the dictionary page for later dictionary-encoded pages, and turning value
 * bytes into JS values.
 *
 * Each data page is delivered to `onPage` as decoded non-null *physical* leaf
 * values (booleans, numbers, BigInts, `Uint8Array`s — no logical/Arrow
 * conversion) plus repetition/definition levels; callers apply the descriptor's
 * Arrow value converter and (for nested columns) reassemble records from the
 * levels.
 *
 * ```ts no_run
 * import { readColumnPages } from 'internal:data/parquet/column-reader';
 *
 * const values: unknown[] = [];
 * readColumnPages(fileBytes, descriptor, columnChunkMeta, (page) => {
 *   for (const v of page.values) values.push(descriptor.decode(v));
 * });
 * ```
 *
 * Page and encoding layouts follow the Parquet format spec:
 * https://parquet.apache.org/docs/file-format/data-pages/
 *
 * @internal
 */
import { ByteReader } from 'internal:format/thrift';
import { PType, Encoding, PageType, ParquetError } from './types.ts';
import type { ColumnDescriptor } from './schema.ts';
import { readPageHeader, type ColumnMetaData } from './metadata.ts';
import { decodePlain, decodeDictionaryIndices } from './encoding.ts';
import { decodeRleHybrid, bitWidthForMax } from './levels.ts';
import { decompressPage } from './compression.ts';
import {
  decodeDeltaBinaryPacked,
  decodeDeltaLengthByteArray,
  decodeDeltaByteArray,
  decodeByteStreamSplit,
} from './delta.ts';
/**
 * A decoded data page, as delivered to the `readColumnPages` callback.
 *
 * `values` is dense: it holds only the leaf slots whose definition level equals
 * the column's `maxDefinitionLevel`, so `values.length` can be smaller than
 * `numValues`. Callers walk `defLevels` to know where nulls (and, for nested
 * columns, empty lists or absent optional groups) sit between the decoded
 * values, and `repLevels` to know where each record starts.
 *
 * ```ts no_run
 * import type { DecodedPage } from 'internal:data/parquet/column-reader';
 *
 * function toNullableArray(page: DecodedPage, maxDef: number): unknown[] {
 *   if (page.defLevels === null) return page.values;
 *   let vi = 0;
 *   return page.defLevels.map((l) => (l === maxDef ? page.values[vi++] : null));
 * }
 * ```
 *
 * @internal
 */
export interface DecodedPage {
  /** Non-null physical leaf values, in order. */
  values: unknown[];
  /** Definition levels (one per leaf slot), or null when maxDefinitionLevel is 0. */
  defLevels: number[] | null;
  /** Repetition levels (one per leaf slot), or null when maxRepetitionLevel is 0. */
  repLevels: number[] | null;
  /** Total leaf slots in this page (including nulls). */
  numValues: number;
}
/**
 * Iterate a column chunk's pages, invoking `onPage` for each data page.
 *
 * `bytes` must be the whole Parquet file (or at least a buffer in which the
 * chunk's page offsets are valid indices): iteration starts at
 * `meta.dictionaryPageOffset` when present, otherwise `meta.dataPageOffset`,
 * and continues until the pages seen account for `meta.numValues` leaf slots.
 *
 * A DICTIONARY_PAGE is decompressed, PLAIN-decoded, and retained so later
 * dictionary-encoded data pages can materialize their indices into values.
 * DATA_PAGE (v1) bodies are decompressed as a whole with `meta.codec` before
 * the length-prefixed level runs and value bytes are read; DATA_PAGE_V2 stores
 * its level runs uncompressed ahead of the value section and only the value
 * bytes are decompressed (and only when the header says they are compressed).
 * INDEX_PAGE entries are skipped — they carry no rows.
 *
 * Decoded values are physical: dictionary indices are resolved against the
 * dictionary, RLE booleans become `boolean`s, DELTA_BINARY_PACKED yields
 * `number`s for INT32 columns and `BigInt`s for INT64, and byte-array
 * encodings yield `Uint8Array`s. Applying the column's logical conversion
 * (`descriptor.decode`) is the caller's job.
 *
 * Throws `ParquetError` if a dictionary-encoded page appears before the
 * chunk's dictionary page, if a page uses an unsupported encoding or an
 * unexpected page type, or (from the compression layer) if the chunk's codec
 * is not supported.
 *
 * ```ts no_run
 * import { readColumnPages } from 'internal:data/parquet/column-reader';
 * import { readFileMetaData } from 'internal:data/parquet/metadata';
 *
 * const meta = readFileMetaData(footerBytes);
 * const chunk = meta.rowGroups[0].columns[0].metaData!;
 * const values: unknown[] = [];
 * readColumnPages(fileBytes, descriptor, chunk, (page) => {
 *   let vi = 0;
 *   for (let i = 0; i < page.numValues; i++) {
 *     const def = page.defLevels === null ? 0 : page.defLevels[i];
 *     values.push(def === descriptor.maxDefinitionLevel ? descriptor.decode(page.values[vi++]) : null);
 *   }
 * });
 * ```
 */
export function readColumnPages(
  bytes: Uint8Array,
  descriptor: ColumnDescriptor,
  meta: ColumnMetaData,
  onPage: (page: DecodedPage) => void,
): void {
  const totalLeaves = Number(meta.numValues);
  let offset =
    meta.dictionaryPageOffset !== undefined
      ? Number(meta.dictionaryPageOffset)
      : Number(meta.dataPageOffset);
  let dictionary: unknown[] | null = null;
  let seen = 0;
  while (seen < totalLeaves) {
    const { header, end } = readPageHeader(bytes, offset);
    const pageBytes = bytes.subarray(end, end + header.compressedPageSize);
    offset = end + header.compressedPageSize;
    if (header.type === PageType.DICTIONARY_PAGE) {
      const dh = header.dictionaryPageHeader!;
      const uncompressed = decompressPage(meta.codec, pageBytes);
      dictionary = decodePlain(
        descriptor.physicalType,
        uncompressed,
        dh.numValues,
        descriptor.typeLength,
      );
      continue;
    }
    if (header.type === PageType.DATA_PAGE) {
      const dph = header.dataPageHeader!;
      const uncompressed = decompressPage(meta.codec, pageBytes);
      const reader = new ByteReader(uncompressed);
      let repLevels: number[] | null = null;
      let defLevels: number[] | null = null;
      if (descriptor.maxRepetitionLevel > 0) {
        reader.readBytes(4);
        repLevels = decodeRleHybrid(
          reader,
          bitWidthForMax(descriptor.maxRepetitionLevel),
          dph.numValues,
        );
      }
      if (descriptor.maxDefinitionLevel > 0) {
        reader.readBytes(4);
        defLevels = decodeRleHybrid(
          reader,
          bitWidthForMax(descriptor.maxDefinitionLevel),
          dph.numValues,
        );
      }
      const valueBytes = reader.readBytes(reader.remaining);
      const nonNull = countNonNull(defLevels, descriptor.maxDefinitionLevel, dph.numValues);
      const values = decodeValues(dph.encoding, descriptor, valueBytes, nonNull, dictionary);
      onPage({
        values,
        defLevels,
        repLevels,
        numValues: dph.numValues,
      });
      seen += dph.numValues;
      continue;
    }
    if (header.type === PageType.DATA_PAGE_V2) {
      const v2 = header.dataPageHeaderV2!;
      const repLen = v2.repetitionLevelsByteLength;
      const defLen = v2.definitionLevelsByteLength;
      const repBytes = pageBytes.subarray(0, repLen);
      const defBytes = pageBytes.subarray(repLen, repLen + defLen);
      const rawValues = pageBytes.subarray(repLen + defLen);
      const valueBytes = v2.isCompressed ? decompressPage(meta.codec, rawValues) : rawValues;
      const repLevels =
        descriptor.maxRepetitionLevel > 0
          ? decodeRleHybrid(
              new ByteReader(repBytes),
              bitWidthForMax(descriptor.maxRepetitionLevel),
              v2.numValues,
            )
          : null;
      const defLevels =
        descriptor.maxDefinitionLevel > 0
          ? decodeRleHybrid(
              new ByteReader(defBytes),
              bitWidthForMax(descriptor.maxDefinitionLevel),
              v2.numValues,
            )
          : null;
      const nonNull = v2.numValues - v2.numNulls;
      const values = decodeValues(v2.encoding, descriptor, valueBytes, nonNull, dictionary);
      onPage({
        values,
        defLevels,
        repLevels,
        numValues: v2.numValues,
      });
      seen += v2.numValues;
      continue;
    }
    // INDEX_PAGE and any other page kinds carry no rows.
    if (header.type !== PageType.INDEX_PAGE) {
      throw new ParquetError(`unexpected Parquet page type ${header.type}`);
    }
  }
}
function countNonNull(defLevels: number[] | null, maxDef: number, numValues: number): number {
  if (defLevels === null) return numValues;
  let n = 0;
  for (const l of defLevels) if (l === maxDef) n++;
  return n;
}
function decodeValues(
  encoding: number,
  descriptor: ColumnDescriptor,
  valueBytes: Uint8Array,
  nonNull: number,
  dictionary: unknown[] | null,
): unknown[] {
  const physicalType = descriptor.physicalType;
  switch (encoding) {
    case Encoding.PLAIN:
      return decodePlain(physicalType, valueBytes, nonNull, descriptor.typeLength);
    case Encoding.RLE_DICTIONARY:
    case Encoding.PLAIN_DICTIONARY: {
      if (dictionary === null)
        throw new ParquetError('dictionary-encoded page before its dictionary page');
      const indices = decodeDictionaryIndices(valueBytes, nonNull);
      return indices.map((idx) => dictionary[idx]);
    }
    case Encoding.RLE: {
      // Boolean values: a 4-byte little-endian length prefix then a hybrid run.
      const reader = new ByteReader(valueBytes);
      reader.readBytes(4);
      const bits = decodeRleHybrid(reader, 1, nonNull);
      return bits.map((b) => b !== 0);
    }
    case Encoding.DELTA_BINARY_PACKED: {
      const nums = decodeDeltaBinaryPacked(valueBytes, nonNull);
      if (physicalType === PType.INT32) return nums.map((v) => Number(BigInt.asIntN(32, v)));
      return nums.map((v) => BigInt.asIntN(64, v));
    }
    case Encoding.DELTA_LENGTH_BYTE_ARRAY:
      return decodeDeltaLengthByteArray(valueBytes, nonNull);
    case Encoding.DELTA_BYTE_ARRAY:
      return decodeDeltaByteArray(valueBytes, nonNull);
    case Encoding.BYTE_STREAM_SPLIT:
      return decodeByteStreamSplit(valueBytes, nonNull, physicalType, descriptor.typeLength);
    default:
      throw new ParquetError(`unsupported data page encoding ${encoding}`);
  }
}
