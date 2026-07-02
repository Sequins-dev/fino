/**
* Tests for the fino:data/arrow object model (types, vectors, batches, tables).
*/
import { describe, it } from 'fino:test/test';
import * as arrow from 'fino:data/arrow';
import { Field } from 'fino:data/arrow';
describe('arrow primitive vectors', () => {
  it('builds and reads int32', (t) => {
    const v = arrow.vectorFromArray([
      1,
      2,
      3,
      null,
      5
    ], arrow.int32());
    t.equal(v.length, 5, 'length');
    t.equal(v.nullCount, 1, 'null count');
    t.equal(v.get(0), 1, 'first');
    t.equal(v.get(3), null, 'null slot');
    t.deepEqual(v.toArray(), [
      1,
      2,
      3,
      null,
      5
    ], 'toArray');
  });
  it('reads int64 as bigint', (t) => {
    const v = arrow.vectorFromArray([
      1n,
      2n,
      9007199254740993n
    ], arrow.int64());
    t.equal(v.get(2), 9007199254740993n, 'preserves 64-bit precision');
  });
  it('builds and reads float64 and float16', (t) => {
    const f64 = arrow.vectorFromArray([
      1.5,
      2.25,
      null
    ], arrow.float64());
    t.equal(f64.get(1), 2.25, 'f64 value');
    const f16 = arrow.vectorFromArray([
      1,
      2,
      .5
    ], arrow.float16());
    t.equal(f16.get(2), .5, 'f16 value');
  });
  it('builds and reads bool with bit packing', (t) => {
    const v = arrow.vectorFromArray([
      true,
      false,
      true,
      true,
      null,
      false
    ], arrow.bool());
    t.deepEqual(v.toArray(), [
      true,
      false,
      true,
      true,
      null,
      false
    ], 'bools round-trip');
  });
  it('omits the validity buffer when there are no nulls', (t) => {
    const v = arrow.vectorFromArray([
      1,
      2,
      3
    ], arrow.int32());
    t.equal(v.validity, null, 'no validity bitmap');
    t.equal(v.nullCount, 0, 'no nulls');
  });
});
describe('arrow variable-width vectors', () => {
  it('builds and reads utf8', (t) => {
    const v = arrow.vectorFromArray([
      'alpha',
      '',
      'grüße',
      null
    ], arrow.utf8());
    t.deepEqual(v.toArray(), [
      'alpha',
      '',
      'grüße',
      null
    ], 'strings round-trip');
  });
  it('builds and reads large utf8', (t) => {
    const v = arrow.vectorFromArray([
      'a',
      'bb',
      'ccc'
    ], arrow.largeUtf8());
    t.deepEqual(v.toArray(), [
      'a',
      'bb',
      'ccc'
    ], 'large strings round-trip');
  });
  it('builds and reads binary', (t) => {
    const v = arrow.vectorFromArray([new Uint8Array([1, 2]), new Uint8Array([3])], arrow.binary());
    t.deepEqual(Array.from(v.get(0) as Uint8Array), [1, 2], 'first blob');
    t.deepEqual(Array.from(v.get(1) as Uint8Array), [3], 'second blob');
  });
});
describe('arrow nested vectors', () => {
  it('builds and reads list<int32>', (t) => {
    const v = arrow.vectorFromArray([
      [1, 2],
      [],
      [
        3,
        4,
        5
      ]
    ], arrow.list(new Field('item', arrow.int32(), true)));
    t.deepEqual(v.toArray(), [
      [1, 2],
      [],
      [
        3,
        4,
        5
      ]
    ], 'lists round-trip');
  });
  it('builds and reads struct', (t) => {
    const type = arrow.struct([new Field('x', arrow.int32(), true), new Field('y', arrow.utf8(), true)]);
    const v = arrow.vectorFromArray([{
      x: 1,
      y: 'a'
    }, {
      x: 2,
      y: 'b'
    }], type);
    t.deepEqual(v.toArray(), [{
      x: 1,
      y: 'a'
    }, {
      x: 2,
      y: 'b'
    }], 'structs round-trip');
  });
});
describe('arrow makeVector with raw buffers', () => {
  it('reads a dictionary vector', (t) => {
    // indices int8 [0,1,0,2], dictionary utf8 ['red','green','blue'].
    const dictType = arrow.dictionary(0, arrow.int8(), arrow.utf8());
    const dictValues = arrow.vectorFromArray([
      'red',
      'green',
      'blue'
    ], arrow.utf8());
    const indices = new Uint8Array([
      0,
      1,
      0,
      2
    ]);
    const v = arrow.makeVector({
      type: dictType,
      length: 4,
      values: indices,
      dictionary: dictValues
    });
    t.deepEqual(v.toArray(), [
      'red',
      'green',
      'blue',
      'blue'
    ].map((_, i) => [
      'red',
      'green',
      'red',
      'blue'
    ][i]), 'decodes through the dictionary');
  });
  it('reads a run-end-encoded vector', (t) => {
    // run ends [2, 3, 6], values ['a','b','c'] → a a b c c c
    const type = arrow.runEndEncoded(new Field('run_ends', arrow.int32(), false), new Field('values', arrow.utf8(), true));
    const runEnds = arrow.makeVector({
      type: arrow.int32(),
      length: 3,
      values: new Uint8Array(new Int32Array([
        2,
        3,
        6
      ]).buffer)
    });
    const values = arrow.vectorFromArray([
      'a',
      'b',
      'c'
    ], arrow.utf8());
    const v = arrow.makeVector({
      type,
      length: 6,
      children: [runEnds, values]
    });
    t.deepEqual(v.toArray(), [
      'a',
      'a',
      'b',
      'c',
      'c',
      'c'
    ], 'REE expands runs');
  });
  it('reads a dense union', (t) => {
    // typeIds [0,1,0], offsets [0,0,1]; child0 int32 [10,20], child1 utf8 ['hi']
    const type = arrow.union(1, [0, 1], [new Field('a', arrow.int32(), true), new Field('b', arrow.utf8(), true)]);
    const child0 = arrow.vectorFromArray([10, 20], arrow.int32());
    const child1 = arrow.vectorFromArray(['hi'], arrow.utf8());
    const v = arrow.makeVector({
      type,
      length: 3,
      typeIds: new Uint8Array([
        0,
        1,
        0
      ]),
      valueOffsets: new Uint8Array(new Int32Array([
        0,
        0,
        1
      ]).buffer),
      children: [child0, child1]
    });
    t.deepEqual(v.toArray(), [
      10,
      'hi',
      20
    ], 'union dispatches by type id');
  });
});
describe('arrow slicing and iteration', () => {
  it('slices zero-copy and preserves nulls', (t) => {
    const v = arrow.vectorFromArray([
      1,
      2,
      3,
      null,
      5
    ], arrow.int32());
    const s = v.slice(2, 5);
    t.deepEqual(s.toArray(), [
      3,
      null,
      5
    ], 'sliced range');
    t.equal(s.length, 3, 'sliced length');
  });
  it('iterates', (t) => {
    const v = arrow.vectorFromArray([
      1,
      2,
      3
    ], arrow.int32());
    t.deepEqual([...v], [
      1,
      2,
      3
    ], 'iterator yields values');
  });
});
describe('arrow record batch and table', () => {
  it('builds a record batch from records', (t) => {
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
      ]
    });
    t.equal(batch.numRows, 3, 'rows');
    t.equal(batch.numColumns, 2, 'columns');
    t.deepEqual(batch.row(1), {
      id: 2,
      name: 'b'
    }, 'row object');
    t.deepEqual(batch.getChild('name')!.toArray(), [
      'a',
      'b',
      'c'
    ], 'column by name');
  });
  it('rejects mismatched column lengths', (t) => {
    const a = arrow.vectorFromArray([1, 2], arrow.int32());
    const b = arrow.vectorFromArray([1], arrow.int32());
    const schema = arrow.Schema.from({
      a: arrow.int32(),
      b: arrow.int32()
    });
    t.throws(() => new arrow.RecordBatch(schema, [a, b]), /same length/, 'length mismatch');
  });
  it('builds a chunked table', (t) => {
    const b1 = arrow.RecordBatch.from({ x: [1, 2] });
    const b2 = arrow.RecordBatch.from({ x: [
      3,
      4,
      5
    ] });
    const table = arrow.Table.from([b1, b2]);
    t.equal(table.numRows, 5, 'total rows');
    const col = table.getChild('x')!;
    t.deepEqual(col.toArray(), [
      1,
      2,
      3,
      4,
      5
    ], 'chunked column scan');
    t.equal(col.get(3), 4, 'cross-chunk random access');
  });
});
describe('arrow type helpers', () => {
  it('compares types structurally', (t) => {
    t.ok(arrow.typeEquals(arrow.int32(), arrow.int32()), 'same int');
    t.ok(!arrow.typeEquals(arrow.int32(), arrow.int64()), 'different width');
    t.ok(arrow.typeEquals(arrow.timestamp(arrow.TimeUnit.MICROSECOND, 'UTC'), arrow.timestamp(arrow.TimeUnit.MICROSECOND, 'UTC')), 'same timestamp');
    t.ok(!arrow.typeEquals(arrow.timestamp(arrow.TimeUnit.MICROSECOND, 'UTC'), arrow.timestamp(arrow.TimeUnit.MICROSECOND, null)), 'tz differs');
  });
});
