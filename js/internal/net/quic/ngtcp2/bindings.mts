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
  ngtcp2_pkt_decode_hd_long: { parameters: ['pointer', 'buffer', 'usize'], result: 'isize' },

  ngtcp2_conn_client_new_versioned: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'u32', 'i32', 'pointer', 'i32', 'pointer', 'i32', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_conn_server_new_versioned: { parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'u32', 'i32', 'pointer', 'i32', 'pointer', 'i32', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_conn_del: { parameters: ['pointer'], result: 'void' },
  ngtcp2_conn_read_pkt_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'u64'], result: 'i32' },
  ngtcp2_conn_write_pkt_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'u64'], result: 'isize' },
  ngtcp2_conn_writev_stream_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'pointer', 'u32', 'i64', 'pointer', 'usize', 'u64'], result: 'isize' },
  ngtcp2_conn_write_connection_close_versioned: { parameters: ['pointer', 'pointer', 'i32', 'pointer', 'buffer', 'usize', 'pointer', 'u64'], result: 'isize' },

  ngtcp2_conn_get_expiry: { parameters: ['pointer'], result: 'u64' },
  ngtcp2_conn_handle_expiry: { parameters: ['pointer', 'u64'], result: 'i32' },
  ngtcp2_conn_get_send_quantum: { parameters: ['pointer'], result: 'usize' },
  ngtcp2_conn_get_max_tx_udp_payload_size: { parameters: ['pointer'], result: 'usize' },
  ngtcp2_conn_get_handshake_completed: { parameters: ['pointer'], result: 'i32' },
  ngtcp2_conn_tls_handshake_completed: { parameters: ['pointer'], result: 'void' },
  ngtcp2_conn_continue_handshake: { parameters: ['pointer', 'u64'], result: 'i32' },
  ngtcp2_conn_get_tls_alert: { parameters: ['pointer'], result: 'u8' },
  ngtcp2_conn_get_tls_error: { parameters: ['pointer'], result: 'i32' },
  ngtcp2_conn_set_tls_error: { parameters: ['pointer', 'i32'], result: 'void' },
  ngtcp2_conn_set_tls_native_handle: { parameters: ['pointer', 'pointer'], result: 'void' },
  ngtcp2_conn_get_tls_native_handle: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_set_local_transport_params_versioned: { parameters: ['pointer', 'pointer', 'i32'], result: 'i32' },
  ngtcp2_conn_get_local_transport_params: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_get_remote_transport_params: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_decode_and_set_remote_transport_params: { parameters: ['pointer', 'pointer', 'usize'], result: 'i32' },
  ngtcp2_conn_encode_local_transport_params: { parameters: ['pointer', 'pointer', 'usize'], result: 'isize' },
  ngtcp2_conn_get_active_dcid: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_get_dcid: { parameters: ['pointer'], result: 'pointer' },
  ngtcp2_conn_get_scid: { parameters: ['pointer', 'pointer'], result: 'usize' },
  ngtcp2_conn_open_bidi_stream: { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_conn_open_uni_stream: { parameters: ['pointer', 'pointer', 'pointer'], result: 'i32' },
  ngtcp2_conn_get_streams_bidi_left: { parameters: ['pointer'], result: 'u64' },
  ngtcp2_conn_get_streams_uni_left: { parameters: ['pointer'], result: 'u64' },
  ngtcp2_conn_set_stream_user_data: { parameters: ['pointer', 'i64', 'pointer'], result: 'i32' },
  ngtcp2_conn_get_stream_user_data: { parameters: ['pointer', 'i64'], result: 'pointer' },
  ngtcp2_conn_shutdown_stream: { parameters: ['pointer', 'u64', 'i64'], result: 'i32' },
  ngtcp2_conn_shutdown_stream_read: { parameters: ['pointer', 'u64', 'i64'], result: 'i32' },
  ngtcp2_conn_shutdown_stream_write: { parameters: ['pointer', 'u64', 'i64'], result: 'i32' },
  ngtcp2_conn_extend_max_stream_offset: { parameters: ['pointer', 'i64', 'u64'], result: 'i32' },
  ngtcp2_conn_extend_max_offset: { parameters: ['pointer', 'u64'], result: 'void' },
  ngtcp2_conn_submit_crypto_data: { parameters: ['pointer', 'i32', 'buffer', 'usize'], result: 'i32' },
  ngtcp2_is_bidi_stream: { parameters: ['i64'], result: 'i32' },
};

let _lib: ReturnType<typeof dlopen> | null = null;

for (const path of _CANDIDATES) {
  try {
    _lib = dlopen(path, _SYMBOLS);
    break;
  } catch {}
}

export const ngtcp2Available = _lib !== null;
export const sym = _lib?.symbols ?? null;
export const ptr = _lib?.pointers ?? null;

export function requireNgtcp2(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error(
      'libngtcp2 not found. Install via:\n' +
      '  macOS:  brew install libngtcp2 openssl@3\n' +
      '  Ubuntu: apt install libngtcp2-16 libngtcp2-crypto-ossl0',
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

export const NGTCP2_PROTO_VER_V1 = 0x00000001;
export const NGTCP2_CALLBACKS_VERSION = 3;
export const NGTCP2_SETTINGS_VERSION = 3;
export const NGTCP2_TRANSPORT_PARAMS_VERSION = 1;
export const NGTCP2_PKT_INFO_VERSION = 1;
export const NGTCP2_NO_ERROR = 0;
export const NGTCP2_MAX_UDP_PAYLOAD_SIZE = 1200;
export const NGTCP2_MIN_INITIAL_DCIDLEN = 8;
export const NGTCP2_MAX_CIDLEN = 20;
export const NGTCP2_ERR_NOBUF = -202;
export const NGTCP2_ERR_STREAM_DATA_BLOCKED = -208;
export const NGTCP2_ERR_WRITE_MORE = -230;
export const NGTCP2_ERR_STREAM_SHUT_WR = -516;
export const NGTCP2_ERR_DRAINING = -901;
export const NGTCP2_ERR_CLOSING = -902;
export const NGTCP2_WRITE_STREAM_FLAG_FIN = 0x02;

// ABI layout constants for the installed libngtcp2 1.22.x LP64 ABI. These
// values are generated with C sizeof/offsetof and keep this module pure FFI:
// JS owns the backing ArrayBuffers and passes their addresses to ngtcp2.
export const NGTCP2_CALLBACKS_SIZE = 360;
export const NGTCP2_SETTINGS_SIZE = 200;
export const NGTCP2_TRANSPORT_PARAMS_SIZE = 344;
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
export const CB_RECV_RETRY = 104;
export const CB_EXTEND_MAX_LOCAL_STREAMS_BIDI = 112;
export const CB_EXTEND_MAX_LOCAL_STREAMS_UNI = 120;
export const CB_RAND = 128;
export const CB_GET_NEW_CONNECTION_ID = 136;
export const CB_REMOVE_CONNECTION_ID = 144;
export const CB_UPDATE_KEY = 152;
export const CB_STREAM_RESET = 176;
export const CB_DELETE_CRYPTO_AEAD_CTX = 232;
export const CB_DELETE_CRYPTO_CIPHER_CTX = 240;
export const CB_GET_PATH_CHALLENGE_DATA = 272;
export const CB_STREAM_STOP_SENDING = 280;
export const CB_VERSION_NEGOTIATION = 288;
export const CB_GET_NEW_CONNECTION_ID2 = 336;
export const CB_GET_PATH_CHALLENGE_DATA2 = 352;

export const CID_DATALEN = 0;
export const CID_DATA = 8;
export const ADDR_ADDR = 0;
export const ADDR_ADDRLEN = 8;
export const PATH_LOCAL = 0;
export const PATH_REMOTE = 16;
export const VEC_BASE = 0;
export const VEC_LEN = 8;
export const VERSION_CID_VERSION = 0;
export const VERSION_CID_DCID = 8;
export const VERSION_CID_DCIDLEN = 16;
export const VERSION_CID_SCID = 24;
export const VERSION_CID_SCIDLEN = 32;
export const TP_ORIGINAL_DCID = 96;
export const TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL = 192;
export const TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE = 200;
export const TP_INITIAL_MAX_STREAM_DATA_UNI = 208;
export const TP_INITIAL_MAX_DATA = 216;
export const TP_INITIAL_MAX_STREAMS_BIDI = 224;
export const TP_INITIAL_MAX_STREAMS_UNI = 232;
export const TP_MAX_UDP_PAYLOAD_SIZE = 248;
export const TP_ACTIVE_CONNECTION_ID_LIMIT = 256;
export const TP_ACK_DELAY_EXPONENT = 264;
export const TP_MAX_ACK_DELAY = 272;
export const TP_ORIGINAL_DCID_PRESENT = 290;
export const PKT_HD_DCID = 0;
export const PKT_HD_SCID = 32;
export const PKT_HD_VERSION = 104;
export const PKT_HD_TYPE = 108;
