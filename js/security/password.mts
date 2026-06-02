/**
 * fino:security/password - PBKDF2 password hashing and verification.
 *
 * This module stores passwords as self-describing PBKDF2 records containing the
 * digest, iteration count, random salt, and derived key. Verification parses the
 * stored record and derives the candidate password with the same parameters, so
 * records can keep working after defaults are raised.
 *
 * PBKDF2 is intentionally slow. Tune iteration counts against your deployment
 * latency budget and periodically rehash older records with stronger settings
 * after a successful login.
 *
 * @example
 * ```ts no_run
 * import { hashPassword, verifyPassword } from 'fino:security/password';
 *
 * const record = hashPassword(password, { iterations: 300_000, hash: 'sha-512' });
 * const ok = verifyPassword(passwordAttempt, record);
 * ```
 */

import { pbkdf2 } from '../internal/openssl.mts';
import { base64urlDecode, base64urlEncode, timingSafeEqual, toBytes } from '../internal/security/encoding.mts';
import { randomBytes } from './random.mts';

/**
 * PBKDF2 password hashing options.
 *
 * Omitted fields use the module defaults: 210,000 iterations, 16 random salt
 * bytes, a 32-byte derived key, and SHA-256. Tune these values only with an
 * understanding of your deployment latency budget and password storage policy.
 *
 * ```ts no_run
 * import type { HashPasswordOptions } from 'fino:security/password';
 *
 * const options: HashPasswordOptions = { iterations: 300_000, hash: 'sha-512' };
 * ```
 */
export interface HashPasswordOptions {
  /**
   * PBKDF2 iteration count.
   *
   * Defaults to `210_000`. Values must be positive safe integers or
   * `hashPassword()` throws `RangeError`.
   *
   * ```ts no_run
   * import type { HashPasswordOptions } from 'fino:security/password';
   *
   * const options: HashPasswordOptions = { iterations: 250_000 };
   * ```
   */
  iterations?: number;
  /**
   * Random salt length in bytes.
   *
   * Defaults to `16`. The salt is generated with cryptographically secure
   * random bytes and stored in the returned record.
   *
   * ```ts no_run
   * import type { HashPasswordOptions } from 'fino:security/password';
   *
   * const options: HashPasswordOptions = { saltLength: 24 };
   * ```
   */
  saltLength?: number;
  /**
   * Derived key length in bytes.
   *
   * Defaults to `32`. The verifier derives the same length from the stored
   * record, so this only needs to be supplied during hashing.
   *
   * ```ts no_run
   * import type { HashPasswordOptions } from 'fino:security/password';
   *
   * const options: HashPasswordOptions = { keyLength: 32 };
   * ```
   */
  keyLength?: number;
  /**
   * Digest used by PBKDF2.
   *
   * Defaults to `sha-256`. The selected digest name is stored in the record and
   * reused during verification.
   *
   * ```ts no_run
   * import type { HashPasswordOptions } from 'fino:security/password';
   *
   * const options: HashPasswordOptions = { hash: 'sha-512' };
   * ```
   */
  hash?: 'sha-256' | 'sha-384' | 'sha-512';
}

/**
 * Hash a password as `pbkdf2$hash$iterations$salt$derived`.
 *
 * Generates a fresh random salt for every call. Invalid iteration counts throw
 * `RangeError`; cryptographic backend failures propagate as errors. Store the
 * returned record verbatim and compare passwords with `verifyPassword()`.
 *
 * ```ts no_run
 * import { hashPassword } from 'fino:security/password';
 *
 * const record = hashPassword('correct horse battery staple');
 * ```
 */
export function hashPassword(password: string, options: HashPasswordOptions = {}): string {
  const hash = options.hash ?? 'sha-256';
  const iterations = options.iterations ?? 210_000;
  const saltLength = options.saltLength ?? 16;
  const keyLength = options.keyLength ?? 32;
  if (!Number.isSafeInteger(iterations) || iterations < 1) throw new RangeError('iterations must be a positive integer');
  const salt = randomBytes(saltLength);
  const derived = pbkdf2(toBytes(password), salt, iterations, hash, keyLength);
  return ['pbkdf2', hash, String(iterations), base64urlEncode(salt), base64urlEncode(derived)].join('$');
}

/**
 * Verify a PBKDF2 password record.
 *
 * Returns `true` only when the password derives to the stored value. Malformed
 * records, unsupported parameters, base64url decode failures, and mismatches
 * return `false`. Comparison is timing-safe after derivation.
 *
 * ```ts no_run
 * import { hashPassword, verifyPassword } from 'fino:security/password';
 *
 * const record = hashPassword('secret');
 * const ok = verifyPassword('secret', record);
 * ```
 */
export function verifyPassword(password: string, record: string): boolean {
  const parts = record.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const hash = parts[1]!;
  const iterations = Number(parts[2]);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
  try {
    const salt = base64urlDecode(parts[3]!);
    const expected = base64urlDecode(parts[4]!);
    const actual = pbkdf2(toBytes(password), salt, iterations, hash, expected.byteLength);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
