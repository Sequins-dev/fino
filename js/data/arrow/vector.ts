/**
* Arrow columnar arrays — one `Vector` class per physical layout.
*
* Vectors own their buffers and a logical offset (so `slice` is zero-copy).
* `get(i)` returns raw physical values: `number` for widths up to 32 bits,
* `bigint` for 64-bit ints/timestamps/durations, `boolean`, `string`,
* `Uint8Array` for binary, arrays/objects for nested types, and `null` for
* nulls. `makeVector` builds any vector from raw buffers (the hot path used by
* IPC and native producers); `vectorFromArray` infers a type from JS values.
*
* @internal
*/
import { ArrowError } from './errors.ts';
import { Field } from './schema.ts';
import { type DataType, Precision, DateUnit, IntervalUnit, UnionMode, fixedWidthBytes, bool, int32, int64, float64, utf8, list, struct } from './type.ts';
const _decoder = new TextDecoder();
const _encoder = new TextEncoder();
/** Raw column data used to construct a `Vector`. */
export interface VectorData {
  type: DataType;
  length: number;
  nullCount?: number;
  validity?: Uint8Array | null;
  offset?: number;
  values?: Uint8Array;
  valueOffsets?: Uint8Array;
  sizes?: Uint8Array;
  views?: Uint8Array;
  variadicBuffers?: Uint8Array[];
  typeIds?: Uint8Array;
  children?: Vector[];
  dictionary?: Vector;
}
function bitGet(bitmap: Uint8Array, i: number): boolean {
  return (bitmap[i >> 3]! & 1 << (i & 7)) !== 0;
}
function readLeBigInt(bytes: Uint8Array, offset: number, byteLength: number, signed: boolean): bigint {
  let value = 0n;
  for (let i = byteLength - 1; i >= 0; i--) {
    value = value << 8n | BigInt(bytes[offset + i]!);
  }
  if (signed && (bytes[offset + byteLength - 1]! & 128) !== 0) {
    value -= 1n << BigInt(byteLength * 8);
  }
  return value;
}
/** Abstract base for every Arrow vector. */
export abstract class Vector {
  /** Logical type of the column. */
  readonly type: DataType;
  /** Number of logical elements. */
  readonly length: number;
  /**
  * Validity bitmap (LSB-first), or `null` when all values are valid.
  *
  * @internal
  */
  readonly validity: Uint8Array | null;
  /**
  * Logical element offset into the buffers (for zero-copy slicing / imports).
  *
  * @internal
  */
  protected offset: number;
  /**
  * Child vectors for nested types.
  *
  * @internal
  */
  readonly children: Vector[];
  #nullCount: number;
  constructor(data: VectorData) {
    this.type = data.type;
    this.length = data.length;
    this.validity = data.validity ?? null;
    this.offset = data.offset ?? 0;
    this.children = data.children ?? [];
    this.#nullCount = data.nullCount ?? -1;
  }
  /** Number of null entries (computed lazily from the validity bitmap). */
  get nullCount(): number {
    if (this.#nullCount < 0) {
      if (this.validity === null) {
        this.#nullCount = 0;
      } else {
        let n = 0;
        for (let i = 0; i < this.length; i++) if (!bitGet(this.validity, this.offset + i)) n++;
        this.#nullCount = n;
      }
    }
    return this.#nullCount;
  }
  /** Whether element `i` is non-null. */
  isValid(i: number): boolean {
    if (this.validity === null) return true;
    return bitGet(this.validity, this.offset + i);
  }
  /** Read element `i` (null-aware), returning the physical value or `null`. */
  get(i: number): unknown {
    if (i < 0 || i >= this.length) return undefined;
    if (!this.isValid(i)) return null;
    return this.getValue(this.offset + i);
  }
  /**
  * Read the physical value at absolute (offset-applied) index `i`, ignoring
  * validity. Implemented per layout.
  *
  * @internal
  */
  protected abstract getValue(i: number): unknown;
  /** Materialize the column as a plain array (nulls become `null`). */
  toArray(): unknown[] {
    const out = new Array<unknown>(this.length);
    for (let i = 0; i < this.length; i++) out[i] = this.get(i);
    return out;
  }
  *[Symbol.iterator](): Iterator<unknown> {
    for (let i = 0; i < this.length; i++) yield this.get(i);
  }
  /** A zero-copy logical sub-range of this vector. */
  slice(begin = 0, end: number = this.length): Vector {
    const length = Math.max(0, Math.min(end, this.length) - begin);
    return makeVector({
      ...this.rawData(),
      length,
      offset: this.offset + begin,
      nullCount: -1
    });
  }
  /**
  * Reconstruct the `VectorData` describing this vector's buffers (for slicing).
  *
  * @internal
  */
  protected rawData(): VectorData {
    return {
      type: this.type,
      length: this.length,
      validity: this.validity,
      offset: this.offset,
      children: this.children
    };
  }
  /**
  * The raw buffers backing this vector, including the logical offset. Used by
  * the IPC writer and C Data Interface exporter.
  *
  * @internal
  */
  toRaw(): VectorData {
    return {
      ...this.rawData(),
      nullCount: this.validity === null ? 0 : this.nullCount
    };
  }
  /** The logical offset into the backing buffers. @internal */
  get logicalOffset(): number {
    return this.offset;
  }
}
class NullVector extends Vector {
  protected getValue(): unknown {
    return null;
  }
  override get(_i: number): unknown {
    return null;
  }
}
class BoolVector extends Vector {
  #data: Uint8Array;
  constructor(data: VectorData) {
    super(data);
    this.#data = data.values!;
  }
  protected getValue(i: number): unknown {
    return bitGet(this.#data, i);
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      values: this.#data
    };
  }
}
class PrimitiveVector extends Vector {
  #data: Uint8Array;
  #dv: DataView;
  #width: number;
  constructor(data: VectorData) {
    super(data);
    this.#data = data.values!;
    this.#dv = new DataView(this.#data.buffer, this.#data.byteOffset, this.#data.byteLength);
    this.#width = fixedWidthBytes(data.type);
  }
  protected getValue(i: number): unknown {
    const t = this.type;
    const pos = i * this.#width;
    switch (t.kind) {
      case 'int':
        switch (t.bitWidth) {
          case 8: return t.signed ? this.#dv.getInt8(pos) : this.#dv.getUint8(pos);
          case 16: return t.signed ? this.#dv.getInt16(pos, true) : this.#dv.getUint16(pos, true);
          case 32: return t.signed ? this.#dv.getInt32(pos, true) : this.#dv.getUint32(pos, true);
          case 64: return t.signed ? this.#dv.getBigInt64(pos, true) : this.#dv.getBigUint64(pos, true);
        }
        return 0;
      case 'float':
        if (t.precision === Precision.HALF) return this.#dv.getFloat16(pos, true);
        if (t.precision === Precision.SINGLE) return this.#dv.getFloat32(pos, true);
        return this.#dv.getFloat64(pos, true);
      case 'date': return t.unit === DateUnit.DAY ? this.#dv.getInt32(pos, true) : this.#dv.getBigInt64(pos, true);
      case 'time': return t.bitWidth === 32 ? this.#dv.getInt32(pos, true) : this.#dv.getBigInt64(pos, true);
      case 'timestamp':
      case 'duration': return this.#dv.getBigInt64(pos, true);
      case 'interval':
        if (t.unit === IntervalUnit.YEAR_MONTH) return this.#dv.getInt32(pos, true);
        if (t.unit === IntervalUnit.DAY_TIME) return {
          days: this.#dv.getInt32(pos, true),
          milliseconds: this.#dv.getInt32(pos + 4, true)
        };
        return {
          months: this.#dv.getInt32(pos, true),
          days: this.#dv.getInt32(pos + 4, true),
          nanoseconds: this.#dv.getBigInt64(pos + 8, true)
        };
      default: return 0;
    }
  }
  /**
  * A typed-array view over the raw values buffer for fixed-width types. Copies
  * only when the underlying buffer is not aligned for the element type.
  */
  values(): ArrayBufferView {
    return this.#data;
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      values: this.#data
    };
  }
}
class DecimalVector extends Vector {
  #data: Uint8Array;
  #width: number;
  constructor(data: VectorData) {
    super(data);
    this.#data = data.values!;
    this.#width = fixedWidthBytes(data.type);
  }
  protected getValue(i: number): unknown {
    return readLeBigInt(this.#data, i * this.#width, this.#width, true);
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      values: this.#data
    };
  }
}
class FixedSizeBinaryVector extends Vector {
  #data: Uint8Array;
  #width: number;
  constructor(data: VectorData) {
    super(data);
    this.#data = data.values!;
    this.#width = fixedWidthBytes(data.type);
  }
  protected getValue(i: number): unknown {
    return this.#data.subarray(i * this.#width, (i + 1) * this.#width);
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      values: this.#data
    };
  }
}
class VarBinaryVector extends Vector {
  #offsets: DataView;
  #data: Uint8Array;
  #large: boolean;
  #utf8: boolean;
  constructor(data: VectorData) {
    super(data);
    const o = data.valueOffsets!;
    this.#offsets = new DataView(o.buffer, o.byteOffset, o.byteLength);
    this.#data = data.values ?? new Uint8Array(0);
    this.#large = data.type.kind === 'largeutf8' || data.type.kind === 'largebinary';
    this.#utf8 = data.type.kind === 'utf8' || data.type.kind === 'largeutf8';
  }
  #offsetAt(i: number): number {
    return this.#large ? Number(this.#offsets.getBigInt64(i * 8, true)) : this.#offsets.getInt32(i * 4, true);
  }
  protected getValue(i: number): unknown {
    const start = this.#offsetAt(i);
    const end = this.#offsetAt(i + 1);
    const bytes = this.#data.subarray(start, end);
    return this.#utf8 ? _decoder.decode(bytes) : bytes;
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      valueOffsets: bufBytes(this.#offsets),
      values: this.#data
    };
  }
}
class VarBinaryViewVector extends Vector {
  #views: DataView;
  #viewsBytes: Uint8Array;
  #buffers: Uint8Array[];
  #utf8: boolean;
  constructor(data: VectorData) {
    super(data);
    const v = data.views!;
    this.#viewsBytes = v;
    this.#views = new DataView(v.buffer, v.byteOffset, v.byteLength);
    this.#buffers = data.variadicBuffers ?? [];
    this.#utf8 = data.type.kind === 'utf8view';
  }
  protected getValue(i: number): unknown {
    // Each view is 16 bytes: i32 length; if length <= 12, 12 inline bytes;
    // else 4-byte prefix, i32 buffer index, i32 offset.
    const base = i * 16;
    const len = this.#views.getInt32(base, true);
    let bytes: Uint8Array;
    if (len <= 12) {
      bytes = this.#viewsBytes.subarray(base + 4, base + 4 + len);
    } else {
      const bufIndex = this.#views.getInt32(base + 8, true);
      const bufOffset = this.#views.getInt32(base + 12, true);
      bytes = this.#buffers[bufIndex]!.subarray(bufOffset, bufOffset + len);
    }
    return this.#utf8 ? _decoder.decode(bytes) : bytes.slice();
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      views: this.#viewsBytes,
      variadicBuffers: this.#buffers
    };
  }
}
class ListVector extends Vector {
  #offsets: DataView;
  #large: boolean;
  constructor(data: VectorData) {
    super(data);
    const o = data.valueOffsets!;
    this.#offsets = new DataView(o.buffer, o.byteOffset, o.byteLength);
    this.#large = data.type.kind === 'largelist';
  }
  #offsetAt(i: number): number {
    return this.#large ? Number(this.#offsets.getBigInt64(i * 8, true)) : this.#offsets.getInt32(i * 4, true);
  }
  protected getValue(i: number): unknown {
    const child = this.children[0]!;
    const start = this.#offsetAt(i);
    const end = this.#offsetAt(i + 1);
    const out = new Array<unknown>(end - start);
    for (let j = start; j < end; j++) out[j - start] = child.get(j);
    return out;
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      valueOffsets: bufBytes(this.#offsets)
    };
  }
}
class ListViewVector extends Vector {
  #offsets: DataView;
  #sizes: DataView;
  #large: boolean;
  constructor(data: VectorData) {
    super(data);
    const o = data.valueOffsets!;
    const s = data.sizes!;
    this.#offsets = new DataView(o.buffer, o.byteOffset, o.byteLength);
    this.#sizes = new DataView(s.buffer, s.byteOffset, s.byteLength);
    this.#large = data.type.kind === 'largelistview';
  }
  protected getValue(i: number): unknown {
    const child = this.children[0]!;
    const start = this.#large ? Number(this.#offsets.getBigInt64(i * 8, true)) : this.#offsets.getInt32(i * 4, true);
    const size = this.#large ? Number(this.#sizes.getBigInt64(i * 8, true)) : this.#sizes.getInt32(i * 4, true);
    const out = new Array<unknown>(size);
    for (let j = 0; j < size; j++) out[j] = child.get(start + j);
    return out;
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      valueOffsets: bufBytes(this.#offsets),
      sizes: bufBytes(this.#sizes)
    };
  }
}
class FixedSizeListVector extends Vector {
  #size: number;
  constructor(data: VectorData) {
    super(data);
    this.#size = (data.type as {
      listSize: number;
    }).listSize;
  }
  protected getValue(i: number): unknown {
    const child = this.children[0]!;
    const out = new Array<unknown>(this.#size);
    for (let j = 0; j < this.#size; j++) out[j] = child.get(i * this.#size + j);
    return out;
  }
}
class StructVector extends Vector {
  protected getValue(i: number): unknown {
    const type = this.type as {
      children: Field[];
    };
    const out: Record<string, unknown> = {};
    for (let c = 0; c < this.children.length; c++) {
      out[type.children[c]!.name] = this.children[c]!.get(i);
    }
    return out;
  }
}
class MapVector extends Vector {
  #offsets: DataView;
  constructor(data: VectorData) {
    super(data);
    const o = data.valueOffsets!;
    this.#offsets = new DataView(o.buffer, o.byteOffset, o.byteLength);
  }
  protected getValue(i: number): unknown {
    const entries = this.children[0]!;
    const start = this.#offsets.getInt32(i * 4, true);
    const end = this.#offsets.getInt32((i + 1) * 4, true);
    const out = new Array<[unknown, unknown]>(end - start);
    for (let j = start; j < end; j++) {
      const entry = entries.get(j) as Record<string, unknown>;
      const keys = Object.keys(entry);
      out[j - start] = [entry[keys[0]!], entry[keys[1]!]];
    }
    return out;
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      valueOffsets: bufBytes(this.#offsets)
    };
  }
}
class UnionVector extends Vector {
  #typeIds: Uint8Array;
  #offsets: DataView | null;
  #dense: boolean;
  #idToChild: Map<number, number>;
  constructor(data: VectorData) {
    super(data);
    this.#typeIds = data.typeIds!;
    this.#dense = (data.type as {
      mode: number;
    }).mode === UnionMode.Dense;
    this.#offsets = this.#dense && data.valueOffsets ? new DataView(data.valueOffsets.buffer, data.valueOffsets.byteOffset, data.valueOffsets.byteLength) : null;
    this.#idToChild = new Map();
    const ids = (data.type as {
      typeIds: number[];
    }).typeIds;
    for (let c = 0; c < ids.length; c++) this.#idToChild.set(ids[c]!, c);
  }
  // Unions have no validity buffer; every slot is "valid" and dispatches.
  override isValid(_i: number): boolean {
    return true;
  }
  protected getValue(i: number): unknown {
    const typeId = this.#typeIds[i]!;
    const childIndex = this.#idToChild.get(typeId);
    if (childIndex === undefined) return null;
    const child = this.children[childIndex]!;
    const childRow = this.#dense ? this.#offsets!.getInt32(i * 4, true) : i;
    return child.get(childRow);
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      typeIds: this.#typeIds,
      valueOffsets: this.#offsets ? bufBytes(this.#offsets) : undefined
    };
  }
}
class DictionaryVector extends Vector {
  #indices: Vector;
  #dictionary: Vector;
  constructor(data: VectorData) {
    super(data);
    const dictType = data.type as {
      indexType: DataType;
      valueType: DataType;
    };
    this.#indices = makeVector({
      type: dictType.indexType,
      length: data.length,
      validity: data.validity,
      offset: data.offset,
      values: data.values
    });
    this.#dictionary = data.dictionary!;
  }
  /** The decoded dictionary values vector. */
  get dictionary(): Vector {
    return this.#dictionary;
  }
  protected getValue(i: number): unknown {
    // getValue is called with the offset already applied; #indices applies its
    // own offset, so read the raw index at logical position (i - offset).
    const key = this.#indices.get(i - this.offset) as number | bigint | null;
    if (key === null) return null;
    return this.#dictionary.get(Number(key));
  }
  override isValid(i: number): boolean {
    return this.#indices.isValid(i);
  }
  protected override rawData(): VectorData {
    return {
      ...super.rawData(),
      values: (this.#indices as PrimitiveVector).values() as Uint8Array,
      dictionary: this.#dictionary
    };
  }
}
class RunEndEncodedVector extends Vector {
  #runEnds: Vector;
  #values: Vector;
  constructor(data: VectorData) {
    super(data);
    this.#runEnds = this.children[0]!;
    this.#values = this.children[1]!;
  }
  // REE has no top-level validity; nulls live in the values child.
  override isValid(_i: number): boolean {
    return true;
  }
  protected getValue(i: number): unknown {
    // Binary search for the first run end strictly greater than i.
    let lo = 0;
    let hi = this.#runEnds.length - 1;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (Number(this.#runEnds.get(mid)) <= i) lo = mid + 1;
      else hi = mid;
    }
    return this.#values.get(lo);
  }
  override get(i: number): unknown {
    if (i < 0 || i >= this.length) return undefined;
    return this.getValue(this.offset + i);
  }
}
function bufBytes(dv: DataView): Uint8Array {
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}
/**
* Construct a vector from raw column buffers. The hot path used by IPC decoding
* and native producers.
*/
export function makeVector(data: VectorData): Vector {
  switch (data.type.kind) {
    case 'null': return new NullVector(data);
    case 'bool': return new BoolVector(data);
    case 'int':
    case 'float':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'duration':
    case 'interval': return new PrimitiveVector(data);
    case 'decimal': return new DecimalVector(data);
    case 'fixedsizebinary': return new FixedSizeBinaryVector(data);
    case 'utf8':
    case 'largeutf8':
    case 'binary':
    case 'largebinary': return new VarBinaryVector(data);
    case 'utf8view':
    case 'binaryview': return new VarBinaryViewVector(data);
    case 'list':
    case 'largelist': return new ListVector(data);
    case 'listview':
    case 'largelistview': return new ListViewVector(data);
    case 'fixedsizelist': return new FixedSizeListVector(data);
    case 'struct': return new StructVector(data);
    case 'map': return new MapVector(data);
    case 'union': return new UnionVector(data);
    case 'dictionary': return new DictionaryVector(data);
    case 'runendencoded': return new RunEndEncodedVector(data);
  }
}
// --- vectorFromArray (type inference + building) ---------------------------
function makeValidity(values: unknown[]): {
  validity: Uint8Array | null;
  nullCount: number;
} {
  let nullCount = 0;
  for (const v of values) if (v === null || v === undefined) nullCount++;
  if (nullCount === 0) return {
    validity: null,
    nullCount: 0
  };
  const validity = new Uint8Array(values.length + 7 >> 3);
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== null && values[i] !== undefined) validity[i >> 3]! |= 1 << (i & 7);
  }
  return {
    validity,
    nullCount
  };
}
function inferType(values: unknown[]): DataType {
  for (const v of values) {
    if (v === null || v === undefined) continue;
    switch (typeof v) {
      case 'boolean': return bool();
      case 'number': return float64();
      case 'bigint': return int64();
      case 'string': return utf8();
      case 'object':
        if (Array.isArray(v)) return list(new Field('item', inferType(v as unknown[]), true));
        return struct(Object.keys(v as object).map((k) => new Field(k, inferType([(v as Record<string, unknown>)[k]]), true)));
    }
  }
  return int32();
}
/**
* Build a vector from JS values, inferring the type when not given. Intended
* for convenience and tests; `makeVector` is the performance path.
*/
export function vectorFromArray(values: unknown[], type?: DataType): Vector {
  const dt = type ?? inferType(values);
  const { validity, nullCount } = makeValidity(values);
  const length = values.length;
  switch (dt.kind) {
    case 'bool': {
      const data = new Uint8Array(length + 7 >> 3);
      for (let i = 0; i < length; i++) if (values[i]) data[i >> 3]! |= 1 << (i & 7);
      return makeVector({
        type: dt,
        length,
        validity,
        nullCount,
        values: data
      });
    }
    case 'int':
    case 'float':
    case 'date':
    case 'time':
    case 'timestamp':
    case 'duration': {
      const width = fixedWidthBytes(dt);
      const data = new Uint8Array(length * width);
      const dv = new DataView(data.buffer);
      for (let i = 0; i < length; i++) {
        const v = values[i];
        if (v === null || v === undefined) continue;
        writeScalar(dv, i * width, dt, v);
      }
      return makeVector({
        type: dt,
        length,
        validity,
        nullCount,
        values: data
      });
    }
    case 'utf8':
    case 'largeutf8':
    case 'binary':
    case 'largebinary': {
      const large = dt.kind === 'largeutf8' || dt.kind === 'largebinary';
      const isUtf8 = dt.kind === 'utf8' || dt.kind === 'largeutf8';
      const parts: Uint8Array[] = [];
      let total = 0;
      const offsets = new Uint8Array((length + 1) * (large ? 8 : 4));
      const odv = new DataView(offsets.buffer);
      for (let i = 0; i < length; i++) {
        const v = values[i];
        if (v !== null && v !== undefined) {
          const bytes = isUtf8 ? _encoder.encode(String(v)) : v as Uint8Array;
          parts.push(bytes);
          total += bytes.byteLength;
        }
        if (large) odv.setBigInt64((i + 1) * 8, BigInt(total), true);
        else odv.setInt32((i + 1) * 4, total, true);
      }
      const dataBuf = new Uint8Array(total);
      let pos = 0;
      for (const part of parts) {
        dataBuf.set(part, pos);
        pos += part.byteLength;
      }
      return makeVector({
        type: dt,
        length,
        validity,
        nullCount,
        valueOffsets: offsets,
        values: dataBuf
      });
    }
    case 'list':
    case 'largelist': {
      const large = dt.kind === 'largelist';
      const flat: unknown[] = [];
      const offsets = new Uint8Array((length + 1) * (large ? 8 : 4));
      const odv = new DataView(offsets.buffer);
      for (let i = 0; i < length; i++) {
        const v = values[i];
        if (Array.isArray(v)) flat.push(...v);
        if (large) odv.setBigInt64((i + 1) * 8, BigInt(flat.length), true);
        else odv.setInt32((i + 1) * 4, flat.length, true);
      }
      const child = vectorFromArray(flat, dt.child.type);
      return makeVector({
        type: dt,
        length,
        validity,
        nullCount,
        valueOffsets: offsets,
        children: [child]
      });
    }
    case 'struct': {
      const children = dt.children.map((f) => vectorFromArray(values.map((v) => v == null ? null : (v as Record<string, unknown>)[f.name] ?? null), f.type));
      return makeVector({
        type: dt,
        length,
        validity,
        nullCount,
        children
      });
    }
    default: throw new ArrowError(`vectorFromArray does not support building ${dt.kind}; use makeVector with raw buffers`);
  }
}
function writeScalar(dv: DataView, pos: number, type: DataType, v: unknown): void {
  switch (type.kind) {
    case 'int':
      switch (type.bitWidth) {
        case 8:
          type.signed ? dv.setInt8(pos, Number(v)) : dv.setUint8(pos, Number(v));
          return;
        case 16:
          type.signed ? dv.setInt16(pos, Number(v), true) : dv.setUint16(pos, Number(v), true);
          return;
        case 32:
          type.signed ? dv.setInt32(pos, Number(v), true) : dv.setUint32(pos, Number(v), true);
          return;
        case 64:
          type.signed ? dv.setBigInt64(pos, BigInt(v as number | bigint), true) : dv.setBigUint64(pos, BigInt(v as number | bigint), true);
          return;
      }
      return;
    case 'float':
      if (type.precision === Precision.HALF) dv.setFloat16(pos, Number(v), true);
      else if (type.precision === Precision.SINGLE) dv.setFloat32(pos, Number(v), true);
      else dv.setFloat64(pos, Number(v), true);
      return;
    case 'date':
      if (type.unit === DateUnit.DAY) dv.setInt32(pos, Number(v), true);
      else dv.setBigInt64(pos, BigInt(v as number | bigint), true);
      return;
    case 'time':
      if (type.bitWidth === 32) dv.setInt32(pos, Number(v), true);
      else dv.setBigInt64(pos, BigInt(v as number | bigint), true);
      return;
    case 'timestamp':
    case 'duration':
      dv.setBigInt64(pos, BigInt(v as number | bigint), true);
      return;
  }
}
export { int64, int32, float64, utf8, list, struct, bool };
