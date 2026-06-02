import { randBytes } from '../internal/openssl.mts';
import { base64urlEncode } from '../internal/security/encoding.mts';

/** Return cryptographically secure random bytes. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('length must be a non-negative integer');
  const buf = new ArrayBuffer(length);
  randBytes(buf, length);
  return new Uint8Array(buf);
}

/** Return cryptographically secure random bytes encoded as unpadded base64url. */
export function randomBase64Url(length = 32): string {
  return base64urlEncode(randomBytes(length));
}

/** Return an opaque random token with 32 bytes of entropy by default. */
export function randomToken(bytes = 32): string {
  return randomBase64Url(bytes);
}

/** Return an unbiased random integer in [min, max). */
export function randomInt(min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new RangeError('min and max must be safe integers');
  if (max <= min) throw new RangeError('max must be greater than min');
  const range = max - min;
  if (range > 0xffffffff) throw new RangeError('range must be <= 2^32 - 1');
  const limit = Math.floor(0x100000000 / range) * range;
  const buf = new ArrayBuffer(4);
  const view = new DataView(buf);
  while (true) {
    randBytes(buf, 4);
    const value = view.getUint32(0, false);
    if (value < limit) return min + (value % range);
  }
}
