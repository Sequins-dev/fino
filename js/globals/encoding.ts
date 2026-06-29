/**
 * UTF-8 TextEncoder / TextDecoder globals.
 *
 * WHATWG Encoding Standard: https://encoding.spec.whatwg.org/
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
 *    that userland code expects. The release scope is UTF-8 only:
 *    `TextEncoder.encoding` is always `"utf-8"`, and `TextDecoder` accepts
 *    any of the WHATWG-defined UTF-8 label aliases ("utf8",
 *    "unicode-1-1-utf-8", etc.) but rejects other encodings with a RangeError.
 *    `stream: true` is supported for UTF-8 by buffering incomplete trailing
 *    multi-byte sequences and prepending them to the next `decode()` call.
 *    Non-UTF-8 labels remain outside the release contract.
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
 *
 * ## Example
 *
 * ```typescript no_run
 * const encoded = new TextEncoder().encode('hello');
 * console.log(new TextDecoder().decode(encoded));
 *
 * const pathBytes = encodeUtf8('/tmp/fino.txt');
 * console.log(decodeUtf8(pathBytes));
 * ```
 *
 */

import { detachArrayBuffer as _detachArrayBuffer } from 'internal:serializer';

// ---------------------------------------------------------------------------
// Internal UTF-8 primitives
// ---------------------------------------------------------------------------

/**
 * Encode a JS string to a Uint8Array of UTF-8 bytes.
 * Handles the full Unicode range including surrogate pairs.
 *
 * Returns a subarray view of an over-allocated backing buffer. Callers that
 * need the exact byte count should use `.byteLength` on the returned view
 * (not `.buffer.byteLength`). This avoids a second allocation (slice copy)
 * while keeping the API identical to before.
 *
 * ```typescript no_run
 * const bytes = encodeUtf8('hello');
 * bytes.byteLength; // 5
 * ```
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
export function encodeUtf8(str: string): Uint8Array {
  // ASCII fast path: scan for any code unit ≥ 0x80. If none found, skip the
  // 4× over-allocation and surrogate handling — one byte per character, exact.
  let ascii = true;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) >= 0x80) { ascii = false; break; }
  }
  if (ascii) {
    const buf = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
    return buf;
  }

  // Non-ASCII: worst case 4 bytes per JS code unit.
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

  // subarray() avoids a second allocation. The view's .byteLength is correct;
  // only .buffer.byteLength is over-allocated (4× worst-case). No callers
  // access .buffer directly on encodeUtf8 results.
  return buf.subarray(0, pos);
}

/**
 * Decode a Uint8Array of UTF-8 bytes to a JS string.
 * Invalid sequences are replaced with U+FFFD (replacement character).
 *
 * In fatal mode, malformed bytes throw TypeError. When skipBom is true, an
 * initial UTF-8 BOM is omitted from the result.
 *
 * ```typescript no_run
 * const text = decodeUtf8(new Uint8Array([104, 105]));
 * text; // "hi"
 * ```
 *
 * @param {Uint8Array} bytes
 * @param {boolean} [fatal=false]  Throw TypeError on invalid sequences instead of replacing.
 * @param {boolean} [skipBom=true] Strip a leading BOM (U+FEFF) if present.
 * @returns {string}
 */
export function decodeUtf8(bytes: Uint8Array, fatal: boolean = false, skipBom: boolean = true): string {
  // ASCII fast path: HTTP headers, DNS names, and most internal strings are pure
  // ASCII. Scan for any high byte — if none, use String.fromCharCode.apply which
  // converts the entire buffer in one native call instead of 300+ string concats.
  // The BOM check is skipped because U+FEFF is a multi-byte sequence (0xEF 0xBB 0xBF)
  // and would fail the < 0x80 scan, falling through to the slow path.
  if (!fatal && skipBom) {
    let ascii = true;
    for (let k = 0; k < bytes.length; k++) {
      if (bytes[k]! >= 0x80) { ascii = false; break; }
    }
    if (ascii) {
      // fromCharCode.apply handles TypedArrays as array-like. Chunk at 65536 to
      // stay within safe argument-list sizes on all engines.
      if (bytes.length <= 65536) return String.fromCharCode.apply(null, bytes as unknown as number[]);
      let out = '';
      for (let k = 0; k < bytes.length; k += 65536) {
        out += String.fromCharCode.apply(null, bytes.subarray(k, k + 65536) as unknown as number[]);
      }
      return out;
    }
  }

  let str = '';
  let i = 0;
  let first = true;

  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let seqLen: number;

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

    if (seqLen >= 3 && i + 1 < bytes.length) {
      const b1 = bytes[i + 1]!;
      const invalidSecond =
        (b1 & 0xC0) === 0x80 && (
          (b0 === 0xE0 && b1 < 0xA0) ||
          (b0 === 0xED && b1 > 0x9F) ||
          (b0 === 0xF0 && b1 < 0x90) ||
          (b0 === 0xF4 && b1 > 0x8F)
        );
      if (invalidSecond) {
        if (fatal) throw new TypeError(`TextDecoder: invalid byte 0x${b1.toString(16)} at index ${i + 1}`);
        str += '\uFFFD';
        i++;
        continue;
      }
    }

    // Validate and accumulate continuation bytes.
    let valid = true;
    let missingContinuation = false;
    let invalidContinuationOffset = 1;
    for (let j = 1; j < seqLen; j++) {
      if (i + j >= bytes.length) {
        missingContinuation = true;
        valid = false;
        break;
      }
      if ((bytes[i + j]! & 0xC0) !== 0x80) {
        invalidContinuationOffset = j;
        valid = false;
        break;
      }
      cp = (cp << 6) | (bytes[i + j]! & 0x3F);
    }

    if (!valid) {
      if (fatal) throw new TypeError(`TextDecoder: incomplete sequence at index ${i}`);
      str += '\uFFFD';
      i += missingContinuation ? bytes.length - i : invalidContinuationOffset;
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

function decodeUtf16(
  bytes: Uint8Array,
  littleEndian: boolean,
  fatal: boolean = false,
  skipBom: boolean = true,
  streaming: boolean = false,
  pendingLead: number | null = null,
): { text: string; pendingLead: number | null } {
  let out = '';
  let i = 0;
  let first = true;

  const readUnit = (offset: number): number => {
    return littleEndian
      ? bytes[offset]! | (bytes[offset + 1]! << 8)
      : (bytes[offset]! << 8) | bytes[offset + 1]!;
  };

  if (pendingLead !== null) {
    if (bytes.length < 2) {
      if (streaming) return { text: out, pendingLead };
      if (fatal) throw new TypeError('TextDecoder: incomplete UTF-16 surrogate pair at end of stream');
      return { text: '\uFFFD', pendingLead: null };
    }

    const trail = readUnit(0);
    if (trail >= 0xDC00 && trail <= 0xDFFF) {
      out += String.fromCharCode(pendingLead, trail);
      i = 2;
    } else {
      if (fatal) throw new TypeError('TextDecoder: invalid UTF-16 surrogate at start of stream');
      out += '\uFFFD';
    }
    pendingLead = null;
  }

  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      if (fatal) throw new TypeError(`TextDecoder: incomplete UTF-16 code unit at index ${i}`);
      out += '\uFFFD';
      return { text: out, pendingLead: null };
    }

    const unit = readUnit(i);
    i += 2;

    if (first && skipBom && unit === 0xFEFF) {
      first = false;
      continue;
    }
    first = false;

    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (i + 1 >= bytes.length) {
        if (streaming) return { text: out, pendingLead: unit };
        if (fatal) throw new TypeError(`TextDecoder: incomplete UTF-16 surrogate pair at index ${i - 2}`);
        out += '\uFFFD';
        return { text: out, pendingLead: null };
      }

      const trail = readUnit(i);
      if (trail >= 0xDC00 && trail <= 0xDFFF) {
        i += 2;
        out += String.fromCharCode(unit, trail);
      } else {
        if (fatal) throw new TypeError(`TextDecoder: invalid UTF-16 surrogate at index ${i - 2}`);
        out += '\uFFFD';
      }
      continue;
    }

    if (unit >= 0xDC00 && unit <= 0xDFFF) {
      if (fatal) throw new TypeError(`TextDecoder: invalid UTF-16 surrogate at index ${i - 2}`);
      out += '\uFFFD';
      continue;
    }

    out += String.fromCharCode(unit);
  }

  return { text: out, pendingLead };
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
 * ```typescript no_run
 * btoa('hi'); // "aGk="
 * ```
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
 * ASCII whitespace is ignored. Missing padding is accepted for valid 2- and
 * 3-character remainders, but length % 4 == 1 is rejected.
 *
 * ```typescript no_run
 * atob('aGk='); // "hi"
 * ```
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
    const v0 = BASE64_DECODE[str.charCodeAt(i)]!;
    const v1 = BASE64_DECODE[str.charCodeAt(i + 1)]!;
    const v2 = BASE64_DECODE[str.charCodeAt(i + 2)]!;
    const v3 = BASE64_DECODE[str.charCodeAt(i + 3)]!;

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
// Blob clone helper registration (avoids circular import with blob.ts)
// ---------------------------------------------------------------------------

// blob.ts calls _registerBlobCloneHelper() after its classes are defined.
// _clone() uses these to clone Blob and File instances synchronously via the
// internal byte buffer, without needing to import from blob.ts directly.
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

/**
 * Register Blob/File clone helpers without creating an import cycle.
 *
 * blob.ts calls this after defining Blob and File. structuredClone() then uses
 * the helper to synchronously clone Blob and File instances by byte-copying
 * their internal storage.
 *
 * ```typescript no_run
 * _registerBlobCloneHelper({
 *   getBlobBytes: () => new Uint8Array(),
 *   BlobCtor: Blob as any,
 *   FileCtor: File as any,
 *   isBlob: () => false,
 *   isFile: () => false,
 *   getName: () => '',
 *   getLastModified: () => 0,
 * });
 * ```
 *
 * @internal
 */
export function _registerBlobCloneHelper(helper: BlobCloneHelper): void {
  _blobCloneHelper = helper;
}

type CryptoKeyCloneHelper = {
  isCryptoKey: (v: object) => boolean;
  cloneCryptoKey: (v: object) => object;
};
let _cryptoKeyCloneHelper: CryptoKeyCloneHelper | null = null;

/**
 * Register CryptoKey clone helpers without importing crypto.ts from this
 * module. CryptoKey material stays encapsulated in the crypto module.
 *
 * @internal
 */
export function _registerCryptoKeyCloneHelper(helper: CryptoKeyCloneHelper): void {
  _cryptoKeyCloneHelper = helper;
}

const _DOM_EXCEPTION_CODES: Record<string, number> = {
  IndexSizeError: 1,
  DOMStringSizeError: 2,
  HierarchyRequestError: 3,
  WrongDocumentError: 4,
  InvalidCharacterError: 5,
  NoDataAllowedError: 6,
  NoModificationAllowedError: 7,
  NotFoundError: 8,
  NotSupportedError: 9,
  InUseAttributeError: 10,
  InvalidStateError: 11,
  SyntaxError: 12,
  InvalidModificationError: 13,
  NamespaceError: 14,
  InvalidAccessError: 15,
  ValidationError: 16,
  TypeMismatchError: 17,
  SecurityError: 18,
  NetworkError: 19,
  AbortError: 20,
  URLMismatchError: 21,
  QuotaExceededError: 22,
  TimeoutError: 23,
  InvalidNodeTypeError: 24,
  DataCloneError: 25,
};

/**
 * Web DOMException class used by platform APIs and structuredClone errors.
 *
 * The `name`, `message`, and legacy numeric `code` properties follow the DOM
 * standard names used by browsers. Unknown names receive code 0.
 */
export class DOMException extends Error {
  #name: string;

  constructor(message = '', name = 'Error') {
    super(String(message));
    this.#name = String(name);
  }

  get [Symbol.toStringTag]() { return 'DOMException'; }
  get name() { return this.#name; }
  get code() { return _DOM_EXCEPTION_CODES[this.#name] ?? 0; }
}

/**
 * Web quota exceeded error.
 *
 * Some web APIs throw this specialized DOMException subclass so tests and
 * userland code can check the constructor as well as the `QuotaExceededError`
 * name and legacy code.
 *
 * ```ts no_run
 * throw new QuotaExceededError('storage quota exceeded');
 * ```
 */
export class QuotaExceededError extends DOMException {
  readonly requested: number | null;
  readonly quota: number | null;

  /**
   * Create a quota exceeded error.
   *
   * `requested` and `quota` default to `null`, matching APIs that expose no
   * numeric quota details.
   *
   * ```ts no_run
   * const err = new QuotaExceededError('too much data', { requested: null, quota: null });
   * ```
   */
  constructor(message = '', options: { requested?: number | null; quota?: number | null } = {}) {
    super(message, 'QuotaExceededError');
    this.requested = options.requested ?? null;
    this.quota = options.quota ?? null;
  }
}

const _DOM_EXCEPTION_LEGACY_CONSTANTS: Record<string, number> = {
  INDEX_SIZE_ERR: 1,
  DOMSTRING_SIZE_ERR: 2,
  HIERARCHY_REQUEST_ERR: 3,
  WRONG_DOCUMENT_ERR: 4,
  INVALID_CHARACTER_ERR: 5,
  NO_DATA_ALLOWED_ERR: 6,
  NO_MODIFICATION_ALLOWED_ERR: 7,
  NOT_FOUND_ERR: 8,
  NOT_SUPPORTED_ERR: 9,
  INUSE_ATTRIBUTE_ERR: 10,
  INVALID_STATE_ERR: 11,
  SYNTAX_ERR: 12,
  INVALID_MODIFICATION_ERR: 13,
  NAMESPACE_ERR: 14,
  INVALID_ACCESS_ERR: 15,
  VALIDATION_ERR: 16,
  TYPE_MISMATCH_ERR: 17,
  SECURITY_ERR: 18,
  NETWORK_ERR: 19,
  ABORT_ERR: 20,
  URL_MISMATCH_ERR: 21,
  QUOTA_EXCEEDED_ERR: 22,
  TIMEOUT_ERR: 23,
  INVALID_NODE_TYPE_ERR: 24,
  DATA_CLONE_ERR: 25,
};

for (const [name, value] of Object.entries(_DOM_EXCEPTION_LEGACY_CONSTANTS)) {
  Object.defineProperty(DOMException, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(DOMException.prototype, name, {
    enumerable: true,
    configurable: true,
    get() {
      if (!(this instanceof DOMException)) {
        throw new TypeError('DOMException legacy constant getter called on incompatible receiver');
      }
      return value;
    },
  });
}

function _dataCloneError(message: string): DOMException {
  return new DOMException(message, 'DataCloneError');
}

// ---------------------------------------------------------------------------
// structuredClone
// ---------------------------------------------------------------------------

/**
 * Deep-clone a value using the structured clone algorithm (subset).
 *
 * Fino implements a documented subset of the HTML
 * [structured clone algorithm](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal).
 * Cycles are detected and reproduced correctly.
 *
 * ## structured-clone support matrix
 *
 * | Category | Global `structuredClone()` support |
 * | --- | --- |
 * | Primitives | `undefined`, `null`, boolean, number, string, and `bigint` clone by value. Symbols throw `DataCloneError`. |
 * | Plain objects | Plain objects and null-prototype objects clone recursively. Objects with custom prototypes throw `DataCloneError`. |
 * | Arrays | Dense and sparse arrays clone recursively while preserving holes. |
 * | Dates and regexps | `Date` clones preserve time values. `RegExp` clones preserve source and flags, with `lastIndex` reset. |
 * | Wrapper objects | `Boolean`, `Number`, and `String` wrapper objects clone with their primitive value. |
 * | Maps and sets | `Map` and `Set` clone entries recursively, including cyclic references. |
 * | Errors | `Error`, `AggregateError`, and `DOMException` clone their supported name/message/cause/error details. |
 * | URL types | `URL` and `URLSearchParams` throw `DataCloneError`. |
 * | File API | `Blob` and `File` clone by byte-copying their internal storage. |
 * | Crypto | `CryptoKey` clones through the WebCrypto module's internal key-material helper. |
 * | Binary data | `ArrayBuffer`, typed arrays, `BigInt64Array`, `BigUint64Array`, and `DataView` clone with copied backing bytes. |
 * | Cycles | Object, array, map, and set cycles are preserved in the cloned graph. |
 *
 * Transfer lists support only `ArrayBuffer`. Transferred buffers are copied into
 * the clone and then detached with V8's native detach operation, so the source
 * buffer's `byteLength` becomes zero. Supplying the same buffer more than once
 * in the transfer list throws `DataCloneError`.
 *
 * Functions, symbols, weak collections, objects with custom prototypes,
 * streams, direct `MessagePort` values, stream transfer entries, and
 * `MessagePort` transfer entries throw `DataCloneError`.
 *
 * ```typescript no_run
 * const original: any = { nested: new Map([['x', 1]]) };
 * original.self = original;
 * const copy = structuredClone(original);
 * copy.self === copy; // true
 * ```
 */
export function structuredClone<T>(value: T, options?: { transfer?: ArrayBuffer[] }): T {
  return _structuredCloneWithTransferMap(value, options);
}

/**
 * Clone using the same implementation as global `structuredClone()`, with an
 * optional object substitution map for internal message-transfer algorithms.
 *
 * The transfer map is intentionally not exposed on `globalThis.structuredClone`.
 * It lets `MessagePort.postMessage()` replace transferred ports inside the
 * message graph while keeping direct global `MessagePort` cloning unsupported.
 *
 * @internal
 */
export function _structuredCloneWithTransferMap<T>(
  value: T,
  options?: { transfer?: ArrayBuffer[]; transferMap?: WeakMap<object, unknown> },
): T {
  const transferList = options?.transfer;
  const transferSet = transferList ? new Set<ArrayBuffer>(transferList) : null;
  if (transferList) {
    const seenTransfers = new Set<ArrayBuffer>();
    for (const buf of transferList) {
      if (!(buf instanceof ArrayBuffer)) {
        throw _dataCloneError('structuredClone: transfer list only supports ArrayBuffer values');
      }
      if (seenTransfers.has(buf)) {
        throw _dataCloneError('structuredClone: duplicate ArrayBuffer in transfer list.');
      }
      seenTransfers.add(buf);
    }
  }
  const seen = new WeakMap<object, unknown>();
  const clone = _clone(value, seen, transferSet, options?.transferMap) as T;
  if (transferSet) {
    for (const buf of transferSet) {
      _detachArrayBuffer(buf);
    }
  }
  return clone;
}

function _clone(
  value: unknown,
  seen: WeakMap<object, unknown>,
  transferSet: Set<ArrayBuffer> | null = null,
  transferMap?: WeakMap<object, unknown>,
): unknown {
  // Primitives
  if (value === null || typeof value !== 'object' && typeof value !== 'function') {
    if (typeof value === 'symbol') {
      throw _dataCloneError('structuredClone: Symbol values cannot be cloned.');
    }
    return value;
  }

  // Functions
  if (typeof value === 'function') {
    throw _dataCloneError('structuredClone: function values cannot be cloned.');
  }

  if (transferMap?.has(value)) return transferMap.get(value);

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

  if (value instanceof URL) {
    throw _dataCloneError('structuredClone: URL values cannot be cloned.');
  }

  if (value instanceof URLSearchParams) {
    throw _dataCloneError('structuredClone: URLSearchParams values cannot be cloned.');
  }

  if (value instanceof DOMException) {
    const clone = new DOMException(value.message, value.name);
    if (value.stack) clone.stack = value.stack;
    seen.set(value, clone);
    return clone;
  }

  if (_cryptoKeyCloneHelper && _cryptoKeyCloneHelper.isCryptoKey(value)) {
    const clone = _cryptoKeyCloneHelper.cloneCryptoKey(value);
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

  // AggregateError needs constructor arguments that differ from ordinary Error.
  if (value instanceof Error && (value as any).constructor?.name === 'AggregateError' && Array.isArray((value as any).errors)) {
    const clone = new AggregateError([], value.message);
    clone.stack = value.stack;
    if (value.name !== clone.name) clone.name = value.name;
    seen.set(value, clone);
    (clone as any).errors = _clone((value as any).errors, seen, transferSet, transferMap);
    if ('cause' in value) (clone as any).cause = _clone((value as any).cause, seen, transferSet, transferMap);
    return clone;
  }

  // Error
  if (value instanceof Error) {
    const clone = new (value as any).constructor(value.message);
    clone.stack = value.stack;
    if (value.name !== clone.name) clone.name = value.name;
    if ('cause' in value) (clone as any).cause = _clone((value as any).cause, seen, transferSet, transferMap);
    seen.set(value, clone);
    return clone;
  }

  // Map
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [k, v] of value) {
      clone.set(_clone(k, seen, transferSet, transferMap), _clone(v, seen, transferSet, transferMap));
    }
    return clone;
  }

  // Set
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    for (const v of value) {
      clone.add(_clone(v, seen, transferSet, transferMap));
    }
    return clone;
  }

  // WeakMap / WeakSet — not cloneable
  if (value instanceof WeakMap || value instanceof WeakSet) {
    throw _dataCloneError('structuredClone: WeakMap/WeakSet values cannot be cloned.');
  }

  // Array
  if (Array.isArray(value)) {
    const clone = new Array(value.length);
    seen.set(value, clone);
    for (let i = 0; i < value.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, i)) {
        clone[i] = _clone(value[i], seen, transferSet, transferMap);
      }
    }
    return clone;
  }

  // Plain object: prototype must be null, or be itself null-prototyped (i.e.
  // Object.prototype-like — handles cross-realm plain objects where the proto
  // is a different context's Object.prototype, not === the current one).
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype && Object.getPrototypeOf(proto) !== null) {
    throw _dataCloneError('structuredClone: object with non-plain prototype cannot be cloned.');
  }
  // When cloning cross-realm objects, map their proto to the local Object.prototype
  // so the clone is a proper plain object in the current realm.
  const cloneProto = proto === null ? null : Object.prototype;
  const clone = Object.create(cloneProto);
  seen.set(value, clone);
  for (const key of Object.keys(value)) {
    (clone as any)[key] = _clone((value as any)[key], seen, transferSet, transferMap);
  }
  return clone;
}

// ---------------------------------------------------------------------------
// TextEncoder
// ---------------------------------------------------------------------------

/**
 * WHATWG TextEncoder — always UTF-8.
 * https://encoding.spec.whatwg.org/#interface-textencoder
 *
 * ```typescript no_run
 * const encoder = new TextEncoder();
 * encoder.encode('hello');
 * ```
 */
export class TextEncoder {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new TextEncoder()); // "[object TextEncoder]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'TextEncoder'; }

  /**
   * Encoding label for this encoder.
   *
   * TextEncoder only supports UTF-8, so this always returns "utf-8".
   *
   * ```typescript no_run
   * new TextEncoder().encoding; // "utf-8"
   * ```
   *
   * @returns {"utf-8"}
   */
  get encoding() { return 'utf-8'; }

  /**
   * Encode `input` to a new Uint8Array.
   *
   * Input is string-coerced and lone surrogates are encoded as U+FFFD.
   *
   * ```typescript no_run
   * const bytes = new TextEncoder().encode('ok');
   * bytes[0]; // 111
   * ```
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
   * Returns the number of UTF-16 code units read and UTF-8 bytes written.
   * Stops before writing a partial UTF-8 sequence.
   *
   * ```typescript no_run
   * const dest = new Uint8Array(2);
   * const result = new TextEncoder().encodeInto('abc', dest);
   * result.written; // 2
   * ```
   *
   * @param {string} input
   * @param {Uint8Array} destination
   * @returns {{ read: number, written: number }}
   */
  encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
    if (!(destination instanceof Uint8Array)) {
      throw new TypeError('TextEncoder.encodeInto: destination must be a Uint8Array');
    }

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

const UTF16LE_LABELS = new Set(['utf-16', 'utf-16le']);
const UTF16BE_LABELS = new Set(['utf-16be']);

type TextDecoderEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

function _trimAsciiWhitespace(label: string): string {
  let start = 0;
  let end = label.length;

  while (start < end) {
    const c = label.charCodeAt(start);
    if (c !== 0x09 && c !== 0x0A && c !== 0x0C && c !== 0x0D && c !== 0x20) break;
    start++;
  }

  while (end > start) {
    const c = label.charCodeAt(end - 1);
    if (c !== 0x09 && c !== 0x0A && c !== 0x0C && c !== 0x0D && c !== 0x20) break;
    end--;
  }

  return label.slice(start, end);
}

function _normaliseDecoderLabel(label: string): TextDecoderEncoding | null {
  const normalised = _trimAsciiWhitespace(String(label)).toLowerCase();
  if (UTF8_LABELS.has(normalised)) return 'utf-8';
  if (UTF16LE_LABELS.has(normalised)) return 'utf-16le';
  if (UTF16BE_LABELS.has(normalised)) return 'utf-16be';
  return null;
}

/**
 * WHATWG TextDecoder — UTF-8 only.
 * https://encoding.spec.whatwg.org/#interface-textdecoder
 *
 * ```typescript no_run
 * const decoder = new TextDecoder('utf-8', { fatal: false });
 * decoder.decode(new Uint8Array([104, 105])); // "hi"
 * ```
 */
// Scan the end of `bytes` for an incomplete multi-byte UTF-8 sequence.
// Returns the byte offset at which the incomplete sequence starts,
// or bytes.length if all sequences are complete.
function _findIncompleteEnd(bytes: Uint8Array): number {
  const len = bytes.length;
  // Check possible sequence starts near the end. Only buffer prefixes that can
  // still become valid UTF-8; invalid leading bytes must be emitted now.
  for (let start = Math.max(0, len - 3); start < len; start++) {
    const b = bytes[start]!;
    let seqLen = 0;
    if (b >= 0xC2 && b <= 0xDF) seqLen = 2;
    else if (b >= 0xE0 && b <= 0xEF) seqLen = 3;
    else if (b >= 0xF0 && b <= 0xF4) seqLen = 4;
    else continue;

    const available = len - start;
    if (available >= seqLen) continue;

    let validPrefix = true;
    for (let offset = 1; offset < available; offset++) {
      const cont = bytes[start + offset]!;
      if ((cont & 0xC0) !== 0x80) {
        validPrefix = false;
        break;
      }
      if (offset === 1) {
        if (b === 0xE0 && cont < 0xA0) validPrefix = false;
        else if (b === 0xED && cont > 0x9F) validPrefix = false;
        else if (b === 0xF0 && cont < 0x90) validPrefix = false;
        else if (b === 0xF4 && cont > 0x8F) validPrefix = false;
      }
    }
    if (validPrefix) return start;
  }
  return len;
}

/**
 * WHATWG TextDecoder facade for UTF-8 decoding with optional fatal mode and
 * BOM handling.
 *
 * Only UTF-8 labels are accepted. Streaming decode buffers incomplete trailing
 * UTF-8 sequences across calls.
 *
 * ```typescript no_run
 * const decoder = new TextDecoder();
 * decoder.decode(new Uint8Array([0x68, 0x69])); // "hi"
 * ```
 */
export class TextDecoder {
  /**
   * Private property `#encoding` used by `TextDecoder`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #encoding = undefined;
   *
   *   readInternalState() {
   *     return this.#encoding;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #encoding: TextDecoderEncoding;
  /**
   * Private property `#fatal` used by `TextDecoder`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fatal = undefined;
   *
   *   readInternalState() {
   *     return this.#fatal;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fatal: boolean;
  /**
   * Private property `#ignoreBOM` used by `TextDecoder`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ignoreBOM = undefined;
   *
   *   readInternalState() {
   *     return this.#ignoreBOM;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #ignoreBOM: boolean;
  /**
   * Private property `#pending` used by `TextDecoder`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #pending = undefined;
   *
   *   readInternalState() {
   *     return this.#pending;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #pending: Uint8Array | null = null;
  #pendingUtf16Lead: number | null = null;
  // Tracks whether the BOM at the stream start has been seen/consumed. Resets
  // after each non-streaming decode() call per WHATWG spec.
  /**
   * Private property `#bomHandled` used by `TextDecoder`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bomHandled = undefined;
   *
   *   readInternalState() {
   *     return this.#bomHandled;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bomHandled: boolean = false;

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(new TextDecoder()); // "[object TextDecoder]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'TextDecoder'; }

  /**
   * Create a UTF-8 TextDecoder.
   *
   * Non-UTF-8 labels throw RangeError. fatal controls malformed byte handling,
   * and ignoreBOM preserves an initial BOM when true.
   *
   * ```typescript no_run
   * const decoder = new TextDecoder('utf8', { fatal: true });
   * decoder.encoding; // "utf-8"
   * ```
   *
   * @param {string} [label='utf-8']
   * @param {{ fatal?: boolean, ignoreBOM?: boolean }} [options]
   */
  constructor(label: string = 'utf-8', options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    const encoding = _normaliseDecoderLabel(label);
    if (encoding === null) {
      throw new RangeError(`TextDecoder: unsupported encoding '${label}'`);
    }
    this.#encoding  = encoding;
    this.#fatal     = Boolean(options.fatal);
    this.#ignoreBOM = Boolean(options.ignoreBOM);
  }

  /**
   * Normalized encoding name.
   *
   * ```typescript no_run
   * new TextDecoder('unicode-1-1-utf-8').encoding; // "utf-8"
   * ```
   *
   * @returns {"utf-8"}
   */
  get encoding()  { return this.#encoding; }

  /**
   * Whether malformed UTF-8 throws TypeError instead of replacement.
   *
   * ```typescript no_run
   * new TextDecoder('utf-8', { fatal: true }).fatal; // true
   * ```
   *
   * @returns {boolean}
   */
  get fatal()     { return this.#fatal; }

  /**
   * Whether an initial BOM is preserved in decoded output.
   *
   * false means the leading BOM is skipped, matching browser defaults.
   *
   * ```typescript no_run
   * new TextDecoder('utf-8', { ignoreBOM: true }).ignoreBOM; // true
   * ```
   *
   * @returns {boolean}
   */
  get ignoreBOM() { return this.#ignoreBOM; }

  /**
   * Decode `input` to a string.
   *
   * @param {ArrayBuffer|ArrayBufferView} [input]
   * @param {{ stream?: boolean }} [options]
   *   When `stream: true`, incomplete multi-byte sequences at the end are
   *   buffered and prepended to the next call, enabling chunk-by-chunk decoding.
   *
   * ```typescript no_run
   * const decoder = new TextDecoder();
   * decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true }); // ""
   * decoder.decode(new Uint8Array([0xac])).length; // 1
   * ```
   *
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
      let completeEnd = bytes.byteLength;
      if (this.#encoding === 'utf-8') {
        completeEnd = _findIncompleteEnd(bytes);
      } else if (bytes.byteLength % 2 === 1) {
        completeEnd = bytes.byteLength - 1;
      }
      if (completeEnd < bytes.byteLength) {
        this.#pending = bytes.slice(completeEnd);
        bytes = bytes.slice(0, completeEnd);
      }
    }

    if (bytes.byteLength === 0) {
      if (!streaming) {
        if (this.#pendingUtf16Lead !== null) {
          if (this.#fatal) throw new TypeError('TextDecoder: incomplete UTF-16 surrogate pair at end of stream');
          this.#pendingUtf16Lead = null;
          this.#bomHandled = false;
          return '\uFFFD';
        }
        this.#bomHandled = false;
      }
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

    if (this.#encoding === 'utf-16le' || this.#encoding === 'utf-16be') {
      try {
        const result = decodeUtf16(
          bytes,
          this.#encoding === 'utf-16le',
          this.#fatal,
          shouldStripBom,
          streaming,
          this.#pendingUtf16Lead,
        );
        this.#pendingUtf16Lead = result.pendingLead;
        return result.text;
      } catch (err) {
        this.#pending = null;
        this.#pendingUtf16Lead = null;
        throw err;
      }
    }
    try {
      return decodeUtf8(bytes, this.#fatal, shouldStripBom);
    } catch (err) {
      this.#pending = null;
      throw err;
    }
  }
}
