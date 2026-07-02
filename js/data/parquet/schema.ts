/**
* Mapping between a Parquet schema and an Arrow schema, plus per-column
* descriptors (physical type, max levels) and the value converters that bridge
* Parquet physical representations and Arrow JS values.
*
* Flat columns are handled here; nested group columns are handled by
* `nested.ts` (which reuses `arrowTypeToParquet`/`parquetLeafToArrow`).
*
* @internal
*/
import { Field, Schema, TimeUnit, type DataType, bool, int8, int16, int32, int64, uint8, uint16, uint32, uint64, float16, float32, float64, utf8, binary, date32, timestamp, time32, time64, decimal, fixedSizeBinary } from 'fino:data/arrow';
import { PType, ConvertedType, Repetition, TimeUnitId, LogicalTypeId, ParquetError } from './types.ts';
import type { SchemaElement, LogicalType } from './metadata.ts';
import { decimalBytesToBigInt, bigIntToDecimalBytes, int96ToEpochNanos, float16BytesToNumber, numberToFloat16Bytes } from './convert.ts';
const _decoder = new TextDecoder();
/** Convert a decoded physical value to the Arrow JS value, or the reverse. @internal */
export type ValueConverter = (value: unknown) => unknown;
const identity: ValueConverter = (v) => v;
/** A single leaf column: how to encode/decode it and where it sits. @internal */
export interface ColumnDescriptor {
  name: string;
  path: string[];
  physicalType: number;
  typeLength?: number;
  maxDefinitionLevel: number;
  maxRepetitionLevel: number;
  arrowField: Field;
  /** Parquet physical value → Arrow JS value. */
  decode: ValueConverter;
  /** Arrow JS value → Parquet physical value (for PLAIN/dictionary encode). */
  encode: ValueConverter;
}
// --- Arrow -> Parquet ------------------------------------------------------
/** Physical + logical typing plus converters for an Arrow leaf type. @internal */
export interface ParquetTypeInfo {
  physicalType: number;
  convertedType?: number;
  logicalType?: LogicalType;
  typeLength?: number;
  decode: ValueConverter;
  encode: ValueConverter;
}
/** Map an Arrow leaf type to its Parquet physical/logical typing + converters. @internal */
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
/** Build the Parquet element + descriptor for one Arrow field (flat). @internal */
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
* Build the Parquet `SchemaElement` list (root + leaves) and column descriptors
* for a flat Arrow schema.
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
/** Map a Parquet leaf `SchemaElement` to an Arrow type + converters. @internal */
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
* Build the Arrow schema and column descriptors from a Parquet `SchemaElement`
* list. Flat schemas; nested group columns are dispatched to `nested.ts`.
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
