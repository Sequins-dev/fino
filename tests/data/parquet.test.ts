/**
 * Round-trip tests for fino:data/parquet (write -> read).
 */
import { describe, it } from 'fino:test/test';
import { writeParquet, readParquet, ParquetError } from 'fino:data/parquet';
import * as arrow from 'fino:data/arrow';
import { Field } from 'fino:data/arrow';
import { zstdAvailable, snappyAvailable } from 'fino:compress';
import { readFileMetaData, readPageHeader, writePageHeader } from 'internal:data/parquet/metadata';
function roundTrip(
  batch: arrow.RecordBatch,
  compression?: 'uncompressed' | 'snappy' | 'gzip' | 'zstd' | 'brotli',
): arrow.Table {
  const bytes = writeParquet(
    batch,
    compression ? { compression } : { compression: 'uncompressed' },
  );
  // Validate the file envelope.
  const magic = [80, 65, 82, 49];
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== magic[i] || bytes[bytes.byteLength - 4 + i] !== magic[i])
      throw new Error('bad PAR1 magic');
  }
  return readParquet(bytes);
}
function mutateFirstPageDecodedSize(bytes: Uint8Array, delta: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLength = view.getUint32(bytes.byteLength - 8, true);
  const metadata = readFileMetaData(
    bytes.subarray(bytes.byteLength - 8 - footerLength, bytes.byteLength - 8),
  );
  const chunk = metadata.rowGroups[0]!.columns[0]!.metaData!;
  const offset = Number(chunk.dictionaryPageOffset ?? chunk.dataPageOffset);
  const { header, end } = readPageHeader(bytes, offset);
  const encoded = writePageHeader({
    ...header,
    uncompressedPageSize: header.uncompressedPageSize + delta,
  });
  if (encoded.byteLength !== end - offset) {
    throw new Error('mutated Parquet page header changed encoded length');
  }
  const mutated = bytes.slice();
  mutated.set(encoded, offset);
  return mutated;
}
describe('parquet round-trips by type', () => {
  const cases: Array<[string, arrow.DataType, unknown[]]> = [
    ['bool', arrow.bool(), [true, false, true, null, false]],
    ['int8', arrow.int8(), [1, -2, 127, null]],
    ['int16', arrow.int16(), [1, -3e3, null]],
    ['int32', arrow.int32(), [1, 2, -123456, null, 5]],
    ['int64', arrow.int64(), [1n, -2n, 9007199254740993n, null]],
    ['uint8', arrow.uint8(), [0, 200, 255]],
    ['uint32', arrow.uint32(), [1, 4e9]],
    ['uint64', arrow.uint64(), [1n, 18000000000000000000n]],
    ['float32', arrow.float32(), [1.5, -2.5, null]],
    ['float64', arrow.float64(), [1.5, 2.25, 3.125, null]],
    ['utf8', arrow.utf8(), ['a', 'grüße', '', null]],
    ['binary', arrow.binary(), [new Uint8Array([1, 2, 3]), new Uint8Array([]), null]],
    ['date32', arrow.date32(), [0, 19e3, null]],
    [
      'timestamp',
      arrow.timestamp(arrow.TimeUnit.MICROSECOND, 'UTC'),
      [0n, 1700000000000000n, null],
    ],
  ];
  for (const [name, type, values] of cases) {
    it(`round-trips ${name}`, (t) => {
      const batch = new arrow.RecordBatch(arrow.Schema.from({ c: type }), [
        arrow.vectorFromArray(values, type),
      ]);
      const table = roundTrip(batch);
      const out = table.getChild('c')!.toArray();
      if (name === 'binary') {
        t.deepEqual(
          out.map((v) => (v === null ? null : Array.from(v as Uint8Array))),
          values.map((v) => (v === null ? null : Array.from(v as Uint8Array))),
          `${name} values`,
        );
      } else {
        t.deepEqual(out, values, `${name} values`);
      }
    });
  }
});
describe('parquet edge cases', () => {
  it('round-trips a required (non-null) column', (t) => {
    const type = arrow.int32();
    const values = [1, 2, 3, 4, 5];
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('c', type, false)]), [
      arrow.vectorFromArray(values, type),
    ]);
    const table = roundTrip(batch);
    t.equal(table.schema.fields[0]!.nullable, false, 'stays required');
    t.deepEqual(table.getChild('c')!.toArray(), values, 'required values');
  });
  it('round-trips an all-null column', (t) => {
    const values = [null, null, null];
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [
      arrow.vectorFromArray(values, arrow.int32()),
    ]);
    t.deepEqual(roundTrip(batch).getChild('c')!.toArray(), values, 'all nulls');
  });
  it('round-trips an empty column', (t) => {
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [
      arrow.vectorFromArray([], arrow.int32()),
    ]);
    const table = roundTrip(batch);
    t.equal(table.numRows, 0, 'no rows');
  });
  it('round-trips a 1000-row column', (t) => {
    const values = Array.from({ length: 1e3 }, (_, i) => i);
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [
      arrow.vectorFromArray(values, arrow.int32()),
    ]);
    t.deepEqual(roundTrip(batch).getChild('c')!.toArray(), values, '1000 values');
  });
  it('round-trips a multi-column batch', (t) => {
    const batch = arrow.RecordBatch.from({
      id: [1, 2, 3],
      name: ['x', 'y', 'z'],
      flag: [true, false, true],
    });
    const table = roundTrip(batch);
    t.deepEqual(
      table.toArray(),
      [
        {
          id: 1,
          name: 'x',
          flag: true,
        },
        {
          id: 2,
          name: 'y',
          flag: false,
        },
        {
          id: 3,
          name: 'z',
          flag: true,
        },
      ],
      'rows',
    );
  });
  it('preserves row count in the footer', (t) => {
    const batch = arrow.RecordBatch.from({ a: [1, 2, 3, 4] });
    t.equal(roundTrip(batch).numRows, 4, 'num_rows');
  });
});
describe('parquet compression codecs', () => {
  const values = Array.from({ length: 500 }, (_, i) => i % 20);
  for (const codec of ['uncompressed', 'gzip', 'snappy', 'zstd', 'brotli'] as const) {
    it(`round-trips with ${codec}`, (t) => {
      const available =
        codec === 'zstd' ? zstdAvailable : codec === 'snappy' ? snappyAvailable : true;
      if (!available) {
        t.ok(true, `${codec} backend not available; skipped`);
        return;
      }
      const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [
        arrow.vectorFromArray(values, arrow.int32()),
      ]);
      t.deepEqual(roundTrip(batch, codec).getChild('c')!.toArray(), values, `${codec} values`);
    });
  }
  it('enforces the decoded size declared by compressed v1 page headers', (t) => {
    const values = Array.from({ length: 500 }, (_, i) => i % 20);
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [
      arrow.vectorFromArray(values, arrow.int32()),
    ]);
    const bytes = writeParquet(batch, {
      compression: 'gzip',
      dictionary: false,
    });
    t.throws(
      () => readParquet(mutateFirstPageDecodedSize(bytes, -1)),
      ParquetError,
      'compressed page output cannot grow past its declared size',
    );
  });
  it('enforces decoded sizes for uncompressed and v2 pages', (t) => {
    const values = Array.from({ length: 500 }, (_, i) => i % 20);
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: arrow.int32() }), [
      arrow.vectorFromArray(values, arrow.int32()),
    ]);
    for (const [name, options] of [
      [
        'uncompressed v1',
        {
          compression: 'uncompressed',
          dictionary: false,
        },
      ],
      [
        'compressed v2',
        {
          compression: 'gzip',
          dictionary: false,
          pageVersion: 2,
        },
      ],
    ] as const) {
      const bytes = writeParquet(batch, options);
      t.throws(
        () => readParquet(mutateFirstPageDecodedSize(bytes, 1)),
        ParquetError,
        `${name} requires the declared decoded size`,
      );
    }
  });
});
describe('parquet dictionary encoding', () => {
  function roundTripDict(batch: arrow.RecordBatch): arrow.Table {
    return readParquet(
      writeParquet(batch, {
        compression: 'uncompressed',
        dictionary: true,
      }),
    );
  }
  it('round-trips a low-cardinality utf8 column via a dictionary page', (t) => {
    const values = ['red', 'green', 'red', 'blue', 'green', 'red', null];
    const batch = new arrow.RecordBatch(arrow.Schema.from({ color: arrow.utf8() }), [
      arrow.vectorFromArray(values, arrow.utf8()),
    ]);
    t.deepEqual(
      roundTripDict(batch).getChild('color')!.toArray(),
      values,
      'dictionary utf8 values',
    );
  });
  it('round-trips a dictionary-encoded int column', (t) => {
    const values = Array.from({ length: 300 }, (_, i) => (i % 5) * 10);
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('n', arrow.int32(), false)]), [
      arrow.vectorFromArray(values, arrow.int32()),
    ]);
    t.deepEqual(roundTripDict(batch).getChild('n')!.toArray(), values, 'dictionary int values');
  });
  it('round-trips a single-distinct-value dictionary (bit width 0)', (t) => {
    const values = [7, 7, 7, 7];
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('n', arrow.int32(), false)]), [
      arrow.vectorFromArray(values, arrow.int32()),
    ]);
    t.deepEqual(roundTripDict(batch).getChild('n')!.toArray(), values, 'single-value dictionary');
  });
  it('round-trips dictionary + zstd compression', (t) => {
    if (!zstdAvailable) {
      t.ok(true, 'zstd unavailable');
      return;
    }
    const values = Array.from({ length: 200 }, (_, i) => `item-${i % 8}`);
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('s', arrow.utf8(), false)]), [
      arrow.vectorFromArray(values, arrow.utf8()),
    ]);
    const table = readParquet(
      writeParquet(batch, {
        compression: 'zstd',
        dictionary: true,
      }),
    );
    t.deepEqual(table.getChild('s')!.toArray(), values, 'compressed dictionary values');
  });
});
describe('parquet extended types', () => {
  function rt(type: arrow.DataType, values: unknown[], nullable = true): unknown[] {
    const schema = nullable
      ? arrow.Schema.from({ c: type })
      : new arrow.Schema([new Field('c', type, false)]);
    const batch = new arrow.RecordBatch(schema, [arrow.vectorFromArray(values, type)]);
    return readParquet(writeParquet(batch, { compression: 'uncompressed' }))
      .getChild('c')!
      .toArray();
  }
  it('round-trips fixedSizeBinary', (t) => {
    const type = arrow.fixedSizeBinary(4);
    const values = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8]), null];
    const out = rt(type, values) as (Uint8Array | null)[];
    t.deepEqual(
      out.map((v) => (v === null ? null : Array.from(v))),
      values.map((v) => (v === null ? null : Array.from(v as Uint8Array))),
      'FLBA',
    );
  });
  it('round-trips float16', (t) => {
    const out = rt(arrow.float16(), [1, .5, 2, null]) as (number | null)[];
    t.deepEqual(out, [1, .5, 2, null], 'float16');
  });
  it('round-trips decimal128 (FLBA-backed)', (t) => {
    const type = arrow.decimal(20, 4, 128);
    const values = [12345n, -67890n, 0n, null];
    t.deepEqual(rt(type, values), values, 'decimal128');
  });
  it('round-trips decimal32 (INT32-backed)', (t) => {
    const type = arrow.decimal(9, 2, 32);
    const values = [100n, -250n, 999999n];
    t.deepEqual(rt(type, values, false), values, 'decimal32');
  });
  it('round-trips decimal64 (INT64-backed)', (t) => {
    const type = arrow.decimal(18, 3, 64);
    const values = [1000n, -2000n, 123456789012n];
    t.deepEqual(rt(type, values, false), values, 'decimal64');
  });
  it('round-trips time32 and time64', (t) => {
    t.deepEqual(
      rt(arrow.time32(arrow.TimeUnit.MILLISECOND), [0, 36e5, null]),
      [0, 36e5, null],
      'time32',
    );
    t.deepEqual(
      rt(arrow.time64(arrow.TimeUnit.MICROSECOND), [0n, 3600000000n, null]),
      [0n, 3600000000n, null],
      'time64',
    );
  });
  it('round-trips timestamp units', (t) => {
    t.deepEqual(
      rt(arrow.timestamp(arrow.TimeUnit.MILLISECOND, 'UTC'), [0n, 1700000000000n, null]),
      [0n, 1700000000000n, null],
      'ts millis',
    );
    t.deepEqual(
      rt(arrow.timestamp(arrow.TimeUnit.NANOSECOND, null), [0n, 1700000000000000000n, null]),
      [0n, 1700000000000000000n, null],
      'ts nanos',
    );
  });
});
describe('parquet value encodings', () => {
  function rt(
    type: arrow.DataType,
    values: unknown[],
    encoding: 'delta' | 'byte-stream-split' | 'rle',
  ): unknown[] {
    const batch = new arrow.RecordBatch(new arrow.Schema([new Field('c', type, false)]), [
      arrow.vectorFromArray(values, type),
    ]);
    return readParquet(
      writeParquet(batch, {
        compression: 'uncompressed',
        encoding,
      }),
    )
      .getChild('c')!
      .toArray();
  }
  it('round-trips DELTA_BINARY_PACKED int32', (t) => {
    const values = Array.from({ length: 500 }, (_, i) => i * 3 - 700);
    t.deepEqual(rt(arrow.int32(), values, 'delta'), values, 'delta int32');
  });
  it('round-trips DELTA_BINARY_PACKED int64', (t) => {
    const values = Array.from({ length: 300 }, (_, i) => BigInt(i) * 1000000000n - 5n);
    t.deepEqual(rt(arrow.int64(), values, 'delta'), values, 'delta int64');
  });
  it('round-trips DELTA_BYTE_ARRAY utf8', (t) => {
    const values = ['apple', 'apricot', 'apricots', 'banana', 'band', 'bandana'];
    t.deepEqual(rt(arrow.utf8(), values, 'delta'), values, 'delta byte array');
  });
  it('round-trips BYTE_STREAM_SPLIT float/double', (t) => {
    const f = Array.from({ length: 100 }, (_, i) => i * 1.25);
    t.deepEqual(rt(arrow.float64(), f, 'byte-stream-split'), f, 'bss double');
    const g = [1.5, 2.5, 3.5, 4.5];
    t.deepEqual(
      (rt(arrow.float32(), g, 'byte-stream-split') as number[]).map((x) => Math.round(x * 10) / 10),
      g,
      'bss float',
    );
  });
  it('round-trips RLE boolean', (t) => {
    const values = [true, true, true, false, false, true, false, false, false, false];
    t.deepEqual(rt(arrow.bool(), values, 'rle'), values, 'rle bool');
  });
});
describe('parquet DATA_PAGE_V2', () => {
  function rtV2(
    type: arrow.DataType,
    values: unknown[],
    opts: {
      encoding?: 'plain' | 'delta';
      compression?: 'uncompressed' | 'zstd';
    } = {},
  ): unknown[] {
    const batch = new arrow.RecordBatch(arrow.Schema.from({ c: type }), [
      arrow.vectorFromArray(values, type),
    ]);
    return readParquet(
      writeParquet(batch, {
        pageVersion: 2,
        compression: opts.compression ?? 'uncompressed',
        encoding: opts.encoding,
      }),
    )
      .getChild('c')!
      .toArray();
  }
  it('round-trips v2 pages with nulls', (t) => {
    const values = [1, 2, null, 4, null, 6];
    t.deepEqual(rtV2(arrow.int32(), values), values, 'v2 int32 with nulls');
  });
  it('round-trips v2 + zstd compression', (t) => {
    if (!zstdAvailable) {
      t.ok(true, 'zstd unavailable');
      return;
    }
    const values = Array.from({ length: 500 }, (_, i) => `s${i % 30}`);
    t.deepEqual(
      rtV2(arrow.utf8(), values, { compression: 'zstd' }),
      values,
      'v2 compressed strings',
    );
  });
  it('round-trips v2 + delta encoding', (t) => {
    const values = Array.from({ length: 200 }, (_, i) => BigInt(i * 7 - 300));
    t.deepEqual(rtV2(arrow.int64(), values, { encoding: 'delta' }), values, 'v2 delta int64');
  });
});
describe('parquet nested columns', () => {
  function rt(field: Field, values: unknown[]): unknown[] {
    const batch = new arrow.RecordBatch(new arrow.Schema([field]), [
      arrow.vectorFromArray(values, field.type),
    ]);
    return readParquet(writeParquet(batch, { compression: 'uncompressed' }))
      .getChild(field.name)!
      .toArray();
  }
  it('round-trips list<int32>', (t) => {
    const field = new Field('l', arrow.list(new Field('item', arrow.int32(), true)), true);
    const values = [[1, 2], [], [3, 4, 5], null, [6]];
    t.deepEqual(rt(field, values), values, 'list values incl empty + null');
  });
  it('round-trips list<utf8> with null elements', (t) => {
    const field = new Field('l', arrow.list(new Field('item', arrow.utf8(), true)), true);
    const values = [['a', null, 'c'], [], ['d']];
    t.deepEqual(rt(field, values), values, 'list of nullable strings');
  });
  it('round-trips struct{a:int32,b:utf8}', (t) => {
    const field = new Field(
      's',
      arrow.struct([new Field('a', arrow.int32(), true), new Field('b', arrow.utf8(), true)]),
      true,
    );
    const values = [
      {
        a: 1,
        b: 'x',
      },
      {
        a: 2,
        b: 'y',
      },
      null,
      {
        a: 4,
        b: null,
      },
    ];
    t.deepEqual(rt(field, values), values, 'struct with nulls');
  });
  it('round-trips list<struct>', (t) => {
    const struct = arrow.struct([
      new Field('k', arrow.int32(), true),
      new Field('v', arrow.utf8(), true),
    ]);
    const field = new Field('ls', arrow.list(new Field('item', struct, true)), true);
    const values = [
      [
        {
          k: 1,
          v: 'a',
        },
        {
          k: 2,
          v: 'b',
        },
      ],
      [],
      [
        {
          k: 3,
          v: 'c',
        },
      ],
    ];
    t.deepEqual(rt(field, values), values, 'list of structs');
  });
  it('round-trips struct{list}', (t) => {
    const inner = arrow.list(new Field('item', arrow.int32(), true));
    const field = new Field(
      'sl',
      arrow.struct([new Field('nums', inner, true), new Field('name', arrow.utf8(), true)]),
      true,
    );
    const values = [
      {
        nums: [1, 2, 3],
        name: 'a',
      },
      {
        nums: [],
        name: 'b',
      },
      {
        nums: null,
        name: 'c',
      },
    ];
    t.deepEqual(rt(field, values), values, 'struct containing a list');
  });
  it('round-trips list<list<int32>>', (t) => {
    const inner = new Field('item', arrow.list(new Field('item', arrow.int32(), true)), true);
    const field = new Field('ll', arrow.list(inner), true);
    const values = [[[1, 2], [3]], [], [[4, 5, 6]], [[]]];
    t.deepEqual(rt(field, values), values, 'nested lists');
  });
  it('round-trips map<utf8,int32>', (t) => {
    const entries = new Field(
      'entries',
      arrow.struct([
        new Field('key', arrow.utf8(), false),
        new Field('value', arrow.int32(), true),
      ]),
      false,
    );
    const field = new Field('m', arrow.map(entries), true);
    const values = [
      [
        ['a', 1],
        ['b', 2],
      ],
      [],
      [['c', 3]],
      null,
    ];
    t.deepEqual(rt(field, values), values, 'map entries');
  });
  it('round-trips list<utf8> with dictionary + v2 pages', (t) => {
    const field = new Field('l', arrow.list(new Field('item', arrow.utf8(), true)), true);
    const values = [['a', 'b', 'a'], [], ['b', 'b'], null, ['a']];
    const batch = new arrow.RecordBatch(new arrow.Schema([field]), [
      arrow.vectorFromArray(values, field.type),
    ]);
    const dict = readParquet(
      writeParquet(batch, {
        compression: 'gzip',
        dictionary: true,
      }),
    );
    t.deepEqual(dict.getChild('l')!.toArray(), values, 'nested dictionary');
    const v2 = readParquet(
      writeParquet(batch, {
        compression: 'uncompressed',
        pageVersion: 2,
      }),
    );
    t.deepEqual(v2.getChild('l')!.toArray(), values, 'nested v2');
  });
});
describe('parquet errors', () => {
  it('rejects non-Parquet input', (t) => {
    t.throws(
      () => readParquet(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])),
      ParquetError,
      'bad magic',
    );
  });
});
