/**
* Arrow `RecordBatch` — a schema plus one column vector per field.
*
* A record batch is Arrow's unit of columnar data interchange: an immutable
* pairing of a `Schema` with one equal-length `Vector` per field. The pairing
* is validated eagerly — a field/column count mismatch or ragged column
* lengths throw `ArrowError` — so a constructed batch is always internally
* consistent, and `numRows` needs no further checking downstream.
*
* Batches are cheap views over their columns. `slice` returns a new batch
* whose vectors share the underlying buffers (zero-copy); the row-wise
* accessors (`row`, `toArray`, iteration) materialize plain objects on demand
* and exist for convenience, not hot paths — prefer `getChild` plus column
* operations for bulk work. Values surface with the physical semantics of
* `Vector.get`: `number` for widths up to 32 bits, `bigint` for 64-bit
* integers and timestamps, and `null` for null slots.
*
* This module is re-exported through `fino:data/arrow`; import from there.
*
* ```ts no_run
* import { RecordBatch } from 'fino:data/arrow';
*
* const batch = RecordBatch.from({ id: [1, 2, 3], name: ['a', 'b', 'c'] });
* batch.numRows;                     // 3
* batch.getChild('name')!.toArray(); // ['a', 'b', 'c']
* [...batch.slice(1)];               // [{ id: 2, name: 'b' }, { id: 3, name: 'c' }]
* ```
*
* Arrow columnar format: https://arrow.apache.org/docs/format/Columnar.html
*
* @internal
*/
import { ArrowError } from './errors.ts';
import { Schema, Field } from './schema.ts';
import { Vector, vectorFromArray } from './vector.ts';
import type { DataType } from './type.ts';
/**
* A batch of equal-length columns described by a `Schema`.
*
* Construct directly when the schema and typed vectors are already in hand
* (the IPC reader and C Data importer do this), or use `RecordBatch.from` to
* build one from plain JS arrays with inferred types. All fields are
* read-only after construction.
*
* ```ts no_run
* import { RecordBatch, Schema, vectorFromArray, int32, utf8 } from 'fino:data/arrow';
*
* const batch = new RecordBatch(
*   Schema.from({ id: int32(), name: utf8() }),
*   [vectorFromArray([1, 2], int32()), vectorFromArray(['a', 'b'], utf8())],
* );
* batch.row(0); // { id: 1, name: 'a' }
* ```
*/
export class RecordBatch {
  /** Column schema; `schema.fields[i]` describes `columns[i]`. */
  readonly schema: Schema;
  /** Column vectors, aligned with `schema.fields`. */
  readonly columns: Vector[];
  /** Row count shared by every column (`0` for a zero-column batch). */
  readonly numRows: number;
  /**
  * Pair `schema` with `columns`.
  *
  * Throws `ArrowError` if the number of columns differs from the number of
  * schema fields, or if the columns are not all the same length.
  */
  constructor(schema: Schema, columns: Vector[]) {
    if (schema.fields.length !== columns.length) {
      throw new ArrowError(`schema has ${schema.fields.length} fields but ${columns.length} columns were provided`);
    }
    const numRows = columns.length > 0 ? columns[0]!.length : 0;
    for (const col of columns) {
      if (col.length !== numRows) throw new ArrowError('all columns in a record batch must have the same length');
    }
    this.schema = schema;
    this.columns = columns;
    this.numRows = numRows;
  }
  /**
  * Build a record batch from `{ name: values[] }` (types inferred) or from an
  * explicit `{ schema, columns }` pair.
  *
  * In the record form each entry becomes one column via `vectorFromArray`:
  * JS `number`s infer Float64, `bigint`s Int64, `string`s Utf8, `boolean`s
  * Bool, arrays List, and plain objects Struct. A field is marked nullable
  * only when its values actually contain `null` or `undefined`. When the
  * inferred types are not what a consumer expects — integer ids that should
  * be Int32 rather than Float64, say — build the vectors explicitly and pass
  * the `{ schema, columns }` form instead.
  *
  * ```ts no_run
  * import { RecordBatch } from 'fino:data/arrow';
  *
  * const batch = RecordBatch.from({
  *   id: [1n, 2n, 3n],           // bigint → Int64
  *   name: ['ada', 'lin', null], // string → Utf8, marked nullable
  * });
  * batch.schema.fields.map((f) => f.type.kind); // ['int', 'utf8']
  * ```
  */
  static from(input: Record<string, unknown[]> | {
    schema: Schema;
    columns: Vector[];
  }): RecordBatch {
    if ('schema' in input && 'columns' in input) return new RecordBatch(input.schema, input.columns);
    const fields: Field[] = [];
    const columns: Vector[] = [];
    for (const [name, values] of Object.entries(input)) {
      const vec = vectorFromArray(values);
      fields.push(new Field(name, vec.type, vec.nullCount > 0));
      columns.push(vec);
    }
    return new RecordBatch(new Schema(fields), columns);
  }
  /** Number of columns. */
  get numColumns(): number {
    return this.columns.length;
  }
  /**
  * Column vector for the first field named `name`, or `undefined` when no
  * such field exists.
  */
  getChild(name: string): Vector | undefined {
    const i = this.schema.fields.findIndex((f) => f.name === name);
    return i < 0 ? undefined : this.columns[i];
  }
  /** Column vector at position `i`, or `undefined` when out of range. */
  columnAt(i: number): Vector | undefined {
    return this.columns[i];
  }
  /**
  * Materialize row `i` as a plain object keyed by field name.
  *
  * Builds a fresh object on every call; for bulk numeric work prefer
  * `getChild` and column-wise access.
  */
  row(i: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let c = 0; c < this.columns.length; c++) out[this.schema.fields[c]!.name] = this.columns[c]!.get(i);
    return out;
  }
  /** Iterate rows in order, each materialized as a plain object via `row`. */
  *[Symbol.iterator](): Iterator<Record<string, unknown>> {
    for (let i = 0; i < this.numRows; i++) yield this.row(i);
  }
  /** All rows as plain objects; equivalent to spreading the batch. */
  toArray(): Record<string, unknown>[] {
    const out = new Array<Record<string, unknown>>(this.numRows);
    for (let i = 0; i < this.numRows; i++) out[i] = this.row(i);
    return out;
  }
  /**
  * A zero-copy row sub-range: the returned batch shares column buffers with
  * this one. `end` is exclusive and clamped to `numRows`; negative indices
  * are not supported.
  */
  slice(begin = 0, end: number = this.numRows): RecordBatch {
    return new RecordBatch(this.schema, this.columns.map((c) => c.slice(begin, end)));
  }
}
/** Re-export of the logical column type union used by `Schema` fields. */
export type { DataType };
