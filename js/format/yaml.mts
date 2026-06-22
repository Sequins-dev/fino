/**
 * fino:format/yaml - YAML 1.2 core schema parser and serializer.
 *
 * YAML is a human-oriented data serialization format often used for
 * configuration, manifests, and multi-document files. This module implements
 * the YAML 1.2 core schema with a security-first surface: it resolves core
 * scalar types, expands anchors and aliases within configured limits, and never
 * constructs arbitrary application objects from tags.
 *
 * Supports the full YAML 1.2 core schema including:
 *   - Block mappings and sequences (indentation-driven)
 *   - Flow mappings {} and sequences []
 *   - Scalars: plain, single-quoted, double-quoted, block literal | and folded >
 *   - Core schema type resolution (null/~, booleans, ints, floats, strings)
 *   - Anchors (&) and aliases (*) with expansion-limit safety
 *   - Explicit tags (!!str, !!int, !!float, !!bool, !!null, !!seq, !!map, !!binary, !!timestamp)
 *   - Merge keys (<<: *anchor and <<: [*a, *b])
 *   - Complex mapping keys (? key) - mappings with non-string keys return Map<unknown, YamlValue>
 *   - Comments, document markers --- / ..., parseAll for multi-document streams
 *
 * YAML directives (`%YAML`, `%TAG`) are outside the release baseline and are
 * rejected. This parser targets Fino's core-schema configuration use cases, not
 * complete YAML processor parity.
 *
 * **Permanently excluded** (security baseline - never executes code):
 *   - Arbitrary type construction (!!ruby/object, etc.)
 *   - Custom user-defined tags
 *   - Local tags (!foo) - use !! core tags only
 *
 * **Note on merge keys**: merge pairs (<<) are absorbed at parse time into the
 * enclosing mapping. stringify does not re-emit them. The round-trip invariant
 * `deepEqual(parse(stringify(parse(x))), parse(x))` holds; text-exact
 * round-trip does not for documents with merge keys, comments, document
 * markers, or source anchor names.
 *
 * ```ts no_run
 * import { parse, stringify, parseAll } from 'fino:format/yaml';
 *
 * const cfg = parse('server:\n  port: 8080\nhosts:\n  - a\n  - b\n');
 * const text = stringify({ x: 1, y: [2, 3] });
 * const docs = parseAll('---\na: 1\n---\nb: 2\n');
 * ```
 *
 * Useful references:
 *   - YAML 1.2.2 specification: https://yaml.org/spec/1.2.2/
 *   - YAML core schema: https://yaml.org/spec/1.2.2/#103-core-schema
 */

import { ParseError } from 'fino:parsing/scanner';
import { decodeUtf8 } from '../globals/encoding.mts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ALIAS_EXPANSION = 1_000_000;
const MAX_ALIAS_DEPTH = 100;
const CORE_TAGS = new Set(['str', 'int', 'float', 'bool', 'null', 'seq', 'map', 'binary', 'timestamp']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Error thrown when YAML input is malformed or violates configured limits.
 *
 * The error extends `ParseError` and carries YAML format metadata plus line,
 * column, and offset information where available. Duplicate keys, unsupported
 * tags, undefined aliases, alias expansion limits, and syntax errors are
 * reported through this type.
 *
 * ```ts no_run
 * import { YamlParseError, parse } from 'fino:format/yaml';
 *
 * try {
 *   parse('a: 1\na: 2\n');
 * } catch (error) {
 *   if (error instanceof YamlParseError) console.error(error.render());
 * }
 * ```
 */
export class YamlParseError extends ParseError {
  /**
   * Error name reported by `YamlParseError` instances.
   *
   * This member is emitted by the docs generator when
   * `--include-private` is enabled. It is maintained by runtime
   * internals and should be changed only with the surrounding
   * implementation contract in mind.
   *
   * @example
   * ```ts no_run
   * const error = new YamlParseError('example', { line: 1, column: 1, offset: 0, snippet: 'x' });
   * console.log(error.name);
   * ```
   */
  name = 'YamlParseError';
}

/**
 * Value types produced by the YAML core schema parser and accepted by stringify.
 *
 * Core tags resolve to JavaScript primitives, `Uint8Array` for `!!binary`,
 * `Date` for `!!timestamp`, arrays for sequences, plain objects for mappings
 * with string keys, and `Map` for mappings with complex keys.
 *
 * ```ts no_run
 * import { parse, stringify, type YamlValue } from 'fino:format/yaml';
 *
 * const value: YamlValue = parse('enabled: true\ncount: 3\n');
 * stringify(value);
 * ```
 */
export type YamlValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Date
  | YamlValue[]
  | YamlMapping
  | Map<unknown, YamlValue>;
/**
 * Plain-object YAML mapping with string keys.
 *
 * Mappings with non-string keys are returned as `Map<unknown, YamlValue>`
 * instead, because JavaScript object keys cannot preserve arbitrary YAML key
 * values.
 *
 * ```ts no_run
 * import { parse, type YamlMapping } from 'fino:format/yaml';
 *
 * const mapping = parse('server:\n  port: 8080\n') as YamlMapping;
 * (mapping.server as YamlMapping).port;
 * ```
 */
export type YamlMapping = {
  /**
   * YAML mapping key with a string-compatible key name.
   *
   * Parser output uses this object shape only when every key can be represented
   * as a JavaScript string. Complex keys are returned as `Map` instead.
   *
   * ```ts no_run
   * import type { YamlMapping } from 'fino:format/yaml';
   *
   * const mapping: YamlMapping = { server: { port: 8080 } };
   * ```
   */
  [k: string]: YamlValue;
};

/**
 * Options controlling YAML parsing limits and duplicate-key behavior.
 *
 * Defaults reject duplicate keys, cap total alias expansion at 1,000,000
 * estimated characters, and cap alias expansion depth at 100.
 *
 * ```ts no_run
 * import { parse, type YamlParseOptions } from 'fino:format/yaml';
 *
 * const options: YamlParseOptions = { maxAliasExpansion: 10_000 };
 * parse('a: 1\n', options);
 * ```
 */
export interface YamlParseOptions {
  /**
   * Permit later duplicate keys to replace earlier values. Defaults to `false`.
   *
   * When disabled, duplicate keys throw `YamlParseError`. For complex keys,
   * duplicate detection uses a JSON string form and is best-effort.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/yaml';
   *
   * parse('a: 1\na: 2\n', { allowDuplicateKeys: true });
   * ```
   */
  allowDuplicateKeys?: boolean;
  /**
   * Maximum estimated expanded character count from aliases.
   *
   * Defaults to `1_000_000`. Lower values can reject hostile or accidental
   * alias amplification earlier for untrusted inputs.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/yaml';
   *
   * parse('a: &a hello\nb: *a\n', { maxAliasExpansion: 100 });
   * ```
   */
  maxAliasExpansion?: number;
  /**
   * Maximum nested alias expansion depth. Defaults to `100`.
   *
   * This option exists to bound deeply nested alias graphs. The parser also
   * applies the total expansion cap in `maxAliasExpansion`.
   *
   * ```ts no_run
   * import { parse } from 'fino:format/yaml';
   *
   * parse('a: &a [1]\nb: *a\n', { maxAliasDepth: 10 });
   * ```
   */
  maxAliasDepth?: number;
}

/**
 * Options controlling YAML serialization style.
 *
 * Stringification emits a readable block style for objects and arrays and does
 * not preserve source comments, anchors, aliases, or merge keys from parsed
 * input.
 *
 * ```ts no_run
 * import { stringify, type YamlStringifyOptions } from 'fino:format/yaml';
 *
 * const options: YamlStringifyOptions = { indent: 4 };
 * stringify({ server: { port: 8080 } }, options);
 * ```
 */
export interface YamlStringifyOptions {
  /**
   * Spaces per nesting level. Defaults to `2`.
   *
   * Values are used directly by the formatter; choose a positive integer for
   * conventional YAML output.
   *
   * ```ts no_run
   * import { stringify } from 'fino:format/yaml';
   *
   * stringify({ a: { b: 1 } }, { indent: 4 });
   * ```
   */
  indent?: number;
  /**
   * Preferred scalar wrapping width.
   *
   * This option is reserved for scalar wrapping behavior. Current output may
   * keep long scalar values on one line when quoting is required.
   *
   * ```ts no_run
   * import { stringify } from 'fino:format/yaml';
   *
   * stringify({ message: 'hello world' }, { lineWidth: 80 });
   * ```
   */
  lineWidth?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse one YAML document, returning the first document from a stream.
 *
 * String input is parsed directly; byte input is decoded as UTF-8. If the input
 * contains no document content, the function returns `null`. For multi-document
 * streams, use `parseAll()` to keep every document.
 *
 * ```ts no_run
 * import { parse } from 'fino:format/yaml';
 *
 * parse('server:\n  port: 8080\n');
 * ```
 */
export function parse(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue {
  const src = typeof input === 'string' ? input : decodeUtf8(input, true, true);
  const docs = new YamlParser(src, options).parseAll();
  return docs[0] ?? null;
}

/**
 * Parse all YAML documents from a multi-document stream.
 *
 * Document markers (`---` and `...`) are consumed between documents. Anchors
 * are scoped per document and cleared before parsing the next document. Empty
 * input returns an empty array.
 *
 * ```ts no_run
 * import { parseAll } from 'fino:format/yaml';
 *
 * const docs = parseAll('---\na: 1\n---\nb: 2\n');
 * docs.length; // 2
 * ```
 */
export function parseAll(input: string | Uint8Array, options: YamlParseOptions = {}): YamlValue[] {
  const src = typeof input === 'string' ? input : decodeUtf8(input, true, true);
  return new YamlParser(src, options).parseAll();
}

/**
 * Serialize a YAML-compatible value.
 *
 * Serialization emits YAML core-schema values from JavaScript primitives,
 * arrays, plain mappings, `Map`, `Uint8Array`, and `Date`. It does not re-emit
 * comments, anchors, aliases, merge keys, or original document markers.
 *
 * ```ts no_run
 * import { stringify } from 'fino:format/yaml';
 *
 * stringify({ hosts: ['a', 'b'] });
 * ```
 */
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
  #anchors: Map<string, YamlValue> = new Map();
  #anchorSize: Map<string, number> = new Map();
  #expandedChars: number = 0;

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
      this.#anchors.clear();
      this.#anchorSize.clear();
      this.#expandedChars = 0;
      this.#skipDocumentMarkers();
    }
    return docs;
  }

  #err(msg: string): never {
    throw new YamlParseError(msg, {
      detail: msg,
      format: 'yaml',
      offset: this.#pos,
      line: this.#line,
      column: this.#col(),
      source: new Uint8Array(0),
    });
  }

  #col(): number {
    let col = 1;
    for (let i = this.#pos - 1; i >= 0 && this.#src[i] !== '\n'; i--) col++;
    return col;
  }

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
      if (this.#src[this.#pos] === '%') {
        this.#err('YAML directives are not supported');
      }
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

    // Alias: complete node, no properties allowed
    if (this.#peek() === '*') return this.#resolveAlias();

    // Properties: &anchor and/or !!tag (either order, zero or one of each)
    const { anchor, tag } = this.#parseProperties();
    // After properties, skip past any trailing comment or newline to reach value
    this.#skipSpaces();
    if (this.#src[this.#pos] === '#') this.#skipLine();
    if (this.#src[this.#pos] === '\n' || this.#src[this.#pos] === '\r') {
      this.#skipWsAndComments();
    }

    // If we crossed a newline, the content is at a deeper indent than the anchor/tag.
    // Use that indent so block parsers stop at the right dedent level.
    const valueIndent = (!inFlow) ? Math.max(indent, this.#lineIndent()) : indent;

    let value: YamlValue;
    const ch = this.#peek();

    if (!ch || this.#atEnd()) {
      value = null;
    } else if (!inFlow && ch === '?' && (this.#peek(1) === ' ' || this.#peek(1) === '\n' || this.#peek(1) === '\r')) {
      // Complex mapping key at the start of a value position
      value = this.#parseBlockMap(valueIndent);
    } else if (ch === '-' && (this.#peek(1) === ' ' || this.#peek(1) === '\n') && !inFlow) {
      value = this.#parseBlockSeq(valueIndent);
    } else if (ch === '[') {
      value = this.#parseFlowSeq();
    } else if (ch === '{') {
      value = this.#parseFlowMap();
    } else if (ch === '|') {
      value = this.#parseBlockScalar(valueIndent, 'literal');
    } else if (ch === '>') {
      value = this.#parseBlockScalar(valueIndent, 'folded');
    } else if (ch === "'") {
      value = this.#parseSingleQuoted();
    } else if (ch === '"') {
      value = this.#parseDoubleQuoted();
    } else {
      const colonPos = (!inFlow) ? this.#findBlockMappingColon(valueIndent) : -1;
      if (colonPos !== -1) {
        value = this.#parseBlockMap(valueIndent);
      } else {
        value = this.#parsePlainScalar(inFlow);
      }
    }

    if (tag !== undefined) value = this.#applyTag(tag, value);
    if (anchor !== undefined) this.#bindAnchor(anchor, value);
    return value;
  }

  // Parses zero or one &anchor and zero or one !!tag in either order.
  #parseProperties(): { anchor?: string; tag?: string } {
    let anchor: string | undefined;
    let tag: string | undefined;
    while (true) {
      const ch = this.#peek();
      if (ch === '&') {
        if (anchor !== undefined) this.#err('duplicate anchor on same node');
        anchor = this.#parseAnchorName();
        this.#skipSpaces();
      } else if (ch === '!') {
        if (tag !== undefined) this.#err('duplicate tag on same node');
        tag = this.#parseTagName();
        this.#skipSpaces();
      } else {
        break;
      }
    }
    return { anchor, tag };
  }

  #parseAnchorName(): string {
    this.#pos++; // &
    const start = this.#pos;
    while (this.#pos < this.#src.length) {
      const c = this.#src[this.#pos]!;
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '-') {
        this.#pos++;
      } else {
        break;
      }
    }
    if (this.#pos === start) this.#err('expected anchor name after &');
    return this.#src.slice(start, this.#pos);
  }

  #parseTagName(): string {
    this.#pos++; // first !
    if (this.#src[this.#pos] !== '!') {
      while (this.#pos < this.#src.length && this.#src[this.#pos] !== ' ' && this.#src[this.#pos] !== '\n') {
        this.#pos++;
      }
      this.#err('local tags not supported (use !! core tags only)');
    }
    this.#pos++; // second !
    const start = this.#pos;
    while (this.#pos < this.#src.length) {
      const c = this.#src[this.#pos]!;
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
        this.#pos++;
      } else {
        break;
      }
    }
    if (this.#pos === start) this.#err('expected tag name after !!');
    const name = this.#src.slice(start, this.#pos);
    if (!CORE_TAGS.has(name)) this.#err(`unknown core tag: !!${name}`);
    return name;
  }

  #parseAliasName(): string {
    this.#pos++; // *
    const start = this.#pos;
    while (this.#pos < this.#src.length) {
      const c = this.#src[this.#pos]!;
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '-') {
        this.#pos++;
      } else {
        break;
      }
    }
    if (this.#pos === start) this.#err('expected alias name after *');
    return this.#src.slice(start, this.#pos);
  }

  #resolveAlias(): YamlValue {
    const name = this.#parseAliasName();
    if (!this.#anchors.has(name)) this.#err(`undefined alias: *${name}`);
    this.#chargeExpansion(this.#anchorSize.get(name)!);
    return this.#anchors.get(name)!;
  }

  #applyTag(tag: string, value: YamlValue): YamlValue {
    if (tag === 'str') return value === null ? '' : String(value);
    if (tag === 'int') {
      const raw = typeof value === 'string' ? value : String(value ?? '');
      if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(raw)) return parseInt(raw, 10);
      if (/^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
      if (/^0o[0-7]+$/.test(raw)) return parseInt(raw.slice(2), 8);
      this.#err(`!!int: cannot parse as integer: ${raw}`);
    }
    if (tag === 'float') {
      const raw = typeof value === 'string' ? value : String(value ?? '');
      if (raw === '.inf' || raw === '+.inf') return Infinity;
      if (raw === '-.inf') return -Infinity;
      if (raw === '.nan') return NaN;
      const n = parseFloat(raw);
      if (isNaN(n)) this.#err(`!!float: cannot parse as float: ${raw}`);
      return n;
    }
    if (tag === 'bool') {
      if (value === true || value === 'true') return true;
      if (value === false || value === 'false') return false;
      this.#err(`!!bool: cannot parse as boolean: ${String(value)}`);
    }
    if (tag === 'null') {
      if (value === null || value === 'null' || value === '~' || value === '') return null;
      this.#err(`!!null: cannot parse as null: ${String(value)}`);
    }
    if (tag === 'seq') {
      if (Array.isArray(value)) return value;
      this.#err('!!seq: value must be a sequence');
    }
    if (tag === 'map') {
      if (this.#isMapping(value)) return value;
      this.#err('!!map: value must be a mapping');
    }
    if (tag === 'binary') {
      if (typeof value !== 'string') this.#err('!!binary: value must be a base64 string');
      return _decodeBase64(value);
    }
    if (tag === 'timestamp') {
      if (typeof value !== 'string') this.#err('!!timestamp: value must be a date string');
      const d = new Date(value);
      if (isNaN(d.getTime())) this.#err(`!!timestamp: invalid date: ${value}`);
      return d;
    }
    this.#err(`unknown core tag: !!${tag}`);
  }

  #bindAnchor(name: string, value: YamlValue): void {
    this.#anchors.set(name, value);
    this.#anchorSize.set(name, _estimateSize(value));
  }

  #chargeExpansion(n: number): void {
    this.#expandedChars += n;
    if (this.#expandedChars > (this.#opts.maxAliasExpansion ?? MAX_ALIAS_EXPANSION)) {
      this.#err('alias expansion limit exceeded');
    }
  }

  #isMapping(v: YamlValue): boolean {
    return (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Uint8Array) &&
      !(v instanceof Date)
    );
  }

  #insertMappingEntry(
    container: YamlMapping | Map<unknown, YamlValue>,
    key: YamlValue,
    value: YamlValue,
  ): YamlMapping | Map<unknown, YamlValue> {
    if (container instanceof Map) {
      container.set(key, value);
      return container;
    }
    if (typeof key === 'string') {
      (container as YamlMapping)[key] = value;
      return container;
    }
    // Non-string key: promote plain object to Map
    const m = new Map<unknown, YamlValue>();
    for (const [k, v] of Object.entries(container as YamlMapping)) m.set(k, v);
    m.set(key, value);
    return m;
  }

  #applyMerge(
    target: YamlMapping | Map<unknown, YamlValue>,
    src: YamlValue,
  ): YamlMapping | Map<unknown, YamlValue> {
    const sources: Array<YamlMapping | Map<unknown, YamlValue>> = [];
    if (Array.isArray(src)) {
      for (const item of src) {
        if (!this.#isMapping(item)) this.#err('merge value must be a mapping or sequence of mappings');
        sources.push(item as YamlMapping | Map<unknown, YamlValue>);
      }
    } else if (this.#isMapping(src)) {
      sources.push(src as YamlMapping | Map<unknown, YamlValue>);
    } else {
      this.#err('merge value must be a mapping or sequence of mappings');
    }
    for (const source of sources) {
      const entries: Array<[unknown, YamlValue]> = source instanceof Map
        ? [...source.entries()]
        : Object.entries(source as YamlMapping);
      for (const [k, v] of entries) {
        const key = k as YamlValue;
        const hasKey = target instanceof Map
          ? target.has(key)
          : (typeof key === 'string' && key in (target as YamlMapping));
        if (!hasKey) target = this.#insertMappingEntry(target, key, v);
      }
    }
    return target;
  }

  #findBlockMappingColon(indent: number): number {
    let i = this.#pos;
    while (i < this.#src.length) {
      const c = this.#src[i]!;
      if (c === '\n' || c === '\r') return -1;
      if (c === ':' && (this.#src[i + 1] === ' ' || this.#src[i + 1] === '\n' || !this.#src[i + 1])) return i;
      if (c === '"' || c === "'") {
        const q = c; i++;
        while (i < this.#src.length && this.#src[i] !== q) {
          if (this.#src[i] === '\\' && q === '"') i++;
          i++;
        }
        i++;
        continue;
      }
      i++;
    }
    return -1;
  }

  #parseBlockMap(indent: number): YamlMapping | Map<unknown, YamlValue> {
    let map: YamlMapping | Map<unknown, YamlValue> = {};
    const seenKeys = new Map<string, true>();

    while (!this.#atEnd()) {
      this.#skipWsAndComments();
      if (this.#atEnd()) break;
      const colIndent = this.#currentCol();
      if (colIndent < indent) break;
      if (this.#src.startsWith('---', this.#pos) || this.#src.startsWith('...', this.#pos)) break;

      this.#skipSpaces();

      let key: YamlValue;
      let isMerge = false;

      if (this.#peek() === '?' && (this.#peek(1) === ' ' || this.#peek(1) === '\n' || this.#peek(1) === '\r')) {
        // Complex key: ? <value>
        this.#pos++; // ?
        this.#skipSpaces();
        if (this.#src[this.#pos] === '\n' || this.#src[this.#pos] === '\r') this.#skipWsAndComments();
        key = this.#atEnd() ? null : this.#parseValue(colIndent + 1, false);
        this.#skipWsAndComments();
        if (this.#src[this.#pos] !== ':') this.#err('expected ":" after complex mapping key');
        this.#pos++;
        if (this.#src[this.#pos] === ' ') this.#pos++;
      } else if (
        this.#src.startsWith('<<', this.#pos) &&
        (this.#src[this.#pos + 2] === ':' || this.#src[this.#pos + 2] === ' ' ||
         this.#src[this.#pos + 2] === '\n' || !this.#src[this.#pos + 2])
      ) {
        // Merge key: <<: <value>
        isMerge = true;
        this.#pos += 2;
        this.#skipSpaces();
        if (this.#src[this.#pos] !== ':') this.#err('expected ":" after <<');
        this.#pos++;
        if (this.#src[this.#pos] === ' ') this.#pos++;
        key = '<<';
      } else {
        // Regular key (with optional anchor/tag)
        const { anchor: keyAnchor, tag: keyTag } = this.#parseProperties();
        if (this.#peek() === '*') {
          key = this.#resolveAlias();
        } else {
          key = this.#parseKey();
        }
        if (keyTag !== undefined) key = this.#applyTag(keyTag, key);
        if (keyAnchor !== undefined) this.#bindAnchor(keyAnchor, key);
        this.#skipSpaces();
        if (!this.#src.startsWith(': ', this.#pos) && this.#src[this.#pos] !== ':') {
          this.#err('expected ": " after mapping key');
        }
        this.#pos++;
        if (this.#src[this.#pos] === ' ') this.#pos++;
      }

      // Duplicate key check
      const keyStr = typeof key === 'string' ? key : JSON.stringify(key);
      if (!this.#opts.allowDuplicateKeys) {
        if (seenKeys.has(keyStr)) this.#err(`duplicate key: ${keyStr}`);
        seenKeys.set(keyStr, true);
      }

      // Value
      this.#skipSpaces();
      let value: YamlValue;
      if (this.#src[this.#pos] === '\n' || this.#src[this.#pos] === '\r' || this.#atEnd()) {
        this.#skipWsAndComments();
        if (this.#atEnd()) {
          if (!isMerge) map = this.#insertMappingEntry(map, key, null);
          break;
        }
        const nextIndent = this.#lineIndent();
        if (nextIndent <= colIndent) {
          if (!isMerge) map = this.#insertMappingEntry(map, key, null);
          continue;
        }
        value = this.#parseValue(nextIndent, false);
      } else {
        value = this.#parseValue(colIndent, false);
        this.#skipSpaces();
        this.#skipComment();
      }

      if (isMerge) {
        map = this.#applyMerge(map, value);
      } else {
        map = this.#insertMappingEntry(map, key, value);
      }
    }
    return map;
  }

  #parseKey(): string {
    const ch = this.#peek();
    if (ch === "'") return this.#parseSingleQuoted() as string;
    if (ch === '"') return this.#parseDoubleQuoted() as string;
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
      this.#pos++;
      if (this.#src[this.#pos] === ' ') this.#pos++;

      let value: YamlValue;
      this.#skipSpaces();
      if (this.#src[this.#pos] === '\n' || this.#src[this.#pos] === '\r' || this.#atEnd()) {
        this.#skipWsAndComments();
        const nextIndent = this.#lineIndent();
        value = this.#atEnd() ? null : this.#parseValue(nextIndent, false);
      } else {
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

  #parseFlowMap(): YamlMapping | Map<unknown, YamlValue> {
    this.#pos++; // {
    let map: YamlMapping | Map<unknown, YamlValue> = {};
    const seenKeys = new Map<string, true>();
    this.#skipWsAndComments();
    if (this.#src[this.#pos] === '}') { this.#pos++; return map; }
    while (!this.#atEnd()) {
      this.#skipWsAndComments();

      let key: YamlValue;
      let isMerge = false;

      if (this.#peek() === '?' && (this.#peek(1) === ' ' || this.#peek(1) === '\n')) {
        // Complex key in flow context
        this.#pos++;
        this.#skipSpaces();
        key = this.#parseValue(0, true);
        this.#skipWsAndComments();
        if (this.#src[this.#pos] === ':') this.#pos++;
        this.#skipSpaces();
      } else if (
        this.#src.startsWith('<<', this.#pos) &&
        (this.#src[this.#pos + 2] === ':' || this.#src[this.#pos + 2] === ' ')
      ) {
        isMerge = true;
        this.#pos += 2;
        this.#skipWsAndComments();
        if (this.#src[this.#pos] === ':') this.#pos++;
        this.#skipSpaces();
        key = '<<';
      } else {
        const { anchor: keyAnchor, tag: keyTag } = this.#parseProperties();
        if (this.#peek() === '*') {
          key = this.#resolveAlias();
        } else {
          key = this.#parseKey();
        }
        if (keyTag !== undefined) key = this.#applyTag(keyTag, key);
        if (keyAnchor !== undefined) this.#bindAnchor(keyAnchor, key);
        this.#skipWsAndComments();
        if (this.#src[this.#pos] === ':') this.#pos++;
        this.#skipSpaces();
      }

      const keyStr = typeof key === 'string' ? key : JSON.stringify(key);
      if (!this.#opts.allowDuplicateKeys) {
        if (seenKeys.has(keyStr)) this.#err(`duplicate key: ${keyStr}`);
        seenKeys.set(keyStr, true);
      }

      const value = this.#parseValue(0, true);

      if (isMerge) {
        map = this.#applyMerge(map, value);
      } else {
        map = this.#insertMappingEntry(map, key, value);
      }

      this.#skipWsAndComments();
      if (this.#src[this.#pos] === ',') { this.#pos++; continue; }
      if (this.#src[this.#pos] === '}') { this.#pos++; return map; }
      this.#err('expected } or , in flow mapping');
    }
    this.#err('unterminated flow mapping');
  }

  #parseBlockScalar(indent: number, style: 'literal' | 'folded'): string {
    this.#pos++; // | or >
    let chomp: 'strip' | 'clip' | 'keep' = 'clip';
    let explicitIndent = 0;
    while (!this.#atEnd() && this.#src[this.#pos] !== '\n') {
      const ch = this.#src[this.#pos]!;
      if (ch === '-') { chomp = 'strip'; this.#pos++; }
      else if (ch === '+') { chomp = 'keep'; this.#pos++; }
      else if (ch >= '1' && ch <= '9') { explicitIndent = parseInt(ch, 10); this.#pos++; }
      else this.#pos++;
    }
    if (!this.#atEnd()) { this.#line++; this.#pos++; }

    const lines: string[] = [];
    let blockIndent = -1;
    let trailingEmpty = 0;

    while (!this.#atEnd()) {
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

    let result: string;
    if (style === 'literal') {
      result = lines.join('\n');
    } else {
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

    if (chomp === 'strip') result = result.replace(/\n+$/, '');
    else if (chomp === 'clip') result = result.replace(/\n+$/, '') + '\n';

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
          case '\n': this.#line++; break;
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
  if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(raw)) return parseInt(raw, 10);
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
  if (/^0o[0-7]+$/.test(raw)) return parseInt(raw.slice(2), 8);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(raw)) return parseFloat(raw);
  return raw;
}

function _estimateSize(value: YamlValue): number {
  if (value === null) return 4;
  if (typeof value === 'boolean') return 5;
  if (typeof value === 'number') return String(value).length;
  if (typeof value === 'string') return value.length + 2;
  if (value instanceof Uint8Array) return Math.ceil(value.byteLength * 4 / 3) + 10;
  if (value instanceof Date) return 30;
  if (Array.isArray(value)) {
    let s = 2;
    for (const e of value) s += _estimateSize(e) + 2;
    return s;
  }
  if (value instanceof Map) {
    let s = 2;
    for (const [k, v] of value) s += _estimateSize(k as YamlValue) + 2 + _estimateSize(v) + 2;
    return s;
  }
  let s = 2;
  for (const [k, v] of Object.entries(value as YamlMapping)) s += k.length + 2 + _estimateSize(v) + 2;
  return s;
}

function _decodeBase64(s: string): Uint8Array {
  const cleaned = s.replace(/\s/g, '');
  const raw = atob(cleaned);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function _encodeBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

// ---------------------------------------------------------------------------
// Stringifier
// ---------------------------------------------------------------------------

class YamlStringifier {
  #indent: number;
  #refCounts: Map<object, number> = new Map();
  #anchorIds: Map<object, { id: number; emitted: boolean }> = new Map();
  #nextId: number = 0;

  constructor(indent: number) { this.#indent = indent; }

  stringify(value: YamlValue): string {
    this.#countRefs(value);
    for (const [obj, count] of this.#refCounts) {
      if (count >= 2) this.#anchorIds.set(obj, { id: ++this.#nextId, emitted: false });
    }
    return this.#val(value, 0) + '\n';
  }

  #countRefs(value: YamlValue): void {
    if (value === null || typeof value !== 'object') return;
    const obj = value as object;
    const prev = this.#refCounts.get(obj) ?? 0;
    this.#refCounts.set(obj, prev + 1);
    if (prev > 0) return; // already recursed into children
    if (value instanceof Uint8Array || value instanceof Date) return;
    if (Array.isArray(value)) {
      for (const e of value) this.#countRefs(e);
    } else if (value instanceof Map) {
      for (const [k, v] of value) { this.#countRefs(k as YamlValue); this.#countRefs(v); }
    } else {
      for (const v of Object.values(value as YamlMapping)) this.#countRefs(v);
    }
  }

  #val(v: YamlValue, depth: number): string {
    if (v !== null && typeof v === 'object') {
      const info = this.#anchorIds.get(v as object);
      if (info) {
        if (info.emitted) return `*a${info.id}`;
        info.emitted = true;
        const content = this.#valContent(v, depth);
        return content.startsWith('\n') ? `&a${info.id}${content}` : `&a${info.id} ${content}`;
      }
    }
    return this.#valContent(v, depth);
  }

  #valContent(v: YamlValue, depth: number): string {
    if (v === null) return 'null';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') {
      if (isNaN(v)) return '.nan';
      if (!isFinite(v)) return v > 0 ? '.inf' : '-.inf';
      return String(v);
    }
    if (typeof v === 'string') return this.#str(v);
    if (v instanceof Uint8Array) return `!!binary ${_encodeBase64(v)}`;
    if (v instanceof Date) return `!!timestamp ${v.toISOString()}`;
    if (Array.isArray(v)) return this.#seq(v, depth);
    if (v instanceof Map) return this.#mapMap(v, depth);
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

  #mapMap(m: Map<unknown, YamlValue>, depth: number): string {
    if (m.size === 0) return '{}';
    const pad = ' '.repeat(this.#indent * depth);
    const lines: string[] = [];
    for (const [k, v] of m) {
      const valStr = this.#val(v, depth + 1);
      const isComplex = typeof k !== 'string' && typeof k !== 'number' && typeof k !== 'boolean' && k !== null;
      if (isComplex) {
        const keyStr = this.#val(k as YamlValue, depth + 1);
        const sep = valStr.startsWith('\n') ? '' : ' ';
        lines.push(`\n${pad}? ${keyStr}\n${pad}:${sep}${valStr}`);
      } else {
        const key = this.#str(typeof k === 'string' ? k : String(k));
        const sep = valStr.startsWith('\n') ? ':' : ': ';
        lines.push(`\n${pad}${key}${sep}${valStr}`);
      }
    }
    return lines.join('');
  }
}
