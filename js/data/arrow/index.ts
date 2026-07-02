/**
* fino:data/arrow - a pure-TypeScript implementation of Apache Arrow.
*
* Provides the Arrow columnar in-memory format (every logical type), the Arrow
* IPC stream and file formats for interchange with the Arrow ecosystem
* (pyarrow, polars, DuckDB, ...), and the Arrow C Data Interface for zero-copy
* hand-off to native libraries over `fino:ffi`.
*
* The object model is `Vector` (one column), `RecordBatch` (a schema plus one
* vector per field), and `Table` (a schema plus batches). `get(i)` returns raw
* physical values — `number` up to 32 bits, `bigint` for 64-bit ints and
* timestamps, `string`, `Uint8Array`, arrays/objects for nested types, and
* `null` for nulls. Build vectors with `vectorFromArray` (type inference) or
* `makeVector` (raw buffers), and move batches with `tableToIPC`/`tableFromIPC`.
*
* ```ts no_run
* import { RecordBatch, tableToIPC, tableFromIPC, Table } from 'fino:data/arrow';
*
* const batch = RecordBatch.from({ id: [1, 2, 3], name: ['a', 'b', 'c'] });
* const bytes = tableToIPC(batch);
* const table = tableFromIPC(bytes);
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
