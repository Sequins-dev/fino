/**
 * fino:uuid — UUID v4 and v7 generation, parsing, and validation.
 *
 * Implements RFC 9562 (May 2024), which obsoletes RFC 4122 and formally
 * standardizes v7 (time-ordered). Randomness comes from libcrypto via
 * internal:openssl; no new Rust code is required.
 *
 * v7 same-millisecond monotonicity uses a module-level 12-bit counter (option
 * b from RFC 9562 §6.2): the counter increments on each v7() call within the
 * same millisecond and resets with fresh random fill when the clock advances.
 * This guarantees strict ascending order within a single process while
 * retaining cryptographic randomness across millisecond boundaries.
 *
 * @example
 *   import { UUID, v4, v7, parse, validate, version } from 'fino:uuid';
 *
 *   const id  = v4();                   // UUID
 *   const row = v7();                   // time-ordered UUID for DB primary keys
 *   const ok  = validate(id.toString()); // true
 *   const ver = version(id.toString()); // 4
 */

import { randBytes, cryptoAvailable } from '../internal/openssl.mts';

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
let _v7Counter = 0;     // 12-bit counter (0–4095)
let _v7CounterRand = 0; // random fill seeded at each ms boundary

// ---------------------------------------------------------------------------
// UUID class
// ---------------------------------------------------------------------------

export class UUID {
  #bytes: Uint8Array;
  #str: string | null = null;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  // --- Static factories ---

  static v4(): UUID {
    _checkAvailable();
    const b = _randomBytes(16);
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10xx
    return new UUID(b);
  }

  static v7(): UUID {
    _checkAvailable();
    const ms = Date.now();
    const b = _randomBytes(16);

    if (ms === _v7LastMs) {
      _v7Counter = (_v7Counter + 1) & 0xfff;
      // On overflow within the same ms, borrow a fresh random fill
      if (_v7Counter === 0) _v7CounterRand = _randomBytes(2)[0]! & 0xff;
    } else {
      _v7LastMs = ms;
      _v7Counter = 0;
      _v7CounterRand = b[7]! & 0xff;
    }

    // Bytes 0–5: 48-bit millisecond timestamp (big-endian)
    b[0] = (ms / 0x10000000000) & 0xff;
    b[1] = (ms / 0x100000000) & 0xff;
    b[2] = (ms / 0x1000000) & 0xff;
    b[3] = (ms / 0x10000) & 0xff;
    b[4] = (ms / 0x100) & 0xff;
    b[5] = ms & 0xff;
    // Byte 6: version 7 | high 4 bits of 12-bit counter
    b[6] = 0x70 | ((_v7Counter >> 8) & 0x0f);
    // Byte 7: low 8 bits of 12-bit counter
    b[7] = _v7Counter & 0xff;
    // Byte 8: variant 10 | random fill
    b[8] = (_v7CounterRand & 0x3f) | 0x80;
    // Bytes 9–15: random (already filled)

    return new UUID(b);
  }

  static parse(str: string): UUID {
    return new UUID(_parse(str));
  }

  static from(val: string | UUID | Uint8Array): UUID {
    if (val instanceof UUID) return val;
    if (val instanceof Uint8Array) {
      if (val.byteLength !== 16) throw new TypeError('UUID.from: Uint8Array must be 16 bytes');
      return new UUID(new Uint8Array(val));
    }
    return new UUID(_parse(val));
  }

  static readonly NIL: UUID = new UUID(new Uint8Array(16));
  static readonly MAX: UUID = new UUID(new Uint8Array(16).fill(0xff));

  // --- Accessors ---

  get version(): number {
    return (this.#bytes[6]! >> 4) & 0x0f;
  }

  get variant(): number {
    const b = this.#bytes[8]!;
    if ((b & 0x80) === 0)      return 0; // NCS backward compatibility
    if ((b & 0xc0) === 0x80)   return 1; // RFC 4122 / RFC 9562
    if ((b & 0xe0) === 0xc0)   return 2; // Microsoft
    return 3;                            // future reserved
  }

  get timestamp(): Date | null {
    const ver = this.version;
    if (ver === 7) {
      const b = this.#bytes;
      const ms = (b[0]! * 0x10000000000) +
                 (b[1]! * 0x100000000) +
                 (b[2]! * 0x1000000) +
                 (b[3]! * 0x10000) +
                 (b[4]! * 0x100) +
                  b[5]!;
      return new Date(ms);
    }
    if (ver === 1) {
      // v1: time_low (bytes 0-3), time_mid (4-5), time_hi_version (6-7)
      const b = this.#bytes;
      const low  = (b[0]! * 0x1000000 + b[1]! * 0x10000 + b[2]! * 0x100 + b[3]!);
      const mid  = (b[4]! * 0x100 + b[5]!);
      const hi   = ((b[6]! & 0x0f) * 0x100 + b[7]!);
      // 100ns intervals since Oct 15, 1582 → ms since Unix epoch
      const ticks = hi * 0x1000000000000 + mid * 0x100000000 + low;
      const ms = Math.round(ticks / 10000) - 12219292800000;
      return new Date(ms);
    }
    return null;
  }

  // --- Methods ---

  toBytes(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }

  equals(other: UUID): boolean {
    const a = this.#bytes, b = other.#bytes;
    for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  toString(): string {
    if (this.#str === null) this.#str = _bytesToString(this.#bytes);
    return this.#str;
  }

  toJSON(): string {
    return this.toString();
  }

  [Symbol.toPrimitive](_hint: string): string {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// Module-level function surface
// ---------------------------------------------------------------------------

export function v4(): UUID { return UUID.v4(); }
export function v7(): UUID { return UUID.v7(); }
export function parse(str: string): UUID { return UUID.parse(str); }

export function validate(str: string): boolean {
  try { _parse(str); return true; } catch { return false; }
}

export function version(str: string): number {
  return UUID.parse(str).version;
}

export const NIL: string = UUID.NIL.toString();
export const MAX: string = UUID.MAX.toString();
