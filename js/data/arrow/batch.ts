/**
* Arrow `RecordBatch` — a schema plus one column vector per field.
*
* @internal
*/
import { ArrowError } from './errors.ts';
import { Schema, Field } from './schema.ts';
import { Vector, vectorFromArray } from './vector.ts';
import type { DataType } from './type.ts';
/**
* A batch of equal-length columns described by a `Schema`.
*/
export class RecordBatch {
  /** Column schema. */
  readonly schema: Schema;
  /** Column vectors, aligned with `schema.fields`. */
  readonly columns: Vector[];
  /** Row count (shared by all columns). */
  readonly numRows: number;
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
  * explicit schema and column vectors.
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
  /** Column vector by name. */
  getChild(name: string): Vector | undefined {
    const i = this.schema.fields.findIndex((f) => f.name === name);
    return i < 0 ? undefined : this.columns[i];
  }
  /** Column vector by position. */
  columnAt(i: number): Vector | undefined {
    return this.columns[i];
  }
  /** Row `i` as a plain object keyed by field name. */
  row(i: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let c = 0; c < this.columns.length; c++) out[this.schema.fields[c]!.name] = this.columns[c]!.get(i);
    return out;
  }
  *[Symbol.iterator](): Iterator<Record<string, unknown>> {
    for (let i = 0; i < this.numRows; i++) yield this.row(i);
  }
  /** All rows as plain objects. */
  toArray(): Record<string, unknown>[] {
    const out = new Array<Record<string, unknown>>(this.numRows);
    for (let i = 0; i < this.numRows; i++) out[i] = this.row(i);
    return out;
  }
  /** A zero-copy row sub-range. */
  slice(begin = 0, end: number = this.numRows): RecordBatch {
    return new RecordBatch(this.schema, this.columns.map((c) => c.slice(begin, end)));
  }
}
export type { DataType };
