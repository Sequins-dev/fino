/**
* fino:format/flatbuffers - schema-less FlatBuffers reading and writing.
*
* FlatBuffers is a zero-copy binary serialization format: tables store fields
* through a vtable indirection so readers can access individual fields without
* unpacking, and all scalars are little-endian at fixed offsets. This module
* implements the wire format directly — no schema compiler or generated code.
* Callers address table fields by their schema field id (the `id` attribute in
* a `.fbs` file, or declaration order starting at 0).
*
* The reader (`FlatBuffer`, `Table`, `Vector`) validates bounds on every
* access and throws `FlatbufferError` with a hex-dump diagnostic for malformed
* buffers. The writer (`Builder`) implements the standard back-to-front
* construction algorithm with vtable deduplication, producing buffers
* byte-compatible with the reference implementation.
*
* ```ts no_run
* import { Builder, FlatBuffer } from 'fino:format/flatbuffers';
*
* const b = new Builder();
* const name = b.createString('fino');
* b.startTable(2);
* b.addFieldOffset(0, name);
* b.addFieldInt32(1, 42, 0);
* const root = b.endTable();
* b.finish(root);
*
* const table = FlatBuffer.from(b.bytes()).rootTable();
* table.string(0); // 'fino'
* table.i32(1, 0); // 42
* ```
*
* Useful references:
*   - FlatBuffers internals: https://flatbuffers.dev/internals/
*   - Format specification: https://flatbuffers.dev/formats/
*/
import { ParseError } from 'fino:parsing/scanner';
const SIZEOF_SHORT = 2;
const SIZEOF_INT = 4;
const FILE_IDENTIFIER_LENGTH = 4;
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();
/**
* Error thrown when a FlatBuffer is malformed or an access runs out of bounds.
*
* `FlatbufferError` extends `ParseError` with a binary source, so `render()`
* produces a hex dump around the failing offset.
*
* ```ts no_run
* import { FlatBuffer, FlatbufferError } from 'fino:format/flatbuffers';
*
* try {
*   FlatBuffer.from(new Uint8Array([1, 2])).rootTable();
* } catch (error) {
*   if (error instanceof FlatbufferError) console.error(error.render());
* }
* ```
*/
export class FlatbufferError extends ParseError {
  /**
  * Error name reported by `FlatbufferError` instances.
  *
  * @internal
  */
  override name = 'FlatbufferError';
}
function _fail(source: Uint8Array, offset: number, detail: string): never {
  throw new FlatbufferError(`Malformed flatbuffer: ${detail}`, {
    detail,
    format: 'flatbuffers',
    offset,
    source
  });
}
/**
* A read-only FlatBuffer with bounds-checked positional accessors.
*
* Wraps a byte buffer and resolves the root table. Positional readers
* (`u8At`, `i32At`, `f64At`, ...) are used for inline structs, whose layout
* only the caller knows.
*
* ```ts no_run
* import { FlatBuffer } from 'fino:format/flatbuffers';
*
* const fb = FlatBuffer.from(bytes);
* const root = fb.rootTable();
* ```
*/
export class FlatBuffer {
  /**
  * Underlying bytes of the buffer (after any size prefix).
  *
  * @internal
  */
  #bytes: Uint8Array;
  /**
  * DataView over `#bytes`, respecting the byte offset of the view.
  *
  * @internal
  */
  #view: DataView;
  /**
  * Wrap `bytes` as a FlatBuffer. Pass `sizePrefixed: true` when the buffer
  * begins with the standard 4-byte length prefix (`finish(..., { sizePrefixed:
  * true })` output); the prefix is validated and stripped.
  */
  static from(bytes: Uint8Array | ArrayBuffer, options?: {
    sizePrefixed?: boolean;
  }): FlatBuffer {
    let u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    if (options?.sizePrefixed) {
      if (u8.byteLength < SIZEOF_INT) {
        _fail(u8, 0, 'size-prefixed buffer shorter than its length prefix');
      }
      const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const declared = view.getUint32(0, true);
      if (declared > u8.byteLength - SIZEOF_INT) {
        _fail(u8, 0, `size prefix ${declared} exceeds remaining ${u8.byteLength - SIZEOF_INT} bytes`);
      }
      u8 = u8.subarray(SIZEOF_INT, SIZEOF_INT + declared);
    }
    return new FlatBuffer(u8);
  }
  /**
  * Construct directly over bytes with no size prefix. Prefer
  * `FlatBuffer.from()`.
  */
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  /**
  * The wrapped bytes (a view, not a copy).
  */
  get bytes(): Uint8Array {
    return this.#bytes;
  }
  /**
  * Bounds check `size` bytes at `pos`, throwing `FlatbufferError` on
  * violation.
  *
  * @internal
  */
  _check(pos: number, size: number): void {
    if (pos < 0 || pos + size > this.#bytes.byteLength) {
      _fail(this.#bytes, Math.max(0, Math.min(pos, this.#bytes.byteLength - 1)), `read of ${size} byte(s) at ${pos} exceeds buffer of ${this.#bytes.byteLength}`);
    }
  }
  /**
  * Raise a `FlatbufferError` at `pos` with `detail`.
  *
  * @internal
  */
  _fail(pos: number, detail: string): never {
    _fail(this.#bytes, pos, detail);
  }
  /** Read an unsigned 8-bit integer at `pos`. */
  u8At(pos: number): number {
    this._check(pos, 1);
    return this.#view.getUint8(pos);
  }
  /** Read a signed 8-bit integer at `pos`. */
  i8At(pos: number): number {
    this._check(pos, 1);
    return this.#view.getInt8(pos);
  }
  /** Read an unsigned 16-bit integer at `pos`. */
  u16At(pos: number): number {
    this._check(pos, 2);
    return this.#view.getUint16(pos, true);
  }
  /** Read a signed 16-bit integer at `pos`. */
  i16At(pos: number): number {
    this._check(pos, 2);
    return this.#view.getInt16(pos, true);
  }
  /** Read an unsigned 32-bit integer at `pos`. */
  u32At(pos: number): number {
    this._check(pos, 4);
    return this.#view.getUint32(pos, true);
  }
  /** Read a signed 32-bit integer at `pos`. */
  i32At(pos: number): number {
    this._check(pos, 4);
    return this.#view.getInt32(pos, true);
  }
  /** Read an unsigned 64-bit integer at `pos` as a bigint. */
  u64At(pos: number): bigint {
    this._check(pos, 8);
    return this.#view.getBigUint64(pos, true);
  }
  /** Read a signed 64-bit integer at `pos` as a bigint. */
  i64At(pos: number): bigint {
    this._check(pos, 8);
    return this.#view.getBigInt64(pos, true);
  }
  /** Read a 32-bit float at `pos`. */
  f32At(pos: number): number {
    this._check(pos, 4);
    return this.#view.getFloat32(pos, true);
  }
  /** Read a 64-bit float at `pos`. */
  f64At(pos: number): number {
    this._check(pos, 8);
    return this.#view.getFloat64(pos, true);
  }
  /**
  * Follow the unsigned relative offset stored at `pos` (tables, strings,
  * vectors).
  *
  * @internal
  */
  _indirect(pos: number): number {
    return pos + this.u32At(pos);
  }
  /**
  * Resolve the root table of the buffer.
  */
  rootTable(): Table {
    const rootPos = this._indirect(0);
    return this.tableAt(rootPos);
  }
  /**
  * Wrap the table at absolute position `pos`, validating its vtable.
  */
  tableAt(pos: number): Table {
    const vtablePos = pos - this.i32At(pos);
    const vtableSize = this.u16At(vtablePos);
    if (vtableSize < 2 * SIZEOF_SHORT || vtableSize % SIZEOF_SHORT !== 0) {
      this._fail(vtablePos, `invalid vtable size ${vtableSize}`);
    }
    this._check(vtablePos, vtableSize);
    return new Table(this, pos, vtablePos, vtableSize);
  }
  /**
  * The 4-character file identifier stored after the root offset, or `null`
  * when the buffer is too short to carry one. FlatBuffers has no in-band flag
  * for identifiers, so a buffer without one returns 4 arbitrary bytes —
  * compare with `hasIdentifier()` instead of trusting this value.
  */
  identifier(): string | null {
    if (this.#bytes.byteLength < SIZEOF_INT + FILE_IDENTIFIER_LENGTH) return null;
    let id = '';
    for (let i = 0; i < FILE_IDENTIFIER_LENGTH; i++) {
      id += String.fromCharCode(this.#bytes[SIZEOF_INT + i]!);
    }
    return id;
  }
  /**
  * Whether the buffer carries the given 4-character file identifier.
  */
  hasIdentifier(id: string): boolean {
    if (id.length !== FILE_IDENTIFIER_LENGTH) {
      throw new TypeError(`FlatBuffers: file identifier must be exactly ${FILE_IDENTIFIER_LENGTH} characters`);
    }
    return this.identifier() === id;
  }
  /**
  * Decode the string whose data begins at absolute position `pos`
  * (u32 length + UTF-8 bytes).
  *
  * @internal
  */
  _stringAt(pos: number): string {
    const len = this.u32At(pos);
    this._check(pos + SIZEOF_INT, len);
    return _decoder.decode(this.#bytes.subarray(pos + SIZEOF_INT, pos + SIZEOF_INT + len));
  }
}
/**
* A table within a `FlatBuffer`, with field accessors keyed by schema field
* id. Missing fields return the supplied default (scalars) or `null`
* (offsets), exactly like generated FlatBuffers accessors.
*
* Unions follow the standard two-field convention: the type tag is a `u8`
* field at id N and the value is a table field at id N + 1 — read them with
* `u8(N, 0)` and `table(N + 1)`.
*/
export class Table {
  /**
  * Owning buffer.
  *
  * @internal
  */
  #fb: FlatBuffer;
  /**
  * Absolute position of the table.
  *
  * @internal
  */
  #pos: number;
  /**
  * Absolute position of the table's vtable.
  *
  * @internal
  */
  #vtablePos: number;
  /**
  * Byte size of the vtable.
  *
  * @internal
  */
  #vtableSize: number;
  /**
  * Wrap a validated table. Use `FlatBuffer.rootTable()` / `tableAt()` rather
  * than constructing directly.
  *
  * @internal
  */
  constructor(fb: FlatBuffer, pos: number, vtablePos: number, vtableSize: number) {
    this.#fb = fb;
    this.#pos = pos;
    this.#vtablePos = vtablePos;
    this.#vtableSize = vtableSize;
  }
  /**
  * Absolute position of this table in the buffer.
  */
  get position(): number {
    return this.#pos;
  }
  /**
  * Absolute position of field `id`'s inline data, or 0 when the field is
  * absent. This is the raw vtable lookup all typed accessors build on.
  */
  fieldPos(id: number): number {
    const slot = 2 * SIZEOF_SHORT + id * SIZEOF_SHORT;
    if (slot + SIZEOF_SHORT > this.#vtableSize) return 0;
    const off = this.#fb.u16At(this.#vtablePos + slot);
    return off === 0 ? 0 : this.#pos + off;
  }
  /** Read a boolean field. */
  bool(id: number, defaultValue: boolean): boolean {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.u8At(pos) !== 0;
  }
  /** Read an unsigned 8-bit field. */
  u8(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.u8At(pos);
  }
  /** Read a signed 8-bit field. */
  i8(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.i8At(pos);
  }
  /** Read an unsigned 16-bit field. */
  u16(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.u16At(pos);
  }
  /** Read a signed 16-bit field. */
  i16(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.i16At(pos);
  }
  /** Read an unsigned 32-bit field. */
  u32(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.u32At(pos);
  }
  /** Read a signed 32-bit field. */
  i32(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.i32At(pos);
  }
  /** Read an unsigned 64-bit field as a bigint. */
  u64(id: number, defaultValue: bigint): bigint {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.u64At(pos);
  }
  /** Read a signed 64-bit field as a bigint. */
  i64(id: number, defaultValue: bigint): bigint {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.i64At(pos);
  }
  /** Read a 32-bit float field. */
  f32(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.f32At(pos);
  }
  /** Read a 64-bit float field. */
  f64(id: number, defaultValue: number): number {
    const pos = this.fieldPos(id);
    return pos === 0 ? defaultValue : this.#fb.f64At(pos);
  }
  /** Read a string field, or `null` when absent. */
  string(id: number): string | null {
    const pos = this.fieldPos(id);
    if (pos === 0) return null;
    return this.#fb._stringAt(this.#fb._indirect(pos));
  }
  /** Read a nested-table field, or `null` when absent. */
  table(id: number): Table | null {
    const pos = this.fieldPos(id);
    if (pos === 0) return null;
    return this.#fb.tableAt(this.#fb._indirect(pos));
  }
  /**
  * Absolute position of an inline struct field, or `null` when absent. Read
  * the struct's members with the buffer's positional accessors
  * (`fb.f32At(pos + 4)`, ...).
  */
  struct(id: number): number | null {
    const pos = this.fieldPos(id);
    return pos === 0 ? null : pos;
  }
  /** Read a vector field, or `null` when absent. */
  vector(id: number): Vector | null {
    const pos = this.fieldPos(id);
    if (pos === 0) return null;
    const dataPos = this.#fb._indirect(pos);
    const length = this.#fb.u32At(dataPos);
    return new Vector(this.#fb, dataPos + SIZEOF_INT, length);
  }
}
/**
* A vector within a `FlatBuffer`. Element accessors are typed by the caller
* (the wire format does not carry element types); indexes are bounds-checked.
*/
export class Vector {
  /**
  * Owning buffer.
  *
  * @internal
  */
  #fb: FlatBuffer;
  /**
  * Absolute position of element 0.
  *
  * @internal
  */
  #elemsPos: number;
  /**
  * Element count.
  *
  * @internal
  */
  #length: number;
  /**
  * Wrap vector data. Use `Table.vector()` rather than constructing directly.
  *
  * @internal
  */
  constructor(fb: FlatBuffer, elemsPos: number, length: number) {
    this.#fb = fb;
    this.#elemsPos = elemsPos;
    this.#length = length;
  }
  /**
  * Number of elements.
  */
  get length(): number {
    return this.#length;
  }
  /**
  * The owning `FlatBuffer`, for reading inline-struct members at absolute
  * positions returned by `structAt`.
  */
  get buffer(): FlatBuffer {
    return this.#fb;
  }
  /**
  * Absolute position of element `i`, given the element byte size.
  */
  elemPos(i: number, elemSize: number): number {
    if (i < 0 || i >= this.#length) {
      this.#fb._fail(this.#elemsPos, `vector index ${i} out of range 0..${this.#length - 1}`);
    }
    return this.#elemsPos + i * elemSize;
  }
  /** Read element `i` as a boolean. */
  bool(i: number): boolean {
    return this.#fb.u8At(this.elemPos(i, 1)) !== 0;
  }
  /** Read element `i` as an unsigned 8-bit integer. */
  u8(i: number): number {
    return this.#fb.u8At(this.elemPos(i, 1));
  }
  /** Read element `i` as a signed 8-bit integer. */
  i8(i: number): number {
    return this.#fb.i8At(this.elemPos(i, 1));
  }
  /** Read element `i` as an unsigned 16-bit integer. */
  u16(i: number): number {
    return this.#fb.u16At(this.elemPos(i, 2));
  }
  /** Read element `i` as a signed 16-bit integer. */
  i16(i: number): number {
    return this.#fb.i16At(this.elemPos(i, 2));
  }
  /** Read element `i` as an unsigned 32-bit integer. */
  u32(i: number): number {
    return this.#fb.u32At(this.elemPos(i, 4));
  }
  /** Read element `i` as a signed 32-bit integer. */
  i32(i: number): number {
    return this.#fb.i32At(this.elemPos(i, 4));
  }
  /** Read element `i` as an unsigned 64-bit bigint. */
  u64(i: number): bigint {
    return this.#fb.u64At(this.elemPos(i, 8));
  }
  /** Read element `i` as a signed 64-bit bigint. */
  i64(i: number): bigint {
    return this.#fb.i64At(this.elemPos(i, 8));
  }
  /** Read element `i` as a 32-bit float. */
  f32(i: number): number {
    return this.#fb.f32At(this.elemPos(i, 4));
  }
  /** Read element `i` as a 64-bit float. */
  f64(i: number): number {
    return this.#fb.f64At(this.elemPos(i, 8));
  }
  /** Read element `i` as a string (vector of string offsets). */
  string(i: number): string {
    return this.#fb._stringAt(this.#fb._indirect(this.elemPos(i, 4)));
  }
  /** Read element `i` as a table (vector of table offsets). */
  table(i: number): Table {
    return this.#fb.tableAt(this.#fb._indirect(this.elemPos(i, 4)));
  }
  /**
  * Absolute position of inline-struct element `i`, given the struct's byte
  * size.
  */
  structAt(i: number, structSize: number): number {
    return this.elemPos(i, structSize);
  }
  /**
  * A raw byte view over all elements (no copy), given the element byte size.
  * For a `[ubyte]` vector this is the vector's contents directly.
  */
  bytes(elemSize = 1): Uint8Array {
    const total = this.#length * elemSize;
    this.#fb._check(this.#elemsPos, total);
    return this.#fb.bytes.subarray(this.#elemsPos, this.#elemsPos + total);
  }
}
/**
* FlatBuffers builder implementing the standard back-to-front construction
* algorithm with vtable deduplication.
*
* Usage follows the reference Builder: create strings/vectors/nested tables
* first (bottom-up), then `startTable(fieldCount)`, add fields by id,
* `endTable()`, and `finish(root)`.
*
* ```ts no_run
* import { Builder } from 'fino:format/flatbuffers';
*
* const b = new Builder();
* const s = b.createString('hi');
* b.startTable(1);
* b.addFieldOffset(0, s);
* b.finish(b.endTable());
* const bytes = b.bytes();
* ```
*/
export class Builder {
  /**
  * Backing storage; data grows downward from the end.
  *
  * @internal
  */
  #buf: Uint8Array;
  /**
  * DataView over `#buf`.
  *
  * @internal
  */
  #view: DataView;
  /**
  * Lowest used byte index; writes decrement this.
  *
  * @internal
  */
  #space: number;
  /**
  * Largest alignment seen so far.
  *
  * @internal
  */
  #minalign = 1;
  /**
  * Field offsets (builder offsets, not positions) for the table being built.
  *
  * @internal
  */
  #vtable: number[] | null = null;
  /**
  * Number of field slots in the current table.
  *
  * @internal
  */
  #vtableInUse = 0;
  /**
  * Whether a table or vector is currently being constructed.
  *
  * @internal
  */
  #isNested = false;
  /**
  * Builder offset where the current table started.
  *
  * @internal
  */
  #objectStart = 0;
  /**
  * Builder offsets of all written vtables, for deduplication.
  *
  * @internal
  */
  #vtables: number[] = [];
  /**
  * Element count for the vector being built.
  *
  * @internal
  */
  #vectorNumElems = 0;
  /**
  * Whether `finish()` has been called.
  *
  * @internal
  */
  #finished = false;
  /**
  * Write scalar fields even when they equal their default.
  *
  * @internal
  */
  #forceDefaults = false;
  /**
  * Create a builder with an optional initial capacity (bytes).
  */
  constructor(initialSize = 1024) {
    const size = Math.max(1, initialSize);
    this.#buf = new Uint8Array(size);
    this.#view = new DataView(this.#buf.buffer);
    this.#space = size;
  }
  /**
  * When true, scalar fields equal to their default are still written.
  * Defaults to false (matching the reference Builder).
  */
  forceDefaults(value: boolean): void {
    this.#forceDefaults = value;
  }
  /**
  * Current builder offset (bytes written so far). Offsets returned by
  * `createString`/`endTable`/`endVector` are in this space.
  */
  offset(): number {
    return this.#buf.length - this.#space;
  }
  /**
  * Grow the backing buffer, keeping existing data at the end.
  *
  * @internal
  */
  #grow(): void {
    const oldSize = this.#buf.length;
    if (oldSize & 3221225472) {
      throw new Error('FlatBuffers: cannot grow buffer beyond 2 gigabytes');
    }
    const newSize = oldSize << 1;
    const next = new Uint8Array(newSize);
    next.set(this.#buf, newSize - oldSize);
    this.#buf = next;
    this.#view = new DataView(next.buffer);
    this.#space += newSize - oldSize;
  }
  /**
  * Write `n` zero padding bytes.
  */
  pad(n: number): void {
    for (let i = 0; i < n; i++) {
      this.#buf[--this.#space] = 0;
    }
  }
  /**
  * Prepare to write `additionalBytes` after aligning to `size`. Grows the
  * buffer as needed. Public so callers can build inline structs with the raw
  * `write*` methods.
  */
  prep(size: number, additionalBytes: number): void {
    if (size > this.#minalign) this.#minalign = size;
    const alignSize = ~(this.#buf.length - this.#space + additionalBytes) + 1 & size - 1;
    while (this.#space < alignSize + size + additionalBytes) {
      this.#grow();
    }
    this.pad(alignSize);
  }
  /** Write a raw signed 8-bit value (no alignment). */
  writeInt8(value: number): void {
    this.#view.setInt8(--this.#space, value);
  }
  /** Write a raw signed 16-bit value (no alignment). */
  writeInt16(value: number): void {
    this.#space -= 2;
    this.#view.setInt16(this.#space, value, true);
  }
  /** Write a raw signed 32-bit value (no alignment). */
  writeInt32(value: number): void {
    this.#space -= 4;
    this.#view.setInt32(this.#space, value, true);
  }
  /** Write a raw signed 64-bit value (no alignment). */
  writeInt64(value: bigint): void {
    this.#space -= 8;
    this.#view.setBigInt64(this.#space, value, true);
  }
  /** Write a raw 32-bit float (no alignment). */
  writeFloat32(value: number): void {
    this.#space -= 4;
    this.#view.setFloat32(this.#space, value, true);
  }
  /** Write a raw 64-bit float (no alignment). */
  writeFloat64(value: number): void {
    this.#space -= 8;
    this.#view.setFloat64(this.#space, value, true);
  }
  /** Align and write a signed 8-bit value. */
  addInt8(value: number): void {
    this.prep(1, 0);
    this.writeInt8(value);
  }
  /** Align and write a signed 16-bit value. */
  addInt16(value: number): void {
    this.prep(2, 0);
    this.writeInt16(value);
  }
  /** Align and write a signed 32-bit value. */
  addInt32(value: number): void {
    this.prep(4, 0);
    this.writeInt32(value);
  }
  /** Align and write a signed 64-bit value. */
  addInt64(value: bigint): void {
    this.prep(8, 0);
    this.writeInt64(value);
  }
  /** Align and write a 32-bit float. */
  addFloat32(value: number): void {
    this.prep(4, 0);
    this.writeFloat32(value);
  }
  /** Align and write a 64-bit float. */
  addFloat64(value: number): void {
    this.prep(8, 0);
    this.writeFloat64(value);
  }
  /**
  * Align and write a relative offset to a previously written object.
  */
  addOffset(offset: number): void {
    this.prep(SIZEOF_INT, 0);
    this.writeInt32(this.offset() - offset + SIZEOF_INT);
  }
  /**
  * Record that field `id` of the current table lives at the current offset.
  *
  * @internal
  */
  #slot(id: number): void {
    if (this.#vtable === null) {
      throw new Error('FlatBuffers: field added outside startTable/endTable');
    }
    this.#vtable[id] = this.offset();
  }
  /** Add a boolean field to the current table. */
  addFieldBool(id: number, value: boolean, defaultValue: boolean): void {
    this.addFieldInt8(id, value ? 1 : 0, defaultValue ? 1 : 0);
  }
  /** Add an 8-bit scalar field to the current table. */
  addFieldInt8(id: number, value: number, defaultValue: number): void {
    if (this.#forceDefaults || value !== defaultValue) {
      this.addInt8(value);
      this.#slot(id);
    }
  }
  /** Add a 16-bit scalar field to the current table. */
  addFieldInt16(id: number, value: number, defaultValue: number): void {
    if (this.#forceDefaults || value !== defaultValue) {
      this.addInt16(value);
      this.#slot(id);
    }
  }
  /** Add a 32-bit scalar field to the current table. */
  addFieldInt32(id: number, value: number, defaultValue: number): void {
    if (this.#forceDefaults || value !== defaultValue) {
      this.addInt32(value);
      this.#slot(id);
    }
  }
  /** Add a 64-bit scalar field to the current table. */
  addFieldInt64(id: number, value: bigint, defaultValue: bigint): void {
    if (this.#forceDefaults || value !== defaultValue) {
      this.addInt64(value);
      this.#slot(id);
    }
  }
  /** Add a 32-bit float field to the current table. */
  addFieldFloat32(id: number, value: number, defaultValue: number): void {
    if (this.#forceDefaults || value !== defaultValue) {
      this.addFloat32(value);
      this.#slot(id);
    }
  }
  /** Add a 64-bit float field to the current table. */
  addFieldFloat64(id: number, value: number, defaultValue: number): void {
    if (this.#forceDefaults || value !== defaultValue) {
      this.addFloat64(value);
      this.#slot(id);
    }
  }
  /**
  * Add an offset field (string, vector, or nested table) to the current
  * table. Zero offsets (absent) are skipped.
  */
  addFieldOffset(id: number, offset: number): void {
    if (offset !== 0) {
      this.addOffset(offset);
      this.#slot(id);
    }
  }
  /**
  * Add an inline struct field to the current table. The struct must have
  * been written immediately before this call (its offset must equal the
  * current builder offset).
  */
  addFieldStruct(id: number, offset: number): void {
    if (offset !== 0) {
      if (offset !== this.offset()) {
        throw new Error('FlatBuffers: struct must be serialized inline, immediately before addFieldStruct');
      }
      this.#slot(id);
    }
  }
  /**
  * Begin a table with `numFields` field slots.
  */
  startTable(numFields: number): void {
    if (this.#isNested) {
      throw new Error('FlatBuffers: startTable inside another table or vector');
    }
    this.#vtable = new Array<number>(numFields).fill(0);
    this.#vtableInUse = numFields;
    this.#isNested = true;
    this.#objectStart = this.offset();
  }
  /**
  * Finish the current table, writing (or reusing) its vtable. Returns the
  * table's builder offset.
  */
  endTable(): number {
    if (this.#vtable === null || !this.#isNested) {
      throw new Error('FlatBuffers: endTable without startTable');
    }
    this.addInt32(0);
    const vtableLoc = this.offset();
    let i = this.#vtableInUse - 1;
    while (i >= 0 && this.#vtable[i] === 0) i--;
    const trimmedSize = i + 1;
    for (; i >= 0; i--) {
      this.writeInt16(this.#vtable[i] !== 0 ? vtableLoc - this.#vtable[i]! : 0);
    }
    const standardFields = 2;
    this.writeInt16(vtableLoc - this.#objectStart);
    const len = (trimmedSize + standardFields) * SIZEOF_SHORT;
    this.writeInt16(len);
    let existingVtable = 0;
    const vt1 = this.#space;
    outer: for (const candidate of this.#vtables) {
      const vt2 = this.#buf.length - candidate;
      if (len === this.#view.getInt16(vt2, true)) {
        for (let j = SIZEOF_SHORT; j < len; j += SIZEOF_SHORT) {
          if (this.#view.getInt16(vt1 + j, true) !== this.#view.getInt16(vt2 + j, true)) {
            continue outer;
          }
        }
        existingVtable = candidate;
        break;
      }
    }
    if (existingVtable !== 0) {
      this.#space = this.#buf.length - vtableLoc;
      this.#view.setInt32(this.#space, existingVtable - vtableLoc, true);
    } else {
      this.#vtables.push(this.offset());
      this.#view.setInt32(this.#buf.length - vtableLoc, this.offset() - vtableLoc, true);
    }
    this.#isNested = false;
    this.#vtable = null;
    return vtableLoc;
  }
  /**
  * Begin a vector of `numElems` elements of `elemSize` bytes, aligned to
  * `alignment`. Write elements back-to-front with the raw `write*` methods or
  * `addOffset`, then call `endVector()`.
  */
  startVector(elemSize: number, numElems: number, alignment: number): void {
    if (this.#isNested) {
      throw new Error('FlatBuffers: startVector inside another table or vector');
    }
    this.#isNested = true;
    this.#vectorNumElems = numElems;
    this.prep(SIZEOF_INT, elemSize * numElems);
    this.prep(alignment, elemSize * numElems);
  }
  /**
  * Finish the current vector and return its builder offset.
  */
  endVector(): number {
    if (!this.#isNested) {
      throw new Error('FlatBuffers: endVector without startVector');
    }
    this.#isNested = false;
    this.writeInt32(this.#vectorNumElems);
    return this.offset();
  }
  /**
  * Write a UTF-8 string (with NUL terminator, per the format) and return its
  * builder offset.
  */
  createString(value: string): number {
    const utf8 = _encoder.encode(value);
    this.addInt8(0);
    this.startVector(1, utf8.length, 1);
    this.#space -= utf8.length;
    this.#buf.set(utf8, this.#space);
    return this.endVector();
  }
  /**
  * Write a `[ubyte]` vector from raw bytes and return its builder offset.
  */
  createByteVector(bytes: Uint8Array): number {
    this.startVector(1, bytes.length, 1);
    this.#space -= bytes.length;
    this.#buf.set(bytes, this.#space);
    return this.endVector();
  }
  /**
  * Finalize the buffer with `rootTable` as the root. An optional 4-character
  * `fileIdentifier` is stored after the root offset; `sizePrefixed` writes
  * the standard 4-byte length prefix.
  */
  finish(rootTable: number, options?: {
    fileIdentifier?: string;
    sizePrefixed?: boolean;
  }): void {
    const sizePrefix = options?.sizePrefixed ? SIZEOF_INT : 0;
    const fid = options?.fileIdentifier;
    if (fid !== undefined) {
      if (fid.length !== FILE_IDENTIFIER_LENGTH) {
        throw new TypeError(`FlatBuffers: file identifier must be exactly ${FILE_IDENTIFIER_LENGTH} characters`);
      }
      this.prep(this.#minalign, SIZEOF_INT + FILE_IDENTIFIER_LENGTH + sizePrefix);
      for (let i = FILE_IDENTIFIER_LENGTH - 1; i >= 0; i--) {
        this.writeInt8(fid.charCodeAt(i));
      }
    }
    this.prep(this.#minalign, SIZEOF_INT + sizePrefix);
    this.addOffset(rootTable);
    if (sizePrefix) {
      this.addInt32(this.#buf.length - this.#space);
    }
    this.#finished = true;
  }
  /**
  * The finished buffer contents (a view over the builder's storage, not a
  * copy). Only valid after `finish()`.
  */
  bytes(): Uint8Array {
    if (!this.#finished) {
      throw new Error('FlatBuffers: bytes() called before finish()');
    }
    return this.#buf.subarray(this.#space);
  }
}
