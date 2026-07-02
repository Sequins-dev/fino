/**
* Arrow `Field` and `Schema`.
*
* @internal
*/
import type { DataType } from './type.ts';
/**
* A named, nullable column type with optional key/value metadata. Fields
* compose recursively to describe nested types (list child, struct children).
*/
export class Field {
  /** Field name. */
  readonly name: string;
  /** Field type. */
  readonly type: DataType;
  /** Whether the field admits nulls. */
  readonly nullable: boolean;
  /** Field-level custom metadata, or `null`. */
  readonly metadata: Map<string, string> | null;
  constructor(name: string, type: DataType, nullable = true, metadata: Map<string, string> | null = null) {
    this.name = name;
    this.type = type;
    this.nullable = nullable;
    this.metadata = metadata;
  }
  /** Build a field; a convenience mirror of the constructor. */
  static new(name: string, type: DataType, nullable = true, metadata?: Map<string, string> | null): Field {
    return new Field(name, type, nullable, metadata ?? null);
  }
}
/**
* An ordered list of fields plus schema-level metadata: the type of a
* `RecordBatch` or `Table`.
*/
export class Schema {
  /** Top-level fields, in column order. */
  readonly fields: Field[];
  /** Schema-level custom metadata, or `null`. */
  readonly metadata: Map<string, string> | null;
  constructor(fields: Field[], metadata: Map<string, string> | null = null) {
    this.fields = fields;
    this.metadata = metadata;
  }
  /**
  * Build a schema from fields, or from a `{ name: type }` record for the common
  * all-nullable case.
  */
  static from(fields: Field[] | Record<string, DataType>, metadata?: Map<string, string> | null): Schema {
    if (Array.isArray(fields)) return new Schema(fields, metadata ?? null);
    return new Schema(Object.entries(fields).map(([name, type]) => new Field(name, type, true)), metadata ?? null);
  }
  /** Look up a top-level field by name. */
  field(name: string): Field | undefined {
    return this.fields.find((f) => f.name === name);
  }
}
