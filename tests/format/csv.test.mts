import { describe, it } from 'fino:test/test';
import { parse, stringify } from 'fino:format/csv';

describe('fino:format/csv — parse basics', () => {
  it('parses simple rows', (t) => {
    t.deepEqual(parse('a,b,c\n1,2,3'), [['a','b','c'],['1','2','3']]);
  });

  it('parses with header option', (t) => {
    const rows = parse('name,age\nAlice,30\nBob,25', { header: true });
    t.deepEqual(rows, [{ name: 'Alice', age: '30' }, { name: 'Bob', age: '25' }]);
  });

  it('handles quoted fields', (t) => {
    t.deepEqual(parse('"hello, world",b'), [['"hello, world"'.slice(1,-1), 'b']]);
    t.deepEqual(parse('"hello, world",b'), [['hello, world', 'b']]);
  });

  it('handles doubled quotes inside quoted field', (t) => {
    t.deepEqual(parse('"say ""hi""",b'), [['say "hi"', 'b']]);
  });

  it('handles CRLF line endings', (t) => {
    t.deepEqual(parse('a,b\r\n1,2\r\n'), [['a','b'],['1','2']]);
  });

  it('handles quoted field with newline', (t) => {
    const result = parse('"line1\nline2",b');
    t.equal(result[0]![0], 'line1\nline2');
    t.equal(result[0]![1], 'b');
  });

  it('handles empty fields', (t) => {
    t.deepEqual(parse('a,,c'), [['a','','c']]);
  });

  it('handles skipEmptyLines', (t) => {
    t.deepEqual(parse('a,b\n\n1,2\n', { skipEmptyLines: true }), [['a','b'],['1','2']]);
  });

  it('handles trim option', (t) => {
    t.deepEqual(parse(' a , b \n 1 , 2 ', { trim: true }), [['a','b'],['1','2']]);
  });

  it('handles comment option', (t) => {
    t.deepEqual(parse('# comment\na,b\n1,2', { comment: '#' }), [['a','b'],['1','2']]);
  });

  it('handles custom delimiter', (t) => {
    t.deepEqual(parse('a;b;c\n1;2;3', { delimiter: ';' }), [['a','b','c'],['1','2','3']]);
  });

  it('handles explicit columns option', (t) => {
    const rows = parse('1,2\n3,4', { columns: ['x', 'y'] });
    t.deepEqual(rows, [{ x: '1', y: '2' }, { x: '3', y: '4' }]);
  });

  it('throws on mismatched column count', (t) => {
    t.throws(() => parse('a,b\n1,2,3', { header: true }), /fields/i);
  });

  it('relaxColumnCount suppresses mismatch error', (t) => {
    const rows = parse('a,b\n1,2,3', { header: true, relaxColumnCount: true });
    t.equal(rows.length, 1);
  });
});

describe('fino:format/csv — parse cast', () => {
  it('casts numbers and booleans', (t) => {
    const rows = parse('x\n1\ntrue\nnull', { header: true, cast: true });
    t.equal(rows[0]!['x'], 1);
    t.equal(rows[1]!['x'] as unknown, true);
    t.equal(rows[2]!['x'] as unknown, null);
  });

  it('supports custom cast function', (t) => {
    const rows = parse('x\n1', {
      header: true,
      cast: (v) => v + '!',
    });
    t.equal(rows[0]!['x'], '1!');
  });
});

describe('fino:format/csv — stringify', () => {
  it('serializes string[][] to CSV', (t) => {
    const csv = stringify([['a','b'],['1','2']]);
    t.equal(csv, 'a,b\r\n1,2\r\n');
  });

  it('serializes records with auto header', (t) => {
    const csv = stringify([{ name: 'Alice', age: '30' }]);
    t.ok(csv.startsWith('name,age\r\n'));
    t.ok(csv.includes('Alice,30'));
  });

  it('quotes fields containing delimiter', (t) => {
    const csv = stringify([['a,b','c']]);
    t.ok(csv.startsWith('"a,b"'));
  });

  it('quotes fields containing newlines', (t) => {
    const csv = stringify([['line1\nline2', 'b']]);
    t.ok(csv.startsWith('"line1\nline2"'));
  });

  it('handles custom lineEnding', (t) => {
    const csv = stringify([['a','b']], { lineEnding: '\n' });
    t.equal(csv, 'a,b\n');
  });

  it('returns empty string for empty input', (t) => {
    t.equal(stringify([]), '');
  });
});

describe('fino:format/csv — roundtrip', () => {
  it('roundtrips basic CSV', (t) => {
    const original = 'a,b,c\r\n1,2,3\r\n4,5,6\r\n';
    const rows = parse(original);
    t.equal(stringify(rows), original);
  });
});
