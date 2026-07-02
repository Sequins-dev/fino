/**
* internal:net/http/h3/bindings - optional libnghttp3 dynamic bindings.
*
* HTTP/3 specification: https://www.rfc-editor.org/rfc/rfc9114
*
* The HTTP/3 binding is intentionally optional. `h3Available === false` is a
* supported release state for builds that do not ship libnghttp3; internal H3
* helpers call `requireH3()` and fail before opening sockets when the library
* is absent. Enabled builds are expected to pass the local simulated and
* loopback H3 suites.
*
* This binding covers the request/response HTTP/3 surface used by the internal
* HTTP/3 helpers. Connection reuse, WebTransport/Capsule, H3 DATAGRAM,
* CONNECT tunnels, and external H3 interop remain deferred above this FFI
* layer.
*
* @internal
*/
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import { TextEncoder as _TextEncoder, TextDecoder as _TextDecoder } from '../../../../globals/encoding.ts';
export { Pointer, FfiCallback };
const _IS_DARWIN = os === 'darwin';
const _CANDIDATES = _IS_DARWIN ? [
  '/opt/homebrew/opt/libnghttp3/lib/libnghttp3.dylib',
  '/opt/homebrew/lib/libnghttp3.dylib',
  '/usr/local/lib/libnghttp3.dylib',
  '/opt/local/lib/libnghttp3.dylib'
] : [
  'libnghttp3.so',
  '/usr/lib/x86_64-linux-gnu/libnghttp3.so',
  '/usr/lib/aarch64-linux-gnu/libnghttp3.so',
  '/usr/lib/libnghttp3.so',
  '/usr/local/lib/libnghttp3.so'
];
const _SYMBOLS = {
  nghttp3_strerror: {
    parameters: ['i32'],
    result: 'pointer'
  },
  nghttp3_conn_server_new_versioned: {
    parameters: [
      'pointer',
      'i32',
      'pointer',
      'i32',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  nghttp3_conn_client_new_versioned: {
    parameters: [
      'pointer',
      'i32',
      'pointer',
      'i32',
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  nghttp3_conn_del: {
    parameters: ['pointer'],
    result: 'void'
  },
  nghttp3_conn_read_stream2: {
    parameters: [
      'pointer',
      'i64',
      'pointer',
      'usize',
      'i32',
      'u64'
    ],
    result: 'isize'
  },
  nghttp3_conn_writev_stream: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'usize'
    ],
    result: 'isize'
  },
  nghttp3_conn_add_write_offset: {
    parameters: [
      'pointer',
      'i64',
      'usize'
    ],
    result: 'i32'
  },
  nghttp3_conn_block_stream: {
    parameters: ['pointer', 'i64'],
    result: 'void'
  },
  nghttp3_conn_unblock_stream: {
    parameters: ['pointer', 'i64'],
    result: 'i32'
  },
  nghttp3_conn_resume_stream: {
    parameters: ['pointer', 'i64'],
    result: 'i32'
  },
  nghttp3_conn_bind_control_stream: {
    parameters: ['pointer', 'i64'],
    result: 'i32'
  },
  nghttp3_conn_bind_qpack_streams: {
    parameters: [
      'pointer',
      'i64',
      'i64'
    ],
    result: 'i32'
  },
  nghttp3_conn_submit_response: {
    parameters: [
      'pointer',
      'i64',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  nghttp3_conn_submit_request: {
    parameters: [
      'pointer',
      'i64',
      'pointer',
      'usize',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  nghttp3_conn_submit_trailers: {
    parameters: [
      'pointer',
      'i64',
      'pointer',
      'usize'
    ],
    result: 'i32'
  },
  nghttp3_conn_shutdown: {
    parameters: ['pointer'],
    result: 'i32'
  },
  nghttp3_conn_close_stream: {
    parameters: [
      'pointer',
      'i64',
      'u64'
    ],
    result: 'i32'
  },
  nghttp3_settings_default_versioned: {
    parameters: ['i32', 'pointer'],
    result: 'void'
  }
};
let _lib: ReturnType<typeof dlopen> | null = null;
for (const path of _CANDIDATES) {
  try {
    _lib = dlopen(path, _SYMBOLS);
    break;
  } catch {}
}
export const h3Available = _lib !== null;
export function requireH3(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error('libnghttp3 not found. Install via:\n' + '  macOS:  brew install libnghttp3\n' + '  Ubuntu: apt install libnghttp3-dev');
  }
  return _lib;
}
export const sym = _lib?.symbols ?? null;
// ---------------------------------------------------------------------------
// Versioning constants for nghttp3_conn_*_new_versioned calls.
// ---------------------------------------------------------------------------
export const NGHTTP3_CALLBACKS_VERSION = 3;
export const NGHTTP3_SETTINGS_VERSION = 4;
// ---------------------------------------------------------------------------
// nghttp3_callbacks struct offsets (19 × 8-byte function pointers = 152 bytes).
// ---------------------------------------------------------------------------
export const CB_SIZE = 152;
export const CB_ACKED_STREAM_DATA = 0;
export const CB_STREAM_CLOSE = 8;
export const CB_RECV_DATA = 16;
export const CB_DEFERRED_CONSUME = 24;
export const CB_BEGIN_HEADERS = 32;
export const CB_RECV_HEADER = 40;
export const CB_END_HEADERS = 48;
export const CB_BEGIN_TRAILERS = 56;
export const CB_RECV_TRAILER = 64;
export const CB_END_TRAILERS = 72;
export const CB_STOP_SENDING = 80;
export const CB_END_STREAM = 88;
export const CB_RESET_STREAM = 96;
export const CB_SHUTDOWN = 104;
// offset 112: recv_settings (deprecated, leave zeroed)
// offset 120: recv_origin  (optional)
// offset 128: end_origin   (optional)
// offset 136: rand         (optional)
export const CB_RECV_SETTINGS2 = 144;
// ---------------------------------------------------------------------------
// nghttp3_nv (name/value) struct — identical layout to nghttp2_nv.
// ---------------------------------------------------------------------------
export const NV_ENTRY_SIZE = 40;
export const NV_NAME = 0;
export const NV_VALUE = 8;
export const NV_NAMELEN = 16;
export const NV_VALUELEN = 24;
export const NV_FLAGS = 32;
export const NGHTTP3_NV_FLAG_NONE = 0;
export const NGHTTP3_NV_FLAG_NEVER_INDEX = 1;
// ---------------------------------------------------------------------------
// nghttp3_vec struct (16 bytes per entry: ptr + len).
// ---------------------------------------------------------------------------
export const VEC_ENTRY_SIZE = 16;
export const VEC_BASE = 0;
export const VEC_LEN = 8;
// ---------------------------------------------------------------------------
// nghttp3_data_reader struct (8 bytes — only one field: read_data at offset 0).
// ---------------------------------------------------------------------------
export const DR_READ_DATA = 0;
export const DR_SIZE = 8;
// ---------------------------------------------------------------------------
// nghttp3_settings struct size (V4 = 72 bytes on 64-bit).
// ---------------------------------------------------------------------------
export const SETTINGS_SIZE = 72;
export const SETTINGS_ENABLE_CONNECT_PROTOCOL = 32;
export const SETTINGS_H3_DATAGRAM = 33;
// ---------------------------------------------------------------------------
// nghttp3_proto_settings struct offsets used by recv_settings2.
// ---------------------------------------------------------------------------
export const PROTO_SETTINGS_ENABLE_CONNECT_PROTOCOL = 24;
export const PROTO_SETTINGS_H3_DATAGRAM = 25;
// ---------------------------------------------------------------------------
// Data flag written into *pflags in read_data callbacks.
// ---------------------------------------------------------------------------
export const NGHTTP3_DATA_FLAG_EOF = 1;
export const NGHTTP3_DATA_FLAG_NO_END_STREAM = 2;
// ---------------------------------------------------------------------------
// Application error codes (H3 layer).
// ---------------------------------------------------------------------------
export const NGHTTP3_H3_NO_ERROR = 256n;
export const NGHTTP3_H3_GENERAL_PROTOCOL_ERROR = 257n;
export const NGHTTP3_H3_INTERNAL_ERROR = 258n;
export const NGHTTP3_H3_REQUEST_CANCELLED = 268n;
export const NGHTTP3_H3_REQUEST_INCOMPLETE = 269n;
// ---------------------------------------------------------------------------
// Library error codes.
// ---------------------------------------------------------------------------
export const NGHTTP3_ERR_WOULDBLOCK = -103;
export const NGHTTP3_ERR_CONN_CLOSING = -111;
export const NGHTTP3_ERR_MALFORMED_HTTP_HEADER = -105;
export const NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING = -107;
export const NGHTTP3_ERR_FATAL = -900;
export const NGHTTP3_H3_MESSAGE_ERROR = 270n;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const _enc = new _TextEncoder();
const _dec = new _TextDecoder();
let _rcbufScratch = new Uint8Array(256);
const _encodedHeaderNames = new Map<string, Uint8Array>();
function encodedHeaderName(name: string): Uint8Array {
  const lower = name.toLowerCase();
  const cached = _encodedHeaderNames.get(lower);
  if (cached !== undefined) return cached;
  const encoded = _enc.encode(lower);
  _encodedHeaderNames.set(lower, encoded);
  return encoded;
}
export function readCStr(ptr: ArrayBuffer): string {
  const bytes: number[] = [];
  let i = 0;
  while (true) {
    const b = Pointer.readU8(ptr, i) as number;
    if (b === 0) break;
    bytes.push(b);
    i++;
  }
  return _dec.decode(new Uint8Array(bytes));
}
export function encodeUtf8(s: string): Uint8Array {
  return _enc.encode(s);
}
export function readRcbuf(rcbufPtr: ArrayBuffer): string {
  const basePtr = Pointer.readPointer(rcbufPtr, 8) as ArrayBuffer | null;
  if (!basePtr) return '';
  const len = Number(Pointer.readU64(rcbufPtr, 16) as bigint);
  if (len === 0) return '';
  if (len > _rcbufScratch.byteLength) {
    let nextSize = _rcbufScratch.byteLength;
    while (nextSize < len) nextSize *= 2;
    _rcbufScratch = new Uint8Array(nextSize);
  }
  const out = _rcbufScratch.subarray(0, len);
  Pointer.copyFromInto(out, basePtr, len);
  return _dec.decode(out);
}
export function buildNvArray(headers: Array<[string, string]>): {
  buf: Uint8Array;
  nv: number;
} {
  const count = headers.length;
  // Encode once up front (names are cached; values vary) so we can size the
  // output buffer, then write name/value bytes straight into it — no per-header
  // concat blob, and Pointer.addr() called once instead of per header.
  const names: Uint8Array[] = [];
  const values: Uint8Array[] = [];
  let totalData = 0;
  for (let i = 0; i < count; i++) {
    const nb = encodedHeaderName(headers[i]![0]);
    const vb = _enc.encode(headers[i]![1]);
    names.push(nb);
    values.push(vb);
    totalData += nb.length + vb.length;
  }
  const buf = new Uint8Array(count * NV_ENTRY_SIZE + totalData);
  const dv = new DataView(buf.buffer);
  const bufAddr = Pointer.addr(buf) as bigint;
  let dataOffset = count * NV_ENTRY_SIZE;
  for (let i = 0; i < count; i++) {
    const nb = names[i]!;
    const vb = values[i]!;
    const base = i * NV_ENTRY_SIZE;
    const nameAddr = bufAddr + BigInt(dataOffset);
    buf.set(nb, dataOffset);
    dataOffset += nb.length;
    const valueAddr = bufAddr + BigInt(dataOffset);
    buf.set(vb, dataOffset);
    dataOffset += vb.length;
    dv.setBigUint64(base + NV_NAME, nameAddr, true);
    dv.setBigUint64(base + NV_VALUE, valueAddr, true);
    dv.setBigUint64(base + NV_NAMELEN, BigInt(nb.length), true);
    dv.setBigUint64(base + NV_VALUELEN, BigInt(vb.length), true);
    buf[base + NV_FLAGS] = NGHTTP3_NV_FLAG_NONE;
  }
  return {
    buf,
    nv: count
  };
}
// Write an FfiCallback's function pointer into a struct buffer at the given offset.
export function writeCbPtr(buf: Uint8Array, offset: number, cb: {
  pointer: ArrayBuffer;
}): void {
  const addr = new DataView(cb.pointer).getBigUint64(0, true);
  new DataView(buf.buffer, buf.byteOffset).setBigUint64(offset, addr, true);
}
