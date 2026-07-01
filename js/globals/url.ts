/**
* WHATWG URL and URLSearchParams globals.
*
* This is a pure-JS implementation of the common WHATWG URL Standard
* (https://url.spec.whatwg.org/) surface used by the runtime. It handles
* absolute URL parsing, relative URL resolution against a base, URL property
* mutation/serialization, and URLSearchParams construction, mutation, and
* iteration semantics. No native binding or C library is used; all parsing is
* done in JS.
*
* The release baseline is intentionally practical rather than WPT-complete.
* Coverage locks common HTTP(S), file, special and non-special scheme behavior,
* IDNA/Punycode host serialization, bracketed IPv6 normalization, numeric IPv4
* forms, percent-encoding through setters, relative-path/query/hash
* resolution, and live URLSearchParams mutation during iteration.
*
*
* ## Architecture
*
* A parsed URL is stored as a plain object with six string fields:
*
*   { scheme, username, password, host, port, pathname, search, hash }
*
* This "state object" is the single source of truth for all property getters.
* Setters mutate the state object directly (e.g. `url.hostname = 'foo'` sets
* `state.host`). Serialization via `_serialize()` concatenates the fields in
* the correct order.
*
* `URLSearchParams` has an `#onUpdate` callback. When a `URLSearchParams`
* instance is attached to a `URL` (via `url.searchParams`), mutations to
* the params object call `onUpdate(queryString)`, which stores the new query
* string back into `url.#state.search`. Conversely, when `url.search` is set
* directly, `url.#params.setQuery()` is called to resync the params list.
* This keeps the URL's `search` property and its `searchParams` in sync
* without a round-trip through the full parser.
*
*
* ## URL parsing
*
* `_parseURL(input, base)` is a hand-rolled parser, not the complete
* state-machine/tokenizer specified by the WHATWG standard. It handles the
* release baseline:
*
* - Absolute URLs with authority (`scheme://user:pass@host:port/path?q#f`)
* - Opaque URLs without authority (`data:`, `javascript:`)
* - Relative URLs resolved against a base via `_resolveRelative()`
*
* Relative resolution follows RFC 3986 §5.2: same-fragment, same-query,
* protocol-relative, absolute-path, and relative-path references are each
* handled as a special case before falling through to the generic merge-with-
* base-directory logic.
*
* `_normalizePath()` resolves `.` and `..` segments in slash-based output
* paths. Opaque non-special paths, such as `custom:opaque/./value`, preserve
* their path text because relative path merging is not valid for opaque bases.
*
*
* ## Default port stripping
*
* The WHATWG spec says that default ports must be excluded from the URL
* serialization. `_parseURL` strips default ports on parse (e.g. `:80` for
* HTTP, `:443` for HTTPS), so they never appear in `url.port` or `url.href`.
* Setters that modify the scheme or port also strip defaults.
*
*
* ## URLSearchParams encoding
*
* URLSearchParams uses `application/x-www-form-urlencoded` encoding, which
* differs from URL component percent-encoding in two ways: spaces become `+`
* (not `%20`), and the safe character set is narrower. The `_formEncode` /
* `_formDecode` helpers implement this. For multi-byte characters they
* delegate to the built-in `encodeURIComponent` / `decodeURIComponent` rather
* than re-implementing the UTF-8 encoder. Mutation methods preserve the
* observable WHATWG ordering contract for common cases: `append()` adds to the
* end, `set()` keeps the first matching position and removes later duplicates,
* `sort()` is stable for duplicate names, and iterators observe live changes.
*
*
* ## Host normalization
*
* Domain hostnames are lowercased and serialized through a small Punycode
* encoder for IDNA-style labels. Bracketed IPv6 addresses are validated,
* expanded, and compressed to canonical shortest-form text. Special-scheme
* numeric IPv4 host forms are normalized to dotted decimal.
*
*
* ## What is NOT implemented
*
* - Full WHATWG URL state machine/tokenizer parity with all parser states.
* - The full host parser validation matrix for every invalid IPv4/domain edge.
* - WPT-level coverage for every control-character, Windows path, and
*   non-special scheme edge.
*
* These omissions are intentional. The implemented subset covers practical
* runtime URL handling and documented release corpus behavior. Add missing
* features only when a concrete use case requires them.
*
*
* ```ts no_run
* // URL and URLSearchParams are available via globalThis
*
* const url = new URL('https://user:pass@example.com:8080/path?q=1#frag');
* url.protocol    // 'https:'
* url.hostname    // 'example.com'
* url.port        // '8080'
* url.pathname    // '/path'
* url.search      // '?q=1'
* url.hash        // '#frag'
* url.origin      // 'https://example.com:8080'
*
* // Relative URL resolution
* const u = new URL('../other', 'http://example.com/a/b/');
* u.href  // 'http://example.com/a/other'
*
* // URLSearchParams
* const p = new URLSearchParams('a=1&b=hello+world');
* p.get('b')  // 'hello world'
* p.toString()  // 'a=1&b=hello+world'
* ```
*
*/
import { v4 as _uuidV4 } from 'fino:uuid';
import { Blob } from './blob.ts';
// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------
interface URLState {
  scheme: string;
  username: string;
  password: string;
  host: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
}
const _blobUrlStore = new Map<string, Blob>();
function _currentObjectUrlOrigin(): string {
  const location = (globalThis as {
    location?: unknown;
  }).location;
  if (location === undefined || location === null) return 'null';
  const state = _parseURL(String(location), null);
  return state === null ? 'null' : _origin(state);
}
function _objectUrlWithoutFragment(url: string): string {
  const hashIndex = url.indexOf('#');
  return hashIndex < 0 ? url : url.slice(0, hashIndex);
}
function _stripURLTabsAndNewlines(value: string): string {
  return value.replace(/[\x09\x0a\x0d]/g, '');
}
/**
* Resolve a `blob:` object URL to the Blob it was created for.
*
* Fragment identifiers are ignored during resolution, matching the File API
* dereferencing model. Query strings and extra path segments remain part of
* the lookup key and therefore do not resolve unless they were present in the
* original object URL.
*
* ```typescript no_run
* const url = URL.createObjectURL(new Blob(['data']));
* const blob = _resolveObjectURL(url);
* ```
*
* @internal
*/
export function _resolveObjectURL(url: string): Blob | null {
  // Only blob: URLs can resolve to an object; skip the full parse otherwise.
  // Request URLs are already-serialized hrefs, so a scheme prefix check is
  // sufficient and avoids a URL parse on every non-blob request.
  const s = String(url);
  if (s.length < 5 || (s.charCodeAt(0) | 32) !== 98 || !/^blob:/i.test(s)) {
    return null;
  }
  const parsed = _parseURL(s, null);
  if (parsed === null || parsed.scheme !== 'blob') return null;
  return _blobUrlStore.get(_objectUrlWithoutFragment(_serialize(parsed))) ?? null;
}
// ---------------------------------------------------------------------------
// application/x-www-form-urlencoded encoding (used by URLSearchParams)
// ---------------------------------------------------------------------------
function _toHex2(n: number): string {
  const h = n.toString(16).toUpperCase();
  return h.length === 1 ? '0' + h : h;
}
// ---------------------------------------------------------------------------
// Percent-encoding (WHATWG URL Standard)
// ---------------------------------------------------------------------------
// Encode a single code point as %XX (or %XX%XX... for multi-byte).
function _pctEncodeCP(cp: number): string {
  if (cp < 128) return '%' + _toHex2(cp);
  // Multi-byte UTF-8
  let encoded = '';
  if (cp < 2048) {
    encoded = '%' + _toHex2(192 | cp >> 6) + '%' + _toHex2(128 | cp & 63);
  } else if (cp < 65536) {
    encoded = '%' + _toHex2(224 | cp >> 12) + '%' + _toHex2(128 | cp >> 6 & 63) + '%' + _toHex2(128 | cp & 63);
  } else {
    encoded = '%' + _toHex2(240 | cp >> 18) + '%' + _toHex2(128 | cp >> 12 & 63) + '%' + _toHex2(128 | cp >> 6 & 63) + '%' + _toHex2(128 | cp & 63);
  }
  return encoded;
}
// Percent-encode `str` using the given encode-set (a string of chars to encode).
// Existing valid %XX sequences are passed through unchanged (no double-encoding).
// Any char in the encode set, any non-ASCII char, or any C0/DEL control is encoded.
function _percentEncode(str: string, encodeSet: string): string {
  // Fast path: most components (ASCII paths/queries with no reserved chars or
  // existing escapes) need no encoding at all. Scan once and return the input
  // unchanged, avoiding per-char string building.
  let needsEncoding = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 31 || code === 37 || code > 126 || encodeSet.indexOf(str[i]!) >= 0) {
      needsEncoding = true;
      break;
    }
  }
  if (!needsEncoding) return str;
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const code = str.charCodeAt(i);
    // Pass through existing valid percent-encoded triplets
    if (c === '%' && i + 2 < str.length && /^[0-9A-Fa-f]{2}$/.test(str.slice(i + 1, i + 3))) {
      result += str.slice(i, i + 3);
      i += 2;
      continue;
    }
    // C0 controls (0x00-0x1F), DEL (0x7F), and non-ASCII (>0x7E) are always encoded
    if (code <= 31 || code === 127 || code > 126) {
      // Handle surrogate pairs for non-ASCII
      let cp = code;
      if (code >= 55296 && code <= 56319 && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 56320 && lo <= 57343) {
          cp = 65536 + (code - 55296 << 10) + (lo - 56320);
          i++;
        }
      }
      result += _pctEncodeCP(cp);
      continue;
    }
    // Characters in the encode set
    if (encodeSet.indexOf(c!) >= 0) {
      result += _pctEncodeCP(code);
      continue;
    }
    result += c;
  }
  return result;
}
// WHATWG URL encode sets (chars beyond C0/non-ASCII that must be encoded per component)
const _FRAGMENT_ENCODE_SET = ' "\'<>`';
const _QUERY_ENCODE_SET = ' "#\'<>';
const _PATH_ENCODE_SET = ' "#<>?`{}';
const _USERINFO_ENCODE_SET = ' "\'#/:;<=>?@[\\]^`{|}~';
function _encodeOpaquePath(path: string, hadSuffix: boolean): string {
  if (!hadSuffix) return _percentEncode(path, _PATH_ENCODE_SET);
  let encoded = _percentEncode(path, _PATH_ENCODE_SET.replace(' ', ''));
  if (encoded.endsWith(' ')) encoded = encoded.slice(0, -1) + '%20';
  return encoded;
}
/**
* Encode a string using application/x-www-form-urlencoded percent-encoding.
* Spaces → '+'; other non-safe chars → %XX.
*/
function _formEncode(str: string): string {
  str = _toUSVString(str);
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const code = str.charCodeAt(i);
    // Safe characters: A-Z a-z 0-9 * - . _
    if (code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || c === '*' || c === '-' || c === '.' || c === '_') {
      result += c;
    } else if (code === 32) {
      result += '+';
    } else {
      let cp = code;
      if (code >= 55296 && code <= 56319 && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 56320 && lo <= 57343) {
          cp = 65536 + (code - 55296 << 10) + (lo - 56320);
          i++;
        }
      }
      const bytes: number[] = [];
      _pushUTF8Bytes(bytes, cp);
      for (const byte of bytes) result += '%' + _toHex2(byte);
    }
  }
  return result;
}
function _pushUTF8Bytes(bytes: number[], cp: number): void {
  if (cp < 128) {
    bytes.push(cp);
  } else if (cp < 2048) {
    bytes.push(192 | cp >> 6, 128 | cp & 63);
  } else if (cp < 65536) {
    bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
  } else {
    bytes.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
  }
}
function _utf8DecodeReplacement(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i++]!;
    if (b0 < 128) {
      out += String.fromCharCode(b0);
      continue;
    }
    let needed = 0;
    let cp = 0;
    let min = 0;
    let max = 1114111;
    if (b0 >= 194 && b0 <= 223) {
      needed = 1;
      cp = b0 & 31;
      min = 128;
    } else if (b0 >= 224 && b0 <= 239) {
      needed = 2;
      cp = b0 & 15;
      min = 2048;
    } else if (b0 >= 240 && b0 <= 244) {
      needed = 3;
      cp = b0 & 7;
      min = 65536;
      max = 1114111;
    } else {
      out += '�';
      continue;
    }
    const start = i;
    let valid = true;
    for (let j = 0; j < needed; j++) {
      const b = bytes[i];
      if (b === undefined || b < 128 || b > 191) {
        valid = false;
        break;
      }
      cp = cp << 6 | b & 63;
      i++;
    }
    if (!valid || cp < min || cp > max || cp >= 55296 && cp <= 57343) {
      i = start;
      out += '�';
      continue;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}
function _toUSVString(value: unknown): string {
  const input = String(value);
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      if (i + 1 < input.length) {
        const lo = input.charCodeAt(i + 1);
        if (lo >= 56320 && lo <= 57343) {
          out += input[i]! + input[i + 1]!;
          i++;
          continue;
        }
      }
      out += '�';
    } else if (code >= 56320 && code <= 57343) {
      out += '�';
    } else {
      out += input[i]!;
    }
  }
  return out;
}
/**
*  Decode an application/x-www-form-urlencoded string. */
function _formDecode(str: string): string {
  const input = String(str);
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '+') {
      bytes.push(32);
      continue;
    }
    if (c === '%' && i + 2 < input.length && /^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    let cp = input.charCodeAt(i);
    if (cp >= 55296 && cp <= 56319 && i + 1 < input.length) {
      const lo = input.charCodeAt(i + 1);
      if (lo >= 56320 && lo <= 57343) {
        cp = 65536 + (cp - 55296 << 10) + (lo - 56320);
        i++;
      } else {
        cp = 65533;
      }
    } else if (cp >= 56320 && cp <= 57343) {
      cp = 65533;
    }
    _pushUTF8Bytes(bytes, cp);
  }
  return _utf8DecodeReplacement(bytes);
}
/**
*  Parse a query string into [[name, value], ...] pairs. */
function _parseQueryString(qs: string, stripLeadingQuestion = true): [string, string][] {
  const list: [string, string][] = [];
  if (!qs) return list;
  if (stripLeadingQuestion && qs.startsWith('?')) qs = qs.slice(1);
  for (const part of qs.split('&')) {
    if (part === '') continue;
    const eqIdx = part.indexOf('=');
    if (eqIdx >= 0) {
      list.push([_formDecode(part.slice(0, eqIdx)), _formDecode(part.slice(eqIdx + 1))]);
    } else {
      list.push([_formDecode(part), '']);
    }
  }
  return list;
}
// ---------------------------------------------------------------------------
// URLSearchParams
// ---------------------------------------------------------------------------
/**
* WHATWG URLSearchParams.
*
* When attached to a URL (via url.searchParams), mutations automatically
* update url.search.
*
* @example
* ```ts no_run
* const documentedClass = 'URLSearchParams';
* console.log(documentedClass);
* ```
*/
export class URLSearchParams {
  /**
  * Private property `#list` used by `URLSearchParams`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #list = undefined;
  *
  *   readInternalState() {
  *     return this.#list;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #list: [string, string][];
  /**
  * Private property `#onUpdate` used by `URLSearchParams`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #onUpdate = undefined;
  *
  *   readInternalState() {
  *     return this.#onUpdate;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #onUpdate: ((qs: string) => void) | null;
  /**
  * String tag used by Object.prototype.toString.
  *
  * ```typescript no_run
  * Object.prototype.toString.call(new URLSearchParams()); // "[object URLSearchParams]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'URLSearchParams';
  }
  /**
  * Create URLSearchParams from a query string, another URLSearchParams,
  * entries, or a record.
  *
  * String input may start with "?". Object input uses own enumerable string
  * keys. The onUpdate callback is internal and lets URL.searchParams update
  * its owning URL.
  *
  * ```typescript no_run
  * const params = new URLSearchParams('a=1&b=hello+world');
  * params.get('b'); // "hello world"
  * ```
  */
  constructor(init?: string | URLSearchParams | [string, string][] | Record<string, string> | null, onUpdate: ((qs: string) => void) | null = null) {
    this.#list = [];
    this.#onUpdate = onUpdate;
    if (init == null) return;
    if (typeof init === 'object' && init !== null && Symbol.iterator in init) {
      for (const pair of init as Iterable<unknown>) {
        if (typeof pair === 'string' || pair === null || typeof pair !== 'object' || !(Symbol.iterator in pair)) {
          throw new TypeError('URLSearchParams: each entry must be iterable');
        }
        const values = Array.from(pair as Iterable<unknown>);
        if (values.length !== 2) throw new TypeError('URLSearchParams: each entry must have exactly two elements');
        this.#list.push([_toUSVString(values[0]), _toUSVString(values[1])]);
      }
    } else if (typeof init === 'object' && init !== null || typeof init === 'function') {
      const seen = new Map<string, number>();
      const record = init as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const name = _toUSVString(key);
        const value = _toUSVString(record[key]);
        const existingIndex = seen.get(name);
        if (existingIndex === undefined) {
          seen.set(name, this.#list.length);
          this.#list.push([name, value]);
        } else {
          this.#list[existingIndex]![1] = value;
        }
      }
    } else {
      this.#list = _parseQueryString(String(init));
    }
  }
  /**
  * Number of stored entries, including duplicates.
  *
  * ```typescript no_run
  * const params = new URLSearchParams('a=1&a=2');
  * params.size; // 2
  * ```
  */
  get size() {
    return this.#list.length;
  }
  /**
  * Append a new name/value pair and preserve existing entries.
  *
  * Names and values are string-coerced. Attached URLs are updated after the
  * mutation.
  *
  * ```typescript no_run
  * const params = new URLSearchParams();
  * params.append('a', '1');
  * params.append('a', '2');
  * ```
  */
  append(name: string, value: string): void {
    this.#list.push([String(name), String(value)]);
    this.#notifyURL();
  }
  /**
  * Remove entries by name and optional value.
  *
  * When value is omitted, all entries with the name are removed. When value is
  * provided, only exact name/value pairs are removed.
  *
  * ```typescript no_run
  * const params = new URLSearchParams('a=1&a=2');
  * params.delete('a', '1');
  * params.toString(); // "a=2"
  * ```
  */
  delete(name: string, value?: string): void {
    name = String(name);
    const val = value === undefined ? undefined : String(value);
    for (let i = 0; i < this.#list.length;) {
      const entry = this.#list[i]!;
      if (entry[0] === name && (val === undefined || entry[1] === val)) {
        this.#list.splice(i, 1);
      } else {
        i++;
      }
    }
    this.#notifyURL();
  }
  /**
  * Return the first value for name, or null when absent.
  *
  * ```typescript no_run
  * new URLSearchParams('a=1&a=2').get('a'); // "1"
  * ```
  */
  get(name: string): string | null {
    name = String(name);
    for (const entry of this.#list) {
      if (entry[0] === name) return entry[1];
    }
    return null;
  }
  /**
  * Return all values for name in insertion order.
  *
  * The returned array is new and can be mutated by the caller.
  *
  * ```typescript no_run
  * new URLSearchParams('a=1&a=2').getAll('a'); // ["1", "2"]
  * ```
  */
  getAll(name: string): string[] {
    name = String(name);
    return this.#list.filter(function(e) {
      return e[0] === name;
    }).map(function(e) {
      return e[1];
    });
  }
  /**
  * Return true if a matching entry exists.
  *
  * With a value argument, both name and value must match.
  *
  * ```typescript no_run
  * const params = new URLSearchParams('a=1');
  * params.has('a', '1'); // true
  * ```
  */
  has(name: string, value?: string): boolean {
    name = String(name);
    if (value !== undefined) {
      const val = String(value);
      return this.#list.some(function(e) {
        return e[0] === name && e[1] === val;
      });
    }
    return this.#list.some(function(e) {
      return e[0] === name;
    });
  }
  /**
  * Set the value for a name (removes existing entries for that name).
  *
  * If the name exists, the first occurrence is replaced and later duplicates
  * are removed. Otherwise, a new entry is appended.
  *
  * ```typescript no_run
  * const params = new URLSearchParams('a=1&a=2');
  * params.set('a', '3');
  * params.toString(); // "a=3"
  * ```
  */
  set(name: string, value: string): void {
    name = String(name);
    value = String(value);
    let replaced = false;
    const next: [string, string][] = [];
    for (const entry of this.#list) {
      if (entry[0] === name) {
        if (!replaced) {
          next.push([name, value]);
          replaced = true;
        }
      } else {
        next.push(entry);
      }
    }
    if (!replaced) next.push([name, value]);
    this.#list = next;
    this.#notifyURL();
  }
  /**
  * Sort entries by name using string comparison.
  *
  * Equal names preserve their relative order. Attached URLs are updated.
  *
  * ```typescript no_run
  * const params = new URLSearchParams('b=2&a=1');
  * params.sort();
  * params.toString(); // "a=1&b=2"
  * ```
  */
  sort() {
    this.#list.sort(function(a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    this.#notifyURL();
  }
  /**
  * Serialize entries as application/x-www-form-urlencoded.
  *
  * Spaces become "+", duplicate names are preserved, and the output does not
  * include a leading question mark.
  *
  * ```typescript no_run
  * new URLSearchParams({ q: 'hello world' }).toString(); // "q=hello+world"
  * ```
  */
  toString() {
    return this.#list.map(function(e) {
      return _formEncode(e[0]) + '=' + _formEncode(e[1]);
    }).join('&');
  }
  /**
  * Iterate over [name, value] pairs.
  *
  * The iterator is live: entries appended during traversal can be observed by
  * the same iterator, matching URLSearchParams iteration semantics.
  *
  * ```typescript no_run
  * [...new URLSearchParams('a=1').entries()]; // [["a", "1"]]
  * ```
  */
  entries() {
    const params = this;
    let index = 0;
    return {
      next(): IteratorResult<[string, string]> {
        if (index >= params.#list.length) return {
          done: true,
          value: undefined as any
        };
        return {
          done: false,
          value: params.#list[index++]!
        };
      },
      [Symbol.iterator]() {
        return this;
      }
    };
  }
  /**
  * Iterate over names in insertion order.
  *
  * ```typescript no_run
  * [...new URLSearchParams('a=1').keys()]; // ["a"]
  * ```
  */
  keys() {
    const iter = this.entries();
    return {
      next(): IteratorResult<string> {
        const entry = iter.next();
        return entry.done ? {
          done: true,
          value: undefined as any
        } : {
          done: false,
          value: entry.value[0]
        };
      },
      [Symbol.iterator]() {
        return this;
      }
    };
  }
  /**
  * Iterate over values in insertion order.
  *
  * ```typescript no_run
  * [...new URLSearchParams('a=1').values()]; // ["1"]
  * ```
  */
  values() {
    const iter = this.entries();
    return {
      next(): IteratorResult<string> {
        const entry = iter.next();
        return entry.done ? {
          done: true,
          value: undefined as any
        } : {
          done: false,
          value: entry.value[1]
        };
      },
      [Symbol.iterator]() {
        return this;
      }
    };
  }
  /**
  * Call callback for each [name, value] pair.
  *
  * Callback arguments are value, name, and this URLSearchParams object.
  *
  * ```typescript no_run
  * const params = new URLSearchParams('a=1');
  * params.forEach((value, name) => console.log(name, value));
  * ```
  */
  forEach(callback: (value: string, name: string, parent: URLSearchParams) => void, thisArg?: unknown): void {
    for (const entry of this.#list) {
      callback.call(thisArg, entry[1], entry[0], this);
    }
  }
  /**
  * Default iterator over [name, value] pairs.
  *
  * ```typescript no_run
  * for (const [name, value] of new URLSearchParams('a=1')) console.log(name, value);
  * ```
  */
  [Symbol.iterator]() {
    return this.entries();
  }
  /**
  * Update the list from a raw query string.
  *
  * This internal hook is called by URL when its search setter runs. It accepts
  * strings with or without a leading question mark and does not call onUpdate.
  *
  * ```typescript no_run
  * const params = new URLSearchParams();
  * params.setQuery('a=1');
  * params.get('a'); // "1"
  * ```
  *
  * @internal
  */
  setQuery(str: string): void {
    this.#list = _parseQueryString(str, false);
  }
  /**
  * Private method `#notifyURL` used by `URLSearchParams`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #notifyURL() {
  *     return 'notifyURL';
  *   }
  *
  *   useInternalMethod() {
  *     return this.#notifyURL();
  *   }
  * }
  * ```
  *
  * @internal
  */
  #notifyURL() {
    if (this.#onUpdate) this.#onUpdate(this.toString());
  }
}
// ---------------------------------------------------------------------------
// URL parsing internals
// ---------------------------------------------------------------------------
/**
*  Default ports for special schemes (value is string for direct comparison). */
const _DEFAULT_PORTS: Record<string, string> = {
  http: '80',
  https: '443',
  ws: '80',
  wss: '443',
  ftp: '21'
};
function _isSpecialScheme(scheme: string): boolean {
  return scheme === 'http' || scheme === 'https' || scheme === 'ws' || scheme === 'wss' || scheme === 'ftp' || scheme === 'file';
}
function _adapt(delta: number, numPoints: number, firstTime: boolean): number {
  delta = firstTime ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > 455) {
    delta = Math.floor(delta / 35);
    k += 36;
  }
  return k + Math.floor(36 * delta / (delta + 38));
}
function _encodeDigit(digit: number): string {
  return String.fromCharCode(digit + 22 + 75 * (digit < 26 ? 1 : 0));
}
function _punycodeLabel(label: string): string {
  const points = Array.from(label, (ch) => ch.codePointAt(0)!);
  if (points.every((cp) => cp < 128)) return label.toLowerCase();
  let output = '';
  let handled = 0;
  for (const cp of points) {
    if (cp < 128) {
      output += String.fromCharCode(cp).toLowerCase();
      handled++;
    }
  }
  const basic = handled;
  if (basic > 0) output += '-';
  let n = 128;
  let delta = 0;
  let bias = 72;
  while (handled < points.length) {
    let m = Infinity;
    for (const cp of points) if (cp >= n && cp < m) m = cp;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of points) {
      if (cp < n) delta++;
      if (cp !== n) continue;
      let q = delta;
      for (let k = 36;; k += 36) {
        const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
        if (q < t) break;
        output += _encodeDigit(t + (q - t) % (36 - t));
        q = Math.floor((q - t) / (36 - t));
      }
      output += _encodeDigit(q);
      bias = _adapt(delta, handled + 1, handled === basic);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return 'xn--' + output;
}
function _normalizeDomain(host: string): string {
  // Fast path: a purely ASCII host needs no IDNA/punycode processing, only
  // lowercasing. This avoids splitting into labels and allocating a code-point
  // array per label for the common case (e.g. "localhost", "example.com").
  let ascii = true;
  for (let i = 0; i < host.length; i++) {
    if (host.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) return host.toLowerCase();
  return host.split('.').map(_punycodeLabel).join('.').toLowerCase();
}
function _parseIPv4Number(part: string): number | null {
  if (part === '') return null;
  let radix = 10;
  let digits = part;
  if (digits.length >= 2 && digits[0] === '0' && (digits[1] === 'x' || digits[1] === 'X')) {
    radix = 16;
    digits = digits.slice(2);
  } else if (digits.length >= 2 && digits[0] === '0') {
    radix = 8;
    digits = digits.slice(1);
  }
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]*$/ : /^[0-9]+$/;
  if (!pattern.test(digits)) return null;
  return parseInt(digits || '0', radix);
}
function _normalizeIPv4(host: string): string | null {
  if (!/^[0-9A-Fa-fxX.]+$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length > 4 || parts.some((part) => part === '')) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const n = _parseIPv4Number(part);
    if (n === null) return null;
    numbers.push(n);
  }
  for (let i = 0; i < numbers.length - 1; i++) {
    if (numbers[i]! > 255) return null;
  }
  const last = numbers[numbers.length - 1]!;
  if (last > Math.pow(256, 5 - numbers.length) - 1) return null;
  let value = last;
  for (let i = 0; i < numbers.length - 1; i++) {
    value += numbers[i]! * Math.pow(256, 3 - i);
  }
  return [
    Math.floor(value / 16777216) & 255,
    Math.floor(value / 65536) & 255,
    Math.floor(value / 256) & 255,
    value & 255
  ].join('.');
}
function _normalizeHost(host: string, scheme: string): string {
  if (scheme === 'file' && host.toLowerCase() === 'localhost') return '';
  if (_isSpecialScheme(scheme)) {
    const ipv4 = _normalizeIPv4(host);
    if (ipv4 !== null) return ipv4;
  }
  return _normalizeDomain(host);
}
function _normalizeHostSetterValue(host: string, scheme: string): string | null {
  if (host.includes('\0')) return null;
  if (_isSpecialScheme(scheme)) {
    if (/[\x01-\x20\x7f]/.test(host)) return null;
    return _normalizeHost(host, scheme);
  }
  return _percentEncode(host.toLowerCase(), '');
}
function _normalizeIPv6(host: string): string | null {
  const inner = host.slice(1, -1).toLowerCase();
  if (!inner) return null;
  const pieces = inner.split('::');
  if (pieces.length > 2) return null;
  const parseSide = (side: string): number[] => {
    if (side === '') return [];
    return side.split(':').map((part) => {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return NaN;
      return parseInt(part, 16);
    });
  };
  const left = parseSide(pieces[0]!);
  const right = pieces.length === 2 ? parseSide(pieces[1]!) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const missing = pieces.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || pieces.length === 1 && left.length !== 8) return null;
  const nums = [
    ...left,
    ...Array(missing).fill(0),
    ...right
  ];
  if (nums.length !== 8) return null;
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < nums.length;) {
    if (nums[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < nums.length && nums[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestStart >= 0) {
    const head = nums.slice(0, bestStart).map((n) => n.toString(16));
    const tail = nums.slice(bestStart + bestLen).map((n) => n.toString(16));
    return '[' + head.join(':') + '::' + tail.join(':') + ']';
  }
  return '[' + nums.map((n) => n.toString(16)).join(':') + ']';
}
/**
* Parse a URL string into a state object.
* @param {string} input
* @param {object|null} base  Parsed base URL state (for relative resolution).
* @returns {{ scheme, username, password, host, port, pathname, search, hash } | null}
*/
function _parseURL(input: string, base: URLState | null): URLState | null {
  // Per WHATWG URL spec: strip leading/trailing C0 controls and space,
  // then remove all ASCII tab (\x09) and newline (\x0A, \x0D) characters.
  input = String(input).replace(/^[\x00-\x1f\x20]+|[\x00-\x1f\x20]+$/g, '').replace(/[\x09\x0a\x0d]/g, '');
  // Check for a scheme.
  const schemeEnd = input.indexOf(':');
  const looksAbsolute = schemeEnd > 0 && /^[a-zA-Z][a-zA-Z0-9+\-.]*$/.test(input.slice(0, schemeEnd));
  if (!looksAbsolute) {
    if (!base) return null;
    return _resolveRelative(input, base);
  }
  const scheme = input.slice(0, schemeEnd).toLowerCase();
  let rest = input.slice(schemeEnd + 1);
  let username = '';
  let password = '';
  let host = '';
  let port = '';
  let pathname = '';
  let search = '';
  let hash = '';
  let hasAuthority = false;
  let opaquePath = false;
  if (rest.startsWith('//')) {
    hasAuthority = true;
    rest = rest.slice(2);
    // Fragment
    const hashIdx = rest.indexOf('#');
    if (hashIdx >= 0) {
      hash = rest.slice(hashIdx + 1);
      rest = rest.slice(0, hashIdx);
    }
    // Query
    const searchIdx = rest.indexOf('?');
    if (searchIdx >= 0) {
      search = rest.slice(searchIdx + 1);
      rest = rest.slice(0, searchIdx);
    }
    // Separate authority from path
    const slashIdx = rest.indexOf('/');
    let authority;
    if (slashIdx >= 0) {
      authority = rest.slice(0, slashIdx);
      pathname = rest.slice(slashIdx);
    } else {
      authority = rest;
      pathname = '/';
    }
    // Userinfo
    const atIdx = authority.lastIndexOf('@');
    if (atIdx >= 0) {
      const userinfo = authority.slice(0, atIdx);
      authority = authority.slice(atIdx + 1);
      const ci = userinfo.indexOf(':');
      if (ci >= 0) {
        username = _percentEncode(userinfo.slice(0, ci), _USERINFO_ENCODE_SET);
        password = _percentEncode(userinfo.slice(ci + 1), _USERINFO_ENCODE_SET);
      } else {
        username = _percentEncode(userinfo, _USERINFO_ENCODE_SET);
      }
    }
    // Host + port (IPv6 aware)
    if (authority.startsWith('[')) {
      const cb = authority.indexOf(']');
      if (cb < 0) return null;
      const normalized = _normalizeIPv6(authority.slice(0, cb + 1));
      if (normalized === null) return null;
      host = normalized;
      const after = authority.slice(cb + 1);
      if (after.startsWith(':')) port = after.slice(1);
      else if (after.length > 0) return null;
    } else {
      const ci = authority.lastIndexOf(':');
      if (ci >= 0) {
        host = _normalizeHost(authority.slice(0, ci), scheme);
        port = authority.slice(ci + 1);
      } else {
        host = _normalizeHost(authority, scheme);
      }
    }
    if (port && (!/^\d+$/.test(port) || Number(port) > 65535)) return null;
    // Strip default port
    if (port && _DEFAULT_PORTS[scheme] === port) port = '';
    if (!pathname) pathname = '/';
  } else {
    // No authority (e.g. data:, javascript:, opaque paths)
    const hashIdx = rest.indexOf('#');
    if (hashIdx >= 0) {
      hash = rest.slice(hashIdx + 1);
      rest = rest.slice(0, hashIdx);
    }
    const searchIdx = rest.indexOf('?');
    if (searchIdx >= 0) {
      search = rest.slice(searchIdx + 1);
      rest = rest.slice(0, searchIdx);
    }
    pathname = rest;
    opaquePath = !_isSpecialScheme(scheme) && !pathname.startsWith('/');
  }
  const normalizedPath = opaquePath ? pathname : _normalizePath(pathname, hasAuthority);
  const encodedPath = opaquePath ? _encodeOpaquePath(normalizedPath, search.length > 0 || hash.length > 0) : _percentEncode(normalizedPath, _PATH_ENCODE_SET);
  return {
    scheme,
    username,
    password,
    host,
    port,
    pathname: encodedPath,
    search: _percentEncode(search, _QUERY_ENCODE_SET),
    hash: _percentEncode(hash, _FRAGMENT_ENCODE_SET)
  };
}
/**
* Resolve a relative reference against a parsed base URL.
* Implements RFC 3986 §5.2.
*/
function _resolveRelative(input: string, base: URLState): URLState {
  const baseIsOpaque = !_isSpecialScheme(base.scheme) && base.host === '' && !base.pathname.startsWith('/');
  if (!input) {
    return Object.assign({}, base);
  }
  if (input.startsWith('#')) {
    return Object.assign({}, base, { hash: _percentEncode(input.slice(1), _FRAGMENT_ENCODE_SET) });
  }
  if (input.startsWith('?')) {
    if (baseIsOpaque) return Object.assign({}, base, {
      search: _percentEncode(input.slice(1), _QUERY_ENCODE_SET),
      hash: ''
    });
    const qi = input.indexOf('#');
    if (qi >= 0) {
      return Object.assign({}, base, {
        search: _percentEncode(input.slice(1, qi), _QUERY_ENCODE_SET),
        hash: _percentEncode(input.slice(qi + 1), _FRAGMENT_ENCODE_SET)
      });
    }
    return Object.assign({}, base, {
      search: _percentEncode(input.slice(1), _QUERY_ENCODE_SET),
      hash: ''
    });
  }
  if (input.startsWith('//')) {
    return _parseURL(base.scheme + ':' + input, null)!;
  }
  if (baseIsOpaque) throw new TypeError('Cannot resolve relative URL against opaque base');
  // Strip fragment and query from input before resolving path
  let rest = input;
  let hash = '';
  let search = '';
  const hi = rest.indexOf('#');
  if (hi >= 0) {
    hash = rest.slice(hi + 1);
    rest = rest.slice(0, hi);
  }
  const qi = rest.indexOf('?');
  if (qi >= 0) {
    search = rest.slice(qi + 1);
    rest = rest.slice(0, qi);
  }
  if (rest.startsWith('/')) {
    return Object.assign({}, base, {
      pathname: _percentEncode(_normalizePath(rest, true), _PATH_ENCODE_SET),
      search: _percentEncode(search, _QUERY_ENCODE_SET),
      hash: _percentEncode(hash, _FRAGMENT_ENCODE_SET)
    });
  }
  // Relative path: merge with base directory
  const lastSlash = base.pathname.lastIndexOf('/');
  const dir = lastSlash >= 0 ? base.pathname.slice(0, lastSlash + 1) : '/';
  return Object.assign({}, base, {
    pathname: _percentEncode(_normalizePath(dir + rest, true), _PATH_ENCODE_SET),
    search: _percentEncode(search, _QUERY_ENCODE_SET),
    hash: _percentEncode(hash, _FRAGMENT_ENCODE_SET)
  });
}
/**
* Resolve `.` and `..` segments in a path.
* @param {string} path
* @param {boolean} hasAuthority  When true, path must start with '/'.
*/
function _normalizePath(path: string, hasAuthority: boolean): string {
  if (!path) return hasAuthority ? '/' : '';
  const leadingSlash = path.startsWith('/');
  const trailingSlash = path.length > 1 && path.endsWith('/');
  const segments = path.split('/');
  const out = [];
  for (const seg of segments) {
    if (seg === '.') {} else if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '') out.pop();
    } else {
      out.push(seg);
    }
  }
  let result = out.join('/');
  if (!result.startsWith('/') && (leadingSlash || hasAuthority)) result = '/' + result;
  if (trailingSlash && !result.endsWith('/')) result += '/';
  return result;
}
/**
*  Serialize a URL state object to a string. */
function _serialize(s: URLState): string {
  let href = s.scheme + ':';
  if (s.host !== '' || s.scheme === 'file') {
    href += '//';
    if (s.username || s.password) {
      href += s.username;
      if (s.password) href += ':' + s.password;
      href += '@';
    }
    href += s.host;
    if (s.port) href += ':' + s.port;
  }
  href += s.pathname;
  if (s.search) href += '?' + s.search;
  if (s.hash) href += '#' + s.hash;
  return href;
}
/**
*  Compute the origin for a parsed URL state. */
function _origin(s: URLState): string {
  const { scheme, host, port } = s;
  if (scheme === 'http' || scheme === 'https' || scheme === 'ws' || scheme === 'wss' || scheme === 'ftp') {
    return scheme + '://' + host + (port ? ':' + port : '');
  }
  if (scheme === 'blob') {
    const inner = _parseURL(s.pathname, null);
    return inner === null ? 'null' : _origin(inner);
  }
  return 'null';
}
// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------
/**
* Generated-doc-visible class `URL`.
*
* This implementation detail is included when documentation is built with
* `--include-private`. It describes state or helper behavior used by the
* owning module rather than a stable application-facing contract. Prefer the
* public API around the owning type unless you are maintaining this runtime.
*
* @example
* ```ts no_run
* const documentedClass = 'URL';
* console.log(documentedClass);
* ```
*
* @internal
*/
export class URL {
  /**
  * Private property `#state` used by `URL`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #state = undefined;
  *
  *   readInternalState() {
  *     return this.#state;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #state: URLState;
  /**
  * Private property `#params` used by `URL`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #params = undefined;
  *
  *   readInternalState() {
  *     return this.#params;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #params: URLSearchParams;
  /**
  * String tag used by Object.prototype.toString.
  *
  * ```typescript no_run
  * Object.prototype.toString.call(new URL('https://example.com')); // "[object URL]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'URL';
  }
  /**
  * Parse a URL from an absolute input or a relative input with base.
  *
  * Invalid inputs throw TypeError. The parser lowercases schemes and hosts,
  * strips default ports, normalizes dot segments, and percent-encodes unsafe
  * component characters.
  *
  * ```typescript no_run
  * const url = new URL('../b', 'https://example.com/a/c');
  * url.href; // "https://example.com/b"
  * ```
  *
  * @param {string|URL} input
  * @param {string|URL} [base]
  */
  constructor(input: string | URL, base?: string | URL) {
    let baseState = null;
    if (base !== undefined) {
      const baseString = String(base);
      baseState = _parseURL(baseString, null);
      if (!baseState) throw new TypeError('Invalid base URL: ' + base);
    }
    const inputString = String(input);
    const state = _parseURL(inputString, baseState);
    if (!state) throw new TypeError('Invalid URL: ' + inputString);
    this.#state = state;
    const url = this;
    this.#params = new URLSearchParams(null, function syncSearch(search) {
      url.#state.search = search;
    });
    this.#params.setQuery(state.search);
  }
  /**
  * Create a `blob:` URL for a Blob or File.
  *
  * The returned URL embeds the current `globalThis.location` origin when one
  * is available and stores a reference to the Blob until revoked. Each call
  * returns a fresh URL, even for the same Blob.
  *
  * ```typescript no_run
  * const url = URL.createObjectURL(new Blob(['hello']));
  * URL.revokeObjectURL(url);
  * ```
  */
  static createObjectURL(object: Blob): string {
    if (!(object instanceof Blob)) {
      throw new TypeError('URL.createObjectURL: object must be a Blob.');
    }
    const url = `blob:${_currentObjectUrlOrigin()}/${_uuidV4().toString()}`;
    _blobUrlStore.set(url, object);
    return url;
  }
  /**
  * Revoke a `blob:` URL created by `URL.createObjectURL()`.
  *
  * Revocation is an exact string match. Unknown URLs and non-blob strings are
  * accepted as no-ops, matching browser behavior.
  *
  * ```typescript no_run
  * URL.revokeObjectURL('blob:https://example.test/id');
  * ```
  */
  static revokeObjectURL(url: string): void {
    _blobUrlStore.delete(String(url));
  }
  // --- Serialization ---
  /**
  * Full serialized URL.
  *
  * Setting href reparses the value and resynchronizes searchParams. Invalid
  * values throw TypeError.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com/');
  * url.href = 'https://example.com/a?x=1';
  * ```
  */
  get href() {
    return _serialize(this.#state);
  }
  /**
  * Replace the full URL by parsing a new absolute URL string.
  *
  * Invalid input throws TypeError and leaves the previous URL unchanged.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.href = 'https://example.org/path';
  * ```
  */
  set href(value) {
    const state = _parseURL(String(value), null);
    if (!state) throw new TypeError('Invalid URL: ' + value);
    this.#state = state;
    this.#params.setQuery(state.search);
  }
  /**
  * Return href as a string.
  *
  * ```typescript no_run
  * new URL('https://example.com/').toString(); // "https://example.com/"
  * ```
  */
  toString() {
    return this.href;
  }
  /**
  * Return href for JSON serialization.
  *
  * ```typescript no_run
  * JSON.stringify(new URL('https://example.com/')); // "\"https://example.com/\""
  * ```
  */
  toJSON() {
    return this.href;
  }
  // --- Origin (read-only) ---
  /**
  * Serialized origin, or "null" for non-special schemes.
  *
  * ```typescript no_run
  * new URL('https://example.com:443/a').origin; // "https://example.com"
  * ```
  */
  get origin() {
    return _origin(this.#state);
  }
  // --- Scheme ---
  /**
  * Scheme with trailing colon.
  *
  * Setting protocol accepts valid scheme strings and strips a trailing colon.
  * Switching between special and non-special schemes is ignored.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.protocol = 'http:';
  * ```
  */
  get protocol() {
    return this.#state.scheme + ':';
  }
  /**
  * Replace the scheme when the change is allowed.
  *
  * Invalid schemes and special-to-non-special transitions are ignored.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.protocol = 'http';
  * ```
  */
  set protocol(value) {
    value = _stripURLTabsAndNewlines(String(value)).replace(/:$/, '').toLowerCase();
    if (/^[a-z][a-z0-9+\-.]*$/.test(value)) {
      // Per WHATWG: cannot switch between special and non-special schemes
      const currentIsSpecial = this.#state.scheme in _DEFAULT_PORTS;
      const newIsSpecial = value in _DEFAULT_PORTS;
      if (currentIsSpecial !== newIsSpecial) return;
      this.#state.scheme = value;
      if (this.#state.port && _DEFAULT_PORTS[value] === this.#state.port) {
        this.#state.port = '';
      }
    }
  }
  // --- Credentials ---
  /**
  * Percent-encoded username component.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.username = 'user name';
  * url.username; // "user%20name"
  * ```
  */
  get username() {
    return this.#state.username;
  }
  /**
  * Set the username after userinfo percent-encoding.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.username = 'user name';
  * ```
  */
  set username(value) {
    this.#state.username = _percentEncode(String(value), _USERINFO_ENCODE_SET);
  }
  /**
  * Percent-encoded password component.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.password = 'p@ss';
  * ```
  */
  get password() {
    return this.#state.password;
  }
  /**
  * Set the password after userinfo percent-encoding.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.password = 'secret';
  * ```
  */
  set password(value) {
    this.#state.password = _percentEncode(String(value), _USERINFO_ENCODE_SET);
  }
  // --- Host ---
  /**
  * Hostname plus optional port.
  *
  * Setting host lowercases the hostname and strips default ports. Malformed
  * bracketed IPv6 input is ignored.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.host = 'Example.com:443';
  * url.host; // "example.com"
  * ```
  */
  get host() {
    const { host, port } = this.#state;
    return port ? host + ':' + port : host;
  }
  /**
  * Set hostname and optional port from a host string.
  *
  * IPv6 bracket notation is preserved. Default ports are normalized away.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.host = 'localhost:8443';
  * ```
  */
  set host(value) {
    value = _stripURLTabsAndNewlines(String(value));
    if (value.startsWith('[')) {
      const cb = value.indexOf(']');
      if (cb < 0) return;
      this.#state.host = value.slice(0, cb + 1).toLowerCase();
      const after = value.slice(cb + 1);
      if (after.startsWith(':')) {
        const p = after.slice(1);
        this.#state.port = _DEFAULT_PORTS[this.#state.scheme] === p ? '' : p;
      }
    } else {
      const ci = value.lastIndexOf(':');
      if (ci >= 0) {
        const host = _normalizeHostSetterValue(value.slice(0, ci), this.#state.scheme);
        if (host === null) return;
        this.#state.host = host;
        const p = value.slice(ci + 1);
        this.#state.port = _DEFAULT_PORTS[this.#state.scheme] === p ? '' : p;
      } else {
        const host = _normalizeHostSetterValue(value, this.#state.scheme);
        if (host === null) return;
        this.#state.host = host;
      }
    }
  }
  /**
  * Hostname without port.
  *
  * Forbidden host code points cause setter input to be ignored.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.hostname = 'API.EXAMPLE.COM';
  * ```
  */
  get hostname() {
    return this.#state.host;
  }
  /**
  * Set hostname without changing the port.
  *
  * Forbidden host characters cause the assignment to be ignored.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com:8443');
  * url.hostname = 'localhost';
  * ```
  */
  set hostname(value) {
    const str = _stripURLTabsAndNewlines(String(value));
    // Per WHATWG: reject if value contains forbidden host code points
    if (/[\x00\x09\x0a\x0d #/?@\\]/.test(str)) return;
    const host = _normalizeHostSetterValue(str, this.#state.scheme);
    if (host === null) return;
    this.#state.host = host;
  }
  /**
  * Port string without leading colon.
  *
  * Empty values clear the port. Non-numeric or out-of-range values are ignored,
  * and default ports serialize as the empty string.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.port = '8443';
  * ```
  */
  get port() {
    return this.#state.port;
  }
  /**
  * Set or clear the port.
  *
  * Non-numeric and out-of-range values are ignored. Default ports serialize as
  * empty for the current scheme.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.port = '443';
  * url.port; // ""
  * ```
  */
  set port(value) {
    value = _stripURLTabsAndNewlines(String(value)).trim();
    if (!value) {
      this.#state.port = '';
      return;
    }
    const match = /^\d+/.exec(value);
    if (match === null) return;
    const num = parseInt(match[0]!, 10);
    if (num > 65535) return;
    const normalized = String(num);
    this.#state.port = _DEFAULT_PORTS[this.#state.scheme] === normalized ? '' : normalized;
  }
  // --- Path ---
  /**
  * Percent-encoded path component.
  *
  * Setting pathname normalizes dot segments and ensures authority URLs keep a
  * leading slash.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com/a');
  * url.pathname = '/b c';
  * ```
  */
  get pathname() {
    return this.#state.pathname;
  }
  /**
  * Set the path component after normalization and percent-encoding.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com/a');
  * url.pathname = '/b/../c';
  * ```
  */
  set pathname(value) {
    this.#state.pathname = _percentEncode(_normalizePath(_stripURLTabsAndNewlines(String(value)), !!this.#state.host), _PATH_ENCODE_SET);
  }
  // --- Query ---
  /**
  * Query string with a leading question mark, or empty string.
  *
  * Setting search accepts values with or without "?" and updates searchParams.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.search = 'a=1';
  * url.searchParams.get('a'); // "1"
  * ```
  */
  get search() {
    return this.#state.search ? '?' + this.#state.search : '';
  }
  /**
  * Set the query string and refresh searchParams.
  *
  * A leading question mark is optional. Unsafe query characters are
  * percent-encoded and existing valid percent triplets are preserved.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.search = '?q=hello world';
  * ```
  */
  set search(value) {
    value = _stripURLTabsAndNewlines(String(value));
    if (value.startsWith('?')) value = value.slice(1);
    // Re-encode the raw query (preserve existing %XX sequences)
    this.#state.search = _percentEncode(value, _QUERY_ENCODE_SET);
    this.#params.setQuery(this.#state.search);
  }
  /**
  * Live URLSearchParams view of the query string.
  *
  * Mutating this object updates the URL search component.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.searchParams.set('a', '1');
  * url.search; // "?a=1"
  * ```
  */
  get searchParams() {
    return this.#params;
  }
  // --- Fragment ---
  /**
  * Fragment with a leading hash, or empty string.
  *
  * Setting hash accepts values with or without "#".
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.hash = 'top';
  * ```
  */
  get hash() {
    return this.#state.hash ? '#' + this.#state.hash : '';
  }
  /**
  * Set the fragment component.
  *
  * A leading hash is optional. Unsafe fragment characters are percent-encoded.
  *
  * ```typescript no_run
  * const url = new URL('https://example.com');
  * url.hash = '#section';
  * ```
  */
  set hash(value) {
    value = _stripURLTabsAndNewlines(String(value));
    if (value.startsWith('#')) value = value.slice(1);
    this.#state.hash = _percentEncode(value, _FRAGMENT_ENCODE_SET);
  }
  // --- Static methods ---
  /**
  * Return true if the input is a parseable URL.
  *
  * This is equivalent to trying new URL(input, base) and catching failures.
  *
  * ```typescript no_run
  * URL.canParse('/a', 'https://example.com'); // true
  * ```
  */
  static canParse(input: string | URL, base?: string | URL): boolean {
    try {
      if (base === undefined) new URL(input);
      else new URL(input, base);
      return true;
    } catch (_e) {
      return false;
    }
  }
  /**
  * Parse and return a URL, or null if invalid.
  *
  * This avoids throwing for validation-style code paths.
  *
  * ```typescript no_run
  * const url = URL.parse('not a url');
  * url; // null
  * ```
  */
  static parse(input: string | URL, base?: string | URL): URL | null {
    try {
      return base === undefined ? new URL(input) : new URL(input, base);
    } catch (_e) {
      return null;
    }
  }
}
for (const name of ['createObjectURL', 'revokeObjectURL'] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(URL, name);
  if (descriptor !== undefined) {
    descriptor.enumerable = true;
    Object.defineProperty(URL, name, descriptor);
  }
}
