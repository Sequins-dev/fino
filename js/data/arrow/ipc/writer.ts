/**
 * Arrow IPC stream and file writers.
 *
 * Serializes `RecordBatch` / `Table` data into the two Arrow IPC formats: the
 * streaming format (schema message, dictionary batches, record batches, then
 * an end-of-stream marker) and the random-access file format (the same
 * message stream wrapped in `ARROW1` magic bytes with a Flatbuffers footer
 * that indexes every block). Output is accumulated entirely in memory and
 * returned as one contiguous `Uint8Array`.
 *
 * Body buffers are laid out per the columnar spec: every buffer is padded to
 * 8-byte alignment, validity bitmaps are regenerated from each vector's null
 * mask, and sliced vectors are serialized window-only — offset buffers are
 * rebased so the first visible element starts at 0, and list children are
 * trimmed to the referenced range. Dictionary-encoded columns (at any nesting
 * depth) emit one dictionary batch per dictionary id, placed before the first
 * record batch that references it. Optional per-buffer body compression (LZ4
 * frame or Zstd) uses the spec's compressed-buffer framing — an 8-byte
 * uncompressed-length prefix, with a `-1` sentinel storing the buffer raw
 * whenever compression fails to shrink it.
 *
 * The public surface — `RecordBatchStreamWriter`, `RecordBatchFileWriter`,
 * `tableToIPC`, and `IPCWriteOptions` — is re-exported through
 * `fino:data/arrow`; import from there. The reading half lives in
 * `./reader.ts`.
 *
 * ```ts no_run
 * import { RecordBatch, tableToIPC } from 'fino:data/arrow';
 *
 * const batch = RecordBatch.from({ id: [1, 2, 3], name: ['a', 'b', 'c'] });
 * const bytes = tableToIPC(batch, { format: 'file', compression: 'zstd' });
 * ```
 *
 * Arrow IPC format: https://arrow.apache.org/docs/format/Columnar.html#serialization-and-interprocess-communication-ipc
 *
 * @internal
 */
import { compress as compressBytes } from 'fino:compress';
import { ArrowError } from '../errors.ts';
import { Schema } from '../schema.ts';
import { Vector } from '../vector.ts';
import { RecordBatch } from '../batch.ts';
import { Table } from '../table.ts';
import { bufferLayout, fixedWidthBytes, hasVariadicBuffers, type DataType } from '../type.ts';
import {
  schemaMessage,
  recordBatchMessage,
  dictionaryBatchMessage,
  encodeSchema,
  CompressionType,
  type FieldNode,
  type BufferRegion,
} from './metadata.ts';
import { Builder } from 'fino:format/flatbuffers';
const MAGIC = new Uint8Array([65, 82, 82, 79, 87, 49]);
/**
 * Options controlling IPC serialization.
 *
 * Accepted by every writer in this module. Compression applies to record
 * batch and dictionary batch bodies only — message metadata is never
 * compressed — and readers on the other end must support the chosen codec.
 *
 * ```ts no_run
 * import { RecordBatch, tableToIPC, type IPCWriteOptions } from 'fino:data/arrow';
 *
 * const options: IPCWriteOptions = { compression: 'lz4' };
 * const bytes = tableToIPC(RecordBatch.from({ id: [1, 2, 3] }), options);
 * ```
 */
export interface IPCWriteOptions {
  /**
   * Body compression codec, or `undefined` for uncompressed buffers.
   *
   * `'lz4'` is the LZ4 frame format; `'zstd'` is Zstandard. The codec must be
   * available through `fino:compress` (backed by the system's liblz4 /
   * libzstd). Buffers that do not shrink under compression are stored raw,
   * so enabling compression never inflates a body buffer beyond its 8-byte
   * length prefix.
   */
  compression?: 'lz4' | 'zstd';
}
interface BatchBuffers {
  length: number;
  nodes: FieldNode[];
  buffers: BufferRegion[];
  variadicCounts: number[];
  body: Uint8Array;
}
function bitmapFromValid(vec: Vector): Uint8Array | null {
  if (vec.nullCount === 0) return null;
  const len = vec.length;
  const out = new Uint8Array((len + 7) >> 3);
  for (let i = 0; i < len; i++) if (vec.isValid(i)) out[i >> 3]! |= 1 << (i & 7);
  return out;
}
class BodyBuilder {
  parts: Uint8Array[] = [];
  buffers: BufferRegion[] = [];
  length = 0;
  #compression: number | null;
  constructor(compression: number | null) {
    this.#compression = compression;
  }
  add(bytes: Uint8Array | null): void {
    const raw = bytes ?? new Uint8Array(0);
    const payload = this.#compression === null ? raw : this.#compressBuffer(raw);
    // Align each buffer to 8 bytes.
    const pad = (8 - (this.length % 8)) % 8;
    if (pad > 0) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.buffers.push({
      offset: this.length,
      length: payload.byteLength,
    });
    this.parts.push(payload);
    this.length += payload.byteLength;
  }
  #compressBuffer(raw: Uint8Array): Uint8Array {
    const format = this.#compression === CompressionType.ZSTD ? 'zstd' : 'lz4';
    const out = new Uint8Array(8 + raw.byteLength * 2 + 64);
    const dv = new DataView(out.buffer);
    if (raw.byteLength === 0) {
      dv.setBigInt64(0, 0n, true);
      return out.subarray(0, 8);
    }
    const compressed = compressBytes(raw, { format });
    if (compressed.byteLength >= raw.byteLength) {
      // Not worth compressing: store raw with a -1 length sentinel.
      dv.setBigInt64(0, -1n, true);
      out.set(raw, 8);
      return out.subarray(0, 8 + raw.byteLength);
    }
    dv.setBigInt64(0, BigInt(raw.byteLength), true);
    out.set(compressed, 8);
    return out.subarray(0, 8 + compressed.byteLength);
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let pos = 0;
    for (const part of this.parts) {
      out.set(part, pos);
      pos += part.byteLength;
    }
    return out;
  }
}
function collectColumn(
  vec: Vector,
  body: BodyBuilder,
  nodes: FieldNode[],
  variadic: number[],
): void {
  nodes.push({
    length: vec.length,
    nullCount: vec.nullCount,
  });
  const type = vec.type;
  const raw = vec.toRaw();
  const offset = raw.offset ?? 0;
  const len = vec.length;
  for (const kind of bufferLayout(type)) {
    switch (kind) {
      case 'validity':
        body.add(bitmapFromValid(vec));
        break;
      case 'data':
        body.add(dataBuffer(type, raw.values ?? null, offset, len, vec));
        break;
      case 'offset32':
        body.add(sliceOffsets(raw.valueOffsets!, offset, len, 4));
        break;
      case 'offset64':
        body.add(sliceOffsets(raw.valueOffsets!, offset, len, 8));
        break;
      case 'size32':
        body.add(raw.sizes!.subarray(offset * 4, (offset + len) * 4));
        break;
      case 'size64':
        body.add(raw.sizes!.subarray(offset * 8, (offset + len) * 8));
        break;
      case 'typeIds':
        body.add(raw.typeIds!.subarray(offset, offset + len));
        break;
      case 'views':
        body.add(raw.views!.subarray(offset * 16, (offset + len) * 16));
        break;
    }
  }
  if (hasVariadicBuffers(type)) {
    const buffers = raw.variadicBuffers ?? [];
    variadic.push(buffers.length);
    for (const buf of buffers) body.add(buf);
  }
  // Children.
  switch (type.kind) {
    case 'list':
    case 'largelist':
    case 'map': {
      const child = vec.children[0]!;
      const [start, end] = listChildRange(
        raw.valueOffsets!,
        offset,
        len,
        type.kind === 'largelist',
      );
      collectColumn(child.slice(start, end), body, nodes, variadic);
      break;
    }
    case 'fixedsizelist': {
      const size = type.listSize;
      collectColumn(
        vec.children[0]!.slice(offset * size, (offset + len) * size),
        body,
        nodes,
        variadic,
      );
      break;
    }
    case 'struct':
      for (const child of vec.children)
        collectColumn(child.slice(offset, offset + len), body, nodes, variadic);
      break;
    case 'listview':
    case 'largelistview':
    case 'union':
    case 'runendencoded':
      if (offset !== 0)
        throw new ArrowError(
          `writing a sliced ${type.kind} column is not supported; compact it first`,
        );
      for (const child of vec.children) collectColumn(child, body, nodes, variadic);
      break;
  }
}
function dataBuffer(
  type: DataType,
  values: Uint8Array | null,
  offset: number,
  len: number,
  vec: Vector,
): Uint8Array | null {
  if (values === null) return null;
  if (type.kind === 'bool') {
    const out = new Uint8Array((len + 7) >> 3);
    for (let i = 0; i < len; i++) {
      const bit = (values[(offset + i) >> 3]! & (1 << ((offset + i) & 7))) !== 0;
      if (bit) out[i >> 3]! |= 1 << (i & 7);
    }
    return out;
  }
  const w = type.kind === 'dictionary' ? fixedWidthBytes(type.indexType) : fixedWidthBytes(type);
  if (w > 0) return values.subarray(offset * w, (offset + len) * w);
  void vec;
  return values;
}
function sliceOffsets(offsets: Uint8Array, offset: number, len: number, width: number): Uint8Array {
  if (offset === 0) return offsets.subarray(0, (len + 1) * width);
  // Rebase so the first offset is 0.
  const src = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
  const out = new Uint8Array((len + 1) * width);
  const dv = new DataView(out.buffer);
  const base =
    width === 8 ? src.getBigInt64(offset * 8, true) : BigInt(src.getInt32(offset * 4, true));
  for (let i = 0; i <= len; i++) {
    const v =
      width === 8
        ? src.getBigInt64((offset + i) * 8, true)
        : BigInt(src.getInt32((offset + i) * 4, true));
    if (width === 8) dv.setBigInt64(i * 8, v - base, true);
    else dv.setInt32(i * 4, Number(v - base), true);
  }
  return out;
}
function listChildRange(
  offsets: Uint8Array,
  offset: number,
  len: number,
  large: boolean,
): [number, number] {
  const dv = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
  const at = (i: number) =>
    large ? Number(dv.getBigInt64(i * 8, true)) : dv.getInt32(i * 4, true);
  return [at(offset), at(offset + len)];
}
function buildBatchBuffers(batch: RecordBatch, compression: number | null): BatchBuffers {
  const body = new BodyBuilder(compression);
  const nodes: FieldNode[] = [];
  const variadic: number[] = [];
  for (const col of batch.columns) collectColumn(col, body, nodes, variadic);
  return {
    length: batch.numRows,
    nodes,
    buffers: body.buffers,
    variadicCounts: variadic,
    body: body.concat(),
  };
}
function buildSingleColumnBuffers(vec: Vector, compression: number | null): BatchBuffers {
  const body = new BodyBuilder(compression);
  const nodes: FieldNode[] = [];
  const variadic: number[] = [];
  collectColumn(vec, body, nodes, variadic);
  return {
    length: vec.length,
    nodes,
    buffers: body.buffers,
    variadicCounts: variadic,
    body: body.concat(),
  };
}
function encapsulate(metadata: Uint8Array, body: Uint8Array): Uint8Array[] {
  const metaPad = (8 - (metadata.byteLength % 8)) % 8;
  const paddedMetaLen = metadata.byteLength + metaPad;
  const prefix = new Uint8Array(8 + paddedMetaLen);
  const dv = new DataView(prefix.buffer);
  dv.setUint32(0, 4294967295, true);
  dv.setInt32(4, paddedMetaLen, true);
  prefix.set(metadata, 8);
  const bodyPad = (8 - (body.byteLength % 8)) % 8;
  return bodyPad > 0 ? [prefix, body, new Uint8Array(bodyPad)] : [prefix, body];
}
function findDictionaries(vec: Vector, out: Map<number, Vector>): void {
  if (vec.type.kind === 'dictionary') {
    out.set(
      vec.type.id,
      (
        vec as unknown as {
          dictionary: Vector;
        }
      ).dictionary,
    );
  }
  for (const child of vec.children) findDictionaries(child, out);
}
/**
 * Serialize batches into the Arrow IPC stream or file format.
 *
 * The shared engine behind `RecordBatchStreamWriter` and
 * `RecordBatchFileWriter` — those classes are thin format-selecting wrappers
 * around this one. The first `writeBatch` call captures the batch's schema
 * and emits the schema message (preceded by the `ARROW1` magic in file mode);
 * batches written after that are assumed to share the same schema — no
 * cross-batch validation is performed. Dictionary batches are emitted
 * lazily, once per dictionary id, ahead of the first record batch that
 * references them.
 *
 * A writer is single-use and fully in-memory: append batches with
 * `writeBatch`, then call `finish` exactly once to terminate the output and
 * obtain the bytes. This class is not part of the public `fino:data/arrow`
 * surface; built-in code that needs direct control imports it from
 * `internal:data/arrow/ipc/writer`.
 *
 * ```ts no_run
 * import { IPCWriter } from 'internal:data/arrow/ipc/writer';
 *
 * const writer = new IPCWriter({ file: true, compression: 'zstd' });
 * writer.writeBatch(batch);
 * const bytes = writer.finish();
 * ```
 *
 * @internal
 */
export class IPCWriter {
  #parts: Uint8Array[] = [];
  #schema: Schema | null = null;
  #compression: number | null;
  #file: boolean;
  #dictBlocks: {
    offset: number;
    metaDataLength: number;
    bodyLength: number;
  }[] = [];
  #batchBlocks: {
    offset: number;
    metaDataLength: number;
    bodyLength: number;
  }[] = [];
  #position = 0;
  #dictionariesWritten = new Set<number>();
  /**
   * Create a writer; `file: true` selects the file format, otherwise the
   * streaming format is produced. `compression` behaves as documented on
   * `IPCWriteOptions`.
   */
  constructor(
    options:
      | (IPCWriteOptions & {
          file?: boolean;
        })
      | undefined,
  ) {
    this.#compression =
      options?.compression === 'zstd'
        ? CompressionType.ZSTD
        : options?.compression === 'lz4'
          ? CompressionType.LZ4_FRAME
          : null;
    this.#file = options?.file ?? false;
  }
  #push(bytes: Uint8Array): void {
    this.#parts.push(bytes);
    this.#position += bytes.byteLength;
  }
  #pushMessage(
    metadata: Uint8Array,
    body: Uint8Array,
  ): {
    offset: number;
    metaDataLength: number;
    bodyLength: number;
  } {
    const offset = this.#position;
    const chunks = encapsulate(metadata, body);
    let metaDataLength = 0;
    metaDataLength = chunks[0]!.byteLength;
    for (const chunk of chunks) this.#push(chunk);
    const bodyLength = this.#position - offset - metaDataLength;
    return {
      offset,
      metaDataLength,
      bodyLength,
    };
  }
  #ensureSchema(schema: Schema): void {
    if (this.#schema !== null) return;
    this.#schema = schema;
    if (this.#file) this.#push(padTo8(MAGIC));
    this.#pushMessage(schemaMessage(schema), new Uint8Array(0));
  }
  #writeDictionaries(batch: RecordBatch): void {
    const dicts = new Map<number, Vector>();
    for (const col of batch.columns) findDictionaries(col, dicts);
    for (const [id, values] of dicts) {
      if (this.#dictionariesWritten.has(id)) continue;
      this.#dictionariesWritten.add(id);
      const bufs = buildSingleColumnBuffers(values, this.#compression);
      const meta = dictionaryBatchMessage(
        id,
        false,
        bufs.length,
        bufs.nodes,
        bufs.buffers,
        bufs.variadicCounts,
        this.#compression,
        bufs.body.byteLength,
      );
      const block = this.#pushMessage(meta, bufs.body);
      this.#dictBlocks.push(block);
    }
  }
  /**
   * Append a record batch to the output.
   *
   * The first call captures the batch's schema and writes the schema message.
   * Dictionaries referenced by the batch (at any nesting depth) that have not
   * been written yet are emitted as dictionary batches before the record
   * batch itself. Throws `ArrowError` when a column is a sliced list-view,
   * union, or run-end-encoded vector — serializing a sliced window of those
   * layouts is not supported; compact the vector first.
   */
  writeBatch(batch: RecordBatch): void {
    this.#ensureSchema(batch.schema);
    this.#writeDictionaries(batch);
    const bufs = buildBatchBuffers(batch, this.#compression);
    const meta = recordBatchMessage(
      bufs.length,
      bufs.nodes,
      bufs.buffers,
      bufs.variadicCounts,
      this.#compression,
      bufs.body.byteLength,
    );
    const block = this.#pushMessage(meta, bufs.body);
    this.#batchBlocks.push(block);
  }
  /**
   * Terminate the output and return the complete byte buffer.
   *
   * In stream mode this appends the end-of-stream marker; in file mode it
   * appends the Flatbuffers footer indexing every dictionary and record
   * batch block, the footer length, and the trailing `ARROW1` magic. Throws
   * `ArrowError` if no batch was ever written, since there is no schema to
   * emit. Call exactly once — the writer is spent afterwards.
   */
  finish(): Uint8Array {
    if (this.#schema === null)
      throw new ArrowError('cannot finish an IPC writer with no schema (write at least one batch)');
    if (this.#file) {
      const footer = encodeFooter(this.#schema, this.#dictBlocks, this.#batchBlocks);
      this.#push(footer);
      const lenBuf = new Uint8Array(4);
      new DataView(lenBuf.buffer).setInt32(0, footer.byteLength, true);
      this.#push(lenBuf);
      this.#push(MAGIC);
    } else {
      // EOS marker.
      const eos = new Uint8Array(8);
      new DataView(eos.buffer).setUint32(0, 4294967295, true);
      this.#push(eos);
    }
    const total = this.#position;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of this.#parts) {
      out.set(part, pos);
      pos += part.byteLength;
    }
    return out;
  }
}
function padTo8(bytes: Uint8Array): Uint8Array {
  const pad = (8 - (bytes.byteLength % 8)) % 8;
  if (pad === 0) return bytes;
  const out = new Uint8Array(bytes.byteLength + pad);
  out.set(bytes, 0);
  return out;
}
function encodeFooter(
  schema: Schema,
  dicts: {
    offset: number;
    metaDataLength: number;
    bodyLength: number;
  }[],
  batches: {
    offset: number;
    metaDataLength: number;
    bodyLength: number;
  }[],
): Uint8Array {
  const b = new Builder();
  const schemaOff = encodeSchema(b, schema);
  const dictVec = encodeBlocks(b, dicts);
  const batchVec = encodeBlocks(b, batches);
  b.startTable(5);
  b.addFieldInt16(0, 4, 0);
  b.addFieldOffset(1, schemaOff);
  b.addFieldOffset(2, dictVec);
  b.addFieldOffset(3, batchVec);
  b.finish(b.endTable());
  return b.bytes();
}
function encodeBlocks(
  b: Builder,
  blocks: {
    offset: number;
    metaDataLength: number;
    bodyLength: number;
  }[],
): number {
  // struct Block { long offset; int metaDataLength; (pad 4) long bodyLength; } = 24 bytes.
  b.startVector(24, blocks.length, 8);
  for (let i = blocks.length - 1; i >= 0; i--) {
    b.prep(8, 24);
    b.writeInt64(BigInt(blocks[i]!.bodyLength));
    b.writeInt32(0);
    b.writeInt32(blocks[i]!.metaDataLength);
    b.writeInt64(BigInt(blocks[i]!.offset));
  }
  return b.endVector();
}
/**
 * Writer for the Arrow IPC streaming format.
 *
 * Produces the sequential wire form — schema message, dictionary batches,
 * record batches, end-of-stream marker — meant for transports where the
 * consumer reads messages in order (sockets, pipes, HTTP bodies) and for any
 * Arrow-speaking peer (pyarrow, polars, DuckDB, ...). The schema is taken
 * from the first batch written; later batches are assumed to match it and
 * are not validated. The whole stream is buffered in memory until `toBytes`.
 *
 * ```ts no_run
 * import { RecordBatch, RecordBatchStreamWriter } from 'fino:data/arrow';
 *
 * const writer = new RecordBatchStreamWriter({ compression: 'lz4' });
 * writer
 *   .write(RecordBatch.from({ id: [1, 2], name: ['a', 'b'] }))
 *   .write(RecordBatch.from({ id: [3, 4], name: ['c', 'd'] }));
 * const bytes = writer.toBytes();
 * ```
 */
export class RecordBatchStreamWriter {
  #writer: IPCWriter;
  /** Create a stream writer, optionally compressing batch bodies. */
  constructor(options?: IPCWriteOptions) {
    this.#writer = new IPCWriter(options);
  }
  /**
   * Append a batch; returns `this` so calls chain.
   *
   * Throws `ArrowError` for sliced list-view, union, or run-end-encoded
   * columns, which must be compacted before writing.
   */
  write(batch: RecordBatch): this {
    this.#writer.writeBatch(batch);
    return this;
  }
  /**
   * Finish the stream and return the full byte buffer.
   *
   * Appends the end-of-stream marker, so nothing more can be written. Throws
   * `ArrowError` if no batch was written. Call exactly once.
   */
  toBytes(): Uint8Array {
    return this.#writer.finish();
  }
}
/**
 * Writer for the Arrow IPC file format (also known as Feather V2).
 *
 * Wraps the streaming message sequence in `ARROW1` magic bytes and appends a
 * Flatbuffers footer recording the offset and size of every dictionary and
 * record batch block, so readers can seek straight to any batch without
 * scanning. This is the format to persist to disk (conventionally `.arrow`
 * files); use `RecordBatchStreamWriter` for sequential transports. Like the
 * stream writer, the schema comes from the first batch and everything is
 * buffered in memory until `toBytes`.
 *
 * ```ts no_run
 * import { RecordBatch, RecordBatchFileWriter } from 'fino:data/arrow';
 *
 * const writer = new RecordBatchFileWriter({ compression: 'zstd' });
 * writer.write(RecordBatch.from({ id: [1, 2, 3], score: [0.5, 0.9, 0.1] }));
 * const bytes = writer.toBytes(); // write these to a .arrow file
 * ```
 */
export class RecordBatchFileWriter {
  #writer: IPCWriter;
  /** Create a file writer, optionally compressing batch bodies. */
  constructor(options?: IPCWriteOptions) {
    this.#writer = new IPCWriter({
      ...options,
      file: true,
    });
  }
  /**
   * Append a batch; returns `this` so calls chain.
   *
   * Throws `ArrowError` for sliced list-view, union, or run-end-encoded
   * columns, which must be compacted before writing.
   */
  write(batch: RecordBatch): this {
    this.#writer.writeBatch(batch);
    return this;
  }
  /**
   * Finish the file and return the full byte buffer.
   *
   * Appends the footer and trailing magic, so nothing more can be written.
   * Throws `ArrowError` if no batch was written. Call exactly once.
   */
  toBytes(): Uint8Array {
    return this.#writer.finish();
  }
}
/**
 * Serialize a table or a single record batch to Arrow IPC bytes.
 *
 * One-shot convenience over the writer classes: a `Table` writes each of its
 * batches in order, a lone `RecordBatch` writes just itself. `format`
 * selects the streaming format (the default) or the random-access file
 * format; `tableFromIPC` is the inverse and auto-detects which one it was
 * given. Throws `ArrowError` if the source contains no batches.
 *
 * ```ts no_run
 * import { RecordBatch, Table, tableToIPC, tableFromIPC } from 'fino:data/arrow';
 *
 * const b1 = RecordBatch.from({ id: [1, 2], name: ['a', 'b'] });
 * const b2 = RecordBatch.from({ id: [3, 4], name: ['c', 'd'] });
 * const bytes = tableToIPC(Table.from([b1, b2]), { format: 'file' });
 * tableFromIPC(bytes).numRows; // 4
 * ```
 */
export function tableToIPC(
  source: Table | RecordBatch,
  options?: IPCWriteOptions & {
    format?: 'stream' | 'file';
  },
): Uint8Array {
  const batches = source instanceof Table ? source.batches : [source];
  const writer =
    options?.format === 'file'
      ? new RecordBatchFileWriter(options)
      : new RecordBatchStreamWriter(options);
  for (const batch of batches) writer.write(batch);
  return writer.toBytes();
}
