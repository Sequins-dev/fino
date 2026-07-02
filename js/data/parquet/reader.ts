/**
* Parquet reader: Parquet file bytes → Arrow.
*
* Parses the schema tree (flat leaves and nested list/struct/map groups), reads
* each leaf column's page stream through `column-reader.ts` (all encodings, v1
* and v2 pages), and reassembles nested Arrow vectors from the repetition/
* definition levels via `nested.ts`. Row groups are concatenated into one
* Arrow `Table`.
*
* @internal
*/
import { RecordBatch, Table, Vector } from 'fino:data/arrow';
import { ParquetError } from './types.ts';
import { readFileMetaData, type ColumnMetaData } from './metadata.ts';
import { readColumnPages } from './column-reader.ts';
import { schemaElementsToNodes, collectLeaves, assembleTree, type LeafStream } from './nested.ts';
import type { ColumnDescriptor } from './schema.ts';
const MAGIC = [
  80,
  65,
  82,
  49
];
function checkMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) throw new ParquetError('not a Parquet file (too short)');
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i] || bytes[bytes.byteLength - 4 + i] !== MAGIC[i]) {
      throw new ParquetError('not a Parquet file (missing PAR1 magic)');
    }
  }
}
/** Decode a Parquet file into an Arrow `Table`. */
export function readParquet(input: Uint8Array | ArrayBuffer): Table {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  checkMagic(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLen = dv.getUint32(bytes.byteLength - 8, true);
  const footerStart = bytes.byteLength - 8 - footerLen;
  if (footerStart < 4) throw new ParquetError('corrupt Parquet footer length');
  const meta = readFileMetaData(bytes.subarray(footerStart, bytes.byteLength - 8));
  const { schema, nodes } = schemaElementsToNodes(meta.schema);
  const nodeLeafCounts = nodes.map((n) => collectLeaves(n).length);
  const totalLeaves = nodeLeafCounts.reduce((a, b) => a + b, 0);
  const batches: RecordBatch[] = [];
  for (const rowGroup of meta.rowGroups) {
    if (rowGroup.columns.length !== totalLeaves) {
      throw new ParquetError(`row group has ${rowGroup.columns.length} leaf columns, schema has ${totalLeaves}`);
    }
    const numRows = Number(rowGroup.numRows);
    // Read every leaf column's stream, then assemble per top node.
    const allDescriptors = nodes.flatMap((n) => collectLeaves(n));
    const leafStreams = allDescriptors.map((descriptor, li) => {
      const chunk = rowGroup.columns[li]!;
      if (chunk.metaData === undefined) throw new ParquetError(`column chunk ${li} has no metadata`);
      return readLeafStream(bytes, descriptor, chunk.metaData);
    });
    let li = 0;
    const columnVectors: Vector[] = nodes.map((node, i) => {
      const n = nodeLeafCounts[i]!;
      const streams = leafStreams.slice(li, li + n);
      li += n;
      return assembleTree(node, streams, numRows);
    });
    batches.push(new RecordBatch(schema, columnVectors));
  }
  if (batches.length === 0) {
    const empty = nodes.map((node) => assembleTree(node, collectLeaves(node).map((d) => ({
      descriptor: d,
      values: [],
      defLevels: [],
      repLevels: []
    })), 0));
    return new Table(schema, [new RecordBatch(schema, empty)]);
  }
  return new Table(schema, batches);
}
// Read one leaf column into a full (values, defLevels, repLevels) stream across
// all its pages, synthesizing zero levels where a level is absent.
function readLeafStream(bytes: Uint8Array, descriptor: ColumnDescriptor, meta: ColumnMetaData): LeafStream {
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
    repLevels
  };
}
