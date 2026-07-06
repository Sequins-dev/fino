/**
* Arrow IPC stream and file readers, plus the `tableFromIPC`/`tableToIPC`
* conveniences. Re-exports the writer surface so the whole IPC API is one
* import; everything here reaches user code through `fino:data/arrow`.
*
* Decoding is eager: the buffer is scanned once, dictionary batches are
* resolved as they appear, and every record batch is materialized up front.
* Uncompressed body buffers are aliased as subarrays of the input (zero-copy),
* so the source bytes must not be mutated while decoded vectors are in use.
* LZ4- and ZSTD-compressed bodies are inflated into fresh buffers via
* `fino:compress`.
*
* Both wire layouts are handled transparently: the streaming format (a bare
* message sequence) and the file format (`ARROW1` magic plus a footer).
* `RecordBatchReader` accepts either; `RecordBatchFileReader` additionally
* requires the file magic and adds indexed batch access. Legacy pre-0.15
* streams (missing the `0xFFFFFFFF` continuation marker) and delta dictionary
* batches are rejected with descriptive errors.
*
* ```ts no_run
* import { tableFromIPC, RecordBatchReader } from 'fino:data/arrow';
* import { DiskFileSystem } from 'fino:file';
*
* const fs = new DiskFileSystem();
* const file = await fs.open('/data/metrics.arrow');
* const table = tableFromIPC(await file.bytes());
* await file.close();
* ```
*
* Arrow IPC format:
* https://arrow.apache.org/docs/format/Columnar.html#serialization-and-interprocess-communication-ipc
*
* @internal
*/
import { decompress as decompressBytes } from 'fino:compress';
import { ArrowError, ArrowParseError, parseError } from '../errors.ts';
import { Field, Schema } from '../schema.ts';
import { Vector, makeVector, type VectorData } from '../vector.ts';
import { RecordBatch } from '../batch.ts';
import { Table } from '../table.ts';
import { bufferLayout, hasVariadicBuffers, type DataType } from '../type.ts';
import { decodeMessage, MessageHeader, CompressionType, type RecordBatchHeader, type MessageInfo } from './metadata.ts';
export { RecordBatchStreamWriter, RecordBatchFileWriter, IPCWriter, tableToIPC, type IPCWriteOptions } from './writer.ts';
const MAGIC = [
  65,
  82,
  82,
  79,
  87,
  49
];
function isFileFormat(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MAGIC.length + 8) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}
// --- buffer reconstruction --------------------------------------------------
interface RebuildContext {
  nodes: RecordBatchHeader['nodes'];
  nodeIndex: number;
  bodyBuffers: Uint8Array[];
  bufferIndex: number;
  variadicCounts: number[];
  variadicIndex: number;
  dictionaries: Map<number, Vector>;
}
function decompressBuffer(region: {
  offset: number;
  length: number;
}, body: Uint8Array, compression: number | null): Uint8Array {
  const raw = body.subarray(region.offset, region.offset + region.length);
  if (compression === null || region.length === 0) return raw;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const uncompressed = dv.getBigInt64(0, true);
  const payload = raw.subarray(8);
  if (uncompressed === -1n) return payload;
  const format = compression === CompressionType.ZSTD ? 'zstd' : 'lz4';
  return decompressBytes(payload, { format });
}
function materializeBuffers(header: RecordBatchHeader, body: Uint8Array): Uint8Array[] {
  return header.buffers.map((region) => decompressBuffer(region, body, header.compression));
}
function rebuildVector(field: Field, ctx: RebuildContext): Vector {
  const type = field.type;
  const node = ctx.nodes[ctx.nodeIndex++]!;
  const data: VectorData = {
    type,
    length: node.length,
    nullCount: node.nullCount
  };
  for (const kind of bufferLayout(type)) {
    const buf = ctx.bodyBuffers[ctx.bufferIndex++]!;
    switch (kind) {
      case 'validity':
        data.validity = node.nullCount === 0 || buf.byteLength === 0 ? null : buf;
        break;
      case 'data':
        data.values = buf;
        break;
      case 'offset32':
      case 'offset64':
        data.valueOffsets = buf;
        break;
      case 'size32':
      case 'size64':
        data.sizes = buf;
        break;
      case 'typeIds':
        data.typeIds = buf;
        break;
      case 'views':
        data.views = buf;
        break;
    }
  }
  if (hasVariadicBuffers(type)) {
    const count = ctx.variadicCounts[ctx.variadicIndex++] ?? 0;
    const buffers: Uint8Array[] = [];
    for (let i = 0; i < count; i++) buffers.push(ctx.bodyBuffers[ctx.bufferIndex++]!);
    data.variadicBuffers = buffers;
  }
  if (type.kind === 'dictionary') {
    const dict = ctx.dictionaries.get(type.id);
    if (dict === undefined) throw new ArrowError(`dictionary ${type.id} referenced before its dictionary batch`);
    data.dictionary = dict;
  }
  const children = childFieldList(type);
  if (children.length > 0) {
    data.children = children.map((child) => rebuildVector(child, ctx));
  }
  return makeVector(data);
}
function childFieldList(type: DataType): Field[] {
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
function rebuildBatch(schema: Schema, header: RecordBatchHeader, body: Uint8Array, dictionaries: Map<number, Vector>): RecordBatch {
  const ctx: RebuildContext = {
    nodes: header.nodes,
    nodeIndex: 0,
    bodyBuffers: materializeBuffers(header, body),
    bufferIndex: 0,
    variadicCounts: header.variadicBufferCounts,
    variadicIndex: 0,
    dictionaries
  };
  const columns = schema.fields.map((f) => rebuildVector(f, ctx));
  return new RecordBatch(schema, columns);
}
// Build id → dictionary value Field map by scanning the schema recursively.
function collectDictionaryFields(fields: Field[], out: Map<number, Field>): void {
  for (const field of fields) {
    if (field.type.kind === 'dictionary') {
      out.set(field.type.id, new Field(field.name, field.type.valueType, field.nullable));
    }
    for (const child of childFieldList(field.type)) collectDictionaryFields([child], out);
  }
}
// --- message iteration ------------------------------------------------------
interface ParsedMessage {
  info: MessageInfo;
  body: Uint8Array;
}
function* iterateMessages(bytes: Uint8Array): Generator<ParsedMessage> {
  let pos = 0;
  let end = bytes.byteLength;
  if (isFileFormat(bytes)) {
    pos = 8;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const footerLen = dv.getInt32(bytes.byteLength - MAGIC.length - 4, true);
    end = bytes.byteLength - MAGIC.length - 4 - footerLen;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (pos + 8 <= end) {
    const continuation = dv.getUint32(pos, true);
    if (continuation !== 4294967295) {
      parseError(bytes, pos, 'expected 0xFFFFFFFF continuation marker (legacy pre-0.15 streams are unsupported; re-export with Arrow >= 0.15)');
    }
    const metaLen = dv.getInt32(pos + 4, true);
    if (metaLen === 0) break;
    const metaStart = pos + 8;
    const metadata = bytes.subarray(metaStart, metaStart + metaLen);
    const info = decodeMessage(metadata);
    const bodyStart = metaStart + metaLen;
    const body = bytes.subarray(bodyStart, bodyStart + info.bodyLength);
    yield {
      info,
      body
    };
    // The body is padded to an 8-byte boundary on the wire.
    const paddedBody = info.bodyLength + (8 - info.bodyLength % 8) % 8;
    pos = bodyStart + paddedBody;
  }
}
function parseAll(bytes: Uint8Array): {
  schema: Schema;
  batches: RecordBatch[];
} {
  let schema: Schema | null = null;
  const dictFields = new Map<number, Field>();
  const dictionaries = new Map<number, Vector>();
  const batches: RecordBatch[] = [];
  for (const { info, body } of iterateMessages(bytes)) {
    if (info.headerType === MessageHeader.Schema && info.schema) {
      schema = info.schema;
      collectDictionaryFields(schema.fields, dictFields);
    } else if (info.headerType === MessageHeader.DictionaryBatch && info.dictionaryBatch) {
      if (schema === null) parseError(bytes, 0, 'dictionary batch before schema');
      const { id, isDelta, batch } = info.dictionaryBatch;
      if (isDelta) throw new ArrowError('delta dictionary batches are not supported');
      const valueField = dictFields.get(id);
      if (valueField === undefined) throw new ArrowError(`dictionary batch for unknown id ${id}`);
      const dictCtx: RebuildContext = {
        nodes: batch.nodes,
        nodeIndex: 0,
        bodyBuffers: materializeBuffers(batch, body),
        bufferIndex: 0,
        variadicCounts: batch.variadicBufferCounts,
        variadicIndex: 0,
        dictionaries
      };
      dictionaries.set(id, rebuildVector(valueField, dictCtx));
    } else if (info.headerType === MessageHeader.RecordBatch && info.recordBatch) {
      if (schema === null) parseError(bytes, 0, 'record batch before schema');
      batches.push(rebuildBatch(schema, info.recordBatch, body, dictionaries));
    }
  }
  if (schema === null) throw new ArrowParseError('Arrow IPC stream contained no schema message', {
    detail: 'no schema',
    format: 'arrow',
    offset: 0,
    source: bytes
  });
  return {
    schema,
    batches
  };
}
async function collectBytes(source: AsyncIterable<Uint8Array> | {
  read(): Promise<Uint8Array | null>;
}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  if (Symbol.asyncIterator in source) {
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      parts.push(chunk);
      total += chunk.byteLength;
    }
  } else {
    const reader = source as {
      read(): Promise<Uint8Array | null>;
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk === null) break;
      parts.push(chunk);
      total += chunk.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}
/**
* Reads record batches from an Arrow IPC stream or file.
*
* Construct via the static factories: `from` for in-memory bytes, `fromAsync`
* for an async byte source. Both formats are detected automatically — a
* buffer starting with the `ARROW1` magic is treated as a file, anything else
* as a stream. All batches are decoded eagerly at construction; the instance
* is a plain container afterwards, iterable batch by batch or collapsible
* into a `Table`.
*
* Construction throws `ArrowParseError` when the input holds no schema
* message or uses the legacy pre-0.15 framing, and `ArrowError` when a
* dictionary-encoded column references a dictionary that never arrived or a
* delta dictionary batch is encountered.
*
* ```ts no_run
* import { RecordBatchReader } from 'fino:data/arrow';
*
* const reader = RecordBatchReader.from(bytes);
* console.log(reader.schema.fields.map((f) => f.name));
* for (const batch of reader) {
*   console.log(batch.numRows);
* }
* ```
*/
export class RecordBatchReader {
  /** The schema shared by every batch, from the stream's schema message. */
  readonly schema: Schema;
  /** All decoded batches, in stream order. */
  readonly batches: RecordBatch[];
  private constructor(schema: Schema, batches: RecordBatch[]) {
    this.schema = schema;
    this.batches = batches;
  }
  /**
  * Read all batches from an in-memory Arrow IPC buffer, in either stream or
  * file format.
  *
  * Decoded vectors alias the input where the body is uncompressed, so keep
  * the buffer intact for as long as the batches are used. Throws
  * `ArrowParseError` if the bytes contain no schema message or cannot be
  * parsed.
  */
  static from(bytes: Uint8Array | ArrayBuffer): RecordBatchReader {
    const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    const { schema, batches } = parseAll(u8);
    return new RecordBatchReader(schema, batches);
  }
  /**
  * Read all batches from an async byte source.
  *
  * Accepts anything async-iterable over `Uint8Array` chunks, or an object
  * with a `read()` method that resolves chunks until `null`. The entire
  * source is buffered into memory first, then parsed exactly like `from` —
  * this is a convenience for sockets and file readers, not a bounded-memory
  * streaming decoder.
  *
  * ```ts no_run
  * import { RecordBatchReader } from 'fino:data/arrow';
  * import { DiskFileSystem } from 'fino:file';
  *
  * const fs = new DiskFileSystem();
  * const file = await fs.open('/data/events.arrows');
  * const reader = await RecordBatchReader.fromAsync(file.reader());
  * await file.close();
  * ```
  */
  static async fromAsync(source: AsyncIterable<Uint8Array> | {
    read(): Promise<Uint8Array | null>;
  }): Promise<RecordBatchReader> {
    return RecordBatchReader.from(await collectBytes(source));
  }
  /** Iterate the decoded batches in stream order. */
  *[Symbol.iterator](): Iterator<RecordBatch> {
    yield* this.batches;
  }
  /** Collect all batches into a `Table` sharing this reader's schema. */
  toTable(): Table {
    return new Table(this.schema, this.batches);
  }
}
/**
* Reader for the Arrow IPC *file* format with indexed batch access.
*
* Unlike `RecordBatchReader`, construction insists on the `ARROW1` magic and
* throws `ArrowParseError` if it is absent — use this class when the input
* must be a well-formed Arrow file rather than a bare stream. All batches are
* decoded eagerly (the footer only bounds the message scan), after which
* `batch(i)` and `numBatches` give positional access.
*
* ```ts no_run
* import { RecordBatchFileReader } from 'fino:data/arrow';
*
* const reader = RecordBatchFileReader.from(bytes);
* const last = reader.batch(reader.numBatches - 1);
* console.log(last.numRows);
* ```
*/
export class RecordBatchFileReader {
  /** The schema shared by every batch, from the file's schema message. */
  readonly schema: Schema;
  /** All decoded batches, in file order. */
  readonly batches: RecordBatch[];
  private constructor(schema: Schema, batches: RecordBatch[]) {
    this.schema = schema;
    this.batches = batches;
  }
  /**
  * Read an Arrow IPC file buffer.
  *
  * Throws `ArrowParseError` if the buffer does not start with the `ARROW1`
  * magic, contains no schema message, or cannot be parsed. Uncompressed
  * vector buffers alias the input bytes, so do not mutate them while the
  * decoded batches are in use.
  */
  static from(bytes: Uint8Array | ArrayBuffer): RecordBatchFileReader {
    const u8 = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    if (!isFileFormat(u8)) throw new ArrowParseError('not an Arrow IPC file (missing ARROW1 magic)', {
      detail: 'bad magic',
      format: 'arrow',
      offset: 0,
      source: u8
    });
    const { schema, batches } = parseAll(u8);
    return new RecordBatchFileReader(schema, batches);
  }
  /** Number of record batches in the file. */
  get numBatches(): number {
    return this.batches.length;
  }
  /**
  * The batch at index `i`, in file order.
  *
  * Throws `ArrowError` when `i` is outside `0..numBatches - 1`.
  */
  batch(i: number): RecordBatch {
    const b = this.batches[i];
    if (b === undefined) throw new ArrowError(`batch index ${i} out of range 0..${this.batches.length - 1}`);
    return b;
  }
  /** Collect all batches into a `Table` sharing this reader's schema. */
  toTable(): Table {
    return new Table(this.schema, this.batches);
  }
}
/**
* Decode an Arrow IPC buffer (stream or file format) into a `Table`.
*
* The one-call counterpart to `tableToIPC`: format detection, dictionary
* resolution, and decompression all happen internally. Equivalent to
* `RecordBatchReader.from(bytes).toTable()`; use the reader classes directly
* when per-batch access matters. Throws `ArrowParseError` on malformed input
* or when no schema message is present.
*
* ```ts no_run
* import { tableFromIPC, tableToIPC, RecordBatch } from 'fino:data/arrow';
*
* const bytes = tableToIPC(RecordBatch.from({ id: [1, 2, 3] }));
* const table = tableFromIPC(bytes);
* console.log(table.numRows); // 3
* ```
*/
export function tableFromIPC(bytes: Uint8Array | ArrayBuffer): Table {
  return RecordBatchReader.from(bytes).toTable();
}
