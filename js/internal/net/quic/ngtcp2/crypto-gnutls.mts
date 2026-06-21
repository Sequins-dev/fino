/**
 * internal:net/quic/ngtcp2/crypto-gnutls — ngtcp2 GnuTLS crypto helpers.
 *
 * Loads `libngtcp2_crypto_gnutls` plus `libgnutls` and exposes the minimal
 * QUIC TLS session operations needed by the generic QUIC endpoint adapter.
 *
 * @internal
 */

import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';

export { Pointer };

const _IS_DARWIN = os === 'darwin';

const _CRYPTO_CANDIDATES = _IS_DARWIN
  ? [
      '/opt/homebrew/opt/libngtcp2/lib/libngtcp2_crypto_gnutls.dylib',
      '/opt/homebrew/lib/libngtcp2_crypto_gnutls.dylib',
      '/usr/local/opt/libngtcp2/lib/libngtcp2_crypto_gnutls.dylib',
      '/usr/local/lib/libngtcp2_crypto_gnutls.dylib',
      '/opt/local/lib/libngtcp2_crypto_gnutls.dylib',
    ]
  : [
      'libngtcp2_crypto_gnutls.so.8',
      'libngtcp2_crypto_gnutls.so.2',
      'libngtcp2_crypto_gnutls.so',
      '/usr/lib/x86_64-linux-gnu/libngtcp2_crypto_gnutls.so.8',
      '/usr/lib/aarch64-linux-gnu/libngtcp2_crypto_gnutls.so.8',
      '/usr/lib/x86_64-linux-gnu/libngtcp2_crypto_gnutls.so.2',
      '/usr/lib/aarch64-linux-gnu/libngtcp2_crypto_gnutls.so.2',
      '/usr/local/lib/libngtcp2_crypto_gnutls.so',
    ];

const _GNUTLS_CANDIDATES = _IS_DARWIN
  ? [
      '/opt/homebrew/opt/gnutls/lib/libgnutls.dylib',
      '/opt/homebrew/lib/libgnutls.dylib',
      '/usr/local/opt/gnutls/lib/libgnutls.dylib',
      '/usr/local/lib/libgnutls.dylib',
      '/opt/local/lib/libgnutls.dylib',
    ]
  : [
      'libgnutls.so.30',
      'libgnutls.so',
      '/usr/lib/x86_64-linux-gnu/libgnutls.so.30',
      '/usr/lib/aarch64-linux-gnu/libgnutls.so.30',
      '/usr/local/lib/libgnutls.so',
    ];

const _CRYPTO_SYMBOLS = {
  ngtcp2_crypto_gnutls_configure_client_session: { parameters: ['pointer'], result: 'i32' },
  ngtcp2_crypto_gnutls_configure_server_session: { parameters: ['pointer'], result: 'i32' },

  ngtcp2_crypto_client_initial_cb: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'usize', 'pointer'], result: 'i32' },
  ngtcp2_crypto_recv_client_initial_cb: { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_crypto_recv_crypto_data_cb: { parameters: ['pointer', 'i32', 'u64', 'pointer', 'usize', 'pointer'], result: 'i32' },
  ngtcp2_crypto_encrypt_cb: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'usize', 'pointer'], result: 'i32' },
  ngtcp2_crypto_decrypt_cb: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'usize', 'pointer'], result: 'i32' },
  ngtcp2_crypto_hp_mask_cb: { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_crypto_update_key_cb: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_crypto_delete_crypto_aead_ctx_cb: { parameters: ['pointer', 'pointer'], result: 'void' },
  ngtcp2_crypto_delete_crypto_cipher_ctx_cb: { parameters: ['pointer', 'pointer'], result: 'void' },
  ngtcp2_crypto_get_path_challenge_data_cb: { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_crypto_version_negotiation_cb: { parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer'], result: 'i32' },
  ngtcp2_crypto_recv_retry_cb: { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_crypto_read_write_crypto_data: { parameters: ['pointer', 'i32', 'pointer', 'usize'], result: 'i32', fast: false },
  ngtcp2_crypto_write_connection_close: { parameters: ['buffer', 'usize', 'u32', 'pointer', 'pointer', 'u64', 'buffer', 'usize'], result: 'isize' },
  ngtcp2_crypto_generate_stateless_reset_token: { parameters: ['buffer', 'buffer', 'usize', 'pointer'], result: 'i32' },
  ngtcp2_crypto_generate_regular_token: { parameters: ['buffer', 'buffer', 'usize', 'pointer', 'u32', 'u64'], result: 'isize' },
  ngtcp2_crypto_verify_regular_token: { parameters: ['buffer', 'usize', 'buffer', 'usize', 'pointer', 'u32', 'u64', 'u64'], result: 'i32' },
  ngtcp2_crypto_generate_retry_token2: { parameters: ['buffer', 'buffer', 'usize', 'u32', 'pointer', 'u32', 'pointer', 'pointer', 'u64'], result: 'isize' },
  ngtcp2_crypto_verify_retry_token2: { parameters: ['pointer', 'buffer', 'usize', 'buffer', 'usize', 'u32', 'pointer', 'u32', 'pointer', 'u64', 'u64'], result: 'i32' },
  ngtcp2_crypto_write_retry: { parameters: ['buffer', 'usize', 'u32', 'pointer', 'pointer', 'pointer', 'buffer', 'usize'], result: 'isize' },
};

const _GNUTLS_SYMBOLS = {
  gnutls_global_init: { parameters: [], result: 'i32' },
  _gnutls_global_set_gettime_function: { parameters: ['pointer'], result: 'void' },
  gnutls_certificate_allocate_credentials: { parameters: ['pointer'], result: 'i32' },
  gnutls_certificate_free_credentials: { parameters: ['pointer'], result: 'void' },
  gnutls_certificate_set_x509_key_file: { parameters: ['pointer', 'buffer', 'buffer', 'i32'], result: 'i32' },
  gnutls_certificate_set_x509_system_trust: { parameters: ['pointer'], result: 'i32' },
  gnutls_init: { parameters: ['pointer', 'u32'], result: 'i32' },
  gnutls_deinit: { parameters: ['pointer'], result: 'void' },
  gnutls_credentials_set: { parameters: ['pointer', 'u32', 'pointer'], result: 'i32' },
  gnutls_set_default_priority: { parameters: ['pointer'], result: 'i32' },
  gnutls_priority_set_direct: { parameters: ['pointer', 'buffer', 'pointer'], result: 'i32' },
  gnutls_alpn_set_protocols: { parameters: ['pointer', 'pointer', 'u32', 'u32'], result: 'i32' },
  gnutls_alpn_get_selected_protocol: { parameters: ['pointer', 'pointer'], result: 'i32' },
  gnutls_cipher_get: { parameters: ['pointer'], result: 'i32' },
  gnutls_cipher_get_name: { parameters: ['i32'], result: 'pointer' },
  gnutls_protocol_get_version: { parameters: ['pointer'], result: 'i32' },
  gnutls_protocol_get_name: { parameters: ['i32'], result: 'pointer' },
  gnutls_server_name_set: { parameters: ['pointer', 'u32', 'buffer', 'usize'], result: 'i32' },
  gnutls_session_set_ptr: { parameters: ['pointer', 'pointer'], result: 'void' },
  gnutls_session_set_verify_cert: { parameters: ['pointer', 'buffer', 'u32'], result: 'void' },
  gnutls_handshake_set_hook_function: { parameters: ['pointer', 'u32', 'i32', 'pointer'], result: 'void', fast: false },
  gnutls_session_get_data2: { parameters: ['pointer', 'pointer'], result: 'i32', fast: false },
  gnutls_session_set_data: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32', fast: false },
  gnutls_session_get_random: { parameters: ['pointer', 'pointer', 'pointer'], result: 'void' },
  gnutls_prf_rfc5705: { parameters: ['pointer', 'usize', 'buffer', 'usize', 'buffer', 'usize', 'buffer'], result: 'i32', fast: false },
  gnutls_session_set_keylog_function: { parameters: ['pointer', 'pointer'], result: 'void' },
  gnutls_session_ticket_key_generate: { parameters: ['pointer'], result: 'i32' },
  gnutls_session_ticket_enable_server: { parameters: ['pointer', 'pointer'], result: 'i32' },
  gnutls_session_ticket_send: { parameters: ['pointer', 'u32', 'u32'], result: 'i32', fast: false },
  gnutls_record_set_max_early_data_size: { parameters: ['pointer', 'usize'], result: 'i32' },
  gnutls_anti_replay_init: { parameters: ['pointer'], result: 'i32' },
  gnutls_anti_replay_deinit: { parameters: ['pointer'], result: 'void' },
  gnutls_anti_replay_set_window: { parameters: ['pointer', 'u32'], result: 'void' },
  gnutls_anti_replay_set_add_function: { parameters: ['pointer', 'pointer'], result: 'void', fast: false },
  gnutls_anti_replay_set_ptr: { parameters: ['pointer', 'pointer'], result: 'void' },
  gnutls_anti_replay_enable: { parameters: ['pointer', 'pointer'], result: 'void', fast: false },
  gnutls_memset: { parameters: ['pointer', 'i32', 'usize'], result: 'void' },
  gnutls_strerror: { parameters: ['i32'], result: 'pointer' },
  gnutls_certificate_server_set_request: { parameters: ['pointer', 'u32'], result: 'void' },
  gnutls_certificate_verify_peers3: { parameters: ['pointer', 'buffer', 'pointer'], result: 'i32', fast: false },
  gnutls_certificate_get_peers: { parameters: ['pointer', 'pointer'], result: 'pointer' },
  gnutls_certificate_set_x509_trust_file: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  gnutls_certificate_set_x509_trust_dir: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
  gnutls_certificate_set_x509_trust_mem: { parameters: ['pointer', 'pointer', 'i32'], result: 'i32' },
};

const _LIBC_SYMBOLS = {
  free: { parameters: ['pointer'], result: 'void' },
};

function tryOpen<T extends Record<string, { parameters: string[]; result: string }>>(paths: string[], symbols: T): ReturnType<typeof dlopen<T>> | null {
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

export const cryptoGnutlsAvailable = _crypto !== null && _gnutls !== null && _libc !== null;
export const cryptoBackend = cryptoGnutlsAvailable ? 'gnutls' : null;
export const sym = _crypto?.symbols ?? null;
export const ptr = _crypto?.pointers ?? null;
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
  TLS_CHACHA20_POLY1305_SHA256: 'CHACHA20-POLY1305',
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
  for (let i = 0; ; i++) {
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

function makeAlpnDatums(protocols: string[]): { datums: ArrayBuffer; keepalive: Uint8Array[] } {
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
  return { datums, keepalive };
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
  const addCallback = new FfiCallback(
    { parameters: ['pointer', 'i64', 'pointer', 'pointer'], result: 'i32' },
    (_ptr: ArrayBuffer | null, expTime: bigint | number, key: ArrayBuffer | null, _data: ArrayBuffer | null) => {
      const now = BigInt(Math.floor(Date.now() / 1000));
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
    },
  );

  gnutlsSym!.gnutls_anti_replay_set_add_function(antiReplay, addCallback.pointer);
  gnutlsSym!.gnutls_anti_replay_set_ptr(antiReplay, null);
  return { handle: antiReplay, addCallback, entries };
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

export function requireCryptoGnutls(): void {
  if (_crypto === null) throw new Error('libngtcp2_crypto_gnutls not found');
  if (_gnutls === null) throw new Error('libgnutls not found');
  if (_libc === null) throw new Error('libc not found');
}

export function initCryptoGnutls(): void {
  requireCryptoGnutls();
  if (_initialized) return;
  check(gnutlsSym!.gnutls_global_init() as number, 'gnutls_global_init');
  _gettimeCallback = new FfiCallback(
    { parameters: ['pointer'], result: 'void' },
    (timespec: ArrayBuffer | null) => {
      if (timespec === null) return;
      const nowMs = Date.now();
      const sec = BigInt(Math.floor(nowMs / 1000));
      const nsec = _truncateTicketTimestamp ? 0n : BigInt((nowMs % 1000) * 1000000);
      Pointer.writeI64(timespec, 0, sec);
      Pointer.writeI64(timespec, 8, nsec);
    },
  );
  gnutlsSym!._gnutls_global_set_gettime_function(_gettimeCallback.pointer);
  _initialized = true;
}

export type GnutlsCredentials = {
  handle: ArrayBuffer;
  ticketKey: ArrayBuffer | null;
  antiReplay: GnutlsAntiReplay | null;
  verifyClient: boolean;
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

export function newGnutlsCredentials(role: 'client' | 'server', certFile?: string, keyFile?: string, verifyPeer = false, ca?: GnutlsCaOptions): GnutlsCredentials {
  initCryptoGnutls();
  const out = new ArrayBuffer(8);
  check(gnutlsSym!.gnutls_certificate_allocate_credentials(Pointer.of(out)) as number, 'gnutls_certificate_allocate_credentials');
  const cred = checkedPointerHandle(out, 'gnutls_certificate_allocate_credentials');
  if (role === 'server') {
    if (certFile === undefined || keyFile === undefined) throw new Error('GnuTLS server credentials require certificate and key files');
    check(
      gnutlsSym!.gnutls_certificate_set_x509_key_file(cred, cstr(certFile), cstr(keyFile), GNUTLS_X509_FMT_PEM) as number,
      'gnutls_certificate_set_x509_key_file',
    );
  } else {
    if (certFile !== undefined && keyFile !== undefined) {
      check(
        gnutlsSym!.gnutls_certificate_set_x509_key_file(cred, cstr(certFile), cstr(keyFile), GNUTLS_X509_FMT_PEM) as number,
        'gnutls_certificate_set_x509_key_file',
      );
    }
    configureGnutlsCa(cred, ca, verifyPeer);
  }
  return {
    handle: cred,
    ticketKey: role === 'server' ? newGnutlsTicketKey() : null,
    antiReplay: role === 'server' ? newGnutlsAntiReplay() : null,
    verifyClient: false,
    rejectUnauthorized: true,
  };
}

export function configureGnutlsServerMtls(cred: GnutlsCredentials, verifyClient: boolean, ca?: GnutlsCaOptions, rejectUnauthorized = true): void {
  if (verifyClient) {
    configureGnutlsCa(cred.handle, ca, true);
    cred.verifyClient = true;
    cred.rejectUnauthorized = rejectUnauthorized;
  }
}

export function freeGnutlsCredentials(cred: GnutlsCredentials): void {
  if (cred.ticketKey !== null) freeGnutlsTicketKey(cred.ticketKey);
  if (cred.antiReplay !== null) {
    gnutlsSym!.gnutls_anti_replay_deinit(cred.antiReplay.handle);
    cred.antiReplay.addCallback.close();
  }
  gnutlsSym!.gnutls_certificate_free_credentials(cred.handle);
}

export type GnutlsSession = {
  handle: ArrayBuffer;
  hostname: Uint8Array | null;
  alpnBytes: Uint8Array[];
  role: 'client' | 'server';
  credentials: GnutlsCredentials;
  earlyDataMax: number;
  earlyDataConfigured: boolean;
  configured: boolean;
  ticketHook: FfiCallback | null;
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
  session.keylogHook = new FfiCallback(
    { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
    (sessionPtr: ArrayBuffer | null, labelPtr: ArrayBuffer | null, secretPtr: ArrayBuffer | null) => {
      if (sessionPtr === null || labelPtr === null || secretPtr === null) return 0;
      const label = readCStr(labelPtr);
      const clientRandom = gnutlsClientRandom(sessionPtr);
      const secret = datumBytes(secretPtr);
      if (label.length > 0 && clientRandom.byteLength > 0 && secret.byteLength > 0) {
        onKeylogLine(`${label} ${hex(clientRandom)} ${hex(secret)}`);
      }
      return 0;
    },
  );
  gnutlsSym!.gnutls_session_set_keylog_function(session.handle, session.keylogHook.pointer);
}

export function newGnutlsSession(role: 'client' | 'server', credentials: GnutlsCredentials, protocols: string[], serverName?: string, verifyPeer = false, earlyDataMax = 0, cipherSuites: readonly string[] | null = null, onKeylogLine?: (line: string) => void): GnutlsSession {
  initCryptoGnutls();
  const out = new ArrayBuffer(8);
  const flags = (role === 'server' ? GNUTLS_SERVER | GNUTLS_NO_AUTO_SEND_TICKET : GNUTLS_CLIENT)
    | (earlyDataMax > 0 ? GNUTLS_ENABLE_EARLY_DATA | GNUTLS_NO_END_OF_EARLY_DATA : 0);
  check(gnutlsSym!.gnutls_init(Pointer.of(out), flags) as number, 'gnutls_init');
  const session = checkedPointerHandle(out, 'gnutls_init');
  try {
    check(gnutlsSym!.gnutls_priority_set_direct(session, cstr(priorityString(cipherSuites)), null) as number, 'gnutls_priority_set_direct');
    if (role === 'server') enableServerSessionTickets(session, credentials.ticketKey);
    check(gnutlsSym!.gnutls_credentials_set(session, GNUTLS_CRD_CERTIFICATE, credentials.handle) as number, 'gnutls_credentials_set');
    if (role === 'server' && credentials.verifyClient) {
      const requestMode = credentials.rejectUnauthorized ? GNUTLS_CERT_REQUIRE : GNUTLS_CERT_REQUEST;
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
    const outSession = { handle: session, hostname, alpnBytes: alpn.keepalive, role, credentials, earlyDataMax, earlyDataConfigured: false, configured: false, ticketHook: null, keylogHook: null };
    setGnutlsKeylogCallback(outSession, onKeylogLine);
    return outSession;
  } catch (error) {
    gnutlsSym!.gnutls_deinit(session);
    throw error;
  }
}

export function freeGnutlsSession(session: GnutlsSession): void {
  const ticketHook = session.ticketHook;
  const keylogHook = session.keylogHook;
  session.ticketHook = null;
  session.keylogHook = null;
  gnutlsSym!.gnutls_deinit(session.handle);
  ticketHook?.close();
  keylogHook?.close();
}

export function setGnutlsConnectionRef(session: GnutlsSession, connRef: ArrayBuffer | null): void {
  gnutlsSym!.gnutls_session_set_ptr(session.handle, connRef === null ? null : Pointer.of(connRef));
}

export function configureGnutlsSession(role: 'client' | 'server', session: GnutlsSession): void {
  if (session.configured) return;
  const rc = role === 'server'
    ? sym!.ngtcp2_crypto_gnutls_configure_server_session(session.handle)
    : sym!.ngtcp2_crypto_gnutls_configure_client_session(session.handle);
  if (rc !== 0) throw new Error(`ngtcp2_crypto_gnutls_configure_${role}_session failed: ${rc}`);
  session.configured = true;
  if (role === 'server' && session.earlyDataMax > 0 && !session.earlyDataConfigured) {
    if (session.credentials.antiReplay !== null) gnutlsSym!.gnutls_anti_replay_enable(session.handle, session.credentials.antiReplay.handle);
    check(gnutlsSym!.gnutls_record_set_max_early_data_size(session.handle, session.earlyDataMax) as number, 'gnutls_record_set_max_early_data_size');
    session.earlyDataConfigured = true;
  }
}

export function setGnutlsSessionTicketCallback(session: GnutlsSession, callback: ((ticket: Uint8Array) => void) | null): void {
  if (session.ticketHook !== null) {
    gnutlsSym!.gnutls_handshake_set_hook_function(session.handle, GNUTLS_HANDSHAKE_NEW_SESSION_TICKET, GNUTLS_HOOK_POST, null);
    session.ticketHook.close();
    session.ticketHook = null;
  }
  if (callback === null) return;

  session.ticketHook = new FfiCallback(
    { parameters: ['pointer', 'u32', 'u32', 'u32', 'pointer'], result: 'i32' },
    (_session: ArrayBuffer | null, htype: number, when: number, _incoming: number, _msg: ArrayBuffer | null) => {
      if (htype !== GNUTLS_HANDSHAKE_NEW_SESSION_TICKET || when !== GNUTLS_HOOK_POST) return 0;
      const ticket = exportGnutlsSession(session);
      if (ticket !== null && ticket.byteLength > 0) callback(ticket);
      return 0;
    },
  );
  gnutlsSym!.gnutls_handshake_set_hook_function(
    session.handle,
    GNUTLS_HANDSHAKE_NEW_SESSION_TICKET,
    GNUTLS_HOOK_POST,
    session.ticketHook.pointer,
  );
}

export function sendGnutlsSessionTicket(session: GnutlsSession, count = 1): void {
  _truncateTicketTimestamp = true;
  try {
    check(gnutlsSym!.gnutls_session_ticket_send(session.handle, count, 0) as number, 'gnutls_session_ticket_send');
  } finally {
    _truncateTicketTimestamp = false;
  }
}

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

export function importGnutlsSession(session: GnutlsSession, data: Uint8Array): boolean {
  return (gnutlsSym!.gnutls_session_set_data(session.handle, data, data.byteLength) as number) === 0;
}

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

export function getGnutlsServername(session: GnutlsSession | null): string | null {
  if (session?.hostname == null) return null;
  const bytes = session.hostname.subarray(0, Math.max(0, session.hostname.byteLength - 1));
  return new TextDecoder().decode(bytes);
}

export function getGnutlsCipherInfo(session: GnutlsSession | null): { cipher: string | null; cipherVersion: string | null } {
  if (session === null) return { cipher: null, cipherVersion: null };
  const cipherId = gnutlsSym!.gnutls_cipher_get(session.handle) as number;
  const protocolId = gnutlsSym!.gnutls_protocol_get_version(session.handle) as number;
  return {
    cipher: readNullableCStr(gnutlsSym!.gnutls_cipher_get_name(cipherId) as ArrayBuffer | null) || null,
    cipherVersion: readNullableCStr(gnutlsSym!.gnutls_protocol_get_name(protocolId) as ArrayBuffer | null) || null,
  };
}

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

export function exportGnutlsKeyingMaterial(session: GnutlsSession, label: string, context: Uint8Array, length: number): ArrayBuffer {
  if (!Number.isInteger(length) || length < 0) throw new RangeError('TLS exporter length must be a non-negative integer');
  const labelBytes = new TextEncoder().encode(label);
  const out = new Uint8Array(length);
  check(
    gnutlsSym!.gnutls_prf_rfc5705(
      session.handle,
      labelBytes.byteLength,
      labelBytes,
      context.byteLength,
      context,
      out.byteLength,
      out,
    ) as number,
    'gnutls_prf_rfc5705',
  );
  return out.buffer;
}

export function getGnutlsVerifyResult(session: GnutlsSession | null): { code: number; reason: string | null } {
  if (session === null) return { code: 0, reason: null };
  const statusBuf = new ArrayBuffer(4);
  const hostname = session.hostname;
  const rc = gnutlsSym!.gnutls_certificate_verify_peers3(
    session.handle,
    hostname !== null ? hostname : new Uint8Array(),
    Pointer.of(statusBuf),
  ) as number;
  if (rc < 0) return { code: rc, reason: errorString(rc) };
  const status = new DataView(statusBuf).getUint32(0, true);
  if (status === 0) return { code: 0, reason: null };
  return { code: status, reason: `certificate verification failed (status=${status})` };
}
