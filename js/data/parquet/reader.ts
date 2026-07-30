/**
 * Parquet reader: Parquet file bytes → Arrow.
 *
 * This is the file-level layer of the Parquet reader, and the module behind
 * the public `readParquet` export of `fino:data/parquet`. It validates the
 * `PAR1` magic at both ends of the file, Thrift-decodes the footer
 * (`metadata.ts`), and turns the flat `SchemaElement` list into a schema node
 * tree of flat leaves and nested list/struct/map groups (`nested.ts`). Each
 * row group then becomes one Arrow `RecordBatch`: every leaf column's page
 * stream is decoded through `column-reader.ts` (all value encodings, v1 and
 * v2 data pages), and nested vectors are reassembled from the repetition/
 * definition levels. The batches are concatenated into a single Arrow
 * `Table`.
 *
 * Decoding is eager within each selected chunk. `ParquetReadOptions` can
 * project top-level fields and select row groups before page decoding; callers
 * that omit options retain the original whole-file behavior.
 *
 * ```ts no_run
 * import { readParquet } from 'internal:data/parquet/reader';
 *
 * const table = readParquet(fileBytes);
 * console.log(table.numRows, table.schema.fields.map((f) => f.name));
 * ```
 *
 * File layout follows the Parquet format spec:
 * https://parquet.apache.org/docs/file-format/
 *
 * @internal
 */
import { RecordBatch, Schema, Table, Vector } from 'fino:data/arrow';
import { PType, ParquetError } from './types.ts';
import { readFileMetaData, type ColumnMetaData, type FileMetaData } from './metadata.ts';
import { readColumnPages } from './column-reader.ts';
import {
  schemaElementsToNodes,
  collectLeaves,
  assembleTree,
  type LeafStream,
  type Node,
} from './nested.ts';
import type { ColumnDescriptor } from './schema.ts';
const MAGIC = [80, 65, 82, 49];
function checkMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) throw new ParquetError('not a Parquet file (too short)');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i] || bytes[bytes.byteLength - 4 + i] !== MAGIC[i]) {
      throw new ParquetError('not a Parquet file (missing PAR1 magic)');
    }
  }
}

/**
 * Selective decode options for `readParquet`.
 *
 * Projection names refer to top-level Arrow fields and are returned in the
 * requested order. Row-group indices are zero-based and likewise preserve the
 * requested order. Omitting either option reads the full corresponding axis.
 */
export interface ParquetReadOptions {
  /** Top-level fields to decode, in output order. */
  columns?: readonly string[];
  /** Zero-based row groups to decode, in output order. */
  rowGroups?: readonly number[];
}

/**
 * Decoded scalar statistics for one top-level Parquet column.
 *
 * @internal
 */
export interface ParquetColumnStatistics {
  min?: unknown;
  max?: unknown;
  nullCount?: bigint;
}

/**
 * Planning metadata used by the DataFrame Parquet scan.
 *
 * @internal
 */
export interface ParquetFileInfo {
  schema: Schema;
  rowGroups: Array<{
    index: number;
    numRows: number;
    columns: Record<string, ParquetColumnStatistics>;
  }>;
}

interface ParsedFile {
  bytes: Uint8Array;
  meta: FileMetaData;
  schema: Schema;
  nodes: Node[];
}

function parseFile(input: Uint8Array | ArrayBuffer): ParsedFile {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  checkMagic(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLen = dv.getUint32(bytes.byteLength - 8, true);
  const footerStart = bytes.byteLength - 8 - footerLen;
  if (footerStart < 4) throw new ParquetError('corrupt Parquet footer length');
  const meta = readFileMetaData(bytes.subarray(footerStart, bytes.byteLength - 8));
  const { schema, nodes } = schemaElementsToNodes(meta.schema);
  return { bytes, meta, schema, nodes };
}

function decodeStatistic(bytes: Uint8Array | undefined, descriptor: ColumnDescriptor): unknown {
  if (bytes === undefined) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let physical: unknown;
  switch (descriptor.physicalType) {
    case PType.BOOLEAN:
      physical = bytes[0] !== 0;
      break;
    case PType.INT32:
      physical =
        descriptor.arrowField.type.kind === 'int' && !descriptor.arrowField.type.signed
          ? view.getUint32(0, true)
          : view.getInt32(0, true);
      break;
    case PType.INT64:
      physical =
        descriptor.arrowField.type.kind === 'int' && !descriptor.arrowField.type.signed
          ? view.getBigUint64(0, true)
          : view.getBigInt64(0, true);
      break;
    case PType.FLOAT:
      physical = view.getFloat32(0, true);
      break;
    case PType.DOUBLE:
      physical = view.getFloat64(0, true);
      break;
    default:
      physical = bytes;
  }
  return descriptor.decode(physical);
}

/**
 * Inspect schema and conservative scalar row-group statistics without
 * decoding column pages.
 *
 * @internal
 */
export function inspectParquet(input: Uint8Array | ArrayBuffer): ParquetFileInfo {
  const { meta, schema, nodes } = parseFile(input);
  const offsets: number[] = [];
  let offset = 0;
  for (const node of nodes) {
    offsets.push(offset);
    offset += collectLeaves(node).length;
  }
  return {
    schema,
    rowGroups: meta.rowGroups.map((group, index) => {
      const columns: Record<string, ParquetColumnStatistics> = {};
      for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
        const node = nodes[nodeIndex]!;
        if (node.kind !== 'leaf' || !node.descriptor) continue;
        const statistics = group.columns[offsets[nodeIndex]!]!.metaData?.statistics;
        if (!statistics) continue;
        const min = decodeStatistic(statistics.minValue ?? statistics.min, node.descriptor);
        const max = decodeStatistic(statistics.maxValue ?? statistics.max, node.descriptor);
        columns[node.name] = {
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
          ...(statistics.nullCount === undefined ? {} : { nullCount: statistics.nullCount }),
        };
      }
      return {
        index,
        numRows: Number(group.numRows),
        columns,
      };
    }),
  };
}
/**
 * Decode a complete Parquet file into an Arrow `Table`.
 *
 * Accepts the file's bytes as a `Uint8Array` or `ArrayBuffer` (an
 * `ArrayBuffer` is viewed in place, not copied). Each row group in the file
 * becomes one `RecordBatch` in the returned table; a file with no row groups
 * yields a table containing a single zero-row batch, so the schema is always
 * preserved. Values arrive already converted to their Arrow logical types —
 * strings, decimals, dates, timestamps, nested lists/structs/maps, and so on.
 *
 * Throws `ParquetError` if the input is too short or missing the `PAR1`
 * magic, if the footer length is corrupt, if a row group's column-chunk count
 * does not match the schema's leaf count, or if a column chunk carries no
 * metadata. Errors from deeper layers (unsupported codec, malformed pages,
 * bad level streams) propagate as `ParquetError` too.
 *
 * ```ts no_run
 * import { readParquet } from 'internal:data/parquet/reader';
 * import { DiskFileSystem } from 'fino:file';
 *
 * const file = await new DiskFileSystem().open('/data/events.parquet', 'r');
 * const table = readParquet(await file.bytes());
 * await file.close();
 * for (const row of table) console.log(row);
 * ```
 */
export function readParquet(
  input: Uint8Array | ArrayBuffer,
  options: ParquetReadOptions = {},
): Table {
  const { bytes, meta, schema, nodes } = parseFile(input);
  const nodeLeafCounts = nodes.map((n) => collectLeaves(n).length);
  const totalLeaves = nodeLeafCounts.reduce((a, b) => a + b, 0);
  const nodeOffsets: number[] = [];
  let offset = 0;
  for (const count of nodeLeafCounts) {
    nodeOffsets.push(offset);
    offset += count;
  }
  const selectedNodeIndices =
    options.columns === undefined
      ? nodes.map((_, index) => index)
      : options.columns.map((name) => {
          const index = nodes.findIndex((node) => node.name === name);
          if (index < 0) throw new ParquetError(`unknown projected column "${name}"`);
          return index;
        });
  if (new Set(selectedNodeIndices).size !== selectedNodeIndices.length)
    throw new ParquetError('projected columns must be unique');
  const selectedNodes = selectedNodeIndices.map((index) => nodes[index]!);
  const selectedSchema = new Schema(selectedNodes.map((node) => node.field));
  const selectedGroups =
    options.rowGroups === undefined
      ? meta.rowGroups
      : options.rowGroups.map((index) => {
          if (!Number.isSafeInteger(index) || index < 0 || index >= meta.rowGroups.length)
            throw new ParquetError(`row group index ${index} is out of range`);
          return meta.rowGroups[index]!;
        });
  const batches: RecordBatch[] = [];
  for (const rowGroup of selectedGroups) {
    if (rowGroup.columns.length !== totalLeaves) {
      throw new ParquetError(
        `row group has ${rowGroup.columns.length} leaf columns, schema has ${totalLeaves}`,
      );
    }
    const numRows = Number(rowGroup.numRows);
    const columnVectors: Vector[] = selectedNodeIndices.map((nodeIndex) => {
      const node = nodes[nodeIndex]!;
      const descriptors = collectLeaves(node);
      const streams = descriptors.map((descriptor, localIndex) => {
        const leafIndex = nodeOffsets[nodeIndex]! + localIndex;
        const chunk = rowGroup.columns[leafIndex]!;
        if (chunk.metaData === undefined)
          throw new ParquetError(`column chunk ${leafIndex} has no metadata`);
        return readLeafStream(bytes, descriptor, chunk.metaData);
      });
      return assembleTree(node, streams, numRows);
    });
    batches.push(new RecordBatch(selectedSchema, columnVectors));
  }
  if (batches.length === 0) {
    const empty = selectedNodes.map((node) =>
      assembleTree(
        node,
        collectLeaves(node).map((d) => ({
          descriptor: d,
          values: [],
          defLevels: [],
          repLevels: [],
        })),
        0,
      ),
    );
    return new Table(selectedSchema, [new RecordBatch(selectedSchema, empty)]);
  }
  return new Table(selectedSchema, batches);
}
// Read one leaf column into a full (values, defLevels, repLevels) stream across
// all its pages, synthesizing zero levels where a level is absent.
function readLeafStream(
  bytes: Uint8Array,
  descriptor: ColumnDescriptor,
  meta: ColumnMetaData,
): LeafStream {
  const values: unknown[] = [];
  const defLevels: number[] = [];
  const repLevels: number[] = [];
  readColumnPages(bytes, descriptor, meta, (page) => {
    for (const v of page.values) values.push(v);
    if (page.defLevels === null) for (let i = 0; i < page.numValues; i++) defLevels.push(0);
    else for (const l of page.defLevels) defLevels.push(l);
    if (page.repLevels === null) for (let i = 0; i < page.numValues; i++) repLevels.push(0);
    else for (const l of page.repLevels) repLevels.push(l);
  });
  return {
    descriptor,
    values,
    defLevels,
    repLevels,
  };
}
