/**
* internal:data/parquet/schema — the type bridge between Parquet schemas and
* Arrow schemas for flat (non-nested) columns.
*
* Parquet describes a column twice: a physical type says how bytes are laid
* out on disk (BOOLEAN, INT32, INT64, INT96, FLOAT, DOUBLE, BYTE_ARRAY,
* FIXED_LEN_BYTE_ARRAY) and an optional annotation says what they mean
* (string, decimal, timestamp, …). Arrow has a single type per column. This
* module owns the mapping in both directions: `arrowTypeToParquet`,
* `arrowFieldToElement`, and `arrowSchemaToParquet` turn Arrow fields into
* the `SchemaElement` list the writer Thrift-encodes into the footer, while
* `parquetLeafToArrow` and `parquetSchemaToArrow` turn a decoded footer
* schema back into Arrow.
*
* Each mapping also yields a pair of `ValueConverter`s, bundled with the
* physical layout and Dremel level bounds into a `ColumnDescriptor`: `decode`
* lifts a decoded physical value (a UTF-8 byte string, an unscaled decimal
* byte string, an INT96 timestamp, …) to the Arrow JS value, and `encode` is
* its inverse for the page encoder. The byte-level codecs the converters are
* built from live in `internal:data/parquet/convert`.
*
* When reading, the modern `LogicalType` annotation takes precedence over the
* legacy `ConvertedType`; when writing, both are emitted where an equivalent
* exists so pre-logical-type readers stay compatible.
*
* Only flat columns are handled here. Nested group columns (struct, list,
* map) are handled by `internal:data/parquet/nested`, which reuses
* `arrowTypeToParquet` and `parquetLeafToArrow` for its leaves.
*
* ```ts no_run
* import { arrowSchemaToParquet, parquetSchemaToArrow } from 'internal:data/parquet/schema';
* import { Schema, Field, int64, utf8 } from 'fino:data/arrow';
*
* const arrow = new Schema([
*   new Field('id', int64(), false),
*   new Field('name', utf8(), true),
* ]);
* const { elements, columns } = arrowSchemaToParquet(arrow);
* // elements → footer schema list; columns → descriptors for the writer
*
* const back = parquetSchemaToArrow(elements);
* // back.schema is equivalent to `arrow`
* ```
*
* Reference: https://github.com/apache/parquet-format/blob/master/LogicalTypes.md
*
* @internal
*/
import { Field, Schema, TimeUnit, type DataType, bool, int8, int16, int32, int64, uint8, uint16, uint32, uint64, float16, float32, float64, utf8, binary, date32, timestamp, time32, time64, decimal, fixedSizeBinary } from 'fino:data/arrow';
import { PType, ConvertedType, Repetition, TimeUnitId, LogicalTypeId, ParquetError } from './types.ts';
import type { SchemaElement, LogicalType } from './metadata.ts';
import { decimalBytesToBigInt, bigIntToDecimalBytes, int96ToEpochNanos, float16BytesToNumber, numberToFloat16Bytes } from './convert.ts';
const _decoder = new TextDecoder();
/**
* Converts one value between its Parquet physical representation and its
* Arrow JS representation.
*
* Converters are direction-specific: a `decode` converter maps a value the
* page decoder produced to the Arrow JS value, and an `encode` converter maps
* the Arrow JS value back to what the page encoder expects. Most columns need
* no conversion and use the identity function; the non-trivial converters
* cover UTF-8 strings, decimals, INT96 timestamps, and float16.
*
* Converters only ever see present values — nulls are resolved from
* definition levels before conversion.
*
* @internal
*/
export type ValueConverter = (value: unknown) => unknown;
const identity: ValueConverter = (v) => v;
/**
* Everything the column reader and writer need to process one leaf column:
* where it sits in the schema tree, its physical layout, its Dremel level
* bounds, and the value converters bridging to Arrow.
*
* Descriptors come out of `arrowSchemaToParquet` / `parquetSchemaToArrow` for
* flat schemas and out of `internal:data/parquet/nested` for nested ones. The
* column reader hands back raw physical values and levels; applying `decode`
* and resolving nulls against `maxDefinitionLevel` is the caller's job.
*
* ```ts no_run
* import { parquetSchemaToArrow } from 'internal:data/parquet/schema';
*
* const { columns } = parquetSchemaToArrow(footerSchemaElements);
* const col = columns[0]!;
* let vi = 0;
* const out = page.defLevels.map((def) =>
*   def === col.maxDefinitionLevel ? col.decode(page.values[vi++]) : null);
* ```
*
* @internal
*/
export interface ColumnDescriptor {
  /** Leaf column name — the last segment of `path`. */
  name: string;
  /**
  * Path segments from the schema root (excluded) down to this leaf. Flat
  * columns get `[name]`; nested leaves include the intermediate group
  * segments (e.g. `['tags', 'list', 'item']`). The writer stores this as
  * `pathInSchema` in each column chunk's metadata.
  */
  path: string[];
  /** Parquet physical type (a `PType` value) — the on-disk value layout. */
  physicalType: number;
  /** Byte width of each value for FIXED_LEN_BYTE_ARRAY columns; absent otherwise. */
  typeLength?: number;
  /**
  * Highest definition level a slot in this column can carry; a slot at this
  * level holds a value, anything lower is a null (or, for nested columns, a
  * null/empty ancestor). `1` for a nullable flat column, `0` for a required
  * one.
  */
  maxDefinitionLevel: number;
  /**
  * Number of repeated ancestors above this leaf. Always `0` for flat
  * columns; positive only for leaves inside lists or maps.
  */
  maxRepetitionLevel: number;
  /** The Arrow field this column materializes as — name, type, nullability. */
  arrowField: Field;
  /** Parquet physical value → Arrow JS value. */
  decode: ValueConverter;
  /** Arrow JS value → Parquet physical value (for PLAIN/dictionary encode). */
  encode: ValueConverter;
}
// --- Arrow -> Parquet ------------------------------------------------------
/**
* How one Arrow leaf type is expressed in Parquet: the physical type, the
* logical annotations, and the value converters for that column.
*
* Produced by `arrowTypeToParquet`. Both the modern `logicalType` and the
* legacy `convertedType` are populated wherever an equivalent exists, so
* written files stay readable by pre-logical-type readers.
*
* ```ts no_run
* import { arrowTypeToParquet, type ParquetTypeInfo } from 'internal:data/parquet/schema';
* import { utf8 } from 'fino:data/arrow';
*
* const info: ParquetTypeInfo = arrowTypeToParquet(utf8());
* // info.physicalType === PType.BYTE_ARRAY
* // info.logicalType  → { kind: 'string' }
* info.decode(new Uint8Array([0x68, 0x69])); // 'hi'
* ```
*
* @internal
*/
export interface ParquetTypeInfo {
  /** Parquet physical type (a `PType` value). */
  physicalType: number;
  /** Legacy `ConvertedType` annotation, when one exists for the type. */
  convertedType?: number;
  /** Modern logical type annotation, when the type means more than its physical layout. */
  logicalType?: LogicalType;
  /** Byte width per value for FIXED_LEN_BYTE_ARRAY (float16 → 2, decimal128 → 16, decimal256 → 32). */
  typeLength?: number;
  /** Parquet physical value → Arrow JS value. */
  decode: ValueConverter;
  /** Arrow JS value → Parquet physical value. */
  encode: ValueConverter;
}
/**
* Map an Arrow leaf type to its Parquet physical/logical typing and value
* converters.
*
* Highlights of the mapping:
*
* - `int`: INT32 for widths up to 32 bits, INT64 above, with an `integer`
*   logical type recording the exact width and signedness.
* - `float`: half → FIXED_LEN_BYTE_ARRAY(2) with the `float16` logical type,
*   single → FLOAT, double → DOUBLE.
* - `decimal`: INT32 (32-bit), INT64 (64-bit), or FIXED_LEN_BYTE_ARRAY of
*   16/32 bytes (128/256-bit), always annotated with precision and scale.
* - `utf8` → BYTE_ARRAY with the `string` annotation; `binary` → BYTE_ARRAY;
*   `fixedsizebinary` → FIXED_LEN_BYTE_ARRAY of the declared width.
* - `date` (32-bit days), `time` (millis/micros/nanos), and `timestamp` map
*   to INT32/INT64 with the matching annotation; a timestamp is marked
*   `isAdjustedToUTC` when its Arrow type carries a timezone.
*
* Throws a `ParquetError` for types with no Parquet equivalent — 64-bit
* dates, second-resolution times, and any nested type (nested fields go
* through `internal:data/parquet/nested` instead).
*
* ```ts no_run
* import { arrowTypeToParquet } from 'internal:data/parquet/schema';
* import { decimal, timestamp, TimeUnit } from 'fino:data/arrow';
*
* const dec = arrowTypeToParquet(decimal(38, 9, 128));
* // FIXED_LEN_BYTE_ARRAY(16) with logicalType { kind: 'decimal', ... }
* dec.encode(12345n); // 16-byte big-endian two's-complement Uint8Array
*
* const ts = arrowTypeToParquet(timestamp(TimeUnit.MICROSECOND, 'UTC'));
* // INT64 with logicalType { kind: 'timestamp', ... isAdjustedToUTC: true }
* ```
*
* @internal
*/
export function arrowTypeToParquet(type: DataType): ParquetTypeInfo {
  switch (type.kind) {
    case 'bool': return {
      physicalType: PType.BOOLEAN,
      decode: identity,
      encode: identity
    };
    case 'int': {
      const p8 = type.bitWidth <= 32 ? PType.INT32 : PType.INT64;
      const converted = intConverted(type.bitWidth, type.signed);
      return {
        physicalType: p8,
        convertedType: converted,
        logicalType: {
          kind: 'integer',
          integer: {
            bitWidth: type.bitWidth,
            isSigned: type.signed
          }
        },
        decode: identity,
        encode: identity
      };
    }
    case 'float':
      if (type.precision === 0) return {
        physicalType: PType.FIXED_LEN_BYTE_ARRAY,
        typeLength: 2,
        logicalType: { kind: 'float16' },
        decode: (v) => float16BytesToNumber(v as Uint8Array),
        encode: (v) => numberToFloat16Bytes(v as number)
      };
      if (type.precision === 1) return {
        physicalType: PType.FLOAT,
        decode: identity,
        encode: identity
      };
      return {
        physicalType: PType.DOUBLE,
        decode: identity,
        encode: identity
      };
    case 'decimal': {
      const bytesToBig = (v: unknown) => typeof v === 'bigint' ? v : typeof v === 'number' ? BigInt(v) : decimalBytesToBigInt(v as Uint8Array);
      if (type.bitWidth === 32) return {
        physicalType: PType.INT32,
        convertedType: ConvertedType.DECIMAL,
        logicalType: {
          kind: 'decimal',
          decimal: {
            scale: type.scale,
            precision: type.precision
          }
        },
        scale: type.scale,
        precision: type.precision,
        decode: bytesToBig,
        encode: (v) => Number(v as bigint)
      } as ParquetTypeInfo & {
        scale: number;
        precision: number;
      };
      if (type.bitWidth === 64) return {
        physicalType: PType.INT64,
        convertedType: ConvertedType.DECIMAL,
        logicalType: {
          kind: 'decimal',
          decimal: {
            scale: type.scale,
            precision: type.precision
          }
        },
        decode: bytesToBig,
        encode: (v) => v as bigint
      };
      const len = type.bitWidth === 256 ? 32 : 16;
      return {
        physicalType: PType.FIXED_LEN_BYTE_ARRAY,
        typeLength: len,
        convertedType: ConvertedType.DECIMAL,
        logicalType: {
          kind: 'decimal',
          decimal: {
            scale: type.scale,
            precision: type.precision
          }
        },
        decode: (v) => decimalBytesToBigInt(v as Uint8Array),
        encode: (v) => bigIntToDecimalBytes(v as bigint, len)
      };
    }
    case 'utf8': return {
      physicalType: PType.BYTE_ARRAY,
      convertedType: ConvertedType.UTF8,
      logicalType: { kind: 'string' },
      decode: (v) => _decoder.decode(v as Uint8Array),
      encode: identity
    };
    case 'binary': return {
      physicalType: PType.BYTE_ARRAY,
      decode: identity,
      encode: identity
    };
    case 'fixedsizebinary': return {
      physicalType: PType.FIXED_LEN_BYTE_ARRAY,
      typeLength: type.byteWidth,
      decode: identity,
      encode: identity
    };
    case 'date':
      if (type.unit === 0) return {
        physicalType: PType.INT32,
        convertedType: ConvertedType.DATE,
        logicalType: { kind: 'date' },
        decode: identity,
        encode: identity
      };
      break;
    case 'time': {
      const unitId = type.unit === TimeUnit.MILLISECOND ? TimeUnitId.MILLIS : type.unit === TimeUnit.NANOSECOND ? TimeUnitId.NANOS : TimeUnit.SECOND === type.unit ? -1 : TimeUnitId.MICROS;
      if (unitId === -1) break;
      if (type.bitWidth === 32) return {
        physicalType: PType.INT32,
        convertedType: ConvertedType.TIME_MILLIS,
        logicalType: {
          kind: 'time',
          time: {
            isAdjustedToUTC: false,
            unit: { unit: unitId }
          }
        },
        decode: identity,
        encode: identity
      };
      return {
        physicalType: PType.INT64,
        convertedType: unitId === TimeUnitId.MICROS ? ConvertedType.TIME_MICROS : undefined,
        logicalType: {
          kind: 'time',
          time: {
            isAdjustedToUTC: false,
            unit: { unit: unitId }
          }
        },
        decode: identity,
        encode: identity
      };
    }
    case 'timestamp': {
      const isUtc = type.timezone !== null;
      const unitId = type.unit === TimeUnit.MILLISECOND ? TimeUnitId.MILLIS : type.unit === TimeUnit.NANOSECOND ? TimeUnitId.NANOS : TimeUnitId.MICROS;
      const converted = type.unit === TimeUnit.MILLISECOND ? ConvertedType.TIMESTAMP_MILLIS : type.unit === TimeUnit.MICROSECOND ? ConvertedType.TIMESTAMP_MICROS : undefined;
      return {
        physicalType: PType.INT64,
        convertedType: converted,
        logicalType: {
          kind: 'timestamp',
          timestamp: {
            isAdjustedToUTC: isUtc,
            unit: { unit: unitId }
          }
        },
        decode: identity,
        encode: identity
      };
    }
  }
  throw new ParquetError(`cannot map Arrow type ${type.kind} to Parquet`);
}
function intConverted(bitWidth: number, signed: boolean): number {
  if (signed) return bitWidth === 8 ? ConvertedType.INT_8 : bitWidth === 16 ? ConvertedType.INT_16 : bitWidth === 32 ? ConvertedType.INT_32 : ConvertedType.INT_64;
  return bitWidth === 8 ? ConvertedType.UINT_8 : bitWidth === 16 ? ConvertedType.UINT_16 : bitWidth === 32 ? ConvertedType.UINT_32 : ConvertedType.UINT_64;
}
/**
* Build the Parquet `SchemaElement` and type info for one flat Arrow field.
*
* The element carries the physical type and annotations from
* `arrowTypeToParquet` plus a repetition of OPTIONAL for nullable fields and
* REQUIRED otherwise. 32-bit decimals also populate the element's legacy
* top-level `scale`/`precision` fields; wider decimals carry precision and
* scale only in their annotations. Throws a `ParquetError` (via
* `arrowTypeToParquet`) if the field's type is nested or has no Parquet
* equivalent.
*
* ```ts no_run
* import { arrowFieldToElement } from 'internal:data/parquet/schema';
* import { Field, utf8 } from 'fino:data/arrow';
*
* const { element, info } = arrowFieldToElement(new Field('name', utf8(), true));
* // element → { name: 'name', type: PType.BYTE_ARRAY,
* //             repetitionType: Repetition.OPTIONAL, logicalType: { kind: 'string' }, ... }
* ```
*
* @internal
*/
export function arrowFieldToElement(field: Field): {
  element: SchemaElement;
  info: ParquetTypeInfo;
} {
  const info = arrowTypeToParquet(field.type);
  return {
    element: {
      name: field.name,
      type: info.physicalType,
      typeLength: info.typeLength,
      repetitionType: field.nullable ? Repetition.OPTIONAL : Repetition.REQUIRED,
      convertedType: info.convertedType,
      scale: (info as {
        scale?: number;
      }).scale,
      precision: (info as {
        precision?: number;
      }).precision,
      logicalType: info.logicalType
    },
    info
  };
}
/**
* Build the Parquet `SchemaElement` list and column descriptors for a flat
* Arrow schema.
*
* The returned `elements` start with the root group (named `schema`, carrying
* `numChildren`) followed by one leaf element per field in field order — the
* exact list the writer Thrift-encodes into the file footer. Each field also
* yields a `ColumnDescriptor` with `maxDefinitionLevel` 1 for nullable fields
* (0 otherwise) and `maxRepetitionLevel` 0.
*
* Throws a `ParquetError` if any field is nested or otherwise unmappable;
* schemas containing struct/list/map fields go through
* `internal:data/parquet/nested` instead.
*
* ```ts no_run
* import { arrowSchemaToParquet } from 'internal:data/parquet/schema';
* import { Schema, Field, int64, utf8 } from 'fino:data/arrow';
*
* const { elements, columns } = arrowSchemaToParquet(new Schema([
*   new Field('id', int64(), false),
*   new Field('name', utf8(), true),
* ]));
* // elements: [root, id, name] — ready for the footer
* // columns[1].path → ['name'], columns[1].maxDefinitionLevel → 1
* ```
*/
export function arrowSchemaToParquet(schema: Schema): {
  elements: SchemaElement[];
  columns: ColumnDescriptor[];
} {
  const elements: SchemaElement[] = [{
    name: 'schema',
    numChildren: schema.fields.length
  }];
  const columns: ColumnDescriptor[] = [];
  for (const field of schema.fields) {
    const { element, info } = arrowFieldToElement(field);
    elements.push(element);
    columns.push({
      name: field.name,
      path: [field.name],
      physicalType: info.physicalType,
      typeLength: info.typeLength,
      maxDefinitionLevel: field.nullable ? 1 : 0,
      maxRepetitionLevel: 0,
      arrowField: field,
      decode: info.decode,
      encode: info.encode
    });
  }
  return {
    elements,
    columns
  };
}
// --- Parquet -> Arrow ------------------------------------------------------
/**
* Map a Parquet leaf `SchemaElement` to an Arrow type plus value converters.
*
* Resolution starts from the physical type and refines it with annotations,
* preferring the modern `logicalType` over the legacy `convertedType`:
*
* - INT32 → 32-bit decimal, date32, time32, or a sized integer from the
*   annotation; plain `int32` otherwise.
* - INT64 → 64-bit decimal, timestamp, time64, or a sized integer; plain
*   `int64` otherwise. Legacy TIMESTAMP_MILLIS/MICROS annotations are
*   treated as UTC-adjusted.
* - INT96 → nanosecond timestamp with no timezone (the legacy Impala/Hive
*   layout), decoded to epoch nanoseconds.
* - BYTE_ARRAY → 128-bit decimal, or `utf8` for string/enum/JSON
*   annotations; plain `binary` otherwise.
* - FIXED_LEN_BYTE_ARRAY → `float16`, decimal (256-bit when the element is
*   wider than 16 bytes, 128-bit otherwise), or `fixedSizeBinary` of the
*   declared length.
*
* Throws a `ParquetError` when the element's physical type is unsupported.
*
* ```ts no_run
* import { parquetLeafToArrow } from 'internal:data/parquet/schema';
* import { PType, ConvertedType } from 'internal:data/parquet/types';
*
* const { type, decode } = parquetLeafToArrow({
*   name: 'name',
*   type: PType.BYTE_ARRAY,
*   convertedType: ConvertedType.UTF8,
* });
* // type.kind === 'utf8'
* decode(new Uint8Array([0x68, 0x69])); // 'hi'
* ```
*
* @internal
*/
export function parquetLeafToArrow(el: SchemaElement): {
  type: DataType;
  decode: ValueConverter;
  encode: ValueConverter;
} {
  const logical = el.logicalType;
  const converted = el.convertedType;
  const isDecimal = logical?.kind === 'decimal' || converted === ConvertedType.DECIMAL;
  switch (el.type) {
    case PType.BOOLEAN: return {
      type: bool(),
      decode: identity,
      encode: identity
    };
    case PType.INT32:
      if (isDecimal) return {
        type: decimal(el.precision ?? logical?.decimal?.precision ?? 9, el.scale ?? logical?.decimal?.scale ?? 0, 32),
        decode: (v) => BigInt(v as number),
        encode: (v) => Number(v as bigint)
      };
      if (logical?.kind === 'date' || converted === ConvertedType.DATE) return {
        type: date32(),
        decode: identity,
        encode: identity
      };
      if (logical?.kind === 'time' || converted === ConvertedType.TIME_MILLIS) return {
        type: time32(TimeUnit.MILLISECOND),
        decode: identity,
        encode: identity
      };
      if (logical?.kind === 'integer') return {
        type: intFromWidth(logical.integer!.bitWidth, logical.integer!.isSigned),
        decode: identity,
        encode: identity
      };
      if (converted !== undefined) return {
        type: intFromConverted(converted),
        decode: identity,
        encode: identity
      };
      return {
        type: int32(),
        decode: identity,
        encode: identity
      };
    case PType.INT64:
      if (isDecimal) return {
        type: decimal(el.precision ?? logical?.decimal?.precision ?? 18, el.scale ?? logical?.decimal?.scale ?? 0, 64),
        decode: identity,
        encode: identity
      };
      if (logical?.kind === 'timestamp') return {
        type: timestampFromUnit(logical.timestamp!.unit.unit, logical.timestamp!.isAdjustedToUTC),
        decode: identity,
        encode: identity
      };
      if (converted === ConvertedType.TIMESTAMP_MILLIS) return {
        type: timestamp(TimeUnit.MILLISECOND, 'UTC'),
        decode: identity,
        encode: identity
      };
      if (converted === ConvertedType.TIMESTAMP_MICROS) return {
        type: timestamp(TimeUnit.MICROSECOND, 'UTC'),
        decode: identity,
        encode: identity
      };
      if (logical?.kind === 'time') return {
        type: time64(logical.time!.unit.unit === TimeUnitId.NANOS ? TimeUnit.NANOSECOND : TimeUnit.MICROSECOND),
        decode: identity,
        encode: identity
      };
      if (converted === ConvertedType.TIME_MICROS) return {
        type: time64(TimeUnit.MICROSECOND),
        decode: identity,
        encode: identity
      };
      if (logical?.kind === 'integer') return {
        type: intFromWidth(logical.integer!.bitWidth, logical.integer!.isSigned),
        decode: identity,
        encode: identity
      };
      if (converted === ConvertedType.UINT_64) return {
        type: uint64(),
        decode: identity,
        encode: identity
      };
      return {
        type: int64(),
        decode: identity,
        encode: identity
      };
    case PType.INT96: return {
      type: timestamp(TimeUnit.NANOSECOND, null),
      decode: (v) => int96ToEpochNanos(v as Uint8Array),
      encode: identity
    };
    case PType.FLOAT: return {
      type: float32(),
      decode: identity,
      encode: identity
    };
    case PType.DOUBLE: return {
      type: float64(),
      decode: identity,
      encode: identity
    };
    case PType.BYTE_ARRAY:
      if (isDecimal) return {
        type: decimal(el.precision ?? 38, el.scale ?? 0, 128),
        decode: (v) => decimalBytesToBigInt(v as Uint8Array),
        encode: (v) => bigIntToDecimalBytes(v as bigint, 16)
      };
      if (logical?.kind === 'string' || converted === ConvertedType.UTF8 || converted === ConvertedType.ENUM || converted === ConvertedType.JSON) return {
        type: utf8(),
        decode: (v) => _decoder.decode(v as Uint8Array),
        encode: identity
      };
      return {
        type: binary(),
        decode: identity,
        encode: identity
      };
    case PType.FIXED_LEN_BYTE_ARRAY: {
      const len = el.typeLength ?? 0;
      if (logical?.kind === 'float16') return {
        type: float16(),
        decode: (v) => float16BytesToNumber(v as Uint8Array),
        encode: (v) => numberToFloat16Bytes(v as number)
      };
      if (isDecimal) return {
        type: decimal(el.precision ?? logical?.decimal?.precision ?? 38, el.scale ?? logical?.decimal?.scale ?? 0, len > 16 ? 256 : 128),
        decode: (v) => decimalBytesToBigInt(v as Uint8Array),
        encode: (v) => bigIntToDecimalBytes(v as bigint, len)
      };
      return {
        type: fixedSizeBinary(len),
        decode: identity,
        encode: identity
      };
    }
    default: throw new ParquetError(`Parquet physical type ${el.type} is not supported`);
  }
}
function intFromWidth(bitWidth: number, signed: boolean): DataType {
  if (signed) return bitWidth === 8 ? int8() : bitWidth === 16 ? int16() : bitWidth === 32 ? int32() : int64();
  return bitWidth === 8 ? uint8() : bitWidth === 16 ? uint16() : bitWidth === 32 ? uint32() : uint64();
}
function intFromConverted(converted: number): DataType {
  switch (converted) {
    case ConvertedType.INT_8: return int8();
    case ConvertedType.INT_16: return int16();
    case ConvertedType.INT_32: return int32();
    case ConvertedType.UINT_8: return uint8();
    case ConvertedType.UINT_16: return uint16();
    case ConvertedType.UINT_32: return uint32();
    default: return int32();
  }
}
function timestampFromUnit(unitId: number, isUtc: boolean): DataType {
  const unit = unitId === TimeUnitId.MILLIS ? TimeUnit.MILLISECOND : unitId === TimeUnitId.NANOS ? TimeUnit.NANOSECOND : TimeUnit.MICROSECOND;
  return timestamp(unit, isUtc ? 'UTC' : null);
}
/**
* Build the Arrow schema and column descriptors from a Parquet
* `SchemaElement` list.
*
* Expects the footer's flattened schema: the root element first, followed by
* its `numChildren` leaves. Every leaf whose repetition is not REQUIRED
* becomes a nullable Arrow field with `maxDefinitionLevel` 1.
*
* Handles flat schemas only. Throws a `ParquetError` when the list is empty
* or truncated, or when it contains a group column — nested schemas must be
* parsed with `internal:data/parquet/nested` instead.
*
* ```ts no_run
* import { parquetSchemaToArrow } from 'internal:data/parquet/schema';
*
* const { schema, columns } = parquetSchemaToArrow(footer.schema);
* schema.fields.map((f) => `${f.name}: ${f.type.kind}`);
* // e.g. ['id: int', 'name: utf8']
* ```
*/
export function parquetSchemaToArrow(elements: SchemaElement[]): {
  schema: Schema;
  columns: ColumnDescriptor[];
} {
  if (elements.length === 0) throw new ParquetError('empty Parquet schema');
  const root = elements[0]!;
  const numChildren = root.numChildren ?? 0;
  const fields: Field[] = [];
  const columns: ColumnDescriptor[] = [];
  let i = 1;
  for (let c = 0; c < numChildren; c++) {
    const el = elements[i];
    if (el === undefined) throw new ParquetError('truncated Parquet schema');
    if ((el.numChildren ?? 0) > 0) throw new ParquetError(`nested column '${el.name}' requires the nested reader`);
    const { type, decode, encode } = parquetLeafToArrow(el);
    const nullable = el.repetitionType !== Repetition.REQUIRED;
    const field = new Field(el.name, type, nullable);
    fields.push(field);
    columns.push({
      name: el.name,
      path: [el.name],
      physicalType: el.type ?? PType.BYTE_ARRAY,
      typeLength: el.typeLength,
      maxDefinitionLevel: nullable ? 1 : 0,
      maxRepetitionLevel: 0,
      arrowField: field,
      decode,
      encode
    });
    i++;
  }
  return {
    schema: new Schema(fields),
    columns
  };
}
void LogicalTypeId;
