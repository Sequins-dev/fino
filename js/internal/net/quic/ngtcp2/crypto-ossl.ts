/**
* internal:net/quic/ngtcp2/crypto-ossl — ngtcp2 OpenSSL crypto helpers.
*
* Phase 1 uses `ngtcp2_crypto_ossl` as the only QUIC crypto backend. This
* module keeps that backend behind an internal boundary so public QUIC APIs do
* not expose OpenSSL-specific types. It binds the callback helpers and session
* configuration functions required to couple ngtcp2 with OpenSSL QUIC TLS.
*
* @internal
*/
import { dlopen, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
export { Pointer };
const _IS_DARWIN = os === 'darwin';
const _CANDIDATES = _IS_DARWIN ? [
  '/opt/homebrew/opt/libngtcp2/lib/libngtcp2_crypto_ossl.dylib',
  '/opt/homebrew/lib/libngtcp2_crypto_ossl.dylib',
  '/usr/local/opt/libngtcp2/lib/libngtcp2_crypto_ossl.dylib',
  '/usr/local/lib/libngtcp2_crypto_ossl.dylib',
  '/opt/local/lib/libngtcp2_crypto_ossl.dylib'
] : [
  'libngtcp2_crypto_ossl.so.0',
  'libngtcp2_crypto_ossl.so',
  '/usr/lib/x86_64-linux-gnu/libngtcp2_crypto_ossl.so.0',
  '/usr/lib/aarch64-linux-gnu/libngtcp2_crypto_ossl.so.0',
  '/usr/local/lib/libngtcp2_crypto_ossl.so'
];
const _SYMBOLS = {
  ngtcp2_crypto_ossl_init: {
    parameters: [],
    result: 'i32'
  },
  ngtcp2_crypto_ossl_ctx_new: {
    parameters: ['pointer', 'pointer'],
    result: 'i32'
  },
  ngtcp2_crypto_ossl_ctx_del: {
    parameters: ['pointer'],
    result: 'void'
  },
  ngtcp2_crypto_ossl_ctx_set_ssl: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  ngtcp2_crypto_ossl_ctx_get_ssl: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  ngtcp2_crypto_ossl_configure_client_session: {
    parameters: ['pointer'],
    result: 'i32'
  },
  ngtcp2_crypto_ossl_configure_server_session: {
    parameters: ['pointer'],
    result: 'i32'
  },
  ngtcp2_crypto_client_initial_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_recv_client_initial_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_recv_crypto_data_cb: {
    parameters: [
      'pointer',
      'i32',
      'u64',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_encrypt_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_decrypt_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_hp_mask_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_update_key_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_delete_crypto_aead_ctx_cb: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  ngtcp2_crypto_delete_crypto_cipher_ctx_cb: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  ngtcp2_crypto_get_path_challenge_data_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_version_negotiation_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_recv_retry_cb: {
    parameters: [
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_read_write_crypto_data: {
    parameters: [
      'pointer',
      'i32',
      'pointer',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_write_connection_close: {
    parameters: [
      'buffer',
      'usize',
      'u32',
      'pointer',
      'pointer',
      'u64',
      'buffer',
      'usize'
    ],
    result: 'isize'
  },
  ngtcp2_crypto_generate_stateless_reset_token: {
    parameters: [
      'buffer',
      'buffer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_generate_regular_token: {
    parameters: [
      'buffer',
      'buffer',
      'usize',
      'pointer',
      'u32',
      'u64'
    ],
    result: 'isize'
  },
  ngtcp2_crypto_verify_regular_token: {
    parameters: [
      'buffer',
      'usize',
      'buffer',
      'usize',
      'pointer',
      'u32',
      'u64',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_generate_retry_token2: {
    parameters: [
      'buffer',
      'buffer',
      'usize',
      'u32',
      'pointer',
      'u32',
      'pointer',
      'pointer',
      'u64'
    ],
    result: 'isize'
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
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_crypto_write_retry: {
    parameters: [
      'buffer',
      'usize',
      'u32',
      'pointer',
      'pointer',
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'isize'
  }
};
let _lib: ReturnType<typeof dlopen> | null = null;
for (const path of _CANDIDATES) {
  try {
    _lib = dlopen(path, _SYMBOLS);
    break;
  } catch {}
}
export const cryptoOsslAvailable = _lib !== null;
export const cryptoBackend = _lib !== null ? 'ossl' : null;
export const sym = _lib?.symbols ?? null;
export const ptr = _lib?.pointers ?? null;
export function requireCryptoOssl(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error('libngtcp2_crypto_ossl not found. Install via:\n' + '  macOS:  brew install libngtcp2 openssl@3\n' + '  Ubuntu: apt install libngtcp2-crypto-ossl0');
  }
  return _lib;
}
export function newCryptoOsslContext(ssl: object | null = null): ArrayBuffer {
  const out = new ArrayBuffer(8);
  const rc = requireCryptoOssl().symbols.ngtcp2_crypto_ossl_ctx_new(Pointer.of(out), ssl) as number;
  if (rc !== 0) throw new Error(`ngtcp2_crypto_ossl_ctx_new failed: ${rc}`);
  return out;
}
