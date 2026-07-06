/**
* Arrow `Table` — a schema plus a sequence of record batches (chunks) sharing
* it, with a chunked `Column` view for cross-batch access.
*
* Arrow data naturally arrives in batches: an IPC stream, a file, or a native
* producer hands over one `RecordBatch` at a time. A `Table` keeps those
* batches exactly as received — nothing is copied or concatenated — and layers
* logical accessors over them: `numRows` sums the batches, row iteration walks
* across batch boundaries, and `getChild`/`columnAt` return `Column` views
* that stitch one field's per-batch vectors into a single indexable sequence.
*
* Consumers usually obtain tables from `tableFromIPC` rather than building
* them by hand; both `Table` and `Column` are re-exported from the public
* `fino:data/arrow` module.
*
* ```ts no_run
* import { RecordBatch, Table } from 'fino:data/arrow';
*
* const jan = RecordBatch.from({ city: ['nyc', 'lyon'], temp: [-3, 4] });
* const feb = RecordBatch.from({ city: ['nyc', 'lyon'], temp: [1, 7] });
* const table = Table.from([jan, feb]);
*
* table.numRows;                     // 4
* table.getChild('temp')!.toArray(); // [-3, 4, 1, 7]
* ```
*
* Arrow columnar format: https://arrow.apache.org/docs/format/Columnar.html
*
* @internal
*/
import { ArrowError } from './errors.ts';
import { Schema } from './schema.ts';
import { Vector } from './vector.ts';
import { RecordBatch } from './batch.ts';
/**
* A logical column spanning a table's batches, addressed as one sequence.
*
* A column never copies data: it holds one `Vector` chunk per batch and
* translates a table-wide row index into a (chunk, local index) pair on each
* access. Columns are produced by `Table.getChild` and `Table.columnAt`; each
* call builds a fresh view over the table's batches.
*
* Values come back as the underlying vectors' raw physical values: `null` for
* nulls, `number` for widths up to 32 bits, `bigint` for 64-bit integers and
* timestamps, `string`, `Uint8Array` for binary, and arrays/objects for
* nested types.
*
* ```ts no_run
* import { RecordBatch, Table } from 'fino:data/arrow';
*
* const table = Table.from([
*   RecordBatch.from({ n: [1, 2] }),
*   RecordBatch.from({ n: [3, 4, 5] }),
* ]);
*
* const col = table.getChild('n')!;
* col.length;   // 5
* col.get(3);   // 4 — crosses the chunk boundary transparently
* [...col];     // [1, 2, 3, 4, 5]
* ```
*/
export class Column {
  /**
  * Per-batch chunk vectors.
  *
  * @internal
  */
  readonly chunks: Vector[];
  /** Total element count across chunks. */
  readonly length: number;
  #cursorChunk = 0;
  #cursorBase = 0;
  /** Wrap per-batch chunk vectors as one logical sequence. */
  constructor(chunks: Vector[]) {
    this.chunks = chunks;
    let n = 0;
    for (const c of chunks) n += c.length;
    this.length = n;
  }
  /**
  * Read element `i` across chunk boundaries.
  *
  * A cached cursor remembers which chunk served the previous read, so
  * sequential scans resolve their chunk in constant time; a read outside the
  * cached chunk falls back to a linear search from the first chunk. Indices
  * outside `[0, length)` are not range-checked.
  */
  get(i: number): unknown {
    if (i < this.#cursorBase || i >= this.#cursorBase + (this.chunks[this.#cursorChunk]?.length ?? 0)) {
      this.#cursorBase = 0;
      this.#cursorChunk = 0;
      for (let c = 0; c < this.chunks.length; c++) {
        const len = this.chunks[c]!.length;
        if (i < this.#cursorBase + len) {
          this.#cursorChunk = c;
          break;
        }
        this.#cursorBase += len;
      }
    }
    return this.chunks[this.#cursorChunk]?.get(i - this.#cursorBase);
  }
  /** Iterate values in row order across every chunk. */
  *[Symbol.iterator](): Iterator<unknown> {
    for (const chunk of this.chunks) yield* chunk;
  }
  /** Materialize the whole column as a plain array, in row order. */
  toArray(): unknown[] {
    const out: unknown[] = [];
    for (const chunk of this.chunks) for (const v of chunk) out.push(v);
    return out;
  }
}
/**
* A schema plus zero or more equally-shaped record batches.
*
* The table is a thin view over its batches: nothing is copied, and batches
* keep their identity (`batches` is the array passed in). Row iteration
* and `toArray` walk the batches in order, yielding each row as a plain
* `{ name: value }` object of raw physical values. Column access via
* `getChild`/`columnAt` returns chunked `Column` views instead of flattened
* arrays, so a multi-gigabyte IPC stream can be scanned without
* re-materializing its columns.
*
* Throws if any batch's column count differs from the table schema's field
* count; deeper type agreement between batches is the producer's
* responsibility.
*
* ```ts no_run
* import { RecordBatch, Table, tableFromIPC } from 'fino:data/arrow';
*
* // From batches produced locally...
* const table = Table.from([
*   RecordBatch.from({ id: [1, 2], name: ['ada', 'grace'] }),
*   RecordBatch.from({ id: [3], name: ['edsger'] }),
* ]);
*
* // ...or from Arrow IPC bytes (pyarrow, polars, DuckDB, ...).
* // const table = tableFromIPC(bytes);
*
* table.numRows;                    // 3
* table.getChild('name')!.get(2);   // 'edsger'
* for (const row of table) {
*   console.log(row.id, row.name);
* }
* ```
*/
export class Table {
  /** Table schema. */
  readonly schema: Schema;
  /** Constituent batches (chunks). */
  readonly batches: RecordBatch[];
  /** Total row count across batches. */
  readonly numRows: number;
  /**
  * Wrap `batches` under `schema`.
  *
  * Throws if a batch's schema has a different number of fields than
  * `schema`. An empty batch list is allowed and yields a zero-row table.
  */
  constructor(schema: Schema, batches: RecordBatch[]) {
    for (const batch of batches) {
      if (batch.schema.fields.length !== schema.fields.length) {
        throw new ArrowError('all batches in a table must share the schema');
      }
    }
    this.schema = schema;
    this.batches = batches;
    let n = 0;
    for (const b of batches) n += b.numRows;
    this.numRows = n;
  }
  /**
  * Build a table from batches, taking the schema from the first batch.
  *
  * Throws if `batches` is empty — use the constructor with an explicit
  * schema to represent a zero-batch table.
  */
  static from(batches: RecordBatch[]): Table {
    if (batches.length === 0) throw new ArrowError('Table.from requires at least one batch');
    return new Table(batches[0]!.schema, batches);
  }
  /** Number of columns. */
  get numColumns(): number {
    return this.schema.fields.length;
  }
  /**
  * A chunked `Column` view over the named field, or `undefined` when no
  * top-level field has that name. Each call builds a fresh view.
  */
  getChild(name: string): Column | undefined {
    const i = this.schema.fields.findIndex((f) => f.name === name);
    if (i < 0) return undefined;
    return new Column(this.batches.map((b) => b.columns[i]!));
  }
  /**
  * A chunked `Column` view over the field at position `i`. The position must
  * be within `[0, numColumns)`; it is not range-checked.
  */
  columnAt(i: number): Column {
    return new Column(this.batches.map((b) => b.columns[i]!));
  }
  /** Iterate rows as plain `{ name: value }` objects, batch by batch. */
  *[Symbol.iterator](): Iterator<Record<string, unknown>> {
    for (const batch of this.batches) yield* batch;
  }
  /** Materialize all rows as plain objects across batches, in row order. */
  toArray(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const batch of this.batches) for (const row of batch) out.push(row);
    return out;
  }
}
