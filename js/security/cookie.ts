/**
* fino:security/cookie - cookie serialization, parsing, signing, and sealing.
*
* HTTP cookie specification: https://www.rfc-editor.org/rfc/rfc6265
*
* Use this module for HTTP cookie values that need browser-compatible
* attributes or tamper-evident storage. Plain serialization and parsing handle
* request and response header syntax. Signing appends an HMAC so the original
* value can be recovered only when it has not been modified. Sealing encrypts
* and authenticates the value for cookies that must not be readable by clients.
*
* The helpers do not implement session storage or key rotation. Applications
* should store secrets outside source code, rotate them deliberately, and avoid
* putting large or highly sensitive payloads in cookies.
*
* @example
* ```ts no_run
* import {
*   serializeCookie,
*   signCookie,
*   verifyCookie,
* } from 'fino:security/cookie';
*
* const signed = signCookie('user-123', sessionSecret);
* const header = serializeCookie('sid', signed, {
*   path: '/',
*   httpOnly: true,
*   secure: true,
*   sameSite: 'Lax',
* });
* const value = verifyCookie(signed, sessionSecret);
* ```
*/
import { cipherDecrypt, cipherEncrypt, hmac } from '../internal/openssl.ts';
import { base64urlDecode, base64urlEncode, normalizeSecretKey, timingSafeEqualString, toBytes, utf8, type BufferLike as SecurityBufferLike } from '../internal/security/encoding.ts';
import { randomBytes } from './random.ts';
/**
* Byte-oriented secret input accepted by cookie signing and sealing helpers.
*
* Strings are encoded as UTF-8. `Uint8Array`, `ArrayBuffer`, and other
* `ArrayBufferView` values are read as bytes.
*/
export type BufferLike = SecurityBufferLike;
/**
* Options used when serializing a single `Set-Cookie` header value.
*
* Attributes are emitted only when provided or set to `true`. Values are not
* validated for header injection, browser prefix rules, finite expiration
* values, and `SameSite=None` / `Secure` coupling. Callers should still pass
* trusted domain, path, and policy strings.
*
* ```ts no_run
* import type { CookieOptions } from 'fino:security/cookie';
*
* const options: CookieOptions = {
*   path: '/',
*   httpOnly: true,
*   secure: true,
*   sameSite: 'Lax',
* };
* ```
*/
export interface CookieOptions {
  /**
  * Optional `Domain` attribute.
  *
  * Omit it to create a host-only cookie. The value is emitted unchanged.
  *
  * ```ts no_run
  * import type { CookieOptions } from 'fino:security/cookie';
  *
  * const options: CookieOptions = { domain: 'example.com' };
  * ```
  */
  domain?: string;
  /**
  * Optional `Path` attribute.
  *
  * Defaults to no emitted path attribute; many applications pass `/`.
  *
  * ```ts no_run
  * import type { CookieOptions } from 'fino:security/cookie';
  *
  * const options: CookieOptions = { path: '/' };
  * ```
  */
  path?: string;
  /**
  * Optional absolute expiration time.
  *
  * When provided, it is formatted with `Date.prototype.toUTCString()`.
  *
  * ```ts no_run
  * import type { CookieOptions } from 'fino:security/cookie';
  *
  * const options: CookieOptions = { expires: new Date(Date.now() + 3600_000) };
  * ```
  */
  expires?: Date;
  /**
  * Optional `Max-Age` value in seconds.
  *
  * The value is floored before serialization. Pass `0` to expire the cookie.
  *
  * ```ts no_run
  * import type { CookieOptions } from 'fino:security/cookie';
  *
  * const options: CookieOptions = { maxAge: 3600 };
  * ```
  */
  maxAge?: number;
  /**
  * Whether to emit the `HttpOnly` attribute.
  *
  * Defaults to omitted. Enable it for cookies that client-side scripts should
  * not read.
  *
  * ```ts no_run
  * import type { CookieOptions } from 'fino:security/cookie';
  *
  * const options: CookieOptions = { httpOnly: true };
  * ```
  */
  httpOnly?: boolean;
  /**
  * Whether to emit the `Secure` attribute.
  *
  * Defaults to omitted. Enable it for cookies that should only be sent over
  * HTTPS, and when using `SameSite=None`.
  *
  * ```ts no_run
  * import type { CookieOptions } from 'fino:security/cookie';
  *
  * const options: CookieOptions = { secure: true };
  * ```
  */
  secure?: boolean;
  /**
  * Optional `SameSite` policy.
  *
  * Defaults to omitted. Use `None` only with `secure: true` for browser
  * compatibility.
  *
  * ```ts no_run
  * import type { CookieOptions } from 'fino:security/cookie';
  *
  * const options: CookieOptions = { sameSite: 'Lax' };
  * ```
  */
  sameSite?: 'Strict' | 'Lax' | 'None';
}
/**
* Serialize one `Set-Cookie` header value, URI-encoding the cookie value.
*
* The cookie name must use valid token characters or the function throws
* `Error`. The value is encoded with `encodeURIComponent()`. Expiration
* attributes must be finite, `SameSite=None` requires `secure: true`, and the
* `__Secure-` / `__Host-` prefixes enforce browser-compatible constraints.
*
* ```ts no_run
* import { serializeCookie } from 'fino:security/cookie';
*
* const header = serializeCookie('sid', 'abc123', {
*   path: '/',
*   httpOnly: true,
*   secure: true,
* });
* ```
*/
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new Error('Invalid cookie name');
  if (options.domain !== undefined && /[\r\n]/.test(options.domain)) throw new Error('Invalid cookie Domain attribute');
  if (options.path !== undefined && /[\r\n]/.test(options.path)) throw new Error('Invalid cookie Path attribute');
  if (options.expires !== undefined && !Number.isFinite(options.expires.getTime())) throw new Error('Invalid cookie Expires attribute');
  if (options.maxAge !== undefined && !Number.isFinite(options.maxAge)) throw new Error('Invalid cookie Max-Age attribute');
  if (options.sameSite !== undefined && options.sameSite !== 'Strict' && options.sameSite !== 'Lax' && options.sameSite !== 'None') {
    throw new Error('Invalid cookie SameSite attribute');
  }
  if (options.sameSite === 'None' && options.secure !== true) throw new Error('SameSite=None requires Secure');
  if (name.startsWith('__Secure-') && options.secure !== true) throw new Error('__Secure- cookies require Secure');
  if (name.startsWith('__Host-')) {
    if (options.secure !== true) throw new Error('__Host- cookies require Secure');
    if (options.domain !== undefined) throw new Error('__Host- cookies must not include Domain');
    if (options.path !== '/') throw new Error('__Host- cookies require Path=/');
  }
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
/**
* Parse a `Cookie` request header into a plain object.
*
* Malformed segments without `=` are skipped. Names are trimmed; values are
* URI-decoded with `decodeURIComponent()`, so malformed percent escapes throw.
* Later duplicate cookie names overwrite earlier values.
*
* ```ts no_run
* import { parseCookieHeader } from 'fino:security/cookie';
*
* const cookies = parseCookieHeader('sid=abc; theme=dark');
* ```
*/
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
/**
* Mutable cookie jar populated from a request `Cookie` header.
*
* Queue cookie changes with `set()` or `delete()`. Framework integrations can
* call `_apply()` to append queued `Set-Cookie` headers to a response. The jar
* also updates its in-memory values immediately, so handlers can read their own
* writes during a request.
*
* ```ts no_run
* import { CookieJar } from 'fino:security/cookie';
*
* const jar = new CookieJar('sid=123');
* jar.set('theme', 'dark', { path: '/' });
* console.log(jar.get('theme'));
* ```
*/
export class CookieJar {
  /**
  * Request cookie values plus local mutations made during this request.
  *
  * @internal
  */
  #values: Record<string, string>;
  /**
  * Serialized `Set-Cookie` headers queued for the outgoing response.
  *
  * @internal
  */
  #out: string[] = [];
  /**
  * Parse a `Cookie` header into a mutable jar.
  *
  * `null` creates an empty jar. Parsing uses `parseCookieHeader()`, including
  * its URI-decoding behavior for cookie values.
  *
  * ```ts no_run
  * const jar = new CookieJar(request.headers.get('cookie'));
  * ```
  */
  constructor(header: string | null) {
    this.#values = header === null ? {} : parseCookieHeader(header);
  }
  /**
  * Read one cookie value from the current jar state.
  *
  * Returns `undefined` when the cookie was not present or has been deleted
  * locally.
  *
  * ```ts no_run
  * const sid = jar.get('sid');
  * ```
  */
  get(name: string): string | undefined {
    return this.#values[name];
  }
  /**
  * Return all current cookie values as a plain object copy.
  *
  * ```ts no_run
  * const values = jar.all();
  * ```
  */
  all(): Record<string, string> {
    return { ...this.#values };
  }
  /**
  * Queue a `Set-Cookie` header and update this jar's current value.
  *
  * Cookie options are passed to `serializeCookie()`.
  *
  * ```ts no_run
  * jar.set('sid', session.id, { httpOnly: true, path: '/' });
  * ```
  */
  set(name: string, value: string, options: CookieOptions = {}): void {
    this.#values[name] = value;
    this.#out.push(serializeCookie(name, value, options));
  }
  /**
  * Queue an expired `Set-Cookie` header and remove this jar's current value.
  *
  * ```ts no_run
  * jar.delete('sid', { path: '/' });
  * ```
  */
  delete(name: string, options: CookieOptions = {}): void {
    delete this.#values[name];
    this.#out.push(serializeCookie(name, '', {
      ...options,
      expires: new Date(0),
      maxAge: 0
    }));
  }
  /**
  * Append queued `Set-Cookie` headers to a response-like object.
  *
  * This is used by HTTP framework integrations after a handler returns. It
  * relies on the runtime's trusted header append hook so multiple `Set-Cookie`
  * headers are preserved instead of joined.
  *
  * @internal
  */
  _apply(res: {
    headers: {
      _appendTrusted(name: string, value: string): void;
    };
  }): void {
    for (const value of this.#out) res.headers._appendTrusted('set-cookie', value);
  }
}
/**
* Sign a cookie value with HMAC-SHA-256 and return `payload.signature`.
*
* The payload is base64url-encoded UTF-8 text, and the signature covers the
* encoded payload. This authenticates but does not encrypt the cookie value.
*
* ```ts no_run
* import { signCookie } from 'fino:security/cookie';
*
* const signed = signCookie('user-123', 'secret');
* ```
*/
export function signCookie(value: string, secret: BufferLike): string {
  const payload = base64urlEncode(value);
  const sig = base64urlEncode(hmac('sha-256', toBytes(secret), toBytes(payload)));
  return `${payload}.${sig}`;
}
/**
* Verify a signed cookie value and return the original UTF-8 value.
*
* Returns `null` when the token is malformed, the signature does not match, or
* the payload cannot be decoded. Signature comparison is timing-safe. This does
* not check expiration; store and verify any expiry in the signed payload.
*
* ```ts no_run
* import { signCookie, verifyCookie } from 'fino:security/cookie';
*
* const signed = signCookie('user-123', 'secret');
* const value = verifyCookie(signed, 'secret');
* ```
*/
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
/**
* Encrypt and authenticate a cookie value using AES-256-GCM and a random IV.
*
* The secret is normalized to a 32-byte key. The returned `v1.iv.ciphertext.tag`
* value hides the plaintext and detects tampering. A fresh 96-bit IV is used
* for each seal operation.
*
* ```ts no_run
* import { sealCookie } from 'fino:security/cookie';
*
* const sealed = sealCookie(JSON.stringify({ sub: 'user-123' }), 'secret');
* ```
*/
export function sealCookie(value: string, secret: BufferLike): string {
  const key = normalizeSecretKey(secret, 32);
  const iv = randomBytes(12);
  const result = cipherEncrypt('aes-256-gcm', key, iv, toBytes(value));
  return [
    'v1',
    base64urlEncode(iv),
    base64urlEncode(result.ciphertext),
    base64urlEncode(result.tag)
  ].join('.');
}
/**
* Decrypt a sealed cookie value and return the original UTF-8 string.
*
* Returns `null` for unsupported versions, malformed parts, decode failures, or
* AES-GCM authentication failures. This authenticates and decrypts the value but
* does not enforce expiration unless you include one in the plaintext.
*
* ```ts no_run
* import { sealCookie, unsealCookie } from 'fino:security/cookie';
*
* const sealed = sealCookie('user-123', 'secret');
* const value = unsealCookie(sealed, 'secret');
* ```
*/
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
