/**
* Tests for the fino:data/arrow C Data Interface (format codec + export/import).
*/
import { describe, it } from 'fino:test/test';
import * as arrow from 'fino:data/arrow';
import { Field } from 'fino:data/arrow';
import { typeToFormat, formatToType, exportVector, importVector, exportRecordBatch } from 'fino:data/arrow/cdata';
describe('arrow C Data Interface format codec', () => {
  const cases: Array<[arrow.DataType, string]> = [
    [arrow.nullType(), 'n'],
    [arrow.bool(), 'b'],
    [arrow.int8(), 'c'],
    [arrow.uint8(), 'C'],
    [arrow.int16(), 's'],
    [arrow.uint16(), 'S'],
    [arrow.int32(), 'i'],
    [arrow.uint32(), 'I'],
    [arrow.int64(), 'l'],
    [arrow.uint64(), 'L'],
    [arrow.float16(), 'e'],
    [arrow.float32(), 'f'],
    [arrow.float64(), 'g'],
    [arrow.utf8(), 'u'],
    [arrow.largeUtf8(), 'U'],
    [arrow.binary(), 'z'],
    [arrow.largeBinary(), 'Z'],
    [arrow.utf8View(), 'vu'],
    [arrow.binaryView(), 'vz'],
    [arrow.fixedSizeBinary(16), 'w:16'],
    [arrow.decimal(38, 4), 'd:38,4'],
    [arrow.decimal(38, 4, 256), 'd:38,4,256'],
    [arrow.date32(), 'tdD'],
    [arrow.date64(), 'tdm'],
    [arrow.timestamp(arrow.TimeUnit.MICROSECOND, 'UTC'), 'tsu:UTC'],
    [arrow.timestamp(arrow.TimeUnit.NANOSECOND, null), 'tsn:'],
    [arrow.duration(arrow.TimeUnit.MILLISECOND), 'tDm'],
    [arrow.interval(arrow.IntervalUnit.MONTH_DAY_NANO), 'tin']
  ];
  for (const [type, format] of cases) {
    it(`encodes ${type.kind} → ${format}`, (t) => {
      t.equal(typeToFormat(type), format, 'format string');
      const decoded = formatToType(format);
      t.ok(arrow.typeEquals(decoded, type), 'round-trips through formatToType');
    });
  }
  it('encodes nested formats', (t) => {
    t.equal(typeToFormat(arrow.list(new Field('item', arrow.int32(), true))), '+l', 'list');
    t.equal(typeToFormat(arrow.struct([])), '+s', 'struct');
    t.equal(typeToFormat(arrow.fixedSizeList(3, new Field('item', arrow.float32(), true))), '+w:3', 'fixed size list');
    t.equal(typeToFormat(arrow.union(arrow.UnionMode.Dense, [0, 1], [])), '+ud:0,1', 'dense union');
    t.equal(typeToFormat(arrow.map(new Field('entries', arrow.struct([]), false))), '+m', 'map');
  });
  it('decodes timestamp timezone', (t) => {
    const ts = formatToType('tsu:America/New_York');
    t.ok(ts.kind === 'timestamp' && ts.timezone === 'America/New_York', 'timezone parsed');
  });
  it('rejects an unknown format', (t) => {
    t.throws(() => formatToType('??'), /unsupported/, 'bad format');
  });
});
describe('arrow C Data Interface export/import round-trips', () => {
  function roundTripVector(values: unknown[], type: arrow.DataType): unknown[] {
    const vec = arrow.vectorFromArray(values, type);
    const { schema, array } = exportVector(vec, new Field('c', type, true));
    const imported = importVector(schema, array);
    const result = imported.value.toArray();
    imported.release();
    return result;
  }
  it('round-trips int32 through real pointers', (t) => {
    t.deepEqual(roundTripVector([
      1,
      2,
      3,
      null,
      5
    ], arrow.int32()), [
      1,
      2,
      3,
      null,
      5
    ], 'int32');
  });
  it('round-trips int64', (t) => {
    t.deepEqual(roundTripVector([
      1n,
      2n,
      9007199254740993n
    ], arrow.int64()), [
      1n,
      2n,
      9007199254740993n
    ], 'int64');
  });
  it('round-trips float64 with nulls', (t) => {
    t.deepEqual(roundTripVector([
      1.5,
      null,
      2.25
    ], arrow.float64()), [
      1.5,
      null,
      2.25
    ], 'float64');
  });
  it('round-trips bool', (t) => {
    t.deepEqual(roundTripVector([
      true,
      false,
      null,
      true
    ], arrow.bool()), [
      true,
      false,
      null,
      true
    ], 'bool');
  });
  it('round-trips utf8', (t) => {
    t.deepEqual(roundTripVector([
      'alpha',
      'grüße',
      '',
      null
    ], arrow.utf8()), [
      'alpha',
      'grüße',
      '',
      null
    ], 'utf8');
  });
  it('round-trips list<int32>', (t) => {
    const type = arrow.list(new Field('item', arrow.int32(), true));
    t.deepEqual(roundTripVector([
      [1, 2],
      [],
      [3]
    ], type), [
      [1, 2],
      [],
      [3]
    ], 'list');
  });
  it('round-trips struct', (t) => {
    const type = arrow.struct([new Field('a', arrow.int32(), true), new Field('b', arrow.utf8(), true)]);
    t.deepEqual(roundTripVector([{
      a: 1,
      b: 'x'
    }, {
      a: 2,
      b: 'y'
    }], type), [{
      a: 1,
      b: 'x'
    }, {
      a: 2,
      b: 'y'
    }], 'struct');
  });
  it('exports a record batch as a struct array', (t) => {
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
    const { schema, array } = exportRecordBatch(batch);
    const imported = importVector(schema, array);
    t.deepEqual(imported.value.toArray(), [
      {
        id: 1,
        name: 'a'
      },
      {
        id: 2,
        name: 'b'
      },
      {
        id: 3,
        name: 'c'
      }
    ], 'batch as struct');
    imported.release();
  });
});
