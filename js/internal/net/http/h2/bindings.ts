/**
 * internal:net/http/h2/bindings — system libnghttp2 loaded via dlopen.
 *
 * This module is the raw FFI foundation for Fino's HTTP/2 stack. It locates a
 * system-installed `libnghttp2`, binds the subset of the C API the higher-level
 * session code needs, and exposes the numeric constants, struct-layout offsets,
 * and byte-marshalling helpers required to drive nghttp2 from JavaScript. It
 * deliberately performs no protocol logic of its own — session lifecycle,
 * callback wiring, and stream state live in the modules that consume `sym`,
 * `requireH2()`, and these helpers.
 *
 * The library is discovered at module load by trying a list of candidate paths
 * in order and stopping at the first that `dlopen` accepts. Homebrew locations
 * come first on macOS so a `brew install libnghttp2` build wins over anything
 * older in the system prefix; Linux tries the SONAME plus the common
 * multiarch directories. The outcome is frozen into `h2Available`: when no
 * candidate loads, `sym` is `null` and `requireH2()` throws with install
 * guidance, letting callers degrade gracefully to HTTP/1.
 *
 * The in-memory session pump symbols (`nghttp2_session_mem_recv2` and
 * `nghttp2_session_mem_send2`) are bound synchronously rather than as
 * `async: true` FFI. They do no socket I/O — they only move bytes between JS
 * buffers and nghttp2's internal state — so running them on the V8 thread
 * avoids thread-pool overhead and, critically, keeps nghttp2's callbacks and
 * submit operations serialized against a single native session that is not
 * internally synchronized.
 *
 * Because every export is a low-level binding, all symbols are `@internal`:
 * they are importable only from other built-ins and are not part of Fino's
 * public surface. Callers marshal headers and settings into single
 * ArrayBuffers (`buildNvArray`, `buildSettingsArray`) and must keep those
 * buffers alive across the FFI call, since nghttp2 reads through the raw
 * pointers they contain.
 *
 * HTTP/2 specification: https://www.rfc-editor.org/rfc/rfc9113
 *
 * ```ts no_run
 * import {
 *   h2Available,
 *   requireH2,
 *   buildSettingsArray,
 *   NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS,
 * } from 'internal:net/http/h2/bindings';
 *
 * if (h2Available) {
 *   const lib = requireH2();
 *   const settings = buildSettingsArray([
 *     [NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, 100],
 *   ]);
 *   // `settings` is now ready to hand to nghttp2_submit_settings via lib.symbols.
 *   void lib;
 * }
 * ```
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
 * Re-export the FFI pointer helper used by HTTP/2 internals.
 *
 * `Pointer` is a low-level Fino FFI primitive. Consumers must keep pointed-to
 * buffers alive for as long as native code can reference them.
 *
 * ```ts no_run
 * import { Pointer } from 'internal:net/http/h2/bindings';
 * Pointer.of(new Uint8Array(8));
 * ```
 *
 * @internal
 */
export { Pointer };
/**
 * Re-export the FFI callback helper used by HTTP/2 internals.
 *
 * Callback objects must remain strongly referenced until native code can no
 * longer invoke them. `Nghttp2Session` stores and closes its callback objects
 * during session shutdown.
 *
 * ```ts no_run
 * import { FfiCallback } from 'internal:net/http/h2/bindings';
 * const cb = new FfiCallback({ parameters: [], result: 'void' }, () => {});
 * cb.close();
 * ```
 *
 * @internal
 */
export { FfiCallback };
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
  nghttp2_version: {
    parameters: ['i32'],
    result: 'pointer',
  },
  nghttp2_strerror: {
    parameters: ['i32'],
    result: 'pointer',
  },
  nghttp2_session_callbacks_new: {
    parameters: ['pointer'],
    result: 'i32',
  },
  nghttp2_session_callbacks_del: {
    parameters: ['pointer'],
    result: 'void',
  },
  nghttp2_session_callbacks_set_on_begin_headers_callback: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  nghttp2_session_callbacks_set_on_header_callback: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  nghttp2_session_callbacks_set_on_frame_recv_callback: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  nghttp2_session_callbacks_set_on_data_chunk_recv_callback: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  nghttp2_session_callbacks_set_on_stream_close_callback: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  nghttp2_session_callbacks_set_error_callback2: {
    parameters: ['pointer', 'pointer'],
    result: 'void',
  },
  nghttp2_option_new: {
    parameters: ['pointer'],
    result: 'i32',
  },
  nghttp2_option_del: {
    parameters: ['pointer'],
    result: 'void',
  },
  nghttp2_option_set_no_auto_window_update: {
    parameters: ['pointer', 'i32'],
    result: 'void',
  },
  nghttp2_option_set_peer_max_concurrent_streams: {
    parameters: ['pointer', 'u32'],
    result: 'void',
  },
  nghttp2_option_set_no_recv_client_magic: {
    parameters: ['pointer', 'i32'],
    result: 'void',
  },
  nghttp2_option_set_no_http_messaging: {
    parameters: ['pointer', 'i32'],
    result: 'void',
  },
  nghttp2_session_server_new2: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  nghttp2_session_client_new2: {
    parameters: ['pointer', 'pointer', 'pointer', 'pointer'],
    result: 'i32',
  },
  nghttp2_session_del: {
    parameters: ['pointer'],
    result: 'void',
  },
  nghttp2_session_mem_recv2: {
    parameters: ['pointer', 'pointer', 'usize'],
    result: 'i32',
  },
  nghttp2_session_mem_send2: {
    parameters: ['pointer', 'pointer'],
    result: 'i32',
  },
  nghttp2_session_want_read: {
    parameters: ['pointer'],
    result: 'i32',
  },
  nghttp2_session_want_write: {
    parameters: ['pointer'],
    result: 'i32',
  },
  nghttp2_session_resume_data: {
    parameters: ['pointer', 'i32'],
    result: 'i32',
  },
  nghttp2_session_consume: {
    parameters: ['pointer', 'i32', 'usize'],
    result: 'i32',
  },
  nghttp2_session_get_stream_user_data: {
    parameters: ['pointer', 'i32'],
    result: 'pointer',
  },
  nghttp2_session_set_stream_user_data: {
    parameters: ['pointer', 'i32', 'pointer'],
    result: 'i32',
  },
  nghttp2_session_get_local_settings: {
    parameters: ['pointer', 'i32'],
    result: 'u32',
  },
  nghttp2_session_get_remote_settings: {
    parameters: ['pointer', 'i32'],
    result: 'u32',
  },
  nghttp2_submit_settings: {
    parameters: ['pointer', 'u8', 'pointer', 'usize'],
    result: 'i32',
  },
  nghttp2_submit_response2: {
    parameters: ['pointer', 'i32', 'pointer', 'usize', 'pointer'],
    result: 'i32',
  },
  nghttp2_submit_request2: {
    parameters: ['pointer', 'pointer', 'pointer', 'usize', 'pointer', 'pointer'],
    result: 'i32',
  },
  nghttp2_submit_trailer: {
    parameters: ['pointer', 'i32', 'pointer', 'usize'],
    result: 'i32',
  },
  nghttp2_submit_goaway: {
    parameters: ['pointer', 'u8', 'i32', 'u32', 'pointer', 'usize'],
    result: 'i32',
  },
  nghttp2_submit_ping: {
    parameters: ['pointer', 'u8', 'pointer'],
    result: 'i32',
  },
  nghttp2_submit_rst_stream: {
    parameters: ['pointer', 'u8', 'i32', 'u32'],
    result: 'i32',
  },
  nghttp2_submit_window_update: {
    parameters: ['pointer', 'u8', 'i32', 'i32'],
    result: 'i32',
  },
  nghttp2_session_upgrade2: {
    parameters: ['pointer', 'pointer', 'usize', 'i32', 'pointer'],
    result: 'i32',
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
 * Whether libnghttp2 was found and loaded.
 *
 * This is a process-start snapshot based on candidate library paths. It is
 * `false` when the library cannot be loaded, in which case `requireH2()`
 * throws with installation guidance.
 *
 * ```ts
 * import { h2Available } from 'internal:net/http/h2/bindings';
 * Boolean(h2Available);
 * ```
 *
 * @internal
 */
export const h2Available = _lib !== null;
/**
 * Return the loaded libnghttp2 FFI handle or throw.
 *
 * The function does not attempt to load additional paths after module
 * initialization. It throws an `Error` with platform installation hints when
 * no candidate library was loaded.
 *
 * ```ts no_run
 * import { requireH2 } from 'internal:net/http/h2/bindings';
 * const lib = requireH2();
 * lib.symbols;
 * ```
 *
 * @internal
 */
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
/**
 * Bound libnghttp2 symbol table, or `null` when unavailable.
 *
 * Callers should prefer `requireH2()` when they need a guaranteed handle.
 * Methods on this object are raw FFI bindings and follow the signatures in the
 * private `_SYMBOLS` table.
 *
 * ```ts
 * import { sym } from 'internal:net/http/h2/bindings';
 * sym === null || typeof sym === 'object';
 * ```
 *
 * @internal
 */
export const sym = _lib?.symbols ?? null;
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/**
 * HTTP/2 frame flag indicating no more data on the stream.
 *
 * ```ts
 * import { NGHTTP2_FLAG_END_STREAM } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FLAG_END_STREAM;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FLAG_END_STREAM = 1;
/**
 * HTTP/2 frame flag indicating a complete header block.
 *
 * ```ts
 * import { NGHTTP2_FLAG_END_HEADERS } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FLAG_END_HEADERS;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FLAG_END_HEADERS = 4;
/**
 * HTTP/2 frame flag indicating a PADDED field is present.
 *
 * ```ts
 * import { NGHTTP2_FLAG_PADDED } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FLAG_PADDED;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FLAG_PADDED = 8;
/**
 * HTTP/2 frame flag indicating priority metadata is present.
 *
 * ```ts
 * import { NGHTTP2_FLAG_PRIORITY } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FLAG_PRIORITY;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FLAG_PRIORITY = 32;
/**
 * HTTP/2 DATA frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_DATA } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_DATA;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_DATA = 0;
/**
 * HTTP/2 HEADERS frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_HEADERS } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_HEADERS;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_HEADERS = 1;
/**
 * HTTP/2 PRIORITY frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_PRIORITY } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_PRIORITY;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_PRIORITY = 2;
/**
 * HTTP/2 RST_STREAM frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_RST_STREAM } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_RST_STREAM;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_RST_STREAM = 3;
/**
 * HTTP/2 SETTINGS frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_SETTINGS } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_SETTINGS;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_SETTINGS = 4;
/**
 * HTTP/2 PUSH_PROMISE frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_PUSH_PROMISE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_PUSH_PROMISE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_PUSH_PROMISE = 5;
/**
 * HTTP/2 PING frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_PING } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_PING;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_PING = 6;
/**
 * HTTP/2 GOAWAY frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_GOAWAY } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_GOAWAY;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_GOAWAY = 7;
/**
 * HTTP/2 WINDOW_UPDATE frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_WINDOW_UPDATE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_WINDOW_UPDATE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_WINDOW_UPDATE = 8;
/**
 * HTTP/2 CONTINUATION frame type.
 *
 * ```ts
 * import { NGHTTP2_FRAME_TYPE_CONTINUATION } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FRAME_TYPE_CONTINUATION;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FRAME_TYPE_CONTINUATION = 9;
/**
 * nghttp2 header category for request headers.
 *
 * ```ts
 * import { NGHTTP2_HCAT_REQUEST } from 'internal:net/http/h2/bindings';
 * NGHTTP2_HCAT_REQUEST;
 * ```
 *
 * @internal
 */
export const NGHTTP2_HCAT_REQUEST = 0;
/**
 * nghttp2 header category for response headers.
 *
 * ```ts
 * import { NGHTTP2_HCAT_RESPONSE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_HCAT_RESPONSE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_HCAT_RESPONSE = 1;
/**
 * nghttp2 header category for pushed responses.
 *
 * ```ts
 * import { NGHTTP2_HCAT_PUSH_RESPONSE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_HCAT_PUSH_RESPONSE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_HCAT_PUSH_RESPONSE = 2;
/**
 * nghttp2 header category for non-pseudo header blocks.
 *
 * ```ts
 * import { NGHTTP2_HCAT_HEADERS } from 'internal:net/http/h2/bindings';
 * NGHTTP2_HCAT_HEADERS;
 * ```
 *
 * @internal
 */
export const NGHTTP2_HCAT_HEADERS = 3;
/**
 * SETTINGS identifier for HPACK table size.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_HEADER_TABLE_SIZE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_HEADER_TABLE_SIZE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_HEADER_TABLE_SIZE = 1;
/**
 * SETTINGS identifier for server push enablement.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_ENABLE_PUSH } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_ENABLE_PUSH;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_ENABLE_PUSH = 2;
/**
 * SETTINGS identifier for max concurrent streams.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS = 3;
/**
 * SETTINGS identifier for initial flow-control window size.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE = 4;
/**
 * SETTINGS identifier for max frame size.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_MAX_FRAME_SIZE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_MAX_FRAME_SIZE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_MAX_FRAME_SIZE = 5;
/**
 * SETTINGS identifier for max header-list size.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE = 6;
/**
 * nghttp2 callback return code for deferred data.
 *
 * ```ts
 * import { NGHTTP2_ERR_DEFERRED } from 'internal:net/http/h2/bindings';
 * NGHTTP2_ERR_DEFERRED;
 * ```
 *
 * @internal
 */
export const NGHTTP2_ERR_DEFERRED = -508;
/**
 * nghttp2 callback return code for temporary callback failure.
 *
 * ```ts
 * import { NGHTTP2_ERR_TEMPORAL_CALLBACK_FAILURE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_ERR_TEMPORAL_CALLBACK_FAILURE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_ERR_TEMPORAL_CALLBACK_FAILURE = -521;
/**
 * nghttp2 callback return code for permanent callback failure.
 *
 * ```ts
 * import { NGHTTP2_ERR_CALLBACK_FAILURE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_ERR_CALLBACK_FAILURE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_ERR_CALLBACK_FAILURE = -902;
/**
 * Data-provider flag that marks EOF.
 *
 * ```ts
 * import { NGHTTP2_DATA_FLAG_EOF } from 'internal:net/http/h2/bindings';
 * NGHTTP2_DATA_FLAG_EOF;
 * ```
 *
 * @internal
 */
export const NGHTTP2_DATA_FLAG_EOF = 1;
/**
 * Data-provider flag that withholds END_STREAM.
 *
 * ```ts
 * import { NGHTTP2_DATA_FLAG_NO_END_STREAM } from 'internal:net/http/h2/bindings';
 * NGHTTP2_DATA_FLAG_NO_END_STREAM;
 * ```
 *
 * @internal
 */
export const NGHTTP2_DATA_FLAG_NO_END_STREAM = 2;
/**
 * Data-provider flag for no-copy output mode.
 *
 * ```ts
 * import { NGHTTP2_DATA_FLAG_NO_COPY } from 'internal:net/http/h2/bindings';
 * NGHTTP2_DATA_FLAG_NO_COPY;
 * ```
 *
 * @internal
 */
export const NGHTTP2_DATA_FLAG_NO_COPY = 4;
/**
 * nghttp2 name/value flag for normal indexing behavior.
 *
 * ```ts
 * import { NGHTTP2_NV_FLAG_NONE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_NV_FLAG_NONE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_NV_FLAG_NONE = 0;
/**
 * nghttp2 name/value flag to disable HPACK indexing.
 *
 * ```ts
 * import { NGHTTP2_NV_FLAG_NO_INDEX } from 'internal:net/http/h2/bindings';
 * NGHTTP2_NV_FLAG_NO_INDEX;
 * ```
 *
 * @internal
 */
export const NGHTTP2_NV_FLAG_NO_INDEX = 1;
/**
 * HTTP/2 PROTOCOL_ERROR code.
 *
 * ```ts
 * import { NGHTTP2_PROTOCOL_ERROR } from 'internal:net/http/h2/bindings';
 * NGHTTP2_PROTOCOL_ERROR;
 * ```
 *
 * @internal
 */
export const NGHTTP2_PROTOCOL_ERROR = 1;
/**
 * HTTP/2 INTERNAL_ERROR code.
 *
 * ```ts
 * import { NGHTTP2_INTERNAL_ERROR } from 'internal:net/http/h2/bindings';
 * NGHTTP2_INTERNAL_ERROR;
 * ```
 *
 * @internal
 */
export const NGHTTP2_INTERNAL_ERROR = 2;
/**
 * HTTP/2 FLOW_CONTROL_ERROR code.
 *
 * ```ts
 * import { NGHTTP2_FLOW_CONTROL_ERROR } from 'internal:net/http/h2/bindings';
 * NGHTTP2_FLOW_CONTROL_ERROR;
 * ```
 *
 * @internal
 */
export const NGHTTP2_FLOW_CONTROL_ERROR = 3;
/**
 * HTTP/2 STREAM_CLOSED code.
 *
 * ```ts
 * import { NGHTTP2_STREAM_CLOSED } from 'internal:net/http/h2/bindings';
 * NGHTTP2_STREAM_CLOSED;
 * ```
 *
 * @internal
 */
export const NGHTTP2_STREAM_CLOSED = 5;
/**
 * HTTP/2 REFUSED_STREAM code.
 *
 * ```ts
 * import { NGHTTP2_REFUSED_STREAM } from 'internal:net/http/h2/bindings';
 * NGHTTP2_REFUSED_STREAM;
 * ```
 *
 * @internal
 */
export const NGHTTP2_REFUSED_STREAM = 7;
/**
 * HTTP/2 ENHANCE_YOUR_CALM code (RFC 9113 §7). Sent when a peer exhibits
 * behavior that could cause excessive load, such as a CONTINUATION flood.
 *
 * ```ts
 * import { NGHTTP2_ENHANCE_YOUR_CALM } from 'internal:net/http/h2/bindings';
 * NGHTTP2_ENHANCE_YOUR_CALM;
 * ```
 *
 * @internal
 */
export const NGHTTP2_ENHANCE_YOUR_CALM = 11;
/**
 * HTTP/2 NO_ERROR code.
 *
 * ```ts
 * import { NGHTTP2_NO_ERROR } from 'internal:net/http/h2/bindings';
 * NGHTTP2_NO_ERROR;
 * ```
 *
 * @internal
 */
export const NGHTTP2_NO_ERROR = 0;
/**
 * nghttp2 settings enum value for reading max concurrent streams.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_ID_MAX_CONCURRENT_STREAMS } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_ID_MAX_CONCURRENT_STREAMS;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_ID_MAX_CONCURRENT_STREAMS = 3;
/**
 * nghttp2 settings enum value for reading initial window size.
 *
 * ```ts
 * import { NGHTTP2_SETTINGS_ID_INITIAL_WINDOW_SIZE } from 'internal:net/http/h2/bindings';
 * NGHTTP2_SETTINGS_ID_INITIAL_WINDOW_SIZE;
 * ```
 *
 * @internal
 */
export const NGHTTP2_SETTINGS_ID_INITIAL_WINDOW_SIZE = 4;
// ---------------------------------------------------------------------------
// Struct layout constants (from C sizeof/offsetof, verified with compiler)
// ---------------------------------------------------------------------------
/**
 * Size in bytes of the copied `nghttp2_frame_hd` layout used here.
 *
 * ```ts
 * import { FRAME_HD_SIZE } from 'internal:net/http/h2/bindings';
 * FRAME_HD_SIZE;
 * ```
 *
 * @internal
 */
export const FRAME_HD_SIZE = 16;
/**
 * Offset of `length` inside `nghttp2_frame_hd`.
 *
 * ```ts
 * import { FRAME_HD_LENGTH } from 'internal:net/http/h2/bindings';
 * FRAME_HD_LENGTH;
 * ```
 *
 * @internal
 */
export const FRAME_HD_LENGTH = 0;
/**
 * Offset of `stream_id` inside `nghttp2_frame_hd`.
 *
 * ```ts
 * import { FRAME_HD_STREAM_ID } from 'internal:net/http/h2/bindings';
 * FRAME_HD_STREAM_ID;
 * ```
 *
 * @internal
 */
export const FRAME_HD_STREAM_ID = 8;
/**
 * Offset of `type` inside `nghttp2_frame_hd`.
 *
 * ```ts
 * import { FRAME_HD_TYPE } from 'internal:net/http/h2/bindings';
 * FRAME_HD_TYPE;
 * ```
 *
 * @internal
 */
export const FRAME_HD_TYPE = 12;
/**
 * Offset of `flags` inside `nghttp2_frame_hd`.
 *
 * ```ts
 * import { FRAME_HD_FLAGS } from 'internal:net/http/h2/bindings';
 * FRAME_HD_FLAGS;
 * ```
 *
 * @internal
 */
export const FRAME_HD_FLAGS = 13;
// nghttp2_headers cat field offset within the full nghttp2_frame union
// nghttp2_headers { hd(16) + padlen(8) + pri_spec(12+4pad) + nva(8) + nvlen(8) + cat(4) }
/**
 * Offset of the `cat` field in an `nghttp2_headers` frame union.
 *
 * ```ts
 * import { HEADERS_CAT } from 'internal:net/http/h2/bindings';
 * HEADERS_CAT;
 * ```
 *
 * @internal
 */
export const HEADERS_CAT = 56;
// nghttp2_nv (40 bytes per entry)
/**
 * Size of one `nghttp2_nv` entry in bytes.
 *
 * ```ts
 * import { NV_ENTRY_SIZE } from 'internal:net/http/h2/bindings';
 * NV_ENTRY_SIZE;
 * ```
 *
 * @internal
 */
export const NV_ENTRY_SIZE = 40;
/**
 * Offset of the `name` pointer in `nghttp2_nv`.
 *
 * ```ts
 * import { NV_NAME } from 'internal:net/http/h2/bindings';
 * NV_NAME;
 * ```
 *
 * @internal
 */
export const NV_NAME = 0;
/**
 * Offset of the `value` pointer in `nghttp2_nv`.
 *
 * ```ts
 * import { NV_VALUE } from 'internal:net/http/h2/bindings';
 * NV_VALUE;
 * ```
 *
 * @internal
 */
export const NV_VALUE = 8;
/**
 * Offset of the name length in `nghttp2_nv`.
 *
 * ```ts
 * import { NV_NAMELEN } from 'internal:net/http/h2/bindings';
 * NV_NAMELEN;
 * ```
 *
 * @internal
 */
export const NV_NAMELEN = 16;
/**
 * Offset of the value length in `nghttp2_nv`.
 *
 * ```ts
 * import { NV_VALUELEN } from 'internal:net/http/h2/bindings';
 * NV_VALUELEN;
 * ```
 *
 * @internal
 */
export const NV_VALUELEN = 24;
/**
 * Offset of flags in `nghttp2_nv`.
 *
 * ```ts
 * import { NV_FLAGS } from 'internal:net/http/h2/bindings';
 * NV_FLAGS;
 * ```
 *
 * @internal
 */
export const NV_FLAGS = 32;
// nghttp2_data_provider2 (16 bytes)
/**
 * Offset of `source` in `nghttp2_data_provider2`.
 *
 * ```ts
 * import { DP2_SOURCE } from 'internal:net/http/h2/bindings';
 * DP2_SOURCE;
 * ```
 *
 * @internal
 */
export const DP2_SOURCE = 0;
/**
 * Offset of `read_callback` in `nghttp2_data_provider2`.
 *
 * ```ts
 * import { DP2_READ_CALLBACK } from 'internal:net/http/h2/bindings';
 * DP2_READ_CALLBACK;
 * ```
 *
 * @internal
 */
export const DP2_READ_CALLBACK = 8;
// nghttp2_settings_entry (8 bytes)
/**
 * Size of one `nghttp2_settings_entry` in bytes.
 *
 * ```ts
 * import { SETTINGS_ENTRY_SIZE } from 'internal:net/http/h2/bindings';
 * SETTINGS_ENTRY_SIZE;
 * ```
 *
 * @internal
 */
export const SETTINGS_ENTRY_SIZE = 8;
/**
 * Offset of `settings_id` in `nghttp2_settings_entry`.
 *
 * ```ts
 * import { SETTINGS_ENTRY_SETTINGS_ID } from 'internal:net/http/h2/bindings';
 * SETTINGS_ENTRY_SETTINGS_ID;
 * ```
 *
 * @internal
 */
export const SETTINGS_ENTRY_SETTINGS_ID = 0;
/**
 * Offset of `value` in `nghttp2_settings_entry`.
 *
 * ```ts
 * import { SETTINGS_ENTRY_VALUE } from 'internal:net/http/h2/bindings';
 * SETTINGS_ENTRY_VALUE;
 * ```
 *
 * @internal
 */
export const SETTINGS_ENTRY_VALUE = 4;
// nghttp2_goaway offsets
/**
 * Offset of `last_stream_id` in a GOAWAY frame union.
 *
 * ```ts
 * import { GOAWAY_LAST_STREAM_ID } from 'internal:net/http/h2/bindings';
 * GOAWAY_LAST_STREAM_ID;
 * ```
 *
 * @internal
 */
export const GOAWAY_LAST_STREAM_ID = 16;
/**
 * Offset of `error_code` in a GOAWAY frame union.
 *
 * ```ts
 * import { GOAWAY_ERROR_CODE } from 'internal:net/http/h2/bindings';
 * GOAWAY_ERROR_CODE;
 * ```
 *
 * @internal
 */
export const GOAWAY_ERROR_CODE = 20;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const _enc = new _TextEncoder();
const _dec = new _TextDecoder();
/**
 * Read a null-terminated C string from a Fino pointer buffer.
 *
 * The pointer must reference readable C memory ending in `\0`. The function
 * copies bytes until the terminator and decodes them as UTF-8; invalid pointers
 * can crash or throw through the FFI layer.
 *
 * ```ts no_run
 * import { readCStr } from 'internal:net/http/h2/bindings';
 * const text = readCStr(ptr);
 * text.length;
 * ```
 *
 * @internal
 */
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
/**
 * Encode a JavaScript string as UTF-8 bytes.
 *
 * The returned `Uint8Array` is not null-terminated. Callers that pass it to C
 * APIs must keep the array alive until the native call finishes.
 *
 * ```ts
 * import { encodeUtf8 } from 'internal:net/http/h2/bindings';
 * encodeUtf8('content-type').byteLength;
 * ```
 *
 * @internal
 */
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
 *
 * Header names are lowercased. The returned buffer contains native pointer
 * values pointing within itself, so moving the bytes into a different buffer
 * invalidates those pointers.
 *
 * ```ts
 * import { buildNvArray } from 'internal:net/http/h2/bindings';
 * const built = buildNvArray([[':status', '200']]);
 * built.nv;
 * ```
 *
 * @internal
 */
export function buildNvArray(headers: Array<[string, string]>): {
  buf: Uint8Array;
  nv: number;
} {
  const count = headers.length;
  const encoded = headers.map(function encodeHeader([name, value]) {
    return {
      name: _enc.encode(name.toLowerCase()),
      value: _enc.encode(value),
    };
  });
  // Each nv entry: 40 bytes. Data follows after all entries.
  const totalData = encoded.reduce(function sumHeaderBytes(s, entry) {
    return s + entry.name.length + entry.value.length;
  }, 0);
  const buf = new Uint8Array(count * NV_ENTRY_SIZE + totalData);
  let dataOffset = count * NV_ENTRY_SIZE;
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < count; i++) {
    const { name: nb, value: vb } = encoded[i]!;
    const base = i * NV_ENTRY_SIZE;
    const nameAddr = (Pointer.addr(buf) as bigint) + BigInt(dataOffset);
    const valueAddr = nameAddr + BigInt(nb.length);
    buf.set(nb, dataOffset);
    buf.set(vb, dataOffset + nb.length);
    dataOffset += nb.length + vb.length;
    // Write the nv entry pointers - C addresses of name/value bytes within buf.
    // Use DataView.setBigUint64 to write into buf's bytes directly (not via pointer deref).
    dv.setBigUint64(base + NV_NAME, nameAddr, true);
    dv.setBigUint64(base + NV_VALUE, valueAddr, true);
    dv.setBigUint64(base + NV_NAMELEN, BigInt(nb.length), true);
    dv.setBigUint64(base + NV_VALUELEN, BigInt(vb.length), true);
    buf[base + NV_FLAGS] = NGHTTP2_NV_FLAG_NONE;
  }
  return {
    buf,
    nv: count,
  };
}
/**
 * Allocate and populate a settings array for nghttp2_submit_settings.
 * Returns a Uint8Array that must be kept alive during the FFI call.
 *
 * Setting IDs are written as signed 32-bit little-endian values and setting
 * values as unsigned 32-bit little-endian values, matching nghttp2's ABI on
 * supported targets.
 *
 * ```ts
 * import { buildSettingsArray } from 'internal:net/http/h2/bindings';
 * buildSettingsArray([[3, 100]]).byteLength;
 * ```
 *
 * @internal
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
 *
 * The returned object copies only the frame header fields needed by callbacks.
 * Passing an invalid pointer is unsafe and may throw or crash through the FFI
 * pointer helpers.
 *
 * ```ts no_run
 * import { readFrameHd } from 'internal:net/http/h2/bindings';
 * const header = readFrameHd(framePtr);
 * header.streamId;
 * ```
 *
 * @internal
 */
export function readFrameHd(frame: ArrayBuffer): {
  length: number;
  streamId: number;
  type: number;
  flags: number;
} {
  return {
    length: Number(Pointer.readU64(frame, FRAME_HD_LENGTH) as bigint),
    streamId: Pointer.readI32(frame, FRAME_HD_STREAM_ID) as number,
    type: Pointer.readU8(frame, FRAME_HD_TYPE) as number,
    flags: Pointer.readU8(frame, FRAME_HD_FLAGS) as number,
  };
}
/**
 * Read the `cat` field from an nghttp2_headers* (which is an nghttp2_frame*
 * for HEADERS frames).
 *
 * The pointer must refer to a HEADERS frame layout. The function reads only the
 * numeric category field and does not validate the frame type.
 *
 * ```ts no_run
 * import { readHeadersCat } from 'internal:net/http/h2/bindings';
 * const cat = readHeadersCat(framePtr);
 * cat;
 * ```
 *
 * @internal
 */
export function readHeadersCat(frame: ArrayBuffer): number {
  return Pointer.readI32(frame, HEADERS_CAT) as number;
}
