/**
* internal:net/http/h3/webtransport - WebTransport over HTTP/3 framing helpers.
*
* Learn more:
* - WebTransport: https://w3c.github.io/webtransport/
* - WebTransport over HTTP/3: https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/
* - HTTP Datagrams: https://www.rfc-editor.org/rfc/rfc9297
*
* This module contains protocol constants and byte-level helpers shared by the
* HTTP/3 client and server WebTransport implementation. The helpers are pure:
* they do not depend on nghttp3 or QUIC connection state, which keeps SETTINGS
* negotiation, HTTP Datagram dispatch, and WebTransport stream-prefix parsing
* testable before they are wired into the native session driver.
*
* Three concerns are covered. First, HTTP/3 SETTINGS: draft-15 WebTransport
* requires three enablement bits, and the module can build them, test whether a
* peer advertised them, and encode or decode SETTINGS frames and control-stream
* prefixes. Second, RFC 9297 HTTP Datagrams: the quarter-stream-id prefix that
* associates a datagram with its CONNECT session is added on encode and
* recovered on decode. Third, WebTransport data streams: the varint stream-type
* tag plus session id that prefixes every WebTransport bidirectional or
* unidirectional stream, with an incremental variant for readers that may not
* yet hold the full prefix. Everything is built on a shared QUIC
* variable-length integer codec (RFC 9000 section 16).
*
* Numeric quantities cross the JS number/bigint boundary here: stream ids and
* varint values are `bigint` because a QUIC varint spans up to 62 bits, while
* SETTINGS identifiers and small values stay `number` for ergonomics. Encoders
* accept either and normalize internally; decoders return `bigint` for
* varint-width values and `number` only where the value provably fits in a safe
* integer.
*
* ```ts no_run
* import {
*   webTransportSettings,
*   encodeH3SettingsFrame,
*   encodeWebTransportStreamPrefix,
*   encodeHttpDatagram,
* } from 'internal:net/http/h3/webtransport';
*
* // Advertise WebTransport in the HTTP/3 control stream.
* const frame = encodeH3SettingsFrame(webTransportSettings());
*
* // Open a bidirectional WebTransport stream bound to CONNECT session 12.
* const prefix = encodeWebTransportStreamPrefix('bidirectional', 12n);
*
* // Send a datagram on the same session.
* const datagram = encodeHttpDatagram(12n, new Uint8Array([0xaa, 0xbb]));
* ```
*
* @internal
*/
/**
* Directionality of a WebTransport data stream.
*
* A `'bidirectional'` stream carries a request-and-response style channel that
* either endpoint may write to, and is prefixed with
* `WEBTRANSPORT_BIDI_STREAM_TYPE`. A `'unidirectional'` stream flows in a
* single direction from its opener and is prefixed with
* `WEBTRANSPORT_UNI_STREAM_TYPE`. The kind is what
* `encodeWebTransportStreamPrefix` writes and what
* `decodeWebTransportStreamPrefix` reports.
*/
export type WebTransportStreamKind = 'bidirectional' | 'unidirectional';
/** HTTP/3 SETTINGS identifier for WebTransport enablement. */
export const SETTINGS_WT_ENABLED = 746385408;
/** HTTP/3 SETTINGS identifier for RFC 9220 extended CONNECT. */
export const SETTINGS_ENABLE_CONNECT_PROTOCOL = 8;
/** HTTP/3 SETTINGS identifier for HTTP Datagrams. */
export const SETTINGS_H3_DATAGRAM = 51;
/** WebTransport bidirectional stream type. */
export const WEBTRANSPORT_BIDI_STREAM_TYPE = 65;
/** WebTransport unidirectional stream type. */
export const WEBTRANSPORT_UNI_STREAM_TYPE = 84;
/** HTTP/3 control stream type. */
export const H3_CONTROL_STREAM_TYPE = 0;
/** HTTP/3 SETTINGS frame type. */
export const H3_SETTINGS_FRAME_TYPE = 4;
const MAX_QUIC_VARINT = (1n << 62n) - 1n;
function assertQuicVarint(value: bigint): void {
  if (value < 0n || value > MAX_QUIC_VARINT) {
    throw new RangeError('QUIC varint value must be between 0 and 2^62 - 1');
  }
}
function toBigInt(value: bigint | number): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new RangeError('QUIC varint number must be a safe integer');
  return BigInt(value);
}
/**
* Return the HTTP/3 SETTINGS entries a draft-15 WebTransport endpoint must send.
*
* The map pairs each of the three enablement identifiers
* (`SETTINGS_WT_ENABLED`, `SETTINGS_ENABLE_CONNECT_PROTOCOL`, and
* `SETTINGS_H3_DATAGRAM`) with the value `1`. Feed the result to
* `encodeH3SettingsFrame` to produce the wire bytes for the control
* stream, or merge it into a peer's settings before re-encoding.
*
* A fresh `Map` is returned on every call, so callers may mutate it freely.
*
* ```ts no_run
* import {
*   webTransportSettings,
*   encodeH3SettingsFrame,
* } from 'internal:net/http/h3/webtransport';
*
* const settings = webTransportSettings(); // 3 enablement bits, all set to 1
* const controlFrame = encodeH3SettingsFrame(settings);
* ```
*/
export function webTransportSettings(): Map<number, number> {
  return new Map([
    [SETTINGS_WT_ENABLED, 1],
    [SETTINGS_ENABLE_CONNECT_PROTOCOL, 1],
    [SETTINGS_H3_DATAGRAM, 1]
  ]);
}
/**
* Report whether a peer's HTTP/3 SETTINGS enable WebTransport.
*
* Returns `true` only when all three required identifiers are present and each
* is exactly `1`. A partial advertisement — for example WebTransport enabled
* but datagrams missing — returns `false`, because draft-15 sessions require the
* full set. Use this on the settings decoded from a peer's control stream
* (via `readWebTransportSettings` or `decodeH3SettingsPayload`)
* before attempting a WebTransport CONNECT.
*
* ```ts no_run
* import {
*   webTransportSettingsEnabled,
*   readWebTransportSettings,
* } from 'internal:net/http/h3/webtransport';
*
* const peer = readWebTransportSettings(peerControlStreamBytes);
* if (!webTransportSettingsEnabled(peer)) {
*   throw new Error('peer does not support WebTransport');
* }
* ```
*/
export function webTransportSettingsEnabled(settings: ReadonlyMap<number, number>): boolean {
  return settings.get(SETTINGS_WT_ENABLED) === 1 && settings.get(SETTINGS_ENABLE_CONNECT_PROTOCOL) === 1 && settings.get(SETTINGS_H3_DATAGRAM) === 1;
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
/**
* Encode a value as a QUIC variable-length integer (RFC 9000 section 16).
*
* The two most-significant bits of the first byte select the encoded length —
* 1, 2, 4, or 8 bytes — and the codec always picks the shortest form that holds
* the value. Accepts a `bigint` or a `number`; a `number` must be a safe
* integer.
*
* Throws a `RangeError` if the value is negative or exceeds the QUIC varint
* ceiling of 2^62 - 1, or if a `number` argument is not a safe integer.
*
* ```ts no_run
* import { encodeQuicVarint } from 'internal:net/http/h3/webtransport';
*
* [...encodeQuicVarint(63n)];    // [63]            — 1-byte form
* [...encodeQuicVarint(64n)];    // [64, 64]        — 2-byte form
* [...encodeQuicVarint(16384n)]; // [128, 0, 64, 0] — 4-byte form
* ```
*/
export function encodeQuicVarint(input: bigint | number): Uint8Array {
  const value = toBigInt(input);
  assertQuicVarint(value);
  if (value < 64n) return new Uint8Array([Number(value)]);
  if (value < 16384n) {
    const out = new Uint8Array(2);
    out[0] = 64 | Number(value >> 8n);
    out[1] = Number(value & 255n);
    return out;
  }
  if (value < 1073741824n) {
    const out = new Uint8Array(4);
    out[0] = 128 | Number(value >> 24n);
    out[1] = Number(value >> 16n & 255n);
    out[2] = Number(value >> 8n & 255n);
    out[3] = Number(value & 255n);
    return out;
  }
  const out = new Uint8Array(8);
  out[0] = 192 | Number(value >> 56n);
  out[1] = Number(value >> 48n & 255n);
  out[2] = Number(value >> 40n & 255n);
  out[3] = Number(value >> 32n & 255n);
  out[4] = Number(value >> 24n & 255n);
  out[5] = Number(value >> 16n & 255n);
  out[6] = Number(value >> 8n & 255n);
  out[7] = Number(value & 255n);
  return out;
}
/**
* Decode a QUIC variable-length integer starting at `offset`.
*
* The tag bits of the byte at `offset` determine how many bytes are consumed,
* and the decoded value is always returned as a `bigint` since it may span up to
* 62 bits. `nextOffset` is the index just past the varint, ready to be passed
* back in for the next field, which makes chained decoding of a frame
* straightforward.
*
* Throws a `RangeError` whose message contains `out of bounds` if `offset` is
* not a non-negative integer within the buffer, and one containing `truncated`
* if the buffer ends before the encoded length is complete. Callers that read
* from a partially-filled stream can distinguish these cases by message, as
* `inspectWebTransportStreamPrefix` does.
*
* ```ts no_run
* import { decodeQuicVarint } from 'internal:net/http/h3/webtransport';
*
* const buf = new Uint8Array([64, 64, 5]);
* const first = decodeQuicVarint(buf);        // { value: 64n, nextOffset: 2 }
* const second = decodeQuicVarint(buf, first.nextOffset); // { value: 5n, nextOffset: 3 }
* ```
*/
export function decodeQuicVarint(bytes: Uint8Array, offset = 0): {
  value: bigint;
  nextOffset: number;
} {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.byteLength) {
    throw new RangeError('QUIC varint offset is out of bounds');
  }
  const first = bytes[offset]!;
  const tag = first >> 6;
  const length = 1 << tag;
  if (offset + length > bytes.byteLength) throw new RangeError('QUIC varint is truncated');
  let value = BigInt(first & 63);
  for (let i = 1; i < length; i++) value = value << 8n | BigInt(bytes[offset + i]!);
  return {
    value,
    nextOffset: offset + length
  };
}
/**
* Encode a SETTINGS frame payload as a flat sequence of identifier/value varints.
*
* Each entry contributes two QUIC varints — the identifier followed by its
* value — concatenated in the map's iteration order. This is the frame body
* only, without the leading type and length; use `encodeH3SettingsFrame`
* when you need a complete framed message. Both identifiers and values are
* encoded as varints, so values wider than a safe integer may be passed as
* `bigint`.
*
* ```ts no_run
* import {
*   encodeH3SettingsPayload,
*   SETTINGS_H3_DATAGRAM,
* } from 'internal:net/http/h3/webtransport';
*
* const payload = encodeH3SettingsPayload(new Map([[SETTINGS_H3_DATAGRAM, 1]]));
* ```
*/
export function encodeH3SettingsPayload(settings: ReadonlyMap<number, number | bigint>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [id, value] of settings) {
    parts.push(encodeQuicVarint(id), encodeQuicVarint(value));
  }
  return concatBytes(parts);
}
/**
* Decode a SETTINGS frame payload into a map of identifier/value pairs.
*
* Reads identifier/value varint pairs until the payload is exhausted. Each
* identifier becomes a `number` map key; each value is narrowed to a `number`
* when it fits in a safe integer and left as a `bigint` otherwise, so callers
* never silently lose precision on large settings. The inverse of
* `encodeH3SettingsPayload`.
*
* Throws a `RangeError` if the payload ends mid-varint (an odd or truncated
* trailing field), propagated from `decodeQuicVarint`.
*
* ```ts no_run
* import {
*   decodeH3SettingsPayload,
*   SETTINGS_WT_ENABLED,
* } from 'internal:net/http/h3/webtransport';
*
* const settings = decodeH3SettingsPayload(payloadBytes);
* const enabled = settings.get(SETTINGS_WT_ENABLED) === 1;
* ```
*/
export function decodeH3SettingsPayload(payload: Uint8Array): Map<number, number | bigint> {
  const settings = new Map<number, number | bigint>();
  let offset = 0;
  while (offset < payload.byteLength) {
    const id = decodeQuicVarint(payload, offset);
    const value = decodeQuicVarint(payload, id.nextOffset);
    settings.set(Number(id.value), value.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value.value) : value.value);
    offset = value.nextOffset;
  }
  return settings;
}
/**
* Encode a complete HTTP/3 SETTINGS frame, including its type and length prefix.
*
* Produces `type(4) || length || payload`, where the type is
* `H3_SETTINGS_FRAME_TYPE`, the length is the byte count of the encoded
* payload, and the payload is `encodeH3SettingsPayload` of `settings`.
* The result is a self-delimiting frame suitable for writing directly onto the
* HTTP/3 control stream after the stream-type byte.
*
* ```ts no_run
* import {
*   encodeH3SettingsFrame,
*   webTransportSettings,
* } from 'internal:net/http/h3/webtransport';
*
* const frame = encodeH3SettingsFrame(webTransportSettings());
* ```
*/
export function encodeH3SettingsFrame(settings: ReadonlyMap<number, number | bigint>): Uint8Array {
  const payload = encodeH3SettingsPayload(settings);
  return concatBytes([
    encodeQuicVarint(H3_SETTINGS_FRAME_TYPE),
    encodeQuicVarint(payload.byteLength),
    payload
  ]);
}
/**
* Decode a complete HTTP/3 SETTINGS frame into its identifier/value map.
*
* Expects the frame to begin at its type varint. It validates that the type is
* `H3_SETTINGS_FRAME_TYPE`, reads the declared length, and decodes exactly
* that many payload bytes — trailing bytes beyond the length are ignored, so a
* frame followed by more control-stream data is handled correctly.
*
* Throws a `RangeError` reading `HTTP/3 frame is not SETTINGS` if the leading
* type is anything else, and one reading `HTTP/3 SETTINGS frame is truncated` if
* the buffer is shorter than the declared length.
*
* ```ts no_run
* import { decodeH3SettingsFrame } from 'internal:net/http/h3/webtransport';
*
* const settings = decodeH3SettingsFrame(frameBytes);
* ```
*/
export function decodeH3SettingsFrame(frame: Uint8Array): Map<number, number | bigint> {
  const type = decodeQuicVarint(frame);
  if (type.value !== BigInt(H3_SETTINGS_FRAME_TYPE)) throw new RangeError('HTTP/3 frame is not SETTINGS');
  const length = decodeQuicVarint(frame, type.nextOffset);
  const start = length.nextOffset;
  const end = start + Number(length.value);
  if (end > frame.byteLength) throw new RangeError('HTTP/3 SETTINGS frame is truncated');
  return decodeH3SettingsPayload(frame.slice(start, end));
}
function locateSettingsFrameInControlStream(bytes: Uint8Array): {
  frameStart: number;
  payloadStart: number;
  payloadEnd: number;
} | null {
  let streamType;
  try {
    streamType = decodeQuicVarint(bytes);
  } catch {
    return null;
  }
  if (streamType.value !== BigInt(H3_CONTROL_STREAM_TYPE)) return null;
  let frameType;
  try {
    frameType = decodeQuicVarint(bytes, streamType.nextOffset);
  } catch {
    return null;
  }
  if (frameType.value !== BigInt(H3_SETTINGS_FRAME_TYPE)) return null;
  let length;
  try {
    length = decodeQuicVarint(bytes, frameType.nextOffset);
  } catch {
    return null;
  }
  const payloadStart = length.nextOffset;
  const payloadEnd = payloadStart + Number(length.value);
  if (payloadEnd > bytes.byteLength) return null;
  return {
    frameStart: streamType.nextOffset,
    payloadStart,
    payloadEnd
  };
}
/**
* Extract the SETTINGS map from the opening bytes of an HTTP/3 control stream.
*
* Unlike `decodeH3SettingsFrame`, the input here starts with the
* control-stream type byte (`H3_CONTROL_STREAM_TYPE`) that precedes the
* first frame, as it appears on the wire. This function skips that byte, locates
* the SETTINGS frame, and returns its decoded contents.
*
* This is a tolerant reader: if the bytes are not a control stream, do not begin
* with a SETTINGS frame, or are truncated before the payload completes, it
* returns an empty `Map` rather than throwing — the caller simply learns the
* peer has not advertised any settings yet. Pair with
* `webTransportSettingsEnabled` to check for WebTransport support.
*
* ```ts no_run
* import {
*   readWebTransportSettings,
*   webTransportSettingsEnabled,
* } from 'internal:net/http/h3/webtransport';
*
* const settings = readWebTransportSettings(controlStreamBytes);
* const ok = webTransportSettingsEnabled(settings);
* ```
*/
export function readWebTransportSettings(controlStreamBytes: Uint8Array): Map<number, number | bigint> {
  const located = locateSettingsFrameInControlStream(controlStreamBytes);
  if (located === null) return new Map();
  return decodeH3SettingsPayload(controlStreamBytes.slice(located.payloadStart, located.payloadEnd));
}
/**
* Rewrite an HTTP/3 control-stream prefix to advertise WebTransport.
*
* Locates the SETTINGS frame in `controlStreamBytes`, merges the draft-15
* WebTransport enablement bits (`webTransportSettings`) into the existing
* settings — overwriting any conflicting entries — re-encodes the frame, and
* splices it back in place of the original. Bytes before the frame (the
* stream-type byte) and any bytes after the frame are preserved, so this can be
* applied to a control-stream prefix produced by another HTTP/3 stack to make it
* WebTransport-capable.
*
* If no SETTINGS frame can be located — the input is not a control stream, or is
* truncated — the input is returned unchanged, matching the tolerant behavior of
* `readWebTransportSettings`.
*
* ```ts no_run
* import { injectWebTransportSettings } from 'internal:net/http/h3/webtransport';
*
* // Take a stock HTTP/3 control-stream prefix and make it advertise WebTransport.
* const rewritten = injectWebTransportSettings(originalControlStreamBytes);
* ```
*/
export function injectWebTransportSettings(controlStreamBytes: Uint8Array): Uint8Array {
  const located = locateSettingsFrameInControlStream(controlStreamBytes);
  if (located === null) return controlStreamBytes;
  const settings = decodeH3SettingsPayload(controlStreamBytes.slice(located.payloadStart, located.payloadEnd));
  for (const [id, value] of webTransportSettings()) settings.set(id, value);
  const frame = encodeH3SettingsFrame(settings);
  return concatBytes([
    controlStreamBytes.slice(0, located.frameStart),
    frame,
    controlStreamBytes.slice(located.payloadEnd)
  ]);
}
/**
* Frame an RFC 9297 HTTP Datagram for a WebTransport session.
*
* The datagram is prefixed with the session's *quarter stream id* — the CONNECT
* stream id divided by four, encoded as a QUIC varint — which is how RFC 9297
* associates a datagram with its stream while keeping the prefix compact. The
* payload is appended verbatim. Decode with `decodeHttpDatagram`.
*
* `sessionStreamId` must be a client-initiated bidirectional QUIC stream id,
* i.e. non-negative with its low two bits clear (`id & 3 === 0`); WebTransport
* sessions always ride on such a stream. Throws a `RangeError` mentioning
* `client-initiated bidirectional` otherwise.
*
* ```ts no_run
* import { encodeHttpDatagram } from 'internal:net/http/h3/webtransport';
*
* const datagram = encodeHttpDatagram(8n, new Uint8Array([0xaa, 0xbb]));
* [...datagram]; // [2, 170, 187] — quarter-stream-id 2 prefix, then payload
* ```
*/
export function encodeHttpDatagram(sessionStreamId: bigint | number, payload: Uint8Array): Uint8Array {
  const streamId = toBigInt(sessionStreamId);
  if (streamId < 0n || (streamId & 3n) !== 0n) {
    throw new RangeError('HTTP Datagram session stream id must be a client-initiated bidirectional stream');
  }
  const prefix = encodeQuicVarint(streamId >> 2n);
  const out = new Uint8Array(prefix.byteLength + payload.byteLength);
  out.set(prefix, 0);
  out.set(payload, prefix.byteLength);
  return out;
}
/**
* Parse an RFC 9297 HTTP Datagram back into its session id and payload.
*
* Reads the leading quarter-stream-id varint and reconstructs the full CONNECT
* stream id by multiplying by four (`quarterStreamId << 2`). Both the recovered
* full `streamId` and the raw `quarterStreamId` are returned — the former for
* routing to a session, the latter if the caller wants the on-wire value — along
* with the remaining bytes as `payload`. Inverse of `encodeHttpDatagram`.
*
* Throws a `RangeError` if `bytes` is empty or the prefix varint is truncated,
* propagated from `decodeQuicVarint`.
*
* ```ts no_run
* import { decodeHttpDatagram } from 'internal:net/http/h3/webtransport';
*
* const { streamId, payload } = decodeHttpDatagram(new Uint8Array([2, 170, 187]));
* streamId;        // 8n
* [...payload];    // [170, 187]
* ```
*/
export function decodeHttpDatagram(bytes: Uint8Array): {
  streamId: bigint;
  quarterStreamId: bigint;
  payload: Uint8Array;
} {
  const { value: quarterStreamId, nextOffset } = decodeQuicVarint(bytes);
  return {
    streamId: quarterStreamId << 2n,
    quarterStreamId,
    payload: bytes.slice(nextOffset)
  };
}
/**
* Build the prefix that opens a WebTransport data stream.
*
* Every WebTransport stream begins with a varint stream-type tag —
* `WEBTRANSPORT_BIDI_STREAM_TYPE` for `'bidirectional'` or
* `WEBTRANSPORT_UNI_STREAM_TYPE` for `'unidirectional'` — followed by the
* owning session's quarter stream id (the CONNECT stream id divided by four),
* both encoded as QUIC varints. Write this prefix before the first byte of
* application data; decode it on the peer with
* `decodeWebTransportStreamPrefix`.
*
* `sessionStreamId` must be a client-initiated bidirectional QUIC stream id
* (non-negative, `id & 3 === 0`). Throws a `RangeError` mentioning
* `client-initiated bidirectional` otherwise.
*
* ```ts no_run
* import { encodeWebTransportStreamPrefix } from 'internal:net/http/h3/webtransport';
*
* const prefix = encodeWebTransportStreamPrefix('bidirectional', 12n);
* [...prefix]; // [64, 65, 3] — bidi type (varint 65), quarter-stream-id 3
* ```
*/
export function encodeWebTransportStreamPrefix(kind: WebTransportStreamKind, sessionStreamId: bigint | number): Uint8Array {
  const streamId = toBigInt(sessionStreamId);
  if (streamId < 0n || (streamId & 3n) !== 0n) {
    throw new RangeError('WebTransport session stream id must be a client-initiated bidirectional stream');
  }
  const type = kind === 'bidirectional' ? WEBTRANSPORT_BIDI_STREAM_TYPE : WEBTRANSPORT_UNI_STREAM_TYPE;
  const typeBytes = encodeQuicVarint(type);
  const sessionBytes = encodeQuicVarint(streamId >> 2n);
  const out = new Uint8Array(typeBytes.byteLength + sessionBytes.byteLength);
  out.set(typeBytes, 0);
  out.set(sessionBytes, typeBytes.byteLength);
  return out;
}
/**
* Read a WebTransport data-stream prefix, assuming the full prefix is present.
*
* Decodes the stream-type tag into a `WebTransportStreamKind`, then reads
* the quarter stream id and reconstructs the full session stream id
* (`quarterStreamId << 2`). `headerLength` is the number of bytes the prefix
* occupied, so the caller can skip past it to the stream body. Inverse of
* `encodeWebTransportStreamPrefix`.
*
* Throws a `RangeError` for an unrecognized stream type (message includes the
* offending type in hex), or if the buffer is too short to hold the full prefix.
* When the input may be a partial read, prefer
* `inspectWebTransportStreamPrefix`, which reports incompleteness instead
* of throwing.
*
* ```ts no_run
* import { decodeWebTransportStreamPrefix } from 'internal:net/http/h3/webtransport';
*
* const { kind, sessionId, headerLength } =
*   decodeWebTransportStreamPrefix(new Uint8Array([64, 65, 3]));
* kind;         // 'bidirectional'
* sessionId;    // 12n
* headerLength; // 3
* ```
*/
export function decodeWebTransportStreamPrefix(bytes: Uint8Array): {
  kind: WebTransportStreamKind;
  sessionId: bigint;
  headerLength: number;
} {
  const type = decodeQuicVarint(bytes);
  let kind: WebTransportStreamKind;
  if (type.value === BigInt(WEBTRANSPORT_BIDI_STREAM_TYPE)) {
    kind = 'bidirectional';
  } else if (type.value === BigInt(WEBTRANSPORT_UNI_STREAM_TYPE)) {
    kind = 'unidirectional';
  } else {
    throw new RangeError(`unknown WebTransport stream type 0x${type.value.toString(16)}`);
  }
  const session = decodeQuicVarint(bytes, type.nextOffset);
  return {
    kind,
    sessionId: session.value << 2n,
    headerLength: session.nextOffset
  };
}
/**
* Classify a stream's opening bytes without requiring the full prefix.
*
* This is the non-throwing counterpart to
* `decodeWebTransportStreamPrefix`, meant for the moment an HTTP/3 stream
* first delivers bytes and the reader must decide what it is looking at before
* it necessarily has the whole header. It returns a tagged result:
*
* - `state: 'complete'` — a full WebTransport prefix was parsed; the object
*   also carries `kind`, `sessionId`, and `headerLength` exactly as
*   `decodeWebTransportStreamPrefix` would return them.
* - `state: 'incomplete'` — the bytes so far are a valid but truncated prefix;
*   the caller should buffer more and try again.
* - `state: 'not-webtransport'` — the stream-type tag is neither WebTransport
*   type, so this is some other HTTP/3 stream.
*
* It never throws: truncation is reported as `'incomplete'` and any other decode
* failure as `'not-webtransport'`.
*
* ```ts no_run
* import { inspectWebTransportStreamPrefix } from 'internal:net/http/h3/webtransport';
*
* const result = inspectWebTransportStreamPrefix(firstChunk);
* switch (result.state) {
*   case 'complete':
*     openStream(result.kind, result.sessionId, firstChunk.subarray(result.headerLength));
*     break;
*   case 'incomplete':
*     break; // wait for more bytes, then re-inspect
*   case 'not-webtransport':
*     handleOtherStream(firstChunk);
*     break;
* }
* ```
*/
export function inspectWebTransportStreamPrefix(bytes: Uint8Array): {
  state: 'complete';
  kind: WebTransportStreamKind;
  sessionId: bigint;
  headerLength: number;
} | {
  state: 'incomplete';
} | {
  state: 'not-webtransport';
} {
  let type;
  try {
    type = decodeQuicVarint(bytes);
  } catch (error) {
    if (error instanceof RangeError && /truncated|out of bounds/.test(error.message)) {
      return { state: 'incomplete' };
    }
    return { state: 'not-webtransport' };
  }
  let kind: WebTransportStreamKind;
  if (type.value === BigInt(WEBTRANSPORT_BIDI_STREAM_TYPE)) {
    kind = 'bidirectional';
  } else if (type.value === BigInt(WEBTRANSPORT_UNI_STREAM_TYPE)) {
    kind = 'unidirectional';
  } else {
    return { state: 'not-webtransport' };
  }
  try {
    const session = decodeQuicVarint(bytes, type.nextOffset);
    return {
      state: 'complete',
      kind,
      sessionId: session.value << 2n,
      headerLength: session.nextOffset
    };
  } catch (error) {
    if (error instanceof RangeError && /truncated|out of bounds/.test(error.message)) {
      return { state: 'incomplete' };
    }
    return { state: 'not-webtransport' };
  }
}
