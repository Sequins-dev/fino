/**
* Mapping between a Parquet schema (a flat list of `SchemaElement`s describing a
* tree) and an Arrow schema, plus the per-column descriptors the reader/writer
* need (physical type, logical/converted type, and max definition/repetition
* levels).
*
* This milestone covers flat (non-nested) schemas: the common physical types
* with their integer width/sign, string, date, and timestamp logical types.
* Nested group columns raise a clear error pending the nesting phase.
*
* @internal
*/
import { Field, Schema, TimeUnit, type DataType, bool, int8, int16, int32, int64, uint8, uint16, uint32, uint64, float32, float64, utf8, binary, date32, timestamp } from 'fino:data/arrow';
import { PType, ConvertedType, Repetition, TimeUnitId, ParquetError } from './types.ts';
import type { SchemaElement, LogicalType } from './metadata.ts';
/** A single leaf column: how to encode/decode it and where it sits. @internal */
export interface ColumnDescriptor {
  name: string;
  path: string[];
  physicalType: number;
  typeLength?: number;
  maxDefinitionLevel: number;
  maxRepetitionLevel: number;
  arrowField: Field;
}
// --- Arrow -> Parquet ------------------------------------------------------
interface ParquetTypeInfo {
  physicalType: number;
  convertedType?: number;
  logicalType?: LogicalType;
  typeLength?: number;
}
function arrowTypeToParquet(type: DataType): ParquetTypeInfo {
  switch (type.kind) {
    case 'bool': return { physicalType: PType.BOOLEAN };
    case 'int':
      switch (type.bitWidth) {
        case 8: return {
          physicalType: PType.INT32,
          convertedType: type.signed ? ConvertedType.INT_8 : ConvertedType.UINT_8,
          logicalType: {
            kind: 'integer',
            integer: {
              bitWidth: 8,
              isSigned: type.signed
            }
          }
        };
        case 16: return {
          physicalType: PType.INT32,
          convertedType: type.signed ? ConvertedType.INT_16 : ConvertedType.UINT_16,
          logicalType: {
            kind: 'integer',
            integer: {
              bitWidth: 16,
              isSigned: type.signed
            }
          }
        };
        case 32: return {
          physicalType: PType.INT32,
          convertedType: type.signed ? ConvertedType.INT_32 : ConvertedType.UINT_32,
          logicalType: {
            kind: 'integer',
            integer: {
              bitWidth: 32,
              isSigned: type.signed
            }
          }
        };
        case 64: return {
          physicalType: PType.INT64,
          convertedType: type.signed ? ConvertedType.INT_64 : ConvertedType.UINT_64,
          logicalType: {
            kind: 'integer',
            integer: {
              bitWidth: 64,
              isSigned: type.signed
            }
          }
        };
      }
      break;
    case 'float':
      if (type.precision === 1) return { physicalType: PType.FLOAT };
      if (type.precision === 2) return { physicalType: PType.DOUBLE };
      break;
    case 'utf8': return {
      physicalType: PType.BYTE_ARRAY,
      convertedType: ConvertedType.UTF8,
      logicalType: { kind: 'string' }
    };
    case 'binary': return { physicalType: PType.BYTE_ARRAY };
    case 'date':
      if (type.unit === 0) return {
        physicalType: PType.INT32,
        convertedType: ConvertedType.DATE,
        logicalType: { kind: 'date' }
      };
      break;
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
        }
      };
    }
  }
  throw new ParquetError(`cannot map Arrow type ${type.kind} to Parquet in this milestone`);
}
/**
* Build the Parquet `SchemaElement` list (root + leaves) and column descriptors
* for an Arrow schema. Flat schemas only.
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
    const info = arrowTypeToParquet(field.type);
    const repetition = field.nullable ? Repetition.OPTIONAL : Repetition.REQUIRED;
    elements.push({
      name: field.name,
      type: info.physicalType,
      typeLength: info.typeLength,
      repetitionType: repetition,
      convertedType: info.convertedType,
      logicalType: info.logicalType
    });
    columns.push({
      name: field.name,
      path: [field.name],
      physicalType: info.physicalType,
      typeLength: info.typeLength,
      maxDefinitionLevel: field.nullable ? 1 : 0,
      maxRepetitionLevel: 0,
      arrowField: field
    });
  }
  return {
    elements,
    columns
  };
}
// --- Parquet -> Arrow ------------------------------------------------------
function parquetTypeToArrow(el: SchemaElement): DataType {
  const logical = el.logicalType;
  const converted = el.convertedType;
  switch (el.type) {
    case PType.BOOLEAN: return bool();
    case PType.INT32:
      if (logical?.kind === 'date' || converted === ConvertedType.DATE) return date32();
      if (logical?.kind === 'integer') return intFromWidth(logical.integer!.bitWidth, logical.integer!.isSigned);
      if (converted !== undefined) return intFromConverted(converted);
      return int32();
    case PType.INT64:
      if (logical?.kind === 'timestamp') return timestampFromUnit(logical.timestamp!.unit.unit, logical.timestamp!.isAdjustedToUTC);
      if (converted === ConvertedType.TIMESTAMP_MILLIS) return timestamp(TimeUnit.MILLISECOND, 'UTC');
      if (converted === ConvertedType.TIMESTAMP_MICROS) return timestamp(TimeUnit.MICROSECOND, 'UTC');
      if (logical?.kind === 'integer') return intFromWidth(logical.integer!.bitWidth, logical.integer!.isSigned);
      if (converted === ConvertedType.UINT_64) return uint64();
      if (converted === ConvertedType.INT_64) return int64();
      return int64();
    case PType.FLOAT: return float32();
    case PType.DOUBLE: return float64();
    case PType.BYTE_ARRAY:
      if (logical?.kind === 'string' || converted === ConvertedType.UTF8) return utf8();
      return binary();
    default: throw new ParquetError(`Parquet physical type ${el.type} is not supported in this milestone`);
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
* list. Flat schemas only; nested group columns raise `ParquetError`.
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
    if ((el.numChildren ?? 0) > 0) throw new ParquetError(`nested column '${el.name}' is not supported in this milestone`);
    const arrowType = parquetTypeToArrow(el);
    const nullable = el.repetitionType !== Repetition.REQUIRED;
    const field = new Field(el.name, arrowType, nullable);
    fields.push(field);
    columns.push({
      name: el.name,
      path: [el.name],
      physicalType: el.type ?? PType.BYTE_ARRAY,
      typeLength: el.typeLength,
      maxDefinitionLevel: nullable ? 1 : 0,
      maxRepetitionLevel: 0,
      arrowField: field
    });
    i++;
  }
  return {
    schema: new Schema(fields),
    columns
  };
}
