/**
* fino:data/arrow — a pure-TypeScript implementation of Apache Arrow.
*
* Provides the Arrow columnar in-memory format (every logical type, including
* the view, union, map, dictionary, and run-end-encoded layouts) and the Arrow
* IPC stream and file formats for interchange with the Arrow ecosystem
* (pyarrow, polars, DuckDB, ...). The Arrow C Data Interface — zero-copy
* hand-off of these same structures to native libraries over `fino:ffi` —
* lives in the companion module `fino:data/arrow/cdata`.
*
* The object model is `Vector` (one column), `RecordBatch` (a schema plus one
* equal-length vector per field), and `Table` (a schema plus batches, with
* chunked `Column` views that read one field across batch boundaries).
* `get(i)` returns raw physical values — `number` up to 32 bits, `bigint` for
* 64-bit ints, timestamps, and durations, `string`, `Uint8Array` for binary,
* arrays/objects for nested types, and `null` for nulls. Build vectors with
* `vectorFromArray` (type inference from JS values) or `makeVector` (raw Arrow
* buffers), and describe columns with the logical type factories (`int32()`,
* `utf8()`, `list()`, `dictionary()`, ...) plus `Field` and `Schema`.
*
* For interchange, `tableToIPC` serializes a `Table` or `RecordBatch` to IPC
* bytes — the streaming format by default, `{ format: 'file' }` for the
* random-access file format, optionally with `lz4` or `zstd` body compression
* — and `tableFromIPC` decodes either format back into a `Table`. The
* `RecordBatchReader`/`RecordBatchFileReader` and
* `RecordBatchStreamWriter`/`RecordBatchFileWriter` classes expose the same
* machinery batch by batch. Malformed input throws `ArrowParseError`, which
* carries the failing byte offset and renders a hex dump of the offending
* region; structural misuse (ragged columns, mismatched schemas) throws
* `ArrowError`.
*
* ```ts no_run
* import { RecordBatch, tableToIPC, tableFromIPC } from 'fino:data/arrow';
*
* const batch = RecordBatch.from({ id: [1, 2, 3], name: ['a', 'b', 'c'] });
* const bytes = tableToIPC(batch);   // Arrow IPC stream bytes
* const table = tableFromIPC(bytes); // also accepts pyarrow/polars output
* table.getChild('name')!.toArray(); // ['a', 'b', 'c']
* ```
*
* Useful references:
*   - Arrow columnar format: https://arrow.apache.org/docs/format/Columnar.html
*   - Arrow IPC format: https://arrow.apache.org/docs/format/Columnar.html#serialization-and-interprocess-communication-ipc
*   - Arrow C Data Interface: https://arrow.apache.org/docs/format/CDataInterface.html
*/
export * from './type.ts';
export { Field, Schema } from './schema.ts';
export { Vector, makeVector, vectorFromArray, type VectorData } from './vector.ts';
export { RecordBatch } from './batch.ts';
export { Table, Column } from './table.ts';
export { ArrowError, ArrowParseError } from './errors.ts';
export { RecordBatchReader, RecordBatchFileReader, tableFromIPC, RecordBatchStreamWriter, RecordBatchFileWriter, tableToIPC, type IPCWriteOptions } from './ipc/reader.ts';
