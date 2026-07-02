/**
* Parquet reader: Parquet file bytes → Arrow.
*
* Reads flat columns from DATA_PAGE v1/v2 pages with PLAIN, dictionary, RLE,
* delta, and byte-stream-split encodings, definition levels for nulls, and page
* compression. Row groups are concatenated into one Arrow `Table`. Nested
* columns are handled by `nested.ts`.
*
* @internal
*/
import { RecordBatch, Table, Vector, vectorFromArray } from 'fino:data/arrow';
import { ParquetError } from './types.ts';
import { parquetSchemaToArrow, type ColumnDescriptor } from './schema.ts';
import { readFileMetaData, type ColumnMetaData } from './metadata.ts';
import { readColumnPages } from './column-reader.ts';
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
  const { schema, columns } = parquetSchemaToArrow(meta.schema);
  const batches: RecordBatch[] = [];
  for (const rowGroup of meta.rowGroups) {
    if (rowGroup.columns.length !== columns.length) {
      throw new ParquetError(`row group has ${rowGroup.columns.length} columns, schema has ${columns.length}`);
    }
    const columnVectors = columns.map((descriptor, c) => {
      const chunk = rowGroup.columns[c]!;
      if (chunk.metaData === undefined) throw new ParquetError(`column chunk ${c} has no metadata`);
      const rows = readFlatColumn(bytes, descriptor, chunk.metaData);
      return buildVector(descriptor, rows);
    });
    batches.push(new RecordBatch(schema, columnVectors));
  }
  if (batches.length === 0) {
    return new Table(schema, [new RecordBatch(schema, columns.map((d) => buildVector(d, [])))]);
  }
  return new Table(schema, batches);
}
// Read a flat column into a nullable JS value array, applying the descriptor's
// physical→Arrow value converter.
function readFlatColumn(bytes: Uint8Array, descriptor: ColumnDescriptor, meta: ColumnMetaData): unknown[] {
  const rows: unknown[] = [];
  readColumnPages(bytes, descriptor, meta, (page) => {
    if (page.defLevels === null) {
      for (const v of page.values) rows.push(descriptor.decode(v));
    } else {
      let vi = 0;
      for (let i = 0; i < page.numValues; i++) {
        rows.push(page.defLevels[i] === descriptor.maxDefinitionLevel ? descriptor.decode(page.values[vi++]) : null);
      }
    }
  });
  return rows;
}
function buildVector(descriptor: ColumnDescriptor, rows: unknown[]): Vector {
  return vectorFromArray(rows, descriptor.arrowField.type);
}
