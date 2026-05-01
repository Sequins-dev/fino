/**
 * fino:crypto — Web Crypto API.
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

import * as openssl from '../openssl.mts';

// ---------------------------------------------------------------------------
// Deferred algorithms (planned, not yet implemented)
//
// The following algorithms require additional OpenSSL FFI bindings:
//   - ECDSA (P-384, P-521): currently only P-256 is supported
//   - ECDH (P-256, P-384): deriveKey, deriveBits
//   - RSA-OAEP: encrypt, decrypt, generateKey, importKey/exportKey
//   - RSA-PSS, RSASSA-PKCS1-v1_5: sign, verify
//   - Ed25519: sign, verify (requires OpenSSL 1.1.1+)
//   - JWK EC and RSA key formats (kty: 'EC', 'RSA', 'OKP')
//   - pkcs8 format for private key import/export
// ---------------------------------------------------------------------------

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

// WeakMap keyed on CryptoKey instances — symmetric key bytes.
const _keyStore = new WeakMap<CryptoKey, Uint8Array>();
// WeakMap keyed on asymmetric CryptoKey instances — EVP_PKEY* pointer.
const _pkeyStore = new WeakMap<CryptoKey, object>();
// Auto-free EVP_PKEY* when the CryptoKey is GC'd.
const _pkeyRegistry = new FinalizationRegistry<object>((pkey) => {
  openssl.evpPkeyFree(pkey);
});

class CryptoKey {
  #type:        KeyType;
  #extractable: boolean;
  #algorithm:   CryptoKeyAlgorithm;
  #usages:      KeyUsage[];

  get [Symbol.toStringTag]() { return 'CryptoKey'; }

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

  get type():        KeyType           { return this.#type; }
  get extractable(): boolean           { return this.#extractable; }
  get algorithm():   CryptoKeyAlgorithm { return this.#algorithm; }
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
// ECDSA DER ↔ raw signature conversion helpers
//
// WebCrypto uses raw 64-byte signatures (32-byte big-endian r ‖ s).
// OpenSSL ECDSA_sign/verify uses ASN.1 DER-encoded signatures.
// ---------------------------------------------------------------------------

function _derSigToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('Invalid ECDSA DER signature: expected SEQUENCE (0x30)');
  let off = 2; // skip SEQUENCE tag + length
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

  const raw = new Uint8Array(64);
  const rStart = rBytes[0] === 0x00 ? 1 : 0;
  const rSlice = rBytes.subarray(rStart);
  if (rSlice.length > 32) throw new Error('Invalid ECDSA DER signature: r value too large');
  raw.set(rSlice, 32 - rSlice.length);
  const sStart = sBytes[0] === 0x00 ? 1 : 0;
  const sSlice = sBytes.subarray(sStart);
  if (sSlice.length > 32) throw new Error('Invalid ECDSA DER signature: s value too large');
  raw.set(sSlice, 64 - sSlice.length);
  return raw;
}

function _rawSigToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error('Raw ECDSA signature must be 64 bytes');

  function _encodeInt(b: Uint8Array): Uint8Array {
    let start = 0;
    while (start < b.length - 1 && b[start] === 0) start++;
    const needsPad = (b[start]! & 0x80) !== 0;
    const out = new Uint8Array(needsPad ? b.length - start + 1 : b.length - start);
    if (needsPad) { out[0] = 0x00; out.set(b.subarray(start), 1); }
    else           { out.set(b.subarray(start)); }
    return out;
  }

  const r = _encodeInt(raw.subarray(0, 32));
  const s = _encodeInt(raw.subarray(32, 64));
  const inner = 2 + r.length + 2 + s.length;
  const der = new Uint8Array(2 + inner);
  der[0] = 0x30; der[1] = inner;
  der[2] = 0x02; der[3] = r.length; der.set(r, 4);
  der[4 + r.length] = 0x02; der[5 + r.length] = s.length; der.set(s, 6 + r.length);
  return der;
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
    return _toArrayBuffer(openssl.digest(hash, arr));
  },

  // -------------------------------------------------------------------------
  // sign / verify — HMAC and ECDSA
  // -------------------------------------------------------------------------

  async sign(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (alg.name === 'ECDSA') {
      if (!key.usages.includes('sign')) throw new Error('CryptoKey does not allow sign');
      const hashAlg = _digestAlgorithm(_hashName(_requiredHash(alg.hash, 'ECDSA hash')));
      const hash    = openssl.digest(hashAlg, _toUint8Array(data));
      const der     = openssl.ecdsaSign(hash, _pkeyPtr(key));
      return _toArrayBuffer(_derSigToRaw(der));
    }

    if (alg.name !== 'HMAC') throw new Error('sign: unsupported algorithm "' + alg.name + '"');
    if (!key.usages.includes('sign')) throw new Error('CryptoKey does not allow sign');
    const hash = _digestAlgorithm(_hashName(_requiredHash(key.algorithm.hash, 'HMAC hash')));
    const mac  = openssl.hmac(hash, _keyData(key), _toUint8Array(data));
    return _toArrayBuffer(mac);
  },

  async verify(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, signature: BufferSource, data: BufferSource): Promise<boolean> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (alg.name === 'ECDSA') {
      if (!key.usages.includes('verify')) throw new Error('CryptoKey does not allow verify');
      const hashAlg = _digestAlgorithm(_hashName(_requiredHash(alg.hash, 'ECDSA hash')));
      const hash    = openssl.digest(hashAlg, _toUint8Array(data));
      let derSig: Uint8Array;
      try {
        derSig = _rawSigToDer(_toUint8Array(signature));
      } catch {
        return false; // malformed signature
      }
      return openssl.ecdsaVerify(hash, derSig, _pkeyPtr(key));
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

  async encrypt(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('encrypt')) throw new Error('CryptoKey does not allow encrypt');

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

  async decrypt(algorithm: string | { name: string; [key: string]: unknown }, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
    if (!key.usages.includes('decrypt')) throw new Error('CryptoKey does not allow decrypt');

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

  async importKey(format: KeyFormat, keyData: BufferSource, algorithm: string | { name: string; [key: string]: unknown }, extractable: boolean, keyUsages: KeyUsage[]): Promise<CryptoKey> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (format === 'jwk') {
      // JWK symmetric key import — kty must be 'oct'
      const jwk = keyData as unknown as { kty?: string; k?: string; alg?: string };
      if (jwk.kty !== 'oct') throw new Error('importKey: JWK kty must be "oct" for symmetric keys');
      if (typeof jwk.k !== 'string') throw new Error('importKey: JWK missing "k" field');
      const bytes = _base64urlDecode(jwk.k);
      // Route through the same algorithm handling below using the decoded bytes
      return subtle.importKey('raw', bytes.buffer as ArrayBuffer, algorithm, extractable, keyUsages);
    }
    if (format === 'spki') {
      // Only ECDSA public keys support SPKI import.
      if (alg.name !== 'ECDSA') throw new Error('importKey: "spki" format only supported for ECDSA');
      const derBytes = _toUint8Array(keyData);
      const pkey = openssl.evpPkeyImportSpki(derBytes);
      return new CryptoKey(
        'public',
        extractable,
        { name: 'ECDSA' },
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

  async exportKey(format: KeyFormat, key: CryptoKey): Promise<ArrayBuffer | object> {
    _checkCryptoAvailable();
    if (format === 'jwk') {
      if (!key.extractable) throw new Error('CryptoKey is not extractable');
      const keyBytes = _keyData(key);
      const algName  = key.algorithm.name;
      const algLen   = key.algorithm.length;
      // Map to JWK alg field
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
      } as unknown as ArrayBuffer; // widen return type; callers handle object | ArrayBuffer
    }
    if (format === 'spki') {
      if (!key.extractable) throw new Error('CryptoKey is not extractable');
      if (key.algorithm.name !== 'ECDSA') throw new Error('exportKey: "spki" format only supported for ECDSA');
      return _toArrayBuffer(openssl.evpPkeyExportSpki(_pkeyPtr(key)));
    }

    if (format !== 'raw') throw new Error(`exportKey: unsupported format "${format}"; supported: "raw", "spki", "jwk"`);
    if (!key.extractable) throw new Error('CryptoKey is not extractable');
    return _toArrayBuffer(_keyData(key));
  },

  async generateKey(
    algorithm: string | { name: string; [key: string]: unknown },
    extractable: boolean,
    keyUsages: KeyUsage[],
  ): Promise<CryptoKey | { privateKey: CryptoKey; publicKey: CryptoKey }> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);

    if (alg.name === 'ECDSA') {
      const pkeyFull = openssl.evpPkeyGenerateEcP256();
      // Export public component and re-import as a separate public-only key so
      // each CryptoKey has independent lifetime managed by FinalizationRegistry.
      let pkeyPub: object;
      try {
        const spki = openssl.evpPkeyExportSpki(pkeyFull);
        pkeyPub = openssl.evpPkeyImportSpki(spki);
      } catch (err) {
        openssl.evpPkeyFree(pkeyFull);
        throw err;
      }
      const privateKey = new CryptoKey('private', extractable, { name: 'ECDSA' }, ['sign'], null, pkeyFull);
      // pkeyPub is safely owned by publicKey's FinalizationRegistry from here on.
      const publicKey  = new CryptoKey('public',  extractable, { name: 'ECDSA' }, ['verify'], null, pkeyPub);
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

  async deriveBits(algorithm: string | { name: string; [key: string]: unknown }, baseKey: CryptoKey, length: number): Promise<ArrayBuffer> {
    _checkCryptoAvailable();
    const alg = _normalizeAlgorithm(algorithm);
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
    return subtle.encrypt(wrapAlgorithm, wrappingKey, keyBytes);
  },

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
    const decrypted = await subtle.decrypt(unwrapAlgorithm, unwrappingKey, wrappedKey);
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
      openssl.randBytes(typedArray.buffer as ArrayBuffer, typedArray.byteLength);
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
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    // Set variant bits 7-8 of byte 8 to 10xx
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },

  subtle,
};

// Register on globalThis
globalThis.crypto = crypto as unknown as typeof globalThis.crypto;

/** Whether the OpenSSL (libcrypto) backend loaded successfully. */
export const cryptoAvailable = openssl.cryptoAvailable;

/** Whether the OpenSSL TLS (libssl) backend loaded successfully. */
export const tlsAvailable = openssl.tlsAvailable;
