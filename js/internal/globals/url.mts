/**
 * fino:url — WHATWG URL and URLSearchParams implementation.
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
 * ```ts
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
 */
export class URLSearchParams {
  #list: [string, string][];
  #onUpdate: ((qs: string) => void) | null; // callback(queryString) — notifies owning URL of mutations

  get [Symbol.toStringTag]() { return 'URLSearchParams'; }

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

  /** Number of entries. */
  get size() { return this.#list.length; }

  /** Append a new name/value pair (allows duplicates). */
  append(name: string, value: string): void {
    this.#list.push([String(name), String(value)]);
    this.#notifyURL();
  }

  /** Remove entries with the given name, optionally matching value too. */
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

  /** Return the first value for the given name, or null. */
  get(name: string): string | null {
    name = String(name);
    for (const entry of this.#list) {
      if (entry[0] === name) return entry[1];
    }
    return null;
  }

  /** Return all values for the given name. */
  getAll(name: string): string[] {
    name = String(name);
    return this.#list.filter(function(e) { return e[0] === name; }).map(function(e) { return e[1]; });
  }

  /** Return true if an entry with the given name (and optionally value) exists. */
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

  /** Sort all entries by name (stable). */
  sort() {
    this.#list.sort(function(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    this.#notifyURL();
  }

  /** Serialize to application/x-www-form-urlencoded string. */
  toString() {
    return this.#list.map(function(e) { return _formEncode(e[0]) + '=' + _formEncode(e[1]); }).join('&');
  }

  /** Iterate over [name, value] pairs. */
  entries() {
    return this.#list.slice()[Symbol.iterator]();
  }

  /** Iterate over names. */
  keys() {
    return this.#list.map(function(e) { return e[0]; })[Symbol.iterator]();
  }

  /** Iterate over values. */
  values() {
    return this.#list.map(function(e) { return e[1]; })[Symbol.iterator]();
  }

  /** Iterate over [name, value] pairs. */
  forEach(callback: (value: string, name: string, parent: URLSearchParams) => void, thisArg?: unknown): void {
    for (const entry of this.#list) {
      callback.call(thisArg, entry[1], entry[0], this);
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  /** Update the list from a raw query string. Called by URL when its search is set. */
  setQuery(str: string): void {
    this.#list = _parseQueryString(str);
  }

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

export class URL {
  #state: URLState;
  #params: URLSearchParams;

  get [Symbol.toStringTag]() { return 'URL'; }

  /**
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

  get href() { return _serialize(this.#state); }
  set href(value) {
    const state = _parseURL(String(value), null);
    if (!state) throw new TypeError('Invalid URL: ' + value);
    this.#state = state;
    this.#params.setQuery(state.search);
  }

  toString() { return this.href; }
  toJSON()   { return this.href; }

  // --- Origin (read-only) ---

  get origin() { return _origin(this.#state); }

  // --- Scheme ---

  get protocol() { return this.#state.scheme + ':'; }
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

  get username() { return this.#state.username; }
  set username(value) { this.#state.username = _percentEncode(String(value), _USERINFO_ENCODE_SET); }

  get password() { return this.#state.password; }
  set password(value) { this.#state.password = _percentEncode(String(value), _USERINFO_ENCODE_SET); }

  // --- Host ---

  get host() {
    const { host, port } = this.#state;
    return port ? host + ':' + port : host;
  }
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

  get hostname() { return this.#state.host; }
  set hostname(value) {
    const str = String(value);
    // Per WHATWG: reject if value contains forbidden host code points
    if (/[\x00\x09\x0a\x0d #/?@\\]/.test(str)) return;
    this.#state.host = str.toLowerCase();
  }

  get port() { return this.#state.port; }
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

  get pathname() { return this.#state.pathname; }
  set pathname(value) { this.#state.pathname = _percentEncode(_normalizePath(String(value), !!this.#state.host), _PATH_ENCODE_SET); }

  // --- Query ---

  get search() {
    return this.#state.search ? '?' + this.#state.search : '';
  }
  set search(value) {
    value = String(value);
    if (value.startsWith('?')) value = value.slice(1);
    // Re-encode the raw query (preserve existing %XX sequences)
    this.#state.search = _percentEncode(value, _QUERY_ENCODE_SET);
    this.#params.setQuery(this.#state.search);
  }

  get searchParams() { return this.#params; }

  // --- Fragment ---

  get hash() {
    return this.#state.hash ? '#' + this.#state.hash : '';
  }
  set hash(value) {
    value = String(value);
    if (value.startsWith('#')) value = value.slice(1);
    this.#state.hash = _percentEncode(value, _FRAGMENT_ENCODE_SET);
  }

  // --- Static methods ---

  /** Return true if the input is a parseable URL (no exception thrown). */
  static canParse(input: string | URL, base?: string | URL): boolean {
    try { new URL(input, base); return true; } catch (_e) { return false; }
  }

  /** Parse and return a URL, or null if invalid. */
  static parse(input: string | URL, base?: string | URL): URL | null {
    try { return new URL(input, base); } catch (_e) { return null; }
  }
}
