/**
 * fino:security/random - cryptographically secure random values.
 *
 * Use this module for salts, nonces, IVs, opaque bearer tokens, identifiers,
 * and unbiased bounded integers. Random bytes come from the runtime OpenSSL
 * backend and higher-level helpers encode them as unpadded base64url strings
 * when text-safe output is needed.
 *
 * Callers are still responsible for choosing protocol-appropriate lengths. For
 * example, AES-GCM commonly uses 12-byte IVs, while bearer tokens often use at
 * least 32 bytes of entropy.
 *
 * @example
 * ```ts no_run
 * import { randomBytes, randomToken, randomInt } from 'fino:security/random';
 *
 * const iv = randomBytes(12);
 * const resetToken = randomToken(32);
 * const shard = randomInt(0, 16);
 * ```
 */

import { randBytes } from '../internal/openssl.mts';
import { base64urlEncode } from '../internal/security/encoding.mts';

/**
 * Return cryptographically secure random bytes from the runtime OpenSSL backend.
 *
 * `length` must be a non-negative safe integer. A zero length returns an empty
 * `Uint8Array`; invalid lengths throw `RangeError`. The bytes are suitable for
 * keys, salts, IVs, nonces, and opaque identifiers, but callers must still
 * choose lengths appropriate for the protocol they are using.
 *
 * ```ts no_run
 * import { randomBytes } from 'fino:security/random';
 *
 * const nonce = randomBytes(12);
 * ```
 */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('length must be a non-negative integer');
  const buf = new ArrayBuffer(length);
  randBytes(buf, length);
  return new Uint8Array(buf);
}

/**
 * Return cryptographically secure random bytes encoded as unpadded base64url.
 *
 * The `length` argument is the number of random bytes before encoding and
 * defaults to 32 bytes. Invalid byte lengths throw `RangeError` through
 * `randomBytes()`. The returned string is URL-safe and contains no padding.
 *
 * ```ts no_run
 * import { randomBase64Url } from 'fino:security/random';
 *
 * const csrf = randomBase64Url(32);
 * ```
 */
export function randomBase64Url(length = 32): string {
  return base64urlEncode(randomBytes(length));
}

/**
 * Return an opaque random token with 32 bytes of entropy by default.
 *
 * `bytes` controls the entropy size before base64url encoding. Invalid byte
 * counts throw `RangeError`. Use the token as an identifier or bearer secret;
 * do not embed structured data in it.
 *
 * ```ts no_run
 * import { randomToken } from 'fino:security/random';
 *
 * const resetToken = randomToken();
 * ```
 */
export function randomToken(bytes = 32): string {
  return randomBase64Url(bytes);
}

/**
 * Return an unbiased random integer in the half-open range `[min, max)`.
 *
 * Both bounds must be safe integers, `max` must be greater than `min`, and the
 * range must fit in 32 bits. Invalid inputs throw `RangeError`. Rejection
 * sampling avoids modulo bias for security-sensitive choices.
 *
 * ```ts no_run
 * import { randomInt } from 'fino:security/random';
 *
 * const index = randomInt(0, choices.length);
 * ```
 */
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
