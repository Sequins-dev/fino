/**
* Apache Arrow logical type system.
*
* Types are plain immutable objects tagged by a numeric `typeId` matching the
* Arrow IPC `Type` union, plus a readable `kind`. Factory functions build them;
* `bufferLayout()` and child metadata drive the columnar memory layout used by
* vectors, IPC, and the C Data Interface.
*
* @internal
*/
import type { Field } from './schema.ts';
/**
* Arrow `Type` union tags (from Schema.fbs). Used as the `typeId` on every
* `DataType` and as the union discriminant in IPC metadata.
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
  LargeListView: 26
} as const;
/** Time/timestamp/duration units (Arrow `TimeUnit`). */
export const TimeUnit = {
  SECOND: 0,
  MILLISECOND: 1,
  MICROSECOND: 2,
  NANOSECOND: 3
} as const;
/** Date units (Arrow `DateUnit`). */
export const DateUnit = {
  DAY: 0,
  MILLISECOND: 1
} as const;
/** Interval units (Arrow `IntervalUnit`). */
export const IntervalUnit = {
  YEAR_MONTH: 0,
  DAY_TIME: 1,
  MONTH_DAY_NANO: 2
} as const;
/** Union modes (Arrow `UnionMode`). */
export const UnionMode = {
  Sparse: 0,
  Dense: 1
} as const;
/** Floating-point precisions (Arrow `Precision`). */
export const Precision = {
  HALF: 0,
  SINGLE: 1,
  DOUBLE: 2
} as const;
/** A logical component of a type's physical buffer layout, in Arrow order. */
export type BufferKind = 'validity' | 'offset32' | 'offset64' | 'size32' | 'size64' | 'data' | 'typeIds' | 'views';
/** Base shape shared by every `DataType`. */
interface BaseType {
  readonly typeId: number;
  readonly kind: string;
}
export interface NullType extends BaseType {
  kind: 'null';
  typeId: 1;
}
export interface BoolType extends BaseType {
  kind: 'bool';
  typeId: 6;
}
export interface IntType extends BaseType {
  kind: 'int';
  typeId: 2;
  bitWidth: 8 | 16 | 32 | 64;
  signed: boolean;
}
export interface FloatType extends BaseType {
  kind: 'float';
  typeId: 3;
  precision: number;
}
export interface DecimalType extends BaseType {
  kind: 'decimal';
  typeId: 7;
  precision: number;
  scale: number;
  bitWidth: 32 | 64 | 128 | 256;
}
export interface DateType extends BaseType {
  kind: 'date';
  typeId: 8;
  unit: number;
}
export interface TimeType extends BaseType {
  kind: 'time';
  typeId: 9;
  unit: number;
  bitWidth: 32 | 64;
}
export interface TimestampType extends BaseType {
  kind: 'timestamp';
  typeId: 10;
  unit: number;
  timezone: string | null;
}
export interface IntervalType extends BaseType {
  kind: 'interval';
  typeId: 11;
  unit: number;
}
export interface DurationType extends BaseType {
  kind: 'duration';
  typeId: 18;
  unit: number;
}
export interface Utf8Type extends BaseType {
  kind: 'utf8';
  typeId: 5;
}
export interface LargeUtf8Type extends BaseType {
  kind: 'largeutf8';
  typeId: 20;
}
export interface BinaryType extends BaseType {
  kind: 'binary';
  typeId: 4;
}
export interface LargeBinaryType extends BaseType {
  kind: 'largebinary';
  typeId: 19;
}
export interface Utf8ViewType extends BaseType {
  kind: 'utf8view';
  typeId: 24;
}
export interface BinaryViewType extends BaseType {
  kind: 'binaryview';
  typeId: 23;
}
export interface FixedSizeBinaryType extends BaseType {
  kind: 'fixedsizebinary';
  typeId: 15;
  byteWidth: number;
}
export interface ListType extends BaseType {
  kind: 'list';
  typeId: 12;
  child: Field;
}
export interface LargeListType extends BaseType {
  kind: 'largelist';
  typeId: 21;
  child: Field;
}
export interface ListViewType extends BaseType {
  kind: 'listview';
  typeId: 25;
  child: Field;
}
export interface LargeListViewType extends BaseType {
  kind: 'largelistview';
  typeId: 26;
  child: Field;
}
export interface FixedSizeListType extends BaseType {
  kind: 'fixedsizelist';
  typeId: 16;
  listSize: number;
  child: Field;
}
export interface StructType extends BaseType {
  kind: 'struct';
  typeId: 13;
  children: Field[];
}
export interface MapType extends BaseType {
  kind: 'map';
  typeId: 17;
  keysSorted: boolean;
  child: Field;
}
export interface UnionType extends BaseType {
  kind: 'union';
  typeId: 14;
  mode: number;
  typeIds: number[];
  children: Field[];
}
export interface DictionaryType extends BaseType {
  kind: 'dictionary';
  typeId: number;
  id: number;
  indexType: IntType;
  valueType: DataType;
  isOrdered: boolean;
}
export interface RunEndEncodedType extends BaseType {
  kind: 'runendencoded';
  typeId: 22;
  runEnds: Field;
  values: Field;
}
/** Any Arrow logical type. */
export type DataType = NullType | BoolType | IntType | FloatType | DecimalType | DateType | TimeType | TimestampType | IntervalType | DurationType | Utf8Type | LargeUtf8Type | BinaryType | LargeBinaryType | Utf8ViewType | BinaryViewType | FixedSizeBinaryType | ListType | LargeListType | ListViewType | LargeListViewType | FixedSizeListType | StructType | MapType | UnionType | DictionaryType | RunEndEncodedType;
// --- factories -------------------------------------------------------------
export const nullType = (): NullType => ({
  kind: 'null',
  typeId: 1
});
export const bool = (): BoolType => ({
  kind: 'bool',
  typeId: 6
});
export const int8 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 8,
  signed: true
});
export const int16 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 16,
  signed: true
});
export const int32 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 32,
  signed: true
});
export const int64 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 64,
  signed: true
});
export const uint8 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 8,
  signed: false
});
export const uint16 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 16,
  signed: false
});
export const uint32 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 32,
  signed: false
});
export const uint64 = (): IntType => ({
  kind: 'int',
  typeId: 2,
  bitWidth: 64,
  signed: false
});
export const float16 = (): FloatType => ({
  kind: 'float',
  typeId: 3,
  precision: Precision.HALF
});
export const float32 = (): FloatType => ({
  kind: 'float',
  typeId: 3,
  precision: Precision.SINGLE
});
export const float64 = (): FloatType => ({
  kind: 'float',
  typeId: 3,
  precision: Precision.DOUBLE
});
export const decimal = (precision: number, scale: number, bitWidth: 32 | 64 | 128 | 256 = 128): DecimalType => ({
  kind: 'decimal',
  typeId: 7,
  precision,
  scale,
  bitWidth
});
export const date32 = (): DateType => ({
  kind: 'date',
  typeId: 8,
  unit: DateUnit.DAY
});
export const date64 = (): DateType => ({
  kind: 'date',
  typeId: 8,
  unit: DateUnit.MILLISECOND
});
export const time32 = (unit: number = TimeUnit.MILLISECOND): TimeType => ({
  kind: 'time',
  typeId: 9,
  unit,
  bitWidth: 32
});
export const time64 = (unit: number = TimeUnit.MICROSECOND): TimeType => ({
  kind: 'time',
  typeId: 9,
  unit,
  bitWidth: 64
});
export const timestamp = (unit: number = TimeUnit.MICROSECOND, timezone: string | null = null): TimestampType => ({
  kind: 'timestamp',
  typeId: 10,
  unit,
  timezone
});
export const duration = (unit: number = TimeUnit.MICROSECOND): DurationType => ({
  kind: 'duration',
  typeId: 18,
  unit
});
export const interval = (unit: number): IntervalType => ({
  kind: 'interval',
  typeId: 11,
  unit
});
export const utf8 = (): Utf8Type => ({
  kind: 'utf8',
  typeId: 5
});
export const largeUtf8 = (): LargeUtf8Type => ({
  kind: 'largeutf8',
  typeId: 20
});
export const binary = (): BinaryType => ({
  kind: 'binary',
  typeId: 4
});
export const largeBinary = (): LargeBinaryType => ({
  kind: 'largebinary',
  typeId: 19
});
export const utf8View = (): Utf8ViewType => ({
  kind: 'utf8view',
  typeId: 24
});
export const binaryView = (): BinaryViewType => ({
  kind: 'binaryview',
  typeId: 23
});
export const fixedSizeBinary = (byteWidth: number): FixedSizeBinaryType => ({
  kind: 'fixedsizebinary',
  typeId: 15,
  byteWidth
});
export const list = (child: Field): ListType => ({
  kind: 'list',
  typeId: 12,
  child
});
export const largeList = (child: Field): LargeListType => ({
  kind: 'largelist',
  typeId: 21,
  child
});
export const listView = (child: Field): ListViewType => ({
  kind: 'listview',
  typeId: 25,
  child
});
export const largeListView = (child: Field): LargeListViewType => ({
  kind: 'largelistview',
  typeId: 26,
  child
});
export const fixedSizeList = (listSize: number, child: Field): FixedSizeListType => ({
  kind: 'fixedsizelist',
  typeId: 16,
  listSize,
  child
});
export const struct = (children: Field[]): StructType => ({
  kind: 'struct',
  typeId: 13,
  children
});
export const map = (child: Field, keysSorted = false): MapType => ({
  kind: 'map',
  typeId: 17,
  keysSorted,
  child
});
export const union = (mode: number, typeIds: number[], children: Field[]): UnionType => ({
  kind: 'union',
  typeId: 14,
  mode,
  typeIds,
  children
});
export const dictionary = (id: number, indexType: IntType, valueType: DataType, isOrdered = false): DictionaryType => ({
  kind: 'dictionary',
  typeId: valueType.typeId,
  id,
  indexType,
  valueType,
  isOrdered
});
export const runEndEncoded = (runEnds: Field, values: Field): RunEndEncodedType => ({
  kind: 'runendencoded',
  typeId: 22,
  runEnds,
  values
});
// --- introspection ---------------------------------------------------------
/** Byte size of a fixed-width type's element, or 0 for variable-width types. */
export function fixedWidthBytes(type: DataType): number {
  switch (type.kind) {
    case 'bool': return 0;
    case 'int': return type.bitWidth / 8;
    case 'float': return type.precision === Precision.HALF ? 2 : type.precision === Precision.SINGLE ? 4 : 8;
    case 'decimal': return type.bitWidth / 8;
    case 'date': return type.unit === DateUnit.DAY ? 4 : 8;
    case 'time': return type.bitWidth / 8;
    case 'timestamp': return 8;
    case 'duration': return 8;
    case 'interval': return type.unit === IntervalUnit.YEAR_MONTH ? 4 : type.unit === IntervalUnit.DAY_TIME ? 8 : 16;
    case 'fixedsizebinary': return type.byteWidth;
    default: return 0;
  }
}
/**
* The physical buffer layout of a type, in Arrow pre-order. Does not include
* child-column buffers (those follow the parent's own node in IPC order).
*/
export function bufferLayout(type: DataType): BufferKind[] {
  switch (type.kind) {
    case 'null': return [];
    case 'bool': return ['validity', 'data'];
    case 'int':
    case 'float':
    case 'decimal':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'duration':
    case 'interval':
    case 'fixedsizebinary': return ['validity', 'data'];
    case 'utf8':
    case 'binary': return [
      'validity',
      'offset32',
      'data'
    ];
    case 'largeutf8':
    case 'largebinary': return [
      'validity',
      'offset64',
      'data'
    ];
    case 'utf8view':
    case 'binaryview': return ['validity', 'views'];
    case 'list':
    case 'map': return ['validity', 'offset32'];
    case 'largelist': return ['validity', 'offset64'];
    case 'listview': return [
      'validity',
      'offset32',
      'size32'
    ];
    case 'largelistview': return [
      'validity',
      'offset64',
      'size64'
    ];
    case 'fixedsizelist':
    case 'struct': return ['validity'];
    case 'union': return type.mode === UnionMode.Dense ? ['typeIds', 'offset32'] : ['typeIds'];
    case 'dictionary': return bufferLayout(type.indexType);
    case 'runendencoded': return [];
  }
}
/** Child fields of a nested type, in Arrow order. Empty for leaf types. */
export function childFields(type: DataType): Field[] {
  switch (type.kind) {
    case 'list':
    case 'largelist':
    case 'listview':
    case 'largelistview':
    case 'fixedsizelist':
    case 'map': return [type.child];
    case 'struct':
    case 'union': return type.children;
    case 'runendencoded': return [type.runEnds, type.values];
    default: return [];
  }
}
/** Whether a type carries variadic data buffers (the View types). */
export function hasVariadicBuffers(type: DataType): boolean {
  return type.kind === 'utf8view' || type.kind === 'binaryview';
}
/** A human-readable label for error messages. */
export function formatType(type: DataType): string {
  return type.kind;
}
/** Structural equality of two types. */
export function typeEquals(a: DataType, b: DataType): boolean {
  if (a.kind !== b.kind) return false;
  return JSON.stringify(stripChildren(a)) === JSON.stringify(stripChildren(b)) && childrenEqual(a, b);
}
function stripChildren(type: DataType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(type)) {
    if (k === 'child' || k === 'children' || k === 'values' || k === 'runEnds' || k === 'valueType') continue;
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
  if (a.kind === 'dictionary' && b.kind === 'dictionary') return typeEquals(a.valueType, b.valueType) && typeEquals(a.indexType, b.indexType);
  return true;
}
