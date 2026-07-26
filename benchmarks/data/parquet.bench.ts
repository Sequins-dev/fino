/**
 * Benchmarks for fino:data/parquet (write + read).
 */
import { writeParquet, readParquet } from 'fino:data/parquet';
import * as arrow from 'fino:data/arrow';
import { bench } from 'fino:bench';
const N = 1e5;
const table = new arrow.Table(
  arrow.Schema.from({
    id: arrow.int32(),
    value: arrow.float64(),
    label: arrow.utf8(),
  }),
  [
    new arrow.RecordBatch(
      arrow.Schema.from({
        id: arrow.int32(),
        value: arrow.float64(),
        label: arrow.utf8(),
      }),
      [
        arrow.vectorFromArray(
          Array.from({ length: N }, (_, i) => i),
          arrow.int32(),
        ),
        arrow.vectorFromArray(
          Array.from({ length: N }, (_, i) => i * 1.5),
          arrow.float64(),
        ),
        arrow.vectorFromArray(
          Array.from({ length: N }, (_, i) => `item-${i % 100}`),
          arrow.utf8(),
        ),
      ],
    ),
  ],
);
const PLAIN_SNAPPY = writeParquet(table, { compression: 'snappy' });
const DICT_ZSTD = writeParquet(table, {
  compression: 'zstd',
  dictionary: true,
});
bench('write', (b) => {
  b.measure('plain + snappy (100K x 3 cols)', () => writeParquet(table, { compression: 'snappy' }));
  b.measure('dictionary + zstd (100K x 3 cols)', () =>
    writeParquet(table, {
      compression: 'zstd',
      dictionary: true,
    }),
  );
  b.measure('uncompressed (100K x 3 cols)', () =>
    writeParquet(table, { compression: 'uncompressed' }),
  );
});
bench('read', (b) => {
  b.measure('plain + snappy (100K x 3 cols)', () => readParquet(PLAIN_SNAPPY));
  b.measure('dictionary + zstd (100K x 3 cols)', () => readParquet(DICT_ZSTD));
});
