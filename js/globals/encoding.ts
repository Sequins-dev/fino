/**
 * TextEncoder / TextDecoder, base64, DOMException, and structuredClone globals.
 *
 * This module implements the encoding-adjacent web globals that userland code
 * expects to find on `globalThis`: `TextEncoder` and `TextDecoder` for
 * text/byte conversion, `btoa` and `atob` for base64, `DOMException` and
 * `QuotaExceededError` for platform-style errors, and `structuredClone` for
 * deep copies. Everything here is installed globally at startup, so no import
 * is needed to use any of it.
 *
 * `TextEncoder.encoding` is always `"utf-8"`. `TextDecoder` accepts UTF-8
 * label aliases plus the UTF-16 labels (`utf-16`, `utf-16le`, `utf-16be`) and
 * rejects every other encoding with a RangeError. `stream: true` buffers
 * incomplete trailing multi-byte sequences and prepends them to the next
 * `decode()` call.
 *
 *
 * ## Why no legacy encodings?
 *
 * The WHATWG Encoding Standard requires implementations to support all
 * legacy encodings (Latin-1, Shift-JIS, etc.) for decoding. We intentionally
 * limit this to UTF-8 and UTF-16. The vast majority of modern text is UTF-8,
 * and adding full encoding support would require a large lookup table or a C
 * library dependency (libiconv). Contributors who need legacy encoding support
 * can import a pure-JS library via the module loader.
 *
 *
 * ## Encoder implementation
 *
 * `TextEncoder.encode()` processes each JS code unit. JS strings are UTF-16
 * internally, so surrogate pairs (U+D800..U+DBFF followed by U+DC00..U+DFFF)
 * are recombined into a 32-bit code point before encoding as a 4-byte UTF-8
 * sequence. Lone surrogates are encoded as U+FFFD, matching web behavior.
 *
 *
 * ## Decoder implementation
 *
 * `TextDecoder.decode()` validates each multi-byte sequence against three
 * classes of errors:
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
 *
 * ## structuredClone
 *
 * `structuredClone()` deep-copies a value using V8's native structured
 * serialization — the same machinery realm messaging uses — and falls back to
 * a JS clone pass only for platform objects V8 cannot reconstruct on its own
 * (`Blob`, `File`, `CryptoKey`, `DOMException`). See the function docs for the
 * full support matrix and transfer semantics.
 *
 * ## Example
 *
 * ```ts no_run
 * const bytes = new TextEncoder().encode('hello');
 * const text = new TextDecoder().decode(bytes); // "hello"
 *
 * const b64 = btoa('hi');  // "aGk="
 * const raw = atob(b64);   // "hi"
 *
 * const copy = structuredClone({ nested: new Map([['x', 1]]) });
 * ```
 *
 * WHATWG Encoding Standard: https://encoding.spec.whatwg.org/
 * base64 utilities and structuredClone: https://html.spec.whatwg.org/multipage/
 * DOMException: https://webidl.spec.whatwg.org/#idl-DOMException
 */
import {
  serialize as _serialize,
  deserialize as _deserialize,
  detachArrayBuffer as _detachArrayBuffer,
} from 'internal:serializer';
import { encodeUtf8, decodeUtf8 } from 'internal:encoding';
function decodeUtf16(
  bytes: Uint8Array,
  littleEndian: boolean,
  fatal: boolean = false,
  skipBom: boolean = true,
  streaming: boolean = false,
  pendingLead: number | null = null,
): {
  text: string;
  pendingLead: number | null;
} {
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
      if (streaming)
        return {
          text: out,
          pendingLead,
        };
      if (fatal)
        throw new TypeError('TextDecoder: incomplete UTF-16 surrogate pair at end of stream');
      return {
        text: '�',
        pendingLead: null,
      };
    }
    const trail = readUnit(0);
    if (trail >= 56320 && trail <= 57343) {
      out += String.fromCharCode(pendingLead, trail);
      i = 2;
    } else {
      if (fatal) throw new TypeError('TextDecoder: invalid UTF-16 surrogate at start of stream');
      out += '�';
    }
    pendingLead = null;
  }
  while (i < bytes.length) {
    if (i + 1 >= bytes.length) {
      if (fatal) throw new TypeError(`TextDecoder: incomplete UTF-16 code unit at index ${i}`);
      out += '�';
      return {
        text: out,
        pendingLead: null,
      };
    }
    const unit = readUnit(i);
    i += 2;
    if (first && skipBom && unit === 65279) {
      first = false;
      continue;
    }
    first = false;
    if (unit >= 55296 && unit <= 56319) {
      if (i + 1 >= bytes.length) {
        if (streaming)
          return {
            text: out,
            pendingLead: unit,
          };
        if (fatal)
          throw new TypeError(`TextDecoder: incomplete UTF-16 surrogate pair at index ${i - 2}`);
        out += '�';
        return {
          text: out,
          pendingLead: null,
        };
      }
      const trail = readUnit(i);
      if (trail >= 56320 && trail <= 57343) {
        i += 2;
        out += String.fromCharCode(unit, trail);
      } else {
        if (fatal) throw new TypeError(`TextDecoder: invalid UTF-16 surrogate at index ${i - 2}`);
        out += '�';
      }
      continue;
    }
    if (unit >= 56320 && unit <= 57343) {
      if (fatal) throw new TypeError(`TextDecoder: invalid UTF-16 surrogate at index ${i - 2}`);
      out += '�';
      continue;
    }
    out += String.fromCharCode(unit);
  }
  return {
    text: out,
    pendingLead,
  };
}
// ---------------------------------------------------------------------------
// Base64 — btoa / atob
// ---------------------------------------------------------------------------
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Reverse lookup: char code → 6-bit value (or -1 for invalid, -2 for '=').
const BASE64_DECODE = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) BASE64_DECODE[BASE64_CHARS.charCodeAt(i)] = i;
BASE64_DECODE[61] = -2;
/**
 * Encode a Latin-1 binary string to base64 (web `btoa`).
 *
 * Each character of the input is treated as one byte, so the input must be a
 * "binary string" whose character codes are all in [0, 255]. Throws a
 * TypeError if any character code is greater than 255 — encode real text to
 * UTF-8 bytes with `TextEncoder` first if it may contain non-Latin-1
 * characters. The output is standard base64 with `=` padding.
 *
 * ```ts no_run
 * btoa('hi'); // "aGk="
 *
 * // Base64-encode arbitrary bytes:
 * const bytes = new TextEncoder().encode('héllo');
 * const b64 = btoa(String.fromCharCode(...bytes));
 * ```
 */
export function btoa(data: string): string {
  const str = String(data);
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 255) {
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
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += rem > 1 ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += rem > 2 ? BASE64_CHARS[b2 & 63] : '=';
  }
  return out;
}
/**
 * Decode a base64 string to a Latin-1 binary string (web `atob`).
 *
 * Each character of the result holds one decoded byte. ASCII whitespace
 * (space, tab, LF, CR, FF) in the input is ignored, and missing `=` padding
 * is accepted for valid 2- and 3-character remainders. Throws a TypeError on
 * any other malformed input: characters outside the base64 alphabet,
 * misplaced padding, or a whitespace-stripped length of `% 4 == 1` (which no
 * padding can make valid).
 *
 * ```ts no_run
 * atob('aGk='); // "hi"
 * atob('aGk');  // "hi" — missing padding accepted
 *
 * // Recover bytes from base64:
 * const bytes = Uint8Array.from(atob('aGk='), (c) => c.charCodeAt(0));
 * ```
 */
export function atob(encodedData: string): string {
  // Strip ASCII whitespace per the spec (spaces, tabs, newlines, CR, FF).
  let str = String(encodedData).replace(/[\t\n\f\r ]/g, '');
  // Per spec, length % 4 == 1 is always invalid. Pad 2- and 3-remainder
  // strings so the 4-byte loop below works without requiring explicit padding.
  const rem = str.length % 4;
  if (rem === 1) {
    throw new TypeError('atob: The string to be decoded is not correctly encoded.');
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
      throw new TypeError('atob: The string to be decoded is not correctly encoded.');
    }
    out += String.fromCharCode((v0 << 2) | (v1 >> 4));
    if (v2 !== -2) out += String.fromCharCode(((v1 & 15) << 4) | (v2 >> 2));
    if (v3 !== -2) out += String.fromCharCode(((v2 & 3) << 6) | v3);
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
  BlobCtor: new (
    parts: Iterable<unknown>,
    opts?: {
      type?: string;
    },
  ) => object;
  FileCtor: new (
    parts: Iterable<unknown>,
    name: string,
    opts?: {
      type?: string;
      lastModified?: number;
    },
  ) => object;
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
 * ```ts no_run
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
 * module. CryptoKey material stays encapsulated in the crypto module;
 * structuredClone() only calls `isCryptoKey` to detect keys and
 * `cloneCryptoKey` to copy one.
 *
 * ```ts no_run
 * _registerCryptoKeyCloneHelper({
 *   isCryptoKey: (v) => v instanceof CryptoKey,
 *   cloneCryptoKey: (v) => cloneKeyInternals(v),
 * });
 * ```
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
 * standard names used by browsers. Unknown names receive code 0. The legacy
 * `INDEX_SIZE_ERR`-style numeric constants are defined on both the
 * constructor and the prototype, matching the WebIDL surface.
 *
 * Fino's own APIs throw plain `Error` subclasses; this class exists for
 * web-platform compatibility — primarily `structuredClone()`'s
 * `DataCloneError` — and for userland code that expects the global.
 *
 * ```ts no_run
 * try {
 *   structuredClone(() => {});
 * } catch (err) {
 *   if (err instanceof DOMException && err.name === 'DataCloneError') {
 *     console.log(err.code); // 25
 *   }
 * }
 * ```
 */
export class DOMException extends Error {
  #name: string;
  /**
   * Create a DOMException with a message and a standard error name.
   *
   * Both arguments are string-coerced. `name` defaults to `'Error'` and
   * selects the legacy `code` value when it matches one of the DOM standard
   * error names.
   *
   * ```ts no_run
   * const err = new DOMException('operation was aborted', 'AbortError');
   * ```
   */
  constructor(message = '', name = 'Error') {
    super(String(message));
    this.#name = String(name);
  }
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```ts no_run
   * Object.prototype.toString.call(new DOMException()); // "[object DOMException]"
   * ```
   */
  get [Symbol.toStringTag]() {
    return 'DOMException';
  }
  /**
   * Standard error name supplied at construction, such as `'AbortError'` or
   * `'DataCloneError'`.
   */
  get name() {
    return this.#name;
  }
  /**
   * Legacy numeric code matching `name`, or 0 for names without one.
   *
   * ```ts no_run
   * new DOMException('', 'AbortError').code; // 20
   * new DOMException('', 'SomethingElse').code; // 0
   * ```
   */
  get code() {
    return _DOM_EXCEPTION_CODES[this.#name] ?? 0;
  }
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
  /** Amount the failed operation asked for, or `null` when unknown. */
  readonly requested: number | null;
  /** Quota limit that was exceeded, or `null` when unknown. */
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
  constructor(
    message = '',
    options: {
      requested?: number | null;
      quota?: number | null;
    } = {},
  ) {
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
 * Deep-clone a value using V8's structured serialization machinery.
 *
 * Fino routes ordinary JavaScript values through the runtime's V8
 * `ValueSerializer` / `ValueDeserializer` binding, the same native machinery
 * used by realm messaging. JS-defined platform objects that V8 cannot
 * reconstruct by itself, such as `Blob`, `File`, and `CryptoKey`, are cloned
 * through narrow Fino host-object helpers.
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
 * | File API | `Blob` and `File` clone through Fino host-object helpers. |
 * | Crypto | `CryptoKey` clones through the WebCrypto module's key-material helper. |
 * | Binary data | `ArrayBuffer`, typed arrays, `BigInt64Array`, `BigUint64Array`, and `DataView` clone with copied backing bytes. |
 * | Cycles | Object, array, map, and set cycles are preserved in the cloned graph. |
 *
 * Transfer lists support only `ArrayBuffer`. V8 transfers the backing data into
 * the clone and detaches the source buffer, so the source buffer's `byteLength`
 * becomes zero. Supplying the same buffer more than once in the transfer list
 * throws `DataCloneError`.
 *
 * Functions, symbols, weak collections, objects with custom prototypes,
 * streams, direct `MessagePort` values, stream transfer entries, and
 * `MessagePort` transfer entries throw `DataCloneError`.
 *
 * ```ts no_run
 * const original: any = { nested: new Map([['x', 1]]) };
 * original.self = original;
 * const copy = structuredClone(original);
 * copy.self === copy; // true
 *
 * // Transfer instead of copy — detaches the source buffer:
 * const buf = new ArrayBuffer(1024);
 * const moved = structuredClone(buf, { transfer: [buf] });
 * buf.byteLength; // 0
 * ```
 */
export function structuredClone<T>(
  value: T,
  options?: {
    transfer?: ArrayBuffer[];
  },
): T {
  const transferList = _validateStructuredCloneTransferList(options?.transfer);
  const preflight = _preflightStructuredClone(value, undefined);
  if (preflight.useFallback) {
    return _structuredCloneWithTransferMap(value, {
      transfer: transferList,
    });
  }
  try {
    const chunks = _serialize(value, transferList);
    const main = chunks[0];
    if (!(main instanceof Uint8Array)) {
      throw new Error('structuredClone: serializer returned no payload');
    }
    return _deserialize(main, chunks.slice(1)) as T;
  } catch (err) {
    throw _toDataCloneError(err, 'structuredClone: value cannot be cloned.');
  }
}
/**
 * Clone using Fino's JS host-object fallback, with an optional object
 * substitution map for internal message-transfer algorithms.
 *
 * The transfer map is intentionally not exposed on `globalThis.structuredClone`.
 * It lets `MessagePort.postMessage()` replace transferred ports inside the
 * message graph while keeping direct global `MessagePort` cloning unsupported.
 * Global `structuredClone()` uses V8 serialization first and calls this helper
 * only for JS-defined host objects that need Fino-specific clone hooks.
 *
 * @internal
 */
export function _structuredCloneWithTransferMap<T>(
  value: T,
  options?: {
    transfer?: ArrayBuffer[];
    transferMap?: WeakMap<object, unknown>;
  },
): T {
  const transferList = _validateStructuredCloneTransferList(options?.transfer);
  const transferSet = transferList.length === 0 ? null : new Set<ArrayBuffer>(transferList);
  _preflightStructuredClone(value, options?.transferMap);
  const seen = new WeakMap<object, unknown>();
  const clone = _clone(value, seen, transferSet, options?.transferMap) as T;
  if (transferSet) {
    for (const buf of transferSet) {
      _detachArrayBuffer(buf);
    }
  }
  return clone;
}
function _validateStructuredCloneTransferList(transferList: unknown): ArrayBuffer[] {
  if (transferList === undefined) return [];
  if (!Array.isArray(transferList)) {
    throw _dataCloneError('structuredClone: transfer must be an ArrayBuffer list.');
  }
  const seenTransfers = new Set<ArrayBuffer>();
  const buffers: ArrayBuffer[] = [];
  for (const item of transferList) {
    if (!(item instanceof ArrayBuffer)) {
      throw _dataCloneError('structuredClone: transfer list only supports ArrayBuffer values');
    }
    if (seenTransfers.has(item)) {
      throw _dataCloneError('structuredClone: duplicate ArrayBuffer in transfer list.');
    }
    seenTransfers.add(item);
    buffers.push(item);
  }
  return buffers;
}
function _toDataCloneError(err: unknown, fallbackMessage: string): DOMException {
  if (err instanceof DOMException && err.name === 'DataCloneError') return err;
  const message = err instanceof Error && err.message ? err.message : fallbackMessage;
  return _dataCloneError(message);
}
function _preflightStructuredClone(
  value: unknown,
  transferMap: WeakMap<object, unknown> | undefined,
  seen: WeakSet<object> = new WeakSet(),
): {
  useFallback: boolean;
} {
  if (value === null) return { useFallback: false };
  const type = typeof value;
  if (type === 'symbol') throw _dataCloneError('structuredClone: Symbol values cannot be cloned.');
  if (type === 'function')
    throw _dataCloneError('structuredClone: function values cannot be cloned.');
  if (type !== 'object') return { useFallback: false };
  const object = value as object;
  if (seen.has(object)) return { useFallback: false };
  seen.add(object);
  if (transferMap?.has(object)) return { useFallback: true };
  if (value instanceof URL) throw _dataCloneError('structuredClone: URL values cannot be cloned.');
  if (value instanceof URLSearchParams)
    throw _dataCloneError('structuredClone: URLSearchParams values cannot be cloned.');
  if (value instanceof WeakMap || value instanceof WeakSet) {
    throw _dataCloneError('structuredClone: WeakMap/WeakSet values cannot be cloned.');
  }
  if (_cryptoKeyCloneHelper?.isCryptoKey(object)) return { useFallback: true };
  if (_blobCloneHelper?.isBlob(object)) return { useFallback: true };
  if (value instanceof DOMException) return { useFallback: true };
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Boolean ||
    value instanceof Number ||
    value instanceof String ||
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(value)
  ) {
    return { useFallback: false };
  }
  let useFallback = false;
  const visit = (item: unknown): void => {
    if (_preflightStructuredClone(item, transferMap, seen).useFallback) useFallback = true;
  };
  if (value instanceof Map) {
    for (const [key, item] of value) {
      visit(key);
      visit(item);
    }
    return { useFallback };
  }
  if (value instanceof Set) {
    for (const item of value) visit(item);
    return { useFallback };
  }
  if (value instanceof Error) {
    const constructorName = (value as any).constructor?.name;
    if (constructorName === 'AggregateError') {
      return { useFallback: true };
    }
    if (value.name !== new (value as any).constructor('').name) {
      return { useFallback: true };
    }
    if ('cause' in value) visit((value as any).cause);
    for (const key of Object.keys(value)) visit((value as any)[key]);
    return { useFallback };
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (Object.prototype.hasOwnProperty.call(value, i)) visit(value[i]);
    }
    return { useFallback };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return { useFallback: true };
  if (proto !== null && proto !== Object.prototype && Object.getPrototypeOf(proto) !== null) {
    throw _dataCloneError('structuredClone: object with non-plain prototype cannot be cloned.');
  }
  for (const key of Object.keys(value)) visit((value as any)[key]);
  return { useFallback };
}
function _clone(
  value: unknown,
  seen: WeakMap<object, unknown>,
  transferSet: Set<ArrayBuffer> | null = null,
  transferMap?: WeakMap<object, unknown>,
): unknown {
  // Primitives
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
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
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    seen.set(value, value);
    return value;
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
      ? new h.FileCtor([bytes], h.getName(value), {
          type: (value as any).type,
          lastModified: h.getLastModified(value),
        })
      : new h.BlobCtor([bytes], { type: (value as any).type });
    seen.set(value, blobClone);
    return blobClone;
  }
  // AggregateError needs constructor arguments that differ from ordinary Error.
  if (
    value instanceof Error &&
    (value as any).constructor?.name === 'AggregateError' &&
    Array.isArray((value as any).errors)
  ) {
    const clone = new AggregateError([], value.message);
    clone.stack = value.stack;
    if (value.name !== clone.name) clone.name = value.name;
    seen.set(value, clone);
    (clone as any).errors = _clone((value as any).errors, seen, transferSet, transferMap);
    if ('cause' in value)
      (clone as any).cause = _clone((value as any).cause, seen, transferSet, transferMap);
    return clone;
  }
  // Error
  if (value instanceof Error) {
    const clone = new (value as any).constructor(value.message);
    clone.stack = value.stack;
    if (value.name !== clone.name) clone.name = value.name;
    if ('cause' in value)
      (clone as any).cause = _clone((value as any).cause, seen, transferSet, transferMap);
    seen.set(value, clone);
    return clone;
  }
  // Map
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [k, v] of value) {
      clone.set(
        _clone(k, seen, transferSet, transferMap),
        _clone(v, seen, transferSet, transferMap),
      );
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
 * WHATWG TextEncoder — encodes strings to UTF-8 bytes.
 *
 * Per the spec, `TextEncoder` supports only UTF-8; there is no label
 * argument. The constructor takes no options and instances are stateless, so
 * one shared encoder can serve a whole module. Lone surrogates in the input
 * are replaced with U+FFFD rather than throwing, matching browsers.
 *
 * ```ts no_run
 * const encoder = new TextEncoder();
 * const bytes = encoder.encode('héllo'); // Uint8Array of UTF-8 bytes
 *
 * // Zero-allocation encoding into an existing buffer:
 * const dest = new Uint8Array(64);
 * const { read, written } = encoder.encodeInto('héllo', dest);
 * ```
 *
 * https://encoding.spec.whatwg.org/#interface-textencoder
 */
export class TextEncoder {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```ts no_run
   * Object.prototype.toString.call(new TextEncoder()); // "[object TextEncoder]"
   * ```
   */
  get [Symbol.toStringTag]() {
    return 'TextEncoder';
  }
  /**
   * Encoding label for this encoder.
   *
   * TextEncoder only supports UTF-8, so this always returns `"utf-8"`.
   *
   * ```ts no_run
   * new TextEncoder().encoding; // "utf-8"
   * ```
   */
  get encoding() {
    return 'utf-8';
  }
  /**
   * Encode `input` to a new Uint8Array of UTF-8 bytes.
   *
   * The input is string-coerced and defaults to the empty string. Lone
   * surrogates are encoded as U+FFFD; the method never throws on any string.
   *
   * ```ts no_run
   * const bytes = new TextEncoder().encode('ok');
   * bytes[0]; // 111 ('o')
   * ```
   */
  encode(input: string = ''): Uint8Array {
    return encodeUtf8(String(input));
  }
  /**
   * Encode as much of `input` as fits into `destination` without allocating.
   *
   * Returns `{ read, written }`: `read` is the number of UTF-16 code units
   * consumed (a surrogate pair counts as 2) and `written` is the number of
   * UTF-8 bytes stored. Encoding stops before a character whose full UTF-8
   * sequence would not fit, so `destination` never receives a partial
   * sequence — resume by re-calling with `input.slice(read)`. Throws if
   * `destination` is not a Uint8Array.
   *
   * ```ts no_run
   * const dest = new Uint8Array(2);
   * const result = new TextEncoder().encodeInto('abc', dest);
   * result.read;    // 2
   * result.written; // 2
   * ```
   */
  encodeInto(
    input: string,
    destination: Uint8Array,
  ): {
    read: number;
    written: number;
  } {
    if (!(destination instanceof Uint8Array)) {
      throw new TypeError('TextEncoder.encodeInto: destination must be a Uint8Array');
    }
    let read = 0;
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      let cp = input.charCodeAt(i);
      // Surrogate pair — combine, or replace lone surrogate with U+FFFD.
      if (cp >= 55296 && cp <= 56319) {
        const lo = input.charCodeAt(i + 1);
        if (lo >= 56320 && lo <= 57343) {
          cp = 65536 + ((cp - 55296) << 10) + (lo - 56320);
        } else {
          cp = 65533;
        }
      } else if (cp >= 56320 && cp <= 57343) {
        cp = 65533;
      }
      let seqLen;
      if (cp < 128) seqLen = 1;
      else if (cp < 2048) seqLen = 2;
      else if (cp < 65536) seqLen = 3;
      else seqLen = 4;
      if (written + seqLen > destination.length) break;
      if (seqLen === 1) {
        destination[written++] = cp;
      } else if (seqLen === 2) {
        destination[written++] = 192 | (cp >> 6);
        destination[written++] = 128 | (cp & 63);
      } else if (seqLen === 3) {
        destination[written++] = 224 | (cp >> 12);
        destination[written++] = 128 | ((cp >> 6) & 63);
        destination[written++] = 128 | (cp & 63);
      } else {
        destination[written++] = 240 | (cp >> 18);
        destination[written++] = 128 | ((cp >> 12) & 63);
        destination[written++] = 128 | ((cp >> 6) & 63);
        destination[written++] = 128 | (cp & 63);
        i++;
        read++;
      }
      read++;
      // Advance past the low surrogate if we consumed a pair
      if (cp >= 65536 && seqLen === 4) {
      }
    }
    return {
      read,
      written,
    };
  }
}
// ---------------------------------------------------------------------------
// TextDecoder
// ---------------------------------------------------------------------------
// Recognised UTF-8 label aliases per the WHATWG Encoding spec.
const UTF8_LABELS = new Set([
  'unicode-1-1-utf-8',
  'unicode11utf8',
  'unicode20utf8',
  'utf-8',
  'utf8',
  'x-unicode20utf8',
]);
const UTF16LE_LABELS = new Set(['utf-16', 'utf-16le']);
const UTF16BE_LABELS = new Set(['utf-16be']);
type TextDecoderEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';
function _trimAsciiWhitespace(label: string): string {
  let start = 0;
  let end = label.length;
  while (start < end) {
    const c = label.charCodeAt(start);
    if (c !== 9 && c !== 10 && c !== 12 && c !== 13 && c !== 32) break;
    start++;
  }
  while (end > start) {
    const c = label.charCodeAt(end - 1);
    if (c !== 9 && c !== 10 && c !== 12 && c !== 13 && c !== 32) break;
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
    if (b >= 194 && b <= 223) seqLen = 2;
    else if (b >= 224 && b <= 239) seqLen = 3;
    else if (b >= 240 && b <= 244) seqLen = 4;
    else continue;
    const available = len - start;
    if (available >= seqLen) continue;
    let validPrefix = true;
    for (let offset = 1; offset < available; offset++) {
      const cont = bytes[start + offset]!;
      if ((cont & 192) !== 128) {
        validPrefix = false;
        break;
      }
      if (offset === 1) {
        if (b === 224 && cont < 160) validPrefix = false;
        else if (b === 237 && cont > 159) validPrefix = false;
        else if (b === 240 && cont < 144) validPrefix = false;
        else if (b === 244 && cont > 143) validPrefix = false;
      }
    }
    if (validPrefix) return start;
  }
  return len;
}
/**
 * WHATWG TextDecoder — decodes UTF-8, UTF-16LE, and UTF-16BE bytes to strings.
 *
 * The constructor accepts the UTF-8 label aliases from the WHATWG Encoding
 * spec plus `utf-16`, `utf-16le`, and `utf-16be`; any other label throws a
 * RangeError. Malformed input is replaced with U+FFFD by default, or throws a
 * TypeError when constructed with `fatal: true`. A leading BOM is stripped
 * unless `ignoreBOM: true`.
 *
 * Passing `{ stream: true }` to `decode()` buffers an incomplete trailing
 * multi-byte sequence (or a trailing UTF-16 lead surrogate) instead of
 * replacing it, and prepends the buffered bytes to the next call — so a byte
 * stream can be decoded chunk by chunk without splitting characters. A
 * decoder used for streaming is stateful; use one instance per stream.
 *
 * ```ts no_run
 * new TextDecoder().decode(new Uint8Array([0x68, 0x69])); // "hi"
 *
 * // Chunked decoding — "€" (0xE2 0x82 0xAC) split across two reads:
 * const decoder = new TextDecoder();
 * decoder.decode(new Uint8Array([0xe2, 0x82]), { stream: true }); // ""
 * decoder.decode(new Uint8Array([0xac])); // "€"
 * ```
 *
 * https://encoding.spec.whatwg.org/#interface-textdecoder
 */
export class TextDecoder {
  /**
   * Normalized encoding selected from the constructor label.
   *
   * @internal
   */
  #encoding: TextDecoderEncoding;
  /**
   * Whether malformed input throws instead of emitting U+FFFD.
   *
   * @internal
   */
  #fatal: boolean;
  /**
   * Whether a leading BOM is preserved in the decoded output.
   *
   * @internal
   */
  #ignoreBOM: boolean;
  /**
   * Bytes of an incomplete trailing sequence buffered by a streaming
   * `decode()` call, prepended to the next chunk.
   *
   * @internal
   */
  #pending: Uint8Array | null = null;
  /**
   * Code unit of a trailing UTF-16 lead surrogate held back by a streaming
   * `decode()` call, awaiting its trail surrogate in the next chunk.
   *
   * @internal
   */
  #pendingUtf16Lead: number | null = null;
  // Tracks whether the BOM at the stream start has been seen/consumed. Resets
  // after each non-streaming decode() call per WHATWG spec.
  /**
   * Whether the BOM at the start of the stream has already been handled, so
   * it is only stripped from the first non-empty chunk. Resets after each
   * non-streaming `decode()` call.
   *
   * @internal
   */
  #bomHandled: boolean = false;
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```ts no_run
   * Object.prototype.toString.call(new TextDecoder()); // "[object TextDecoder]"
   * ```
   */
  get [Symbol.toStringTag]() {
    return 'TextDecoder';
  }
  /**
   * Create a TextDecoder for a supported encoding label.
   *
   * `label` is matched case-insensitively after trimming ASCII whitespace and
   * defaults to `'utf-8'`; unsupported labels throw a RangeError. `fatal`
   * makes malformed input throw a TypeError instead of emitting U+FFFD, and
   * `ignoreBOM` preserves an initial BOM instead of stripping it.
   *
   * ```ts no_run
   * const decoder = new TextDecoder('utf8', { fatal: true });
   * decoder.encoding; // "utf-8"
   * new TextDecoder('shift-jis'); // throws RangeError
   * ```
   */
  constructor(
    label: string = 'utf-8',
    options: {
      fatal?: boolean;
      ignoreBOM?: boolean;
    } = {},
  ) {
    const encoding = _normaliseDecoderLabel(label);
    if (encoding === null) {
      throw new RangeError(`TextDecoder: unsupported encoding '${label}'`);
    }
    this.#encoding = encoding;
    this.#fatal = Boolean(options.fatal);
    this.#ignoreBOM = Boolean(options.ignoreBOM);
  }
  /**
   * Normalized encoding name: `"utf-8"`, `"utf-16le"`, or `"utf-16be"`.
   *
   * Label aliases normalize to their canonical form, so `'utf8'` and
   * `'unicode-1-1-utf-8'` both report `"utf-8"`, and `'utf-16'` reports
   * `"utf-16le"`.
   *
   * ```ts no_run
   * new TextDecoder('unicode-1-1-utf-8').encoding; // "utf-8"
   * new TextDecoder('utf-16').encoding; // "utf-16le"
   * ```
   */
  get encoding() {
    return this.#encoding;
  }
  /**
   * Whether malformed input throws a TypeError instead of emitting U+FFFD.
   *
   * ```ts no_run
   * new TextDecoder('utf-8', { fatal: true }).fatal; // true
   * ```
   */
  get fatal() {
    return this.#fatal;
  }
  /**
   * Whether an initial BOM is preserved in decoded output.
   *
   * `false` means the leading BOM is skipped, matching browser defaults.
   *
   * ```ts no_run
   * new TextDecoder('utf-8', { ignoreBOM: true }).ignoreBOM; // true
   * ```
   */
  get ignoreBOM() {
    return this.#ignoreBOM;
  }
  /**
   * Decode `input` to a string.
   *
   * `input` may be an ArrayBuffer or any ArrayBufferView (the view's byte
   * range is decoded); omitting it or passing `null` decodes an empty chunk,
   * which is how a streaming sequence is flushed. Any other input type throws
   * a TypeError.
   *
   * With `stream: true`, an incomplete multi-byte sequence at the end of the
   * chunk is buffered and prepended to the next call instead of being
   * replaced, enabling chunk-by-chunk decoding of a byte stream. Finish the
   * stream with a final non-streaming call (typically `decode()` with no
   * argument): leftover incomplete bytes then become U+FFFD, or throw a
   * TypeError in fatal mode.
   *
   * In fatal mode a TypeError is thrown on any malformed sequence, and the
   * decoder's buffered streaming state is reset.
   *
   * ```ts no_run
   * const decoder = new TextDecoder();
   * for await (const chunk of byteStream) {
   *   process(decoder.decode(chunk, { stream: true }));
   * }
   * process(decoder.decode()); // flush
   * ```
   */
  decode(
    input?: ArrayBuffer | ArrayBufferView | null,
    options?: {
      stream?: boolean;
    },
  ): string {
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
          if (this.#fatal)
            throw new TypeError('TextDecoder: incomplete UTF-16 surrogate pair at end of stream');
          this.#pendingUtf16Lead = null;
          this.#bomHandled = false;
          return '�';
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
