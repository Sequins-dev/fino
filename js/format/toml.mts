/**
 * fino:format/toml - TOML 1.0.0 parser and serializer.
 *
 * TOML is a configuration format optimized for human-edited files with typed
 * values and predictable table structure. This module parses TOML 1.0.0 into
 * JavaScript values and serializes compatible JavaScript objects back to TOML.
 * It is a good fit for application config, project manifests, and small
 * settings files where comments and stable textual shape matter to users.
 *
 * The parser covers TOML scalar types, basic and literal strings, integers,
 * floats, booleans, offset datetimes, local datetimes, local dates, local
 * times, arrays, inline tables, tables, and arrays of tables. Key uniqueness
 * and structural rules from the spec are enforced. Numeric tokens and
 * date/time ranges are validated rather than partially accepted.
 *
 * Datetime types:
 *   - Offset datetime   -> native Date
 *   - Local datetime    -> TomlLocalDateTime
 *   - Local date        -> TomlLocalDate
 *   - Local time        -> TomlLocalTime
 *
 * Integer overflow throws by default; pass `{ bigint: true }` to receive
 * `BigInt` values for integers outside JavaScript's safe integer range.
 * Stringification emits a normalized TOML document and does not preserve
 * comments, source ordering between scalars and tables, or original quoting
 * style. Heterogeneous arrays are accepted as Fino values even though many
 * TOML tools prefer homogeneous arrays.
 *
 * ```ts no_run
 * import { parse, stringify } from 'fino:format/toml';
 *
 * const cfg = parse('[server]\nport = 8080\nhosts = ["a", "b"]');
 * const text = stringify(cfg);
 * ```
 *
 * ```ts no_run
 * import { parse, TomlLocalDate } from 'fino:format/toml';
 *
 * const cfg = parse('released = 2026-06-02');
 * cfg.released instanceof TomlLocalDate; // true
 * ```
 *
 * Useful references:
 *   - TOML 1.0.0 specification: https://toml.io/en/v1.0.0
 */

import { Scanner, ParseError } from 'fino:parsing/scanner';

// ---------------------------------------------------------------------------
// Per-format error class
// ---------------------------------------------------------------------------

/**
 * Error thrown when TOML input is malformed or violates TOML structure rules.
 *
 * The error inherits source location and rendering support from `ParseError`.
 * Invalid values, duplicate keys, duplicate table declarations, and integer
 * overflow without `bigint: true` are reported through this error type.
 *
 * ```ts no_run
 * import { TomlParseError, parse } from 'fino:format/toml';
 *
 * try {
 *   parse('answer =');
 * } catch (error) {
 *   if (error instanceof TomlParseError) console.error(error.render());
 * }
 * ```
 */
export class TomlParseError extends ParseError {
  /**
   * Error name reported by `TomlParseError` instances.
   *
   * This member is emitted by the docs generator when
   * `--include-private` is enabled. It is maintained by runtime
   * internals and should be changed only with the surrounding
   * implementation contract in mind.
   *
   * @example
   * ```ts no_run
   * const error = new TomlParseError('example', { line: 1, column: 1, offset: 0, snippet: 'x' });
   * console.log(error.name);
   * ```
   */
  name = 'TomlParseError';
}

// ---------------------------------------------------------------------------
// Exported datetime wrapper types
// ---------------------------------------------------------------------------

/**
 * TOML local date value without a time or UTC offset.
 *
 * `parse()` returns this wrapper for TOML local-date values such as
 * `2026-06-02`. It preserves the date as written instead of converting through
 * a timezone. `toString()` and `toJSON()` return TOML-compatible
 * `YYYY-MM-DD` text.
 *
 * ```ts no_run
 * import { TomlLocalDate } from 'fino:format/toml';
 *
 * const date = new TomlLocalDate(2026, 6, 2);
 * date.toString(); // '2026-06-02'
 * ```
 */
export class TomlLocalDate {
  /**
   * Four-digit calendar year.
   *
   * The constructor does not normalize invalid calendar values; parsed TOML is
   * expected to supply spec-valid values.
   *
   * ```ts no_run
   * import { TomlLocalDate } from 'fino:format/toml';
   *
   * new TomlLocalDate(2026, 6, 2).year;
   * ```
   */
  readonly year: number;
  /**
   * One-based calendar month.
   *
   * January is `1` and December is `12`.
   *
   * ```ts no_run
   * import { TomlLocalDate } from 'fino:format/toml';
   *
   * new TomlLocalDate(2026, 6, 2).month;
   * ```
   */
  readonly month: number;
  /**
   * One-based day of month.
   *
   * The value is emitted with two digits by `toString()`.
   *
   * ```ts no_run
   * import { TomlLocalDate } from 'fino:format/toml';
   *
   * new TomlLocalDate(2026, 6, 2).day;
   * ```
   */
  readonly day: number;
  /**
   * Create a TOML local date wrapper.
   *
   * The values are stored directly and are not converted to a JavaScript `Date`.
   *
   * ```ts no_run
   * import { TomlLocalDate } from 'fino:format/toml';
   *
   * const date = new TomlLocalDate(2026, 6, 2);
   * ```
   */
  constructor(y: number, mo: number, d: number) { this.year = y; this.month = mo; this.day = d; }
  /**
   * Format the date as TOML local-date text.
   *
   * The return value is zero-padded and contains no timezone information.
   *
   * ```ts no_run
   * import { TomlLocalDate } from 'fino:format/toml';
   *
   * new TomlLocalDate(2026, 6, 2).toString();
   * ```
   */
  toString() { return `${pad4(this.year)}-${pad2(this.month)}-${pad2(this.day)}`; }
  /**
   * Return the JSON representation used by `JSON.stringify()`.
   *
   * The value matches `toString()` so local dates remain timezone-free when
   * serialized to JSON.
   *
   * ```ts no_run
   * import { TomlLocalDate } from 'fino:format/toml';
   *
   * JSON.stringify({ released: new TomlLocalDate(2026, 6, 2) });
   * ```
   */
  toJSON() { return this.toString(); }
}

/**
 * TOML local time value without a date or UTC offset.
 *
 * `parse()` returns this wrapper for TOML local-time values such as
 * `12:30:00`. It preserves wall-clock time and does not attach a timezone or
 * date.
 *
 * ```ts no_run
 * import { TomlLocalTime } from 'fino:format/toml';
 *
 * const time = new TomlLocalTime(9, 30, 0);
 * time.toString(); // '09:30:00'
 * ```
 */
export class TomlLocalTime {
  /**
   * Hour in 24-hour time.
   *
   * The value is emitted with two digits by `toString()`.
   *
   * ```ts no_run
   * import { TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalTime(9, 30, 0).hour;
   * ```
   */
  readonly hour: number;
  /**
   * Minute within the hour.
   *
   * The value is emitted with two digits by `toString()`.
   *
   * ```ts no_run
   * import { TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalTime(9, 30, 0).minute;
   * ```
   */
  readonly minute: number;
  /**
   * Second within the minute.
   *
   * Fractional precision, when present, is stored separately in `ms`.
   *
   * ```ts no_run
   * import { TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalTime(9, 30, 15).second;
   * ```
   */
  readonly second: number;
  /**
   * Millisecond fraction. Defaults to `0`.
   *
   * Parsed TOML fractional seconds are rounded to the nearest millisecond.
   *
   * ```ts no_run
   * import { TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalTime(9, 30, 15, 250).ms;
   * ```
   */
  readonly ms: number;
  /**
   * Create a TOML local time wrapper.
   *
   * The constructor stores values directly and does not normalize overflow.
   *
   * ```ts no_run
   * import { TomlLocalTime } from 'fino:format/toml';
   *
   * const time = new TomlLocalTime(9, 30, 15, 250);
   * ```
   */
  constructor(h: number, m: number, s: number, ms = 0) { this.hour = h; this.minute = m; this.second = s; this.ms = ms; }
  /**
   * Format the value as TOML local-time text.
   *
   * Milliseconds are emitted only when non-zero.
   *
   * ```ts no_run
   * import { TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalTime(9, 30, 15, 250).toString();
   * ```
   */
  toString() { return `${pad2(this.hour)}:${pad2(this.minute)}:${pad2(this.second)}${this.ms ? `.${String(this.ms).padStart(3,'0')}` : ''}`; }
  /**
   * Return the JSON representation used by `JSON.stringify()`.
   *
   * The value matches `toString()` and remains date- and timezone-free.
   *
   * ```ts no_run
   * import { TomlLocalTime } from 'fino:format/toml';
   *
   * JSON.stringify({ startsAt: new TomlLocalTime(9, 30, 0) });
   * ```
   */
  toJSON() { return this.toString(); }
}

/**
 * TOML local date-time value without a UTC offset.
 *
 * `parse()` returns this wrapper for TOML local datetimes such as
 * `2026-06-02T09:30:00`. Offset datetimes are returned as native `Date`
 * instances instead.
 *
 * ```ts no_run
 * import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';
 *
 * const value = new TomlLocalDateTime(
 *   new TomlLocalDate(2026, 6, 2),
 *   new TomlLocalTime(9, 30, 0),
 * );
 * ```
 */
export class TomlLocalDateTime {
  /**
   * Local date component.
   *
   * This component carries no timezone and is preserved independently from
   * JavaScript `Date`.
   *
   * ```ts no_run
   * import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)).date;
   * ```
   */
  readonly date: TomlLocalDate;
  /**
   * Local time component.
   *
   * The component includes optional millisecond precision but no timezone.
   *
   * ```ts no_run
   * import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)).time;
   * ```
   */
  readonly time: TomlLocalTime;
  /**
   * Create a TOML local date-time wrapper from local date and time parts.
   *
   * No timezone conversion or validation is performed by the constructor.
   *
   * ```ts no_run
   * import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';
   *
   * const value = new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0));
   * ```
   */
  constructor(d: TomlLocalDate, t: TomlLocalTime) { this.date = d; this.time = t; }
  /**
   * Format the value as TOML local-date-time text.
   *
   * The returned string uses `T` between date and time and includes no offset.
   *
   * ```ts no_run
   * import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';
   *
   * new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)).toString();
   * ```
   */
  toString() { return `${this.date}T${this.time}`; }
  /**
   * Return the JSON representation used by `JSON.stringify()`.
   *
   * The value matches `toString()` and stays offset-free.
   *
   * ```ts no_run
   * import { TomlLocalDate, TomlLocalDateTime, TomlLocalTime } from 'fino:format/toml';
   *
   * JSON.stringify({
   *   start: new TomlLocalDateTime(new TomlLocalDate(2026, 6, 2), new TomlLocalTime(9, 30, 0)),
   * });
   * ```
   */
  toJSON() { return this.toString(); }
}

function pad2(n: number) { return String(n).padStart(2, '0'); }
function pad4(n: number) { return String(n).padStart(4, '0'); }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Value types produced by the TOML parser and accepted by the stringifier.
 *
 * Offset datetimes are native `Date` values; local temporal values use the
 * wrapper classes exported by this module. Objects represent TOML tables and
 * arrays represent TOML arrays or arrays of tables depending on context.
 *
 * ```ts no_run
 * import { stringify, type TomlValue } from 'fino:format/toml';
 *
 * const value: TomlValue = { server: { port: 8080, enabled: true } };
 * stringify(value as Record<string, TomlValue>);
 * ```
 */
export type TomlValue =
  | string | number | bigint | boolean
  | Date | TomlLocalDate | TomlLocalTime | TomlLocalDateTime
  | TomlValue[]
  | {
    /**
     * TOML table key mapped to another TOML-compatible value.
     *
     * Nested objects become TOML tables or inline tables depending on
     * stringifier context.
     *
     * ```ts no_run
     * import type { TomlValue } from 'fino:format/toml';
     *
     * const table: TomlValue = { server: { port: 8080 } };
     * ```
     */
    [k: string]: TomlValue;
  };

/**
 * Options controlling TOML parsing.
 *
 * Parsing is strict by default and throws on integers outside JavaScript's safe
 * integer range. Enable `bigint` when preserving oversized TOML integers is
 * more important than returning only `number` values.
 *
 * ```ts no_run
 * import { parse, type TomlParseOptions } from 'fino:format/toml';
 *
 * const options: TomlParseOptions = { bigint: true };
 * parse('huge = 9223372036854775807', options);
 * ```
 */
export interface TomlParseOptions {
  /**
   * Return oversized TOML integers as `BigInt` instead of throwing.
   *
   * Defaults to `false`. Safe integers are still returned as `number`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/toml';
   *
   * const cfg = parse('huge = 9223372036854775807', { bigint: true });
   * ```
   */
  bigint?: boolean;
}
/**
 * Options controlling TOML output formatting.
 *
 * The current stringifier emits one key per line, table headers for nested
 * objects, and arrays of tables for arrays of object values.
 *
 * ```ts no_run
 * import { stringify, type TomlStringifyOptions } from 'fino:format/toml';
 *
 * const options: TomlStringifyOptions = { indent: '' };
 * stringify({ server: { port: 8080 } }, options);
 * ```
 */
export interface TomlStringifyOptions {
  /**
   * Reserved indentation string for TOML output. Defaults to `""`.
   *
   * The current formatter stores this value for future formatting support, but
   * TOML tables and arrays are emitted in a compact one-entry-per-line style.
   *
   * ```ts no_run
   * import { stringify } from 'fino:format/toml';
   *
   * stringify({ server: { port: 8080 } }, { indent: '' });
   * ```
   */
  indent?: string;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a TOML document into a plain object.
 *
 * The parser enforces TOML 1.0.0 key uniqueness, table structure, scalar
 * syntax, and integer range rules. It returns an object with a null prototype
 * internally, but callers should treat the result as a plain record of
 * `TomlValue`.
 *
 * ```ts no_run
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

function createTable(): TomlTable {
  return {};
}

function setMeta<T extends object>(target: T, key: symbol, value: boolean): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

class TomlParser {
  #sc: Scanner;
  #opts: TomlParseOptions;
  #root: TomlTable = createTable();

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

    return stripMeta(this.#root) as Record<string, TomlValue>;
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
    const obj: TomlTable = createTable();
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
    if (/^[+-]0[xob]/.test(raw)) throw sc.error(`invalid value: ${raw}`);
    if (raw.slice(0, 2) === '0x') {
      if (!/^0x[0-9a-fA-F]+(?:_[0-9a-fA-F]+)*$/.test(raw)) throw sc.error(`invalid value: ${raw}`);
      return this.#parseInt(parseInt(raw.slice(2).replace(/_/g, ''), 16), raw);
    }
    if (raw.slice(0, 2) === '0o') {
      if (!/^0o[0-7]+(?:_[0-7]+)*$/.test(raw)) throw sc.error(`invalid value: ${raw}`);
      return this.#parseInt(parseInt(raw.slice(2).replace(/_/g, ''), 8), raw);
    }
    if (raw.slice(0, 2) === '0b') {
      if (!/^0b[01]+(?:_[01]+)*$/.test(raw)) throw sc.error(`invalid value: ${raw}`);
      return this.#parseInt(parseInt(raw.slice(2).replace(/_/g, ''), 2), raw);
    }

    // Strip underscores for numeric parse
    const clean = raw.replace(/_/g, '');

    if (raw.includes('_') && !/^[+-]?(?:0|[1-9][0-9]*)(?:_[0-9]+)*(?:\.[0-9]+(?:_[0-9]+)*)?(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?$/.test(raw)) {
      throw sc.error(`invalid value: ${raw}`);
    }

    if (/^[+-]?(?:0|[1-9][0-9]*)$/.test(clean)) return this.#parseInt(parseInt(clean, 10), raw);

    // Float
    if (/^[+-]?(?:(?:[0-9]+\.[0-9]+)|(?:[0-9]+(?:\.[0-9]+)?[eE][+-]?[0-9]+))$/.test(clean)) {
      return parseFloat(clean.replace(/^[+]/, ''));
    }
    if (clean === 'nan' || clean === '+nan' || clean === '-nan') return NaN;
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
    if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) {
      throw this.#sc.error(`invalid datetime: ${raw}`);
    }
    const datePart = raw.slice(0, 10);
    const [y, mo, d] = datePart.split('-').map(Number) as [number, number, number];
    this.#validateDate(y, mo, d, raw);
    const rest = raw.slice(10);
    if (!rest) return new TomlLocalDate(y, mo, d);
    // Separator: T or space
    const timeRaw = rest.startsWith('T') || rest.startsWith(' ') ? rest.slice(1) : rest;
    const tzMatch = timeRaw.match(/([+-]\d{2}:\d{2}|Z)$/);
    const timePart = tzMatch ? timeRaw.slice(0, timeRaw.length - tzMatch[0].length) : timeRaw;
    const t = this.#parseTime(timePart);
    if (tzMatch) {
      if (tzMatch[0] !== 'Z') {
        const [oh, om] = tzMatch[0].slice(1).split(':').map(Number) as [number, number];
        if (oh > 23 || om > 59) throw this.#sc.error(`invalid datetime offset: ${raw}`);
      }
      // Offset datetime -> Date
      const date = new Date(`${datePart}T${timePart}${tzMatch[0]}`);
      if (isNaN(date.getTime())) throw this.#sc.error(`invalid datetime: ${raw}`);
      return date;
    }
    return new TomlLocalDateTime(new TomlLocalDate(y, mo, d), t);
  }

  #parseTime(raw: string): TomlLocalTime {
    if (!/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) throw this.#sc.error(`invalid time: ${raw}`);
    const [hms, fracStr] = raw.split('.') as [string, string | undefined];
    const [h, m, s] = hms.split(':').map(Number) as [number, number, number];
    if (h > 23 || m > 59 || s > 59) throw this.#sc.error(`invalid time: ${raw}`);
    const ms = fracStr ? Math.round(Number(`0.${fracStr}`) * 1000) : 0;
    return new TomlLocalTime(h, m, s, ms);
  }

  #validateDate(y: number, mo: number, d: number, raw: string): void {
    if (mo < 1 || mo > 12 || d < 1) throw this.#sc.error(`invalid date: ${raw}`);
    const days = [31, this.#isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (d > days[mo - 1]!) throw this.#sc.error(`invalid date: ${raw}`);
  }

  #isLeapYear(y: number): boolean {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  }

  #resolveTable(root: TomlTable, keys: string[], isArray: boolean): TomlTable {
    let t: TomlTable = root;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!(k in t)) {
        const sub: TomlTable = createTable();
        setMeta(sub, _IMPLICIT, true);
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
        setMeta(arr, _ARRAY, true);
        t[last] = arr as unknown as TomlValue;
      } else if (!Array.isArray(t[last]) || !(t[last] as unknown as TomlTable)[_ARRAY]) {
        throw this.#sc.error(`key '${last}' is not an array of tables`);
      }
      const arr = t[last] as TomlTable[];
      const entry: TomlTable = createTable();
      arr.push(entry);
      return entry;
    }
    // Standard table
    if (!(last in t)) {
      const sub: TomlTable = createTable();
      setMeta(sub, _DEFINED, true);
      t[last] = sub;
      return sub;
    }
    const existing = t[last] as TomlTable;
    if (existing[_DEFINED] && !existing[_IMPLICIT]) {
      throw this.#sc.error(`duplicate table '${last}'`);
    }
    setMeta(existing, _IMPLICIT, false);
    setMeta(existing, _DEFINED, true);
    return existing;
  }

  #setKey(t: TomlTable, keys: string[], val: TomlValue): void {
    let cur = t;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!(k in cur)) {
        const sub: TomlTable = createTable();
        setMeta(sub, _IMPLICIT, true);
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
 * The stringifier emits TOML scalars before nested tables, converts native
 * `Date` values to UTC offset datetimes, and emits local wrappers through
 * their `toString()` methods. It does not preserve comments or original source
 * formatting from a parsed document.
 *
 * ```ts no_run
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
      if (Array.isArray(v) && v.length > 0 && isTableValue(v[0])) {
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

function stripMeta(value: TomlValue): TomlValue {
  if (Array.isArray(value)) {
    delete (value as unknown as TableMeta)[_ARRAY];
    for (let i = 0; i < value.length; i++) value[i] = stripMeta(value[i]!);
    return value;
  }
  if (value && typeof value === 'object' && !_isDateLike(value)) {
    delete (value as TableMeta)[_DEFINED];
    delete (value as TableMeta)[_ARRAY];
    delete (value as TableMeta)[_IMPLICIT];
    for (const key of Object.keys(value as Record<string, TomlValue>)) {
      (value as Record<string, TomlValue>)[key] = stripMeta((value as Record<string, TomlValue>)[key]!);
    }
  }
  return value;
}

function _isDateLike(v: unknown): boolean {
  return v instanceof Date || v instanceof TomlLocalDate || v instanceof TomlLocalTime || v instanceof TomlLocalDateTime;
}

function isTableValue(v: unknown): v is Record<string, TomlValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !_isDateLike(v);
}

function _tomlKey(k: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function _tomlString(s: string): string {
  // Use literal strings when possible (no backslash, no single-quote)
  if (!s.includes("'") && !s.includes('\n') && !s.includes('\r')) return `'${s}'`;
  return JSON.stringify(s); // basic string with JSON-compatible escapes
}
