/**
 * Parquet enums and error type.
 *
 * The numeric constants here are the wire values from `parquet.thrift` — they
 * are serialized directly into a file's Thrift compact-encoded metadata, so
 * every value must match the spec exactly. The whole `internal:data/parquet/*`
 * family shares them: `metadata` reads and writes them in footers and page
 * headers, `schema` and `nested` map them to and from Arrow types,
 * `column-reader` and `writer` switch on them to pick decode and encode paths,
 * and `compression` maps codec ids onto `fino:compress` formats. Backs
 * `fino:data/parquet`.
 *
 * `ParquetError` is the family's error class. It extends `ArrowError` — the
 * Parquet toolkit produces and consumes Arrow, so a single `instanceof
 * ArrowError` check covers failures from both layers — and is re-exported
 * from the public `fino:data/parquet` module.
 *
 * ```ts no_run
 * import { PType, Repetition, ParquetError } from 'internal:data/parquet/types';
 * import type { SchemaElement } from 'internal:data/parquet/metadata';
 *
 * function describeLeaf(el: SchemaElement): string {
 *   const suffix = el.repetitionType === Repetition.OPTIONAL ? '?' : '';
 *   switch (el.type) {
 *     case PType.INT64: return `int64${suffix}`;
 *     case PType.BYTE_ARRAY: return `binary${suffix}`;
 *     default: throw new ParquetError(`unhandled physical type ${el.type}`);
 *   }
 * }
 * ```
 *
 * parquet.thrift: https://github.com/apache/parquet-format/blob/master/src/main/thrift/parquet.thrift
 *
 * @internal
 */
import { ArrowError } from 'fino:data/arrow';
/**
 * Physical storage types (`parquet.thrift` `Type`) — how values are laid out
 * in a page, independent of any logical annotation on top. INT96 is the
 * deprecated 12-byte Impala/Hive timestamp layout: the reader decodes it, but
 * the writer never emits it. FIXED_LEN_BYTE_ARRAY values take their width
 * from the schema element's `typeLength`.
 *
 * @internal
 */
export const PType = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  INT96: 3,
  FLOAT: 4,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
  FIXED_LEN_BYTE_ARRAY: 7,
} as const;
/**
 * Legacy type annotations (`parquet.thrift` `ConvertedType`), superseded by
 * the `LogicalType` union but still round-tripped for compatibility: the
 * writer emits a converted type alongside the logical type wherever one
 * exists, and the reader falls back to it when a file predates logical types.
 * MAP, MAP_KEY_VALUE, and LIST annotate group nodes; the rest annotate leaf
 * columns.
 *
 * @internal
 */
export const ConvertedType = {
  UTF8: 0,
  MAP: 1,
  MAP_KEY_VALUE: 2,
  LIST: 3,
  ENUM: 4,
  DECIMAL: 5,
  DATE: 6,
  TIME_MILLIS: 7,
  TIME_MICROS: 8,
  TIMESTAMP_MILLIS: 9,
  TIMESTAMP_MICROS: 10,
  UINT_8: 11,
  UINT_16: 12,
  UINT_32: 13,
  UINT_64: 14,
  INT_8: 15,
  INT_16: 16,
  INT_32: 17,
  INT_64: 18,
  JSON: 19,
  BSON: 20,
  INTERVAL: 21,
} as const;
/**
 * Column repetition kind (`parquet.thrift` `FieldRepetitionType`). REQUIRED
 * fields contribute nothing to a column's levels, each OPTIONAL ancestor adds
 * one to the max definition level, and each REPEATED node (list element, map
 * entry) adds one to both the max definition and max repetition level —
 * `internal:data/parquet/nested` derives those maxima by walking these values
 * down the schema tree.
 *
 * @internal
 */
export const Repetition = {
  REQUIRED: 0,
  OPTIONAL: 1,
  REPEATED: 2,
} as const;
/**
 * Value and level encodings (`parquet.thrift` `Encoding`). The gap at 1 is
 * the spec's retired GROUP_VAR_INT slot. PLAIN_DICTIONARY is the v1 spelling
 * of dictionary encoding and RLE_DICTIONARY the v2 one; the column reader
 * treats them identically, while the writer only emits RLE_DICTIONARY. RLE
 * here is the RLE/bit-packed hybrid used for definition/repetition levels and
 * dictionary indices (and for BOOLEAN data pages).
 *
 * @internal
 */
export const Encoding = {
  PLAIN: 0,
  PLAIN_DICTIONARY: 2,
  RLE: 3,
  BIT_PACKED: 4,
  DELTA_BINARY_PACKED: 5,
  DELTA_LENGTH_BYTE_ARRAY: 6,
  DELTA_BYTE_ARRAY: 7,
  RLE_DICTIONARY: 8,
  BYTE_STREAM_SPLIT: 9,
} as const;
/**
 * Page compression codecs (`parquet.thrift` `CompressionCodec`).
 * `internal:data/parquet/compression` wires UNCOMPRESSED, SNAPPY, GZIP, ZSTD,
 * and BROTLI to `fino:compress`; LZO, LZ4, and LZ4_RAW are recognized ids but
 * unsupported — encountering one throws `ParquetError`.
 *
 * @internal
 */
export const Compression = {
  UNCOMPRESSED: 0,
  SNAPPY: 1,
  GZIP: 2,
  LZO: 3,
  BROTLI: 4,
  LZ4: 5,
  ZSTD: 6,
  LZ4_RAW: 7,
} as const;
/**
 * Page kinds (`parquet.thrift` `PageType`) carried in each page header within
 * a column chunk. The column reader consumes DATA_PAGE, DATA_PAGE_V2, and
 * DICTIONARY_PAGE, skips INDEX_PAGE, and throws `ParquetError` on anything
 * else.
 *
 * @internal
 */
export const PageType = {
  DATA_PAGE: 0,
  INDEX_PAGE: 1,
  DICTIONARY_PAGE: 2,
  DATA_PAGE_V2: 3,
} as const;
/**
 * Thrift field ids of the `LogicalType` union members — field ids, not enum
 * values. A `LogicalType` is a Thrift union, so the one field id present in
 * the encoded struct identifies which annotation applies to the column;
 * `internal:data/parquet/metadata` matches against these when reading and
 * writing `SchemaElement.logicalType`. The gap at 9 is the slot the spec
 * reserves for INTERVAL.
 *
 * @internal
 */
export const LogicalTypeId = {
  STRING: 1,
  MAP: 2,
  LIST: 3,
  ENUM: 4,
  DECIMAL: 5,
  DATE: 6,
  TIME: 7,
  TIMESTAMP: 8,
  INTEGER: 10,
  UNKNOWN: 11,
  JSON: 12,
  BSON: 13,
  UUID: 14,
  FLOAT16: 15,
} as const;
/**
 * Thrift field ids of the `TimeUnit` union nested inside TIME and TIMESTAMP
 * logical types, selecting the resolution (milliseconds, microseconds, or
 * nanoseconds) of the stored integer values.
 *
 * @internal
 */
export const TimeUnitId = {
  MILLIS: 1,
  MICROS: 2,
  NANOS: 3,
} as const;
/**
 * Error thrown for malformed or unsupported Parquet input, or misuse.
 *
 * Covers three failure families: corrupt bytes (missing `PAR1` magic,
 * truncated footers or schemas, level/value count mismatches), features this
 * implementation does not support (LZO/LZ4 codecs, unknown page encodings),
 * and caller mistakes (an unsupported `compression` option passed to
 * `writeParquet`).
 *
 * Extends `ArrowError`, so code that already catches Arrow toolkit errors
 * catches Parquet ones too. Re-exported from the public `fino:data/parquet`
 * module — import it from there for `instanceof` checks.
 *
 * ```ts no_run
 * import { readParquet, ParquetError } from 'fino:data/parquet';
 *
 * try {
 *   const table = readParquet(bytes);
 * } catch (err) {
 *   if (err instanceof ParquetError) {
 *     console.error(`rejecting upload: ${err.message}`);
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 *
 * @internal
 */
export class ParquetError extends ArrowError {
  /**
   * Error name reported by `ParquetError` instances.
   *
   * @internal
   */
  override name = 'ParquetError';
}
