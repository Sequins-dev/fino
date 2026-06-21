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
 * ## Example
 *
 * ```typescript no_run
 * import * as openssl from 'internal:openssl';
 *
 * if (openssl.cryptoAvailable) {
 *   const digest = openssl.digest('sha-256', new Uint8Array([1, 2, 3]));
 *   console.log(digest.byteLength);
 * }
 * ```
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

/**
 * Result returned by symmetric encryption helpers.
 *
 * GCM ciphers return both ciphertext and an authentication tag. CBC ciphers do
 * not authenticate and therefore return `tag: null`. Callers must pass the tag
 * back to `cipherDecrypt()` for GCM decryption and should treat a missing or
 * mismatched tag as an authentication failure.
 *
 * ```js
 * import { cipherEncrypt, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = new Uint8Array(32);
 *   const iv = new Uint8Array(12);
 *   const result = cipherEncrypt('aes-256-gcm', key, iv, new Uint8Array());
 *   console.log(result.tag?.byteLength ?? 0);
 * }
 * ```
 *
 * @internal
 */
export interface CipherResult {
  /**
   * Encrypted payload bytes.
   *
   * For CBC ciphers this includes OpenSSL padding output. For GCM ciphers this
   * is only the encrypted payload; the authentication tag is separate.
   *
   * ```js
   * import { cipherEncrypt, cryptoAvailable } from 'internal:openssl';
   * if (cryptoAvailable) {
   *   const result = cipherEncrypt('aes-128-cbc', new Uint8Array(16), new Uint8Array(16), new Uint8Array());
   *   console.log(result.ciphertext.byteLength);
   * }
   * ```
   *
   * @internal
   */
  ciphertext: Uint8Array;
  /**
   * Authentication tag for GCM ciphers, or `null` for CBC ciphers.
   *
   * The tag must be retained with the ciphertext and provided to
   * `cipherDecrypt()` for GCM. CBC callers should expect `null`.
   *
   * ```js
   * import { cipherEncrypt, cryptoAvailable } from 'internal:openssl';
   * if (cryptoAvailable) {
   *   const result = cipherEncrypt('aes-256-gcm', new Uint8Array(32), new Uint8Array(12), new Uint8Array());
   *   console.log(result.tag !== null);
   * }
   * ```
   *
   * @internal
   */
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
      '/usr/local/lib/libcrypto.3.dylib',
      '/usr/local/lib/libcrypto.1.1.dylib',
    ]
  : ['libcrypto.so.3', 'libcrypto.so.1.1', 'libcrypto.so'];

const _sslPaths = isDarwin
  ? [
      '/opt/homebrew/lib/libssl.3.dylib',
      '/usr/local/lib/libssl.3.dylib',
      '/usr/local/lib/libssl.1.1.dylib',
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
  EVP_DigestSignInit:   { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  EVP_DigestSign:       { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'usize'], result: 'i32' },
  EVP_DigestVerifyInit: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  EVP_DigestVerify:     { parameters: ['pointer', 'buffer', 'usize', 'buffer', 'usize'], result: 'i32' },
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
  EVP_PKEY_CTX_set0_rsa_oaep_label: { parameters: ['pointer', 'pointer', 'i32'], result: 'i32' },
  CRYPTO_malloc:                   { parameters: ['usize', 'pointer', 'i32'], result: 'pointer' },
  CRYPTO_free:                     { parameters: ['pointer', 'pointer', 'i32'], result: 'void' },

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
  EVP_PKEY_up_ref:        { parameters: ['pointer'], result: 'i32' },
  EVP_PKEY_new_raw_private_key: { parameters: ['i32', 'pointer', 'buffer', 'usize'], result: 'pointer' },
  EVP_PKEY_new_raw_public_key:  { parameters: ['i32', 'pointer', 'buffer', 'usize'], result: 'pointer' },
  EVP_PKEY_get_raw_private_key: { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  EVP_PKEY_get_raw_public_key:  { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
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
  SSL_set_connect_state: { parameters: ['pointer'], result: 'void' },
  SSL_set_accept_state: { parameters: ['pointer'], result: 'void' },
  SSL_set_ex_data: { parameters: ['pointer', 'i32', 'pointer'], result: 'i32' },
  SSL_set_fd:   { parameters: ['pointer', 'i32'], result: 'i32' },
  SSL_connect:  { parameters: ['pointer'], result: 'i32' },
  // async: true — runs on the blocking pool so ALPN select FfiCallbacks fire via condvar
  SSL_accept:   { parameters: ['pointer'], result: 'i32', async: true },
  SSL_CTX_set_alpn_select_cb: { parameters: ['pointer', 'pointer', 'pointer'], result: 'void' },
  SSL_CTX_callback_ctrl: { parameters: ['pointer', 'i32', 'pointer'], result: 'i64' },
  SSL_CTX_ctrl: { parameters: ['pointer', 'i32', 'i64', 'buffer'], result: 'i64' },
  SSL_set_SSL_CTX: { parameters: ['pointer', 'pointer'], result: 'pointer' },
  SSL_read:     { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  SSL_write:    { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  SSL_read_ex:  { parameters: ['pointer', 'buffer', 'usize', 'buffer'], result: 'i32' },
  SSL_shutdown: { parameters: ['pointer'], result: 'i32' },
  SSL_shutdown_ex: { parameters: ['pointer', 'u64', 'pointer', 'usize'], result: 'i32' },
  SSL_get_error: { parameters: ['pointer', 'i32'], result: 'i32' },
  SSL_pending:   { parameters: ['pointer'], result: 'i32' },
  SSL_is_init_finished: { parameters: ['pointer'], result: 'i32' },
  SSL_CTX_set_verify:               { parameters: ['pointer', 'i32', 'pointer'], result: 'void' },
  SSL_set_verify:                   { parameters: ['pointer', 'i32', 'pointer'], result: 'void' },
  SSL_CTX_set_default_verify_paths: { parameters: ['pointer'], result: 'i32' },
  SSL_CTX_load_verify_locations:    { parameters: ['pointer', 'buffer', 'buffer'], result: 'i32' },
  SSL_CTX_get_cert_store:           { parameters: ['pointer'], result: 'pointer' },
  BIO_new_mem_buf:                  { parameters: ['buffer', 'i32'], result: 'pointer' },
  BIO_free:                         { parameters: ['pointer'], result: 'i32' },
  PEM_read_bio_X509:                { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'pointer' },
  X509_STORE_add_cert:              { parameters: ['pointer', 'pointer'], result: 'i32' },
  SSL_CTX_set_ciphersuites: { parameters: ['pointer', 'buffer'], result: 'i32' },
  SSL_CTX_set_max_early_data: { parameters: ['pointer', 'u32'], result: 'i32' },
  SSL_CTX_set_recv_max_early_data: { parameters: ['pointer', 'u32'], result: 'i32' },
  SSL_CTX_set_keylog_callback: { parameters: ['pointer', 'pointer'], result: 'void' },
  // SSL_ctrl(ssl, cmd, larg, parg) — used for SNI (cmd=55)
  // larg is C `long` (64-bit on LP64); parg is a buffer (hostname string for SNI)
  SSL_ctrl:      { parameters: ['pointer', 'i32', 'i64', 'buffer'], result: 'i64' },
  SSL_set1_host: { parameters: ['pointer', 'buffer'], result: 'i32' },
  SSL_new_session_ticket: { parameters: ['pointer'], result: 'i32' },
  SSL_set_max_early_data: { parameters: ['pointer', 'u32'], result: 'i32' },
  SSL_set_recv_max_early_data: { parameters: ['pointer', 'u32'], result: 'i32' },
  SSL_set_quic_tls_early_data_enabled: { parameters: ['pointer', 'i32'], result: 'void' },
  SSL_get1_session: { parameters: ['pointer'], result: 'pointer' },
  SSL_get_current_cipher: { parameters: ['pointer'], result: 'pointer' },
  SSL_CIPHER_get_name: { parameters: ['pointer'], result: 'pointer' },
  SSL_CIPHER_get_version: { parameters: ['pointer'], result: 'pointer' },
  SSL_get_verify_result: { parameters: ['pointer'], result: 'i64' },
  SSL_get_servername: { parameters: ['pointer', 'i32'], result: 'pointer' },
  SSL_get1_peer_certificate: { parameters: ['pointer'], result: 'pointer' },
  SSL_export_keying_material: { parameters: ['pointer', 'buffer', 'usize', 'buffer', 'usize', 'buffer', 'usize', 'i32'], result: 'i32' },
  X509_verify_cert_error_string: { parameters: ['i64'], result: 'pointer' },
  X509_free: { parameters: ['pointer'], result: 'void' },
  i2d_X509: { parameters: ['pointer', 'buffer'], result: 'i32' },
  SSL_set_session: { parameters: ['pointer', 'pointer'], result: 'i32' },
  SSL_SESSION_get_max_early_data: { parameters: ['pointer'], result: 'u32' },
  SSL_SESSION_set_max_early_data: { parameters: ['pointer', 'u32'], result: 'i32' },
  SSL_SESSION_free: { parameters: ['pointer'], result: 'void' },
  i2d_SSL_SESSION: { parameters: ['pointer', 'buffer'], result: 'i32' },
  d2i_SSL_SESSION: { parameters: ['pointer', 'buffer', 'i64'], result: 'pointer' },
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
  SSL_set_alpn_protos: { parameters: ['pointer', 'buffer', 'u32'], result: 'i32' },
} satisfies NativeSymbolMap;

const _sslQuicSymbols = {
  ..._sslSymbols,
  OSSL_QUIC_client_thread_method: { parameters: [], result: 'pointer' },
  OSSL_QUIC_server_method: { parameters: [], result: 'pointer' },
  SSL_write_ex2: { parameters: ['pointer', 'buffer', 'usize', 'u64', 'buffer'], result: 'i32' },
  SSL_handle_events: { parameters: ['pointer'], result: 'i32', async: true },
  SSL_set_blocking_mode: { parameters: ['pointer', 'i32'], result: 'i32' },
  SSL_new_listener: { parameters: ['pointer', 'u64'], result: 'pointer' },
  SSL_listen: { parameters: ['pointer'], result: 'i32' },
  SSL_accept_connection: { parameters: ['pointer', 'u64'], result: 'pointer' },
  SSL_get_accept_connection_queue_len: { parameters: ['pointer'], result: 'usize' },
  SSL_set_default_stream_mode: { parameters: ['pointer', 'u32'], result: 'i32' },
  SSL_set_incoming_stream_policy: { parameters: ['pointer', 'i32', 'u64'], result: 'i32' },
  SSL_new_stream: { parameters: ['pointer', 'u64'], result: 'pointer' },
  SSL_accept_stream: { parameters: ['pointer', 'u64'], result: 'pointer' },
  SSL_get_accept_stream_queue_len: { parameters: ['pointer'], result: 'usize' },
  SSL_get_stream_id: { parameters: ['pointer'], result: 'u64' },
  SSL_stream_conclude: { parameters: ['pointer', 'u64'], result: 'i32' },
} satisfies NativeSymbolMap;

const SSL_CTRL_SET_GROUPS_LIST = 92;

// ---------------------------------------------------------------------------
// Library loading
// ---------------------------------------------------------------------------

type CryptoLibrary = DynamicLibrary<typeof _cryptoSymbols>;
type SslLibrary = DynamicLibrary<typeof _sslSymbols>;
type SslQuicLibrary = DynamicLibrary<typeof _sslQuicSymbols>;

function _tryOpen<TSymbols extends NativeSymbolMap>(paths: string[], symbols: TSymbols): DynamicLibrary<TSymbols> | null {
  for (const p of paths) {
    try { return dlopen(p, symbols); } catch (_) {}
  }
  return null;
}

const _libcrypto = _tryOpen(_cryptoPaths, _cryptoSymbols);
const _libssl    = _tryOpen(_sslPaths, _sslSymbols);
const _libsslQuic = _tryOpen(_sslPaths, _sslQuicSymbols);

/**
 * Whether libcrypto was loaded successfully.
 *
 * Crypto helpers call an internal availability check and throw
 * `OpenSSL not available` when this flag is false. Public modules use this to
 * produce clearer user-facing errors before attempting native calls.
 *
 * ```js
 * import { cryptoAvailable } from 'internal:openssl';
 * console.log(typeof cryptoAvailable);
 * ```
 *
 * @internal
 */
export const cryptoAvailable = _libcrypto !== null;
/**
 * Whether libssl was loaded successfully.
 *
 * TLS helpers call an internal availability check and throw
 * `OpenSSL SSL not available` when this flag is false. Public TLS modules use
 * this to decide whether TLS support can be enabled.
 *
 * ```js
 * import { tlsAvailable } from 'internal:openssl';
 * console.log(typeof tlsAvailable);
 * ```
 *
 * @internal
 */
export const tlsAvailable    = _libssl !== null;

function _requireCrypto(): CryptoLibrary {
  if (_libcrypto === null) throw new Error('OpenSSL not available');
  return _libcrypto;
}

function _requireSsl(): SslLibrary {
  if (_libssl === null) throw new Error('OpenSSL SSL not available');
  return _libssl;
}

function _requireSslQuic(): SslQuicLibrary {
  if (_libsslQuic === null) throw new Error('OpenSSL QUIC SSL not available');
  return _libsslQuic;
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/**
 * Read the most recent OpenSSL error as text.
 *
 * Returns `OpenSSL not available` when libcrypto is missing and `no error` when
 * the OpenSSL error queue is empty. Otherwise it drains one error code from the
 * queue and formats it with `ERR_error_string_n()`. This is a low-level helper;
 * callers should include their own operation context in thrown errors.
 *
 * ```js
 * import { getErrorString } from 'internal:openssl';
 * console.log(typeof getErrorString());
 * ```
 *
 * @returns A human-readable OpenSSL error string.
 * @internal
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
 * Fill an ArrayBuffer with cryptographically random bytes.
 *
 * The function writes exactly `len` bytes starting at the beginning of `buf`
 * using OpenSSL `RAND_bytes()`. `buf` must be at least `len` bytes long. It
 * throws when libcrypto is unavailable or the random generator reports failure.
 *
 * ```js
 * import { randBytes, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const buf = new ArrayBuffer(16);
 *   randBytes(buf, 16);
 *   console.log(new Uint8Array(buf).byteLength);
 * }
 * ```
 *
 * @param buf Destination buffer.
 * @param len Number of bytes to fill.
 * @returns Nothing.
 * @internal
 */
export function randBytes(buf: ArrayBuffer, len: number): void {
  const rc = _requireCrypto().symbols.RAND_bytes(buf, len);
  if (rc !== 1) throw new Error('RAND_bytes failed: ' + getErrorString());
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * Compute a one-shot message digest.
 *
 * Supported algorithms are `sha-1`, `sha-256`, `sha-384`, and `sha-512`.
 * Unsupported algorithm names and unavailable libcrypto throw. The output size
 * is fixed by the selected digest and the returned `Uint8Array` owns its
 * backing buffer.
 *
 * ```js
 * import { digest, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const out = digest('sha-256', new TextEncoder().encode('hello'));
 *   console.log(out.byteLength);
 * }
 * ```
 *
 * @param algorithm Digest algorithm name.
 * @param data Bytes to hash.
 * @returns Digest bytes.
 * @internal
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
 * Compute a one-shot HMAC.
 *
 * Supported digest algorithms match `digest()`. `key` and `data` may be
 * `Uint8Array` or `ArrayBuffer`. Unsupported algorithms, unavailable libcrypto,
 * and OpenSSL HMAC failures throw. The result length matches the digest size.
 *
 * ```js
 * import { hmac, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const mac = hmac('sha-256', new Uint8Array([1]), new Uint8Array([2]));
 *   console.log(mac.byteLength);
 * }
 * ```
 *
 * @param algorithm Digest algorithm name.
 * @param key Secret HMAC key bytes.
 * @param data Message bytes.
 * @returns HMAC bytes.
 * @internal
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
 * Encrypt bytes with a supported AES cipher.
 *
 * Supported algorithms are `aes-128-gcm`, `aes-256-gcm`, `aes-128-cbc`, and
 * `aes-256-cbc`. GCM returns an authentication tag and accepts optional AAD.
 * CBC returns `tag: null` and uses OpenSSL padding. Invalid algorithms,
 * unavailable libcrypto, bad key or IV sizes, and OpenSSL failures throw.
 *
 * ```js
 * import { cipherEncrypt, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const result = cipherEncrypt('aes-256-gcm', new Uint8Array(32), new Uint8Array(12), new Uint8Array([1]));
 *   console.log(result.ciphertext.byteLength);
 * }
 * ```
 *
 * @param algorithm AES cipher name.
 * @param key Raw key bytes of the size required by the algorithm.
 * @param iv Initialization vector or nonce bytes.
 * @param plaintext Plaintext bytes to encrypt.
 * @param aad Optional GCM additional authenticated data.
 * @returns Ciphertext plus optional authentication tag.
 * @internal
 */
export function cipherEncrypt(algorithm: string, key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array | null): CipherResult {
  const normalized = _normalizeCipherAlgorithm(algorithm);
  const cipher = _cipherForAlgorithm(normalized);
  if (_isGCM(normalized)) return _encryptGCM(cipher, key, iv, plaintext, aad ?? null);
  return _encryptCBC(cipher, key, iv, plaintext);
}

/**
 * Decrypt bytes with a supported AES cipher.
 *
 * GCM requires the authentication tag returned by `cipherEncrypt()` and fails
 * when the tag, key, IV, ciphertext, or AAD do not authenticate. CBC ignores
 * `tag` and `aad` and relies on OpenSSL padding validation. Invalid algorithms,
 * unavailable libcrypto, and OpenSSL failures throw.
 *
 * ```js
 * import { cipherEncrypt, cipherDecrypt, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = new Uint8Array(32);
 *   const iv = new Uint8Array(12);
 *   const encrypted = cipherEncrypt('aes-256-gcm', key, iv, new Uint8Array([7]));
 *   console.log(cipherDecrypt('aes-256-gcm', key, iv, encrypted.ciphertext, encrypted.tag).byteLength);
 * }
 * ```
 *
 * @param algorithm AES cipher name.
 * @param key Raw key bytes of the size required by the algorithm.
 * @param iv Initialization vector or nonce bytes.
 * @param ciphertext Ciphertext bytes to decrypt.
 * @param tag Required GCM authentication tag; ignored for CBC.
 * @param aad Optional GCM additional authenticated data.
 * @returns Plaintext bytes.
 * @internal
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
 * Derive key bytes with PBKDF2-HMAC.
 *
 * `hashAlg` supports the same digest names as `digest()`. `iterations` and
 * `keyLength` are passed to OpenSSL as signed integers, so callers should
 * validate user-provided values before calling this internal helper.
 * Unavailable libcrypto, unsupported digests, and OpenSSL failures throw.
 *
 * ```js
 * import { pbkdf2, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = pbkdf2(new TextEncoder().encode('pw'), new Uint8Array([1, 2]), 1000, 'sha-256', 32);
 *   console.log(key.byteLength);
 * }
 * ```
 *
 * @param password Password bytes.
 * @param salt Salt bytes.
 * @param iterations PBKDF2 iteration count.
 * @param hashAlg Digest algorithm used by HMAC.
 * @param keyLength Desired output length in bytes.
 * @returns Derived key bytes.
 * @internal
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
 * Derive key bytes with HKDF as defined by RFC 5869.
 *
 * This helper is implemented in JavaScript using `hmac()` for extract and
 * expand to avoid OpenSSL HKDF API differences. Empty salt is replaced with a
 * zero-filled salt of the digest length. Requests requiring more than 255 HKDF
 * blocks throw. Unavailable libcrypto and unsupported digests also throw.
 *
 * ```js
 * import { hkdf, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = hkdf('sha-256', new Uint8Array([1]), new Uint8Array(), new Uint8Array(), 32);
 *   console.log(key.byteLength);
 * }
 * ```
 *
 * @param hashAlg Digest algorithm used by HMAC.
 * @param ikm Input key material.
 * @param salt Optional salt bytes; empty means HashLen zero bytes.
 * @param info Optional context/application info.
 * @param keyLength Desired output length in bytes.
 * @returns Derived key bytes.
 * @internal
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

/**
 * Return the coordinate byte width for a supported EC curve.
 *
 * Supported curves are `P-256`, `P-384`, and `P-521`. Unsupported names throw.
 * The result is used for JWK coordinate padding and private scalar extraction.
 *
 * ```js
 * import { ecdsaCoordSize } from 'internal:openssl';
 * console.log(ecdsaCoordSize('P-256'));
 * ```
 *
 * @param namedCurve Web Crypto named curve.
 * @returns Coordinate size in bytes.
 * @internal
 */
export function ecdsaCoordSize(namedCurve: string): number {
  const info = _CURVE_INFO[namedCurve];
  if (!info) throw new Error(`Unsupported EC curve: ${namedCurve}`);
  return info.coordSize;
}

/**
 * Generate an EC key pair for a supported named curve.
 *
 * Returns an owning `EVP_PKEY*` wrapper represented as an opaque object. The
 * caller must eventually call `evpPkeyFree()`. Unsupported curves, unavailable
 * libcrypto, allocation failures, and OpenSSL generation failures throw.
 *
 * ```js
 * import { evpPkeyGenerateEc, evpPkeyFree, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param namedCurve `P-256`, `P-384`, or `P-521`.
 * @returns Opaque owning `EVP_PKEY*`.
 * @internal
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

/**
 * Generate a P-256 EC key pair.
 *
 * This compatibility helper delegates to `evpPkeyGenerateEc('P-256')`. The
 * returned key must be freed with `evpPkeyFree()`. It throws for the same
 * OpenSSL availability and generation failures as `evpPkeyGenerateEc()`.
 *
 * ```js
 * import { evpPkeyGenerateEcP256, evpPkeyFree, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEcP256();
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @returns Opaque owning P-256 `EVP_PKEY*`.
 * @deprecated Use `evpPkeyGenerateEc('P-256')` instead.
 * @internal
 */
export function evpPkeyGenerateEcP256(): object { return evpPkeyGenerateEc('P-256'); }

/**
 * Free an owning `EVP_PKEY*`.
 *
 * The pointer must come from one of this module's key generation or import
 * helpers. Calling it with a borrowed, already-freed, or foreign pointer is
 * undefined native behavior.
 *
 * ```js
 * import { evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey Opaque owning `EVP_PKEY*`.
 * @returns Nothing.
 * @internal
 */
export function evpPkeyFree(pkey: object): void {
  _requireCrypto().symbols.EVP_PKEY_free(pkey);
}

/**
 * Increment an EVP_PKEY reference count and return the same native handle.
 *
 * The returned handle is an owning reference and must eventually be released
 * with `evpPkeyFree()`. This is used when cloning CryptoKey wrappers without
 * exporting non-extractable key material.
 *
 * @internal
 */
export function evpPkeyUpRef(pkey: object): object {
  const ok = _requireCrypto().symbols.EVP_PKEY_up_ref(pkey);
  if (ok !== 1) throw new Error('EVP_PKEY_up_ref failed: ' + getErrorString());
  return pkey;
}

// ---------------------------------------------------------------------------
// Ed25519 — raw key import/export and one-shot signing
// ---------------------------------------------------------------------------

let _ed25519Nid: number | undefined;

function _ed25519Type(): number {
  if (_ed25519Nid !== undefined) return _ed25519Nid;
  const lib = _requireCrypto();
  const nid = lib.symbols.OBJ_txt2nid(encodeUtf8('ED25519\0'));
  if (nid === 0) throw new Error('OBJ_txt2nid: ED25519 not recognised');
  _ed25519Nid = nid;
  return nid;
}

function _readSizeT(buf: Uint8Array): number {
  return Number(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(0, true));
}

/**
 * Generate an Ed25519 key pair.
 *
 * Returns an owning `EVP_PKEY*` containing private and public key material.
 * Ed25519 always signs the original message bytes directly; callers must not
 * prehash input. Unavailable libcrypto or OpenSSL generation failures throw.
 *
 * @returns Opaque owning Ed25519 `EVP_PKEY*`.
 * @internal
 */
export function evpPkeyGenerateEd25519(): object {
  const seed = new Uint8Array(32);
  randBytes(seed.buffer as ArrayBuffer, seed.byteLength);
  return evpPkeyImportRawPrivateEd25519(seed);
}

/**
 * Import a 32-byte raw Ed25519 public key.
 *
 * @param publicKey Raw public key bytes.
 * @returns Opaque owning Ed25519 public `EVP_PKEY*`.
 * @internal
 */
export function evpPkeyImportRawPublicEd25519(publicKey: Uint8Array): object {
  if (publicKey.byteLength !== 32) throw new Error(`Ed25519 public key must be 32 bytes (got ${publicKey.byteLength})`);
  const lib = _requireCrypto();
  const pkey = lib.symbols.EVP_PKEY_new_raw_public_key(_ed25519Type(), null, publicKey, publicKey.byteLength);
  if (pkey === null) throw new Error('EVP_PKEY_new_raw_public_key(Ed25519) failed: ' + getErrorString());
  return pkey;
}

/**
 * Import a 32-byte raw Ed25519 private seed.
 *
 * @param seed Raw private seed bytes.
 * @returns Opaque owning Ed25519 private `EVP_PKEY*`.
 * @internal
 */
export function evpPkeyImportRawPrivateEd25519(seed: Uint8Array): object {
  if (seed.byteLength !== 32) throw new Error(`Ed25519 private seed must be 32 bytes (got ${seed.byteLength})`);
  const lib = _requireCrypto();
  const pkey = lib.symbols.EVP_PKEY_new_raw_private_key(_ed25519Type(), null, seed, seed.byteLength);
  if (pkey === null) throw new Error('EVP_PKEY_new_raw_private_key(Ed25519) failed: ' + getErrorString());
  return pkey;
}

/**
 * Export a 32-byte raw Ed25519 public key from an `EVP_PKEY`.
 *
 * @param pkey Ed25519 public or private key.
 * @returns Raw public key bytes.
 * @internal
 */
export function evpPkeyExportRawPublicEd25519(pkey: object): Uint8Array {
  const lib = _requireCrypto();
  const lenBuf = new Uint8Array(8);
  if (lib.symbols.EVP_PKEY_get_raw_public_key(pkey, null, lenBuf) !== 1) {
    throw new Error('EVP_PKEY_get_raw_public_key length failed: ' + getErrorString());
  }
  const len = _readSizeT(lenBuf);
  if (len !== 32) throw new Error(`Ed25519 public key export returned ${len} bytes`);
  const out = new Uint8Array(len);
  const outLenBuf = new Uint8Array(8);
  new DataView(outLenBuf.buffer).setBigUint64(0, BigInt(len), true);
  if (lib.symbols.EVP_PKEY_get_raw_public_key(pkey, out, outLenBuf) !== 1) {
    throw new Error('EVP_PKEY_get_raw_public_key failed: ' + getErrorString());
  }
  return out;
}

/**
 * Export a 32-byte raw Ed25519 private seed from an `EVP_PKEY`.
 *
 * @param pkey Ed25519 private key.
 * @returns Raw private seed bytes.
 * @internal
 */
export function evpPkeyExportRawPrivateEd25519(pkey: object): Uint8Array {
  const lib = _requireCrypto();
  const lenBuf = new Uint8Array(8);
  if (lib.symbols.EVP_PKEY_get_raw_private_key(pkey, null, lenBuf) !== 1) {
    throw new Error('EVP_PKEY_get_raw_private_key length failed: ' + getErrorString());
  }
  const len = _readSizeT(lenBuf);
  if (len !== 32) throw new Error(`Ed25519 private key export returned ${len} bytes`);
  const out = new Uint8Array(len);
  const outLenBuf = new Uint8Array(8);
  new DataView(outLenBuf.buffer).setBigUint64(0, BigInt(len), true);
  if (lib.symbols.EVP_PKEY_get_raw_private_key(pkey, out, outLenBuf) !== 1) {
    throw new Error('EVP_PKEY_get_raw_private_key failed: ' + getErrorString());
  }
  return out;
}

/**
 * Export a public key as DER SubjectPublicKeyInfo with OpenSSL i2d_PUBKEY.
 *
 * This generic helper supports RSA and Ed25519 keys and any other `EVP_PKEY`
 * type OpenSSL can encode. Unavailable libcrypto and OpenSSL failures throw.
 *
 * @param pkey Public or private key with a public component.
 * @returns DER SubjectPublicKeyInfo bytes.
 * @internal
 */
export function evpPkeyExportSpkiDer(pkey: object): Uint8Array {
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
 * Import a public key from DER SubjectPublicKeyInfo with OpenSSL d2i_PUBKEY.
 *
 * @param der DER SubjectPublicKeyInfo bytes.
 * @returns Opaque owning `EVP_PKEY*`.
 * @internal
 */
export function evpPkeyImportSpkiDer(der: Uint8Array): object {
  const lib  = _requireCrypto();
  const pp   = _ptrPtrBuf(der);
  const pkey = lib.symbols.d2i_PUBKEY(null, pp, der.length);
  if (pkey === null) throw new Error('d2i_PUBKEY failed: ' + getErrorString());
  return pkey;
}

/**
 * Sign message bytes with Ed25519 using OpenSSL one-shot EVP APIs.
 *
 * @param pkey Ed25519 private key.
 * @param data Message bytes.
 * @returns 64-byte Ed25519 signature.
 * @internal
 */
export function ed25519Sign(pkey: object, data: Uint8Array): Uint8Array {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_MD_CTX_new();
  if (ctx === null) throw new Error('EVP_MD_CTX_new failed');
  try {
    if (lib.symbols.EVP_DigestSignInit(ctx, null, null, null, pkey) !== 1) {
      throw new Error('EVP_DigestSignInit(Ed25519) failed: ' + getErrorString());
    }
    const lenBuf = new Uint8Array(8);
    if (lib.symbols.EVP_DigestSign(ctx, null, lenBuf, data, data.byteLength) !== 1) {
      throw new Error('EVP_DigestSign length failed: ' + getErrorString());
    }
    const sigLen = _readSizeT(lenBuf);
    const sig = new Uint8Array(sigLen);
    const sigLenBuf = new Uint8Array(8);
    new DataView(sigLenBuf.buffer).setBigUint64(0, BigInt(sigLen), true);
    if (lib.symbols.EVP_DigestSign(ctx, sig, sigLenBuf, data, data.byteLength) !== 1) {
      throw new Error('EVP_DigestSign failed: ' + getErrorString());
    }
    return sig;
  } finally {
    lib.symbols.EVP_MD_CTX_free(ctx);
  }
}

/**
 * Verify an Ed25519 signature over message bytes.
 *
 * @param pkey Ed25519 public key.
 * @param sig Signature bytes.
 * @param data Message bytes.
 * @returns Whether the signature verifies.
 * @internal
 */
export function ed25519Verify(pkey: object, sig: Uint8Array, data: Uint8Array): boolean {
  const lib = _requireCrypto();
  const ctx = lib.symbols.EVP_MD_CTX_new();
  if (ctx === null) throw new Error('EVP_MD_CTX_new failed');
  try {
    if (lib.symbols.EVP_DigestVerifyInit(ctx, null, null, null, pkey) !== 1) {
      throw new Error('EVP_DigestVerifyInit(Ed25519) failed: ' + getErrorString());
    }
    const rc = lib.symbols.EVP_DigestVerify(ctx, sig, sig.byteLength, data, data.byteLength);
    return rc === 1;
  } finally {
    lib.symbols.EVP_MD_CTX_free(ctx);
  }
}

/**
 * Export an EC public key as DER-encoded SPKI.
 *
 * `namedCurve` must match the key's actual curve and must be supported by the
 * built-in SPKI prefix table. The returned bytes are DER SubjectPublicKeyInfo.
 * Unavailable libcrypto, unsupported curves, malformed keys, and OpenSSL point
 * conversion failures throw.
 *
 * ```js
 * const { evpPkeyGenerateEc, evpPkeyExportSpki, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   console.log(evpPkeyExportSpki(key, 'P-256').byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey EC key to export.
 * @param namedCurve Expected curve name.
 * @returns DER SubjectPublicKeyInfo bytes.
 * @internal
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
 *
 * The curve is detected from the supported SPKI header prefixes for `P-256`,
 * `P-384`, and `P-521`. The returned key is owning and must be freed with
 * `evpPkeyFree()`. Unknown headers, invalid point encodings, unavailable
 * libcrypto, and OpenSSL allocation/import failures throw.
 *
 * ```js
 * const { evpPkeyGenerateEc, evpPkeyExportSpki, evpPkeyImportSpki, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   const imported = evpPkeyImportSpki(evpPkeyExportSpki(key, 'P-256'));
 *   console.log(imported.namedCurve);
 *   evpPkeyFree(imported.pkey);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param der DER SubjectPublicKeyInfo bytes.
 * @returns Imported key and detected curve name.
 * @internal
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
 * Sign a precomputed digest with ECDSA.
 *
 * `hash` must already be digest bytes appropriate for the key and caller
 * policy; this helper does not hash input. The returned signature is DER
 * encoded. Unavailable libcrypto, non-EC keys, and OpenSSL signing failures
 * throw.
 *
 * ```js
 * const { digest, ecdsaSign, evpPkeyGenerateEc, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   const sig = ecdsaSign(digest('sha-256', new Uint8Array([1])), key);
 *   console.log(sig.byteLength > 0);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param hash Precomputed digest bytes.
 * @param pkey EC private key.
 * @returns DER-encoded ECDSA signature.
 * @internal
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
 * Verify a DER-encoded ECDSA signature over a precomputed digest.
 *
 * Returns `true` for a valid signature and `false` for an invalid signature.
 * It throws for unavailable libcrypto or when `pkey` is not an EC key.
 *
 * ```js
 * const { digest, ecdsaSign, ecdsaVerify, evpPkeyGenerateEc, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   const hash = digest('sha-256', new Uint8Array([1]));
 *   console.log(ecdsaVerify(hash, ecdsaSign(hash, key), key));
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param hash Precomputed digest bytes.
 * @param derSig DER-encoded ECDSA signature.
 * @param pkey EC public or private key.
 * @returns Whether the signature verifies.
 * @internal
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

function _setRsaOaepLabel(lib: DynamicLibrary<typeof _cryptoSymbols>, ctx: object, label: Uint8Array | null): void {
  if (label === null || label.byteLength === 0) return;
  const ptr = lib.symbols.CRYPTO_malloc(label.byteLength, null, 0);
  if (ptr === null) throw new Error('CRYPTO_malloc(OAEP label) failed');
  try {
    Pointer.copyTo(ptr, label);
    if (lib.symbols.EVP_PKEY_CTX_set0_rsa_oaep_label(ctx, ptr, label.byteLength) <= 0) {
      throw new Error('set0_rsa_oaep_label failed: ' + getErrorString());
    }
  } catch (e) {
    lib.symbols.CRYPTO_free(ptr, null, 0);
    throw e;
  }
}

/**
 * Generate an RSA key pair.
 *
 * Returns an owning `EVP_PKEY*` wrapper that must be freed with
 * `evpPkeyFree()`. `publicExponent` is typically 65537. Unavailable libcrypto,
 * invalid modulus/exponent values, allocation failures, and OpenSSL generation
 * failures throw.
 *
 * ```js
 * import { evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } from 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param modulusBits RSA modulus size in bits.
 * @param publicExponent Public exponent, usually 65537.
 * @returns Opaque owning `EVP_PKEY*`.
 * @internal
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
 * Export an RSA public key as DER-encoded SPKI.
 *
 * This uses OpenSSL `i2d_PUBKEY()` and returns DER SubjectPublicKeyInfo bytes.
 * The helper is intended for RSA keys, although OpenSSL can encode other
 * `EVP_PKEY` types. Unavailable libcrypto and OpenSSL length/write failures
 * throw.
 *
 * ```js
 * const { evpPkeyGenerateRsa, evpPkeyExportSpkiRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   console.log(evpPkeyExportSpkiRsa(key).byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey RSA key to export.
 * @returns DER SubjectPublicKeyInfo bytes.
 * @internal
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
 *
 * The returned key is owning and must be freed with `evpPkeyFree()`. The helper
 * uses `d2i_PUBKEY()` and is intended for RSA SPKI input; unavailable libcrypto
 * and OpenSSL parse failures throw.
 *
 * ```js
 * const { evpPkeyGenerateRsa, evpPkeyExportSpkiRsa, evpPkeyImportSpkiRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   const imported = evpPkeyImportSpkiRsa(evpPkeyExportSpkiRsa(key));
 *   evpPkeyFree(imported);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param der DER SubjectPublicKeyInfo bytes.
 * @returns Opaque owning `EVP_PKEY*`.
 * @internal
 */
export function evpPkeyImportSpkiRsa(der: Uint8Array): object {
  const lib  = _requireCrypto();
  const pp   = _ptrPtrBuf(der);
  const pkey = lib.symbols.d2i_PUBKEY(null, pp, der.length);
  if (pkey === null) throw new Error('d2i_PUBKEY failed: ' + getErrorString());
  return pkey;
}

/**
 * Encrypt bytes with RSA-OAEP.
 *
 * `hashAlg` is used for both OAEP and MGF1. A non-empty `label` is bound into
 * the OAEP operation and must match during decryption. Unavailable libcrypto,
 * unsupported hashes, invalid keys,
 * oversize plaintext, and OpenSSL failures throw.
 *
 * ```js
 * const { rsaOaepEncrypt, evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   console.log(rsaOaepEncrypt(key, 'sha-256', null, new Uint8Array([1])).byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey RSA public or private key.
 * @param hashAlg Digest algorithm for OAEP and MGF1.
 * @param label Optional OAEP label.
 * @param data Plaintext bytes.
 * @returns Ciphertext bytes.
 * @internal
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
    _setRsaOaepLabel(lib, ctx, label);

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
 * Decrypt bytes with RSA-OAEP.
 *
 * `hashAlg` is used for both OAEP and MGF1. A non-empty `label` is bound into
 * the OAEP operation and must match the encryption label.
 * Wrong keys, wrong ciphertext, padding/authentication failures, unavailable
 * libcrypto, and OpenSSL failures throw.
 *
 * ```js
 * const { rsaOaepEncrypt, rsaOaepDecrypt, evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   const ciphertext = rsaOaepEncrypt(key, 'sha-256', null, new Uint8Array([1]));
 *   console.log(rsaOaepDecrypt(key, 'sha-256', null, ciphertext)[0]);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey RSA private key.
 * @param hashAlg Digest algorithm for OAEP and MGF1.
 * @param label Optional OAEP label.
 * @param data Ciphertext bytes.
 * @returns Plaintext bytes.
 * @internal
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
    _setRsaOaepLabel(lib, ctx, label);

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
 * Sign data with RSA-PSS.
 *
 * The helper hashes `data` with `hashAlg` before signing the digest.
 * `saltLength === -1` uses the digest length; other values are passed through
 * to OpenSSL. Unavailable libcrypto, unsupported digests, invalid keys, and
 * OpenSSL signing failures throw.
 *
 * ```js
 * const { rsaPssSign, evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   console.log(rsaPssSign(key, 'sha-256', -1, new Uint8Array([1])).byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey RSA private key.
 * @param hashAlg Digest algorithm used before signing.
 * @param saltLength PSS salt length; `-1` means digest length.
 * @param data Message bytes to hash and sign.
 * @returns Signature bytes.
 * @internal
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
 * Verify an RSA-PSS signature.
 *
 * The helper hashes `data` with `hashAlg` before verification and lets OpenSSL
 * infer the salt length from the signature. It returns `false` for invalid
 * signatures and throws for unavailable libcrypto, unsupported digests, invalid
 * keys, and OpenSSL setup failures.
 *
 * ```js
 * const { rsaPssSign, rsaPssVerify, evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   const data = new Uint8Array([1]);
 *   console.log(rsaPssVerify(key, 'sha-256', rsaPssSign(key, 'sha-256', -1, data), data));
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey RSA public or private key.
 * @param hashAlg Digest algorithm used before verification.
 * @param sig Signature bytes.
 * @param data Message bytes to hash and verify.
 * @returns Whether the signature verifies.
 * @internal
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
 * Sign data with RSASSA-PKCS1-v1_5.
 *
 * The helper hashes `data` with `hashAlg` before signing the digest.
 * Unavailable libcrypto, unsupported digests, invalid keys, and OpenSSL
 * signing failures throw.
 *
 * ```js
 * const { rsaPkcs1Sign, evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   console.log(rsaPkcs1Sign(key, 'sha-256', new Uint8Array([1])).byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey RSA private key.
 * @param hashAlg Digest algorithm used before signing.
 * @param data Message bytes to hash and sign.
 * @returns Signature bytes.
 * @internal
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
 * Verify an RSASSA-PKCS1-v1_5 signature.
 *
 * The helper hashes `data` with `hashAlg` before verification. It returns
 * `false` for invalid signatures and throws for unavailable libcrypto,
 * unsupported digests, invalid keys, and OpenSSL setup failures.
 *
 * ```js
 * const { rsaPkcs1Sign, rsaPkcs1Verify, evpPkeyGenerateRsa, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateRsa(2048, 65537);
 *   const data = new Uint8Array([1]);
 *   console.log(rsaPkcs1Verify(key, 'sha-256', rsaPkcs1Sign(key, 'sha-256', data), data));
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey RSA public or private key.
 * @param hashAlg Digest algorithm used before verification.
 * @param sig Signature bytes.
 * @param data Message bytes to hash and verify.
 * @returns Whether the signature verifies.
 * @internal
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
 * Import an RSA key from raw big-endian component byte arrays.
 *
 * Provide `n` and `e` for a public key. Include `d` and optionally CRT
 * components `p`, `q`, `dp`, `dq`, and `qi` for a private key. OpenSSL takes
 * ownership of constructed BIGNUMs; the returned `EVP_PKEY*` is owning and must
 * be freed with `evpPkeyFree()`. Missing required components, unavailable
 * libcrypto, allocation failures, and OpenSSL import failures throw.
 *
 * ```js
 * import { rsaImportComponents } from 'internal:openssl';
 * console.log(typeof rsaImportComponents);
 * ```
 *
 * @param components RSA component byte arrays.
 * @returns Opaque owning `EVP_PKEY*`.
 * @internal
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
 * Extract public EC coordinates from an `EVP_PKEY`.
 *
 * The key must be on a supported named curve. The helper reads the uncompressed
 * point, removes the `0x04` prefix, and returns fixed-width X and Y arrays.
 * Unsupported curves, unavailable libcrypto, non-EC keys, and OpenSSL point
 * conversion failures throw.
 *
 * ```js
 * const { ecPublicKeyCoords, evpPkeyGenerateEc, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   console.log(ecPublicKeyCoords(key, 'P-256').x.byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey EC key.
 * @param namedCurve Expected curve name.
 * @returns Fixed-width X and Y coordinate bytes.
 * @internal
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
 * Import an EC key from raw JWK coordinate bytes.
 *
 * `x` and `y` are required public coordinates. `d` is optional and creates a
 * private key when supplied. All coordinates must be big-endian and padded to
 * the curve coordinate size. Unsupported curves, invalid coordinate lengths,
 * unavailable libcrypto, and OpenSSL import failures throw.
 *
 * ```js
 * const { evpPkeyGenerateEc, ecPublicKeyCoords, evpPkeyImportEcJwk, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const source = evpPkeyGenerateEc('P-256');
 *   const { x, y } = ecPublicKeyCoords(source, 'P-256');
 *   const imported = evpPkeyImportEcJwk('P-256', x, y);
 *   evpPkeyFree(imported);
 *   evpPkeyFree(source);
 * }
 * ```
 *
 * @param namedCurve `P-256`, `P-384`, or `P-521`.
 * @param x Public X coordinate.
 * @param y Public Y coordinate.
 * @param d Optional private scalar.
 * @returns Opaque owning `EVP_PKEY*`.
 * @internal
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
 * Export a private key as unencrypted PKCS8 DER.
 *
 * Works for EC and RSA private keys supported by OpenSSL. The returned bytes are
 * a PKCS8 `PrivateKeyInfo` structure without encryption. Unavailable libcrypto,
 * public-only keys, and OpenSSL conversion failures throw.
 *
 * ```js
 * const { evpPkeyGenerateEc, evpPkeyExportPkcs8, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   console.log(evpPkeyExportPkcs8(key).byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey EC or RSA private key.
 * @returns Unencrypted PKCS8 DER bytes.
 * @internal
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
 * Import a private key from unencrypted PKCS8 DER.
 *
 * The returned key is owning and must be freed with `evpPkeyFree()`. Works for
 * EC and RSA private keys supported by OpenSSL. Encrypted PKCS8, malformed DER,
 * unavailable libcrypto, and OpenSSL conversion failures throw.
 *
 * ```js
 * const { evpPkeyGenerateEc, evpPkeyExportPkcs8, evpPkeyImportPkcs8, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   const imported = evpPkeyImportPkcs8(evpPkeyExportPkcs8(key));
 *   evpPkeyFree(imported);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param der Unencrypted PKCS8 `PrivateKeyInfo` bytes.
 * @returns Opaque owning `EVP_PKEY*`.
 * @internal
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
 * Derive an ECDH shared secret.
 *
 * `privateKey` must contain a private EC key and `publicKey` must be a peer EC
 * public key on the same curve. The returned bytes are the raw shared secret
 * produced by OpenSSL. Unavailable libcrypto, mismatched curves, invalid keys,
 * and OpenSSL derive failures throw.
 *
 * ```js
 * const { evpPkeyGenerateEc, evpPkeyDeriveEcdh, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const a = evpPkeyGenerateEc('P-256');
 *   const b = evpPkeyGenerateEc('P-256');
 *   console.log(evpPkeyDeriveEcdh(a, b).byteLength);
 *   evpPkeyFree(b);
 *   evpPkeyFree(a);
 * }
 * ```
 *
 * @param privateKey Local EC private key.
 * @param publicKey Peer EC public key.
 * @returns Raw ECDH shared secret bytes.
 * @internal
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
 * Extract the private EC scalar as fixed-width bytes.
 *
 * The result is big-endian and left-padded with zeroes to `coordSize`. The key
 * must be an EC private key. Public-only keys, unavailable libcrypto, and
 * OpenSSL BIGNUM conversion failures throw.
 *
 * ```js
 * const { ecPrivateKeyD, ecdsaCoordSize, evpPkeyGenerateEc, evpPkeyFree, cryptoAvailable } =
 *   import 'internal:openssl';
 * if (cryptoAvailable) {
 *   const key = evpPkeyGenerateEc('P-256');
 *   console.log(ecPrivateKeyD(key, ecdsaCoordSize('P-256')).byteLength);
 *   evpPkeyFree(key);
 * }
 * ```
 *
 * @param pkey EC private key.
 * @param coordSize Expected coordinate width in bytes.
 * @returns Zero-padded private scalar bytes.
 * @internal
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

/**
 * Create a client TLS context.
 *
 * The returned `SSL_CTX*` is owning and must be freed with `sslCtxFree()`.
 * It is configured with OpenSSL's generic client TLS method. Unavailable
 * libssl and OpenSSL allocation failures throw.
 *
 * ```js
 * import { sslCtxNewClient, sslCtxFree, tlsAvailable } from 'internal:openssl';
 * if (tlsAvailable) {
 *   const ctx = sslCtxNewClient();
 *   sslCtxFree(ctx);
 * }
 * ```
 *
 * @returns Opaque owning `SSL_CTX*`.
 * @internal
 */
export function sslCtxNewClient(): object {
  const lib = _requireSsl();
  const method = lib.symbols.TLS_client_method();
  const ctx = lib.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new failed: ' + getErrorString());
  return ctx;
}

/**
 * Create a server TLS context.
 *
 * The returned `SSL_CTX*` is owning and must be freed with `sslCtxFree()`.
 * Callers normally load certificates with `sslCtxLoadCertKey()` before use.
 * Unavailable libssl and OpenSSL allocation failures throw.
 *
 * ```js
 * import { sslCtxNewServer, sslCtxFree, tlsAvailable } from 'internal:openssl';
 * if (tlsAvailable) {
 *   const ctx = sslCtxNewServer();
 *   sslCtxFree(ctx);
 * }
 * ```
 *
 * @returns Opaque owning `SSL_CTX*`.
 * @internal
 */
export function sslCtxNewServer(): object {
  const lib = _requireSsl();
  const method = lib.symbols.TLS_server_method();
  const ctx = lib.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new failed: ' + getErrorString());
  return ctx;
}

/**
 * Create a client QUIC context using OpenSSL's thread-assisted QUIC method.
 *
 * The context is owning and must be freed with `sslCtxFree()`. OpenSSL requires
 * ALPN for QUIC; callers should configure protocols before connecting.
 *
 * @returns Opaque owning `SSL_CTX*`.
 * @internal
 */
export function sslCtxNewQuicClient(): object {
  const lib = _requireSslQuic();
  const method = lib.symbols.OSSL_QUIC_client_thread_method();
  const ctx = lib.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new(OSSL_QUIC_client_thread_method) failed: ' + getErrorString());
  return ctx;
}

/**
 * Create a server QUIC context using OpenSSL's QUIC listener method.
 *
 * The context is owning and must be freed with `sslCtxFree()`. Load a
 * certificate/key pair and install a server ALPN callback before listening.
 *
 * @returns Opaque owning `SSL_CTX*`.
 * @internal
 */
export function sslCtxNewQuicServer(): object {
  const lib = _requireSslQuic();
  const method = lib.symbols.OSSL_QUIC_server_method();
  const ctx = lib.symbols.SSL_CTX_new(method);
  if (ctx === null) throw new Error('SSL_CTX_new(OSSL_QUIC_server_method) failed: ' + getErrorString());
  return ctx;
}

/**
 * Load a PEM certificate and private key into an existing SSL context.
 *
 * @param ctx SSL_CTX* to configure.
 * @param certPath Path to PEM certificate.
 * @param keyPath Path to PEM private key.
 * @returns Nothing.
 * @internal
 */
export function sslCtxUseCertKey(ctx: object, certPath: string, keyPath: string): void {
  const lib = _requireSsl();
  const certBuf = encodeUtf8(certPath + '\0');
  if (lib.symbols.SSL_CTX_use_certificate_file(ctx, certBuf, 1) !== 1) {
    throw new Error(`TLS: failed to load certificate "${certPath}": ` + getErrorString());
  }
  const keyBuf = encodeUtf8(keyPath + '\0');
  if (lib.symbols.SSL_CTX_use_PrivateKey_file(ctx, keyBuf, 1) !== 1) {
    throw new Error(`TLS: failed to load private key "${keyPath}": ` + getErrorString());
  }
  if (lib.symbols.SSL_CTX_check_private_key(ctx) !== 1) {
    throw new Error(`TLS: certificate "${certPath}" and key "${keyPath}" do not match: ` + getErrorString());
  }
}

/**
 * Create a server SSL context and load a PEM certificate + private key.
 * Both paths must point to PEM-encoded files (SSL_FILETYPE_PEM = 1).
 * Throws if the context cannot be created or either file fails to load.
 *
 * ```js
 * import { sslCtxLoadCertKey } from 'internal:openssl';
 * console.log(typeof sslCtxLoadCertKey);
 * ```
 *
 * @param {string} certPath — path to PEM certificate file
 * @param {string} keyPath  — path to PEM private key file
 * @returns {object} SSL_CTX* configured with the cert/key pair
 * @internal
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

/**
 * Free an owning TLS context.
 *
 * The context must have been returned by this module. Any ALPN server callback
 * object returned by `sslCtxSetAlpnServerProtos()` should be retained and
 * closed by the owner before or alongside freeing the context.
 *
 * ```js
 * import { sslCtxNewClient, sslCtxFree, tlsAvailable } from 'internal:openssl';
 * if (tlsAvailable) {
 *   const ctx = sslCtxNewClient();
 *   sslCtxFree(ctx);
 * }
 * ```
 *
 * @param ctx Opaque owning `SSL_CTX*`.
 * @returns Nothing.
 * @internal
 */
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
 * ```js
 * const { sslCtxNewClient, sslCtxSetAlpnProtos, sslCtxFree, tlsAvailable } =
 *   import 'internal:openssl';
 * if (tlsAvailable) {
 *   const ctx = sslCtxNewClient();
 *   sslCtxSetAlpnProtos(ctx, ['http/1.1']);
 *   sslCtxFree(ctx);
 * }
 * ```
 *
 * @param ctx SSL_CTX* from `sslCtxNewClient()` or `sslCtxLoadCertKey()`.
 * @param protocols Ordered preference list, for example `['http/1.1']`.
 * @returns Nothing.
 * @internal
 */
export function sslCtxSetAlpnProtos(ctx: object, protocols: string[]): void {
  const lib = _requireSsl();
  const buf = _encodeAlpnProtocols(protocols);
  const rc = lib.symbols.SSL_CTX_set_alpn_protos(ctx, buf, buf.length);
  if (rc !== 0) throw new Error('SSL_CTX_set_alpn_protos failed: ' + getErrorString());
}

/**
 * Restrict TLS 1.3 cipher suites on an `SSL_CTX`.
 *
 * OpenSSL expects standard TLS 1.3 suite names separated by colons, for example
 * `TLS_CHACHA20_POLY1305_SHA256`. QUIC uses TLS 1.3 exclusively, so callers
 * should validate the suite list before it reaches this low-level helper.
 *
 * @param ctx SSL_CTX* to configure.
 * @param cipherSuites Ordered TLS 1.3 cipher-suite names.
 * @returns Nothing.
 * @internal
 */
export function sslCtxSetCipherSuites(ctx: object, cipherSuites: readonly string[]): void {
  if (cipherSuites.length === 0) throw new TypeError('TLS cipher suite list must not be empty');
  const lib = _requireSsl();
  const buf = encodeUtf8(cipherSuites.join(':') + '\0');
  const rc = lib.symbols.SSL_CTX_set_ciphersuites(ctx, buf);
  if (rc !== 1) throw new Error('SSL_CTX_set_ciphersuites failed: ' + getErrorString());
}

/**
 * Restrict TLS supported groups on an `SSL_CTX`.
 *
 * OpenSSL expects colon-separated group names such as `P-256` or `X25519`.
 *
 * @param ctx SSL_CTX* to configure.
 * @param groups Ordered TLS group names.
 * @returns Nothing.
 * @internal
 */
export function sslCtxSetGroups(ctx: object, groups: readonly string[]): void {
  if (groups.length === 0) throw new TypeError('TLS group list must not be empty');
  const lib = _requireSsl();
  const buf = encodeUtf8(groups.join(':') + '\0');
  const rc = lib.symbols.SSL_CTX_ctrl(ctx, SSL_CTRL_SET_GROUPS_LIST, 0n, buf);
  if (rc !== 1n && rc !== 1) throw new Error('SSL_CTX_set1_groups_list failed: ' + getErrorString());
}

/**
 * Set the ALPN protocol list on a single SSL connection object.
 *
 * This is used by ngtcp2's OpenSSL crypto backend, which configures QUIC TLS
 * on an `SSL*` rather than on OpenSSL's high-level QUIC transport object.
 *
 * @param ssl SSL* connection object.
 * @param protocols Ordered ALPN preference list.
 * @returns Nothing.
 * @internal
 */
export function sslSetAlpnProtos(ssl: object, protocols: string[]): void {
  const lib = _requireSsl();
  const buf = _encodeAlpnProtocols(protocols);
  const rc = lib.symbols.SSL_set_alpn_protos(ssl, buf, buf.length);
  if (rc !== 0) throw new Error('SSL_set_alpn_protos failed: ' + getErrorString());
}

/**
 * Query the negotiated ALPN protocol for a TLS connection.
 *
 * Returns `null` when no protocol has been negotiated, ALPN was not used, or
 * the handshake has not completed. The returned string is copied from OpenSSL's
 * borrowed protocol bytes.
 *
 * ```js
 * import { sslGetAlpnSelected } from 'internal:openssl';
 * console.log(typeof sslGetAlpnSelected);
 * ```
 *
 * @param ssl Opaque `SSL*`.
 * @returns Negotiated protocol name, or `null`.
 * @internal
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

/** Return the current TLS cipher name and protocol version for an `SSL*`. */
export function sslGetCurrentCipherInfo(ssl: object): { cipher: string | null; cipherVersion: string | null } {
  const lib = _requireSsl();
  const cipher = lib.symbols.SSL_get_current_cipher(ssl) as ArrayBuffer | null;
  if (cipher === null) return { cipher: null, cipherVersion: null };
  return {
    cipher: readCStr(lib.symbols.SSL_CIPHER_get_name(cipher) as ArrayBuffer | null) || null,
    cipherVersion: readCStr(lib.symbols.SSL_CIPHER_get_version(cipher) as ArrayBuffer | null) || null,
  };
}

/** Return OpenSSL peer verification status for an `SSL*`. */
export function sslGetVerifyResult(ssl: object): { code: number; reason: string | null } {
  const lib = _requireSsl();
  const code = Number(lib.symbols.SSL_get_verify_result(ssl) as number);
  const reason = code === 0
    ? null
    : readCStr(lib.symbols.X509_verify_cert_error_string(code) as ArrayBuffer | null) || null;
  return { code, reason };
}

/** Return the peer certificate as DER bytes, or `null` when absent. */
export function sslGetPeerCertificate(ssl: object): Uint8Array | null {
  const lib = _requireSsl();
  const cert = lib.symbols.SSL_get1_peer_certificate(ssl) as ArrayBuffer | null;
  if (cert === null) return null;
  try {
    const len = lib.symbols.i2d_X509(cert, null);
    if (len <= 0) return null;
    const der = new Uint8Array(len);
    const pp = _ptrPtrBuf(der);
    const written = lib.symbols.i2d_X509(cert, pp);
    if (written <= 0) return null;
    return der;
  } finally {
    lib.symbols.X509_free(cert);
  }
}

/** Export RFC 5705 TLS keying material for an `SSL*`. */
export function sslExportKeyingMaterial(ssl: object, label: string, context: Uint8Array, length: number): ArrayBuffer {
  const lib = _requireSsl();
  if (!Number.isInteger(length) || length < 0) throw new RangeError('TLS exporter length must be a non-negative integer');
  const out = new Uint8Array(length);
  const labelBytes = encodeUtf8(label);
  const rc = lib.symbols.SSL_export_keying_material(
    ssl,
    out,
    out.byteLength,
    labelBytes,
    labelBytes.byteLength,
    context,
    context.byteLength,
    1,
  ) as number;
  if (rc !== 1) throw new Error('SSL_export_keying_material failed: ' + getErrorString());
  return out.buffer;
}

/** Return the SNI server name associated with an `SSL*`, when available. */
export function sslGetServername(ssl: object): string | null {
  const ptr = _requireSsl().symbols.SSL_get_servername(ssl, 0) as ArrayBuffer | null;
  return readCStr(ptr) || null;
}

const SSL_CTRL_SET_TLSEXT_SERVERNAME_CB = 53;
const SSL_TLSEXT_ERR_OK = 0;
const SSL_TLSEXT_ERR_NOACK = 3;

function _normalizeServername(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1).toLowerCase() : name.toLowerCase();
}

function _matchServername(name: string, entries: ReadonlyMap<string, object>): object | null {
  const normalized = _normalizeServername(name);
  const exact = entries.get(normalized);
  if (exact !== undefined) return exact;
  for (const [pattern, ctx] of entries) {
    if (!pattern.startsWith('*.')) continue;
    const suffix = pattern.slice(1);
    if (!normalized.endsWith(suffix)) continue;
    const prefix = normalized.slice(0, normalized.length - suffix.length);
    if (prefix.length > 0 && !prefix.includes('.')) return ctx;
  }
  return null;
}

/** Install an OpenSSL SNI callback that swaps SSL_CTX based on server name. */
export function sslCtxSetServernameCallback(ctx: object, entries: ReadonlyMap<string, object>): object {
  const lib = _requireSsl();
  const normalizedEntries = new Map<string, object>();
  for (const [name, entryCtx] of entries) normalizedEntries.set(_normalizeServername(name), entryCtx);

  const cb = new FfiCallback(
    {
      parameters: ['pointer', 'pointer', 'pointer'],
      result: 'i32',
    },
    (ssl: ArrayBuffer): number => {
      const servername = sslGetServername(ssl);
      if (servername === null) return SSL_TLSEXT_ERR_NOACK;
      const selected = _matchServername(servername, normalizedEntries);
      if (selected === null) return SSL_TLSEXT_ERR_NOACK;
      lib.symbols.SSL_set_SSL_CTX(ssl, selected);
      return SSL_TLSEXT_ERR_OK;
    },
  );

  const rc = lib.symbols.SSL_CTX_callback_ctrl(ctx, SSL_CTRL_SET_TLSEXT_SERVERNAME_CB, cb.pointer);
  if (rc !== 1n && rc !== 1) {
    cb.close();
    throw new Error('SSL_CTX_set_tlsext_servername_callback failed: ' + getErrorString());
  }
  return cb;
}

/**
 * Configure a TLS context to use OpenSSL's default trust paths.
 *
 * This is normally called for client contexts that verify peers. Unavailable
 * libssl and OpenSSL trust-path setup failures throw.
 *
 * ```js
 * const { sslCtxNewClient, sslCtxSetDefaultVerifyPaths, sslCtxFree, tlsAvailable } =
 *   import 'internal:openssl';
 * if (tlsAvailable) {
 *   const ctx = sslCtxNewClient();
 *   sslCtxSetDefaultVerifyPaths(ctx);
 *   sslCtxFree(ctx);
 * }
 * ```
 *
 * @param ctx SSL_CTX* to configure.
 * @returns Nothing.
 * @internal
 */
export function sslCtxSetDefaultVerifyPaths(ctx: object): void {
  const rc = _requireSsl().symbols.SSL_CTX_set_default_verify_paths(ctx);
  if (rc !== 1) throw new Error('SSL_CTX_set_default_verify_paths failed: ' + getErrorString());
}

/**
 * Load CA certificate(s) for peer verification.
 *
 * ```js
 * import { sslCtxLoadVerifyLocations } from 'internal:openssl';
 * console.log(typeof sslCtxLoadVerifyLocations);
 * ```
 *
 * @param {object} ctx — SSL_CTX* pointer
 * @param {string|null} caFile — path to a PEM file, or null
 * @param {string|null} caPath — path to a directory of PEM files, or null
 * @returns Nothing.
 * @internal
 */
export function sslCtxLoadVerifyLocations(ctx: object, caFile: string | null, caPath: string | null): void {
  const lib = _requireSsl();
  const fileBuf = caFile ? encodeUtf8(caFile + '\0') : null;
  const pathBuf = caPath ? encodeUtf8(caPath + '\0') : null;
  const rc = lib.symbols.SSL_CTX_load_verify_locations(ctx, fileBuf, pathBuf);
  if (rc !== 1) throw new Error('SSL_CTX_load_verify_locations failed: ' + getErrorString());
}

/** Add PEM-encoded CA certificates to an SSL_CTX trust store. */
export function sslCtxAddCaCertificates(ctx: object, pem: string | Uint8Array | Array<string | Uint8Array>): void {
  const lib = _requireSsl();
  const store = lib.symbols.SSL_CTX_get_cert_store(ctx) as ArrayBuffer | null;
  if (store === null) throw new Error('SSL_CTX_get_cert_store failed: ' + getErrorString());

  const entries = Array.isArray(pem) ? pem : [pem];
  if (entries.length === 0) throw new TypeError('QUIC ca.pem must include at least one PEM certificate');

  for (const entry of entries) {
    const bytes = typeof entry === 'string' ? encodeUtf8(entry) : entry;
    if (bytes.byteLength === 0) throw new TypeError('QUIC ca.pem entries must not be empty');
    const bio = lib.symbols.BIO_new_mem_buf(bytes, bytes.byteLength) as ArrayBuffer | null;
    if (bio === null) throw new Error('BIO_new_mem_buf failed: ' + getErrorString());
    try {
      let added = 0;
      while (true) {
        const cert = lib.symbols.PEM_read_bio_X509(bio, null, null, null) as ArrayBuffer | null;
        if (cert === null) break;
        try {
          const rc = lib.symbols.X509_STORE_add_cert(store, cert) as number;
          if (rc !== 1) throw new Error('X509_STORE_add_cert failed: ' + getErrorString());
          added++;
        } finally {
          lib.symbols.X509_free(cert);
        }
      }
      if (added === 0) throw new Error('PEM_read_bio_X509 failed to read a CA certificate: ' + getErrorString());
    } finally {
      lib.symbols.BIO_free(bio);
    }
  }
}

/**
 * Set TLS peer verification mode on a context.
 *
 * `mode` is passed directly to `SSL_CTX_set_verify()`, commonly
 * `SSL_VERIFY_PEER` for clients that require certificate verification. The
 * verify callback is always null.
 *
 * ```js
 * import { SSL_VERIFY_PEER, sslCtxSetVerify } from 'internal:openssl';
 * console.log(SSL_VERIFY_PEER, typeof sslCtxSetVerify);
 * ```
 *
 * @param ctx SSL_CTX* to configure.
 * @param mode OpenSSL verification bitmask.
 * @returns Nothing.
 * @internal
 */
export function sslCtxSetVerify(ctx: object, mode: number): void {
  _requireSsl().symbols.SSL_CTX_set_verify(ctx, mode, null);
}

/** Set TLS verification mode with a callback that records but allows failures. */
export function sslCtxSetPermissiveVerify(ctx: object, mode: number): object {
  const cb = new FfiCallback(
    { parameters: ['i32', 'pointer'], result: 'i32' },
    () => 1,
  );
  _requireSsl().symbols.SSL_CTX_set_verify(ctx, mode, cb.pointer);
  return cb;
}

/** Set TLS verification mode on a single SSL connection. */
export function sslSetVerify(ssl: object, mode: number): void {
  _requireSsl().symbols.SSL_set_verify(ssl, mode, null);
}

function readCStr(ptr: ArrayBuffer | null): string {
  if (ptr === null) return '';
  const bytes: number[] = [];
  for (let offset = 0; ; offset++) {
    const byte = Pointer.readU8(ptr, offset);
    if (byte === 0) break;
    bytes.push(byte);
  }
  return decodeUtf8(new Uint8Array(bytes));
}

export function sslCtxSetKeylogCallback(ctx: object, onLine: (line: string) => void): object {
  const cb = new FfiCallback(
    { parameters: ['pointer', 'pointer'], result: 'void' },
    (_ssl: ArrayBuffer | null, line: ArrayBuffer | null) => {
      onLine(readCStr(line));
    },
  );
  _requireSsl().symbols.SSL_CTX_set_keylog_callback(ctx, cb.pointer);
  return cb;
}

// ---------------------------------------------------------------------------
// SSL — connection management
// ---------------------------------------------------------------------------

/**
 * Create an SSL connection object from a context.
 *
 * The returned `SSL*` is owning and must be freed with `sslFree()`. Callers
 * usually bind it to a descriptor with `sslSetFd()` before handshaking.
 * Unavailable libssl and OpenSSL allocation failures throw.
 *
 * ```js
 * const { sslCtxNewClient, sslNew, sslFree, sslCtxFree, tlsAvailable } =
 *   import 'internal:openssl';
 * if (tlsAvailable) {
 *   const ctx = sslCtxNewClient();
 *   const ssl = sslNew(ctx);
 *   sslFree(ssl);
 *   sslCtxFree(ctx);
 * }
 * ```
 *
 * @param ctx SSL_CTX* used to create the connection.
 * @returns Opaque owning `SSL*`.
 * @internal
 */
export function sslNew(ctx: object): object {
  const ssl = _requireSsl().symbols.SSL_new(ctx);
  if (ssl === null) throw new Error('SSL_new failed: ' + getErrorString());
  return ssl;
}

/**
 * Put an `SSL*` into client handshake mode.
 *
 * @param ssl SSL* connection object.
 * @returns Nothing.
 * @internal
 */
export function sslSetConnectState(ssl: object): void {
  _requireSsl().symbols.SSL_set_connect_state(ssl);
}

/**
 * Put an `SSL*` into server handshake mode.
 *
 * @param ssl SSL* connection object.
 * @returns Nothing.
 * @internal
 */
export function sslSetAcceptState(ssl: object): void {
  _requireSsl().symbols.SSL_set_accept_state(ssl);
}

export function sslNewSessionTicket(ssl: object): void {
  if (_requireSsl().symbols.SSL_new_session_ticket(ssl) !== 1) {
    throw new Error('SSL_new_session_ticket failed: ' + getErrorString());
  }
}

export function sslSetMaxEarlyData(ssl: object, maxBytes: number): void {
  const max = Math.max(0, Math.min(0xffffffff, Math.floor(maxBytes)));
  if (_requireSsl().symbols.SSL_set_max_early_data(ssl, max) !== 1) {
    throw new Error('SSL_set_max_early_data failed: ' + getErrorString());
  }
}

export function sslSetRecvMaxEarlyData(ssl: object, maxBytes: number): void {
  const max = Math.max(0, Math.min(0xffffffff, Math.floor(maxBytes)));
  if (_requireSsl().symbols.SSL_set_recv_max_early_data(ssl, max) !== 1) {
    throw new Error('SSL_set_recv_max_early_data failed: ' + getErrorString());
  }
}

export function sslCtxSetMaxEarlyData(ctx: object, maxBytes: number): void {
  const max = Math.max(0, Math.min(0xffffffff, Math.floor(maxBytes)));
  if (_requireSsl().symbols.SSL_CTX_set_max_early_data(ctx, max) !== 1) {
    throw new Error('SSL_CTX_set_max_early_data failed: ' + getErrorString());
  }
}

export function sslCtxSetRecvMaxEarlyData(ctx: object, maxBytes: number): void {
  const max = Math.max(0, Math.min(0xffffffff, Math.floor(maxBytes)));
  if (_requireSsl().symbols.SSL_CTX_set_recv_max_early_data(ctx, max) !== 1) {
    throw new Error('SSL_CTX_set_recv_max_early_data failed: ' + getErrorString());
  }
}

export function sslEnableQuicEarlyData(ssl: object, enabled: boolean): void {
  _requireSsl().symbols.SSL_set_quic_tls_early_data_enabled(ssl, enabled ? 1 : 0);
}

export function sslExportSession(ssl: object): Uint8Array | null {
  const lib = _requireSsl();
  const session = lib.symbols.SSL_get1_session(ssl);
  if (session === null) return null;
  try {
    const len = lib.symbols.i2d_SSL_SESSION(session, null);
    if (len <= 0) return null;
    const der = new Uint8Array(len);
    const pp = _ptrPtrBuf(der);
    const written = lib.symbols.i2d_SSL_SESSION(session, pp);
    if (written <= 0) return null;
    return der;
  } finally {
    lib.symbols.SSL_SESSION_free(session);
  }
}

export function sslImportSession(ssl: object, data: Uint8Array, earlyDataMax = 0): { imported: boolean; maxEarlyData: number } {
  const lib = _requireSsl();
  const pp = _ptrPtrBuf(data);
  const session = lib.symbols.d2i_SSL_SESSION(null, pp, data.byteLength);
  if (session === null) return { imported: false, maxEarlyData: 0 };
  try {
    let maxEarlyData = Number(lib.symbols.SSL_SESSION_get_max_early_data(session) ?? 0);
    const restoredMax = Math.max(0, Math.min(0xffffffff, Math.floor(earlyDataMax)));
    if (maxEarlyData === 0 && restoredMax > 0 && lib.symbols.SSL_SESSION_set_max_early_data(session, restoredMax) === 1) {
      maxEarlyData = restoredMax;
    }
    return { imported: lib.symbols.SSL_set_session(ssl, session) === 1, maxEarlyData };
  } finally {
    lib.symbols.SSL_SESSION_free(session);
  }
}

/**
 * Set OpenSSL app data for an `SSL*`.
 *
 * @param ssl SSL* connection object.
 * @param data Native pointer value or null.
 * @returns Nothing.
 * @internal
 */
export function sslSetAppData(ssl: object, data: ArrayBuffer | null = null): void {
  if (_requireSsl().symbols.SSL_set_ex_data(ssl, 0, data) !== 1) {
    throw new Error('SSL_set_ex_data failed: ' + getErrorString());
  }
}

export const SSL_DEFAULT_STREAM_MODE_NONE = 0;
export const SSL_INCOMING_STREAM_POLICY_ACCEPT = 1;
export const SSL_ACCEPT_CONNECTION_NO_BLOCK = 1;
export const SSL_STREAM_FLAG_UNI = 1;
export const SSL_STREAM_FLAG_NO_BLOCK = 2;
export const SSL_ACCEPT_STREAM_NO_BLOCK = 1;
export const SSL_ACCEPT_STREAM_UNI = 2;
export const SSL_ACCEPT_STREAM_BIDI = 4;
export const SSL_WRITE_FLAG_CONCLUDE = 1;
export const SSL_SHUTDOWN_FLAG_RAPID = 1;

/**
 * Create an OpenSSL QUIC listener object from a QUIC server context.
 *
 * @param ctx QUIC server SSL_CTX*.
 * @returns Opaque owning listener `SSL*`.
 * @internal
 */
export function sslNewListener(ctx: object): object {
  const ssl = _requireSslQuic().symbols.SSL_new_listener(ctx, 0);
  if (ssl === null) throw new Error('SSL_new_listener failed: ' + getErrorString());
  return ssl;
}

/**
 * Start an OpenSSL listener.
 *
 * @param listener QUIC listener `SSL*`.
 * @returns Nothing.
 * @internal
 */
export function sslListen(listener: object): void {
  if (_requireSslQuic().symbols.SSL_listen(listener) !== 1) {
    throw new Error('SSL_listen failed: ' + getErrorString());
  }
}

/**
 * Accept a QUIC connection from a listener without blocking.
 *
 * @param listener QUIC listener `SSL*`.
 * @returns Owning connection `SSL*`, or null when no connection is queued.
 * @internal
 */
export function sslAcceptConnectionNoBlock(listener: object): object | null {
  return _requireSslQuic().symbols.SSL_accept_connection(listener, SSL_ACCEPT_CONNECTION_NO_BLOCK) as object | null;
}

/**
 * Return queued QUIC connections ready to be accepted from a listener.
 *
 * @param listener QUIC listener `SSL*`.
 * @returns Number of queued connections.
 * @internal
 */
export function sslGetAcceptConnectionQueueLen(listener: object): number {
  return Number(_requireSslQuic().symbols.SSL_get_accept_connection_queue_len(listener));
}

/**
 * Create a locally-initiated QUIC stream.
 *
 * @param conn QUIC connection `SSL*`.
 * @param unidirectional Whether to create a unidirectional stream.
 * @returns Owning stream `SSL*`.
 * @internal
 */
export function sslNewQuicStream(conn: object, unidirectional = false): object {
  const flags = (unidirectional ? SSL_STREAM_FLAG_UNI : 0) | SSL_STREAM_FLAG_NO_BLOCK;
  const stream = _requireSslQuic().symbols.SSL_new_stream(conn, flags);
  if (stream === null) throw new Error('SSL_new_stream failed: ' + getErrorString());
  return stream;
}

/**
 * Accept a remote-initiated QUIC stream without blocking.
 *
 * @param conn QUIC connection `SSL*`.
 * @returns Owning stream `SSL*`, or null when no stream is queued.
 * @internal
 */
export function sslAcceptStreamNoBlock(conn: object): object | null {
  return _requireSslQuic().symbols.SSL_accept_stream(conn, SSL_ACCEPT_STREAM_NO_BLOCK) as object | null;
}

/**
 * Return an OpenSSL QUIC stream ID.
 *
 * @param stream QUIC stream `SSL*`.
 * @returns Stream ID as a number.
 * @internal
 */
export function sslGetStreamId(stream: object): number {
  return Number(_requireSslQuic().symbols.SSL_get_stream_id(stream));
}

/**
 * Free an owning SSL connection object.
 *
 * The pointer must have been returned by `sslNew()` and must not be used after
 * this call. Shutdown should be handled separately when protocol semantics
 * require it.
 *
 * ```js
 * const { sslCtxNewClient, sslNew, sslFree, sslCtxFree, tlsAvailable } =
 *   import 'internal:openssl';
 * if (tlsAvailable) {
 *   const ctx = sslCtxNewClient();
 *   const ssl = sslNew(ctx);
 *   sslFree(ssl);
 *   sslCtxFree(ctx);
 * }
 * ```
 *
 * @param ssl Opaque owning `SSL*`.
 * @returns Nothing.
 * @internal
 */
export function sslFree(ssl: object): void {
  _requireSsl().symbols.SSL_free(ssl);
}

/**
 * Bind an SSL connection object to a file descriptor.
 *
 * The descriptor is borrowed by OpenSSL and must remain valid while the SSL
 * object is used. OpenSSL setup failure throws.
 *
 * ```js
 * import { sslSetFd } from 'internal:openssl';
 * console.log(typeof sslSetFd);
 * ```
 *
 * @param ssl Opaque `SSL*`.
 * @param fd POSIX file descriptor.
 * @returns Nothing.
 * @internal
 */
export function sslSetFd(ssl: object, fd: number): void {
  const rc = _requireSsl().symbols.SSL_set_fd(ssl, fd);
  if (rc !== 1) throw new Error('SSL_set_fd failed');
}

/**
 * Configure OpenSSL application-level blocking mode.
 *
 * QUIC network sockets remain nonblocking; this controls whether OpenSSL API
 * calls wait internally. Fino uses nonblocking mode and the JS event loop.
 *
 * @param ssl SSL* object.
 * @param blocking Whether OpenSSL calls should block.
 * @returns Nothing.
 * @internal
 */
export function sslSetBlockingMode(ssl: object, blocking: boolean): void {
  if (_requireSslQuic().symbols.SSL_set_blocking_mode(ssl, blocking ? 1 : 0) !== 1) {
    throw new Error('SSL_set_blocking_mode failed: ' + getErrorString());
  }
}

/**
 * Disable the implicit default QUIC stream for multi-stream operation.
 *
 * @param ssl QUIC connection SSL*.
 * @returns Nothing.
 * @internal
 */
export function sslUseQuicMultiStreamMode(ssl: object): void {
  const lib = _requireSslQuic();
  if (lib.symbols.SSL_set_default_stream_mode(ssl, SSL_DEFAULT_STREAM_MODE_NONE) !== 1) {
    throw new Error('SSL_set_default_stream_mode failed: ' + getErrorString());
  }
  if (lib.symbols.SSL_set_incoming_stream_policy(ssl, SSL_INCOMING_STREAM_POLICY_ACCEPT, 0) !== 1) {
    throw new Error('SSL_set_incoming_stream_policy failed: ' + getErrorString());
  }
}

/**
 * Drive OpenSSL QUIC event processing.
 *
 * @param ssl QUIC listener, connection, or stream SSL*.
 * @returns Raw OpenSSL return value.
 * @internal
 */
export function sslHandleEvents(ssl: object): Promise<number> {
  return _requireSslQuic().symbols.SSL_handle_events(ssl) as Promise<number>;
}

/**
 * Whether an SSL handshake has completed.
 *
 * @param ssl SSL* object.
 * @returns True after handshake completion.
 * @internal
 */
export function sslIsInitFinished(ssl: object): boolean {
  return _requireSsl().symbols.SSL_is_init_finished(ssl) === 1;
}

/**
 * Set SNI hostname and enable hostname verification.
 * RFC 6066 forbids IP literals in the SNI extension — SNI is skipped for them.
 * SSL_set1_host is always called so that IP SAN matching still works.
 *
 * ```js
 * import { sslSetHostname } from 'internal:openssl';
 * console.log(typeof sslSetHostname);
 * ```
 *
 * @param {object} ssl — SSL* pointer
 * @param {string} hostname — DNS name or IP address
 * @returns Nothing.
 * @internal
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

/**
 * Perform a client TLS handshake step.
 *
 * Returns the raw `SSL_connect()` result, usually `1` on success and
 * non-positive values requiring `sslGetError()` handling. This wrapper does not
 * loop on WANT_READ or WANT_WRITE.
 *
 * ```js
 * import { sslConnect } from 'internal:openssl';
 * console.log(typeof sslConnect);
 * ```
 *
 * @param ssl Opaque `SSL*`.
 * @returns Raw OpenSSL handshake result.
 * @internal
 */
export function sslConnect(ssl: object): number { return _requireSsl().symbols.SSL_connect(ssl); }

/**
 * Perform a server TLS handshake step.
 *
 * Returns the raw `SSL_accept()` result, usually `1` on success. The FFI symbol
 * is async and runs on the blocking pool so ALPN callbacks can bridge safely.
 * Non-positive results require `sslGetError()` handling by the caller.
 *
 * ```js
 * import { sslAccept } from 'internal:openssl';
 * console.log(typeof sslAccept);
 * ```
 *
 * @param ssl Opaque `SSL*`.
 * @returns A promise resolving to the raw OpenSSL handshake result.
 * @internal
 */
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
 *
 * ```js
 * import { sslCtxSetAlpnServerProtos } from 'internal:openssl';
 * console.log(typeof sslCtxSetAlpnServerProtos);
 * ```
 *
 * @param ctx Server SSL_CTX*.
 * @param protocols Ordered server preference list.
 * @returns Retained FFI callback object; caller must keep and close it.
 * @internal
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
 *
 * This returns the raw `SSL_read()` result: positive byte count on success, `0`
 * for graceful close, or a negative value that should be interpreted with
 * `sslGetError()`. The buffer must be at least `len` bytes.
 *
 * ```js
 * import { sslRead } from 'internal:openssl';
 * console.log(typeof sslRead);
 * ```
 *
 * @param {object} ssl
 * @param {ArrayBuffer} buf
 * @param {number} len
 * @returns {number} bytes read, 0 on graceful close, negative on error
 * @internal
 */
export function sslRead(ssl: object, buf: ArrayBuffer, len: number): number  { return _requireSsl().symbols.SSL_read(ssl, buf, len); }

/**
 * Read decrypted bytes with OpenSSL's size_t-based API.
 *
 * @param ssl QUIC stream `SSL*`.
 * @param buf Destination buffer.
 * @returns Bytes read, `0` for graceful stream EOF, or `null` for WANT_READ/WRITE.
 * @internal
 */
export function sslReadEx(ssl: object, buf: ArrayBuffer): number | null {
  const out = new ArrayBuffer(8);
  const rc = _requireSsl().symbols.SSL_read_ex(ssl, buf, buf.byteLength, out);
  if (rc === 1) return Number(new DataView(out).getBigUint64(0, true));
  const err = sslGetError(ssl, rc);
  if (err === SSL_ERROR_ZERO_RETURN) return 0;
  if (err === SSL_ERROR_WANT_READ || err === SSL_ERROR_WANT_WRITE) return null;
  throw new Error('SSL_read_ex failed: ' + getErrorString());
}

/**
 * Write `len` bytes from `buf` over TLS.
 *
 * This returns the raw `SSL_write()` result: positive byte count on success or
 * a non-positive value that should be interpreted with `sslGetError()`. The
 * caller is responsible for retrying partial writes.
 *
 * ```js
 * import { sslWrite } from 'internal:openssl';
 * console.log(typeof sslWrite);
 * ```
 *
 * @param {object} ssl
 * @param {Uint8Array|ArrayBuffer} buf
 * @param {number} len
 * @returns {number} bytes written, or negative on error
 * @internal
 */
export function sslWrite(ssl: object, buf: Uint8Array | ArrayBuffer, len: number): number { return _requireSsl().symbols.SSL_write(ssl, buf, len); }

/**
 * Write decrypted bytes with optional QUIC FIN.
 *
 * @param ssl QUIC stream `SSL*`.
 * @param buf Source bytes.
 * @param conclude Whether to append the stream FIN after this write.
 * @returns Bytes accepted, or `null` for WANT_READ/WRITE.
 * @internal
 */
export function sslWriteEx2(ssl: object, buf: Uint8Array | ArrayBuffer, conclude = false): number | null {
  const out = new ArrayBuffer(8);
  const rc = _requireSslQuic().symbols.SSL_write_ex2(ssl, buf, buf.byteLength, conclude ? SSL_WRITE_FLAG_CONCLUDE : 0, out);
  if (rc === 1) return Number(new DataView(out).getBigUint64(0, true));
  const err = sslGetError(ssl, rc);
  if (err === SSL_ERROR_WANT_READ || err === SSL_ERROR_WANT_WRITE) return null;
  throw new Error('SSL_write_ex2 failed: ' + getErrorString());
}

/**
 * Conclude the sending side of a QUIC stream.
 *
 * @param ssl QUIC stream `SSL*`.
 * @returns Nothing.
 * @internal
 */
export function sslStreamConclude(ssl: object): void {
  if (_requireSslQuic().symbols.SSL_stream_conclude(ssl, 0) !== 1) {
    throw new Error('SSL_stream_conclude failed: ' + getErrorString());
  }
}

/**
 * Rapidly close a QUIC connection.
 *
 * @param ssl QUIC connection `SSL*`.
 * @returns Raw OpenSSL result.
 * @internal
 */
export function sslShutdownQuicRapid(ssl: object): number {
  return _requireSsl().symbols.SSL_shutdown_ex(ssl, SSL_SHUTDOWN_FLAG_RAPID, null, 0);
}

/**
 * Initiate or continue the TLS shutdown sequence.
 *
 * Returns the raw `SSL_shutdown()` result. Callers must interpret non-success
 * results with OpenSSL semantics and may need to call the function again for a
 * bidirectional shutdown.
 *
 * ```js
 * import { sslShutdown } from 'internal:openssl';
 * console.log(typeof sslShutdown);
 * ```
 *
 * @param ssl Opaque `SSL*`.
 * @returns Raw OpenSSL shutdown result.
 * @internal
 */
export function sslShutdown(ssl: object): number { return _requireSsl().symbols.SSL_shutdown(ssl); }

/**
 * Translate a raw SSL operation result to an OpenSSL error code.
 *
 * Use this after `sslRead()`, `sslWrite()`, `sslConnect()`, `sslAccept()`, or
 * `sslShutdown()` return a non-success value. Returned constants include
 * `SSL_ERROR_WANT_READ`, `SSL_ERROR_WANT_WRITE`, and `SSL_ERROR_ZERO_RETURN`.
 *
 * ```js
 * import { sslGetError, SSL_ERROR_WANT_READ } from 'internal:openssl';
 * console.log(typeof sslGetError, SSL_ERROR_WANT_READ);
 * ```
 *
 * @param ssl Opaque `SSL*`.
 * @param ret Raw result from a previous SSL operation.
 * @returns OpenSSL SSL_ERROR_* code.
 * @internal
 */
export function sslGetError(ssl: object, ret: number): number { return _requireSsl().symbols.SSL_get_error(ssl, ret); }

/**
 * Return bytes already decrypted and buffered by OpenSSL.
 *
 * This does not read from the underlying descriptor. A positive value means
 * `sslRead()` can return decrypted bytes without waiting for more network I/O.
 *
 * ```js
 * import { sslPending } from 'internal:openssl';
 * console.log(typeof sslPending);
 * ```
 *
 * @param ssl Opaque `SSL*`.
 * @returns Pending decrypted byte count.
 * @internal
 */
export function sslPending(ssl: object): number { return _requireSsl().symbols.SSL_pending(ssl); }

// ---------------------------------------------------------------------------
// SSL error code constants
// ---------------------------------------------------------------------------

/**
 * OpenSSL error code for no SSL error.
 *
 * ```js
 * import { SSL_ERROR_NONE } from 'internal:openssl';
 * console.log(SSL_ERROR_NONE);
 * ```
 *
 * @internal
 */
export const SSL_ERROR_NONE        = 0;
/**
 * OpenSSL error code for protocol or library failure.
 *
 * ```js
 * import { SSL_ERROR_SSL } from 'internal:openssl';
 * console.log(SSL_ERROR_SSL);
 * ```
 *
 * @internal
 */
export const SSL_ERROR_SSL         = 1;
/**
 * OpenSSL error code indicating the operation should retry after readability.
 *
 * ```js
 * import { SSL_ERROR_WANT_READ } from 'internal:openssl';
 * console.log(SSL_ERROR_WANT_READ);
 * ```
 *
 * @internal
 */
export const SSL_ERROR_WANT_READ   = 2;
/**
 * OpenSSL error code indicating the operation should retry after writability.
 *
 * ```js
 * import { SSL_ERROR_WANT_WRITE } from 'internal:openssl';
 * console.log(SSL_ERROR_WANT_WRITE);
 * ```
 *
 * @internal
 */
export const SSL_ERROR_WANT_WRITE  = 3;
/**
 * OpenSSL error code for syscall-layer failure or unexpected EOF.
 *
 * ```js
 * import { SSL_ERROR_SYSCALL } from 'internal:openssl';
 * console.log(SSL_ERROR_SYSCALL);
 * ```
 *
 * @internal
 */
export const SSL_ERROR_SYSCALL     = 5;
/**
 * OpenSSL error code for clean TLS close-notify.
 *
 * ```js
 * import { SSL_ERROR_ZERO_RETURN } from 'internal:openssl';
 * console.log(SSL_ERROR_ZERO_RETURN);
 * ```
 *
 * @internal
 */
export const SSL_ERROR_ZERO_RETURN = 6;

/**
 * OpenSSL verification mode bit that requires peer certificate verification.
 *
 * ```js
 * import { SSL_VERIFY_PEER } from 'internal:openssl';
 * console.log(SSL_VERIFY_PEER);
 * ```
 *
 * @internal
 */
export const SSL_VERIFY_PEER = 0x01;

/** OpenSSL verification mode bit requiring clients to send a certificate. */
export const SSL_VERIFY_FAIL_IF_NO_PEER_CERT = 0x02;
