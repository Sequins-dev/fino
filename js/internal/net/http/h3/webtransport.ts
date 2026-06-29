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
* @internal
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
* Return the WebTransport SETTINGS entries required for draft-15 sessions.
*/
export function webTransportSettings(): Map<number, number> {
  return new Map([
    [SETTINGS_WT_ENABLED, 1],
    [SETTINGS_ENABLE_CONNECT_PROTOCOL, 1],
    [SETTINGS_H3_DATAGRAM, 1]
  ]);
}
/**
* Test whether peer HTTP/3 SETTINGS advertise all required WebTransport bits.
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
* Encode a QUIC variable-length integer.
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
* Decode a QUIC variable-length integer from a byte buffer.
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
* Encode an HTTP/3 SETTINGS frame payload from a map of identifier/value pairs.
*/
export function encodeH3SettingsPayload(settings: ReadonlyMap<number, number | bigint>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [id, value] of settings) {
    parts.push(encodeQuicVarint(id), encodeQuicVarint(value));
  }
  return concatBytes(parts);
}
/**
* Decode an HTTP/3 SETTINGS frame payload into identifier/value pairs.
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
* Encode one complete HTTP/3 SETTINGS frame.
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
* Decode one complete HTTP/3 SETTINGS frame.
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
* Read a SETTINGS frame from an HTTP/3 control stream prefix.
*/
export function readWebTransportSettings(controlStreamBytes: Uint8Array): Map<number, number | bigint> {
  const located = locateSettingsFrameInControlStream(controlStreamBytes);
  if (located === null) return new Map();
  return decodeH3SettingsPayload(controlStreamBytes.slice(located.payloadStart, located.payloadEnd));
}
/**
* Inject draft-15 WebTransport SETTINGS into an HTTP/3 control stream prefix.
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
* Encode an RFC 9297 HTTP Datagram payload for an HTTP/3 request stream.
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
* Decode an RFC 9297 HTTP Datagram payload.
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
* Encode the stream header for a WebTransport data stream.
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
* Decode the stream header for a WebTransport data stream.
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
* Decode a WebTransport stream header when the QUIC read may not contain the
* full prefix yet.
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
