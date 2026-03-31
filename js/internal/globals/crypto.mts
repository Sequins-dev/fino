/**
 * boats:crypto — Web Crypto API.
 *
 * Implements a useful subset of the W3C Web Cryptography API:
 *   crypto.getRandomValues(typedArray)
 *   crypto.randomUUID()
 *   crypto.subtle.digest(algorithm, data)
 *   crypto.subtle.sign(algorithm, key, data)
 *   crypto.subtle.verify(algorithm, key, signature, data)
 *   crypto.subtle.encrypt(algorithm, key, data)
 *   crypto.subtle.decrypt(algorithm, key, data)
 *   crypto.subtle.importKey(format, keyData, algorithm, extractable, keyUsages)
 *   crypto.subtle.exportKey(format, key)
 *   crypto.subtle.generateKey(algorithm, extractable, keyUsages)
 *
 * Backed by internal:openssl (libcrypto via FFI). If OpenSSL is not installed,
 * every method throws an informative error rather than crashing the process.
 *
 * Registers `globalThis.crypto` at import time.
 */

import * as openssl from 'internal:openssl';

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
}

/** Algorithm descriptor stored on a CryptoKey. */
interface CryptoKeyAlgorithm {
  name: string;
  hash?: { name: string };
  length?: number;
}

// ---------------------------------------------------------------------------
// CryptoKey
// ---------------------------------------------------------------------------

// WeakMap keyed on CryptoKey instances — allows module-level functions to
// access private key material without making #fields accessible outside the class.
const _keyStore = new WeakMap<CryptoKey, Uint8Array>();

class CryptoKey {
  #type:        KeyType;
  #extractable: boolean;
  #algorithm:   CryptoKeyAlgorithm;
  #usages:      KeyUsage[];

  get [Symbol.toStringTag]() { return 'CryptoKey'; }

  constructor(type: KeyType, extractable: boolean, algorithm: CryptoKeyAlgorithm, usages: KeyUsage[], keyData: Uint8Array) {
    this.#type        = type;
    this.#extractable = extractable;
    this.#algorithm   = algorithm;
    this.#usages      = usages;
    _keyStore.set(this, keyData); // Uint8Array — the raw key bytes
  }

  get type():        KeyType           { return this.#type; }
  get extractable(): boolean           { return this.#extractable; }
  get algorithm():   CryptoKeyAlgorithm { return this.#algorithm; }
  get usages():      KeyUsage[]        { return Object.freeze([...this.#usages]); }
}

function _keyData(key: CryptoKey): Uint8Array {
  if (!(key instanceof CryptoKey)) throw new Error('Invalid CryptoKey');
  return _keyStore.get(key);
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

// ---------------------------------------------------------------------------
// SubtleCrypto
// ---------------------------------------------------------------------------

const subtle = {
  get [Symbol.toStringTag]() { return 'SubtleCrypto'; },

  // -------------------------------------------------------------------------
  // digest
  // -------------------------------------------------------------------------

  async digest(algorithm: string | { name: string; [key: string]: unknown }, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg  = _normalizeAlgorithm(algorithm);
    const hash = _digestAlgorithm(alg.name);
    const arr  = _toUint8Array(data);
    return openssl.digest(hash, arr).buffer;
  },

  // -------------------------------------------------------------------------
  // sign / verify — HMAC only for now
  // -------------------------------------------------------------------------

  async sign(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (alg.name !== 'HMAC') throw new Error('sign: only HMAC is supported');
    if (!key.usages.includes('sign')) throw new Error('CryptoKey does not allow sign');

    const hash = _digestAlgorithm(_hashName(key.algorithm.hash));
    const mac  = openssl.hmac(hash, _keyData(key), _toUint8Array(data));
    return mac.buffer;
  },

  async verify(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (alg.name !== 'HMAC') throw new Error('verify: only HMAC is supported');
    if (!key.usages.includes('verify')) throw new Error('CryptoKey does not allow verify');

    const hash     = _digestAlgorithm(_hashName(key.algorithm.hash));
    const expected = openssl.hmac(hash, _keyData(key), _toUint8Array(data));
    const actual   = _toUint8Array(signature);

    // Constant-time comparison
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    return diff === 0;
  },

  // -------------------------------------------------------------------------
  // encrypt / decrypt — AES-GCM and AES-CBC
  // -------------------------------------------------------------------------

  async encrypt(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('encrypt')) throw new Error('CryptoKey does not allow encrypt');

    const keyBytes = _keyData(key);
    const cipherAlg = _cipherAlgorithm(alg.name, keyBytes.byteLength);
    const iv  = _toUint8Array(alg.iv);
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
      return out.buffer;
    }
    return ciphertext.buffer;
  },

  async decrypt(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('decrypt')) throw new Error('CryptoKey does not allow decrypt');

    const keyBytes  = _keyData(key);
    const cipherAlg = _cipherAlgorithm(alg.name, keyBytes.byteLength);
    const iv = _toUint8Array(alg.iv);
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
    return plaintext.buffer;
  },

  // -------------------------------------------------------------------------
  // Key management
  // -------------------------------------------------------------------------

  async importKey(format: KeyFormat, keyData: BufferSource, algorithm: string | { name: string; [key: string]: unknown }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (format !== 'raw') throw new Error('importKey: only "raw" format is supported');

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

  async exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    if (format !== 'raw') throw new Error('exportKey: only "raw" format is supported');
    if (!key.extractable) throw new Error('CryptoKey is not extractable');
    return _keyData(key).buffer.slice(0);
  },

  async generateKey(algorithm: string | { name: string; [key: string]: unknown }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (alg.name === 'HMAC') {
      const hashName   = _hashName(alg.hash ?? 'SHA-256');
      const digestName = _digestAlgorithm(hashName);
      // Key length defaults to the digest output size if not specified
      const keyLen = alg.length ? alg.length / 8 : ({ 'sha-1': 20, 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 })[digestName];
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

  async deriveBits(algorithm: string | { name: string; [key: string]: unknown }, baseKey: CryptoKey, length: number): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    const keyBytes = _keyData(baseKey);
    const keyLen = length / 8;

    if (alg.name === 'PBKDF2') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw new Error('CryptoKey does not allow deriveBits');
      }
      const salt       = _toUint8Array(alg.salt);
      const iterations = alg.iterations;
      const hash       = _digestAlgorithm(_hashName(alg.hash ?? 'SHA-256'));
      return openssl.pbkdf2(keyBytes, salt, iterations, hash, keyLen).buffer;
    }

    if (alg.name === 'HKDF') {
      if (!baseKey.usages.includes('deriveBits') && !baseKey.usages.includes('deriveKey')) {
        throw new Error('CryptoKey does not allow deriveBits');
      }
      const salt = alg.salt ? _toUint8Array(alg.salt) : new Uint8Array(0);
      const info = alg.info ? _toUint8Array(alg.info) : new Uint8Array(0);
      const hash = _digestAlgorithm(_hashName(alg.hash ?? 'SHA-256'));
      return openssl.hkdf(hash, keyBytes, salt, info, keyLen).buffer;
    }

    throw new Error('deriveBits: unsupported algorithm: ' + alg.name);
  },

  // -------------------------------------------------------------------------
  // deriveKey — derives a CryptoKey from a base key
  // -------------------------------------------------------------------------

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
};

// ---------------------------------------------------------------------------
// crypto object (globalThis.crypto)
// ---------------------------------------------------------------------------

export const crypto = {
  get [Symbol.toStringTag]() { return 'Crypto'; },

  /**
   * Fill `typedArray` with cryptographically random bytes.
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
      openssl.randBytes(typedArray.buffer, typedArray.byteLength);
    } else {
      const tmp = new ArrayBuffer(typedArray.byteLength);
      openssl.randBytes(tmp, typedArray.byteLength);
      new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength).set(new Uint8Array(tmp));
    }
    return typedArray;
  },

  /**
   * Generate a random UUID v4 string.
   * @returns {string}
   */
  randomUUID(): string {
    _checkCryptoAvailable();
    const buf = new ArrayBuffer(16);
    openssl.randBytes(buf, 16);
    const bytes = new Uint8Array(buf);
    // Set version 4 (bits 12-15 of byte 6)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // Set variant bits 7-8 of byte 8 to 10xx
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },

  subtle,
};

// Register on globalThis
globalThis.crypto = crypto;

/** Whether the OpenSSL (libcrypto) backend loaded successfully. */
export const cryptoAvailable = openssl.cryptoAvailable;

/** Whether the OpenSSL TLS (libssl) backend loaded successfully. */
export const tlsAvailable = openssl.tlsAvailable;
