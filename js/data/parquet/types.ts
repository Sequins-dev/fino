/**
* Parquet enums and error type.
*
* Values match `parquet.thrift`. Backs `fino:data/parquet`.
*
* @internal
*/
import { ArrowError } from 'fino:data/arrow';
/** Parquet physical types (`parquet.thrift` `Type`). @internal */
export const PType = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  INT96: 3,
  FLOAT: 4,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
  FIXED_LEN_BYTE_ARRAY: 7
} as const;
/** Legacy converted types (`ConvertedType`). @internal */
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
  INTERVAL: 21
} as const;
/** Column repetition kind (`FieldRepetitionType`). @internal */
export const Repetition = {
  REQUIRED: 0,
  OPTIONAL: 1,
  REPEATED: 2
} as const;
/** Value/level encodings (`Encoding`). @internal */
export const Encoding = {
  PLAIN: 0,
  PLAIN_DICTIONARY: 2,
  RLE: 3,
  BIT_PACKED: 4,
  DELTA_BINARY_PACKED: 5,
  DELTA_LENGTH_BYTE_ARRAY: 6,
  DELTA_BYTE_ARRAY: 7,
  RLE_DICTIONARY: 8,
  BYTE_STREAM_SPLIT: 9
} as const;
/** Page compression codecs (`CompressionCodec`). @internal */
export const Compression = {
  UNCOMPRESSED: 0,
  SNAPPY: 1,
  GZIP: 2,
  LZO: 3,
  BROTLI: 4,
  LZ4: 5,
  ZSTD: 6,
  LZ4_RAW: 7
} as const;
/** Page kinds (`PageType`). @internal */
export const PageType = {
  DATA_PAGE: 0,
  INDEX_PAGE: 1,
  DICTIONARY_PAGE: 2,
  DATA_PAGE_V2: 3
} as const;
/** `LogicalType` union member ids (thrift field ids). @internal */
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
  FLOAT16: 15
} as const;
/** Time unit union ids used by TIME/TIMESTAMP logical types. @internal */
export const TimeUnitId = {
  MILLIS: 1,
  MICROS: 2,
  NANOS: 3
} as const;
/**
* Error thrown for malformed or unsupported Parquet input, or misuse.
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
