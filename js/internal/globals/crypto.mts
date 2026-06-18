/**
 * internal:globals/crypto — Web Crypto API global.
 *
 * Implements a useful subset of the W3C Web Cryptography API:
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
 * Backed by internal:openssl (libcrypto via FFI). If OpenSSL is not installed,
 * every method throws an informative error rather than crashing the process.
 *
 * Registers `globalThis.crypto` at import time.
 *
 * ## Example
 *
 * ```typescript no_run
 * import { crypto, cryptoAvailable } from 'internal:globals/crypto';
 *
 * if (cryptoAvailable) {
 *   const data = new TextEncoder().encode('hello');
 *   const digest = await crypto.subtle.digest('SHA-256', data);
 *   console.log(new Uint8Array(digest).byteLength);
 * }
 * ```
 *
 * @internal
 */

import * as openssl from '../openssl.mts';
import { v4 as _uuidV4 } from 'fino:uuid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type KeyType   = 'public' | 'private' | 'secret';
type KeyFormat = 'raw' | 'pkcs8' | 'spki' | 'jwk';
type KeyUsage  = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';

type BufferSource = ArrayBuffer | ArrayBufferView;

/** Normalized algorithm object used internally after calling _normalizeAlgorithm(). */
interface NormalizedAlgorithm {
  name: string;
  hash?: string | { name: string };
  iv?: BufferSource;
  additionalData?: BufferSource;
  tagLength?: number;
  length?: number;
  salt?: BufferSource;
  iterations?: number;
  info?: BufferSource;
  label?: BufferSource;     // RSA-OAEP optional label
  saltLength?: number;      // RSA-PSS salt length
  public?: CryptoKey;       // ECDH public key parameter
  namedCurve?: string;      // EC key generation
  modulusLength?: number;   // RSA key generation
  publicExponent?: Uint8Array; // RSA key generation
}

/** Algorithm descriptor stored on a CryptoKey. */
interface CryptoKeyAlgorithm {
  name: string;
  hash?: { name: string };
  length?: number;
  namedCurve?: string;   // EC key curves: 'P-256' | 'P-384' | 'P-521'
  modulusLength?: number;         // RSA: key size in bits
  publicExponent?: Uint8Array;    // RSA: typically [0x01,0x00,0x01] = 65537
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
 * ```typescript no_run
 * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
 * key.type; // "secret"
 * ```
 *
 * @internal
 */
class CryptoKey {
  #type:        KeyType;
  #extractable: boolean;
  #algorithm:   CryptoKeyAlgorithm;
  #usages:      KeyUsage[];

  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
   * Object.prototype.toString.call(key); // "[object CryptoKey]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'CryptoKey'; }

  /**
   * Create an internal CryptoKey wrapper.
   *
   * Symmetric keys store bytes in a WeakMap. Asymmetric keys store an OpenSSL
   * pointer in a WeakMap and register it for finalization. User code receives
   * CryptoKey objects from SubtleCrypto methods rather than constructing them.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
   * key.extractable; // true
   * ```
   */
  constructor(
    type: KeyType,
    extractable: boolean,
    algorithm: CryptoKeyAlgorithm,
    usages: KeyUsage[],
    keyData: Uint8Array | null,
    pkeyPtr: object | null = null,
  ) {
    this.#type        = type;
    this.#extractable = extractable;
    this.#algorithm   = algorithm;
    this.#usages      = usages;
    if (keyData !== null) _keyStore.set(this, keyData);
    if (pkeyPtr !== null) {
      _pkeyStore.set(this, pkeyPtr);
      _pkeyRegistry.register(this, pkeyPtr, this);
    }
  }

  /**
   * Key kind: public, private, or secret.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
   * key.type; // "secret"
   * ```
   */
  get type():        KeyType           { return this.#type; }

  /**
   * Whether exportKey() and wrapKey() are allowed to reveal this key.
   *
   * Non-extractable keys throw when exported or wrapped.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt']);
   * key.extractable; // false
   * ```
   */
  get extractable(): boolean           { return this.#extractable; }

  /**
   * Normalized algorithm descriptor associated with this key.
   *
   * The descriptor includes fields such as hash, length, namedCurve, or RSA
   * modulus information depending on the algorithm.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
   * key.algorithm.name; // "AES-GCM"
   * ```
   */
  get algorithm():   CryptoKeyAlgorithm { return this.#algorithm; }

  /**
   * Frozen copy of allowed key usages.
   *
   * Mutating the returned array is not possible and does not affect the key.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
   * key.usages.includes('encrypt'); // true
   * ```
   */
  get usages():      readonly KeyUsage[] { return Object.freeze([...this.#usages]); }
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

// ---------------------------------------------------------------------------
// Algorithm normalization helpers
// ---------------------------------------------------------------------------

function _normalizeAlgorithm(algorithm: string | { name: string; [key: string]: unknown }): NormalizedAlgorithm {
  if (typeof algorithm === 'string') return { name: algorithm.toUpperCase() };
  return { ...algorithm, name: algorithm.name.toUpperCase() } as NormalizedAlgorithm;
}

function _hashName(hash: string | { name: string }): string {
  // Accept { name: 'SHA-256' } or just 'SHA-256'
  const name = typeof hash === 'string' ? hash : hash.name;
  return name.toUpperCase();
}

// Map Web Crypto algorithm names to openssl.mjs algorithm strings
function _digestAlgorithm(name: string): string {
  switch (name.toUpperCase()) {
    case 'SHA-1':   return 'sha-1';
    case 'SHA-256': return 'sha-256';
    case 'SHA-384': return 'sha-384';
    case 'SHA-512': return 'sha-512';
    default: throw new Error('Unsupported hash algorithm: ' + name);
  }
}

function _cipherAlgorithm(name: string, keyLength: number): string {
  const bits = keyLength * 8;
  switch (name.toUpperCase()) {
    case 'AES-GCM': return bits === 128 ? 'aes-128-gcm' : 'aes-256-gcm';
    case 'AES-CBC': return bits === 128 ? 'aes-128-cbc' : 'aes-256-cbc';
    default: throw new Error('Unsupported cipher algorithm: ' + name);
  }
}

// ---------------------------------------------------------------------------
// Data coercion helpers
// ---------------------------------------------------------------------------

function _toUint8Array(data: BufferSource): Uint8Array {
  if (data instanceof Uint8Array)    return data;
  if (data instanceof ArrayBuffer)   return new Uint8Array(data);
  if (ArrayBuffer.isView(data))      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('data must be an ArrayBuffer or ArrayBufferView');
}

function _checkCryptoAvailable() {
  if (!openssl.cryptoAvailable) {
    throw new Error(
      'crypto: OpenSSL (libcrypto) is not available on this system. ' +
      'Install OpenSSL and ensure it is findable via the standard library paths.',
    );
  }
}

function _requiredBufferSource(value: BufferSource | undefined, name: string): BufferSource {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function _requiredHash(value: string | { name: string } | undefined, name: string): string | { name: string } {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function _toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function _base64urlEncode(bytes: Uint8Array): string {
  let b64 = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!; const b1 = bytes[i + 1] ?? 0; const b2 = bytes[i + 2] ?? 0;
    b64 += chars[b0 >> 2]!;
    b64 += chars[((b0 & 3) << 4) | (b1 >> 4)]!;
    b64 += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)]! : '=';
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

  private _readTag(): number { return this.buf[this.off++]!; }

  private _readLen(): number {
    const first = this.buf[this.off++]!;
    if (first < 0x80) return first;
    const numBytes = first & 0x7f;
    let len = 0;
    for (let i = 0; i < numBytes; i++) len = (len << 8) | this.buf[this.off++]!;
    return len;
  }

  enterSequence(): _DerReader {
    const tag = this._readTag();
    if (tag !== 0x30) throw new Error(`DER: expected SEQUENCE (0x30), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    const sub = new _DerReader(this.buf.subarray(this.off, this.off + len));
    this.off += len;
    return sub;
  }

  skip(): void { this._readTag(); const len = this._readLen(); this.off += len; }

  readInteger(): Uint8Array {
    const tag = this._readTag();
    if (tag !== 0x02) throw new Error(`DER: expected INTEGER (0x02), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    const bytes = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    return bytes.subarray(start);
  }

  readBitStringContent(): Uint8Array {
    const tag = this._readTag();
    if (tag !== 0x03) throw new Error(`DER: expected BIT STRING (0x03), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    this.off++; // skip unused-bits byte (always 0 for RSA)
    const content = this.buf.subarray(this.off, this.off + len - 1);
    this.off += len - 1;
    return content;
  }

  readOctetStringContent(): Uint8Array {
    const tag = this._readTag();
    if (tag !== 0x04) throw new Error(`DER: expected OCTET STRING (0x04), got 0x${tag.toString(16)}`);
    const len = this._readLen();
    const content = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return content;
  }
}

function _rsaParseSpki(der: Uint8Array): { n: Uint8Array; e: Uint8Array } {
  const root   = new _DerReader(der).enterSequence();
  root.skip();                                        // AlgorithmIdentifier SEQUENCE
  const bitStr = root.readBitStringContent();         // BIT STRING → RSAPublicKey
  const rsa    = new _DerReader(bitStr).enterSequence();
  return { n: rsa.readInteger(), e: rsa.readInteger() };
}

function _rsaParsePkcs8(der: Uint8Array): {
  n: Uint8Array; e: Uint8Array; d: Uint8Array;
  p: Uint8Array; q: Uint8Array; dp: Uint8Array; dq: Uint8Array; qi: Uint8Array;
} {
  const root = new _DerReader(der).enterSequence();
  root.skip();                                       // version INTEGER
  root.skip();                                       // AlgorithmIdentifier SEQUENCE
  const privKeyBytes = root.readOctetStringContent(); // OCTET STRING → RSAPrivateKey
  const rsa = new _DerReader(privKeyBytes).enterSequence();
  rsa.skip();                                        // version INTEGER
  return {
    n:  rsa.readInteger(),
    e:  rsa.readInteger(),
    d:  rsa.readInteger(),
    p:  rsa.readInteger(),
    q:  rsa.readInteger(),
    dp: rsa.readInteger(),
    dq: rsa.readInteger(),
    qi: rsa.readInteger(),
  };
}

function _rsaJwkAlg(algName: string, hashName: string): string {
  if (algName === 'RSA-OAEP')           return `RSA-OAEP${hashName === 'SHA-256' ? '-256' : hashName === 'SHA-384' ? '-384' : '-512'}`;
  if (algName === 'RSA-PSS')            return hashName === 'SHA-256' ? 'PS256' : hashName === 'SHA-384' ? 'PS384' : 'PS512';
  /* RSASSA-PKCS1-V1_5 */               return hashName === 'SHA-256' ? 'RS256' : hashName === 'SHA-384' ? 'RS384' : 'RS512';
}

// ---------------------------------------------------------------------------
// ECDSA DER ↔ raw signature conversion helpers
//
// WebCrypto uses raw (2 × coordSize)-byte signatures: big-endian r ‖ s.
// OpenSSL ECDSA_sign/verify uses ASN.1 DER-encoded signatures.
// `coordSize` is 32 for P-256, 48 for P-384, 66 for P-521.
// ---------------------------------------------------------------------------

function _derSigToRaw(der: Uint8Array, coordSize: number): Uint8Array {
  if (der[0] !== 0x30) throw new Error('Invalid ECDSA DER signature: expected SEQUENCE (0x30)');
  let off = 2; // skip SEQUENCE tag + length (assuming short-form length)
  // Handle long-form sequence length (P-521 SEQUENCE length > 127)
  if ((der[1]! & 0x80) !== 0) off = 2 + (der[1]! & 0x7f);
  if (der[off] !== 0x02) throw new Error('Invalid ECDSA DER signature: expected INTEGER for r');
  off++;
  const rLen = der[off++]!;
  if (off + rLen > der.length) throw new Error('Invalid ECDSA DER signature: r length overruns buffer');
  const rBytes = der.subarray(off, off + rLen); off += rLen;
  if (der[off] !== 0x02) throw new Error('Invalid ECDSA DER signature: expected INTEGER for s');
  off++;
  const sLen = der[off++]!;
  if (off + sLen > der.length) throw new Error('Invalid ECDSA DER signature: s length overruns buffer');
  const sBytes = der.subarray(off, off + sLen);

  const raw = new Uint8Array(coordSize * 2);
  const rStart = rBytes[0] === 0x00 ? 1 : 0;
  const rSlice = rBytes.subarray(rStart);
  if (rSlice.length > coordSize) throw new Error('Invalid ECDSA DER signature: r value too large');
  raw.set(rSlice, coordSize - rSlice.length);
  const sStart = sBytes[0] === 0x00 ? 1 : 0;
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
    const needsPad = (b[start]! & 0x80) !== 0;
    const out = new Uint8Array(needsPad ? b.length - start + 1 : b.length - start);
    if (needsPad) { out[0] = 0x00; out.set(b.subarray(start), 1); }
    else           { out.set(b.subarray(start)); }
    return out;
  }

  const r = _encodeInt(raw.subarray(0, coordSize));
  const s = _encodeInt(raw.subarray(coordSize));
  const inner = 2 + r.length + 2 + s.length;

  // Use long-form SEQUENCE length when inner > 127 (P-521 signatures).
  let der: Uint8Array;
  if (inner > 127) {
    der = new Uint8Array(3 + inner); // 30 81 <len> ...
    der[0] = 0x30; der[1] = 0x81; der[2] = inner;
    der[3] = 0x02; der[4] = r.length; der.set(r, 5);
    der[5 + r.length] = 0x02; der[6 + r.length] = s.length; der.set(s, 7 + r.length);
  } else {
    der = new Uint8Array(2 + inner);
    der[0] = 0x30; der[1] = inner;
    der[2] = 0x02; der[3] = r.length; der.set(r, 4);
    der[4 + r.length] = 0x02; der[5 + r.length] = s.length; der.set(s, 6 + r.length);
  }
  return der;
}

/** Return the coordinate byte size for a CryptoKey's named curve. */
function _ecCoordSize(key: CryptoKey): number {
  return openssl.ecdsaCoordSize(key.algorithm.namedCurve ?? 'P-256');
}

// ---------------------------------------------------------------------------
// SubtleCrypto
// ---------------------------------------------------------------------------

const subtle = {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(crypto.subtle); // "[object SubtleCrypto]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'SubtleCrypto'; },

  // -------------------------------------------------------------------------
  // digest
  // -------------------------------------------------------------------------

  /**
   * Compute a hash digest for `data`.
   *
   * Supports SHA-1, SHA-256, SHA-384, and SHA-512. Throws if OpenSSL is not
   * available or the algorithm is unsupported.
   *
   * ```typescript no_run
   * const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello'));
   * digest.byteLength; // 32
   * ```
   */
  async digest(algorithm: string | { name: string; [key: string]: unknown }, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg  = _normalizeAlgorithm(algorithm);
    const hash = _digestAlgorithm(alg.name);
    const arr  = _toUint8Array(data);
    return _toArrayBuffer(openssl.digest(hash, arr));
  },

  // -------------------------------------------------------------------------
  // sign / verify — HMAC and ECDSA
  // -------------------------------------------------------------------------

  /**
   * Sign `data` with an HMAC, ECDSA, RSA-PSS, or RSASSA-PKCS1-v1_5 key.
   *
   * The key must include the "sign" usage. ECDSA signatures are returned in
   * WebCrypto raw r||s form; RSA and HMAC return backend-produced bytes.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
   * const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array([1]));
   * ```
   */
  async sign(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (alg.name === 'ECDSA') {
      if (!key.usages.includes('sign')) throw new Error('CryptoKey does not allow sign');
      const hashAlg = _digestAlgorithm(_hashName(_requiredHash(alg.hash, 'ECDSA hash')));
      const hash    = openssl.digest(hashAlg, _toUint8Array(data));
      const der     = openssl.ecdsaSign(hash, _pkeyPtr(key));
      return _toArrayBuffer(_derSigToRaw(der, _ecCoordSize(key)));
    }

    if (alg.name === 'RSA-PSS') {
      if (!key.usages.includes('sign')) throw new Error('CryptoKey does not allow sign');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-PSS hash'));
      const hashAlg  = _digestAlgorithm(hashName);
      const saltLen  = (alg as { saltLength?: number }).saltLength ?? -1;
      return _toArrayBuffer(openssl.rsaPssSign(_pkeyPtr(key), hashAlg, saltLen, _toUint8Array(data)));
    }

    if (alg.name === 'RSASSA-PKCS1-V1_5') {
      if (!key.usages.includes('sign')) throw new Error('CryptoKey does not allow sign');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSASSA-PKCS1-v1_5 hash'));
      const hashAlg  = _digestAlgorithm(hashName);
      return _toArrayBuffer(openssl.rsaPkcs1Sign(_pkeyPtr(key), hashAlg, _toUint8Array(data)));
    }

    if (alg.name !== 'HMAC') throw new Error('sign: unsupported algorithm "' + alg.name + '"');
    if (!key.usages.includes('sign')) throw new Error('CryptoKey does not allow sign');
    const hash = _digestAlgorithm(_hashName(_requiredHash(key.algorithm.hash, 'HMAC hash')));
    const mac  = openssl.hmac(hash, _keyData(key), _toUint8Array(data));
    return _toArrayBuffer(mac);
  },

  /**
   * Verify a signature produced by `sign`.
   *
   * Returns false for malformed or non-matching signatures and throws for
   * unsupported algorithms, unavailable OpenSSL, or disallowed key usage.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign', 'verify']);
   * const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array([1]));
   * await crypto.subtle.verify('HMAC', key, sig, new Uint8Array([1])); // true
   * ```
   */
  async verify(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (alg.name === 'ECDSA') {
      if (!key.usages.includes('verify')) throw new Error('CryptoKey does not allow verify');
      const hashAlg = _digestAlgorithm(_hashName(_requiredHash(alg.hash, 'ECDSA hash')));
      const hash    = openssl.digest(hashAlg, _toUint8Array(data));
      let derSig: Uint8Array;
      try {
        derSig = _rawSigToDer(_toUint8Array(signature), _ecCoordSize(key));
      } catch {
        return false; // malformed signature
      }
      return openssl.ecdsaVerify(hash, derSig, _pkeyPtr(key));
    }

    if (alg.name === 'RSA-PSS') {
      if (!key.usages.includes('verify')) throw new Error('CryptoKey does not allow verify');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-PSS hash'));
      const hashAlg  = _digestAlgorithm(hashName);
      return openssl.rsaPssVerify(_pkeyPtr(key), hashAlg, _toUint8Array(signature), _toUint8Array(data));
    }

    if (alg.name === 'RSASSA-PKCS1-V1_5') {
      if (!key.usages.includes('verify')) throw new Error('CryptoKey does not allow verify');
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSASSA-PKCS1-v1_5 hash'));
      const hashAlg  = _digestAlgorithm(hashName);
      return openssl.rsaPkcs1Verify(_pkeyPtr(key), hashAlg, _toUint8Array(signature), _toUint8Array(data));
    }

    if (alg.name !== 'HMAC') throw new Error('verify: unsupported algorithm "' + alg.name + '"');
    if (!key.usages.includes('verify')) throw new Error('CryptoKey does not allow verify');
    const hash     = _digestAlgorithm(_hashName(_requiredHash(key.algorithm.hash, 'HMAC hash')));
    const expected = openssl.hmac(hash, _keyData(key), _toUint8Array(data));
    const actual   = _toUint8Array(signature);

    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ actual[i]!;
    return diff === 0;
  },

  // -------------------------------------------------------------------------
  // encrypt / decrypt — AES-GCM and AES-CBC
  // -------------------------------------------------------------------------

  /**
   * Encrypt data with AES-GCM, AES-CBC, or RSA-OAEP.
   *
   * The key must include the "encrypt" usage. AES-GCM returns ciphertext
   * followed by the authentication tag; AES-CBC returns ciphertext only.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
   * const iv = crypto.getRandomValues(new Uint8Array(12));
   * const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([1]));
   * ```
   */
  async encrypt(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('encrypt')) throw new Error('CryptoKey does not allow encrypt');

    if (alg.name === 'RSA-OAEP') {
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-OAEP hash'));
      const hashAlg  = _digestAlgorithm(hashName);
      const label    = alg.label ? _toUint8Array(alg.label as BufferSource) : null;
      return _toArrayBuffer(openssl.rsaOaepEncrypt(_pkeyPtr(key), hashAlg, label, _toUint8Array(data)));
    }

    const keyBytes = _keyData(key);
    const cipherAlg = _cipherAlgorithm(alg.name, keyBytes.byteLength);
    const iv  = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData) : null;
    const pt  = _toUint8Array(data);

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
   * Decrypt data produced by `encrypt`.
   *
   * The key must include the "decrypt" usage. AES-GCM input must include the
   * trailing tag, and authentication failures are surfaced by the backend.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']);
   * const iv = crypto.getRandomValues(new Uint8Array(12));
   * const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array([1]));
   * await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
   * ```
   */
  async decrypt(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('decrypt')) throw new Error('CryptoKey does not allow decrypt');

    if (alg.name === 'RSA-OAEP') {
      const hashName = _hashName(_requiredHash(key.algorithm.hash, 'RSA-OAEP hash'));
      const hashAlg  = _digestAlgorithm(hashName);
      const label    = alg.label ? _toUint8Array(alg.label as BufferSource) : null;
      return _toArrayBuffer(openssl.rsaOaepDecrypt(_pkeyPtr(key), hashAlg, label, _toUint8Array(data)));
    }

    const keyBytes  = _keyData(key);
    const cipherAlg = _cipherAlgorithm(alg.name, keyBytes.byteLength);
    const iv = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData) : null;

    let ciphertext, tag;
    if (cipherAlg.endsWith('-gcm')) {
      // Web Crypto convention: encrypted data = ciphertext || 16-byte tag
      const tagLength = (alg.tagLength ?? 128) / 8;
      const buf = _toUint8Array(data);
      if (buf.byteLength < tagLength) throw new Error('AES-GCM: data too short (no tag)');
      ciphertext = buf.subarray(0, buf.byteLength - tagLength);
      tag        = buf.subarray(buf.byteLength - tagLength);
    } else {
      ciphertext = _toUint8Array(data);
      tag        = null;
    }

    const plaintext = openssl.cipherDecrypt(cipherAlg, keyBytes, iv, ciphertext, tag, aad);
    return _toArrayBuffer(plaintext);
  },

  // -------------------------------------------------------------------------
  // Key management
  // -------------------------------------------------------------------------

  /**
   * Import raw, PKCS#8, SPKI, or JWK key material as a CryptoKey.
   *
   * Supported formats depend on the algorithm. JWK import accepts oct, EC, and
   * RSA keys. PBKDF2 and HKDF raw imports are always non-extractable.
   *
   * ```typescript no_run
   * const raw = new Uint8Array(16);
   * const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt']);
   * key.algorithm.name; // "AES-GCM"
   * ```
   */
  async importKey(format: KeyFormat, keyData: BufferSource, algorithm: string | { name: string; [key: string]: unknown }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (format === 'jwk') {
      const jwk = keyData as unknown as {
        kty?: string; k?: string; crv?: string;
        x?: string; y?: string; d?: string; alg?: string;
        n?: string; e?: string; p?: string; q?: string; dp?: string; dq?: string; qi?: string;
      };
      if (jwk.kty === 'EC') {
        // EC JWK import (ECDSA and ECDH).
        if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
          throw new Error('importKey: JWK kty="EC" requires "x" and "y" fields');
        }
        const crv = jwk.crv ?? (alg as { namedCurve?: string }).namedCurve ?? 'P-256';
        const coordSize = openssl.ecdsaCoordSize(crv);
        const x = _base64urlDecode(jwk.x);
        const y = _base64urlDecode(jwk.y);
        const d = jwk.d !== undefined ? _base64urlDecode(jwk.d) : undefined;
        // Pad coordinates to coordSize if shorter (e.g. leading zeros stripped in JWK).
        const padTo = (arr: Uint8Array): Uint8Array => {
          if (arr.length === coordSize) return arr;
          const out = new Uint8Array(coordSize); out.set(arr, coordSize - arr.length); return out;
        };
        const pkey = openssl.evpPkeyImportEcJwk(crv, padTo(x), padTo(y), d !== undefined ? padTo(d) : undefined);
        const keyType: KeyType = d !== undefined ? 'private' : 'public';
        return new CryptoKey(keyType, extractable, { name: alg.name, namedCurve: crv }, [...keyUsages], null, pkey);
      }
      if (jwk.kty === 'RSA') {
        // RSA JWK import.
        if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
          throw new Error('importKey: RSA JWK requires "n" and "e" fields');
        }
        const isPrivate = typeof jwk.d === 'string';
        const components: Parameters<typeof openssl.rsaImportComponents>[0] = {
          n: _base64urlDecode(jwk.n),
          e: _base64urlDecode(jwk.e),
        };
        if (isPrivate) {
          components.d  = _base64urlDecode(jwk.d!);
          if (jwk.p)  components.p  = _base64urlDecode(jwk.p);
          if (jwk.q)  components.q  = _base64urlDecode(jwk.q);
          if (jwk.dp) components.dp = _base64urlDecode(jwk.dp);
          if (jwk.dq) components.dq = _base64urlDecode(jwk.dq);
          if (jwk.qi) components.qi = _base64urlDecode(jwk.qi);
        }
        const pkey = openssl.rsaImportComponents(components);
        const hashName = _hashName((alg as { hash?: string | { name: string } }).hash ?? 'SHA-256');
        const keyType: KeyType = isPrivate ? 'private' : 'public';
        return new CryptoKey(keyType, extractable, { name: alg.name, hash: { name: hashName } }, [...keyUsages], null, pkey);
      }
      // JWK symmetric key import — kty must be 'oct'.
      if (jwk.kty !== 'oct') throw new Error(`importKey: unsupported JWK kty "${jwk.kty}" (supported: "oct", "EC", "RSA")`);
      if (typeof jwk.k !== 'string') throw new Error('importKey: JWK missing "k" field');
      const bytes = _base64urlDecode(jwk.k);
      return subtle.importKey('raw', bytes.buffer as ArrayBuffer, algorithm, extractable, keyUsages);
    }
    if (format === 'pkcs8') {
      const derBytes = _toUint8Array(keyData);
      const pkey     = openssl.evpPkeyImportPkcs8(derBytes);
      if (alg.name === 'RSA-OAEP' || alg.name === 'RSA-PSS' || alg.name === 'RSASSA-PKCS1-V1_5') {
        const hashName = _hashName((alg as { hash?: string | { name: string } }).hash ?? 'SHA-256');
        return new CryptoKey('private', extractable, { name: alg.name, hash: { name: hashName } }, [...keyUsages], null, pkey);
      }
      // EC private key (ECDSA / ECDH).
      const namedCurve = (alg as { namedCurve?: string }).namedCurve ?? 'P-256';
      return new CryptoKey('private', extractable, { name: alg.name, namedCurve }, [...keyUsages], null, pkey);
    }

    if (format === 'spki') {
      // SPKI import for EC and RSA public keys.
      if (alg.name === 'RSA-OAEP' || alg.name === 'RSA-PSS' || alg.name === 'RSASSA-PKCS1-V1_5') {
        const hashName = _hashName((alg as { hash?: string | { name: string } }).hash ?? 'SHA-256');
        const pkey = openssl.evpPkeyImportSpkiRsa(_toUint8Array(keyData));
        return new CryptoKey('public', extractable, { name: alg.name, hash: { name: hashName } }, [...keyUsages], null, pkey);
      }
      if (alg.name !== 'ECDSA' && alg.name !== 'ECDH') {
        throw new Error('importKey: "spki" format only supported for EC algorithms (ECDSA, ECDH)');
      }
      const derBytes = _toUint8Array(keyData);
      const { pkey, namedCurve } = openssl.evpPkeyImportSpki(derBytes);
      // If the algorithm specifies a curve, validate it matches the SPKI header.
      const expectedCurve = (alg as { namedCurve?: string }).namedCurve;
      if (expectedCurve && expectedCurve !== namedCurve) {
        openssl.evpPkeyFree(pkey);
        throw new Error(`importKey: SPKI curve (${namedCurve}) does not match algorithm.namedCurve (${expectedCurve})`);
      }
      return new CryptoKey(
        'public',
        extractable,
        { name: alg.name, namedCurve },
        [...keyUsages],
        null,
        pkey,
      );
    }

    if (format !== 'raw') throw new Error(`importKey: unsupported format "${format}"; supported: "raw", "spki", "jwk"`);

    const bytes = _toUint8Array(keyData);

    if (alg.name === 'HMAC') {
      const hashName = _hashName(alg.hash ?? 'SHA-256');
      _digestAlgorithm(hashName); // validate
      return new CryptoKey(
        'secret',
        extractable,
        { name: 'HMAC', hash: { name: hashName } },
        [...keyUsages],
        new Uint8Array(bytes),
      );
    }

    if (alg.name === 'AES-GCM' || alg.name === 'AES-CBC') {
      if (bytes.byteLength !== 16 && bytes.byteLength !== 32) {
        throw new Error(`${alg.name}: key must be 128 or 256 bits`);
      }
      return new CryptoKey(
        'secret',
        extractable,
        { name: alg.name, length: bytes.byteLength * 8 },
        [...keyUsages],
        new Uint8Array(bytes),
      );
    }

    if (alg.name === 'PBKDF2') {
      return new CryptoKey(
        'secret',
        false, // PBKDF2 keys are never extractable per spec
        { name: 'PBKDF2' },
        [...keyUsages],
        new Uint8Array(bytes),
      );
    }

    if (alg.name === 'HKDF') {
      return new CryptoKey(
        'secret',
        false, // HKDF keys are never extractable per spec
        { name: 'HKDF' },
        [...keyUsages],
        new Uint8Array(bytes),
      );
    }

    throw new Error('importKey: unsupported algorithm: ' + alg.name);
  },

  /**
   * Export a CryptoKey as raw bytes, SPKI, PKCS#8, or JWK data.
   *
   * The key must be extractable. JWK export returns an object, while raw, spki,
   * and pkcs8 return ArrayBuffer bytes.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
   * const raw = await crypto.subtle.exportKey('raw', key);
   * raw.byteLength; // 16
   * ```
   */
  async exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer | object> {
    _checkCryptoAvailable();
    if (format === 'jwk') {
      if (!key.extractable) throw new Error('CryptoKey is not extractable');
      const algName = key.algorithm.name;

      // RSA JWK export.
      if (algName === 'RSA-OAEP' || algName === 'RSA-PSS' || algName === 'RSASSA-PKCS1-V1_5') {
        const hashName = key.algorithm.hash?.name ?? 'SHA-256';
        const jwkAlg   = _rsaJwkAlg(algName, hashName);
        if (key.type === 'public') {
          const { n, e } = _rsaParseSpki(openssl.evpPkeyExportSpkiRsa(_pkeyPtr(key)));
          return {
            kty: 'RSA', alg: jwkAlg,
            n: _base64urlEncode(n), e: _base64urlEncode(e),
            key_ops: [...key.usages], ext: key.extractable,
          } as unknown as ArrayBuffer;
        }
        const { n, e, d, p, q, dp, dq, qi } = _rsaParsePkcs8(openssl.evpPkeyExportPkcs8(_pkeyPtr(key)));
        return {
          kty: 'RSA', alg: jwkAlg,
          n: _base64urlEncode(n), e: _base64urlEncode(e),
          d: _base64urlEncode(d), p: _base64urlEncode(p), q: _base64urlEncode(q),
          dp: _base64urlEncode(dp), dq: _base64urlEncode(dq), qi: _base64urlEncode(qi),
          key_ops: [...key.usages], ext: key.extractable,
        } as unknown as ArrayBuffer;
      }

      // EC JWK export (ECDSA and ECDH).
      if (algName === 'ECDSA' || algName === 'ECDH') {
        const namedCurve = key.algorithm.namedCurve ?? 'P-256';
        const { x, y }   = openssl.ecPublicKeyCoords(_pkeyPtr(key), namedCurve);
        const crvMap: Record<string, string> = { 'P-256': 'P-256', 'P-384': 'P-384', 'P-521': 'P-521' };
        const jwk: Record<string, unknown> = {
          kty: 'EC',
          crv: crvMap[namedCurve] ?? namedCurve,
          x: _base64urlEncode(x),
          y: _base64urlEncode(y),
          key_ops: [...key.usages],
          ext: key.extractable,
        };
        if (key.type === 'private') {
          const d = openssl.ecPrivateKeyD(_pkeyPtr(key), openssl.ecdsaCoordSize(namedCurve));
          jwk['d'] = _base64urlEncode(d);
        }
        return jwk as unknown as ArrayBuffer;
      }

      // Symmetric JWK export.
      const keyBytes = _keyData(key);
      const algLen   = key.algorithm.length;
      let jwkAlg: string;
      if (algName === 'HMAC') {
        const hash = (key.algorithm as { hash?: { name: string } }).hash?.name ?? 'SHA-256';
        jwkAlg = hash === 'SHA-384' ? 'HS384' : hash === 'SHA-512' ? 'HS512' : 'HS256';
      } else if (algName === 'AES-GCM') {
        jwkAlg = algLen === 128 ? 'A128GCM' : 'A256GCM';
      } else if (algName === 'AES-CBC') {
        jwkAlg = algLen === 128 ? 'A128CBC' : 'A256CBC';
      } else {
        throw new Error(`exportKey: JWK not supported for algorithm ${algName}`);
      }
      return {
        kty: 'oct',
        k: _base64urlEncode(keyBytes),
        alg: jwkAlg,
        key_ops: [...key.usages],
        ext: key.extractable,
      } as unknown as ArrayBuffer;
    }
    if (format === 'pkcs8') {
      if (!key.extractable) throw new Error('CryptoKey is not extractable');
      if (key.type !== 'private') throw new Error('exportKey: pkcs8 requires a private key');
      return _toArrayBuffer(openssl.evpPkeyExportPkcs8(_pkeyPtr(key)));
    }

    if (format === 'spki') {
      if (!key.extractable) throw new Error('CryptoKey is not extractable');
      const algName = key.algorithm.name;
      if (algName === 'RSA-OAEP' || algName === 'RSA-PSS' || algName === 'RSASSA-PKCS1-V1_5') {
        return _toArrayBuffer(openssl.evpPkeyExportSpkiRsa(_pkeyPtr(key)));
      }
      if (algName !== 'ECDSA' && algName !== 'ECDH') {
        throw new Error('exportKey: "spki" format only supported for EC and RSA algorithms');
      }
      const namedCurve = key.algorithm.namedCurve ?? 'P-256';
      return _toArrayBuffer(openssl.evpPkeyExportSpki(_pkeyPtr(key), namedCurve));
    }

    if (format !== 'raw') throw new Error(`exportKey: unsupported format "${format}"; supported: "raw", "pkcs8", "spki", "jwk"`);
    if (!key.extractable) throw new Error('CryptoKey is not extractable');
    return _toArrayBuffer(_keyData(key));
  },

  /**
   * Generate a new secret key or asymmetric key pair.
   *
   * AES and HMAC return a single CryptoKey. ECDH, ECDSA, RSA-OAEP, RSA-PSS,
   * and RSASSA-PKCS1-v1_5 return { privateKey, publicKey }. Missing algorithm
   * defaults follow this module's documented choices.
   *
   * ```typescript no_run
   * const pair = await crypto.subtle.generateKey(
   *   { name: 'ECDSA', namedCurve: 'P-256' },
   *   true,
   *   ['sign', 'verify'],
   * );
   * pair.privateKey.type; // "private"
   * ```
   */
  async generateKey(
    algorithm: string | { name: string; [key: string]: unknown },
    extractable: boolean,
    keyUsages: KeyUsage[],
  ): Promise<CryptoKey | { privateKey: CryptoKey; publicKey: CryptoKey }> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (alg.name === 'ECDH') {
      const namedCurve = (alg as { namedCurve?: string }).namedCurve ?? 'P-256';
      const pkeyFull = openssl.evpPkeyGenerateEc(namedCurve);
      let pkeyPub: object;
      try {
        const spki = openssl.evpPkeyExportSpki(pkeyFull, namedCurve);
        ({ pkey: pkeyPub } = openssl.evpPkeyImportSpki(spki));
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const algoDescriptor: CryptoKeyAlgorithm = { name: 'ECDH', namedCurve };
      const privateUsages = keyUsages.filter(u => u === 'deriveKey' || u === 'deriveBits');
      const privateKey = new CryptoKey('private', extractable, algoDescriptor,
        privateUsages.length ? privateUsages : ['deriveKey', 'deriveBits'], null, pkeyFull);
      const publicKey  = new CryptoKey('public',  extractable, algoDescriptor, [], null, pkeyPub);
      return { privateKey, publicKey };
    }

    if (alg.name === 'ECDSA') {
      const namedCurve = (alg as { namedCurve?: string }).namedCurve ?? 'P-256';
      const pkeyFull = openssl.evpPkeyGenerateEc(namedCurve);
      // Export public component and re-import as a separate public-only key so
      // each CryptoKey has independent lifetime managed by FinalizationRegistry.
      let pkeyPub: object;
      try {
        const spki = openssl.evpPkeyExportSpki(pkeyFull, namedCurve);
        ({ pkey: pkeyPub } = openssl.evpPkeyImportSpki(spki));
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const algoDescriptor: CryptoKeyAlgorithm = { name: 'ECDSA', namedCurve };
      const privateUsages = keyUsages.filter(u => u === 'sign');
      const publicUsages  = keyUsages.filter(u => u === 'verify');
      const privateKey = new CryptoKey('private', extractable, algoDescriptor, privateUsages.length ? privateUsages : ['sign'], null, pkeyFull);
      const publicKey  = new CryptoKey('public',  extractable, algoDescriptor, publicUsages.length  ? publicUsages  : ['verify'], null, pkeyPub);
      return { privateKey, publicKey };
    }

    if (alg.name === 'RSA-OAEP' || alg.name === 'RSA-PSS' || alg.name === 'RSASSA-PKCS1-V1_5') {
      const modulusLength  = (alg as { modulusLength?: number }).modulusLength ?? 2048;
      const rawExponent    = (alg as { publicExponent?: Uint8Array }).publicExponent ?? new Uint8Array([0x01, 0x00, 0x01]);
      const publicExponent = new Uint8Array(rawExponent);
      // Decode up to 4 bytes of big-endian exponent (covers 65537 = 0x010001).
      const expBytes = publicExponent.slice(-Math.min(4, publicExponent.length));
      let exponentNum = 0;
      for (let i = 0; i < expBytes.length; i++) exponentNum = (exponentNum << 8) | expBytes[i]!;
      const hashName  = _hashName((alg as { hash?: string | { name: string } }).hash ?? 'SHA-256');
      _digestAlgorithm(hashName); // validate hash
      const pkeyFull = openssl.evpPkeyGenerateRsa(modulusLength, exponentNum || 65537);
      let pkeyPub: object;
      try {
        const spki = openssl.evpPkeyExportSpkiRsa(pkeyFull);
        pkeyPub = openssl.evpPkeyImportSpkiRsa(spki);
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const rsaAlgo: CryptoKeyAlgorithm = { name: alg.name, hash: { name: hashName }, modulusLength, publicExponent };
      const privateUsages = keyUsages.filter(u => u === 'decrypt' || u === 'sign' || u === 'unwrapKey');
      const publicUsages  = keyUsages.filter(u => u === 'encrypt' || u === 'verify' || u === 'wrapKey');
      const privateKey = new CryptoKey('private', extractable, rsaAlgo,
        privateUsages.length ? privateUsages : (alg.name === 'RSA-OAEP' ? ['decrypt'] : ['sign']), null, pkeyFull);
      const publicKey  = new CryptoKey('public',  extractable, rsaAlgo,
        publicUsages.length  ? publicUsages  : (alg.name === 'RSA-OAEP' ? ['encrypt'] : ['verify']), null, pkeyPub);
      return { privateKey, publicKey };
    }

    if (alg.name === 'HMAC') {
      const hashName   = _hashName(alg.hash ?? 'SHA-256');
      const digestName = _digestAlgorithm(hashName);
      // Key length defaults to the digest output size if not specified
      const keyLen = alg.length ? alg.length / 8 : ({ 'sha-1': 20, 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 })[digestName];
      if (keyLen === undefined) throw new Error(`Unsupported HMAC digest: ${digestName}`);
      const buf = new ArrayBuffer(keyLen);
      openssl.randBytes(buf, keyLen);
      return new CryptoKey(
        'secret',
        extractable,
        { name: 'HMAC', hash: { name: hashName } },
        [...keyUsages],
        new Uint8Array(buf),
      );
    }

    if (alg.name === 'AES-GCM' || alg.name === 'AES-CBC') {
      const length = alg.length ?? 256;
      if (length !== 128 && length !== 256) {
        throw new Error(`${alg.name}: key length must be 128 or 256`);
      }
      const keyLen = length / 8;
      const buf = new ArrayBuffer(keyLen);
      openssl.randBytes(buf, keyLen);
      return new CryptoKey(
        'secret',
        extractable,
        { name: alg.name, length },
        [...keyUsages],
        new Uint8Array(buf),
      );
    }

    throw new Error('generateKey: unsupported algorithm: ' + alg.name);
  },

  // -------------------------------------------------------------------------
  // deriveBits — PBKDF2 and HKDF
  // -------------------------------------------------------------------------

  /**
   * Derive raw key bits with PBKDF2, HKDF, or ECDH.
   *
   * The base key must allow deriveBits or deriveKey. The requested length is
   * expressed in bits and the returned ArrayBuffer length is ceil(length / 8).
   *
   * ```typescript no_run
   * const base = await crypto.subtle.importKey('raw', new Uint8Array([1, 2]), 'PBKDF2', false, ['deriveBits']);
   * const bits = await crypto.subtle.deriveBits(
   *   { name: 'PBKDF2', salt: new Uint8Array([3]), iterations: 1, hash: 'SHA-256' },
   *   base,
   *   128,
   * );
   * bits.byteLength; // 16
   * ```
   */
  async deriveBits(algorithm: string | { name: string; [key: string]: unknown }, baseKey: CryptoKey, length: number): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (alg.name === 'ECDH') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw new Error('CryptoKey does not allow deriveBits/deriveKey');
      }
      if (baseKey.type !== 'private') throw new Error('ECDH deriveBits requires a private key');
      const publicKeyParam = alg.public;
      if (!publicKeyParam || !(publicKeyParam instanceof CryptoKey)) {
        throw new Error('ECDH deriveBits: algorithm.public must be an ECDH public CryptoKey');
      }
      if (publicKeyParam.type !== 'public') throw new Error('ECDH deriveBits: algorithm.public must be a public key');
      const privCurve = baseKey.algorithm.namedCurve;
      const pubCurve  = publicKeyParam.algorithm.namedCurve;
      if (privCurve !== pubCurve) {
        throw new Error(`ECDH deriveBits: key curves do not match (${privCurve} vs ${pubCurve})`);
      }
      const secret = openssl.evpPkeyDeriveEcdh(_pkeyPtr(baseKey), _pkeyPtr(publicKeyParam));
      const requestedBytes = Math.ceil(length / 8);
      if (requestedBytes > secret.byteLength) {
        throw new Error(`ECDH deriveBits: requested ${requestedBytes} bytes but shared secret is only ${secret.byteLength}`);
      }
      return _toArrayBuffer(secret.subarray(0, requestedBytes));
    }

    const keyBytes = _keyData(baseKey);
    const keyLen = length / 8;

    if (alg.name === 'PBKDF2') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw new Error('CryptoKey does not allow deriveBits');
      }
      const salt       = _toUint8Array(_requiredBufferSource(alg.salt, 'PBKDF2 salt'));
      const iterations = alg.iterations;
      if (iterations === undefined) throw new Error('PBKDF2 iterations are required');
      const hash       = _digestAlgorithm(_hashName(alg.hash ?? 'SHA-256'));
      return _toArrayBuffer(openssl.pbkdf2(keyBytes, salt, iterations, hash, keyLen));
    }

    if (alg.name === 'HKDF') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw new Error('CryptoKey does not allow deriveBits');
      }
      const salt = alg.salt ? _toUint8Array(alg.salt) : new Uint8Array(0);
      const info = alg.info ? _toUint8Array(alg.info) : new Uint8Array(0);
      const hash = _digestAlgorithm(_hashName(alg.hash ?? 'SHA-256'));
      return _toArrayBuffer(openssl.hkdf(hash, keyBytes, salt, info, keyLen));
    }

    throw new Error('deriveBits: unsupported algorithm: ' + alg.name);
  },

  // -------------------------------------------------------------------------
  // deriveKey — derives a CryptoKey from a base key
  // -------------------------------------------------------------------------

  /**
   * Derive a CryptoKey from another key.
   *
   * This derives raw bits with deriveBits() and imports them as the requested
   * derived key type. AES-GCM, AES-CBC, and HMAC are supported as outputs.
   *
   * ```typescript no_run
   * const base = await crypto.subtle.importKey('raw', new Uint8Array([1, 2]), 'HKDF', false, ['deriveKey']);
   * const key = await crypto.subtle.deriveKey(
   *   { name: 'HKDF', salt: new Uint8Array(), info: new Uint8Array(), hash: 'SHA-256' },
   *   base,
   *   { name: 'AES-GCM', length: 128 },
   *   true,
   *   ['encrypt'],
   * );
   * key.type; // "secret"
   * ```
   */
  async deriveKey(
    algorithm: string | { name: string; [key: string]: unknown },
    baseKey: CryptoKey,
    derivedKeyType: string | { name: string; length?: number; [key: string]: unknown },
    extractable: boolean,
    keyUsages: KeyUsage[],
  ): Promise<CryptoKey> {
    _checkCryptoAvailable();
    const derivedAlg = _normalizeAlgorithm(derivedKeyType);

    // Determine the derived key length in bits from the derivedKeyType.
    let lengthBits: number;
    if (derivedAlg.name === 'HMAC') {
      const hashName = _hashName(derivedAlg.hash ?? 'SHA-256');
      const digestName = _digestAlgorithm(hashName);
      lengthBits = (derivedAlg.length ?? ({ 'sha-1': 160, 'sha-256': 256, 'sha-384': 384, 'sha-512': 512 })[digestName]) as number;
    } else if (derivedAlg.name === 'AES-GCM' || derivedAlg.name === 'AES-CBC') {
      lengthBits = derivedAlg.length ?? 256;
    } else {
      throw new Error('deriveKey: unsupported derivedKeyType: ' + derivedAlg.name);
    }

    const bits = await subtle.deriveBits(algorithm, baseKey, lengthBits);
    return subtle.importKey('raw', bits, derivedKeyType, extractable, keyUsages);
  },

  /**
   * Export and encrypt a key with another key.
   *
   * The wrapped key must be extractable and the wrapping key must allow
   * wrapKey. This implementation supports AES wrapping algorithms through the
   * same AES-GCM/AES-CBC path used for encryption.
   *
   * ```typescript no_run
   * const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['encrypt']);
   * const wrappingKey = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', true, ['wrapKey']);
   * const iv = new Uint8Array(12);
   * await crypto.subtle.wrapKey('raw', key, wrappingKey, { name: 'AES-GCM', iv });
   * ```
   */
  async wrapKey(
    format: KeyFormat,
    key: CryptoKey,
    wrappingKey: CryptoKey,
    wrapAlgorithm: string | { name: string; [k: string]: unknown },
  ): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    if (!key.extractable) throw new Error('wrapKey: key is not extractable');
    if (!wrappingKey.usages.includes('wrapKey')) throw new Error('wrappingKey does not allow wrapKey');
    const exported = await subtle.exportKey(format, key);
    const keyBytes = format === 'jwk'
      ? new TextEncoder().encode(JSON.stringify(exported))
      : new Uint8Array(exported as ArrayBuffer);
    // Call encrypt bypassing the 'encrypt' usage check — wrapKey's own 'wrapKey'
    // usage check above is the authoritative gate for this operation.
    const alg = _normalizeAlgorithm(wrapAlgorithm);
    const wrappingKeyBytes = _keyData(wrappingKey);
    const cipherAlg = _cipherAlgorithm(alg.name, wrappingKeyBytes.byteLength);
    const iv  = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData as BufferSource) : null;
    const { ciphertext, tag } = openssl.cipherEncrypt(cipherAlg, wrappingKeyBytes, iv, keyBytes, aad);
    if (tag) {
      const requestedTagBytes = ((alg.tagLength as number | undefined) ?? 128) / 8;
      const truncatedTag = tag.subarray(0, requestedTagBytes);
      const out = new Uint8Array(ciphertext.byteLength + truncatedTag.byteLength);
      out.set(ciphertext);
      out.set(truncatedTag, ciphertext.byteLength);
      return _toArrayBuffer(out);
    }
    return _toArrayBuffer(ciphertext);
  },

  /**
   * Decrypt wrapped key material and import it as a CryptoKey.
   *
   * The unwrapping key must allow unwrapKey. raw and jwk wrapped formats are
   * supported; other formats currently throw.
   *
   * ```typescript no_run
   * const unwrapped = await crypto.subtle.unwrapKey(
   *   'raw',
   *   wrappedBytes,
   *   unwrappingKey,
   *   { name: 'AES-GCM', iv },
   *   'AES-GCM',
   *   true,
   *   ['encrypt'],
   * );
   * ```
   */
  async unwrapKey(
    format: KeyFormat,
    wrappedKey: BufferSource,
    unwrappingKey: CryptoKey,
    unwrapAlgorithm: string | { name: string; [k: string]: unknown },
    unwrappedKeyAlgorithm: string | { name: string; [k: string]: unknown },
    extractable: boolean,
    keyUsages: KeyUsage[],
  ): Promise<CryptoKey> {
    _checkCryptoAvailable();
    if (!unwrappingKey.usages.includes('unwrapKey')) throw new Error('unwrappingKey does not allow unwrapKey');
    // Bypass the 'decrypt' usage check in subtle.decrypt — unwrapKey's own
    // 'unwrapKey' usage check above is the authoritative gate.
    const alg = _normalizeAlgorithm(unwrapAlgorithm);
    const unwrappingKeyBytes = _keyData(unwrappingKey);
    const cipherAlg = _cipherAlgorithm(alg.name, unwrappingKeyBytes.byteLength);
    const iv = _toUint8Array(_requiredBufferSource(alg.iv, 'AES iv'));
    const aad = alg.additionalData ? _toUint8Array(alg.additionalData as BufferSource) : null;
    const wrappedBytes = _toUint8Array(wrappedKey);
    const tagLen = ((alg.tagLength as number | undefined) ?? 128) / 8;
    const ct = wrappedBytes.subarray(0, wrappedBytes.byteLength - tagLen);
    const tag = wrappedBytes.subarray(wrappedBytes.byteLength - tagLen);
    const decrypted = _toArrayBuffer(openssl.cipherDecrypt(cipherAlg, unwrappingKeyBytes, iv, ct, tag, aad));
    if (format === 'raw') {
      return subtle.importKey('raw', decrypted, unwrappedKeyAlgorithm, extractable, keyUsages);
    }
    if (format === 'jwk') {
      const text = new TextDecoder().decode(decrypted);
      const jwk = JSON.parse(text) as unknown;
      return subtle.importKey('jwk', jwk as BufferSource, unwrappedKeyAlgorithm, extractable, keyUsages);
    }
    throw new Error(`unwrapKey: unsupported format "${format}"`);
  },
};

// ---------------------------------------------------------------------------
// crypto object (globalThis.crypto)
// ---------------------------------------------------------------------------

/**
 * Web Crypto global object backed by OpenSSL.
 *
 * Methods throw an informative Error when libcrypto is unavailable. The object
 * is installed on globalThis when this module is imported.
 *
 * ```typescript no_run
 * const bytes = crypto.getRandomValues(new Uint8Array(8));
 * const id = crypto.randomUUID();
 * ```
 */
export const crypto = {
  /**
   * String tag used by Object.prototype.toString.
   *
   * ```typescript no_run
   * Object.prototype.toString.call(crypto); // "[object Crypto]"
   * ```
   */
  get [Symbol.toStringTag]() { return 'Crypto'; },

  /**
   * Fill `typedArray` with cryptographically random bytes.
   *
   * The argument must be an integer typed array and must not exceed 65536
   * bytes. The same typed array object is returned.
   *
   * ```typescript no_run
   * const bytes = crypto.getRandomValues(new Uint8Array(16));
   * bytes.byteLength; // 16
   * ```
   *
   * @param {TypedArray} typedArray
   * @returns {TypedArray} the same typed array
   */
  getRandomValues<T extends ArrayBufferView>(typedArray: T): T {
    _checkCryptoAvailable();
    if (!(typedArray instanceof Int8Array ||
          typedArray instanceof Uint8Array ||
          typedArray instanceof Uint8ClampedArray ||
          typedArray instanceof Int16Array ||
          typedArray instanceof Uint16Array ||
          typedArray instanceof Int32Array ||
          typedArray instanceof Uint32Array ||
          typedArray instanceof BigInt64Array ||
          typedArray instanceof BigUint64Array)) {
      throw new TypeError('getRandomValues: argument must be an integer typed array');
    }
    if (typedArray.byteLength > 65536) {
      throw new Error('getRandomValues: quota exceeded (max 65536 bytes)');
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
   * Generate a random RFC 9562 UUID string.
   *
   * The UUID is version 4 and uses the runtime UUID module's random source.
   * Throws if OpenSSL is unavailable.
   *
   * ```typescript no_run
   * const id = crypto.randomUUID();
   * id.length; // 36
   * ```
   */
  randomUUID(): string {
    _checkCryptoAvailable();
    return _uuidV4().toString();
  },

  /**
   * SubtleCrypto-compatible cryptographic operations.
   *
   * This object exposes digest, sign, verify, encrypt, decrypt, key import and
   * export, key generation, derivation, wrapping, and unwrapping.
   *
   * ```typescript no_run
   * await crypto.subtle.digest('SHA-256', new Uint8Array());
   * ```
   */
  subtle,
};

// Register on globalThis
globalThis.crypto = crypto as unknown as typeof globalThis.crypto;
(globalThis as Record<string, unknown>).CryptoKey = CryptoKey;

/**
 * Whether the OpenSSL libcrypto backend loaded successfully.
 *
 * When false, crypto methods throw instead of attempting unavailable FFI calls.
 *
 * ```typescript no_run
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
 * ```typescript no_run
 * if (!tlsAvailable) console.warn('tls disabled');
 * ```
 */
export const tlsAvailable = openssl.tlsAvailable;
