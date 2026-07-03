---
weight: 15
---
# Data Guide

Fino includes pure TypeScript data tooling for columnar in-memory data and file
interchange. The current public surface centers on Apache Arrow and Parquet.

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
