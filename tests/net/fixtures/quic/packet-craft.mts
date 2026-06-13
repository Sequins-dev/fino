/**
 * QUIC packet construction helpers for raw conformance probes.
 *
 * The helpers build only packets whose headers are not encrypted by QUIC,
 * namely Version Negotiation packets and deliberately malformed Initial
 * probes. They are shared by simulator and loopback tests so byte layout stays
 * consistent across RFC 9000/RFC 9368 coverage.
 *
 * @internal
 */

export const QUIC_V1 = 0x00000001;
export const QUIC_V2 = 0x6b3343cf;

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(offset, value >>> 0, false);
}

/**
 * Write one QUIC variable-length integer and return the number of bytes used.
 */
export function writeQuicVarint(buf: Uint8Array, offset: number, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError('QUIC varint value must be a non-negative integer');
  if (value < 0x40) {
    buf[offset] = value;
    return 1;
  }
  if (value < 0x4000) {
    buf[offset] = 0x40 | (value >>> 8);
    buf[offset + 1] = value & 0xff;
    return 2;
  }
  throw new RangeError('test helper only supports QUIC varints up to 16383');
}

/**
 * Build a QUIC Version Negotiation packet.
 */
export function makeVersionNegotiationPacket(input: {
  destinationConnectionId: Uint8Array;
  sourceConnectionId: Uint8Array;
  versions: readonly number[];
  firstByte?: number;
}): Uint8Array {
  const dcid = input.destinationConnectionId;
  const scid = input.sourceConnectionId;
  if (dcid.byteLength > 20 || scid.byteLength > 20) throw new RangeError('QUIC connection IDs must be at most 20 bytes');
  const out = new Uint8Array(1 + 4 + 1 + dcid.byteLength + 1 + scid.byteLength + input.versions.length * 4);
  out[0] = input.firstByte ?? 0x80;
  writeU32BE(out, 1, 0);
  out[5] = dcid.byteLength;
  out.set(dcid, 6);
  const scidLengthOffset = 6 + dcid.byteLength;
  out[scidLengthOffset] = scid.byteLength;
  out.set(scid, scidLengthOffset + 1);
  let offset = scidLengthOffset + 1 + scid.byteLength;
  for (const version of input.versions) {
    writeU32BE(out, offset, version);
    offset += 4;
  }
  return out;
}

/**
 * Build a minimal Initial-shaped datagram for listener probes.
 */
export function makeInitialProbe(version = QUIC_V1, seed = 0, token: Uint8Array = new Uint8Array()): Uint8Array {
  const dcid = new Uint8Array(8);
  const scid = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    dcid[i] = (0x40 + seed + i) & 0xff;
    scid[i] = (0x80 + seed + i) & 0xff;
  }

  const packet = new Uint8Array(1200);
  packet[0] = 0xc0;
  writeU32BE(packet, 1, version);
  packet[5] = dcid.byteLength;
  packet.set(dcid, 6);
  packet[14] = scid.byteLength;
  packet.set(scid, 15);
  let offset = 23;
  offset += writeQuicVarint(packet, offset, token.byteLength);
  packet.set(token, offset);
  offset += token.byteLength;
  writeQuicVarint(packet, offset, 0);
  return packet;
}
