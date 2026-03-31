/**
 * internal:openssl — OpenSSL FFI bindings for libcrypto and libssl.
 *
 * Tries to dlopen OpenSSL at module load time. Sets `cryptoAvailable` and
 * `tlsAvailable` flags on success/failure. Callers (boats:crypto, boats:tls)
 * check these flags and throw descriptive errors if unavailable.
 *
 * This is an internal module — only boats:* built-ins may import it.
 *
 * ## Swappability
 * This module exports a well-defined interface. To add BoringSSL support,
 * create internal:boringssl with the same exports and change the import in
 * boats:crypto and boats:tls.
 */

import { dlopen, Pointer } from 'boats:ffi';
import { os } from 'internal:process';
import { encodeUtf8 } from 'internal:globals/encoding';

export interface CipherResult {
  ciphertext: Uint8Array;
  tag:        Uint8Array | null;
}

const isDarwin = os === 'darwin';

// ---------------------------------------------------------------------------
// Library search paths
// ---------------------------------------------------------------------------

const _cryptoPaths = isDarwin
  ? ['/opt/homebrew/lib/libcrypto.dylib', '/usr/local/lib/libcrypto.dylib', 'libcrypto.dylib']
  : ['libcrypto.so.3', 'libcrypto.so.1.1', 'libcrypto.so'];

const _sslPaths = isDarwin
  ? ['/opt/homebrew/lib/libssl.dylib', '/usr/local/lib/libssl.dylib', 'libssl.dylib']
  : ['libssl.so.3', 'libssl.so.1.1', 'libssl.so'];

// ---------------------------------------------------------------------------
// FFI symbol tables
// ---------------------------------------------------------------------------

const _cryptoSymbols = {
  // Random
  RAND_bytes: { parameters: ['buffer', 'i32'], result: 'i32' },

  // Digest — EVP high-level API
  EVP_MD_CTX_new:     { parameters: [], result: 'pointer' },
  EVP_MD_CTX_free:    { parameters: ['pointer'], result: 'void' },
  EVP_DigestInit_ex:  { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
  EVP_DigestUpdate:   { parameters: ['pointer', 'buffer', 'usize'], result: 'i32' },
  EVP_DigestFinal_ex: { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  EVP_sha1:   { parameters: [], result: 'pointer' },
  EVP_sha256: { parameters: [], result: 'pointer' },
  EVP_sha384: { parameters: [], result: 'pointer' },
  EVP_sha512: { parameters: [], result: 'pointer' },

  // HMAC — one-shot
  // HMAC(evp_md, key, key_len, data, data_len, out, out_len) → pointer
  HMAC: {
    parameters: ['pointer', 'buffer', 'i32', 'buffer', 'usize', 'buffer', 'buffer'],
    result: 'pointer',
  },

  // Cipher — EVP encrypt/decrypt
  EVP_CIPHER_CTX_new:  { parameters: [], result: 'pointer' },
  EVP_CIPHER_CTX_free: { parameters: ['pointer'], result: 'void' },
  // EncryptInit_ex(ctx, cipher_or_null, engine_or_null, key_or_null, iv_or_null)
  EVP_EncryptInit_ex:  { parameters: ['pointer', 'pointer', 'pointer', 'buffer', 'buffer'], result: 'i32' },
  EVP_EncryptUpdate:   { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'i32'], result: 'i32' },
  EVP_EncryptFinal_ex: { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  EVP_DecryptInit_ex:  { parameters: ['pointer', 'pointer', 'pointer', 'buffer', 'buffer'], result: 'i32' },
  EVP_DecryptUpdate:   { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'i32'], result: 'i32' },
  EVP_DecryptFinal_ex: { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  // ctrl(ctx, type, arg, ptr) — used for GCM tag get/set and IV length
  EVP_CIPHER_CTX_ctrl: { parameters: ['pointer', 'i32', 'i32', 'buffer'], result: 'i32' },
  EVP_aes_128_gcm: { parameters: [], result: 'pointer' },
  EVP_aes_256_gcm: { parameters: [], result: 'pointer' },
  EVP_aes_128_cbc: { parameters: [], result: 'pointer' },
  EVP_aes_256_cbc: { parameters: [], result: 'pointer' },

  // Error reporting
  ERR_get_error:      { parameters: [], result: 'u64' },
  ERR_error_string_n: { parameters: ['u64', 'buffer', 'usize'], result: 'void' },

  // PBKDF2 — one-shot key derivation
  // PKCS5_PBKDF2_HMAC(pass, passlen, salt, saltlen, iter, digest, keylen, out)
  PKCS5_PBKDF2_HMAC: {
    parameters: ['buffer', 'i32', 'buffer', 'i32', 'i32', 'pointer', 'i32', 'buffer'],
    result: 'i32',
  },

};

const _sslSymbols = {
  TLS_client_method: { parameters: [], result: 'pointer' },
  TLS_server_method: { parameters: [], result: 'pointer' },
  SSL_CTX_new:  { parameters: ['pointer'], result: 'pointer' },
  SSL_CTX_free: { parameters: ['pointer'], result: 'void' },
  SSL_new:  { parameters: ['pointer'], result: 'pointer' },
  SSL_free: { parameters: ['pointer'], result: 'void' },
  SSL_set_fd:   { parameters: ['pointer', 'i32'], result: 'i32' },
  SSL_connect:  { parameters: ['pointer'], result: 'i32' },
  SSL_accept:   { parameters: ['pointer'], result: 'i32' },
  SSL_read:     { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  SSL_write:    { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  SSL_shutdown: { parameters: ['pointer'], result: 'i32' },
  SSL_get_error: { parameters: ['pointer', 'i32'], result: 'i32' },
  SSL_pending:   { parameters: ['pointer'], result: 'i32' },
  SSL_CTX_set_verify:               { parameters: ['pointer', 'i32', 'pointer'], result: 'void' },
  SSL_CTX_set_default_verify_paths: { parameters: ['pointer'], result: 'i32' },
  SSL_CTX_load_verify_locations:    { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  // SSL_ctrl(ssl, cmd, larg, parg) — used for SNI (cmd=55)
  // larg is C `long` (64-bit on LP64); parg is a buffer (hostname string for SNI)
  SSL_ctrl:      { parameters: ['pointer', 'i32', 'i64', 'buffer'], result: 'i64' },
  SSL_set1_host: { parameters: ['pointer', 'buffer'], result: 'i32' },
};

// ---------------------------------------------------------------------------
// Library loading
// ---------------------------------------------------------------------------

function _tryOpen(paths: string[], symbols: object): object | null {
  for (const p of paths) {
    try { return dlopen(p, symbols); } catch (_) {}
  }
  return null;
}

const _libcrypto = _tryOpen(_cryptoPaths, _cryptoSymbols);
const _libssl    = _tryOpen(_sslPaths, _sslSymbols);

export const cryptoAvailable = _libcrypto !== null;
export const tlsAvailable    = _libssl !== null;

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/**
 * Read the most recent error from the OpenSSL error queue as a human-readable string.
 * @returns {string}
 */
export function getErrorString(): string {
  if (!_libcrypto) return 'OpenSSL not available';
  const code = _libcrypto.symbols.ERR_get_error(); // BigInt (u64)
  if (code === 0n) return 'no error';
  const buf = new ArrayBuffer(256);
  _libcrypto.symbols.ERR_error_string_n(code, buf, 256);
  const bytes = new Uint8Array(buf);
  const end = bytes.indexOf(0);
  return String.fromCharCode(...bytes.subarray(0, end >= 0 ? end : bytes.length));
}

// ---------------------------------------------------------------------------
// Digest size table — avoids EVP_MD_size / EVP_MD_get_size API differences
// ---------------------------------------------------------------------------

const _digestSize = {
  'sha-1':   20,
  'sha-256': 32,
  'sha-384': 48,
  'sha-512': 64,
};

function _getMd(algorithm: string): object {
  switch (algorithm.toLowerCase()) {
    case 'sha-1':   return _libcrypto.symbols.EVP_sha1();
    case 'sha-256': return _libcrypto.symbols.EVP_sha256();
    case 'sha-384': return _libcrypto.symbols.EVP_sha384();
    case 'sha-512': return _libcrypto.symbols.EVP_sha512();
    default: throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
}

// ---------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------

/**
 * Fill `buf` with `len` cryptographically random bytes via RAND_bytes.
 * @param {ArrayBuffer} buf
 * @param {number} len
 */
export function randBytes(buf: ArrayBuffer, len: number): void {
  const rc = _libcrypto.symbols.RAND_bytes(buf, len);
  if (rc !== 1) throw new Error('RAND_bytes failed: ' + getErrorString());
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * One-shot digest.
 * @param {string} algorithm — 'sha-1', 'sha-256', 'sha-384', 'sha-512'
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function digest(algorithm: string, data: Uint8Array): Uint8Array {
  const md   = _getMd(algorithm);
  const size = _digestSize[algorithm.toLowerCase()];
  if (size === undefined) throw new Error('Unsupported digest: ' + algorithm);

  const ctx = _libcrypto.symbols.EVP_MD_CTX_new();
  if (ctx === null) throw new Error('EVP_MD_CTX_new failed');

  try {
    let rc = _libcrypto.symbols.EVP_DigestInit_ex(ctx, md, null);
    if (rc !== 1) throw new Error('EVP_DigestInit_ex failed: ' + getErrorString());

    rc = _libcrypto.symbols.EVP_DigestUpdate(ctx, data, data.byteLength);
    if (rc !== 1) throw new Error('EVP_DigestUpdate failed');

    const outBuf    = new ArrayBuffer(size);
    const outlenBuf = new ArrayBuffer(4);
    rc = _libcrypto.symbols.EVP_DigestFinal_ex(ctx, outBuf, outlenBuf);
    if (rc !== 1) throw new Error('EVP_DigestFinal_ex failed');

    return new Uint8Array(outBuf);
  } finally {
    _libcrypto.symbols.EVP_MD_CTX_free(ctx);
  }
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

/**
 * One-shot HMAC.
 * @param {string} algorithm — 'sha-256', 'sha-512', etc.
 * @param {Uint8Array} key
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function hmac(algorithm: string, key: Uint8Array | ArrayBuffer, data: Uint8Array | ArrayBuffer): Uint8Array {
  const md  = _getMd(algorithm);
  const outBuf    = new ArrayBuffer(64); // large enough for any digest
  const outlenBuf = new ArrayBuffer(4);  // unsigned int*

  const keyArr  = key  instanceof Uint8Array ? key  : new Uint8Array(key);
  const dataArr = data instanceof Uint8Array ? data : new Uint8Array(data);

  const result = _libcrypto.symbols.HMAC(
    md,
    keyArr, keyArr.byteLength,
    dataArr, dataArr.byteLength,
    outBuf, outlenBuf,
  );

  if (result === null) throw new Error('HMAC failed: ' + getErrorString());

  const len = new DataView(outlenBuf).getUint32(0, true);
  // Copy into a fresh buffer of the correct size so .buffer returns the right length.
  return new Uint8Array(new Uint8Array(outBuf, 0, len));
}

// ---------------------------------------------------------------------------
// Cipher — internal helpers
// ---------------------------------------------------------------------------

// EVP_CIPHER_CTX_ctrl type constants
const _GCM_SET_IVLEN = 0x9;
const _GCM_GET_TAG   = 0x10;
const _GCM_SET_TAG   = 0x11;

function _cipherForAlgorithm(algorithm: string): object {
  switch (algorithm) {
    case 'aes-128-gcm': return _libcrypto.symbols.EVP_aes_128_gcm();
    case 'aes-256-gcm': return _libcrypto.symbols.EVP_aes_256_gcm();
    case 'aes-128-cbc': return _libcrypto.symbols.EVP_aes_128_cbc();
    case 'aes-256-cbc': return _libcrypto.symbols.EVP_aes_256_cbc();
    default: throw new Error('Unsupported cipher: ' + algorithm);
  }
}

function _isGCM(algorithm: string): boolean {
  return algorithm.endsWith('-gcm');
}

function _encryptGCM(cipher: object, key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array | null): CipherResult {
  const ctx = _libcrypto.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    // 1. Init cipher without key/IV
    let rc = _libcrypto.symbols.EVP_EncryptInit_ex(ctx, cipher, null, null, null);
    if (rc !== 1) throw new Error('EVP_EncryptInit_ex failed: ' + getErrorString());

    // 2. Set IV length (GCM standard is 12 bytes, but we accept any)
    rc = _libcrypto.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_SET_IVLEN, iv.byteLength, null);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(SET_IVLEN) failed');

    // 3. Set key + IV
    rc = _libcrypto.symbols.EVP_EncryptInit_ex(ctx, null, null, key, iv);
    if (rc !== 1) throw new Error('EVP_EncryptInit_ex(key+iv) failed');

    // 4. Process AAD if provided
    if (aad && aad.byteLength > 0) {
      rc = _libcrypto.symbols.EVP_EncryptUpdate(ctx, null, outlenBuf, aad, aad.byteLength);
      if (rc !== 1) throw new Error('EVP_EncryptUpdate(AAD) failed');
    }

    // 5. Encrypt plaintext
    const updateBuf = new ArrayBuffer(plaintext.byteLength + 16);
    rc = _libcrypto.symbols.EVP_EncryptUpdate(ctx, updateBuf, outlenBuf, plaintext, plaintext.byteLength);
    if (rc !== 1) throw new Error('EVP_EncryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    // 6. Finalize (GCM produces no additional output bytes)
    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = _libcrypto.symbols.EVP_EncryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('EVP_EncryptFinal_ex failed');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    // 7. Get 16-byte auth tag
    const tagBuf = new ArrayBuffer(16);
    rc = _libcrypto.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_GET_TAG, 16, tagBuf);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(GET_TAG) failed');

    // Combine output
    const ciphertext = new Uint8Array(updateLen + finalLen);
    ciphertext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) ciphertext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return { ciphertext, tag: new Uint8Array(tagBuf) };
  } finally {
    _libcrypto.symbols.EVP_CIPHER_CTX_free(ctx);
  }
}

function _encryptCBC(cipher: object, key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): CipherResult {
  const ctx = _libcrypto.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    let rc = _libcrypto.symbols.EVP_EncryptInit_ex(ctx, cipher, null, key, iv);
    if (rc !== 1) throw new Error('EVP_EncryptInit_ex failed: ' + getErrorString());

    // CBC update — output can be up to plaintext + 1 block
    const updateBuf = new ArrayBuffer(plaintext.byteLength + 16);
    rc = _libcrypto.symbols.EVP_EncryptUpdate(ctx, updateBuf, outlenBuf, plaintext, plaintext.byteLength);
    if (rc !== 1) throw new Error('EVP_EncryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    // Final block (PKCS7 padding)
    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = _libcrypto.symbols.EVP_EncryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('EVP_EncryptFinal_ex failed');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    const ciphertext = new Uint8Array(updateLen + finalLen);
    ciphertext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) ciphertext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return { ciphertext, tag: null };
  } finally {
    _libcrypto.symbols.EVP_CIPHER_CTX_free(ctx);
  }
}

function _decryptGCM(cipher: object, key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, aad: Uint8Array | null): Uint8Array {
  const ctx = _libcrypto.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    // 1. Init cipher without key/IV
    let rc = _libcrypto.symbols.EVP_DecryptInit_ex(ctx, cipher, null, null, null);
    if (rc !== 1) throw new Error('EVP_DecryptInit_ex failed: ' + getErrorString());

    // 2. Set IV length
    rc = _libcrypto.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_SET_IVLEN, iv.byteLength, null);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(SET_IVLEN) failed');

    // 3. Set key + IV
    rc = _libcrypto.symbols.EVP_DecryptInit_ex(ctx, null, null, key, iv);
    if (rc !== 1) throw new Error('EVP_DecryptInit_ex(key+iv) failed');

    // 4. Set expected tag BEFORE decrypting (required by GCM).
    // Use the actual tag length so OpenSSL truncates its computed tag to the same length.
    const tagBuf = new ArrayBuffer(tag.byteLength);
    new Uint8Array(tagBuf).set(tag);
    rc = _libcrypto.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_SET_TAG, tag.byteLength, tagBuf);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(SET_TAG) failed');

    // 5. Process AAD if provided
    if (aad && aad.byteLength > 0) {
      rc = _libcrypto.symbols.EVP_DecryptUpdate(ctx, null, outlenBuf, aad, aad.byteLength);
      if (rc !== 1) throw new Error('EVP_DecryptUpdate(AAD) failed');
    }

    // 6. Decrypt ciphertext
    const updateBuf = new ArrayBuffer(ciphertext.byteLength);
    rc = _libcrypto.symbols.EVP_DecryptUpdate(ctx, updateBuf, outlenBuf, ciphertext, ciphertext.byteLength);
    if (rc !== 1) throw new Error('EVP_DecryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    // 7. Finalize — verifies GCM tag; returns < 0 on tag mismatch
    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = _libcrypto.symbols.EVP_DecryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('AES-GCM decryption failed: authentication tag mismatch');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    const plaintext = new Uint8Array(updateLen + finalLen);
    plaintext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) plaintext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return plaintext;
  } finally {
    _libcrypto.symbols.EVP_CIPHER_CTX_free(ctx);
  }
}

function _decryptCBC(cipher: object, key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const ctx = _libcrypto.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    let rc = _libcrypto.symbols.EVP_DecryptInit_ex(ctx, cipher, null, key, iv);
    if (rc !== 1) throw new Error('EVP_DecryptInit_ex failed: ' + getErrorString());

    const updateBuf = new ArrayBuffer(ciphertext.byteLength);
    rc = _libcrypto.symbols.EVP_DecryptUpdate(ctx, updateBuf, outlenBuf, ciphertext, ciphertext.byteLength);
    if (rc !== 1) throw new Error('EVP_DecryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = _libcrypto.symbols.EVP_DecryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('EVP_DecryptFinal_ex failed (bad padding or wrong key?)');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    const plaintext = new Uint8Array(updateLen + finalLen);
    plaintext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) plaintext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return plaintext;
  } finally {
    _libcrypto.symbols.EVP_CIPHER_CTX_free(ctx);
  }
}

// ---------------------------------------------------------------------------
// Cipher — public interface
// ---------------------------------------------------------------------------

/**
 * Encrypt data with the given cipher.
 * @param {string} algorithm — 'aes-128-gcm', 'aes-256-gcm', 'aes-128-cbc', 'aes-256-cbc'
 * @param {Uint8Array} key
 * @param {Uint8Array} iv
 * @param {Uint8Array} plaintext
 * @param {Uint8Array|null} [aad] — additional authenticated data (GCM only)
 * @returns {{ ciphertext: Uint8Array, tag: Uint8Array|null }}
 */
export function cipherEncrypt(algorithm: string, key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array | null): CipherResult {
  const cipher = _cipherForAlgorithm(algorithm);
  if (_isGCM(algorithm)) return _encryptGCM(cipher, key, iv, plaintext, aad);
  return _encryptCBC(cipher, key, iv, plaintext);
}

/**
 * Decrypt data with the given cipher.
 * @param {string} algorithm
 * @param {Uint8Array} key
 * @param {Uint8Array} iv
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array|null} [tag] — auth tag (GCM only)
 * @param {Uint8Array|null} [aad] — additional authenticated data (GCM only)
 * @returns {Uint8Array}
 */
export function cipherDecrypt(algorithm: string, key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, tag?: Uint8Array | null, aad?: Uint8Array | null): Uint8Array {
  const cipher = _cipherForAlgorithm(algorithm);
  if (_isGCM(algorithm)) return _decryptGCM(cipher, key, iv, ciphertext, tag, aad);
  return _decryptCBC(cipher, key, iv, ciphertext);
}

// ---------------------------------------------------------------------------
// Key derivation — PBKDF2
// ---------------------------------------------------------------------------

/**
 * Derive key bytes using PBKDF2-HMAC.
 *
 * @param {Uint8Array} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @param {string} hashAlg — 'sha-1', 'sha-256', 'sha-384', 'sha-512'
 * @param {number} keyLength — output length in bytes
 * @returns {Uint8Array}
 */
export function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number, hashAlg: string, keyLength: number): Uint8Array {
  if (!_libcrypto) throw new Error('OpenSSL not available');
  const md  = _getMd(hashAlg);
  const out = new ArrayBuffer(keyLength);
  const rc  = _libcrypto.symbols.PKCS5_PBKDF2_HMAC(
    password, password.byteLength,
    salt, salt.byteLength,
    iterations,
    md,
    keyLength,
    out,
  );
  if (rc !== 1) throw new Error('PKCS5_PBKDF2_HMAC failed: ' + getErrorString());
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------
// Key derivation — HKDF (RFC 5869) — pure JS using existing hmac()
// ---------------------------------------------------------------------------

/**
 * Derive key bytes using HKDF (RFC 5869).
 *
 * Implemented directly in JS using HMAC (extract + expand) to avoid OpenSSL
 * version compatibility issues with the EVP_PKEY_CTX HKDF API.
 *
 * @param {string} hashAlg — 'sha-1', 'sha-256', 'sha-384', 'sha-512'
 * @param {Uint8Array} ikm   — input key material
 * @param {Uint8Array} salt  — salt (may be empty; defaults to HashLen zero bytes)
 * @param {Uint8Array} info  — context info (may be empty)
 * @param {number} keyLength — output length in bytes
 * @returns {Uint8Array}
 */
export function hkdf(hashAlg: string, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, keyLength: number): Uint8Array {
  if (!_libcrypto) throw new Error('OpenSSL not available');

  // Use a zero-filled salt of HashLen bytes if salt is empty (RFC 5869 §2.2)
  const hashLen = (_digestSize as Record<string, number>)[hashAlg.toLowerCase()];
  if (!hashLen) throw new Error('HKDF: unsupported hash algorithm: ' + hashAlg);
  const effectiveSalt = salt.byteLength > 0 ? salt : new Uint8Array(hashLen);

  // Step 1: Extract — PRK = HMAC-Hash(salt, IKM)
  const prk = hmac(hashAlg, effectiveSalt, ikm);

  // Step 2: Expand — T(i) = HMAC-Hash(PRK, T(i-1) || info || i)
  const n = Math.ceil(keyLength / hashLen);
  if (n > 255) throw new Error('HKDF: requested key length too large');

  const out = new Uint8Array(keyLength);
  let prev  = new Uint8Array(0);
  let offset = 0;

  for (let i = 1; i <= n; i++) {
    const counter = new Uint8Array([i]);
    const input   = new Uint8Array(prev.byteLength + info.byteLength + 1);
    input.set(prev);
    input.set(info, prev.byteLength);
    input.set(counter, prev.byteLength + info.byteLength);

    prev = hmac(hashAlg, prk, input);
    const take = Math.min(hashLen, keyLength - offset);
    out.set(prev.subarray(0, take), offset);
    offset += take;
  }

  return out;
}

// ---------------------------------------------------------------------------
// SSL — context management
// ---------------------------------------------------------------------------

export function sslCtxNewClient(): object {
  const method = _libssl.symbols.TLS_client_method();
  const ctx = _libssl.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new failed: ' + getErrorString());
  return ctx;
}

export function sslCtxNewServer(): object {
  const method = _libssl.symbols.TLS_server_method();
  const ctx = _libssl.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new failed: ' + getErrorString());
  return ctx;
}

export function sslCtxFree(ctx: object): void {
  _libssl.symbols.SSL_CTX_free(ctx);
}

export function sslCtxSetDefaultVerifyPaths(ctx: object): void {
  const rc = _libssl.symbols.SSL_CTX_set_default_verify_paths(ctx);
  if (rc !== 1) throw new Error('SSL_CTX_set_default_verify_paths failed: ' + getErrorString());
}

/**
 * Load CA certificate(s) for peer verification.
 * @param {object} ctx — SSL_CTX* pointer
 * @param {string|null} caFile — path to a PEM file, or null
 * @param {string|null} caPath — path to a directory of PEM files, or null
 */
export function sslCtxLoadVerifyLocations(ctx: object, caFile: string | null, caPath: string | null): void {
  const fileBuf = caFile ? encodeUtf8(caFile + '\0') : null;
  const pathBuf = caPath ? encodeUtf8(caPath + '\0') : null;
  const rc = _libssl.symbols.SSL_CTX_load_verify_locations(ctx, fileBuf, pathBuf);
  if (rc !== 1) throw new Error('SSL_CTX_load_verify_locations failed: ' + getErrorString());
}

export function sslCtxSetVerify(ctx: object, mode: number): void {
  _libssl.symbols.SSL_CTX_set_verify(ctx, mode, null);
}

// ---------------------------------------------------------------------------
// SSL — connection management
// ---------------------------------------------------------------------------

export function sslNew(ctx: object): object {
  const ssl = _libssl.symbols.SSL_new(ctx);
  if (ssl === null) throw new Error('SSL_new failed: ' + getErrorString());
  return ssl;
}

export function sslFree(ssl: object): void {
  _libssl.symbols.SSL_free(ssl);
}

export function sslSetFd(ssl: object, fd: number): void {
  const rc = _libssl.symbols.SSL_set_fd(ssl, fd);
  if (rc !== 1) throw new Error('SSL_set_fd failed');
}

/**
 * Set SNI hostname and enable hostname verification.
 * @param {object} ssl — SSL* pointer
 * @param {string} hostname
 */
export function sslSetHostname(ssl: object, hostname: string): void {
  // SSL_set_tlsext_host_name macro: SSL_ctrl(ssl, SSL_CTRL_SET_TLSEXT_HOSTNAME=55, 0, hostname)
  const hostBuf = encodeUtf8(hostname + '\0');
  _libssl.symbols.SSL_ctrl(ssl, 55, 0, hostBuf);

  // Enable hostname verification (OpenSSL 1.1.0+, LibreSSL 2.9+)
  _libssl.symbols.SSL_set1_host(ssl, encodeUtf8(hostname + '\0'));
}

/** Perform TLS handshake (client). Returns 1 on success. */
export function sslConnect(ssl: object): number  { return _libssl.symbols.SSL_connect(ssl); }

/** Perform TLS handshake (server). Returns 1 on success. */
export function sslAccept(ssl: object): number   { return _libssl.symbols.SSL_accept(ssl); }

/**
 * Read up to `len` decrypted bytes into `buf`.
 * @param {object} ssl
 * @param {ArrayBuffer} buf
 * @param {number} len
 * @returns {number} bytes read, 0 on graceful close, negative on error
 */
export function sslRead(ssl: object, buf: ArrayBuffer, len: number): number  { return _libssl.symbols.SSL_read(ssl, buf, len); }

/**
 * Write `len` bytes from `buf` over TLS.
 * @param {object} ssl
 * @param {Uint8Array|ArrayBuffer} buf
 * @param {number} len
 * @returns {number} bytes written, or negative on error
 */
export function sslWrite(ssl: object, buf: Uint8Array | ArrayBuffer, len: number): number { return _libssl.symbols.SSL_write(ssl, buf, len); }

/** Initiate TLS shutdown sequence. */
export function sslShutdown(ssl: object): number { return _libssl.symbols.SSL_shutdown(ssl); }

/** Translate an SSL return value to an error code. */
export function sslGetError(ssl: object, ret: number): number { return _libssl.symbols.SSL_get_error(ssl, ret); }

/** Return number of bytes already decrypted and buffered in OpenSSL. */
export function sslPending(ssl: object): number { return _libssl.symbols.SSL_pending(ssl); }

// ---------------------------------------------------------------------------
// SSL error code constants
// ---------------------------------------------------------------------------

export const SSL_ERROR_NONE        = 0;
export const SSL_ERROR_SSL         = 1;
export const SSL_ERROR_WANT_READ   = 2;
export const SSL_ERROR_WANT_WRITE  = 3;
export const SSL_ERROR_SYSCALL     = 5;
export const SSL_ERROR_ZERO_RETURN = 6;

export const SSL_VERIFY_PEER = 0x01;
