/**
 * internal:net/http/h3/bindings - optional libnghttp3 dynamic bindings.
 *
 * This module is the raw FFI floor of the HTTP/3 stack. It `dlopen`s
 * libnghttp3 — the QPACK + HTTP/3 framing engine that sits on top of QUIC — and
 * re-exports its symbols alongside the struct layout constants, protocol error
 * codes, and small marshalling helpers that the higher-level session, server,
 * and client modules build on. Everything here is deliberately low-level:
 * callers work in terms of byte offsets, `Pointer` reads, and manually packed
 * `nghttp3_nv` / `nghttp3_callbacks` / `nghttp3_settings` buffers, because
 * libnghttp3 exposes no getters and its structs must be assembled by hand.
 *
 * The binding is intentionally optional. `h3Available === false` is a supported
 * release state for builds that do not ship libnghttp3: the candidate library
 * paths simply fail to `dlopen`, `sym` stays `null`, and internal H3 helpers
 * call `requireH3()` so they throw a clear installation error before opening any
 * socket. Linux release builds resolve the statically linked copy from the Fino
 * executable before trying system library paths. Enabled builds are expected to
 * pass the local simulated and loopback H3 suites.
 *
 * Struct offsets are fixed for the ABI versions pinned by
 * `NGHTTP3_CALLBACKS_VERSION` and `NGHTTP3_SETTINGS_VERSION`; they are not
 * discovered at runtime, so bumping the vendored libnghttp3 major version means
 * re-checking every `CB_*`, `NV_*`, `VEC_*`, `DR_*`, and `SETTINGS_*` constant
 * against the corresponding C header. This binding covers the request/response
 * HTTP/3 surface used by the internal helpers. Connection reuse,
 * WebTransport/Capsule, H3 DATAGRAM, CONNECT tunnels, and external H3 interop
 * remain deferred above this FFI layer.
 *
 * ```ts no_run
 * import {
 *   h3Available,
 *   requireH3,
 *   buildNvArray,
 * } from 'internal:net/http/h3/bindings';
 *
 * if (!h3Available) throw new Error('this build has no HTTP/3 support');
 *
 * const lib = requireH3();
 * const { buf, nv } = buildNvArray([
 *   [':status', '200'],
 *   ['content-type', 'text/plain'],
 * ]);
 * // `buf` keeps the header bytes alive; `nv` is the entry count to pass to
 * // nghttp3_conn_submit_response alongside Pointer.addr(buf).
 * ```
 *
 * HTTP/3 specification: https://www.rfc-editor.org/rfc/rfc9114
 *
 * @internal
 */
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import {
  TextEncoder as _TextEncoder,
  TextDecoder as _TextDecoder,
} from '../../../../globals/encoding.ts';
/**
 * Re-exports of the FFI primitives that H3 callers need together with these
 * bindings.
 *
 * `Pointer` supplies the typed memory reads (`readU8`, `readU64`,
 * `readPointer`, `copyFromInto`, `addr`) used to walk libnghttp3 structs, and
 * `FfiCallback` wraps a JS function as a C function pointer for the connection
 * callback table. They are surfaced here so a module can import the pointer
 * tooling and the H3 layout constants from a single specifier.
 */
export { Pointer, FfiCallback };
const _IS_DARWIN = os === 'darwin';
const _CANDIDATES = _IS_DARWIN
  ? [
      '/opt/homebrew/opt/libnghttp3/lib/libnghttp3.dylib',
      '/opt/homebrew/lib/libnghttp3.dylib',
      '/usr/local/lib/libnghttp3.dylib',
      '/opt/local/lib/libnghttp3.dylib',
    ]
  : [
      null,
      'libnghttp3.so.9',
      'libnghttp3.so',
      '/usr/lib64/libnghttp3.so.9',
      '/usr/lib/x86_64-linux-gnu/libnghttp3.so',
      '/usr/lib/aarch64-linux-gnu/libnghttp3.so',
      '/usr/lib/libnghttp3.so',
      '/usr/local/lib/libnghttp3.so',
    ];
const _SYMBOLS = {
  nghttp3_strerror: {
    parameters: ['i32'],
    result: 'pointer',
  },
  nghttp3_conn_server_new_versioned: {
    parameters: ['pointer', 'i32', 'pointer', 'i32', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  nghttp3_conn_client_new_versioned: {
    parameters: ['pointer', 'i32', 'pointer', 'i32', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  nghttp3_conn_del: {
    parameters: ['pointer'],
    result: 'void',
  },
  nghttp3_conn_read_stream2: {
    parameters: ['pointer', 'i64', 'pointer', 'usize', 'i32', 'u64'],
    result: 'isize',
  },
  nghttp3_conn_writev_stream: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer', 'usize'],
    result: 'isize',
  },
  nghttp3_conn_add_write_offset: {
    parameters: ['pointer', 'i64', 'usize'],
    result: 'i32',
  },
  nghttp3_conn_block_stream: {
    parameters: ['pointer', 'i64'],
    result: 'void',
  },
  nghttp3_conn_unblock_stream: {
    parameters: ['pointer', 'i64'],
    result: 'i32',
  },
  nghttp3_conn_resume_stream: {
    parameters: ['pointer', 'i64'],
    result: 'i32',
  },
  nghttp3_conn_bind_control_stream: {
    parameters: ['pointer', 'i64'],
    result: 'i32',
  },
  nghttp3_conn_bind_qpack_streams: {
    parameters: ['pointer', 'i64', 'i64'],
    result: 'i32',
  },
  nghttp3_conn_submit_response: {
    parameters: ['pointer', 'i64', 'pointer', 'usize', 'pointer'],
    result: 'i32',
  },
  nghttp3_conn_submit_request: {
    parameters: ['pointer', 'i64', 'pointer', 'usize', 'pointer', 'pointer'],
    result: 'i32',
  },
  nghttp3_conn_submit_trailers: {
    parameters: ['pointer', 'i64', 'pointer', 'usize'],
    result: 'i32',
  },
  nghttp3_conn_shutdown: {
    parameters: ['pointer'],
    result: 'i32',
  },
  nghttp3_conn_submit_shutdown_notice: {
    parameters: ['pointer'],
    result: 'i32',
  },
  nghttp3_conn_is_drained: {
    parameters: ['pointer'],
    result: 'i32',
  },
  nghttp3_conn_close_stream: {
    parameters: ['pointer', 'i64', 'u64'],
    result: 'i32',
  },
  nghttp3_settings_default_versioned: {
    parameters: ['i32', 'pointer'],
    result: 'void',
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
 * Whether libnghttp3 was found and loaded on this host.
 *
 * Set once at module load by trying each platform candidate path in turn. When
 * `false`, no HTTP/3 functionality is available and `sym` is `null`; callers
 * should branch on this to decline H3 gracefully rather than let a later call
 * throw. This is a supported build state, not an error.
 *
 * ```ts no_run
 * import { h3Available } from 'internal:net/http/h3/bindings';
 *
 * const protocols = h3Available ? ['h3', 'h2'] : ['h2'];
 * ```
 */
export const h3Available = _lib !== null;
/**
 * Returns the loaded libnghttp3 handle, throwing an install-guidance error if
 * the library is absent.
 *
 * This is the enforcement point that lets the rest of the H3 stack assume a
 * usable library: helpers call it at the top of any operation that would open a
 * socket or touch native state, so an unsupported build fails fast with a clear
 * message instead of dereferencing `null` symbols. On success the returned
 * handle exposes `.symbols` — the same object as `sym` when non-null.
 *
 * Throws an `Error` naming the `brew` / `apt` install commands when libnghttp3
 * could not be found at any candidate path.
 *
 * ```ts no_run
 * import { requireH3 } from 'internal:net/http/h3/bindings';
 *
 * function openH3Connection() {
 *   const lib = requireH3(); // throws here if H3 is unavailable
 *   return lib.symbols.nghttp3_conn_shutdown;
 * }
 * ```
 */
export function requireH3(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error(
      'libnghttp3 not found. Install via:\n' +
        '  macOS:  brew install libnghttp3\n' +
        '  Ubuntu: apt install libnghttp3-dev',
    );
  }
  return _lib;
}
/**
 * The libnghttp3 symbol table, or `null` when the library is unavailable.
 *
 * Each property is a callable FFI wrapper for the correspondingly named
 * `nghttp3_*` C function declared in the internal symbol map. Access it directly
 * when a call site has already guarded on `h3Available`; otherwise prefer
 * `requireH3().symbols`, which throws instead of yielding `null`.
 *
 * ```ts no_run
 * import { sym, requireH3 } from 'internal:net/http/h3/bindings';
 *
 * const symbols = sym ?? requireH3().symbols;
 * const msgPtr = symbols.nghttp3_strerror(-103);
 * ```
 */
export const sym = _lib?.symbols ?? null;
// ---------------------------------------------------------------------------
// Versioning constants for nghttp3_conn_*_new_versioned calls.
// ---------------------------------------------------------------------------
/**
 * ABI version of the `nghttp3_callbacks` struct, passed to the
 * `nghttp3_conn_*_new_versioned` constructors so libnghttp3 interprets the
 * callback table with the matching field layout. Must agree with the `CB_*`
 * offsets below.
 */
export const NGHTTP3_CALLBACKS_VERSION = 3;
/**
 * ABI version of the `nghttp3_settings` struct, passed to
 * `nghttp3_settings_default_versioned` and the connection constructors. Must
 * agree with `SETTINGS_SIZE` and the `SETTINGS_*` offsets below.
 */
export const NGHTTP3_SETTINGS_VERSION = 4;
// ---------------------------------------------------------------------------
// nghttp3_callbacks struct offsets (19 × 8-byte function pointers = 152 bytes).
// ---------------------------------------------------------------------------
/**
 * Total byte size of the `nghttp3_callbacks` struct (19 slots × 8-byte function
 * pointers). Allocate a zeroed buffer of this size, write the callbacks you
 * implement at their `CB_*` offsets with `writeCbPtr`, and pass its address to
 * the connection constructor. Unset slots stay zero and libnghttp3 treats them
 * as absent.
 */
export const CB_SIZE = 152;
/** Byte offset of the `acked_stream_data` callback — fired when the peer has acknowledged sent stream data, freeing send buffers. */
export const CB_ACKED_STREAM_DATA = 0;
/** Byte offset of the `stream_close` callback — fired when a stream is fully closed with its application error code. */
export const CB_STREAM_CLOSE = 8;
/** Byte offset of the `recv_data` callback — delivers a chunk of request/response body bytes for a stream. */
export const CB_RECV_DATA = 16;
/** Byte offset of the `deferred_consume` callback — reports flow-control consumption of data that was previously deferred. */
export const CB_DEFERRED_CONSUME = 24;
/** Byte offset of the `begin_headers` callback — marks the start of a header block for a stream. */
export const CB_BEGIN_HEADERS = 32;
/** Byte offset of the `recv_header` callback — delivers one decoded header name/value pair (QPACK). */
export const CB_RECV_HEADER = 40;
/** Byte offset of the `end_headers` callback — marks the end of a header block. */
export const CB_END_HEADERS = 48;
/** Byte offset of the `begin_trailers` callback — marks the start of a trailing header block. */
export const CB_BEGIN_TRAILERS = 56;
/** Byte offset of the `recv_trailer` callback — delivers one decoded trailer name/value pair. */
export const CB_RECV_TRAILER = 64;
/** Byte offset of the `end_trailers` callback — marks the end of a trailing header block. */
export const CB_END_TRAILERS = 72;
/** Byte offset of the `stop_sending` callback — the peer asked us to stop sending on a stream. */
export const CB_STOP_SENDING = 80;
/** Byte offset of the `end_stream` callback — the peer signalled the end of the request/response on a stream. */
export const CB_END_STREAM = 88;
/** Byte offset of the `reset_stream` callback — the stream was reset by the peer. */
export const CB_RESET_STREAM = 96;
/** Byte offset of the `shutdown` callback — the connection is shutting down and no new streams should be created. */
export const CB_SHUTDOWN = 104;
// offset 112: recv_settings (deprecated, leave zeroed)
// offset 120: recv_origin  (optional)
// offset 128: end_origin   (optional)
// offset 136: rand         (optional)
/** Byte offset of the `recv_settings2` callback — delivers the peer's decoded SETTINGS frame as an `nghttp3_proto_settings` pointer. */
export const CB_RECV_SETTINGS2 = 144;
// ---------------------------------------------------------------------------
// nghttp3_nv (name/value) struct — identical layout to nghttp2_nv.
// ---------------------------------------------------------------------------
/** Byte size of one `nghttp3_nv` header entry (name ptr, value ptr, two lengths, flags + padding). `buildNvArray` uses this to stride the entry array. */
export const NV_ENTRY_SIZE = 40;
/** Offset within an `nghttp3_nv` entry of the `name` field — a pointer to the header-name bytes. */
export const NV_NAME = 0;
/** Offset within an `nghttp3_nv` entry of the `value` field — a pointer to the header-value bytes. */
export const NV_VALUE = 8;
/** Offset within an `nghttp3_nv` entry of `namelen` — the header-name byte length. */
export const NV_NAMELEN = 16;
/** Offset within an `nghttp3_nv` entry of `valuelen` — the header-value byte length. */
export const NV_VALUELEN = 24;
/** Offset within an `nghttp3_nv` entry of the one-byte `flags` field (see the `NGHTTP3_NV_FLAG_*` values). */
export const NV_FLAGS = 32;
/** The default `nghttp3_nv` flag — normal header, eligible for QPACK indexing. */
export const NGHTTP3_NV_FLAG_NONE = 0;
/** `nghttp3_nv` flag marking a header that must never be QPACK-indexed (for sensitive values such as authorization tokens). */
export const NGHTTP3_NV_FLAG_NEVER_INDEX = 1;
// ---------------------------------------------------------------------------
// nghttp3_vec struct (16 bytes per entry: ptr + len).
// ---------------------------------------------------------------------------
/** Byte size of one `nghttp3_vec` scatter/gather entry (base pointer + length), the unit libnghttp3 fills when asking for outbound stream data. */
export const VEC_ENTRY_SIZE = 16;
/** Offset within an `nghttp3_vec` entry of the `base` field — a pointer to the buffer to send. */
export const VEC_BASE = 0;
/** Offset within an `nghttp3_vec` entry of the `len` field — the number of bytes at `base`. */
export const VEC_LEN = 8;
// ---------------------------------------------------------------------------
// nghttp3_data_reader struct (8 bytes — only one field: read_data at offset 0).
// ---------------------------------------------------------------------------
/** Offset within an `nghttp3_data_reader` struct of its single `read_data` field — the function pointer libnghttp3 calls to pull outbound body bytes. */
export const DR_READ_DATA = 0;
/** Byte size of an `nghttp3_data_reader` struct (one function pointer). Allocate this many bytes and write the reader callback at `DR_READ_DATA`. */
export const DR_SIZE = 8;
// ---------------------------------------------------------------------------
// nghttp3_settings struct size (V4 = 72 bytes on 64-bit).
// ---------------------------------------------------------------------------
/** Byte size of the V4 `nghttp3_settings` struct on 64-bit targets. Allocate a zeroed buffer of this size and fill it via `nghttp3_settings_default_versioned` before adjusting fields. */
export const SETTINGS_SIZE = 72;
/** Offset of the advertised maximum decoded field-section size (`SETTINGS_MAX_FIELD_SECTION_SIZE`). */
export const SETTINGS_MAX_FIELD_SECTION_SIZE = 0;
/** Offset of the decoder's maximum QPACK dynamic-table capacity. */
export const SETTINGS_QPACK_MAX_DTABLE_CAPACITY = 8;
/** Offset of the encoder's maximum QPACK dynamic-table capacity. */
export const SETTINGS_QPACK_ENCODER_MAX_DTABLE_CAPACITY = 16;
/** Offset of the maximum number of QPACK-blocked streams. */
export const SETTINGS_QPACK_BLOCKED_STREAMS = 24;
/** Offset within `nghttp3_settings` of the one-byte `enable_connect_protocol` flag — advertises support for extended CONNECT (RFC 9220). */
export const SETTINGS_ENABLE_CONNECT_PROTOCOL = 32;
/** Offset within `nghttp3_settings` of the one-byte `h3_datagram` flag — advertises support for HTTP/3 DATAGRAM (RFC 9297). */
export const SETTINGS_H3_DATAGRAM = 33;
// ---------------------------------------------------------------------------
// nghttp3_proto_settings struct offsets used by recv_settings2.
// ---------------------------------------------------------------------------
/** Offset within the `nghttp3_proto_settings` struct handed to the `recv_settings2` callback of the peer's `enable_connect_protocol` flag. */
export const PROTO_SETTINGS_ENABLE_CONNECT_PROTOCOL = 24;
/** Offset within the `nghttp3_proto_settings` struct handed to the `recv_settings2` callback of the peer's `h3_datagram` flag. */
export const PROTO_SETTINGS_H3_DATAGRAM = 25;
/** Offset of the peer's `SETTINGS_MAX_FIELD_SECTION_SIZE` value. */
export const PROTO_SETTINGS_MAX_FIELD_SECTION_SIZE = 0;
/** Offset of the peer's QPACK dynamic-table capacity. */
export const PROTO_SETTINGS_QPACK_MAX_DTABLE_CAPACITY = 8;
/** Offset of the peer's maximum number of QPACK-blocked streams. */
export const PROTO_SETTINGS_QPACK_BLOCKED_STREAMS = 16;
// ---------------------------------------------------------------------------
// Data flag written into *pflags in read_data callbacks.
// ---------------------------------------------------------------------------
/** `read_data` flag written into `*pflags` to mark the final body chunk — this is the last data on the stream. */
export const NGHTTP3_DATA_FLAG_EOF = 1;
/** `read_data` flag combined with EOF to signal end-of-body without closing the stream, for cases such as trailers that follow the data. */
export const NGHTTP3_DATA_FLAG_NO_END_STREAM = 2;
// ---------------------------------------------------------------------------
// Application error codes (H3 layer).
// ---------------------------------------------------------------------------
/** H3 application error code (`H3_NO_ERROR`) for a clean stream or connection close with no error, as a `bigint` for the 62-bit QUIC error space. */
export const NGHTTP3_H3_NO_ERROR = 256n;
/** H3 application error code (`H3_GENERAL_PROTOCOL_ERROR`) for a protocol violation not covered by a more specific code. */
export const NGHTTP3_H3_GENERAL_PROTOCOL_ERROR = 257n;
/** H3 application error code (`H3_INTERNAL_ERROR`) for an internal fault in the endpoint. */
export const NGHTTP3_H3_INTERNAL_ERROR = 258n;
/** H3 application error code (`H3_REQUEST_CANCELLED`) indicating the request was cancelled before completion. */
export const NGHTTP3_H3_REQUEST_CANCELLED = 268n;
/** H3 application error code (`H3_REQUEST_INCOMPLETE`) indicating the request or response was truncated before it finished. */
export const NGHTTP3_H3_REQUEST_INCOMPLETE = 269n;
// ---------------------------------------------------------------------------
// Library error codes.
// ---------------------------------------------------------------------------
/** libnghttp3 return code meaning the operation would block — treat as a soft "try again later", not a failure, e.g. when a write vector is temporarily empty. */
export const NGHTTP3_ERR_WOULDBLOCK = -103;
/** libnghttp3 return code meaning the connection is closing and no further work can be submitted on it. */
export const NGHTTP3_ERR_CONN_CLOSING = -111;
/** libnghttp3 return code meaning a received header was malformed. */
export const NGHTTP3_ERR_MALFORMED_HTTP_HEADER = -105;
/** libnghttp3 return code meaning the HTTP message framing was malformed (e.g. missing required pseudo-headers). */
export const NGHTTP3_ERR_MALFORMED_HTTP_MESSAGING = -107;
/** Threshold marking libnghttp3's fatal error range — return codes at or below this indicate the connection is unusable and must be torn down. */
export const NGHTTP3_ERR_FATAL = -900;
/** H3 application error code (`H3_MESSAGE_ERROR`) for a malformed request or response message, used when resetting the offending stream. */
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
/**
 * Reads a NUL-terminated C string from native memory into a JS string.
 *
 * Scans forward from the start of `ptr` one byte at a time until it hits the
 * first `0x00`, then UTF-8 decodes the bytes before it. Intended for the small,
 * static strings libnghttp3 returns — most usefully the message pointer from
 * `nghttp3_strerror`. It reads until the terminator, so `ptr` must reference a
 * buffer that is actually NUL-terminated and mapped, or the scan will run off
 * the end.
 *
 * ```ts no_run
 * import { readCStr, requireH3, Pointer } from 'internal:net/http/h3/bindings';
 *
 * const msgPtr = requireH3().symbols.nghttp3_strerror(-103) as ArrayBuffer;
 * console.log(readCStr(msgPtr)); // "ERR_WOULDBLOCK" style text
 * ```
 */
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
/**
 * UTF-8 encodes a string into a fresh `Uint8Array`, sharing this module's
 * `TextEncoder`.
 *
 * A thin convenience so H3 helpers can turn a JS string into the raw bytes they
 * need to hand to native calls — request bodies, header values built ad hoc —
 * without each site allocating its own encoder. The returned array owns its
 * backing buffer; keep a reference to it for as long as native code may read
 * the bytes.
 *
 * ```ts no_run
 * import { encodeUtf8, Pointer } from 'internal:net/http/h3/bindings';
 *
 * const body = encodeUtf8('{"ok":true}');
 * const addr = Pointer.addr(body); // stable while `body` is retained
 * ```
 */
export function encodeUtf8(s: string): Uint8Array {
  return _enc.encode(s);
}
/**
 * Decodes an `nghttp3_rcbuf` reference-counted buffer into a JS string.
 *
 * libnghttp3 delivers decoded header names and values as `nghttp3_rcbuf`
 * pointers whose `nghttp3_vec base`/`len` fields sit at offsets 8 and 16. This
 * reads that base pointer and length, copies the bytes into a shared,
 * geometrically-growing scratch buffer, and UTF-8 decodes them. Returns `""`
 * for a null base or zero length.
 *
 * The scratch buffer is reused across calls and is not thread-affine within a
 * callback, so the returned string must be consumed (or copied) before the next
 * `readRcbuf` call overwrites the scratch region; because it decodes eagerly to
 * an immutable JS string, storing the result is always safe.
 *
 * ```ts no_run
 * import { readRcbuf } from 'internal:net/http/h3/bindings';
 *
 * // Inside a recv_header callback, name/value arrive as rcbuf pointers:
 * function onHeader(nameRcbuf: ArrayBuffer, valueRcbuf: ArrayBuffer) {
 *   const name = readRcbuf(nameRcbuf);
 *   const value = readRcbuf(valueRcbuf);
 *   return [name, value] as const;
 * }
 * ```
 */
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
/**
 * Packs a list of header name/value pairs into a native `nghttp3_nv` array for
 * submission.
 *
 * Returns `{ buf, nv }`: `buf` is a single `Uint8Array` holding the entry array
 * immediately followed by the interned name and value bytes, and `nv` is the
 * entry count. Each entry's `name`/`value` pointers are absolute addresses into
 * `buf` itself, computed once from `Pointer.addr(buf)` — so the entire header
 * block is one allocation with no per-header pointer bookkeeping. Header names
 * are lowercased and their encodings cached across calls; values are encoded
 * fresh each time. Every entry uses `NGHTTP3_NV_FLAG_NONE`.
 *
 * Because the pointers embedded in `buf` reference `buf`'s own memory, the
 * caller must keep `buf` alive (and unmoved) until the native submit call has
 * fully consumed it — dropping the reference lets the GC free the bytes the
 * pointers still target. Pass `Pointer.addr(buf)` as the `nva` argument and `nv`
 * as the count.
 *
 * ```ts no_run
 * import { buildNvArray, Pointer, requireH3 } from 'internal:net/http/h3/bindings';
 *
 * const { buf, nv } = buildNvArray([
 *   [':status', '200'],
 *   ['content-type', 'application/json'],
 * ]);
 * requireH3().symbols.nghttp3_conn_submit_response(
 *   conn, streamId, Pointer.addr(buf), nv, dataReaderPtr,
 * );
 * // keep `buf` referenced until the submit call returns
 * ```
 */
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
    nv: count,
  };
}
// Write an FfiCallback's function pointer into a struct buffer at the given offset.
/**
 * Writes an `FfiCallback`'s native function pointer into a struct buffer at a
 * byte offset.
 *
 * Reads the 64-bit little-endian address out of the callback's `pointer`
 * ArrayBuffer and stores it into `buf` at `offset`. This is the mechanism for
 * populating both the `nghttp3_callbacks` table (write each implemented callback
 * at its `CB_*` offset into a `CB_SIZE` buffer) and the one-field
 * `nghttp3_data_reader` (write the reader at `DR_READ_DATA`). `cb` is any object
 * exposing a `pointer` ArrayBuffer, so an `FfiCallback` passes directly.
 *
 * The offset must leave 8 bytes inside `buf`; the write is unchecked beyond the
 * buffer's own bounds. As with all callback tables, `buf` and the underlying
 * `FfiCallback` must outlive the native connection that holds the pointer.
 *
 * ```ts no_run
 * import {
 *   writeCbPtr, CB_SIZE, CB_RECV_DATA, FfiCallback,
 * } from 'internal:net/http/h3/bindings';
 *
 * const cbs = new Uint8Array(CB_SIZE);
 * const recvData = new FfiCallback(
 *   { parameters: ['pointer'], result: 'i32' },
 *   () => 0,
 * );
 * writeCbPtr(cbs, CB_RECV_DATA, recvData);
 * // pass Pointer.addr(cbs) to nghttp3_conn_*_new_versioned
 * ```
 */
export function writeCbPtr(
  buf: Uint8Array,
  offset: number,
  cb: {
    pointer: ArrayBuffer;
  },
): void {
  const addr = new DataView(cb.pointer).getBigUint64(0, true);
  new DataView(buf.buffer, buf.byteOffset).setBigUint64(offset, addr, true);
}
