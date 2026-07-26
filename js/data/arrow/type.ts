/**
 * Apache Arrow logical type system.
 *
 * Types are plain immutable objects tagged by a numeric `typeId` matching the
 * Arrow IPC `Type` union, plus a readable `kind` string that narrows the
 * `DataType` union in a `switch`. Factory functions (`int32()`, `utf8()`,
 * `list(...)`, ...) build them; the introspection helpers (`bufferLayout`,
 * `childFields`, `fixedWidthBytes`, `hasVariadicBuffers`) describe the
 * columnar memory layout shared by vectors, IPC serialization, and the
 * C Data Interface.
 *
 * Because types are bare object literals rather than class instances, they
 * serialize cleanly, compare structurally (`typeEquals`), and cross realm
 * boundaries without any prototype fixup. Nested types embed `Field` objects
 * from `internal:data/arrow/schema` so child name, nullability, and metadata
 * travel with the type.
 *
 * Everything here is re-exported from the public `fino:data/arrow` module,
 * which is what application code should import.
 *
 * ```ts no_run
 * import { int32, utf8, list, struct, bufferLayout, Field } from 'fino:data/arrow';
 *
 * const point = struct([
 *   new Field('x', int32(), false),
 *   new Field('y', int32(), false),
 * ]);
 * const tags = list(new Field('item', utf8()));
 *
 * bufferLayout(tags);  // ['validity', 'offset32']
 * bufferLayout(point); // ['validity']
 * ```
 *
 * Arrow columnar format: https://arrow.apache.org/docs/format/Columnar.html
 *
 * @internal
 */
import type { Field } from './schema.ts';
/**
 * Arrow `Type` union tags (from Schema.fbs). Used as the `typeId` on every
 * `DataType` and as the union discriminant in IPC metadata.
 *
 * Prefer matching on a type's `kind` string in JS code; the numeric ids exist
 * for IPC and C Data Interface interop.
 */
export const Type = {
  Null: 1,
  Int: 2,
  Float: 3,
  Binary: 4,
  Utf8: 5,
  Bool: 6,
  Decimal: 7,
  Date: 8,
  Time: 9,
  Timestamp: 10,
  Interval: 11,
  List: 12,
  Struct: 13,
  Union: 14,
  FixedSizeBinary: 15,
  FixedSizeList: 16,
  Map: 17,
  Duration: 18,
  LargeBinary: 19,
  LargeUtf8: 20,
  LargeList: 21,
  RunEndEncoded: 22,
  BinaryView: 23,
  Utf8View: 24,
  ListView: 25,
  LargeListView: 26,
} as const;
/**
 * Time/timestamp/duration units (Arrow `TimeUnit`), from whole seconds down
 * to nanoseconds. Passed to `time32`/`time64`/`timestamp`/`duration` and
 * stored on the resulting type's `unit` property.
 */
export const TimeUnit = {
  SECOND: 0,
  MILLISECOND: 1,
  MICROSECOND: 2,
  NANOSECOND: 3,
} as const;
/**
 * Date units (Arrow `DateUnit`): `DAY` for `date32` (days since the Unix
 * epoch) and `MILLISECOND` for `date64` (milliseconds since the Unix epoch).
 */
export const DateUnit = {
  DAY: 0,
  MILLISECOND: 1,
} as const;
/**
 * Interval units (Arrow `IntervalUnit`). Selects the physical encoding of an
 * `interval(...)` type: a 4-byte month count (`YEAR_MONTH`), an 8-byte
 * day + millisecond pair (`DAY_TIME`), or a 16-byte month/day/nanosecond
 * triple (`MONTH_DAY_NANO`).
 */
export const IntervalUnit = {
  YEAR_MONTH: 0,
  DAY_TIME: 1,
  MONTH_DAY_NANO: 2,
} as const;
/**
 * Union modes (Arrow `UnionMode`). `Sparse` unions store every child column
 * at the union's full length; `Dense` unions add a 32-bit offsets buffer so
 * each child stores only its own values.
 */
export const UnionMode = {
  Sparse: 0,
  Dense: 1,
} as const;
/**
 * Floating-point precisions (Arrow `Precision`): half (16-bit), single
 * (32-bit), and double (64-bit). Stored on `FloatType.precision`.
 */
export const Precision = {
  HALF: 0,
  SINGLE: 1,
  DOUBLE: 2,
} as const;
/**
 * A logical component of a type's physical buffer layout, in Arrow order.
 *
 * `validity` is the null bitmap, `offset32`/`offset64` are value offsets,
 * `size32`/`size64` are list-view sizes, `data` is the values buffer,
 * `typeIds` is the union type-id buffer, and `views` is the 16-byte view
 * buffer used by the Utf8View/BinaryView types.
 */
export type BufferKind =
  | 'validity'
  | 'offset32'
  | 'offset64'
  | 'size32'
  | 'size64'
  | 'data'
  | 'typeIds'
  | 'views';
/** Base shape shared by every `DataType`. */
export interface BaseType {
  /** Numeric Arrow `Type` union tag, for IPC and C Data Interface interop. */
  readonly typeId: number;
  /** Lowercase discriminant string that narrows the `DataType` union. */
  readonly kind: string;
}
/**
 * The null type: every value is null, and no buffers are allocated at all.
 *
 * ```ts no_run
 * import { nullType, bufferLayout } from 'fino:data/arrow';
 *
 * const t = nullType();
 * bufferLayout(t); // []
 * ```
 */
export interface NullType extends BaseType {
  kind: 'null';
  typeId: 1;
}
/**
 * Boolean type. Values are bit-packed in the data buffer, eight per byte, so
 * `fixedWidthBytes` reports 0 for it despite the fixed layout.
 *
 * ```ts no_run
 * import { bool } from 'fino:data/arrow';
 *
 * const t = bool(); // { kind: 'bool', typeId: 6 }
 * ```
 */
export interface BoolType extends BaseType {
  kind: 'bool';
  typeId: 6;
}
/**
 * Fixed-width integer of 8 to 64 bits, signed or unsigned. Built by the
 * `int8`..`int64` and `uint8`..`uint64` factories.
 *
 * ```ts no_run
 * import { int32, uint64 } from 'fino:data/arrow';
 *
 * const a = int32();  // bitWidth 32, signed true
 * const b = uint64(); // bitWidth 64, signed false
 * ```
 */
export interface IntType extends BaseType {
  kind: 'int';
  typeId: 2;
  /** Bits per value: 8, 16, 32, or 64. */
  bitWidth: 8 | 16 | 32 | 64;
  /** Whether values are two's-complement signed. */
  signed: boolean;
}
/**
 * IEEE 754 floating-point number in half, single, or double precision.
 *
 * ```ts no_run
 * import { float64, Precision } from 'fino:data/arrow';
 *
 * const t = float64();
 * t.precision === Precision.DOUBLE; // true
 * ```
 */
export interface FloatType extends BaseType {
  kind: 'float';
  typeId: 3;
  /** One of the `Precision` constants: HALF, SINGLE, or DOUBLE. */
  precision: number;
}
/**
 * Fixed-point decimal: `precision` total significant digits with `scale`
 * digits after the decimal point, stored as a little-endian two's-complement
 * integer of `bitWidth` bits.
 *
 * ```ts no_run
 * import { decimal } from 'fino:data/arrow';
 *
 * const money = decimal(38, 9); // 128-bit storage by default
 * ```
 */
export interface DecimalType extends BaseType {
  kind: 'decimal';
  typeId: 7;
  /** Total number of significant digits. */
  precision: number;
  /** Number of digits after the decimal point. */
  scale: number;
  /** Storage width in bits. */
  bitWidth: 32 | 64 | 128 | 256;
}
/**
 * Calendar date. `DateUnit.DAY` stores 32-bit days since the Unix epoch
 * (`date32`); `DateUnit.MILLISECOND` stores 64-bit milliseconds since the
 * epoch (`date64`).
 *
 * ```ts no_run
 * import { date32, DateUnit } from 'fino:data/arrow';
 *
 * const t = date32();
 * t.unit === DateUnit.DAY; // true
 * ```
 */
export interface DateType extends BaseType {
  kind: 'date';
  typeId: 8;
  /** One of the `DateUnit` constants: DAY or MILLISECOND. */
  unit: number;
}
/**
 * Time of day since midnight, as a 32- or 64-bit integer in `unit`
 * resolution. The Arrow spec pairs 32-bit storage with second/millisecond
 * units and 64-bit storage with microsecond/nanosecond units.
 *
 * ```ts no_run
 * import { time64, TimeUnit } from 'fino:data/arrow';
 *
 * const t = time64(TimeUnit.NANOSECOND); // bitWidth 64
 * ```
 */
export interface TimeType extends BaseType {
  kind: 'time';
  typeId: 9;
  /** One of the `TimeUnit` constants. */
  unit: number;
  /** Storage width in bits: 32 for time32, 64 for time64. */
  bitWidth: 32 | 64;
}
/**
 * An instant: a 64-bit count of `unit` intervals since the Unix epoch. With
 * a `timezone` the values are absolute instants displayed in that zone; with
 * `timezone: null` they are zone-naive wall-clock readings.
 *
 * ```ts no_run
 * import { timestamp, TimeUnit } from 'fino:data/arrow';
 *
 * const utc = timestamp(TimeUnit.MILLISECOND, 'UTC');
 * const naive = timestamp(); // microseconds, no timezone
 * ```
 */
export interface TimestampType extends BaseType {
  kind: 'timestamp';
  typeId: 10;
  /** One of the `TimeUnit` constants. */
  unit: number;
  /** IANA zone name or fixed offset string, or `null` for zone-naive. */
  timezone: string | null;
}
/**
 * Calendar interval. The `unit` selects the physical encoding: months only
 * (`YEAR_MONTH`), days plus milliseconds (`DAY_TIME`), or months, days, and
 * nanoseconds (`MONTH_DAY_NANO`).
 *
 * ```ts no_run
 * import { interval, IntervalUnit } from 'fino:data/arrow';
 *
 * const t = interval(IntervalUnit.MONTH_DAY_NANO); // 16 bytes per value
 * ```
 */
export interface IntervalType extends BaseType {
  kind: 'interval';
  typeId: 11;
  /** One of the `IntervalUnit` constants. */
  unit: number;
}
/**
 * Elapsed time as a 64-bit integer count of `unit` intervals, with no
 * calendar semantics (unlike `IntervalType`).
 *
 * ```ts no_run
 * import { duration, TimeUnit } from 'fino:data/arrow';
 *
 * const t = duration(TimeUnit.NANOSECOND);
 * ```
 */
export interface DurationType extends BaseType {
  kind: 'duration';
  typeId: 18;
  /** One of the `TimeUnit` constants. */
  unit: number;
}
/**
 * Variable-length UTF-8 string with 32-bit offsets, which caps a single
 * column chunk's string data at 2 GiB. Use `LargeUtf8Type` beyond that.
 *
 * ```ts no_run
 * import { utf8, bufferLayout } from 'fino:data/arrow';
 *
 * bufferLayout(utf8()); // ['validity', 'offset32', 'data']
 * ```
 */
export interface Utf8Type extends BaseType {
  kind: 'utf8';
  typeId: 5;
}
/**
 * Variable-length UTF-8 string with 64-bit offsets, for columns whose string
 * data may exceed the 2 GiB limit of `Utf8Type`.
 *
 * ```ts no_run
 * import { largeUtf8, bufferLayout } from 'fino:data/arrow';
 *
 * bufferLayout(largeUtf8()); // ['validity', 'offset64', 'data']
 * ```
 */
export interface LargeUtf8Type extends BaseType {
  kind: 'largeutf8';
  typeId: 20;
}
/**
 * Variable-length byte string with 32-bit offsets. Same layout as
 * `Utf8Type` but with no UTF-8 validity guarantee.
 *
 * ```ts no_run
 * import { binary } from 'fino:data/arrow';
 *
 * const t = binary(); // { kind: 'binary', typeId: 4 }
 * ```
 */
export interface BinaryType extends BaseType {
  kind: 'binary';
  typeId: 4;
}
/**
 * Variable-length byte string with 64-bit offsets, for columns whose data
 * may exceed the 2 GiB limit of `BinaryType`.
 *
 * ```ts no_run
 * import { largeBinary } from 'fino:data/arrow';
 *
 * const t = largeBinary(); // { kind: 'largebinary', typeId: 19 }
 * ```
 */
export interface LargeBinaryType extends BaseType {
  kind: 'largebinary';
  typeId: 19;
}
/**
 * UTF-8 string in the view ("German string") layout: each value is a 16-byte
 * view that inlines strings of 12 bytes or fewer and otherwise points into
 * one of a variadic set of data buffers. Views make take/filter cheap because
 * only the fixed-size view buffer is rewritten.
 *
 * ```ts no_run
 * import { utf8View, hasVariadicBuffers } from 'fino:data/arrow';
 *
 * hasVariadicBuffers(utf8View()); // true
 * ```
 */
export interface Utf8ViewType extends BaseType {
  kind: 'utf8view';
  typeId: 24;
}
/**
 * Byte string in the view layout: 16-byte views with short values inlined
 * and long values referencing variadic data buffers. The binary counterpart
 * of `Utf8ViewType`.
 *
 * ```ts no_run
 * import { binaryView, bufferLayout } from 'fino:data/arrow';
 *
 * bufferLayout(binaryView()); // ['validity', 'views']
 * ```
 */
export interface BinaryViewType extends BaseType {
  kind: 'binaryview';
  typeId: 23;
}
/**
 * Byte string of exactly `byteWidth` bytes per value, stored contiguously
 * with no offsets buffer. Common for hashes, UUIDs, and fixed-size codes.
 *
 * ```ts no_run
 * import { fixedSizeBinary } from 'fino:data/arrow';
 *
 * const uuid = fixedSizeBinary(16);
 * ```
 */
export interface FixedSizeBinaryType extends BaseType {
  kind: 'fixedsizebinary';
  typeId: 15;
  /** Exact size of every value in bytes. */
  byteWidth: number;
}
/**
 * Variable-length list with 32-bit offsets. The element type, name, and
 * nullability come from the `child` field.
 *
 * ```ts no_run
 * import { list, int32, Field } from 'fino:data/arrow';
 *
 * const scores = list(new Field('item', int32()));
 * ```
 */
export interface ListType extends BaseType {
  kind: 'list';
  typeId: 12;
  /** Element field: type, name, and nullability of list items. */
  child: Field;
}
/**
 * Variable-length list with 64-bit offsets, for lists whose flattened
 * element count may exceed the 32-bit range of `ListType`.
 *
 * ```ts no_run
 * import { largeList, utf8, Field } from 'fino:data/arrow';
 *
 * const t = largeList(new Field('item', utf8()));
 * ```
 */
export interface LargeListType extends BaseType {
  kind: 'largelist';
  typeId: 21;
  /** Element field: type, name, and nullability of list items. */
  child: Field;
}
/**
 * List in the view layout: separate 32-bit offsets and sizes buffers, so
 * lists may be stored out of order or share element ranges.
 *
 * ```ts no_run
 * import { listView, int32, Field, bufferLayout } from 'fino:data/arrow';
 *
 * const t = listView(new Field('item', int32()));
 * bufferLayout(t); // ['validity', 'offset32', 'size32']
 * ```
 */
export interface ListViewType extends BaseType {
  kind: 'listview';
  typeId: 25;
  /** Element field: type, name, and nullability of list items. */
  child: Field;
}
/**
 * List in the view layout with 64-bit offsets and sizes; the large-offset
 * counterpart of `ListViewType`.
 *
 * ```ts no_run
 * import { largeListView, int32, Field } from 'fino:data/arrow';
 *
 * const t = largeListView(new Field('item', int32()));
 * ```
 */
export interface LargeListViewType extends BaseType {
  kind: 'largelistview';
  typeId: 26;
  /** Element field: type, name, and nullability of list items. */
  child: Field;
}
/**
 * List of exactly `listSize` elements per value. No offsets buffer is
 * needed; element `i` of list `j` lives at child index `j * listSize + i`.
 *
 * ```ts no_run
 * import { fixedSizeList, float32, Field } from 'fino:data/arrow';
 *
 * const vec3 = fixedSizeList(3, new Field('item', float32(), false));
 * ```
 */
export interface FixedSizeListType extends BaseType {
  kind: 'fixedsizelist';
  typeId: 16;
  /** Exact number of elements in every list value. */
  listSize: number;
  /** Element field: type, name, and nullability of list items. */
  child: Field;
}
/**
 * Named tuple of child columns. The struct itself only carries a validity
 * bitmap; each child field stores its own buffers at the same length.
 *
 * ```ts no_run
 * import { struct, int32, utf8, Field } from 'fino:data/arrow';
 *
 * const person = struct([
 *   new Field('name', utf8(), false),
 *   new Field('age', int32()),
 * ]);
 * ```
 */
export interface StructType extends BaseType {
  kind: 'struct';
  typeId: 13;
  /** Member fields, in declaration order. */
  children: Field[];
}
/**
 * Map from keys to values, physically a list of `entries` structs. The
 * `child` field must be a non-nullable struct with a non-nullable key field
 * and a value field. `keysSorted` asserts keys are sorted within each map.
 *
 * ```ts no_run
 * import { map, struct, utf8, int32, Field } from 'fino:data/arrow';
 *
 * const entries = new Field('entries', struct([
 *   new Field('key', utf8(), false),
 *   new Field('value', int32()),
 * ]), false);
 * const t = map(entries);
 * ```
 */
export interface MapType extends BaseType {
  kind: 'map';
  typeId: 17;
  /** Whether keys are sorted within each individual map value. */
  keysSorted: boolean;
  /** The `entries` struct field holding key and value children. */
  child: Field;
}
/**
 * Tagged union of child types. Each slot's `typeIds`-buffer entry selects a
 * child; `typeIds[i]` gives the tag value for child `i`. In `Dense` mode an
 * extra 32-bit offsets buffer indexes into per-child columns; in `Sparse`
 * mode every child spans the full length.
 *
 * ```ts no_run
 * import { union, UnionMode, int32, utf8, Field } from 'fino:data/arrow';
 *
 * const t = union(UnionMode.Dense, [0, 1], [
 *   new Field('num', int32()),
 *   new Field('str', utf8()),
 * ]);
 * ```
 */
export interface UnionType extends BaseType {
  kind: 'union';
  typeId: 14;
  /** One of the `UnionMode` constants: Sparse or Dense. */
  mode: number;
  /** Tag value stored in the typeIds buffer for each child, by child index. */
  typeIds: number[];
  /** Child fields, one per union variant. */
  children: Field[];
}
/**
 * Dictionary-encoded column: values are indices of `indexType` into a shared
 * dictionary of `valueType` values. Following Arrow convention, `typeId`
 * mirrors the value type's id — dictionary encoding is a physical encoding
 * recorded on the field, not a distinct logical type — so always check
 * `kind === 'dictionary'` rather than the numeric id.
 *
 * ```ts no_run
 * import { dictionary, int8, utf8 } from 'fino:data/arrow';
 *
 * // Low-cardinality strings: int8 codes into a utf8 dictionary.
 * const color = dictionary(0, int8(), utf8());
 * ```
 */
export interface DictionaryType extends BaseType {
  kind: 'dictionary';
  typeId: number;
  /** Dictionary id linking the field to its dictionary batch in IPC. */
  id: number;
  /** Integer type of the index (code) values. */
  indexType: IntType;
  /** Logical type of the dictionary's values. */
  valueType: DataType;
  /** Whether dictionary order is semantically meaningful. */
  isOrdered: boolean;
}
/**
 * Run-end encoded column: the `runEnds` child holds the exclusive end index
 * of each run and the `values` child holds one value per run. The type
 * itself has no buffers — all data lives in the two children.
 *
 * ```ts no_run
 * import { runEndEncoded, int32, utf8, Field } from 'fino:data/arrow';
 *
 * const t = runEndEncoded(
 *   new Field('run_ends', int32(), false),
 *   new Field('values', utf8()),
 * );
 * ```
 */
export interface RunEndEncodedType extends BaseType {
  kind: 'runendencoded';
  typeId: 22;
  /** Field of run end indices; must be a non-nullable integer field. */
  runEnds: Field;
  /** Field holding one value per run. */
  values: Field;
}
/**
 * Any Arrow logical type. Narrow on the `kind` discriminant in a `switch` to
 * recover the concrete member.
 */
export type DataType =
  | NullType
  | BoolType
  | IntType
  | FloatType
  | DecimalType
  | DateType
  | TimeType
  | TimestampType
  | IntervalType
  | DurationType
  | Utf8Type
  | LargeUtf8Type
  | BinaryType
  | LargeBinaryType
  | Utf8ViewType
  | BinaryViewType
  | FixedSizeBinaryType
  | ListType
  | LargeListType
  | ListViewType
  | LargeListViewType
  | FixedSizeListType
  | StructType
  | MapType
  | UnionType
  | DictionaryType
  | RunEndEncodedType;
// --- factories -------------------------------------------------------------
/**
 * Builds the null type. Named `nullType` because `null` is a reserved word.
 *
 * ```ts no_run
 * import { nullType } from 'fino:data/arrow';
 * const t = nullType();
 * ```
 */
export const nullType = (): NullType => ({
  kind: 'null',
  typeId: 1,
});
/**
 * Builds the bit-packed boolean type.
 *
 * ```ts no_run
 * import { bool } from 'fino:data/arrow';
 * const t = bool();
 * ```
 */
export const bool = (): BoolType => ({
  kind: 'bool',
  typeId: 6,
});
/**
 * Builds a signed 8-bit integer type.
 *
 * ```ts no_run
 * import { int8 } from 'fino:data/arrow';
 * const t = int8();
 * ```
 */
export const int8 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 8,
  signed: true,
});
/**
 * Builds a signed 16-bit integer type.
 *
 * ```ts no_run
 * import { int16 } from 'fino:data/arrow';
 * const t = int16();
 * ```
 */
export const int16 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 16,
  signed: true,
});
/**
 * Builds a signed 32-bit integer type.
 *
 * ```ts no_run
 * import { int32 } from 'fino:data/arrow';
 * const t = int32();
 * ```
 */
export const int32 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 32,
  signed: true,
});
/**
 * Builds a signed 64-bit integer type.
 *
 * ```ts no_run
 * import { int64 } from 'fino:data/arrow';
 * const t = int64();
 * ```
 */
export const int64 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 64,
  signed: true,
});
/**
 * Builds an unsigned 8-bit integer type.
 *
 * ```ts no_run
 * import { uint8 } from 'fino:data/arrow';
 * const t = uint8();
 * ```
 */
export const uint8 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 8,
  signed: false,
});
/**
 * Builds an unsigned 16-bit integer type.
 *
 * ```ts no_run
 * import { uint16 } from 'fino:data/arrow';
 * const t = uint16();
 * ```
 */
export const uint16 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 16,
  signed: false,
});
/**
 * Builds an unsigned 32-bit integer type.
 *
 * ```ts no_run
 * import { uint32 } from 'fino:data/arrow';
 * const t = uint32();
 * ```
 */
export const uint32 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 32,
  signed: false,
});
/**
 * Builds an unsigned 64-bit integer type.
 *
 * ```ts no_run
 * import { uint64 } from 'fino:data/arrow';
 * const t = uint64();
 * ```
 */
export const uint64 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 64,
  signed: false,
});
/**
 * Builds a half-precision (16-bit) floating-point type.
 *
 * ```ts no_run
 * import { float16 } from 'fino:data/arrow';
 * const t = float16();
 * ```
 */
export const float16 = (): FloatType => ({
  kind: 'float',
  typeId: 3,
  precision: Precision.HALF,
});
/**
 * Builds a single-precision (32-bit) floating-point type.
 *
 * ```ts no_run
 * import { float32 } from 'fino:data/arrow';
 * const t = float32();
 * ```
 */
export const float32 = (): FloatType => ({
  kind: 'float',
  typeId: 3,
  precision: Precision.SINGLE,
});
/**
 * Builds a double-precision (64-bit) floating-point type.
 *
 * ```ts no_run
 * import { float64 } from 'fino:data/arrow';
 * const t = float64();
 * ```
 */
export const float64 = (): FloatType => ({
  kind: 'float',
  typeId: 3,
  precision: Precision.DOUBLE,
});
/**
 * Builds a fixed-point decimal type with `precision` total digits and
 * `scale` fractional digits. Storage defaults to 128 bits, the common width
 * for SQL-style decimals up to 38 digits.
 *
 * ```ts no_run
 * import { decimal } from 'fino:data/arrow';
 * const price = decimal(10, 2);        // 128-bit
 * const tiny = decimal(7, 3, 32);      // 32-bit storage
 * ```
 */
export const decimal = (
  precision: number,
  scale: number,
  bitWidth: 32 | 64 | 128 | 256 = 128,
): DecimalType => ({
  kind: 'decimal',
  typeId: 7,
  precision,
  scale,
  bitWidth,
});
/**
 * Builds a day-precision date type (32-bit days since the Unix epoch).
 *
 * ```ts no_run
 * import { date32 } from 'fino:data/arrow';
 * const t = date32();
 * ```
 */
export const date32 = (): DateType => ({
  kind: 'date',
  typeId: 8,
  unit: DateUnit.DAY,
});
/**
 * Builds a millisecond-precision date type (64-bit milliseconds since the
 * Unix epoch).
 *
 * ```ts no_run
 * import { date64 } from 'fino:data/arrow';
 * const t = date64();
 * ```
 */
export const date64 = (): DateType => ({
  kind: 'date',
  typeId: 8,
  unit: DateUnit.MILLISECOND,
});
/**
 * Builds a 32-bit time-of-day type; defaults to milliseconds. The Arrow spec
 * pairs 32-bit times with `SECOND` or `MILLISECOND` units — the unit is not
 * validated here, but other tooling will reject finer units at this width.
 *
 * ```ts no_run
 * import { time32, TimeUnit } from 'fino:data/arrow';
 * const t = time32(TimeUnit.SECOND);
 * ```
 */
export const time32 = (unit: number = TimeUnit.MILLISECOND): TimeType => ({
  kind: 'time',
  typeId: 9,
  unit,
  bitWidth: 32,
});
/**
 * Builds a 64-bit time-of-day type; defaults to microseconds. The Arrow spec
 * pairs 64-bit times with `MICROSECOND` or `NANOSECOND` units.
 *
 * ```ts no_run
 * import { time64, TimeUnit } from 'fino:data/arrow';
 * const t = time64(TimeUnit.NANOSECOND);
 * ```
 */
export const time64 = (unit: number = TimeUnit.MICROSECOND): TimeType => ({
  kind: 'time',
  typeId: 9,
  unit,
  bitWidth: 64,
});
/**
 * Builds a timestamp type; defaults to zone-naive microseconds. Pass a
 * timezone string to mark values as absolute instants in that zone.
 *
 * ```ts no_run
 * import { timestamp, TimeUnit } from 'fino:data/arrow';
 * const created = timestamp(TimeUnit.MILLISECOND, 'UTC');
 * ```
 */
export const timestamp = (
  unit: number = TimeUnit.MICROSECOND,
  timezone: string | null = null,
): TimestampType => ({
  kind: 'timestamp',
  typeId: 10,
  unit,
  timezone,
});
/**
 * Builds a duration type (64-bit elapsed-time counts); defaults to
 * microseconds.
 *
 * ```ts no_run
 * import { duration, TimeUnit } from 'fino:data/arrow';
 * const t = duration(TimeUnit.NANOSECOND);
 * ```
 */
export const duration = (unit: number = TimeUnit.MICROSECOND): DurationType => ({
  kind: 'duration',
  typeId: 18,
  unit,
});
/**
 * Builds a calendar-interval type. The unit is required because it changes
 * the physical width (4, 8, or 16 bytes per value).
 *
 * ```ts no_run
 * import { interval, IntervalUnit } from 'fino:data/arrow';
 * const t = interval(IntervalUnit.DAY_TIME);
 * ```
 */
export const interval = (unit: number): IntervalType => ({
  kind: 'interval',
  typeId: 11,
  unit,
});
/**
 * Builds the UTF-8 string type with 32-bit offsets.
 *
 * ```ts no_run
 * import { utf8 } from 'fino:data/arrow';
 * const t = utf8();
 * ```
 */
export const utf8 = (): Utf8Type => ({
  kind: 'utf8',
  typeId: 5,
});
/**
 * Builds the UTF-8 string type with 64-bit offsets.
 *
 * ```ts no_run
 * import { largeUtf8 } from 'fino:data/arrow';
 * const t = largeUtf8();
 * ```
 */
export const largeUtf8 = (): LargeUtf8Type => ({
  kind: 'largeutf8',
  typeId: 20,
});
/**
 * Builds the variable-length binary type with 32-bit offsets.
 *
 * ```ts no_run
 * import { binary } from 'fino:data/arrow';
 * const t = binary();
 * ```
 */
export const binary = (): BinaryType => ({
  kind: 'binary',
  typeId: 4,
});
/**
 * Builds the variable-length binary type with 64-bit offsets.
 *
 * ```ts no_run
 * import { largeBinary } from 'fino:data/arrow';
 * const t = largeBinary();
 * ```
 */
export const largeBinary = (): LargeBinaryType => ({
  kind: 'largebinary',
  typeId: 19,
});
/**
 * Builds the view-layout UTF-8 string type (16-byte views plus variadic
 * data buffers).
 *
 * ```ts no_run
 * import { utf8View } from 'fino:data/arrow';
 * const t = utf8View();
 * ```
 */
export const utf8View = (): Utf8ViewType => ({
  kind: 'utf8view',
  typeId: 24,
});
/**
 * Builds the view-layout binary type (16-byte views plus variadic data
 * buffers).
 *
 * ```ts no_run
 * import { binaryView } from 'fino:data/arrow';
 * const t = binaryView();
 * ```
 */
export const binaryView = (): BinaryViewType => ({
  kind: 'binaryview',
  typeId: 23,
});
/**
 * Builds a fixed-size binary type of exactly `byteWidth` bytes per value.
 *
 * ```ts no_run
 * import { fixedSizeBinary } from 'fino:data/arrow';
 * const sha256 = fixedSizeBinary(32);
 * ```
 */
export const fixedSizeBinary = (byteWidth: number): FixedSizeBinaryType => ({
  kind: 'fixedsizebinary',
  typeId: 15,
  byteWidth,
});
/**
 * Builds a list type with 32-bit offsets over the given element field.
 *
 * ```ts no_run
 * import { list, utf8, Field } from 'fino:data/arrow';
 * const tags = list(new Field('item', utf8()));
 * ```
 */
export const list = (child: Field): ListType => ({
  kind: 'list',
  typeId: 12,
  child,
});
/**
 * Builds a list type with 64-bit offsets over the given element field.
 *
 * ```ts no_run
 * import { largeList, binary, Field } from 'fino:data/arrow';
 * const blobs = largeList(new Field('item', binary()));
 * ```
 */
export const largeList = (child: Field): LargeListType => ({
  kind: 'largelist',
  typeId: 21,
  child,
});
/**
 * Builds a list-view type (32-bit offsets and sizes) over the given element
 * field.
 *
 * ```ts no_run
 * import { listView, int32, Field } from 'fino:data/arrow';
 * const t = listView(new Field('item', int32()));
 * ```
 */
export const listView = (child: Field): ListViewType => ({
  kind: 'listview',
  typeId: 25,
  child,
});
/**
 * Builds a large list-view type (64-bit offsets and sizes) over the given
 * element field.
 *
 * ```ts no_run
 * import { largeListView, int32, Field } from 'fino:data/arrow';
 * const t = largeListView(new Field('item', int32()));
 * ```
 */
export const largeListView = (child: Field): LargeListViewType => ({
  kind: 'largelistview',
  typeId: 26,
  child,
});
/**
 * Builds a fixed-size list type: every value holds exactly `listSize`
 * elements of the given field.
 *
 * ```ts no_run
 * import { fixedSizeList, float32, Field } from 'fino:data/arrow';
 * const embedding = fixedSizeList(768, new Field('item', float32(), false));
 * ```
 */
export const fixedSizeList = (listSize: number, child: Field): FixedSizeListType => ({
  kind: 'fixedsizelist',
  typeId: 16,
  listSize,
  child,
});
/**
 * Builds a struct type from its member fields.
 *
 * ```ts no_run
 * import { struct, utf8, int32, Field } from 'fino:data/arrow';
 * const person = struct([
 *   new Field('name', utf8(), false),
 *   new Field('age', int32()),
 * ]);
 * ```
 */
export const struct = (children: Field[]): StructType => ({
  kind: 'struct',
  typeId: 13,
  children,
});
/**
 * Builds a map type over an `entries` struct field. The child should be a
 * non-nullable struct field with a non-nullable key field and a value field;
 * pass `keysSorted: true` only when keys are sorted within each map value.
 *
 * ```ts no_run
 * import { map, struct, utf8, int32, Field } from 'fino:data/arrow';
 * const t = map(new Field('entries', struct([
 *   new Field('key', utf8(), false),
 *   new Field('value', int32()),
 * ]), false));
 * ```
 */
export const map = (child: Field, keysSorted = false): MapType => ({
  kind: 'map',
  typeId: 17,
  keysSorted,
  child,
});
/**
 * Builds a union type. `typeIds[i]` is the tag written to the typeIds buffer
 * for values of child `i`; tags need not be contiguous or start at zero.
 *
 * ```ts no_run
 * import { union, UnionMode, int32, utf8, Field } from 'fino:data/arrow';
 * const t = union(UnionMode.Dense, [0, 1], [
 *   new Field('num', int32()),
 *   new Field('str', utf8()),
 * ]);
 * ```
 */
export const union = (mode: number, typeIds: number[], children: Field[]): UnionType => ({
  kind: 'union',
  typeId: 14,
  mode,
  typeIds,
  children,
});
/**
 * Builds a dictionary-encoded type: `indexType` codes referencing a
 * dictionary of `valueType` values. The `id` ties the field to its
 * dictionary batch in IPC streams; distinct dictionaries in one schema need
 * distinct ids. The resulting `typeId` mirrors `valueType.typeId`.
 *
 * ```ts no_run
 * import { dictionary, int8, utf8 } from 'fino:data/arrow';
 * const color = dictionary(0, int8(), utf8());
 * ```
 */
export const dictionary = (
  id: number,
  indexType: IntType,
  valueType: DataType,
  isOrdered = false,
): DictionaryType => ({
  kind: 'dictionary',
  typeId: valueType.typeId,
  id,
  indexType,
  valueType,
  isOrdered,
});
/**
 * Builds a run-end encoded type from its two child fields: `runEnds` (a
 * non-nullable integer field of exclusive run end indices) and `values`
 * (one value per run).
 *
 * ```ts no_run
 * import { runEndEncoded, int32, utf8, Field } from 'fino:data/arrow';
 * const t = runEndEncoded(
 *   new Field('run_ends', int32(), false),
 *   new Field('values', utf8()),
 * );
 * ```
 */
export const runEndEncoded = (runEnds: Field, values: Field): RunEndEncodedType => ({
  kind: 'runendencoded',
  typeId: 22,
  runEnds,
  values,
});
// --- introspection ---------------------------------------------------------
/**
 * Byte size of a fixed-width type's element, or 0 for variable-width types.
 *
 * Note that `bool` also reports 0: values are bit-packed, so no whole-byte
 * element size exists. Nested and variable-length types (lists, structs,
 * strings, views) all return 0.
 *
 * ```ts no_run
 * import { fixedWidthBytes, int64, utf8, bool } from 'fino:data/arrow';
 *
 * fixedWidthBytes(int64()); // 8
 * fixedWidthBytes(utf8());  // 0 (variable width)
 * fixedWidthBytes(bool());  // 0 (bit-packed)
 * ```
 */
export function fixedWidthBytes(type: DataType): number {
  switch (type.kind) {
    case 'bool':
      return 0;
    case 'int':
      return type.bitWidth / 8;
    case 'float':
      return type.precision === Precision.HALF ? 2 : type.precision === Precision.SINGLE ? 4 : 8;
    case 'decimal':
      return type.bitWidth / 8;
    case 'date':
      return type.unit === DateUnit.DAY ? 4 : 8;
    case 'time':
      return type.bitWidth / 8;
    case 'timestamp':
      return 8;
    case 'duration':
      return 8;
    case 'interval':
      return type.unit === IntervalUnit.YEAR_MONTH
        ? 4
        : type.unit === IntervalUnit.DAY_TIME
          ? 8
          : 16;
    case 'fixedsizebinary':
      return type.byteWidth;
    default:
      return 0;
  }
}
/**
 * The physical buffer layout of a type, in Arrow pre-order. Does not include
 * child-column buffers (those follow the parent's own node in IPC order).
 *
 * Dictionary types report the layout of their index type, since only the
 * codes live in the column itself. Null and run-end-encoded types own no
 * buffers and return an empty array. View types report `views` but not
 * their variadic data buffers — check `hasVariadicBuffers` for those.
 *
 * ```ts no_run
 * import { bufferLayout, utf8, list, int32, Field } from 'fino:data/arrow';
 *
 * bufferLayout(utf8());                          // ['validity', 'offset32', 'data']
 * bufferLayout(list(new Field('item', int32()))); // ['validity', 'offset32']
 * ```
 */
export function bufferLayout(type: DataType): BufferKind[] {
  switch (type.kind) {
    case 'null':
      return [];
    case 'bool':
      return ['validity', 'data'];
    case 'int':
    case 'float':
    case 'decimal':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'duration':
    case 'interval':
    case 'fixedsizebinary':
      return ['validity', 'data'];
    case 'utf8':
    case 'binary':
      return ['validity', 'offset32', 'data'];
    case 'largeutf8':
    case 'largebinary':
      return ['validity', 'offset64', 'data'];
    case 'utf8view':
    case 'binaryview':
      return ['validity', 'views'];
    case 'list':
    case 'map':
      return ['validity', 'offset32'];
    case 'largelist':
      return ['validity', 'offset64'];
    case 'listview':
      return ['validity', 'offset32', 'size32'];
    case 'largelistview':
      return ['validity', 'offset64', 'size64'];
    case 'fixedsizelist':
    case 'struct':
      return ['validity'];
    case 'union':
      return type.mode === UnionMode.Dense ? ['typeIds', 'offset32'] : ['typeIds'];
    case 'dictionary':
      return bufferLayout(type.indexType);
    case 'runendencoded':
      return [];
  }
}
/**
 * Child fields of a nested type, in Arrow order. Empty for leaf types.
 *
 * Run-end-encoded types return `[runEnds, values]`; dictionaries return
 * nothing here because the dictionary column travels separately.
 *
 * ```ts no_run
 * import { childFields, struct, int32, Field } from 'fino:data/arrow';
 *
 * const t = struct([new Field('x', int32(), false)]);
 * childFields(t).map((f) => f.name); // ['x']
 * ```
 */
export function childFields(type: DataType): Field[] {
  switch (type.kind) {
    case 'list':
    case 'largelist':
    case 'listview':
    case 'largelistview':
    case 'fixedsizelist':
    case 'map':
      return [type.child];
    case 'struct':
    case 'union':
      return type.children;
    case 'runendencoded':
      return [type.runEnds, type.values];
    default:
      return [];
  }
}
/**
 * Whether a type carries variadic data buffers (the View types).
 *
 * IPC record batches list a per-column buffer count; view columns append a
 * variable number of data buffers after the fixed layout, so writers and
 * readers use this to know when to expect them.
 *
 * ```ts no_run
 * import { hasVariadicBuffers, utf8View, utf8 } from 'fino:data/arrow';
 *
 * hasVariadicBuffers(utf8View()); // true
 * hasVariadicBuffers(utf8());     // false
 * ```
 */
export function hasVariadicBuffers(type: DataType): boolean {
  return type.kind === 'utf8view' || type.kind === 'binaryview';
}
/**
 * A human-readable label for error messages. Currently the `kind` string.
 *
 * ```ts no_run
 * import { formatType, timestamp } from 'fino:data/arrow';
 *
 * throw new Error(`unsupported type: ${formatType(timestamp())}`);
 * ```
 */
export function formatType(type: DataType): string {
  return type.kind;
}
/**
 * Structural equality of two types.
 *
 * Compares every own parameter (bit width, unit, timezone, precision, ...)
 * and recurses through child fields, requiring matching child names and
 * nullability as well as equal child types. Dictionary types additionally
 * compare index and value types, though the dictionary `id` and other
 * non-child parameters must also match.
 *
 * ```ts no_run
 * import { typeEquals, timestamp, TimeUnit } from 'fino:data/arrow';
 *
 * typeEquals(timestamp(TimeUnit.MICROSECOND, 'UTC'),
 *            timestamp(TimeUnit.MICROSECOND, 'UTC')); // true
 * typeEquals(timestamp(TimeUnit.MICROSECOND, 'UTC'),
 *            timestamp(TimeUnit.MICROSECOND, null));  // false
 * ```
 */
export function typeEquals(a: DataType, b: DataType): boolean {
  if (a.kind !== b.kind) return false;
  return (
    JSON.stringify(stripChildren(a)) === JSON.stringify(stripChildren(b)) && childrenEqual(a, b)
  );
}
function stripChildren(type: DataType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(type)) {
    if (k === 'child' || k === 'children' || k === 'values' || k === 'runEnds' || k === 'valueType')
      continue;
    out[k] = v;
  }
  return out;
}
function childrenEqual(a: DataType, b: DataType): boolean {
  const ca = childFields(a);
  const cb = childFields(b);
  if (ca.length !== cb.length) return false;
  for (let i = 0; i < ca.length; i++) {
    if (ca[i]!.name !== cb[i]!.name || ca[i]!.nullable !== cb[i]!.nullable) return false;
    if (!typeEquals(ca[i]!.type, cb[i]!.type)) return false;
  }
  if (a.kind === 'dictionary' && b.kind === 'dictionary')
    return typeEquals(a.valueType, b.valueType) && typeEquals(a.indexType, b.indexType);
  return true;
}
