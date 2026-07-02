/**
* IPC round-trip tests for fino:data/arrow.
*/
import { describe, it } from 'fino:test/test';
import * as arrow from 'fino:data/arrow';
import { Field } from 'fino:data/arrow';
import { zstdAvailable, lz4Available } from 'fino:compress';
function roundTrip(batch: arrow.RecordBatch, format?: 'stream' | 'file'): arrow.Table {
  const bytes = arrow.tableToIPC(batch, format ? { format } : undefined);
  return arrow.tableFromIPC(bytes);
}
describe('arrow IPC round-trips by type', () => {
  const cases: Array<[string, arrow.DataType, unknown[]]> = [
    [
      'int8',
      arrow.int8(),
      [
        1,
        -2,
        3,
        null
      ]
    ],
    [
      'uint8',
      arrow.uint8(),
      [
        1,
        2,
        255
      ]
    ],
    [
      'int16',
      arrow.int16(),
      [
        1,
        -300,
        null
      ]
    ],
    [
      'int32',
      arrow.int32(),
      [
        1,
        2,
        3,
        null,
        5
      ]
    ],
    [
      'uint32',
      arrow.uint32(),
      [1, 4e9]
    ],
    [
      'int64',
      arrow.int64(),
      [
        1n,
        -2n,
        9007199254740993n
      ]
    ],
    [
      'uint64',
      arrow.uint64(),
      [
        1n,
        2n,
        18000000000000000000n
      ]
    ],
    [
      'float16',
      arrow.float16(),
      [
        1,
        .5,
        2,
        null
      ]
    ],
    [
      'float32',
      arrow.float32(),
      [
        1.5,
        2.5,
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
      'largeutf8',
      arrow.largeUtf8(),
      [
        'x',
        'yy',
        'zzz'
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
    ],
    [
      'list<int32>',
      arrow.list(new Field('item', arrow.int32(), true)),
      [
        [1, 2],
        [],
        [
          3,
          4,
          5
        ],
        null
      ]
    ],
    [
      'struct',
      arrow.struct([new Field('a', arrow.int32(), true), new Field('b', arrow.utf8(), true)]),
      [
        {
          a: 1,
          b: 'x'
        },
        {
          a: 2,
          b: 'y'
        },
        null
      ]
    ]
  ];
  for (const [name, type, values] of cases) {
    it(`round-trips ${name} (stream)`, (t) => {
      const batch = new arrow.RecordBatch(arrow.Schema.from({ c: type }), [arrow.vectorFromArray(values, type)]);
      const table = roundTrip(batch);
      t.deepEqual(table.getChild('c')!.toArray(), values, `${name} values`);
    });
    it(`round-trips ${name} (file)`, (t) => {
      const batch = new arrow.RecordBatch(arrow.Schema.from({ c: type }), [arrow.vectorFromArray(values, type)]);
      const table = roundTrip(batch, 'file');
      t.deepEqual(table.getChild('c')!.toArray(), values, `${name} values`);
    });
  }
});
describe('arrow IPC edge cases', () => {
  it('round-trips an empty batch', (t) => {
    const batch = new arrow.RecordBatch(arrow.Schema.from({ x: arrow.int32() }), [arrow.vectorFromArray([], arrow.int32())]);
    const table = roundTrip(batch);
    t.equal(table.numRows, 0, 'no rows');
  });
  it('round-trips an all-null column', (t) => {
    const values = [
      null,
      null,
      null
    ];
    const batch = new arrow.RecordBatch(arrow.Schema.from({ x: arrow.int32() }), [arrow.vectorFromArray(values, arrow.int32())]);
    const table = roundTrip(batch);
    t.deepEqual(table.getChild('x')!.toArray(), values, 'all nulls');
  });
  it('round-trips a no-null column (omitted validity)', (t) => {
    const values = [
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
      12,
      13
    ];
    const batch = new arrow.RecordBatch(arrow.Schema.from({ x: arrow.int32() }), [arrow.vectorFromArray(values, arrow.int32())]);
    const table = roundTrip(batch);
    t.deepEqual(table.getChild('x')!.toArray(), values, 'odd-length no-null');
  });
  it('round-trips a 1000-row column', (t) => {
    const values = Array.from({ length: 1e3 }, (_, i) => i);
    const batch = new arrow.RecordBatch(arrow.Schema.from({ x: arrow.int32() }), [arrow.vectorFromArray(values, arrow.int32())]);
    const table = roundTrip(batch);
    t.deepEqual(table.getChild('x')!.toArray(), values, '1000 values');
  });
  it('round-trips a multi-column batch', (t) => {
    const batch = arrow.RecordBatch.from({
      id: [
        1,
        2,
        3
      ],
      name: [
        'a',
        'b',
        'c'
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
        name: 'a',
        flag: true
      },
      {
        id: 2,
        name: 'b',
        flag: false
      },
      {
        id: 3,
        name: 'c',
        flag: true
      }
    ], 'rows');
  });
  it('round-trips multiple batches via a table', (t) => {
    const b1 = arrow.RecordBatch.from({ x: [1, 2] });
    const b2 = arrow.RecordBatch.from({ x: [
      3,
      4,
      5
    ] });
    const bytes = arrow.tableToIPC(arrow.Table.from([b1, b2]));
    const table = arrow.tableFromIPC(bytes);
    t.equal(table.batches.length, 2, 'two batches preserved');
    t.deepEqual(table.getChild('x')!.toArray(), [
      1,
      2,
      3,
      4,
      5
    ], 'concatenated values');
  });
  it('round-trips a dictionary column', (t) => {
    const dictType = arrow.dictionary(0, arrow.int32(), arrow.utf8());
    const dictValues = arrow.vectorFromArray([
      'red',
      'green',
      'blue'
    ], arrow.utf8());
    const indices = new Uint8Array(new Int32Array([
      0,
      1,
      0,
      2,
      1
    ]).buffer);
    const col = arrow.makeVector({
      type: dictType,
      length: 5,
      values: indices,
      dictionary: dictValues
    });
    const batch = new arrow.RecordBatch(arrow.Schema.from({ color: dictType }), [col]);
    const table = roundTrip(batch);
    t.deepEqual(table.getChild('color')!.toArray(), [
      'red',
      'green',
      'red',
      'blue',
      'green'
    ], 'dictionary decoded after round-trip');
  });
  it('rejects legacy pre-0.15 framing', (t) => {
    // A metadata-length-first buffer (no 0xFFFFFFFF continuation).
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setInt32(0, 8, true);
    t.throws(() => arrow.tableFromIPC(bad), /continuation/, 'legacy framing rejected');
  });
});
describe('arrow IPC compression', () => {
  const bigValues = Array.from({ length: 2e3 }, (_, i) => i % 50);
  for (const codec of ['zstd', 'lz4'] as const) {
    const available = codec === 'zstd' ? zstdAvailable : lz4Available;
    it(`round-trips with ${codec} compression`, (t) => {
      if (!available) {
        t.ok(true, `${codec} not available; skipped`);
        return;
      }
      const batch = new arrow.RecordBatch(arrow.Schema.from({ x: arrow.int32() }), [arrow.vectorFromArray(bigValues, arrow.int32())]);
      const bytes = arrow.tableToIPC(batch, { compression: codec });
      const table = arrow.tableFromIPC(bytes);
      t.deepEqual(table.getChild('x')!.toArray(), bigValues, `${codec} values round-trip`);
    });
  }
});
