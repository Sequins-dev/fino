/**
* Round-trip tests for fino:data/parquet (write -> read).
*/
import { describe, it } from 'fino:test/test';
import { writeParquet, readParquet, ParquetError } from 'fino:data/parquet';
import * as arrow from 'fino:data/arrow';
import { Field } from 'fino:data/arrow';
import { zstdAvailable, snappyAvailable } from 'fino:compress';
function roundTrip(batch: arrow.RecordBatch, compression?: 'uncompressed' | 'snappy' | 'gzip' | 'zstd' | 'brotli'): arrow.Table {
  const bytes = writeParquet(batch, compression ? { compression } : { compression: 'uncompressed' });
  // Validate the file envelope.
  const magic = [
    80,
    65,
    82,
    49
  ];
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== magic[i] || bytes[bytes.byteLength - 4 + i] !== magic[i]) throw new Error('bad PAR1 magic');
  }
  return readParquet(bytes);
}
describe('parquet round-trips by type', () => {
  const cases: Array<[string, arrow.DataType, unknown[]]> = [
    [
      'bool',
      arrow.bool(),
      [
        true,
        false,
        true,
        null,
        false
      ]
    ],
    [
      'int8',
      arrow.int8(),
      [
        1,
        -2,
        127,
        null
      ]
    ],
    [
      'int16',
      arrow.int16(),
      [
        1,
        -3e3,
        null
      ]
    ],
    [
      'int32',
      arrow.int32(),
      [
        1,
        2,
        -123456,
        null,
        5
      ]
    ],
    [
      'int64',
      arrow.int64(),
      [
        1n,
        -2n,
        9007199254740993n,
        null
      ]
    ],
    [
      'uint8',
      arrow.uint8(),
      [
        0,
        200,
        255
      ]
    ],
    [
      'uint32',
      arrow.uint32(),
      [1, 4e9]
    ],
    [
      'uint64',
      arrow.uint64(),
      [1n, 18000000000000000000n]
    ],
    [
      'float32',
      arrow.float32(),
      [
        1.5,
        -2.5,
        null
      ]
    ],
    [
      'float64',
      arrow.float64(),
      [
        1.5,
        2.25,
        3.125,
        null
      ]
    ],
    [
      'utf8',
      arrow.utf8(),
      [
        'a',
        'grüße',
        '',
        null
      ]
    ],
    [
      'binary',
      arrow.binary(),
      [
        new Uint8Array([
          1,
          2,
          3
        ]),
        new Uint8Array([]),
        null
      ]
    ],
    [
      'date32',
      arrow.date32(),
      [
        0,
        19e3,
        null
      ]
    ],
    [
      'timestamp',
      arrow.timestamp(arrow.TimeUnit.MICROSECOND, 'UTC'),
      [
        0n,
        1700000000000000n,
        null
      ]
    ]
  ];
  for (const [name, type, values] of cases) {
    it(`round-trips ${name}`, (t) => {
      const batch = new arrow.RecordBatch(arrow.Schema.from({ c: type }), [arrow.vectorFromArray(values, type)]);
      const table = roundTrip(batch);
      const out = table.getChild('c')!.toArray();
      if (name === 'binary') {
        t.deepEqual(out.map((v) => v === null ? null : Array.from(v as Uint8Array)), values.map((v) => v === null ? null : Array.from(v as Uint8Array)), `${name} values`);
      } else {
        t.deepEqual(out, values, `${name} values`);
      }
    });
  }
});
describe('parquet edge cases', () => {
  it('round-trips a required (non-null) column', (t) => {
    const type = arrow.int32();
    const values = [
      1,
      2,
      3,
      4,
      5
    ];
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('c', type, false)]), [arrow.vectorFromArray(values, type)]);
    const table = roundTrip(batch);
    t.equal(table.schema.fields[0]!.nullable, false, 'stays required');
    t.deepEqual(table.getChild('c')!.toArray(), values, 'required values');
  });
  it('round-trips an all-null column', (t) => {
    const values = [
      null,
      null,
      null
    ];
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [arrow.vectorFromArray(values, arrow.int32())]);
    t.deepEqual(roundTrip(batch).getChild('c')!.toArray(), values, 'all nulls');
  });
  it('round-trips an empty column', (t) => {
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [arrow.vectorFromArray([], arrow.int32())]);
    const table = roundTrip(batch);
    t.equal(table.numRows, 0, 'no rows');
  });
  it('round-trips a 1000-row column', (t) => {
    const values = Array.from({ length: 1e3 }, (_, i) => i);
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [arrow.vectorFromArray(values, arrow.int32())]);
    t.deepEqual(roundTrip(batch).getChild('c')!.toArray(), values, '1000 values');
  });
  it('round-trips a multi-column batch', (t) => {
    const batch = arrow.RecordBatch.from({
      id: [
        1,
        2,
        3
      ],
      name: [
        'x',
        'y',
        'z'
      ],
      flag: [
        true,
        false,
        true
      ]
    });
    const table = roundTrip(batch);
    t.deepEqual(table.toArray(), [
      {
        id: 1,
        name: 'x',
        flag: true
      },
      {
        id: 2,
        name: 'y',
        flag: false
      },
      {
        id: 3,
        name: 'z',
        flag: true
      }
    ], 'rows');
  });
  it('preserves row count in the footer', (t) => {
    const batch = arrow.RecordBatch.from({ a: [
      1,
      2,
      3,
      4
    ] });
    t.equal(roundTrip(batch).numRows, 4, 'num_rows');
  });
});
describe('parquet compression codecs', () => {
  const values = Array.from({ length: 500 }, (_, i) => i % 20);
  for (const codec of [
    'uncompressed',
    'gzip',
    'snappy',
    'zstd',
    'brotli'
  ] as const) {
    it(`round-trips with ${codec}`, (t) => {
      const available = codec === 'zstd' ? zstdAvailable : codec === 'snappy' ? snappyAvailable : true;
      if (!available) {
        t.ok(true, `${codec} backend not available; skipped`);
        return;
      }
      const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [arrow.vectorFromArray(values, arrow.int32())]);
      t.deepEqual(roundTrip(batch, codec).getChild('c')!.toArray(), values, `${codec} values`);
    });
  }
});
describe('parquet dictionary encoding', () => {
  function roundTripDict(batch: arrow.RecordBatch): arrow.Table {
    return readParquet(writeParquet(batch, {
      compression: 'uncompressed',
      dictionary: true
    }));
  }
  it('round-trips a low-cardinality utf8 column via a dictionary page', (t) => {
    const values = [
      'red',
      'green',
      'red',
      'blue',
      'green',
      'red',
      null
    ];
    const batch = new arrow.RecordBatch(arrow.Schema.from({ color: arrow.utf8() }), [arrow.vectorFromArray(values, arrow.utf8())]);
    t.deepEqual(roundTripDict(batch).getChild('color')!.toArray(), values, 'dictionary utf8 values');
  });
  it('round-trips a dictionary-encoded int column', (t) => {
    const values = Array.from({ length: 300 }, (_, i) => i % 5 * 10);
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('n', arrow.int32(), false)]), [arrow.vectorFromArray(values, arrow.int32())]);
    t.deepEqual(roundTripDict(batch).getChild('n')!.toArray(), values, 'dictionary int values');
  });
  it('round-trips a single-distinct-value dictionary (bit width 0)', (t) => {
    const values = [
      7,
      7,
      7,
      7
    ];
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('n', arrow.int32(), false)]), [arrow.vectorFromArray(values, arrow.int32())]);
    t.deepEqual(roundTripDict(batch).getChild('n')!.toArray(), values, 'single-value dictionary');
  });
  it('round-trips dictionary + zstd compression', (t) => {
    if (!zstdAvailable) {
      t.ok(true, 'zstd unavailable');
      return;
    }
    const values = Array.from({ length: 200 }, (_, i) => `item-${i % 8}`);
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('s', arrow.utf8(), false)]), [arrow.vectorFromArray(values, arrow.utf8())]);
    const table = readParquet(writeParquet(batch, {
      compression: 'zstd',
      dictionary: true
    }));
    t.deepEqual(table.getChild('s')!.toArray(), values, 'compressed dictionary values');
  });
});
describe('parquet errors', () => {
  it('rejects non-Parquet input', (t) => {
    t.throws(() => readParquet(new Uint8Array([
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12
    ])), ParquetError, 'bad magic');
  });
});
