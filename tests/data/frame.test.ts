import { describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Field, RecordBatch, Schema, Table, float64, utf8 } from 'fino:data/arrow';
import { IterableDataset } from 'fino:data/dataset';
import { readParquet } from 'fino:data/parquet';
import { readFileMetaData } from 'internal:data/parquet/metadata';
import { DataFrame, col, count, lit, type Expr } from 'fino:data/frame';

type Sale = {
  id: number;
  region: string | null;
  amount: number | null;
  units: number;
};

function salesFrame(): DataFrame<Sale> {
  return DataFrame.from<Sale>(
    RecordBatch.from({
      id: [1, 2, 3, 4, 5],
      region: ['east', 'west', 'east', null, 'west'],
      amount: [10, 20, null, 40, 15],
      units: [1, 2, 3, 1, 2],
    }),
  );
}

describe('DataFrame expressions and projection', () => {
  it('builds immutable lazy plans with typed frame columns', async (t) => {
    const source = salesFrame();
    const amount: Expr<number | null> = source.col('amount');
    const plan = source
      .filter(amount.gte(15))
      .withColumns({
        gross: amount.mul(source.col('units')),
        tagged: source.col('region').eq('west').and(source.col('amount').isNotNull()),
      })
      .select({
        id: source.col('id'),
        gross: col<number | null>('gross'),
        label: source.col('region'),
        constant: lit('sale'),
      });

    t.equal(source.explain(), 'ArrowScan', 'operators do not mutate the source frame');
    t.deepEqual((await plan.collect()).toArray(), [
      { id: 2, gross: 40, label: 'west', constant: 'sale' },
      { id: 4, gross: 40, label: null, constant: 'sale' },
      { id: 5, gross: 30, label: 'west', constant: 'sale' },
    ]);
    t.match(plan.explain(), /Filter.*WithColumns.*Project/s);
  });

  it('uses three-valued null semantics and offers key-preserving selection', async (t) => {
    const source = salesFrame();

    t.deepEqual(
      (await source.filter(source.col('amount').eq(null)).collect()).toArray(),
      [],
      'comparison with null produces null and filter retains only true',
    );
    t.deepEqual(
      (
        await source.filter(source.col('amount').isNull()).select('id', 'amount').collect()
      ).toArray(),
      [{ id: 3, amount: null }],
    );

    const replaced = await source
      .withColumns({
        amount: source.col('amount').mul(2),
      })
      .collect();
    t.deepEqual(
      replaced.schema.fields.map((field) => field.name),
      ['id', 'region', 'amount', 'units'],
      'replacing a column preserves its position',
    );
  });
});

describe('DataFrame aggregation, join, sort, and limit', () => {
  it('aggregates globally and by key while ignoring null inputs', async (t) => {
    const source = salesFrame();
    const grouped = source.groupBy('region').agg({
      rows: count(),
      present: source.col('amount').count(),
      total: source.col('amount').sum(),
      average: source.col('amount').mean(),
      smallest: source.col('amount').min(),
      largest: source.col('amount').max(),
    });

    t.deepEqual(
      (await grouped.sort(grouped.col('region').asc({ nulls: 'last' })).collect()).toArray(),
      [
        {
          region: 'east',
          rows: 2,
          present: 1,
          total: 10,
          average: 10,
          smallest: 10,
          largest: 10,
        },
        {
          region: 'west',
          rows: 2,
          present: 2,
          total: 35,
          average: 17.5,
          smallest: 15,
          largest: 20,
        },
        {
          region: null,
          rows: 1,
          present: 1,
          total: 40,
          average: 40,
          smallest: 40,
          largest: 40,
        },
      ],
    );

    t.deepEqual(
      (
        await source
          .aggregate({
            rows: count(),
            total: source.col('amount').sum(),
          })
          .collect()
      ).toArray(),
      [{ rows: 5, total: 85 }],
    );
  });

  it('joins without overwriting collisions and implements outer row semantics', async (t) => {
    const left = DataFrame.from<{ id: number; label: string }>(
      RecordBatch.from({ id: [1, 2, 3], label: ['one', 'two', 'three'] }),
    );
    const right = DataFrame.from<{ id: number; label: string; score: number }>(
      RecordBatch.from({ id: [2, 3, 4], label: ['dos', 'tres', 'cuatro'], score: [20, 30, 40] }),
    );

    t.deepEqual(
      (await left.join(right, { on: 'id', how: 'left', suffix: '_right' }).collect()).toArray(),
      [
        { id: 1, label: 'one', label_right: null, score: null },
        { id: 2, label: 'two', label_right: 'dos', score: 20 },
        { id: 3, label: 'three', label_right: 'tres', score: 30 },
      ],
    );
    t.deepEqual(
      (await left.join(right, { on: 'id', how: 'full', suffix: '_right' }).collect()).toArray(),
      [
        { id: 1, label: 'one', label_right: null, score: null },
        { id: 2, label: 'two', label_right: 'dos', score: 20 },
        { id: 3, label: 'three', label_right: 'tres', score: 30 },
        { id: 4, label: null, label_right: 'cuatro', score: 40 },
      ],
    );
  });

  it('sorts stably with explicit null placement and limits without reading ahead', async (t) => {
    const sortable = DataFrame.from<{ id: number | null; value: string }>(
      RecordBatch.from({
        id: [2, null, 1, 2],
        value: ['first-two', 'null', 'one', 'second-two'],
      }),
    );
    t.deepEqual(
      (await sortable.sort(sortable.col('id').asc({ nulls: 'last' })).collect()).toArray(),
      [
        { id: 1, value: 'one' },
        { id: 2, value: 'first-two' },
        { id: 2, value: 'second-two' },
        { id: null, value: 'null' },
      ],
      'equal keys retain their source order',
    );

    let reads = 0;
    const schema = Schema.from({ id: float64(), value: utf8() });
    const source = new IterableDataset<RecordBatch>(async function* () {
      for (const values of [
        { id: [1, 2], value: ['a', 'b'] },
        { id: [3, 4], value: ['c', 'd'] },
      ]) {
        reads++;
        yield RecordBatch.from(values);
      }
    });
    const frame = DataFrame.from<{ id: number; value: string }>(source, { schema });
    const result = await frame.limit(1).collect();

    t.deepEqual(result.toArray(), [{ id: 1, value: 'a' }]);
    t.equal(reads, 1);
  });
});

describe('DataFrame Parquet scans', () => {
  const fs = new DiskFileSystem();

  async function fixture(name: string): Promise<Uint8Array> {
    const file = await fs.open(`tests/fixtures/parquet/${name}`, 'r');
    const bytes = await file.bytes();
    await file.close();
    return bytes;
  }

  function metadata(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const footerLength = view.getUint32(bytes.byteLength - 8, true);
    return readFileMetaData(
      bytes.subarray(bytes.byteLength - 8 - footerLength, bytes.byteLength - 8),
    );
  }

  function corruptChunk(bytes: Uint8Array, rowGroup: number, column: string): Uint8Array {
    const copy = bytes.slice();
    const group = metadata(copy).rowGroups[rowGroup]!;
    const chunk = group.columns.find(
      (candidate) => candidate.metaData?.pathInSchema[0] === column,
    )!.metaData!;
    const offset = Number(chunk.dictionaryPageOffset ?? chunk.dataPageOffset);
    copy.fill(0xff, offset, Math.min(offset + 32, copy.byteLength - 8));
    return copy;
  }

  it('projects columns and row groups in the Parquet reader', async (t) => {
    const bytes = await fixture('row-groups.parquet');
    const table = readParquet(bytes, { columns: ['value'], rowGroups: [2] });

    t.equal(table.batches.length, 1);
    t.deepEqual(table.toArray(), [{ value: 8 }, { value: 9 }]);
  });

  it('does not decode projected-away columns', async (t) => {
    const corrupt = corruptChunk(await fixture('primitives.parquet'), 0, 's');

    t.throws(() => readParquet(corrupt), /parquet|page|thrift|unknown/i);
    t.deepEqual(
      readParquet(corrupt, { columns: ['i32'] })
        .getChild('i32')!
        .toArray(),
      [1, 2, 3, null],
    );
  });

  it('pushes simple projections and predicates into a Parquet scan', async (t) => {
    let bytes = await fixture('row-groups.parquet');
    bytes = corruptChunk(bytes, 0, 'value');
    bytes = corruptChunk(bytes, 1, 'value');
    const frame = DataFrame.scanParquet<{ value: number }>(bytes)
      .filter(col<number>('value').gte(8))
      .select('value');

    t.deepEqual((await frame.collect()).toArray(), [{ value: 8 }, { value: 9 }]);
    t.match(frame.explain(), /ParquetScan.*columns=\[value\].*rowGroups=\[2\]/s);
  });
});
