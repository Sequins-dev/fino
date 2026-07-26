/**
 * internal:net/quic/ngtcp2/crypto-ossl — ngtcp2 OpenSSL crypto helpers.
 *
 * This module `dlopen`s `libngtcp2_crypto_ossl` and binds the crypto callbacks,
 * session configuration entry points, and token helpers ngtcp2 needs to drive a
 * QUIC handshake through OpenSSL's native QUIC TLS API (OpenSSL 3.5+). It is the
 * preferred crypto backend for QUIC; `crypto-gnutls.ts` is the fallback used
 * where a suitable OpenSSL is unavailable. Both sit behind the generic
 * `crypto.ts` adapter so that public QUIC APIs never expose OpenSSL- or
 * GnuTLS-specific types.
 *
 * Loading is best effort. At import time the module walks a list of
 * platform-specific candidates. Linux first resolves the statically linked copy
 * from the Fino executable, while macOS tries Homebrew and MacPorts; both retain
 * system-library fallbacks. If none is found the module still imports cleanly,
 * but every accessor reports the backend as unavailable and
 * `requireCryptoOssl()` throws with install guidance. Callers should branch on
 * `cryptoOsslAvailable` (or the unified `cryptoAvailable` in `crypto.ts`) before
 * touching `sym`, `ptr`, or `newCryptoOsslContext()`.
 *
 * The bound symbol table mirrors the `ngtcp2_crypto` and `ngtcp2_crypto_ossl`
 * C APIs one-to-one, so `sym` exposes raw FFI functions with pointer-and-length
 * argument shapes rather than a JavaScript-friendly wrapper. It is intended for
 * consumption by `crypto.ts`, not for direct use elsewhere.
 *
 * ```ts no_run
 * import {
 *   cryptoOsslAvailable,
 *   requireCryptoOssl,
 *   newCryptoOsslContext,
 * } from 'internal:net/quic/ngtcp2/crypto-ossl';
 *
 * if (cryptoOsslAvailable) {
 *   requireCryptoOssl().symbols.ngtcp2_crypto_ossl_init();
 *   // `ssl` is an SSL* handle produced elsewhere in the TLS setup.
 *   const ctx = newCryptoOsslContext(sslHandle);
 * }
 * ```
 *
 * ngtcp2 crypto API: https://nghttp2.org/ngtcp2/ngtcp2_crypto.html
 *
 * @internal
 */
import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
/**
 * Re-export of the `fino:ffi` `Pointer` helper.
 *
 * Callers building argument lists for the raw `sym` functions — for example
 * wrapping an output `ArrayBuffer` with `Pointer.of()` — can import `Pointer`
 * from this module instead of reaching into `fino:ffi` separately.
 */
export { Pointer };
const _IS_DARWIN = os === 'darwin';
const _CANDIDATES = _IS_DARWIN
  ? [
      '/opt/homebrew/opt/libngtcp2/lib/libngtcp2_crypto_ossl.dylib',
      '/opt/homebrew/lib/libngtcp2_crypto_ossl.dylib',
      '/usr/local/opt/libngtcp2/lib/libngtcp2_crypto_ossl.dylib',
      '/usr/local/lib/libngtcp2_crypto_ossl.dylib',
      '/opt/local/lib/libngtcp2_crypto_ossl.dylib',
    ]
  : [
      null,
      'libngtcp2_crypto_ossl.so.0',
      'libngtcp2_crypto_ossl.so',
      '/usr/lib/x86_64-linux-gnu/libngtcp2_crypto_ossl.so.0',
      '/usr/lib/aarch64-linux-gnu/libngtcp2_crypto_ossl.so.0',
      '/usr/local/lib/libngtcp2_crypto_ossl.so',
    ];
const _SYMBOLS = {
  ngtcp2_crypto_ossl_init: {
    parameters: [],
    result: 'i32',
  },
  ngtcp2_crypto_ossl_ctx_new: {
    parameters: ['pointer', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_ossl_ctx_del: {
    parameters: ['pointer'],
    result: 'void',
  },
  ngtcp2_crypto_ossl_ctx_set_ssl: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  ngtcp2_crypto_ossl_ctx_get_ssl: {
    parameters: ['pointer'],
    result: 'pointer',
  },
  ngtcp2_crypto_ossl_configure_client_session: {
    parameters: ['pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_ossl_configure_server_session: {
    parameters: ['pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_client_initial_cb: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'usize', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_recv_client_initial_cb: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_recv_crypto_data_cb: {
    parameters: ['pointer', 'i32', 'u64', 'pointer', 'usize', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_encrypt_cb: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'usize', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_decrypt_cb: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'usize', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_hp_mask_cb: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_update_key_cb: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_delete_crypto_aead_ctx_cb: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  ngtcp2_crypto_delete_crypto_cipher_ctx_cb: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  ngtcp2_crypto_get_path_challenge_data_cb: {
    parameters: ['pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_version_negotiation_cb: {
    parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_recv_retry_cb: {
    parameters: ['pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_read_write_crypto_data: {
    parameters: ['pointer', 'i32', 'pointer', 'usize'],
    result: 'i32',
  },
  ngtcp2_crypto_write_connection_close: {
    parameters: ['buffer', 'usize', 'u32', 'pointer', 'pointer', 'u64', 'buffer', 'usize'],
    result: 'isize',
  },
  ngtcp2_crypto_generate_stateless_reset_token: {
    parameters: ['buffer', 'buffer', 'usize', 'pointer'],
    result: 'i32',
  },
  ngtcp2_crypto_generate_regular_token: {
    parameters: ['buffer', 'buffer', 'usize', 'pointer', 'u32', 'u64'],
    result: 'isize',
  },
  ngtcp2_crypto_verify_regular_token: {
    parameters: ['buffer', 'usize', 'buffer', 'usize', 'pointer', 'u32', 'u64', 'u64'],
    result: 'i32',
  },
  ngtcp2_crypto_generate_retry_token2: {
    parameters: ['buffer', 'buffer', 'usize', 'u32', 'pointer', 'u32', 'pointer', 'pointer', 'u64'],
    result: 'isize',
  },
  ngtcp2_crypto_verify_retry_token2: {
    parameters: [
      'pointer',
      'buffer',
      'usize',
      'buffer',
      'usize',
      'u32',
      'pointer',
      'u32',
      'pointer',
      'u64',
      'u64',
    ],
    result: 'i32',
  },
  ngtcp2_crypto_write_retry: {
    parameters: ['buffer', 'usize', 'u32', 'pointer', 'pointer', 'pointer', 'buffer', 'usize'],
    result: 'isize',
  },
};
let _lib: ReturnType<typeof dlopen> | null = null;
for (const path of _CANDIDATES) {
  try {
    _lib = dlopen(path, _SYMBOLS);
    break;
  } catch {}
}
/**
 * Whether `libngtcp2_crypto_ossl` was found and opened at import time.
 *
 * When `false`, `sym`, `ptr`, and `cryptoBackend` are all `null`, and any
 * call into the backend must be avoided. `crypto.ts` folds this into the
 * unified `cryptoAvailable` flag alongside the GnuTLS backend.
 */
export const cryptoOsslAvailable = _lib !== null;
/**
 * Backend tag: the string `'ossl'` when the OpenSSL library loaded, otherwise
 * `null`.
 *
 * This lets the generic adapter dispatch on backend identity — for example
 * `cryptoBackend === 'ossl'` gates the OpenSSL-specific init and context paths
 * in `crypto.ts`.
 */
export const cryptoBackend = _lib !== null ? 'ossl' : null;
/**
 * The bound FFI symbol table, or `null` when the backend is unavailable.
 *
 * Each property is a raw function matching its `ngtcp2_crypto` /
 * `ngtcp2_crypto_ossl` C counterpart, so arguments follow the C ABI
 * (pointers, buffers, and explicit lengths). Guard access with
 * `cryptoOsslAvailable` — the value is `null`, not a throwing stub, when the
 * library is missing.
 *
 * ```ts no_run
 * import { cryptoOsslAvailable, sym } from 'internal:net/quic/ngtcp2/crypto-ossl';
 *
 * if (cryptoOsslAvailable) {
 *   sym!.ngtcp2_crypto_ossl_init();
 * }
 * ```
 */
export const sym = _lib?.symbols ?? null;
/**
 * The library's exported symbol pointers, or `null` when unavailable.
 *
 * These are function-pointer addresses (as opposed to the callable wrappers in
 * `sym`), used when ngtcp2 needs the raw address of a crypto callback to store
 * in a callbacks struct rather than to invoke it from JavaScript.
 */
export const ptr = _lib?.pointers ?? null;
/**
 * Returns the loaded OpenSSL crypto library handle, throwing if it is missing.
 *
 * Use this at the point where the backend is actually required so the failure
 * carries actionable install guidance. Prefer checking `cryptoOsslAvailable`
 * first if you want to fall back to another backend rather than surface an
 * error.
 *
 * Throws an `Error` with platform-specific install instructions when
 * `libngtcp2_crypto_ossl` could not be opened at import time.
 *
 * ```ts no_run
 * import { requireCryptoOssl } from 'internal:net/quic/ngtcp2/crypto-ossl';
 *
 * const lib = requireCryptoOssl();
 * lib.symbols.ngtcp2_crypto_ossl_init();
 * ```
 */
export function requireCryptoOssl(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error(
      'libngtcp2_crypto_ossl not found. Install via:\n' +
        '  macOS:  brew install libngtcp2 openssl@3\n' +
        '  Ubuntu: apt install libngtcp2-crypto-ossl0',
    );
  }
  return _lib;
}
/**
 * Allocates and initializes an `ngtcp2_crypto_ossl_ctx` bound to an SSL handle.
 *
 * The returned 8-byte `ArrayBuffer` holds the opaque context pointer produced
 * by `ngtcp2_crypto_ossl_ctx_new`. Pass the OpenSSL `SSL*` handle as `ssl` (or
 * `null` to attach it later via `ngtcp2_crypto_ossl_ctx_set_ssl`). The buffer
 * is written in place by the FFI call and must outlive the QUIC connection that
 * references it, so keep it reachable — the connection stores a raw pointer
 * into it.
 *
 * Requires the OpenSSL backend to be loaded; it calls `requireCryptoOssl()`
 * internally and therefore throws if the library is unavailable. Also throws if
 * `ngtcp2_crypto_ossl_ctx_new` returns a non-zero status.
 *
 * ```ts no_run
 * import { newCryptoOsslContext } from 'internal:net/quic/ngtcp2/crypto-ossl';
 *
 * // `ssl` is an SSL* handle obtained from the TLS session setup.
 * const ctx = newCryptoOsslContext(ssl);
 * // Keep `ctx` alive for the lifetime of the QUIC connection.
 * ```
 */
export function newCryptoOsslContext(ssl: object | null = null): ArrayBuffer {
  const out = new ArrayBuffer(8);
  const rc = requireCryptoOssl().symbols.ngtcp2_crypto_ossl_ctx_new(Pointer.of(out), ssl) as number;
  if (rc !== 0) throw new Error(`ngtcp2_crypto_ossl_ctx_new failed: ${rc}`);
  return out;
}
