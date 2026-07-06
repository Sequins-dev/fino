/**
* internal:net/quic/ngtcp2/bindings — system libngtcp2 via dlopen.
*
* This module is the narrow native boundary for Fino's low-level QUIC support.
* It loads `libngtcp2` from Homebrew, MacPorts, and common Linux locations and
* exposes only the symbols needed by the QUIC endpoint implementation:
* connection creation/destruction, packet read/write, stream open/write,
* timers, transport parameters, connection IDs, and error helpers. Everything
* above this file — the endpoint, connection, and stream state machines — is
* plain TypeScript that drives these raw FFI symbols, keeping the Rust side out
* of QUIC entirely.
*
* Loading is attempted once at module init across a candidate path list, and the
* whole surface degrades gracefully. `ngtcp2Available` is `false` (rather than
* throwing) when no library is found, so tests and applications can skip QUIC
* work on systems without ngtcp2; call `requireNgtcp2()` at the point where
* native QUIC becomes mandatory to turn a missing library into a descriptive
* error. Two capabilities are probed separately because they appeared in later
* releases: the stateless-reset writer (required for a usable endpoint) and
* `reset_stream_at` / `shutdown_stream_at` reliable-reset support (optional,
* surfaced through `ngtcp2ResetStreamAtAvailable`).
*
* This module deliberately owns no native memory. Every ngtcp2 struct — settings,
* transport parameters, connection IDs, paths, callbacks — is a JS-allocated
* `ArrayBuffer` whose address is handed to ngtcp2 through `fino:ffi`. The large
* block of exported `*_SIZE` and field-offset constants encodes the LP64 ABI
* layout of those structs (generated from C `sizeof`/`offsetof`) so callers can
* read and write struct fields with `Pointer` accessors without a Rust shim. The
* `NGTCP2_*_VERSION` constants track versioned ABI variants and are chosen from
* the runtime library version detected at load time.
*
* Because it imports `internal:process` and `fino:ffi`, this is an
* `internal:*` module; only other built-ins may import it. Direct consumers
* are the QUIC endpoint (`internal:net/quic/endpoint`) and the ngtcp2 crypto
* backends.
*
* ```ts no_run
* import {
*   ngtcp2Available,
*   requireNgtcp2,
*   readCStr,
*   sym,
*   NGTCP2_MAX_CIDLEN,
* } from 'internal:net/quic/ngtcp2/bindings';
* import { Pointer } from 'fino:ffi';
*
* if (!ngtcp2Available) throw new Error('build without QUIC');
*
* const lib = requireNgtcp2();
* const info = lib.symbols.ngtcp2_version(0) as ArrayBuffer;
* const versionString = readCStr(Pointer.readPointer(info, 8) as ArrayBuffer);
*
* // Allocate a connection-ID struct and fill it via the raw symbol.
* const cid = new ArrayBuffer(NGTCP2_MAX_CIDLEN + 16);
* const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
* sym!.ngtcp2_cid_init(Pointer.of(cid), bytes, bytes.byteLength);
* ```
*
* ngtcp2 API reference: https://nghttp2.org/ngtcp2/
*
* @internal
*/
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
/**
* Re-exports of the `fino:ffi` primitives that QUIC callers need alongside these
* bindings.
*
* `FfiCallback` wraps a JS function as a C function pointer for the many ngtcp2
* callback slots (see the `CB_*` offsets), and `Pointer` provides `Pointer.of`
* plus the typed struct-field accessors (`readU8`, `readI32`, `readPointer`, …)
* used to marshal the ABI structs whose layouts this module describes. They are
* re-exported here so consumers can import the whole native toolkit from one
* specifier.
*/
export { FfiCallback, Pointer };
const _IS_DARWIN = os === 'darwin';
const _CANDIDATES = _IS_DARWIN ? [
  '/opt/homebrew/opt/libngtcp2/lib/libngtcp2.dylib',
  '/opt/homebrew/lib/libngtcp2.dylib',
  '/usr/local/opt/libngtcp2/lib/libngtcp2.dylib',
  '/usr/local/lib/libngtcp2.dylib',
  '/opt/local/lib/libngtcp2.dylib'
] : [
  'libngtcp2.so.16',
  'libngtcp2.so',
  '/usr/lib/x86_64-linux-gnu/libngtcp2.so.16',
  '/usr/lib/aarch64-linux-gnu/libngtcp2.so.16',
  '/usr/local/lib/libngtcp2.so'
];
const _SYMBOLS = {
  ngtcp2_version: {
    parameters: ['i32'],
    result: 'pointer'
  },
  ngtcp2_strerror: {
    parameters: ['i32'],
    result: 'pointer'
  },
  ngtcp2_err_is_fatal: {
    parameters: ['i32'],
    result: 'i32'
  },
  ngtcp2_err_infer_quic_transport_error_code: {
    parameters: ['i32'],
    result: 'u64'
  },
  ngtcp2_is_supported_version: {
    parameters: ['u32'],
    result: 'i32'
  },
  ngtcp2_ccerr_default: {
    parameters: ['pointer'],
    result: 'void'
  },
  ngtcp2_ccerr_set_liberr: {
    parameters: [
      'pointer',
      'i32',
      'buffer',
      'usize'
    ],
    result: 'void'
  },
  ngtcp2_ccerr_set_tls_alert: {
    parameters: [
      'pointer',
      'u8',
      'buffer',
      'usize'
    ],
    result: 'void'
  },
  ngtcp2_ccerr_set_transport_error: {
    parameters: [
      'pointer',
      'u64',
      'buffer',
      'usize'
    ],
    result: 'void'
  },
  ngtcp2_ccerr_set_application_error: {
    parameters: [
      'pointer',
      'u64',
      'buffer',
      'usize'
    ],
    result: 'void'
  },
  ngtcp2_accept: {
    parameters: [
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_settings_default_versioned: {
    parameters: ['i32', 'pointer'],
    result: 'void'
  },
  ngtcp2_transport_params_default_versioned: {
    parameters: ['i32', 'pointer'],
    result: 'void'
  },
  ngtcp2_transport_params_encode_versioned: {
    parameters: [
      'i32',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'isize'
  },
  ngtcp2_transport_params_decode_versioned: {
    parameters: [
      'i32',
      'pointer',
      'pointer',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_transport_params_decode_new: {
    parameters: [
      'pointer',
      'pointer',
      'usize',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_transport_params_del: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  ngtcp2_cid_init: {
    parameters: [
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'void'
  },
  ngtcp2_cid_eq: {
    parameters: ['pointer', 'pointer'],
    result: 'i32'
  },
  ngtcp2_pkt_decode_version_cid: {
    parameters: [
      'pointer',
      'buffer',
      'usize',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_pkt_write_version_negotiation: {
    parameters: [
      'buffer',
      'usize',
      'u8',
      'buffer',
      'usize',
      'buffer',
      'usize',
      'buffer',
      'usize'
    ],
    result: 'isize'
  },
  ngtcp2_pkt_decode_hd_long: {
    parameters: [
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'isize'
  },
  ngtcp2_conn_client_new_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'u32',
      'i32',
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
  ngtcp2_conn_server_new_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'pointer',
      'pointer',
      'u32',
      'i32',
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
  ngtcp2_conn_del: {
    parameters: ['pointer'],
    result: 'void'
  },
  ngtcp2_conn_read_pkt_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'i32',
      'pointer',
      'buffer',
      'usize',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_conn_write_pkt_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'i32',
      'pointer',
      'buffer',
      'usize',
      'u64'
    ],
    result: 'isize'
  },
  ngtcp2_conn_writev_stream_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'i32',
      'pointer',
      'buffer',
      'usize',
      'pointer',
      'u32',
      'i64',
      'pointer',
      'usize',
      'u64'
    ],
    result: 'isize'
  },
  ngtcp2_conn_write_datagram_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'i32',
      'pointer',
      'buffer',
      'usize',
      'pointer',
      'u32',
      'u64',
      'buffer',
      'usize',
      'u64'
    ],
    result: 'isize'
  },
  ngtcp2_conn_write_connection_close_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'i32',
      'pointer',
      'buffer',
      'usize',
      'pointer',
      'u64'
    ],
    result: 'isize'
  },
  ngtcp2_conn_initiate_key_update: {
    parameters: ['pointer', 'u64'],
    result: 'i32'
  },
  ngtcp2_conn_initiate_immediate_migration: {
    parameters: [
      'pointer',
      'pointer',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_conn_initiate_migration: {
    parameters: [
      'pointer',
      'pointer',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_conn_set_local_addr: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  ngtcp2_conn_set_path_user_data: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  ngtcp2_conn_get_ccerr: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  ngtcp2_conn_get_expiry: {
    parameters: ['pointer'],
    result: 'u64'
  },
  ngtcp2_conn_get_pto: {
    parameters: ['pointer'],
    result: 'u64'
  },
  ngtcp2_conn_handle_expiry: {
    parameters: ['pointer', 'u64'],
    result: 'i32'
  },
  ngtcp2_conn_set_keep_alive_timeout: {
    parameters: ['pointer', 'u64'],
    result: 'void'
  },
  ngtcp2_conn_update_pkt_tx_time: {
    parameters: ['pointer', 'u64'],
    result: 'void'
  },
  ngtcp2_conn_get_send_quantum: {
    parameters: ['pointer'],
    result: 'usize'
  },
  ngtcp2_conn_get_max_tx_udp_payload_size: {
    parameters: ['pointer'],
    result: 'usize'
  },
  ngtcp2_conn_get_handshake_completed: {
    parameters: ['pointer'],
    result: 'i32'
  },
  ngtcp2_conn_tls_handshake_completed: {
    parameters: ['pointer'],
    result: 'void'
  },
  ngtcp2_conn_get_tls_alert: {
    parameters: ['pointer'],
    result: 'u8'
  },
  ngtcp2_conn_get_tls_error: {
    parameters: ['pointer'],
    result: 'i32'
  },
  ngtcp2_conn_get_negotiated_version: {
    parameters: ['pointer'],
    result: 'u32'
  },
  ngtcp2_conn_set_tls_error: {
    parameters: ['pointer', 'i32'],
    result: 'void'
  },
  ngtcp2_conn_set_tls_native_handle: {
    parameters: ['pointer', 'pointer'],
    result: 'void'
  },
  ngtcp2_conn_get_tls_native_handle: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  ngtcp2_conn_get_conn_info_versioned: {
    parameters: [
      'pointer',
      'i32',
      'pointer'
    ],
    result: 'void'
  },
  ngtcp2_conn_set_local_transport_params_versioned: {
    parameters: [
      'pointer',
      'pointer',
      'i32'
    ],
    result: 'i32'
  },
  ngtcp2_conn_get_local_transport_params: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  ngtcp2_conn_get_remote_transport_params: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  ngtcp2_conn_decode_and_set_remote_transport_params: {
    parameters: [
      'pointer',
      'pointer',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_conn_encode_0rtt_transport_params: {
    parameters: [
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'isize'
  },
  ngtcp2_conn_decode_and_set_0rtt_transport_params: {
    parameters: [
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_conn_encode_local_transport_params: {
    parameters: [
      'pointer',
      'pointer',
      'usize'
    ],
    result: 'isize'
  },
  ngtcp2_conn_get_active_dcid: {
    parameters: ['pointer', 'pointer'],
    result: 'usize'
  },
  ngtcp2_conn_get_dcid: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  ngtcp2_conn_get_path: {
    parameters: ['pointer'],
    result: 'pointer'
  },
  ngtcp2_conn_get_scid: {
    parameters: ['pointer', 'pointer'],
    result: 'usize'
  },
  ngtcp2_conn_open_bidi_stream: {
    parameters: [
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_conn_open_uni_stream: {
    parameters: [
      'pointer',
      'pointer',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_conn_get_streams_bidi_left: {
    parameters: ['pointer'],
    result: 'u64'
  },
  ngtcp2_conn_get_streams_uni_left: {
    parameters: ['pointer'],
    result: 'u64'
  },
  ngtcp2_conn_set_stream_user_data: {
    parameters: [
      'pointer',
      'i64',
      'pointer'
    ],
    result: 'i32'
  },
  ngtcp2_conn_shutdown_stream: {
    parameters: [
      'pointer',
      'u32',
      'i64',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_conn_shutdown_stream_read: {
    parameters: [
      'pointer',
      'u32',
      'i64',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_conn_shutdown_stream_write: {
    parameters: [
      'pointer',
      'u32',
      'i64',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_conn_extend_max_stream_offset: {
    parameters: [
      'pointer',
      'i64',
      'u64'
    ],
    result: 'i32'
  },
  ngtcp2_conn_extend_max_offset: {
    parameters: ['pointer', 'u64'],
    result: 'void'
  },
  ngtcp2_conn_extend_max_streams_bidi: {
    parameters: ['pointer', 'usize'],
    result: 'void'
  },
  ngtcp2_conn_extend_max_streams_uni: {
    parameters: ['pointer', 'usize'],
    result: 'void'
  },
  ngtcp2_conn_submit_crypto_data: {
    parameters: [
      'pointer',
      'i32',
      'buffer',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_conn_submit_new_token: {
    parameters: [
      'pointer',
      'buffer',
      'usize'
    ],
    result: 'i32'
  },
  ngtcp2_is_bidi_stream: {
    parameters: ['i64'],
    result: 'i32'
  }
};
type StatelessResetWriter = (dest: Uint8Array, destlen: number, token: Uint8Array, random: Uint8Array, randomLength: number) => number;
type ResetStreamAtWriter = (conn: ArrayBuffer, flags: number, streamId: bigint, appErrorCode: bigint, finalSize: bigint) => number;
let _lib: ReturnType<typeof dlopen> | null = null;
let _statelessResetLib: ReturnType<typeof dlopen> | null = null;
let _statelessResetWriter: StatelessResetWriter | null = null;
let _resetStreamAtLib: ReturnType<typeof dlopen> | null = null;
let _resetStreamAtWriter: ResetStreamAtWriter | null = null;
const _loadErrors: string[] = [];
function statelessResetTokenPointer(token: Uint8Array): ArrayBuffer {
  const view = token.byteOffset === 0 && token.byteLength === token.buffer.byteLength ? token : token.slice();
  return Pointer.of(view.buffer);
}
function tryOpenResetStreamAt(path: string): ResetStreamAtWriter | null {
  const signature = {
    parameters: [
      'pointer',
      'u32',
      'i64',
      'u64',
      'u64'
    ],
    result: 'i32'
  } as const;
  try {
    const lib = dlopen(path, { ngtcp2_conn_shutdown_stream_at: signature });
    _resetStreamAtLib = lib;
    return (conn, flags, streamId, appErrorCode, finalSize) => Number(lib.symbols.ngtcp2_conn_shutdown_stream_at(conn, flags, streamId, appErrorCode, finalSize));
  } catch (error1) {
    try {
      const lib = dlopen(path, { ngtcp2_conn_reset_stream_at: signature });
      _resetStreamAtLib = lib;
      return (conn, flags, streamId, appErrorCode, finalSize) => Number(lib.symbols.ngtcp2_conn_reset_stream_at(conn, flags, streamId, appErrorCode, finalSize));
    } catch (error2) {
      const message1 = error1 instanceof Error ? error1.message : String(error1);
      const message2 = error2 instanceof Error ? error2.message : String(error2);
      _loadErrors.push(`${path}: reset_stream_at unavailable (${message1}; ${message2})`);
      return null;
    }
  }
}
function tryOpenStatelessReset(path: string): StatelessResetWriter | null {
  try {
    const lib = dlopen(path, { ngtcp2_pkt_write_stateless_reset2: {
      parameters: [
        'buffer',
        'usize',
        'pointer',
        'buffer',
        'usize'
      ],
      result: 'isize'
    } });
    _statelessResetLib = lib;
    return (dest, destlen, token, random, randomLength) => Number(lib.symbols.ngtcp2_pkt_write_stateless_reset2(dest, destlen, statelessResetTokenPointer(token), random, randomLength));
  } catch (error2) {
    try {
      const lib = dlopen(path, { ngtcp2_pkt_write_stateless_reset: {
        parameters: [
          'buffer',
          'usize',
          'buffer',
          'buffer',
          'usize'
        ],
        result: 'isize'
      } });
      _statelessResetLib = lib;
      return (dest, destlen, token, random, randomLength) => Number(lib.symbols.ngtcp2_pkt_write_stateless_reset(dest, destlen, token, random, randomLength));
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
    _resetStreamAtWriter = tryOpenResetStreamAt(path);
    break;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    _loadErrors.push(`${path}: ${message}`);
  }
}
/**
* Whether a usable libngtcp2 was loaded at module init.
*
* This is `true` only when both the main symbol table and a stateless-reset
* writer opened successfully from the same library path. It never throws, so it
* is safe to branch on at the top of QUIC code to skip work (or skip tests)
* on systems where ngtcp2 is not installed. When it is `false`, `sym` and `ptr`
* are `null` and `requireNgtcp2()` throws.
*
* ```ts no_run
* import { ngtcp2Available } from 'internal:net/quic/ngtcp2/bindings';
*
* if (!ngtcp2Available) {
*   console.log('QUIC disabled: libngtcp2 not found');
* }
* ```
*/
export const ngtcp2Available = _lib !== null && _statelessResetWriter !== null;
/**
* Whether the loaded library supports reliable stream reset (`reset_stream_at`
* or its older `shutdown_stream_at` spelling).
*
* This capability shipped in later ngtcp2 releases, so it is probed separately
* from the core surface and may be `false` even when `ngtcp2Available` is
* `true`. Guard `ngtcp2ConnResetStreamAt` with this flag; calling it while this
* is `false` throws.
*/
export const ngtcp2ResetStreamAtAvailable = _resetStreamAtWriter !== null;
/**
* The raw ngtcp2 symbol table, or `null` when no library loaded.
*
* Each property is a callable bound to the corresponding `ngtcp2_*` C function
* with the ABI signature declared in this module. Callers must marshal struct
* arguments themselves — pass `Pointer.of(buffer)` for `pointer` parameters and
* a `Uint8Array` for `buffer` parameters. Prefer `requireNgtcp2().symbols` when
* the library is mandatory so a missing library is a clear error rather than a
* `null` dereference.
*
* ```ts no_run
* import { sym } from 'internal:net/quic/ngtcp2/bindings';
*
* const rc = sym!.ngtcp2_is_supported_version(1);
* ```
*/
export const sym = _lib?.symbols ?? null;
/**
* Raw function-pointer addresses for the loaded ngtcp2 symbols, or `null` when
* no library loaded.
*
* These are the `void*` addresses of the C functions themselves, used when a
* pointer to an ngtcp2 routine must be stored inside another struct (for
* example, wiring a library-provided helper into a callback slot) rather than
* called directly through `sym`.
*/
export const ptr = _lib?.pointers ?? null;
/**
* Writes a QUIC Stateless Reset packet into `dest`, returning its byte length.
*
* Transparently dispatches to whichever writer the loaded library provides —
* the newer `ngtcp2_pkt_write_stateless_reset2` (which takes the reset token by
* pointer) or the older `ngtcp2_pkt_write_stateless_reset` (token by buffer) —
* normalizing both to the same signature. `token` is the 16-byte stateless
* reset token, `random` supplies the unpredictable bytes that pad the packet,
* and the return value is the number of bytes written to `dest` (negative on an
* ngtcp2 error such as `NGTCP2_ERR_NOBUF`).
*
* Throws if no stateless-reset writer was available at load time; check
* `ngtcp2Available` first.
*
* ```ts no_run
* import { ngtcp2PktWriteStatelessReset } from 'internal:net/quic/ngtcp2/bindings';
*
* const out = new Uint8Array(1200);
* const n = ngtcp2PktWriteStatelessReset(out, out.byteLength, token, random, random.byteLength);
* if (n > 0) transport.send(out.subarray(0, n), remoteAddress);
* ```
*/
export function ngtcp2PktWriteStatelessReset(dest: Uint8Array, destlen: number, token: Uint8Array, random: Uint8Array, randomLength: number): number {
  if (_statelessResetWriter === null) throw new Error('ngtcp2 stateless reset writer is unavailable');
  return _statelessResetWriter(dest, destlen, token, random, randomLength);
}
/**
* Resets a stream at a specific final size, delivering the reliable prefix
* before the abort takes effect.
*
* Wraps whichever reliable-reset entry point the loaded library exposes
* (`ngtcp2_conn_shutdown_stream_at` or `ngtcp2_conn_reset_stream_at`). `conn`
* is the native connection handle, `streamId` the stream to reset,
* `appErrorCode` the application error code, and `finalSize` the byte offset up
* to which already-buffered data is still guaranteed to be delivered before the
* reset. Returns `0` on success or a negative ngtcp2 error code.
*
* Throws if the loaded library lacks reliable-reset support; guard with
* `ngtcp2ResetStreamAtAvailable`.
*
* ```ts no_run
* import {
*   ngtcp2ConnResetStreamAt,
*   ngtcp2ResetStreamAtAvailable,
* } from 'internal:net/quic/ngtcp2/bindings';
*
* if (ngtcp2ResetStreamAtAvailable) {
*   ngtcp2ConnResetStreamAt(conn, 0, BigInt(streamId), 0n, reliableSize);
* }
* ```
*/
export function ngtcp2ConnResetStreamAt(conn: ArrayBuffer, flags: number, streamId: bigint, appErrorCode: bigint, finalSize: bigint): number {
  if (_resetStreamAtWriter === null) throw new Error('ngtcp2 reset_stream_at is not supported by the loaded library');
  return _resetStreamAtWriter(conn, flags, streamId, appErrorCode, finalSize);
}
/**
* Returns the loaded ngtcp2 library handle, throwing a descriptive install
* message if none was found.
*
* Use this at the boundary where native QUIC becomes mandatory (endpoint
* construction, for example) so an absent library surfaces as a clear error —
* including the platform install command and every path that was tried —
* instead of a later `null` dereference. When it returns, `.symbols` and
* `.pointers` are guaranteed non-null.
*
* ```ts no_run
* import { requireNgtcp2 } from 'internal:net/quic/ngtcp2/bindings';
*
* const lib = requireNgtcp2(); // throws with install hint if missing
* lib.symbols.ngtcp2_conn_del(conn);
* ```
*/
export function requireNgtcp2(): ReturnType<typeof dlopen> {
  if (_lib === null) {
    throw new Error('libngtcp2 not found. Install via:\n' + '  macOS:  brew install libngtcp2 openssl@3\n' + '  Debian/Ubuntu: apt install libngtcp2-16 libngtcp2-crypto-gnutls8' + (_loadErrors.length === 0 ? '' : '\nTried:\n  ' + _loadErrors.join('\n  ')));
  }
  return _lib;
}
/**
* Reads a NUL-terminated C string from a native pointer into a JS string.
*
* Scans forward from the pointer one byte at a time until the first `0x00`,
* then UTF-8 decodes the bytes in between. Used to read `const char*` results
* from ngtcp2 such as `ngtcp2_strerror` and the version string. The pointer
* must reference a valid NUL-terminated buffer; there is no length bound, so a
* non-terminated buffer will read past its intended end.
*
* ```ts no_run
* import { readCStr, sym } from 'internal:net/quic/ngtcp2/bindings';
*
* const msg = readCStr(sym!.ngtcp2_strerror(-202) as ArrayBuffer); // "NOBUF"
* ```
*/
export function readCStr(ptr: ArrayBuffer): string {
  const bytes: number[] = [];
  for (let i = 0;; i++) {
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
/** QUIC v1 wire version number (RFC 9000). */
export const NGTCP2_PROTO_VER_V1 = 1;
/** QUIC v2 wire version number (RFC 9369), `0x6b3343cf`. */
export const NGTCP2_PROTO_VER_V2 = 1798521807;
/**
* ABI version of the `ngtcp2_callbacks` struct to request, chosen from the
* library version detected at load time.
*
* Newer ngtcp2 releases appended callback slots and bumped this version; the
* value selected here must match `NGTCP2_CALLBACKS_SIZE` when allocating and
* passing the struct.
*/
export const NGTCP2_CALLBACKS_VERSION = _VERSION_NUM >= 71168 ? 3 : _VERSION_NUM >= 69120 ? 2 : 1;
/**
* ABI version of the `ngtcp2_settings` struct to request, chosen from the
* detected library version. Pairs with `NGTCP2_SETTINGS_SIZE`.
*/
export const NGTCP2_SETTINGS_VERSION = _VERSION_NUM >= 69376 ? 3 : 2;
/** ABI version of the `ngtcp2_transport_params` struct passed to the versioned encode/decode/default helpers. */
export const NGTCP2_TRANSPORT_PARAMS_VERSION = 1;
/** ABI version of the `ngtcp2_pkt_info` struct passed with each read/write packet call. */
export const NGTCP2_PKT_INFO_VERSION = 1;
/** Byte size of the `ngtcp2_pkt_info` struct (holds the ECN codepoint of a datagram). */
export const NGTCP2_PKT_INFO_SIZE = 8;
/** Offset of the ECN field within an `ngtcp2_pkt_info` struct. */
export const PKT_INFO_ECN = 0;
/** ECN codepoint: Not-ECT — the datagram is not ECN-capable. */
export const NGTCP2_ECN_NOT_ECT = 0;
/** ECN codepoint: ECT(1) — ECN-Capable Transport, codepoint 1. */
export const NGTCP2_ECN_ECT_1 = 1;
/** ECN codepoint: ECT(0) — ECN-Capable Transport, codepoint 0. */
export const NGTCP2_ECN_ECT_0 = 2;
/** ECN codepoint: CE — Congestion Experienced, set by a router on the path. */
export const NGTCP2_ECN_CE = 3;
/** Bitmask isolating the two-bit ECN field from an IP tclass/tos byte. */
export const NGTCP2_ECN_MASK = 3;
/** QUIC transport error code `NO_ERROR` (0), a clean connection close with no error. */
export const NGTCP2_NO_ERROR = 0;
/** Base of the QUIC `CRYPTO_ERROR` transport error range (0x0100); TLS alert `n` maps to `256 + n`. */
export const NGTCP2_CRYPTO_ERROR = 256;
/** Conservative maximum UDP payload assumed safe to send before PMTU discovery (1200 bytes, the QUIC minimum). */
export const NGTCP2_MAX_UDP_PAYLOAD_SIZE = 1200;
/** Default largest UDP payload ngtcp2 will accept on receive when none is configured. */
export const NGTCP2_DEFAULT_MAX_RECV_UDP_PAYLOAD_SIZE = 65527;
/** Minimum length of the Destination Connection ID a client must use in its Initial packet. */
export const NGTCP2_MIN_INITIAL_DCIDLEN = 8;
/** Maximum length in bytes of a QUIC connection ID. */
export const NGTCP2_MAX_CIDLEN = 20;
/** ngtcp2 error: the output buffer is too small. */
export const NGTCP2_ERR_NOBUF = -202;
/** ngtcp2 error: the operation is invalid in the connection's current state. */
export const NGTCP2_ERR_INVALID_STATE = -204;
/** ngtcp2 error: no new stream can be opened because the peer's stream limit is reached. */
export const NGTCP2_ERR_STREAM_ID_BLOCKED = -206;
/** ngtcp2 error: no more stream data can be sent because flow control is exhausted. */
export const NGTCP2_ERR_STREAM_DATA_BLOCKED = -208;
/** ngtcp2 error: a fatal error occurred in the TLS/crypto layer. */
export const NGTCP2_ERR_CRYPTO = -213;
/** ngtcp2 error: the packet number space is exhausted; the connection must close. */
export const NGTCP2_ERR_PKT_NUM_EXHAUSTED = -214;
/** ngtcp2 error: a user callback returned failure, aborting the operation. */
export const NGTCP2_ERR_CALLBACK_FAILURE = -502;
/** ngtcp2 error: the peer requested a version that requires version negotiation. */
export const NGTCP2_ERR_VERSION_NEGOTIATION = -235;
/** ngtcp2 error: the connection closed because the idle timeout elapsed. */
export const NGTCP2_ERR_IDLE_CLOSE = -238;
/** ngtcp2 error: the stream's write side is already shut down. */
export const NGTCP2_ERR_STREAM_SHUT_WR = -219;
/** ngtcp2 error: the referenced stream does not exist. */
export const NGTCP2_ERR_STREAM_NOT_FOUND = -220;
/** ngtcp2 error: a Version Negotiation packet was received; the caller must react. */
export const NGTCP2_ERR_RECV_VERSION_NEGOTIATION = -222;
/** ngtcp2 error: no unused connection ID is available to migrate to. */
export const NGTCP2_ERR_CONN_ID_BLOCKED = -227;
/** ngtcp2 error: more data can be coalesced into the current packet; call write again with `WRITE_MORE`. */
export const NGTCP2_ERR_WRITE_MORE = -230;
/** ngtcp2 error: the server must send a Retry packet before proceeding. */
export const NGTCP2_ERR_RETRY = -231;
/** ngtcp2 error: the incoming packet should be silently dropped. */
export const NGTCP2_ERR_DROP_CONN = -232;
/** ngtcp2 error: the connection has entered the closing state. */
export const NGTCP2_ERR_CLOSING = -223;
/** ngtcp2 error: the connection has entered the draining state. */
export const NGTCP2_ERR_DRAINING = -224;
/** Address-validation token type: origin unknown (not from Retry or NEW_TOKEN). */
export const NGTCP2_TOKEN_TYPE_UNKNOWN = 0;
/** Address-validation token type: the token came from a Retry packet. */
export const NGTCP2_TOKEN_TYPE_RETRY = 1;
/** Address-validation token type: the token came from a NEW_TOKEN frame. */
export const NGTCP2_TOKEN_TYPE_NEW_TOKEN = 2;
/** Stream-write flag: mark the written data as the final bytes of the stream (FIN). */
export const NGTCP2_WRITE_STREAM_FLAG_FIN = 2;
/** Stream-write flag: more stream data will be coalesced; keep the packet open for another write. */
export const NGTCP2_WRITE_STREAM_FLAG_MORE = 1;
/** Datagram-write flag: no special handling. */
export const NGTCP2_WRITE_DATAGRAM_FLAG_NONE = 0;
/** Datagram flag reported on receive: the datagram arrived in 0-RTT packets. */
export const NGTCP2_DATAGRAM_FLAG_0RTT = 1;
/** Connection-ID status callback type: the peer activated (began using) this connection ID. */
export const NGTCP2_CONNECTION_ID_STATUS_TYPE_ACTIVATE = 0;
/** Connection-ID status callback type: the peer retired (stopped using) this connection ID. */
export const NGTCP2_CONNECTION_ID_STATUS_TYPE_DEACTIVATE = 1;
/** Path-validation result: the path was validated successfully. */
export const NGTCP2_PATH_VALIDATION_RESULT_SUCCESS = 0;
/** Path-validation result: validation failed. */
export const NGTCP2_PATH_VALIDATION_RESULT_FAILURE = 1;
/** Path-validation result: validation was aborted before completing. */
export const NGTCP2_PATH_VALIDATION_RESULT_ABORTED = 2;
/** Path-validation flag: the path being validated is the server's preferred address. */
export const NGTCP2_PATH_VALIDATION_FLAG_PREFERRED_ADDR = 1;
/** Path-validation flag: a NEW_TOKEN frame should be sent once this path validates. */
export const NGTCP2_PATH_VALIDATION_FLAG_NEW_TOKEN = 2;
// ABI layout constants for the libngtcp2 v1 callback / v2 settings LP64 ABI.
// These values are generated with C sizeof/offsetof and keep this module pure
// FFI: JS owns the backing ArrayBuffers and passes their addresses to ngtcp2.
/** Byte size of the `ngtcp2_callbacks` struct for the selected `NGTCP2_CALLBACKS_VERSION`. */
export const NGTCP2_CALLBACKS_SIZE = NGTCP2_CALLBACKS_VERSION >= 3 ? 360 : NGTCP2_CALLBACKS_VERSION >= 2 ? 328 : 320;
/** Byte size of the `ngtcp2_settings` struct for the selected `NGTCP2_SETTINGS_VERSION`. */
export const NGTCP2_SETTINGS_SIZE = NGTCP2_SETTINGS_VERSION >= 3 ? 200 : 184;
/** Byte size of the `ngtcp2_transport_params` struct. */
export const NGTCP2_TRANSPORT_PARAMS_SIZE = 344;
/** Byte size of the `ngtcp2_ccerr` (connection-close error) struct. */
export const NGTCP2_CCERR_SIZE = 40;
/** Byte size of the `ngtcp2_cid` connection-ID struct (1-byte length + 20-byte data, padded). */
export const NGTCP2_CID_SIZE = 32;
/** Byte size of the `ngtcp2_addr` struct (a sockaddr pointer plus its length). */
export const NGTCP2_ADDR_SIZE = 16;
/** Byte size of the `ngtcp2_path` struct (local addr, remote addr, user-data pointer). */
export const NGTCP2_PATH_SIZE = 40;
/** Byte size of the `ngtcp2_pkt_hd` long-header struct. */
export const NGTCP2_PKT_HD_SIZE = 112;
/** Byte size of the `ngtcp2_vec` (base pointer + length) I/O vector struct. */
export const NGTCP2_VEC_SIZE = 16;
/** Byte size of the `ngtcp2_version_cid` struct filled by `ngtcp2_pkt_decode_version_cid`. */
export const NGTCP2_VERSION_CID_SIZE = 40;
/**
* Byte offset of the `client_initial` function pointer within `ngtcp2_callbacks`.
*
* The `CB_*` constants are the offsets of each callback slot in the
* `ngtcp2_callbacks` struct. Store a `FfiCallback` pointer at the desired offset
* of a JS-allocated callbacks buffer with `Pointer.writePointer` before passing
* it to `ngtcp2_conn_client_new_versioned` / `ngtcp2_conn_server_new_versioned`.
* Slots that did not exist in the requested `NGTCP2_CALLBACKS_VERSION` must be
* left zeroed. This slot fires so a client can produce its first Initial CRYPTO
* data.
*/
export const CB_CLIENT_INITIAL = 0;
/** Offset of the `recv_client_initial` callback: a server received a client's Initial packet. */
export const CB_RECV_CLIENT_INITIAL = 8;
/** Offset of the `recv_crypto_data` callback: TLS handshake bytes arrived for the given encryption level. */
export const CB_RECV_CRYPTO_DATA = 16;
/** Offset of the `handshake_completed` callback: the TLS handshake finished. */
export const CB_HANDSHAKE_COMPLETED = 24;
/** Offset of the `recv_version_negotiation` callback: a Version Negotiation packet was received. */
export const CB_RECV_VERSION_NEGOTIATION = 32;
/** Offset of the `encrypt` callback: AEAD-encrypt a packet payload. */
export const CB_ENCRYPT = 40;
/** Offset of the `decrypt` callback: AEAD-decrypt a packet payload. */
export const CB_DECRYPT = 48;
/** Offset of the `hp_mask` callback: compute the header-protection mask. */
export const CB_HP_MASK = 56;
/** Offset of the `recv_stream_data` callback: application data arrived on a stream. */
export const CB_RECV_STREAM_DATA = 64;
/** Offset of the `acked_stream_data_offset` callback: previously sent stream data was acknowledged. */
export const CB_ACKED_STREAM_DATA_OFFSET = 72;
/** Offset of the `stream_open` callback: the peer opened a new stream. */
export const CB_STREAM_OPEN = 80;
/** Offset of the `stream_close` callback: a stream closed. */
export const CB_STREAM_CLOSE = 88;
/** Offset of the `recv_stateless_reset` callback: a Stateless Reset was received. */
export const CB_RECV_STATELESS_RESET = 96;
/** Offset of the `recv_retry` callback: a Retry packet was received. */
export const CB_RECV_RETRY = 104;
/** Offset of the `extend_max_local_streams_bidi` callback: the peer raised our bidi stream limit. */
export const CB_EXTEND_MAX_LOCAL_STREAMS_BIDI = 112;
/** Offset of the `extend_max_local_streams_uni` callback: the peer raised our uni stream limit. */
export const CB_EXTEND_MAX_LOCAL_STREAMS_UNI = 120;
/** Offset of the `rand` callback: fill a buffer with cryptographically strong random bytes. */
export const CB_RAND = 128;
/** Offset of the `get_new_connection_id` callback: supply a fresh connection ID and its reset token. */
export const CB_GET_NEW_CONNECTION_ID = 136;
/** Offset of the `remove_connection_id` callback: a connection ID was retired and may be forgotten. */
export const CB_REMOVE_CONNECTION_ID = 144;
/** Offset of the `update_key` callback: install the next-generation read/write keys for key update. */
export const CB_UPDATE_KEY = 152;
/** Offset of the `path_validation` callback: path validation completed with a result. */
export const CB_PATH_VALIDATION = 160;
/** Offset of the `select_preferred_addr` callback: choose whether to migrate to the server's preferred address. */
export const CB_SELECT_PREFERRED_ADDR = 168;
/** Offset of the `stream_reset` callback: the peer reset a stream (RESET_STREAM). */
export const CB_STREAM_RESET = 176;
/** Offset of the `extend_max_remote_streams_bidi` callback: our peer may open more bidi streams. */
export const CB_EXTEND_MAX_REMOTE_STREAMS_BIDI = 184;
/** Offset of the `extend_max_remote_streams_uni` callback: our peer may open more uni streams. */
export const CB_EXTEND_MAX_REMOTE_STREAMS_UNI = 192;
/** Offset of the `extend_max_stream_data` callback: a stream's flow-control window grew. */
export const CB_EXTEND_MAX_STREAM_DATA = 200;
/** Offset of the `dcid_status` callback: a destination connection ID was activated or deactivated. */
export const CB_DCID_STATUS = 208;
/** Offset of the `handshake_confirmed` callback: the handshake is confirmed (RFC 9001). */
export const CB_HANDSHAKE_CONFIRMED = 216;
/** Offset of the `recv_new_token` callback: a NEW_TOKEN frame was received for future address validation. */
export const CB_RECV_NEW_TOKEN = 224;
/** Offset of the `delete_crypto_aead_ctx` callback: free an AEAD context created for this connection. */
export const CB_DELETE_CRYPTO_AEAD_CTX = 232;
/** Offset of the `delete_crypto_cipher_ctx` callback: free a header-protection cipher context. */
export const CB_DELETE_CRYPTO_CIPHER_CTX = 240;
/** Offset of the `recv_datagram` callback: an unreliable DATAGRAM frame arrived. */
export const CB_RECV_DATAGRAM = 248;
/** Offset of the `ack_datagram` callback: a sent DATAGRAM was acknowledged. */
export const CB_ACK_DATAGRAM = 256;
/** Offset of the `lost_datagram` callback: a sent DATAGRAM is presumed lost. */
export const CB_LOST_DATAGRAM = 264;
/** Offset of the `get_path_challenge_data` callback: supply random PATH_CHALLENGE data. */
export const CB_GET_PATH_CHALLENGE_DATA = 272;
/** Offset of the `stream_stop_sending` callback: the peer sent STOP_SENDING for a stream. */
export const CB_STREAM_STOP_SENDING = 280;
/** Offset of the `version_negotiation` callback: negotiate the QUIC version to use. */
export const CB_VERSION_NEGOTIATION = 288;
/** Offset of the `recv_rx_key` callback: a receive key for an encryption level became available. */
export const CB_RECV_RX_KEY = 296;
/** Offset of the `recv_tx_key` callback: a transmit key for an encryption level became available. */
export const CB_RECV_TX_KEY = 304;
/** Offset of the `early_data_rejected` callback: the server rejected 0-RTT early data. */
export const CB_EARLY_DATA_REJECTED = 312;
/** Offset of the `begin_path_validation` callback: path validation is starting (newer ABI). */
export const CB_BEGIN_PATH_VALIDATION = 320;
/** Offset of the `recv_stateless_reset2` callback: extended stateless-reset receive callback (newer ABI). */
export const CB_RECV_STATELESS_RESET2 = 328;
/** Offset of the `get_new_connection_id2` callback: extended connection-ID supplier (newer ABI). */
export const CB_GET_NEW_CONNECTION_ID2 = 336;
/** Offset of the `dcid_status2` callback: extended DCID status callback (newer ABI). */
export const CB_DCID_STATUS2 = 344;
/** Offset of the `get_path_challenge_data2` callback: extended PATH_CHALLENGE data supplier (newer ABI). */
export const CB_GET_PATH_CHALLENGE_DATA2 = 352;
/** Offset of the `datalen` field (connection-ID length) within an `ngtcp2_cid` struct. */
export const CID_DATALEN = 0;
/** Offset of the `data` field (connection-ID bytes) within an `ngtcp2_cid` struct. */
export const CID_DATA = 8;
/** Offset of the `addr` sockaddr pointer within an `ngtcp2_addr` struct. */
export const ADDR_ADDR = 0;
/** Offset of the `addrlen` field within an `ngtcp2_addr` struct. */
export const ADDR_ADDRLEN = 8;
/** Offset of the embedded local `ngtcp2_addr` within an `ngtcp2_path` struct. */
export const PATH_LOCAL = 0;
/** Offset of the embedded remote `ngtcp2_addr` within an `ngtcp2_path` struct. */
export const PATH_REMOTE = 16;
/** Offset of the `user_data` pointer within an `ngtcp2_path` struct. */
export const PATH_USER_DATA = 32;
/** Offset of the `base` data pointer within an `ngtcp2_vec` struct. */
export const VEC_BASE = 0;
/** Offset of the `len` field within an `ngtcp2_vec` struct. */
export const VEC_LEN = 8;
/** Offset of the `version` field within an `ngtcp2_version_cid` struct. */
export const VERSION_CID_VERSION = 0;
/** Offset of the `dcid` pointer within an `ngtcp2_version_cid` struct. */
export const VERSION_CID_DCID = 8;
/** Offset of the `dcidlen` field within an `ngtcp2_version_cid` struct. */
export const VERSION_CID_DCIDLEN = 16;
/** Offset of the `scid` pointer within an `ngtcp2_version_cid` struct. */
export const VERSION_CID_SCID = 24;
/** Offset of the `scidlen` field within an `ngtcp2_version_cid` struct. */
export const VERSION_CID_SCIDLEN = 32;
/** Offset of the `qlog_write` callback pointer within an `ngtcp2_settings` struct. */
export const SETTINGS_QLOG_WRITE = 0;
/** Offset of the `cc_algo` congestion-control algorithm selector within `ngtcp2_settings`. */
export const SETTINGS_CC_ALGO = 8;
/** Offset of the `token` pointer (address-validation token) within `ngtcp2_settings`. */
export const SETTINGS_TOKEN = 48;
/** Offset of the `initial_ts` field (monotonic timestamp at connection start) within `ngtcp2_settings`. */
export const SETTINGS_INITIAL_TS = 16;
/** Offset of the `initial_rtt` field within `ngtcp2_settings`. */
export const SETTINGS_INITIAL_RTT = 24;
/** Offset of the `max_tx_udp_payload_size` field within `ngtcp2_settings`. */
export const SETTINGS_MAX_TX_UDP_PAYLOAD_SIZE = 40;
/** Offset of the `tokenlen` field within `ngtcp2_settings`. */
export const SETTINGS_TOKENLEN = 56;
/** Offset of the `token_type` field (one of the `NGTCP2_TOKEN_TYPE_*` values) within `ngtcp2_settings`. */
export const SETTINGS_TOKEN_TYPE = 64;
/** Offset of the `max_window` field (connection flow-control auto-tuning ceiling) within `ngtcp2_settings`. */
export const SETTINGS_MAX_WINDOW = 80;
/** Offset of the `max_stream_window` field (per-stream auto-tuning ceiling) within `ngtcp2_settings`. */
export const SETTINGS_MAX_STREAM_WINDOW = 88;
/** Offset of the `ack_thresh` field (packets before an ACK is forced) within `ngtcp2_settings`. */
export const SETTINGS_ACK_THRESH = 96;
/** Offset of the `no_tx_udp_payload_size_shaping` flag within `ngtcp2_settings`. */
export const SETTINGS_NO_TX_UDP_PAYLOAD_SIZE_SHAPING = 104;
/** Offset of the `handshake_timeout` field within `ngtcp2_settings`. */
export const SETTINGS_HANDSHAKE_TIMEOUT = 112;
/** Offset of the `preferred_versions` array pointer within `ngtcp2_settings`. */
export const SETTINGS_PREFERRED_VERSIONS = 120;
/** Offset of the `preferred_versionslen` field within `ngtcp2_settings`. */
export const SETTINGS_PREFERRED_VERSIONSLEN = 128;
/** Offset of the `available_versions` array pointer within `ngtcp2_settings`. */
export const SETTINGS_AVAILABLE_VERSIONS = 136;
/** Offset of the `available_versionslen` field within `ngtcp2_settings`. */
export const SETTINGS_AVAILABLE_VERSIONSLEN = 144;
/** Offset of the `original_version` field within `ngtcp2_settings`. */
export const SETTINGS_ORIGINAL_VERSION = 152;
/** Offset of the `no_pmtud` flag (disable Path MTU Discovery) within `ngtcp2_settings`. */
export const SETTINGS_NO_PMTUD = 156;
/** Offset of the embedded `original_dcid` connection ID within an `ngtcp2_transport_params` struct. */
export const TP_ORIGINAL_DCID = 96;
/** Offset of the embedded `initial_scid` connection ID within `ngtcp2_transport_params`. */
export const TP_INITIAL_SCID = 128;
/** Offset of the embedded `retry_scid` connection ID within `ngtcp2_transport_params`. */
export const TP_RETRY_SCID = 160;
/** Offset of the `preferred_addr` sub-struct within `ngtcp2_transport_params` (base for the `TP_PREFERRED_ADDR_*` fields). */
export const TP_PREFERRED_ADDR = 0;
/** Offset of the preferred-address connection ID, relative to the `preferred_addr` sub-struct. */
export const TP_PREFERRED_ADDR_CID = 0;
/** Offset of the preferred-address IPv4 sockaddr, relative to the `preferred_addr` sub-struct. */
export const TP_PREFERRED_ADDR_IPV4 = 32;
/** Offset of the preferred-address IPv6 sockaddr, relative to the `preferred_addr` sub-struct. */
export const TP_PREFERRED_ADDR_IPV6 = 48;
/** Offset of the flag marking the preferred-address IPv4 endpoint present. */
export const TP_PREFERRED_ADDR_IPV4_PRESENT = 76;
/** Offset of the flag marking the preferred-address IPv6 endpoint present. */
export const TP_PREFERRED_ADDR_IPV6_PRESENT = 77;
/** Offset of the preferred-address stateless reset token, relative to the `preferred_addr` sub-struct. */
export const TP_PREFERRED_ADDR_STATELESS_RESET_TOKEN = 78;
/** Offset of `initial_max_stream_data_bidi_local` within `ngtcp2_transport_params`. */
export const TP_INITIAL_MAX_STREAM_DATA_BIDI_LOCAL = 192;
/** Offset of `initial_max_stream_data_bidi_remote` within `ngtcp2_transport_params`. */
export const TP_INITIAL_MAX_STREAM_DATA_BIDI_REMOTE = 200;
/** Offset of `initial_max_stream_data_uni` within `ngtcp2_transport_params`. */
export const TP_INITIAL_MAX_STREAM_DATA_UNI = 208;
/** Offset of `initial_max_data` (connection-level flow-control limit) within `ngtcp2_transport_params`. */
export const TP_INITIAL_MAX_DATA = 216;
/** Offset of `initial_max_streams_bidi` within `ngtcp2_transport_params`. */
export const TP_INITIAL_MAX_STREAMS_BIDI = 224;
/** Offset of `initial_max_streams_uni` within `ngtcp2_transport_params`. */
export const TP_INITIAL_MAX_STREAMS_UNI = 232;
/** Offset of `max_idle_timeout` within `ngtcp2_transport_params`. */
export const TP_MAX_IDLE_TIMEOUT = 240;
/** Offset of `max_udp_payload_size` within `ngtcp2_transport_params`. */
export const TP_MAX_UDP_PAYLOAD_SIZE = 248;
/** Offset of `active_connection_id_limit` within `ngtcp2_transport_params`. */
export const TP_ACTIVE_CONNECTION_ID_LIMIT = 256;
/** Offset of `ack_delay_exponent` within `ngtcp2_transport_params`. */
export const TP_ACK_DELAY_EXPONENT = 264;
/** Offset of `max_ack_delay` within `ngtcp2_transport_params`. */
export const TP_MAX_ACK_DELAY = 272;
/** Offset of `max_datagram_frame_size` (DATAGRAM extension) within `ngtcp2_transport_params`. */
export const TP_MAX_DATAGRAM_FRAME_SIZE = 280;
/** Offset of the flag marking `stateless_reset_token` present within `ngtcp2_transport_params`. */
export const TP_STATELESS_RESET_TOKEN_PRESENT = 288;
/** Offset of the `disable_active_migration` flag within `ngtcp2_transport_params`. */
export const TP_DISABLE_ACTIVE_MIGRATION = 289;
/** Offset of the flag marking `original_dcid` present within `ngtcp2_transport_params`. */
export const TP_ORIGINAL_DCID_PRESENT = 290;
/** Offset of the flag marking `initial_scid` present within `ngtcp2_transport_params`. */
export const TP_INITIAL_SCID_PRESENT = 291;
/** Offset of the flag marking `retry_scid` present within `ngtcp2_transport_params`. */
export const TP_RETRY_SCID_PRESENT = 292;
/** Offset of the flag marking `preferred_addr` present within `ngtcp2_transport_params`. */
export const TP_PREFERRED_ADDR_PRESENT = 293;
/** Offset of the 16-byte `stateless_reset_token` within `ngtcp2_transport_params`. */
export const TP_STATELESS_RESET_TOKEN = 294;
/** Byte size of the `ngtcp2_conn_info` struct filled by `ngtcp2_conn_get_conn_info_versioned`. */
export const NGTCP2_CONN_INFO_SIZE = 120;
/** ABI version of the `ngtcp2_conn_info` struct to request. */
export const NGTCP2_CONN_INFO_VERSION = 2;
/** Offset of `latest_rtt` within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_LATEST_RTT = 0;
/** Offset of `min_rtt` within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_MIN_RTT = 8;
/** Offset of `smoothed_rtt` within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_SMOOTHED_RTT = 16;
/** Offset of `rttvar` (RTT variance) within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_RTTVAR = 24;
/** Offset of `cwnd` (congestion window) within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_CWND = 32;
/** Offset of `ssthresh` (slow-start threshold) within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_SSTHRESH = 40;
/** Offset of `bytes_in_flight` within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_BYTES_IN_FLIGHT = 48;
/** Offset of the total packets-sent counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_PKT_SENT = 56;
/** Offset of the total bytes-sent counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_BYTES_SENT = 64;
/** Offset of the total packets-received counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_PKT_RECV = 72;
/** Offset of the total bytes-received counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_BYTES_RECV = 80;
/** Offset of the total packets-lost counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_PKT_LOST = 88;
/** Offset of the total bytes-lost counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_BYTES_LOST = 96;
/** Offset of the PING-received counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_PING_RECV = 104;
/** Offset of the packets-discarded counter within an `ngtcp2_conn_info` struct. */
export const CONN_INFO_PKT_DISCARDED = 112;
/** Offset of the embedded destination connection ID within an `ngtcp2_pkt_hd` struct. */
export const PKT_HD_DCID = 0;
/** Offset of the embedded source connection ID within an `ngtcp2_pkt_hd` struct. */
export const PKT_HD_SCID = 32;
/** Offset of the `token` pointer within an `ngtcp2_pkt_hd` struct. */
export const PKT_HD_TOKEN = 72;
/** Offset of the `tokenlen` field within an `ngtcp2_pkt_hd` struct. */
export const PKT_HD_TOKENLEN = 80;
/** Offset of the `version` field within an `ngtcp2_pkt_hd` struct. */
export const PKT_HD_VERSION = 104;
/** Offset of the long-header packet `type` field within an `ngtcp2_pkt_hd` struct. */
export const PKT_HD_TYPE = 108;
/** Offset of the `type` field (transport vs. application error) within an `ngtcp2_ccerr` struct. */
export const CCERR_TYPE = 0;
/** Offset of the `error_code` field within an `ngtcp2_ccerr` struct. */
export const CCERR_ERROR_CODE = 8;
/** Offset of the `reason` pointer (human-readable close reason) within an `ngtcp2_ccerr` struct. */
export const CCERR_REASON = 24;
/** Offset of the `reasonlen` field within an `ngtcp2_ccerr` struct. */
export const CCERR_REASONLEN = 32;
