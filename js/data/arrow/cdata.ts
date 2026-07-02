/**
* fino:data/arrow/cdata - the Arrow C Data Interface over `fino:ffi`.
*
* Exchanges Arrow arrays with native libraries in-process with zero copies:
* `exportVector`/`exportRecordBatch` build the `ArrowSchema`/`ArrowArray`
* structs a consumer expects, and `importVector`/`importRecordBatch` wrap the
* structs a producer hands back into fino vectors (aliasing native memory via
* `Pointer.view`). The `format` string codec (`typeToFormat`/`formatToType`)
* is pure and covers every Arrow type.
*
* This module is kept separate from the pure model so `fino:data/arrow` never
* loads `fino:ffi`.
*
* @internal
*/
import { Pointer, FfiCallback, structType } from 'fino:ffi';
import { ArrowError } from './errors.ts';
import { Field } from './schema.ts';
import { RecordBatch } from './batch.ts';
import { Vector, makeVector, type VectorData } from './vector.ts';
import { type DataType, Type, UnionMode, TimeUnit, DateUnit, IntervalUnit, Precision, bufferLayout, fixedWidthBytes, struct, list, largeList, largeUtf8, utf8, binary, largeBinary, fixedSizeBinary, fixedSizeList, listView, largeListView, map as mapType, union, runEndEncoded, dictionary, nullType, bool, int8, int16, int32, int64, uint8, uint16, uint32, uint64, float16, float32, float64, decimal, date32, date64, time32, time64, timestamp, duration, interval, utf8View, binaryView } from './type.ts';
import type { IntType } from './type.ts';
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();
// ArrowSchema: format,name,metadata (ptr×3), flags,n_children (i64×2),
// children,dictionary,release,private_data (ptr×4). 72 bytes.
const ArrowSchema = structType([
  ['format', 'pointer'],
  ['name', 'pointer'],
  ['metadata', 'pointer'],
  ['flags', 'i64'],
  ['n_children', 'i64'],
  ['children', 'pointer'],
  ['dictionary', 'pointer'],
  ['release', 'pointer'],
  ['private_data', 'pointer']
]);
// ArrowArray: length,null_count,offset,n_buffers,n_children (i64×5),
// buffers,children,dictionary,release,private_data (ptr×5). 80 bytes.
const ArrowArray = structType([
  ['length', 'i64'],
  ['null_count', 'i64'],
  ['offset', 'i64'],
  ['n_buffers', 'i64'],
  ['n_children', 'i64'],
  ['buffers', 'pointer'],
  ['children', 'pointer'],
  ['dictionary', 'pointer'],
  ['release', 'pointer'],
  ['private_data', 'pointer']
]);
// ---------------------------------------------------------------------------
// Format string codec
// ---------------------------------------------------------------------------
const TIME_UNIT_CODE: Record<number, string> = {
  [TimeUnit.SECOND]: 's',
  [TimeUnit.MILLISECOND]: 'm',
  [TimeUnit.MICROSECOND]: 'u',
  [TimeUnit.NANOSECOND]: 'n'
};
const CODE_TIME_UNIT: Record<string, number> = {
  s: TimeUnit.SECOND,
  m: TimeUnit.MILLISECOND,
  u: TimeUnit.MICROSECOND,
  n: TimeUnit.NANOSECOND
};
/** The Arrow C Data Interface format string for a type. */
export function typeToFormat(type: DataType): string {
  switch (type.kind) {
    case 'null': return 'n';
    case 'bool': return 'b';
    case 'int': return {
      8: type.signed ? 'c' : 'C',
      16: type.signed ? 's' : 'S',
      32: type.signed ? 'i' : 'I',
      64: type.signed ? 'l' : 'L'
    }[type.bitWidth]!;
    case 'float': return type.precision === Precision.HALF ? 'e' : type.precision === Precision.SINGLE ? 'f' : 'g';
    case 'decimal': return `d:${type.precision},${type.scale}${type.bitWidth === 128 ? '' : `,${type.bitWidth}`}`;
    case 'binary': return 'z';
    case 'largebinary': return 'Z';
    case 'utf8': return 'u';
    case 'largeutf8': return 'U';
    case 'binaryview': return 'vz';
    case 'utf8view': return 'vu';
    case 'fixedsizebinary': return `w:${type.byteWidth}`;
    case 'date': return type.unit === DateUnit.DAY ? 'tdD' : 'tdm';
    case 'time': return type.bitWidth === 32 ? `tt${TIME_UNIT_CODE[type.unit]}` : `tt${TIME_UNIT_CODE[type.unit]}`;
    case 'timestamp': return `ts${TIME_UNIT_CODE[type.unit]}:${type.timezone ?? ''}`;
    case 'duration': return `tD${TIME_UNIT_CODE[type.unit]}`;
    case 'interval': return type.unit === IntervalUnit.YEAR_MONTH ? 'tiM' : type.unit === IntervalUnit.DAY_TIME ? 'tiD' : 'tin';
    case 'list': return '+l';
    case 'largelist': return '+L';
    case 'listview': return '+vl';
    case 'largelistview': return '+vL';
    case 'fixedsizelist': return `+w:${type.listSize}`;
    case 'struct': return '+s';
    case 'map': return '+m';
    case 'union': return `+u${type.mode === UnionMode.Dense ? 'd' : 's'}:${type.typeIds.join(',')}`;
    case 'runendencoded': return '+r';
    case 'dictionary': return typeToFormat(type.indexType);
  }
}
/**
* Parse an Arrow C Data Interface format string into a type. Nested types
* (`+l`, `+s`, ...) take their child types from the supplied `children`.
*/
export function formatToType(format: string, children: Field[] = []): DataType {
  switch (format) {
    case 'n': return nullType();
    case 'b': return bool();
    case 'c': return int8();
    case 'C': return uint8();
    case 's': return int16();
    case 'S': return uint16();
    case 'i': return int32();
    case 'I': return uint32();
    case 'l': return int64();
    case 'L': return uint64();
    case 'e': return float16();
    case 'f': return float32();
    case 'g': return float64();
    case 'z': return binary();
    case 'Z': return largeBinary();
    case 'u': return utf8();
    case 'U': return largeUtf8();
    case 'vz': return binaryView();
    case 'vu': return utf8View();
    case 'tdD': return date32();
    case 'tdm': return date64();
    case 'tiM': return interval(IntervalUnit.YEAR_MONTH);
    case 'tiD': return interval(IntervalUnit.DAY_TIME);
    case 'tin': return interval(IntervalUnit.MONTH_DAY_NANO);
    case '+l': return list(children[0]!);
    case '+L': return largeList(children[0]!);
    case '+vl': return listView(children[0]!);
    case '+vL': return largeListView(children[0]!);
    case '+s': return struct(children);
    case '+m': return mapType(children[0]!, false);
    case '+r': return runEndEncoded(children[0]!, children[1]!);
  }
  if (format.startsWith('w:')) return fixedSizeBinary(parseInt(format.slice(2), 10));
  if (format.startsWith('+w:')) return fixedSizeList(parseInt(format.slice(3), 10), children[0]!);
  if (format.startsWith('d:')) {
    const parts = format.slice(2).split(',').map((n) => parseInt(n, 10));
    return decimal(parts[0]!, parts[1]!, (parts[2] ?? 128) as 32 | 64 | 128 | 256);
  }
  if (format.startsWith('tt')) return format[3] === undefined || 'smun'.includes(format[2]!) ? 'smun'.indexOf(format[2]!) <= 1 ? time32(CODE_TIME_UNIT[format[2]!]!) : time64(CODE_TIME_UNIT[format[2]!]!) : time32(TimeUnit.MILLISECOND);
  if (format.startsWith('ts')) {
    const unit = CODE_TIME_UNIT[format[2]!]!;
    const tz = format.slice(4);
    return timestamp(unit, tz.length > 0 ? tz : null);
  }
  if (format.startsWith('tD')) return duration(CODE_TIME_UNIT[format[2]!]!);
  if (format.startsWith('+us:') || format.startsWith('+ud:')) {
    const dense = format[2] === 'd';
    const ids = format.slice(4).split(',').filter((s) => s.length > 0).map((n) => parseInt(n, 10));
    return union(dense ? UnionMode.Dense : UnionMode.Sparse, ids, children);
  }
  throw new ArrowError(`unsupported Arrow C Data Interface format string '${format}'`);
}
// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
interface ExportEntry {
  pins: unknown[];
}
// Keyed by the native address of the exported ArrowArray struct, so both our
// release callback and importVector.release can find and drop the pinned
// buffers without a private_data slot.
const exportRegistry = new Map<bigint, ExportEntry>();
// release lives at offset 64 in ArrowArray.
const RELEASE_OFFSET_MARKER = 64;
let releaseCallback: ReturnType<typeof FfiCallback> | null = null;
function releaseFn(): ReturnType<typeof FfiCallback> {
  if (releaseCallback === null) {
    releaseCallback = new FfiCallback({
      parameters: ['pointer'],
      result: 'void'
    }, (structPtr: unknown) => {
      // A consumer signals it is done: drop our pinned buffers and mark the
      // struct released per the C Data Interface contract.
      const p = structPtr as ArrayBuffer;
      const addr = new DataView(p).getBigUint64(0, true);
      exportRegistry.delete(addr);
      Pointer.writeU64(p, RELEASE_OFFSET_MARKER, 0n);
    });
  }
  return releaseCallback;
}
// Build an array of pointer values (addresses of the given buffers) and return
// a pointer value to that array. The array buffer is pinned.
function ptrArrayPointer(targets: (ArrayBuffer | ArrayBufferView | null)[], pins: unknown[]): ArrayBuffer {
  const buf = new ArrayBuffer(Math.max(1, targets.length) * 8);
  const dv = new DataView(buf);
  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    dv.setBigUint64(i * 8, p === null ? 0n : Pointer.addr(p), true);
  }
  pins.push(buf);
  return Pointer.of(buf) as ArrayBuffer;
}
function cStringPointer(s: string, pins: unknown[]): ArrayBuffer {
  const bytes = new Uint8Array(_encoder.encode(s).length + 1);
  bytes.set(_encoder.encode(s), 0);
  pins.push(bytes);
  return Pointer.of(bytes) as ArrayBuffer;
}
/**
* Export a vector's schema + array into freshly allocated C structs. Returns
* pointer values to the two structs; the consumer must call the array's
* `release`.
*/
export function exportVector(vector: Vector, field?: Field): {
  schema: ArrayBuffer;
  array: ArrayBuffer;
} {
  const f = field ?? new Field('', vector.type, vector.nullCount > 0);
  const pins: unknown[] = [];
  const schemaBuf = buildSchema(f, pins);
  const arrayBuf = buildArray(vector, pins);
  ArrowArray.set(arrayBuf, 'release', releaseFn().pointer);
  exportRegistry.set(Pointer.addr(arrayBuf), { pins });
  return {
    schema: Pointer.of(schemaBuf) as ArrayBuffer,
    array: Pointer.of(arrayBuf) as ArrayBuffer
  };
}
function buildSchema(field: Field, pins: unknown[]): ArrayBuffer {
  const type = field.type;
  const childFields = childFieldsOf(type);
  const childSchemas = childFields.map((c) => buildSchema(c, pins));
  const buf = ArrowSchema.alloc();
  pins.push(buf);
  ArrowSchema.set(buf, 'format', cStringPointer(typeToFormat(type), pins));
  ArrowSchema.set(buf, 'name', cStringPointer(field.name, pins));
  ArrowSchema.set(buf, 'flags', field.nullable ? 2 : 0);
  ArrowSchema.set(buf, 'n_children', childSchemas.length);
  if (childSchemas.length > 0) ArrowSchema.set(buf, 'children', ptrArrayPointer(childSchemas, pins));
  ArrowSchema.set(buf, 'release', releaseFn().pointer);
  if (type.kind === 'dictionary') {
    ArrowSchema.set(buf, 'dictionary', Pointer.of(buildSchema(new Field('', type.valueType, true), pins)) as ArrayBuffer);
  }
  return buf;
}
function buildArray(vector: Vector, pins: unknown[]): ArrayBuffer {
  const raw = vector.toRaw();
  const buffers: (Uint8Array | null)[] = [];
  for (const kind of bufferLayout(vector.type)) {
    buffers.push(exportBuffer(kind, vector, raw, pins));
  }
  const buf = ArrowArray.alloc();
  pins.push(buf);
  ArrowArray.set(buf, 'length', vector.length);
  ArrowArray.set(buf, 'null_count', vector.nullCount);
  ArrowArray.set(buf, 'offset', raw.offset ?? 0);
  ArrowArray.set(buf, 'n_buffers', buffers.length);
  ArrowArray.set(buf, 'buffers', ptrArrayPointer(buffers, pins));
  const children = vector.children;
  if (children.length > 0) {
    const childArrays = children.map((c) => buildArray(c, pins));
    ArrowArray.set(buf, 'n_children', childArrays.length);
    ArrowArray.set(buf, 'children', ptrArrayPointer(childArrays, pins));
  }
  if (vector.type.kind === 'dictionary') {
    ArrowArray.set(buf, 'dictionary', Pointer.of(buildArray(((vector as unknown) as {
      dictionary: Vector;
    }).dictionary, pins)) as ArrayBuffer);
  }
  return buf;
}
function exportBuffer(kind: string, vector: Vector, raw: VectorData, pins: unknown[]): Uint8Array | null {
  let bytes: Uint8Array | null = null;
  switch (kind) {
    case 'validity':
      bytes = raw.validity ?? null;
      break;
    case 'data':
      bytes = raw.values ?? null;
      break;
    case 'offset32':
    case 'offset64':
      bytes = raw.valueOffsets ?? null;
      break;
    case 'size32':
    case 'size64':
      bytes = raw.sizes ?? null;
      break;
    case 'typeIds':
      bytes = raw.typeIds ?? null;
      break;
    case 'views':
      bytes = raw.views ?? null;
      break;
  }
  void vector;
  if (bytes === null) return null;
  pins.push(bytes);
  return bytes;
}
function childFieldsOf(type: DataType): Field[] {
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
/** Export a record batch as a struct array (Arrow models a batch as a struct). */
export function exportRecordBatch(batch: RecordBatch): {
  schema: ArrayBuffer;
  array: ArrayBuffer;
} {
  const structType_ = struct(batch.schema.fields);
  const structVec = makeVector({
    type: structType_,
    length: batch.numRows,
    children: batch.columns
  });
  return exportVector(structVec, new Field('', structType_, false));
}
// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
/**
* Import an Arrow array from `ArrowSchema`/`ArrowArray` pointers into a fino
* vector. Buffers are aliased via `Pointer.view`.
*
* `release()` drops this importer's hold. For arrays exported by this module
* in-process it also frees the pinned source buffers (via `private_data`). For
* arrays produced by a foreign library, the producer's `release` function
* pointer cannot yet be invoked from JS (that needs a future function-pointer
* call primitive in `fino:ffi`); such arrays are freed when the producer is
* torn down. Do not use imported views after `release()`.
*/
export function importVector(schemaPtr: ArrayBuffer, arrayPtr: ArrayBuffer): {
  value: Vector;
  release(): void;
  [Symbol.dispose](): void;
} {
  const field = importSchema(schemaPtr);
  const vector = importArray(field, arrayPtr);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    // If this is one of our own in-process exports, drop its registry pins.
    const addr = new DataView(arrayPtr).getBigUint64(0, true);
    exportRegistry.delete(addr);
  };
  return {
    value: vector,
    release,
    [Symbol.dispose]: release
  };
}
function importSchema(schemaPtr: ArrayBuffer): Field {
  const formatPtr = Pointer.readPointer(schemaPtr, 0);
  const format = readCString(formatPtr);
  const namePtr = Pointer.readPointer(schemaPtr, 8);
  const name = namePtr === null ? '' : readCString(namePtr);
  const flags = Pointer.readU64(schemaPtr, 24);
  const nChildren = Number(Pointer.readU64(schemaPtr, 32));
  const childrenPtr = Pointer.readPointer(schemaPtr, 40);
  const children: Field[] = [];
  for (let i = 0; i < nChildren; i++) {
    const childPtr = Pointer.readPointer(childrenPtr, i * 8);
    children.push(importSchema(childPtr as ArrayBuffer));
  }
  let type = formatToType(format, children);
  const dictPtr = Pointer.readPointer(schemaPtr, 48);
  if (dictPtr !== null) {
    const valueField = importSchema(dictPtr as ArrayBuffer);
    type = dictionary(0, type as IntType, valueField.type, false);
  }
  return new Field(name, type, (flags & 2n) !== 0n);
}
function importArray(field: Field, arrayPtr: ArrayBuffer): Vector {
  const type = field.type;
  const length = Number(Pointer.readU64(arrayPtr, 0));
  const nullCount = Number(Pointer.readI64(arrayPtr, 8));
  const offset = Number(Pointer.readU64(arrayPtr, 16));
  const nBuffers = Number(Pointer.readU64(arrayPtr, 24));
  const buffersPtr = Pointer.readPointer(arrayPtr, 40);
  const data: VectorData = {
    type,
    length,
    nullCount,
    offset
  };
  const layout = bufferLayout(type);
  const total = length + offset;
  const isVarBinary = type.kind === 'utf8' || type.kind === 'binary' || type.kind === 'largeutf8' || type.kind === 'largebinary';
  const large = type.kind === 'largeutf8' || type.kind === 'largebinary';
  let lastOffsets: Uint8Array | null = null;
  for (let i = 0; i < layout.length && i < nBuffers; i++) {
    const kind = layout[i]!;
    const bp = Pointer.readPointer(buffersPtr, i * 8) as ArrayBuffer | null;
    let byteLen: number;
    if (kind === 'data' && isVarBinary) {
      // Variable-binary data length = the final offset value.
      byteLen = lastOffsets === null ? 0 : readOffsetAt(lastOffsets, total, large);
    } else {
      byteLen = bufferByteLength(type, kind, total);
    }
    let bytes: Uint8Array | null = null;
    if (bp !== null && byteLen > 0) bytes = new Uint8Array(Pointer.view(bp, byteLen));
    if (kind === 'offset32' || kind === 'offset64') lastOffsets = bytes;
    assignBuffer(data, kind, bytes);
  }
  // Children.
  const childFields = childFieldsOf(type);
  if (childFields.length > 0) {
    const childrenPtr = Pointer.readPointer(arrayPtr, 48);
    data.children = childFields.map((cf, i) => importArray(cf, Pointer.readPointer(childrenPtr, i * 8) as ArrayBuffer));
  }
  if (type.kind === 'dictionary') {
    const dictArrayPtr = Pointer.readPointer(arrayPtr, 56) as ArrayBuffer;
    data.dictionary = importArray(new Field('', type.valueType, true), dictArrayPtr);
  }
  return makeVector(data);
}
function readOffsetAt(offsets: Uint8Array, i: number, large: boolean): number {
  const dv = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
  return large ? Number(dv.getBigInt64(i * 8, true)) : dv.getInt32(i * 4, true);
}
function assignBuffer(data: VectorData, kind: string, bytes: Uint8Array | null): void {
  switch (kind) {
    case 'validity':
      data.validity = bytes;
      break;
    case 'data':
      data.values = bytes ?? new Uint8Array(0);
      break;
    case 'offset32':
    case 'offset64':
      data.valueOffsets = bytes ?? new Uint8Array(0);
      break;
    case 'size32':
    case 'size64':
      data.sizes = bytes ?? new Uint8Array(0);
      break;
    case 'typeIds':
      data.typeIds = bytes ?? new Uint8Array(0);
      break;
    case 'views':
      data.views = bytes ?? new Uint8Array(0);
      break;
  }
}
function bufferByteLength(type: DataType, kind: string, total: number): number {
  switch (kind) {
    case 'validity': return total + 7 >> 3;
    case 'data':
      if (type.kind === 'bool') return total + 7 >> 3;
      return total * (type.kind === 'dictionary' ? fixedWidthBytes(type.indexType) : fixedWidthBytes(type));
    case 'offset32': return (total + 1) * 4;
    case 'offset64': return (total + 1) * 8;
    case 'size32': return total * 4;
    case 'size64': return total * 8;
    case 'typeIds': return total;
    case 'views': return total * 16;
  }
  return 0;
}
function readCString(ptr: ArrayBuffer | null): string {
  if (ptr === null) return '';
  const bytes: number[] = [];
  for (let i = 0; i < 4096; i++) {
    const b = Pointer.readU8(ptr, i);
    if (b === 0) break;
    bytes.push(b);
  }
  return _decoder.decode(new Uint8Array(bytes));
}
