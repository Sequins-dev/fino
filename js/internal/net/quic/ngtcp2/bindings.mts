/**
 * internal:net/quic/ngtcp2/bindings — system libngtcp2 via dlopen.
 *
 * This module is the narrow native boundary for Fino's low-level QUIC support.
 * It loads `libngtcp2` from Homebrew, MacPorts, and common Linux locations and
 * exposes only Phase 1 symbols needed by the QUIC endpoint implementation:
 * connection creation/destruction, packet read/write, stream open/write,
 * timers, transport parameters, connection IDs, and error helpers.
 *
 * The exported availability flag is intentionally non-throwing so tests and
 * applications can skip QUIC work on systems without ngtcp2. Call
 * `requireNgtcp2()` when native QUIC is mandatory.
 *
 * @internal
 */

import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';

export { FfiCallback, Pointer };

const _IS_DARWIN = os === 'darwin';

const _CANDIDATES = _IS_DARWIN
  ? [
      '/opt/homebrew/opt/libngtcp2/lib/libngtcp2.dylib',
      '/opt/homebrew/lib/libngtcp2.dylib',
      '/usr/local/opt/libngtcp2/lib/libngtcp2.dylib',
      '/usr/local/lib/libngtcp2.dylib',
      '/opt/local/lib/libngtcp2.dylib',
    ]
  : [
      'libngtcp2.so.16',
      'libngtcp2.so',
      '/usr/lib/x86_64-linux-gnu/libngtcp2.so.16',
      '/usr/lib/aarch64-linux-gnu/libngtcp2.so.16',
      '/usr/local/lib/libngtcp2.so',
    ];

const _SYMBOLS = {
  ngtcp2_version: { parameters: ['i32'], result: 'pointer' },
  ngtcp2_strerror: { parameters: ['i32'], result: 'pointer' },
  ngtcp2_err_is_fatal: { parameters: ['i32'], result: 'i32' },
  ngtcp2_err_infer_quic_transport_error_code: { parameters: ['i32'], result: 'u64' },
  ngtcp2_is_supported_version: { parameters: ['u32'], result: 'i32' },
  ngtcp2_ccerr_default: { parameters: ['pointer'], result: 'void' },
  ngtcp2_ccerr_set_liberr: { parameters: ['pointer', 'i32', 'buffer', 'usize'], result: 'void' },
  ngtcp2_ccerr_set_tls_alert: { parameters: ['pointer', 'u8', 'buffer', 'usize'], result: 'void' },
  ngtcp2_ccerr_set_transport_error: { parameters: ['pointer', 'u64', 'buffer', 'usize'], result: 'void' },
  ngtcp2_ccerr_set_application_error: { parameters: ['pointer', 'u64', 'buffer', 'usize'], result: 'void' },

  ngtcp2_accept: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32' },
  ngtcp2_settings_default_versioned: { parameters: ['i32', 'pointer'], result: 'void' },
  ngtcp2_transport_params_default_versioned: { parameters: ['i32', 'pointer'], result: 'void' },
  ngtcp2_transport_params_encode_versioned: { parameters: ['i32', 'pointer', 'usize', 'pointer'], result: 'isize' },
  ngtcp2_transport_params_decode_versioned: { parameters: ['i32', 'pointer', 'pointer', 'usize'], result: 'i32' },
  ngtcp2_transport_params_decode_new: { parameters: ['pointer', 'pointer', 'usize', 'pointer'], result: 'i32' },
  ngtcp2_transport_params_del: { parameters: ['pointer', 'pointer'], result: 'void' },

  ngtcp2_cid_init: { parameters: ['pointer', 'buffer', 'usize'], result: 'void' },
  ngtcp2_cid_eq: { parameters: ['pointer', 'pointer'], result: 'i32' },
  ngtcp2_pkt_decode_version_cid: { parameters: ['pointer', 'buffer', 'usize', 'usize'], result: 'i32' },
  ngtcp2_pkt_write_version_negotiation: { parameters: ['buffer', 'usize', 'u8', 'buffer', 'usize', 'buffer', 'usize', 'buffer', 'usize'], result: 'isize' },
  ngtcp2_pkt_decode_hd_long: { parameters: ['pointer', 'buffer', 'usize'], result: 'isize' },

  ngtcp2_conn_client_new_versioned: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'u32', 'i32', 'pointer', 'i32', 'pointer', 'i32', 'pointer', 'pointer', 'pointer'], result: 'i32', fast: false },
  ngtcp2_conn_server_new_versioned: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'u32', 'i32', 'pointer', 'i32', 'pointer', 'i32', 'pointer', 'pointer', 'pointer'], result: 'i32', fast: false },
  ngtcp2_conn_del: { parameters: ['pointer'], result: 'void' },
  ngtcp2_conn_read_pkt_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_write_pkt_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'u64'], result: 'isize', fast: false },
  ngtcp2_conn_writev_stream_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'pointer', 'u32', 'i64', 'pointer', 'usize', 'u64'], result: 'isize', fast: false },
  ngtcp2_conn_write_datagram_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'pointer', 'u32', 'u64', 'buffer', 'usize', 'u64'], result: 'isize' },
  ngtcp2_conn_write_connection_close_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'pointer', 'u64'], result: 'isize', fast: false },
  ngtcp2_conn_initiate_key_update: { parameters: ['pointer', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_initiate_immediate_migration: { parameters: ['pointer', 'pointer', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_initiate_migration: { parameters: ['pointer', 'pointer', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_set_local_addr: { parameters: ['pointer', 'pointer'], result: 'void', fast: false },
  ngtcp2_conn_set_path_user_data: { parameters: ['pointer', 'pointer'], result: 'void', fast: false },
  ngtcp2_conn_get_ccerr: { parameters: ['pointer'], result: 'pointer' },

  ngtcp2_conn_get_expiry: { parameters: ['pointer'], result: 'u64' },
  ngtcp2_conn_get_pto: { parameters: ['pointer'], result: 'u64' },
  ngtcp2_conn_handle_expiry: { parameters: ['pointer', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_set_keep_alive_timeout: { parameters: ['pointer', 'u64'], result: 'void', fast: false },
  ngtcp2_conn_update_pkt_tx_time: { parameters: ['pointer', 'u64'], result: 'void', fast: false },
  ngtcp2_conn_get_send_quantum: { parameters: ['pointer'], result: 'usize' },
  ngtcp2_conn_get_max_tx_udp_payload_size: { parameters: ['pointer'], result: 'usize' },
  ngtcp2_conn_get_handshake_completed: { parameters: ['pointer'], result: 'i32' },
  ngtcp2_conn_tls_handshake_completed: { parameters: ['pointer'], result: 'void', fast: false },
  ngtcp2_conn_get_tls_alert: { parameters: ['pointer'], result: 'u8' },
  ngtcp2_conn_get_tls_error: { parameters: ['pointer'], result: 'i32' },
  ngtcp2_conn_get_negotiated_version: { parameters: ['pointer'], result: 'u32' },
  ngtcp2_conn_set_tls_error: { parameters: ['pointer', 'i32'], result: 'void', fast: false },
  ngtcp2_conn_set_tls_native_handle: { parameters: ['pointer', 'pointer'], result: 'void', fast: false },
  ngtcp2_conn_get_tls_native_handle: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_get_conn_info_versioned: { parameters: ['pointer', 'i32', 'pointer'], result: 'void', fast: false },
  ngtcp2_conn_set_local_transport_params_versioned: { parameters: ['pointer', 'pointer', 'i32'], result: 'i32', fast: false },
  ngtcp2_conn_get_local_transport_params: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_get_remote_transport_params: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_decode_and_set_remote_transport_params: { parameters: ['pointer', 'pointer', 'usize'], result: 'i32', fast: false },
  ngtcp2_conn_encode_0rtt_transport_params: { parameters: ['pointer', 'buffer', 'usize'], result: 'isize', fast: false },
  ngtcp2_conn_decode_and_set_0rtt_transport_params: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32', fast: false },
  ngtcp2_conn_encode_local_transport_params: { parameters: ['pointer', 'pointer', 'usize'], result: 'isize', fast: false },
  ngtcp2_conn_get_active_dcid: { parameters: ['pointer', 'pointer'], result: 'usize' },
  ngtcp2_conn_get_dcid: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_get_path: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_get_scid: { parameters: ['pointer', 'pointer'], result: 'usize' },
  ngtcp2_conn_open_bidi_stream: { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32', fast: false },
  ngtcp2_conn_open_uni_stream: { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32', fast: false },
  ngtcp2_conn_get_streams_bidi_left: { parameters: ['pointer'], result: 'u64' },
  ngtcp2_conn_get_streams_uni_left: { parameters: ['pointer'], result: 'u64' },
  ngtcp2_conn_set_stream_user_data: { parameters: ['pointer', 'i64', 'pointer'], result: 'i32', fast: false },
  ngtcp2_conn_shutdown_stream: { parameters: ['pointer', 'u32', 'i64', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_shutdown_stream_read: { parameters: ['pointer', 'u32', 'i64', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_shutdown_stream_write: { parameters: ['pointer', 'u32', 'i64', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_extend_max_stream_offset: { parameters: ['pointer', 'i64', 'u64'], result: 'i32', fast: false },
  ngtcp2_conn_extend_max_offset: { parameters: ['pointer', 'u64'], result: 'void', fast: false },
  ngtcp2_conn_extend_max_streams_bidi: { parameters: ['pointer', 'usize'], result: 'void', fast: false },
  ngtcp2_conn_extend_max_streams_uni: { parameters: ['pointer', 'usize'], result: 'void', fast: false },
  ngtcp2_conn_submit_crypto_data: { parameters: ['pointer', 'i32', 'buffer', 'usize'], result: 'i32', fast: false },
  ngtcp2_conn_submit_new_token: { parameters: ['pointer', 'buffer', 'usize'], result: 'i32', fast: false },
  ngtcp2_is_bidi_stream: { parameters: ['i64'], result: 'i32' },
};

type StatelessResetWriter = (dest: Uint8Array, destlen: number, token: Uint8Array, random: Uint8Array, randomLength: number) => number;

let _lib: ReturnType<typeof dlopen> | null = null;
let _statelessResetLib: ReturnType<typeof dlopen> | null = null;
let _statelessResetWriter: StatelessResetWriter | null = null;
const _loadErrors: string[] = [];

function statelessResetTokenPointer(token: Uint8Array): ArrayBuffer {
  const view = token.byteOffset === 0 && token.byteLength === token.buffer.byteLength
    ? token
    : token.slice();
  return Pointer.of(view.buffer);
}

function tryOpenStatelessReset(path: string): StatelessResetWriter | null {
  try {
    const lib = dlopen(path, {
      ngtcp2_pkt_write_stateless_reset2: { parameters: ['buffer', 'usize', 'pointer', 'buffer', 'usize'], result: 'isize' },
    });
    _statelessResetLib = lib;
    return (dest, destlen, token, random, randomLength) => Number(lib.symbols.ngtcp2_pkt_write_stateless_reset2(
      dest,
      destlen,
      statelessResetTokenPointer(token),
      random,
      randomLength,
    ));
  } catch (error2) {
    try {
      const lib = dlopen(path, {
        ngtcp2_pkt_write_stateless_reset: { parameters: ['buffer', 'usize', 'buffer', 'buffer', 'usize'], result: 'isize' },
      });
      _statelessResetLib = lib;
      return (dest, destlen, token, random, randomLength) => Number(lib.symbols.ngtcp2_pkt_write_stateless_reset(
        dest,
        destlen,
        token,
        random,
        randomLength,
      ));
    } catch (error1) {
      const message2 = error2 instanceof Error ? error2.message : String(error2);
      const message1 = error1 instanceof Error ? error1.message : String(error1);
      _loadErrors.push(`${path}: stateless reset writer unavailable (${message2}; ${message1})`);
      return null;
    }
  }
}

for (const path of _CANDIDATES) {
  try {
    const lib = dlopen(path, _SYMBOLS);
    const statelessResetWriter = tryOpenStatelessReset(path);
    if (statelessResetWriter === null) continue;
    _lib = lib;
    _statelessResetWriter = statelessResetWriter;
    break;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    _loadErrors.push(`${path}: ${message}`);
  }
}

export const ngtcp2Available = _lib !== null && _statelessResetWriter !== null;
export const sym = _lib?.symbols ?? null;
export const ptr = _lib?.pointers ?? null;

export function ngtcp2PktWriteStatelessReset(dest: Uint8Array, destlen: number, token: Uint8Array, random: Uint8Array, randomLength: number): number {
  if (_statelessResetWriter === null) throw new Error('ngtcp2 stateless reset writer is unavailable');
  return _statelessResetWriter(dest, destlen, token, random, randomLength);
}

export function requireNgtcp2(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error(
      'libngtcp2 not found. Install via:\n' +
      '  macOS:  brew install libngtcp2 openssl@3\n' +
      '  Debian/Ubuntu: apt install libngtcp2-16 libngtcp2-crypto-gnutls8' +
      (_loadErrors.length === 0 ? '' : '\nTried:\n  ' + _loadErrors.join('\n  ')),
    );
  }
  return _lib;
}

export function readCStr(ptr: ArrayBuffer): string {
  const bytes: number[] = [];
  for (let i = 0; ; i++) {
    const b = Pointer.readU8(ptr, i);
    if (b === 0) break;
    bytes.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function loadedNgtcp2VersionNumber(): number {
  if (_lib === null) return 0;
  try {
    const info = _lib.symbols.ngtcp2_version(0) as ArrayBuffer | null;
    return info === null ? 0 : Pointer.readI32(info, 4) as number;
  } catch {
    return 0;
  }
}

const _VERSION_NUM = loadedNgtcp2VersionNumber();

export const NGTCP2_PROTO_VER_V1 = 0x00000001;
export const NGTCP2_PROTO_VER_V2 = 0x6b3343cf;
export const NGTCP2_CALLBACKS_VERSION = _VERSION_NUM >= 0x011600
  ? 3
  : _VERSION_NUM >= 0x010e00
    ? 2
    : 1;
export const NGTCP2_SETTINGS_VERSION = _VERSION_NUM >= 0x010f00 ? 3 : 2;
export const NGTCP2_TRANSPORT_PARAMS_VERSION = 1;
export const NGTCP2_PKT_INFO_VERSION = 1;
export const NGTCP2_PKT_INFO_SIZE = 8;
export const PKT_INFO_ECN = 0;
export const NGTCP2_ECN_NOT_ECT = 0;
export const NGTCP2_ECN_ECT_1 = 1;
export const NGTCP2_ECN_ECT_0 = 2;
export const NGTCP2_ECN_CE = 3;
export const NGTCP2_ECN_MASK = 3;
export const NGTCP2_NO_ERROR = 0;
export const NGTCP2_CRYPTO_ERROR = 0x100;
export const NGTCP2_MAX_UDP_PAYLOAD_SIZE = 1200;
export const NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE = 65527;
export const NGTCP2_MIN_INITIAL_DCIDLEN = 8;
export const NGTCP2_MAX_CIDLEN = 20;
export const NGTCP2_ERR_NOBUF = -202;
export const NGTCP2_ERR_INVALID_STATE = -204;
export const NGTCP2_ERR_STREAM_ID_BLOCKED = -206;
export const NGTCP2_ERR_STREAM_DATA_BLOCKED = -208;
export const NGTCP2_ERR_CRYPTO = -213;
export const NGTCP2_ERR_PKT_NUM_EXHAUSTED = -214;
export const NGTCP2_ERR_CALLBACK_FAILURE = -502;
export const NGTCP2_ERR_VERSION_NEGOTIATION = -235;
export const NGTCP2_ERR_IDLE_CLOSE = -238;
export const NGTCP2_ERR_STREAM_SHUT_WR = -219;
export const NGTCP2_ERR_STREAM_NOT_FOUND = -220;
export const NGTCP2_ERR_RECV_VERSION_NEGOTIATION = -222;
export const NGTCP2_ERR_CONN_ID_BLOCKED = -227;
export const NGTCP2_ERR_WRITE_MORE = -230;
export const NGTCP2_ERR_RETRY = -231;
export const NGTCP2_ERR_DROP_CONN = -232;
export const NGTCP2_ERR_CLOSING = -223;
export const NGTCP2_ERR_DRAINING = -224;
export const NGTCP2_TOKEN_TYPE_UNKNOWN = 0;
export const NGTCP2_TOKEN_TYPE_RETRY = 1;
export const NGTCP2_TOKEN_TYPE_NEW_TOKEN = 2;
export const NGTCP2_WRITE_STREAM_FLAG_FIN = 0x02;
export const NGTCP2_WRITE_STREAM_FLAG_MORE = 0x01;
export const NGTCP2_WRITE_DATAGRAM_FLAG_NONE = 0x00;
export const NGTCP2_DATAGRAM_FLAG_0RTT = 0x01;
export const NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE = 0;
export const NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE = 1;
export const NGTCP2_PATH_VALIDATION_RESULT_SUCCESS = 0;
export const NGTCP2_PATH_VALIDATION_RESULT_FAILURE = 1;
export const NGTCP2_PATH_VALIDATION_RESULT_ABORTED = 2;
export const NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR = 0x01;
export const NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN = 0x02;

// ABI layout constants for the libngtcp2 v1 callback / v2 settings LP64 ABI.
// These values are generated with C sizeof/offsetof and keep this module pure
// FFI: JS owns the backing ArrayBuffers and passes their addresses to ngtcp2.
export const NGTCP2_CALLBACKS_SIZE = NGTCP2_CALLBACKS_VERSION >= 3
  ? 360
  : NGTCP2_CALLBACKS_VERSION >= 2
    ? 328
    : 320;
export const NGTCP2_SETTINGS_SIZE = NGTCP2_SETTINGS_VERSION >= 3 ? 200 : 184;
export const NGTCP2_TRANSPORT_PARAMS_SIZE = 344;
export const NGTCP2_CCERR_SIZE = 40;
export const NGTCP2_CID_SIZE = 32;
export const NGTCP2_ADDR_SIZE = 16;
export const NGTCP2_PATH_SIZE = 40;
export const NGTCP2_PKT_HD_SIZE = 112;
export const NGTCP2_VEC_SIZE = 16;
export const NGTCP2_VERSION_CID_SIZE = 40;

export const CB_CLIENT_INITIAL = 0;
export const CB_RECV_CLIENT_INITIAL = 8;
export const CB_RECV_CRYPTO_DATA = 16;
export const CB_HANDSHAKE_COMPLETED = 24;
export const CB_RECV_VERSION_NEGOTIATION = 32;
export const CB_ENCRYPT = 40;
export const CB_DECRYPT = 48;
export const CB_HP_MASK = 56;
export const CB_RECV_STREAM_DATA = 64;
export const CB_ACKED_STREAM_DATA_OFFSET = 72;
export const CB_STREAM_OPEN = 80;
export const CB_STREAM_CLOSE = 88;
export const CB_RECV_STATELESS_RESET = 96;
export const CB_RECV_RETRY = 104;
export const CB_EXTEND_MAX_LOCAL_STREAMS_BIDI = 112;
export const CB_EXTEND_MAX_LOCAL_STREAMS_UNI = 120;
export const CB_RAND = 128;
export const CB_GET_NEW_CONNECTION_ID = 136;
export const CB_REMOVE_CONNECTION_ID = 144;
export const CB_UPDATE_KEY = 152;
export const CB_PATH_VALIDATION = 160;
export const CB_SELECT_PREFERRED_ADDR = 168;
export const CB_STREAM_RESET = 176;
export const CB_EXTEND_MAX_REMOTE_STREAMS_BIDI = 184;
export const CB_EXTEND_MAX_REMOTE_STREAMS_UNI = 192;
export const CB_EXTEND_MAX_STREAM_DATA = 200;
export const CB_DCID_STATUS = 208;
export const CB_HANDSHAKE_CONFIRMED = 216;
export const CB_RECV_NEW_TOKEN = 224;
export const CB_DELETE_CRYPTO_AEAD_CTX = 232;
export const CB_DELETE_CRYPTO_CIPHER_CTX = 240;
export const CB_RECV_DATAGRAM = 248;
export const CB_ACK_DATAGRAM = 256;
export const CB_LOST_DATAGRAM = 264;
export const CB_GET_PATH_CHALLENGE_DATA = 272;
export const CB_STREAM_STOP_SENDING = 280;
export const CB_VERSION_NEGOTIATION = 288;
export const CB_RECV_RX_KEY = 296;
export const CB_RECV_TX_KEY = 304;
export const CB_EARLY_DATA_REJECTED = 312;
export const CB_BEGIN_PATH_VALIDATION = 320;
export const CB_RECV_STATELESS_RESET2 = 328;
export const CB_GET_NEW_CONNECTION_ID2 = 336;
export const CB_DCID_STATUS2 = 344;
export const CB_GET_PATH_CHALLENGE_DATA2 = 352;

export const CID_DATALEN = 0;
export const CID_DATA = 8;
export const ADDR_ADDR = 0;
export const ADDR_ADDRLEN = 8;
export const PATH_LOCAL = 0;
export const PATH_REMOTE = 16;
export const PATH_USER_DATA = 32;
export const VEC_BASE = 0;
export const VEC_LEN = 8;
export const VERSION_CID_VERSION = 0;
export const VERSION_CID_DCID = 8;
export const VERSION_CID_DCIDLEN = 16;
export const VERSION_CID_SCID = 24;
export const VERSION_CID_SCIDLEN = 32;
export const SETTINGS_QLOG_WRITE = 0;
export const SETTINGS_CC_ALGO = 8;
export const SETTINGS_TOKEN = 48;
export const SETTINGS_INITIAL_TS = 16;
export const SETTINGS_INITIAL_RTT = 24;
export const SETTINGS_MAX_TX_UDP_PAYLOAD_SIZE = 40;
export const SETTINGS_TOKENLEN = 56;
export const SETTINGS_TOKEN_TYPE = 64;
export const SETTINGS_MAX_WINDOW = 80;
export const SETTINGS_MAX_STREAM_WINDOW = 88;
export const SETTINGS_ACK_THRESH = 96;
export const SETTINGS_NO_TX_UDP_PAYLOAD_SIZE_SHAPING = 104;
export const SETTINGS_HANDSHAKE_TIMEOUT = 112;
export const SETTINGS_PREFERRED_VERSIONS = 120;
export const SETTINGS_PREFERRED_VERSIONSLEN = 128;
export const SETTINGS_AVAILABLE_VERSIONS = 136;
export const SETTINGS_AVAILABLE_VERSIONSLEN = 144;
export const SETTINGS_ORIGINAL_VERSION = 152;
export const SETTINGS_NO_PMTUD = 156;
export const TP_ORIGINAL_DCID = 96;
export const TP_INITIAL_SCID = 128;
export const TP_RETRY_SCID = 160;
export const TP_PREFERRED_ADDR = 0;
export const TP_PREFERRED_ADDR_CID = 0;
export const TP_PREFERRED_ADDR_IPV4 = 32;
export const TP_PREFERRED_ADDR_IPV6 = 48;
export const TP_PREFERRED_ADDR_IPV4_PRESENT = 76;
export const TP_PREFERRED_ADDR_IPV6_PRESENT = 77;
export const TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN = 78;
export const TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL = 192;
export const TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE = 200;
export const TP_INITIAL_MAX_STREAM_DATA_UNI = 208;
export const TP_INITIAL_MAX_DATA = 216;
export const TP_INITIAL_MAX_STREAMS_BIDI = 224;
export const TP_INITIAL_MAX_STREAMS_UNI = 232;
export const TP_MAX_IDLE_TIMEOUT = 240;
export const TP_MAX_UDP_PAYLOAD_SIZE = 248;
export const TP_ACTIVE_CONNECTION_ID_LIMIT = 256;
export const TP_ACK_DELAY_EXPONENT = 264;
export const TP_MAX_ACK_DELAY = 272;
export const TP_MAX_DATAGRAM_FRAME_SIZE = 280;
export const TP_STATELESS_RESET_TOKEN_PRESENT = 288;
export const TP_DISABLE_ACTIVE_MIGRATION = 289;
export const TP_ORIGINAL_DCID_PRESENT = 290;
export const TP_INITIAL_SCID_PRESENT = 291;
export const TP_RETRY_SCID_PRESENT = 292;
export const TP_PREFERRED_ADDR_PRESENT = 293;
export const TP_STATELESS_RESET_TOKEN = 294;
export const NGTCP2_CONN_INFO_SIZE = 120;
export const NGTCP2_CONN_INFO_VERSION = 2;
export const CONN_INFO_LATEST_RTT = 0;
export const CONN_INFO_MIN_RTT = 8;
export const CONN_INFO_SMOOTHED_RTT = 16;
export const CONN_INFO_RTTVAR = 24;
export const CONN_INFO_CWND = 32;
export const CONN_INFO_SSTHRESH = 40;
export const CONN_INFO_BYTES_IN_FLIGHT = 48;
export const CONN_INFO_PKT_SENT = 56;
export const CONN_INFO_BYTES_SENT = 64;
export const CONN_INFO_PKT_RECV = 72;
export const CONN_INFO_BYTES_RECV = 80;
export const CONN_INFO_PKT_LOST = 88;
export const CONN_INFO_BYTES_LOST = 96;
export const CONN_INFO_PING_RECV = 104;
export const CONN_INFO_PKT_DISCARDED = 112;
export const PKT_HD_DCID = 0;
export const PKT_HD_SCID = 32;
export const PKT_HD_TOKEN = 72;
export const PKT_HD_TOKENLEN = 80;
export const PKT_HD_VERSION = 104;
export const PKT_HD_TYPE = 108;
export const CCERR_TYPE = 0;
export const CCERR_ERROR_CODE = 8;
export const CCERR_REASON = 24;
export const CCERR_REASONLEN = 32;
