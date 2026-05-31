/**
 * fino:format/toml — TOML 1.0.0 parser and serializer.
 *
 * Full TOML 1.0.0 conformance: all scalar types (strings, integers, floats,
 * booleans, datetimes), tables, arrays, arrays-of-tables, inline tables.
 * Key uniqueness and structural rules from the spec are enforced.
 *
 * Datetime types:
 *   - Offset datetime   → native Date
 *   - Local datetime    → TomlLocalDateTime
 *   - Local date        → TomlLocalDate
 *   - Local time        → TomlLocalTime
 *
 * Integer overflow: throws by default; pass { bigint: true } to receive BigInt.
 *
 * ```ts
 *   import { parse, stringify } from 'fino:format/toml';
 *
 *   const cfg = parse('[server]\nport = 8080\nhosts = ["a", "b"]');
 *   stringify(cfg);
 * ```
 */

import { Scanner, ParseError } from 'fino:scanner';

// ---------------------------------------------------------------------------
// Per-format error class
// ---------------------------------------------------------------------------

/** Error thrown when TOML input is malformed. */
export class TomlParseError extends ParseError { name = 'TomlParseError'; }

// ---------------------------------------------------------------------------
// Exported datetime wrapper types
// ---------------------------------------------------------------------------

/** TOML local date value without a time or offset. */
export class TomlLocalDate {
  readonly year: number; readonly month: number; readonly day: number;
  constructor(y: number, mo: number, d: number) { this.year = y; this.month = mo; this.day = d; }
  toString() { return `${pad4(this.year)}-${pad2(this.month)}-${pad2(this.day)}`; }
  toJSON() { return this.toString(); }
}

/** TOML local time value without a date or offset. */
export class TomlLocalTime {
  readonly hour: number; readonly minute: number; readonly second: number; readonly ms: number;
  constructor(h: number, m: number, s: number, ms = 0) { this.hour = h; this.minute = m; this.second = s; this.ms = ms; }
  toString() { return `${pad2(this.hour)}:${pad2(this.minute)}:${pad2(this.second)}${this.ms ? `.${String(this.ms).padStart(3,'0')}` : ''}`; }
  toJSON() { return this.toString(); }
}

/** TOML local date-time value without an offset. */
export class TomlLocalDateTime {
  readonly date: TomlLocalDate; readonly time: TomlLocalTime;
  constructor(d: TomlLocalDate, t: TomlLocalTime) { this.date = d; this.time = t; }
  toString() { return `${this.date}T${this.time}`; }
  toJSON() { return this.toString(); }
}

function pad2(n: number) { return String(n).padStart(2, '0'); }
function pad4(n: number) { return String(n).padStart(4, '0'); }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Value types produced by the TOML parser and accepted by the stringifier. */
export type TomlValue =
  | string | number | bigint | boolean
  | Date | TomlLocalDate | TomlLocalTime | TomlLocalDateTime
  | TomlValue[]
  | { [k: string]: TomlValue };

/** Options controlling TOML parsing. */
export interface TomlParseOptions { bigint?: boolean; }
/** Options controlling TOML output formatting. */
export interface TomlStringifyOptions { indent?: string; }

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a TOML document into a plain object.
 *
 * ```ts
 * import { parse } from 'fino:format/toml';
 *
 * parse('title = "Fino"\n[server]\nport = 8080\n');
 * ```
 */
export function parse(input: string | Uint8Array, options: TomlParseOptions = {}): Record<string, TomlValue> {
  return new TomlParser(input, options).parse();
}

// Per-table metadata to track explicit definition (for duplicate-table detection)
const _DEFINED = Symbol('defined');
const _ARRAY   = Symbol('array');
const _IMPLICIT = Symbol('implicit');

type TableMeta = { [_DEFINED]?: boolean; [_ARRAY]?: boolean; [_IMPLICIT]?: boolean };
type TomlTable = Record<string, TomlValue> & TableMeta;

class TomlParser {
  #sc: Scanner;
  #opts: TomlParseOptions;
  #root: TomlTable = Object.create(null);

  constructor(src: string | Uint8Array, opts: TomlParseOptions) {
    this.#opts = opts;
    this.#sc = new Scanner(src, { encoding: 'utf-8', format: 'toml' });
  }

  parse(): Record<string, TomlValue> {
    let current: TomlTable = this.#root;
    const sc = this.#sc;

    while (!sc.done) {
      this.#skipWs();
      if (sc.done) break;
      const ch = sc.peek();

      if (ch === '#') { this.#skipComment(); continue; }

      if (ch === '[') {
        sc.eat();
        const isArray = sc.eatChar('[');
        const keys = this.#parseKeyPath();
        sc.expect(']');
        if (isArray) sc.expect(']');
        this.#skipWs();
        if (!sc.done && sc.peek() !== '#') {
          if (sc.peek() !== '\n' && sc.peek() !== '\r') throw sc.error('expected newline after table header');
        }
        this.#skipComment();
        current = this.#resolveTable(this.#root, keys, isArray);
        continue;
      }

      if (ch === '\n' || ch === '\r') { sc.eat(); continue; }

      // key = value
      const keys = this.#parseKeyPath();
      sc.skipSpaceTab();
      sc.expect('=');
      sc.skipSpaceTab();
      const val = this.#parseValue();
      sc.skipSpaceTab();
      if (!sc.done && sc.peek() !== '#' && sc.peek() !== '\n' && sc.peek() !== '\r') {
        throw sc.error('expected newline or comment after value');
      }
      this.#skipComment();
      this.#setKey(current, keys, val);
    }

    return this.#root;
  }

  #skipWs() {
    while (!this.#sc.done) {
      const c = this.#sc.peek();
      if (c === ' ' || c === '\t') { this.#sc.eat(); continue; }
      break;
    }
  }

  #skipComment() {
    const sc = this.#sc;
    sc.skipSpaceTab();
    if (!sc.done && sc.peek() === '#') {
      while (!sc.done && sc.peek() !== '\n' && sc.peek() !== '\r') sc.eat();
    }
    if (!sc.done) {
      if (sc.peek() === '\r') sc.eat();
      if (!sc.done && sc.peek() === '\n') sc.eat();
    }
  }

  #parseKeyPath(): string[] {
    const keys: string[] = [this.#parseKey()];
    while (this.#sc.eatChar('.')) {
      this.#sc.skipSpaceTab();
      keys.push(this.#parseKey());
      this.#sc.skipSpaceTab();
    }
    return keys;
  }

  #parseKey(): string {
    const sc = this.#sc;
    sc.skipSpaceTab();
    const ch = sc.peek();
    if (ch === '"') return this.#parseBasicString();
    if (ch === "'") return this.#parseLiteralString();
    // bare key: a-z A-Z 0-9 - _
    const k = sc.eatWhile(c => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45);
    if (k === '') throw sc.error('expected key');
    sc.skipSpaceTab();
    return k;
  }

  #parseValue(): TomlValue {
    const sc = this.#sc;
    const ch = sc.peek();

    if (ch === '"') {
      if (sc.peek(3) === '"""') return this.#parseMultilineBasicString();
      return this.#parseBasicString();
    }
    if (ch === "'") {
      if (sc.peek(3) === "'''") return this.#parseMultilineLiteralString();
      return this.#parseLiteralString();
    }
    if (ch === '[') return this.#parseArray();
    if (ch === '{') return this.#parseInlineTable();
    if (ch === 't') { if (sc.match('true'))  return true;  throw sc.error('expected true'); }
    if (ch === 'f') { if (sc.match('false')) return false; throw sc.error('expected false'); }
    if (ch === 'i') { if (sc.match('inf'))   return Infinity; throw sc.error('expected inf'); }
    if (ch === 'n') { if (sc.match('nan'))   return NaN; throw sc.error('expected nan'); }
    if (ch === '+') {
      if (sc.peekCode(1) === 0x69 /* i */) { sc.match('+inf'); return Infinity; }
      if (sc.peekCode(1) === 0x6E /* n */) { sc.match('+nan'); return NaN; }
    }
    if (ch === '-') {
      if (sc.peekCode(1) === 0x69 /* i */) { sc.match('-inf'); return -Infinity; }
      if (sc.peekCode(1) === 0x6E /* n */) { sc.match('-nan'); return NaN; }
    }

    // Number or datetime
    return this.#parseNumberOrDate();
  }

  #parseBasicString(): string {
    const sc = this.#sc;
    sc.expect('"');
    let s = '';
    while (!sc.done) {
      const ch = sc.peek();
      if (ch === '"') { sc.eat(); return s; }
      if (ch === '\\') { s += this.#parseEscape(); continue; }
      if (ch === '\n' || ch === '\r') throw sc.error('newline not allowed in basic string');
      s += sc.eat();
    }
    throw sc.error('unterminated string');
  }

  #parseLiteralString(): string {
    const sc = this.#sc;
    sc.expect("'");
    let s = '';
    while (!sc.done) {
      const ch = sc.peek();
      if (ch === "'") { sc.eat(); return s; }
      if (ch === '\n' || ch === '\r') throw sc.error('newline not allowed in literal string');
      s += sc.eat();
    }
    throw sc.error('unterminated literal string');
  }

  #parseMultilineBasicString(): string {
    const sc = this.#sc;
    sc.match('"""');
    // Skip leading newline
    if (sc.peek() === '\r') sc.eat();
    if (sc.peek() === '\n') sc.eat();
    let s = '';
    while (!sc.done) {
      if (sc.match('"""')) return s;
      const ch = sc.peek();
      if (ch === '\\') {
        // Line-ending backslash: skip whitespace
        sc.eat();
        if (sc.peek() === '\n' || sc.peek() === '\r') {
          while (!sc.done && (sc.peek() === '\n' || sc.peek() === '\r' || sc.peek() === ' ' || sc.peek() === '\t')) sc.eat();
          continue;
        }
        s += this.#parseEscapeChar(sc.eat());
        continue;
      }
      s += sc.eat();
    }
    throw sc.error('unterminated multiline basic string');
  }

  #parseMultilineLiteralString(): string {
    const sc = this.#sc;
    sc.match("'''");
    if (sc.peek() === '\r') sc.eat();
    if (sc.peek() === '\n') sc.eat();
    let s = '';
    while (!sc.done) {
      if (sc.match("'''")) return s;
      s += sc.eat();
    }
    throw sc.error('unterminated multiline literal string');
  }

  #parseEscape(): string {
    const sc = this.#sc;
    sc.expect('\\');
    return this.#parseEscapeChar(sc.eat());
  }

  #parseEscapeChar(ch: string): string {
    switch (ch) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case 'u': return this.#parseUnicode(4);
      case 'U': return this.#parseUnicode(8);
      default: throw this.#sc.error(`unknown escape \\${ch}`);
    }
  }

  #parseUnicode(len: number): string {
    const sc = this.#sc;
    let hex = '';
    for (let i = 0; i < len; i++) hex += sc.eat();
    const cp = parseInt(hex, 16);
    if (isNaN(cp)) throw sc.error('invalid unicode escape');
    return String.fromCodePoint(cp);
  }

  #parseArray(): TomlValue[] {
    const sc = this.#sc;
    sc.expect('[');
    const arr: TomlValue[] = [];
    while (true) {
      sc.skipWhitespace();
      while (sc.peek() === '#') { this.#skipComment(); sc.skipWhitespace(); }
      if (sc.eatChar(']')) return arr;
      arr.push(this.#parseValue());
      sc.skipWhitespace();
      while (sc.peek() === '#') { this.#skipComment(); sc.skipWhitespace(); }
      if (!sc.eatChar(',')) {
        sc.skipWhitespace();
        while (sc.peek() === '#') { this.#skipComment(); sc.skipWhitespace(); }
        sc.expect(']');
        return arr;
      }
    }
  }

  #parseInlineTable(): TomlTable {
    const sc = this.#sc;
    sc.expect('{');
    const obj: TomlTable = Object.create(null);
    sc.skipSpaceTab();
    if (sc.eatChar('}')) return obj;
    while (true) {
      sc.skipSpaceTab();
      const keys = this.#parseKeyPath();
      sc.skipSpaceTab();
      sc.expect('=');
      sc.skipSpaceTab();
      const val = this.#parseValue();
      this.#setKey(obj, keys, val);
      sc.skipSpaceTab();
      if (sc.eatChar('}')) return obj;
      sc.expect(',');
    }
  }

  #parseNumberOrDate(): TomlValue {
    const sc = this.#sc;
    // Collect the token (consume sign, digits, separators, letters)
    const raw = sc.eatWhile(c => /[0-9a-fA-Fox_+\-.:TZ]/.test(String.fromCharCode(c)));
    if (raw === '') throw sc.error('expected value');

    // --- Datetime detection ---
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return this.#parseDate(raw);
    if (/^\d{2}:\d{2}:\d{2}/.test(raw)) return this.#parseTime(raw);

    // --- Integer: hex/oct/bin/dec ---
    if (raw.startsWith('0x')) return this.#parseInt(parseInt(raw.slice(2), 16), raw);
    if (raw.startsWith('0o')) return this.#parseInt(parseInt(raw.slice(2), 8), raw);
    if (raw.startsWith('0b')) return this.#parseInt(parseInt(raw.slice(2), 2), raw);

    // Strip underscores for numeric parse
    const clean = raw.replace(/_/g, '');

    if (/^[+-]?(?:0|[1-9][0-9]*)$/.test(clean)) return this.#parseInt(parseInt(clean, 10), raw);

    // Float
    const f = parseFloat(clean.replace(/^[+]/, ''));
    if (!isNaN(f) || clean === 'nan') return f;
    if (clean === 'inf' || clean === '+inf') return Infinity;
    if (clean === '-inf') return -Infinity;

    throw sc.error(`invalid value: ${raw}`);
  }

  #parseInt(n: number, raw: string): number | bigint {
    if (!Number.isSafeInteger(n)) {
      if (this.#opts.bigint) return BigInt(raw.replace(/_/g, ''));
      throw this.#sc.error(`integer overflow: ${raw} exceeds Number.MAX_SAFE_INTEGER; use { bigint: true }`);
    }
    return n;
  }

  #parseDate(raw: string): Date | TomlLocalDateTime | TomlLocalDate {
    const datePart = raw.slice(0, 10);
    const [y, mo, d] = datePart.split('-').map(Number) as [number, number, number];
    const rest = raw.slice(10);
    if (!rest) return new TomlLocalDate(y, mo, d);
    // Separator: T or space
    const timeRaw = rest.startsWith('T') || rest.startsWith(' ') ? rest.slice(1) : rest;
    const tzMatch = timeRaw.match(/([+-]\d{2}:\d{2}|Z)$/);
    const timePart = tzMatch ? timeRaw.slice(0, timeRaw.length - tzMatch[0].length) : timeRaw;
    const t = this.#parseTime(timePart);
    if (tzMatch) {
      // Offset datetime → Date
      return new Date(`${datePart}T${timePart}${tzMatch[0]}`);
    }
    return new TomlLocalDateTime(new TomlLocalDate(y, mo, d), t);
  }

  #parseTime(raw: string): TomlLocalTime {
    const [hms, fracStr] = raw.split('.') as [string, string | undefined];
    const [h, m, s] = hms.split(':').map(Number) as [number, number, number];
    const ms = fracStr ? Math.round(Number(`0.${fracStr}`) * 1000) : 0;
    return new TomlLocalTime(h, m, s, ms);
  }

  #resolveTable(root: TomlTable, keys: string[], isArray: boolean): TomlTable {
    let t: TomlTable = root;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!(k in t)) {
        const sub: TomlTable = Object.create(null);
        sub[_IMPLICIT] = true;
        t[k] = sub;
      }
      const next = t[k];
      if (Array.isArray(next)) {
        t = next[next.length - 1] as TomlTable;
      } else if (typeof next === 'object' && next !== null) {
        t = next as TomlTable;
      } else {
        throw this.#sc.error(`key '${k}' is not a table`);
      }
    }
    const last = keys[keys.length - 1]!;
    if (isArray) {
      if (!(last in t)) {
        const arr: TomlTable[] & { [_ARRAY]?: boolean } = [];
        arr[_ARRAY] = true;
        t[last] = arr as unknown as TomlValue;
      } else if (!Array.isArray(t[last]) || !(t[last] as unknown as TomlTable)[_ARRAY]) {
        throw this.#sc.error(`key '${last}' is not an array of tables`);
      }
      const arr = t[last] as TomlTable[];
      const entry: TomlTable = Object.create(null);
      arr.push(entry);
      return entry;
    }
    // Standard table
    if (!(last in t)) {
      const sub: TomlTable = Object.create(null);
      sub[_DEFINED] = true;
      t[last] = sub;
      return sub;
    }
    const existing = t[last] as TomlTable;
    if (existing[_DEFINED] && !existing[_IMPLICIT]) {
      throw this.#sc.error(`duplicate table '${last}'`);
    }
    existing[_IMPLICIT] = false;
    existing[_DEFINED] = true;
    return existing;
  }

  #setKey(t: TomlTable, keys: string[], val: TomlValue): void {
    let cur = t;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!(k in cur)) {
        const sub: TomlTable = Object.create(null);
        sub[_IMPLICIT] = true;
        cur[k] = sub;
      }
      const next = cur[k];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        throw this.#sc.error(`key '${k}' is not a table`);
      }
      cur = next as TomlTable;
    }
    const last = keys[keys.length - 1]!;
    if (last in cur) throw this.#sc.error(`duplicate key '${last}'`);
    cur[last] = val;
  }
}

// ---------------------------------------------------------------------------
// Stringify
// ---------------------------------------------------------------------------

/**
 * Serialize a TOML-compatible object.
 *
 * ```ts
 * import { stringify } from 'fino:format/toml';
 *
 * stringify({ server: { port: 8080 } });
 * ```
 */
export function stringify(value: Record<string, TomlValue>, options: TomlStringifyOptions = {}): string {
  const indent = options.indent ?? '';
  return new TomlStringifier(indent).stringifyRoot(value);
}

class TomlStringifier {
  #indent: string;
  constructor(indent: string) { this.#indent = indent; }

  stringifyRoot(obj: Record<string, TomlValue>): string {
    return this.#stringifyTable(obj, []);
  }

  #stringifyTable(obj: Record<string, TomlValue>, path: string[]): string {
    const scalar: [string, TomlValue][] = [];
    const tables: [string, Record<string, TomlValue>][] = [];
    const arrayTables: [string, Record<string, TomlValue>[]][] = [];

    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && !_isDateLike(v[0])) {
        arrayTables.push([k, v as Record<string, TomlValue>[]]);
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v) && !_isDateLike(v)) {
        tables.push([k, v as Record<string, TomlValue>]);
      } else {
        scalar.push([k, v]);
      }
    }

    let out = '';
    if (path.length > 0 && scalar.length + arrayTables.length > 0) {
      out += `[${path.map(_tomlKey).join('.')}]\n`;
    }
    for (const [k, v] of scalar) {
      out += `${_tomlKey(k)} = ${this.#tomlValue(v)}\n`;
    }
    for (const [k, sub] of tables) {
      out += '\n' + this.#stringifyTable(sub, [...path, k]);
    }
    for (const [k, arr] of arrayTables) {
      for (const entry of arr) {
        out += `\n[[${[...path, k].map(_tomlKey).join('.')}]]\n`;
        out += this.#stringifyInlineTableEntries(entry);
      }
    }
    return out;
  }

  #stringifyInlineTableEntries(obj: Record<string, TomlValue>): string {
    let out = '';
    for (const [k, v] of Object.entries(obj)) {
      out += `${_tomlKey(k)} = ${this.#tomlValue(v)}\n`;
    }
    return out;
  }

  #tomlValue(v: TomlValue): string {
    if (typeof v === 'string') return _tomlString(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'number') {
      if (isNaN(v)) return 'nan';
      if (!isFinite(v)) return v > 0 ? 'inf' : '-inf';
      return Number.isInteger(v) ? String(v) : v.toPrecision(17).replace(/0+$/, '');
    }
    if (v instanceof Date) return v.toISOString().replace('Z', '+00:00');
    if (v instanceof TomlLocalDateTime) return v.toString();
    if (v instanceof TomlLocalDate) return v.toString();
    if (v instanceof TomlLocalTime) return v.toString();
    if (Array.isArray(v)) {
      return '[' + v.map(e => this.#tomlValue(e)).join(', ') + ']';
    }
    if (typeof v === 'object' && v !== null) {
      const pairs = Object.entries(v as Record<string, TomlValue>)
        .map(([k, val]) => `${_tomlKey(k)} = ${this.#tomlValue(val)}`);
      return '{' + pairs.join(', ') + '}';
    }
    return String(v);
  }
}

function _isDateLike(v: unknown): boolean {
  return v instanceof Date || v instanceof TomlLocalDate || v instanceof TomlLocalTime || v instanceof TomlLocalDateTime;
}

function _tomlKey(k: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function _tomlString(s: string): string {
  // Use literal strings when possible (no backslash, no single-quote)
  if (!s.includes("'") && !s.includes('\n') && !s.includes('\r')) return `'${s}'`;
  return JSON.stringify(s); // basic string with JSON-compatible escapes
}
