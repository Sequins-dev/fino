/**
 * internal:net/http2/bindings — system libnghttp2 via dlopen.
 *
 * Tries candidate paths in order; sets `h2Available` accordingly.
 * Homebrew paths are first so macOS users get the right build.
 *
 * All symbols that can invoke FfiCallbacks (session_mem_recv2,
 * session_mem_send2) are marked async:true so they run on the blocking
 * pool — FfiCallback trampolines block their calling thread, and that
 * thread must not be the V8 thread.
 *
 * @internal
 */

import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import { TextEncoder as _TextEncoder, TextDecoder as _TextDecoder } from '../../globals/encoding.mts';

export { Pointer, FfiCallback };

const _IS_DARWIN = os === 'darwin';

const _CANDIDATES = _IS_DARWIN
  ? [
      '/opt/homebrew/opt/libnghttp2/lib/libnghttp2.dylib',
      '/opt/homebrew/lib/libnghttp2.dylib',
      '/usr/local/lib/libnghttp2.dylib',
      '/opt/local/lib/libnghttp2.dylib',
    ]
  : [
      'libnghttp2.so.14',
      '/usr/lib/x86_64-linux-gnu/libnghttp2.so.14',
      '/usr/lib/aarch64-linux-gnu/libnghttp2.so.14',
      '/usr/lib/libnghttp2.so.14',
      '/usr/local/lib/libnghttp2.so',
    ];

const _SYMBOLS = {
  // ---------------------------------------------------------------------------
  // Library info
  // ---------------------------------------------------------------------------
  nghttp2_version:  { parameters: ['i32'],     result: 'pointer' },
  nghttp2_strerror: { parameters: ['i32'],     result: 'pointer' },

  // ---------------------------------------------------------------------------
  // Session callbacks — alloc/free + setters
  // ---------------------------------------------------------------------------
  nghttp2_session_callbacks_new:                              { parameters: ['pointer'],              result: 'i32' },
  nghttp2_session_callbacks_del:                              { parameters: ['pointer'],              result: 'void' },
  nghttp2_session_callbacks_set_on_begin_headers_callback:    { parameters: ['pointer', 'pointer'],  result: 'void' },
  nghttp2_session_callbacks_set_on_header_callback:           { parameters: ['pointer', 'pointer'],  result: 'void' },
  nghttp2_session_callbacks_set_on_frame_recv_callback:       { parameters: ['pointer', 'pointer'],  result: 'void' },
  nghttp2_session_callbacks_set_on_data_chunk_recv_callback:  { parameters: ['pointer', 'pointer'],  result: 'void' },
  nghttp2_session_callbacks_set_on_stream_close_callback:     { parameters: ['pointer', 'pointer'],  result: 'void' },
  nghttp2_session_callbacks_set_error_callback2:              { parameters: ['pointer', 'pointer'],  result: 'void' },

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------
  nghttp2_option_new:                              { parameters: ['pointer'],         result: 'i32' },
  nghttp2_option_del:                              { parameters: ['pointer'],         result: 'void' },
  nghttp2_option_set_no_auto_window_update:        { parameters: ['pointer', 'i32'], result: 'void' },
  nghttp2_option_set_peer_max_concurrent_streams:  { parameters: ['pointer', 'u32'], result: 'void' },
  nghttp2_option_set_no_recv_client_magic:         { parameters: ['pointer', 'i32'], result: 'void' },
  nghttp2_option_set_no_http_messaging:            { parameters: ['pointer', 'i32'], result: 'void' },

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------
  nghttp2_session_server_new2:  { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  nghttp2_session_client_new2:  { parameters: ['pointer', 'pointer', 'pointer', 'pointer'], result: 'i32' },
  nghttp2_session_del:          { parameters: ['pointer'],                                  result: 'void' },

  // I/O pumps — async because they fire FfiCallbacks from the pool thread.
  nghttp2_session_mem_recv2:  { parameters: ['pointer', 'pointer', 'usize'], result: 'isize', async: true },
  nghttp2_session_mem_send2:  { parameters: ['pointer', 'pointer'],          result: 'isize', async: true },

  // ---------------------------------------------------------------------------
  // Session state (sync — no callbacks)
  // ---------------------------------------------------------------------------
  nghttp2_session_want_read:               { parameters: ['pointer'],          result: 'i32' },
  nghttp2_session_want_write:              { parameters: ['pointer'],          result: 'i32' },
  nghttp2_session_resume_data:             { parameters: ['pointer', 'i32'],  result: 'i32' },
  nghttp2_session_get_stream_user_data:    { parameters: ['pointer', 'i32'],  result: 'pointer' },
  nghttp2_session_set_stream_user_data:    { parameters: ['pointer', 'i32', 'pointer'], result: 'i32' },
  nghttp2_session_get_local_settings:      { parameters: ['pointer', 'i32'],  result: 'u32' },
  nghttp2_session_get_remote_settings:     { parameters: ['pointer', 'i32'],  result: 'u32' },

  // ---------------------------------------------------------------------------
  // Submit operations (sync — no callbacks)
  // ---------------------------------------------------------------------------
  nghttp2_submit_settings:     { parameters: ['pointer', 'u8', 'pointer', 'usize'],                    result: 'i32' },
  nghttp2_submit_response2:    { parameters: ['pointer', 'i32', 'pointer', 'usize', 'pointer'],         result: 'i32' },
  nghttp2_submit_request2:     { parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer', 'pointer'], result: 'i32' },
  nghttp2_submit_trailer:      { parameters: ['pointer', 'i32', 'pointer', 'usize'],                   result: 'i32' },
  nghttp2_submit_goaway:       { parameters: ['pointer', 'u8', 'i32', 'u32', 'pointer', 'usize'],      result: 'i32' },
  nghttp2_submit_ping:         { parameters: ['pointer', 'u8', 'pointer'],                             result: 'i32' },
  nghttp2_submit_rst_stream:   { parameters: ['pointer', 'u8', 'i32', 'u32'],                          result: 'i32' },
  nghttp2_submit_window_update:{ parameters: ['pointer', 'u8', 'i32', 'i32'],                          result: 'i32' },

  // ---------------------------------------------------------------------------
  // h2c upgrade
  // ---------------------------------------------------------------------------
  nghttp2_session_upgrade2: { parameters: ['pointer', 'pointer', 'usize', 'i32', 'pointer'], result: 'i32' },
};

let _lib: ReturnType<typeof dlopen> | null = null;

for (const path of _CANDIDATES) {
  try {
    _lib = dlopen(path, _SYMBOLS);
    break;
  } catch {}
}

export const h2Available = _lib !== null;

export function requireH2(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error(
      'libnghttp2 not found. Install via:\n' +
      '  macOS:  brew install libnghttp2\n' +
      '  Ubuntu: apt install libnghttp2-14',
    );
  }
  return _lib;
}

export const sym = _lib?.symbols ?? null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NGHTTP2_FLAG_END_STREAM   = 0x01;
export const NGHTTP2_FLAG_END_HEADERS  = 0x04;
export const NGHTTP2_FLAG_PADDED       = 0x08;
export const NGHTTP2_FLAG_PRIORITY     = 0x20;

export const NGHTTP2_FRAME_TYPE_DATA          = 0x00;
export const NGHTTP2_FRAME_TYPE_HEADERS       = 0x01;
export const NGHTTP2_FRAME_TYPE_PRIORITY      = 0x02;
export const NGHTTP2_FRAME_TYPE_RST_STREAM    = 0x03;
export const NGHTTP2_FRAME_TYPE_SETTINGS      = 0x04;
export const NGHTTP2_FRAME_TYPE_PUSH_PROMISE  = 0x05;
export const NGHTTP2_FRAME_TYPE_PING          = 0x06;
export const NGHTTP2_FRAME_TYPE_GOAWAY        = 0x07;
export const NGHTTP2_FRAME_TYPE_WINDOW_UPDATE = 0x08;
export const NGHTTP2_FRAME_TYPE_CONTINUATION  = 0x09;

export const NGHTTP2_HCAT_REQUEST       = 0;
export const NGHTTP2_HCAT_RESPONSE      = 1;
export const NGHTTP2_HCAT_PUSH_RESPONSE = 2;
export const NGHTTP2_HCAT_HEADERS       = 3;

export const NGHTTP2_SETTINGS_HEADER_TABLE_SIZE      = 0x01;
export const NGHTTP2_SETTINGS_ENABLE_PUSH            = 0x02;
export const NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS = 0x03;
export const NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE    = 0x04;
export const NGHTTP2_SETTINGS_MAX_FRAME_SIZE         = 0x05;
export const NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE   = 0x06;

export const NGHTTP2_ERR_DEFERRED                  = -508;
export const NGHTTP2_ERR_TEMPORAL_CALLBACK_FAILURE = -521;
export const NGHTTP2_ERR_CALLBACK_FAILURE          = -902;

export const NGHTTP2_DATA_FLAG_EOF           = 0x01;
export const NGHTTP2_DATA_FLAG_NO_END_STREAM = 0x02;
export const NGHTTP2_DATA_FLAG_NO_COPY       = 0x04;

export const NGHTTP2_NV_FLAG_NONE     = 0x00;
export const NGHTTP2_NV_FLAG_NO_INDEX = 0x01;

export const NGHTTP2_PROTOCOL_ERROR  = 0x01;
export const NGHTTP2_INTERNAL_ERROR  = 0x02;
export const NGHTTP2_FLOW_CONTROL_ERROR = 0x03;
export const NGHTTP2_STREAM_CLOSED   = 0x05;
export const NGHTTP2_REFUSED_STREAM  = 0x07;
export const NGHTTP2_NO_ERROR        = 0x00;

// nghttp2_settings_id enum values used with session_get_*_settings
export const NGHTTP2_SETTINGS_ID_MAX_CONCURRENT_STREAMS = 0x03;
export const NGHTTP2_SETTINGS_ID_INITIAL_WINDOW_SIZE    = 0x04;

// ---------------------------------------------------------------------------
// Struct layout constants (from C sizeof/offsetof, verified with compiler)
// ---------------------------------------------------------------------------

// nghttp2_frame_hd (16 bytes)
export const FRAME_HD_SIZE       = 16;
export const FRAME_HD_LENGTH     = 0;   // size_t (8 bytes)
export const FRAME_HD_STREAM_ID  = 8;   // int32_t (4 bytes)
export const FRAME_HD_TYPE       = 12;  // uint8_t (1 byte)
export const FRAME_HD_FLAGS      = 13;  // uint8_t (1 byte)

// nghttp2_headers cat field offset within the full nghttp2_frame union
// nghttp2_headers { hd(16) + padlen(8) + pri_spec(12+4pad) + nva(8) + nvlen(8) + cat(4) }
export const HEADERS_CAT = 56;  // int (4 bytes)

// nghttp2_nv (40 bytes per entry)
export const NV_ENTRY_SIZE  = 40;
export const NV_NAME        = 0;   // uint8_t* (8 bytes)
export const NV_VALUE       = 8;   // uint8_t* (8 bytes)
export const NV_NAMELEN     = 16;  // size_t (8 bytes)
export const NV_VALUELEN    = 24;  // size_t (8 bytes)
export const NV_FLAGS       = 32;  // uint8_t (1 byte)

// nghttp2_data_provider2 (16 bytes)
export const DP2_SOURCE          = 0;   // union { int fd; void* ptr } (8 bytes)
export const DP2_READ_CALLBACK   = 8;   // function pointer (8 bytes)

// nghttp2_settings_entry (8 bytes)
export const SETTINGS_ENTRY_SIZE        = 8;
export const SETTINGS_ENTRY_SETTINGS_ID = 0;  // int32_t (4 bytes)
export const SETTINGS_ENTRY_VALUE       = 4;  // uint32_t (4 bytes)

// nghttp2_goaway offsets
export const GOAWAY_LAST_STREAM_ID = 16;  // int32_t at offset 16
export const GOAWAY_ERROR_CODE     = 20;  // uint32_t at offset 20

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _enc = new _TextEncoder();
const _dec = new _TextDecoder();

/** Read a null-terminated C string from a fino pointer buffer. */
export function readCStr(ptr: ArrayBuffer): string {
  const bytes: number[] = [];
  let i = 0;
  while (true) {
    const b = Pointer.readU8(ptr, i);
    if (b === 0) break;
    bytes.push(b);
    i++;
  }
  return _dec.decode(new Uint8Array(bytes));
}

/** Encode a JS string to a UTF-8 Uint8Array (NOT null-terminated). */
export function encodeUtf8(s: string): Uint8Array {
  return _enc.encode(s);
}

/**
 * Build an nghttp2_nv array in a single ArrayBuffer.
 * The header name/value data is appended after the nv structs so everything
 * stays in one allocation that the caller can hold alive for the FFI call.
 *
 * Returns `{ buf, nv }` where `buf` is the ArrayBuffer and `nv` is the number
 * of entries.
 */
export function buildNvArray(headers: Array<[string, string]>): { buf: Uint8Array; nv: number } {
  const count = headers.length;
  // Each nv entry: 40 bytes. Data follows after all entries.
  const dataBlobs: Uint8Array[] = headers.map(([n, v]) => {
    const nb = _enc.encode(n.toLowerCase());
    const vb = _enc.encode(v);
    const blob = new Uint8Array(nb.length + vb.length);
    blob.set(nb, 0);
    blob.set(vb, nb.length);
    return blob;
  });
  const totalData = dataBlobs.reduce((s, b) => s + b.length, 0);
  const buf = new Uint8Array(count * NV_ENTRY_SIZE + totalData);

  let dataOffset = count * NV_ENTRY_SIZE;
  const dv = new DataView(buf.buffer);

  for (let i = 0; i < count; i++) {
    const [name, value] = headers[i]!;
    const nb = _enc.encode(name.toLowerCase());
    const vb = _enc.encode(value);
    const base = i * NV_ENTRY_SIZE;
    const nameAddr = Pointer.addr(buf) as bigint + BigInt(dataOffset);
    const valueAddr = nameAddr + BigInt(nb.length);

    buf.set(nb, dataOffset);
    buf.set(vb, dataOffset + nb.length);
    dataOffset += nb.length + vb.length;

    // Write the nv entry pointers — C addresses of name/value bytes within buf.
    // Use DataView.setBigUint64 to write into buf's bytes directly (not via pointer deref).
    dv.setBigUint64(base + NV_NAME,    nameAddr,            true);
    dv.setBigUint64(base + NV_VALUE,   valueAddr,           true);
    dv.setBigUint64(base + NV_NAMELEN, BigInt(nb.length),   true);
    dv.setBigUint64(base + NV_VALUELEN, BigInt(vb.length),  true);
    buf[base + NV_FLAGS] = NGHTTP2_NV_FLAG_NONE;
  }

  return { buf, nv: count };
}

/**
 * Allocate and populate a settings array for nghttp2_submit_settings.
 * Returns a Uint8Array that must be kept alive during the FFI call.
 */
export function buildSettingsArray(settings: Array<[number, number]>): Uint8Array {
  const buf = new Uint8Array(settings.length * SETTINGS_ENTRY_SIZE);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < settings.length; i++) {
    const base = i * SETTINGS_ENTRY_SIZE;
    dv.setInt32(base + SETTINGS_ENTRY_SETTINGS_ID, settings[i]![0]!, true);
    dv.setUint32(base + SETTINGS_ENTRY_VALUE, settings[i]![1]!, true);
  }
  return buf;
}

/**
 * Read length+type+stream_id+flags from an nghttp2_frame* pointer.
 */
export function readFrameHd(frame: ArrayBuffer): { length: number; streamId: number; type: number; flags: number } {
  return {
    length:   Number(Pointer.readU64(frame, FRAME_HD_LENGTH) as bigint),
    streamId: Pointer.readI32(frame, FRAME_HD_STREAM_ID) as number,
    type:     Pointer.readU8(frame, FRAME_HD_TYPE) as number,
    flags:    Pointer.readU8(frame, FRAME_HD_FLAGS) as number,
  };
}

/**
 * Read the `cat` field from an nghttp2_headers* (which is an nghttp2_frame*
 * for HEADERS frames).
 */
export function readHeadersCat(frame: ArrayBuffer): number {
  return Pointer.readI32(frame, HEADERS_CAT) as number;
}
