import { cipherDecrypt, cipherEncrypt, hmac } from '../internal/openssl.mts';
import { base64urlDecode, base64urlEncode, normalizeSecretKey, timingSafeEqualString, toBytes, utf8, type BufferLike } from '../internal/security/encoding.mts';
import { randomBytes } from './random.mts';

/** Options used when serializing a single `Set-Cookie` header value. */
export interface CookieOptions {
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Serialize one `Set-Cookie` header value, URI-encoding the cookie value. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new Error('Invalid cookie name');
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

/** Parse a `Cookie` request header into a plain object, skipping malformed pairs. */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length > 0) out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Sign a cookie value with HMAC-SHA-256 and return `payload.signature`. */
export function signCookie(value: string, secret: BufferLike): string {
  const payload = base64urlEncode(value);
  const sig = base64urlEncode(hmac('sha-256', toBytes(secret), toBytes(payload)));
  return `${payload}.${sig}`;
}

/** Verify a signed cookie value, returning `null` on tamper or malformed input. */
export function verifyCookie(signed: string, secret: BufferLike): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = base64urlEncode(hmac('sha-256', toBytes(secret), toBytes(payload)));
  if (!timingSafeEqualString(sig, expected)) return null;
  try {
    return utf8(base64urlDecode(payload));
  } catch {
    return null;
  }
}

/** Encrypt and authenticate a cookie value using AES-256-GCM and a random IV. */
export function sealCookie(value: string, secret: BufferLike): string {
  const key = normalizeSecretKey(secret, 32);
  const iv = randomBytes(12);
  const result = cipherEncrypt('aes-256-gcm', key, iv, toBytes(value));
  return ['v1', base64urlEncode(iv), base64urlEncode(result.ciphertext), base64urlEncode(result.tag)].join('.');
}

/** Decrypt a sealed cookie value, returning `null` on tamper or malformed input. */
export function unsealCookie(sealed: string, secret: BufferLike): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const key = normalizeSecretKey(secret, 32);
    const iv = base64urlDecode(parts[1]!);
    const ciphertext = base64urlDecode(parts[2]!);
    const tag = base64urlDecode(parts[3]!);
    return utf8(cipherDecrypt('aes-256-gcm', key, iv, ciphertext, tag));
  } catch {
    return null;
  }
}
