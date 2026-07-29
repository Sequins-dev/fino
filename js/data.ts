/**
 * fino:data - data engineering and interchange formats.
 *
 * Umbrella entry point for fino's data toolbox. Rather than exporting symbols
 * directly, it groups each data surface under a namespace so related types
 * travel together and additional surfaces can attach here without colliding.
 * The module exposes the `arrow` and `dataset` namespaces.
 *
 * The `arrow` namespace is a pure-TypeScript Apache Arrow implementation:
 * the columnar in-memory format (every logical type), the IPC stream and file
 * formats for interchange with the wider Arrow ecosystem (pyarrow, polars,
 * DuckDB, ...), and the Arrow C Data Interface for zero-copy hand-off to
 * native libraries over `fino:ffi`. It is a re-export of `fino:data/arrow` —
 * importing either specifier yields the same module instance, so prefer the
 * namespaced form here when mixing data surfaces and the direct specifier
 * when only Arrow is needed.
 *
 * The `dataset` namespace is the shared ingestion path for deterministic
 * indexed data, lazy async streams, source adapters, seeded transforms, and
 * pull-driven batching. Tabular binary adapters yield Arrow record batches;
 * row adapters cross into Arrow explicitly through `arrowCollator`.
 *
 * ```ts no_run
 * import { arrow } from 'fino:data';
 *
 * const batch = arrow.RecordBatch.from({ id: [1, 2, 3], name: ['a', 'b', 'c'] });
 * const bytes = arrow.tableToIPC(batch);
 * const table = arrow.tableFromIPC(bytes);
 * console.log(table.numRows); // 3
 * ```
 *
 * Arrow columnar format: https://arrow.apache.org/docs/format/Columnar.html
 */
/**
 * Apache Arrow columnar data: vectors, record batches, tables, IPC, and the
 * C Data Interface.
 *
 * The object model is `Vector` (one column), `RecordBatch` (a schema plus one
 * vector per field), and `Table` (a schema plus batches). Build vectors with
 * `vectorFromArray` (type inference) or `makeVector` (raw buffers), and move
 * data across process boundaries with `tableToIPC`/`tableFromIPC` or the
 * streaming reader/writer classes. See `fino:data/arrow` for the full API.
 *
 * ```ts no_run
 * import { arrow } from 'fino:data';
 *
 * const batch = arrow.RecordBatch.from({ age: [32, 27, null, 45] });
 * console.log(batch.numRows);                 // 4
 * console.log(batch.getChild('age')!.get(2)); // null
 * ```
 */
export * as arrow from 'fino:data/arrow';
/**
 * Deterministic random-access and streaming datasets, lazy transforms,
 * source adapters, and pull-driven batching/collation.
 *
 * Use `Dataset` for in-memory indexed values and `IterableDataset` for lazy
 * or streaming sources. `DataLoader` adds explicit batching, seeded shuffle,
 * and custom collation; adapters cover CSV, JSONL, Arrow IPC, Parquet, SQLite,
 * HTTP, and revision-addressed hubs. See `fino:data/dataset` for the full API.
 *
 * ```ts no_run
 * import { dataset } from 'fino:data';
 *
 * const source = dataset.Dataset.from([1, 2, 3, 4]);
 * const loader = new dataset.DataLoader(source, { batchSize: 2 });
 * for await (const batch of loader) console.log(batch);
 * ```
 */
export * as dataset from 'fino:data/dataset';
