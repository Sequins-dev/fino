import { digest } from '../internal/openssl.mts';
import { base64urlDecode, base64urlEncode, sha256Base64url, toBytes } from '../internal/security/encoding.mts';
import { randomBytes } from './random.mts';

/** JSON Web Key object accepted by the security helpers. */
export type JsonWebKeyLike = Record<string, unknown>;

/** JSON Web Key Set container. */
export interface JsonWebKeySet {
  keys: JsonWebKeyLike[];
}

/** Options for generating symmetric, RSA, or EC JSON Web Keys. */
export interface GenerateJwkOptions {
  kty: 'oct' | 'RSA' | 'EC';
  alg?: string;
  kid?: string;
  use?: string;
  key_ops?: string[];
  length?: number;
  namedCurve?: 'P-256' | 'P-384' | 'P-521';
  modulusLength?: number;
}

/** Criteria used to select a key from a JWKS or key array. */
export interface JwkSelector {
  kid?: string;
  alg?: string;
  kty?: string;
  use?: string;
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

/** Generate an extractable JSON Web Key using the runtime crypto backend. */
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

/** Import a JWK as a WebCrypto `CryptoKey` for the requested usages. */
export async function importJwk(jwk: JsonWebKeyLike, usages: string[] = []): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, algorithmForJwk(jwk, usages), true, usages as KeyUsage[]);
}

/** Export a public JWK from a JWK or `CryptoKey`, stripping private or symmetric key material. */
export async function exportPublicJwk(key: JsonWebKeyLike | CryptoKey): Promise<JsonWebKeyLike> {
  const jwk = key instanceof CryptoKey ? await crypto.subtle.exportKey('jwk', key) as JsonWebKeyLike : { ...key };
  const out: JsonWebKeyLike = { ...jwk };
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) delete out[field];
  return out;
}

/** Compute a stable SHA-256 thumbprint for a JWK-like object. */
export async function jwkThumbprint(jwk: JsonWebKeyLike): Promise<string> {
  const fields = Object.keys(jwk)
    .filter((key) => jwk[key] !== undefined && key !== 'kid' && key !== 'use' && key !== 'key_ops' && key !== 'alg')
    .sort();
  const canonical: Record<string, unknown> = {};
  for (const field of fields) canonical[field] = jwk[field];
  return sha256Base64url(JSON.stringify(canonical));
}

/** Select the first matching key from a JWKS or key array, returning `undefined` if none matches. */
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

/** Build an `oct` JWK from a shared secret for HMAC or direct encryption use. */
export function jwkFromSecret(secret: string | Uint8Array, alg = 'HS256', kid?: string): JsonWebKeyLike {
  return {
    kty: 'oct',
    k: base64urlEncode(typeof secret === 'string' ? toBytes(secret) : secret),
    alg,
    ...(kid ? { kid } : {}),
  };
}
