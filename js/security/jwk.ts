/**
 * fino:security/jwk - JSON Web Key generation, import, export, and selection.
 *
 * JSON Web Key specification: https://www.rfc-editor.org/rfc/rfc7517
 *
 * Use this module when JOSE helpers need keys in JWK or JWKS form. It can
 * generate symmetric, RSA, and EC keys, import JWKs into WebCrypto keys,
 * export public key material, compute RFC 7638 thumbprints, and select keys
 * from a key set by `kid`, `alg`, `kty`, and `use`.
 *
 * Private JWK fields and symmetric `k` values are secret material. Keep them
 * out of logs and client responses. For public discovery endpoints, export or
 * publish only public JWK fields.
 *
 * @example
 * ```ts no_run
 * import {
 *   generateJwk,
 *   exportPublicJwk,
 *   jwkThumbprint,
 * } from 'fino:security/jwk';
 *
 * const privateKey = await generateJwk({ kty: 'RSA', alg: 'RS256', kid: 'signing-1' });
 * const publicKey = await exportPublicJwk(privateKey);
 * const thumbprint = await jwkThumbprint(publicKey);
 * ```
 */

import { digest } from '../internal/openssl.ts';
import { base64urlDecode, base64urlEncode, sha256Base64url, toBytes } from '../internal/security/encoding.ts';
import { randomBytes } from './random.ts';

/**
 * JSON Web Key object accepted by the security helpers.
 *
 * The map follows the JOSE JWK shape and may contain public, private, or
 * symmetric key material depending on `kty`. Callers are responsible for
 * keeping private fields such as `d` and symmetric `k` values secret.
 *
 * ```ts no_run
 * import type { JsonWebKeyLike } from 'fino:security/jwk';
 *
 * const key: JsonWebKeyLike = { kty: 'oct', k: 'base64url-secret', alg: 'HS256' };
 * ```
 */
export type JsonWebKeyLike = Record<string, unknown>;

/**
 * JSON Web Key Set container.
 *
 * The `keys` array is searched in order by `selectJwk()` and JWT/JWE helpers.
 * Use `kid` values when multiple keys can validate the same algorithm.
 *
 * ```ts no_run
 * import type { JsonWebKeySet } from 'fino:security/jwk';
 *
 * const jwks: JsonWebKeySet = { keys: [{ kty: 'oct', k: 'base64url-secret', kid: 'current' }] };
 * ```
 */
export interface JsonWebKeySet {
  /**
   * Keys included in the set.
   *
   * Selection returns the first matching key. Empty arrays are valid but cannot
   * satisfy a selector.
   *
   * ```ts no_run
   * import type { JsonWebKeySet } from 'fino:security/jwk';
   *
   * const jwks: JsonWebKeySet = { keys: [] };
   * ```
   */
  keys: JsonWebKeyLike[];
}

/**
 * Options for generating symmetric, RSA, or EC JSON Web Keys.
 *
 * Defaults depend on `kty`: `oct` uses a 256-bit HMAC key, `RSA` uses a
 * 2048-bit modulus, and `EC` uses `P-256`. Generated keys are extractable so
 * they can be returned as JWK objects; protect private or symmetric output.
 *
 * ```ts no_run
 * import type { GenerateJwkOptions } from 'fino:security/jwk';
 *
 * const options: GenerateJwkOptions = { kty: 'RSA', alg: 'RS256', kid: 'signing-1' };
 * ```
 */
export interface GenerateJwkOptions {
  /**
   * Key type to generate.
   *
   * Use `oct` for shared secrets, `RSA` for RSA signatures or RSA-OAEP, and
   * `EC` for ECDSA. Unsupported values are rejected by the type and runtime
   * algorithm selection.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'oct' };
   * ```
   */
  kty: 'oct' | 'RSA' | 'EC';
  /**
   * Optional JOSE algorithm identifier.
   *
   * The algorithm influences hash selection and generated key usages. If
   * omitted, helpers choose defaults such as SHA-256 based on key type.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'EC', alg: 'ES256' };
   * ```
   */
  alg?: string;
  /**
   * Optional key identifier copied into the generated JWK.
   *
   * Use stable `kid` values for rotation and JWKS selection.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'RSA', kid: '2026-06' };
   * ```
   */
  kid?: string;
  /**
   * Optional JWK `use` value.
   *
   * Common values include `sig` and `enc`. The helper copies it without
   * validation.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'RSA', use: 'sig' };
   * ```
   */
  use?: string;
  /**
   * Optional JWK `key_ops` list.
   *
   * The list is copied into the returned JWK. WebCrypto generation usages are
   * still inferred from `kty` and `alg`.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'oct', key_ops: ['sign', 'verify'] };
   * ```
   */
  key_ops?: string[];
  /**
   * Symmetric key length in bits for `oct` keys.
   *
   * Defaults to `256`. The value is divided by 8 to generate random key bytes.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'oct', length: 512 };
   * ```
   */
  length?: number;
  /**
   * Named curve for `EC` keys.
   *
   * Defaults to `P-256`. It is ignored for non-EC key generation.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'EC', namedCurve: 'P-384' };
   * ```
   */
  namedCurve?: 'P-256' | 'P-384' | 'P-521';
  /**
   * RSA modulus length in bits.
   *
   * Defaults to `2048`. Larger values increase signing and decryption cost.
   *
   * ```ts no_run
   * import type { GenerateJwkOptions } from 'fino:security/jwk';
   *
   * const options: GenerateJwkOptions = { kty: 'RSA', modulusLength: 3072 };
   * ```
   */
  modulusLength?: number;
}

/**
 * Criteria used to select a key from a JWKS or key array.
 *
 * All supplied fields must match. Missing fields on a candidate are permissive
 * for `alg`, `use`, and `key_ops`, so include `kid` when exact key selection is
 * important.
 *
 * ```ts no_run
 * import type { JwkSelector } from 'fino:security/jwk';
 *
 * const selector: JwkSelector = { kid: 'current', alg: 'RS256' };
 * ```
 */
export interface JwkSelector {
  /**
   * Required key identifier.
   *
   * When supplied, candidate keys must have the same `kid`.
   *
   * ```ts no_run
   * import type { JwkSelector } from 'fino:security/jwk';
   *
   * const selector: JwkSelector = { kid: 'current' };
   * ```
   */
  kid?: string;
  /**
   * Required algorithm when the candidate declares `alg`.
   *
   * Keys without an `alg` field are allowed to match, which supports generic
   * keys in a JWKS.
   *
   * ```ts no_run
   * import type { JwkSelector } from 'fino:security/jwk';
   *
   * const selector: JwkSelector = { alg: 'HS256' };
   * ```
   */
  alg?: string;
  /**
   * Required JWK key type.
   *
   * Use it to distinguish symmetric, RSA, and EC keys in mixed sets.
   *
   * ```ts no_run
   * import type { JwkSelector } from 'fino:security/jwk';
   *
   * const selector: JwkSelector = { kty: 'RSA' };
   * ```
   */
  kty?: string;
  /**
   * Required JWK `use` value when the candidate declares `use`.
   *
   * Keys without `use` are allowed to match.
   *
   * ```ts no_run
   * import type { JwkSelector } from 'fino:security/jwk';
   *
   * const selector: JwkSelector = { use: 'sig' };
   * ```
   */
  use?: string;
  /**
   * Required key operations when the candidate declares `key_ops`.
   *
   * Every requested operation must be present in the candidate list. Keys
   * without `key_ops` are allowed to match.
   *
   * ```ts no_run
   * import type { JwkSelector } from 'fino:security/jwk';
   *
   * const selector: JwkSelector = { key_ops: ['verify'] };
   * ```
   */
  key_ops?: string[];
}

function hashForAlg(alg: string | undefined): string {
  const suffix = (alg ?? 'HS256').slice(-3);
  if (suffix === '384') return 'SHA-384';
  if (suffix === '512') return 'SHA-512';
  return 'SHA-256';
}

function algorithmForJwk(jwk: JsonWebKeyLike, usages: string[]): AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | AesKeyAlgorithm {
  const alg = typeof jwk.alg === 'string' ? jwk.alg : undefined;
  if (jwk.kty === 'oct') {
    if (alg === 'dir' || alg?.startsWith('A') || usages.some((usage) => usage === 'encrypt' || usage === 'decrypt' || usage === 'wrapKey' || usage === 'unwrapKey')) {
      return { name: 'AES-GCM', length: base64urlDecode(String(jwk.k ?? '')).byteLength * 8 };
    }
    return { name: 'HMAC', hash: hashForAlg(alg) };
  }
  if (jwk.kty === 'RSA') {
    if (alg?.startsWith('PS')) return { name: 'RSA-PSS', hash: hashForAlg(alg) };
    if (alg?.startsWith('RSA-OAEP')) return { name: 'RSA-OAEP', hash: alg === 'RSA-OAEP' ? 'SHA-1' : hashForAlg(alg) };
    return { name: 'RSASSA-PKCS1-v1_5', hash: hashForAlg(alg) };
  }
  if (jwk.kty === 'EC') return { name: 'ECDSA', namedCurve: String(jwk.crv ?? 'P-256') };
  throw new Error(`Unsupported JWK kty: ${String(jwk.kty)}`);
}

function generationAlgorithm(options: GenerateJwkOptions): AlgorithmIdentifier | RsaHashedKeyGenParams | EcKeyGenParams | HmacKeyGenParams {
  if (options.kty === 'oct') return { name: 'HMAC', hash: hashForAlg(options.alg), length: options.length ?? 256 };
  if (options.kty === 'RSA') {
    const alg = options.alg?.startsWith('PS') ? 'RSA-PSS' : options.alg?.startsWith('RSA-OAEP') ? 'RSA-OAEP' : 'RSASSA-PKCS1-v1_5';
    return {
      name: alg,
      hash: options.alg === 'RSA-OAEP' ? 'SHA-1' : hashForAlg(options.alg),
      modulusLength: options.modulusLength ?? 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    };
  }
  return { name: 'ECDSA', namedCurve: options.namedCurve ?? 'P-256' };
}

function defaultUsages(options: GenerateJwkOptions): KeyUsage[] {
  if (options.kty === 'oct' && (options.alg === 'dir' || options.alg?.startsWith('A'))) return ['encrypt', 'decrypt'];
  if (options.alg?.startsWith('RSA-OAEP')) return ['encrypt', 'decrypt'];
  return ['sign', 'verify'];
}

/**
 * Generate an extractable JSON Web Key using the runtime crypto backend.
 *
 * For `oct` keys the helper returns random key bytes directly as a symmetric
 * JWK. For RSA and EC keys it generates a WebCrypto key pair and exports the
 * private key JWK, including private fields. Unsupported key options or crypto
 * backend failures reject the promise.
 *
 * ```ts no_run
 * import { generateJwk } from 'fino:security/jwk';
 *
 * const key = await generateJwk({ kty: 'RSA', alg: 'RS256', kid: 'signing-1' });
 * ```
 */
export async function generateJwk(options: GenerateJwkOptions): Promise<JsonWebKeyLike> {
  if (options.kty === 'oct') {
    const keyBytes = randomBytes((options.length ?? 256) / 8);
    return {
      kty: 'oct',
      k: base64urlEncode(keyBytes),
      ...(options.alg ? { alg: options.alg } : {}),
      ...(options.kid ? { kid: options.kid } : {}),
      ...(options.use ? { use: options.use } : {}),
      ...(options.key_ops ? { key_ops: options.key_ops } : {}),
    };
  }

  const generated = await crypto.subtle.generateKey(generationAlgorithm(options), true, defaultUsages(options));
  const privateKey = (generated as CryptoKeyPair).privateKey ?? generated as CryptoKey;
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return {
    ...(jwk as JsonWebKeyLike),
    ...(options.alg ? { alg: options.alg } : {}),
    ...(options.kid ? { kid: options.kid } : {}),
    ...(options.use ? { use: options.use } : {}),
    ...(options.key_ops ? { key_ops: options.key_ops } : {}),
  };
}

/**
 * Import a JWK as a WebCrypto `CryptoKey` for the requested usages.
 *
 * The algorithm is inferred from `kty`, `alg`, and requested usages. The
 * returned key is extractable. Unsupported key types, malformed JWK fields, or
 * incompatible usages reject the promise.
 *
 * ```ts no_run
 * import { generateJwk, importJwk } from 'fino:security/jwk';
 *
 * const jwk = await generateJwk({ kty: 'oct', alg: 'HS256' });
 * const key = await importJwk(jwk, ['sign']);
 * ```
 */
export async function importJwk(jwk: JsonWebKeyLike, usages: string[] = []): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, algorithmForJwk(jwk, usages), true, usages as KeyUsage[]);
}

/**
 * Export a public JWK from a JWK or `CryptoKey`.
 *
 * Private RSA/EC fields and symmetric `k` material are removed from the
 * returned object. Passing a symmetric JWK therefore returns metadata without
 * usable key bytes. Crypto export failures reject the promise.
 *
 * ```ts no_run
 * import { exportPublicJwk, generateJwk } from 'fino:security/jwk';
 *
 * const privateJwk = await generateJwk({ kty: 'RSA', alg: 'RS256' });
 * const publicJwk = await exportPublicJwk(privateJwk);
 * ```
 */
export async function exportPublicJwk(key: JsonWebKeyLike | CryptoKey): Promise<JsonWebKeyLike> {
  const jwk = key instanceof CryptoKey ? await crypto.subtle.exportKey('jwk', key) as JsonWebKeyLike : { ...key };
  const out: JsonWebKeyLike = { ...jwk };
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) delete out[field];
  return out;
}

/**
 * Compute an RFC 7638 SHA-256 thumbprint for a JWK-like object.
 *
 * The helper canonicalizes only the required public members for supported key
 * types: RSA uses `e`, `kty`, and `n`; EC uses `crv`, `kty`, `x`, and `y`; and
 * `oct` uses `k` and `kty`. Private fields and metadata such as `kid`, `use`,
 * `key_ops`, and `alg` are intentionally ignored. Missing required members or
 * unsupported `kty` values throw.
 *
 * ```ts no_run
 * import { generateJwk, jwkThumbprint } from 'fino:security/jwk';
 *
 * const jwk = await generateJwk({ kty: 'oct' });
 * const thumbprint = await jwkThumbprint(jwk);
 * ```
 */
export async function jwkThumbprint(jwk: JsonWebKeyLike): Promise<string> {
  const kty = String(jwk.kty ?? '');
  const fields =
    kty === 'RSA' ? ['e', 'kty', 'n'] :
    kty === 'EC' ? ['crv', 'kty', 'x', 'y'] :
    kty === 'oct' ? ['k', 'kty'] :
    null;
  if (fields === null) throw new Error(`Unsupported JWK kty for thumbprint: ${kty || '<missing>'}`);
  const canonical: Record<string, unknown> = {};
  for (const field of fields) {
    if (jwk[field] === undefined) throw new Error(`JWK thumbprint missing required member: ${field}`);
    canonical[field] = jwk[field];
  }
  return sha256Base64url(JSON.stringify(canonical));
}

/**
 * Select the first matching key from a JWKS or key array.
 *
 * Returns `undefined` when no candidate satisfies the selector. The search is
 * order-preserving, so put the preferred or current key first when several keys
 * could match. Candidate keys that omit `alg`, `use`, or `key_ops` are treated
 * as generic keys for that field and may match a selector that requests it.
 *
 * ```ts no_run
 * import { selectJwk } from 'fino:security/jwk';
 *
 * const key = selectJwk({ keys: [{ kid: 'current', kty: 'oct' }] }, { kid: 'current' });
 * ```
 */
export function selectJwk(jwks: JsonWebKeySet | JsonWebKeyLike[], selector: JwkSelector): JsonWebKeyLike | undefined {
  const keys = Array.isArray(jwks) ? jwks : jwks.keys;
  return keys.find((key) => {
    if (selector.kid !== undefined && key.kid !== selector.kid) return false;
    if (selector.alg !== undefined && key.alg !== undefined && key.alg !== selector.alg) return false;
    if (selector.kty !== undefined && key.kty !== selector.kty) return false;
    if (selector.use !== undefined && key.use !== undefined && key.use !== selector.use) return false;
    if (selector.key_ops && Array.isArray(key.key_ops)) {
      for (const op of selector.key_ops) if (!(key.key_ops as unknown[]).includes(op)) return false;
    }
    return true;
  });
}

/**
 * Build an `oct` JWK from a shared secret for HMAC or direct encryption use.
 *
 * String secrets are encoded as UTF-8 before base64url storage. The default
 * algorithm is `HS256`; pass `dir`, `A128GCM`, or `A256GCM` for direct JWE/AES
 * use when the secret length matches that algorithm's needs.
 *
 * ```ts no_run
 * import { jwkFromSecret } from 'fino:security/jwk';
 *
 * const jwk = jwkFromSecret('shared-secret', 'HS256', 'signing-1');
 * ```
 */
export function jwkFromSecret(secret: string | Uint8Array, alg = 'HS256', kid?: string): JsonWebKeyLike {
  return {
    kty: 'oct',
    k: base64urlEncode(typeof secret === 'string' ? toBytes(secret) : secret),
    alg,
    ...(kid ? { kid } : {}),
  };
}
