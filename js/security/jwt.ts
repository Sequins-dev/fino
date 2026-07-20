/**
* fino:security/jwt - compact JWT/JWS and JWE helpers backed by JWK keys.
*
* Learn more:
* - JSON Web Token: https://www.rfc-editor.org/rfc/rfc7519
* - JSON Web Signature: https://www.rfc-editor.org/rfc/rfc7515
* - JSON Web Encryption: https://www.rfc-editor.org/rfc/rfc7516
*
* This module signs and verifies compact JWTs with HMAC, RSA, RSASSA-PSS, and
* ECDSA algorithms, and encrypts or decrypts compact JWE payloads with direct
* symmetric keys or RSA-OAEP key wrapping. Key inputs may be single JWKs, arrays
* of JWKs, or JWKS containers; verification and decryption select compatible
* keys from token headers.
*
* The helpers validate common registered claims such as issuer, audience,
* subject, expiration, not-before, token type, JWT ID, required claims, and
* maximum token age when options request them. They do not fetch remote JWKS
* documents or implement application authorization policy. JWE support is the
* compact serialization with AES-GCM content encryption and `dir`,
* `RSA-OAEP`, or `RSA-OAEP-256` key management; JSON serialization,
* ECDH-ES, PBES2, CBC-HS, compression, and additional OAEP variants are
* intentionally outside this release baseline.
*
* @example
* ```ts no_run
* import { jwkFromSecret } from 'fino:security/jwk';
* import { jwtSign, jwtVerify } from 'fino:security/jwt';
*
* const key = jwkFromSecret(sessionSecret, 'HS256', 'current');
* const token = await jwtSign({ sub: 'user-123' }, key, {
*   algorithm: 'HS256',
*   expiresIn: 900,
* });
* const { payload } = await jwtVerify(token, key, { clockTolerance: 30 });
* ```
*/
import { base64urlDecode, base64urlEncode, base64urlJson, parseBase64urlJson, toBytes, utf8 } from '../internal/security/encoding.ts';
import { randomBytes } from './random.ts';
import { exportPublicJwk, importJwk, selectJwk, type JsonWebKeyLike, type JsonWebKeySet } from './jwk.ts';
/**
* Supported compact JWS algorithms.
*
* `none` is intentionally unsupported. HMAC algorithms require `oct` keys, RSA
* algorithms require RSA keys, and ECDSA algorithms require EC keys with a
* compatible curve.
*
* ```ts no_run
* import type { JwtAlgorithm } from 'fino:security/jwt';
*
* const algorithm: JwtAlgorithm = 'HS256';
* ```
*/
export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'ES512';
/**
* Supported compact JWE key-management algorithms.
*
* `dir` uses the supplied symmetric key directly as the content-encryption key.
* RSA-OAEP variants wrap a fresh content-encryption key for each token.
*
* ```ts no_run
* import type { JweAlgorithm } from 'fino:security/jwt';
*
* const algorithm: JweAlgorithm = 'RSA-OAEP-256';
* ```
*/
export type JweAlgorithm = 'dir' | 'RSA-OAEP' | 'RSA-OAEP-256';
/**
* Supported compact JWE content-encryption algorithms.
*
* `A128GCM` uses a 16-byte content-encryption key; `A256GCM` uses 32 bytes.
*
* ```ts no_run
* import type { JweEncryption } from 'fino:security/jwt';
*
* const encryption: JweEncryption = 'A256GCM';
* ```
*/
export type JweEncryption = 'A128GCM' | 'A256GCM';
/**
* Key input accepted by verification and decryption helpers.
*
* A single JWK is used directly. Arrays and JWKS containers are searched by
* header `kid` and `alg`, returning the first matching key or throwing when no
* key matches.
*
* ```ts no_run
* import type { JwtKeyInput } from 'fino:security/jwt';
*
* const keys: JwtKeyInput = { keys: [{ kty: 'oct', kid: 'current', k: 'secret' }] };
* ```
*/
export type JwtKeyInput = JsonWebKeyLike | JsonWebKeySet | JsonWebKeyLike[];
/**
* Options for signing a compact JWT.
*
* The algorithm is required. `iat` is added by default, and `expiresIn` or
* `notBefore` add relative `exp` and `nbf` claims based on the current Unix
* time in seconds.
*
* ```ts no_run
* import type { JwtSignOptions } from 'fino:security/jwt';
*
* const options: JwtSignOptions = { algorithm: 'HS256', expiresIn: 3600 };
* ```
*/
export interface JwtSignOptions {
  /**
  * JWS signing algorithm.
  *
  * The key must be compatible with the selected algorithm. `none` is not part
  * of this type and is rejected defensively at runtime.
  *
  * ```ts no_run
  * import type { JwtSignOptions } from 'fino:security/jwt';
  *
  * const options: JwtSignOptions = { algorithm: 'RS256' };
  * ```
  */
  algorithm: JwtAlgorithm;
  /**
  * Additional protected header fields.
  *
  * These fields are merged after the default `{ typ: 'JWT', alg }`, so they
  * can add values such as `kid`. Avoid overriding `alg`.
  *
  * ```ts no_run
  * import type { JwtSignOptions } from 'fino:security/jwt';
  *
  * const options: JwtSignOptions = { algorithm: 'HS256', header: { kid: 'current' } };
  * ```
  */
  header?: Record<string, unknown>;
  /**
  * Lifetime in seconds from signing time.
  *
  * When provided, `exp` is set to `now + expiresIn`. Omit it to leave the JWT
  * without an expiration claim.
  *
  * ```ts no_run
  * import type { JwtSignOptions } from 'fino:security/jwt';
  *
  * const options: JwtSignOptions = { algorithm: 'HS256', expiresIn: 900 };
  * ```
  */
  expiresIn?: number;
  /**
  * Delay in seconds before the JWT becomes valid.
  *
  * When provided, `nbf` is set to `now + notBefore`.
  *
  * ```ts no_run
  * import type { JwtSignOptions } from 'fino:security/jwt';
  *
  * const options: JwtSignOptions = { algorithm: 'HS256', notBefore: 30 };
  * ```
  */
  notBefore?: number;
  /**
  * Issued-at claim value, or `false` to omit `iat`.
  *
  * Defaults to the current Unix time in seconds. Numeric values are used as-is.
  *
  * ```ts no_run
  * import type { JwtSignOptions } from 'fino:security/jwt';
  *
  * const options: JwtSignOptions = { algorithm: 'HS256', issuedAt: false };
  * ```
  */
  issuedAt?: number | false;
}
/**
* Claim checks and clock controls used during JWT verification.
*
* All supplied checks must pass after signature verification. Failures throw
* errors from `jwtVerify()` rather than returning `null`.
*
* ```ts no_run
* import type { JwtVerifyOptions } from 'fino:security/jwt';
*
* const options: JwtVerifyOptions = { issuer: 'https://issuer.example', audience: 'api' };
* ```
*/
export interface JwtVerifyOptions {
  /**
  * Expected `aud` claim.
  *
  * A string or any value in the provided list may match. JWT payload `aud` can
  * be a string or array of strings.
  *
  * ```ts no_run
  * import type { JwtVerifyOptions } from 'fino:security/jwt';
  *
  * const options: JwtVerifyOptions = { audience: ['api', 'admin'] };
  * ```
  */
  audience?: string | string[];
  /**
  * Expected `iss` claim.
  *
  * When supplied, payload `iss` must be exactly equal or verification throws.
  *
  * ```ts no_run
  * import type { JwtVerifyOptions } from 'fino:security/jwt';
  *
  * const options: JwtVerifyOptions = { issuer: 'https://issuer.example' };
  * ```
  */
  issuer?: string;
  /**
  * Expected `sub` claim.
  *
  * When supplied, payload `sub` must be exactly equal or verification throws.
  *
  * ```ts no_run
  * import type { JwtVerifyOptions } from 'fino:security/jwt';
  *
  * const options: JwtVerifyOptions = { subject: 'user-123' };
  * ```
  */
  subject?: string;
  /**
  * Allowed protected-header algorithms.
  *
  * When supplied, the token `alg` must be one of these values before key
  * selection and signature verification.
  *
  * ```ts no_run
  * const options: JwtVerifyOptions = { algorithms: ['RS256'] };
  * ```
  */
  algorithms?: JwtAlgorithm[];
  /**
  * Required payload claim names.
  *
  * Each listed claim must be present in the verified payload. Values may be
  * any JSON value except `undefined`.
  *
  * ```ts no_run
  * const options: JwtVerifyOptions = { requiredClaims: ['sub', 'iat'] };
  * ```
  */
  requiredClaims?: string[];
  /**
  * Maximum age in seconds since the `iat` claim.
  *
  * Tokens without numeric `iat` fail when this option is supplied.
  *
  * ```ts no_run
  * const options: JwtVerifyOptions = { maxTokenAge: 300 };
  * ```
  */
  maxTokenAge?: number;
  /**
  * Expected JOSE `typ` protected-header value.
  *
  * A string or any value in the provided list may match.
  *
  * ```ts no_run
  * const options: JwtVerifyOptions = { typ: 'JWT' };
  * ```
  */
  typ?: string | string[];
  /**
  * Expected `jti` claim.
  *
  * A string or any value in the provided list may match. Replay prevention is
  * application policy; this only compares the claim value.
  *
  * ```ts no_run
  * const options: JwtVerifyOptions = { jwtId: 'token-123' };
  * ```
  */
  jwtId?: string | string[];
  /**
  * Clock tolerance in seconds for `exp` and `nbf`.
  *
  * Defaults to `0`. Positive values allow small clock skew during validation.
  *
  * ```ts no_run
  * import type { JwtVerifyOptions } from 'fino:security/jwt';
  *
  * const options: JwtVerifyOptions = { clockTolerance: 30 };
  * ```
  */
  clockTolerance?: number;
  /**
  * Current Unix time in seconds for claim checks.
  *
  * Defaults to the current wall clock. Supplying it is useful for tests.
  *
  * ```ts no_run
  * import type { JwtVerifyOptions } from 'fino:security/jwt';
  *
  * const options: JwtVerifyOptions = { now: 1_700_000_000 };
  * ```
  */
  now?: number;
}
/**
* Options for encrypting a compact JWE with a JSON payload.
*
* The algorithm controls key management and `encryption` controls AES-GCM
* content encryption. Additional header fields are protected by authenticated
* encryption.
*
* ```ts no_run
* import type { JwtEncryptOptions } from 'fino:security/jwt';
*
* const options: JwtEncryptOptions = { algorithm: 'dir', encryption: 'A256GCM' };
* ```
*/
export interface JwtEncryptOptions {
  /**
  * JWE key-management algorithm.
  *
  * `dir` requires an `oct` JWK whose decoded `k` length matches `encryption`.
  * RSA-OAEP variants use a public RSA key to encrypt a fresh CEK.
  *
  * ```ts no_run
  * import type { JwtEncryptOptions } from 'fino:security/jwt';
  *
  * const options: JwtEncryptOptions = { algorithm: 'RSA-OAEP-256', encryption: 'A256GCM' };
  * ```
  */
  algorithm: JweAlgorithm;
  /**
  * JWE content-encryption algorithm.
  *
  * `A128GCM` requires a 16-byte CEK and `A256GCM` requires a 32-byte CEK.
  *
  * ```ts no_run
  * import type { JwtEncryptOptions } from 'fino:security/jwt';
  *
  * const options: JwtEncryptOptions = { algorithm: 'dir', encryption: 'A128GCM' };
  * ```
  */
  encryption: JweEncryption;
  /**
  * Additional protected JWE header fields.
  *
  * Fields are merged after `typ`, `alg`, and `enc`, so use this for values
  * such as `kid`. Avoid overriding algorithm fields.
  *
  * ```ts no_run
  * import type { JwtEncryptOptions } from 'fino:security/jwt';
  *
  * const options: JwtEncryptOptions = { algorithm: 'dir', encryption: 'A256GCM', header: { kid: 'enc-1' } };
  * ```
  */
  header?: Record<string, unknown>;
}
/**
* Decoded compact JWT or JWE result.
*
* Verification and decryption return the protected header and JSON payload as
* plain records. Claim validation is performed only by `jwtVerify()`.
*
* ```ts no_run
* import type { JwtResult } from 'fino:security/jwt';
*
* const result: JwtResult = { header: { alg: 'HS256' }, payload: { sub: 'user-123' } };
* ```
*/
export interface JwtResult {
  /**
  * Decoded protected header.
  *
  * Values are parsed from JSON and are not narrowed beyond the record shape.
  *
  * ```ts no_run
  * import type { JwtResult } from 'fino:security/jwt';
  *
  * const result: JwtResult = { header: { alg: 'HS256' }, payload: {} };
  * const alg = result.header.alg;
  * ```
  */
  header: Record<string, unknown>;
  /**
  * Decoded JSON payload.
  *
  * Values are parsed from JSON. JWT registered claims remain in this object
  * after verification.
  *
  * ```ts no_run
  * import type { JwtResult } from 'fino:security/jwt';
  *
  * const result: JwtResult = { header: { alg: 'HS256' }, payload: { sub: 'user-123' } };
  * const sub = result.payload.sub;
  * ```
  */
  payload: Record<string, unknown>;
}
function hashForJwtAlg(alg: string): string {
  if (alg.endsWith('384')) return 'SHA-384';
  if (alg.endsWith('512')) return 'SHA-512';
  return 'SHA-256';
}
function rejectUnsupportedCrit(header: Record<string, unknown>): void {
  if (header.crit === undefined) return;
  if (Array.isArray(header.crit) && header.crit.length === 0) return;
  throw new Error('Unsupported JOSE crit header');
}
function keyMatchesPurpose(key: JsonWebKeyLike, purpose?: {
  use?: string;
  key_ops?: string[];
}): boolean {
  if (purpose?.use !== undefined && key.use !== undefined && key.use !== purpose.use) return false;
  if (purpose?.key_ops && Array.isArray(key.key_ops)) {
    for (const op of purpose.key_ops) {
      if ((key.key_ops as unknown[]).includes(op)) continue;
      if (op === 'verify' && key.kty !== 'oct' && (key.key_ops as unknown[]).includes('sign')) continue;
      return false;
    }
  }
  return true;
}
function keyFor(input: JwtKeyInput, header: Record<string, unknown>, alg: string, purpose?: {
  use?: string;
  key_ops?: string[];
}): JsonWebKeyLike {
  if (Array.isArray(input) || 'keys' in input) {
    const keys = Array.isArray(input) ? input : input.keys;
    const selected = keys.find((key) => {
      const candidate = selectJwk([key], {
        kid: typeof header.kid === 'string' ? header.kid : undefined,
        alg
      });
      return candidate !== undefined && keyMatchesPurpose(candidate, purpose);
    });
    if (!selected) throw new Error('No matching JWK found');
    return selected;
  }
  return input as JsonWebKeyLike;
}
function signAlgorithm(alg: JwtAlgorithm): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  if (alg.startsWith('PS')) return {
    name: 'RSA-PSS',
    saltLength: Number(alg.slice(2)) / 8
  };
  if (alg.startsWith('ES')) return {
    name: 'ECDSA',
    hash: hashForJwtAlg(alg)
  };
  return { name: alg.startsWith('RS') ? 'RSASSA-PKCS1-v1_5' : 'HMAC' };
}
function importUsages(alg: string, op: 'sign' | 'verify'): KeyUsage[] {
  if (alg.startsWith('HS')) return [op];
  return [op];
}
function optionList(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value : [value];
}
function validateJwtHeader(header: Record<string, unknown>, alg: string, options: JwtVerifyOptions): void {
  if (options.algorithms !== undefined && !options.algorithms.includes(alg as JwtAlgorithm)) {
    throw new Error('JWT algorithm not allowed');
  }
  const typ = optionList(options.typ);
  if (typ !== null && !typ.includes(String(header.typ ?? ''))) {
    throw new Error('JWT typ mismatch');
  }
}
function validateClaims(payload: Record<string, unknown>, options: JwtVerifyOptions): void {
  const now = options.now ?? Math.floor(Date.now() / 1e3);
  const tolerance = options.clockTolerance ?? 0;
  if (typeof payload.exp === 'number' && now > payload.exp + tolerance) throw new Error('JWT expired');
  if (typeof payload.nbf === 'number' && now + tolerance < payload.nbf) throw new Error('JWT not active');
  if (options.issuer !== undefined && payload.iss !== options.issuer) throw new Error('JWT issuer mismatch');
  if (options.subject !== undefined && payload.sub !== options.subject) throw new Error('JWT subject mismatch');
  for (const claim of options.requiredClaims ?? []) {
    if (payload[claim] === undefined) throw new Error(`JWT required claim missing: ${claim}`);
  }
  const jwtIds = optionList(options.jwtId);
  if (jwtIds !== null && !jwtIds.includes(String(payload.jti ?? ''))) throw new Error('JWT jti mismatch');
  if (options.maxTokenAge !== undefined) {
    if (typeof payload.iat !== 'number') throw new Error('JWT iat required for maxTokenAge');
    if (now > payload.iat + options.maxTokenAge + tolerance) throw new Error('JWT too old');
  }
  if (options.audience !== undefined) {
    const expected = Array.isArray(options.audience) ? options.audience : [options.audience];
    const actual = Array.isArray(payload.aud) ? payload.aud.map(String) : typeof payload.aud === 'string' ? [payload.aud] : [];
    if (!expected.some((audience) => actual.includes(audience))) throw new Error('JWT audience mismatch');
  }
}
/**
* Sign a compact JWS/JWT.
*
* Adds `iat` by default and optional relative `exp` and `nbf` claims. The
* returned string is `header.payload.signature`. Key import, unsupported
* algorithms, and crypto signing failures reject the promise.
*
* ```ts no_run
* import { jwtSign } from 'fino:security/jwt';
* import { jwkFromSecret } from 'fino:security/jwk';
*
* const key = jwkFromSecret('shared-secret', 'HS256');
* const token = await jwtSign({ sub: 'user-123' }, key, { algorithm: 'HS256' });
* ```
*/
export async function jwtSign(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtSignOptions): Promise<string> {
  const alg = options.algorithm;
  if (alg === 'none') throw new Error('JWT alg "none" is not supported');
  const now = Math.floor(Date.now() / 1e3);
  const body: Record<string, unknown> = {
    ...payload,
    ...options.issuedAt === false ? {} : { iat: options.issuedAt ?? now },
    ...options.expiresIn !== undefined ? { exp: now + options.expiresIn } : {},
    ...options.notBefore !== undefined ? { nbf: now + options.notBefore } : {}
  };
  const header = {
    typ: 'JWT',
    alg,
    ...options.header
  };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(body)}`;
  const cryptoKey = await importJwk({
    ...key,
    alg
  }, importUsages(alg, 'sign'));
  // WebCrypto ECDSA signatures are already the JOSE raw r||s form; no
  // DER conversion happens here. (A former DER-shaped signer left a
  // heuristic converter behind that misfired whenever r's first random
  // byte happened to be 0x30 — a 1-in-256 signing failure.)
  const signature = new Uint8Array(await crypto.subtle.sign(signAlgorithm(alg), cryptoKey, toBytes(signingInput)) as ArrayBuffer);
  return `${signingInput}.${base64urlEncode(signature)}`;
}
/**
* Verify a compact JWS/JWT and return decoded header and payload.
*
* Throws for malformed compact tokens, unsupported algorithms, missing matching
* keys, failed signatures, and failed claim checks. The helper selects keys
* from JWKS input using protected header `kid` and `alg`.
*
* ```ts no_run
* import { jwtSign, jwtVerify } from 'fino:security/jwt';
* import { jwkFromSecret } from 'fino:security/jwk';
*
* const key = jwkFromSecret('shared-secret', 'HS256');
* const token = await jwtSign({ sub: 'user-123' }, key, { algorithm: 'HS256' });
* const result = await jwtVerify(token, key, { subject: 'user-123' });
* ```
*/
export async function jwtVerify(token: string, keys: JwtKeyInput, options: JwtVerifyOptions = {}): Promise<JwtResult> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid compact JWT');
  const header = parseBase64urlJson(parts[0]!);
  const payload = parseBase64urlJson(parts[1]!);
  rejectUnsupportedCrit(header);
  const alg = String(header.alg ?? '');
  if (!alg || alg === 'none') throw new Error('Unsupported JWT algorithm');
  validateJwtHeader(header, alg, options);
  const selectedKey = keyFor(keys, header, alg, {
    use: 'sig',
    key_ops: ['verify']
  });
  const key = selectedKey.kty === 'oct' ? selectedKey : await exportPublicJwk(selectedKey);
  const cryptoKey = await importJwk({
    ...key,
    alg
  }, importUsages(alg, 'verify'));
  const signature = base64urlDecode(parts[2]!);
  const ok = await crypto.subtle.verify(signAlgorithm(alg as JwtAlgorithm), cryptoKey, signature, toBytes(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('JWT signature verification failed');
  validateClaims(payload, options);
  return {
    header,
    payload
  };
}
async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, {
    name: 'AES-GCM',
    length: bytes.byteLength * 8
  }, false, usages);
}
function cekLength(enc: JweEncryption): number {
  return enc === 'A128GCM' ? 16 : 32;
}
function rsaOaepHash(alg: JweAlgorithm): string {
  return alg === 'RSA-OAEP' ? 'SHA-1' : 'SHA-256';
}
/**
* Encrypt a compact JWE with a JSON payload using AES-GCM content encryption.
*
* The returned string is the five-part compact JWE form. With `dir`, the
* symmetric key is used directly as the CEK. With RSA-OAEP, a fresh CEK is
* generated and encrypted for the recipient. Key import and crypto failures
* reject the promise.
*
* ```ts no_run
* import { jwtEncrypt } from 'fino:security/jwt';
* import { generateJwk } from 'fino:security/jwk';
*
* const key = await generateJwk({ kty: 'oct', alg: 'dir', length: 256 });
* const token = await jwtEncrypt({ sub: 'user-123' }, key, { algorithm: 'dir', encryption: 'A256GCM' });
* ```
*/
export async function jwtEncrypt(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtEncryptOptions): Promise<string> {
  const header = {
    typ: 'JWT',
    alg: options.algorithm,
    enc: options.encryption,
    ...options.header
  };
  const protectedHeader = base64urlJson(header);
  let cek: Uint8Array;
  let encryptedKey = new Uint8Array();
  if (options.algorithm === 'dir') {
    if (key.kty !== 'oct' || typeof key.k !== 'string') throw new Error('dir JWE requires an oct JWK');
    cek = base64urlDecode(key.k);
  } else {
    cek = randomBytes(cekLength(options.encryption));
    const publicKey = await importJwk({
      ...await exportPublicJwk(key),
      alg: options.algorithm
    }, ['encrypt']);
    encryptedKey = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, cek) as ArrayBuffer);
  }
  const iv = randomBytes(12);
  const aesKey = await importAesKey(cek, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: toBytes(protectedHeader),
    tagLength: 128
  }, aesKey, toBytes(JSON.stringify(payload))) as ArrayBuffer);
  const tagLength = 16;
  const ciphertext = encrypted.subarray(0, encrypted.length - tagLength);
  const tag = encrypted.subarray(encrypted.length - tagLength);
  return [
    protectedHeader,
    base64urlEncode(encryptedKey),
    base64urlEncode(iv),
    base64urlEncode(ciphertext),
    base64urlEncode(tag)
  ].join('.');
}
/**
* Decrypt a compact JWE and return decoded header and JSON payload.
*
* Throws for malformed compact tokens, missing matching keys, CEK length
* mismatches, AES-GCM authentication failures, and JSON decode failures. The
* thrown error message is prefixed with `JWE decryption failed:` for inner
* decryption errors.
*
* ```ts no_run
* import { jwtDecrypt, jwtEncrypt } from 'fino:security/jwt';
* import { generateJwk } from 'fino:security/jwk';
*
* const key = await generateJwk({ kty: 'oct', alg: 'dir', length: 256 });
* const token = await jwtEncrypt({ sub: 'user-123' }, key, { algorithm: 'dir', encryption: 'A256GCM' });
* const result = await jwtDecrypt(token, key);
* ```
*/
export async function jwtDecrypt(token: string, keys: JwtKeyInput): Promise<JwtResult> {
  const parts = token.split('.');
  if (parts.length !== 5) throw new Error('Invalid compact JWE');
  const header = parseBase64urlJson(parts[0]!);
  rejectUnsupportedCrit(header);
  const alg = String(header.alg ?? '') as JweAlgorithm;
  const enc = String(header.enc ?? '') as JweEncryption;
  const key = keyFor(keys, header, alg, {
    use: 'enc',
    key_ops: ['decrypt']
  });
  try {
    let cek: Uint8Array;
    if (alg === 'dir') {
      if (key.kty !== 'oct' || typeof key.k !== 'string') throw new Error('dir JWE requires an oct JWK');
      cek = base64urlDecode(key.k);
    } else {
      const privateKey = await importJwk({
        ...key,
        alg
      }, ['decrypt']);
      cek = new Uint8Array(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, base64urlDecode(parts[1]!)) as ArrayBuffer);
    }
    if (cek.byteLength !== cekLength(enc)) throw new Error('JWE content encryption key length mismatch');
    const aesKey = await importAesKey(cek, ['decrypt']);
    const ciphertext = base64urlDecode(parts[3]!);
    const tag = base64urlDecode(parts[4]!);
    const encrypted = new Uint8Array(ciphertext.byteLength + tag.byteLength);
    encrypted.set(ciphertext);
    encrypted.set(tag, ciphertext.byteLength);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: base64urlDecode(parts[2]!),
      additionalData: toBytes(parts[0]!),
      tagLength: 128
    }, aesKey, encrypted) as ArrayBuffer);
    return {
      header,
      payload: JSON.parse(utf8(plaintext))
    };
  } catch (err) {
    throw new Error('JWE decryption failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}
