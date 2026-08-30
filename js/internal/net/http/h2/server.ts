/**
 * internal:net/http/h2/server - HTTP/2 server driver backed by nghttp2.
 *
 * This module drives the server half of an HTTP/2 connection: it enforces
 * frame-level protocol invariants ahead of nghttp2 with a hardened validator,
 * accumulates and validates request pseudo-headers, streams request bodies into
 * a Fino HTTP handler, and submits response headers, body chunks, and trailers
 * back onto the session. It exposes a single public class, `H2ServerDriver`,
 * plus two small header-parsing helpers reused by the client. The two entry
 * points differ only in how the connection began: `run` handles a fresh h2
 * connection (expecting the client preface), while `runFromUpgrade` resumes h2
 * after an HTTP/1.1 `Upgrade: h2c` handshake by replaying the original request
 * as stream 1.
 *
 * Learn more:
 * - HTTP/2: https://www.rfc-editor.org/rfc/rfc9113
 * - HTTP semantics: https://www.rfc-editor.org/rfc/rfc9110
 *
 * ## Stream lifecycle (server side)
 *
 * 1. onBeginHeaders(streamId, isTrailers=false) - allocate H2ServerStream.
 * 2. onHeader - accumulate `:method`, `:path`, `:scheme`, `:authority` + headers.
 * 3. onFrameRecv(HEADERS, END_HEADERS) - initial headers complete.
 *    If END_STREAM also set -> no body, trigger dispatch.
 * 4. onDataChunk(bytes) - push bytes to body queue.
 * 5. onFrameRecv(DATA, END_STREAM) - body complete, trigger dispatch.
 * 6. Handler completes -> submit HEADERS response + DATA frame(s).
 *
 * ## h2c Upgrade (runFromUpgrade)
 *
 * When a connection was upgraded from HTTP/1.1 via the `Upgrade: h2c` dance,
 * `runFromUpgrade` is called instead of `run`. It calls `session.upgradeFromH1`
 * to tell nghttp2 about the prior-knowledge state, then dispatches the original
 * HTTP/1.1 request as stream 1 without going through the normal header-parsing
 * callbacks (those callbacks only fire for frames received from the wire after
 * the upgrade).
 *
 * ## RST_STREAM / stream cancellation
 *
 * When the client sends RST_STREAM, `onStreamClose` fires with a non-zero
 * errorCode. If `dispatchStream` is still waiting for the request body
 * (triggerDispatch not yet called), it unblocks immediately and returns without
 * sending a response. If the response-submission phase has already started,
 * any nghttp2 error from submitting on a closed stream is caught silently.
 *
 * ## Concurrency safety
 *
 * `startDispatch` wraps dispatchStream errors so `Promise.all(inFlight)` in
 * the finally block never rejects. A FIFO serializes all drainWrite calls because
 * concurrent session_mem_send2 calls on the same nghttp2_session* would be a data race.
 *
 * ## Example
 *
 * ```ts no_run
 * import { H2ServerDriver } from 'internal:net/http/h2/server';
 * import { Response } from 'internal:net/http/wire';
 *
 * const driver = new H2ServerDriver();
 * await driver.run(
 *   reader,
 *   writer,
 *   () => new Response('ok'),
 *   { maxConcurrent: 100 },
 * );
 * ```
 *
 * @internal
 */
import type { BufferedBytesReader } from '../../../stream.ts';
import type { BytesWriter } from '../../../stream.ts';
import type { ServerDriver, ServerHandler, ServerDriverOptions } from 'internal:net/http/driver';
import { isConnectionTakeover } from 'internal:net/http/driver';
import { Fifo } from 'internal:fifo';
import { Request, Response, Headers } from '../../../../net/http/index.ts';
import { Scanner } from '../../../../parsing/scanner.ts';
import { HttpBodyQueue, HttpStreamError } from '../stream.ts';
import {
  NGHTTP2_FLAG_END_STREAM,
  NGHTTP2_FLAG_END_HEADERS,
  NGHTTP2_FLAG_PADDED,
  NGHTTP2_FRAME_TYPE_HEADERS,
  NGHTTP2_FRAME_TYPE_DATA,
  NGHTTP2_FRAME_TYPE_PRIORITY,
  NGHTTP2_FRAME_TYPE_RST_STREAM,
  NGHTTP2_FRAME_TYPE_SETTINGS,
  NGHTTP2_FRAME_TYPE_PUSH_PROMISE,
  NGHTTP2_FRAME_TYPE_PING,
  NGHTTP2_FRAME_TYPE_GOAWAY,
  NGHTTP2_FRAME_TYPE_WINDOW_UPDATE,
  NGHTTP2_FRAME_TYPE_CONTINUATION,
  NGHTTP2_INTERNAL_ERROR,
  NGHTTP2_PROTOCOL_ERROR,
  NGHTTP2_REFUSED_STREAM,
  NGHTTP2_STREAM_CLOSED,
  NGHTTP2_ENHANCE_YOUR_CALM,
  NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS,
  NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE,
} from './bindings.ts';
import { Nghttp2Session } from './session.ts';
import type { H2StreamCallbacks } from './session.ts';
// ---------------------------------------------------------------------------
// Per-stream state
// ---------------------------------------------------------------------------
interface H2ServerStream {
  streamId: number;
  method: string;
  path: string;
  scheme: string;
  authority: string;
  headers: Headers;
  trailerHeaders: Headers;
  inTrailers: boolean;
  body: HttpBodyQueue;
  bodyDone: boolean;
  expectedContentLength: number | null;
  dispatched: boolean;
  // Set to true when client RST_STREAMs the stream. dispatchStream checks
  // this after triggerDispatch resolves and returns early if true.
  cancelled: boolean;
  triggerDispatch: (() => void) | null;
  // Header validation state (RFC 7540 Section 8.1.2). Non-null = error code to RST with.
  seenPseudos: Set<string>;
  seenRegularHeader: boolean;
  headerError: number | null;
}
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
function readH2StrictUnsigned(scanner: Scanner, name: string): number {
  const digits = scanner.eatWhile(isDigit);
  if (digits === '') throw new Error(`invalid ${name}`);
  if (!Number.isSafeInteger(Number(digits))) throw new Error(`invalid ${name}`);
  return Number(digits);
}
/**
 * Parse a strict HTTP/2 `:status` header value.
 *
 * The value must contain exactly three ASCII digits and nothing else. Statuses
 * below `100` are rejected; values up to `999` are accepted because HTTP
 * status code space is represented as three digits on the wire.
 *
 * ```ts
 * import { _parseH2StatusHeader } from 'internal:net/http/h2/server';
 * _parseH2StatusHeader('204');
 * ```
 *
 * @internal
 */
export function _parseH2StatusHeader(value: string): number {
  const scanner = new Scanner(value, {
    encoding: 'ascii',
    format: 'http2',
  });
  const digits = scanner.eatWhile(isDigit);
  if (digits.length !== 3 || !scanner.done) throw new Error('invalid :status header');
  const status = Number(digits);
  if (status < 100 || status > 999) throw new Error('invalid :status header');
  return status;
}
/**
 * Parse an HTTP/2 `content-length` field value.
 *
 * The parser accepts comma-separated duplicate values only when every value is
 * the same, matching HTTP semantics for repeated fields. It throws for empty,
 * non-integer, unsafe-integer, or conflicting values.
 *
 * ```ts
 * import { _parseH2ContentLength } from 'internal:net/http/h2/server';
 * _parseH2ContentLength('12, 12');
 * ```
 *
 * @internal
 */
export function _parseH2ContentLength(value: string): number {
  const scanner = new Scanner(value, {
    encoding: 'ascii',
    format: 'http2',
  });
  let expected: number | null = null;
  while (!scanner.done) {
    scanner.skipSpaceTab();
    const current = readH2StrictUnsigned(scanner, 'content-length');
    scanner.skipSpaceTab();
    if (expected === null) expected = current;
    else if (expected !== current) throw new Error('conflicting content-length headers');
    if (scanner.done) break;
    scanner.expect(',', 'invalid content-length header');
  }
  if (expected === null) throw new Error('invalid content-length header');
  return expected;
}
function _isValidRegularHeaderName(name: string): boolean {
  if (name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (
      (code < 97 || code > 122) &&
      (code < 48 || code > 57) &&
      code !== 33 &&
      code !== 35 &&
      code !== 36 &&
      code !== 37 &&
      code !== 38 &&
      code !== 39 &&
      code !== 42 &&
      code !== 43 &&
      code !== 45 &&
      code !== 46 &&
      code !== 94 &&
      code !== 95 &&
      code !== 96 &&
      code !== 124 &&
      code !== 126
    ) {
      return false;
    }
  }
  return true;
}
function _isValidHeaderValue(value: string): boolean {
  if (
    value.startsWith(' ') ||
    value.startsWith('\t') ||
    value.endsWith(' ') ||
    value.endsWith('\t')
  ) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) return false;
  }
  return true;
}
// Connection-specific header fields forbidden in HTTP/2 (RFC 7540 Section 8.1.2.2).
const _FORBIDDEN_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);
const NGHTTP2_FRAME_SIZE_ERROR = 6;
const NGHTTP2_FLOW_CONTROL_ERROR = 3;
const _DEFAULT_MAX_FRAME_SIZE = 16 * 1024;
// Upper bound on the total bytes of a single HEADERS + CONTINUATION block held
// while waiting for END_HEADERS. A client can otherwise stream CONTINUATION
// frames indefinitely without ever setting END_HEADERS, forcing unbounded
// buffering before nghttp2 ever sees (and could reject) the block — the
// HTTP/2 CONTINUATION-flood denial of service. This matches the advertised
// SETTINGS_MAX_HEADER_LIST_SIZE; a legitimate header block never exceeds it.
const _MAX_HEADER_BLOCK_BYTES = 65536;
const _INITIAL_FLOW_CONTROL_WINDOW = 65535;
const _MAX_FLOW_CONTROL_WINDOW = 2147483647;
const _MAX_WRITEV_CHUNKS = 16;
const _H2_PREFACE = new Uint8Array([
  80, 82, 73, 32, 42, 32, 72, 84, 84, 80, 47, 50, 46, 48, 13, 10, 13, 10, 83, 77, 13, 10, 13, 10,
]);
type H2RawStreamState = 'open' | 'halfClosedRemote' | 'closed';
interface H2RawStream {
  state: H2RawStreamState;
  outboundWindow: number;
}
interface H2RawAction {
  kind: 'goaway' | 'rst' | 'close';
  streamId?: number;
  errorCode?: number;
}
interface H2RawValidationResult {
  feed: Uint8Array | null;
  actions: H2RawAction[];
}
function _concatBytes(parts: Uint8Array[]): Uint8Array | null {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  const total = parts.reduce(function sumByteLength(n, p) {
    return n + p.byteLength;
  }, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
function _readFrameLength(bytes: Uint8Array, off: number): number {
  return (bytes[off]! << 16) | (bytes[off + 1]! << 8) | bytes[off + 2]!;
}
function _readFrameStreamId(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off + 5]! & 127) << 24) |
    (bytes[off + 6]! << 16) |
    (bytes[off + 7]! << 8) |
    bytes[off + 8]!
  );
}
function _buildRawFrame(
  type: number,
  flags: number,
  streamId: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(9 + payload.byteLength);
  const len = payload.byteLength;
  out[0] = (len >> 16) & 255;
  out[1] = (len >> 8) & 255;
  out[2] = len & 255;
  out[3] = type & 255;
  out[4] = flags & 255;
  out[5] = (streamId >> 24) & 127;
  out[6] = (streamId >> 16) & 255;
  out[7] = (streamId >> 8) & 255;
  out[8] = streamId & 255;
  out.set(payload, 9);
  return out;
}
function _u32Bytes(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
}
function _buildRawGoaway(errorCode: number): Uint8Array {
  const payload = new Uint8Array(8);
  payload.set(_u32Bytes(0), 0);
  payload.set(_u32Bytes(errorCode), 4);
  return _buildRawFrame(NGHTTP2_FRAME_TYPE_GOAWAY, 0, 0, payload);
}
function _buildRawRstStream(streamId: number, errorCode: number): Uint8Array {
  return _buildRawFrame(NGHTTP2_FRAME_TYPE_RST_STREAM, 0, streamId, _u32Bytes(errorCode));
}
class H2ServerFrameValidator {
  #buffer = new Uint8Array(0);
  #expectPreface: boolean;
  #optionalPreface: boolean;
  #lastClientStreamId = 0;
  #continuationStream = 0;
  #heldHeaderBlock: Uint8Array[] = [];
  #heldHeaderBytes = 0;
  #streams = new Map<number, H2RawStream>();
  #halfClosedInCurrentPush = new Set<number>();
  #openStreams = 0;
  #outboundConnectionWindow = _INITIAL_FLOW_CONTROL_WINDOW;
  constructor(
    private readonly maxConcurrent: number,
    expectPreface: boolean,
    upgradeStream1 = false,
    optionalPreface = false,
  ) {
    this.#expectPreface = expectPreface;
    this.#optionalPreface = optionalPreface;
    if (upgradeStream1) {
      this.#lastClientStreamId = 1;
      this.#streams.set(1, {
        state: 'halfClosedRemote',
        outboundWindow: _INITIAL_FLOW_CONTROL_WINDOW,
      });
    }
  }
  push(chunk: Uint8Array): H2RawValidationResult {
    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    combined.set(this.#buffer, 0);
    combined.set(chunk, this.#buffer.byteLength);
    this.#buffer = combined;
    const feedParts: Uint8Array[] = [];
    const actions: H2RawAction[] = [];
    let pos = 0;
    this.#halfClosedInCurrentPush.clear();
    if (this.#expectPreface) {
      const needed = Math.min(this.#buffer.byteLength, _H2_PREFACE.byteLength);
      for (let i = 0; i < needed; i++) {
        if (this.#buffer[i] !== _H2_PREFACE[i]) {
          this.#buffer = new Uint8Array(0);
          return {
            feed: null,
            actions: [
              {
                kind: 'goaway',
                errorCode: NGHTTP2_PROTOCOL_ERROR,
              },
            ],
          };
        }
      }
      if (this.#buffer.byteLength < _H2_PREFACE.byteLength) {
        return {
          feed: null,
          actions: [],
        };
      }
      feedParts.push(this.#buffer.subarray(0, _H2_PREFACE.byteLength));
      pos = _H2_PREFACE.byteLength;
      this.#expectPreface = false;
    }
    if (this.#optionalPreface && this.#buffer.byteLength > 0) {
      const needed = Math.min(this.#buffer.byteLength, _H2_PREFACE.byteLength);
      let matches = true;
      for (let i = 0; i < needed; i++) {
        if (this.#buffer[i] !== _H2_PREFACE[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        if (this.#buffer.byteLength < _H2_PREFACE.byteLength) {
          return {
            feed: null,
            actions: [],
          };
        }
        feedParts.push(this.#buffer.subarray(0, _H2_PREFACE.byteLength));
        pos = _H2_PREFACE.byteLength;
      }
      this.#optionalPreface = false;
    }
    while (pos + 9 <= this.#buffer.byteLength) {
      const frameStart = pos;
      const length = _readFrameLength(this.#buffer, pos);
      if (length > _DEFAULT_MAX_FRAME_SIZE) {
        this.#buffer = new Uint8Array(0);
        actions.push({
          kind: 'goaway',
          errorCode: NGHTTP2_FRAME_SIZE_ERROR,
        });
        return {
          feed: _concatBytes(feedParts),
          actions,
        };
      }
      const frameEnd = pos + 9 + length;
      if (frameEnd > this.#buffer.byteLength) break;
      const type = this.#buffer[pos + 3]!;
      const flags = this.#buffer[pos + 4]!;
      const streamId = _readFrameStreamId(this.#buffer, pos);
      const action = this.#validateFrame(type, flags, streamId, length, pos + 9);
      pos = frameEnd;
      if (action === 'ignore') continue;
      if (action !== null) {
        feedParts.length = 0;
        this.#heldHeaderBlock = [];
        this.#heldHeaderBytes = 0;
        actions.push(action);
        this.#buffer = this.#buffer.subarray(pos);
        return {
          feed: _concatBytes(feedParts),
          actions,
        };
      }
      const frameBytes = this.#buffer.subarray(frameStart, frameEnd);
      if (type === NGHTTP2_FRAME_TYPE_HEADERS && (flags & NGHTTP2_FLAG_END_HEADERS) === 0) {
        this.#heldHeaderBlock = [frameBytes];
        this.#heldHeaderBytes = frameBytes.byteLength;
      } else if (type === NGHTTP2_FRAME_TYPE_CONTINUATION) {
        this.#heldHeaderBlock.push(frameBytes);
        this.#heldHeaderBytes += frameBytes.byteLength;
        if (this.#heldHeaderBytes > _MAX_HEADER_BLOCK_BYTES) {
          // CONTINUATION flood: the peer keeps extending the header block
          // without END_HEADERS. Refuse before buffering grows further.
          feedParts.length = 0;
          this.#heldHeaderBlock = [];
          this.#heldHeaderBytes = 0;
          this.#buffer = this.#buffer.subarray(pos);
          actions.push({
            kind: 'goaway',
            errorCode: NGHTTP2_ENHANCE_YOUR_CALM,
          });
          return {
            feed: _concatBytes(feedParts),
            actions,
          };
        }
        if (this.#continuationStream === 0) {
          const complete = _concatBytes(this.#heldHeaderBlock);
          if (complete) feedParts.push(complete);
          this.#heldHeaderBlock = [];
          this.#heldHeaderBytes = 0;
        }
      } else {
        feedParts.push(frameBytes);
      }
    }
    this.#buffer = this.#buffer.subarray(pos);
    return {
      feed: _concatBytes(feedParts),
      actions,
    };
  }
  #validateFrame(
    type: number,
    flags: number,
    streamId: number,
    length: number,
    payloadOff: number,
  ): H2RawAction | 'ignore' | null {
    if (this.#continuationStream !== 0) {
      if (type !== NGHTTP2_FRAME_TYPE_CONTINUATION || streamId !== this.#continuationStream) {
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_PROTOCOL_ERROR,
        };
      }
    } else if (type === NGHTTP2_FRAME_TYPE_CONTINUATION) {
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    }
    switch (type) {
      case NGHTTP2_FRAME_TYPE_DATA:
        return this.#validateData(flags, streamId, length, payloadOff);
      case NGHTTP2_FRAME_TYPE_HEADERS:
        return this.#validateHeaders(flags, streamId);
      case NGHTTP2_FRAME_TYPE_PRIORITY:
        return this.#validatePriority(streamId, length, payloadOff);
      case NGHTTP2_FRAME_TYPE_RST_STREAM:
        return this.#validateRstStream(streamId, length);
      case NGHTTP2_FRAME_TYPE_SETTINGS:
        return this.#validateSettings(flags, streamId, length, payloadOff);
      case NGHTTP2_FRAME_TYPE_PUSH_PROMISE:
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_PROTOCOL_ERROR,
        };
      case NGHTTP2_FRAME_TYPE_PING:
        return this.#validatePing(flags, streamId, length);
      case NGHTTP2_FRAME_TYPE_WINDOW_UPDATE:
        return this.#validateWindowUpdate(streamId, length, payloadOff);
      case NGHTTP2_FRAME_TYPE_CONTINUATION:
        if ((flags & NGHTTP2_FLAG_END_HEADERS) !== 0) this.#continuationStream = 0;
        return null;
      default:
        return null;
    }
  }
  #validateData(
    flags: number,
    streamId: number,
    length: number,
    payloadOff: number,
  ): H2RawAction | null {
    if (streamId === 0)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    if ((flags & NGHTTP2_FLAG_PADDED) !== 0) {
      if (length === 0)
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_PROTOCOL_ERROR,
        };
      const padLength = this.#buffer[payloadOff]!;
      if (padLength >= length)
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_PROTOCOL_ERROR,
        };
    }
    const s = this.#streams.get(streamId);
    if (!s)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    if (s.state !== 'open')
      return {
        kind: 'rst',
        streamId,
        errorCode: NGHTTP2_STREAM_CLOSED,
      };
    if ((flags & NGHTTP2_FLAG_END_STREAM) !== 0) {
      s.state = 'halfClosedRemote';
      this.#openStreams = Math.max(0, this.#openStreams - 1);
    }
    return null;
  }
  #validateHeaders(flags: number, streamId: number): H2RawAction | null {
    if (streamId === 0)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    const existing = this.#streams.get(streamId);
    if (existing && existing.state !== 'open') {
      if (existing.state === 'halfClosedRemote' && !this.#halfClosedInCurrentPush.has(streamId)) {
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_STREAM_CLOSED,
        };
      }
      return {
        kind: 'rst',
        streamId,
        errorCode: NGHTTP2_STREAM_CLOSED,
      };
    }
    if (!existing) {
      if ((streamId & 1) === 0 || streamId <= this.#lastClientStreamId) {
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_PROTOCOL_ERROR,
        };
      }
      this.#lastClientStreamId = streamId;
      if (this.#openStreams >= this.maxConcurrent) {
        this.#streams.set(streamId, {
          state: 'closed',
          outboundWindow: _INITIAL_FLOW_CONTROL_WINDOW,
        });
        return {
          kind: 'rst',
          streamId,
          errorCode: NGHTTP2_REFUSED_STREAM,
        };
      }
      this.#streams.set(streamId, {
        state: 'open',
        outboundWindow: _INITIAL_FLOW_CONTROL_WINDOW,
      });
      this.#openStreams++;
    }
    if ((flags & NGHTTP2_FLAG_END_HEADERS) === 0) this.#continuationStream = streamId;
    if ((flags & NGHTTP2_FLAG_END_STREAM) !== 0) {
      const s = this.#streams.get(streamId);
      if (s && s.state === 'open') {
        s.state = 'halfClosedRemote';
        this.#halfClosedInCurrentPush.add(streamId);
        this.#openStreams = Math.max(0, this.#openStreams - 1);
      }
    }
    return null;
  }
  #validatePriority(streamId: number, length: number, payloadOff: number): H2RawAction | null {
    if (streamId === 0)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    if (length !== 5)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_FRAME_SIZE_ERROR,
      };
    const dependency =
      ((this.#buffer[payloadOff]! & 127) << 24) |
      (this.#buffer[payloadOff + 1]! << 16) |
      (this.#buffer[payloadOff + 2]! << 8) |
      this.#buffer[payloadOff + 3]!;
    if (dependency === streamId)
      return {
        kind: 'rst',
        streamId,
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    return null;
  }
  #validateRstStream(streamId: number, length: number): H2RawAction | null {
    if (streamId === 0)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    if (length !== 4)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_FRAME_SIZE_ERROR,
      };
    const existing = this.#streams.get(streamId);
    if (!existing)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    if (existing?.state === 'open') this.#openStreams = Math.max(0, this.#openStreams - 1);
    this.#streams.set(streamId, {
      state: 'closed',
      outboundWindow: existing.outboundWindow,
    });
    return null;
  }
  #validateSettings(
    flags: number,
    streamId: number,
    length: number,
    payloadOff: number,
  ): H2RawAction | null {
    if (streamId !== 0)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    if ((flags & 1) !== 0) {
      if (length !== 0)
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_FRAME_SIZE_ERROR,
        };
    } else if (length % 6 !== 0) {
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_FRAME_SIZE_ERROR,
      };
    } else {
      for (let off = payloadOff; off < payloadOff + length; off += 6) {
        const id = (this.#buffer[off]! << 8) | this.#buffer[off + 1]!;
        if (id === 4) {
          const value =
            ((this.#buffer[off + 2]! << 24) |
              (this.#buffer[off + 3]! << 16) |
              (this.#buffer[off + 4]! << 8) |
              this.#buffer[off + 5]!) >>>
            0;
          if (value > _MAX_FLOW_CONTROL_WINDOW) {
            return {
              kind: 'goaway',
              errorCode: NGHTTP2_FLOW_CONTROL_ERROR,
            };
          }
        }
      }
    }
    return null;
  }
  #validatePing(flags: number, streamId: number, length: number): H2RawAction | 'ignore' | null {
    if (streamId !== 0)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    if (length !== 8)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_FRAME_SIZE_ERROR,
      };
    if ((flags & 1) !== 0) return 'ignore';
    return null;
  }
  #validateWindowUpdate(streamId: number, length: number, payloadOff: number): H2RawAction | null {
    if (length !== 4)
      return {
        kind: 'goaway',
        errorCode: NGHTTP2_FRAME_SIZE_ERROR,
      };
    const increment =
      ((this.#buffer[payloadOff]! & 127) << 24) |
      (this.#buffer[payloadOff + 1]! << 16) |
      (this.#buffer[payloadOff + 2]! << 8) |
      this.#buffer[payloadOff + 3]!;
    if (increment === 0) {
      if (streamId === 0)
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_PROTOCOL_ERROR,
        };
      return {
        kind: 'rst',
        streamId,
        errorCode: NGHTTP2_PROTOCOL_ERROR,
      };
    }
    if (streamId === 0) {
      if (this.#outboundConnectionWindow + increment > _MAX_FLOW_CONTROL_WINDOW) {
        return {
          kind: 'goaway',
          errorCode: NGHTTP2_FLOW_CONTROL_ERROR,
        };
      }
      this.#outboundConnectionWindow += increment;
      return null;
    }
    const existing = this.#streams.get(streamId);
    if (existing && existing.outboundWindow + increment > _MAX_FLOW_CONTROL_WINDOW) {
      return {
        kind: 'rst',
        streamId,
        errorCode: NGHTTP2_FLOW_CONTROL_ERROR,
      };
    }
    if (existing) existing.outboundWindow += increment;
    return null;
  }
}
// ---------------------------------------------------------------------------
// Shared context setup (used by both run() and runFromUpgrade())
// ---------------------------------------------------------------------------
interface H2ServerCtx {
  streams: Map<number, H2ServerStream>;
  inFlight: Set<Promise<void>>;
  drainWrite: () => Promise<void>;
  drainStreams: () => void;
  cancelStream: (streamId: number) => void;
  startDispatch: (stream: H2ServerStream) => void;
  goawayReceived: () => boolean;
  callbacks: H2StreamCallbacks;
  setSession: (s: Nghttp2Session) => void;
}
function _makeCtx(writer: BytesWriter, handler: ServerHandler, maxConcurrent: number): H2ServerCtx {
  const streams = new Map<number, H2ServerStream>();
  const inFlight = new Set<Promise<void>>();
  const drains = new Fifo();
  let receivedGoaway = false;
  // Set by setSession() before any closure runs.
  let session = null as unknown as Nghttp2Session;
  function drainWrite(): Promise<void> {
    async function drainH2Writes() {
      const chunks: Uint8Array[] = [];
      do {
        const bytes = session.flush();
        if (bytes && bytes.byteLength > 0) {
          chunks.push(bytes);
        } else {
          // flow-control window exhausted: nghttp2 wants to write but can't.
          // Break so _recvLoop can process the next incoming WINDOW_UPDATE.
          break;
        }
      } while (session.wantWrite());
      for (let i = 0; i < chunks.length; i += _MAX_WRITEV_CHUNKS) {
        const count = Math.min(_MAX_WRITEV_CHUNKS, chunks.length - i);
        const batch = chunks.slice(i, i + count);
        await writer.writev(batch, count);
      }
      await writer.flush();
    }
    return drains.run(drainH2Writes);
  }
  function resetMalformedBody(stream: H2ServerStream, message: string): void {
    stream.cancelled = true;
    stream.body.error(
      new HttpStreamError('protocol', message, {
        streamId: stream.streamId,
        protocolCode: NGHTTP2_PROTOCOL_ERROR,
      }),
    );
    if (stream.triggerDispatch) {
      stream.triggerDispatch();
      stream.triggerDispatch = null;
    }
    try {
      session.submitRstStream(stream.streamId, NGHTTP2_PROTOCOL_ERROR);
    } catch {}
    void drainWrite();
  }
  async function dispatchStream(stream: H2ServerStream): Promise<void> {
    const { streamId } = stream;
    // Client cancelled the stream (RST_STREAM received) while we were waiting.
    if (stream.cancelled) return;
    const url = `${stream.scheme}://${stream.authority}${stream.path}`;
    const reqBody =
      stream.method === 'GET' || stream.method === 'HEAD' ? null : (stream.body as any);
    const req = new Request(url, {
      method: stream.method,
      headers: stream.headers,
      body: reqBody as any,
      trailers: stream.trailerHeaders,
    });
    let res: Response;
    try {
      const result = await handler(req);
      // Check again: RST_STREAM may have arrived while the handler was running.
      if (stream.cancelled) return;
      if (result instanceof Response) {
        res = result;
      } else if (isConnectionTakeover(result) && !result.compatibleProtocols.has('h2')) {
        try {
          session.submitRstStream(streamId, NGHTTP2_INTERNAL_ERROR);
        } catch {}
        await drainWrite();
        return;
      } else {
        res = new Response('Internal Server Error', { status: 500 });
      }
    } catch {
      res = new Response('Internal Server Error', { status: 500 });
    }
    if (stream.cancelled) return;
    try {
      await stream.body.closed;
    } catch {
      if (!stream.cancelled) {
        try {
          session.submitRstStream(streamId, NGHTTP2_INTERNAL_ERROR);
        } catch {}
        await drainWrite();
      }
      return;
    }
    // Build and submit the response. If the stream was RST_STREAMed while the
    // handler was running, submitResponse will throw - catch and discard.
    const responseHeaders: Array<[string, string]> = [[':status', String(res.status)]];
    for (const [k, v] of res.headers.entries()) {
      if (k === 'transfer-encoding' || k === 'connection' || k === 'keep-alive') continue;
      responseHeaders.push([k, v]);
    }
    try {
      const hasTrailers = res._hasOutTrailers();
      const bodyBytes = stream.method === 'HEAD' ? null : res._extractBytes();
      const responseBody = stream.method === 'HEAD' ? null : res.body;
      const hasStreamingBody = bodyBytes === null && responseBody !== null;
      const hasBody = bodyBytes !== null || hasStreamingBody || hasTrailers;
      session.submitResponse(streamId, responseHeaders, hasBody);
      if (bodyBytes) {
        // Queue fixed bodies before the first response drain so nghttp2 can
        // emit HEADERS and DATA through one send pass.
        session.setStreamData(streamId, bodyBytes, { endStream: !hasTrailers });
        await drainWrite();
      } else {
        await drainWrite();
        if (hasStreamingBody) {
          for await (const chunk of responseBody as any as AsyncIterable<Uint8Array>) {
            if (stream.cancelled) return;
            if (chunk.byteLength === 0) continue;
            session.setStreamData(streamId, chunk);
            await drainWrite();
          }
        }
      }
      if (hasTrailers) {
        let trailersOut: Headers;
        const raw = res._getRawOutTrailers();
        if (raw instanceof Headers) {
          trailersOut = raw;
        } else if (typeof raw === 'function') {
          try {
            trailersOut = await (raw as () => Headers | Promise<Headers>)();
          } catch {
            trailersOut = new Headers();
          }
        } else {
          trailersOut = new Headers();
        }
        const trailerList: Array<[string, string]> = [];
        for (const [k, v] of trailersOut.entries()) trailerList.push([k, v]);
        if (trailerList.length > 0) {
          session.submitTrailer(streamId, trailerList);
          session.setStreamData(streamId, null);
          await drainWrite();
        } else {
          session.setStreamData(streamId, null);
          await drainWrite();
        }
      } else if (hasBody && bodyBytes === null) {
        session.setStreamData(streamId, null);
        await drainWrite();
      }
    } catch {}
  }
  function startDispatch(stream: H2ServerStream): void {
    if (stream.dispatched) return;
    if (stream.cancelled) return;
    stream.dispatched = true;
    // Absorb errors so Promise.all(inFlight) in the finally block never rejects.
    const done = dispatchStream(stream).catch(function ignoreDispatchError() {});
    inFlight.add(done);
    done.finally(function removeInflightDispatch() {
      inFlight.delete(done);
    });
  }
  const callbacks: H2StreamCallbacks = {
    onBeginHeaders(streamId: number, isTrailers: boolean): void {
      if (isTrailers) {
        const s = streams.get(streamId);
        if (s) s.inTrailers = true;
        return;
      }
      // A second non-trailer HEADERS on an already-open stream.
      if (streams.has(streamId)) {
        const s = streams.get(streamId)!;
        // If the stream is half-closed remote (body already done), this is
        // STREAM_CLOSED; otherwise it is a plain PROTOCOL_ERROR.
        s.headerError = s.bodyDone ? NGHTTP2_STREAM_CLOSED : NGHTTP2_PROTOCOL_ERROR;
        return;
      }
      // Determine initial error: REFUSED_STREAM if over concurrent limit.
      // Never call submitRstStream from onBeginHeaders - the stream is not
      // fully initialized in nghttp2 yet; doing so causes a connection error.
      // Defer the RST to onFrameRecv (END_HEADERS) when the stream is ready.
      const initialError = streams.size >= maxConcurrent ? NGHTTP2_REFUSED_STREAM : null;
      streams.set(streamId, {
        streamId,
        method: 'GET',
        path: '/',
        scheme: 'https',
        authority: 'localhost',
        headers: new Headers(),
        trailerHeaders: new Headers(),
        inTrailers: false,
        body: new HttpBodyQueue(),
        bodyDone: false,
        expectedContentLength: null,
        dispatched: false,
        cancelled: false,
        triggerDispatch: null,
        seenPseudos: new Set(),
        seenRegularHeader: false,
        headerError: initialError,
      });
    },
    onHeader(streamId: number, name: string, value: string, _flags: number): void {
      const s = streams.get(streamId);
      if (!s || s.headerError !== null) return;
      if (s.inTrailers) {
        // Pseudo-headers must not appear in trailers (RFC 7540 Section 8.1.2.1).
        if (name.startsWith(':')) {
          s.headerError = NGHTTP2_PROTOCOL_ERROR;
          return;
        }
        s.trailerHeaders.append(name, value);
        return;
      }
      if (name.startsWith(':')) {
        // Pseudo-header after a regular header field (RFC 7540 Section 8.1.2.1).
        if (s.seenRegularHeader) {
          s.headerError = NGHTTP2_PROTOCOL_ERROR;
          return;
        }
        // Only the four request pseudo-headers are valid (RFC 7540 Section 8.1.2.3).
        if (name !== ':method' && name !== ':path' && name !== ':scheme' && name !== ':authority') {
          s.headerError = NGHTTP2_PROTOCOL_ERROR;
          return;
        }
        // Duplicate pseudo-header (RFC 7540 Section 8.1.2.3).
        if (s.seenPseudos.has(name)) {
          s.headerError = NGHTTP2_PROTOCOL_ERROR;
          return;
        }
        s.seenPseudos.add(name);
        switch (name) {
          case ':method':
            s.method = value;
            break;
          case ':path':
            s.path = value;
            break;
          case ':scheme':
            s.scheme = value;
            break;
          case ':authority':
            s.authority = value;
            break;
        }
      } else {
        s.seenRegularHeader = true;
        // RFC 9113 Section 8.2.1 requires lowercase token names and forbids
        // NUL/CR/LF or surrounding whitespace in values.
        if (!_isValidRegularHeaderName(name) || !_isValidHeaderValue(value)) {
          s.headerError = NGHTTP2_PROTOCOL_ERROR;
          return;
        }
        // Connection-specific headers are forbidden (RFC 7540 Section 8.1.2.2).
        if (_FORBIDDEN_HEADERS.has(name)) {
          s.headerError = NGHTTP2_PROTOCOL_ERROR;
          return;
        }
        // TE header must only carry "trailers" (RFC 7540 Section 8.1.2.2).
        if (name === 'te' && value !== 'trailers') {
          s.headerError = NGHTTP2_PROTOCOL_ERROR;
          return;
        }
        s.headers.append(name, value);
      }
    },
    onFrameRecv(streamId: number, frameType: number, frameFlags: number): void {
      // GOAWAY is connection-level (stream 0) - no per-stream entry.
      if (frameType === NGHTTP2_FRAME_TYPE_GOAWAY) {
        receivedGoaway = true;
        return;
      }
      const s = streams.get(streamId);
      if (!s) return;
      const endStream = (frameFlags & NGHTTP2_FLAG_END_STREAM) !== 0;
      if (frameType === NGHTTP2_FRAME_TYPE_HEADERS) {
        if ((frameFlags & NGHTTP2_FLAG_END_HEADERS) === 0) return;
        if (s.inTrailers) {
          if (s.headerError !== null) {
            try {
              session.submitRstStream(streamId, s.headerError);
            } catch {}
            s.cancelled = true;
            s.body.error(
              new HttpStreamError('protocol', `H2 stream ${streamId} received invalid trailers`, {
                streamId,
                protocolCode: s.headerError,
              }),
            );
            if (s.triggerDispatch) {
              s.triggerDispatch();
              s.triggerDispatch = null;
            }
            // Leave stream in map; onStreamClose will clean up.
            return;
          }
          // Trailers with END_STREAM unblock the body wait.
          if (endStream) {
            s.bodyDone = true;
            s.body.close();
            if (s.triggerDispatch) {
              s.triggerDispatch();
              s.triggerDispatch = null;
            }
          }
          return;
        }
        // Validate required pseudo-headers once END_HEADERS is received.
        if (s.headerError === null) {
          if (s.method === 'CONNECT') {
            if (!s.authority || s.seenPseudos.has(':path') || s.seenPseudos.has(':scheme')) {
              s.headerError = NGHTTP2_PROTOCOL_ERROR;
            }
          } else {
            if (
              !s.seenPseudos.has(':method') ||
              !s.seenPseudos.has(':path') ||
              !s.seenPseudos.has(':scheme')
            ) {
              s.headerError = NGHTTP2_PROTOCOL_ERROR;
            } else if (s.path === '') {
              s.headerError = NGHTTP2_PROTOCOL_ERROR;
            }
          }
        }
        if (s.headerError !== null) {
          try {
            session.submitRstStream(streamId, s.headerError);
          } catch {}
          // Leave stream in map; onStreamClose will clean up.
          return;
        }
        const clHeader = s.headers.get('content-length');
        if (clHeader !== null) {
          try {
            s.expectedContentLength = _parseH2ContentLength(clHeader);
          } catch {
            resetMalformedBody(s, `H2 stream ${streamId} received invalid content-length`);
            return;
          }
        }
        if (endStream) {
          if (
            s.expectedContentLength !== null &&
            s.body.receivedBytes !== s.expectedContentLength
          ) {
            s.bodyDone = true;
            resetMalformedBody(s, `H2 stream ${streamId} content-length did not match DATA length`);
            return;
          }
          s.bodyDone = true;
          s.body.close();
          if (s.triggerDispatch) {
            s.triggerDispatch();
            s.triggerDispatch = null;
          } else startDispatch(s);
        } else {
          startDispatch(s);
        }
      }
      if (frameType === NGHTTP2_FRAME_TYPE_DATA && endStream) {
        if (s.expectedContentLength !== null && s.body.receivedBytes !== s.expectedContentLength) {
          s.bodyDone = true;
          resetMalformedBody(s, `H2 stream ${streamId} content-length did not match DATA length`);
          return;
        }
        s.bodyDone = true;
        s.body.close();
        if (s.triggerDispatch) {
          s.triggerDispatch();
          s.triggerDispatch = null;
        }
      }
    },
    onDataChunk(streamId: number, data: Uint8Array): void {
      const s = streams.get(streamId);
      if (!s || s.bodyDone) return;
      if (s.expectedContentLength !== null) {
        const remaining = s.expectedContentLength - s.body.receivedBytes;
        if (data.byteLength > remaining) {
          if (remaining > 0 && !s.body.push(data.subarray(0, remaining))) {
            s.cancelled = true;
            try {
              session.submitRstStream(streamId, NGHTTP2_INTERNAL_ERROR);
            } catch {}
            void drainWrite();
            return;
          }
          s.bodyDone = true;
          resetMalformedBody(s, `H2 stream ${streamId} content-length exceeded DATA length`);
          return;
        }
      }
      if (!s.body.push(data)) {
        s.cancelled = true;
        try {
          session.submitRstStream(streamId, NGHTTP2_INTERNAL_ERROR);
        } catch {}
        void drainWrite();
      }
    },
    onStreamClose(streamId: number, _errorCode: number): void {
      const s = streams.get(streamId);
      if (s) {
        if (_errorCode === 0) {
          s.bodyDone = true;
          s.body.close();
          if (s.triggerDispatch !== null) {
            s.triggerDispatch();
            s.triggerDispatch = null;
          }
          streams.delete(streamId);
          return;
        }
        // Always mark cancelled so dispatchStream returns early even if it
        // has not yet awaited triggerDispatch (bodyDone was true at dispatch
        // time - e.g. RST_STREAM arriving before the async handler runs).
        s.cancelled = true;
        s.body.error(
          new HttpStreamError(
            'cancelled',
            `H2 stream ${streamId} closed with error ${_errorCode}`,
            {
              streamId,
              protocolCode: _errorCode,
            },
          ),
        );
        if (s.triggerDispatch !== null) {
          s.bodyDone = true;
          s.triggerDispatch();
          s.triggerDispatch = null;
        }
      }
      streams.delete(streamId);
    },
  };
  function drainStreams(): void {
    // Unblock any stream still waiting for a request body that will never arrive
    // (connection dropped before END_STREAM). Without this, Promise.all(inFlight)
    // below would hang forever because dispatchStream is stuck at triggerDispatch.
    for (const [, s] of streams) {
      s.cancelled = true;
      s.body.error(
        new HttpStreamError(
          'transport',
          `H2 stream ${s.streamId} drained before request body completed`,
          { streamId: s.streamId },
        ),
      );
      if (s.triggerDispatch !== null) {
        s.bodyDone = true;
        s.triggerDispatch();
        s.triggerDispatch = null;
      }
    }
  }
  function cancelStream(streamId: number): void {
    const s = streams.get(streamId);
    if (!s) return;
    s.cancelled = true;
    s.body.error(
      new HttpStreamError('cancelled', `H2 stream ${streamId} cancelled locally`, { streamId }),
    );
    if (s.triggerDispatch !== null) {
      s.bodyDone = true;
      s.triggerDispatch();
      s.triggerDispatch = null;
    }
  }
  return {
    streams,
    inFlight,
    drainWrite,
    drainStreams,
    cancelStream,
    startDispatch,
    goawayReceived: function isGoawayReceived() {
      return receivedGoaway;
    },
    callbacks,
    setSession: function setH2Session(s: Nghttp2Session) {
      session = s;
    },
  };
}
// ---------------------------------------------------------------------------
// Shared recv loop
// ---------------------------------------------------------------------------
async function _recvLoop(
  reader: BufferedBytesReader,
  writer: BytesWriter,
  session: Nghttp2Session,
  inFlight: Set<Promise<void>>,
  drainWrite: () => Promise<void>,
  drainStreams: () => void,
  cancelStream: (streamId: number) => void,
  goawayReceived: () => boolean,
  maxConcurrent: number,
  expectPreface: boolean,
  upgradeStream1 = false,
  optionalPreface = false,
): Promise<void> {
  const validator = new H2ServerFrameValidator(
    maxConcurrent,
    expectPreface,
    upgradeStream1,
    optionalPreface,
  );
  let sendFinalGoaway = true;
  async function processValidatedBytes(bytes: Uint8Array | null): Promise<boolean> {
    if (!bytes || bytes.byteLength === 0) return true;
    const n = session.recv(bytes);
    if (n < 0) {
      try {
        await drainWrite();
      } catch {}
      return false;
    }
    try {
      await drainWrite();
    } catch {
      return false;
    }
    return !goawayReceived();
  }
  async function processRawAction(action: H2RawAction): Promise<boolean> {
    if (action.kind === 'close') {
      sendFinalGoaway = false;
      return false;
    }
    if (action.kind === 'goaway') {
      sendFinalGoaway = false;
      try {
        const bytes = _buildRawGoaway(action.errorCode ?? NGHTTP2_PROTOCOL_ERROR);
        await writer.write(bytes);
        await writer.flush();
      } catch {}
      return false;
    }
    if (action.kind === 'rst') {
      cancelStream(action.streamId ?? 0);
      try {
        const bytes = _buildRawRstStream(
          action.streamId ?? 0,
          action.errorCode ?? NGHTTP2_PROTOCOL_ERROR,
        );
        await writer.write(bytes);
        await writer.flush();
      } catch {}
      return true;
    }
    return true;
  }
  try {
    for await (const chunk of reader) {
      const validated = validator.push(chunk);
      if (!(await processValidatedBytes(validated.feed))) break;
      let keepReading = true;
      for (const action of validated.actions) {
        keepReading = await processRawAction(action);
        if (!keepReading) break;
      }
      if (!keepReading) break;
    }
  } finally {
    // Unblock streams waiting for bodies that will never arrive (connection
    // dropped before END_STREAM). Must run before Promise.all(inFlight) or
    // the await hangs indefinitely.
    drainStreams();
    await Promise.all([...inFlight]);
    if (sendFinalGoaway) {
      try {
        session.submitGoaway(0, 0);
      } catch {}
      try {
        await drainWrite();
      } catch {}
    }
    session.close();
    // BytesReader has no return() so breaking the for-await above does NOT
    // close the reader. Close it explicitly so split() pairs reach closeCount=2
    // and the socket fd is actually released. Writer close triggers fd close.
    try {
      await reader.close();
    } catch {}
    try {
      await writer.close();
    } catch {}
  }
}
// ---------------------------------------------------------------------------
// Build the synthetic stream 1 for h2c upgrade
// ---------------------------------------------------------------------------
function _buildStream1(req: Request): H2ServerStream {
  let path = '/';
  let authority = req.headers.get('host') ?? 'localhost';
  try {
    const parsed = new URL(req.url);
    path = parsed.pathname + parsed.search;
    authority = parsed.host;
  } catch {
    path = req.url;
  }
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'upgrade' || lk === 'http2-settings' || lk === 'host')
      continue;
    headers.append(k, v);
  }
  const body = new HttpBodyQueue();
  body.close();
  return {
    streamId: 1,
    method: req.method,
    path,
    scheme: 'http',
    authority,
    headers,
    trailerHeaders: new Headers(),
    inTrailers: false,
    body,
    bodyDone: true,
    expectedContentLength: null,
    dispatched: false,
    cancelled: false,
    triggerDispatch: null,
    seenPseudos: new Set(),
    seenRegularHeader: false,
    headerError: null,
  };
}
// ---------------------------------------------------------------------------
// H2ServerDriver
// ---------------------------------------------------------------------------
/**
 * HTTP/2 server driver backed by nghttp2.
 *
 * The driver validates request pseudo-headers, streams request bodies into a
 * Fino HTTP handler, and submits response headers, body chunks, and trailers.
 * It serializes all nghttp2 writes to avoid concurrent access to the session.
 *
 * ```ts no_run
 * import { H2ServerDriver } from 'internal:net/http/h2/server';
 * const driver = new H2ServerDriver();
 * await driver.run(reader, writer, handler, { maxConcurrent: 100 });
 * ```
 *
 * @internal
 */
export class H2ServerDriver implements ServerDriver {
  /**
   * Run an HTTP/2 server session on a connected reader/writer pair.
   *
   * The method submits server settings, receives frames until EOF, GOAWAY, or
   * protocol shutdown, waits for in-flight handlers to settle, then closes the
   * session and both stream halves. Handler failures produce `500` responses.
   *
   * ```ts no_run
   * import { H2ServerDriver } from 'internal:net/http/h2/server';
   * import { Response } from 'internal:net/http/wire';
   * await new H2ServerDriver().run(reader, writer, () => new Response('ok'), { maxConcurrent: 100 });
   * ```
   */
  async run(
    reader: BufferedBytesReader,
    writer: BytesWriter,
    handler: ServerHandler,
    opts: ServerDriverOptions,
  ): Promise<void> {
    const ctx = _makeCtx(writer, handler, opts.maxConcurrent);
    const session = Nghttp2Session.createServer(ctx.callbacks);
    ctx.setSession(session);
    session.submitSettings([
      [NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, opts.maxConcurrent],
      [NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE, 65536],
    ]);
    await ctx.drainWrite();
    await _recvLoop(
      reader,
      writer,
      session,
      ctx.inFlight,
      ctx.drainWrite,
      ctx.drainStreams,
      ctx.cancelStream,
      ctx.goawayReceived,
      opts.maxConcurrent,
      true,
    );
  }
  /**
   * Run the h2 server after a successful h2c Upgrade handshake.
   *
   * Called by the h1 driver after it has written the 101 Switching Protocols
   * response and handed control of reader/writer to us. `initialReq` is the
   * HTTP/1.1 request that triggered the upgrade; it becomes h2 stream 1.
   * `settingsPayload` is the base64url-decoded `HTTP2-Settings` header value.
   *
   * The method must be called only after the h1 driver has sent `101 Switching
   * Protocols`. The upgrade request body is not supported by h2c and stream 1
   * starts as body-complete.
   *
   * ```ts no_run
   * import { H2ServerDriver } from 'internal:net/http/h2/server';
   * import { Request, Response } from 'internal:net/http/wire';
   * await new H2ServerDriver().runFromUpgrade(reader, writer, () => new Response('ok'), { maxConcurrent: 100 }, new Request('http://localhost/'), new Uint8Array(), false);
   * ```
   */
  async runFromUpgrade(
    reader: BufferedBytesReader,
    writer: BytesWriter,
    handler: ServerHandler,
    opts: ServerDriverOptions,
    initialReq: Request,
    settingsPayload: Uint8Array,
    headRequest: boolean,
  ): Promise<void> {
    const ctx = _makeCtx(writer, handler, opts.maxConcurrent);
    const session = Nghttp2Session.createServer(ctx.callbacks);
    ctx.setSession(session);
    session.upgradeFromH1(settingsPayload, headRequest);
    session.submitSettings([
      [NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, opts.maxConcurrent],
      [NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE, 65536],
    ]);
    await ctx.drainWrite();
    const stream1 = _buildStream1(initialReq);
    ctx.streams.set(1, stream1);
    ctx.startDispatch(stream1);
    await _recvLoop(
      reader,
      writer,
      session,
      ctx.inFlight,
      ctx.drainWrite,
      ctx.drainStreams,
      ctx.cancelStream,
      ctx.goawayReceived,
      opts.maxConcurrent,
      false,
      true,
      true,
    );
  }
}
