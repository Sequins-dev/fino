import { describe, it } from 'fino:test/test';
import { parse, stringify, parseAll } from 'fino:format/yaml';
import { loadCorpus, runCorpus, type CorpusCase } from './_corpus.ts';
import { DiskFileSystem } from 'fino:file';
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
  it('keeps YAML 1.1 boolean-like words as YAML 1.2 core strings', (t) => {
    t.equal(parse('yes'), 'yes');
    t.equal(parse('on'), 'on');
    t.equal(parse('Off'), 'Off');
    t.deepEqual(parse('a: yes\nb: on\nc: Off'), {
      a: 'yes',
      b: 'on',
      c: 'Off'
    });
  });
  it('parses single-quoted strings', (t) => {
    t.equal(parse('\'hello\''), 'hello');
    t.equal(parse('\'it\'\'s a quote\''), 'it\'s a quote');
  });
  it('parses double-quoted strings', (t) => {
    t.equal(parse('"hello\\nworld"'), 'hello\nworld');
    t.equal(parse('"tab\\there"'), 'tab	here');
  });
});
describe('fino:format/yaml — block mappings', () => {
  it('parses simple mapping', (t) => {
    t.deepEqual(parse('a: 1\nb: 2'), {
      a: 1,
      b: 2
    });
  });
  it('parses nested mappings', (t) => {
    t.deepEqual(parse('server:\n  port: 8080\n  host: localhost'), { server: {
      port: 8080,
      host: 'localhost'
    } });
  });
  it('parses mapping with null value', (t) => {
    const v = parse('a:\nb: 2') as {
      a: null;
      b: number;
    };
    t.equal(v.a, null);
    t.equal(v.b, 2);
  });
  it('throws on duplicate keys by default', (t) => {
    t.throws(() => parse('a: 1\na: 2'), /duplicate/i);
  });
  it('allows duplicate keys when opted in', (t) => {
    const v = parse('a: 1\na: 2', { allowDuplicateKeys: true }) as {
      a: number;
    };
    t.equal(v.a, 2);
  });
});
describe('fino:format/yaml — block sequences', () => {
  it('parses simple sequence', (t) => {
    t.deepEqual(parse('- 1\n- 2\n- 3'), [
      1,
      2,
      3
    ]);
  });
  it('parses sequence of mappings', (t) => {
    t.deepEqual(parse('- name: Alice\n  age: 30\n- name: Bob\n  age: 25'), [{
      name: 'Alice',
      age: 30
    }, {
      name: 'Bob',
      age: 25
    }]);
  });
  it('parses nested sequences', (t) => {
    t.deepEqual(parse('- - 1\n  - 2\n- - 3\n  - 4'), [[1, 2], [3, 4]]);
  });
});
describe('fino:format/yaml — flow styles', () => {
  it('parses flow sequence', (t) => {
    t.deepEqual(parse('[1, 2, 3]'), [
      1,
      2,
      3
    ]);
  });
  it('parses flow mapping', (t) => {
    t.deepEqual(parse('{a: 1, b: 2}'), {
      a: 1,
      b: 2
    });
  });
  it('parses nested flow', (t) => {
    t.deepEqual(parse('{a: [1, 2]}'), { a: [1, 2] });
  });
});
describe('fino:format/yaml — block scalars', () => {
  it('parses literal block scalar', (t) => {
    const v = parse('text: |\n  line1\n  line2\n') as {
      text: string;
    };
    t.equal(v.text, 'line1\nline2\n');
  });
  it('parses folded block scalar', (t) => {
    const v = parse('text: >\n  line1\n  line2\n') as {
      text: string;
    };
    t.ok(v.text.includes('line1'));
  });
  it('handles strip chomping -', (t) => {
    const v = parse('text: |-\n  hello\n') as {
      text: string;
    };
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
  it('parseAll handles explicit starts, document ends, comments, and following documents', (t) => {
    const docs = parseAll([
      '---',
      'a: 1',
      '...',
      '# separator comment',
      '---',
      '- b',
      '- c',
      '...'
    ].join('\n'));
    t.equal(docs.length, 2, 'two documents returned');
    t.deepEqual(docs[0], { a: 1 }, 'first document parsed');
    t.deepEqual(docs[1], ['b', 'c'], 'final sequence document parsed');
  });
  it('rejects YAML directives outside the core-schema baseline', (t) => {
    t.throws(() => parse('%YAML 1.2\n---\na: 1'), /directive|unexpected|expected/i);
  });
  it('rejects TAG directives outside the core-schema baseline', (t) => {
    t.throws(() => parse('%TAG !e! tag:example.com,2026:\n---\nx: !e!thing value'), /directive|unexpected|expected/i);
  });
});
describe('fino:format/yaml — anchors & aliases', () => {
  it('basic scalar anchor + alias', (t) => {
    const doc = parse('a: &x 1\nb: *x') as any;
    t.equal(doc.a, 1);
    t.equal(doc.b, 1);
  });
  it('alias resolves to shared reference for objects', (t) => {
    const doc = parse('a: &m\n  x: 1\nb: *m') as any;
    t.equal(doc.a.x, 1);
    t.equal(doc.b.x, 1);
    t.ok(doc.a === doc.b, 'shared reference');
  });
  it('alias inside sequence', (t) => {
    const doc = parse('- &v hello\n- *v') as any;
    t.equal(doc[0], 'hello');
    t.equal(doc[1], 'hello');
  });
  it('tag before anchor: !!str &a 42', (t) => {
    const doc = parse('x: !!str &a 42\ny: *a') as any;
    t.equal(typeof doc.x, 'string');
    t.equal(doc.x, '42');
    t.equal(doc.y, '42');
  });
  it('anchor on key binds to key value', (t) => {
    const doc = parse('&k foo: bar') as any;
    t.equal(doc.foo, 'bar');
  });
  it('undefined alias throws', (t) => {
    t.throws(() => parse('x: *nope'), /undefined alias/i);
  });
  it('rejects self-referential aliases instead of constructing cycles', (t) => {
    t.throws(() => parse('x: &x [*x]'), /undefined alias/i);
    t.throws(() => parse('x: &x {self: *x}'), /undefined alias/i);
  });
  it('alias expansion limit exceeded', (t) => {
    const entity = 'a'.repeat(500);
    const refs = Array.from({ length: 10 }, () => '  - *big').join('\n');
    t.throws(() => parse(`big: &big ${entity}\nlist:\n${refs}`, { maxAliasExpansion: 100 }), /alias expansion limit exceeded/i);
  });
  it('anchors are document-scoped across parseAll', (t) => {
    t.throws(() => parseAll('x: &a 1\n---\ny: *a'), /undefined alias/i);
  });
  it('rejects duplicate anchor and tag properties on one node', (t) => {
    t.throws(() => parse('x: &a &b 1'), /duplicate anchor/i);
    t.throws(() => parse('x: !!str !!int 1'), /duplicate tag/i);
  });
});
describe('fino:format/yaml — explicit tags', () => {
  it('!!str coerces number to string', (t) => {
    const doc = parse('n: !!str 42') as any;
    t.equal(typeof doc.n, 'string');
    t.equal(doc.n, '42');
  });
  it('!!int coerces string to integer', (t) => {
    const doc = parse('n: !!int "42"') as any;
    t.equal(doc.n, 42);
  });
  it('!!float coerces string to float', (t) => {
    const doc = parse('n: !!float "3.14"') as any;
    t.ok(Math.abs((doc.n as number) - 3.14) < .001);
  });
  it('!!bool coerces', (t) => {
    t.equal((parse('v: !!bool true') as any).v, true);
    t.equal((parse('v: !!bool false') as any).v, false);
  });
  it('!!null coerces', (t) => {
    t.equal((parse('v: !!null null') as any).v, null);
    t.equal((parse('v: !!null ~') as any).v, null);
  });
  it('!!binary decodes base64 to Uint8Array', (t) => {
    const doc = parse('data: !!binary aGVsbG8=') as any;
    t.ok(doc.data instanceof Uint8Array);
    t.equal(doc.data.length, 5);
    t.equal(new TextDecoder().decode(doc.data), 'hello');
  });
  it('!!timestamp produces Date', (t) => {
    const doc = parse('ts: !!timestamp 2026-05-31T00:00:00.000Z') as any;
    t.ok(doc.ts instanceof Date);
    t.equal(doc.ts.toISOString(), '2026-05-31T00:00:00.000Z');
  });
  it('!!int with invalid value throws', (t) => {
    t.throws(() => parse('n: !!int abc'), /!!int/i);
  });
  it('local tag throws', (t) => {
    t.throws(() => parse('x: !foo bar'), /local tag/i);
  });
  it('unknown core tag throws', (t) => {
    t.throws(() => parse('x: !!nope bar'), /unknown core tag/i);
  });
  it('never constructs arbitrary application objects from tags', (t) => {
    t.throws(() => parse('x: !!ruby/object:User {name: Ada}'), /unknown core tag|local tag/i);
    t.throws(() => parse('x: !<tag:example.com,2026:User> {name: Ada}'), /local tag|expected/i);
  });
});
describe('fino:format/yaml — merge keys', () => {
  it('single merge: <<: *base', (t) => {
    const doc = parse('base: &base\n  x: 1\n  y: 2\nchild:\n  <<: *base\n  z: 3') as any;
    t.equal(doc.child.x, 1);
    t.equal(doc.child.y, 2);
    t.equal(doc.child.z, 3);
  });
  it('local keys override merged', (t) => {
    const doc = parse('base: &base\n  x: 1\nchild:\n  <<: *base\n  x: 99') as any;
    t.equal(doc.child.x, 99);
  });
  it('sequence merge: <<: [*a, *b] — earlier wins', (t) => {
    const doc = parse('a: &a\n  x: 1\nb: &b\n  x: 2\n  y: 3\nc:\n  <<: [*a, *b]') as any;
    t.equal(doc.c.x, 1);
    t.equal(doc.c.y, 3);
  });
  it('merge of non-mapping throws', (t) => {
    t.throws(() => parse('a: &a 42\nb:\n  <<: *a'), /merge value/i);
  });
  it('duplicate << throws', (t) => {
    t.throws(() => parse('base: &base {x: 1}\nchild:\n  <<: *base\n  <<: *base'), /duplicate key/i);
  });
});
describe('fino:format/yaml — complex mapping keys', () => {
  it('? [a, b]: value returns Map with array key', (t) => {
    const doc = parse('? [a, b]\n: value') as any;
    t.ok(doc instanceof Map);
    let found = false;
    for (const [k] of doc) {
      if (Array.isArray(k)) found = true;
    }
    t.ok(found);
  });
  it('? {x: 1}: value returns Map with object key', (t) => {
    const doc = parse('? {x: 1}\n: hello') as any;
    t.ok(doc instanceof Map);
  });
  it('mixing string and complex keys promotes to Map', (t) => {
    const doc = parse('a: 1\n? [c, d]\n: 2') as any;
    t.ok(doc instanceof Map);
    t.equal(doc.get('a'), 1);
  });
  it('string-only keys still return plain object', (t) => {
    const doc = parse('a: 1\nb: 2') as any;
    t.ok(!(doc instanceof Map));
    t.equal(doc.a, 1);
  });
});
describe('fino:format/yaml — stringify Phase 2 types', () => {
  it('stringifies and re-parses Uint8Array via !!binary', (t) => {
    const bytes = new TextEncoder().encode('hello');
    const out = stringify(bytes as any);
    t.ok(out.includes('!!binary'));
    const back = parse(out) as Uint8Array;
    t.ok(back instanceof Uint8Array);
    t.equal(new TextDecoder().decode(back), 'hello');
  });
  it('stringifies and re-parses Date via !!timestamp', (t) => {
    const d = new Date('2026-05-31T00:00:00.000Z');
    const out = stringify(d as any);
    t.ok(out.includes('!!timestamp'));
    const back = parse(out) as Date;
    t.ok(back instanceof Date);
    t.equal(back.toISOString(), d.toISOString());
  });
  it('emits anchors for shared references', (t) => {
    const shared = { x: 1 };
    const out = stringify({
      a: shared,
      b: shared
    } as any);
    t.ok(out.includes('&a'));
    t.ok(out.includes('*a'));
    const back = parse(out) as any;
    t.equal(back.a.x, 1);
    t.equal(back.b.x, 1);
  });
  it('round-trips parsed merge keys while omitting merge syntax', (t) => {
    const source = [
      'base: &base',
      '  x: 1',
      '  y: 2',
      'child:',
      '  <<: *base',
      '  y: 3'
    ].join('\n');
    const parsed = parse(source);
    const out = stringify(parsed as any);
    const reparsed = parse(out);
    t.deepEqual(reparsed, parsed, 'merged mapping survives stringify/parse');
    t.notOk(out.includes('<<'), 'merge key syntax is not re-emitted');
    t.notOk(out.includes('&base'), 'source anchor name is not preserved');
  });
  it('does not preserve comments, document markers, or source anchor names', (t) => {
    const parsed = parse([
      '---',
      '# source comment',
      'shared: &source',
      '  x: 1',
      'again: *source',
      '...'
    ].join('\n'));
    const out = stringify(parsed as any);
    t.notOk(out.includes('# source comment'), 'comments are not emitted');
    t.notOk(out.includes('---'), 'document start marker is not emitted');
    t.notOk(out.includes('...'), 'document end marker is not emitted');
    t.notOk(out.includes('&source'), 'source anchor names are not preserved');
    t.ok(out.includes('&a'), 'shared references use generated anchor names');
    t.deepEqual(parse(out), parsed, 'normalized YAML preserves value graph');
  });
  it('stringifies Map with complex keys', (t) => {
    const m = new Map<unknown, unknown>([[['key'], 'value']]);
    const out = stringify(m as any);
    t.ok(out.includes('?'));
    const back = parse(out) as Map<unknown, unknown>;
    t.ok(back instanceof Map);
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
    t.ok(stringify('true').includes('\'true\'') || stringify('true').includes('"true"'));
  });
  it('serializes mappings', (t) => {
    const out = stringify({
      a: 1,
      b: 'hello'
    });
    t.ok(out.includes('a: 1'));
    t.ok(out.includes('b:'));
  });
  it('serializes sequences', (t) => {
    const out = stringify([
      1,
      2,
      3
    ]);
    t.ok(out.includes('1'));
  });
  it('roundtrips a config-like document', (t) => {
    const original = {
      server: {
        port: 8080,
        host: 'localhost'
      },
      tags: ['a', 'b']
    };
    const yaml = stringify(original as any);
    const parsed = parse(yaml) as typeof original;
    t.equal(parsed.server.port, 8080);
    t.equal(parsed.server.host, 'localhost');
  });
});
const YAML_FIXTURES_DIR = new URL('../fixtures/yaml', import.meta.url).pathname;
const yamlCorpus = await loadCorpus(YAML_FIXTURES_DIR);
const _secFs = new DiskFileSystem();
const _dec = new TextDecoder();
async function _readSecurity(name: string): Promise<string> {
  const f = await _secFs.open(YAML_FIXTURES_DIR + '/security/' + name, 'r');
  const bytes = await f.bytes();
  await f.close();
  return _dec.decode(bytes);
}
const _aliasBombYaml = await _readSecurity('alias_bomb.yaml');
describe('fino:format/yaml — conformance (yaml-test-suite)', () => {
  runCorpus(yamlCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') {
      t.throws(() => parse(c.input));
      return;
    }
    const val = parse(c.input);
    if (c.expected !== 'parse-ok') {
      t.deepEqual(val, c.expected, c.id);
    } else {
      t.ok(true, 'parse succeeded');
    }
  });
});
describe('fino:format/yaml — round-trip (corpus)', () => {
  runCorpus(yamlCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') return;
    const first = parse(c.input);
    const second = parse(stringify(first as any));
    t.deepEqual(second, first, c.id);
  });
});
describe('fino:format/yaml — security', () => {
  it('alias_bomb.yaml exceeds expansion limit with default cap', (t) => {
    t.throws(() => parse(_aliasBombYaml), /alias expansion limit exceeded/i);
  });
  it('alias_bomb.yaml parses with raised limit', (t) => {
    const result = parse(_aliasBombYaml, { maxAliasExpansion: 1e7 }) as any;
    t.ok(Array.isArray(result.e), 'top-level array under raised limit');
  });
});
