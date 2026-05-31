import { describe, it } from 'fino:test/test';
import { parse, stringify, parseAll } from 'fino:format/yaml';

describe('fino:format/yaml — scalars', () => {
  it('parses null', (t) => {
    t.equal(parse('null'), null);
    t.equal(parse('~'), null);
    t.equal(parse(''), null);
  });

  it('parses booleans', (t) => {
    t.equal(parse('true'), true);
    t.equal(parse('false'), false);
  });

  it('parses integers', (t) => {
    t.equal(parse('42'), 42);
    t.equal(parse('-1'), -1);
    t.equal(parse('0xff'), 255);
    t.equal(parse('0o77'), 63);
  });

  it('parses floats', (t) => {
    t.equal(parse('3.14'), 3.14);
    t.equal(parse('.inf'), Infinity);
    t.equal(parse('-.inf'), -Infinity);
    t.ok(Number.isNaN(parse('.nan') as number));
  });

  it('parses plain strings', (t) => {
    t.equal(parse('hello world'), 'hello world');
    t.equal(parse('not-a-number-really'), 'not-a-number-really');
  });

  it('parses single-quoted strings', (t) => {
    t.equal(parse("'hello'"), 'hello');
    t.equal(parse("'it''s a quote'"), "it's a quote");
  });

  it('parses double-quoted strings', (t) => {
    t.equal(parse('"hello\\nworld"'), 'hello\nworld');
    t.equal(parse('"tab\\there"'), 'tab\there');
  });
});

describe('fino:format/yaml — block mappings', () => {
  it('parses simple mapping', (t) => {
    t.deepEqual(parse('a: 1\nb: 2'), { a: 1, b: 2 });
  });

  it('parses nested mappings', (t) => {
    t.deepEqual(parse('server:\n  port: 8080\n  host: localhost'), {
      server: { port: 8080, host: 'localhost' },
    });
  });

  it('parses mapping with null value', (t) => {
    const v = parse('a:\nb: 2') as { a: null; b: number };
    t.equal(v.a, null);
    t.equal(v.b, 2);
  });

  it('throws on duplicate keys by default', (t) => {
    t.throws(() => parse('a: 1\na: 2'), /duplicate/i);
  });

  it('allows duplicate keys when opted in', (t) => {
    const v = parse('a: 1\na: 2', { allowDuplicateKeys: true }) as { a: number };
    t.equal(v.a, 2);
  });
});

describe('fino:format/yaml — block sequences', () => {
  it('parses simple sequence', (t) => {
    t.deepEqual(parse('- 1\n- 2\n- 3'), [1, 2, 3]);
  });

  it('parses sequence of mappings', (t) => {
    t.deepEqual(parse('- name: Alice\n  age: 30\n- name: Bob\n  age: 25'), [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
  });

  it('parses nested sequences', (t) => {
    t.deepEqual(parse('- - 1\n  - 2\n- - 3\n  - 4'), [[1, 2], [3, 4]]);
  });
});

describe('fino:format/yaml — flow styles', () => {
  it('parses flow sequence', (t) => {
    t.deepEqual(parse('[1, 2, 3]'), [1, 2, 3]);
  });

  it('parses flow mapping', (t) => {
    t.deepEqual(parse('{a: 1, b: 2}'), { a: 1, b: 2 });
  });

  it('parses nested flow', (t) => {
    t.deepEqual(parse('{a: [1, 2]}'), { a: [1, 2] });
  });
});

describe('fino:format/yaml — block scalars', () => {
  it('parses literal block scalar', (t) => {
    const v = parse('text: |\n  line1\n  line2\n') as { text: string };
    t.equal(v.text, 'line1\nline2\n');
  });

  it('parses folded block scalar', (t) => {
    const v = parse('text: >\n  line1\n  line2\n') as { text: string };
    t.ok(v.text.includes('line1'));
  });

  it('handles strip chomping -', (t) => {
    const v = parse('text: |-\n  hello\n') as { text: string };
    t.equal(v.text, 'hello');
  });
});

describe('fino:format/yaml — comments and markers', () => {
  it('ignores comments', (t) => {
    t.deepEqual(parse('# comment\na: 1 # inline'), { a: 1 });
  });

  it('handles document markers ---', (t) => {
    t.deepEqual(parse('---\na: 1'), { a: 1 });
  });

  it('parseAll returns multiple documents', (t) => {
    const docs = parseAll('a: 1\n---\nb: 2');
    t.equal(docs.length, 2);
    t.deepEqual(docs[0], { a: 1 });
    t.deepEqual(docs[1], { b: 2 });
  });
});

describe('fino:format/yaml — Phase 2 rejections', () => {
  it('rejects anchors with clear error', (t) => {
    t.throws(() => parse('x: &anchor value'), /anchor.*phase 2/i);
  });

  it('rejects aliases with clear error', (t) => {
    t.throws(() => parse('x: *anchor'), /alias.*phase 2/i);
  });

  it('rejects explicit tags with clear error', (t) => {
    t.throws(() => parse('x: !!str 42'), /tag.*phase 2/i);
  });
});

describe('fino:format/yaml — stringify', () => {
  it('serializes null', (t) => {
    t.ok(stringify(null).trim() === 'null');
  });

  it('serializes booleans', (t) => {
    t.ok(stringify(true).trim() === 'true');
    t.ok(stringify(false).trim() === 'false');
  });

  it('serializes numbers', (t) => {
    t.ok(stringify(42).trim() === '42');
    t.ok(stringify(Infinity).trim() === '.inf');
  });

  it('serializes strings', (t) => {
    t.ok(stringify('hello').trim() === 'hello');
    t.ok(stringify('true').includes("'true'") || stringify('true').includes('"true"'));
  });

  it('serializes mappings', (t) => {
    const out = stringify({ a: 1, b: 'hello' });
    t.ok(out.includes('a: 1'));
    t.ok(out.includes('b:'));
  });

  it('serializes sequences', (t) => {
    const out = stringify([1, 2, 3]);
    t.ok(out.includes('1'));
  });

  it('roundtrips a config-like document', (t) => {
    const original = { server: { port: 8080, host: 'localhost' }, tags: ['a', 'b'] };
    const yaml = stringify(original as any);
    const parsed = parse(yaml) as typeof original;
    t.equal(parsed.server.port, 8080);
    t.equal(parsed.server.host, 'localhost');
  });
});
