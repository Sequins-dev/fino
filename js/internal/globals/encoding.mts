/**
 * boats:encoding — UTF-8 TextEncoder / TextDecoder (WHATWG Encoding Standard)
 *
 * This module provides two layers:
 *
 * 1. **Internal helpers** (`encodeUtf8`, `decodeUtf8`): low-level functions
 *    used throughout the standard library whenever bytes need to cross the
 *    JS↔C boundary. Every module that passes strings to libc (file paths,
 *    DNS names, HTTP headers, process arguments, …) uses `encodeUtf8` to
 *    produce null-terminated byte arrays. These are exported so modules can
 *    import them directly without going through the WHATWG class wrappers.
 *
 * 2. **WHATWG API** (`TextEncoder`, `TextDecoder`): the web-standard classes
 *    that userland code expects. `TextEncoder.encoding` is always `"utf-8"`.
 *    `TextDecoder` accepts any of the WHATWG-defined UTF-8 label aliases
 *    ("utf8", "unicode-1-1-utf-8", etc.) but rejects other encodings with a
 *    RangeError. The `stream: true` option for incremental decoding is
 *    accepted but ignored — splitting UTF-8 input across multiple calls is
 *    not supported; each `decode()` call treats its input as a complete byte
 *    sequence.
 *
 *
 * ## Why UTF-8 only?
 *
 * The WHATWG Encoding Standard requires implementations to support all
 * legacy encodings (Latin-1, Shift-JIS, etc.) for decoding. We intentionally
 * limit this to UTF-8 only. The vast majority of modern text is UTF-8, and
 * adding full encoding support would require a large lookup table or a C
 * library dependency (libiconv). Contributors who need legacy encoding support
 * can import a pure-JS library via the module loader.
 *
 *
 * ## Encoder implementation
 *
 * `encodeUtf8` processes each JS code unit. JS strings are UTF-16 internally,
 * so surrogate pairs (U+D800..U+DBFF followed by U+DC00..U+DFFF) must be
 * recombined into a 32-bit code point before encoding as a 4-byte UTF-8
 * sequence. The algorithm pre-allocates `str.length * 4` bytes (worst case),
 * writes into that buffer, then calls `slice(0, pos)` to return a correctly-
 * sized copy. Using `slice()` rather than `subarray()` ensures the returned
 * Uint8Array's `.buffer` property has the right `byteLength`, which matters
 * when callers pass `.buffer` to FFI or `Pointer.of()`.
 *
 *
 * ## Decoder implementation
 *
 * `decodeUtf8` validates each multi-byte sequence against three classes of
 * errors (also checked by browsers):
 *
 * - **Invalid lead byte**: a byte whose high bits don't match any UTF-8
 *   sequence prefix (e.g. 0xFF).
 * - **Truncated sequence**: a lead byte promises N continuation bytes but
 *   fewer are available.
 * - **Overlong / surrogate / out-of-range**: a sequence that encodes a code
 *   point that could have been expressed with fewer bytes (overlong), a code
 *   point in the surrogate range (U+D800–U+DFFF, which UTF-8 cannot encode
 *   in valid form), or a code point above U+10FFFF.
 *
 * In non-fatal mode (default), all three replace the offending byte(s) with
 * U+FFFD (the REPLACEMENT CHARACTER). In fatal mode, a TypeError is thrown.
 *
 * The optional BOM strip (U+FEFF at offset 0) is on by default to match
 * browser behavior; set `ignoreBOM: true` on `TextDecoder` to preserve it.
 *
 *
 * ## encodeInto
 *
 * `TextEncoder.encodeInto(input, destination)` writes directly into an
 * existing Uint8Array without allocating. It returns `{ read, written }`:
 * `read` is the number of JS code units consumed (note: a surrogate pair
 * counts as 2 code units), `written` is the number of bytes written. Stops
 * early if the destination would overflow.
 */

// ---------------------------------------------------------------------------
// Internal UTF-8 primitives
// ---------------------------------------------------------------------------

/**
 * Encode a JS string to a Uint8Array of UTF-8 bytes.
 * Handles the full Unicode range including surrogate pairs.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
export function encodeUtf8(str: string): Uint8Array {
  // Worst case: 4 bytes per JS code unit.
  const buf = new Uint8Array(str.length * 4);
  let pos = 0;

  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);

    // Surrogate pair — combine, or replace lone surrogate with U+FFFD.
    if (cp >= 0xD800 && cp <= 0xDBFF) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xDC00 && lo <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        i++; // consume the low surrogate
      } else {
        cp = 0xFFFD; // lone high surrogate
      }
    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
      cp = 0xFFFD; // lone low surrogate
    }

    if (cp < 0x80) {
      buf[pos++] = cp;
    } else if (cp < 0x800) {
      buf[pos++] = 0xC0 | (cp >> 6);
      buf[pos++] = 0x80 | (cp & 0x3F);
    } else if (cp < 0x10000) {
      buf[pos++] = 0xE0 | (cp >> 12);
      buf[pos++] = 0x80 | ((cp >> 6) & 0x3F);
      buf[pos++] = 0x80 | (cp & 0x3F);
    } else {
      buf[pos++] = 0xF0 | (cp >> 18);
      buf[pos++] = 0x80 | ((cp >> 12) & 0x3F);
      buf[pos++] = 0x80 | ((cp >> 6) & 0x3F);
      buf[pos++] = 0x80 | (cp & 0x3F);
    }
  }

  // slice() copies only the written bytes, giving the result its own
  // correctly-sized ArrayBuffer. (subarray() would share the over-allocated
  // backing buffer, making .buffer misleading for callers.)
  return buf.slice(0, pos);
}

/**
 * Decode a Uint8Array of UTF-8 bytes to a JS string.
 * Invalid sequences are replaced with U+FFFD (replacement character).
 *
 * @param {Uint8Array} bytes
 * @param {boolean} [fatal=false]  Throw TypeError on invalid sequences instead of replacing.
 * @param {boolean} [skipBom=true] Strip a leading BOM (U+FEFF) if present.
 * @returns {string}
 */
export function decodeUtf8(bytes: Uint8Array, fatal: boolean = false, skipBom: boolean = true): string {
  let str = '';
  let i = 0;
  let first = true;

  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp;
    let seqLen;

    if (b0 < 0x80) {
      cp = b0; seqLen = 1;
    } else if ((b0 & 0xE0) === 0xC0) {
      cp = b0 & 0x1F; seqLen = 2;
    } else if ((b0 & 0xF0) === 0xE0) {
      cp = b0 & 0x0F; seqLen = 3;
    } else if ((b0 & 0xF8) === 0xF0) {
      cp = b0 & 0x07; seqLen = 4;
    } else {
      // Invalid lead byte
      if (fatal) throw new TypeError(`TextDecoder: invalid byte 0x${b0.toString(16)} at index ${i}`);
      str += '\uFFFD';
      i++;
      continue;
    }

    // Validate and accumulate continuation bytes.
    let valid = true;
    for (let j = 1; j < seqLen; j++) {
      if (i + j >= bytes.length || (bytes[i + j] & 0xC0) !== 0x80) {
        valid = false;
        break;
      }
      cp = (cp << 6) | (bytes[i + j] & 0x3F);
    }

    if (!valid) {
      if (fatal) throw new TypeError(`TextDecoder: incomplete sequence at index ${i}`);
      str += '\uFFFD';
      i++;
      continue;
    }

    // Overlong / surrogate / out-of-range checks
    if (
      (seqLen === 2 && cp < 0x80) ||
      (seqLen === 3 && cp < 0x800) ||
      (seqLen === 4 && cp < 0x10000) ||
      cp > 0x10FFFF ||
      (cp >= 0xD800 && cp <= 0xDFFF)
    ) {
      if (fatal) throw new TypeError(`TextDecoder: invalid code point U+${cp.toString(16)} at index ${i}`);
      str += '\uFFFD';
      i += seqLen;
      continue;
    }

    // Skip BOM at the very start of the stream.
    if (first && skipBom && cp === 0xFEFF) {
      i += seqLen;
      first = false;
      continue;
    }
    first = false;

    if (cp < 0x10000) {
      str += String.fromCharCode(cp);
    } else {
      // Supplementary plane → surrogate pair
      cp -= 0x10000;
      str += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
    }

    i += seqLen;
  }

  return str;
}

// ---------------------------------------------------------------------------
// Base64 — btoa / atob
// ---------------------------------------------------------------------------

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Reverse lookup: char code → 6-bit value (or -1 for invalid, -2 for '=').
const BASE64_DECODE = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) BASE64_DECODE[BASE64_CHARS.charCodeAt(i)] = i;
BASE64_DECODE[0x3D] = -2; // '='

/**
 * Encode a Latin-1 binary string to base64 (web `btoa`).
 * Throws if any character code is > 255.
 *
 * @param {string} data  Binary string — each char must be in [0, 255].
 * @returns {string}
 */
export function btoa(data: string): string {
  const str = String(data);
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0xFF) {
      throw new TypeError(
        'btoa: The string to be encoded contains characters outside of the Latin1 range.',
      );
    }
  }

  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const b0 = str.charCodeAt(i);
    const b1 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const b2 = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    const rem = str.length - i;

    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += rem > 1 ? BASE64_CHARS[((b1 & 0x0F) << 2) | (b2 >> 6)] : '=';
    out += rem > 2 ? BASE64_CHARS[b2 & 0x3F] : '=';
  }
  return out;
}

/**
 * Decode a base64 string to a Latin-1 binary string (web `atob`).
 * Throws on invalid base64 input.
 *
 * @param {string} encodedData
 * @returns {string}
 */
export function atob(encodedData: string): string {
  // Strip ASCII whitespace per the spec (spaces, tabs, newlines, CR, FF).
  let str = String(encodedData).replace(/[\t\n\f\r ]/g, '');

  // Per spec, length % 4 == 1 is always invalid. Pad 2- and 3-remainder
  // strings so the 4-byte loop below works without requiring explicit padding.
  const rem = str.length % 4;
  if (rem === 1) {
    throw new TypeError(
      'atob: The string to be decoded is not correctly encoded.',
    );
  } else if (rem === 2) {
    str += '==';
  } else if (rem === 3) {
    str += '=';
  }

  let out = '';
  for (let i = 0; i < str.length; i += 4) {
    const v0 = BASE64_DECODE[str.charCodeAt(i)];
    const v1 = BASE64_DECODE[str.charCodeAt(i + 1)];
    const v2 = BASE64_DECODE[str.charCodeAt(i + 2)];
    const v3 = BASE64_DECODE[str.charCodeAt(i + 3)];

    if (v0 < 0 || v1 < 0 || v2 === -1 || v3 === -1 || (v2 === -2 && v3 !== -2)) {
      throw new TypeError(
        'atob: The string to be decoded is not correctly encoded.',
      );
    }

    out += String.fromCharCode((v0 << 2) | (v1 >> 4));
    if (v2 !== -2) out += String.fromCharCode(((v1 & 0x0F) << 4) | (v2 >> 2));
    if (v3 !== -2) out += String.fromCharCode(((v2 & 0x03) << 6) | v3);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blob clone helper registration (avoids circular import with blob.mts)
// ---------------------------------------------------------------------------

// blob.mts calls _registerBlobCloneHelper() after its classes are defined.
// _clone() uses these to clone Blob and File instances synchronously via the
// internal byte buffer, without needing to import from blob.mts directly.
type BlobCloneHelper = {
  getBlobBytes: (b: object) => Uint8Array;
  BlobCtor: new (parts: Iterable<unknown>, opts?: { type?: string }) => object;
  FileCtor: new (parts: Iterable<unknown>, name: string, opts?: { type?: string; lastModified?: number }) => object;
  isBlob: (v: object) => boolean;
  isFile: (v: object) => boolean;
  getName: (v: object) => string;
  getLastModified: (v: object) => number;
};
let _blobCloneHelper: BlobCloneHelper | null = null;

export function _registerBlobCloneHelper(helper: BlobCloneHelper): void {
  _blobCloneHelper = helper;
}

// ---------------------------------------------------------------------------
// structuredClone
// ---------------------------------------------------------------------------

/**
 * Deep-clone a value using the structured clone algorithm (subset).
 *
 * Supported types:
 *   primitives, plain objects, Arrays, Date, RegExp, Map, Set,
 *   ArrayBuffer, TypedArrays, DataView, Error (message + name), Blob, File.
 *
 * Unsupported (throws DataCloneError):
 *   Functions, Symbols, WeakMap, WeakSet.
 *
 * Cycles are detected and reproduced correctly.
 *
 * @param {*} value
 * @returns {*}
 */
export function structuredClone<T>(value: T, options?: { transfer?: ArrayBuffer[] }): T {
  const transferList = options?.transfer;
  const transferSet = transferList ? new Set<ArrayBuffer>(transferList) : null;
  if (transferList) {
    for (const buf of transferList) {
      if (!(buf instanceof ArrayBuffer)) {
        throw new TypeError('structuredClone: transfer list must contain only ArrayBuffers');
      }
    }
  }
  const seen = new WeakMap<object, unknown>();
  const clone = _clone(value, seen, transferSet) as T;
  // Detach transferred ArrayBuffers. True detachment requires engine support.
  // If the buffer is resizable, resize to 0 (byteLength → 0, views become empty).
  // Otherwise zero the contents — full detachment is not possible without transfer().
  if (transferSet) {
    for (const buf of transferSet) {
      if ((buf as any).resizable) {
        (buf as any).resize(0);
      } else {
        new Uint8Array(buf).fill(0);
      }
    }
  }
  return clone;
}

function _clone(value: unknown, seen: WeakMap<object, unknown>, transferSet: Set<ArrayBuffer> | null = null): unknown {
  // Primitives
  if (value === null || typeof value !== 'object' && typeof value !== 'function') {
    if (typeof value === 'symbol') {
      throw new TypeError('structuredClone: Symbol values cannot be cloned.');
    }
    return value;
  }

  // Functions
  if (typeof value === 'function') {
    throw new TypeError('structuredClone: function values cannot be cloned.');
  }

  // Cycle check
  if (seen.has(value)) return seen.get(value);

  // Date
  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    seen.set(value, clone);
    return clone;
  }

  // RegExp
  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    seen.set(value, clone);
    return clone;
  }

  // Boolean / Number / String wrapper objects
  if (value instanceof Boolean) {
    const clone = new Boolean((value as Boolean).valueOf());
    seen.set(value, clone);
    return clone;
  }
  if (value instanceof Number) {
    const clone = new Number((value as Number).valueOf());
    seen.set(value, clone);
    return clone;
  }
  if (value instanceof String) {
    const clone = new String((value as String).valueOf());
    seen.set(value, clone);
    return clone;
  }

  // ArrayBuffer — copy the bytes; the source will be detached after _clone returns.
  if (value instanceof ArrayBuffer) {
    const clone = value.slice(0);
    seen.set(value, clone);
    return clone;
  }

  // TypedArrays and DataView
  if (ArrayBuffer.isView(value)) {
    const bufClone = value.buffer.slice(0);
    let clone;
    if (value instanceof DataView) {
      clone = new DataView(bufClone, value.byteOffset, value.byteLength);
    } else {
      clone = new (value as any).constructor(bufClone, value.byteOffset, (value as any).length);
    }
    seen.set(value, clone);
    return clone;
  }

  // Blob / File (synchronous via registered helper)
  if (_blobCloneHelper && _blobCloneHelper.isBlob(value)) {
    const bytes = _blobCloneHelper.getBlobBytes(value);
    const h = _blobCloneHelper;
    const blobClone = h.isFile(value)
      ? new h.FileCtor([bytes], h.getName(value), { type: (value as any).type, lastModified: h.getLastModified(value) })
      : new h.BlobCtor([bytes], { type: (value as any).type });
    seen.set(value, blobClone);
    return blobClone;
  }

  // Error
  if (value instanceof Error) {
    const clone = new (value as any).constructor(value.message);
    clone.stack = value.stack;
    if (value.name !== clone.name) clone.name = value.name;
    if ('cause' in value) (clone as any).cause = _clone((value as any).cause, seen, transferSet);
    seen.set(value, clone);
    return clone;
  }

  // Map
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [k, v] of value) {
      clone.set(_clone(k, seen, transferSet), _clone(v, seen, transferSet));
    }
    return clone;
  }

  // Set
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    for (const v of value) {
      clone.add(_clone(v, seen, transferSet));
    }
    return clone;
  }

  // WeakMap / WeakSet — not cloneable
  if (value instanceof WeakMap || value instanceof WeakSet) {
    throw new TypeError('structuredClone: WeakMap/WeakSet values cannot be cloned.');
  }

  // Array
  if (Array.isArray(value)) {
    const clone = new Array(value.length);
    seen.set(value, clone);
    for (let i = 0; i < value.length; i++) {
      clone[i] = _clone(value[i], seen, transferSet);
    }
    return clone;
  }

  // Plain object (prototype must be Object.prototype or null)
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const err = new Error('structuredClone: object with non-plain prototype cannot be cloned.');
    err.name = 'DataCloneError';
    throw err;
  }
  const clone = Object.create(proto);
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    (clone as any)[key] = _clone((value as any)[key], seen, transferSet);
  }
  return clone;
}

// ---------------------------------------------------------------------------
// TextEncoder
// ---------------------------------------------------------------------------

/**
 * WHATWG TextEncoder — always UTF-8.
 * https://encoding.spec.whatwg.org/#interface-textencoder
 */
export class TextEncoder {
  get [Symbol.toStringTag]() { return 'TextEncoder'; }
  /** @returns {"utf-8"} */
  get encoding() { return 'utf-8'; }

  /**
   * Encode `input` to a new Uint8Array.
   *
   * @param {string} [input='']
   * @returns {Uint8Array}
   */
  encode(input: string = ''): Uint8Array {
    return encodeUtf8(String(input));
  }

  /**
   * Encode as much of `input` as fits into `destination` without allocating.
   *
   * @param {string} input
   * @param {Uint8Array} destination
   * @returns {{ read: number, written: number }}
   */
  encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
    let read = 0;    // JS code units consumed
    let written = 0; // bytes written

    for (let i = 0; i < input.length; i++) {
      let cp = input.charCodeAt(i);

      // Surrogate pair — combine, or replace lone surrogate with U+FFFD.
      if (cp >= 0xD800 && cp <= 0xDBFF) {
        const lo = input.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
        } else {
          cp = 0xFFFD; // lone high surrogate
        }
      } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
        cp = 0xFFFD; // lone low surrogate
      }

      let seqLen;
      if      (cp < 0x80)    seqLen = 1;
      else if (cp < 0x800)   seqLen = 2;
      else if (cp < 0x10000) seqLen = 3;
      else                   seqLen = 4;

      if (written + seqLen > destination.length) break;

      if (seqLen === 1) {
        destination[written++] = cp;
      } else if (seqLen === 2) {
        destination[written++] = 0xC0 | (cp >> 6);
        destination[written++] = 0x80 | (cp & 0x3F);
      } else if (seqLen === 3) {
        destination[written++] = 0xE0 | (cp >> 12);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3F);
        destination[written++] = 0x80 | (cp & 0x3F);
      } else {
        destination[written++] = 0xF0 | (cp >> 18);
        destination[written++] = 0x80 | ((cp >> 12) & 0x3F);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3F);
        destination[written++] = 0x80 | (cp & 0x3F);
        i++; // consumed the low surrogate too
        read++;
      }

      read++;
      // Advance past the low surrogate if we consumed a pair
      if (cp >= 0x10000 && seqLen === 4) {
        // already incremented i and read above
      }
    }

    return { read, written };
  }
}

// ---------------------------------------------------------------------------
// TextDecoder
// ---------------------------------------------------------------------------

// Recognised UTF-8 label aliases per the WHATWG Encoding spec.
const UTF8_LABELS = new Set([
  'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8',
  'utf-8', 'utf8', 'x-unicode20utf8',
]);

/**
 * WHATWG TextDecoder — UTF-8 only.
 * https://encoding.spec.whatwg.org/#interface-textdecoder
 */
// Scan the end of `bytes` for an incomplete multi-byte UTF-8 sequence.
// Returns the byte offset at which the incomplete sequence starts,
// or bytes.length if all sequences are complete.
function _findIncompleteEnd(bytes: Uint8Array): number {
  const len = bytes.length;
  // Check last 1-3 bytes for an incomplete leading byte
  for (let back = 1; back <= 3 && back <= len; back++) {
    const b = bytes[len - back];
    let seqLen = 0;
    if ((b & 0xE0) === 0xC0) seqLen = 2;
    else if ((b & 0xF0) === 0xE0) seqLen = 3;
    else if ((b & 0xF8) === 0xF0) seqLen = 4;
    if (seqLen > 0 && back < seqLen) {
      // Found a leading byte that needs more continuation bytes
      return len - back;
    }
    // If it's a continuation byte (10xxxxxx), keep scanning
    if ((b & 0xC0) === 0x80) continue;
    // ASCII or a complete leading byte — stop
    break;
  }
  return len;
}

export class TextDecoder {
  #encoding: string;
  #fatal: boolean;
  #ignoreBOM: boolean;
  #pending: Uint8Array | null = null;
  // Tracks whether the BOM at the stream start has been seen/consumed. Resets
  // after each non-streaming decode() call per WHATWG spec.
  #bomHandled: boolean = false;

  get [Symbol.toStringTag]() { return 'TextDecoder'; }

  /**
   * @param {string} [label='utf-8']
   * @param {{ fatal?: boolean, ignoreBOM?: boolean }} [options]
   */
  constructor(label: string = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const normalised = String(label).trim().toLowerCase();
    if (!UTF8_LABELS.has(normalised)) {
      throw new RangeError(`TextDecoder: unsupported encoding '${label}'`);
    }
    this.#encoding  = 'utf-8';
    this.#fatal     = Boolean(options.fatal);
    this.#ignoreBOM = Boolean(options.ignoreBOM);
  }

  /** @returns {"utf-8"} */
  get encoding()  { return this.#encoding; }

  /** @returns {boolean} */
  get fatal()     { return this.#fatal; }

  /** @returns {boolean} */
  get ignoreBOM() { return this.#ignoreBOM; }

  /**
   * Decode `input` to a string.
   *
   * @param {ArrayBuffer|ArrayBufferView} [input]
   * @param {{ stream?: boolean }} [options]
   *   When `stream: true`, incomplete multi-byte sequences at the end are
   *   buffered and prepended to the next call, enabling chunk-by-chunk decoding.
   * @returns {string}
   */
  decode(input?: ArrayBuffer | ArrayBufferView | null, options?: { stream?: boolean }): string {
    const streaming = Boolean(options?.stream);

    let chunk: Uint8Array;
    if (input === undefined || input === null) {
      chunk = new Uint8Array(0);
    } else if (input instanceof Uint8Array) {
      chunk = input;
    } else if (ArrayBuffer.isView(input)) {
      chunk = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else if (input instanceof ArrayBuffer) {
      chunk = new Uint8Array(input);
    } else {
      throw new TypeError('TextDecoder.decode: input must be an ArrayBuffer or ArrayBufferView');
    }

    // Prepend any buffered incomplete sequence from a previous streaming call.
    let bytes: Uint8Array;
    if (this.#pending !== null) {
      const combined = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
      combined.set(this.#pending);
      combined.set(chunk, this.#pending.byteLength);
      bytes = combined;
      this.#pending = null;
    } else {
      bytes = chunk;
    }

    if (streaming) {
      // Buffer any incomplete multi-byte sequence at the end.
      const completeEnd = _findIncompleteEnd(bytes);
      if (completeEnd < bytes.byteLength) {
        this.#pending = bytes.slice(completeEnd);
        bytes = bytes.slice(0, completeEnd);
      }
    }

    if (bytes.byteLength === 0) {
      if (!streaming) this.#bomHandled = false;
      return '';
    }

    // For streaming mode the BOM-seen flag persists across calls so that BOM
    // is only stripped from the very first non-empty chunk of the stream.
    // For non-streaming mode each call is independent.
    const shouldStripBom = !this.#ignoreBOM && !this.#bomHandled;
    if (streaming) {
      this.#bomHandled = true;
    } else {
      this.#bomHandled = false;
    }

    return decodeUtf8(bytes, this.#fatal, shouldStripBom);
  }
}
