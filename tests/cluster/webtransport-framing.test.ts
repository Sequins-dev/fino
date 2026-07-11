import { describe, it } from 'fino:test/test';
import { decodeClusterStreamFrame, encodeClusterStreamFrame, type ClusterStreamMetadata } from 'internal:cluster/webtransport-framing';
describe('cluster WebTransport stream framing', () => {
  it('round-trips length-prefixed JSON metadata frames', (t) => {
    const meta: ClusterStreamMetadata = {
      v: 1,
      kind: 'control'
    };
    const encoded = encodeClusterStreamFrame(meta);
    const decoded = decodeClusterStreamFrame(encoded);
    t.equal(decoded.bytesRead, encoded.byteLength, 'frame length includes prefix and JSON payload');
    t.deepEqual(decoded.value, meta, 'metadata JSON round-trips');
  });
  it('rejects truncated frames', (t) => {
    const encoded = encodeClusterStreamFrame({
      v: 1,
      kind: 'control'
    });
    t.throws(() => decodeClusterStreamFrame(encoded.subarray(0, encoded.byteLength - 1)), /truncated/i, 'short payload is rejected');
  });
  it('rejects malformed JSON frames', (t) => {
    const malformed = new Uint8Array([
      0,
      0,
      0,
      1,
      255
    ]);
    t.throws(() => decodeClusterStreamFrame(malformed), /invalid/i, 'non-UTF8 or non-JSON payload is rejected');
  });
});
