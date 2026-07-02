/**
* Arrow `Table` — a schema plus a sequence of record batches (chunks) sharing
* it, with a chunked `Column` view for cross-batch access.
*
* @internal
*/
import { ArrowError } from './errors.ts';
import { Schema } from './schema.ts';
import { Vector } from './vector.ts';
import { RecordBatch } from './batch.ts';
/**
* A logical column spanning a table's batches, addressed as one sequence.
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
  constructor(chunks: Vector[]) {
    this.chunks = chunks;
    let n = 0;
    for (const c of chunks) n += c.length;
    this.length = n;
  }
  /** Read element `i` across chunk boundaries (cached cursor for scans). */
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
  *[Symbol.iterator](): Iterator<unknown> {
    for (const chunk of this.chunks) yield* chunk;
  }
  /** Materialize the column across all chunks. */
  toArray(): unknown[] {
    const out: unknown[] = [];
    for (const chunk of this.chunks) for (const v of chunk) out.push(v);
    return out;
  }
}
/**
* A schema plus zero or more equally-shaped record batches.
*/
export class Table {
  /** Table schema. */
  readonly schema: Schema;
  /** Constituent batches (chunks). */
  readonly batches: RecordBatch[];
  /** Total row count across batches. */
  readonly numRows: number;
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
  /** Build a table from batches, taking the schema from the first batch. */
  static from(batches: RecordBatch[]): Table {
    if (batches.length === 0) throw new ArrowError('Table.from requires at least one batch');
    return new Table(batches[0]!.schema, batches);
  }
  /** Number of columns. */
  get numColumns(): number {
    return this.schema.fields.length;
  }
  /** A chunked column view by field name. */
  getChild(name: string): Column | undefined {
    const i = this.schema.fields.findIndex((f) => f.name === name);
    if (i < 0) return undefined;
    return new Column(this.batches.map((b) => b.columns[i]!));
  }
  /** A chunked column view by position. */
  columnAt(i: number): Column {
    return new Column(this.batches.map((b) => b.columns[i]!));
  }
  *[Symbol.iterator](): Iterator<Record<string, unknown>> {
    for (const batch of this.batches) yield* batch;
  }
  /** All rows as plain objects across batches. */
  toArray(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const batch of this.batches) for (const row of batch) out.push(row);
    return out;
  }
}
