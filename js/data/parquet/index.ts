/**
* fino:data/parquet - a native Apache Parquet reader and writer producing and
* consuming Arrow.
*
* Built from discrete parts rather than a bundled engine: Thrift compact
* metadata (`internal:format/thrift`), page compression (`fino:compress`:
* snappy/gzip/zstd/brotli), and Arrow (`fino:data/arrow`) as the in-memory
* representation. `readParquet` decodes a file to an Arrow `Table`;
* `writeParquet` serializes an Arrow `Table`/`RecordBatch` to Parquet bytes.
*
* Current coverage: flat (non-nested) columns of the common types
* (bool/int/uint/float/double/string/binary/date/timestamp), DATA_PAGE v1 with
* PLAIN or dictionary-encoded values and definition levels for nulls. Nested
* columns, delta/byte-stream-split encodings, and DATA_PAGE v2 come in later
* phases and raise a clear `ParquetError` until then.
*
* ```ts no_run
* import { writeParquet, readParquet } from 'fino:data/parquet';
* import { RecordBatch } from 'fino:data/arrow';
*
* const batch = RecordBatch.from({ id: [1, 2, 3], name: ['a', 'b', 'c'] });
* const bytes = writeParquet(batch, { compression: 'zstd' });
* const table = readParquet(bytes);
* table.getChild('name')!.toArray(); // ['a', 'b', 'c']
* ```
*
* Useful references:
*   - Parquet file format: https://parquet.apache.org/docs/file-format/
*   - parquet.thrift: https://github.com/apache/parquet-format/blob/master/src/main/thrift/parquet.thrift
*/
export { readParquet } from './reader.ts';
export { writeParquet, type ParquetWriteOptions } from './writer.ts';
export { ParquetError } from './types.ts';
