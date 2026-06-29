/**
* QUIC packet parsing helpers for wire-level conformance tests.
*
* These utilities intentionally parse only the invariant header fields needed
* by raw-packet tests: form, version, destination/source connection IDs, and
* the offset where long-header packet-type-specific fields begin. They do not
* decrypt QUIC packets or validate protected fields.
*
* @internal
*/
export type ParsedQuicHeader = {
  form: 'long' | 'short';
  firstByte: number;
  version: number | null;
  destinationConnectionId: Uint8Array;
  sourceConnectionId: Uint8Array;
  payloadOffset: number;
};
function readU32BE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, false);
}
function ensureAvailable(data: Uint8Array, offset: number, length: number, field: string): void {
  if (offset + length > data.byteLength) throw new RangeError(`truncated QUIC packet while reading ${field}`);
}
/**
* Parse the QUIC invariant header fields from one datagram payload.
*/
export function parseQuicHeader(data: Uint8Array): ParsedQuicHeader {
  ensureAvailable(data, 0, 1, 'first byte');
  const firstByte = data[0]!;
  if ((firstByte & 128) === 0) {
    return {
      form: 'short',
      firstByte,
      version: null,
      destinationConnectionId: data.subarray(1),
      sourceConnectionId: new Uint8Array(),
      payloadOffset: data.byteLength
    };
  }
  ensureAvailable(data, 1, 5, 'long-header version and DCID length');
  const version = readU32BE(data, 1);
  const dcidLength = data[5]!;
  ensureAvailable(data, 6, dcidLength + 1, 'long-header DCID and SCID length');
  const dcidStart = 6;
  const dcidEnd = dcidStart + dcidLength;
  const scidLength = data[dcidEnd]!;
  const scidStart = dcidEnd + 1;
  ensureAvailable(data, scidStart, scidLength, 'long-header SCID');
  const scidEnd = scidStart + scidLength;
  return {
    form: 'long',
    firstByte,
    version,
    destinationConnectionId: data.slice(dcidStart, dcidEnd),
    sourceConnectionId: data.slice(scidStart, scidEnd),
    payloadOffset: scidEnd
  };
}
