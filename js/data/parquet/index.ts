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
* Coverage: the full primitive and logical type system (bool, signed/unsigned
* ints, float/double/float16, string/binary, fixed-length binary, decimals over
* every physical backing, date, time, all timestamp units, and INT96); nested
* columns (list/struct/map and arbitrary nesting) via repetition/definition
* levels; DATA_PAGE v1 and v2; and every value encoding (PLAIN, dictionary,
* RLE, the DELTA family, BYTE_STREAM_SPLIT). Compression codecs are those
* `fino:compress` provides (LZO and raw-block LZ4 excepted).
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
