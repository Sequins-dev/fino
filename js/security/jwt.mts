import {
  base64urlDecode,
  base64urlEncode,
  base64urlJson,
  parseBase64urlJson,
  toBytes,
  utf8,
} from '../internal/security/encoding.mts';
import { randomBytes } from './random.mts';
import { exportPublicJwk, importJwk, selectJwk, type JsonWebKeyLike, type JsonWebKeySet } from './jwk.mts';

/** Supported compact JWS algorithms; `none` is intentionally not supported. */
export type JwtAlgorithm =
  | 'HS256' | 'HS384' | 'HS512'
  | 'RS256' | 'RS384' | 'RS512'
  | 'PS256' | 'PS384' | 'PS512'
  | 'ES256' | 'ES384' | 'ES512';

/** Supported compact JWE key-management algorithms. */
export type JweAlgorithm = 'dir' | 'RSA-OAEP' | 'RSA-OAEP-256';

/** Supported compact JWE content-encryption algorithms. */
export type JweEncryption = 'A128GCM' | 'A256GCM';

/** Key input accepted by verification and decryption helpers. */
export type JwtKeyInput = JsonWebKeyLike | JsonWebKeySet | JsonWebKeyLike[];

/** Options for signing a compact JWT. */
export interface JwtSignOptions {
  algorithm: JwtAlgorithm;
  header?: Record<string, unknown>;
  expiresIn?: number;
  notBefore?: number;
  issuedAt?: number | false;
}

/** Claim checks and clock controls used during JWT verification. */
export interface JwtVerifyOptions {
  audience?: string | string[];
  issuer?: string;
  subject?: string;
  clockTolerance?: number;
  now?: number;
}

/** Options for encrypting a compact JWE with a JSON payload. */
export interface JwtEncryptOptions {
  algorithm: JweAlgorithm;
  encryption: JweEncryption;
  header?: Record<string, unknown>;
}

/** Decoded compact JWT or JWE result. */
export interface JwtResult {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

function hashForJwtAlg(alg: string): string {
  if (alg.endsWith('384')) return 'SHA-384';
  if (alg.endsWith('512')) return 'SHA-512';
  return 'SHA-256';
}

function keyFor(input: JwtKeyInput, header: Record<string, unknown>, alg: string): JsonWebKeyLike {
  if (Array.isArray(input) || 'keys' in input) {
    const selected = selectJwk(input as JsonWebKeySet | JsonWebKeyLike[], {
      kid: typeof header.kid === 'string' ? header.kid : undefined,
      alg,
    });
    if (!selected) throw new Error('No matching JWK found');
    return selected;
  }
  return input as JsonWebKeyLike;
}

function signAlgorithm(alg: JwtAlgorithm): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  if (alg.startsWith('PS')) return { name: 'RSA-PSS', saltLength: Number(alg.slice(2)) / 8 };
  if (alg.startsWith('ES')) return { name: 'ECDSA', hash: hashForJwtAlg(alg) };
  return { name: alg.startsWith('RS') ? 'RSASSA-PKCS1-v1_5' : 'HMAC' };
}

function importUsages(alg: string, op: 'sign' | 'verify'): KeyUsage[] {
  if (alg.startsWith('HS')) return [op];
  return [op];
}

function ecBytes(alg: string): number {
  if (alg === 'ES384') return 48;
  if (alg === 'ES512') return 66;
  return 32;
}

function trimInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  return bytes.subarray(start);
}

function padInteger(bytes: Uint8Array, size: number): Uint8Array {
  const trimmed = trimInteger(bytes);
  if (trimmed.length > size) return trimmed.subarray(trimmed.length - size);
  const out = new Uint8Array(size);
  out.set(trimmed, size - trimmed.length);
  return out;
}

function derToJose(signature: Uint8Array, alg: string): Uint8Array {
  const size = ecBytes(alg);
  if (signature[0] !== 0x30) return signature;
  let offset = 2;
  if (signature[1]! & 0x80) offset = 2 + (signature[1]! & 0x7f);
  if (signature[offset++] !== 0x02) throw new Error('Invalid ECDSA DER signature');
  const rLen = signature[offset++]!;
  const r = signature.subarray(offset, offset + rLen);
  offset += rLen;
  if (signature[offset++] !== 0x02) throw new Error('Invalid ECDSA DER signature');
  const sLen = signature[offset++]!;
  const s = signature.subarray(offset, offset + sLen);
  const out = new Uint8Array(size * 2);
  out.set(padInteger(r, size), 0);
  out.set(padInteger(s, size), size);
  return out;
}

function integerDer(bytes: Uint8Array): Uint8Array {
  const trimmed = trimInteger(bytes);
  const needsZero = (trimmed[0]! & 0x80) !== 0;
  const out = new Uint8Array(2 + trimmed.length + (needsZero ? 1 : 0));
  out[0] = 0x02;
  out[1] = trimmed.length + (needsZero ? 1 : 0);
  out.set(trimmed, needsZero ? 3 : 2);
  return out;
}

function joseToDer(signature: Uint8Array, alg: string): Uint8Array {
  const size = ecBytes(alg);
  if (signature.length !== size * 2) return signature;
  const r = integerDer(signature.subarray(0, size));
  const s = integerDer(signature.subarray(size));
  const len = r.length + s.length;
  const out = new Uint8Array(2 + len);
  out[0] = 0x30;
  out[1] = len;
  out.set(r, 2);
  out.set(s, 2 + r.length);
  return out;
}

function validateClaims(payload: Record<string, unknown>, options: JwtVerifyOptions): void {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockTolerance ?? 0;
  if (typeof payload.exp === 'number' && now > payload.exp + tolerance) throw new Error('JWT expired');
  if (typeof payload.nbf === 'number' && now + tolerance < payload.nbf) throw new Error('JWT not active');
  if (options.issuer !== undefined && payload.iss !== options.issuer) throw new Error('JWT issuer mismatch');
  if (options.subject !== undefined && payload.sub !== options.subject) throw new Error('JWT subject mismatch');
  if (options.audience !== undefined) {
    const expected = Array.isArray(options.audience) ? options.audience : [options.audience];
    const actual = Array.isArray(payload.aud) ? payload.aud.map(String) : typeof payload.aud === 'string' ? [payload.aud] : [];
    if (!expected.some((audience) => actual.includes(audience))) throw new Error('JWT audience mismatch');
  }
}

/** Sign a compact JWS/JWT, adding `iat` by default and optional `exp`/`nbf` claims. */
export async function jwtSign(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtSignOptions): Promise<string> {
  const alg = options.algorithm;
  if (alg === 'none') throw new Error('JWT alg "none" is not supported');
  const now = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = {
    ...payload,
    ...(options.issuedAt === false ? {} : { iat: options.issuedAt ?? now }),
    ...(options.expiresIn !== undefined ? { exp: now + options.expiresIn } : {}),
    ...(options.notBefore !== undefined ? { nbf: now + options.notBefore } : {}),
  };
  const header = { typ: 'JWT', alg, ...options.header };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(body)}`;
  const cryptoKey = await importJwk({ ...key, alg }, importUsages(alg, 'sign'));
  let signature = new Uint8Array(await crypto.subtle.sign(signAlgorithm(alg), cryptoKey, toBytes(signingInput)) as ArrayBuffer);
  if (alg.startsWith('ES')) signature = derToJose(signature, alg);
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/** Verify a compact JWS/JWT and return decoded header and payload or throw on failure. */
export async function jwtVerify(token: string, keys: JwtKeyInput, options: JwtVerifyOptions = {}): Promise<JwtResult> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid compact JWT');
  const header = parseBase64urlJson(parts[0]!);
  const payload = parseBase64urlJson(parts[1]!);
  const alg = String(header.alg ?? '');
  if (!alg || alg === 'none') throw new Error('Unsupported JWT algorithm');
  const selectedKey = keyFor(keys, header, alg);
  const key = selectedKey.kty === 'oct' ? selectedKey : await exportPublicJwk(selectedKey);
  const cryptoKey = await importJwk({ ...key, alg }, importUsages(alg, 'verify'));
  const signature = base64urlDecode(parts[2]!);
  const ok = await crypto.subtle.verify(signAlgorithm(alg as JwtAlgorithm), cryptoKey, signature, toBytes(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('JWT signature verification failed');
  validateClaims(payload, options);
  return { header, payload };
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM', length: bytes.byteLength * 8 }, false, usages);
}

function cekLength(enc: JweEncryption): number {
  return enc === 'A128GCM' ? 16 : 32;
}

function rsaOaepHash(alg: JweAlgorithm): string {
  return alg === 'RSA-OAEP' ? 'SHA-1' : 'SHA-256';
}

/** Encrypt a compact JWE with a JSON payload using AES-GCM content encryption. */
export async function jwtEncrypt(payload: Record<string, unknown>, key: JsonWebKeyLike, options: JwtEncryptOptions): Promise<string> {
  const header = { typ: 'JWT', alg: options.algorithm, enc: options.encryption, ...options.header };
  const protectedHeader = base64urlJson(header);
  let cek: Uint8Array;
  let encryptedKey = new Uint8Array();

  if (options.algorithm === 'dir') {
    if (key.kty !== 'oct' || typeof key.k !== 'string') throw new Error('dir JWE requires an oct JWK');
    cek = base64urlDecode(key.k);
  } else {
    cek = randomBytes(cekLength(options.encryption));
    const publicKey = await importJwk({ ...await exportPublicJwk(key), alg: options.algorithm }, ['encrypt']);
    encryptedKey = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, cek) as ArrayBuffer);
  }

  const iv = randomBytes(12);
  const aesKey = await importAesKey(cek, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: toBytes(protectedHeader),
    tagLength: 128,
  }, aesKey, toBytes(JSON.stringify(payload))) as ArrayBuffer);
  const tagLength = 16;
  const ciphertext = encrypted.subarray(0, encrypted.length - tagLength);
  const tag = encrypted.subarray(encrypted.length - tagLength);
  return [
    protectedHeader,
    base64urlEncode(encryptedKey),
    base64urlEncode(iv),
    base64urlEncode(ciphertext),
    base64urlEncode(tag),
  ].join('.');
}

/** Decrypt a compact JWE and return decoded header and JSON payload or throw on failure. */
export async function jwtDecrypt(token: string, keys: JwtKeyInput): Promise<JwtResult> {
  const parts = token.split('.');
  if (parts.length !== 5) throw new Error('Invalid compact JWE');
  const header = parseBase64urlJson(parts[0]!);
  const alg = String(header.alg ?? '') as JweAlgorithm;
  const enc = String(header.enc ?? '') as JweEncryption;
  const key = keyFor(keys, header, alg);

  try {
    let cek: Uint8Array;
    if (alg === 'dir') {
      if (key.kty !== 'oct' || typeof key.k !== 'string') throw new Error('dir JWE requires an oct JWK');
      cek = base64urlDecode(key.k);
    } else {
      const privateKey = await importJwk({ ...key, alg }, ['decrypt']);
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
      tagLength: 128,
    }, aesKey, encrypted) as ArrayBuffer);
    return { header, payload: JSON.parse(utf8(plaintext)) };
  } catch (err) {
    throw new Error('JWE decryption failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}
