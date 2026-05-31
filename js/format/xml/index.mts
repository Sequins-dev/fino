/**
 * fino:format/xml — XML 1.0 + Namespaces parser and serializer.
 *
 * Well-formedness + Namespaces in XML 1.0. Internal DTD parsing for entity
 * definitions. External entities are **disabled by default** (XXE prevention).
 * Entity expansion is bounded against billion-laughs attacks.
 *
 * Two output surfaces:
 *   - Tree (DOM-lite):  parse(input)  → XmlDocument
 *   - SAX/streaming:   parseStream(src) → AsyncIterableIterator<XmlEvent>
 *
 * @example
 *   import { parse, stringify } from 'fino:format/xml';
 *
 *   const doc = parse('<root attr="v"><child>text</child></root>');
 *   doc.root.name;           // 'root'
 *   doc.root.children[0].type; // 'element'
 *   stringify(doc);
 */

import { Scanner, ParseError } from 'fino:scanner';

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

export class XmlParseError extends ParseError { name = 'XmlParseError'; }

export interface XmlDocument {
  type: 'document';
  root: XmlElement;
  prolog: XmlNode[];   // PIs and comments before root
}

export interface XmlElement {
  type: 'element';
  name: string;
  prefix: string | null;
  namespace: string | null;
  attributes: Record<string, string>;
  children: XmlNode[];
}

export interface XmlText      { type: 'text';   data: string; }
export interface XmlCData     { type: 'cdata';  data: string; }
export interface XmlComment   { type: 'comment'; data: string; }
export interface XmlPI        { type: 'pi';     target: string; data: string; }
export interface XmlDoctype   { type: 'doctype'; data: string; }

export type XmlNode = XmlElement | XmlText | XmlCData | XmlComment | XmlPI | XmlDoctype;

// SAX events
export type XmlEvent =
  | { type: 'startElement'; name: string; prefix: string | null; namespace: string | null; attributes: Record<string, string> }
  | { type: 'endElement';   name: string }
  | { type: 'text';         data: string }
  | { type: 'cdata';        data: string }
  | { type: 'comment';      data: string }
  | { type: 'pi';           target: string; data: string };

export interface XmlParseOptions {
  namespaces?: boolean;            // default true
  trim?: boolean;                  // trim text nodes
  maxEntityExpansion?: number;     // default 1_000_000
  maxDepth?: number;               // default 500
  resolveExternalEntities?: ((systemId: string) => string | null) | null;
}

export interface XmlStringifyOptions {
  indent?: string;
  xmlDeclaration?: boolean;
}

// ---------------------------------------------------------------------------
// Parse (tree)
// ---------------------------------------------------------------------------

export function parse(input: string | Uint8Array, options: XmlParseOptions = {}): XmlDocument {
  return new XmlParser(input, options).parseDocument();
}

// ---------------------------------------------------------------------------
// Parse stream (SAX)
// ---------------------------------------------------------------------------

export async function* parseStream(
  src: AsyncIterable<Uint8Array>,
  options: XmlParseOptions = {},
): AsyncIterableIterator<XmlEvent> {
  let accum = new Uint8Array(0);
  // Events already yielded to the caller. On each re-parse attempt we skip
  // this many events at the front (they were yielded in a previous iteration
  // before the parser stalled at an incomplete chunk boundary).
  let yieldedCount = 0;

  for await (const chunk of src) {
    const merged = new Uint8Array(accum.length + chunk.length);
    merged.set(accum, 0);
    merged.set(chunk, accum.length);
    accum = merged;

    let i = 0;
    try {
      for (const event of new XmlParser(accum, options).events()) {
        if (i++ >= yieldedCount) yield event;
      }
      return; // parser reached natural end-of-document
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      // Parser stalled — likely an incomplete token at the chunk boundary.
      // Record how many events were emitted before the stall; skip them on
      // the next attempt once more data arrives.
      yieldedCount = i;
    }
  }

  // Source exhausted — parse the final accumulated buffer. Any error here is
  // a genuine parse error (not a chunk-boundary truncation).
  let i = 0;
  for (const event of new XmlParser(accum, options).events()) {
    if (i++ >= yieldedCount) yield event;
  }
}

// ---------------------------------------------------------------------------
// XmlParser
// ---------------------------------------------------------------------------

const MAX_ENTITY_EXPANSION = 1_000_000;
const MAX_DEPTH = 500;

const _PREDEF: Record<string, string> = {
  lt: '<', gt: '>', amp: '&', apos: "'", quot: '"',
};

const _NS_XMLNS = 'http://www.w3.org/2000/xmlns/';
const _NS_XML   = 'http://www.w3.org/XML/1998/namespace';

class XmlParser {
  #sc: Scanner;
  #opts: XmlParseOptions;
  #entities: Record<string, string> = Object.create(_PREDEF);
  #expandedChars = 0;
  #depth = 0;
  #nsStack: Record<string, string>[] = [{ xml: _NS_XML, xmlns: _NS_XMLNS }];

  constructor(src: string | Uint8Array, opts: XmlParseOptions) {
    this.#opts = opts;
    this.#sc = new Scanner(src, { encoding: 'utf-8', format: 'xml' });
  }

  parseDocument(): XmlDocument {
    const prolog: XmlNode[] = [];
    const sc = this.#sc;
    let root: XmlElement | null = null;

    while (!sc.done) {
      sc.skipWhitespace();
      if (sc.done) break;
      if (!sc.match('<')) throw sc.error('expected <');
      const next = sc.peek();
      if (next === '?') {
        const pi = this.#parsePI();
        // Skip XML declaration
        if (pi.target.toLowerCase() !== 'xml') prolog.push(pi);
      } else if (next === '!' && sc.peekCode(1) === 0x2D && sc.peekCode(2) === 0x2D) {
        prolog.push(this.#parseComment());
      } else if (next === '!' && sc.peek(8) === '!DOCTYPE') {
        prolog.push(this.#parseDoctype());
      } else {
        root = this.#parseElement();
        break;
      }
    }

    if (!root) throw sc.error('no root element');
    sc.skipWhitespace();
    if (!sc.done) {
      // Allow comments/PIs after root
      while (!sc.done) {
        sc.skipWhitespace();
        if (sc.done) break;
        if (sc.match('<')) {
          if (sc.peek() === '?' || (sc.peek() === '!' && sc.peekCode(1) === 0x2D)) {
            if (sc.peek() === '?') this.#parsePI();
            else this.#parseComment();
          } else {
            throw sc.error('content after root element');
          }
        } else {
          throw sc.error('content after root element');
        }
      }
    }

    return { type: 'document', root, prolog };
  }

  *events(): Generator<XmlEvent, void> {
    const sc = this.#sc;
    // Skip prolog
    while (!sc.done) {
      sc.skipWhitespace();
      if (sc.done) break;
      if (sc.match('<')) {
        const next = sc.peek();
        if (next === '?') { this.#parsePI(); continue; }
        if (next === '!' && sc.peekCode(1) === 0x2D) { this.#parseComment(); continue; }
        if (sc.peek(8) === '!DOCTYPE') { this.#parseDoctype(); continue; }
        break;
      }
      break;
    }
    yield* this.#elementEvents();
  }

  *#elementEvents(): Generator<XmlEvent, void> {
    const sc = this.#sc;
    const { name, prefix, ns, attrs, selfClose } = this.#parseStartTag();

    yield { type: 'startElement', name, prefix: prefix ?? null, namespace: ns ?? null, attributes: attrs };

    if (!selfClose) {
      yield* this.#childEvents(name);
    }
    yield { type: 'endElement', name };
  }

  *#childEvents(parentName: string): Generator<XmlEvent, void> {
    const sc = this.#sc;
    while (!sc.done) {
      if (!sc.match('<')) {
        // Text
        const text = this.#parseCharData();
        if (text) yield { type: 'text', data: text };
        continue;
      }
      const next = sc.peek();
      if (next === '/') {
        sc.eat(); // consume /
        const closeName = sc.eatWhile(c => c !== 0x3E);
        sc.expect('>');
        if (closeName !== parentName) throw sc.error(`mismatched close tag: expected </${parentName}>, got </${closeName}>`);
        return;
      }
      if (next === '!' && sc.peekCode(1) === 0x5B) {
        yield { type: 'cdata', data: this.#parseCData() };
      } else if (next === '!' && sc.peekCode(1) === 0x2D) {
        yield { type: 'comment', data: this.#parseComment().data };
      } else if (next === '?') {
        const pi = this.#parsePI();
        yield { type: 'pi', target: pi.target, data: pi.data };
      } else {
        yield* this.#elementEvents();
      }
    }
    throw sc.error(`unclosed element <${parentName}>`);
  }

  #parseElement(): XmlElement {
    const { name, prefix, ns, attrs, selfClose } = this.#parseStartTag();
    if (++this.#depth > (this.#opts.maxDepth ?? MAX_DEPTH)) throw this.#sc.error('element nesting too deep');
    const children: XmlNode[] = [];
    if (!selfClose) {
      this.#parseChildren(name, children);
    }
    this.#depth--;
    return { type: 'element', name, prefix: prefix ?? null, namespace: ns ?? null, attributes: attrs, children };
  }

  #parseStartTag() {
    const sc = this.#sc;
    const useNs = this.#opts.namespaces !== false;
    const nsFrame: Record<string, string> = {};

    const name = sc.eatWhile(c => c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x2F && c !== 0x3E);
    if (!name) throw sc.error('expected element name');

    const attrs: Record<string, string> = {};
    const rawAttrs: Record<string, string> = {};

    // Parse attributes
    while (!sc.done) {
      sc.skipWhitespace();
      const ch = sc.peek();
      if (ch === '/' || ch === '>') break;
      const aname = sc.eatWhile(c => c !== 0x3D && c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x2F && c !== 0x3E);
      if (!aname) break;
      sc.skipWhitespace();
      sc.expect('=');
      sc.skipWhitespace();
      const q = sc.eat();
      if (q !== '"' && q !== "'") throw sc.error('expected quote for attribute value');
      let val = '';
      while (!sc.done && sc.peek() !== q) {
        val += this.#parseAttrChar(sc, q);
      }
      sc.expect(q);
      rawAttrs[aname] = val;
      if (useNs && aname === 'xmlns') nsFrame[''] = val;
      else if (useNs && aname.startsWith('xmlns:')) nsFrame[aname.slice(6)] = val;
    }

    const selfClose = sc.eatChar('/');
    sc.expect('>');

    // Build namespace map
    if (useNs && Object.keys(nsFrame).length > 0) {
      this.#nsStack.push({ ...this.#nsStack[this.#nsStack.length - 1]!, ...nsFrame });
    }

    // Resolve element namespace
    const [elemPrefix, localName] = _splitName(name);
    const nsMap = this.#nsStack[this.#nsStack.length - 1]!;
    const ns = useNs ? (elemPrefix ? (nsMap[elemPrefix] ?? null) : (nsMap[''] ?? null)) : null;

    // Resolve attribute namespaces and populate attrs
    for (const [aname, val] of Object.entries(rawAttrs)) {
      if (useNs && (aname === 'xmlns' || aname.startsWith('xmlns:'))) continue;
      attrs[aname] = val;
    }

    return { name: useNs ? localName : name, prefix: useNs ? elemPrefix : null, ns, attrs, selfClose };
  }

  #parseChildren(parentName: string, children: XmlNode[]): void {
    const sc = this.#sc;
    const useNs = this.#opts.namespaces !== false;
    while (!sc.done) {
      if (!sc.match('<')) {
        const text = this.#parseCharData();
        if (text) {
          const t = this.#opts.trim ? text.trim() : text;
          if (t) children.push({ type: 'text', data: t });
        }
        continue;
      }
      const next = sc.peek();
      if (next === '/') {
        sc.eat();
        const closeName = sc.eatWhile(c => c !== 0x3E);
        sc.expect('>');
        const [, closeLocal] = _splitName(closeName);
        const [, parentLocal] = _splitName(parentName);
        if ((useNs ? closeLocal : closeName) !== (useNs ? parentLocal : parentName)) {
          throw sc.error(`mismatched close tag: expected </${parentName}>, got </${closeName}>`);
        }
        if (useNs && this.#nsStack.length > 1) this.#nsStack.pop();
        return;
      }
      if (next === '!' && sc.peekCode(1) === 0x5B) {
        const cdata = this.#parseCData();
        children.push({ type: 'cdata', data: cdata });
      } else if (next === '!' && sc.peekCode(1) === 0x2D) {
        children.push(this.#parseComment());
      } else if (next === '?') {
        children.push(this.#parsePI());
      } else {
        children.push(this.#parseElement());
      }
    }
    throw sc.error(`unclosed element <${parentName}>`);
  }

  #parseCharData(): string {
    const sc = this.#sc;
    let s = '';
    while (!sc.done && sc.peek() !== '<') {
      if (sc.peek() === '&') { s += this.#parseEntityRef(); continue; }
      s += sc.eat();
    }
    return s;
  }

  #parseAttrChar(sc: Scanner, quote: string): string {
    if (sc.peek() === '&') return this.#parseEntityRef();
    const ch = sc.eat();
    if (ch === '<') throw sc.error('< not allowed in attribute value');
    return ch;
  }

  #parseEntityRef(): string {
    const sc = this.#sc;
    sc.expect('&');
    if (sc.eatChar('#')) {
      let hex = false;
      if (sc.eatChar('x')) hex = true;
      const digits = sc.eatWhile(c => hex
        ? (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
        : (c >= 0x30 && c <= 0x39));
      sc.expect(';');
      const cp = parseInt(digits, hex ? 16 : 10);
      this.#expandedChars++;
      if (this.#expandedChars > (this.#opts.maxEntityExpansion ?? MAX_ENTITY_EXPANSION)) {
        throw sc.error('entity expansion limit exceeded');
      }
      return String.fromCodePoint(cp);
    }
    const name = sc.eatWhile(c => c !== 0x3B);
    sc.expect(';');
    if (name in _PREDEF) return _PREDEF[name]!;
    if (name in this.#entities) {
      const expanded = this.#entities[name]!;
      this.#expandedChars += expanded.length;
      if (this.#expandedChars > (this.#opts.maxEntityExpansion ?? MAX_ENTITY_EXPANSION)) {
        throw sc.error('entity expansion limit exceeded');
      }
      return expanded;
    }
    throw sc.error(`undefined entity: &${name};`);
  }

  #parseCData(): string {
    const sc = this.#sc;
    sc.match('![CDATA[');
    let s = '';
    while (!sc.done) {
      if (sc.match(']]>')) return s;
      s += sc.eat();
    }
    throw sc.error('unterminated CDATA section');
  }

  #parseComment(): XmlComment {
    const sc = this.#sc;
    sc.match('!--');
    let s = '';
    while (!sc.done) {
      if (sc.match('-->')) return { type: 'comment', data: s };
      if (sc.peek() === '-' && sc.peekCode(1) === 0x2D) throw sc.error('-- not allowed inside comment');
      s += sc.eat();
    }
    throw sc.error('unterminated comment');
  }

  #parsePI(): XmlPI {
    const sc = this.#sc;
    sc.expect('?');
    const target = sc.eatWhile(c => c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x3F && c !== 0x3E);
    if (target.toLowerCase() === 'xml' && !this.#sc.done) {
      // XML declaration — consume it
      const decl = sc.eatWhile(c => c !== 0x3F);
      sc.match('?>');
      return { type: 'pi', target, data: decl.trim() };
    }
    sc.skipWhitespace();
    const data = sc.eatWhile(c => !(c === 0x3F && sc.peekCode(1) === 0x3E));
    sc.match('?>');
    return { type: 'pi', target, data: data.trim() };
  }

  #parseDoctype(): XmlDoctype {
    const sc = this.#sc;
    sc.match('!DOCTYPE');
    sc.skipWhitespace();
    let depth = 0;
    let s = '';
    while (!sc.done) {
      const ch = sc.eat();
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === '>' && depth === 0) break;
      s += ch;

      // Parse entity definitions from internal DTD subset
      if (s.endsWith('<!ENTITY')) {
        const entityMark = sc.mark();
        sc.skipWhitespace();
        const ename = sc.eatWhile(c => c !== 0x20 && c !== 0x09 && c !== 0x0A);
        sc.skipWhitespace();

        if (sc.peek() === '"' || sc.peek() === "'") {
          // Internal entity definition
          const q = sc.eat();
          let val = '';
          while (!sc.done && sc.peek() !== q) val += sc.eat();
          sc.expect(q);
          sc.skipWhitespace();
          sc.expect('>');
          if (!(ename in _PREDEF)) this.#entities[ename] = val;
        } else if (sc.match('SYSTEM') || sc.match('PUBLIC')) {
          // External entity — consume the identifier(s) then reject or resolve
          sc.skipWhitespace();
          let firstId = '';
          if (sc.peek() === '"' || sc.peek() === "'") {
            const q = sc.eat();
            firstId = sc.eatUntil(c => c === q.charCodeAt(0));
            sc.expect(q);
          }
          // PUBLIC has two identifiers; second is the system ID
          sc.skipWhitespace();
          let systemId = firstId;
          if (sc.peek() === '"' || sc.peek() === "'") {
            const q = sc.eat();
            systemId = sc.eatUntil(c => c === q.charCodeAt(0));
            sc.expect(q);
          }
          sc.skipWhitespace();
          sc.expect('>');

          const resolver = this.#opts.resolveExternalEntities;
          if (typeof resolver === 'function') {
            const val = resolver(systemId);
            if (val !== null && !(ename in _PREDEF)) this.#entities[ename] = val;
          } else {
            throw sc.error(
              `external entity rejected: ${ename} (set resolveExternalEntities to opt in)`,
              entityMark,
            );
          }
        }
        s += ename;
      }
    }
    return { type: 'doctype', data: s.trim() };
  }
}

function _splitName(name: string): [string | null, string] {
  const i = name.indexOf(':');
  if (i === -1) return [null, name];
  return [name.slice(0, i), name.slice(i + 1)];
}

// ---------------------------------------------------------------------------
// Stringify
// ---------------------------------------------------------------------------

export function stringify(doc: XmlDocument, options: XmlStringifyOptions = {}): string {
  const indent = options.indent ?? '';
  let out = '';
  if (options.xmlDeclaration !== false) out = '<?xml version="1.0" encoding="UTF-8"?>\n';
  out += stringifyNode(doc.root, indent, 0);
  return out;
}

function stringifyNode(node: XmlNode, indent: string, depth: number): string {
  const pad = indent.repeat(depth);
  switch (node.type) {
    case 'element': return stringifyElement(node, indent, depth);
    case 'text':    return pad + _escapeText(node.data);
    case 'cdata':   return `${pad}<![CDATA[${node.data}]]>`;
    case 'comment': return `${pad}<!--${node.data}-->`;
    case 'pi':      return `${pad}<?${node.target}${node.data ? ' ' + node.data : ''}?>`;
    case 'doctype': return `${pad}<!DOCTYPE ${node.data}>`;
  }
}

function stringifyElement(el: XmlElement, indent: string, depth: number): string {
  const pad = indent.repeat(depth);
  const nameStr = el.prefix ? `${el.prefix}:${el.name}` : el.name;
  const attrs = Object.entries(el.attributes)
    .map(([k, v]) => ` ${k}="${_escapeAttr(v)}"`)
    .join('');
  if (el.children.length === 0) return `${pad}<${nameStr}${attrs}/>`;
  const childStr = el.children.map(c => stringifyNode(c, indent, depth + 1)).join(indent ? '\n' : '');
  const inner = indent ? `\n${childStr}\n${pad}` : childStr;
  return `${pad}<${nameStr}${attrs}>${inner}</${nameStr}>`;
}

function _escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
