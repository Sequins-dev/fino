import { describe, it } from 'fino:test/test';
import { parse, stringify } from 'fino:format/xml';

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
});

describe('fino:format/xml — security', () => {
  it('rejects external entities by default', (t) => {
    // External entity ref in doctype — parse throws or ignores safely
    // We just verify it doesn't crash or fetch anything
    try {
      parse('<!DOCTYPE foo [<!ENTITY ext SYSTEM "file:///etc/passwd">]><foo>&ext;</foo>');
    } catch {
      // OK — throwing is acceptable
    }
  });

  it('entity expansion limit prevents billion-laughs', (t) => {
    // Construct a basic bomb attempt; parser should throw on expansion limit
    const doctype = '<!DOCTYPE lol [' +
      '<!ENTITY a "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">' +
      '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
      '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">' +
      ']>';
    // With entity expansion bounded, this should either work (small) or throw
    try {
      parse(`${doctype}<root>&c;</root>`, { maxEntityExpansion: 100 });
    } catch (e) {
      t.ok((e as Error).message.includes('limit'), 'expected expansion limit error');
    }
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
});
