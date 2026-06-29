import { describe, it } from 'fino:test/test';
import { parse, stringify, parseStream, type XmlEvent } from 'fino:format/xml';
import { DiskFileSystem } from 'fino:file';
import { loadCorpus, runCorpus, type CorpusCase } from './_corpus.ts';

describe('fino:format/xml — parse basics', () => {
  it('parses a simple element', (t) => {
    const doc = parse('<root/>');
    t.equal(doc.root.name, 'root');
    t.equal(doc.root.children.length, 0);
  });

  it('parses element with text', (t) => {
    const doc = parse('<root>hello</root>');
    t.equal(doc.root.children.length, 1);
    t.equal(doc.root.children[0]!.type, 'text');
    t.equal((doc.root.children[0] as { type: 'text'; data: string }).data, 'hello');
  });

  it('parses nested elements', (t) => {
    const doc = parse('<root><child/></root>');
    t.equal(doc.root.children.length, 1);
    t.equal((doc.root.children[0] as { name: string }).name, 'child');
  });

  it('parses attributes', (t) => {
    const doc = parse('<root id="1" class="x"/>');
    t.equal(doc.root.attributes['id'], '1');
    t.equal(doc.root.attributes['class'], 'x');
  });

  it('parses double and single-quoted attributes', (t) => {
    const doc = parse("<root id='42'/>");
    t.equal(doc.root.attributes['id'], '42');
  });

  it('parses CDATA section', (t) => {
    const doc = parse('<root><![CDATA[<not>xml</not>]]></root>');
    const child = doc.root.children[0]!;
    t.equal(child.type, 'cdata');
    t.equal((child as { type: 'cdata'; data: string }).data, '<not>xml</not>');
  });

  it('parses comment', (t) => {
    const doc = parse('<root><!-- my comment --></root>');
    const child = doc.root.children[0]!;
    t.equal(child.type, 'comment');
  });

  it('parses processing instruction', (t) => {
    const doc = parse('<root><?php echo 1; ?></root>');
    const child = doc.root.children[0]!;
    t.equal(child.type, 'pi');
    t.equal((child as { type: 'pi'; target: string }).target, 'php');
  });

  it('parses entity references', (t) => {
    const doc = parse('<root>&lt;&gt;&amp;&apos;&quot;</root>');
    const text = (doc.root.children[0] as { data: string }).data;
    t.equal(text, '<>&\'"');
  });

  it('parses numeric character references', (t) => {
    const doc = parse('<root>&#65;&#x42;</root>');
    const text = (doc.root.children[0] as { data: string }).data;
    t.equal(text, 'AB');
  });

  it('throws on mismatched tags', (t) => {
    t.throws(() => parse('<a><b></a>'), /mismatched/i);
  });

  it('throws on unclosed element', (t) => {
    t.throws(() => parse('<root>'), /unclosed/i);
  });

  it('throws on undefined entity', (t) => {
    t.throws(() => parse('<root>&undefined;</root>'), /undefined entity/i);
  });
});

describe('fino:format/xml — namespaces', () => {
  it('resolves default namespace', (t) => {
    const doc = parse('<root xmlns="http://example.com"/>');
    t.equal(doc.root.namespace, 'http://example.com');
  });

  it('resolves prefixed namespace', (t) => {
    const doc = parse('<ns:root xmlns:ns="http://example.com"/>');
    t.equal(doc.root.namespace, 'http://example.com');
    t.equal(doc.root.prefix, 'ns');
  });

  it('strips xmlns attributes from element.attributes', (t) => {
    const doc = parse('<root xmlns="http://example.com" id="1"/>');
    t.ok(!('xmlns' in doc.root.attributes));
    t.equal(doc.root.attributes['id'], '1');
  });

  it('respects namespaces:false option', (t) => {
    const doc = parse('<ns:root xmlns:ns="http://example.com"/>', { namespaces: false });
    t.equal(doc.root.name, 'ns:root');
    t.equal(doc.root.namespace, null);
  });

  it('rejects invalid XML names even when namespace processing is disabled', (t) => {
    t.throws(() => parse('<1root/>'), /invalid XML name/i);
    t.throws(() => parse('<root 1attr="x"/>'), /invalid XML name/i);
    t.throws(() => parse('<!DOCTYPE root [<!ENTITY 1bad "x">]><root/>'), /invalid XML name/i);
    t.throws(() => parse('<?1bad data?><root/>'), /invalid XML name/i);
    t.doesNotThrow(() => parse('<ns:root ns:attr="x"/>', { namespaces: false }));
  });

  it('rejects malformed QName tokens when namespace processing is enabled', (t) => {
    t.throws(() => parse('<a:b:c xmlns:a="urn:a"/>'), /invalid QName/i);
    t.throws(() => parse('<root a:b:c="x"/>'), /invalid QName/i);
  });

  it('rejects duplicate raw attributes', (t) => {
    t.throws(() => parse('<root a="1" a="2"/>'), /duplicate attribute/i);
  });

  it('rejects unbound namespace prefixes', (t) => {
    t.throws(() => parse('<x:root/>'), /unbound namespace prefix/i);
    t.throws(() => parse('<root x:a="1"/>'), /unbound namespace prefix/i);
  });

  it('rejects reserved namespace misuse', (t) => {
    t.throws(() => parse('<root xmlns:xml="urn:wrong"/>'), /reserved namespace/i);
    t.throws(() => parse('<root xmlns:p="http:\/\/www.w3.org\/XML\/1998\/namespace"/>'), /reserved namespace/i);
    t.throws(() => parse('<root xmlns:xmlns="urn:x"/>'), /reserved namespace/i);
    t.throws(() => parse('<xmlns:root/>'), /reserved namespace/i);
    t.throws(() => parse('<root xmlns:p=""/>'), /prefix undeclaring/i);
  });

  it('rejects duplicate expanded attribute names', (t) => {
    t.throws(
      () => parse('<root xmlns:a="urn:x" xmlns:b="urn:x" a:id="1" b:id="2"/>'),
      /duplicate attribute/i,
    );
  });

  it('keeps namespace duplicate and reserved-prefix behavior covered as matrix evidence', (t) => {
    t.throws(() => parse('<root xmlns:xml="urn:wrong"/>'), /reserved namespace/i);
    t.throws(() => parse('<root xmlns:p="http:\/\/www.w3.org\/XML\/1998\/namespace"/>'), /reserved namespace/i);
    t.throws(
      () => parse('<root xmlns:a="urn:x" xmlns:b="urn:x" a:id="1" b:id="2"/>'),
      /duplicate attribute/i,
    );
  });

  it('accepts supported XML declaration attributes only at the document start', (t) => {
    t.equal(parse('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root/>').root.name, 'root');
    t.throws(() => parse('<!--lead--><?xml version="1.0"?><root/>'), /xml declaration/i);
    t.throws(() => parse('<root><?xml version="1.0"?></root>'), /xml declaration/i);
    t.throws(() => parse('<root/><?xml version="1.0"?>'), /xml declaration/i);
  });

  it('matches close tags against the full qualified name', (t) => {
    t.throws(() => parse('<a:x xmlns:a="urn:x" xmlns:b="urn:x"></b:x>'), /mismatched close tag/i);
  });

  it('limits self-closing namespace declarations to the empty element itself', (t) => {
    t.throws(() => parse('<root><x:empty xmlns:x="urn:x"/><x:next/></root>'), /unbound namespace prefix/i);
  });
});

describe('fino:format/xml — character validity', () => {
  it('rejects raw invalid XML characters in text', (t) => {
    t.throws(() => parse('<root>ok\u0001bad</root>'), /invalid XML character/i);
  });

  it('rejects raw invalid XML characters in attribute values', (t) => {
    t.throws(() => parse('<root attr="ok\u0001bad"/>'), /invalid XML character/i);
  });

  it('rejects raw invalid XML characters in CDATA', (t) => {
    t.throws(() => parse('<root><![CDATA[ok\u0001bad]]></root>'), /invalid XML character/i);
  });

  it('rejects raw invalid XML characters in comments', (t) => {
    t.throws(() => parse('<root><!-- ok\u0001bad --></root>'), /invalid XML character/i);
  });

  it('rejects raw invalid XML characters in processing instruction data', (t) => {
    t.throws(() => parse('<root><?pi ok\u0001bad?></root>'), /invalid XML character/i);
  });

  it('rejects the CDATA close delimiter in character data', (t) => {
    t.throws(() => parse('<root>not cdata ]]></root>'), /\]\]> not allowed/i);
  });
});

describe('fino:format/xml — security', () => {
  it('rejects external entities by default', (t) => {
    t.throws(
      () => parse('<!DOCTYPE foo [<!ENTITY ext SYSTEM "file:///etc/passwd">]><foo>&ext;</foo>'),
      /external entity rejected/i,
    );
  });

  it('resolveExternalEntities opt-in calls resolver with systemId', (t) => {
    const doc = parse(
      '<!DOCTYPE foo [<!ENTITY ext SYSTEM "file:///data.txt">]><foo>&ext;</foo>',
      { resolveExternalEntities: () => 'resolved-value' },
    );
    t.equal((doc.root.children[0] as { data: string }).data, 'resolved-value');
  });

  it('rejects PUBLIC external entities by default', (t) => {
    t.throws(
      () => parse('<!DOCTYPE foo [<!ENTITY ext PUBLIC "-//FOO//" "http://attacker.example/">]><foo>&ext;</foo>'),
      /external entity rejected/i,
    );
  });

  it('entity expansion limit prevents excessive expansion', (t) => {
    // Each &a; expands to 50 chars; 3 refs × 50 = 150 > maxEntityExpansion:100
    const entity = 'a'.repeat(50);
    const doctype = `<!DOCTYPE lol [<!ENTITY a "${entity}">]>`;
    t.throws(
      () => parse(`${doctype}<root>&a;&a;&a;</root>`, { maxEntityExpansion: 100 }),
      /limit/i,
    );
  });

  it('expands nested internal entities in text', (t) => {
    const doc = parse('<!DOCTYPE r [<!ENTITY a "A"><!ENTITY b "&a;B">]><r>&b;</r>');
    t.equal((doc.root.children[0] as { data: string }).data, 'AB');
  });

  it('expands entity references inside attributes', (t) => {
    const doc = parse('<!DOCTYPE r [<!ENTITY a "A"><!ENTITY b "&a;B">]><r value="&b;"/>');
    t.equal(doc.root.attributes['value'], 'AB');
  });

  it('rejects recursive entity cycles', (t) => {
    t.throws(
      () => parse('<!DOCTYPE r [<!ENTITY a "&b;"><!ENTITY b "&a;">]><r>&a;</r>'),
      /recursive entity/i,
    );
  });

  it('rejects invalid numeric character references', (t) => {
    t.throws(() => parse('<r>&#;</r>'), /invalid character reference/i);
    t.throws(() => parse('<r>&#0;</r>'), /invalid XML character/i);
    t.throws(() => parse('<r>&#xD800;</r>'), /invalid XML character/i);
    t.throws(() => parse('<r>&#x110000;</r>'), /invalid XML character/i);
  });

  it('explicit maxDepth rejects deeply nested input', (t) => {
    t.throws(() => parse('<root><child/></root>', { maxDepth: 1 }), /too deep/i);
  });
});

describe('fino:format/xml — stringify', () => {
  it('serializes a simple document', (t) => {
    const doc = parse('<root id="1"><child>text</child></root>');
    const out = stringify(doc, { xmlDeclaration: false });
    t.ok(out.includes('<root'));
    t.ok(out.includes('id="1"'));
    t.ok(out.includes('<child>'));
    t.ok(out.includes('text'));
    t.ok(out.includes('</root>'));
  });

  it('includes XML declaration by default', (t) => {
    const doc = parse('<root/>');
    const out = stringify(doc);
    t.ok(out.startsWith('<?xml'));
  });

  it('self-closes empty elements', (t) => {
    const doc = parse('<root/>');
    const out = stringify(doc, { xmlDeclaration: false });
    t.ok(out.includes('<root/>'));
  });

  it('escapes special characters in text', (t) => {
    const doc = parse('<root>&lt;hello&gt;</root>');
    const out = stringify(doc, { xmlDeclaration: false });
    t.ok(out.includes('&lt;hello&gt;'));
  });

  it('normalizes entity spelling instead of preserving source text', (t) => {
    const doc = parse('<root>&#60;&lt;&amp;</root>');
    const out = stringify(doc, { xmlDeclaration: false });
    t.equal(out, '<root>&lt;&lt;&amp;</root>');
  });

  it('preserves prefix spelling but does not reconstruct xmlns attributes', (t) => {
    const doc = parse('<ns:root xmlns:ns="urn:test"><ns:child/></ns:root>');
    const out = stringify(doc, { xmlDeclaration: false });
    t.ok(out.includes('<ns:root'));
    t.ok(out.includes('<ns:child/>'));
    t.ok(!out.includes('xmlns:ns='));
  });
});

describe('fino:format/xml — prolog', () => {
  it('skips XML declaration', (t) => {
    const doc = parse('<?xml version="1.0"?><root/>');
    t.equal(doc.root.name, 'root');
  });

  it('handles processing instruction in prolog', (t) => {
    const doc = parse('<?xml-stylesheet type="text/css" href="style.css"?><root/>');
    t.equal(doc.root.name, 'root');
    t.ok(doc.prolog.some(n => n.type === 'pi'));
  });

  it('retains supported prolog nodes for parse output only', (t) => {
    const doc = parse('<?xml-stylesheet href="style.css"?><!--note--><!DOCTYPE root><root/>');
    t.equal(doc.prolog.length, 3);
    t.equal(doc.prolog[0]!.type, 'pi');
    t.equal(doc.prolog[1]!.type, 'comment');
    t.equal(doc.prolog[2]!.type, 'doctype');

    const out = stringify(doc, { xmlDeclaration: false });
    t.equal(out, '<root/>');
  });

  it('accepts trailing comments and processing instructions without retaining them', (t) => {
    const doc = parse('<root/><!--tail--><?after ok?>');
    t.equal(doc.root.name, 'root');
    t.equal(doc.prolog.length, 0);
    t.equal(stringify(doc, { xmlDeclaration: false }), '<root/>');
  });
});

describe('fino:format/xml — parseStream', () => {
  async function xmlChunks(xml: string, sizes: number[]): Promise<AsyncIterable<Uint8Array>> {
    const enc = new TextEncoder();
    const bytes = enc.encode(xml);
    const parts: Uint8Array[] = [];
    let pos = 0;
    for (const sz of sizes) {
      const end = Math.min(pos + sz, bytes.length);
      if (end > pos) parts.push(bytes.subarray(pos, end));
      pos += sz;
    }
    if (pos < bytes.length) parts.push(bytes.subarray(pos));
    return (async function* () { for (const p of parts) yield p; })();
  }

  async function collect(src: AsyncIterable<Uint8Array>, options: Parameters<typeof parseStream>[1] = {}): Promise<XmlEvent[]> {
    const events: XmlEvent[] = [];
    for await (const ev of parseStream(src, options)) events.push(ev);
    return events;
  }

  it('produces correct events for a simple document (one chunk)', async (t) => {
    const xml = '<root id="1"><child>text</child></root>';
    const events = await collect(await xmlChunks(xml, [xml.length]));
    t.equal(events.filter(e => e.type === 'startElement').length, 2);
    t.equal(events.filter(e => e.type === 'endElement').length, 2);
    t.equal(events.filter(e => e.type === 'text').length, 1);
    t.equal((events[0] as { name: string }).name, 'root');
    t.equal((events[0] as { attributes: Record<string, string> }).attributes['id'], '1');
  });

  it('produces same event sequence when split mid-tag-name', async (t) => {
    const xml = '<root><child>hello</child></root>';
    for (const splitAt of [4, 7, 13, 20]) {
      const events = await collect(await xmlChunks(xml, [splitAt]));
      t.equal(events[0]!.type, 'startElement', `split@${splitAt}`);
      t.equal((events[0] as { name: string }).name, 'root', `split@${splitAt}`);
      t.equal(events.filter(e => e.type === 'startElement').length, 2, `split@${splitAt}`);
    }
  });

  it('handles CDATA split across chunk boundary', async (t) => {
    const xml = '<root><![CDATA[hello world]]></root>';
    const events = await collect(await xmlChunks(xml, [10, xml.length - 10]));
    const cdata = events.find(e => e.type === 'cdata') as { type: 'cdata'; data: string } | undefined;
    t.ok(cdata, 'cdata event present');
    t.equal(cdata!.data, 'hello world');
  });

  it('produces correct events for multi-element document across chunks', async (t) => {
    const xml = '<items><item id="1">a</item><item id="2">b</item></items>';
    const events = await collect(await xmlChunks(xml, [8, 20, xml.length - 28]));
    const starts = events.filter(e => e.type === 'startElement') as Array<{ name: string }>;
    t.equal(starts.length, 3);
    t.equal(starts[0]!.name, 'items');
    t.equal(starts[1]!.name, 'item');
    t.equal(starts[2]!.name, 'item');
    t.equal(events.filter(e => e.type === 'text').length, 2);
  });

  it('handles split inside attribute value', async (t) => {
    const xml = '<root attr="long-value-here"/>';
    const events = await collect(await xmlChunks(xml, [15, xml.length - 15]));
    t.equal(events[0]!.type, 'startElement');
    t.equal((events[0] as { attributes: Record<string, string> }).attributes['attr'], 'long-value-here');
  });

  it('throws on malformed XML (mismatched tags) after all chunks', async (t) => {
    const xml = '<root><a></b></root>';
    let threw = false;
    try {
      await collect(await xmlChunks(xml, [8, xml.length - 8]));
    } catch {
      threw = true;
    }
    t.ok(threw, 'malformed XML should throw');
  });

  it('does not emit partial events until a complete document can be reparsed', async (t) => {
    const src = await xmlChunks('<root><child/></root>', [6, 8, 7]);
    const events = await collect(src);
    t.equal(events.map(e => e.type).join(','), 'startElement,startElement,endElement,endElement');
  });
});

const XML_FIXTURES_DIR = new URL('../fixtures/xml', import.meta.url).pathname;
const xmlCorpus = await loadCorpus(XML_FIXTURES_DIR);

describe('fino:format/xml — conformance (xmlconf)', () => {
  runCorpus(xmlCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') {
      t.throws(() => parse(c.input));
      return;
    }
    const doc = parse(c.input);
    t.ok(doc.root !== undefined, 'parse produced a document');
  });
});

describe('fino:format/xml — round-trip (corpus)', () => {
  runCorpus(xmlCorpus, it, (c, t) => {
    if (c.expected === 'parse-err') return;
    const first = parse(c.input);
    const serialized = stringify(first, { xmlDeclaration: false });
    if (first.root.prefix) {
      t.ok(serialized.includes(`<${first.root.prefix}:${first.root.name}`), c.id);
      return;
    }
    const second = parse(serialized);
    t.equal(second.root.name, first.root.name, c.id);
  });
});

describe('fino:format/xml — security fixtures', () => {
  const DEC = new TextDecoder();

  it('large-entity-bomb: expansion accumulator limit fires', async (t) => {
    const f = new DiskFileSystem();
    const file = await f.open(XML_FIXTURES_DIR + '/security/billion_laughs.xml', 'r');
    const bytes = await file.bytes();
    await file.close();
    // 500-char entity × 100 refs = 50K chars > limit of 10K
    t.throws(() => parse(bytes, { maxEntityExpansion: 10_000 }), /limit/i);
  });

  it('quadratic-blowup: entity expansion limit fires', async (t) => {
    const f = new DiskFileSystem();
    const file = await f.open(XML_FIXTURES_DIR + '/security/quadratic_blowup.xml', 'r');
    const bytes = await file.bytes();
    await file.close();
    t.throws(() => parse(bytes, { maxEntityExpansion: 100_000 }), /limit/i);
  });

  it('xxe-file: external entity rejected by default', async (t) => {
    const f = new DiskFileSystem();
    const file = await f.open(XML_FIXTURES_DIR + '/security/xxe_file.xml', 'r');
    const bytes = await file.bytes();
    await file.close();
    t.throws(() => parse(bytes), /external entity rejected/i);
  });

  it('xxe-http: external entity rejected by default', async (t) => {
    const f = new DiskFileSystem();
    const file = await f.open(XML_FIXTURES_DIR + '/security/xxe_http.xml', 'r');
    const bytes = await file.bytes();
    await file.close();
    t.throws(() => parse(bytes), /external entity rejected/i);
  });

  it('deep-nesting: depth limit fires', async (t) => {
    const f = new DiskFileSystem();
    const file = await f.open(XML_FIXTURES_DIR + '/security/deep_nesting.xml', 'r');
    const bytes = await file.bytes();
    await file.close();
    t.throws(() => parse(bytes), /too deep/i);
  });
});
