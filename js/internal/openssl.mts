/**
 * internal:openssl — OpenSSL FFI bindings for libcrypto and libssl.
 *
 * Tries to dlopen OpenSSL at module load time. Sets `cryptoAvailable` and
 * `tlsAvailable` flags on success/failure. Callers (fino:crypto, fino:tls)
 * check these flags and throw descriptive errors if unavailable.
 *
 * This is an internal module — only fino:* built-ins may import it.
 *
 * ## Swappability
 * This module exports a well-defined interface. To add BoringSSL support,
 * create internal:boringssl with the same exports and change the import in
 * fino:crypto and fino:tls.
 *
 * @internal
 */

import {
  dlopen,
  FfiCallback,
  Pointer,
  type DynamicLibrary,
  type NativeSymbolMap,
} from 'fino:ffi';
import { os } from 'internal:process';
import { encodeUtf8, decodeUtf8 } from './globals/encoding.mts';

export interface CipherResult {
  ciphertext: Uint8Array;
  tag:        Uint8Array | null;
}

type DigestAlgorithm = 'sha-1' | 'sha-256' | 'sha-384' | 'sha-512';
type CipherAlgorithm = 'aes-128-gcm' | 'aes-256-gcm' | 'aes-128-cbc' | 'aes-256-cbc';

const isDarwin = os === 'darwin';

// ---------------------------------------------------------------------------
// Library search paths
// ---------------------------------------------------------------------------

// On macOS 26+ loading the bare unversioned 'libcrypto.dylib' / 'libssl.dylib'
// resolves to the system library that no longer has a stable ABI — dyld now
// aborts instead of warning. Use explicit versioned paths (Homebrew OpenSSL 3
// or legacy 1.1) and never fall back to the bare name on macOS.
const _cryptoPaths = isDarwin
  ? [
      '/opt/homebrew/lib/libcrypto.3.dylib',
      '/opt/homebrew/lib/libcrypto.dylib',
      '/usr/local/lib/libcrypto.3.dylib',
      '/usr/local/lib/libcrypto.1.1.dylib',
      '/usr/local/lib/libcrypto.dylib',
    ]
  : ['libcrypto.so.3', 'libcrypto.so.1.1', 'libcrypto.so'];

const _sslPaths = isDarwin
  ? [
      '/opt/homebrew/lib/libssl.3.dylib',
      '/opt/homebrew/lib/libssl.dylib',
      '/usr/local/lib/libssl.3.dylib',
      '/usr/local/lib/libssl.1.1.dylib',
      '/usr/local/lib/libssl.dylib',
    ]
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

  // ECDH key derivation via EVP_PKEY_CTX (also reused for RSA in Phase 5).
  // EVP_PKEY_CTX_new(pkey, engine) — create context from an existing EVP_PKEY
  // EVP_PKEY_CTX_free(ctx)
  // EVP_PKEY_derive_init(ctx) → 1 on success
  // EVP_PKEY_derive_set_peer(ctx, peer_pkey) → 1 on success
  // EVP_PKEY_derive(ctx, key_out_or_null, keylen_buf) → 1 on success
  EVP_PKEY_CTX_new:          { parameters: ['pointer', 'pointer'], result: 'pointer' },
  EVP_PKEY_CTX_free:         { parameters: ['pointer'], result: 'void' },
  EVP_PKEY_derive_init:      { parameters: ['pointer'], result: 'i32' },
  EVP_PKEY_derive_set_peer:  { parameters: ['pointer', 'pointer'], result: 'i32' },
  // EVP_PKEY_derive(ctx, key, keylen): key=null → writes required length into keylen;
  //                                    key!=null → writes shared secret into key.
  // keylen is a usize* (native pointer size), passed as a buffer holding 8 bytes.
  EVP_PKEY_derive:           { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },

  // EC private key scalar extraction (ECDH raw export, EC JWK 'd').
  EC_KEY_get0_private_key:   { parameters: ['pointer'], result: 'pointer' }, // → BIGNUM* (borrowed)
  // BN_num_bytes is a macro in OpenSSL 3 (not exported); use BN_num_bits and compute ceil(bits/8) in JS.
  BN_num_bits:               { parameters: ['pointer'], result: 'i32' },
  BN_bn2bin:                 { parameters: ['pointer', 'buffer'], result: 'i32' },
  // EC JWK private import: construct EC_KEY from raw (x, y, d) coordinates.
  BN_bin2bn:                 { parameters: ['buffer', 'i32', 'pointer'], result: 'pointer' }, // → BIGNUM*
  BN_free:                   { parameters: ['pointer'], result: 'void' },
  EC_KEY_set_private_key:    { parameters: ['pointer', 'pointer'], result: 'i32' },
  // EC_POINT_mul(group, r, n, q, m, ctx): compute r = n*G + m*q; n=scalar for base-point multiply.
  EC_POINT_mul:              { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },

  // RSA key generation.
  // RSA_new() → RSA*;  RSA_free(rsa);  RSA_generate_key_ex(rsa, bits, exponent_bn, cb) → 1
  RSA_new:             { parameters: [], result: 'pointer' },
  RSA_free:            { parameters: ['pointer'], result: 'void' },
  RSA_generate_key_ex: { parameters: ['pointer', 'i32', 'pointer', 'pointer'], result: 'i32' },
  RSA_size:            { parameters: ['pointer'], result: 'i32' }, // max ciphertext/signature size
  // RSA_get0_key(rsa, n, e, d): borrow BIGNUMs; any may be null if not wanted.
  RSA_get0_key:        { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'void' },
  RSA_get0_factors:    { parameters: ['pointer', 'pointer', 'pointer'], result: 'void' },
  RSA_get0_crt_params: { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'void' },
  // RSA_set0_key owns the BIGNUMs passed in (do not free them separately).
  RSA_set0_key:        { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  RSA_set0_factors:    { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
  RSA_set0_crt_params: { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },

  // BIGNUM operations — used for RSA public exponent and JWK component encoding/decoding.
  // (BN_free, BN_bin2bn, BN_num_bits, BN_bn2bin are already declared in the EC section above.)
  BN_new:           { parameters: [], result: 'pointer' },
  BN_set_word:      { parameters: ['pointer', 'u64'], result: 'i32' },
  BN_num_bits:      { parameters: ['pointer'], result: 'i32' },
  // BN_bn2binpad(a, to, tolen) → tolen bytes, left-zero-padded (requires OpenSSL 1.1+)
  BN_bn2binpad:     { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },

  // EVP_PKEY assignment / extraction for RSA.
  // EVP_PKEY_set1_RSA was removed in OpenSSL 3; use set1 (increments refcount).
  EVP_PKEY_set1_RSA: { parameters: ['pointer', 'pointer'], result: 'i32' },
  EVP_PKEY_get1_RSA:   { parameters: ['pointer'], result: 'pointer' }, // increments refcount

  // Generic SPKI: i2d_PUBKEY / d2i_PUBKEY work for any EVP_PKEY type (EC and RSA),
  // unlike the hand-rolled SPKI used for EC.  Same pointer-to-pointer convention.
  i2d_PUBKEY: { parameters: ['pointer', 'buffer'], result: 'i32' },
  d2i_PUBKEY: { parameters: ['pointer', 'buffer', 'i32'], result: 'pointer' },

  // RSA-OAEP encrypt / decrypt via EVP_PKEY_CTX.
  // EVP_PKEY_CTX_new is already declared above (ECDH section).
  EVP_PKEY_encrypt_init:          { parameters: ['pointer'], result: 'i32' },
  EVP_PKEY_encrypt:               { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'usize'], result: 'i32' },
  EVP_PKEY_decrypt_init:          { parameters: ['pointer'], result: 'i32' },
  EVP_PKEY_decrypt:               { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'usize'], result: 'i32' },
  EVP_PKEY_CTX_set_rsa_padding:   { parameters: ['pointer', 'i32'], result: 'i32' },
  EVP_PKEY_CTX_set_rsa_oaep_md:   { parameters: ['pointer', 'pointer'], result: 'i32' },
  EVP_PKEY_CTX_set_rsa_mgf1_md:   { parameters: ['pointer', 'pointer'], result: 'i32' },

  // RSA-PSS / PKCS1-v1_5 sign and verify.
  // Use the EVP_PKEY_sign* family (hash-then-sign) to avoid the EVP_DigestSignInit
  // pctx pointer-to-pointer output parameter.  Pre-compute the digest with
  // openssl.digest() and pass it directly.
  EVP_PKEY_sign_init:    { parameters: ['pointer'], result: 'i32' },
  // EVP_PKEY_sign(ctx, sig, siglen_buf, tbs, tbslen): sig=null → get length
  EVP_PKEY_sign:         { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'usize'], result: 'i32' },
  EVP_PKEY_verify_init:  { parameters: ['pointer'], result: 'i32' },
  // EVP_PKEY_verify(ctx, sig, siglen, tbs, tbslen) → 1=valid, 0=invalid, <0=error
  EVP_PKEY_verify:       { parameters: ['pointer', 'buffer', 'usize', 'buffer', 'usize'], result: 'i32' },
  EVP_PKEY_CTX_set_rsa_pss_saltlen: { parameters: ['pointer', 'i32'], result: 'i32' },
  // EVP_PKEY_CTX_set_signature_md sets the digest used for RSA-PSS / PKCS1-v1_5 signature.
  EVP_PKEY_CTX_set_signature_md:    { parameters: ['pointer', 'pointer'], result: 'i32' },

  // PKCS8 PrivateKeyInfo (unencrypted) — used for EC and RSA private key DER export/import.
  // EVP_PKEY2PKCS8 wraps an EVP_PKEY in a PKCS8_PRIV_KEY_INFO structure (no password).
  // i2d_PKCS8_PRIV_KEY_INFO(key, pp): pp==null → returns required length; pp!=null → writes DER.
  // d2i_PKCS8_PRIV_KEY_INFO(a, pp, length): parses DER → PKCS8_PRIV_KEY_INFO*.
  // EVP_PKCS82PKEY(p8) → EVP_PKEY*.
  // PKCS8_PRIV_KEY_INFO_free frees the temporary PKCS8 structure.
  EVP_PKEY2PKCS8:              { parameters: ['pointer'], result: 'pointer' },
  i2d_PKCS8_PRIV_KEY_INFO:     { parameters: ['pointer', 'buffer'], result: 'i32' },
  d2i_PKCS8_PRIV_KEY_INFO:     { parameters: ['pointer', 'buffer', 'i32'], result: 'pointer' },
  EVP_PKCS82PKEY:              { parameters: ['pointer'], result: 'pointer' },
  PKCS8_PRIV_KEY_INFO_free:    { parameters: ['pointer'], result: 'void' },

  // ECDSA / EC key operations
  OBJ_txt2nid:            { parameters: ['buffer'], result: 'i32' },
  EC_KEY_new_by_curve_name: { parameters: ['i32'], result: 'pointer' },
  EC_KEY_generate_key:    { parameters: ['pointer'], result: 'i32' },
  EC_KEY_free:            { parameters: ['pointer'], result: 'void' },
  EC_KEY_get0_group:      { parameters: ['pointer'], result: 'pointer' },
  EC_KEY_get0_public_key: { parameters: ['pointer'], result: 'pointer' },
  EC_KEY_set_public_key:  { parameters: ['pointer', 'pointer'], result: 'i32' },
  EC_POINT_new:           { parameters: ['pointer'], result: 'pointer' },
  EC_POINT_free:          { parameters: ['pointer'], result: 'void' },
  // Returns byte count written; buf must be pre-allocated.  ctx may be null.
  EC_POINT_point2oct: {
    parameters: ['pointer', 'pointer', 'i32', 'buffer', 'usize', 'pointer'],
    result: 'usize',
  },
  // Returns 1 on success.  ctx may be null.
  EC_POINT_oct2point: {
    parameters: ['pointer', 'pointer', 'buffer', 'usize', 'pointer'],
    result: 'i32',
  },
  EVP_PKEY_new:           { parameters: [], result: 'pointer' },
  EVP_PKEY_free:          { parameters: ['pointer'], result: 'void' },
  // EVP_PKEY_set1_EC_KEY removed in OpenSSL 3; use set1 (increments refcount).
  EVP_PKEY_set1_EC_KEY: { parameters: ['pointer', 'pointer'], result: 'i32' },
  EVP_PKEY_get0_EC_KEY:   { parameters: ['pointer'], result: 'pointer' },
  // ECDSA_sign(type=0, dgst, dgstlen, sig, siglen_buf, eckey) → 1 on success
  // siglen_buf must be a 4-byte buffer; written with actual DER sig length.
  ECDSA_sign:   { parameters: ['i32', 'buffer', 'i32', 'buffer', 'buffer', 'pointer'], result: 'i32' },
  // ECDSA_verify(type=0, dgst, dgstlen, sig, siglen, eckey) → 1 if valid
  ECDSA_verify: { parameters: ['i32', 'buffer', 'i32', 'buffer', 'i32', 'pointer'], result: 'i32' },
} satisfies NativeSymbolMap;

const _sslSymbols = {
  TLS_client_method: { parameters: [], result: 'pointer' },
  TLS_server_method: { parameters: [], result: 'pointer' },
  SSL_CTX_new:  { parameters: ['pointer'], result: 'pointer' },
  SSL_CTX_free: { parameters: ['pointer'], result: 'void' },
  SSL_new:  { parameters: ['pointer'], result: 'pointer' },
  SSL_free: { parameters: ['pointer'], result: 'void' },
  SSL_set_fd:   { parameters: ['pointer', 'i32'], result: 'i32' },
  SSL_connect:  { parameters: ['pointer'], result: 'i32' },
  // async: true — runs on the blocking pool so ALPN select FfiCallbacks fire via condvar
  SSL_accept:   { parameters: ['pointer'], result: 'i32', async: true },
  SSL_CTX_set_alpn_select_cb: { parameters: ['pointer', 'pointer', 'pointer'], result: 'void' },
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
  // Server certificate and private key loading
  SSL_CTX_use_certificate_file: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  SSL_CTX_use_PrivateKey_file:  { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  SSL_CTX_check_private_key:    { parameters: ['pointer'], result: 'i32' },
  // ALPN — Application Layer Protocol Negotiation
  // SSL_CTX_set_alpn_protos(ctx, protos, protos_len) — advertise protocol list
  SSL_CTX_set_alpn_protos: { parameters: ['pointer', 'buffer', 'u32'], result: 'i32' },
  // SSL_get0_alpn_selected(ssl, *data_out, *len_out) — query negotiated protocol
  // data_out receives a non-owning pointer into OpenSSL internals; len_out is u32.
  SSL_get0_alpn_selected: { parameters: ['pointer', 'buffer', 'buffer'], result: 'void' },
} satisfies NativeSymbolMap;

// ---------------------------------------------------------------------------
// Library loading
// ---------------------------------------------------------------------------

type CryptoLibrary = DynamicLibrary<typeof _cryptoSymbols>;
type SslLibrary = DynamicLibrary<typeof _sslSymbols>;

function _tryOpen<TSymbols extends NativeSymbolMap>(paths: string[], symbols: TSymbols): DynamicLibrary<TSymbols> | null {
  for (const p of paths) {
    try { return dlopen(p, symbols); } catch (_) {}
  }
  return null;
}

const _libcrypto = _tryOpen(_cryptoPaths, _cryptoSymbols);
const _libssl    = _tryOpen(_sslPaths, _sslSymbols);

export const cryptoAvailable = _libcrypto !== null;
export const tlsAvailable    = _libssl !== null;

function _requireCrypto(): CryptoLibrary {
  if (_libcrypto === null) throw new Error('OpenSSL not available');
  return _libcrypto;
}

function _requireSsl(): SslLibrary {
  if (_libssl === null) throw new Error('OpenSSL SSL not available');
  return _libssl;
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/**
 * Read the most recent error from the OpenSSL error queue as a human-readable string.
 * @returns {string}
 */
export function getErrorString(): string {
  if (_libcrypto === null) return 'OpenSSL not available';
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

const _digestSize: Record<DigestAlgorithm, number> = {
  'sha-1':   20,
  'sha-256': 32,
  'sha-384': 48,
  'sha-512': 64,
};

function _normalizeDigestAlgorithm(algorithm: string): DigestAlgorithm {
  switch (algorithm.toLowerCase()) {
    case 'sha-1':
    case 'sha-256':
    case 'sha-384':
    case 'sha-512':
      return algorithm.toLowerCase() as DigestAlgorithm;
    default:
      throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
}

function _getMd(algorithm: DigestAlgorithm): object {
  const lib = _requireCrypto();
  switch (algorithm) {
    case 'sha-1':   return lib.symbols.EVP_sha1();
    case 'sha-256': return lib.symbols.EVP_sha256();
    case 'sha-384': return lib.symbols.EVP_sha384();
    case 'sha-512': return lib.symbols.EVP_sha512();
    default: throw new Error(`Unsupported digest algorithm: ${algorithm}`);
  }
}

function _normalizeCipherAlgorithm(algorithm: string): CipherAlgorithm {
  switch (algorithm) {
    case 'aes-128-gcm':
    case 'aes-256-gcm':
    case 'aes-128-cbc':
    case 'aes-256-cbc':
      return algorithm;
    default:
      throw new Error('Unsupported cipher: ' + algorithm);
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
  const rc = _requireCrypto().symbols.RAND_bytes(buf, len);
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
  const lib = _requireCrypto();
  const normalized = _normalizeDigestAlgorithm(algorithm);
  const md   = _getMd(normalized);
  const size = _digestSize[normalized];

  const ctx = lib.symbols.EVP_MD_CTX_new();
  if (ctx === null) throw new Error('EVP_MD_CTX_new failed');

  try {
    let rc = lib.symbols.EVP_DigestInit_ex(ctx, md, null);
    if (rc !== 1) throw new Error('EVP_DigestInit_ex failed: ' + getErrorString());

    rc = lib.symbols.EVP_DigestUpdate(ctx, data, data.byteLength);
    if (rc !== 1) throw new Error('EVP_DigestUpdate failed');

    const outBuf    = new ArrayBuffer(size);
    const outlenBuf = new ArrayBuffer(4);
    rc = lib.symbols.EVP_DigestFinal_ex(ctx, outBuf, outlenBuf);
    if (rc !== 1) throw new Error('EVP_DigestFinal_ex failed');

    return new Uint8Array(outBuf);
  } finally {
    lib.symbols.EVP_MD_CTX_free(ctx);
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
  const lib = _requireCrypto();
  const md  = _getMd(_normalizeDigestAlgorithm(algorithm));
  const outBuf    = new ArrayBuffer(64); // large enough for any digest
  const outlenBuf = new ArrayBuffer(4);  // unsigned int*

  const keyArr  = key  instanceof Uint8Array ? key  : new Uint8Array(key);
  const dataArr = data instanceof Uint8Array ? data : new Uint8Array(data);

  const result = lib.symbols.HMAC(
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

function _cipherForAlgorithm(algorithm: CipherAlgorithm): object {
  const lib = _requireCrypto();
  switch (algorithm) {
    case 'aes-128-gcm': return lib.symbols.EVP_aes_128_gcm();
    case 'aes-256-gcm': return lib.symbols.EVP_aes_256_gcm();
    case 'aes-128-cbc': return lib.symbols.EVP_aes_128_cbc();
    case 'aes-256-cbc': return lib.symbols.EVP_aes_256_cbc();
    default: throw new Error('Unsupported cipher: ' + algorithm);
  }
}

function _isGCM(algorithm: string): boolean {
  return algorithm.endsWith('-gcm');
}

function _encryptGCM(cipher: object, key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array | null): CipherResult {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    // 1. Init cipher without key/IV
    let rc = lib.symbols.EVP_EncryptInit_ex(ctx, cipher, null, null, null);
    if (rc !== 1) throw new Error('EVP_EncryptInit_ex failed: ' + getErrorString());

    // 2. Set IV length (GCM standard is 12 bytes, but we accept any)
    rc = lib.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_SET_IVLEN, iv.byteLength, null);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(SET_IVLEN) failed');

    // 3. Set key + IV
    rc = lib.symbols.EVP_EncryptInit_ex(ctx, null, null, key, iv);
    if (rc !== 1) throw new Error('EVP_EncryptInit_ex(key+iv) failed');

    // 4. Process AAD if provided
    if (aad && aad.byteLength > 0) {
      rc = lib.symbols.EVP_EncryptUpdate(ctx, null, outlenBuf, aad, aad.byteLength);
      if (rc !== 1) throw new Error('EVP_EncryptUpdate(AAD) failed');
    }

    // 5. Encrypt plaintext
    const updateBuf = new ArrayBuffer(plaintext.byteLength + 16);
    rc = lib.symbols.EVP_EncryptUpdate(ctx, updateBuf, outlenBuf, plaintext, plaintext.byteLength);
    if (rc !== 1) throw new Error('EVP_EncryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    // 6. Finalize (GCM produces no additional output bytes)
    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = lib.symbols.EVP_EncryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('EVP_EncryptFinal_ex failed');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    // 7. Get 16-byte auth tag
    const tagBuf = new ArrayBuffer(16);
    rc = lib.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_GET_TAG, 16, tagBuf);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(GET_TAG) failed');

    // Combine output
    const ciphertext = new Uint8Array(updateLen + finalLen);
    ciphertext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) ciphertext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return { ciphertext, tag: new Uint8Array(tagBuf) };
  } finally {
    lib.symbols.EVP_CIPHER_CTX_free(ctx);
  }
}

function _encryptCBC(cipher: object, key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): CipherResult {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    let rc = lib.symbols.EVP_EncryptInit_ex(ctx, cipher, null, key, iv);
    if (rc !== 1) throw new Error('EVP_EncryptInit_ex failed: ' + getErrorString());

    // CBC update — output can be up to plaintext + 1 block
    const updateBuf = new ArrayBuffer(plaintext.byteLength + 16);
    rc = lib.symbols.EVP_EncryptUpdate(ctx, updateBuf, outlenBuf, plaintext, plaintext.byteLength);
    if (rc !== 1) throw new Error('EVP_EncryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    // Final block (PKCS7 padding)
    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = lib.symbols.EVP_EncryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('EVP_EncryptFinal_ex failed');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    const ciphertext = new Uint8Array(updateLen + finalLen);
    ciphertext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) ciphertext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return { ciphertext, tag: null };
  } finally {
    lib.symbols.EVP_CIPHER_CTX_free(ctx);
  }
}

function _decryptGCM(cipher: object, key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array, aad: Uint8Array | null): Uint8Array {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    // 1. Init cipher without key/IV
    let rc = lib.symbols.EVP_DecryptInit_ex(ctx, cipher, null, null, null);
    if (rc !== 1) throw new Error('EVP_DecryptInit_ex failed: ' + getErrorString());

    // 2. Set IV length
    rc = lib.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_SET_IVLEN, iv.byteLength, null);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(SET_IVLEN) failed');

    // 3. Set key + IV
    rc = lib.symbols.EVP_DecryptInit_ex(ctx, null, null, key, iv);
    if (rc !== 1) throw new Error('EVP_DecryptInit_ex(key+iv) failed');

    // 4. Set expected tag BEFORE decrypting (required by GCM).
    // Use the actual tag length so OpenSSL truncates its computed tag to the same length.
    const tagBuf = new ArrayBuffer(tag.byteLength);
    new Uint8Array(tagBuf).set(tag);
    rc = lib.symbols.EVP_CIPHER_CTX_ctrl(ctx, _GCM_SET_TAG, tag.byteLength, tagBuf);
    if (rc !== 1) throw new Error('EVP_CIPHER_CTX_ctrl(SET_TAG) failed');

    // 5. Process AAD if provided
    if (aad && aad.byteLength > 0) {
      rc = lib.symbols.EVP_DecryptUpdate(ctx, null, outlenBuf, aad, aad.byteLength);
      if (rc !== 1) throw new Error('EVP_DecryptUpdate(AAD) failed');
    }

    // 6. Decrypt ciphertext
    const updateBuf = new ArrayBuffer(ciphertext.byteLength);
    rc = lib.symbols.EVP_DecryptUpdate(ctx, updateBuf, outlenBuf, ciphertext, ciphertext.byteLength);
    if (rc !== 1) throw new Error('EVP_DecryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    // 7. Finalize — verifies GCM tag; returns < 0 on tag mismatch
    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = lib.symbols.EVP_DecryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('AES-GCM decryption failed: authentication tag mismatch');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    const plaintext = new Uint8Array(updateLen + finalLen);
    plaintext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) plaintext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return plaintext;
  } finally {
    lib.symbols.EVP_CIPHER_CTX_free(ctx);
  }
}

function _decryptCBC(cipher: object, key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_CIPHER_CTX_new();
  if (ctx === null) throw new Error('EVP_CIPHER_CTX_new failed');

  try {
    const outlenBuf = new ArrayBuffer(4);

    let rc = lib.symbols.EVP_DecryptInit_ex(ctx, cipher, null, key, iv);
    if (rc !== 1) throw new Error('EVP_DecryptInit_ex failed: ' + getErrorString());

    const updateBuf = new ArrayBuffer(ciphertext.byteLength);
    rc = lib.symbols.EVP_DecryptUpdate(ctx, updateBuf, outlenBuf, ciphertext, ciphertext.byteLength);
    if (rc !== 1) throw new Error('EVP_DecryptUpdate failed');
    const updateLen = new DataView(outlenBuf).getInt32(0, true);

    const finalBuf    = new ArrayBuffer(32);
    const finalLenBuf = new ArrayBuffer(4);
    rc = lib.symbols.EVP_DecryptFinal_ex(ctx, finalBuf, finalLenBuf);
    if (rc !== 1) throw new Error('EVP_DecryptFinal_ex failed (bad padding or wrong key?)');
    const finalLen = new DataView(finalLenBuf).getInt32(0, true);

    const plaintext = new Uint8Array(updateLen + finalLen);
    plaintext.set(new Uint8Array(updateBuf, 0, updateLen));
    if (finalLen > 0) plaintext.set(new Uint8Array(finalBuf, 0, finalLen), updateLen);

    return plaintext;
  } finally {
    lib.symbols.EVP_CIPHER_CTX_free(ctx);
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
  const normalized = _normalizeCipherAlgorithm(algorithm);
  const cipher = _cipherForAlgorithm(normalized);
  if (_isGCM(normalized)) return _encryptGCM(cipher, key, iv, plaintext, aad ?? null);
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
  const normalized = _normalizeCipherAlgorithm(algorithm);
  const cipher = _cipherForAlgorithm(normalized);
  if (_isGCM(normalized)) {
    if (tag == null) throw new Error('AES-GCM decryption requires an authentication tag');
    return _decryptGCM(cipher, key, iv, ciphertext, tag, aad ?? null);
  }
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
  const lib = _requireCrypto();
  const md  = _getMd(_normalizeDigestAlgorithm(hashAlg));
  const out = new ArrayBuffer(keyLength);
  const rc  = lib.symbols.PKCS5_PBKDF2_HMAC(
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
  // Use a zero-filled salt of HashLen bytes if salt is empty (RFC 5869 §2.2)
  const normalized = _normalizeDigestAlgorithm(hashAlg);
  const hashLen = _digestSize[normalized];
  const effectiveSalt = salt.byteLength > 0 ? salt : new Uint8Array(hashLen);

  // Step 1: Extract — PRK = HMAC-Hash(salt, IKM)
  const prk = hmac(hashAlg, effectiveSalt, ikm);

  // Step 2: Expand — T(i) = HMAC-Hash(PRK, T(i-1) || info || i)
  const n = Math.ceil(keyLength / hashLen);
  if (n > 255) throw new Error('HKDF: requested key length too large');

  const out = new Uint8Array(keyLength);
  let prev: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let offset = 0;

  for (let i = 1; i <= n; i++) {
    const counter = new Uint8Array([i]);
    const input   = new Uint8Array(prev.byteLength + info.byteLength + 1);
    input.set(prev);
    input.set(info, prev.byteLength);
    input.set(counter, prev.byteLength + info.byteLength);

    prev = hmac(normalized, prk, input);
    const take = Math.min(hashLen, keyLength - offset);
    out.set(prev.subarray(0, take), offset);
    offset += take;
  }

  return out;
}

// ---------------------------------------------------------------------------
// ECDSA / EC — multi-curve key generation, SPKI import/export, sign/verify
//
// Supports P-256 (prime256v1), P-384 (secp384r1), and P-521 (secp521r1).
// ---------------------------------------------------------------------------

// NID cache: 'P-256' | 'P-384' | 'P-521' → OpenSSL NID integer
const _curveNidCache = new Map<string, number>();

function _curveNID(namedCurve: string): number {
  const cached = _curveNidCache.get(namedCurve);
  if (cached !== undefined) return cached;
  const lib = _requireCrypto();
  const oidNames: Record<string, string> = {
    'P-256': 'prime256v1',
    'P-384': 'secp384r1',
    'P-521': 'secp521r1',
  };
  const oidName = oidNames[namedCurve] ?? namedCurve;
  const nid = lib.symbols.OBJ_txt2nid(encodeUtf8(oidName + '\0'));
  if (nid === 0) throw new Error(`OBJ_txt2nid: ${oidName} not recognised`);
  _curveNidCache.set(namedCurve, nid);
  return nid;
}

// Per-curve SPKI prefix bytes and geometry constants.
//
// SubjectPublicKeyInfo structure:
//   SEQUENCE {
//     SEQUENCE { OID id-ecPublicKey; OID <curve> }
//     BIT STRING { 0x00 04 X Y }   (uncompressed point, POINT_CONVERSION=4)
//   }
//
// Sizes:
//   P-256: prefix 26 B, point 65 B (04+32+32),   total SPKI 91 B
//   P-384: prefix 23 B, point 97 B (04+48+48),   total SPKI 120 B
//   P-521: prefix 25 B, point 133 B (04+66+66),  total SPKI 158 B
interface _CurveInfo {
  prefix:    Uint8Array;
  coordSize: number; // bytes per coordinate
  pointSize: number; // full uncompressed point = 1 + 2 × coordSize
  spkiSize:  number; // prefix.length + pointSize
}

const _CURVE_INFO: Record<string, _CurveInfo> = {
  'P-256': {
    prefix: new Uint8Array([
      0x30, 0x59,                                                        // SEQUENCE(89)
      0x30, 0x13,                                                        // SEQUENCE(19)
      0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,            // OID ecPublicKey
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,      // OID prime256v1
      0x03, 0x42, 0x00,                                                  // BIT STRING(66), 0 unused
    ]),
    coordSize: 32, pointSize: 65, spkiSize: 91,
  },
  'P-384': {
    prefix: new Uint8Array([
      0x30, 0x76,                                                        // SEQUENCE(118)
      0x30, 0x10,                                                        // SEQUENCE(16)
      0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,            // OID ecPublicKey
      0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22,                        // OID secp384r1
      0x03, 0x62, 0x00,                                                  // BIT STRING(98), 0 unused
    ]),
    coordSize: 48, pointSize: 97, spkiSize: 120,
  },
  'P-521': {
    prefix: new Uint8Array([
      0x30, 0x81, 0x9b,                                                  // SEQUENCE(155) long-form
      0x30, 0x10,                                                        // SEQUENCE(16)
      0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,            // OID ecPublicKey
      0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23,                        // OID secp521r1
      0x03, 0x81, 0x86, 0x00,                                            // BIT STRING(134) long-form, 0 unused
    ]),
    coordSize: 66, pointSize: 133, spkiSize: 158,
  },
};

/** Return the byte size of each coordinate for the given named curve (32/48/66). */
export function ecdsaCoordSize(namedCurve: string): number {
  const info = _CURVE_INFO[namedCurve];
  if (!info) throw new Error(`Unsupported EC curve: ${namedCurve}`);
  return info.coordSize;
}

/**
 * Generate an EC key pair for the given named curve.
 * Returns an EVP_PKEY* owning both private and public components.
 * The caller must eventually call `evpPkeyFree()`.
 */
export function evpPkeyGenerateEc(namedCurve: string): object {
  if (!_CURVE_INFO[namedCurve]) throw new Error(`Unsupported EC curve: ${namedCurve}`);
  const lib   = _requireCrypto();
  const nid   = _curveNID(namedCurve);
  const ecKey = lib.symbols.EC_KEY_new_by_curve_name(nid);
  if (ecKey === null) throw new Error('EC_KEY_new_by_curve_name failed: ' + getErrorString());
  if (lib.symbols.EC_KEY_generate_key(ecKey) !== 1) {
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EC_KEY_generate_key failed: ' + getErrorString());
  }
  const pkey = lib.symbols.EVP_PKEY_new();
  if (pkey === null) {
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EVP_PKEY_new failed: ' + getErrorString());
  }
  if (lib.symbols.EVP_PKEY_set1_EC_KEY(pkey, ecKey) !== 1) {
    lib.symbols.EVP_PKEY_free(pkey);
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EVP_PKEY_set1_EC_KEY failed: ' + getErrorString());
  }
  return pkey;
}

/** @deprecated Use evpPkeyGenerateEc('P-256') instead. */
export function evpPkeyGenerateEcP256(): object { return evpPkeyGenerateEc('P-256'); }

/** Free an EVP_PKEY* returned by evpPkeyGenerateEc or evpPkeyImportSpki. */
export function evpPkeyFree(pkey: object): void {
  _requireCrypto().symbols.EVP_PKEY_free(pkey);
}

/**
 * Export the public component of an EC key as DER-encoded SPKI.
 * `namedCurve` must match the curve used when the key was generated.
 */
export function evpPkeyExportSpki(pkey: object, namedCurve: string): Uint8Array {
  const info = _CURVE_INFO[namedCurve];
  if (!info) throw new Error(`Unsupported EC curve: ${namedCurve}`);
  const lib   = _requireCrypto();
  const ecKey = lib.symbols.EVP_PKEY_get0_EC_KEY(pkey);
  if (ecKey === null) throw new Error('EVP_PKEY_get0_EC_KEY returned null');
  const group  = lib.symbols.EC_KEY_get0_group(ecKey);
  const point  = lib.symbols.EC_KEY_get0_public_key(ecKey);
  const outBuf = new Uint8Array(info.pointSize);
  // POINT_CONVERSION_UNCOMPRESSED = 4
  const written = lib.symbols.EC_POINT_point2oct(group, point, 4, outBuf, info.pointSize, null);
  if (Number(written) !== info.pointSize) {
    throw new Error('EC_POINT_point2oct failed: ' + getErrorString());
  }
  const spki = new Uint8Array(info.spkiSize);
  spki.set(info.prefix);
  spki.set(outBuf, info.prefix.length);
  return spki;
}

/**
 * Import an EC public key from DER-encoded SPKI.
 * Auto-detects the curve from the SPKI header bytes.
 * Returns `{ pkey, namedCurve }`. The caller must call evpPkeyFree(pkey) when done.
 */
export function evpPkeyImportSpki(der: Uint8Array): { pkey: object; namedCurve: string } {
  let namedCurve: string | undefined;
  let info: _CurveInfo | undefined;

  for (const [curve, curveInfo] of Object.entries(_CURVE_INFO)) {
    if (der.length !== curveInfo.spkiSize) continue;
    let match = true;
    for (let i = 0; i < curveInfo.prefix.length; i++) {
      if (der[i] !== curveInfo.prefix[i]) { match = false; break; }
    }
    if (match) { namedCurve = curve; info = curveInfo; break; }
  }

  if (!info || !namedCurve) {
    const knownSizes = Object.values(_CURVE_INFO).map(c => c.spkiSize).join('/');
    throw new Error(
      `SPKI header does not match any supported EC curve (P-256/P-384/P-521). ` +
      `Expected ${knownSizes} bytes, got ${der.length}.`,
    );
  }

  const prefixLen = info.prefix.length;
  if (der[prefixLen] !== 0x04) {
    throw new Error(`SPKI: expected uncompressed EC point (0x04) at byte ${prefixLen}`);
  }
  const pointBytes = der.subarray(prefixLen); // 04 || X || Y

  const lib   = _requireCrypto();
  const nid   = _curveNID(namedCurve);
  const ecKey = lib.symbols.EC_KEY_new_by_curve_name(nid);
  if (ecKey === null) throw new Error('EC_KEY_new_by_curve_name failed: ' + getErrorString());

  const group = lib.symbols.EC_KEY_get0_group(ecKey);
  const point = lib.symbols.EC_POINT_new(group);
  if (point === null) {
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EC_POINT_new failed: ' + getErrorString());
  }

  if (lib.symbols.EC_POINT_oct2point(group, point, pointBytes, info.pointSize, null) !== 1) {
    lib.symbols.EC_POINT_free(point);
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EC_POINT_oct2point failed: ' + getErrorString());
  }

  const rc2 = lib.symbols.EC_KEY_set_public_key(ecKey, point);
  lib.symbols.EC_POINT_free(point);
  if (rc2 !== 1) {
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EC_KEY_set_public_key failed: ' + getErrorString());
  }

  const pkey = lib.symbols.EVP_PKEY_new();
  if (pkey === null) {
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EVP_PKEY_new failed: ' + getErrorString());
  }
  if (lib.symbols.EVP_PKEY_set1_EC_KEY(pkey, ecKey) !== 1) {
    lib.symbols.EVP_PKEY_free(pkey);
    lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EVP_PKEY_set1_EC_KEY failed: ' + getErrorString());
  }
  return { pkey, namedCurve };
}

/**
 * ECDSA sign: compute ECDSA_sign(0, hash, hashLen, ...) and return the
 * DER-encoded signature.  `hash` must already be the digest bytes.
 */
export function ecdsaSign(hash: Uint8Array, pkey: object): Uint8Array {
  const lib   = _requireCrypto();
  const ecKey = lib.symbols.EVP_PKEY_get0_EC_KEY(pkey);
  if (ecKey === null) throw new Error('EVP_PKEY_get0_EC_KEY returned null');
  // 150 bytes is enough for all supported curves (P-521 max DER is ~141 bytes).
  const sigBuf    = new Uint8Array(150);
  const siglenBuf = new Uint8Array(4);
  new DataView(siglenBuf.buffer).setUint32(0, 150, true);
  if (lib.symbols.ECDSA_sign(0, hash, hash.length, sigBuf, siglenBuf, ecKey) !== 1) {
    throw new Error('ECDSA_sign failed: ' + getErrorString());
  }
  return sigBuf.slice(0, new DataView(siglenBuf.buffer).getUint32(0, true));
}

/**
 * ECDSA verify: return true if `derSig` is a valid DER-encoded ECDSA signature
 * over `hash` for the given public key.
 */
export function ecdsaVerify(hash: Uint8Array, derSig: Uint8Array, pkey: object): boolean {
  const lib   = _requireCrypto();
  const ecKey = lib.symbols.EVP_PKEY_get0_EC_KEY(pkey);
  if (ecKey === null) throw new Error('EVP_PKEY_get0_EC_KEY returned null');
  return lib.symbols.ECDSA_verify(0, hash, hash.length, derSig, derSig.length, ecKey) === 1;
}

// ---------------------------------------------------------------------------
// RSA key generation and operations
// ---------------------------------------------------------------------------

const RSA_PKCS1_PADDING      = 1;
const RSA_PKCS1_OAEP_PADDING = 4;
const RSA_PKCS1_PSS_PADDING  = 6;
const RSA_PSS_SALTLEN_AUTO   = -2; // use digest length for verify, set from signature for verify

/**
 * Generate an RSA key pair and return an EVP_PKEY* owning it.
 * `publicExponent` is typically 65537.  The caller must call evpPkeyFree().
 */
export function evpPkeyGenerateRsa(modulusBits: number, publicExponent: number): object {
  const lib = _requireCrypto();
  const rsa = lib.symbols.RSA_new();
  if (rsa === null) throw new Error('RSA_new failed: ' + getErrorString());

  const bn = lib.symbols.BN_new();
  if (bn === null) { lib.symbols.RSA_free(rsa); throw new Error('BN_new failed'); }

  if (lib.symbols.BN_set_word(bn, BigInt(publicExponent)) !== 1) {
    lib.symbols.BN_free(bn); lib.symbols.RSA_free(rsa);
    throw new Error('BN_set_word failed: ' + getErrorString());
  }
  if (lib.symbols.RSA_generate_key_ex(rsa, modulusBits, bn, null) !== 1) {
    lib.symbols.BN_free(bn); lib.symbols.RSA_free(rsa);
    throw new Error('RSA_generate_key_ex failed: ' + getErrorString());
  }
  lib.symbols.BN_free(bn);

  const pkey = lib.symbols.EVP_PKEY_new();
  if (pkey === null) { lib.symbols.RSA_free(rsa); throw new Error('EVP_PKEY_new failed'); }
  if (lib.symbols.EVP_PKEY_set1_RSA(pkey, rsa) !== 1) {
    lib.symbols.EVP_PKEY_free(pkey); lib.symbols.RSA_free(rsa);
    throw new Error('EVP_PKEY_set1_RSA failed: ' + getErrorString());
  }
  return pkey;
}

/**
 * Export the public component of an RSA EVP_PKEY as DER-encoded SPKI.
 * Uses i2d_PUBKEY (works for any EVP_PKEY type).
 */
export function evpPkeyExportSpkiRsa(pkey: object): Uint8Array {
  const lib = _requireCrypto();
  const len = lib.symbols.i2d_PUBKEY(pkey, null);
  if (len <= 0) throw new Error('i2d_PUBKEY (length) failed: ' + getErrorString());
  const der = new Uint8Array(len);
  const pp  = _ptrPtrBuf(der);
  const written = lib.symbols.i2d_PUBKEY(pkey, pp);
  if (written <= 0) throw new Error('i2d_PUBKEY (write) failed: ' + getErrorString());
  return der;
}

/**
 * Import an RSA public key from DER-encoded SPKI.
 * Uses d2i_PUBKEY (works for any EVP_PKEY type).
 * The caller must call evpPkeyFree().
 */
export function evpPkeyImportSpkiRsa(der: Uint8Array): object {
  const lib  = _requireCrypto();
  const pp   = _ptrPtrBuf(der);
  const pkey = lib.symbols.d2i_PUBKEY(null, pp, der.length);
  if (pkey === null) throw new Error('d2i_PUBKEY failed: ' + getErrorString());
  return pkey;
}

/**
 * RSA-OAEP encrypt.  Returns ciphertext.
 * `hashMd` is the EVP_MD* for the OAEP hash and the MGF1 hash.
 * `label` may be empty; most callers pass an empty Uint8Array.
 */
export function rsaOaepEncrypt(pkey: object, hashAlg: string, label: Uint8Array | null, data: Uint8Array): Uint8Array {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_PKEY_CTX_new(pkey, null);
  if (ctx === null) throw new Error('EVP_PKEY_CTX_new failed: ' + getErrorString());
  try {
    if (lib.symbols.EVP_PKEY_encrypt_init(ctx) !== 1) throw new Error('EVP_PKEY_encrypt_init failed');
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_OAEP_PADDING) <= 0) {
      throw new Error('set_rsa_padding(OAEP) failed: ' + getErrorString());
    }
    const md = _getMd(_normalizeDigestAlgorithm(hashAlg));
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_oaep_md(ctx, md) <= 0) {
      throw new Error('set_rsa_oaep_md failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_mgf1_md(ctx, md) <= 0) {
      throw new Error('set_rsa_mgf1_md failed: ' + getErrorString());
    }
    // Note: setting label is omitted (label must be null or empty per Web Crypto default).
    void label;

    // Get output length.
    const outlenBuf = new Uint8Array(8);
    if (lib.symbols.EVP_PKEY_encrypt(ctx, null, outlenBuf, data, data.length) !== 1) {
      throw new Error('EVP_PKEY_encrypt (length) failed: ' + getErrorString());
    }
    const outLen = Number(new DataView(outlenBuf.buffer).getBigUint64(0, true));
    const outBuf = new Uint8Array(outLen);
    const outlenBuf2 = new Uint8Array(8);
    new DataView(outlenBuf2.buffer).setBigUint64(0, BigInt(outLen), true);
    if (lib.symbols.EVP_PKEY_encrypt(ctx, outBuf, outlenBuf2, data, data.length) !== 1) {
      throw new Error('EVP_PKEY_encrypt (write) failed: ' + getErrorString());
    }
    return outBuf;
  } finally {
    lib.symbols.EVP_PKEY_CTX_free(ctx);
  }
}

/**
 * RSA-OAEP decrypt.  Returns plaintext.
 */
export function rsaOaepDecrypt(pkey: object, hashAlg: string, label: Uint8Array | null, data: Uint8Array): Uint8Array {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_PKEY_CTX_new(pkey, null);
  if (ctx === null) throw new Error('EVP_PKEY_CTX_new failed: ' + getErrorString());
  try {
    if (lib.symbols.EVP_PKEY_decrypt_init(ctx) !== 1) throw new Error('EVP_PKEY_decrypt_init failed');
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_OAEP_PADDING) <= 0) {
      throw new Error('set_rsa_padding(OAEP) failed: ' + getErrorString());
    }
    const md = _getMd(_normalizeDigestAlgorithm(hashAlg));
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_oaep_md(ctx, md) <= 0) {
      throw new Error('set_rsa_oaep_md failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_mgf1_md(ctx, md) <= 0) {
      throw new Error('set_rsa_mgf1_md failed: ' + getErrorString());
    }
    void label;

    const outlenBuf = new Uint8Array(8);
    if (lib.symbols.EVP_PKEY_decrypt(ctx, null, outlenBuf, data, data.length) !== 1) {
      throw new Error('EVP_PKEY_decrypt (length) failed: ' + getErrorString());
    }
    const outLen = Number(new DataView(outlenBuf.buffer).getBigUint64(0, true));
    const outBuf = new Uint8Array(outLen);
    const outlenBuf2 = new Uint8Array(8);
    new DataView(outlenBuf2.buffer).setBigUint64(0, BigInt(outLen), true);
    if (lib.symbols.EVP_PKEY_decrypt(ctx, outBuf, outlenBuf2, data, data.length) !== 1) {
      throw new Error('EVP_PKEY_decrypt failed (bad padding or wrong key): ' + getErrorString());
    }
    const actualLen = Number(new DataView(outlenBuf2.buffer).getBigUint64(0, true));
    return outBuf.subarray(0, actualLen);
  } finally {
    lib.symbols.EVP_PKEY_CTX_free(ctx);
  }
}

/**
 * RSA-PSS sign: pre-hash `data` and sign the digest.
 * `saltLength = -1` means "auto" (use hash size); -2 = "max".
 */
export function rsaPssSign(pkey: object, hashAlg: string, saltLength: number, data: Uint8Array): Uint8Array {
  const lib  = _requireCrypto();
  const norm = _normalizeDigestAlgorithm(hashAlg);
  const hash = digest(hashAlg, data);
  const ctx  = lib.symbols.EVP_PKEY_CTX_new(pkey, null);
  if (ctx === null) throw new Error('EVP_PKEY_CTX_new failed: ' + getErrorString());
  try {
    if (lib.symbols.EVP_PKEY_sign_init(ctx) !== 1) throw new Error('EVP_PKEY_sign_init failed');
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_PSS_PADDING) <= 0) {
      throw new Error('set_rsa_padding(PSS) failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_CTX_set_signature_md(ctx, _getMd(norm)) <= 0) {
      throw new Error('set_signature_md failed: ' + getErrorString());
    }
    const sl = saltLength === -1 ? _digestSize[norm] : saltLength;
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_pss_saltlen(ctx, sl) <= 0) {
      throw new Error('set_rsa_pss_saltlen failed: ' + getErrorString());
    }
    const siglenBuf = new Uint8Array(8);
    if (lib.symbols.EVP_PKEY_sign(ctx, null, siglenBuf, hash, hash.length) !== 1) {
      throw new Error('EVP_PKEY_sign (length) failed: ' + getErrorString());
    }
    const sigLen = Number(new DataView(siglenBuf.buffer).getBigUint64(0, true));
    const sig    = new Uint8Array(sigLen);
    const siglenBuf2 = new Uint8Array(8);
    new DataView(siglenBuf2.buffer).setBigUint64(0, BigInt(sigLen), true);
    if (lib.symbols.EVP_PKEY_sign(ctx, sig, siglenBuf2, hash, hash.length) !== 1) {
      throw new Error('EVP_PKEY_sign (write) failed: ' + getErrorString());
    }
    return sig;
  } finally {
    lib.symbols.EVP_PKEY_CTX_free(ctx);
  }
}

/**
 * RSA-PSS verify: return true if the signature is valid.
 */
export function rsaPssVerify(pkey: object, hashAlg: string, sig: Uint8Array, data: Uint8Array): boolean {
  const lib  = _requireCrypto();
  const norm = _normalizeDigestAlgorithm(hashAlg);
  const hash = digest(hashAlg, data);
  const ctx  = lib.symbols.EVP_PKEY_CTX_new(pkey, null);
  if (ctx === null) throw new Error('EVP_PKEY_CTX_new failed: ' + getErrorString());
  try {
    if (lib.symbols.EVP_PKEY_verify_init(ctx) !== 1) throw new Error('EVP_PKEY_verify_init failed');
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_PSS_PADDING) <= 0) {
      throw new Error('set_rsa_padding(PSS) failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_CTX_set_signature_md(ctx, _getMd(norm)) <= 0) {
      throw new Error('set_signature_md failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_pss_saltlen(ctx, RSA_PSS_SALTLEN_AUTO) <= 0) {
      throw new Error('set_rsa_pss_saltlen failed: ' + getErrorString());
    }
    const rc = lib.symbols.EVP_PKEY_verify(ctx, sig, sig.length, hash, hash.length);
    return rc === 1;
  } finally {
    lib.symbols.EVP_PKEY_CTX_free(ctx);
  }
}

/**
 * RSASSA-PKCS1-v1_5 sign.
 */
export function rsaPkcs1Sign(pkey: object, hashAlg: string, data: Uint8Array): Uint8Array {
  const lib  = _requireCrypto();
  const norm = _normalizeDigestAlgorithm(hashAlg);
  const hash = digest(hashAlg, data);
  const ctx  = lib.symbols.EVP_PKEY_CTX_new(pkey, null);
  if (ctx === null) throw new Error('EVP_PKEY_CTX_new failed: ' + getErrorString());
  try {
    if (lib.symbols.EVP_PKEY_sign_init(ctx) !== 1) throw new Error('EVP_PKEY_sign_init failed');
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_PADDING) <= 0) {
      throw new Error('set_rsa_padding(PKCS1) failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_CTX_set_signature_md(ctx, _getMd(norm)) <= 0) {
      throw new Error('set_signature_md failed: ' + getErrorString());
    }
    const siglenBuf = new Uint8Array(8);
    if (lib.symbols.EVP_PKEY_sign(ctx, null, siglenBuf, hash, hash.length) !== 1) {
      throw new Error('EVP_PKEY_sign (length) failed: ' + getErrorString());
    }
    const sigLen = Number(new DataView(siglenBuf.buffer).getBigUint64(0, true));
    const sig    = new Uint8Array(sigLen);
    const siglenBuf2 = new Uint8Array(8);
    new DataView(siglenBuf2.buffer).setBigUint64(0, BigInt(sigLen), true);
    if (lib.symbols.EVP_PKEY_sign(ctx, sig, siglenBuf2, hash, hash.length) !== 1) {
      throw new Error('EVP_PKEY_sign (write) failed: ' + getErrorString());
    }
    return sig;
  } finally {
    lib.symbols.EVP_PKEY_CTX_free(ctx);
  }
}

/**
 * RSASSA-PKCS1-v1_5 verify.
 */
export function rsaPkcs1Verify(pkey: object, hashAlg: string, sig: Uint8Array, data: Uint8Array): boolean {
  const lib  = _requireCrypto();
  const norm = _normalizeDigestAlgorithm(hashAlg);
  const hash = digest(hashAlg, data);
  const ctx  = lib.symbols.EVP_PKEY_CTX_new(pkey, null);
  if (ctx === null) throw new Error('EVP_PKEY_CTX_new failed: ' + getErrorString());
  try {
    if (lib.symbols.EVP_PKEY_verify_init(ctx) !== 1) throw new Error('EVP_PKEY_verify_init failed');
    if (lib.symbols.EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_PADDING) <= 0) {
      throw new Error('set_rsa_padding(PKCS1) failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_CTX_set_signature_md(ctx, _getMd(norm)) <= 0) {
      throw new Error('set_signature_md failed: ' + getErrorString());
    }
    const rc = lib.symbols.EVP_PKEY_verify(ctx, sig, sig.length, hash, hash.length);
    return rc === 1;
  } finally {
    lib.symbols.EVP_PKEY_CTX_free(ctx);
  }
}

// ---------------------------------------------------------------------------
// RSA JWK component import via raw BIGNUM construction
//
// Export: done by parsing the DER output of evpPkeyExportSpkiRsa /
//         evpPkeyExportPkcs8 in JavaScript (no FFI pointer re-reading needed).
//
// Import: construct an RSA key from raw byte-array components using the
//         RSA_set0_* family.  BIGNUMs are created via BN_bin2bn.
// ---------------------------------------------------------------------------

/** Convert a byte array to a new BN (caller must free via BN_free). */
function _bytesToBn(lib: ReturnType<typeof _requireCrypto>, bytes: Uint8Array): object {
  const bn = lib.symbols.BN_bin2bn(bytes, bytes.length, null);
  if (bn === null) throw new Error('BN_bin2bn failed: ' + getErrorString());
  return bn;
}

/**
 * Import an RSA key from raw component byte arrays.
 * Provide `d` and friends for a private key; omit them for a public key.
 * The caller must call evpPkeyFree().
 */
export function rsaImportComponents(components: {
  n: Uint8Array; e: Uint8Array;
  d?: Uint8Array; p?: Uint8Array; q?: Uint8Array;
  dp?: Uint8Array; dq?: Uint8Array; qi?: Uint8Array;
}): object {
  const lib = _requireCrypto();
  const rsa = lib.symbols.RSA_new();
  if (rsa === null) throw new Error('RSA_new failed');

  const nBn = _bytesToBn(lib, components.n);
  const eBn = _bytesToBn(lib, components.e);
  const dBn = components.d ? _bytesToBn(lib, components.d) : null;

  // RSA_set0_key takes ownership of the BIGNUMs.
  if (lib.symbols.RSA_set0_key(rsa, nBn, eBn, dBn) !== 1) {
    lib.symbols.RSA_free(rsa);
    throw new Error('RSA_set0_key failed: ' + getErrorString());
  }

  if (components.p && components.q) {
    const pBn = _bytesToBn(lib, components.p);
    const qBn = _bytesToBn(lib, components.q);
    if (lib.symbols.RSA_set0_factors(rsa, pBn, qBn) !== 1) {
      lib.symbols.RSA_free(rsa);
      throw new Error('RSA_set0_factors failed: ' + getErrorString());
    }
    if (components.dp && components.dq && components.qi) {
      const dpBn = _bytesToBn(lib, components.dp);
      const dqBn = _bytesToBn(lib, components.dq);
      const qiBn = _bytesToBn(lib, components.qi);
      if (lib.symbols.RSA_set0_crt_params(rsa, dpBn, dqBn, qiBn) !== 1) {
        lib.symbols.RSA_free(rsa);
        throw new Error('RSA_set0_crt_params failed: ' + getErrorString());
      }
    }
  }

  const pkey = lib.symbols.EVP_PKEY_new();
  if (pkey === null) { lib.symbols.RSA_free(rsa); throw new Error('EVP_PKEY_new failed'); }
  if (lib.symbols.EVP_PKEY_set1_RSA(pkey, rsa) !== 1) {
    lib.symbols.EVP_PKEY_free(pkey); lib.symbols.RSA_free(rsa);
    throw new Error('EVP_PKEY_set1_RSA failed: ' + getErrorString());
  }
  return pkey;
}

// ---------------------------------------------------------------------------
// EC JWK coordinate helpers
// ---------------------------------------------------------------------------

/**
 * Extract the uncompressed public key point (04 || X || Y) from an EC EVP_PKEY,
 * then split into separate X and Y Uint8Arrays of `coordSize` bytes each.
 */
export function ecPublicKeyCoords(pkey: object, namedCurve: string): { x: Uint8Array; y: Uint8Array } {
  const info = _CURVE_INFO[namedCurve];
  if (!info) throw new Error(`Unsupported EC curve: ${namedCurve}`);
  const lib   = _requireCrypto();
  const ecKey = lib.symbols.EVP_PKEY_get0_EC_KEY(pkey);
  if (ecKey === null) throw new Error('EVP_PKEY_get0_EC_KEY returned null');
  const group  = lib.symbols.EC_KEY_get0_group(ecKey);
  const point  = lib.symbols.EC_KEY_get0_public_key(ecKey);
  const outBuf = new Uint8Array(info.pointSize);
  const written = lib.symbols.EC_POINT_point2oct(group, point, 4, outBuf, info.pointSize, null);
  if (Number(written) !== info.pointSize) throw new Error('EC_POINT_point2oct failed: ' + getErrorString());
  // outBuf = 04 || X(coordSize) || Y(coordSize) — skip the 04 prefix byte.
  const x = outBuf.slice(1, 1 + info.coordSize);
  const y = outBuf.slice(1 + info.coordSize);
  return { x, y };
}

/**
 * Build an EVP_PKEY from raw EC JWK coordinates (x, y required; d optional for private).
 * All coordinate arrays must be `coordSize` bytes (big-endian, zero-padded).
 */
export function evpPkeyImportEcJwk(
  namedCurve: string,
  x: Uint8Array,
  y: Uint8Array,
  d?: Uint8Array,
): object {
  const info = _CURVE_INFO[namedCurve];
  if (!info) throw new Error(`Unsupported EC curve: ${namedCurve}`);
  const lib = _requireCrypto();
  const nid = _curveNID(namedCurve);

  const ecKey = lib.symbols.EC_KEY_new_by_curve_name(nid);
  if (ecKey === null) throw new Error('EC_KEY_new_by_curve_name failed: ' + getErrorString());

  // Reconstruct the uncompressed point from x, y and import it.
  const pointBytes = new Uint8Array(info.pointSize);
  pointBytes[0] = 0x04;
  pointBytes.set(x, 1);
  pointBytes.set(y, 1 + info.coordSize);

  const group = lib.symbols.EC_KEY_get0_group(ecKey);
  const point = lib.symbols.EC_POINT_new(group);
  if (point === null) { lib.symbols.EC_KEY_free(ecKey); throw new Error('EC_POINT_new failed: ' + getErrorString()); }

  if (lib.symbols.EC_POINT_oct2point(group, point, pointBytes, info.pointSize, null) !== 1) {
    lib.symbols.EC_POINT_free(point); lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EC_POINT_oct2point failed: ' + getErrorString());
  }
  if (lib.symbols.EC_KEY_set_public_key(ecKey, point) !== 1) {
    lib.symbols.EC_POINT_free(point); lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EC_KEY_set_public_key failed: ' + getErrorString());
  }
  lib.symbols.EC_POINT_free(point);

  // If private scalar `d` was provided, set it.
  if (d !== undefined) {
    const dBn = lib.symbols.BN_bin2bn(d, d.length, null);
    if (dBn === null) { lib.symbols.EC_KEY_free(ecKey); throw new Error('BN_bin2bn(d) failed: ' + getErrorString()); }
    if (lib.symbols.EC_KEY_set_private_key(ecKey, dBn) !== 1) {
      lib.symbols.BN_free(dBn); lib.symbols.EC_KEY_free(ecKey);
      throw new Error('EC_KEY_set_private_key failed: ' + getErrorString());
    }
    lib.symbols.BN_free(dBn);
  }

  const pkey = lib.symbols.EVP_PKEY_new();
  if (pkey === null) { lib.symbols.EC_KEY_free(ecKey); throw new Error('EVP_PKEY_new failed: ' + getErrorString()); }
  if (lib.symbols.EVP_PKEY_set1_EC_KEY(pkey, ecKey) !== 1) {
    lib.symbols.EVP_PKEY_free(pkey); lib.symbols.EC_KEY_free(ecKey);
    throw new Error('EVP_PKEY_set1_EC_KEY failed: ' + getErrorString());
  }
  return pkey;
}

// ---------------------------------------------------------------------------
// PKCS8 PrivateKeyInfo — DER import/export for EC and RSA private keys
//
// The OpenSSL `i2d_*` and `d2i_*` APIs use an `unsigned char **pp` argument.
// The FFI binding declares this as `buffer`, so we pass a Uint8Array whose
// first 8 bytes (platform pointer size) hold the native address of our
// actual data buffer.  Pointer.addr() gives us that address as a bigint.
// ---------------------------------------------------------------------------

/** Build an 8-byte little-endian buffer containing the native address of `buf`. */
function _ptrPtrBuf(buf: Uint8Array): Uint8Array {
  const addr = Pointer.addr(buf);
  const pp   = new Uint8Array(8);
  new DataView(pp.buffer).setBigUint64(0, addr, true /* little-endian */);
  return pp;
}

/**
 * Export an EVP_PKEY private key as an unencrypted PKCS8 PrivateKeyInfo DER blob.
 * Works for EC keys (all curves) and RSA keys.
 */
export function evpPkeyExportPkcs8(pkey: object): Uint8Array {
  const lib = _requireCrypto();
  const p8  = lib.symbols.EVP_PKEY2PKCS8(pkey);
  if (p8 === null) throw new Error('EVP_PKEY2PKCS8 failed: ' + getErrorString());
  try {
    // Pass null to get the required DER length (OpenSSL: pp==null → no write).
    const len = lib.symbols.i2d_PKCS8_PRIV_KEY_INFO(p8, null);
    if (len <= 0) throw new Error('i2d_PKCS8_PRIV_KEY_INFO (length query) failed: ' + getErrorString());

    // Allocate the output DER buffer and build a pointer-to-pointer (pp) that
    // points to its first byte.  OpenSSL reads *pp, writes DER there, advances *pp.
    const der = new Uint8Array(len);
    const pp  = _ptrPtrBuf(der);
    const written = lib.symbols.i2d_PKCS8_PRIV_KEY_INFO(p8, pp);
    if (written <= 0) throw new Error('i2d_PKCS8_PRIV_KEY_INFO (write) failed: ' + getErrorString());
    return der;
  } finally {
    lib.symbols.PKCS8_PRIV_KEY_INFO_free(p8);
  }
}

/**
 * Import an EVP_PKEY from an unencrypted PKCS8 PrivateKeyInfo DER blob.
 * Works for EC keys (all curves) and RSA keys.
 * The caller must call evpPkeyFree() when done.
 */
export function evpPkeyImportPkcs8(der: Uint8Array): object {
  const lib  = _requireCrypto();
  // d2i_PKCS8_PRIV_KEY_INFO also takes unsigned char **pp.
  // Build a pp pointing to our input DER buffer.
  const pp  = _ptrPtrBuf(der);
  const p8  = lib.symbols.d2i_PKCS8_PRIV_KEY_INFO(null, pp, der.length);
  if (p8 === null) throw new Error('d2i_PKCS8_PRIV_KEY_INFO failed: ' + getErrorString());
  try {
    const pkey = lib.symbols.EVP_PKCS82PKEY(p8);
    if (pkey === null) throw new Error('EVP_PKCS82PKEY failed: ' + getErrorString());
    return pkey;
  } finally {
    lib.symbols.PKCS8_PRIV_KEY_INFO_free(p8);
  }
}

// ---------------------------------------------------------------------------
// ECDH shared-secret derivation
// ---------------------------------------------------------------------------

/**
 * Derive the ECDH shared secret between a private key and a peer public key.
 * Both keys must be on the same named curve.
 * Returns the raw shared secret bytes (X coordinate of the shared point).
 */
export function evpPkeyDeriveEcdh(privateKey: object, publicKey: object): Uint8Array {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_PKEY_CTX_new(privateKey, null);
  if (ctx === null) throw new Error('EVP_PKEY_CTX_new failed: ' + getErrorString());
  try {
    if (lib.symbols.EVP_PKEY_derive_init(ctx) !== 1) {
      throw new Error('EVP_PKEY_derive_init failed: ' + getErrorString());
    }
    if (lib.symbols.EVP_PKEY_derive_set_peer(ctx, publicKey) !== 1) {
      throw new Error('EVP_PKEY_derive_set_peer failed: ' + getErrorString());
    }
    // First pass: key=null → determine length.
    const lenBuf = new Uint8Array(8);
    if (lib.symbols.EVP_PKEY_derive(ctx, null, lenBuf) !== 1) {
      throw new Error('EVP_PKEY_derive (length query) failed: ' + getErrorString());
    }
    const secretLen = Number(new DataView(lenBuf.buffer).getBigUint64(0, true));
    // Second pass: write shared secret.
    const secret = new Uint8Array(secretLen);
    const len2   = new Uint8Array(8);
    new DataView(len2.buffer).setBigUint64(0, BigInt(secretLen), true);
    if (lib.symbols.EVP_PKEY_derive(ctx, secret, len2) !== 1) {
      throw new Error('EVP_PKEY_derive (write) failed: ' + getErrorString());
    }
    return secret;
  } finally {
    lib.symbols.EVP_PKEY_CTX_free(ctx);
  }
}

/**
 * Extract the private scalar `d` from an EC private key as big-endian bytes.
 * The result is zero-padded to `coordSize` bytes.
 */
export function ecPrivateKeyD(pkey: object, coordSize: number): Uint8Array {
  const lib   = _requireCrypto();
  const ecKey = lib.symbols.EVP_PKEY_get0_EC_KEY(pkey);
  if (ecKey === null) throw new Error('EVP_PKEY_get0_EC_KEY returned null');
  const bn = lib.symbols.EC_KEY_get0_private_key(ecKey);
  if (bn === null) throw new Error('EC_KEY_get0_private_key returned null (key has no private component)');
  // BN_num_bytes is a macro in OpenSSL 3; compute ceil(bits/8) using BN_num_bits.
  const numBytes = Math.ceil(lib.symbols.BN_num_bits(bn) / 8);
  const raw = new Uint8Array(numBytes);
  lib.symbols.BN_bn2bin(bn, raw);
  // Zero-pad on the left to fill coordSize bytes.
  if (numBytes === coordSize) return raw;
  const padded = new Uint8Array(coordSize);
  padded.set(raw, coordSize - numBytes);
  return padded;
}

// ---------------------------------------------------------------------------
// SSL — context management
// ---------------------------------------------------------------------------

export function sslCtxNewClient(): object {
  const lib = _requireSsl();
  const method = lib.symbols.TLS_client_method();
  const ctx = lib.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new failed: ' + getErrorString());
  return ctx;
}

export function sslCtxNewServer(): object {
  const lib = _requireSsl();
  const method = lib.symbols.TLS_server_method();
  const ctx = lib.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new failed: ' + getErrorString());
  return ctx;
}

/**
 * Create a server SSL context and load a PEM certificate + private key.
 * Both paths must point to PEM-encoded files (SSL_FILETYPE_PEM = 1).
 * Throws if the context cannot be created or either file fails to load.
 *
 * @param {string} certPath — path to PEM certificate file
 * @param {string} keyPath  — path to PEM private key file
 * @returns {object} SSL_CTX* configured with the cert/key pair
 */
export function sslCtxLoadCertKey(certPath: string, keyPath: string): object {
  const lib = _requireSsl();
  const ctx = sslCtxNewServer();

  const certBuf = encodeUtf8(certPath + '\0');
  const rc1 = lib.symbols.SSL_CTX_use_certificate_file(ctx, certBuf, 1);
  if (rc1 !== 1) {
    lib.symbols.SSL_CTX_free(ctx);
    throw new Error(`TLS: failed to load certificate "${certPath}": ` + getErrorString());
  }

  const keyBuf = encodeUtf8(keyPath + '\0');
  const rc2 = lib.symbols.SSL_CTX_use_PrivateKey_file(ctx, keyBuf, 1);
  if (rc2 !== 1) {
    lib.symbols.SSL_CTX_free(ctx);
    throw new Error(`TLS: failed to load private key "${keyPath}": ` + getErrorString());
  }

  const rc3 = lib.symbols.SSL_CTX_check_private_key(ctx);
  if (rc3 !== 1) {
    lib.symbols.SSL_CTX_free(ctx);
    throw new Error(`TLS: certificate "${certPath}" and key "${keyPath}" do not match: ` + getErrorString());
  }

  // Advertise HTTP/1.1 via ALPN so clients can negotiate the protocol during
  // handshake. This is a prerequisite for future HTTP/2 (h2) support.
  const alpnBuf = _encodeAlpnProtocols(['http/1.1']);
  lib.symbols.SSL_CTX_set_alpn_protos(ctx, alpnBuf, alpnBuf.length);

  return ctx;
}

export function sslCtxFree(ctx: object): void {
  _requireSsl().symbols.SSL_CTX_free(ctx);
}

// ---------------------------------------------------------------------------
// ALPN (Application Layer Protocol Negotiation)
// ---------------------------------------------------------------------------

/**
 * Encode protocol names as a wire-format ALPN protocol list.
 * Each name is length-prefixed: `[len, ...bytes, len, ...bytes, ...]`.
 */
function _encodeAlpnProtocols(protocols: string[]): Uint8Array {
  let totalLen = 0;
  const encoded = protocols.map(p => { const b = encodeUtf8(p); totalLen += 1 + b.length; return b; });
  const buf = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of encoded) { buf[offset++] = b.length; buf.set(b, offset); offset += b.length; }
  return buf;
}

/**
 * Set the ALPN protocol list on an SSL_CTX (client side: preference list).
 * Used to advertise supported protocols during TLS handshake.
 *
 * @param ctx — SSL_CTX* (from sslCtxNewClient / sslCtxLoadCertKey)
 * @param protocols — ordered preference list, e.g. `['http/1.1']`
 */
export function sslCtxSetAlpnProtos(ctx: object, protocols: string[]): void {
  const lib = _requireSsl();
  const buf = _encodeAlpnProtocols(protocols);
  const rc = lib.symbols.SSL_CTX_set_alpn_protos(ctx, buf, buf.length);
  if (rc !== 0) throw new Error('SSL_CTX_set_alpn_protos failed: ' + getErrorString());
}

/**
 * Query the ALPN protocol that was negotiated on this SSL connection.
 * Returns null if no protocol was negotiated (no ALPN, or handshake not done yet).
 */
export function sslGetAlpnSelected(ssl: object): string | null {
  const lib = _requireSsl();
  const dataBuf = new Uint8Array(8);   // receives a non-owning C pointer (8-byte address)
  const lenBuf  = new Uint8Array(4);   // receives unsigned int length (4 bytes)
  lib.symbols.SSL_get0_alpn_selected(ssl, dataBuf, lenBuf);
  const len = new DataView(lenBuf.buffer).getUint32(0, true);
  if (len === 0) return null;
  // dataBuf holds the raw address OpenSSL wrote; copyFrom extracts it and reads len bytes from it.
  const bytes = Pointer.copyFrom(dataBuf, len) as Uint8Array;
  return decodeUtf8(bytes);
}

export function sslCtxSetDefaultVerifyPaths(ctx: object): void {
  const rc = _requireSsl().symbols.SSL_CTX_set_default_verify_paths(ctx);
  if (rc !== 1) throw new Error('SSL_CTX_set_default_verify_paths failed: ' + getErrorString());
}

/**
 * Load CA certificate(s) for peer verification.
 * @param {object} ctx — SSL_CTX* pointer
 * @param {string|null} caFile — path to a PEM file, or null
 * @param {string|null} caPath — path to a directory of PEM files, or null
 */
export function sslCtxLoadVerifyLocations(ctx: object, caFile: string | null, caPath: string | null): void {
  const lib = _requireSsl();
  const fileBuf = caFile ? encodeUtf8(caFile + '\0') : null;
  const pathBuf = caPath ? encodeUtf8(caPath + '\0') : null;
  const rc = lib.symbols.SSL_CTX_load_verify_locations(ctx, fileBuf, pathBuf);
  if (rc !== 1) throw new Error('SSL_CTX_load_verify_locations failed: ' + getErrorString());
}

export function sslCtxSetVerify(ctx: object, mode: number): void {
  _requireSsl().symbols.SSL_CTX_set_verify(ctx, mode, null);
}

// ---------------------------------------------------------------------------
// SSL — connection management
// ---------------------------------------------------------------------------

export function sslNew(ctx: object): object {
  const ssl = _requireSsl().symbols.SSL_new(ctx);
  if (ssl === null) throw new Error('SSL_new failed: ' + getErrorString());
  return ssl;
}

export function sslFree(ssl: object): void {
  _requireSsl().symbols.SSL_free(ssl);
}

export function sslSetFd(ssl: object, fd: number): void {
  const rc = _requireSsl().symbols.SSL_set_fd(ssl, fd);
  if (rc !== 1) throw new Error('SSL_set_fd failed');
}

/**
 * Set SNI hostname and enable hostname verification.
 * RFC 6066 forbids IP literals in the SNI extension — SNI is skipped for them.
 * SSL_set1_host is always called so that IP SAN matching still works.
 *
 * @param {object} ssl — SSL* pointer
 * @param {string} hostname — DNS name or IP address
 */
export function sslSetHostname(ssl: object, hostname: string): void {
  const lib = _requireSsl();
  // IP literals (IPv4: digits + dots; IPv6: hex + colons) must NOT appear in SNI.
  const isIpLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (!isIpLiteral) {
    // SSL_set_tlsext_host_name macro: SSL_ctrl(ssl, SSL_CTRL_SET_TLSEXT_HOSTNAME=55, 0, hostname)
    lib.symbols.SSL_ctrl(ssl, 55, 0, encodeUtf8(hostname + '\0'));
  }
  // Enable hostname/IP verification (OpenSSL 1.1.0+, LibreSSL 2.9+)
  lib.symbols.SSL_set1_host(ssl, encodeUtf8(hostname + '\0'));
}

/** Perform TLS handshake (client). Returns 1 on success. */
export function sslConnect(ssl: object): number { return _requireSsl().symbols.SSL_connect(ssl); }

/** Perform TLS handshake (server). Returns 1 on success (async — runs on blocking pool). */
export function sslAccept(ssl: object): Promise<number> { return _requireSsl().symbols.SSL_accept(ssl) as Promise<number>; }

/**
 * Set the ALPN protocol selection callback on a server SSL_CTX.
 *
 * Returns an FfiCallback that must be retained for the lifetime of the SSL_CTX
 * and closed when the SSL_CTX is freed.
 *
 * The callback picks the first protocol in `protocols` that the client also
 * offered. If no match is found, no ALPN extension is sent in the ServerHello.
 *
 * Requires SSL_accept to be async:true so the FfiCallback fires via the
 * condvar bridge rather than silently on the V8 thread.
 */
export function sslCtxSetAlpnServerProtos(ctx: object, protocols: string[]): object {
  const lib = _requireSsl();
  const dec = new TextDecoder();

  const cb = new FfiCallback(
    {
      parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'u32', 'pointer'],
      result: 'i32',
    },
    (
      _ssl:   ArrayBuffer,
      out:    ArrayBuffer,   // unsigned char **out — write selected proto address here
      outlen: ArrayBuffer,   // unsigned char *outlen — write selected proto length here
      inPtr:  ArrayBuffer,   // const unsigned char *in — client's ALPN wire list
      inlen:  number | bigint,
      _arg:   ArrayBuffer,
    ): number => {
      const n = Number(inlen);
      const clientBytes = Pointer.copyFrom(inPtr, n) as Uint8Array;
      let offset = 0;
      while (offset < clientBytes.byteLength) {
        const protoLen = clientBytes[offset]!;
        const proto = dec.decode(clientBytes.subarray(offset + 1, offset + 1 + protoLen));
        if (protocols.includes(proto)) {
          Pointer.writePointer(out, 0, Pointer.offset(inPtr, offset + 1));
          Pointer.writeU8(outlen, 0, protoLen);
          return 0; // SSL_TLSEXT_ERR_OK
        }
        offset += 1 + protoLen;
      }
      return 3; // SSL_TLSEXT_ERR_NOACK — no match
    },
  );

  lib.symbols.SSL_CTX_set_alpn_select_cb(ctx, cb.pointer, null);
  return cb; // caller must retain + close alongside sslCtxFree
}

/**
 * Read up to `len` decrypted bytes into `buf`.
 * @param {object} ssl
 * @param {ArrayBuffer} buf
 * @param {number} len
 * @returns {number} bytes read, 0 on graceful close, negative on error
 */
export function sslRead(ssl: object, buf: ArrayBuffer, len: number): number  { return _requireSsl().symbols.SSL_read(ssl, buf, len); }

/**
 * Write `len` bytes from `buf` over TLS.
 * @param {object} ssl
 * @param {Uint8Array|ArrayBuffer} buf
 * @param {number} len
 * @returns {number} bytes written, or negative on error
 */
export function sslWrite(ssl: object, buf: Uint8Array | ArrayBuffer, len: number): number { return _requireSsl().symbols.SSL_write(ssl, buf, len); }

/** Initiate TLS shutdown sequence. */
export function sslShutdown(ssl: object): number { return _requireSsl().symbols.SSL_shutdown(ssl); }

/** Translate an SSL return value to an error code. */
export function sslGetError(ssl: object, ret: number): number { return _requireSsl().symbols.SSL_get_error(ssl, ret); }

/** Return number of bytes already decrypted and buffered in OpenSSL. */
export function sslPending(ssl: object): number { return _requireSsl().symbols.SSL_pending(ssl); }

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
