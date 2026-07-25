/**
* internal:net/quic/ngtcp2/crypto-gnutls — ngtcp2 GnuTLS crypto helpers.
*
* QUIC needs a TLS 1.3 stack wired into ngtcp2's cryptographic callbacks. This
* module is the GnuTLS backend for that coupling: it dlopens
* `libngtcp2_crypto_gnutls`, `libgnutls`, and libc (for `free`), then exposes
* the narrow set of credential and session operations the generic QUIC crypto
* adapter (`internal:net/quic/ngtcp2/crypto`) needs. It is the fallback backend,
* selected when the preferred OpenSSL backend (`crypto-ossl`) is absent — on
* many Linux distributions GnuTLS is the QUIC-capable TLS library that ships by
* default.
*
* Everything here is thin glue over the C ABI. Handles are raw `ArrayBuffer`
* pointers into GnuTLS objects; the `GnutlsCredentials` and `GnutlsSession`
* records bundle a handle with the JavaScript-side state (FFI callbacks, ticket
* keys, anti-replay tables) that must outlive the C object and be freed
* deterministically. Nothing loads eagerly — probing happens at import time and
* failures surface through `cryptoGnutlsAvailable` rather than throwing, so a
* host without GnuTLS can still import the module and fall back to OpenSSL. Call
* `requireCryptoGnutls()` (or any factory, which runs `initCryptoGnutls()` for
* you) before touching a handle.
*
* A typical server flow builds credentials once, then creates, configures, and
* frees a session per connection:
*
* ```ts no_run
*   import {
*     cryptoGnutlsAvailable,
*     newGnutlsCredentials,
*     newGnutlsSession,
*     configureGnutlsSession,
*     getGnutlsAlpnSelected,
*     freeGnutlsSession,
*     freeGnutlsCredentials,
*   } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   if (!cryptoGnutlsAvailable) throw new Error('GnuTLS QUIC backend unavailable');
*
*   const creds = newGnutlsCredentials('server', '/etc/tls/cert.pem', '/etc/tls/key.pem');
*   const session = newGnutlsSession('server', creds, ['h3']);
*   configureGnutlsSession('server', session);
*   // ... drive the ngtcp2 handshake, then once it completes:
*   const alpn = getGnutlsAlpnSelected(session); // 'h3'
*   freeGnutlsSession(session);
*   freeGnutlsCredentials(creds);
* ```
*
* ngtcp2 crypto helpers: https://nghttp2.org/ngtcp2/
* GnuTLS manual: https://www.gnutls.org/manual/
*
* @internal
*/
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
/**
* Re-export of the FFI `Pointer` helper for reading and writing native memory.
*
* Callers that manipulate the raw handles carried by `GnutlsCredentials` and
* `GnutlsSession` reach for it without importing `fino:ffi` separately.
*/
export { Pointer };
const _IS_DARWIN = os === 'darwin';
const _CRYPTO_CANDIDATES = _IS_DARWIN ? [
  '/opt/homebrew/opt/libngtcp2/lib/libngtcp2_crypto_gnutls.dylib',
  '/opt/homebrew/lib/libngtcp2_crypto_gnutls.dylib',
  '/usr/local/opt/libngtcp2/lib/libngtcp2_crypto_gnutls.dylib',
  '/usr/local/lib/libngtcp2_crypto_gnutls.dylib',
  '/opt/local/lib/libngtcp2_crypto_gnutls.dylib'
] : [
  'libngtcp2_crypto_gnutls.so.8',
  'libngtcp2_crypto_gnutls.so.2',
  'libngtcp2_crypto_gnutls.so',
  '/usr/lib/x86_64-linux-gnu/libngtcp2_crypto_gnutls.so.8',
  '/usr/lib/aarch64-linux-gnu/libngtcp2_crypto_gnutls.so.8',
  '/usr/lib/x86_64-linux-gnu/libngtcp2_crypto_gnutls.so.2',
  '/usr/lib/aarch64-linux-gnu/libngtcp2_crypto_gnutls.so.2',
  '/usr/local/lib/libngtcp2_crypto_gnutls.so'
];
const _GNUTLS_CANDIDATES = _IS_DARWIN ? [
  '/opt/homebrew/opt/gnutls/lib/libgnutls.dylib',
  '/opt/homebrew/lib/libgnutls.dylib',
  '/usr/local/opt/gnutls/lib/libgnutls.dylib',
  '/usr/local/lib/libgnutls.dylib',
  '/opt/local/lib/libgnutls.dylib'
] : [
  'libgnutls.so.30',
  'libgnutls.so',
  '/usr/lib/x86_64-linux-gnu/libgnutls.so.30',
  '/usr/lib/aarch64-linux-gnu/libgnutls.so.30',
  '/usr/local/lib/libgnutls.so'
];
const _CRYPTO_SYMBOLS = {
  ngtcp2_crypto_gnutls_configure_client_session: {
    parameters: ['pointer'],
    result: 'i32'
  },
  ngtcp2_crypto_gnutls_configure_server_session: {
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
const _GNUTLS_SYMBOLS = {
  gnutls_global_init: {
    parameters: [],
    result: 'i32'
  },
  _gnutls_global_set_gettime_function: {
    parameters: ['pointer'],
    result: 'void'
  },
  gnutls_certificate_allocate_credentials: {
    parameters: ['pointer'],
    result: 'i32'
  },
  gnutls_certificate_free_credentials: {
    parameters: ['pointer'],
    result: 'void'
  },
  gnutls_certificate_set_x509_key_file: {
    parameters: [
      'pointer',
      'buffer',
      'buffer',
      'i32'
    ],
    result: 'i32'
  },
  gnutls_certificate_set_x509_system_trust: {
    parameters: ['pointer'],
    result: 'i32'
  },
  gnutls_init: {
    parameters: ['pointer', 'u32'],
    result: 'i32'
  },
  gnutls_deinit: {
    parameters: ['pointer'],
    result: 'void'
  },
  gnutls_credentials_set: {
    parameters: [
      'pointer',
      'u32',
      'pointer'
    ],
    result: 'i32'
  },
  gnutls_set_default_priority: {
    parameters: ['pointer'],
    result: 'i32'
  },
  gnutls_priority_set_direct: {
    parameters: [
      'pointer',
      'buffer',
      'pointer'
    ],
    result: 'i32'
  },
  gnutls_alpn_set_protocols: {
    parameters: [
      'pointer',
      'pointer',
      'u32',
      'u32'
    ],
    result: 'i32'
  },
  gnutls_alpn_get_selected_protocol: {
    parameters: ['pointer', 'pointer'],
    result: 'i32'
  },
  gnutls_cipher_get: {
    parameters: ['pointer'],
    result: 'i32'
  },
  gnutls_cipher_get_name: {
    parameters: ['i32'],
    result: 'pointer'
  },
  gnutls_protocol_get_version: {
    parameters: ['pointer'],
    result: 'i32'
  },
  gnutls_protocol_get_name: {
    parameters: ['i32'],
    result: 'pointer'
  },
  gnutls_server_name_set: {
    parameters: [
      'pointer',
      'u32',
      'buffer',
      'usize'
    ],
    result: 'i32'
  },
  gnutls_session_set_ptr: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  gnutls_session_set_verify_cert: {
    parameters: [
      'pointer',
      'buffer',
      'u32'
    ],
    result: 'void'
  },
  gnutls_handshake_set_hook_function: {
    parameters: [
      'pointer',
      'u32',
      'i32',
      'pointer'
    ],
    result: 'void'
  },
  gnutls_session_get_data2: {
    parameters: ['pointer', 'pointer'],
    result: 'i32'
  },
  gnutls_session_set_data: {
    parameters: [
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'i32'
  },
  gnutls_session_get_random: {
    parameters: [
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'void'
  },
  gnutls_prf_rfc5705: {
    parameters: [
      'pointer',
      'usize',
      'buffer',
      'usize',
      'buffer',
      'usize',
      'buffer'
    ],
    result: 'i32'
  },
  gnutls_session_set_keylog_function: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  gnutls_session_ticket_key_generate: {
    parameters: ['pointer'],
    result: 'i32'
  },
  gnutls_session_ticket_enable_server: {
    parameters: ['pointer', 'pointer'],
    result: 'i32'
  },
  gnutls_session_ticket_send: {
    parameters: [
      'pointer',
      'u32',
      'u32'
    ],
    result: 'i32'
  },
  gnutls_record_set_max_early_data_size: {
    parameters: ['pointer', 'usize'],
    result: 'i32'
  },
  gnutls_anti_replay_init: {
    parameters: ['pointer'],
    result: 'i32'
  },
  gnutls_anti_replay_deinit: {
    parameters: ['pointer'],
    result: 'void'
  },
  gnutls_anti_replay_set_window: {
    parameters: ['pointer', 'u32'],
    result: 'void'
  },
  gnutls_anti_replay_set_add_function: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  gnutls_anti_replay_set_ptr: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  gnutls_anti_replay_enable: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  gnutls_memset: {
    parameters: [
      'pointer',
      'i32',
      'usize'
    ],
    result: 'void'
  },
  gnutls_strerror: {
    parameters: ['i32'],
    result: 'pointer'
  },
  gnutls_certificate_server_set_request: {
    parameters: ['pointer', 'u32'],
    result: 'void'
  },
  gnutls_certificate_verify_peers3: {
    parameters: [
      'pointer',
      'buffer',
      'pointer'
    ],
    result: 'i32'
  },
  gnutls_certificate_get_peers: {
    parameters: ['pointer', 'pointer'],
    result: 'pointer'
  },
  gnutls_certificate_set_x509_trust_file: {
    parameters: [
      'pointer',
      'buffer',
      'i32'
    ],
    result: 'i32'
  },
  gnutls_certificate_set_x509_trust_dir: {
    parameters: [
      'pointer',
      'buffer',
      'i32'
    ],
    result: 'i32'
  },
  gnutls_certificate_set_x509_trust_mem: {
    parameters: [
      'pointer',
      'pointer',
      'i32'
    ],
    result: 'i32'
  }
};
const _LIBC_SYMBOLS = { free: {
  parameters: ['pointer'],
  result: 'void'
} };
function tryOpen<T extends Record<string, {
  parameters: string[];
  result: string;
}>>(paths: string[], symbols: T): ReturnType<typeof dlopen<T>> | null {
  for (const path of paths) {
    try {
      return dlopen(path, symbols);
    } catch {}
  }
  return null;
}
const _crypto = tryOpen(_CRYPTO_CANDIDATES, _CRYPTO_SYMBOLS);
const _gnutls = tryOpen(_GNUTLS_CANDIDATES, _GNUTLS_SYMBOLS);
const _libc = tryOpen(_IS_DARWIN ? ['/usr/lib/libSystem.B.dylib'] : ['libc.so.6', 'libc.so'], _LIBC_SYMBOLS);
/**
* Whether the GnuTLS QUIC backend can be used in this process.
*
* True only when all three shared libraries — `libngtcp2_crypto_gnutls`,
* `libgnutls`, and libc — were found and loaded at import time. When false,
* every factory in this module will throw, so callers (notably the `crypto`
* adapter) should gate on this and fall back to the OpenSSL backend.
*/
export const cryptoGnutlsAvailable = _crypto !== null && _gnutls !== null && _libc !== null;
/**
* The backend tag `'gnutls'` when this backend is available, otherwise `null`.
*
* Lets the generic crypto adapter report which TLS library backs a QUIC
* endpoint without inspecting the handles.
*/
export const cryptoBackend = cryptoGnutlsAvailable ? 'gnutls' : null;
/**
* The bound `ngtcp2_crypto_gnutls_*` symbols, or `null` if the backend failed to load.
*
* These are the ngtcp2 crypto entry points and packet-level helpers (retry
* tokens, stateless-reset tokens, connection-close encoding) shared with the
* ngtcp2 conn callbacks. Non-null exactly when `cryptoGnutlsAvailable` is true.
*/
export const sym = _crypto?.symbols ?? null;
/**
* Function pointers for the `ngtcp2_crypto_*` callbacks, or `null` if unavailable.
*
* These addresses are installed directly into an `ngtcp2_callbacks` struct so
* ngtcp2 can invoke the GnuTLS-backed encrypt/decrypt/HP-mask/key-update
* routines without a JavaScript trampoline. Non-null exactly when
* `cryptoGnutlsAvailable` is true.
*/
export const ptr = _crypto?.pointers ?? null;
/**
* The bound `libgnutls` symbols, or `null` if the backend failed to load.
*
* The raw GnuTLS C API used throughout this module to build credentials and
* sessions. Exposed so the crypto adapter can reach GnuTLS-only operations that
* have no ngtcp2 wrapper. Non-null exactly when `cryptoGnutlsAvailable` is true.
*/
export const gnutlsSym = _gnutls?.symbols ?? null;
type GnutlsCaOptions = {
  file?: string;
  directory?: string;
  pem?: string | Uint8Array | Array<string | Uint8Array>;
};
const GNUTLS_CERT_IGNORE = 0;
const GNUTLS_CERT_REQUEST = 1;
const GNUTLS_CERT_REQUIRE = 2;
const GNUTLS_SERVER = 1;
const GNUTLS_CLIENT = 2;
const GNUTLS_ENABLE_EARLY_DATA = 1 << 20;
const GNUTLS_NO_AUTO_SEND_TICKET = 1 << 21;
const GNUTLS_NO_END_OF_EARLY_DATA = 1 << 22;
const GNUTLS_CRD_CERTIFICATE = 1;
const GNUTLS_X509_FMT_PEM = 1;
const GNUTLS_ALPN_MAND = 1;
const GNUTLS_ALPN_SERVER_PRECEDENCE = 1 << 1;
const GNUTLS_NAME_DNS = 1;
const GNUTLS_HANDSHAKE_NEW_SESSION_TICKET = 4;
const GNUTLS_HOOK_POST = 1;
const GNUTLS_DATUM_SIZE = 16;
const GNUTLS_DATUM_DATA = 0;
const GNUTLS_DATUM_SIZE_OFFSET = 8;
const GNUTLS_E_DB_ENTRY_EXISTS = -428;
const GNUTLS_QUIC_PRIORITY = '%DISABLE_TLS13_COMPAT_MODE:NORMAL';
const GNUTLS_CIPHER_PRIORITIES: Record<string, string> = {
  TLS_AES_128_GCM_SHA256: 'AES-128-GCM',
  TLS_AES_256_GCM_SHA384: 'AES-256-GCM',
  TLS_CHACHA20_POLY1305_SHA256: 'CHACHA20-POLY1305'
};
let _initialized = false;
let _gettimeCallback: FfiCallback | null = null;
let _truncateTicketTimestamp = false;
function cstr(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const out = new Uint8Array(bytes.byteLength + 1);
  out.set(bytes);
  return out;
}
function readCStr(ptr: ArrayBuffer): string {
  const bytes: number[] = [];
  for (let i = 0;; i++) {
    const b = Pointer.readU8(ptr, i);
    if (b === 0) break;
    bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
function readNullableCStr(ptr: ArrayBuffer | null): string {
  return ptr === null ? '' : readCStr(ptr);
}
function errorString(code: number): string {
  try {
    const ptr = gnutlsSym?.gnutls_strerror(code) as ArrayBuffer | null;
    if (ptr !== null && ptr !== undefined) return readCStr(ptr);
  } catch {}
  return String(code);
}
function check(rc: number, context: string): void {
  if (rc < 0) throw new Error(`${context}: ${errorString(rc)} (${rc})`);
}
function pointerAddress(handle: ArrayBuffer, offset = 0): bigint {
  return new DataView(handle).getBigUint64(offset, true);
}
function pointerField(buf: ArrayBuffer, offset: number): ArrayBuffer | null {
  const addr = pointerAddress(buf, offset);
  if (addr === 0n) return null;
  const out = new ArrayBuffer(8);
  new DataView(out).setBigUint64(0, addr, true);
  return out;
}
function datumBytes(datum: ArrayBuffer | null): Uint8Array {
  if (datum === null) return new Uint8Array();
  const data = Pointer.readPointer(datum, GNUTLS_DATUM_DATA) as ArrayBuffer | null;
  const len = Pointer.readU32(datum, GNUTLS_DATUM_SIZE_OFFSET) as number;
  if (data === null || len === 0) return new Uint8Array();
  return Pointer.copyFrom(data, len) as Uint8Array;
}
function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}
function checkedPointerHandle(out: ArrayBuffer, context: string): ArrayBuffer {
  if (pointerAddress(out) === 0n) throw new Error(`${context} returned NULL`);
  return out;
}
function makeAlpnDatums(protocols: string[]): {
  datums: ArrayBuffer;
  keepalive: Uint8Array[];
} {
  const datums = new ArrayBuffer(protocols.length * GNUTLS_DATUM_SIZE);
  const view = new DataView(datums);
  const keepalive: Uint8Array[] = [];
  for (let i = 0; i < protocols.length; i++) {
    const bytes = new TextEncoder().encode(protocols[i]);
    keepalive.push(bytes);
    const offset = i * GNUTLS_DATUM_SIZE;
    view.setBigUint64(offset + GNUTLS_DATUM_DATA, Pointer.addr(bytes) as bigint, true);
    view.setUint32(offset + GNUTLS_DATUM_SIZE_OFFSET, bytes.byteLength, true);
  }
  return {
    datums,
    keepalive
  };
}
function newGnutlsTicketKey(): ArrayBuffer {
  const key = new ArrayBuffer(GNUTLS_DATUM_SIZE);
  check(gnutlsSym!.gnutls_session_ticket_key_generate(Pointer.of(key)) as number, 'gnutls_session_ticket_key_generate');
  return key;
}
type GnutlsAntiReplay = {
  handle: ArrayBuffer;
  addCallback: FfiCallback;
  entries: Map<string, bigint>;
};
function newGnutlsAntiReplay(): GnutlsAntiReplay {
  const out = new ArrayBuffer(8);
  check(gnutlsSym!.gnutls_anti_replay_init(Pointer.of(out)) as number, 'gnutls_anti_replay_init');
  const antiReplay = checkedPointerHandle(out, 'gnutls_anti_replay_init');
  const entries = new Map<string, bigint>();
  const addCallback = new FfiCallback({
    parameters: [
      'pointer',
      'i64',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  }, (_ptr: ArrayBuffer | null, expTime: bigint | number, key: ArrayBuffer | null, _data: ArrayBuffer | null) => {
    const now = BigInt(Math.floor(Date.now() / 1e3));
    for (const [entry, expires] of entries) {
      if (expires <= now) entries.delete(entry);
    }
    const expires = typeof expTime === 'bigint' ? expTime : BigInt(expTime);
    const entry = hex(datumBytes(key));
    const existing = entries.get(entry);
    if (existing !== undefined && existing > now) {
      return GNUTLS_E_DB_ENTRY_EXISTS;
    }
    entries.set(entry, expires);
    return 0;
  });
  gnutlsSym!.gnutls_anti_replay_set_add_function(antiReplay, addCallback.pointer);
  gnutlsSym!.gnutls_anti_replay_set_ptr(antiReplay, null);
  return {
    handle: antiReplay,
    addCallback,
    entries
  };
}
function freeGnutlsTicketKey(key: ArrayBuffer): void {
  const data = pointerField(key, GNUTLS_DATUM_DATA);
  const size = new DataView(key).getUint32(GNUTLS_DATUM_SIZE_OFFSET, true);
  if (data === null || size === 0) return;
  gnutlsSym!.gnutls_memset(data, 0, size);
  _libc!.symbols.free(data);
}
function enableServerSessionTickets(session: ArrayBuffer, key: ArrayBuffer | null): void {
  if (key === null) return;
  check(gnutlsSym!.gnutls_session_ticket_enable_server(session, Pointer.of(key)) as number, 'gnutls_session_ticket_enable_server');
}
function priorityString(cipherSuites: readonly string[] | null): string {
  if (cipherSuites === null) return GNUTLS_QUIC_PRIORITY;
  const ciphers = cipherSuites.map((suite) => {
    const priority = GNUTLS_CIPHER_PRIORITIES[suite];
    if (priority === undefined) throw new TypeError(`Unsupported GnuTLS QUIC TLS cipher suite: ${suite}`);
    return `+${priority}`;
  });
  return `${GNUTLS_QUIC_PRIORITY}:-CIPHER-ALL:${ciphers.join(':')}`;
}
/**
* Asserts that the GnuTLS QUIC backend loaded, throwing a specific error otherwise.
*
* Throws `Error` naming the first missing library — `libngtcp2_crypto_gnutls`,
* `libgnutls`, or libc — so a misconfigured host produces an actionable message
* instead of a null-dereference later. Use it as a guard before reaching for
* `sym`, `ptr`, or `gnutlsSym` directly; the higher-level factories call it for
* you.
*
* ```ts no_run
*   import { requireCryptoGnutls, gnutlsSym } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   requireCryptoGnutls(); // throws if GnuTLS is not installed
*   // gnutlsSym is now guaranteed non-null
* ```
*/
export function requireCryptoGnutls(): void {
  if (_crypto === null) throw new Error('libngtcp2_crypto_gnutls not found');
  if (_gnutls === null) throw new Error('libgnutls not found');
  if (_libc === null) throw new Error('libc not found');
}
/**
* Performs one-time global GnuTLS initialization for this process.
*
* Idempotent: the first call runs `gnutls_global_init` and installs a custom
* gettime function so session-ticket timestamps derive from `Date.now()` rather
* than the raw system clock, letting `sendGnutlsSessionTicket` emit
* deterministic second-granularity times. Subsequent calls return immediately.
* Throws via `requireCryptoGnutls()` when the backend is unavailable, or if
* `gnutls_global_init` itself fails.
*
* Every credential and session factory calls this, so you rarely invoke it
* directly; do so only when preparing to use `gnutlsSym` by hand.
*/
export function initCryptoGnutls(): void {
  requireCryptoGnutls();
  if (_initialized) return;
  check(gnutlsSym!.gnutls_global_init() as number, 'gnutls_global_init');
  _gettimeCallback = new FfiCallback({
    parameters: ['pointer'],
    result: 'void'
  }, (timespec: ArrayBuffer | null) => {
    if (timespec === null) return;
    const nowMs = Date.now();
    const sec = BigInt(Math.floor(nowMs / 1e3));
    const nsec = _truncateTicketTimestamp ? 0n : BigInt(nowMs % 1e3 * 1e6);
    Pointer.writeI64(timespec, 0, sec);
    Pointer.writeI64(timespec, 8, nsec);
  });
  gnutlsSym!._gnutls_global_set_gettime_function(_gettimeCallback.pointer);
  _initialized = true;
}
/**
* A GnuTLS certificate-credentials handle plus the server-side state bound to it.
*
* Returned by `newGnutlsCredentials` and reused across many sessions of the
* same role. Must be released with `freeGnutlsCredentials` — it owns native
* memory (the credentials object, and for servers a session-ticket key and an
* anti-replay table with a live FFI callback) that otherwise leaks.
*/
export type GnutlsCredentials = {
  /** The `gnutls_certificate_credentials_t` handle as a pointer-sized `ArrayBuffer`. */
  handle: ArrayBuffer;
  /** Server-only key used to encrypt session tickets; `null` for client credentials. */
  ticketKey: ArrayBuffer | null;
  /** Server-only 0-RTT anti-replay table guarding against early-data replay; `null` for clients. */
  antiReplay: GnutlsAntiReplay | null;
  /** Whether, and how strictly, a server asks the client for a certificate. */
  clientAuth: 'none' | 'request' | 'require';
  /** Whether a failed peer-certificate verification should abort the handshake. */
  rejectUnauthorized: boolean;
};
function configureGnutlsCa(cred: ArrayBuffer, ca: GnutlsCaOptions | undefined, verifyPeer: boolean): void {
  if (ca !== undefined) {
    if (ca.file !== undefined) {
      check(gnutlsSym!.gnutls_certificate_set_x509_trust_file(cred, cstr(ca.file), GNUTLS_X509_FMT_PEM) as number, 'gnutls_certificate_set_x509_trust_file');
    }
    if (ca.directory !== undefined) {
      check(gnutlsSym!.gnutls_certificate_set_x509_trust_dir(cred, cstr(ca.directory), GNUTLS_X509_FMT_PEM) as number, 'gnutls_certificate_set_x509_trust_dir');
    }
    if (ca.pem !== undefined) {
      const pems = Array.isArray(ca.pem) ? ca.pem : [ca.pem];
      for (const pem of pems) {
        const bytes = typeof pem === 'string' ? new TextEncoder().encode(pem) : pem;
        const datum = new ArrayBuffer(GNUTLS_DATUM_SIZE);
        const view = new DataView(datum);
        view.setBigUint64(GNUTLS_DATUM_DATA, Pointer.addr(bytes) as bigint, true);
        view.setUint32(GNUTLS_DATUM_SIZE_OFFSET, bytes.byteLength, true);
        check(gnutlsSym!.gnutls_certificate_set_x509_trust_mem(cred, Pointer.of(datum), GNUTLS_X509_FMT_PEM) as number, 'gnutls_certificate_set_x509_trust_mem');
        void bytes;
      }
    }
  } else if (verifyPeer) {
    check(gnutlsSym!.gnutls_certificate_set_x509_system_trust(cred) as number, 'gnutls_certificate_set_x509_system_trust');
  }
}
/**
* Allocates GnuTLS certificate credentials for a client or server role.
*
* Runs `initCryptoGnutls()` first. A `'server'` role requires both `certFile`
* and `keyFile` (PEM paths) and additionally provisions a fresh session-ticket
* key and an anti-replay table for 0-RTT; it throws if either file is missing. A
* `'client'` role may optionally present its own certificate (for mutual TLS) by
* passing both files, and configures trust anchors: when `ca` is given its
* file/directory/PEM entries are loaded, otherwise if `verifyPeer` is true the
* system trust store is used. Throws, carrying the underlying GnuTLS error
* string, if any GnuTLS call fails.
*
* The returned record owns native memory; release it with
* `freeGnutlsCredentials`.
*
* ```ts no_run
*   import { newGnutlsCredentials, freeGnutlsCredentials } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   // Server: certificate + private key are mandatory.
*   const server = newGnutlsCredentials('server', '/etc/tls/cert.pem', '/etc/tls/key.pem');
*
*   // Client verifying the server against the system trust store.
*   const client = newGnutlsCredentials('client', undefined, undefined, true);
*
*   freeGnutlsCredentials(server);
*   freeGnutlsCredentials(client);
* ```
*/
export function newGnutlsCredentials(role: 'client' | 'server', certFile?: string, keyFile?: string, verifyPeer = false, ca?: GnutlsCaOptions): GnutlsCredentials {
  initCryptoGnutls();
  const out = new ArrayBuffer(8);
  check(gnutlsSym!.gnutls_certificate_allocate_credentials(Pointer.of(out)) as number, 'gnutls_certificate_allocate_credentials');
  const cred = checkedPointerHandle(out, 'gnutls_certificate_allocate_credentials');
  if (role === 'server') {
    if (certFile === undefined || keyFile === undefined) throw new Error('GnuTLS server credentials require certificate and key files');
    check(gnutlsSym!.gnutls_certificate_set_x509_key_file(cred, cstr(certFile), cstr(keyFile), GNUTLS_X509_FMT_PEM) as number, 'gnutls_certificate_set_x509_key_file');
  } else {
    if (certFile !== undefined && keyFile !== undefined) {
      check(gnutlsSym!.gnutls_certificate_set_x509_key_file(cred, cstr(certFile), cstr(keyFile), GNUTLS_X509_FMT_PEM) as number, 'gnutls_certificate_set_x509_key_file');
    }
    configureGnutlsCa(cred, ca, verifyPeer);
  }
  return {
    handle: cred,
    ticketKey: role === 'server' ? newGnutlsTicketKey() : null,
    antiReplay: role === 'server' ? newGnutlsAntiReplay() : null,
    clientAuth: 'none',
    rejectUnauthorized: true
  };
}
/**
* Enables mutual TLS on already-allocated server credentials.
*
* When `clientAuth` is `'request'` or `'require'`, loads the client-CA trust
* anchors from `ca` (or the system trust store if `ca` is omitted) and records
* the requested auth mode and `rejectUnauthorized` flag on the credentials, so
* `newGnutlsSession` asks peers for a certificate and `getGnutlsVerifyResult`
* can report the outcome. A `clientAuth` of `'none'` is a no-op. Throws if
* loading the trust anchors fails.
*
* ```ts no_run
*   import { newGnutlsCredentials, configureGnutlsServerMtls } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   const creds = newGnutlsCredentials('server', '/etc/tls/cert.pem', '/etc/tls/key.pem');
*   configureGnutlsServerMtls(creds, 'require', { file: '/etc/tls/client-ca.pem' });
* ```
*/
export function configureGnutlsServerMtls(cred: GnutlsCredentials, clientAuth: 'none' | 'request' | 'require', ca?: GnutlsCaOptions, rejectUnauthorized = true): void {
  if (clientAuth !== 'none') {
    configureGnutlsCa(cred.handle, ca, true);
    cred.clientAuth = clientAuth;
    cred.rejectUnauthorized = rejectUnauthorized;
  }
}
/**
* Releases every native resource held by a `GnutlsCredentials` record.
*
* Wipes and frees the server ticket key, deinitializes the anti-replay table
* and closes its FFI callback, then frees the underlying GnuTLS credentials
* object. Safe for either role. Do not use the record afterward, and free it
* only once all sessions built from it have themselves been freed.
*/
export function freeGnutlsCredentials(cred: GnutlsCredentials): void {
  if (cred.ticketKey !== null) freeGnutlsTicketKey(cred.ticketKey);
  if (cred.antiReplay !== null) {
    gnutlsSym!.gnutls_anti_replay_deinit(cred.antiReplay.handle);
    cred.antiReplay.addCallback.close();
  }
  gnutlsSym!.gnutls_certificate_free_credentials(cred.handle);
}
/**
* A GnuTLS TLS session handle plus the JavaScript state that must outlive it.
*
* Produced by `newGnutlsSession`, one per QUIC connection. Alongside the raw
* session handle it retains the buffers and FFI callbacks (SNI hostname, ALPN
* datums, ticket and keylog hooks) that GnuTLS references by pointer, so they
* are not garbage-collected mid-handshake. Release it with `freeGnutlsSession`.
*/
export type GnutlsSession = {
  /** The `gnutls_session_t` handle as a pointer-sized `ArrayBuffer`. */
  handle: ArrayBuffer;
  /** NUL-terminated SNI hostname kept alive for GnuTLS; `null` for servers or unnamed clients. */
  hostname: Uint8Array | null;
  /** ALPN protocol byte strings retained so the datum array handed to GnuTLS stays valid. */
  alpnBytes: Uint8Array[];
  /** Whether this session is the QUIC client or server end. */
  role: 'client' | 'server';
  /** The credentials this session draws its certificate and trust configuration from. */
  credentials: GnutlsCredentials;
  /** Maximum 0-RTT early-data size in bytes; `0` disables early data. */
  earlyDataMax: number;
  /** Whether server early-data enforcement has already been wired up by `configureGnutlsSession`. */
  earlyDataConfigured: boolean;
  /** Whether the ngtcp2 crypto callbacks have already been installed on this session. */
  configured: boolean;
  /** Live FFI callback for the new-session-ticket handshake hook, or `null` when none is set. */
  ticketHook: FfiCallback | null;
  /** Live FFI callback delivering TLS key-log lines, or `null` when key logging is off. */
  keylogHook: FfiCallback | null;
};
function gnutlsClientRandom(session: ArrayBuffer): Uint8Array {
  const client = new ArrayBuffer(GNUTLS_DATUM_SIZE);
  const server = new ArrayBuffer(GNUTLS_DATUM_SIZE);
  gnutlsSym!.gnutls_session_get_random(session, Pointer.of(client), Pointer.of(server));
  return datumBytes(client);
}
function setGnutlsKeylogCallback(session: GnutlsSession, onKeylogLine: ((line: string) => void) | undefined): void {
  if (onKeylogLine === undefined) return;
  session.keylogHook = new FfiCallback({
    parameters: [
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  }, (sessionPtr: ArrayBuffer | null, labelPtr: ArrayBuffer | null, secretPtr: ArrayBuffer | null) => {
    if (sessionPtr === null || labelPtr === null || secretPtr === null) return 0;
    const label = readCStr(labelPtr);
    const clientRandom = gnutlsClientRandom(sessionPtr);
    const secret = datumBytes(secretPtr);
    if (label.length > 0 && clientRandom.byteLength > 0 && secret.byteLength > 0) {
      onKeylogLine(`${label} ${hex(clientRandom)} ${hex(secret)}`);
    }
    return 0;
  });
  gnutlsSym!.gnutls_session_set_keylog_function(session.handle, session.keylogHook.pointer);
}
/**
* Creates and provisions a GnuTLS session for one QUIC connection.
*
* Runs `initCryptoGnutls()`, then initializes a session in the given `role`,
* applies the QUIC-mandated priority string (optionally narrowed to the given
* TLS 1.3 `cipherSuites`), attaches the `credentials`, and installs the ALPN
* `protocols`. For a server it enables session tickets and, if the credentials
* requested it, client-certificate auth. For a client that passes `serverName`
* it sets SNI and, when `verifyPeer` is true, hostname verification.
* `earlyDataMax` greater than zero arms 0-RTT early data (finalized later by
* `configureGnutlsSession`). When `onKeylogLine` is supplied, TLS secrets are
* emitted as NSS key-log lines for debugging.
*
* Throws if any GnuTLS call fails, deinitializing the half-built session first
* so nothing leaks. `cipherSuites` entries must each be one of the QUIC TLS 1.3
* suites (`TLS_AES_128_GCM_SHA256`, `TLS_AES_256_GCM_SHA384`,
* `TLS_CHACHA20_POLY1305_SHA256`); any other value throws `TypeError`. Release
* the result with `freeGnutlsSession`.
*
* ```ts no_run
*   import { newGnutlsCredentials, newGnutlsSession, freeGnutlsSession } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   const creds = newGnutlsCredentials('client');
*   const session = newGnutlsSession('client', creds, ['h3'], 'example.com', true);
*   // ... drive the handshake ...
*   freeGnutlsSession(session);
* ```
*/
export function newGnutlsSession(role: 'client' | 'server', credentials: GnutlsCredentials, protocols: string[], serverName?: string, verifyPeer = false, earlyDataMax = 0, cipherSuites: readonly string[] | null = null, onKeylogLine?: (line: string) => void): GnutlsSession {
  initCryptoGnutls();
  const out = new ArrayBuffer(8);
  const flags = (role === 'server' ? GNUTLS_SERVER | GNUTLS_NO_AUTO_SEND_TICKET : GNUTLS_CLIENT) | (earlyDataMax > 0 ? GNUTLS_ENABLE_EARLY_DATA | GNUTLS_NO_END_OF_EARLY_DATA : 0);
  check(gnutlsSym!.gnutls_init(Pointer.of(out), flags) as number, 'gnutls_init');
  const session = checkedPointerHandle(out, 'gnutls_init');
  try {
    check(gnutlsSym!.gnutls_priority_set_direct(session, cstr(priorityString(cipherSuites)), null) as number, 'gnutls_priority_set_direct');
    if (role === 'server') enableServerSessionTickets(session, credentials.ticketKey);
    check(gnutlsSym!.gnutls_credentials_set(session, GNUTLS_CRD_CERTIFICATE, credentials.handle) as number, 'gnutls_credentials_set');
    if (role === 'server' && credentials.clientAuth !== 'none') {
      const requestMode = credentials.clientAuth === 'require' ? GNUTLS_CERT_REQUIRE : GNUTLS_CERT_REQUEST;
      gnutlsSym!.gnutls_certificate_server_set_request(session, requestMode);
    }
    const alpn = makeAlpnDatums(protocols);
    const alpnFlags = role === 'server' ? GNUTLS_ALPN_MAND | GNUTLS_ALPN_SERVER_PRECEDENCE : GNUTLS_ALPN_MAND;
    check(gnutlsSym!.gnutls_alpn_set_protocols(session, Pointer.of(alpn.datums), protocols.length, alpnFlags) as number, 'gnutls_alpn_set_protocols');
    let hostname: Uint8Array | null = null;
    if (role === 'client' && serverName !== undefined) {
      hostname = cstr(serverName);
      check(gnutlsSym!.gnutls_server_name_set(session, GNUTLS_NAME_DNS, hostname, hostname.byteLength - 1) as number, 'gnutls_server_name_set');
      if (verifyPeer) gnutlsSym!.gnutls_session_set_verify_cert(session, hostname, 0);
    }
    const outSession = {
      handle: session,
      hostname,
      alpnBytes: alpn.keepalive,
      role,
      credentials,
      earlyDataMax,
      earlyDataConfigured: false,
      configured: false,
      ticketHook: null,
      keylogHook: null
    };
    setGnutlsKeylogCallback(outSession, onKeylogLine);
    return outSession;
  } catch (error) {
    gnutlsSym!.gnutls_deinit(session);
    throw error;
  }
}
/**
* Deinitializes a GnuTLS session and closes the FFI callbacks bound to it.
*
* Detaches and closes the ticket and keylog hooks before calling
* `gnutls_deinit`, so no native callback outlives the session. The associated
* `GnutlsCredentials` are not freed — they are shared across sessions and must
* be released separately with `freeGnutlsCredentials`.
*/
export function freeGnutlsSession(session: GnutlsSession): void {
  const ticketHook = session.ticketHook;
  const keylogHook = session.keylogHook;
  session.ticketHook = null;
  session.keylogHook = null;
  gnutlsSym!.gnutls_deinit(session.handle);
  ticketHook?.close();
  keylogHook?.close();
}
/**
* Points the session's user pointer at an ngtcp2 connection reference.
*
* ngtcp2's GnuTLS crypto callbacks reach the owning connection through the
* session's user pointer, which they expect to hold an `ngtcp2_crypto_conn_ref`.
* Pass the conn-ref buffer to wire them together, or `null` to clear it — for
* example before tearing the connection down.
*/
export function setGnutlsConnectionRef(session: GnutlsSession, connRef: ArrayBuffer | null): void {
  gnutlsSym!.gnutls_session_set_ptr(session.handle, connRef === null ? null : Pointer.of(connRef));
}
/**
* Installs ngtcp2's crypto callbacks onto the session and finalizes early data.
*
* Idempotent per session. Calls `ngtcp2_crypto_gnutls_configure_client_session`
* or `..._server_session` to hook GnuTLS into ngtcp2's TLS message flow. For a
* server with early data enabled it also turns on anti-replay protection and
* sets the maximum early-data size. Throws if the ngtcp2 configure call returns
* non-zero or a GnuTLS call fails. Call once after `newGnutlsSession`, before
* driving the handshake.
*
* ```ts no_run
*   import { newGnutlsCredentials, newGnutlsSession, configureGnutlsSession } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   const creds = newGnutlsCredentials('server', '/etc/tls/cert.pem', '/etc/tls/key.pem');
*   const session = newGnutlsSession('server', creds, ['h3']);
*   configureGnutlsSession('server', session);
* ```
*/
export function configureGnutlsSession(role: 'client' | 'server', session: GnutlsSession): void {
  if (session.configured) return;
  const rc = role === 'server' ? sym!.ngtcp2_crypto_gnutls_configure_server_session(session.handle) : sym!.ngtcp2_crypto_gnutls_configure_client_session(session.handle);
  if (rc !== 0) throw new Error(`ngtcp2_crypto_gnutls_configure_${role}_session failed: ${rc}`);
  session.configured = true;
  if (role === 'server' && session.earlyDataMax > 0 && !session.earlyDataConfigured) {
    if (session.credentials.antiReplay !== null) gnutlsSym!.gnutls_anti_replay_enable(session.handle, session.credentials.antiReplay.handle);
    check(gnutlsSym!.gnutls_record_set_max_early_data_size(session.handle, session.earlyDataMax) as number, 'gnutls_record_set_max_early_data_size');
    session.earlyDataConfigured = true;
  }
}
/**
* Installs or removes a hook that fires when GnuTLS issues a new session ticket.
*
* Passing a callback registers a post-handshake hook on the new-session-ticket
* message; each time a ticket is generated the hook exports the session
* (`exportGnutlsSession`) and hands the serialized bytes to the callback for
* storage or transmission to the client. Passing `null` removes a previously
* installed hook and closes its FFI callback. Replacing an existing callback
* tears down the old one first. Server-side in practice.
*
* ```ts no_run
*   import { setGnutlsSessionTicketCallback } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   setGnutlsSessionTicketCallback(session, (ticket) => {
*     sendToClient(ticket); // opaque resumption blob
*   });
* ```
*/
export function setGnutlsSessionTicketCallback(session: GnutlsSession, callback: ((ticket: Uint8Array) => void) | null): void {
  if (session.ticketHook !== null) {
    gnutlsSym!.gnutls_handshake_set_hook_function(session.handle, GNUTLS_HANDSHAKE_NEW_SESSION_TICKET, GNUTLS_HOOK_POST, null);
    session.ticketHook.close();
    session.ticketHook = null;
  }
  if (callback === null) return;
  session.ticketHook = new FfiCallback({
    parameters: [
      'pointer',
      'u32',
      'u32',
      'u32',
      'pointer'
    ],
    result: 'i32'
  }, (_session: ArrayBuffer | null, htype: number, when: number, _incoming: number, _msg: ArrayBuffer | null) => {
    if (htype !== GNUTLS_HANDSHAKE_NEW_SESSION_TICKET || when !== GNUTLS_HOOK_POST) return 0;
    const ticket = exportGnutlsSession(session);
    if (ticket !== null && ticket.byteLength > 0) callback(ticket);
    return 0;
  });
  gnutlsSym!.gnutls_handshake_set_hook_function(session.handle, GNUTLS_HANDSHAKE_NEW_SESSION_TICKET, GNUTLS_HOOK_POST, session.ticketHook.pointer);
}
/**
* Sends `count` NewSessionTicket messages to the peer.
*
* Wraps `gnutls_session_ticket_send`, temporarily truncating ticket timestamps
* to whole seconds (through the custom gettime function installed by
* `initCryptoGnutls`) so the emitted tickets carry deterministic,
* second-granularity times. Throws if the GnuTLS call fails. Server-side; call
* after the handshake completes to grant the client resumption tickets.
*/
export function sendGnutlsSessionTicket(session: GnutlsSession, count = 1): void {
  _truncateTicketTimestamp = true;
  try {
    check(gnutlsSym!.gnutls_session_ticket_send(session.handle, count, 0) as number, 'gnutls_session_ticket_send');
  } finally {
    _truncateTicketTimestamp = false;
  }
}
/**
* Serializes the session into an opaque blob for later resumption.
*
* Wraps `gnutls_session_get_data2`, copying GnuTLS's allocated buffer into a
* `Uint8Array` and freeing the C allocation. Returns `null` when no session data
* is available yet — for example before a ticket has been issued. The bytes are
* GnuTLS-specific and only meaningful to `importGnutlsSession`.
*/
export function exportGnutlsSession(session: GnutlsSession): Uint8Array | null {
  const datum = new ArrayBuffer(GNUTLS_DATUM_SIZE);
  const rc = gnutlsSym!.gnutls_session_get_data2(session.handle, Pointer.of(datum)) as number;
  if (rc !== 0) return null;
  const data = pointerField(datum, GNUTLS_DATUM_DATA);
  const len = new DataView(datum).getUint32(GNUTLS_DATUM_SIZE_OFFSET, true);
  if (data === null || len === 0) return null;
  try {
    return Pointer.copyFrom(data, len) as Uint8Array;
  } finally {
    _libc!.symbols.free(data);
  }
}
/**
* Loads a previously exported session blob to attempt TLS resumption.
*
* Wraps `gnutls_session_set_data` with the bytes from `exportGnutlsSession`.
* Returns true when GnuTLS accepted the data, false otherwise — for example if
* the blob is malformed or from an incompatible session. Call on a fresh client
* session before the handshake to offer resumption or 0-RTT.
*
* ```ts no_run
*   import { newGnutlsSession, importGnutlsSession } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   const session = newGnutlsSession('client', creds, ['h3'], 'example.com');
*   if (savedTicket) importGnutlsSession(session, savedTicket);
* ```
*/
export function importGnutlsSession(session: GnutlsSession, data: Uint8Array): boolean {
  return gnutlsSym!.gnutls_session_set_data(session.handle, data, data.byteLength) as number === 0;
}
/**
* Returns the ALPN protocol GnuTLS negotiated, or the empty string.
*
* Yields `''` when the session is `null`, no protocol was selected, or the
* handshake has not yet reached ALPN selection. After a successful handshake
* this is the agreed application protocol, for example `'h3'`.
*/
export function getGnutlsAlpnSelected(session: GnutlsSession | null): string {
  if (session === null) return '';
  const datum = new ArrayBuffer(GNUTLS_DATUM_SIZE);
  const rc = gnutlsSym!.gnutls_alpn_get_selected_protocol(session.handle, Pointer.of(datum)) as number;
  if (rc !== 0) return '';
  const data = pointerField(datum, GNUTLS_DATUM_DATA);
  const len = new DataView(datum).getUint32(GNUTLS_DATUM_SIZE_OFFSET, true);
  if (data === null || len === 0) return '';
  return new TextDecoder().decode(Pointer.copyFrom(data, len) as Uint8Array);
}
/**
* Returns the SNI hostname associated with the session, or `null`.
*
* Reports the server name recorded when a client session was created with a
* `serverName`; returns `null` for server sessions and for clients that set no
* SNI. Decoded from the retained NUL-terminated buffer with the trailing NUL
* stripped.
*/
export function getGnutlsServername(session: GnutlsSession | null): string | null {
  if (session?.hostname == null) return null;
  const bytes = session.hostname.subarray(0, Math.max(0, session.hostname.byteLength - 1));
  return new TextDecoder().decode(bytes);
}
/**
* Returns the negotiated cipher suite and TLS protocol version names.
*
* After the handshake `cipher` is the AEAD cipher name (for example
* `'AES-256-GCM'`) and `cipherVersion` the protocol name (for example
* `'TLS1.3'`); either is `null` when unavailable. A `null` session yields both
* `null`.
*/
export function getGnutlsCipherInfo(session: GnutlsSession | null): {
  cipher: string | null;
  cipherVersion: string | null;
} {
  if (session === null) return {
    cipher: null,
    cipherVersion: null
  };
  const cipherId = gnutlsSym!.gnutls_cipher_get(session.handle) as number;
  const protocolId = gnutlsSym!.gnutls_protocol_get_version(session.handle) as number;
  return {
    cipher: readNullableCStr(gnutlsSym!.gnutls_cipher_get_name(cipherId) as ArrayBuffer | null) || null,
    cipherVersion: readNullableCStr(gnutlsSym!.gnutls_protocol_get_name(protocolId) as ArrayBuffer | null) || null
  };
}
/**
* Returns the peer's leaf certificate in DER form, or `null`.
*
* Reads the first entry of the peer certificate chain GnuTLS captured during
* the handshake. Returns `null` when the session is `null`, the peer sent no
* certificate, or the entry is empty — for a server this is the client
* certificate (present only under mutual TLS), for a client the server
* certificate.
*/
export function getGnutlsPeerCertificate(session: GnutlsSession | null): Uint8Array | null {
  if (session === null) return null;
  const countBuf = new ArrayBuffer(4);
  const peers = gnutlsSym!.gnutls_certificate_get_peers(session.handle, Pointer.of(countBuf)) as ArrayBuffer | null;
  if (peers === null) return null;
  const count = new DataView(countBuf).getUint32(0, true);
  if (count === 0) return null;
  const cert = datumBytes(peers);
  return cert.byteLength > 0 ? cert : null;
}
/**
* Derives exported keying material via the RFC 5705 TLS exporter.
*
* Runs `gnutls_prf_rfc5705` with the given `label` and `context` to produce
* `length` bytes of key material bound to the session — used, for example, to
* derive application-layer keys tied to the QUIC/TLS handshake. Throws
* `RangeError` if `length` is not a non-negative integer, and throws if the
* GnuTLS PRF call fails. Returns the derived bytes as an `ArrayBuffer`.
*
* ```ts no_run
*   import { exportGnutlsKeyingMaterial } from 'internal:net/quic/ngtcp2/crypto-gnutls';
*
*   const key = exportGnutlsKeyingMaterial(session, 'EXPORTER-my-app', new Uint8Array(0), 32);
* ```
*/
export function exportGnutlsKeyingMaterial(session: GnutlsSession, label: string, context: Uint8Array, length: number): ArrayBuffer {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('TLS exporter length must be a non-negative integer');
  const labelBytes = new TextEncoder().encode(label);
  const out = new Uint8Array(length);
  check(gnutlsSym!.gnutls_prf_rfc5705(session.handle, labelBytes.byteLength, labelBytes, context.byteLength, context, out.byteLength, out) as number, 'gnutls_prf_rfc5705');
  return out.buffer;
}
/**
* Reports the result of peer-certificate verification.
*
* Returns `{ code: 0, reason: null }` when the peer certificate verified
* cleanly (or when the session is `null`). A negative `code` with a GnuTLS error
* string in `reason` means the verification call itself failed; a positive
* `code` is the GnuTLS verification-status bitmask with a descriptive `reason`.
* Consult it after the handshake to decide whether to accept a peer under the
* credentials' `rejectUnauthorized` policy.
*/
export function getGnutlsVerifyResult(session: GnutlsSession | null): {
  code: number;
  reason: string | null;
} {
  if (session === null) return {
    code: 0,
    reason: null
  };
  const statusBuf = new ArrayBuffer(4);
  const hostname = session.hostname;
  const rc = gnutlsSym!.gnutls_certificate_verify_peers3(session.handle, hostname !== null ? hostname : new Uint8Array(), Pointer.of(statusBuf)) as number;
  if (rc < 0) return {
    code: rc,
    reason: errorString(rc)
  };
  const status = new DataView(statusBuf).getUint32(0, true);
  if (status === 0) return {
    code: 0,
    reason: null
  };
  return {
    code: status,
    reason: `certificate verification failed (status=${status})`
  };
}
