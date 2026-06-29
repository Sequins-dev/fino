/**
* fino:uuid - UUID v4 and v7 generation, parsing, and validation.
*
* Implements RFC 9562 (May 2024), which obsoletes RFC 4122 and formally
* standardizes v7 (time-ordered). Randomness comes from libcrypto via
* internal:openssl; no new Rust code is required.
*
* UUID specification: https://www.rfc-editor.org/rfc/rfc9562
*
* v7 same-millisecond monotonicity uses a module-level 12-bit counter (option
* b from RFC 9562 section 6.2): the counter increments on each v7() call within
* the same millisecond and resets with fresh random fill when the clock
* advances. If more than 4096 UUIDs are generated in one observed millisecond,
* the module advances a logical millisecond so strings remain strictly
* ascending within the same process while retaining cryptographic randomness
* across millisecond boundaries.
*
* ```ts no_run
*   import { UUID, v4, v7, parse, validate, version } from 'fino:uuid';
*
*   const id = v4();                    // UUID
*   const row = v7();                   // time-ordered UUID for DB primary keys
*   const ok = validate(id.toString()); // true
*   const ver = version(id.toString()); // 4
* ```
*/
import { randBytes, cryptoAvailable } from '../internal/openssl.ts';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _checkAvailable(): void {
  if (!cryptoAvailable) throw new Error('fino:uuid requires libcrypto (OpenSSL)');
}
function _randomBytes(n: number): Uint8Array {
  const buf = new ArrayBuffer(n);
  randBytes(buf, n);
  return new Uint8Array(buf);
}
function _hexByte(b: number): string {
  return b.toString(16).padStart(2, '0');
}
function _bytesToString(b: Uint8Array): string {
  const h = Array.from(b).map(_hexByte).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// Validate canonical form: xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx (lowercase hex)
const _RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _parse(str: string): Uint8Array {
  if (!_RE.test(str)) throw new Error(`Invalid UUID: "${str}"`);
  const hex = str.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
// ---------------------------------------------------------------------------
// v7 monotonic state
// ---------------------------------------------------------------------------
let _v7LastMs = -1;
let _v7Counter = 0;
let _v7CounterRand = 0;
// ---------------------------------------------------------------------------
// UUID class
// ---------------------------------------------------------------------------
/**
* Immutable UUID value object.
*
* `UUID` instances wrap 16 bytes and lazily cache their canonical string form.
* Static factories generate or parse values; instance methods expose metadata,
* bytes, equality, and JSON/string conversion. Generation requires OpenSSL
* availability and throws if the crypto backend is unavailable.
*
* ```ts no_run
* import { UUID } from 'fino:uuid';
*
* const id = UUID.v7();
* const text = id.toString();
* ```
*/
export class UUID {
  /**
  * Private property `#bytes` used by `UUID`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #bytes = undefined;
  *
  *   readInternalState() {
  *     return this.#bytes;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #bytes: Uint8Array;
  /**
  * Private property `#str` used by `UUID`.
  *
  * This implementation detail is included when documentation is built with
  * `--include-private`. It describes state or helper behavior used by the
  * owning module rather than a stable application-facing contract. Prefer the
  * public API around the owning type unless you are maintaining this runtime.
  *
  * @example
  * ```ts no_run
  * class IncludePrivateExample {
  *   #str = undefined;
  *
  *   readInternalState() {
  *     return this.#str;
  *   }
  * }
  * ```
  *
  * @internal
  */
  #str: string | null = null;
  /**
  * Create a UUID from exactly 16 bytes.
  *
  * The constructor is private; use `UUID.v4()`, `UUID.v7()`, `UUID.parse()`,
  * or `UUID.from()` instead. The supplied bytes are stored by the class, so the
  * public factories copy caller-provided byte arrays where needed.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const id = UUID.from(new Uint8Array(16));
  * ```
  */
  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  // --- Static factories ---
  /**
  * Generate a random RFC 9562 version 4 UUID.
  *
  * The UUID contains 122 bits of random data after version and variant bits
  * are set. Throws when the OpenSSL random backend is unavailable.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const id = UUID.v4();
  * ```
  */
  static v4(): UUID {
    _checkAvailable();
    const b = _randomBytes(16);
    b[6] = b[6]! & 15 | 64;
    b[8] = b[8]! & 63 | 128;
    return new UUID(b);
  }
  /**
  * Generate a time-ordered RFC 9562 version 7 UUID.
  *
  * The first 48 bits contain the current or logical Unix millisecond
  * timestamp. Calls in the same process and millisecond use a 12-bit counter
  * so generated strings sort in creation order. During extreme bursts that
  * exhaust the 12-bit counter, generation advances a logical millisecond that
  * may be slightly ahead of `Date.now()` to preserve same-process ordering.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const id = UUID.v7();
  * ```
  */
  static v7(): UUID {
    _checkAvailable();
    let ms = Date.now();
    const b = _randomBytes(16);
    if (ms > _v7LastMs) {
      _v7LastMs = ms;
      _v7Counter = 0;
      _v7CounterRand = b[7]! & 255;
    } else {
      ms = _v7LastMs;
      _v7Counter++;
      if (_v7Counter > 4095) {
        _v7LastMs++;
        ms = _v7LastMs;
        _v7Counter = 0;
        _v7CounterRand = _randomBytes(2)[0]! & 255;
      }
    }
    // Bytes 0-5: 48-bit millisecond timestamp (big-endian)
    b[0] = ms / 1099511627776 & 255;
    b[1] = ms / 4294967296 & 255;
    b[2] = ms / 16777216 & 255;
    b[3] = ms / 65536 & 255;
    b[4] = ms / 256 & 255;
    b[5] = ms & 255;
    // Byte 6: version 7 | high 4 bits of 12-bit counter
    b[6] = 112 | _v7Counter >> 8 & 15;
    // Byte 7: low 8 bits of 12-bit counter
    b[7] = _v7Counter & 255;
    // Byte 8: variant 10 | random fill
    b[8] = _v7CounterRand & 63 | 128;
    // Bytes 9-15: random (already filled)
    return new UUID(b);
  }
  /**
  * Parse a canonical UUID string into a `UUID` instance.
  *
  * Uppercase and lowercase hexadecimal characters are accepted. Invalid
  * length, missing dashes, or non-hex characters throw `Error`.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const id = UUID.parse('018f6a25-4f31-7c00-9d42-8c15d070f31f');
  * ```
  */
  static parse(str: string): UUID {
    return new UUID(_parse(str));
  }
  /**
  * Convert a UUID-like value into a `UUID` instance.
  *
  * Passing an existing `UUID` returns it unchanged. Passing a `Uint8Array`
  * requires exactly 16 bytes and copies the bytes. Passing a string delegates
  * to `UUID.parse()` and throws on invalid input.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const id = UUID.from('018f6a25-4f31-7c00-9d42-8c15d070f31f');
  * ```
  */
  static from(val: string | UUID | Uint8Array): UUID {
    if (val instanceof UUID) return val;
    if (val instanceof Uint8Array) {
      if (val.byteLength !== 16) throw new TypeError('UUID.from: Uint8Array must be 16 bytes');
      return new UUID(new Uint8Array(val));
    }
    return new UUID(_parse(val));
  }
  /**
  * Nil UUID value with all bytes set to zero.
  *
  * Useful as a sentinel value. The exported module-level `NIL` constant is its
  * string form.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const empty = UUID.NIL.toString();
  * ```
  */
  static readonly NIL: UUID = new UUID(new Uint8Array(16));
  /**
  * Maximum UUID value with all bytes set to `0xff`.
  *
  * Useful for range bounds. The exported module-level `MAX` constant is its
  * string form.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const upper = UUID.MAX.toString();
  * ```
  */
  static readonly MAX: UUID = new UUID(new Uint8Array(16).fill(255));
  // --- Accessors ---
  /**
  * UUID version nibble.
  *
  * Returns the high four bits of byte 6, so generated IDs return `4` or `7`.
  * Parsed IDs can report any encoded version number.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const version = UUID.v4().version;
  * ```
  */
  get version(): number {
    return this.#bytes[6]! >> 4 & 15;
  }
  /**
  * UUID variant classification.
  *
  * Returns `0` for NCS, `1` for RFC 4122/RFC 9562, `2` for Microsoft, and `3`
  * for future reserved values. Generated UUIDs use variant `1`.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const variant = UUID.v7().variant;
  * ```
  */
  get variant(): number {
    const b = this.#bytes[8]!;
    if ((b & 128) === 0) return 0;
    if ((b & 192) === 128) return 1;
    if ((b & 224) === 192) return 2;
    return 3;
  }
  /**
  * Timestamp represented by version 1 or version 7 UUIDs.
  *
  * Returns a `Date` for v7 millisecond timestamps and for v1 100-nanosecond
  * timestamps converted to Unix time. Returns `null` for UUID versions without
  * embedded time, including v4.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const createdAt = UUID.v7().timestamp;
  * ```
  */
  get timestamp(): Date | null {
    const ver = this.version;
    if (ver === 7) {
      const b = this.#bytes;
      const ms = b[0]! * 1099511627776 + b[1]! * 4294967296 + b[2]! * 16777216 + b[3]! * 65536 + b[4]! * 256 + b[5]!;
      return new Date(ms);
    }
    if (ver === 1) {
      // v1: time_low (bytes 0-3), time_mid (4-5), time_hi_version (6-7)
      const b = this.#bytes;
      const low = b[0]! * 16777216 + b[1]! * 65536 + b[2]! * 256 + b[3]!;
      const mid = b[4]! * 256 + b[5]!;
      const hi = (b[6]! & 15) * 256 + b[7]!;
      // 100ns intervals since Oct 15, 1582 to ms since Unix epoch
      const ticks = hi * 281474976710656 + mid * 4294967296 + low;
      const ms = Math.round(ticks / 1e4) - 0xb1d069b5400;
      return new Date(ms);
    }
    return null;
  }
  // --- Methods ---
  /**
  * Return a copy of the UUID bytes.
  *
  * The returned `Uint8Array` is detached from the instance state, so mutating
  * it cannot change the UUID.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const bytes = UUID.v4().toBytes();
  * ```
  */
  toBytes(): Uint8Array {
    return this.#bytes.slice();
  }
  /**
  * Compare this UUID to another UUID by byte value.
  *
  * Returns `true` only when all 16 bytes match. It accepts `UUID` instances,
  * so parse or convert other inputs before comparing.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const same = UUID.NIL.equals(UUID.from(UUID.NIL.toString()));
  * ```
  */
  equals(other: UUID): boolean {
    const a = this.#bytes, b = other.#bytes;
    for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  /**
  * Return the canonical lower-case UUID string.
  *
  * The string is computed once and cached. It always uses the
  * `8-4-4-4-12` dashed hexadecimal form.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const text = UUID.v4().toString();
  * ```
  */
  toString(): string {
    if (this.#str === null) this.#str = _bytesToString(this.#bytes);
    return this.#str;
  }
  /**
  * Return the canonical string for JSON serialization.
  *
  * `JSON.stringify()` calls this method, so UUID values serialize as strings
  * rather than objects.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const json = JSON.stringify({ id: UUID.v4() });
  * ```
  */
  toJSON(): string {
    return this.toString();
  }
  /**
  * Convert the UUID to a string primitive.
  *
  * String interpolation and concatenation use the canonical UUID string. The
  * hint is ignored.
  *
  * ```ts no_run
  * import { UUID } from 'fino:uuid';
  *
  * const label = `${UUID.v7()}`;
  * ```
  */
  [Symbol.toPrimitive](_hint: string): string {
    return this.toString();
  }
}
// ---------------------------------------------------------------------------
// Module-level function surface
// ---------------------------------------------------------------------------
/**
* Generate a random UUID version 4.
*
* This is a convenience wrapper around `UUID.v4()`. It returns a `UUID`
* instance and throws when the OpenSSL random backend is unavailable.
*
* ```ts no_run
* import { v4 } from 'fino:uuid';
*
* const id = v4();
* ```
*/
export function v4(): UUID {
  return UUID.v4();
}
/**
* Generate a time-ordered UUID version 7.
*
* This is a convenience wrapper around `UUID.v7()`. Values include a
* millisecond timestamp and sort well for many database primary-key workloads.
*
* ```ts no_run
* import { v7 } from 'fino:uuid';
*
* const id = v7();
* ```
*/
export function v7(): UUID {
  return UUID.v7();
}
/**
* Parse a UUID string into a `UUID` instance.
*
* Uppercase and lowercase hexadecimal input is accepted. Invalid input throws
* `Error`.
*
* ```ts no_run
* import { parse } from 'fino:uuid';
*
* const id = parse('018f6a25-4f31-7c00-9d42-8c15d070f31f');
* ```
*/
export function parse(str: string): UUID {
  return UUID.parse(str);
}
/**
* Return `true` when `str` is a valid canonical UUID string.
*
* This helper accepts upper or lower case hexadecimal characters and never
* throws for invalid UUID text.
*
* ```ts no_run
* import { validate } from 'fino:uuid';
*
* const ok = validate('018f6a25-4f31-7c00-9d42-8c15d070f31f');
* ```
*/
export function validate(str: string): boolean {
  try {
    _parse(str);
    return true;
  } catch {
    return false;
  }
}
/**
* Return the UUID version number parsed from `str`.
*
* Invalid UUID text throws through `UUID.parse()`. The result is the version
* nibble encoded in the string, not a validation of whether that version is
* supported for generation.
*
* ```ts no_run
* import { version } from 'fino:uuid';
*
* const v = version('018f6a25-4f31-7c00-9d42-8c15d070f31f');
* ```
*/
export function version(str: string): number {
  return UUID.parse(str).version;
}
/**
* Nil UUID string (`00000000-0000-0000-0000-000000000000`).
*
* Use this string sentinel when an API expects UUID text rather than a `UUID`
* instance.
*
* ```ts no_run
* import { NIL } from 'fino:uuid';
*
* const empty = NIL;
* ```
*/
export const NIL: string = UUID.NIL.toString();
/**
* Max UUID string (`ffffffff-ffff-ffff-ffff-ffffffffffff`).
*
* Use this string sentinel for upper bounds or placeholder values that need the
* maximum UUID byte sequence.
*
* ```ts no_run
* import { MAX } from 'fino:uuid';
*
* const upper = MAX;
* ```
*/
export const MAX: string = UUID.MAX.toString();
