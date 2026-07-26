/**
 * Arrow `Field` and `Schema` — the name/type layer of the Arrow object model.
 *
 * A `Field` binds a column (or nested child) name to a `DataType`, a
 * nullability declaration, and optional key/value metadata. A `Schema` is an
 * ordered list of fields plus schema-level metadata, and describes the shape
 * of a `RecordBatch` or `Table`. Both are plain immutable value objects:
 * constructing them performs no validation, and metadata maps are stored by
 * reference rather than copied.
 *
 * Nullability and metadata are declarative. They round-trip through Arrow IPC
 * (`internal:data/arrow/ipc/metadata`), surface as flags in the C Data
 * Interface (`fino:data/arrow/cdata`), and participate in `typeEquals`
 * comparisons of nested types — but nothing here rejects null values in a
 * column whose field is declared non-nullable.
 *
 * Both classes are re-exported publicly from `fino:data/arrow`.
 *
 * ```ts no_run
 * import { Schema, Field, int64, utf8, timestamp, TimeUnit } from 'fino:data/arrow';
 *
 * const schema = new Schema([
 *   new Field('id', int64(), false),
 *   new Field('name', utf8()),
 *   new Field('seen', timestamp(TimeUnit.MILLISECOND, 'UTC')),
 * ]);
 * schema.field('name')?.type.kind; // 'utf8'
 * ```
 *
 * Arrow schema reference: https://arrow.apache.org/docs/format/Columnar.html#schema
 *
 * @internal
 */
import type { DataType } from './type.ts';
/**
 * A named, nullable column type with optional key/value metadata.
 *
 * Fields compose recursively to describe nested types: `list`, `fixedSizeList`,
 * `map`, `union`, and `runEndEncoded` types each carry child fields, and
 * `struct` carries one field per member. `nullable` defaults to `true`,
 * matching Arrow's convention that a column admits nulls unless declared
 * otherwise.
 *
 * Instances are immutable — to "change" a field, construct a new one.
 *
 * ```ts no_run
 * import { Field, list, float64, struct, utf8 } from 'fino:data/arrow';
 *
 * const readings = new Field('readings', list(new Field('item', float64(), false)));
 * const meta = new Field('meta', struct([new Field('tag', utf8())]), true,
 *   new Map([['origin', 'sensor-7']]));
 * ```
 */
export class Field {
  /** Column (or nested child) name as it appears in the schema. */
  readonly name: string;
  /** Logical Arrow type of the field's values. */
  readonly type: DataType;
  /**
   * Whether the field is declared to admit nulls. Carried through IPC metadata
   * and the C Data Interface flags, but never enforced against actual column
   * data.
   */
  readonly nullable: boolean;
  /**
   * Field-level key/value metadata, or `null` when absent. Stored by reference
   * and serialized alongside the field in Arrow IPC.
   */
  readonly metadata: Map<string, string> | null;
  constructor(
    name: string,
    type: DataType,
    nullable = true,
    metadata: Map<string, string> | null = null,
  ) {
    this.name = name;
    this.type = type;
    this.nullable = nullable;
    this.metadata = metadata;
  }
  /**
   * Build a field; a convenience mirror of the constructor that also accepts
   * `undefined` metadata (normalized to `null`).
   */
  static new(
    name: string,
    type: DataType,
    nullable = true,
    metadata?: Map<string, string> | null,
  ): Field {
    return new Field(name, type, nullable, metadata ?? null);
  }
}
/**
 * An ordered list of fields plus schema-level metadata: the type of a
 * `RecordBatch` or `Table`.
 *
 * Column order is significant — the vectors of a `RecordBatch` align
 * positionally with `fields`. The constructor performs no validation:
 * duplicate field names are permitted, and `field()` simply returns the first
 * match.
 *
 * ```ts no_run
 * import { Schema, Field, int32, utf8 } from 'fino:data/arrow';
 *
 * const inferred = Schema.from({ id: int32(), name: utf8() });
 * const strict = new Schema(
 *   [new Field('id', int32(), false), new Field('name', utf8())],
 *   new Map([['version', '2']]),
 * );
 * strict.field('id')?.nullable; // false
 * ```
 */
export class Schema {
  /** Top-level fields, in column order. */
  readonly fields: Field[];
  /**
   * Schema-level key/value metadata, or `null` when absent. Stored by
   * reference and serialized with the schema in Arrow IPC.
   */
  readonly metadata: Map<string, string> | null;
  constructor(fields: Field[], metadata: Map<string, string> | null = null) {
    this.fields = fields;
    this.metadata = metadata;
  }
  /**
   * Build a schema from an array of fields, or from a `{ name: type }` record
   * for the common all-nullable case.
   *
   * With the record form, property insertion order becomes column order, every
   * field is nullable, and no per-field metadata is attached — pass `Field`
   * instances instead when any of those need control.
   *
   * ```ts no_run
   * import { Schema, int64, utf8, float64 } from 'fino:data/arrow';
   *
   * const schema = Schema.from({ id: int64(), name: utf8(), score: float64() });
   * schema.fields.map((f) => f.name); // ['id', 'name', 'score']
   * ```
   */
  static from(
    fields: Field[] | Record<string, DataType>,
    metadata?: Map<string, string> | null,
  ): Schema {
    if (Array.isArray(fields)) return new Schema(fields, metadata ?? null);
    return new Schema(
      Object.entries(fields).map(([name, type]) => new Field(name, type, true)),
      metadata ?? null,
    );
  }
  /**
   * Look up a top-level field by name, returning `undefined` when no field
   * matches. Does not descend into the children of nested types.
   */
  field(name: string): Field | undefined {
    return this.fields.find((f) => f.name === name);
  }
}
