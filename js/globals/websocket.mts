/**
 * WebSocket client and server.
 *
 * Implements RFC 6455 in two composable layers:
 *
 * Learn more:
 * - WebSocket API: https://websockets.spec.whatwg.org/
 * - WebSocket Protocol: https://www.rfc-editor.org/rfc/rfc6455
 * - WebSocket Compression Extensions: https://www.rfc-editor.org/rfc/rfc7692
 *
 *
 * ## WebSocketConnection (lower-level engine)
 *
 * Extends EventTarget. Handles framing, masking, UTF-8 validation, close
 * handshakes, PING/PONG, and subprotocol negotiation. Used directly by
 * server code or wrapped by the WHATWG `WebSocket` facade.
 *
 * ```ts no_run
 *   // CLIENT
 *   const conn = WebSocketConnection.connect('wss://example.com/ws', {
 *     protocols: ['chat.v1'],
 *   });
 *   conn.addEventListener('open',    () => conn.send('hello'));
 *   conn.addEventListener('message', (e) => console.log(e.data));
 *   conn.addEventListener('close',   (e) => console.log(e.code));
 *
 *   // SERVER (inside a serve() handler)
 *
 *   serve({ port: 3000 }, async (incoming) => {
 *     if (incoming.kind === 'websocket') {
 *       const ws = await incoming.accept({ protocol: 'chat.v1' });
 *       ws.addEventListener('message', (e) => ws.send(`echo: ${e.data}`));
 *       return;
 *     }
 *     await incoming.reject(new Response('hello'));
 *   });
 * ```
 *
 *
 * ## WebSocket (WHATWG facade)
 *
 * WHATWG-compatible global facade. Wraps a WebSocketConnection and exposes the
 * browser API surface: constructor validation, `CONNECTING`/`OPEN`/`CLOSING`/
 * `CLOSED` states, `url`, `protocol`, `extensions`, `bufferedAmount`,
 * `binaryType`, event handler properties, `send()`, and `close()`.
 *
 * ```ts no_run
 *   const ws = new WebSocket('wss://example.com/ws', ['chat.v1']);
 *   ws.binaryType = 'arraybuffer';
 *   ws.onopen    = () => ws.send('hello');
 *   ws.onmessage = (e) => console.log(e.data);
 *   ws.onclose   = (e) => console.log('closed', e.code, e.wasClean);
 * ```
 *
 * ### WebSocket API conformance matrix
 *
 * | Area | Baseline | Coverage |
 * | --- | --- | --- |
 * | Constructor | Accepts `ws:` and `wss:` URLs, rejects fragments and duplicate requested protocols synchronously. | `tests/net/websocket.test.mts` |
 * | Lifecycle | Starts at `CONNECTING`, forwards `open`, `message`, `error`, and `close`, and exposes browser ready-state constants. | `tests/net/websocket.test.mts` |
 * | Sending | `send()` accepts strings, binary buffers, typed arrays, and blobs once open; pre-open sends throw because this release does not buffer before `OPEN`. | `tests/net/websocket.test.mts` |
 * | Binary receive | `binaryType` defaults to `blob`; `arraybuffer` switches binary messages to copied ArrayBuffers; invalid assignments throw `TypeError` without changing the previous value. | `tests/net/websocket.test.mts` |
 * | Close | `close()` validates application close codes and the 123-byte UTF-8 reason limit synchronously before starting the close handshake. | `tests/net/websocket.test.mts` |
 * | Negotiation properties | `protocol` reflects the accepted subprotocol, `extensions` reflects accepted server-side permessage-deflate, and `bufferedAmount` is numeric. | `tests/net/websocket.test.mts` |
 * | Extensions | Server-side `permessage-deflate` is negotiated when offered. Unsupported RSV bits still fail protocol validation. | `tests/net/websocket.test.mts` |
 * | HTTP/2 and HTTP/3 | Intentional limit: WebSocket over HTTP/2 (RFC 8441) and HTTP/3 are deferred; this release uses HTTP/1.1 Upgrade only. | `tests/net/http2.test.mts` and research docs |
 *
 *
 * ## Close handshake
 *
 * Both sides share the same handshake: the initiator sends a CLOSE frame,
 * the peer echoes one back, then the underlying socket is closed. A 5-second
 * timeout is applied after the initiator sends its CLOSE — if the peer does
 * not echo within that time, the socket is torn down unilaterally.
 *
 *
 * ## Spec compliance (RFC 6455)
 *
 * Server-side `permessage-deflate` follows RFC 7692 with no context takeover
 * in either direction. The client path does not offer extensions by default
 * and still rejects unsolicited `Sec-WebSocket-Extensions` responses.
 *
 * RFC 8441 WebSocket over HTTP/2 and WebSocket over HTTP/3 are also deferred.
 * `WebSocketConnection` is an HTTP/1.1 Upgrade takeover today; HTTP/2 and
 * HTTP/3 requests that try to hand over a non-H2/H3-compatible takeover are
 * rejected by those protocol drivers.
 *
 * - RSV1 is accepted only for data messages when `permessage-deflate` was
 *   negotiated; all other unexpected RSV bits fail with 1002
 * - Unknown/reserved opcodes → 1002
 * - Control frames must not be fragmented, payload ≤ 125 → 1002
 * - Client→server frames must be masked; server→client must not → 1002
 * - CONTINUATION without an active fragment → 1002
 * - New data frame during an active fragment → 1002
 * - Payload > maxPayloadSize (default 16 MiB) → 1009
 * - Invalid UTF-8 in TEXT messages → 1007
 * - PING → automatic PONG with echoed payload
 */

import { encodeUtf8, btoa }  from './encoding.mts';
import { digest }             from '../internal/openssl.mts';
import { Headers, _headerTokenList, _parseHeaders, _parseResponseLine } from '../net/http/index.mts';
import { Socket }             from '../net/socket.mts';
import { TlsSocket }          from '../net/tls.mts';
import { lookup }             from '../net/dns.mts';
import * as loop              from '../internal/runtime/loop.mts';
import { EventTarget, Event } from './eventtarget.mts';
import { MessageEvent } from './messaging.mts';
import { URL }                from './url.mts';
import { Blob }               from './blob.mts';
import { crypto }             from './crypto.mts';
import { ZlibRawMessageInflater } from '../internal/compress/zlib.mts';
import type { BytesReader, BytesWriter } from '../internal/stream.mts';
import type { IPv4Address, IPv6Address } from '../net/socket.mts';
import type { ConnectionTakeover } from 'internal:net/http/driver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTING = 0;
const OPEN       = 1;
const CLOSING    = 2;
const CLOSED     = 3;

const OP_CONTINUATION = 0x0;
const OP_TEXT         = 0x1;
const OP_BINARY       = 0x2;
const OP_CLOSE        = 0x8;
const OP_PING         = 0x9;
const OP_PONG         = 0xA;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024; // 16 MiB
const CLOSE_TIMEOUT_MS    = 5_000;

function _validReceivedCloseCode(code: number): boolean {
  if (code < 1000 || code > 4999) return false;
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return false;
  if (code >= 1016 && code <= 2999) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Event classes (CloseEvent, ErrorEvent — MessageEvent imported from shared module)
// ---------------------------------------------------------------------------

/**
 *  Web-compatible message event used for WebSocket `message` events.
 *
 * The event data is a string for text messages and binary data for binary
 * messages, with the WHATWG facade applying `binaryType` conversion.
 *
 * ```ts no_run
 * ws.addEventListener('message', (event) => console.log(event.data));
 * ```
 */
export { MessageEvent };

interface CloseEventInit {
  code?:     number;
  reason?:   string;
  wasClean?: boolean;
}

/**
 * WebSocket close event carrying close code, reason, and cleanliness.
 *
 * Instances are dispatched for both protocol close handshakes and local
 * teardown. Code `1006` may be used internally to report abnormal closure.
 *
 * ```ts no_run
 * ws.onclose = (event) => console.log(event.code, event.reason, event.wasClean);
 * ```
 */
export class CloseEvent extends Event {
  /**
   * Private property `#code` used by `CloseEvent`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #code = undefined;
   *
   *   readInternalState() {
   *     return this.#code;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #code:     number;
  /**
   * Private property `#reason` used by `CloseEvent`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #reason = undefined;
   *
   *   readInternalState() {
   *     return this.#reason;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #reason:   string;
  /**
   * Private property `#wasClean` used by `CloseEvent`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #wasClean = undefined;
   *
   *   readInternalState() {
   *     return this.#wasClean;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #wasClean: boolean;

  /**
   * Create a close event.
   *
   * Missing fields default to code `0`, empty reason, and `wasClean: false`.
   *
   * ```ts no_run
   * const event = new CloseEvent('close', { code: 1000, reason: 'done', wasClean: true });
   * ```
   */
  constructor(type: string, init?: CloseEventInit) {
    super(type);
    this.#code     = init?.code     ?? 0;
    this.#reason   = init?.reason   ?? '';
    this.#wasClean = init?.wasClean ?? false;
  }

  /** Close status code.
   *
   * ```ts no_run
   * console.log(event.code);
   * ```
   */
  get code()     { return this.#code; }
  /** UTF-8 close reason string.
   *
   * ```ts no_run
   * console.log(event.reason);
   * ```
   */
  get reason()   { return this.#reason; }
  /** Whether the close handshake completed cleanly.
   *
   * ```ts no_run
   * console.log(event.wasClean);
   * ```
   */
  get wasClean() { return this.#wasClean; }
}

/**
 * WebSocket error event carrying the underlying error value when available.
 *
 * The `error` value may be any thrown value, or `null` when no concrete error
 * was captured.
 *
 * ```ts no_run
 * ws.onerror = (event) => console.log(event.error);
 * ```
 */
export class ErrorEvent extends Event {
  /**
   * Private property `#error` used by `ErrorEvent`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #error = undefined;
   *
   *   readInternalState() {
   *     return this.#error;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #error: unknown;

  /**
   * Create an error event.
   *
   * ```ts no_run
   * const event = new ErrorEvent('error', { error: new Error('failed') });
   * ```
   */
  constructor(type: string, init?: { error?: unknown }) {
    super(type);
    this.#error = init?.error ?? null;
  }

  /** Underlying error value, or `null`.
   *
   * ```ts no_run
   * console.log(event.error);
   * ```
   */
  get error() { return this.#error; }
}

// ---------------------------------------------------------------------------
// Internal: WebSocket message type
// ---------------------------------------------------------------------------

/**
 * Parsed WebSocket message payload used by lower-level connection helpers.
 *
 * Text messages expose a string. Binary messages expose raw bytes and are not
 * converted to Blob by `WebSocketConnection`.
 *
 * ```ts no_run
 * for await (const message of conn) console.log(message.type, message.data);
 * ```
 */
export interface WebSocketMessage {
  /** Message kind.
   *
   * ```ts no_run
   * if (message.type === 'binary') console.log(message.data);
   * ```
   */
  type: 'text' | 'binary';
  /** Message payload.
   *
   * ```ts no_run
   * if (message.type === 'text') console.log(message.data.toUpperCase());
   * ```
   */
  data: string | Uint8Array;
}

// ---------------------------------------------------------------------------
// Internal: buffered byte consumer
// ---------------------------------------------------------------------------

/**
 *  Accumulates byte chunks and provides consume(n) for exact-byte reads. */
class _Buf {
  #chunks: Uint8Array[] = [];
  #size:   number       = 0;

  push(chunk: Uint8Array): void {
    this.#chunks.push(chunk);
    this.#size += chunk.byteLength;
  }

  get available(): number { return this.#size; }

  consume(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let pos = 0;
    while (pos < n) {
      const head = this.#chunks[0]!;
      const need = n - pos;
      if (head.byteLength <= need) {
        out.set(head, pos);
        pos          += head.byteLength;
        this.#size   -= head.byteLength;
        this.#chunks.shift();
      } else {
        out.set(head.subarray(0, need), pos);
        this.#chunks[0] = head.subarray(need);
        this.#size      -= need;
        pos              = n;
      }
    }
    return out;
  }
}

/**
 *  Read exactly n bytes from a Reader into a _Buf, then consume them. */
async function _readExactly(
  reader: BytesReader,
  buf:    _Buf,
  n:      number,
): Promise<Uint8Array | null> {
  while (buf.available < n) {
    const chunk = await reader.read();
    if (chunk === null) return null;
    buf.push(chunk);
  }
  return buf.consume(n);
}

// ---------------------------------------------------------------------------
// Internal: frame helpers
// ---------------------------------------------------------------------------

/**
 *  XOR-mask data in-place using a 4-byte masking key. */
function _maskInPlace(data: Uint8Array, key: Uint8Array): void {
  for (let i = 0; i < data.length; i++) {
    data[i]! ^= key[i & 3]!;
  }
}

/**
 * Encode a WebSocket frame.
 * @param opcode  Frame opcode (OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG)
 * @param payload Raw payload bytes
 * @param mask    True for client→server (masked), false for server→client
 * @param fin     FIN bit (default true — single-frame message)
 */
function _encodeFrame(
  opcode:  number,
  payload: Uint8Array,
  mask:    boolean,
  fin:     boolean = true,
  rsv:     number = 0,
): Uint8Array {
  const len = payload.byteLength;
  let headerLen = 2;
  if (len > 65535)      headerLen += 8;
  else if (len > 125)   headerLen += 2;
  if (mask)             headerLen += 4;

  const frame = new Uint8Array(headerLen + len);
  frame[0] = (fin ? 0x80 : 0x00) | (rsv & 0x70) | (opcode & 0x0F);

  let pos = 2;
  if (len <= 125) {
    frame[1] = (mask ? 0x80 : 0x00) | len;
    pos = 2;
  } else if (len <= 65535) {
    frame[1] = (mask ? 0x80 : 0x00) | 126;
    frame[2] = (len >>> 8) & 0xFF;
    frame[3] =  len        & 0xFF;
    pos = 4;
  } else {
    frame[1] = (mask ? 0x80 : 0x00) | 127;
    // 64-bit big-endian length (JS numbers are safe up to 2^53)
    const hi = Math.floor(len / 0x100000000);
    const lo = len >>> 0;
    frame[2] = (hi >>> 24) & 0xFF;
    frame[3] = (hi >>> 16) & 0xFF;
    frame[4] = (hi >>>  8) & 0xFF;
    frame[5] =  hi         & 0xFF;
    frame[6] = (lo >>> 24) & 0xFF;
    frame[7] = (lo >>> 16) & 0xFF;
    frame[8] = (lo >>>  8) & 0xFF;
    frame[9] =  lo         & 0xFF;
    pos = 10;
  }

  if (mask) {
    const maskKey = new Uint8Array(4);
    crypto.getRandomValues(maskKey);
    frame[pos]     = maskKey[0]!;
    frame[pos + 1] = maskKey[1]!;
    frame[pos + 2] = maskKey[2]!;
    frame[pos + 3] = maskKey[3]!;
    pos += 4;
    frame.set(payload, pos);
    for (let i = 0; i < len; i++) frame[pos + i]! ^= maskKey[i & 3]!;
  } else {
    frame.set(payload, pos);
  }

  return frame;
}

// ---------------------------------------------------------------------------
// Internal: handshake helpers
// ---------------------------------------------------------------------------

/**
 *  Generate a random 16-byte base64-encoded WebSocket handshake key. */
function _handshakeKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < 16; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/**
 *  Compute the Sec-WebSocket-Accept header value for a given Sec-WebSocket-Key. */
function _acceptHash(key: string): string {
  const combined = encodeUtf8(key + WS_GUID);
  const hash     = digest('sha-1', combined);
  let binary = '';
  for (let i = 0; i < hash.byteLength; i++) binary += String.fromCharCode(hash[i]!);
  return btoa(binary);
}

function _hasPerMessageDeflateOffer(header: string | null): boolean {
  if (!header) return false;
  for (const offer of header.split(',')) {
    const name = offer.split(';', 1)[0]!.trim().toLowerCase();
    if (name === 'permessage-deflate') return true;
  }
  return false;
}

function _perMessageDeflateResponse(header: string | null): string {
  if (!_hasPerMessageDeflateOffer(header)) return '';
  return 'permessage-deflate; server_no_context_takeover; client_no_context_takeover';
}

/**
 * Read HTTP response headers from `reader`, putting any bytes after the
 * "\r\n\r\n" terminator into `preamble` for later use by the frame reader.
 *
 * Returns parsed status code and a lowercase Map of header names → values.
 * This avoids the internal-buffer trap in `parseResponse`: if that function's
 * `_createReader` closure buffers bytes beyond `\r\n\r\n`, those bytes are
 * inaccessible after it returns — which would silently drop WebSocket frames
 * that arrive in the same TCP segment as the 101 response.
 */
async function _readUpgradeResponse(
  reader:   BytesReader,
  preamble: _Buf,
): Promise<{ status: number; headers: Map<string, string> }> {
  const CR = 13, LF = 10;
  const parts: Uint8Array[] = [];
  let totalLen = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk === null) throw new Error('Connection closed during WebSocket handshake');
    parts.push(chunk);
    totalLen += chunk.byteLength;

    // Assemble all received bytes
    let assembled: Uint8Array;
    if (parts.length === 1) {
      assembled = parts[0]!;
    } else {
      assembled = new Uint8Array(totalLen);
      let pos = 0;
      for (const p of parts) { assembled.set(p, pos); pos += p.byteLength; }
    }

    // Search for \r\n\r\n starting from a position that avoids rescanning.
    const searchFrom = Math.max(0, totalLen - chunk.byteLength - 3);
    let headerEnd = -1;
    for (let i = searchFrom; i + 3 < assembled.byteLength; i++) {
      if (assembled[i] === CR && assembled[i + 1] === LF &&
          assembled[i + 2] === CR && assembled[i + 3] === LF) {
        headerEnd = i + 4;
        break;
      }
    }

    if (headerEnd < 0) continue;

    // Any bytes after \r\n\r\n belong to the WebSocket framing layer.
    if (headerEnd < assembled.byteLength) {
      preamble.push(new Uint8Array(assembled.subarray(headerEnd)));
    }

    // Parse status line and headers through the shared scanner-backed HTTP
    // parser used by the regular HTTP/1 path.
    const parsed = _parseHeaders(assembled.subarray(0, headerEnd));
    const { status } = _parseResponseLine(parsed.firstLine);
    const headers = new Map<string, string>();
    for (const [name, value] of parsed.headers) {
      headers.set(name, value);
    }
    return { status, headers };
  }
}

// ---------------------------------------------------------------------------
// WebSocketConnection options interfaces
// ---------------------------------------------------------------------------

/**
 * Options used when accepting a WebSocket upgrade from an HTTP handler.
 *
 * If both `protocol` and `selectProtocol` are omitted, no subprotocol is
 * selected. Invalid upgrade requests throw synchronously.
 *
 * ```ts no_run
 * const conn = WebSocketConnection.accept(req, { protocol: 'chat.v1' });
 * ```
 */
export interface WebSocketAcceptOptions {
  /** Single subprotocol to accept; must be offered by the client when present.
   *
   * ```ts no_run
   * WebSocketConnection.accept(req, { protocol: 'chat.v1' });
   * ```
   */
  protocol?:       string;
  /** Callback to select a subprotocol from the list offered by the client.
   *
   * Return `null` to accept no subprotocol.
   *
   * ```ts no_run
   * WebSocketConnection.accept(req, { selectProtocol: (offered) => offered[0] ?? null });
   * ```
   */
  selectProtocol?: (offered: string[]) => string | null;
  /** Maximum payload size in bytes; defaults to 16 MiB.
   *
   * Frames exceeding this cause close code 1009.
   *
   * ```ts no_run
   * WebSocketConnection.accept(req, { maxPayloadSize: 1024 * 1024 });
   * ```
   */
  maxPayloadSize?: number;
}

/**
 * Options used when opening a WebSocket client connection.
 *
 * Headers are added to the HTTP upgrade request. Duplicate protocol names throw
 * synchronously.
 *
 * ```ts no_run
 * const conn = WebSocketConnection.connect('wss://example.com/ws', { protocols: ['chat.v1'] });
 * ```
 */
export interface WebSocketConnectOptions {
  /** Requested subprotocols, joined as `Sec-WebSocket-Protocol`.
   *
   * ```ts no_run
   * WebSocketConnection.connect(url, { protocols: ['chat.v1', 'chat.v2'] });
   * ```
   */
  protocols?:      string | string[];
  /** Extra request headers sent with the upgrade request.
   *
   * ```ts no_run
   * WebSocketConnection.connect(url, { headers: { authorization: 'Bearer token' } });
   * ```
   */
  headers?:        Record<string, string> | Headers;
  /** Maximum incoming payload size in bytes; defaults to 16 MiB.
   *
   * ```ts no_run
   * WebSocketConnection.connect(url, { maxPayloadSize: 1024 * 1024 });
   * ```
   */
  maxPayloadSize?: number;
}

// ---------------------------------------------------------------------------
// WebSocketConnection — the engine
// ---------------------------------------------------------------------------

/**
 * A WebSocket connection, client or server side. Extends EventTarget.
 *
 * Events dispatched: 'open', 'message' (MessageEvent), 'close' (CloseEvent),
 * 'error' (ErrorEvent), 'ping', 'pong'.
 *
 * Use the static factories:
 *   - `WebSocketConnection.connect(url, opts)` — client (async via events)
 *   - `WebSocketConnection.accept(req, opts)` — server (from a serve() handler)
 *
 * ```ts no_run
 * const conn = WebSocketConnection.connect('wss://example.com/ws');
 * conn.onmessage = (event) => console.log(event.data);
 * ```
 */
export class WebSocketConnection extends EventTarget implements ConnectionTakeover {
  /** Ready state before the handshake completes.
   *
   * ```ts no_run
   * if (conn.readyState === WebSocketConnection.CONNECTING) console.log('connecting');
   * ```
   */
  static readonly CONNECTING = CONNECTING;
  /** Ready state while messages may be sent.
   *
   * ```ts no_run
   * if (conn.readyState === WebSocketConnection.OPEN) await conn.send('hello');
   * ```
   */
  static readonly OPEN       = OPEN;
  /** Ready state after close has started.
   *
   * ```ts no_run
   * if (conn.readyState === WebSocketConnection.CLOSING) console.log('closing');
   * ```
   */
  static readonly CLOSING    = CLOSING;
  /** Ready state after the connection is closed.
   *
   * ```ts no_run
   * if (conn.readyState === WebSocketConnection.CLOSED) console.log('closed');
   * ```
   */
  static readonly CLOSED     = CLOSED;

  /** HTTP protocols this takeover can run under.
   *
   * WebSocketConnection currently supports HTTP/1.1 upgrade takeovers.
   *
   * ```ts no_run
   * console.log(conn.compatibleProtocols.has('http/1.1'));
   * ```
   */
  readonly compatibleProtocols: ReadonlySet<string> = new Set(['http/1.1']);

  // ── State ──────────────────────────────────────────────────────────────────

  /**
   * Private property `#role` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #role = undefined;
   *
   *   readInternalState() {
   *     return this.#role;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #role:           'client' | 'server' = 'client';
  /**
   * Private property `#readyState` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readyState = undefined;
   *
   *   readInternalState() {
   *     return this.#readyState;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #readyState:     number              = CONNECTING;
  /**
   * Private property `#url` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #url = undefined;
   *
   *   readInternalState() {
   *     return this.#url;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #url:            string              = '';
  /**
   * Private property `#protocol` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #protocol = undefined;
   *
   *   readInternalState() {
   *     return this.#protocol;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #protocol:       string              = '';
  /**
   * Private property `#extensions` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #extensions = undefined;
   *
   *   readInternalState() {
   *     return this.#extensions;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #extensions:     string              = '';
  #perMessageDeflate: boolean          = false;
  #perMessageInflater: ZlibRawMessageInflater | null = null;
  /**
   * Private property `#maxPayloadSize` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #maxPayloadSize = undefined;
   *
   *   readInternalState() {
   *     return this.#maxPayloadSize;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #maxPayloadSize: number              = DEFAULT_MAX_PAYLOAD;
  /**
   * Private property `#ownsSocket` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #ownsSocket = undefined;
   *
   *   readInternalState() {
   *     return this.#ownsSocket;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #ownsSocket:     boolean             = false;    // true when connect() created the socket

  // ── I/O ────────────────────────────────────────────────────────────────────

  /**
   * Private property `#rawReader` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #rawReader = undefined;
   *
   *   readInternalState() {
   *     return this.#rawReader;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #rawReader:   BytesReader | null = null;
  /**
   * Private property `#rawWriter` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #rawWriter = undefined;
   *
   *   readInternalState() {
   *     return this.#rawWriter;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #rawWriter:   BytesWriter | null = null;
  /**
   * Private property `#socket` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #socket = undefined;
   *
   *   readInternalState() {
   *     return this.#socket;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #socket:      Socket | null = null;

  // Serialised write queue: each enqueued fn runs after the previous one.
  /**
   * Private property `#writeQueue` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writeQueue = undefined;
   *
   *   readInternalState() {
   *     return this.#writeQueue;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #writeQueue: Promise<void> = Promise.resolve();

  // Bytes currently buffered in the write queue (best-effort bufferedAmount).
  /**
   * Private property `#bufferedBytes` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #bufferedBytes = undefined;
   *
   *   readInternalState() {
   *     return this.#bufferedBytes;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #bufferedBytes: number = 0;

  // ── Handshake ──────────────────────────────────────────────────────────────

  /**
   * Private property `#handshakeBytes` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #handshakeBytes = undefined;
   *
   *   readInternalState() {
   *     return this.#handshakeBytes;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #handshakeBytes: Uint8Array | null = null;   // server: pre-computed 101 bytes
  /**
   * Private property `#preamble` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #preamble = undefined;
   *
   *   readInternalState() {
   *     return this.#preamble;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #preamble:       _Buf       | null = null;   // client: bytes after 101 \r\n\r\n

  // ── Close state ────────────────────────────────────────────────────────────

  /**
   * Private property `#closeSent` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closeSent = undefined;
   *
   *   readInternalState() {
   *     return this.#closeSent;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closeSent:     boolean                                = false;
  /**
   * Private property `#closeReceived` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closeReceived = undefined;
   *
   *   readInternalState() {
   *     return this.#closeReceived;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closeReceived: { code: number; reason: string } | null = null;
  /**
   * Private property `#closeResolve` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closeResolve = undefined;
   *
   *   readInternalState() {
   *     return this.#closeResolve;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closeResolve:  (() => void) | null                    = null;
  /**
   * Private property `#closePromise` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closePromise = undefined;
   *
   *   readInternalState() {
   *     return this.#closePromise;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closePromise:  Promise<void>                          = Promise.resolve();

  // ── Async iterator ─────────────────────────────────────────────────────────

  /**
   * Private property `#msgQueue` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #msgQueue = undefined;
   *
   *   readInternalState() {
   *     return this.#msgQueue;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #msgQueue:   WebSocketMessage[]                                 = [];
  /**
   * Private property `#msgWaiters` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #msgWaiters = undefined;
   *
   *   readInternalState() {
   *     return this.#msgWaiters;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #msgWaiters: Array<(r: IteratorResult<WebSocketMessage>) => void> = [];

  // ── IDL attribute callbacks ─────────────────────────────────────────────────

  /**
   * Private property `#onopen` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onopen = undefined;
   *
   *   readInternalState() {
   *     return this.#onopen;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onopen:    ((e: Event) => void) | null        = null;
  /**
   * Private property `#onmessage` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onmessage = undefined;
   *
   *   readInternalState() {
   *     return this.#onmessage;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onmessage: ((e: MessageEvent) => void) | null = null;
  /**
   * Private property `#onerror` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onerror = undefined;
   *
   *   readInternalState() {
   *     return this.#onerror;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onerror:   ((e: ErrorEvent) => void) | null   = null;
  /**
   * Private property `#onclose` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onclose = undefined;
   *
   *   readInternalState() {
   *     return this.#onclose;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onclose:   ((e: CloseEvent) => void) | null   = null;

  // ---------------------------------------------------------------------------
  // Constructor (private — use static factories)
  // ---------------------------------------------------------------------------

  /**
   * Create an unconnected WebSocketConnection.
   *
   * Prefer `connect()` or `accept()` because the constructor does not perform a
   * handshake or attach I/O.
   *
   * ```ts no_run
   * const conn = new WebSocketConnection();
   * ```
   */
  constructor() { super(); }

  // ---------------------------------------------------------------------------
  // Public state
  // ---------------------------------------------------------------------------

  /** Role: `client` sends masked frames; `server` sends unmasked frames.
   *
   * ```ts no_run
   * console.log(conn.role);
   * ```
   */
  get role():           'client' | 'server' { return this.#role; }
  /** Current ready state.
   *
   * ```ts no_run
   * console.log(conn.readyState);
   * ```
   */
  get readyState():     number              { return this.#readyState; }
  /** WebSocket URL string for this connection.
   *
   * ```ts no_run
   * console.log(conn.url);
   * ```
   */
  get url():            string              { return this.#url; }
  /** Negotiated subprotocol, or an empty string.
   *
   * ```ts no_run
   * console.log(conn.protocol || 'none');
   * ```
   */
  get protocol():       string              { return this.#protocol; }
  /** Negotiated extension string.
   *
   * ```ts no_run
   * console.log(conn.extensions);
   * ```
   */
  get extensions():     string              { return this.#extensions; }
  /** Best-effort count of bytes queued for writing.
   *
   * ```ts no_run
   * console.log(conn.bufferedAmount);
   * ```
   */
  get bufferedAmount(): number              { return this.#bufferedBytes; }

  /** The underlying socket, available once `open` fires and `null` before that.
   *
   * ```ts no_run
   * conn.onopen = () => console.log(conn.socket?.fd);
   * ```
   */
  get socket(): Socket | null { return this.#socket; }

  /** Callback for `open` events.
   *
   * ```ts no_run
   * conn.onopen = () => conn.send('hello');
   * ```
   */
  get onopen()    { return this.#onopen; }
  /** Callback for `message` events.
   *
   * ```ts no_run
   * conn.onmessage = (event) => console.log(event.data);
   * ```
   */
  get onmessage() { return this.#onmessage; }
  /** Callback for `error` events.
   *
   * ```ts no_run
   * conn.onerror = (event) => console.log(event.error);
   * ```
   */
  get onerror()   { return this.#onerror; }
  /** Callback for `close` events.
   *
   * ```ts no_run
   * conn.onclose = (event) => console.log(event.code);
   * ```
   */
  get onclose()   { return this.#onclose; }

  /** Set the `open` callback, or `null` to clear it.
   *
   * ```ts no_run
   * conn.onopen = null;
   * ```
   */
  set onopen(fn: ((e: Event) => void) | null)        {
    if (this.#onopen !== null) this.removeEventListener('open', this.#onopen as any);
    this.#onopen = typeof fn === 'function' ? fn : null;
    if (this.#onopen !== null) this.addEventListener('open', this.#onopen as any);
  }
  /** Set the `message` callback, or `null` to clear it.
   *
   * ```ts no_run
   * conn.onmessage = null;
   * ```
   */
  set onmessage(fn: ((e: MessageEvent) => void) | null) {
    if (this.#onmessage !== null) this.removeEventListener('message', this.#onmessage as any);
    this.#onmessage = typeof fn === 'function' ? fn : null;
    if (this.#onmessage !== null) this.addEventListener('message', this.#onmessage as any);
  }
  /** Set the `error` callback, or `null` to clear it.
   *
   * ```ts no_run
   * conn.onerror = null;
   * ```
   */
  set onerror(fn: ((e: ErrorEvent) => void) | null)  {
    if (this.#onerror !== null) this.removeEventListener('error', this.#onerror as any);
    this.#onerror = typeof fn === 'function' ? fn : null;
    if (this.#onerror !== null) this.addEventListener('error', this.#onerror as any);
  }
  /** Set the `close` callback, or `null` to clear it.
   *
   * ```ts no_run
   * conn.onclose = null;
   * ```
   */
  set onclose(fn: ((e: CloseEvent) => void) | null)  {
    if (this.#onclose !== null) this.removeEventListener('close', this.#onclose as any);
    this.#onclose = typeof fn === 'function' ? fn : null;
    if (this.#onclose !== null) this.addEventListener('close', this.#onclose as any);
  }

  // ---------------------------------------------------------------------------
  // Public send / close API
  // ---------------------------------------------------------------------------

  /**
   * Send a text, binary, or Blob message.
   * Returns a Promise that resolves when the frame has been written.
   * Throws if readyState is CONNECTING; silently returns if CLOSING or CLOSED.
   *
   * ```ts no_run
   * await conn.send('hello');
   * await conn.send(new Uint8Array([1, 2, 3]));
   * ```
   */
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): Promise<void> {
    if (this.#readyState === CONNECTING) {
      const err = new Error('WebSocket is not yet open');
      err.name  = 'InvalidStateError';
      throw err;
    }
    if (this.#readyState !== OPEN) return Promise.resolve();

    let payload: Uint8Array;
    let opcode: number;

    if (typeof data === 'string') {
      payload = encodeUtf8(data);
      opcode  = OP_TEXT;
    } else if (data instanceof Blob) {
      // Queue async blob read, then frame
      return this.#enqueue(async () => {
        const ab  = await data.arrayBuffer();
        const pl  = new Uint8Array(ab);
        await this.#writeFrame(OP_BINARY, pl);
      }, data.size);
    } else if (data instanceof ArrayBuffer) {
      payload = new Uint8Array(data);
      opcode  = OP_BINARY;
    } else if (ArrayBuffer.isView(data)) {
      payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      opcode  = OP_BINARY;
    } else {
      const err = new Error('send: unsupported data type');
      err.name  = 'TypeError';
      throw err;
    }

    return this.#enqueue(() => this.#writeFrame(opcode, payload), payload.byteLength);
  }

  /**
   * Send a PING control frame. The peer should respond with a PONG.
   * Payload must be ≤ 125 bytes.
   *
   * ```ts no_run
   * await conn.ping(new Uint8Array([1]));
   * ```
   */
  ping(data?: Uint8Array): Promise<void> {
    if (this.#readyState !== OPEN) return Promise.resolve();
    const payload = data ?? new Uint8Array(0);
    if (payload.byteLength > 125) throw new Error('ping: payload must be ≤ 125 bytes');
    return this.#enqueue(() => this.#writeFrame(OP_PING, payload));
  }

  /**
   * Send a PONG control frame.
   * Payload must be ≤ 125 bytes.
   *
   * ```ts no_run
   * await conn.pong();
   * ```
   */
  pong(data?: Uint8Array): Promise<void> {
    if (this.#readyState !== OPEN) return Promise.resolve();
    const payload = data ?? new Uint8Array(0);
    if (payload.byteLength > 125) throw new Error('pong: payload must be ≤ 125 bytes');
    return this.#enqueue(() => this.#writeFrame(OP_PONG, payload));
  }

  /**
   * Initiate the WebSocket close handshake.
   *
   * `code` defaults to 1000 and must be 1000 or 3000-4999. `reason` must encode
   * to at most 123 UTF-8 bytes. Resolves when the peer close arrives or the
   * close timeout tears down the socket.
   *
   * ```ts no_run
   * await conn.close(1000, 'done');
   * ```
   */
  async close(code: number = 1000, reason: string = ''): Promise<void> {
    if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;

    if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
      const err = new Error('Invalid WebSocket close code: ' + code);
      err.name  = 'InvalidAccessError';
      throw err;
    }

    const reasonBytes = encodeUtf8(reason);
    if (reasonBytes.byteLength > 123) {
      const err = new Error('WebSocket close reason too long (max 123 UTF-8 bytes)');
      err.name  = 'SyntaxError';
      throw err;
    }

    this.#readyState = CLOSING;
    this.#closeSent  = true;

    const payload = new Uint8Array(2 + reasonBytes.byteLength);
    payload[0] = (code >>> 8) & 0xFF;
    payload[1] =  code        & 0xFF;
    payload.set(reasonBytes, 2);

    await this.#enqueue(() => this.#writeFrame(OP_CLOSE, payload));

    // Wait for peer CLOSE echo (or timeout)
    const closeTimer = loop.timeout(CLOSE_TIMEOUT_MS);
    await Promise.race([
      this.#closePromise,
      closeTimer.then(() => {
        if (this.#readyState !== CLOSED) this.#teardown();
      }),
    ]);
    closeTimer.cancel(); // no-op if timeout already fired
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  // ---------------------------------------------------------------------------
  // Async iterator (alternative to events)
  // ---------------------------------------------------------------------------

  /**
   * Iterate received WebSocket messages.
   *
   * The iterator completes when the connection reaches CLOSED. Returning from
   * the iterator does not close the WebSocket.
   *
   * ```ts no_run
   * for await (const message of conn) console.log(message.data);
   * ```
   */
  [Symbol.asyncIterator](): AsyncIterator<WebSocketMessage> {
    const self = this;
    return {
      next(): Promise<IteratorResult<WebSocketMessage>> {
        if (self.#msgQueue.length > 0) {
          return Promise.resolve({ done: false, value: self.#msgQueue.shift()! });
        }
        if (self.#readyState === CLOSED) {
          return Promise.resolve({ done: true, value: undefined as unknown as WebSocketMessage });
        }
        return new Promise(resolve => self.#msgWaiters.push(resolve));
      },
      return(): Promise<IteratorResult<WebSocketMessage>> {
        return Promise.resolve({ done: true, value: undefined as unknown as WebSocketMessage });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Static factories
  // ---------------------------------------------------------------------------

  /**
   * SERVER FACTORY — Synchronously validate an HTTP upgrade request and return
   * a WebSocketConnection in the CONNECTING state. The 'open' event fires after
   * serve() writes the 101 response and hands over the socket.
   *
   * Throws a plain Error (name='SyntaxError') if the request is not a valid
   * WebSocket upgrade. The handler can catch this and return a 400 Response.
   *
   * ```ts no_run
   * serve({ port: 3000 }, async (incoming) => {
   *   if (incoming.kind === 'websocket') {
   *     const ws = await incoming.accept({ protocol: 'chat.v1' });
   *     ws.addEventListener('message', (e) => ws.send(`echo: ${e.data}`));
   *     return;
   *   }
   *   await incoming.reject(new Response('hello'));
   * });
   * ```
   */
  static accept(req: { method: string; url: string; headers: Headers }, opts: WebSocketAcceptOptions = {}): WebSocketConnection {
    // Validate request
    if (req.method !== 'GET') {
      throw Object.assign(new Error('WebSocket upgrade requires GET'), { name: 'SyntaxError' });
    }

    const upgrade = (req.headers.get('upgrade') ?? '').toLowerCase().trim();
    if (upgrade !== 'websocket') {
      throw Object.assign(new Error('Missing or invalid Upgrade: websocket header'), { name: 'SyntaxError' });
    }

    const connection = req.headers.get('connection');
    if (!_headerTokenList(connection).some((t: string) => t.toLowerCase() === 'upgrade')) {
      throw Object.assign(new Error('Missing Connection: Upgrade header'), { name: 'SyntaxError' });
    }

    const version = req.headers.get('sec-websocket-version') ?? '';
    if (version !== '13') {
      throw Object.assign(new Error('WebSocket version must be 13'), { name: 'SyntaxError' });
    }

    const clientKey = req.headers.get('sec-websocket-key') ?? '';
    if (!clientKey) {
      throw Object.assign(new Error('Missing Sec-WebSocket-Key header'), { name: 'SyntaxError' });
    }

    // Negotiate subprotocol
    const offered = _headerTokenList(req.headers.get('sec-websocket-protocol'));
    let   negotiated: string | null = null;

    if (opts.selectProtocol) {
      negotiated = opts.selectProtocol(offered);
    } else if (opts.protocol) {
      if (offered.length > 0 && !offered.includes(opts.protocol)) {
        throw Object.assign(
          new Error('Requested protocol "' + opts.protocol + '" not offered by client'),
          { name: 'SyntaxError' },
        );
      }
      negotiated = opts.protocol;
    }

    // Compute accept hash
    const acceptHash = _acceptHash(clientKey);
    const negotiatedExtensions = _perMessageDeflateResponse(req.headers.get('sec-websocket-extensions'));

    // Build 101 response bytes
    let resp = 'HTTP/1.1 101 Switching Protocols\r\n'
             + 'Upgrade: websocket\r\n'
             + 'Connection: Upgrade\r\n'
             + 'Sec-WebSocket-Accept: ' + acceptHash + '\r\n';
    if (negotiated) resp += 'Sec-WebSocket-Protocol: ' + negotiated + '\r\n';
    if (negotiatedExtensions) resp += 'Sec-WebSocket-Extensions: ' + negotiatedExtensions + '\r\n';
    resp += '\r\n';

    const conn = new WebSocketConnection();
    conn.#role           = 'server';
    conn.#readyState     = CONNECTING;
    conn.#url            = req.url;
    conn.#protocol       = negotiated ?? '';
    conn.#extensions     = negotiatedExtensions;
    conn.#perMessageDeflate = negotiatedExtensions !== '';
    conn.#perMessageInflater = conn.#perMessageDeflate ? new ZlibRawMessageInflater() : null;
    conn.#maxPayloadSize = opts.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD;
    conn.#ownsSocket     = false;
    conn.#handshakeBytes = encodeUtf8(resp);

    const done = new Promise<void>(resolve => { conn.#closeResolve = resolve; });
    conn.#closePromise = done;

    return conn;
  }

  /**
   * CLIENT FACTORY — Open a WebSocket connection to a remote URL.
   * Returns a WebSocketConnection immediately in the CONNECTING state.
   * The 'open' event fires when the handshake completes; 'error' + 'close'
   * fire if the connection fails.
   *
   * ```ts no_run
   * const ws = WebSocketConnection.connect('wss://example.com/chat', {
   *   protocols: ['chat.v1'],
   * });
   * ws.addEventListener('open',    () => ws.send('hello'));
   * ws.addEventListener('message', (e) => console.log(e.data));
   * ```
   */
  static connect(url: string | URL, opts: WebSocketConnectOptions = {}): WebSocketConnection {
    const parsed = new URL(String(url));
    const isWss  = parsed.protocol === 'wss:';

    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw Object.assign(
        new Error('WebSocket URL must use ws: or wss: scheme'),
        { name: 'SyntaxError' },
      );
    }
    if (parsed.hash !== '') {
      throw Object.assign(
        new Error('WebSocket URL must not have a fragment identifier'),
        { name: 'SyntaxError' },
      );
    }

    // Normalize protocols
    const rawProtocols = opts.protocols ?? [];
    const protocols    = Array.isArray(rawProtocols) ? rawProtocols : [rawProtocols];
    const protoSet     = new Set<string>();
    for (const p of protocols) {
      if (protoSet.has(p)) {
        throw Object.assign(new Error('Duplicate WebSocket subprotocol: ' + p), { name: 'SyntaxError' });
      }
      protoSet.add(p);
    }

    const conn = new WebSocketConnection();
    conn.#role           = 'client';
    conn.#readyState     = CONNECTING;
    conn.#url            = parsed.href;
    conn.#protocol       = '';
    conn.#extensions     = '';
    conn.#maxPayloadSize = opts.maxPayloadSize ?? DEFAULT_MAX_PAYLOAD;
    conn.#ownsSocket     = true;

    const done = new Promise<void>(resolve => { conn.#closeResolve = resolve; });
    conn.#closePromise = done;

    // Launch async connection; errors are surfaced as 'error'+'close' events.
    conn.#doConnect(parsed, isWss, protocols, opts).catch(() => {});

    return conn;
  }

  // ---------------------------------------------------------------------------
  // Internal: serve() integration — called by _handleConnection
  // ---------------------------------------------------------------------------

  /**
   * Hand over an existing reader/writer from _handleConnection to this
   * WebSocketConnection. Writes the pre-computed 101 handshake, transitions
   * to OPEN, dispatches 'open', and starts the frame read pump.
   *
   * Returns a Promise that resolves when the WebSocket is fully closed.
   * `serve()` awaits this before running its `finally` (which closes r/w).
   *
   * @internal — not part of the public API surface.
   *
   * ```ts no_run
   * await conn._takeOver(reader, writer);
   * ```
   */
  _takeOver(reader: BytesReader, writer: BytesWriter): Promise<void> {
    const done = this.#closePromise;

    void (async () => {
      try {
        // Write the pre-computed 101 response
        await writer.write(this.#handshakeBytes!);
        await writer.flush();
        this.#handshakeBytes = null;
        this.#rawReader = reader;
        this.#rawWriter = writer;
        this.#attach();
      } catch (err) {
        this.#fireError(err);
        this.#teardown();
      }
    })();

    return done;
  }

  // ---------------------------------------------------------------------------
  // Private: connection setup
  // ---------------------------------------------------------------------------

  /**
   * Private method `#doConnect` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #doConnect() {
   *     return 'doConnect';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#doConnect();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #doConnect(
    parsed:    InstanceType<typeof URL>,
    isWss:     boolean,
    protocols: string[],
    opts:      WebSocketConnectOptions,
  ): Promise<void> {
    const hostname = parsed.hostname;
    const port     = parsed.port
      ? parseInt(parsed.port, 10)
      : (isWss ? 443 : 80);
    const path = (parsed.pathname + parsed.search) || '/';

    let reader: BytesReader | null = null;
    let writer: BytesWriter | null = null;
    let sock:   Socket | null = null;

    try {
      // DNS lookup
      const { address, family } = await lookup(hostname);
      if (this.#readyState === CLOSED) return;

      const addr: IPv4Address | IPv6Address = family === 6
        ? { family: 'ipv6', ip: address, port }
        : { family: 'ipv4', ip: address, port };

      // TCP / TLS connect
      if (isWss) {
        sock = await TlsSocket.connect(addr, { hostname });
      } else {
        sock = await Socket.connect(addr);
      }
      if (this.#readyState === CLOSED) { sock.close(); return; }

      this.#socket = sock;
      [reader, writer] = sock.split();

      // Build upgrade request
      const key        = _handshakeKey();
      const hostHeader = parsed.port
        ? `${hostname}:${parsed.port}`
        : hostname;

      let reqStr  = `GET ${path} HTTP/1.1\r\n`;
      reqStr     += `Host: ${hostHeader}\r\n`;
      reqStr     += `Upgrade: websocket\r\n`;
      reqStr     += `Connection: Upgrade\r\n`;
      reqStr     += `Sec-WebSocket-Key: ${key}\r\n`;
      reqStr     += `Sec-WebSocket-Version: 13\r\n`;
      if (protocols.length > 0) {
        reqStr   += `Sec-WebSocket-Protocol: ${protocols.join(', ')}\r\n`;
      }
      if (opts.headers) {
        const extraHeaders = new Headers(opts.headers);
        for (const [name, value] of extraHeaders) {
          reqStr += `${name}: ${value}\r\n`;
        }
      }
      reqStr += '\r\n';

      await writer.write(encodeUtf8(reqStr));
      await writer.flush();
      if (this.#readyState === CLOSED) return;

      // Parse HTTP 101 response.
      // We use _readUpgradeResponse instead of parseResponse() so that any
      // bytes that arrive in the same TCP segment as the 101 headers (e.g. an
      // initial PING from the server) are captured in `preamble` rather than
      // lost inside parseResponse's internal _createReader closure.
      const preamble = new _Buf();
      const { status, headers: respHeaders } = await _readUpgradeResponse(reader, preamble);
      if (this.#readyState === CLOSED) return;

      if (status !== 101) {
        throw new Error('WebSocket handshake failed: server returned ' + status);
      }

      const upgradeHdr = (respHeaders.get('upgrade') ?? '').toLowerCase().trim();
      if (upgradeHdr !== 'websocket') {
        throw new Error('WebSocket handshake failed: missing or invalid Upgrade header');
      }

      const connHdr = respHeaders.get('connection');
      if (!_headerTokenList(connHdr).some((t: string) => t.toLowerCase() === 'upgrade')) {
        throw new Error('WebSocket handshake failed: missing Connection: Upgrade');
      }

      const acceptHdr = respHeaders.get('sec-websocket-accept') ?? '';
      if (acceptHdr !== _acceptHash(key)) {
        throw new Error('WebSocket handshake failed: invalid Sec-WebSocket-Accept');
      }

      const serverProto = (respHeaders.get('sec-websocket-protocol') ?? '').trim();
      if (serverProto && !protocols.includes(serverProto)) {
        throw new Error('WebSocket handshake failed: server offered unrecognized protocol: ' + serverProto);
      }

      const serverExt = (respHeaders.get('sec-websocket-extensions') ?? '').trim();
      if (serverExt) {
        throw new Error('WebSocket handshake failed: server offered unsupported extensions: ' + serverExt);
      }

      this.#protocol = serverProto;
      this.#preamble = preamble;
      this.#rawReader = reader;
      this.#rawWriter = writer;
      this.#attach();

    } catch (err) {
      if (reader) try { reader.close(); } catch (_) {}
      if (writer) try { writer.close(); } catch (_) {}
      this.#socket = null;
      this.#fireError(err);
      this.#teardown();
    }
  }

  /** Transition to OPEN, dispatch 'open', start read pump. */
  /**
   * Private method `#attach` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #attach() {
   *     return 'attach';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#attach();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #attach(): void {
    this.#readyState = OPEN;

    queueMicrotask(() => {
      const e = new Event('open');
      this.dispatchEvent(e);
    });

    this.#readPump().catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Private: write queue
  // ---------------------------------------------------------------------------

  /**
   * Enqueue a write operation. Ensures frame atomicity across concurrent
   * send() calls. Errors in individual frames propagate to the caller but
   * do not break the queue for subsequent frames.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #enqueue() {
   *     return 'enqueue';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#enqueue();
   *   }
   * }
   * ```
   */
  #enqueue(fn: () => Promise<void>, bytes: number = 0): Promise<void> {
    this.#bufferedBytes += bytes;
    const next = this.#writeQueue.then(fn);
    this.#writeQueue = next.then(
      () => { this.#bufferedBytes -= bytes; },
      () => { this.#bufferedBytes -= bytes; },
    );
    return next;
  }

  /** Write a single WebSocket frame to the underlying writer. */
  /**
   * Private method `#writeFrame` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #writeFrame() {
   *     return 'writeFrame';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#writeFrame();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #writeFrame(opcode: number, payload: Uint8Array, mask?: boolean): Promise<void> {
    const shouldMask = mask !== undefined ? mask : this.#role === 'client';
    const frame = _encodeFrame(opcode, payload, shouldMask);
    await this.#rawWriter!.write(frame);
    await this.#rawWriter!.flush();
  }

  // ---------------------------------------------------------------------------
  // Private: read pump
  // ---------------------------------------------------------------------------

  /**
   * Private method `#readPump` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #readPump() {
   *     return 'readPump';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#readPump();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #readPump(): Promise<void> {
    const reader = this.#rawReader!;
    // Reuse any bytes captured between the 101 \r\n\r\n and the first read()
    // call (client path only). Without this, frames arriving in the same TCP
    // segment as the 101 headers would be silently dropped.
    const buf = this.#preamble ?? new _Buf();
    this.#preamble = null;

    // Fragment reassembly state
    let fragOpcode = -1;           // -1 = not in fragment
    let fragParts: Uint8Array[] = [];
    let fragSize   = 0;
    let fragCompressed = false;

    try {
      while (true) {
        // Read 2-byte frame header
        const header = await _readExactly(reader, buf, 2);
        if (header === null) break;  // EOF / socket closed

        const fin     = (header[0]! & 0x80) !== 0;
        const rsv     =  header[0]! & 0x70;
        const opcode  =  header[0]! & 0x0F;
        const masked  = (header[1]! & 0x80) !== 0;
        const lenCode =  header[1]! & 0x7F;

        const rsv1 = (rsv & 0x40) !== 0;
        const unexpectedRsv = rsv & 0x30;

        if (unexpectedRsv !== 0) {
          await this.#failProtocol(1002, 'Unexpected RSV bits');
          break;
        }

        // Validate opcode: 0x0–0x2 (data), 0x8–0xA (control); others reserved
        const isControl = opcode >= 0x8;
        if ((opcode > 0x2 && opcode < 0x8) || opcode > 0xA) {
          await this.#failProtocol(1002, 'Unknown opcode: 0x' + opcode.toString(16));
          break;
        }

        // Control frame constraints (RFC 6455 §5.5)
        if (isControl) {
          if (rsv1) {
            await this.#failProtocol(1002, 'Control frames must not set RSV bits');
            break;
          }
          if (!fin) {
            await this.#failProtocol(1002, 'Control frames must not be fragmented');
            break;
          }
          if (lenCode > 125) {
            await this.#failProtocol(1002, 'Control frame payload exceeds 125 bytes');
            break;
          }
        }

        if (opcode === OP_CONTINUATION && rsv1) {
          await this.#failProtocol(1002, 'CONTINUATION frames must not set RSV1');
          break;
        }
        if ((opcode === OP_TEXT || opcode === OP_BINARY) && rsv1 && !this.#perMessageDeflate) {
          await this.#failProtocol(1002, 'RSV1 requires negotiated permessage-deflate');
          break;
        }

        // Masking enforcement
        if (this.#role === 'server' && !masked) {
          await this.#failProtocol(1002, 'Frames from client must be masked');
          break;
        }
        if (this.#role === 'client' && masked) {
          await this.#failProtocol(1002, 'Frames from server must not be masked');
          break;
        }

        // Extended payload length
        let payloadLen: number;
        if (lenCode <= 125) {
          payloadLen = lenCode;
        } else if (lenCode === 126) {
          const ext = await _readExactly(reader, buf, 2);
          if (ext === null) break;
          payloadLen = (ext[0]! << 8) | ext[1]!;
        } else {
          // 8-byte length
          const ext = await _readExactly(reader, buf, 8);
          if (ext === null) break;
          if (ext[0]! & 0x80) {
            await this.#failProtocol(1009, 'Payload length most-significant bit is set');
            break;
          }
          payloadLen =
            ext[0]! * 0x100000000000000 + ext[1]! * 0x1000000000000 +
            ext[2]! * 0x10000000000 + ext[3]! * 0x100000000 +
            ext[4]! * 0x1000000 + ext[5]! * 0x10000 +
            ext[6]! * 0x100 + ext[7]!;
        }

        // Enforce max payload size
        if (payloadLen > this.#maxPayloadSize) {
          await this.#failProtocol(1009, 'Payload exceeds maxPayloadSize (' + this.#maxPayloadSize + ' bytes)');
          break;
        }

        // Read mask key
        let maskKey: Uint8Array | null = null;
        if (masked) {
          maskKey = await _readExactly(reader, buf, 4);
          if (maskKey === null) break;
        }

        // Read payload
        const payload = payloadLen > 0
          ? await _readExactly(reader, buf, payloadLen)
          : new Uint8Array(0);
        if (payload === null) break;

        // Unmask
        if (maskKey !== null) _maskInPlace(payload, maskKey);

        // ── Dispatch by opcode ──────────────────────────────────────────────

        if (opcode === OP_PING) {
          this.dispatchEvent(new Event('ping'));
          // Auto-pong: enqueue but don't await (read pump must not block)
          void this.#enqueue(() => this.#writeFrame(OP_PONG, payload, this.#role === 'client'));
          continue;
        }

        if (opcode === OP_PONG) {
          this.dispatchEvent(new Event('pong'));
          continue;
        }

        if (opcode === OP_CLOSE) {
          let code   = 1005;  // No Status Received
          let reason = '';
          if (payload.byteLength === 1) {
            await this.#failProtocol(1002, 'CLOSE payload length must be 0 or at least 2 bytes');
            break;
          }
          if (payload.byteLength >= 2) {
            code = (payload[0]! << 8) | payload[1]!;
            if (!_validReceivedCloseCode(code)) {
              await this.#failProtocol(1002, 'Invalid WebSocket close code: ' + code);
              break;
            }
            if (payload.byteLength > 2) {
              try {
                reason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
              } catch {
                await this.#failProtocol(1007, 'Invalid UTF-8 in WebSocket close reason');
                break;
              }
            }
          }
          this.#closeReceived = { code, reason };
          // Echo close frame if we haven't initiated one
          if (!this.#closeSent) {
            this.#closeSent = true;
            const echo = payload.byteLength <= 125 ? payload : payload.subarray(0, 125);
            await this.#enqueue(() => this.#writeFrame(OP_CLOSE, echo, this.#role === 'client'));
          }
          break;
        }

        // Data frames: TEXT, BINARY, CONTINUATION
        if (opcode === OP_CONTINUATION) {
          if (fragOpcode === -1) {
            await this.#failProtocol(1002, 'CONTINUATION frame without a preceding data frame');
            break;
          }
          fragParts.push(payload);
          fragSize += payload.byteLength;
        } else {
          // TEXT or BINARY — must not be in a fragment
          if (fragOpcode !== -1) {
            await this.#failProtocol(1002, 'New data frame received during fragmented message');
            break;
          }
          fragOpcode = opcode;
          fragCompressed = rsv1;
          fragParts.push(payload);
          fragSize   += payload.byteLength;
        }

        // Assemble on FIN
        if (fin) {
          let assembled: Uint8Array;
          if (fragParts.length === 1) {
            assembled = fragParts[0]!;
          } else {
            assembled = new Uint8Array(fragSize);
            let pos = 0;
            for (const part of fragParts) { assembled.set(part, pos); pos += part.byteLength; }
          }

          // Reset fragment state before delivery (in case deliver throws)
          const msgOpcode = fragOpcode;
          const compressed = fragCompressed;
          fragOpcode      = -1;
          fragCompressed   = false;
          fragParts       = [];
          fragSize        = 0;

          if (compressed) {
            try {
              assembled = this.#perMessageInflater!.inflateMessage(assembled);
            } catch {
              await this.#failProtocol(1003, 'Invalid permessage-deflate payload');
              break;
            }
            if (assembled.byteLength > this.#maxPayloadSize) {
              await this.#failProtocol(1009, 'Inflated payload exceeds maxPayloadSize (' + this.#maxPayloadSize + ' bytes)');
              break;
            }
          }

          if (msgOpcode === OP_TEXT) {
            let text: string;
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(assembled);
            } catch {
              await this.#failProtocol(1007, 'Invalid UTF-8 in text message');
              break;
            }
            this.#deliverMessage({ type: 'text', data: text });
          } else {
            this.#deliverMessage({ type: 'binary', data: assembled });
          }
        }
      }
    } catch (_err) {
      // Socket / I/O error — fall through to teardown
    } finally {
      this.#teardown();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: close / error helpers
  // ---------------------------------------------------------------------------

  /** Send a close frame and set closeSent flag (used for protocol violations). */
  /**
   * Private method `#failProtocol` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #failProtocol() {
   *     return 'failProtocol';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#failProtocol();
   *   }
   * }
   * ```
   *
   * @internal
   */
  async #failProtocol(code: number, reason: string): Promise<void> {
    if (this.#closeSent || this.#readyState === CLOSED) return;
    this.#closeSent  = true;
    this.#readyState = CLOSING;

    const reasonBytes = encodeUtf8(reason.substring(0, 123));
    const payload     = new Uint8Array(2 + reasonBytes.byteLength);
    payload[0] = (code >>> 8) & 0xFF;
    payload[1] =  code        & 0xFF;
    payload.set(reasonBytes, 2);

    try {
      await this.#writeFrame(OP_CLOSE, payload, this.#role === 'client');
    } catch (_) {}
  }

  /** Deliver a decoded message to event listeners and async iterators. */
  /**
   * Private method `#deliverMessage` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #deliverMessage() {
   *     return 'deliverMessage';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#deliverMessage();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #deliverMessage(msg: WebSocketMessage): void {
    const e = new MessageEvent('message', { data: msg.data });
    this.dispatchEvent(e);

    if (this.#msgWaiters.length > 0) {
      this.#msgWaiters.shift()!({ done: false, value: msg });
    } else {
      this.#msgQueue.push(msg);
    }
  }

  /** Drain all pending async iterator waiters with done=true. */
  /**
   * Private method `#closeIterators` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #closeIterators() {
   *     return 'closeIterators';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#closeIterators();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #closeIterators(): void {
    for (const resolve of this.#msgWaiters) {
      resolve({ done: true, value: undefined as unknown as WebSocketMessage });
    }
    this.#msgWaiters = [];
  }

  /** Dispatch an error event. */
  /**
   * Private method `#fireError` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #fireError() {
   *     return 'fireError';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#fireError();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #fireError(err?: unknown): void {
    const e = new ErrorEvent('error', { error: err });
    this.dispatchEvent(e);
  }

  /** Final cleanup: transition to CLOSED, fire 'close', resolve the done promise. */
  /**
   * Private method `#teardown` used by `WebSocketConnection`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #teardown() {
   *     return 'teardown';
   *   }
   *
   *   useInternalMethod() {
   *     return this.#teardown();
   *   }
   * }
   * ```
   *
   * @internal
   */
  #teardown(): void {
    const alreadyClosed = this.#readyState === CLOSED;
    this.#readyState = CLOSED;

    this.#closeIterators();

    if (!alreadyClosed) {
      const code     = this.#closeReceived?.code ?? 1006;
      const reason   = this.#closeReceived?.reason ?? '';
      const wasClean = this.#closeSent && this.#closeReceived !== null;

      const e = new CloseEvent('close', { code, reason, wasClean });
      this.dispatchEvent(e);
    }

    try { this.#rawReader?.close(); } catch (_) {}
    try { this.#rawWriter?.close(); } catch (_) {}
    try { this.#perMessageInflater?.close(); } catch (_) {}
    this.#perMessageInflater = null;

    if (this.#closeResolve) {
      this.#closeResolve();
      this.#closeResolve = null;
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket — WHATWG spec-compliant facade
// ---------------------------------------------------------------------------

/**
 * WHATWG-compatible WebSocket facade.
 *
 * For server-side or lower-level control, use `WebSocketConnection` directly.
 * This facade intentionally does not buffer `send()` calls before `OPEN`.
 * Client connections do not offer extensions by default, and use the HTTP/1.1
 * Upgrade path provided by `WebSocketConnection`; HTTP/2 and HTTP/3 WebSocket
 * transports are deferred.
 *
 * ```ts no_run
 * const ws = new WebSocket('wss://example.com/ws', ['chat.v1']);
 * ws.onopen = () => ws.send('hello');
 * ```
 *
 * @see https://websockets.spec.whatwg.org/
 */
export class WebSocket extends EventTarget {
  /** Ready state before the handshake completes.
   *
   * ```ts no_run
   * if (ws.readyState === WebSocket.CONNECTING) console.log('connecting');
   * ```
   */
  static readonly CONNECTING = CONNECTING;
  /** Ready state while messages can be sent.
   *
   * ```ts no_run
   * if (ws.readyState === WebSocket.OPEN) ws.send('hello');
   * ```
   */
  static readonly OPEN       = OPEN;
  /** Ready state after close has started.
   *
   * ```ts no_run
   * if (ws.readyState === WebSocket.CLOSING) console.log('closing');
   * ```
   */
  static readonly CLOSING    = CLOSING;
  /** Ready state after the connection is closed.
   *
   * ```ts no_run
   * if (ws.readyState === WebSocket.CLOSED) console.log('closed');
   * ```
   */
  static readonly CLOSED     = CLOSED;

  /**
   * Private property `#conn` used by `WebSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #conn = undefined;
   *
   *   readInternalState() {
   *     return this.#conn;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #conn:       WebSocketConnection;
  /**
   * Private property `#binaryType` used by `WebSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #binaryType = undefined;
   *
   *   readInternalState() {
   *     return this.#binaryType;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #binaryType: 'blob' | 'arraybuffer' = 'blob';

  /**
   * Private property `#onopen` used by `WebSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onopen = undefined;
   *
   *   readInternalState() {
   *     return this.#onopen;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onopen:    ((e: Event) => void) | null        = null;
  /**
   * Private property `#onmessage` used by `WebSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onmessage = undefined;
   *
   *   readInternalState() {
   *     return this.#onmessage;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onmessage: ((e: MessageEvent) => void) | null = null;
  /**
   * Private property `#onerror` used by `WebSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onerror = undefined;
   *
   *   readInternalState() {
   *     return this.#onerror;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onerror:   ((e: ErrorEvent) => void) | null   = null;
  /**
   * Private property `#onclose` used by `WebSocket`.
   *
   * This implementation detail is included when documentation is built with
   * `--include-private`. It describes state or helper behavior used by the
   * owning module rather than a stable application-facing contract. Prefer the
   * public API around the owning type unless you are maintaining this runtime.
   *
   * @example
   * ```ts no_run
   * class IncludePrivateExample {
   *   #onclose = undefined;
   *
   *   readInternalState() {
   *     return this.#onclose;
   *   }
   * }
   * ```
   *
   * @internal
   */
  #onclose:   ((e: CloseEvent) => void) | null   = null;

  /**
   * Create a WebSocket and immediately start connecting.
   *
   * `url` must use `ws:` or `wss:` and must not include a fragment. Duplicate
   * requested protocols throw synchronously through the underlying connection
   * factory.
   *
   * ```ts no_run
   * const ws = new WebSocket('wss://example.com/chat', 'chat.v1');
   */
  constructor(url: string | URL, protocols?: string | string[]) {
    super();

    // Validate URL before creating the connection (synchronous, per spec)
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw Object.assign(
        new Error('The URL\'s scheme must be either \'ws\' or \'wss\''),
        { name: 'SyntaxError' },
      );
    }
    if (parsed.hash !== '') {
      throw Object.assign(
        new Error('The URL contains a fragment identifier'),
        { name: 'SyntaxError' },
      );
    }

    this.#conn = WebSocketConnection.connect(url, protocols !== undefined ? { protocols } : {});

    // Forward events from the underlying connection
    const self = this;

    this.#conn.addEventListener('open', function wsOpen(e: Event) {
      const fwd = new Event('open');
      self.dispatchEvent(fwd);
    });

    this.#conn.addEventListener('message', function wsMessage(e: Event) {
      const me   = e as MessageEvent;
      let data   = me.data;

      // Apply binaryType conversion for binary (Uint8Array) data.
      // Default binaryType is 'blob'; 'arraybuffer' delivers a plain ArrayBuffer.
      if (data instanceof Uint8Array) {
        if (self.#binaryType === 'blob') {
          data = new Blob([data]);
        } else {
          // 'arraybuffer': copy into an independent ArrayBuffer
          data = data.slice().buffer as ArrayBuffer;
        }
      }

      const fwd = new MessageEvent('message', { data });
      self.dispatchEvent(fwd);
    });

    this.#conn.addEventListener('error', function wsError(e: Event) {
      const fwd = new ErrorEvent('error', { error: (e as ErrorEvent).error });
      self.dispatchEvent(fwd);
    });

    this.#conn.addEventListener('close', function wsClose(e: Event) {
      const ce  = e as CloseEvent;
      const fwd = new CloseEvent('close', {
        code:     ce.code,
        reason:   ce.reason,
        wasClean: ce.wasClean,
      });
      self.dispatchEvent(fwd);
    });
  }

  // ── Getters ──────────────────────────────────────────────────────────────────

  /** WebSocket URL string.
   *
   * ```ts no_run
   * console.log(ws.url);
   * ```
   */
  get url():            string              { return this.#conn.url; }
  /** Current ready state.
   *
   * ```ts no_run
   * console.log(ws.readyState);
   * ```
   */
  get readyState():     number              { return this.#conn.readyState; }
  /** Best-effort bytes queued for sending.
   *
   * ```ts no_run
   * console.log(ws.bufferedAmount);
   * ```
   */
  get bufferedAmount(): number              { return this.#conn.bufferedAmount; }
  /** Negotiated extensions, currently an empty string.
   *
   * ```ts no_run
   * console.log(ws.extensions);
   * ```
   */
  get extensions():     string              { return this.#conn.extensions; }
  /** Negotiated subprotocol, or an empty string.
   *
   * ```ts no_run
   * console.log(ws.protocol);
   * ```
   */
  get protocol():       string              { return this.#conn.protocol; }

  /** Binary message conversion mode.
   *
   * Defaults to `blob`. Set to `arraybuffer` to receive binary messages as
   * ArrayBuffer values.
   *
   * ```ts no_run
   * ws.binaryType = 'arraybuffer';
   * ```
   */
  get binaryType(): 'blob' | 'arraybuffer' { return this.#binaryType; }
  /** Set binary message conversion mode.
   *
   * Throws `TypeError` for values other than `blob` or `arraybuffer`.
   *
   * ```ts no_run
   * ws.binaryType = 'blob';
   * ```
   */
  set binaryType(v: 'blob' | 'arraybuffer') {
    if (v !== 'blob' && v !== 'arraybuffer') {
      throw new TypeError('binaryType must be "blob" or "arraybuffer"');
    }
    this.#binaryType = v;
  }

  /** Callback for `open` events.
   *
   * ```ts no_run
   * ws.onopen = () => ws.send('hello');
   * ```
   */
  get onopen()    { return this.#onopen; }
  /** Callback for `message` events.
   *
   * ```ts no_run
   * ws.onmessage = (event) => console.log(event.data);
   * ```
   */
  get onmessage() { return this.#onmessage; }
  /** Callback for `error` events.
   *
   * ```ts no_run
   * ws.onerror = (event) => console.log(event.error);
   * ```
   */
  get onerror()   { return this.#onerror; }
  /** Callback for `close` events.
   *
   * ```ts no_run
   * ws.onclose = (event) => console.log(event.code);
   * ```
   */
  get onclose()   { return this.#onclose; }

  /** Set the `open` callback, or `null` to clear it.
   *
   * ```ts no_run
   * ws.onopen = null;
   * ```
   */
  set onopen(fn: ((e: Event) => void) | null)        {
    if (this.#onopen !== null) this.removeEventListener('open', this.#onopen as any);
    this.#onopen = typeof fn === 'function' ? fn : null;
    if (this.#onopen !== null) this.addEventListener('open', this.#onopen as any);
  }
  /** Set the `message` callback, or `null` to clear it.
   *
   * ```ts no_run
   * ws.onmessage = null;
   * ```
   */
  set onmessage(fn: ((e: MessageEvent) => void) | null) {
    if (this.#onmessage !== null) this.removeEventListener('message', this.#onmessage as any);
    this.#onmessage = typeof fn === 'function' ? fn : null;
    if (this.#onmessage !== null) this.addEventListener('message', this.#onmessage as any);
  }
  /** Set the `error` callback, or `null` to clear it.
   *
   * ```ts no_run
   * ws.onerror = null;
   * ```
   */
  set onerror(fn: ((e: ErrorEvent) => void) | null)  {
    if (this.#onerror !== null) this.removeEventListener('error', this.#onerror as any);
    this.#onerror = typeof fn === 'function' ? fn : null;
    if (this.#onerror !== null) this.addEventListener('error', this.#onerror as any);
  }
  /** Set the `close` callback, or `null` to clear it.
   *
   * ```ts no_run
   * ws.onclose = null;
   * ```
   */
  set onclose(fn: ((e: CloseEvent) => void) | null)  {
    if (this.#onclose !== null) this.removeEventListener('close', this.#onclose as any);
    this.#onclose = typeof fn === 'function' ? fn : null;
    if (this.#onclose !== null) this.addEventListener('close', this.#onclose as any);
  }

  // ── send / close (WHATWG spec: synchronous, fire-and-forget) ─────────────────

  /**
   * Queue data to be sent. Throws InvalidStateError if CONNECTING;
   * silently drops if CLOSING or CLOSED.
   *
   * Errors after queuing are surfaced through `error` events, matching the
   * fire-and-forget WHATWG API shape.
   *
   * ```ts no_run
   * ws.send('hello');
   * ws.send(new Uint8Array([1, 2, 3]));
   * ```
   */
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (this.#conn.readyState === CONNECTING) {
      throw Object.assign(
        new Error('WebSocket is not yet open: buffering not supported'),
        { name: 'InvalidStateError' },
      );
    }
    if (this.#conn.readyState !== OPEN) return;
    // Fire and forget — errors are surfaced as 'error' events
    this.#conn.send(data).catch(() => {});
  }

  /**
   * Initiate the close handshake.
   *
   * `code` defaults to 1000 and must be 1000 or 3000-4999. `reason` must encode
   * to at most 123 UTF-8 bytes. Invalid values throw synchronously.
   *
   * ```ts no_run
   * ws.close(1000, 'done');
   * ```
   */
  close(code: number = 1000, reason: string = ''): void {
    const state = this.#conn.readyState;
    if (state === CLOSING || state === CLOSED) return;

    // Validate synchronously (spec requires throw before state change)
    if (code !== 1000 && !(code >= 3000 && code <= 4999)) {
      throw Object.assign(
        new Error('Invalid WebSocket close code: ' + code),
        { name: 'InvalidAccessError' },
      );
    }
    const reasonBytes = new TextEncoder().encode(reason);
    if (reasonBytes.byteLength > 123) {
      throw Object.assign(
        new Error('WebSocket close reason exceeds 123 UTF-8 bytes'),
        { name: 'SyntaxError' },
      );
    }

    // Fire and forget — close event will fire through the forwarded listener
    this.#conn.close(code, reason).catch(() => {});
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
