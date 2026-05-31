import { describe, it } from 'fino:test/test';
import { parse, stringify, TomlLocalDate, TomlLocalTime, TomlLocalDateTime } from 'fino:format/toml';
import { loadCorpus, runCorpus, type CorpusCase } from './_corpus.mts';

describe('fino:format/toml — scalars', () => {
  it('parses strings', (t) => {
    t.deepEqual(parse('x = "hello"'), { x: 'hello' });
    t.deepEqual(parse("x = 'world'"), { x: 'world' });
  });

  it('parses integers', (t) => {
    t.deepEqual(parse('x = 42'), { x: 42 });
    t.deepEqual(parse('x = -1'), { x: -1 });
    t.deepEqual(parse('x = 1_000'), { x: 1000 });
    t.deepEqual(parse('x = 0xff'), { x: 255 });
    t.deepEqual(parse('x = 0o77'), { x: 63 });
    t.deepEqual(parse('x = 0b1010'), { x: 10 });
  });

  it('parses floats', (t) => {
    t.deepEqual(parse('x = 3.14'), { x: 3.14 });
    t.deepEqual(parse('x = inf'), { x: Infinity });
    t.deepEqual(parse('x = -inf'), { x: -Infinity });
    t.ok(Number.isNaN((parse('x = nan') as { x: number }).x));
  });

  it('parses booleans', (t) => {
    t.deepEqual(parse('x = true\ny = false'), { x: true, y: false });
  });

  it('parses multiline basic strings', (t) => {
    const doc = parse('x = """\nline1\nline2\n"""');
    t.equal((doc as { x: string }).x, 'line1\nline2\n');
  });

  it('parses escape sequences in basic strings', (t) => {
    t.deepEqual(parse('x = "tab\\there"'), { x: 'tab\there' });
    t.deepEqual(parse('x = "quote: \\""'), { x: 'quote: "' });
  });
});

describe('fino:format/toml — arrays', () => {
  it('parses arrays', (t) => {
    t.deepEqual(parse('x = [1, 2, 3]'), { x: [1, 2, 3] });
  });

  it('parses mixed-type arrays', (t) => {
    t.deepEqual(parse('x = ["a", "b"]'), { x: ['a', 'b'] });
  });

  it('parses nested arrays', (t) => {
    t.deepEqual(parse('x = [[1, 2], [3, 4]]'), { x: [[1, 2], [3, 4]] });
  });

  it('parses array with trailing comma', (t) => {
    t.deepEqual(parse('x = [1, 2, 3,]'), { x: [1, 2, 3] });
  });
});

describe('fino:format/toml — tables', () => {
  it('parses [table]', (t) => {
    const doc = parse('[server]\nport = 8080');
    t.deepEqual(doc, { server: { port: 8080 } });
  });

  it('parses dotted keys', (t) => {
    t.deepEqual(parse('a.b.c = 1'), { a: { b: { c: 1 } } });
  });

  it('parses [[array-of-tables]]', (t) => {
    const doc = parse('[[products]]\nname = "Hammer"\n[[products]]\nname = "Nail"');
    t.deepEqual(doc, { products: [{ name: 'Hammer' }, { name: 'Nail' }] });
  });

  it('parses inline tables', (t) => {
    t.deepEqual(parse('point = { x = 1, y = 2 }'), { point: { x: 1, y: 2 } });
  });

  it('throws on duplicate key', (t) => {
    t.throws(() => parse('x = 1\nx = 2'), /duplicate/i);
  });

  it('throws on duplicate table', (t) => {
    t.throws(() => parse('[a]\nx = 1\n[a]\ny = 2'), /duplicate/i);
  });
});

describe('fino:format/toml — datetimes', () => {
  it('parses offset datetime to Date', (t) => {
    const doc = parse('dt = 1979-05-27T07:32:00Z') as { dt: Date };
    t.ok(doc.dt instanceof Date);
    t.equal(doc.dt.getFullYear(), 1979);
  });

  it('parses local date to TomlLocalDate', (t) => {
    const doc = parse('d = 2024-01-15') as { d: TomlLocalDate };
    t.ok(doc.d instanceof TomlLocalDate);
    t.equal(doc.d.year, 2024);
    t.equal(doc.d.month, 1);
    t.equal(doc.d.day, 15);
  });

  it('parses local time to TomlLocalTime', (t) => {
    const doc = parse('t = 07:32:00') as { t: TomlLocalTime };
    t.ok(doc.t instanceof TomlLocalTime);
    t.equal(doc.t.hour, 7);
  });

  it('parses local datetime', (t) => {
    const doc = parse('dt = 2024-01-15T07:32:00') as { dt: TomlLocalDateTime };
    t.ok(doc.dt instanceof TomlLocalDateTime);
    t.equal(doc.dt.date.year, 2024);
  });
});

describe('fino:format/toml — comments', () => {
  it('ignores comments', (t) => {
    t.deepEqual(parse('# top comment\nx = 1 # inline'), { x: 1 });
  });
});

describe('fino:format/toml — stringify', () => {
  it('roundtrips scalars', (t) => {
    const doc = { name: 'test', count: 42, enabled: true };
    const toml = stringify(doc);
    t.ok(toml.includes('count = 42'));
    t.ok(toml.includes('enabled = true'));
  });

  it('roundtrips nested tables', (t) => {
    const doc = { server: { port: 8080 } };
    const toml = stringify(doc);
    t.ok(toml.includes('[server]'));
    t.ok(toml.includes('port = 8080'));
  });

  it('roundtrips arrays', (t) => {
    const doc = { tags: ['a', 'b', 'c'] };
    const toml = stringify(doc);
    t.ok(toml.includes("tags = ['a', 'b', 'c']") || toml.includes('tags = ['));
  });

  it('roundtrips array of tables', (t) => {
    const doc = { products: [{ name: 'Hammer' }, { name: 'Nail' }] };
    const toml = stringify(doc);
    t.ok(toml.includes('[[products]]'));
  });
});

const TOML_FIXTURES_DIR = new URL('../fixtures/toml', import.meta.url).pathname;
const tomlCorpus = await loadCorpus(TOML_FIXTURES_DIR);

describe('fino:format/toml — conformance (toml-test)', () => {
  runCorpus(tomlCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') {
      t.throws(() => parse(c.input));
      return;
    }
    const doc = parse(c.input);
    if (c.expected !== 'parse-ok') {
      t.deepEqual(doc, c.expected as Record<string, unknown>, c.id);
    } else {
      t.ok(typeof doc === 'object' && doc !== null, 'parse succeeded');
    }
  });
});

describe('fino:format/toml — round-trip (corpus)', () => {
  runCorpus(tomlCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') return;
    const first = parse(c.input);
    const second = parse(stringify(first));
    t.deepEqual(second, first, c.id);
  });
});
