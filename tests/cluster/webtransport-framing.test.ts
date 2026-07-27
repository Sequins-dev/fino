import { describe, it } from 'fino:test/test';
import {
  canonicalPortPair,
  decodeClusterStreamMetadata,
  decodeClusterStreamFrame,
  encodeClusterStreamMetadata,
  encodeClusterStreamFrame,
  type ClusterStreamMetadata,
} from 'internal:cluster/webtransport-framing';
describe('cluster WebTransport stream framing', () => {
  it('round-trips length-prefixed protobuf metadata frames', (t) => {
    const meta: ClusterStreamMetadata = {
      v: 1,
      kind: 'port',
      pair: 'a/1|b/2',
      a: 'a/1',
      b: 'b/2',
    };
    const encoded = encodeClusterStreamFrame(encodeClusterStreamMetadata(meta));
    const decoded = decodeClusterStreamFrame(encoded);
    t.equal(decoded.bytesRead, encoded.byteLength, 'frame length includes prefix and payload');
    t.deepEqual(decodeClusterStreamMetadata(decoded.value), meta, 'protobuf metadata round-trips');
  });
  it('rejects truncated frames', (t) => {
    const encoded = encodeClusterStreamFrame(
      encodeClusterStreamMetadata({ v: 1, kind: 'control' }),
    );
    t.throws(
      () => decodeClusterStreamFrame(encoded.subarray(0, encoded.byteLength - 1)),
      /truncated/i,
      'short payload is rejected',
    );
  });
  it('rejects malformed protobuf metadata', (t) => {
    const malformed = new Uint8Array([255]);
    t.throws(
      () => decodeClusterStreamMetadata(malformed),
      /protobuf|truncated/i,
      'invalid protobuf is rejected',
    );
  });
  it('builds canonical port pair keys independent of direction', (t) => {
    t.equal(canonicalPortPair('node-b/p2', 'node-a/p1'), 'node-a/p1|node-b/p2');
    t.equal(canonicalPortPair('node-a/p1', 'node-b/p2'), 'node-a/p1|node-b/p2');
  });
});
