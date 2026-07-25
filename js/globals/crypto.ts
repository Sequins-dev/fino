/**
* Web Crypto API global.
*
* Implements a useful subset of the W3C Web Cryptography API and installs it
* as `globalThis.crypto` at import time; the `CryptoKey` class is installed
* as a global too. Application code never imports this module directly — it
* just uses `crypto` like it would in a browser:
*
* - `crypto.getRandomValues(typedArray)`
* - `crypto.randomUUID()`
* - `crypto.subtle.digest(algorithm, data)`
* - `crypto.subtle.sign(algorithm, key, data)`
* - `crypto.subtle.verify(algorithm, key, signature, data)`
* - `crypto.subtle.encrypt(algorithm, key, data)`
* - `crypto.subtle.decrypt(algorithm, key, data)`
* - `crypto.subtle.importKey(format, keyData, algorithm, extractable, keyUsages)`
* - `crypto.subtle.exportKey(format, key)`
* - `crypto.subtle.generateKey(algorithm, extractable, keyUsages)`
* - `crypto.subtle.deriveBits(algorithm, baseKey, length)`
* - `crypto.subtle.deriveKey(algorithm, baseKey, derivedKeyAlgorithm, extractable, keyUsages)`
* - `crypto.subtle.wrapKey(format, key, wrappingKey, wrapAlgorithm)`
* - `crypto.subtle.unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgorithm, unwrappedKeyAlgorithm, extractable, keyUsages)`
*
* Backed by internal:openssl (libcrypto via FFI). `cryptoAvailable` reports
* whether that backend loaded successfully; if OpenSSL is not installed, every
* method throws an informative error rather than crashing the process. Release
* CI should include at least one OpenSSL-enabled lane so the WebCrypto algorithm
* matrix and named error behavior are exercised rather than skipped.
*
* Supported digest names are SHA-1, SHA-256, SHA-384, and SHA-512. Symmetric
* key import supports raw and JWK AES-GCM, AES-CBC, HMAC, PBKDF2, and HKDF
* keys; generated AES-CTR keys can be exported as raw or JWK metadata.
* Asymmetric import/export supports the RSA, ECDSA, ECDH, and Ed25519
* formats covered by the focused crypto tests. AES-CTR encryption, AES-KW,
* full WPT coverage, and full WebCrypto algorithm parity are outside this
* release baseline. Unsupported algorithms and key formats reject with
* `NotSupportedError`, malformed key material rejects with `DataError`,
* key/type/usage mismatches reject with `InvalidAccessError`, and backend
* operation failures such as AES-GCM authentication failure reject with
* `OperationError`.
*
* `CryptoKey` instances are structured-cloneable: `structuredClone()` copies
* symmetric key material and takes a fresh reference on asymmetric OpenSSL
* key handles, so cloned keys have independent lifetimes.
*
* ## Example
*
* ```ts no_run
* const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
* const iv = crypto.getRandomValues(new Uint8Array(12));
* const secret = new TextEncoder().encode('attack at dawn');
* const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret);
* const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
* new TextDecoder().decode(plaintext); // "attack at dawn"
* ```
*
* W3C Web Cryptography API: https://www.w3.org/TR/WebCryptoAPI/
*/
import * as openssl from '../internal/openssl.ts';
import { DOMException, QuotaExceededError, _registerCryptoKeyCloneHelper } from './encoding.ts';
import { v4 as _uuidV4 } from 'fino:uuid';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/**
* Bytes accepted by Web Crypto methods.
*
* Callers may pass an `ArrayBuffer` directly or any typed-array/DataView view
* over an `ArrayBuffer`. Views are read from their own byte offset and length.
*/
export type BufferSource = ArrayBuffer | ArrayBufferView;
/**
* Web Crypto key kind.
*
* Public and private keys are asymmetric key handles. Secret keys hold
* symmetric key material such as AES, HMAC, PBKDF2, or HKDF input bytes.
*/
export type KeyType = 'public' | 'private' | 'secret';
/**
* Key serialization format accepted by `importKey()`, `exportKey()`,
* `wrapKey()`, and `unwrapKey()`.
*/
export type KeyFormat = 'raw' | 'pkcs8' | 'spki' | 'jwk';
/**
* Operation a `CryptoKey` is allowed to perform.
*
* SubtleCrypto checks key usages before performing operations and rejects
* mismatches with `InvalidAccessError`.
*/
export type KeyUsage = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';
/**
* Named Web Crypto algorithm descriptor.
*
* Most SubtleCrypto methods accept either a string algorithm name or an object
* with `name` plus algorithm-specific fields such as `iv`, `hash`, `salt`, or
* `namedCurve`.
*
* ```ts no_run
* const iv = crypto.getRandomValues(new Uint8Array(12));
* const alg: Algorithm = { name: 'AES-GCM', iv };
* const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
* await crypto.subtle.encrypt(alg, key as CryptoKey, new Uint8Array(4));
* ```
*/
export interface Algorithm {
  /**
  * Algorithm name such as `"AES-GCM"`, `"HMAC"`, or `"ECDSA"`. Names are
  * matched case-insensitively.
  */
  name: string;
  /**
  * Algorithm-specific parameters, e.g. `iv` and `tagLength` for AES-GCM,
  * `hash` for HMAC and RSA, `salt`/`iterations` for PBKDF2, `info` for HKDF,
  * `namedCurve` for EC, or `public` for ECDH derivation.
  */
  [key: string]: unknown;
}
/**
* Algorithm argument accepted by SubtleCrypto.
*/
export type AlgorithmIdentifier = string | Algorithm;
/**
* Algorithm metadata exposed on a `CryptoKey`.
*
* Fields depend on the key algorithm. AES and HMAC keys expose `length`,
* HMAC and RSA keys expose `hash`, elliptic-curve keys expose `namedCurve`,
* and RSA keys expose modulus and exponent metadata.
*
* ```ts no_run
* const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']);
* (key as CryptoKey).algorithm.name;       // "HMAC"
* (key as CryptoKey).algorithm.hash?.name; // "SHA-256"
* ```
*/
export interface KeyAlgorithm {
  /**
  * Algorithm name the key was created for, e.g. `"AES-GCM"` or `"ECDSA"`.
  */
  name: string;
  /**
  * Digest bound to the key at import/generation time (HMAC and RSA keys).
  */
  hash?: {
    name: string;
  };
  /**
  * Key length in bits (AES and HMAC keys).
  */
  length?: number;
  /**
  * Curve name for EC keys: `"P-256"`, `"P-384"`, or `"P-521"`.
  */
  namedCurve?: string;
  /**
  * RSA modulus size in bits, e.g. `2048`.
  */
  modulusLength?: number;
  /**
  * RSA public exponent as big-endian bytes; `[1, 0, 1]` is 65537.
  */
  publicExponent?: Uint8Array;
}
/**
* JSON Web Key object accepted by `importKey("jwk", ...)` and returned by
* `exportKey("jwk", ...)`.
*
* The active algorithm determines which fields are required. Symmetric keys use
* `kty: "oct"` with `k`; EC keys use `kty: "EC"` with `crv`, `x`, and `y`;
* RSA keys use `kty: "RSA"` with `n` and `e`; Ed25519 keys use `kty: "OKP"`.
* All binary fields are base64url-encoded without padding.
*
* ```ts no_run
* const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
* const jwk = await crypto.subtle.exportKey('jwk', key as CryptoKey) as JsonWebKey;
* jwk.kty; // "oct"
* jwk.alg; // "A128GCM"
* ```
*/
export interface JsonWebKey {
  /**
  * Key type: `"oct"` (symmetric), `"EC"`, `"RSA"`, or `"OKP"` (Ed25519).
  */
  kty?: string;
  /**
  * Symmetric key bytes (`kty: "oct"`).
  */
  k?: string;
  /**
  * Curve name for EC keys (`P-256`, `P-384`, `P-521`) or `"Ed25519"` for OKP.
  */
  crv?: string;
  /**
  * EC public x coordinate, or the Ed25519 public key for OKP keys.
  */
  x?: string;
  /**
  * EC public y coordinate.
  */
  y?: string;
  /**
  * Private key material: EC scalar, RSA private exponent, or Ed25519 seed.
  * Present only on private keys.
  */
  d?: string;
  /**
  * JWA algorithm identifier such as `"A256GCM"` or `"HS256"`. On import a
  * mismatched `alg` rejects with `DataError`.
  */
  alg?: string;
  /**
  * RSA modulus.
  */
  n?: string;
  /**
  * RSA public exponent.
  */
  e?: string;
  /**
  * RSA first prime factor.
  */
  p?: string;
  /**
  * RSA second prime factor.
  */
  q?: string;
  /**
  * RSA first CRT exponent (`d mod (p-1)`).
  */
  dp?: string;
  /**
  * RSA second CRT exponent (`d mod (q-1)`).
  */
  dq?: string;
  /**
  * RSA CRT coefficient (`q^-1 mod p`).
  */
  qi?: string;
  /**
  * Operations the key may perform. On import, requesting a usage not listed
  * here rejects with `InvalidAccessError`.
  */
  key_ops?: KeyUsage[];
  /**
  * Extractability flag mirrored from the exported key.
  */
  ext?: boolean;
}
/**
* Asymmetric key pair returned by `generateKey()` for RSA, ECDSA, ECDH, and
* Ed25519 algorithms.
*
* ```ts no_run
* const { privateKey, publicKey } = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
* const data = new TextEncoder().encode('message');
* const sig = await crypto.subtle.sign('Ed25519', privateKey, data);
* await crypto.subtle.verify('Ed25519', publicKey, sig, data); // true
* ```
*/
export interface CryptoKeyPair {
  /**
  * Private key used for private-key operations such as decrypting, signing, or
  * deriving bits.
  */
  privateKey: CryptoKey;
  /**
  * Public key used for public-key operations such as encrypting or verifying.
  */
  publicKey: CryptoKey;
}
/**
*  Normalized algorithm object used internally after calling _normalizeAlgorithm(). */
interface NormalizedAlgorithm {
  name: string;
  hash?: string | {
    name: string;
  };
  iv?: BufferSource;
  additionalData?: BufferSource;
  tagLength?: number;
  length?: number;
  salt?: BufferSource;
  iterations?: number;
  info?: BufferSource;
  label?: BufferSource;
  saltLength?: number;
  public?: CryptoKey;
  namedCurve?: string;
  modulusLength?: number;
  publicExponent?: Uint8Array;
}
function _webCryptoError(name: 'DataError' | 'InvalidAccessError' | 'NotSupportedError' | 'OperationError' | 'QuotaExceededError' | 'SyntaxError' | 'TypeMismatchError', message: string): DOMException {
  return new DOMException(message, name);
}
// ---------------------------------------------------------------------------
// CryptoKey
// ---------------------------------------------------------------------------
// WeakMap keyed on CryptoKey instances — symmetric key bytes.
const _keyStore = new WeakMap<CryptoKey, Uint8Array>();
// WeakMap keyed on asymmetric CryptoKey instances — EVP_PKEY* pointer.
const _pkeyStore = new WeakMap<CryptoKey, object>();
// Auto-free EVP_PKEY* when the CryptoKey is GC'd.
const _pkeyRegistry = new FinalizationRegistry<object>((pkey) => {
  openssl.evpPkeyFree(pkey);
});
/**
* Web Crypto key handle backed by either symmetric bytes or an OpenSSL EVP_PKEY.
*
* CryptoKey exposes metadata but not key material unless the key is extractable
* and exported through SubtleCrypto. Asymmetric native keys are freed with a
* FinalizationRegistry when the wrapper is collected.
*
* ```ts no_run
* const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
* key.type; // "secret"
* ```
*
*/
export class CryptoKey {
  #type: KeyType;
  #extractable: boolean;
  #algorithm: KeyAlgorithm;
  #usages: readonly KeyUsage[];
  /**
  * String tag used by Object.prototype.toString.
  *
  * ```ts no_run
  * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
  * Object.prototype.toString.call(key); // "[object CryptoKey]"
  * ```
  */
  get [Symbol.toStringTag]() {
    return 'CryptoKey';
  }
  /**
  * Create an internal CryptoKey wrapper.
  *
  * Symmetric keys store bytes in a WeakMap. Asymmetric keys store an OpenSSL
  * pointer in a WeakMap and register it for finalization. User code receives
  * CryptoKey objects from SubtleCrypto methods rather than constructing them.
  *
  * ```ts no_run
  * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
  * key.extractable; // true
  * ```
  *
  * @internal
  */
  constructor(type: KeyType, extractable: boolean, algorithm: KeyAlgorithm, usages: KeyUsage[], keyData: Uint8Array | null, pkeyPtr: object | null = null) {
    this.#type = type;
    this.#extractable = extractable;
    this.#algorithm = algorithm;
    this.#usages = Object.freeze([...usages]);
    if (keyData !== null) _keyStore.set(this, keyData);
    if (pkeyPtr !== null) {
      _pkeyStore.set(this, pkeyPtr);
      _pkeyRegistry.register(this, pkeyPtr, this);
    }
  }
  /**
  * Key kind: public, private, or secret.
  *
  * ```ts no_run
  * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
  * key.type; // "secret"
  * ```
  */
  get type(): KeyType {
    return this.#type;
  }
  /**
  * Whether exportKey() and wrapKey() are allowed to reveal this key.
  *
  * Non-extractable keys throw when exported or wrapped.
  *
  * ```ts no_run
  * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt']);
  * key.extractable; // false
  * ```
  */
  get extractable(): boolean {
    return this.#extractable;
  }
  /**
  * Normalized algorithm descriptor associated with this key.
  *
  * The descriptor includes fields such as hash, length, namedCurve, or RSA
  * modulus information depending on the algorithm.
  *
  * ```ts no_run
  * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
  * key.algorithm.name; // "AES-GCM"
  * ```
  */
  get algorithm(): KeyAlgorithm {
    return this.#algorithm;
  }
  /**
  * Frozen allowed key usages.
  *
  * Mutating the returned array is not possible.
  *
  * ```ts no_run
  * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
  * key.usages.includes('encrypt'); // true
  * ```
  */
  get usages(): readonly KeyUsage[] {
    return this.#usages;
  }
}
function _keyData(key: CryptoKey): Uint8Array {
  if (!(key instanceof CryptoKey)) throw new Error('Invalid CryptoKey');
  const d = _keyStore.get(key);
  if (!d) throw new Error('CryptoKey has no symmetric key material');
  return d;
}
function _pkeyPtr(key: CryptoKey): object {
  if (!(key instanceof CryptoKey)) throw new Error('Invalid CryptoKey');
  const p = _pkeyStore.get(key);
  if (!p) throw new Error('CryptoKey has no asymmetric key material');
  return p;
}
function _cloneAlgorithmDescriptor(algorithm: KeyAlgorithm): KeyAlgorithm {
  const clone: KeyAlgorithm = { ...algorithm };
  if (algorithm.hash) clone.hash = { ...algorithm.hash };
  if (algorithm.publicExponent) clone.publicExponent = new Uint8Array(algorithm.publicExponent);
  return clone;
}
function _cloneCryptoKey(key: CryptoKey): CryptoKey {
  if (!(key instanceof CryptoKey)) throw new Error('Invalid CryptoKey');
  const keyData = _keyStore.get(key);
  if (keyData) {
    return new CryptoKey(key.type, key.extractable, _cloneAlgorithmDescriptor(key.algorithm), [...key.usages], new Uint8Array(keyData), null);
  }
  const pkey = _pkeyStore.get(key);
  if (pkey) {
    return new CryptoKey(key.type, key.extractable, _cloneAlgorithmDescriptor(key.algorithm), [...key.usages], null, openssl.evpPkeyUpRef(pkey));
  }
  throw new Error('CryptoKey has no key material');
}
// ---------------------------------------------------------------------------
// Algorithm normalization helpers
// ---------------------------------------------------------------------------
function _normalizeAlgorithm(algorithm: string | {
  name: string;
  [key: string]: unknown;
}): NormalizedAlgorithm {
  if (typeof algorithm === 'string') return { name: algorithm.toUpperCase() };
  return {
    ...algorithm,
    name: algorithm.name.toUpperCase()
  } as NormalizedAlgorithm;
}
function _isEd25519Algorithm(name: string): boolean {
  return name === 'ED25519';
}
function _hashName(hash: string | {
  name: string;
}): string {
  // Accept { name: 'SHA-256' } or just 'SHA-256'
  const name = typeof hash === 'string' ? hash : hash.name;
  return name.toUpperCase();
}
// Map Web Crypto algorithm names to openssl.mjs algorithm strings
function _digestAlgorithm(name: string): string {
  switch (name.toUpperCase()) {
    case 'SHA-1': return 'sha-1';
    case 'SHA-256': return 'sha-256';
    case 'SHA-384': return 'sha-384';
    case 'SHA-512': return 'sha-512';
    default: throw _webCryptoError('NotSupportedError', 'Unsupported hash algorithm: ' + name);
  }
}
function _cipherAlgorithm(name: string, keyLength: number): string {
  const bits = keyLength * 8;
  switch (name.toUpperCase()) {
    case 'AES-GCM': return bits === 128 ? 'aes-128-gcm' : 'aes-256-gcm';
    case 'AES-CBC': return bits === 128 ? 'aes-128-cbc' : 'aes-256-cbc';
    default: throw _webCryptoError('NotSupportedError', 'Unsupported cipher algorithm: ' + name);
  }
}
// ---------------------------------------------------------------------------
// Data coercion helpers
// ---------------------------------------------------------------------------
function _toUint8Array(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('data must be an ArrayBuffer or ArrayBufferView');
}
function _checkCryptoAvailable() {
  if (!openssl.cryptoAvailable) {
    throw new Error('crypto: OpenSSL (libcrypto) is not available on this system. ' + 'Install OpenSSL and ensure it is findable via the standard library paths.');
  }
}
function _requiredBufferSource(value: BufferSource | undefined, name: string): BufferSource {
  if (value === undefined) throw _webCryptoError('DataError', `${name} is required`);
  return value;
}
function _requiredHash(value: string | {
  name: string;
} | undefined, name: string): string | {
  name: string;
} {
  if (value === undefined) throw _webCryptoError('DataError', `${name} is required`);
  return value;
}
function _toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
function _deriveBitsByteLength(length: number | null | undefined): number {
  if (!Number.isInteger(length) || length === null || length < 0 || length % 8 !== 0) {
    throw _webCryptoError('OperationError', 'deriveBits: length must be a non-negative multiple of 8');
  }
  return length / 8;
}
function _base64urlEncode(bytes: Uint8Array): string {
  let b64 = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    b64 += chars[b0 >> 2]!;
    b64 += chars[(b0 & 3) << 4 | b1 >> 4]!;
    b64 += i + 1 < bytes.length ? chars[(b1 & 15) << 2 | b2 >> 6]! : '=';
    b64 += i + 2 < bytes.length ? chars[b2 & 63]! : '=';
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function _base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
// ---------------------------------------------------------------------------
// Minimal DER TLV reader — used by RSA JWK export to parse SPKI / PKCS8 DER.
// ---------------------------------------------------------------------------
class _DerReader {
  private off = 0;
  constructor(private readonly buf: Uint8Array) {}
  private _readTag(): number {
    return this.buf[this.off++]!;
  }
  private _readLen(): number {
    const first = this.buf[this.off++]!;
    if (first < 128) return first;
    const numBytes = first & 127;
    let len = 0;
    for (let i = 0; i < numBytes; i++) len = len << 8 | this.buf[this.off++]!;
    return len;
  }
  enterSequence(): _DerReader {
    const tag = this._readTag();
    if (tag !== 48) throw new Error(`DER: expected SEQUENCE (0x30), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    const sub = new _DerReader(this.buf.subarray(this.off, this.off + len));
    this.off += len;
    return sub;
  }
  skip(): void {
    this._readTag();
    const len = this._readLen();
    this.off += len;
  }
  readInteger(): Uint8Array {
    const tag = this._readTag();
    if (tag !== 2) throw new Error(`DER: expected INTEGER (0x02), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    const bytes = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    return bytes.subarray(start);
  }
  readBitStringContent(): Uint8Array {
    const tag = this._readTag();
    if (tag !== 3) throw new Error(`DER: expected BIT STRING (0x03), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    this.off++;
    const content = this.buf.subarray(this.off, this.off + len - 1);
    this.off += len - 1;
    return content;
  }
  readOctetStringContent(): Uint8Array {
    const tag = this._readTag();
    if (tag !== 4) throw new Error(`DER: expected OCTET STRING (0x04), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    const content = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return content;
  }
}
function _rsaParseSpki(der: Uint8Array): {
  n: Uint8Array;
  e: Uint8Array;
} {
  const root = new _DerReader(der).enterSequence();
  root.skip();
  const bitStr = root.readBitStringContent();
  const rsa = new _DerReader(bitStr).enterSequence();
  return {
    n: rsa.readInteger(),
    e: rsa.readInteger()
  };
}
function _rsaParsePkcs8(der: Uint8Array): {
  n: Uint8Array;
  e: Uint8Array;
  d: Uint8Array;
  p: Uint8Array;
  q: Uint8Array;
  dp: Uint8Array;
  dq: Uint8Array;
  qi: Uint8Array;
} {
  const root = new _DerReader(der).enterSequence();
  root.skip();
  root.skip();
  const privKeyBytes = root.readOctetStringContent();
  const rsa = new _DerReader(privKeyBytes).enterSequence();
  rsa.skip();
  return {
    n: rsa.readInteger(),
    e: rsa.readInteger(),
    d: rsa.readInteger(),
    p: rsa.readInteger(),
    q: rsa.readInteger(),
    dp: rsa.readInteger(),
    dq: rsa.readInteger(),
    qi: rsa.readInteger()
  };
}
function _rsaJwkAlg(algName: string, hashName: string): string {
  if (algName === 'RSA-OAEP') return `RSA-OAEP${hashName === 'SHA-256' ? '-256' : hashName === 'SHA-384' ? '-384' : '-512'}`;
  if (algName === 'RSA-PSS') return hashName === 'SHA-256' ? 'PS256' : hashName === 'SHA-384' ? 'PS384' : 'PS512';
  /* RSASSA-PKCS1-V1_5 */ return hashName === 'SHA-256' ? 'RS256' : hashName === 'SHA-384' ? 'RS384' : 'RS512';
}
function _symmetricJwkAlg(algName: string, keyBytes: number, hash?: string | {
  name: string;
}): string {
  if (algName === 'HMAC') {
    const hashName = _hashName(hash ?? 'SHA-256');
    return hashName === 'SHA-384' ? 'HS384' : hashName === 'SHA-512' ? 'HS512' : 'HS256';
  }
  const bits = keyBytes * 8;
  if (algName === 'AES-GCM') return bits === 128 ? 'A128GCM' : 'A256GCM';
  if (algName === 'AES-CBC') return bits === 128 ? 'A128CBC' : 'A256CBC';
  if (algName === 'AES-CTR') return bits === 128 ? 'A128CTR' : bits === 192 ? 'A192CTR' : 'A256CTR';
  throw _webCryptoError('NotSupportedError', `JWK not supported for algorithm ${algName}`);
}
function _validateJwkKeyOps(jwkOps: unknown, requestedUsages: readonly KeyUsage[]): void {
  if (jwkOps === undefined) return;
  if (!Array.isArray(jwkOps) || jwkOps.some((op) => typeof op !== 'string')) {
    throw _webCryptoError('DataError', 'importKey: JWK key_ops must be an array of strings');
  }
  for (const usage of requestedUsages) {
    if (!jwkOps.includes(usage)) {
      throw _webCryptoError('InvalidAccessError', `importKey: requested usage "${usage}" is not allowed by JWK key_ops`);
    }
  }
}
// ---------------------------------------------------------------------------
// ECDSA DER ↔ raw signature conversion helpers
//
// WebCrypto uses raw (2 × coordSize)-byte signatures: big-endian r ‖ s.
// OpenSSL ECDSA_sign/verify uses ASN.1 DER-encoded signatures.
// `coordSize` is 32 for P-256, 48 for P-384, 66 for P-521.
// ---------------------------------------------------------------------------
function _derSigToRaw(der: Uint8Array, coordSize: number): Uint8Array {
  if (der[0] !== 48) throw new Error('Invalid ECDSA DER signature: expected SEQUENCE (0x30)');
  let off = 2;
  // Handle long-form sequence length (P-521 SEQUENCE length > 127)
  if ((der[1]! & 128) !== 0) off = 2 + (der[1]! & 127);
  if (der[off] !== 2) throw new Error('Invalid ECDSA DER signature: expected INTEGER for r');
  off++;
  const rLen = der[off++]!;
  if (off + rLen > der.length) throw new Error('Invalid ECDSA DER signature: r length overruns buffer');
  const rBytes = der.subarray(off, off + rLen);
  off += rLen;
  if (der[off] !== 2) throw new Error('Invalid ECDSA DER signature: expected INTEGER for s');
  off++;
  const sLen = der[off++]!;
  if (off + sLen > der.length) throw new Error('Invalid ECDSA DER signature: s length overruns buffer');
  const sBytes = der.subarray(off, off + sLen);
  const raw = new Uint8Array(coordSize * 2);
  const rStart = rBytes[0] === 0 ? 1 : 0;
  const rSlice = rBytes.subarray(rStart);
  if (rSlice.length > coordSize) throw new Error('Invalid ECDSA DER signature: r value too large');
  raw.set(rSlice, coordSize - rSlice.length);
  const sStart = sBytes[0] === 0 ? 1 : 0;
  const sSlice = sBytes.subarray(sStart);
  if (sSlice.length > coordSize) throw new Error('Invalid ECDSA DER signature: s value too large');
  raw.set(sSlice, coordSize * 2 - sSlice.length);
  return raw;
}
function _rawSigToDer(raw: Uint8Array, coordSize: number): Uint8Array {
  if (raw.length !== coordSize * 2) {
    throw new Error(`Raw ECDSA signature must be ${coordSize * 2} bytes (got ${raw.length})`);
  }
  function _encodeInt(b: Uint8Array): Uint8Array {
    let start = 0;
    while (start < b.length - 1 && b[start] === 0) start++;
    const needsPad = (b[start]! & 128) !== 0;
    const out = new Uint8Array(needsPad ? b.length - start + 1 : b.length - start);
    if (needsPad) {
      out[0] = 0;
      out.set(b.subarray(start), 1);
    } else {
      out.set(b.subarray(start));
    }
    return out;
  }
  const r = _encodeInt(raw.subarray(0, coordSize));
  const s = _encodeInt(raw.subarray(coordSize));
  const inner = 2 + r.length + 2 + s.length;
  // Use long-form SEQUENCE length when inner > 127 (P-521 signatures).
  let der: Uint8Array;
  if (inner > 127) {
    der = new Uint8Array(3 + inner);
    der[0] = 48;
    der[1] = 129;
    der[2] = inner;
    der[3] = 2;
    der[4] = r.length;
    der.set(r, 5);
    der[5 + r.length] = 2;
    der[6 + r.length] = s.length;
    der.set(s, 7 + r.length);
  } else {
    der = new Uint8Array(2 + inner);
    der[0] = 48;
    der[1] = inner;
    der[2] = 2;
    der[3] = r.length;
    der.set(r, 4);
    der[4 + r.length] = 2;
    der[5 + r.length] = s.length;
    der.set(s, 6 + r.length);
  }
  return der;
}
/**
*  Return the coordinate byte size for a CryptoKey's named curve. */
function _ecCoordSize(key: CryptoKey): number {
  return openssl.ecdsaCoordSize(key.algorithm.namedCurve ?? 'P-256');
}
// ---------------------------------------------------------------------------
// SubtleCrypto
// ---------------------------------------------------------------------------
/**
* Web Crypto cryptographic operation surface exposed as `crypto.subtle`.
*
* Methods are asynchronous and reject with DOMException names used by the Web
* Crypto specification. Unsupported algorithms reject with `NotSupportedError`,
* malformed key material with `DataError`, key/usage mismatches with
* `InvalidAccessError`, and backend failures with `OperationError`. Every
* method rejects with a plain `Error` when the OpenSSL backend is unavailable
* (see `cryptoAvailable`).
*
* ```ts no_run
* const data = new TextEncoder().encode('hello');
* const digest = await crypto.subtle.digest('SHA-256', data);
* const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
* const mac = await crypto.subtle.sign('HMAC', key as CryptoKey, data);
* await crypto.subtle.verify('HMAC', key as CryptoKey, mac, data); // true
* ```
*/
export interface SubtleCrypto {
  /**
  * Brand string used by `Object.prototype.toString.call(crypto.subtle)`.
  */
  readonly [Symbol.toStringTag]: string;
  /**
  * Compute a digest of `data`.
  *
  * Supported digest names are `SHA-1`, `SHA-256`, `SHA-384`, and `SHA-512`.
  * The returned `ArrayBuffer` contains the raw digest bytes. Rejects with
  * `NotSupportedError` for any other digest name.
  *
  * ```ts no_run
  * const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
  * const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  * ```
  */
  digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer>;
  /**
  * Sign `data` with `key`.
  *
  * Supported algorithms are HMAC, ECDSA, RSA-PSS, RSASSA-PKCS1-v1_5, and
  * Ed25519. The key must allow the `sign` usage and match the requested
  * algorithm, otherwise the call rejects with `InvalidAccessError`.
  *
  * ECDSA signatures are returned in the Web Crypto raw form — big-endian
  * `r ‖ s` at twice the curve coordinate size — not ASN.1 DER. Ed25519
  * signatures are always 64 bytes. ECDSA requires `hash` on the algorithm
  * object; HMAC and RSA use the hash bound to the key.
  *
  * ```ts no_run
  * const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  * const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(32));
  * new Uint8Array(sig).byteLength; // 64 (r ‖ s for P-256)
  * ```
  */
  sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  /**
  * Verify `signature` for `data` with `key`.
  *
  * Returns `false` for a valid algorithm/key combination with an invalid
  * signature — including malformed or wrong-length ECDSA and Ed25519
  * signatures. Key or algorithm mismatches reject with `InvalidAccessError`
  * instead. HMAC comparison is constant-time.
  *
  * ```ts no_run
  * const key = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  * const data = new TextEncoder().encode('payload');
  * const mac = await crypto.subtle.sign('HMAC', key, data);
  * await crypto.subtle.verify('HMAC', key, mac, data); // true
  * ```
  */
  verify(algorithm: AlgorithmIdentifier, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean>;
  /**
  * Encrypt `data` with `key`.
  *
  * Supported algorithms are AES-GCM, AES-CBC, and RSA-OAEP. The key must
  * allow the `encrypt` usage. AES requires `iv` on the algorithm object; the
  * AES-GCM result is the ciphertext with the authentication tag appended
  * (`tagLength` bits, default 128), and `additionalData` is authenticated
  * when provided. RSA-OAEP requires a public key.
  *
  * ```ts no_run
  * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  * const iv = crypto.getRandomValues(new Uint8Array(12));
  * const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key as CryptoKey, new TextEncoder().encode('hi'));
  * ```
  */
  encrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  /**
  * Decrypt `data` with `key`.
  *
  * The inverse of `encrypt()`: AES-GCM input must be ciphertext with the
  * authentication tag appended, and the same `iv` (plus `additionalData`, if
  * any) must be supplied. Authentication or padding failures reject with
  * `OperationError`. The key must allow the `decrypt` usage. RSA-OAEP
  * requires a private key.
  *
  * ```ts no_run
  * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
  * const iv = crypto.getRandomValues(new Uint8Array(12));
  * const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('hi'));
  * const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, box);
  * new TextDecoder().decode(plain); // "hi"
  * ```
  */
  decrypt(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>;
  /**
  * Import key material and return a `CryptoKey`.
  *
  * Supported formats depend on the algorithm: `raw` covers AES-GCM/AES-CBC
  * (128- or 256-bit), HMAC, PBKDF2, HKDF, and Ed25519 public keys; `jwk`
  * covers symmetric (`oct`), EC, RSA, and Ed25519 (`OKP`) keys; `pkcs8`
  * imports EC, RSA, and Ed25519 private keys; `spki` imports EC, RSA, and
  * Ed25519 public keys.
  *
  * `extractable` controls whether future export and wrap operations may
  * reveal key material — except PBKDF2 and HKDF keys, which are always
  * non-extractable. Malformed key material rejects with `DataError`; a JWK
  * whose `key_ops` does not cover the requested usages rejects with
  * `InvalidAccessError`.
  *
  * ```ts no_run
  * const secret = crypto.getRandomValues(new Uint8Array(32));
  * const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt', 'decrypt']);
  * ```
  */
  importKey(format: KeyFormat, keyData: BufferSource | JsonWebKey, algorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
  /**
  * Export `key` in the requested format.
  *
  * `jwk` returns a `JsonWebKey` object; all other formats return an
  * `ArrayBuffer`. `raw` exports symmetric key bytes and Ed25519 public keys,
  * `pkcs8` exports private keys, and `spki` exports EC, RSA, and Ed25519
  * public keys. Non-extractable keys reject with `InvalidAccessError`.
  *
  * ```ts no_run
  * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  * const raw = await crypto.subtle.exportKey('raw', key as CryptoKey) as ArrayBuffer;
  * new Uint8Array(raw).byteLength; // 32
  * ```
  */
  exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer | JsonWebKey>;
  /**
  * Generate a new key or key pair.
  *
  * Symmetric algorithms (AES-GCM, AES-CBC, AES-CTR with `length` 128, 192,
  * or 256; HMAC with a default length derived from its hash) return a single
  * `CryptoKey`. Asymmetric algorithms (RSA-OAEP, RSA-PSS, RSASSA-PKCS1-v1_5,
  * ECDSA, ECDH, Ed25519) return a `CryptoKeyPair` whose usages are split
  * between the halves — e.g. `sign` goes to the private key and `verify` to
  * the public key. Ed25519 public keys are always extractable. Empty or
  * invalid usage lists reject with `SyntaxError`.
  *
  * ```ts no_run
  * const pair = await crypto.subtle.generateKey(
  *   { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  *   true,
  *   ['encrypt', 'decrypt'],
  * ) as CryptoKeyPair;
  * pair.publicKey.usages; // ["encrypt"]
  * ```
  */
  generateKey(algorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey | CryptoKeyPair>;
  /**
  * Derive raw bits from `baseKey`.
  *
  * Supported algorithms are ECDH, PBKDF2, and HKDF. `length` is measured in
  * bits and must be a non-negative multiple of 8 for PBKDF2 and HKDF
  * (`OperationError` otherwise). PBKDF2 requires `salt` and `iterations`;
  * HKDF defaults `salt` and `info` to empty. For ECDH, `algorithm.public`
  * carries the peer's public key, both keys must be on the same curve, and a
  * `null`/omitted `length` yields the full shared secret; non-byte-aligned
  * lengths are masked down to the requested bit count.
  *
  * ```ts no_run
  * const password = await crypto.subtle.importKey('raw', new TextEncoder().encode('hunter2'), 'PBKDF2', false, ['deriveBits']);
  * const salt = crypto.getRandomValues(new Uint8Array(16));
  * const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' }, password, 256);
  * ```
  */
  deriveBits(algorithm: AlgorithmIdentifier, baseKey: CryptoKey, length?: number | null): Promise<ArrayBuffer>;
  /**
  * Derive a new `CryptoKey` from `baseKey`.
  *
  * Equivalent to `deriveBits()` followed by `importKey('raw', ...)`: the
  * derivation algorithm (ECDH, PBKDF2, or HKDF) produces the key material and
  * `derivedKeyType` decides its shape. Supported derived key types are
  * AES-GCM, AES-CBC (default 256-bit), and HMAC (default length from its
  * hash). The base key must allow `deriveKey` or `deriveBits`.
  *
  * ```ts no_run
  * const password = await crypto.subtle.importKey('raw', new TextEncoder().encode('hunter2'), 'PBKDF2', false, ['deriveKey']);
  * const salt = crypto.getRandomValues(new Uint8Array(16));
  * const aes = await crypto.subtle.deriveKey(
  *   { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
  *   password,
  *   { name: 'AES-GCM', length: 256 },
  *   false,
  *   ['encrypt', 'decrypt'],
  * );
  * ```
  */
  deriveKey(algorithm: AlgorithmIdentifier, baseKey: CryptoKey, derivedKeyType: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
  /**
  * Export and encrypt `key` with `wrappingKey`.
  *
  * Exports `key` in `format` (`jwk` exports are serialized to JSON text
  * first) and encrypts the result with AES-GCM or AES-CBC. The wrapping key
  * must allow the `wrapKey` usage — the `encrypt` usage is not required — and
  * the wrapped key must be extractable.
  *
  * ```ts no_run
  * const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']) as CryptoKey;
  * const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as CryptoKey;
  * const iv = crypto.getRandomValues(new Uint8Array(12));
  * const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  * ```
  */
  wrapKey(format: KeyFormat, key: CryptoKey, wrappingKey: CryptoKey, wrapAlgorithm: AlgorithmIdentifier): Promise<ArrayBuffer>;
  /**
  * Decrypt wrapped key material and import the result.
  *
  * The inverse of `wrapKey()`: decrypts with AES-GCM or AES-CBC, then imports
  * the plaintext in `format` — only `raw` and `jwk` are supported here. The
  * unwrapping key must allow the `unwrapKey` usage; decryption failure
  * rejects with `OperationError`.
  *
  * ```ts no_run
  * // Continuing from the wrapKey() example above:
  * const dek = await crypto.subtle.unwrapKey('raw', wrapped, kek, { name: 'AES-GCM', iv }, 'AES-GCM', false, ['decrypt']);
  * ```
  */
  unwrapKey(format: KeyFormat, wrappedKey: BufferSource, unwrappingKey: CryptoKey, unwrapAlgorithm: AlgorithmIdentifier, unwrappedKeyAlgorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey>;
}
const subtle: SubtleCrypto = {
  get [Symbol.toStringTag]() {
    return 'SubtleCrypto';
  },
  /**
  * See `SubtleCrypto.digest()`.
  */
  async digest(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    const hash = _digestAlgorithm(alg.name);
    const arr = _toUint8Array(data);
    return _toArrayBuffer(openssl.digest(hash, arr));
  },
  /**
  * See `SubtleCrypto.sign()`.
  */
  async sign(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (_isEd25519Algorithm(alg.name)) {
      if (key.type !== 'private') throw _webCryptoError('InvalidAccessError', 'Ed25519 sign requires a private key');
      if (!key.usages.includes('sign')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow sign');
      return _toArrayBuffer(openssl.ed25519Sign(_pkeyPtr(key), _toUint8Array(data)));
    }
    if (alg.name === 'ECDSA') {
      if (key.algorithm.name !== 'ECDSA' || key.type !== 'private') {
        throw _webCryptoError('InvalidAccessError', 'ECDSA sign requires an ECDSA private key');
      }
      if (!key.usages.includes('sign')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow sign');
      const hashAlg = _digestAlgorithm(_hashName(_requiredHash(alg.hash, 'ECDSA hash')));
      const hash = openssl.digest(hashAlg, _toUint8Array(data));
      const der = openssl.ecdsaSign(hash, _pkeyPtr(key));
      return _toArrayBuffer(_derSigToRaw(der, _ecCoordSize(key)));
    }
    if (alg.name === 'RSA-PSS') {
      if (key.algorithm.name !== 'RSA-PSS' || key.type !== 'private') {
        throw _webCryptoError('InvalidAccessError', 'RSA-PSS sign requires an RSA-PSS private key');
      }
      if (!key.usages.includes('sign')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow sign');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-PSS hash'));
      const hashAlg = _digestAlgorithm(hashName);
      const saltLen = (alg as {
        saltLength?: number;
      }).saltLength ?? -1;
      return _toArrayBuffer(openssl.rsaPssSign(_pkeyPtr(key), hashAlg, saltLen, _toUint8Array(data)));
    }
    if (alg.name === 'RSASSA-PKCS1-V1_5') {
      if (key.algorithm.name !== 'RSASSA-PKCS1-V1_5' || key.type !== 'private') {
        throw _webCryptoError('InvalidAccessError', 'RSASSA-PKCS1-v1_5 sign requires an RSASSA-PKCS1-v1_5 private key');
      }
      if (!key.usages.includes('sign')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow sign');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSASSA-PKCS1-v1_5 hash'));
      const hashAlg = _digestAlgorithm(hashName);
      return _toArrayBuffer(openssl.rsaPkcs1Sign(_pkeyPtr(key), hashAlg, _toUint8Array(data)));
    }
    if (alg.name !== 'HMAC') throw _webCryptoError('NotSupportedError', 'sign: unsupported algorithm "' + alg.name + '"');
    if (key.algorithm.name !== 'HMAC' || key.type !== 'secret') {
      throw _webCryptoError('InvalidAccessError', 'HMAC sign requires an HMAC secret key');
    }
    if (!key.usages.includes('sign')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow sign');
    const hash = _digestAlgorithm(_hashName(_requiredHash(key.algorithm.hash, 'HMAC hash')));
    const mac = openssl.hmac(hash, _keyData(key), _toUint8Array(data));
    return _toArrayBuffer(mac);
  },
  /**
  * See `SubtleCrypto.verify()`.
  */
  async verify(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (_isEd25519Algorithm(alg.name)) {
      if (key.type !== 'public') throw _webCryptoError('InvalidAccessError', 'Ed25519 verify requires a public key');
      if (!key.usages.includes('verify')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow verify');
      const sig = _toUint8Array(signature);
      if (sig.byteLength !== 64) return false;
      return openssl.ed25519Verify(_pkeyPtr(key), sig, _toUint8Array(data));
    }
    if (alg.name === 'ECDSA') {
      if (key.algorithm.name !== 'ECDSA' || key.type !== 'public') {
        throw _webCryptoError('InvalidAccessError', 'ECDSA verify requires an ECDSA public key');
      }
      if (!key.usages.includes('verify')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow verify');
      const hashAlg = _digestAlgorithm(_hashName(_requiredHash(alg.hash, 'ECDSA hash')));
      const hash = openssl.digest(hashAlg, _toUint8Array(data));
      let derSig: Uint8Array;
      try {
        derSig = _rawSigToDer(_toUint8Array(signature), _ecCoordSize(key));
      } catch {
        return false;
      }
      return openssl.ecdsaVerify(hash, derSig, _pkeyPtr(key));
    }
    if (alg.name === 'RSA-PSS') {
      if (key.algorithm.name !== 'RSA-PSS' || key.type !== 'public') {
        throw _webCryptoError('InvalidAccessError', 'RSA-PSS verify requires an RSA-PSS public key');
      }
      if (!key.usages.includes('verify')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow verify');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-PSS hash'));
      const hashAlg = _digestAlgorithm(hashName);
      return openssl.rsaPssVerify(_pkeyPtr(key), hashAlg, _toUint8Array(signature), _toUint8Array(data));
    }
    if (alg.name === 'RSASSA-PKCS1-V1_5') {
      if (key.algorithm.name !== 'RSASSA-PKCS1-V1_5' || key.type !== 'public') {
        throw _webCryptoError('InvalidAccessError', 'RSASSA-PKCS1-v1_5 verify requires an RSASSA-PKCS1-v1_5 public key');
      }
      if (!key.usages.includes('verify')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow verify');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSASSA-PKCS1-v1_5 hash'));
      const hashAlg = _digestAlgorithm(hashName);
      return openssl.rsaPkcs1Verify(_pkeyPtr(key), hashAlg, _toUint8Array(signature), _toUint8Array(data));
    }
    if (alg.name !== 'HMAC') throw _webCryptoError('NotSupportedError', 'verify: unsupported algorithm "' + alg.name + '"');
    if (key.algorithm.name !== 'HMAC' || key.type !== 'secret') {
      throw _webCryptoError('InvalidAccessError', 'HMAC verify requires an HMAC secret key');
    }
    if (!key.usages.includes('verify')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow verify');
    const hash = _digestAlgorithm(_hashName(_requiredHash(key.algorithm.hash, 'HMAC hash')));
    const expected = openssl.hmac(hash, _keyData(key), _toUint8Array(data));
    const actual = _toUint8Array(signature);
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ actual[i]!;
    return diff === 0;
  },
  /**
  * See `SubtleCrypto.encrypt()`.
  */
  async encrypt(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('encrypt')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow encrypt');
    if (alg.name === 'RSA-OAEP') {
      if (key.algorithm.name !== 'RSA-OAEP' || key.type !== 'public') {
        throw _webCryptoError('InvalidAccessError', 'RSA-OAEP encrypt requires an RSA-OAEP public key');
      }
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-OAEP hash'));
      const hashAlg = _digestAlgorithm(hashName);
      const label = alg.label ? _toUint8Array(alg.label as BufferSource) : null;
      return _toArrayBuffer(openssl.rsaOaepEncrypt(_pkeyPtr(key), hashAlg, label, _toUint8Array(data)));
    }
    if (alg.name !== 'AES-GCM' && alg.name !== 'AES-CBC') {
      throw _webCryptoError('NotSupportedError', 'encrypt: unsupported algorithm "' + alg.name + '"');
    }
    if (key.algorithm.name !== alg.name || key.type !== 'secret') {
      throw _webCryptoError('InvalidAccessError', `${alg.name} encrypt requires a matching secret key`);
    }
    const keyBytes = _keyData(key);
    const cipherAlg = _cipherAlgorithm(alg.name, keyBytes.byteLength);
    const iv = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData) : null;
    const pt = _toUint8Array(data);
    const { ciphertext, tag } = openssl.cipherEncrypt(cipherAlg, keyBytes, iv, pt, aad);
    if (tag) {
      // AES-GCM: return ciphertext || tag concatenated.
      // The tag is truncated to the requested tagLength (default: 128 bits = 16 bytes).
      const requestedTagBytes = (alg.tagLength ?? 128) / 8;
      const truncatedTag = tag.subarray(0, requestedTagBytes);
      const out = new Uint8Array(ciphertext.byteLength + truncatedTag.byteLength);
      out.set(ciphertext);
      out.set(truncatedTag, ciphertext.byteLength);
      return _toArrayBuffer(out);
    }
    return _toArrayBuffer(ciphertext);
  },
  /**
  * See `SubtleCrypto.decrypt()`.
  */
  async decrypt(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('decrypt')) throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow decrypt');
    if (alg.name === 'RSA-OAEP') {
      if (key.algorithm.name !== 'RSA-OAEP' || key.type !== 'private') {
        throw _webCryptoError('InvalidAccessError', 'RSA-OAEP decrypt requires an RSA-OAEP private key');
      }
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-OAEP hash'));
      const hashAlg = _digestAlgorithm(hashName);
      const label = alg.label ? _toUint8Array(alg.label as BufferSource) : null;
      return _toArrayBuffer(openssl.rsaOaepDecrypt(_pkeyPtr(key), hashAlg, label, _toUint8Array(data)));
    }
    if (alg.name !== 'AES-GCM' && alg.name !== 'AES-CBC') {
      throw _webCryptoError('NotSupportedError', 'decrypt: unsupported algorithm "' + alg.name + '"');
    }
    if (key.algorithm.name !== alg.name || key.type !== 'secret') {
      throw _webCryptoError('InvalidAccessError', `${alg.name} decrypt requires a matching secret key`);
    }
    const keyBytes = _keyData(key);
    const cipherAlg = _cipherAlgorithm(alg.name, keyBytes.byteLength);
    const iv = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData) : null;
    let ciphertext, tag;
    if (cipherAlg.endsWith('-gcm')) {
      // Web Crypto convention: encrypted data = ciphertext || 16-byte tag
      const tagLength = (alg.tagLength ?? 128) / 8;
      const buf = _toUint8Array(data);
      if (buf.byteLength < tagLength) throw _webCryptoError('OperationError', 'AES-GCM: data too short (no tag)');
      ciphertext = buf.subarray(0, buf.byteLength - tagLength);
      tag = buf.subarray(buf.byteLength - tagLength);
    } else {
      ciphertext = _toUint8Array(data);
      tag = null;
    }
    let plaintext: Uint8Array;
    try {
      plaintext = openssl.cipherDecrypt(cipherAlg, keyBytes, iv, ciphertext, tag, aad);
    } catch (err) {
      throw _webCryptoError('OperationError', err instanceof Error ? err.message : 'decrypt operation failed');
    }
    return _toArrayBuffer(plaintext);
  },
  /**
  * See `SubtleCrypto.importKey()`.
  */
  async importKey(format: KeyFormat, keyData: BufferSource, algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (format === 'jwk') {
      const jwk = (keyData as unknown) as {
        kty?: string;
        k?: string;
        crv?: string;
        x?: string;
        y?: string;
        d?: string;
        alg?: string;
        n?: string;
        e?: string;
        p?: string;
        q?: string;
        dp?: string;
        dq?: string;
        qi?: string;
        key_ops?: unknown;
      };
      if ((alg.name === 'AES-GCM' || alg.name === 'AES-CBC' || alg.name === 'AES-CTR' || alg.name === 'HMAC') && jwk.kty !== 'oct') {
        throw _webCryptoError('DataError', `importKey: ${alg.name} JWK requires kty "oct"`);
      }
      if ((alg.name === 'ECDSA' || alg.name === 'ECDH') && jwk.kty !== 'EC') {
        throw _webCryptoError('DataError', `importKey: ${alg.name} JWK requires kty "EC"`);
      }
      if ((alg.name === 'RSA-OAEP' || alg.name === 'RSA-PSS' || alg.name === 'RSASSA-PKCS1-V1_5') && jwk.kty !== 'RSA') {
        throw _webCryptoError('DataError', `importKey: ${alg.name} JWK requires kty "RSA"`);
      }
      if (_isEd25519Algorithm(alg.name) && jwk.kty !== 'OKP') {
        throw _webCryptoError('DataError', 'importKey: Ed25519 JWK requires kty "OKP"');
      }
      if (jwk.kty === 'OKP') {
        if (!_isEd25519Algorithm(alg.name)) throw _webCryptoError('DataError', 'importKey: OKP JWK requires Ed25519 algorithm');
        if (jwk.crv !== 'Ed25519') throw _webCryptoError('DataError', 'importKey: OKP JWK crv must be "Ed25519"');
        if (typeof jwk.x !== 'string') throw _webCryptoError('DataError', 'importKey: Ed25519 JWK requires "x" field');
        const x = _base64urlDecode(jwk.x);
        if (x.byteLength !== 32) throw _webCryptoError('DataError', 'importKey: Ed25519 JWK x must be 32 bytes');
        let pkey: object;
        try {
          pkey = typeof jwk.d === 'string' ? openssl.evpPkeyImportRawPrivateEd25519(_base64urlDecode(jwk.d)) : openssl.evpPkeyImportRawPublicEd25519(x);
        } catch (err) {
          throw _webCryptoError('DataError', err instanceof Error ? err.message : 'Malformed Ed25519 JWK');
        }
        const keyType: KeyType = typeof jwk.d === 'string' ? 'private' : 'public';
        return new CryptoKey(keyType, extractable, { name: 'Ed25519' }, [...keyUsages], null, pkey);
      }
      if (jwk.kty === 'EC') {
        // EC JWK import (ECDSA and ECDH).
        if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
          throw _webCryptoError('DataError', 'importKey: JWK kty="EC" requires "x" and "y" fields');
        }
        const crv = jwk.crv ?? (alg as {
          namedCurve?: string;
        }).namedCurve ?? 'P-256';
        const coordSize = openssl.ecdsaCoordSize(crv);
        const x = _base64urlDecode(jwk.x);
        const y = _base64urlDecode(jwk.y);
        const d = jwk.d !== undefined ? _base64urlDecode(jwk.d) : undefined;
        // Pad coordinates to coordSize if shorter (e.g. leading zeros stripped in JWK).
        const padTo = (arr: Uint8Array): Uint8Array => {
          if (arr.length === coordSize) return arr;
          const out = new Uint8Array(coordSize);
          out.set(arr, coordSize - arr.length);
          return out;
        };
        let pkey: object;
        try {
          pkey = openssl.evpPkeyImportEcJwk(crv, padTo(x), padTo(y), d !== undefined ? padTo(d) : undefined);
        } catch (err) {
          throw _webCryptoError('DataError', err instanceof Error ? err.message : 'Malformed EC JWK');
        }
        const keyType: KeyType = d !== undefined ? 'private' : 'public';
        return new CryptoKey(keyType, extractable, {
          name: alg.name,
          namedCurve: crv
        }, [...keyUsages], null, pkey);
      }
      if (jwk.kty === 'RSA') {
        // RSA JWK import.
        if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
          throw _webCryptoError('DataError', 'importKey: RSA JWK requires "n" and "e" fields');
        }
        const isPrivate = typeof jwk.d === 'string';
        const components: Parameters<typeof openssl.rsaImportComponents>[0] = {
          n: _base64urlDecode(jwk.n),
          e: _base64urlDecode(jwk.e)
        };
        if (isPrivate) {
          components.d = _base64urlDecode(jwk.d!);
          if (jwk.p) components.p = _base64urlDecode(jwk.p);
          if (jwk.q) components.q = _base64urlDecode(jwk.q);
          if (jwk.dp) components.dp = _base64urlDecode(jwk.dp);
          if (jwk.dq) components.dq = _base64urlDecode(jwk.dq);
          if (jwk.qi) components.qi = _base64urlDecode(jwk.qi);
        }
        let pkey: object;
        try {
          pkey = openssl.rsaImportComponents(components);
        } catch (err) {
          throw _webCryptoError('DataError', err instanceof Error ? err.message : 'Malformed RSA JWK');
        }
        const hashName = _hashName((alg as {
          hash?: string | {
            name: string;
          };
        }).hash ?? 'SHA-256');
        const keyType: KeyType = isPrivate ? 'private' : 'public';
        return new CryptoKey(keyType, extractable, {
          name: alg.name,
          hash: { name: hashName }
        }, [...keyUsages], null, pkey);
      }
      // JWK symmetric key import — kty must be 'oct'.
      if (jwk.kty !== 'oct') throw _webCryptoError('DataError', `importKey: unsupported JWK kty "${jwk.kty}" (supported: "oct", "EC", "RSA", "OKP")`);
      if (typeof jwk.k !== 'string') throw _webCryptoError('DataError', 'importKey: JWK missing "k" field');
      const bytes = _base64urlDecode(jwk.k);
      const expectedAlg = _symmetricJwkAlg(alg.name, bytes.byteLength, alg.hash);
      if (jwk.alg !== undefined && jwk.alg !== expectedAlg) {
        throw _webCryptoError('DataError', `importKey: JWK alg "${jwk.alg}" does not match ${expectedAlg}`);
      }
      _validateJwkKeyOps(jwk.key_ops, keyUsages);
      return subtle.importKey('raw', bytes.buffer as ArrayBuffer, algorithm, extractable, keyUsages);
    }
    if (format === 'pkcs8') {
      const derBytes = _toUint8Array(keyData);
      let pkey: object;
      try {
        pkey = openssl.evpPkeyImportPkcs8(derBytes);
      } catch (err) {
        throw _webCryptoError('DataError', err instanceof Error ? err.message : 'Malformed PKCS#8 key data');
      }
      if (_isEd25519Algorithm(alg.name)) {
        return new CryptoKey('private', extractable, { name: 'Ed25519' }, [...keyUsages], null, pkey);
      }
      if (alg.name === 'RSA-OAEP' || alg.name === 'RSA-PSS' || alg.name === 'RSASSA-PKCS1-V1_5') {
        const hashName = _hashName((alg as {
          hash?: string | {
            name: string;
          };
        }).hash ?? 'SHA-256');
        return new CryptoKey('private', extractable, {
          name: alg.name,
          hash: { name: hashName }
        }, [...keyUsages], null, pkey);
      }
      // EC private key (ECDSA / ECDH).
      const namedCurve = (alg as {
        namedCurve?: string;
      }).namedCurve ?? 'P-256';
      return new CryptoKey('private', extractable, {
        name: alg.name,
        namedCurve
      }, [...keyUsages], null, pkey);
    }
    if (format === 'spki') {
      // SPKI import for EC and RSA public keys.
      if (_isEd25519Algorithm(alg.name)) {
        let pkey: object;
        try {
          pkey = openssl.evpPkeyImportSpkiDer(_toUint8Array(keyData));
        } catch (err) {
          throw _webCryptoError('DataError', err instanceof Error ? err.message : 'Malformed Ed25519 SPKI key data');
        }
        return new CryptoKey('public', extractable, { name: 'Ed25519' }, [...keyUsages], null, pkey);
      }
      if (alg.name === 'RSA-OAEP' || alg.name === 'RSA-PSS' || alg.name === 'RSASSA-PKCS1-V1_5') {
        const hashName = _hashName((alg as {
          hash?: string | {
            name: string;
          };
        }).hash ?? 'SHA-256');
        let pkey: object;
        try {
          pkey = openssl.evpPkeyImportSpkiRsa(_toUint8Array(keyData));
        } catch (err) {
          throw _webCryptoError('DataError', err instanceof Error ? err.message : 'Malformed RSA SPKI key data');
        }
        return new CryptoKey('public', extractable, {
          name: alg.name,
          hash: { name: hashName }
        }, [...keyUsages], null, pkey);
      }
      if (alg.name !== 'ECDSA' && alg.name !== 'ECDH') {
        throw _webCryptoError('NotSupportedError', 'importKey: "spki" format only supported for EC algorithms (ECDSA, ECDH)');
      }
      const derBytes = _toUint8Array(keyData);
      let pkey: object;
      let namedCurve: string;
      try {
        ({pkey, namedCurve} = openssl.evpPkeyImportSpki(derBytes));
      } catch (err) {
        throw _webCryptoError('DataError', err instanceof Error ? err.message : 'Malformed SPKI key data');
      }
      // If the algorithm specifies a curve, validate it matches the SPKI header.
      const expectedCurve = (alg as {
        namedCurve?: string;
      }).namedCurve;
      if (expectedCurve && expectedCurve !== namedCurve) {
        openssl.evpPkeyFree(pkey);
        throw _webCryptoError('DataError', `importKey: SPKI curve (${namedCurve}) does not match algorithm.namedCurve (${expectedCurve})`);
      }
      return new CryptoKey('public', extractable, {
        name: alg.name,
        namedCurve
      }, [...keyUsages], null, pkey);
    }
    if (format !== 'raw') throw _webCryptoError('NotSupportedError', `importKey: unsupported format "${format}"; supported: "raw", "spki", "jwk"`);
    const bytes = _toUint8Array(keyData);
    if (_isEd25519Algorithm(alg.name)) {
      if (bytes.byteLength !== 32) throw _webCryptoError('DataError', 'Ed25519 raw public key must be 32 bytes');
      return new CryptoKey('public', extractable, { name: 'Ed25519' }, [...keyUsages], null, openssl.evpPkeyImportRawPublicEd25519(bytes));
    }
    if (alg.name === 'HMAC') {
      const hashName = _hashName(alg.hash ?? 'SHA-256');
      _digestAlgorithm(hashName);
      return new CryptoKey('secret', extractable, {
        name: 'HMAC',
        hash: { name: hashName }
      }, [...keyUsages], new Uint8Array(bytes));
    }
    if (alg.name === 'AES-GCM' || alg.name === 'AES-CBC') {
      if (bytes.byteLength !== 16 && bytes.byteLength !== 32) {
        throw _webCryptoError('DataError', `${alg.name}: key must be 128 or 256 bits`);
      }
      return new CryptoKey('secret', extractable, {
        name: alg.name,
        length: bytes.byteLength * 8
      }, [...keyUsages], new Uint8Array(bytes));
    }
    if (alg.name === 'PBKDF2') {
      return new CryptoKey('secret', false, { name: 'PBKDF2' }, [...keyUsages], new Uint8Array(bytes));
    }
    if (alg.name === 'HKDF') {
      return new CryptoKey('secret', false, { name: 'HKDF' }, [...keyUsages], new Uint8Array(bytes));
    }
    throw _webCryptoError('NotSupportedError', 'importKey: unsupported algorithm: ' + alg.name);
  },
  /**
  * See `SubtleCrypto.exportKey()`.
  */
  async exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer | object> {
    _checkCryptoAvailable();
    if (format === 'jwk') {
      if (!key.extractable) throw _webCryptoError('InvalidAccessError', 'CryptoKey is not extractable');
      const algName = key.algorithm.name;
      if (algName === 'Ed25519') {
        const x = openssl.evpPkeyExportRawPublicEd25519(_pkeyPtr(key));
        const jwk: Record<string, unknown> = {
          kty: 'OKP',
          crv: 'Ed25519',
          x: _base64urlEncode(x),
          key_ops: [...key.usages],
          ext: key.extractable
        };
        if (key.type === 'private') {
          jwk['d'] = _base64urlEncode(openssl.evpPkeyExportRawPrivateEd25519(_pkeyPtr(key)));
        }
        return (jwk as unknown) as ArrayBuffer;
      }
      // RSA JWK export.
      if (algName === 'RSA-OAEP' || algName === 'RSA-PSS' || algName === 'RSASSA-PKCS1-V1_5') {
        const hashName = key.algorithm.hash?.name ?? 'SHA-256';
        const jwkAlg = _rsaJwkAlg(algName, hashName);
        if (key.type === 'public') {
          const { n, e } = _rsaParseSpki(openssl.evpPkeyExportSpkiRsa(_pkeyPtr(key)));
          return ({
            kty: 'RSA',
            alg: jwkAlg,
            n: _base64urlEncode(n),
            e: _base64urlEncode(e),
            key_ops: [...key.usages],
            ext: key.extractable
          } as unknown) as ArrayBuffer;
        }
        const { n, e, d, p, q, dp, dq, qi } = _rsaParsePkcs8(openssl.evpPkeyExportPkcs8(_pkeyPtr(key)));
        return ({
          kty: 'RSA',
          alg: jwkAlg,
          n: _base64urlEncode(n),
          e: _base64urlEncode(e),
          d: _base64urlEncode(d),
          p: _base64urlEncode(p),
          q: _base64urlEncode(q),
          dp: _base64urlEncode(dp),
          dq: _base64urlEncode(dq),
          qi: _base64urlEncode(qi),
          key_ops: [...key.usages],
          ext: key.extractable
        } as unknown) as ArrayBuffer;
      }
      // EC JWK export (ECDSA and ECDH).
      if (algName === 'ECDSA' || algName === 'ECDH') {
        const namedCurve = key.algorithm.namedCurve ?? 'P-256';
        const { x, y } = openssl.ecPublicKeyCoords(_pkeyPtr(key), namedCurve);
        const crvMap: Record<string, string> = {
          'P-256': 'P-256',
          'P-384': 'P-384',
          'P-521': 'P-521'
        };
        const jwk: Record<string, unknown> = {
          kty: 'EC',
          crv: crvMap[namedCurve] ?? namedCurve,
          x: _base64urlEncode(x),
          y: _base64urlEncode(y),
          key_ops: [...key.usages],
          ext: key.extractable
        };
        if (key.type === 'private') {
          const d = openssl.ecPrivateKeyD(_pkeyPtr(key), openssl.ecdsaCoordSize(namedCurve));
          jwk['d'] = _base64urlEncode(d);
        }
        return (jwk as unknown) as ArrayBuffer;
      }
      // Symmetric JWK export.
      const keyBytes = _keyData(key);
      const algLen = key.algorithm.length;
      let jwkAlg: string;
      if (algName === 'HMAC') {
        const hash = (key.algorithm as {
          hash?: {
            name: string;
          };
        }).hash?.name ?? 'SHA-256';
        jwkAlg = hash === 'SHA-384' ? 'HS384' : hash === 'SHA-512' ? 'HS512' : 'HS256';
      } else if (algName === 'AES-GCM') {
        jwkAlg = algLen === 128 ? 'A128GCM' : 'A256GCM';
      } else if (algName === 'AES-CBC') {
        jwkAlg = algLen === 128 ? 'A128CBC' : 'A256CBC';
      } else if (algName === 'AES-CTR') {
        jwkAlg = algLen === 128 ? 'A128CTR' : algLen === 192 ? 'A192CTR' : 'A256CTR';
      } else {
        throw _webCryptoError('NotSupportedError', `exportKey: JWK not supported for algorithm ${algName}`);
      }
      return ({
        kty: 'oct',
        k: _base64urlEncode(keyBytes),
        alg: jwkAlg,
        key_ops: [...key.usages],
        ext: key.extractable
      } as unknown) as ArrayBuffer;
    }
    if (format === 'pkcs8') {
      if (!key.extractable) throw _webCryptoError('InvalidAccessError', 'CryptoKey is not extractable');
      if (key.type !== 'private') throw _webCryptoError('InvalidAccessError', 'exportKey: pkcs8 requires a private key');
      return _toArrayBuffer(openssl.evpPkeyExportPkcs8(_pkeyPtr(key)));
    }
    if (format === 'spki') {
      if (!key.extractable) throw _webCryptoError('InvalidAccessError', 'CryptoKey is not extractable');
      const algName = key.algorithm.name;
      if (algName === 'Ed25519') {
        return _toArrayBuffer(openssl.evpPkeyExportSpkiDer(_pkeyPtr(key)));
      }
      if (algName === 'RSA-OAEP' || algName === 'RSA-PSS' || algName === 'RSASSA-PKCS1-V1_5') {
        return _toArrayBuffer(openssl.evpPkeyExportSpkiRsa(_pkeyPtr(key)));
      }
      if (algName !== 'ECDSA' && algName !== 'ECDH') {
        throw _webCryptoError('NotSupportedError', 'exportKey: "spki" format only supported for EC and RSA algorithms');
      }
      const namedCurve = key.algorithm.namedCurve ?? 'P-256';
      return _toArrayBuffer(openssl.evpPkeyExportSpki(_pkeyPtr(key), namedCurve));
    }
    if (format !== 'raw') throw _webCryptoError('NotSupportedError', `exportKey: unsupported format "${format}"; supported: "raw", "pkcs8", "spki", "jwk"`);
    if (!key.extractable) throw _webCryptoError('InvalidAccessError', 'CryptoKey is not extractable');
    if (key.algorithm.name === 'Ed25519') {
      if (key.type !== 'public') throw _webCryptoError('InvalidAccessError', 'exportKey: raw Ed25519 requires a public key');
      return _toArrayBuffer(openssl.evpPkeyExportRawPublicEd25519(_pkeyPtr(key)));
    }
    return _toArrayBuffer(_keyData(key));
  },
  /**
  * See `SubtleCrypto.generateKey()`.
  */
  async generateKey(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey | {
    privateKey: CryptoKey;
    publicKey: CryptoKey;
  }> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (_isEd25519Algorithm(alg.name)) {
      const allowedUsages = new Set<KeyUsage>(['sign', 'verify']);
      if (keyUsages.length === 0 || keyUsages.some((usage) => !allowedUsages.has(usage))) {
        throw _webCryptoError('SyntaxError', 'Ed25519: invalid key usages');
      }
      const pkeyFull = openssl.evpPkeyGenerateEd25519();
      let pkeyPub: object;
      try {
        pkeyPub = openssl.evpPkeyImportRawPublicEd25519(openssl.evpPkeyExportRawPublicEd25519(pkeyFull));
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const algoDescriptor: KeyAlgorithm = { name: 'Ed25519' };
      const privateUsages = keyUsages.filter((u) => u === 'sign');
      const publicUsages = keyUsages.filter((u) => u === 'verify');
      const privateKey = new CryptoKey('private', extractable, algoDescriptor, privateUsages, null, pkeyFull);
      const publicKey = new CryptoKey('public', true, algoDescriptor, publicUsages, null, pkeyPub);
      return {
        privateKey,
        publicKey
      };
    }
    if (alg.name === 'ECDH') {
      const namedCurve = (alg as {
        namedCurve?: string;
      }).namedCurve ?? 'P-256';
      const pkeyFull = openssl.evpPkeyGenerateEc(namedCurve);
      let pkeyPub: object;
      try {
        const spki = openssl.evpPkeyExportSpki(pkeyFull, namedCurve);
        ({pkey: pkeyPub} = openssl.evpPkeyImportSpki(spki));
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const algoDescriptor: KeyAlgorithm = {
        name: 'ECDH',
        namedCurve
      };
      const privateUsages = keyUsages.filter((u) => u === 'deriveKey' || u === 'deriveBits');
      const privateKey = new CryptoKey('private', extractable, algoDescriptor, privateUsages.length ? privateUsages : ['deriveKey', 'deriveBits'], null, pkeyFull);
      const publicKey = new CryptoKey('public', extractable, algoDescriptor, [], null, pkeyPub);
      return {
        privateKey,
        publicKey
      };
    }
    if (alg.name === 'ECDSA') {
      const namedCurve = (alg as {
        namedCurve?: string;
      }).namedCurve ?? 'P-256';
      const pkeyFull = openssl.evpPkeyGenerateEc(namedCurve);
      // Export public component and re-import as a separate public-only key so
      // each CryptoKey has independent lifetime managed by FinalizationRegistry.
      let pkeyPub: object;
      try {
        const spki = openssl.evpPkeyExportSpki(pkeyFull, namedCurve);
        ({pkey: pkeyPub} = openssl.evpPkeyImportSpki(spki));
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const algoDescriptor: KeyAlgorithm = {
        name: 'ECDSA',
        namedCurve
      };
      const privateUsages = keyUsages.filter((u) => u === 'sign');
      const publicUsages = keyUsages.filter((u) => u === 'verify');
      const privateKey = new CryptoKey('private', extractable, algoDescriptor, privateUsages.length ? privateUsages : ['sign'], null, pkeyFull);
      const publicKey = new CryptoKey('public', extractable, algoDescriptor, publicUsages.length ? publicUsages : ['verify'], null, pkeyPub);
      return {
        privateKey,
        publicKey
      };
    }
    if (alg.name === 'RSA-OAEP' || alg.name === 'RSA-PSS' || alg.name === 'RSASSA-PKCS1-V1_5') {
      const modulusLength = (alg as {
        modulusLength?: number;
      }).modulusLength ?? 2048;
      const rawExponent = (alg as {
        publicExponent?: Uint8Array;
      }).publicExponent ?? new Uint8Array([
        1,
        0,
        1
      ]);
      const publicExponent = new Uint8Array(rawExponent);
      // Decode up to 4 bytes of big-endian exponent (covers 65537 = 0x010001).
      const expBytes = publicExponent.slice(-Math.min(4, publicExponent.length));
      let exponentNum = 0;
      for (let i = 0; i < expBytes.length; i++) exponentNum = exponentNum << 8 | expBytes[i]!;
      const hashName = _hashName((alg as {
        hash?: string | {
          name: string;
        };
      }).hash ?? 'SHA-256');
      _digestAlgorithm(hashName);
      const pkeyFull = openssl.evpPkeyGenerateRsa(modulusLength, exponentNum || 65537);
      let pkeyPub: object;
      try {
        const spki = openssl.evpPkeyExportSpkiRsa(pkeyFull);
        pkeyPub = openssl.evpPkeyImportSpkiRsa(spki);
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const rsaAlgo: KeyAlgorithm = {
        name: alg.name,
        hash: { name: hashName },
        modulusLength,
        publicExponent
      };
      const privateUsages = keyUsages.filter((u) => u === 'decrypt' || u === 'sign' || u === 'unwrapKey');
      const publicUsages = keyUsages.filter((u) => u === 'encrypt' || u === 'verify' || u === 'wrapKey');
      const privateKey = new CryptoKey('private', extractable, rsaAlgo, privateUsages, null, pkeyFull);
      const publicKey = new CryptoKey('public', extractable, rsaAlgo, publicUsages, null, pkeyPub);
      return {
        privateKey,
        publicKey
      };
    }
    if (alg.name === 'HMAC') {
      const hashName = _hashName(alg.hash ?? 'SHA-256');
      const digestName = _digestAlgorithm(hashName);
      const allowedUsages = new Set<KeyUsage>(['sign', 'verify']);
      if (keyUsages.length === 0 || keyUsages.some((usage) => !allowedUsages.has(usage))) {
        throw _webCryptoError('SyntaxError', 'HMAC: invalid key usages');
      }
      const defaultLength = {
        'sha-1': 512,
        'sha-256': 512,
        'sha-384': 1024,
        'sha-512': 1024
      }[digestName];
      if (defaultLength === undefined) throw _webCryptoError('NotSupportedError', `Unsupported HMAC digest: ${digestName}`);
      const keyLength = alg.length ?? defaultLength;
      const keyLen = Math.ceil(keyLength / 8);
      const buf = new ArrayBuffer(keyLen);
      openssl.randBytes(buf, keyLen);
      return new CryptoKey('secret', extractable, {
        name: 'HMAC',
        hash: { name: hashName },
        length: keyLength
      }, [...keyUsages], new Uint8Array(buf));
    }
    if (alg.name === 'AES-GCM' || alg.name === 'AES-CBC' || alg.name === 'AES-CTR') {
      const length = alg.length ?? 256;
      if (length !== 128 && length !== 192 && length !== 256) {
        throw _webCryptoError('OperationError', `${alg.name}: key length must be 128, 192, or 256`);
      }
      const allowedUsages = new Set<KeyUsage>([
        'encrypt',
        'decrypt',
        'wrapKey',
        'unwrapKey'
      ]);
      if (keyUsages.length === 0 || keyUsages.some((usage) => !allowedUsages.has(usage))) {
        throw _webCryptoError('SyntaxError', `${alg.name}: invalid key usages`);
      }
      const keyLen = length / 8;
      const buf = new ArrayBuffer(keyLen);
      openssl.randBytes(buf, keyLen);
      return new CryptoKey('secret', extractable, {
        name: alg.name,
        length
      }, [...keyUsages], new Uint8Array(buf));
    }
    throw _webCryptoError('NotSupportedError', 'generateKey: unsupported algorithm: ' + alg.name);
  },
  /**
  * See `SubtleCrypto.deriveBits()`.
  */
  async deriveBits(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, baseKey: CryptoKey, length?: number | null): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (alg.name === 'ECDH') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow deriveBits/deriveKey');
      }
      if (baseKey.type !== 'private') throw _webCryptoError('InvalidAccessError', 'ECDH deriveBits requires a private key');
      const publicKeyParam = alg.public;
      if (!publicKeyParam || !(publicKeyParam instanceof CryptoKey)) {
        throw _webCryptoError('DataError', 'ECDH deriveBits: algorithm.public must be an ECDH public CryptoKey');
      }
      if (publicKeyParam.type !== 'public') throw _webCryptoError('InvalidAccessError', 'ECDH deriveBits: algorithm.public must be a public key');
      const privCurve = baseKey.algorithm.namedCurve;
      const pubCurve = publicKeyParam.algorithm.namedCurve;
      if (privCurve !== pubCurve) {
        throw _webCryptoError('InvalidAccessError', `ECDH deriveBits: key curves do not match (${privCurve} vs ${pubCurve})`);
      }
      const secret = openssl.evpPkeyDeriveEcdh(_pkeyPtr(baseKey), _pkeyPtr(publicKeyParam));
      const requestedBits = length == null ? secret.byteLength * 8 : length;
      if (!Number.isInteger(requestedBits) || requestedBits < 0) {
        throw _webCryptoError('OperationError', 'ECDH deriveBits: length must be a non-negative integer');
      }
      const requestedBytes = Math.ceil(requestedBits / 8);
      if (requestedBytes > secret.byteLength) {
        throw _webCryptoError('OperationError', `ECDH deriveBits: requested ${requestedBytes} bytes but shared secret is only ${secret.byteLength}`);
      }
      const out = secret.slice(0, requestedBytes);
      const remainder = requestedBits % 8;
      if (remainder !== 0 && out.byteLength !== 0) {
        out[out.byteLength - 1] = out[out.byteLength - 1]! & 255 << 8 - remainder;
      }
      return _toArrayBuffer(out);
    }
    const keyBytes = _keyData(baseKey);
    const keyLen = _deriveBitsByteLength(length);
    if (alg.name === 'PBKDF2') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow deriveBits');
      }
      const salt = _toUint8Array(_requiredBufferSource(alg.salt, 'PBKDF2 salt'));
      const iterations = alg.iterations;
      if (iterations === undefined) throw _webCryptoError('DataError', 'PBKDF2 iterations are required');
      const hash = _digestAlgorithm(_hashName(alg.hash ?? 'SHA-256'));
      return _toArrayBuffer(openssl.pbkdf2(keyBytes, salt, iterations, hash, keyLen));
    }
    if (alg.name === 'HKDF') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw _webCryptoError('InvalidAccessError', 'CryptoKey does not allow deriveBits');
      }
      const salt = alg.salt ? _toUint8Array(alg.salt) : new Uint8Array(0);
      const info = alg.info ? _toUint8Array(alg.info) : new Uint8Array(0);
      const hash = _digestAlgorithm(_hashName(alg.hash ?? 'SHA-256'));
      return _toArrayBuffer(openssl.hkdf(hash, keyBytes, salt, info, keyLen));
    }
    throw _webCryptoError('NotSupportedError', 'deriveBits: unsupported algorithm: ' + alg.name);
  },
  /**
  * See `SubtleCrypto.deriveKey()`.
  */
  async deriveKey(algorithm: string | {
    name: string;
    [key: string]: unknown;
  }, baseKey: CryptoKey, derivedKeyType: string | {
    name: string;
    length?: number;
    [key: string]: unknown;
  }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    _checkCryptoAvailable();
    const derivedAlg = _normalizeAlgorithm(derivedKeyType);
    // Determine the derived key length in bits from the derivedKeyType.
    let lengthBits: number;
    if (derivedAlg.name === 'HMAC') {
      const hashName = _hashName(derivedAlg.hash ?? 'SHA-256');
      const digestName = _digestAlgorithm(hashName);
      lengthBits = (derivedAlg.length ?? {
        'sha-1': 160,
        'sha-256': 256,
        'sha-384': 384,
        'sha-512': 512
      }[digestName]) as number;
    } else if (derivedAlg.name === 'AES-GCM' || derivedAlg.name === 'AES-CBC') {
      lengthBits = derivedAlg.length ?? 256;
    } else {
      throw _webCryptoError('NotSupportedError', 'deriveKey: unsupported derivedKeyType: ' + derivedAlg.name);
    }
    const bits = await subtle.deriveBits(algorithm, baseKey, lengthBits);
    return subtle.importKey('raw', bits, derivedKeyType, extractable, keyUsages);
  },
  /**
  * See `SubtleCrypto.wrapKey()`.
  */
  async wrapKey(format: KeyFormat, key: CryptoKey, wrappingKey: CryptoKey, wrapAlgorithm: string | {
    name: string;
    [k: string]: unknown;
  }): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    if (!key.extractable) throw _webCryptoError('InvalidAccessError', 'wrapKey: key is not extractable');
    if (!wrappingKey.usages.includes('wrapKey')) throw _webCryptoError('InvalidAccessError', 'wrappingKey does not allow wrapKey');
    const exported = await subtle.exportKey(format, key);
    const keyBytes = format === 'jwk' ? new TextEncoder().encode(JSON.stringify(exported)) : new Uint8Array(exported as ArrayBuffer);
    // Call encrypt bypassing the 'encrypt' usage check — wrapKey's own 'wrapKey'
    // usage check above is the authoritative gate for this operation.
    const alg = _normalizeAlgorithm(wrapAlgorithm);
    if (alg.name !== 'AES-GCM' && alg.name !== 'AES-CBC') {
      throw _webCryptoError('NotSupportedError', 'wrapKey: unsupported algorithm "' + alg.name + '"');
    }
    if (wrappingKey.algorithm.name !== alg.name || wrappingKey.type !== 'secret') {
      throw _webCryptoError('InvalidAccessError', `${alg.name} wrapKey requires a matching secret key`);
    }
    const wrappingKeyBytes = _keyData(wrappingKey);
    const cipherAlg = _cipherAlgorithm(alg.name, wrappingKeyBytes.byteLength);
    const iv = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData as BufferSource) : null;
    const { ciphertext, tag } = openssl.cipherEncrypt(cipherAlg, wrappingKeyBytes, iv, keyBytes, aad);
    if (tag) {
      const requestedTagBytes = (alg.tagLength as number | undefined ?? 128) / 8;
      const truncatedTag = tag.subarray(0, requestedTagBytes);
      const out = new Uint8Array(ciphertext.byteLength + truncatedTag.byteLength);
      out.set(ciphertext);
      out.set(truncatedTag, ciphertext.byteLength);
      return _toArrayBuffer(out);
    }
    return _toArrayBuffer(ciphertext);
  },
  /**
  * See `SubtleCrypto.unwrapKey()`.
  */
  async unwrapKey(format: KeyFormat, wrappedKey: BufferSource, unwrappingKey: CryptoKey, unwrapAlgorithm: string | {
    name: string;
    [k: string]: unknown;
  }, unwrappedKeyAlgorithm: string | {
    name: string;
    [k: string]: unknown;
  }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    _checkCryptoAvailable();
    if (!unwrappingKey.usages.includes('unwrapKey')) throw _webCryptoError('InvalidAccessError', 'unwrappingKey does not allow unwrapKey');
    // Bypass the 'decrypt' usage check in subtle.decrypt — unwrapKey's own
    // 'unwrapKey' usage check above is the authoritative gate.
    const alg = _normalizeAlgorithm(unwrapAlgorithm);
    if (alg.name !== 'AES-GCM' && alg.name !== 'AES-CBC') {
      throw _webCryptoError('NotSupportedError', 'unwrapKey: unsupported algorithm "' + alg.name + '"');
    }
    if (unwrappingKey.algorithm.name !== alg.name || unwrappingKey.type !== 'secret') {
      throw _webCryptoError('InvalidAccessError', `${alg.name} unwrapKey requires a matching secret key`);
    }
    const unwrappingKeyBytes = _keyData(unwrappingKey);
    const cipherAlg = _cipherAlgorithm(alg.name, unwrappingKeyBytes.byteLength);
    const iv = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData as BufferSource) : null;
    const wrappedBytes = _toUint8Array(wrappedKey);
    const tagLen = (alg.tagLength as number | undefined ?? 128) / 8;
    const ct = wrappedBytes.subarray(0, wrappedBytes.byteLength - tagLen);
    const tag = wrappedBytes.subarray(wrappedBytes.byteLength - tagLen);
    let decrypted: ArrayBuffer;
    try {
      decrypted = _toArrayBuffer(openssl.cipherDecrypt(cipherAlg, unwrappingKeyBytes, iv, ct, tag, aad));
    } catch (err) {
      throw _webCryptoError('OperationError', err instanceof Error ? err.message : 'unwrapKey operation failed');
    }
    if (format === 'raw') {
      return subtle.importKey('raw', decrypted, unwrappedKeyAlgorithm, extractable, keyUsages);
    }
    if (format === 'jwk') {
      const text = new TextDecoder().decode(decrypted);
      const jwk = JSON.parse(text) as unknown;
      return subtle.importKey('jwk', jwk as BufferSource, unwrappedKeyAlgorithm, extractable, keyUsages);
    }
    throw _webCryptoError('NotSupportedError', `unwrapKey: unsupported format "${format}"`);
  }
};
// ---------------------------------------------------------------------------
// crypto object (globalThis.crypto)
// ---------------------------------------------------------------------------
/**
* The Web Crypto global object installed as `globalThis.crypto`.
*
* `Crypto` provides synchronous random byte generation, random UUID creation,
* and the asynchronous `subtle` cryptography surface.
*
* ```ts no_run
* const nonce = crypto.getRandomValues(new Uint8Array(16));
* const requestId = crypto.randomUUID();
* const fingerprint = await crypto.subtle.digest('SHA-256', nonce);
* ```
*/
export interface Crypto {
  /**
  * Brand string used by `Object.prototype.toString.call(crypto)`.
  */
  readonly [Symbol.toStringTag]: string;
  /**
  * Fill `typedArray` with cryptographically strong random bytes.
  *
  * The same array object is returned. Only the region the view covers is
  * filled, so sub-array views leave the rest of the backing buffer untouched.
  *
  * Throws `TypeMismatchError` for non-integer typed arrays such as
  * `Float64Array`, and `QuotaExceededError` for views larger than 65,536
  * bytes, matching the Web Crypto quota.
  *
  * ```ts no_run
  * const iv = crypto.getRandomValues(new Uint8Array(12));
  * ```
  */
  getRandomValues<T extends ArrayBufferView>(typedArray: T): T;
  /**
  * Return a version 4 random UUID string.
  *
  * Randomness comes from libcrypto via `fino:uuid`.
  *
  * ```ts no_run
  * crypto.randomUUID(); // "8b4bd1ab-…-…-…-…"
  * ```
  */
  randomUUID(): string;
  /**
  * Asynchronous Web Crypto operation surface.
  */
  readonly subtle: SubtleCrypto;
}
/**
* Web Crypto global object backed by OpenSSL.
*
* Methods throw an informative Error when libcrypto is unavailable. The object
* is installed on globalThis when this module is imported.
*
* ```ts no_run
* const bytes = crypto.getRandomValues(new Uint8Array(8));
* const id = crypto.randomUUID();
* ```
*/
export const crypto: Crypto = {
  get [Symbol.toStringTag]() {
    return 'Crypto';
  },
  /**
  * See `Crypto.getRandomValues()`.
  */
  getRandomValues<T extends ArrayBufferView>(typedArray: T): T {
    _checkCryptoAvailable();
    if (!(typedArray instanceof Int8Array || typedArray instanceof Uint8Array || typedArray instanceof Uint8ClampedArray || typedArray instanceof Int16Array || typedArray instanceof Uint16Array || typedArray instanceof Int32Array || typedArray instanceof Uint32Array || typedArray instanceof BigInt64Array || typedArray instanceof BigUint64Array)) {
      throw _webCryptoError('TypeMismatchError', 'getRandomValues: argument must be an integer typed array');
    }
    if (typedArray.byteLength > 65536) {
      throw new QuotaExceededError('getRandomValues: quota exceeded (max 65536 bytes)');
    }
    // Fill only the portion of the backing buffer the view covers,
    // respecting byteOffset for sub-array views.
    if (typedArray.byteOffset === 0 && typedArray.byteLength === typedArray.buffer.byteLength) {
      openssl.randBytes(typedArray.buffer as ArrayBuffer, typedArray.byteLength);
    } else {
      const tmp = new ArrayBuffer(typedArray.byteLength);
      openssl.randBytes(tmp, typedArray.byteLength);
      new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).set(new Uint8Array(tmp));
    }
    return typedArray;
  },
  /**
  * See `Crypto.randomUUID()`.
  */
  randomUUID(): string {
    _checkCryptoAvailable();
    return _uuidV4().toString();
  },
  /**
  * See `Crypto.subtle` and the `SubtleCrypto` interface.
  */
  subtle
};
// Register on globalThis
_registerCryptoKeyCloneHelper({
  isCryptoKey: (value: object) => value instanceof CryptoKey,
  cloneCryptoKey: (value: object) => _cloneCryptoKey(value as CryptoKey)
});
globalThis.crypto = (crypto as unknown) as typeof globalThis.crypto;
(globalThis as Record<string, unknown>).CryptoKey = CryptoKey;
/**
* Whether the OpenSSL libcrypto backend loaded successfully.
*
* When false, crypto methods throw instead of attempting unavailable FFI calls.
*
* ```ts no_run
* if (!cryptoAvailable) console.warn('crypto disabled');
* ```
*/
export const cryptoAvailable = openssl.cryptoAvailable;
/**
* Whether the OpenSSL libssl TLS backend loaded successfully.
*
* This flag is exported from the crypto globals module for code that wants to
* check TLS support alongside crypto support.
*
* ```ts no_run
* if (!tlsAvailable) console.warn('tls disabled');
* ```
*/
export const tlsAvailable = openssl.tlsAvailable;
