import { pbkdf2 } from '../internal/openssl.mts';
import { base64urlDecode, base64urlEncode, timingSafeEqual, toBytes } from '../internal/security/encoding.mts';
import { randomBytes } from './random.mts';

/** PBKDF2 password hashing options. */
export interface HashPasswordOptions {
  iterations?: number;
  saltLength?: number;
  keyLength?: number;
  hash?: 'sha-256' | 'sha-384' | 'sha-512';
}

/** Hash a password as `pbkdf2$hash$iterations$salt$hash`. */
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

/** Verify a PBKDF2 password record, returning `false` for malformed records. */
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
