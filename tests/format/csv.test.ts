import { describe, it } from 'fino:test/test';
import { parse, stringify, parseStream } from 'fino:format/csv';
import { loadCorpus, runCorpus, type CorpusCase } from './_corpus.ts';
describe('fino:format/csv — parse basics', () => {
  it('parses simple rows', (t) => {
    t.deepEqual(parse('a,b,c\n1,2,3'), [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });
  it('parses with header option', (t) => {
    const rows = parse('name,age\nAlice,30\nBob,25', { header: true });
    t.deepEqual(rows, [
      {
        name: 'Alice',
        age: '30',
      },
      {
        name: 'Bob',
        age: '25',
      },
    ]);
  });
  it('handles quoted fields', (t) => {
    t.deepEqual(parse('"hello, world",b'), [['"hello, world"'.slice(1, -1), 'b']]);
    t.deepEqual(parse('"hello, world",b'), [['hello, world', 'b']]);
  });
  it('handles doubled quotes inside quoted field', (t) => {
    t.deepEqual(parse('"say ""hi""",b'), [['say "hi"', 'b']]);
  });
  it('handles CRLF line endings', (t) => {
    t.deepEqual(parse('a,b\r\n1,2\r\n'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('handles quoted field with newline', (t) => {
    const result = parse('"line1\nline2",b');
    t.equal(result[0]![0], 'line1\nline2');
    t.equal(result[0]![1], 'b');
  });
  it('rejects trailing text after a closing quote', (t) => {
    t.throws(() => parse('"a"x,b\n'), /closing quote|quoted field/i);
  });
  it('handles empty fields', (t) => {
    t.deepEqual(parse('a,,c'), [['a', '', 'c']]);
  });
  it('handles skipEmptyLines', (t) => {
    t.deepEqual(parse('a,b\n\n1,2\n', { skipEmptyLines: true }), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('handles trim option', (t) => {
    t.deepEqual(parse(' a , b \n 1 , 2 ', { trim: true }), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('handles comment option', (t) => {
    t.deepEqual(parse('# comment\na,b\n1,2', { comment: '#' }), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('handles custom delimiter', (t) => {
    t.deepEqual(parse('a;b;c\n1;2;3', { delimiter: ';' }), [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });
  it('handles explicit columns option', (t) => {
    const rows = parse('1,2\n3,4', { columns: ['x', 'y'] });
    t.deepEqual(rows, [
      {
        x: '1',
        y: '2',
      },
      {
        x: '3',
        y: '4',
      },
    ]);
  });
  it('throws on mismatched column count', (t) => {
    t.throws(() => parse('a,b\n1,2,3', { header: true }), /fields/i);
  });
  it('relaxColumnCount suppresses mismatch error', (t) => {
    const rows = parse('a,b\n1,2,3', {
      header: true,
      relaxColumnCount: true,
    });
    t.equal(rows.length, 1);
  });
});
describe('fino:format/csv — parse cast', () => {
  it('casts numbers and booleans', (t) => {
    const rows = parse('x\n1\ntrue\nnull', {
      header: true,
      cast: true,
    });
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
    const csv = stringify([
      ['a', 'b'],
      ['1', '2'],
    ]);
    t.equal(csv, 'a,b\r\n1,2\r\n');
  });
  it('serializes records with auto header', (t) => {
    const csv = stringify([
      {
        name: 'Alice',
        age: '30',
      },
    ]);
    t.ok(csv.startsWith('name,age\r\n'));
    t.ok(csv.includes('Alice,30'));
  });
  it('quotes fields containing delimiter', (t) => {
    const csv = stringify([['a,b', 'c']]);
    t.ok(csv.startsWith('"a,b"'));
  });
  it('quotes fields containing newlines', (t) => {
    const csv = stringify([['line1\nline2', 'b']]);
    t.ok(csv.startsWith('"line1\nline2"'));
  });
  it('handles custom lineEnding', (t) => {
    const csv = stringify([['a', 'b']], { lineEnding: '\n' });
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
describe('fino:format/csv — parseStream', () => {
  async function chunks(csv: string, sizes: number[]): Promise<AsyncIterable<Uint8Array>> {
    const enc = new TextEncoder();
    const bytes = enc.encode(csv);
    const parts: Uint8Array[] = [];
    let pos = 0;
    for (const sz of sizes) {
      parts.push(bytes.subarray(pos, pos + sz));
      pos += sz;
    }
    if (pos < bytes.length) parts.push(bytes.subarray(pos));
    return (async function* () {
      for (const p of parts) yield p;
    })();
  }
  it('streams simple rows', async (t) => {
    const src = await chunks('a,b,c\n1,2,3\n4,5,6\n', [7, 12]);
    const rows: string[][] = [];
    for await (const row of parseStream(src)) rows.push(row as string[]);
    t.deepEqual(rows, [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });
  it('streams with header option', async (t) => {
    const src = await chunks('name,age\nAlice,30\nBob,25\n', [9, 16]);
    const rows: Record<string, string>[] = [];
    for await (const row of parseStream(src, { header: true }))
      rows.push(row as Record<string, string>);
    t.deepEqual(rows, [
      {
        name: 'Alice',
        age: '30',
      },
      {
        name: 'Bob',
        age: '25',
      },
    ]);
  });
  it('handles quoted field with embedded newline across chunk boundary', async (t) => {
    const csv = '"line1\nline2",b\nc,d\n';
    const src = await chunks(csv, [8, csv.length - 8]);
    const rows: string[][] = [];
    for await (const row of parseStream(src)) rows.push(row as string[]);
    t.equal(rows[0]![0], 'line1\nline2');
    t.equal(rows[0]![1], 'b');
    t.deepEqual(rows[1], ['c', 'd']);
  });
  it('handles last row without trailing newline', async (t) => {
    const src = await chunks('a,b\n1,2', [4, 3]);
    const rows: string[][] = [];
    for await (const row of parseStream(src)) rows.push(row as string[]);
    t.deepEqual(rows, [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('handles CRLF line endings', async (t) => {
    const src = await chunks('a,b\r\n1,2\r\n', [5, 5]);
    const rows: string[][] = [];
    for await (const row of parseStream(src)) rows.push(row as string[]);
    t.deepEqual(rows, [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('skipEmptyLines works in stream', async (t) => {
    const src = await chunks('a,b\n\n1,2\n', [4, 6]);
    const rows: string[][] = [];
    for await (const row of parseStream(src, { skipEmptyLines: true })) rows.push(row as string[]);
    t.deepEqual(rows, [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('throws on mismatched column count in stream', async (t) => {
    const src = await chunks('a,b\n1,2,3\n', [5, 6]);
    let threw = false;
    try {
      for await (const _ of parseStream(src, { header: true })) {
      }
    } catch (e) {
      threw = true;
      t.ok((e as Error).message.includes('fields'), 'expected fields error');
    }
    t.ok(threw, 'expected error to be thrown');
  });
  it('rejects trailing text after a closing quote across chunks', async (t) => {
    const src = await chunks('"a"x,b\n', [2, 1, 4]);
    await t.rejects(async () => {
      for await (const _ of parseStream(src)) {
      }
    }, /closing quote|quoted field/i);
  });
});
const FIXTURES_DIR = new URL('../fixtures/csv', import.meta.url).pathname;
const csvCorpus = await loadCorpus(FIXTURES_DIR);
describe('fino:format/csv — conformance (csv-spectrum)', () => {
  runCorpus(csvCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') {
      t.throws(() => parse(c.input));
      return;
    }
    const rows = parse(c.input);
    if (c.expected !== 'parse-ok') {
      t.deepEqual(rows, c.expected as string[][], c.id);
    } else {
      t.ok(Array.isArray(rows), 'parse succeeded');
    }
  });
});
describe('fino:format/csv — round-trip (corpus)', () => {
  runCorpus(csvCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') return;
    const first = parse(c.input) as string[][];
    const second = parse(stringify(first)) as string[][];
    t.deepEqual(second, first, c.id);
  });
});
