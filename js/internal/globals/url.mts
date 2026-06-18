/**
 * internal:globals/url — WHATWG URL and URLSearchParams globals.
 *
 * This is a pure-JS implementation of the WHATWG URL Standard
 * (https://url.spec.whatwg.org/). It handles absolute URL parsing, relative
 * URL resolution against a base, and the full URLSearchParams mutation API.
 * No native binding or C library is used — all parsing is done in JS.
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
 * `_parseURL(input, base)` is a hand-rolled parser, not a state-machine as
 * specified by the WHATWG standard. It handles the most common cases:
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
 * `_normalizePath()` resolves `.` and `..` segments in the output path. It
 * does not percent-encode or decode path segments — characters in the path
 * are preserved exactly as supplied.
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
 * differs from percent-encoding in two ways: spaces become `+` (not `%20`),
 * and the safe character set is narrower. The `_formEncode` / `_formDecode`
 * helpers implement this. For multi-byte characters they delegate to the
 * built-in `encodeURIComponent` / `decodeURIComponent` rather than
 * re-implementing the UTF-8 encoder.
 *
 *
 * ## What is NOT implemented
 *
 * - IDNA (internationalized domain names) — hostnames are lowercased but not
 *   decoded from Punycode.
 * - Full WHATWG URL state machine with all 20+ parser states.
 * - IPv6 normalization beyond bracket-wrapping.
 * - Opaque path handling (e.g. `blob:` URLs with UUIDs).
 *
 * These omissions are intentional. The implemented subset covers all practical
 * HTTP/HTTPS usage. Add missing features only when a concrete use-case
 * requires them.
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
 * @internal
 */

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
  if (cp < 0x80) return '%' + _toHex2(cp);
  // Multi-byte UTF-8
  let encoded = '';
  if (cp < 0x800) {
    encoded = '%' + _toHex2(0xC0 | (cp >> 6)) + '%' + _toHex2(0x80 | (cp & 0x3F));
  } else if (cp < 0x10000) {
    encoded = '%' + _toHex2(0xE0 | (cp >> 12)) + '%' + _toHex2(0x80 | ((cp >> 6) & 0x3F)) + '%' + _toHex2(0x80 | (cp & 0x3F));
  } else {
    encoded = '%' + _toHex2(0xF0 | (cp >> 18)) + '%' + _toHex2(0x80 | ((cp >> 12) & 0x3F)) + '%' + _toHex2(0x80 | ((cp >> 6) & 0x3F)) + '%' + _toHex2(0x80 | (cp & 0x3F));
  }
  return encoded;
}

// Percent-encode `str` using the given encode-set (a string of chars to encode).
// Existing valid %XX sequences are passed through unchanged (no double-encoding).
// Any char in the encode set, any non-ASCII char, or any C0/DEL control is encoded.
function _percentEncode(str: string, encodeSet: string): string {
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
    if (code <= 0x1F || code === 0x7F || code > 0x7E) {
      // Handle surrogate pairs for non-ASCII
      let cp = code;
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = 0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00);
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
const _QUERY_ENCODE_SET    = ' "#\'<>';
const _PATH_ENCODE_SET     = ' "#<>?`{}';
const _USERINFO_ENCODE_SET = ' "\'#/:;<=>?@[\\]^`{|}~';

/**
 * Encode a string using application/x-www-form-urlencoded percent-encoding.
 * Spaces → '+'; other non-safe chars → %XX.
 */
function _formEncode(str: string): string {
  str = String(str);
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const code = str.charCodeAt(i);
    // Safe characters: A-Z a-z 0-9 * - . _
    if ((code >= 0x41 && code <= 0x5A) ||  // A-Z
        (code >= 0x61 && code <= 0x7A) ||  // a-z
        (code >= 0x30 && code <= 0x39) ||  // 0-9
        c === '*' || c === '-' || c === '.' || c === '_') {
      result += c;
    } else if (c === ' ') {
      result += '+';
    } else if (code <= 0x7F) {
      result += '%' + _toHex2(code);
    } else {
      // Multi-byte UTF-8: encode each byte
      const encoded = encodeURIComponent(c!); // gives %XX or %XX%XX etc.
      result += encoded;
    }
  }
  return result;
}

/** Decode an application/x-www-form-urlencoded string. */
function _formDecode(str: string): string {
  try {
    return decodeURIComponent(String(str).replace(/\+/g, '%20'));
  } catch (_e) {
    return String(str).replace(/\+/g, ' ');
  }
}

/** Parse a query string into [[name, value], ...] pairs. Leading '?' is stripped. */
function _parseQueryString(qs: string): [string, string][] {
  const list: [string, string][] = [];
  if (!qs) return list;
  if (qs.startsWith('?')) qs = qs.slice(1);
  for (const part of qs.split('&')) {
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
  #onUpdate: ((qs: string) => void) | null; // callback(queryString) — notifies owning URL of mutations

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new URLSearchParams()); // "[object URLSearchParams]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'URLSearchParams'; }

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

    if (init instanceof URLSearchParams) {
      this.#list = init.#list.slice();
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        if (pair.length < 2) throw new TypeError('URLSearchParams: each entry must have two elements');
        this.#list.push([String(pair[0]), String(pair[1])]);
      }
    } else if (typeof init === 'object') {
      for (const key of Object.keys(init)) {
        this.#list.push([String(key), String(init[key])]);
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
  get size() { return this.#list.length; }

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
    if (value !== undefined) {
      const val = String(value);
      this.#list = this.#list.filter(function(e) { return !(e[0] === name && e[1] === val); });
    } else {
      this.#list = this.#list.filter(function(e) { return e[0] !== name; });
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
    return this.#list.filter(function(e) { return e[0] === name; }).map(function(e) { return e[1]; });
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
      return this.#list.some(function(e) { return e[0] === name && e[1] === val; });
    }
    return this.#list.some(function(e) { return e[0] === name; });
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
    name  = String(name);
    value = String(value);
    let replaced = false;
    const next: [string, string][] = [];
    for (const entry of this.#list) {
      if (entry[0] === name) {
        if (!replaced) { next.push([name, value]); replaced = true; }
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
    this.#list.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
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
    return this.#list.map(function(e) { return _formEncode(e[0]) + '=' + _formEncode(e[1]); }).join('&');
  }

  /**
   * Iterate over [name, value] pairs.
   *
   * The iterator uses a snapshot so later mutations do not affect it.
   *
   * ```typescript no_run
   * [...new URLSearchParams('a=1').entries()]; // [["a", "1"]]
   * ```
   */
  entries() {
    return this.#list.slice()[Symbol.iterator]();
  }

  /**
   * Iterate over names in insertion order.
   *
   * ```typescript no_run
   * [...new URLSearchParams('a=1').keys()]; // ["a"]
   * ```
   */
  keys() {
    return this.#list.map(function(e) { return e[0]; })[Symbol.iterator]();
  }

  /**
   * Iterate over values in insertion order.
   *
   * ```typescript no_run
   * [...new URLSearchParams('a=1').values()]; // ["1"]
   * ```
   */
  values() {
    return this.#list.map(function(e) { return e[1]; })[Symbol.iterator]();
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
    this.#list = _parseQueryString(str);
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

/** Default ports for special schemes (value is string for direct comparison). */
const _DEFAULT_PORTS: Record<string, string> = {
  http: '80',
  https: '443',
  ws: '80',
  wss: '443',
  ftp: '21',
};

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
  let host     = '';
  let port     = '';
  let pathname = '';
  let search   = '';
  let hash     = '';

  if (rest.startsWith('//')) {
    rest = rest.slice(2);

    // Fragment
    const hashIdx = rest.indexOf('#');
    if (hashIdx >= 0) { hash = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }

    // Query
    const searchIdx = rest.indexOf('?');
    if (searchIdx >= 0) { search = rest.slice(searchIdx + 1); rest = rest.slice(0, searchIdx); }

    // Separate authority from path
    const slashIdx = rest.indexOf('/');
    let authority;
    if (slashIdx >= 0) {
      authority = rest.slice(0, slashIdx);
      pathname  = rest.slice(slashIdx);
    } else {
      authority = rest;
      pathname  = '/';
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
      if (cb < 0) return null; // malformed IPv6
      host = authority.slice(0, cb + 1).toLowerCase();
      const after = authority.slice(cb + 1);
      if (after.startsWith(':')) port = after.slice(1);
      else if (after.length > 0) return null;
    } else {
      const ci = authority.lastIndexOf(':');
      if (ci >= 0) { host = authority.slice(0, ci).toLowerCase(); port = authority.slice(ci + 1); }
      else          { host = authority.toLowerCase(); }
    }

    // Strip default port
    if (port && _DEFAULT_PORTS[scheme] === port) port = '';

    if (!pathname) pathname = '/';

  } else {
    // No authority (e.g. data:, javascript:, opaque paths)
    const hashIdx = rest.indexOf('#');
    if (hashIdx >= 0) { hash = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }

    const searchIdx = rest.indexOf('?');
    if (searchIdx >= 0) { search = rest.slice(searchIdx + 1); rest = rest.slice(0, searchIdx); }

    pathname = rest;
  }

  return {
    scheme, username, password, host, port,
    pathname: _percentEncode(_normalizePath(pathname, !!host), _PATH_ENCODE_SET),
    search: _percentEncode(search, _QUERY_ENCODE_SET),
    hash: _percentEncode(hash, _FRAGMENT_ENCODE_SET),
  };
}

/**
 * Resolve a relative reference against a parsed base URL.
 * Implements RFC 3986 §5.2.
 */
function _resolveRelative(input: string, base: URLState): URLState {
  if (!input) {
    return Object.assign({}, base, { hash: '' });
  }

  if (input.startsWith('#')) {
    return Object.assign({}, base, { hash: _percentEncode(input.slice(1), _FRAGMENT_ENCODE_SET) });
  }

  if (input.startsWith('?')) {
    const qi = input.indexOf('#');
    if (qi >= 0) {
      return Object.assign({}, base, {
        search: _percentEncode(input.slice(1, qi), _QUERY_ENCODE_SET),
        hash: _percentEncode(input.slice(qi + 1), _FRAGMENT_ENCODE_SET),
      });
    }
    return Object.assign({}, base, { search: _percentEncode(input.slice(1), _QUERY_ENCODE_SET), hash: '' });
  }

  if (input.startsWith('//')) {
    return _parseURL(base.scheme + ':' + input, null)!;
  }

  // Strip fragment and query from input before resolving path
  let rest = input;
  let hash   = '';
  let search = '';

  const hi = rest.indexOf('#');
  if (hi >= 0) { hash = rest.slice(hi + 1); rest = rest.slice(0, hi); }

  const qi = rest.indexOf('?');
  if (qi >= 0) { search = rest.slice(qi + 1); rest = rest.slice(0, qi); }

  if (rest.startsWith('/')) {
    return Object.assign({}, base, {
      pathname: _percentEncode(_normalizePath(rest, true), _PATH_ENCODE_SET),
      search: _percentEncode(search, _QUERY_ENCODE_SET),
      hash: _percentEncode(hash, _FRAGMENT_ENCODE_SET),
    });
  }

  // Relative path: merge with base directory
  const lastSlash = base.pathname.lastIndexOf('/');
  const dir = lastSlash >= 0 ? base.pathname.slice(0, lastSlash + 1) : '/';
  return Object.assign({}, base, {
    pathname: _percentEncode(_normalizePath(dir + rest, true), _PATH_ENCODE_SET),
    search: _percentEncode(search, _QUERY_ENCODE_SET),
    hash: _percentEncode(hash, _FRAGMENT_ENCODE_SET),
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
    if (seg === '.') {
      // stay in current dir
    } else if (seg === '..') {
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

/** Serialize a URL state object to a string. */
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
  if (s.hash)   href += '#' + s.hash;
  return href;
}

/** Compute the origin for a parsed URL state. */
function _origin(s: URLState): string {
  const { scheme, host, port } = s;
  if (scheme === 'http' || scheme === 'https' ||
      scheme === 'ws'   || scheme === 'wss'   ||
      scheme === 'ftp') {
    return scheme + '://' + host + (port ? ':' + port : '');
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
  get [Symbol.toStringTag]() { return 'URL'; }

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
    if (base != null) {
      baseState = base instanceof URL ? base.#state : _parseURL(String(base), null);
      if (!baseState) throw new TypeError('Invalid base URL: ' + base);
    }

    const state = _parseURL(String(input), baseState);
    if (!state) throw new TypeError('Invalid URL: ' + input);

    this.#state  = state;
    const url = this;
    this.#params = new URLSearchParams(state.search, function syncSearch(search) { url.#state.search = search; });
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
  get href() { return _serialize(this.#state); }
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
  toString() { return this.href; }

  /**
   * Return href for JSON serialization.
   *
   * ```typescript no_run
   * JSON.stringify(new URL('https://example.com/')); // "\"https://example.com/\""
   * ```
   */
  toJSON()   { return this.href; }

  // --- Origin (read-only) ---

  /**
   * Serialized origin, or "null" for non-special schemes.
   *
   * ```typescript no_run
   * new URL('https://example.com:443/a').origin; // "https://example.com"
   * ```
   */
  get origin() { return _origin(this.#state); }

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
  get protocol() { return this.#state.scheme + ':'; }
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
    value = String(value).replace(/:$/, '').toLowerCase();
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
  get username() { return this.#state.username; }
  /**
   * Set the username after userinfo percent-encoding.
   *
   * ```typescript no_run
   * const url = new URL('https://example.com');
   * url.username = 'user name';
   * ```
   */
  set username(value) { this.#state.username = _percentEncode(String(value), _USERINFO_ENCODE_SET); }

  /**
   * Percent-encoded password component.
   *
   * ```typescript no_run
   * const url = new URL('https://example.com');
   * url.password = 'p@ss';
   * ```
   */
  get password() { return this.#state.password; }
  /**
   * Set the password after userinfo percent-encoding.
   *
   * ```typescript no_run
   * const url = new URL('https://example.com');
   * url.password = 'secret';
   * ```
   */
  set password(value) { this.#state.password = _percentEncode(String(value), _USERINFO_ENCODE_SET); }

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
    value = String(value);
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
        this.#state.host = value.slice(0, ci).toLowerCase();
        const p = value.slice(ci + 1);
        this.#state.port = _DEFAULT_PORTS[this.#state.scheme] === p ? '' : p;
      } else {
        this.#state.host = value.toLowerCase();
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
  get hostname() { return this.#state.host; }
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
    const str = String(value);
    // Per WHATWG: reject if value contains forbidden host code points
    if (/[\x00\x09\x0a\x0d #/?@\\]/.test(str)) return;
    this.#state.host = str.toLowerCase();
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
  get port() { return this.#state.port; }
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
    value = String(value).trim();
    if (!value) {
      this.#state.port = '';
      return;
    }
    if (!/^\d+$/.test(value)) return; // non-numeric, ignore
    const num = parseInt(value, 10);
    if (num > 65535) return; // out of range, ignore
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
  get pathname() { return this.#state.pathname; }
  /**
   * Set the path component after normalization and percent-encoding.
   *
   * ```typescript no_run
   * const url = new URL('https://example.com/a');
   * url.pathname = '/b/../c';
   * ```
   */
  set pathname(value) { this.#state.pathname = _percentEncode(_normalizePath(String(value), !!this.#state.host), _PATH_ENCODE_SET); }

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
    value = String(value);
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
  get searchParams() { return this.#params; }

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
    value = String(value);
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
    try { new URL(input, base); return true; } catch (_e) { return false; }
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
    try { return new URL(input, base); } catch (_e) { return null; }
  }
}
