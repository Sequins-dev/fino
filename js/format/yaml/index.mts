/**
 * fino:format/yaml — YAML 1.2 core schema parser and serializer (Phase 1).
 *
 * Supports the pragmatic 95% subset:
 *   - Block mappings and sequences (indentation-driven)
 *   - Flow mappings {} and sequences []
 *   - Scalars: plain, single-quoted, double-quoted, block literal | and folded >
 *   - Core schema type resolution (null/~, booleans, ints, floats, strings)
 *   - Comments, document markers --- / ..., parseAll for multi-document streams
 *
 * **Permanently excluded** (security baseline — never executes code):
 *   - Arbitrary type construction (!!ruby/object, etc.)
 *   - Custom tags / type coercion via !!
 *
 * **Deferred to Phase 2** (rejected with a clear error, not silently mis-parsed):
 *   - Anchors & aliases (&anchor, *alias)
 *   - Explicit tags (!!str, !<tag:…>)
 *   - Merge keys (<<)
 *   - Complex mapping keys (? key)
 *
 * @example
 *   import { parse, stringify, parseAll } from 'fino:format/yaml';
 *
 *   const cfg = parse('server:\n  port: 8080\nhosts:\n  - a\n  - b\n');
 *   stringify({ x: 1, y: [2, 3] });
 */

import { YamlParseError } from '../_error.mts';
import { decodeUtf8 } from '../../internal/globals/encoding.mts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type YamlValue = null | boolean | number | string | YamlValue[] | YamlMapping;
export type YamlMapping = { [k: string]: YamlValue };

export interface YamlParseOptions {
  allowDuplicateKeys?: boolean;
}

export interface YamlStringifyOptions {
  indent?: number;
  lineWidth?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse a YAML document (first document if there are multiple). */
export function parse(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue {
  const src = typeof input === 'string' ? input : decodeUtf8(input, true, true);
  const docs = new YamlParser(src, options).parseAll();
  return docs[0] ?? null;
}

/** Parse all YAML documents from a multi-document stream. */
export function parseAll(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue[] {
  const src = typeof input === 'string' ? input : decodeUtf8(input, true, true);
  return new YamlParser(src, options).parseAll();
}

/** Serialize a value to YAML. */
export function stringify(value: YamlValue, options: YamlStringifyOptions = {}): string {
  const indent = options.indent ?? 2;
  return new YamlStringifier(indent).stringify(value);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class YamlParser {
  #src: string;
  #pos: number = 0;
  #line: number = 1;
  #opts: YamlParseOptions;

  constructor(src: string, opts: YamlParseOptions) {
    this.#src = src;
    this.#opts = opts;
  }

  parseAll(): YamlValue[] {
    const docs: YamlValue[] = [];
    this.#skipDocumentMarkers();
    while (this.#pos < this.#src.length) {
      const doc = this.#parseDocument();
      docs.push(doc);
      this.#skipDocumentMarkers();
    }
    return docs;
  }

  #err(msg: string): never {
    const snippet = this.#src.slice(Math.max(0, this.#pos - 20), this.#pos + 20).replace(/\n/g, '↵');
    throw new YamlParseError(msg, this.#line, this.#col(), this.#pos, snippet);
  }

  #col(): number {
    let col = 1;
    for (let i = this.#pos - 1; i >= 0 && this.#src[i] !== '\n'; i--) col++;
    return col;
  }

  // Column of the current position (0-indexed spaces from last newline).
  #currentCol(): number {
    let i = this.#pos;
    while (i > 0 && this.#src[i - 1] !== '\n') i--;
    return this.#pos - i;
  }

  #peek(n = 0): string { return this.#src[this.#pos + n] ?? ''; }
  #eat(): string {
    const ch = this.#src[this.#pos]!;
    if (ch === '\n') this.#line++;
    this.#pos++;
    return ch;
  }

  #atEnd(): boolean { return this.#pos >= this.#src.length; }

  #skipSpaces(): void {
    while (this.#pos < this.#src.length && (this.#src[this.#pos] === ' ' || this.#src[this.#pos] === '\t')) {
      this.#pos++;
    }
  }

  #skipLine(): void {
    while (this.#pos < this.#src.length && this.#src[this.#pos] !== '\n') this.#pos++;
    if (this.#pos < this.#src.length) { this.#line++; this.#pos++; }
  }

  #skipComment(): void {
    if (this.#src[this.#pos] === '#') this.#skipLine();
  }

  #skipWsAndComments(): void {
    while (this.#pos < this.#src.length) {
      const ch = this.#src[this.#pos]!;
      if (ch === ' ' || ch === '\t') { this.#pos++; continue; }
      if (ch === '\n') { this.#line++; this.#pos++; continue; }
      if (ch === '\r' && this.#src[this.#pos + 1] === '\n') { this.#line++; this.#pos += 2; continue; }
      if (ch === '#') { this.#skipLine(); continue; }
      break;
    }
  }

  // Leading-space indent of the current line (for detecting dedent after block).
  #lineIndent(): number {
    let i = this.#pos;
    while (i > 0 && this.#src[i - 1] !== '\n') i--;
    let col = 0;
    while (i + col < this.#src.length && this.#src[i + col] === ' ') col++;
    return col;
  }

  #skipDocumentMarkers(): void {
    this.#skipWsAndComments();
    while (this.#pos < this.#src.length) {
      if (this.#src.startsWith('---', this.#pos) &&
          (this.#src[this.#pos + 3] === '\n' || this.#src[this.#pos + 3] === ' ' || !this.#src[this.#pos + 3])) {
        this.#pos += 3; this.#skipLine(); this.#skipWsAndComments(); continue;
      }
      if (this.#src.startsWith('...', this.#pos) &&
          (this.#src[this.#pos + 3] === '\n' || this.#src[this.#pos + 3] === ' ' || !this.#src[this.#pos + 3])) {
        this.#pos += 3; this.#skipLine(); this.#skipWsAndComments(); continue;
      }
      break;
    }
  }

  #parseDocument(): YamlValue {
    this.#skipWsAndComments();
    if (this.#atEnd()) return null;
    return this.#parseValue(0, false);
  }

  #parseValue(indent: number, inFlow: boolean): YamlValue {
    this.#skipSpaces();
    if (this.#atEnd()) return null;
    const ch = this.#peek();

    // Phase 2 unsupported features — reject clearly
    if (ch === '&') this.#err('unsupported YAML feature: anchors (planned for Phase 2)');
    if (ch === '*') this.#err('unsupported YAML feature: aliases (planned for Phase 2)');
    if (ch === '!') this.#err('unsupported YAML feature: explicit tags (planned for Phase 2)');
    if (ch === '?') this.#err('unsupported YAML feature: complex mapping keys (planned for Phase 2)');
    if (ch === '<' && this.#peek(1) === '<') this.#err('unsupported YAML feature: merge keys (planned for Phase 2)');

    if (ch === '-' && this.#peek(1) === ' ' && !inFlow) return this.#parseBlockSeq(indent);
    if (ch === '[') return this.#parseFlowSeq();
    if (ch === '{') return this.#parseFlowMap();
    if (ch === '|') return this.#parseBlockScalar(indent, 'literal');
    if (ch === '>') return this.#parseBlockScalar(indent, 'folded');
    if (ch === "'") return this.#parseSingleQuoted();
    if (ch === '"') return this.#parseDoubleQuoted();

    // Check for block mapping — only valid in block context
    const colonPos = (!inFlow) ? this.#findBlockMappingColon(indent) : -1;
    if (colonPos !== -1) return this.#parseBlockMap(indent);

    return this.#parsePlainScalar(inFlow);
  }

  #findBlockMappingColon(indent: number): number {
    // Look ahead to see if there's a ': ' or ':\n' at the current line
    let i = this.#pos;
    while (i < this.#src.length) {
      const c = this.#src[i]!;
      if (c === '\n' || c === '\r') return -1;
      if (c === ':' && (this.#src[i + 1] === ' ' || this.#src[i + 1] === '\n' || !this.#src[i + 1])) return i;
      if (c === '"' || c === "'") {
        // Skip quoted string
        const q = c; i++;
        while (i < this.#src.length && this.#src[i] !== q) {
          if (this.#src[i] === '\\' && q === '"') i++;
          i++;
        }
        i++; // closing quote
        continue;
      }
      i++;
    }
    return -1;
  }

  #parseBlockMap(indent: number): YamlMapping {
    const map: YamlMapping = {};
    while (!this.#atEnd()) {
      this.#skipWsAndComments();
      if (this.#atEnd()) break;
      const colIndent = this.#currentCol();
      if (colIndent < indent) break;
      if (this.#src.startsWith('---', this.#pos) || this.#src.startsWith('...', this.#pos)) break;

      // key
      this.#skipSpaces();
      const key = this.#parseKey();
      this.#skipSpaces();
      if (!this.#src.startsWith(': ', this.#pos) && this.#src[this.#pos] !== ':') {
        this.#err('expected ": " after mapping key');
      }
      this.#pos++; // consume :
      if (this.#src[this.#pos] === ' ') this.#pos++; // consume space

      if (!this.#opts.allowDuplicateKeys && key in map) this.#err(`duplicate key: ${key}`);

      // value
      this.#skipSpaces();
      let value: YamlValue;
      if (this.#src[this.#pos] === '\n' || this.#src[this.#pos] === '\r' || this.#atEnd()) {
        // Value on next line(s)
        this.#skipWsAndComments();
        if (this.#atEnd()) { map[key] = null; break; }
        const nextIndent = this.#lineIndent();
        if (nextIndent <= colIndent) { map[key] = null; continue; }
        value = this.#parseValue(nextIndent, false);
      } else {
        value = this.#parseValue(colIndent, false);
        this.#skipSpaces();
        this.#skipComment();
      }
      map[key] = value;
    }
    return map;
  }

  #parseKey(): string {
    const ch = this.#peek();
    if (ch === "'") return this.#parseSingleQuoted() as string;
    if (ch === '"') return this.#parseDoubleQuoted() as string;
    // Plain key — read until ': '
    const start = this.#pos;
    while (this.#pos < this.#src.length) {
      const c = this.#src[this.#pos]!;
      if (c === '\n' || c === '\r') break;
      if (c === ':' && (this.#src[this.#pos + 1] === ' ' || this.#src[this.#pos + 1] === '\n' || !this.#src[this.#pos + 1])) break;
      this.#pos++;
    }
    return this.#src.slice(start, this.#pos).trim();
  }

  #parseBlockSeq(indent: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (!this.#atEnd()) {
      this.#skipWsAndComments();
      if (this.#atEnd()) break;
      const colIndent = this.#currentCol();
      if (colIndent < indent) break;
      if (this.#src.startsWith('---', this.#pos) || this.#src.startsWith('...', this.#pos)) break;
      this.#skipSpaces();
      if (this.#src[this.#pos] !== '-') break;
      if (this.#src[this.#pos + 1] !== ' ' && this.#src[this.#pos + 1] !== '\n') break;
      this.#pos++; // consume -
      if (this.#src[this.#pos] === ' ') this.#pos++; // consume space

      let value: YamlValue;
      this.#skipSpaces();
      if (this.#src[this.#pos] === '\n' || this.#src[this.#pos] === '\r' || this.#atEnd()) {
        this.#skipWsAndComments();
        const nextIndent = this.#lineIndent();
        value = this.#atEnd() ? null : this.#parseValue(nextIndent, false);
      } else {
        // Inline value: use current column as indent for sub-structure
        const inlineIndent = this.#currentCol();
        value = this.#parseValue(inlineIndent, false);
        this.#skipSpaces();
        this.#skipComment();
      }
      arr.push(value);
    }
    return arr;
  }

  #parseFlowSeq(): YamlValue[] {
    this.#pos++; // [
    const arr: YamlValue[] = [];
    this.#skipWsAndComments();
    if (this.#src[this.#pos] === ']') { this.#pos++; return arr; }
    while (!this.#atEnd()) {
      this.#skipWsAndComments();
      arr.push(this.#parseValue(0, true));
      this.#skipWsAndComments();
      if (this.#src[this.#pos] === ',') { this.#pos++; continue; }
      if (this.#src[this.#pos] === ']') { this.#pos++; return arr; }
      this.#err('expected ] or , in flow sequence');
    }
    this.#err('unterminated flow sequence');
  }

  #parseFlowMap(): YamlMapping {
    this.#pos++; // {
    const map: YamlMapping = {};
    this.#skipWsAndComments();
    if (this.#src[this.#pos] === '}') { this.#pos++; return map; }
    while (!this.#atEnd()) {
      this.#skipWsAndComments();
      const key = this.#parseKey();
      this.#skipWsAndComments();
      if (this.#src[this.#pos] === ':') this.#pos++;
      this.#skipSpaces();
      const value = this.#parseValue(0, true);
      if (!this.#opts.allowDuplicateKeys && key in map) this.#err(`duplicate key: ${key}`);
      map[key] = value;
      this.#skipWsAndComments();
      if (this.#src[this.#pos] === ',') { this.#pos++; continue; }
      if (this.#src[this.#pos] === '}') { this.#pos++; return map; }
      this.#err('expected } or , in flow mapping');
    }
    this.#err('unterminated flow mapping');
  }

  #parseBlockScalar(indent: number, style: 'literal' | 'folded'): string {
    this.#pos++; // | or >
    // Optional chomping indicator (- or +) and indentation indicator
    let chomp: 'strip' | 'clip' | 'keep' = 'clip';
    let explicitIndent = 0;
    while (!this.#atEnd() && this.#src[this.#pos] !== '\n') {
      const ch = this.#src[this.#pos]!;
      if (ch === '-') { chomp = 'strip'; this.#pos++; }
      else if (ch === '+') { chomp = 'keep'; this.#pos++; }
      else if (ch >= '1' && ch <= '9') { explicitIndent = parseInt(ch, 10); this.#pos++; }
      else this.#pos++;
    }
    if (!this.#atEnd()) { this.#line++; this.#pos++; } // consume newline

    // Determine indent
    const lines: string[] = [];
    let blockIndent = -1;
    let trailingEmpty = 0;

    while (!this.#atEnd()) {
      // Count leading spaces
      let spaces = 0;
      const lineStart = this.#pos;
      while (this.#pos < this.#src.length && this.#src[this.#pos] === ' ') { spaces++; this.#pos++; }
      if (this.#src[this.#pos] === '\n' || this.#src[this.#pos] === '\r' || this.#atEnd()) {
        lines.push('');
        if (!this.#atEnd()) { this.#line++; this.#pos++; }
        trailingEmpty++;
        continue;
      }
      if (blockIndent === -1) blockIndent = explicitIndent || spaces;
      if (spaces < blockIndent) { this.#pos = lineStart; break; }

      const content = spaces - blockIndent;
      let line = ' '.repeat(content);
      while (!this.#atEnd() && this.#src[this.#pos] !== '\n' && this.#src[this.#pos] !== '\r') {
        line += this.#src[this.#pos]!;
        this.#pos++;
      }
      if (!this.#atEnd()) { this.#line++; this.#pos++; }
      lines.push(line);
      trailingEmpty = 0;
    }

    // Build result
    let result: string;
    if (style === 'literal') {
      result = lines.join('\n');
    } else {
      // Folded: join non-empty lines with space, empty lines with newlines
      const parts: string[] = [];
      let pending = '';
      for (const line of lines) {
        if (line === '') {
          if (pending) { parts.push(pending); pending = ''; }
          parts.push('');
        } else {
          pending = pending ? pending + ' ' + line : line;
        }
      }
      if (pending) parts.push(pending);
      result = parts.join('\n');
    }

    // Chomping
    if (chomp === 'strip') result = result.replace(/\n+$/, '');
    else if (chomp === 'clip') result = result.replace(/\n+$/, '') + '\n';
    // keep: leave trailing newlines as-is

    return result;
  }

  #parseSingleQuoted(): string {
    this.#pos++; // '
    let s = '';
    while (this.#pos < this.#src.length) {
      const ch = this.#src[this.#pos]!;
      if (ch === "'") {
        this.#pos++;
        if (this.#src[this.#pos] === "'") { s += "'"; this.#pos++; continue; }
        return s;
      }
      if (ch === '\n') this.#line++;
      s += ch;
      this.#pos++;
    }
    this.#err('unterminated single-quoted scalar');
  }

  #parseDoubleQuoted(): string {
    this.#pos++; // "
    let s = '';
    while (this.#pos < this.#src.length) {
      const ch = this.#src[this.#pos]!;
      if (ch === '"') { this.#pos++; return s; }
      if (ch === '\\') {
        this.#pos++;
        const esc = this.#src[this.#pos]!;
        this.#pos++;
        switch (esc) {
          case 'n': s += '\n'; break;
          case 't': s += '\t'; break;
          case 'r': s += '\r'; break;
          case '"': s += '"'; break;
          case '\\': s += '\\'; break;
          case '/': s += '/'; break;
          case 'b': s += '\b'; break;
          case 'f': s += '\f'; break;
          case 'u': {
            const hex = this.#src.slice(this.#pos, this.#pos + 4);
            this.#pos += 4;
            s += String.fromCodePoint(parseInt(hex, 16));
            break;
          }
          case 'U': {
            const hex = this.#src.slice(this.#pos, this.#pos + 8);
            this.#pos += 8;
            s += String.fromCodePoint(parseInt(hex, 16));
            break;
          }
          case '\n': this.#line++; break; // line continuation
          default: s += esc;
        }
        continue;
      }
      if (ch === '\n') this.#line++;
      s += ch;
      this.#pos++;
    }
    this.#err('unterminated double-quoted scalar');
  }

  #parsePlainScalar(inFlow: boolean): YamlValue {
    const start = this.#pos;
    while (this.#pos < this.#src.length) {
      const ch = this.#src[this.#pos]!;
      if (ch === '\n' || ch === '\r') break;
      if (inFlow && (ch === ',' || ch === '}' || ch === ']')) break;
      if (ch === ':' && (this.#src[this.#pos + 1] === ' ' || !this.#src[this.#pos + 1])) break;
      if (ch === '#' && this.#src[this.#pos - 1] === ' ') break;
      this.#pos++;
    }
    const raw = this.#src.slice(start, this.#pos).trim();
    return _resolveScalar(raw);
  }
}

// ---------------------------------------------------------------------------
// Core schema scalar resolution (YAML 1.2)
// ---------------------------------------------------------------------------

function _resolveScalar(raw: string): YamlValue {
  if (raw === 'null' || raw === '~' || raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === '.inf' || raw === '+.inf') return Infinity;
  if (raw === '-.inf') return -Infinity;
  if (raw === '.nan') return NaN;
  // Integer: decimal, hex (0x), octal (0o)
  if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(raw)) return parseInt(raw, 10);
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
  if (/^0o[0-7]+$/.test(raw)) return parseInt(raw.slice(2), 8);
  // Float
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(raw)) return parseFloat(raw);
  return raw;
}

// ---------------------------------------------------------------------------
// Stringifier
// ---------------------------------------------------------------------------

class YamlStringifier {
  #indent: number;
  constructor(indent: number) { this.#indent = indent; }

  stringify(value: YamlValue): string {
    return this.#val(value, 0) + '\n';
  }

  #val(v: YamlValue, depth: number): string {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') {
      if (isNaN(v)) return '.nan';
      if (!isFinite(v)) return v > 0 ? '.inf' : '-.inf';
      return String(v);
    }
    if (typeof v === 'string') return this.#str(v);
    if (Array.isArray(v)) return this.#seq(v, depth);
    return this.#map(v as YamlMapping, depth);
  }

  #str(s: string): string {
    if (s === '') return "''";
    if (_resolveScalar(s) !== s) return `'${s.replace(/'/g, "''")}'`;
    if (/[:\[\]{},#&*!|>'"%@`]/.test(s[0]!)) return `'${s.replace(/'/g, "''")}'`;
    if (s.includes('\n')) return `'${s.replace(/'/g, "''")}'`;
    return s;
  }

  #seq(arr: YamlValue[], depth: number): string {
    if (arr.length === 0) return '[]';
    const pad = ' '.repeat(this.#indent * depth);
    const childPad = ' '.repeat(this.#indent * (depth + 1));
    const inline = arr.every(e => e !== null && typeof e !== 'object');
    if (inline && arr.length <= 5) {
      const items = arr.map(e => this.#val(e, 0)).join(', ');
      if (items.length < 60) return `[${items}]`;
    }
    return arr.map(e => {
      const v = this.#val(e, depth + 1);
      return `\n${pad}- ${v}`;
    }).join('');
  }

  #map(obj: YamlMapping, depth: number): string {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    const pad = ' '.repeat(this.#indent * depth);
    return keys.map(k => {
      const key = this.#str(k);
      const v = obj[k]!;
      const valStr = this.#val(v, depth + 1);
      const sep = valStr.startsWith('\n') ? ':' : ': ';
      return `\n${pad}${key}${sep}${valStr}`;
    }).join('');
  }
}
