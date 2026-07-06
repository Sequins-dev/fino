/**
* fino:data/parquet - a native Apache Parquet reader and writer producing and
* consuming Arrow.
*
* Built from discrete parts rather than a bundled engine: Thrift compact
* metadata (`internal:format/thrift`), page compression (`fino:compress`:
* snappy/gzip/zstd/brotli), and Arrow (`fino:data/arrow`) as the in-memory
* representation. `readParquet` decodes a file to an Arrow `Table`,
* concatenating every row group; `writeParquet` serializes an Arrow
* `Table`/`RecordBatch` to Parquet bytes as a single row group, with
* `ParquetWriteOptions` selecting the compression codec, value encoding,
* dictionary encoding, and data page version. Malformed or unsupported input
* is reported by throwing `ParquetError`.
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
/**
* Decode a Parquet file into an Arrow `Table`.
*
* Accepts the complete file as a `Uint8Array` or `ArrayBuffer` — the format's
* footer-last layout requires the whole file, so there is no streaming form.
* Every row group becomes one Arrow `RecordBatch` in the returned table (a
* file with no row groups yields a single empty batch), and nested columns are
* reassembled into list/struct/map vectors from their repetition/definition
* levels.
*
* Throws `ParquetError` if the input lacks the `PAR1` magic, the footer is
* corrupt, a row group's column count disagrees with the schema, or a page
* uses a compression codec that `fino:compress` cannot provide on this system.
*
* ```ts no_run
* import { readParquet } from 'fino:data/parquet';
* import { DiskFileSystem } from 'fino:file';
*
* const fs = new DiskFileSystem();
* const file = await fs.open('/data/events.parquet');
* const table = readParquet(await file.bytes());
* await file.close();
* for (const batch of table.batches) {
*   console.log(batch.numRows, batch.schema.fields.map((f) => f.name));
* }
* ```
*/
export { readParquet } from './reader.ts';
/**
* Serialize an Arrow `Table` or `RecordBatch` to Parquet file bytes.
*
* All batches are written as one row group. `ParquetWriteOptions` controls the
* output: `compression` names the page codec (default `'snappy'`;
* `'uncompressed'`, `'gzip'`, `'zstd'`, and `'brotli'` are the alternatives),
* `dictionary` turns on dictionary-encoded pages (default `false`), `encoding`
* picks the non-dictionary value encoding (`'plain'` default, or `'delta'`,
* `'byte-stream-split'`, `'rle'`, each applied only to column types where the
* format allows it, falling back to PLAIN elsewhere), and `pageVersion`
* selects DATA_PAGE v1 (default) or v2.
*
* Throws `ParquetError` when the requested compression codec is unavailable
* through `fino:compress` on this system.
*
* ```ts no_run
* import { writeParquet } from 'fino:data/parquet';
* import { Table, RecordBatch } from 'fino:data/arrow';
*
* const table = Table.from([
*   RecordBatch.from({ ts: [1n, 2n, 3n], tags: [['a'], [], ['b', 'c']] }),
* ]);
* const bytes = writeParquet(table, {
*   compression: 'zstd',
*   dictionary: true,
*   pageVersion: 2,
* });
* ```
*/
export { writeParquet, type ParquetWriteOptions } from './writer.ts';
/**
* Error thrown for malformed or unsupported Parquet input, or misuse.
*
* Extends `ArrowError` from `fino:data/arrow`, so one catch clause can cover
* both layers of a decode pipeline. Instances report `name` as
* `'ParquetError'`.
*
* ```ts no_run
* import { readParquet, ParquetError } from 'fino:data/parquet';
*
* try {
*   readParquet(bytes);
* } catch (err) {
*   if (err instanceof ParquetError) console.error('bad file:', err.message);
*   else throw err;
* }
* ```
*/
export { ParquetError } from './types.ts';
