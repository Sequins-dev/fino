---
weight: 140
---
# Data

Fino includes pure TypeScript data tooling for columnar in-memory data, file
interchange, and deterministic streaming ingestion. The public surface centers
on Apache Arrow, Parquet, and the shared Dataset/DataLoader pipeline.

## Arrow

`fino:data` exposes the `arrow` namespace for schemas, arrays, vectors,
record batches, tables, IPC readers/writers, and the C Data Interface:

```ts no_run
import { arrow } from 'fino:data';

const batch = arrow.RecordBatch.from({ id: [1, 2], name: ['a', 'b'] });
const table = new arrow.Table(batch.schema, [batch]);
console.log(table.numRows);
```

Use Arrow when data should stay columnar in memory or cross a boundary through
Arrow IPC or C Data Interface conventions.

## Datasets and loading

`fino:data/dataset` provides the lazy ingestion contract used by evaluation,
memory, and batch workflows. `Dataset` snapshots finite indexed values;
`IterableDataset` composes synchronous and asynchronous sources through
`map`, `filter`, buffered `shuffle`, `batch`, `take`, `split`, and
`interleave`. `DataLoader` adds pull-driven batching and explicit collation:

```ts no_run
import {
  DataLoader,
  csvDataset,
  arrowCollator,
} from 'fino:data/dataset';

const rows = csvDataset('id,text\n1,hello\n2,world\n', {
  header: true,
  cast: true,
});
const loader = new DataLoader(rows, {
  batchSize: 128,
  shuffle: { bufferSize: 2048 },
  seed: 7,
  collate: arrowCollator,
});

for await (const batch of loader.forEpoch(0)) {
  console.log(batch.numRows);
}
```

CSV, JSONL, SQLite, HTTP, and hub adapters yield rows. Arrow IPC and Parquet
adapters yield `RecordBatch` objects directly. Iteration is pull-driven and
cancelable; realm workers, shared-memory collation, and durable checkpoint
state are layered onto the same contract rather than exposed as a second
loader API.

## DataFrames

`fino:data/frame` builds immutable lazy plans over Arrow record batches. Its
bounded operator set covers expression-based filter and projection, computed
columns, group aggregation, joins, stable sort, and limit:

```ts no_run
import { DataFrame, col, count } from 'fino:data/frame';

const report = DataFrame
  .scanParquet<{ team: string; score: number }>(bytes)
  .filter(col<number>('score').gte(0.8))
  .groupBy('team')
  .agg({
    rows: count(),
    average: col<number>('score').mean(),
  })
  .sort(col<string>('team').asc());

const table = await report.collect();
```

Use `frame.col('name')` when a `DataFrame<Row>` should check column names and
types, and standalone `col<T>('name')` for reusable expressions. Comparisons
and arithmetic propagate null, filters retain only `true`, aggregates ignore
null inputs, and joins suffix colliding right-side fields rather than
overwriting them.

Parquet scans push required top-level columns into decoding and use simple
predicate statistics to skip only row groups proven not to match. Unsupported
or missing statistics fall back to decoding and post-scan filtering, preserving
results.

## Parquet

`fino:data/parquet` reads and writes Parquet bytes using Arrow tables and record
batches:

```ts no_run
import { readParquet, writeParquet } from 'fino:data/parquet';

const bytes = writeParquet(table);
const restored = readParquet(bytes);
```

Parquet support is intended for local interchange, fixtures, and data pipelines
inside Fino applications. Unsupported encodings, nested shapes, or compression
codecs should fail clearly rather than silently changing data.
