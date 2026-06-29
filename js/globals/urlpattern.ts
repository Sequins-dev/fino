/**
* URLPattern global (WHATWG URL Pattern API)
*
* URLPattern lets you declare a pattern for URL matching and then test or
* match URLs against it. The release baseline is routing-oriented: matching
* request URLs by protocol, hostname, path, search, and hash, and extracting
* named groups from path and host patterns such as `/users/:id`.
*
* The implementation follows the broad WHATWG URL Pattern Standard shape
* (https://urlpattern.spec.whatwg.org/) but is not strict tokenizer parity. It
* processes patterns per URL component (protocol, username, password, hostname,
* port, pathname, search, hash) so you can match any combination of URL parts.
* Coverage locks object and string constructors, baseURL resolution, named
* parameters, wildcard and regexp groups, repeat modifiers, escaped literals,
* `hasRegExpGroups`, `ignoreCase`, and percent-encoding boundaries used by
* routing code.
*
*
* ## Architecture: tokenize → compile → match
*
* Pattern processing is a two-stage pipeline:
*
* **Stage 1 — Tokenize** (`_tokenize`):
* The pattern string is scanned character by character into a flat token
* array. Token types:
*   - `T_TEXT` — literal text to match verbatim
*   - `T_ESCAPED` — a `\x`-escaped literal character
*   - `T_NAME` — a `:name` named parameter
*   - `T_PATTERN` — a `(regex)` custom regex group
*   - `T_ASTERISK` — a bare `*` wildcard
*   - `T_OPEN` / `T_CLOSE` — `{` / `}` non-capturing group delimiters
*   - `T_MODIFIER` — `?`, `+` (follows a group or name)
*   - `T_END` — sentinel
*
* **Stage 2 — Compile** (`_compileTokens`):
* Tokens are converted to a `RegExp` and a parallel `keys` array:
*   - `T_TEXT` → `_escapeRe(value)` (escaped literal)
*   - `T_NAME` → `(pattern)modifier` where pattern defaults to
*     `[^delimiter]+?` (matches everything except the delimiter, e.g. `/`
*     for pathname) unless a `T_PATTERN` immediately follows the name
*   - `T_PATTERN` → `(regex)modifier` with an auto-generated numeric key
*   - `T_ASTERISK` → `(.*)` with an auto-generated numeric key
*   - `T_OPEN` group → `(?:inner)modifier` (non-capturing group in regex)
*
* The `keys` array parallels the regex capturing groups: `keys[i].name` is
* the name (or auto-generated index string) of capture group `i+1`.
*
*
* ## Per-component options
*
* Each URL component is compiled with different `options.delimiter`:
*   - `pathname` uses `'/'` as the delimiter, so `:name` matches a single
*     path segment by default (stops at the next `/`)
*   - `hostname` uses `'.'` as the delimiter, so `:sub` matches a single
*     subdomain label
*   - other components (search, hash, protocol, etc.) have no delimiter,
*     so `:name` matches everything
*
*
* ## String constructor input
*
* When `URLPattern` is constructed with a string (e.g.
* `new URLPattern('https://example.com/users/:id')`), the string is parsed
* into its URL components first using `_parsePatternString()`. This function
* finds the scheme, authority, path, search, and hash sections by scanning
* for the structural characters (`:`, `//`, `/`, `?`, `#`) while respecting
* `(...)` and `{...}` groups that may contain those characters. A `baseURL`
* option can provide defaults for any missing components.
*
*
* ## exec() and test()
*
* `exec(input)` tries to match `input` (a URL string or URL object) against
* all compiled components. If all match, it returns a result object with
* per-component `{ input, groups }` values. `test(input)` is just
* `exec(input) !== null`.
*
*
* ## What is NOT implemented
*
* - The WHATWG spec's "encoding callback" for percent-encoding patterns —
*   patterns and inputs are matched as-is without percent-decoding or
*   component-specific pre-encoding.
* - Strict WHATWG tokenizer state machine parity. This uses a hand-rolled
*   scanner that covers the routing syntax but may differ in edge cases.
*
*
* ```ts no_run
* // URLPattern is available via globalThis
*
* // Object form (most precise):
* const p = new URLPattern({ pathname: '/users/:id' });
* p.test('https://example.com/users/42');  // true
* p.exec('https://example.com/users/42');
* // → { pathname: { input: '/users/42', groups: { id: '42' } }, ... }
*
* // String form:
* const q = new URLPattern('https://example.com/users/:id');
* q.test('https://example.com/users/42');  // true
*
* // Supported pattern syntax (per component):
* //   :name         — named param, matches non-delimiter chars by default
* //   :name(regex)  — named param with custom regex
* //   (regex)       — unnamed group with custom regex
* //   *             — wildcard, matches anything
* //   {group}       — non-capturing group
* //   ?  +  *       — modifiers after :name, (regex), {group}, or *
* //   \x            — literal escape
* ```
*
*/
import { URL } from './url.ts';
// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------
interface Token {
  type: number;
  value?: string;
}
interface CompiledPattern {
  pattern: string;
  regexp: RegExp;
  keys: Array<{
    name: string;
  }>;
  hasRegExpGroups: boolean;
}
interface URLPatternInit {
  protocol?: string;
  username?: string;
  password?: string;
  hostname?: string;
  port?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  baseURL?: string;
}
interface URLPatternOptions {
  ignoreCase?: boolean;
}
interface ParsedURLPatternInit {
  protocol: string | undefined;
  username: string | undefined;
  password: string | undefined;
  hostname: string | undefined;
  port: string | undefined;
  pathname: string | undefined;
  search: string | undefined;
  hash: string | undefined;
}
interface URLPatternComponentResult {
  input: string;
  groups: Record<string, string | undefined>;
}
interface URLPatternComparePart {
  kind: 'text' | 'name' | 'regexp' | 'wildcard' | 'group';
  value?: string;
  modifier?: string;
  parts?: URLPatternComparePart[];
}
interface URLComponentDict {
  protocol: string;
  username: string;
  password: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
}
type URLPatternComponentName = 'protocol' | 'username' | 'password' | 'hostname' | 'port' | 'pathname' | 'search' | 'hash';
// ---------------------------------------------------------------------------
// Pattern tokenizer
// ---------------------------------------------------------------------------
const T_END = 0;
const T_TEXT = 1;
const T_ESCAPED = 2;
const T_NAME = 3;
const T_PATTERN = 4;
const T_ASTERISK = 5;
const T_OPEN = 6;
const T_CLOSE = 7;
const T_MODIFIER = 8;
const NAME_START_RE = /[\w$\p{ID_Start}]/u;
const NAME_CONTINUE_RE = /[\w$\u200C\u200D\p{ID_Continue}]/u;
function _readCodePoint(str: string, index: number): {
  value: string;
  next: number;
} | null {
  if (index >= str.length) return null;
  const cp = str.codePointAt(index);
  if (cp === undefined) return null;
  const value = String.fromCodePoint(cp);
  return {
    value,
    next: index + value.length
  };
}
function _consumeName(str: string, index: number): {
  name: string;
  next: number;
} | null {
  const first = _readCodePoint(str, index);
  if (!first || !NAME_START_RE.test(first.value)) return null;
  let name = first.value;
  let next = first.next;
  while (next < str.length) {
    const current = _readCodePoint(str, next);
    if (!current || !NAME_CONTINUE_RE.test(current.value)) break;
    name += current.value;
    next = current.next;
  }
  return {
    name,
    next
  };
}
function _tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let textBuf = '';
  function flushText() {
    if (textBuf) {
      tokens.push({
        type: T_TEXT,
        value: textBuf
      });
      textBuf = '';
    }
  }
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      flushText();
      tokens.push({
        type: T_ESCAPED,
        value: pattern[i + 1]!
      });
      i += 2;
      continue;
    }
    if (ch === ':') {
      const consumed = _consumeName(pattern, i + 1);
      const name = consumed?.name ?? '';
      if (name) {
        flushText();
        tokens.push({
          type: T_NAME,
          value: name
        });
        i = consumed!.next;
      } else {
        throw new TypeError('Invalid URLPattern parameter name');
      }
      continue;
    }
    if (ch === '(') {
      flushText();
      let depth = 1;
      let regex = '';
      i++;
      while (i < pattern.length) {
        const c = pattern[i]!;
        if (c === '\\' && i + 1 < pattern.length) {
          regex += c + pattern[i + 1]!;
          i += 2;
          continue;
        }
        if (c === '(') {
          depth++;
          regex += c;
          i++;
          continue;
        }
        if (c === ')') {
          depth--;
          i++;
          if (depth === 0) break;
          regex += c;
          continue;
        }
        regex += c;
        i++;
      }
      if (depth !== 0) throw new TypeError('Unmatched ( in URLPattern');
      if (regex === '') throw new TypeError('Empty regexp group in URLPattern');
      tokens.push({
        type: T_PATTERN,
        value: regex
      });
      continue;
    }
    if (ch === '{') {
      flushText();
      tokens.push({ type: T_OPEN });
      i++;
      continue;
    }
    if (ch === '}') {
      flushText();
      tokens.push({ type: T_CLOSE });
      i++;
      continue;
    }
    if (ch === '*') {
      flushText();
      tokens.push({ type: T_ASTERISK });
      i++;
      continue;
    }
    if (ch === '?' || ch === '+') {
      flushText();
      tokens.push({
        type: T_MODIFIER,
        value: ch
      });
      i++;
      continue;
    }
    textBuf += ch;
    i++;
  }
  flushText();
  tokens.push({ type: T_END });
  return tokens;
}
// ---------------------------------------------------------------------------
// Pattern compiler  tokens → { regexp, keys }
// ---------------------------------------------------------------------------
function _escapeRe(str: string): string {
  return str.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
function _toHex2(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, '0');
}
function _pctEncodeCP(cp: number): string {
  if (cp < 128) return '%' + _toHex2(cp);
  if (cp < 2048) {
    return '%' + _toHex2(192 | cp >> 6) + '%' + _toHex2(128 | cp & 63);
  }
  if (cp < 65536) {
    return '%' + _toHex2(224 | cp >> 12) + '%' + _toHex2(128 | cp >> 6 & 63) + '%' + _toHex2(128 | cp & 63);
  }
  return '%' + _toHex2(240 | cp >> 18) + '%' + _toHex2(128 | cp >> 12 & 63) + '%' + _toHex2(128 | cp >> 6 & 63) + '%' + _toHex2(128 | cp & 63);
}
function _percentEncode(str: string, encodeSet: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i]!;
    const code = str.charCodeAt(i);
    if (c === '%' && i + 2 < str.length && /^[0-9A-Fa-f]{2}$/.test(str.slice(i + 1, i + 3))) {
      result += str.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (code <= 31 || code === 127 || code > 126) {
      let cp = code;
      if (code >= 55296 && code <= 56319 && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 56320 && lo <= 57343) {
          cp = 65536 + (code - 55296 << 10) + (lo - 56320);
          i++;
        } else {
          cp = 65533;
        }
      } else if (code >= 56320 && code <= 57343) {
        cp = 65533;
      }
      result += _pctEncodeCP(cp);
      continue;
    }
    if (encodeSet.indexOf(c) >= 0) {
      result += _pctEncodeCP(code);
      continue;
    }
    result += c;
  }
  return result;
}
function _componentEncodeSet(component: URLPatternComponentName): string {
  if (component === 'username' || component === 'password') return ' "\'#/:;<=>?@[\\]^`{|}~';
  if (component === 'pathname') return ' "#<>?`{}';
  if (component === 'search') return ' "#\'<>';
  if (component === 'hash') return ' "\'<>`';
  return '';
}
function _canonicalizeComponentText(component: URLPatternComponentName, value: string): string {
  if (component === 'hostname') return _canonicalizeHostnameText(value);
  if (component === 'protocol' || component === 'port') return value;
  return _percentEncode(value, _componentEncodeSet(component));
}
function _canonicalizeHostnameText(value: string): string {
  if (value === '' || value === '*') return value;
  try {
    return new URL(`http://${value}/`).hostname;
  } catch (_) {
    return value;
  }
}
function _canonicalizeLiteralHostname(value: string): string {
  if (value === '' || value === '*') return value;
  if (/[ %<>?@[\]^|]/.test(value)) {
    throw new TypeError('URLPattern: invalid hostname pattern');
  }
  try {
    return new URL(`http://${value}/`).hostname;
  } catch (_) {
    throw new TypeError('URLPattern: invalid hostname pattern');
  }
}
function _escapePatternLiteral(value: string): string {
  return value.replace(/[\\:*+?{}()]/g, '\\$&');
}
function _isLiteralPattern(tokens: Token[]): boolean {
  for (const token of tokens) {
    if (token.type === T_END || token.type === T_TEXT) continue;
    return false;
  }
  return true;
}
function _peekModifier(tokens: Token[], i: number): string {
  const tok = tokens[i];
  if (!tok) return '';
  if (tok.type === T_MODIFIER) return tok.value ?? '';
  if (tok.type === T_ASTERISK) return '*';
  return '';
}
/**
* Apply a modifier (+, *, ?) to a regex pattern string, generating a single
* capture group. For + and * with a delimiter, generates a segment-aware
* pattern so that `:name+` on pathname matches multiple /-separated segments.
*/
function _applyModifier(pat: string, mod: string, escapedDelim: string): string {
  if (mod === '+') {
    if (escapedDelim) {
      return '(' + pat + '(?:' + escapedDelim + pat + ')*)';
    }
    return '((?:' + pat + ')+)';
  }
  if (mod === '*') {
    if (escapedDelim) {
      return '(' + pat + '(?:' + escapedDelim + pat + ')*)?';
    }
    return '((?:' + pat + ')*)';
  }
  if (mod === '?') {
    return '(' + pat + ')?';
  }
  return '(' + pat + ')';
}
function _consumeModifier(tokens: Token[], i: number): {
  modifier: string;
  next: number;
} {
  const modifier = _peekModifier(tokens, i);
  return {
    modifier,
    next: modifier ? i + 1 : i
  };
}
function _appendWildcardPattern(src: string, mod: string, escapedDelim: string): string {
  if ((mod === '?' || mod === '*') && escapedDelim && src.endsWith(escapedDelim)) {
    return src.slice(0, -escapedDelim.length) + '(?:' + escapedDelim + '(.*))?';
  }
  return src + '(.*)';
}
function _canonicalPatternString(tokens: Token[], component: URLPatternComponentName, start = 0): {
  value: string;
  index: number;
} {
  let out = '';
  let i = start;
  while (tokens[i]!.type !== T_END && tokens[i]!.type !== T_CLOSE) {
    const tok = tokens[i]!;
    if (tok.type === T_TEXT) {
      out += _canonicalizeComponentText(component, tok.value ?? '');
      i++;
      continue;
    }
    if (tok.type === T_ESCAPED) {
      const value = tok.value ?? '';
      const encoded = _canonicalizeComponentText(component, value);
      out += encoded === value ? '\\' + value : encoded;
      i++;
      continue;
    }
    if (tok.type === T_ASTERISK) {
      const mod = _peekModifier(tokens, i + 1);
      out += '*' + mod;
      i += mod ? 2 : 1;
      continue;
    }
    if (tok.type === T_PATTERN) {
      const mod = _peekModifier(tokens, i + 1);
      out += tok.value === '.*' ? '*' + mod : '(' + (tok.value ?? '') + ')' + mod;
      i += mod ? 2 : 1;
      continue;
    }
    if (tok.type === T_NAME) {
      out += ':' + (tok.value ?? '');
      i++;
      if (tokens[i]!.type === T_PATTERN) {
        out += '(' + (tokens[i]!.value ?? '') + ')';
        i++;
      }
      const mod = _peekModifier(tokens, i);
      if (mod) {
        out += mod;
        i++;
      }
      continue;
    }
    if (tok.type === T_OPEN) {
      const group = _canonicalPatternString(tokens, component, i + 1);
      i = group.index;
      if (tokens[i]!.type === T_CLOSE) i++;
      const mod = _peekModifier(tokens, i);
      if (mod) {
        out += '{' + group.value + '}' + mod;
        i++;
      } else {
        out += group.value;
      }
      continue;
    }
    if (tok.type === T_MODIFIER) {
      out += tok.value ?? '';
      i++;
      continue;
    }
    i++;
  }
  return {
    value: out,
    index: i
  };
}
function _compileTokens(tokens: Token[], options: {
  delimiter?: string;
} | null, ignoreCase = false): {
  regexp: RegExp;
  keys: Array<{
    name: string;
  }>;
  hasRegExpGroups: boolean;
} {
  const delimiter = options && options.delimiter ? options.delimiter : '';
  const defaultPat = delimiter ? '[^' + _escapeRe(delimiter) + ']+?' : '.+?';
  const escapedDelim = delimiter ? _escapeRe(delimiter) : '';
  const keys: Array<{
    name: string;
  }> = [];
  let groupIndex = 0;
  let src = '';
  let i = 0;
  let hasRegExpGroups = false;
  while (tokens[i]!.type !== T_END) {
    const tok = tokens[i]!;
    if (tok.type === T_TEXT) {
      src += _escapeRe(tok.value!);
      i++;
      continue;
    }
    if (tok.type === T_ESCAPED) {
      src += _escapeRe(tok.value!);
      i++;
      continue;
    }
    if (tok.type === T_ASTERISK) {
      // Wildcards get numeric string keys per spec (unnamed groups), but do NOT
      // count as regexp groups for hasRegExpGroups.
      keys.push({ name: String(groupIndex++) });
      const modifier = _consumeModifier(tokens, i + 1);
      src = _appendWildcardPattern(src, modifier.modifier, escapedDelim);
      i = modifier.next;
      continue;
    }
    if (tok.type === T_NAME) {
      const name = tok.value!;
      i++;
      let pat;
      if (tokens[i]!.type === T_PATTERN) {
        pat = tokens[i]!.value!;
        // A named param with a custom regexp counts as a regexp group.
        hasRegExpGroups = true;
        i++;
      } else {
        pat = defaultPat;
      }
      const mod = _peekModifier(tokens, i);
      if (mod) i++;
      keys.push({ name });
      src += _applyModifier(pat, mod, escapedDelim);
      continue;
    }
    if (tok.type === T_PATTERN) {
      keys.push({ name: String(groupIndex++) });
      i++;
      const modifier = _consumeModifier(tokens, i);
      i = modifier.next;
      if (tok.value === '.*') {
        src = _appendWildcardPattern(src, modifier.modifier, escapedDelim);
      } else {
        // Explicit unnamed regexp group — always counts as a regexp group.
        hasRegExpGroups = true;
        src += _applyModifier(tok.value!, modifier.modifier, escapedDelim);
      }
      continue;
    }
    if (tok.type === T_OPEN) {
      i++;
      let innerSrc = '';
      let depth = 1;
      while (tokens[i]!.type !== T_END) {
        if (tokens[i]!.type === T_CLOSE) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        if (tokens[i]!.type === T_OPEN) depth++;
        const inner = tokens[i]!;
        if (inner.type === T_TEXT) {
          innerSrc += _escapeRe(inner.value!);
          i++;
        } else if (inner.type === T_ESCAPED) {
          innerSrc += _escapeRe(inner.value!);
          i++;
        } else if (inner.type === T_NAME) {
          keys.push({ name: inner.value! });
          i++;
          let ipat;
          if (tokens[i]!.type === T_PATTERN) {
            ipat = tokens[i]!.value!;
            hasRegExpGroups = true;
            i++;
          } else {
            ipat = defaultPat;
          }
          innerSrc += '(' + ipat + ')';
        } else if (inner.type === T_PATTERN) {
          hasRegExpGroups = true;
          keys.push({ name: String(groupIndex++) });
          innerSrc += '(' + inner.value! + ')';
          i++;
        } else if (inner.type === T_ASTERISK) {
          keys.push({ name: String(groupIndex++) });
          innerSrc += '(.*)';
          i++;
        } else {
          i++;
        }
      }
      const mod = _peekModifier(tokens, i);
      if (mod) i++;
      src += '(?:' + innerSrc + ')' + mod;
      continue;
    }
    // Skip unexpected modifier or close at outer level.
    i++;
  }
  return {
    regexp: new RegExp('^' + src + '$', ignoreCase ? 'i' : ''),
    keys,
    hasRegExpGroups
  };
}
function _compilePattern(pattern: string, options: {
  delimiter?: string;
} | null, component: URLPatternComponentName, ignoreCase = false): CompiledPattern {
  const tokens = _tokenize(pattern);
  if (component === 'hostname' && _isLiteralPattern(tokens)) {
    const canonicalHostname = _canonicalizeLiteralHostname(pattern);
    const compiled = _compileTokens(_tokenize(canonicalHostname), options, ignoreCase);
    return {
      pattern: canonicalHostname,
      regexp: compiled.regexp,
      keys: compiled.keys,
      hasRegExpGroups: compiled.hasRegExpGroups
    };
  }
  const compiled = _compileTokens(tokens, options, ignoreCase);
  const canonical = _canonicalPatternString(tokens, component).value;
  const canonicalCompiled = canonical === pattern ? compiled : _compileTokens(_tokenize(canonical), options, ignoreCase);
  return {
    pattern: canonical,
    regexp: canonicalCompiled.regexp,
    keys: canonicalCompiled.keys,
    hasRegExpGroups: canonicalCompiled.hasRegExpGroups
  };
}
// ---------------------------------------------------------------------------
// URL structure parser for string constructor input
// ---------------------------------------------------------------------------
// Scan str for the last @ that is not inside ( ) or { }
function _findAt(str: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === '@' && depth === 0) last = i;
  }
  return last;
}
// Split "hostname:port" where port is the part after the last bare colon.
// Handles IPv6 bracket notation.
function _splitHostPort(str: string): {
  hostname: string;
  port: string;
} {
  if (str.startsWith('[')) {
    const end = str.indexOf(']');
    if (end !== -1 && end + 1 < str.length && str[end + 1] === ':') {
      return {
        hostname: str.slice(0, end + 1),
        port: str.slice(end + 2)
      };
    }
    return {
      hostname: str,
      port: ''
    };
  }
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  if (lastColon === -1) return {
    hostname: str,
    port: ''
  };
  return {
    hostname: str.slice(0, lastColon),
    port: str.slice(lastColon + 1)
  };
}
/**
* Scan a string (post-authority) for pathname, search, and hash components,
* respecting pattern syntax so that a '?' modifier (:name?) is not confused
* with a URL search delimiter.
*
* Rule: '?' is a search delimiter unless the immediately preceding token is
* a named param (:name), a pattern group ((...)), a brace group ({...}),
* or an asterisk (*). In those cases '?' is a modifier.
*/
function _splitPathnameSearchHash(str: string): {
  pathname: string;
  search: string | undefined;
  hash: string | undefined;
} {
  let pathname = '';
  let search: string | undefined;
  let hash: string | undefined;
  let i = 0;
  let lastWasParam = false;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === '\\' && i + 1 < str.length) {
      pathname += ch + str[i + 1]!;
      i += 2;
      lastWasParam = false;
      continue;
    }
    if (ch === ':') {
      const consumed = _consumeName(str, i + 1);
      if (consumed) {
        pathname += ':' + consumed.name;
        i = consumed.next;
        lastWasParam = true;
      } else {
        pathname += ':';
        i++;
        lastWasParam = false;
      }
      continue;
    }
    if (ch === '(') {
      let depth = 1, group = ch;
      i++;
      while (i < str.length && depth > 0) {
        const c = str[i]!;
        if (c === '\\' && i + 1 < str.length) {
          group += c + str[i + 1]!;
          i += 2;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        group += c;
        i++;
      }
      pathname += group;
      lastWasParam = true;
      continue;
    }
    if (ch === '{') {
      let depth = 1, group = ch;
      i++;
      while (i < str.length && depth > 0) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') depth--;
        group += str[i++];
      }
      pathname += group;
      lastWasParam = true;
      continue;
    }
    if (ch === '*') {
      pathname += ch;
      i++;
      lastWasParam = true;
      continue;
    }
    if (ch === '?') {
      if (lastWasParam) {
        pathname += ch;
        i++;
        lastWasParam = false;
        continue;
      }
      // URL search delimiter
      const rest = str.slice(i + 1);
      const hIdx = rest.indexOf('#');
      if (hIdx !== -1) {
        search = rest.slice(0, hIdx);
        hash = rest.slice(hIdx + 1);
      } else {
        search = rest;
      }
      return {
        pathname,
        search,
        hash
      };
    }
    if (ch === '+' && lastWasParam) {
      pathname += ch;
      i++;
      lastWasParam = false;
      continue;
    }
    if (ch === '#') {
      hash = str.slice(i + 1);
      return {
        pathname,
        search,
        hash
      };
    }
    pathname += ch;
    i++;
    lastWasParam = false;
  }
  return {
    pathname,
    search,
    hash
  };
}
/**
* Parse a URLPattern constructor string into a component init object.
* Returns an object with the same shape as a URLPatternInit, but any
* component not present in the string is left as undefined.
*/
function _parsePatternInitString(input: string): ParsedURLPatternInit {
  const result: ParsedURLPatternInit = {
    protocol: undefined,
    username: undefined,
    password: undefined,
    hostname: undefined,
    port: undefined,
    pathname: undefined,
    search: undefined,
    hash: undefined
  };
  let str = input;
  let hasAuthority = false;
  // Detect "protocol://" where the protocol part contains no URL-special chars.
  // Regex: letters/digits/+/- before "://"
  const protoMatch = /^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//.exec(str);
  if (protoMatch) {
    result.protocol = protoMatch[1];
    str = str.slice(protoMatch[0].length);
    hasAuthority = true;
  } else if (str.startsWith('//')) {
    str = str.slice(2);
    hasAuthority = true;
  }
  if (hasAuthority) {
    // Find end of authority: first unbracketed /, ?, or #
    let authEnd = -1;
    let depth = 0;
    let inBracket = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '[') inBracket = true;
      else if (c === ']') inBracket = false;
      else if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') depth--;
      else if (!inBracket && depth === 0 && (c === '/' || c === '?' || c === '#')) {
        authEnd = i;
        break;
      }
    }
    const authority = authEnd !== -1 ? str.slice(0, authEnd) : str;
    str = authEnd !== -1 ? str.slice(authEnd) : '';
    const atIdx = _findAt(authority);
    let hostPort;
    if (atIdx !== -1) {
      const creds = authority.slice(0, atIdx);
      const colonIdx = creds.indexOf(':');
      if (colonIdx !== -1) {
        result.username = creds.slice(0, colonIdx);
        result.password = creds.slice(colonIdx + 1);
      } else {
        result.username = creds;
        result.password = '';
      }
      hostPort = authority.slice(atIdx + 1);
    } else {
      hostPort = authority;
    }
    const ps = _splitHostPort(hostPort);
    result.hostname = ps.hostname;
    result.port = ps.port;
  }
  const parts = _splitPathnameSearchHash(str);
  if (parts.pathname) result.pathname = parts.pathname;
  if (parts.search !== undefined) result.search = parts.search;
  if (parts.hash !== undefined) result.hash = parts.hash;
  return result;
}
// ---------------------------------------------------------------------------
// Component compilation helpers
// ---------------------------------------------------------------------------
const COMPONENT_OPTIONS: Record<string, {
  delimiter: string;
}> = {
  protocol: { delimiter: '' },
  username: { delimiter: '' },
  password: { delimiter: '' },
  hostname: { delimiter: '.' },
  port: { delimiter: '' },
  pathname: { delimiter: '/' },
  search: { delimiter: '' },
  hash: { delimiter: '' }
};
const URL_PATTERN_COMPONENT_NAMES = new Set<string>([
  'protocol',
  'username',
  'password',
  'hostname',
  'port',
  'pathname',
  'search',
  'hash'
]);
const SPECIAL_PROTOCOLS = new Set([
  'ftp',
  'file',
  'http',
  'https',
  'ws',
  'wss'
]);
function _compileComponent(patternStr: string | undefined, options: {
  delimiter: string;
}, component: URLPatternComponentName, ignoreCase = false): CompiledPattern {
  const p = patternStr != null ? String(patternStr) : '*';
  return _compilePattern(p, options, component, ignoreCase);
}
const BASE_URL_EARLIER_COMPONENTS: Record<URLPatternComponentName, URLPatternComponentName[]> = {
  protocol: [],
  username: [],
  password: [],
  hostname: ['protocol'],
  port: ['protocol', 'hostname'],
  pathname: [
    'protocol',
    'hostname',
    'port'
  ],
  search: [
    'protocol',
    'hostname',
    'port',
    'pathname'
  ],
  hash: [
    'protocol',
    'hostname',
    'port',
    'pathname',
    'search'
  ]
};
function _urlComponentValue(url: URL, component: URLPatternComponentName): string {
  if (component === 'protocol') return url.protocol.replace(/:$/, '');
  if (component === 'username') return url.username;
  if (component === 'password') return url.password;
  if (component === 'hostname') return _escapePatternLiteral(url.hostname);
  if (component === 'port') return url.port;
  if (component === 'pathname') return _escapePatternLiteral(url.pathname);
  if (component === 'search') return _escapePatternLiteral(url.search.replace(/^\?/, ''));
  return _escapePatternLiteral(url.hash.replace(/^#/, ''));
}
function _initHasComponent(init: URLPatternInit, component: URLPatternComponentName): boolean {
  return _hasOwn(init, component) && init[component] !== undefined;
}
function _resolveURLPatternInitBaseURL(init: URLPatternInit): URLPatternInit {
  if (init.baseURL == null) return init;
  const base = new URL(String(init.baseURL));
  const result: URLPatternInit = { ...init };
  for (const component of URL_PATTERN_COMPONENT_NAMES) {
    const name = component as URLPatternComponentName;
    if (name === 'username' || name === 'password' || _initHasComponent(result, name)) {
      continue;
    }
    if (BASE_URL_EARLIER_COMPONENTS[name].some((earlier) => _initHasComponent(init, earlier))) {
      continue;
    }
    result[name] = _urlComponentValue(base, name);
  }
  return result;
}
function _extractInitComponents(init: URLPatternInit): URLComponentDict | null {
  let resolved = init;
  if (init.baseURL != null) {
    try {
      const base = new URL(String(init.baseURL));
      resolved = {
        protocol: base.protocol.replace(/:$/, ''),
        username: base.username,
        password: base.password,
        hostname: base.hostname,
        port: base.port,
        pathname: base.pathname,
        search: base.search.replace(/^\?/, ''),
        hash: base.hash.replace(/^#/, ''),
        ...init
      };
    } catch (_) {
      return null;
    }
  }
  return {
    protocol: resolved.protocol != null ? String(resolved.protocol).replace(/:$/, '') : '',
    username: resolved.username != null ? _canonicalizeComponentText('username', String(resolved.username)) : '',
    password: resolved.password != null ? _canonicalizeComponentText('password', String(resolved.password)) : '',
    hostname: resolved.hostname != null ? _canonicalizeHostnameText(String(resolved.hostname)) : '',
    port: resolved.port != null ? String(resolved.port) : '',
    pathname: resolved.pathname != null ? _canonicalizeComponentText('pathname', String(resolved.pathname)) : '',
    search: resolved.search != null ? _canonicalizeComponentText('search', String(resolved.search).replace(/^\?/, '')) : '',
    hash: resolved.hash != null ? _canonicalizeComponentText('hash', String(resolved.hash).replace(/^#/, '')) : ''
  };
}
function _ignoreCaseFromOptions(options: URLPatternOptions | undefined): boolean {
  return options?.ignoreCase === true;
}
function _hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
function _encodeGeneratedGroup(component: URLPatternComponentName, value: string, protocolPattern: string): string {
  if (component === 'pathname') {
    if (value.includes('/')) {
      throw new TypeError('URLPattern.generate: pathname groups cannot contain "/"');
    }
    if (protocolPattern !== '*' && !SPECIAL_PROTOCOLS.has(protocolPattern.toLowerCase())) {
      return value;
    }
    return encodeURIComponent(value);
  }
  return value;
}
function _canonicalizeGeneratedComponent(component: URLPatternComponentName, value: string): string {
  if (component !== 'hostname' || value === '*') return value;
  try {
    return new URL(`http://${value}/`).hostname;
  } catch (_) {
    throw new TypeError('URLPattern.generate: generated hostname is invalid');
  }
}
function _compareModifier(modifierA = '', modifierB = ''): number {
  const ranks: Record<string, number> = {
    '*': 0,
    '?': 1,
    '+': 2,
    '': 3
  };
  return Math.sign((ranks[modifierA] ?? 3) - (ranks[modifierB] ?? 3));
}
function _compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
function _comparePartRank(part: URLPatternComparePart): number {
  if (part.kind === 'wildcard') return 0;
  if (part.kind === 'name') return 1;
  if (part.kind === 'regexp') return 2;
  if (part.kind === 'text') return 3;
  return 3;
}
function _comparePartLists(left: URLPatternComparePart[], right: URLPatternComparePart[]): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const compared = _compareParts(left[i]!, right[i]!);
    if (compared !== 0) return compared;
  }
  if (left.length < right.length && right[left.length]!.kind !== 'text') return 1;
  if (right.length < left.length && left[right.length]!.kind !== 'text') return -1;
  return Math.sign(left.length - right.length);
}
function _compareParts(left: URLPatternComparePart, right: URLPatternComparePart): number {
  if (left.kind === 'group' || right.kind === 'group') {
    const leftParts = left.kind === 'group' ? left.parts ?? [] : [left];
    const rightParts = right.kind === 'group' ? right.parts ?? [] : [right];
    const compared = _comparePartLists(leftParts, rightParts);
    if (compared !== 0) return compared;
    return _compareModifier(left.kind === 'group' ? left.modifier : '', right.kind === 'group' ? right.modifier : '');
  }
  const rankCompared = Math.sign(_comparePartRank(left) - _comparePartRank(right));
  if (rankCompared !== 0) return rankCompared;
  if (left.kind === 'text') {
    const compared = _compareText(left.value ?? '', right.value ?? '');
    if (compared !== 0) return compared;
  } else if (left.kind === 'regexp') {
    const compared = _compareText(left.value ?? '', right.value ?? '');
    if (compared !== 0) return compared;
  }
  return _compareModifier(left.modifier, right.modifier);
}
function _parseCompareParts(tokens: Token[], start = 0): {
  parts: URLPatternComparePart[];
  index: number;
} {
  const parts: URLPatternComparePart[] = [];
  let i = start;
  while (tokens[i]!.type !== T_END && tokens[i]!.type !== T_CLOSE) {
    const token = tokens[i]!;
    if (token.type === T_TEXT || token.type === T_ESCAPED) {
      parts.push({
        kind: 'text',
        value: token.value ?? ''
      });
      i++;
      continue;
    }
    if (token.type === T_NAME) {
      i++;
      if (tokens[i]!.type === T_PATTERN) {
        const value = tokens[i]!.value ?? '';
        i++;
        const modifier = tokens[i]!.type === T_MODIFIER || tokens[i]!.type === T_ASTERISK ? tokens[i]!.value ?? '*' : '';
        if (modifier) i++;
        parts.push({
          kind: 'regexp',
          value,
          modifier
        });
        continue;
      }
      const modifier = tokens[i]!.type === T_MODIFIER || tokens[i]!.type === T_ASTERISK ? tokens[i]!.value ?? '*' : '';
      if (modifier) i++;
      parts.push({
        kind: 'name',
        modifier
      });
      continue;
    }
    if (token.type === T_PATTERN) {
      i++;
      const modifier = tokens[i]!.type === T_MODIFIER || tokens[i]!.type === T_ASTERISK ? tokens[i]!.value ?? '*' : '';
      if (modifier) i++;
      parts.push({
        kind: 'regexp',
        value: token.value ?? '',
        modifier
      });
      continue;
    }
    if (token.type === T_ASTERISK) {
      parts.push({ kind: 'wildcard' });
      i++;
      continue;
    }
    if (token.type === T_OPEN) {
      const group = _parseCompareParts(tokens, i + 1);
      i = group.index;
      if (tokens[i]!.type === T_CLOSE) i++;
      const modifier = tokens[i]!.type === T_MODIFIER || tokens[i]!.type === T_ASTERISK ? tokens[i]!.value ?? '*' : '';
      if (modifier) {
        i++;
        parts.push({
          kind: 'group',
          modifier,
          parts: group.parts
        });
      } else {
        parts.push(...group.parts);
      }
      continue;
    }
    i++;
  }
  return {
    parts: _normalizeCompareParts(parts),
    index: i
  };
}
function _normalizeCompareParts(parts: URLPatternComparePart[]): URLPatternComparePart[] {
  const normalized: URLPatternComparePart[] = [];
  for (const part of parts) {
    if (part.kind === 'name' && part.modifier === '?' && normalized.length > 0) {
      const previous = normalized[normalized.length - 1]!;
      if (previous.kind === 'text' && previous.value !== undefined && previous.value.length > 0) {
        const delimiter = previous.value[previous.value.length - 1]!;
        previous.value = previous.value.slice(0, -1);
        if (previous.value === '') normalized.pop();
        normalized.push({
          kind: 'group',
          modifier: '?',
          parts: [{
            kind: 'text',
            value: delimiter
          }, { kind: 'name' }]
        });
        continue;
      }
    }
    const previous = normalized[normalized.length - 1];
    if (previous?.kind === 'text' && part.kind === 'text') {
      previous.value = (previous.value ?? '') + (part.value ?? '');
    } else {
      normalized.push(part);
    }
  }
  return normalized;
}
function _generateComponent(compiled: CompiledPattern, component: URLPatternComponentName, groups: Record<string, unknown>, protocolPattern: string): string {
  const tokens = _tokenize(compiled.pattern);
  let output = '';
  let i = 0;
  function appendUntilClose(): boolean {
    while (tokens[i]!.type !== T_END) {
      const tok = tokens[i]!;
      if (tok.type === T_CLOSE) {
        i++;
        return true;
      }
      if (tok.type === T_TEXT || tok.type === T_ESCAPED) {
        output += tok.value ?? '';
        i++;
        continue;
      }
      if (tok.type === T_NAME) {
        const name = tok.value!;
        if (!_hasOwn(groups, name)) {
          throw new TypeError(`URLPattern.generate: missing group "${name}"`);
        }
        i++;
        if (tokens[i]!.type === T_PATTERN) {
          throw new TypeError('URLPattern.generate: regexp groups are not supported');
        }
        output += _encodeGeneratedGroup(component, String(groups[name]), protocolPattern);
        continue;
      }
      if (tok.type === T_OPEN) {
        i++;
        appendUntilClose();
        if (tokens[i]!.type === T_MODIFIER || tokens[i]!.type === T_ASTERISK) {
          throw new TypeError('URLPattern.generate: group modifiers are not supported');
        }
        continue;
      }
      throw new TypeError('URLPattern.generate: unsupported pattern syntax');
    }
    return false;
  }
  appendUntilClose();
  return _canonicalizeGeneratedComponent(component, output);
}
function _compareComponentPattern(left: CompiledPattern, right: CompiledPattern): number {
  const leftParts = _parseCompareParts(_tokenize(left.pattern)).parts;
  const rightParts = _parseCompareParts(_tokenize(right.pattern)).parts;
  return _comparePartLists(leftParts, rightParts);
}
// ---------------------------------------------------------------------------
// Match a component: returns { input, groups } or null
// ---------------------------------------------------------------------------
function _matchComponent(compiled: CompiledPattern, value: string): URLPatternComponentResult | null {
  const m = compiled.regexp.exec(value);
  if (!m) return null;
  const groups: Record<string, string | undefined> = {};
  for (let i = 0; i < compiled.keys.length; i++) {
    const k = compiled.keys[i]!;
    const v = m[i + 1];
    groups[k.name] = v !== undefined ? v : undefined;
  }
  return {
    input: value,
    groups
  };
}
// ---------------------------------------------------------------------------
// Resolve test/exec input → URL component dict
// ---------------------------------------------------------------------------
function _hasHref(input: unknown): input is {
  href: string;
} {
  return input != null && typeof input === 'object' && typeof (input as {
    href?: string;
  }).href === 'string';
}
function _extractComponents(input: string | {
  href: string;
} | URLPatternInit, baseURL?: string): URLComponentDict | null {
  if (typeof input === 'string' || _hasHref(input)) {
    try {
      const href = typeof input === 'string' ? input : input.href;
      const url = new URL(href, baseURL);
      return {
        protocol: url.protocol.replace(/:$/, ''),
        username: url.username,
        password: url.password,
        hostname: url.hostname,
        port: url.port,
        pathname: url.pathname,
        search: url.search.replace(/^\?/, ''),
        hash: url.hash.replace(/^#/, '')
      };
    } catch (_) {
      return null;
    }
  }
  // URLPatternInit object
  return _extractInitComponents(input as URLPatternInit);
}
// ---------------------------------------------------------------------------
// URLPattern
// ---------------------------------------------------------------------------
/**
* WHATWG URLPattern implementation for matching URLs by component.
*
* Patterns may be supplied as a URL-like string or as an object with per-part
* patterns. Missing components default to "*".
*
* ```typescript no_run
* const pattern = new URLPattern({ pathname: '/users/:id' });
* pattern.test('https://example.com/users/42'); // true
* ```
*/
export class URLPattern {
  /**
  * Private property `#protocol` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #protocol = undefined;
  *
  *   readInternalState() {
  *     return this.#protocol;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #protocol: CompiledPattern;
  /**
  * Private property `#username` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #username = undefined;
  *
  *   readInternalState() {
  *     return this.#username;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #username: CompiledPattern;
  /**
  * Private property `#password` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #password = undefined;
  *
  *   readInternalState() {
  *     return this.#password;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #password: CompiledPattern;
  /**
  * Private property `#hostname` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #hostname = undefined;
  *
  *   readInternalState() {
  *     return this.#hostname;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #hostname: CompiledPattern;
  /**
  * Private property `#port` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #port = undefined;
  *
  *   readInternalState() {
  *     return this.#port;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #port: CompiledPattern;
  /**
  * Private property `#pathname` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #pathname = undefined;
  *
  *   readInternalState() {
  *     return this.#pathname;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #pathname: CompiledPattern;
  /**
  * Private property `#search` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #search = undefined;
  *
  *   readInternalState() {
  *     return this.#search;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #search: CompiledPattern;
  /**
  * Private property `#hash` used by `URLPattern`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #hash = undefined;
  *
  *   readInternalState() {
  *     return this.#hash;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #hash: CompiledPattern;
  #componentPattern(component: URLPatternComponentName): CompiledPattern {
    if (component === 'protocol') return this.#protocol;
    if (component === 'username') return this.#username;
    if (component === 'password') return this.#password;
    if (component === 'hostname') return this.#hostname;
    if (component === 'port') return this.#port;
    if (component === 'pathname') return this.#pathname;
    if (component === 'search') return this.#search;
    return this.#hash;
  }
  /**
  * String tag used by Object.prototype.toString.
  *
  * ```typescript no_run
  * Object.prototype.toString.call(new URLPattern({ pathname: '/' })); // "[object URLPattern]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'URLPattern';
  }
  /**
  * Create a URLPattern from string, component-object, or omitted input.
  *
  * String input is split into URL components while respecting pattern groups.
  * `baseURL` supplies defaults for relative string patterns and component
  * dictionaries. Object input uses the provided component patterns directly.
  * Missing or `undefined` input creates an all-wildcard pattern. Pass
  * `{ ignoreCase: true }` as the options object to match ASCII and Unicode
  * letters without case sensitivity.
  *
  * ```typescript no_run
  * const pattern = new URLPattern('/files/:name', 'https://example.com', {
  *   ignoreCase: true,
  * });
  * pattern.hostname; // "example.com"
  * ```
  */
  constructor(input?: string | URLPatternInit, baseURLOrOptions?: string | URLPatternOptions, options?: URLPatternOptions) {
    let init: ParsedURLPatternInit | URLPatternInit;
    let baseURL: string | undefined;
    let constructorOptions: URLPatternOptions | undefined;
    if (typeof baseURLOrOptions === 'string') {
      baseURL = baseURLOrOptions;
      constructorOptions = options;
    } else {
      constructorOptions = baseURLOrOptions;
    }
    const ignoreCase = _ignoreCaseFromOptions(constructorOptions);
    if (input === undefined) {
      init = {};
    } else if (typeof input === 'string') {
      init = _parsePatternInitString(input);
      // Apply baseURL for relative patterns (only pathname present)
      if (baseURL != null && init.protocol === undefined) {
        try {
          const base = new URL(String(baseURL));
          if (init.protocol === undefined) init.protocol = base.protocol.replace(/:$/, '');
          if (init.hostname === undefined) init.hostname = base.hostname;
          if (init.port === undefined) init.port = base.port;
          if (init.username === undefined) init.username = base.username;
          if (init.password === undefined) init.password = base.password;
        } catch (_) {}
      }
    } else if (input != null && typeof input === 'object') {
      init = _resolveURLPatternInitBaseURL(input);
    } else {
      throw new TypeError('URLPattern: first argument must be a string or object');
    }
    this.#protocol = _compileComponent(init.protocol, COMPONENT_OPTIONS.protocol!, 'protocol', ignoreCase);
    this.#username = _compileComponent(init.username, COMPONENT_OPTIONS.username!, 'username', ignoreCase);
    this.#password = _compileComponent(init.password, COMPONENT_OPTIONS.password!, 'password', ignoreCase);
    this.#hostname = _compileComponent(init.hostname, COMPONENT_OPTIONS.hostname!, 'hostname', ignoreCase);
    this.#port = _compileComponent(init.port, COMPONENT_OPTIONS.port!, 'port', ignoreCase);
    this.#pathname = _compileComponent(init.pathname, COMPONENT_OPTIONS.pathname!, 'pathname', ignoreCase);
    this.#search = _compileComponent(init.search, COMPONENT_OPTIONS.search!, 'search', ignoreCase);
    this.#hash = _compileComponent(init.hash, COMPONENT_OPTIONS.hash!, 'hash', ignoreCase);
  }
  // Pattern string accessors
  /**
  * Protocol pattern without the trailing colon.
  *
  * ```typescript no_run
  * new URLPattern({ protocol: 'https' }).protocol; // "https"
  * ```
  */
  get protocol() {
    return this.#protocol.pattern;
  }
  /**
  * Username pattern.
  *
  * ```typescript no_run
  * new URLPattern({ username: '*' }).username; // "*"
  * ```
  */
  get username() {
    return this.#username.pattern;
  }
  /**
  * Password pattern.
  *
  * ```typescript no_run
  * new URLPattern({ password: '*' }).password; // "*"
  * ```
  */
  get password() {
    return this.#password.pattern;
  }
  /**
  * Hostname pattern.
  *
  * Hostname named parameters stop at "." by default.
  *
  * ```typescript no_run
  * new URLPattern({ hostname: ':sub.example.com' }).hostname; // ":sub.example.com"
  * ```
  */
  get hostname() {
    return this.#hostname.pattern;
  }
  /**
  * Port pattern.
  *
  * ```typescript no_run
  * new URLPattern({ port: '8080' }).port; // "8080"
  * ```
  */
  get port() {
    return this.#port.pattern;
  }
  /**
  * Pathname pattern.
  *
  * Pathname named parameters stop at "/" by default.
  *
  * ```typescript no_run
  * new URLPattern({ pathname: '/users/:id' }).pathname; // "/users/:id"
  * ```
  */
  get pathname() {
    return this.#pathname.pattern;
  }
  /**
  * Search pattern without leading question mark.
  *
  * ```typescript no_run
  * new URLPattern({ search: 'q=:term' }).search; // "q=:term"
  * ```
  */
  get search() {
    return this.#search.pattern;
  }
  /**
  * Hash pattern without leading hash.
  *
  * ```typescript no_run
  * new URLPattern({ hash: 'top' }).hash; // "top"
  * ```
  */
  get hash() {
    return this.#hash.pattern;
  }
  /**
  * Returns true if any component contains an explicit regexp group `(...)`.
  * Named params like `:name` do not count; only inline `(pattern)` groups do.
  *
  * ```typescript no_run
  * new URLPattern({ pathname: '/:id(\\d+)' }).hasRegExpGroups; // true
  * ```
  */
  get hasRegExpGroups(): boolean {
    // True when any component contains an explicit regexp group — either an
    // inline `(pattern)` or a named param with a custom regexp `:name(pattern)`.
    // Plain wildcards `*` and plain named params `:name` do not count.
    return this.#protocol.hasRegExpGroups || this.#username.hasRegExpGroups || this.#password.hasRegExpGroups || this.#hostname.hasRegExpGroups || this.#port.hasRegExpGroups || this.#pathname.hasRegExpGroups || this.#search.hasRegExpGroups || this.#hash.hasRegExpGroups;
  }
  /**
  * Return true when input matches every URL component pattern.
  *
  * Invalid string or href inputs return false. Object inputs are interpreted as
  * already-split URLPatternInit component values.
  *
  * ```typescript no_run
  * const pattern = new URLPattern({ pathname: '/users/:id' });
  * pattern.test('https://example.com/users/42'); // true
  * ```
  */
  test(input: string | {
    href: string;
  } | URLPatternInit, baseURL?: string): boolean {
    const components = _extractComponents(input, baseURL);
    if (!components) return false;
    return this.#protocol.regexp.test(components.protocol) && this.#username.regexp.test(components.username) && this.#password.regexp.test(components.password) && this.#hostname.regexp.test(components.hostname) && this.#port.regexp.test(components.port) && this.#pathname.regexp.test(components.pathname) && this.#search.regexp.test(components.search) && this.#hash.regexp.test(components.hash);
  }
  /**
  * Generate one URL component from literal text and simple named groups.
  *
  * The current support covers the common routing subset used by the WPT
  * generation fixture: text tokens, escaped literals, and `:name` groups.
  * Wildcards, regexp groups, and optional or repeated groups throw `TypeError`.
  *
  * ```typescript no_run
  * new URLPattern({ pathname: '/users/:id' }).generate('pathname', { id: '42' });
  * // "/users/42"
  * ```
  */
  generate(component: string, groups: Record<string, unknown> = {}): string {
    if (!URL_PATTERN_COMPONENT_NAMES.has(component)) {
      throw new TypeError('URLPattern.generate: invalid component');
    }
    if (groups === null || typeof groups !== 'object') {
      throw new TypeError('URLPattern.generate: groups must be an object');
    }
    const name = component as URLPatternComponentName;
    return _generateComponent(this.#componentPattern(name), name, groups, this.#protocol.pattern);
  }
  /**
  * Compare two URLPattern component patterns for routing precedence.
  *
  * Parameter names do not affect ordering. Literal text sorts above regexp
  * groups, named groups, and wildcards; group modifiers sort as `*`, `?`, `+`,
  * then no modifier.
  *
  * ```typescript no_run
  * URLPattern.compareComponent(
  *   'pathname',
  *   new URLPattern({ pathname: '/users/:id' }),
  *   new URLPattern({ pathname: '/users/*' }),
  * ); // 1
  * ```
  */
  static compareComponent(component: string, left: URLPattern, right: URLPattern): number {
    if (!URL_PATTERN_COMPONENT_NAMES.has(component)) {
      throw new TypeError('URLPattern.compareComponent: invalid component');
    }
    if (!(left instanceof URLPattern) || !(right instanceof URLPattern)) {
      throw new TypeError('URLPattern.compareComponent: arguments must be URLPattern instances');
    }
    const name = component as URLPatternComponentName;
    return _compareComponentPattern(left.#componentPattern(name), right.#componentPattern(name));
  }
  /**
  * Match input and return per-component inputs and capture groups.
  *
  * Returns null if parsing fails or any component does not match. The inputs
  * array contains [input] or [input, baseURL] depending on call shape.
  *
  * ```typescript no_run
  * const pattern = new URLPattern({ pathname: '/users/:id' });
  * const match = pattern.exec('https://example.com/users/42');
  * match?.pathname.groups.id; // "42"
  * ```
  */
  exec(input: string | {
    href: string;
  } | URLPatternInit, baseURL?: string): {
    inputs: any[];
    protocol: URLPatternComponentResult;
    username: URLPatternComponentResult;
    password: URLPatternComponentResult;
    hostname: URLPatternComponentResult;
    port: URLPatternComponentResult;
    pathname: URLPatternComponentResult;
    search: URLPatternComponentResult;
    hash: URLPatternComponentResult;
  } | null {
    const components = _extractComponents(input, baseURL);
    if (!components) return null;
    const protocol = _matchComponent(this.#protocol, components.protocol);
    const username = _matchComponent(this.#username, components.username);
    const password = _matchComponent(this.#password, components.password);
    const hostname = _matchComponent(this.#hostname, components.hostname);
    const port = _matchComponent(this.#port, components.port);
    const pathname = _matchComponent(this.#pathname, components.pathname);
    const search = _matchComponent(this.#search, components.search);
    const hash = _matchComponent(this.#hash, components.hash);
    if (!protocol || !username || !password || !hostname || !port || !pathname || !search || !hash) {
      return null;
    }
    const inputs = baseURL != null ? [input, baseURL] : [input];
    return {
      inputs,
      protocol,
      username,
      password,
      hostname,
      port,
      pathname,
      search,
      hash
    };
  }
}
