/**
 * internal:cluster/webtransport-framing - stream frame helpers for cluster WebTransport.
 *
 * Cluster WebTransport sessions use reliable bidirectional streams. Each
 * stream starts with a protobuf metadata frame that identifies whether the stream
 * carries control-plane messages or `PORT_MSG` data for a single logical port
 * pair. Every frame is an opaque binary payload prefixed by a four-byte
 * big-endian length, so a receiver can split a byte stream back into discrete
 * protobuf messages without in-band delimiters.
 *
 * The module has two halves. The stateless half is a pair of pure functions:
 * `encodeClusterStreamFrame` frames one byte array, and
 * `decodeClusterStreamFrame` decodes exactly one complete
 * frame from the front of a buffer. The stateful half is
 * `ClusterStreamFrameReader`, which buffers partial frames across arbitrary
 * chunk boundaries — WebTransport delivers reads in whatever sizes the QUIC
 * stack produces, so a single frame may span several chunks and a single
 * chunk may contain several frames.
 *
 * `canonicalPortPair` builds a direction-independent key for a logical port
 * pair. Port metadata may carry one, but a multiplexed port lane — which is
 * what the transport opens — carries every pair on the connection and names
 * none of them, so the field is optional and purely descriptive.
 *
 * ```ts no_run
 * import {
 *   ClusterStreamFrameReader,
 *   canonicalPortPair,
 *   encodeClusterStreamFrame,
 *   type ClusterStreamMetadata,
 * } from 'internal:cluster/webtransport-framing';
 *
 * // Sender: announce the stream, then send messages.
 * const metadata: ClusterStreamMetadata = {
 *   v: 1,
 *   kind: 'port',
 *   pair: canonicalPortPair('node-a/p1', 'node-b/p2'),
 *   a: 'node-a/p1',
 *   b: 'node-b/p2',
 * };
 * await writer.write(encodeClusterStreamFrame(encodeClusterStreamMetadata(metadata)));
 *
 * // Receiver: reassemble frames from arbitrary read chunks.
 * const frames = new ClusterStreamFrameReader();
 * for await (const chunk of readable) {
 *   for (const value of frames.push(chunk)) handle(value);
 * }
 * frames.assertComplete();
 * ```
 *
 * @internal
 */
import { defineMessage } from 'fino:format/protobuf';
/**
 * Metadata frame sent first on every cluster WebTransport stream.
 *
 * The `kind` discriminant declares what the rest of the stream carries. A
 * `'control'` stream carries control-plane cluster messages between two
 * nodes; a `'port'` stream carries `PORT_MSG` traffic. When a stream serves
 * exactly one logical port pair it may name it — `a` and `b` are the two port
 * addresses and `pair` their canonical key — but the transport multiplexes
 * every pair onto one lane, so those fields are normally absent. Nothing
 * routes on them: a `PORT_MSG` names its own `fromPort` and `toPort`.
 *
 * `v` is the framing protocol version; the only defined version is `1`.
 *
 * ```ts no_run
 * import { canonicalPortPair, type ClusterStreamMetadata } from 'internal:cluster/webtransport-framing';
 *
 * const control: ClusterStreamMetadata = { v: 1, kind: 'control' };
 * const port: ClusterStreamMetadata = {
 *   v: 1,
 *   kind: 'port',
 *   pair: canonicalPortPair('node-a/p1', 'node-b/p2'),
 *   a: 'node-a/p1',
 *   b: 'node-b/p2',
 * };
 * ```
 */
export type ClusterStreamMetadata =
  | {
      v: 1;
      kind: 'control';
    }
  | {
      v: 1;
      kind: 'port';
      /**
       * The logical port pair this stream serves, when it serves exactly one.
       *
       * Omitted on a multiplexed port lane, which carries every pair on the
       * connection over a single long-lived stream. Nothing routes on these —
       * a `PORT_MSG` names its own `fromPort` and `toPort` — so they are
       * descriptive only.
       */
      pair?: string;
      a?: string;
      b?: string;
    };

interface WireMetadata {
  version: number;
  kind: number;
  pair?: string;
  a?: string;
  b?: string;
}

const MetadataMessage = defineMessage<WireMetadata>({
  version: { number: 1, type: 'uint32' },
  kind: { number: 2, type: 'enum' },
  pair: { number: 3, type: 'string', optional: true },
  a: { number: 4, type: 'string', optional: true },
  b: { number: 5, type: 'string', optional: true },
});

/**
 * Encode typed stream metadata as a protobuf message.
 *
 * @internal
 */
export function encodeClusterStreamMetadata(metadata: ClusterStreamMetadata): Uint8Array {
  return MetadataMessage.encode({
    version: metadata.v,
    kind: metadata.kind === 'control' ? 1 : 2,
    ...(metadata.kind === 'port' ? { pair: metadata.pair, a: metadata.a, b: metadata.b } : {}),
  });
}

/**
 * Decode and validate one protobuf stream metadata message.
 *
 * @internal
 */
export function decodeClusterStreamMetadata(bytes: Uint8Array): ClusterStreamMetadata {
  const value = MetadataMessage.decode(bytes);
  if (value.version !== 1) {
    throw new Error(`unsupported cluster WebTransport metadata version ${value.version}`);
  }
  if (value.kind === 1) return { v: 1, kind: 'control' };
  if (value.kind === 2) {
    // The pair fields are optional: a multiplexed lane carries every pair on
    // the connection and names none of them.
    return {
      v: 1,
      kind: 'port',
      ...(typeof value.pair === 'string' ? { pair: value.pair } : {}),
      ...(typeof value.a === 'string' ? { a: value.a } : {}),
      ...(typeof value.b === 'string' ? { b: value.b } : {}),
    };
  }
  throw new Error('invalid cluster WebTransport metadata');
}
/**
 * Build a stable key for both directions of a logical port pair.
 *
 * Orders the two port addresses lexicographically and joins them with `|`,
 * so the same pair of ports always maps to the same key regardless of
 * argument order. Used as the `pair` field of port-stream metadata and as
 * the lookup key when routing an incoming stream to its local port.
 *
 * ```ts no_run
 * import { canonicalPortPair } from 'internal:cluster/webtransport-framing';
 *
 * canonicalPortPair('node-a/p1', 'node-b/p2'); // 'node-a/p1|node-b/p2'
 * canonicalPortPair('node-b/p2', 'node-a/p1'); // 'node-a/p1|node-b/p2'
 * ```
 */
export function canonicalPortPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
/**
 * Encode one binary payload as a length-prefixed cluster stream frame.
 *
 * Prepends a four-byte big-endian length covering the payload only (the prefix
 * itself is not counted). Consecutive frames are written back to back.
 *
 * ```ts no_run
 * import { encodeClusterStreamFrame } from 'internal:cluster/webtransport-framing';
 *
 * const frame = encodeClusterStreamFrame(new Uint8Array([1, 2, 3]));
 * // frame[0..4] is the big-endian payload length; bytes follow.
 * await writer.write(frame);
 * ```
 */
export function encodeClusterStreamFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, payload.byteLength);
  out.set(payload, 4);
  return out;
}
/**
 * Decode one complete cluster stream frame from the front of `bytes`.
 *
 * Reads the four-byte big-endian length prefix and returns the payload together
 * with `bytesRead` — the
 * total size of the consumed frame (prefix plus payload). Any bytes past the
 * frame are left untouched, so a caller holding several back-to-back frames
 * can advance by `bytesRead` and decode again. For chunked input where frame
 * boundaries are unknown, use `ClusterStreamFrameReader` instead.
 *
 * Throws if `bytes` is shorter than the length prefix or the buffer ends
 * before the declared payload length.
 *
 * ```ts no_run
 * import { decodeClusterStreamFrame, encodeClusterStreamFrame } from 'internal:cluster/webtransport-framing';
 *
 * const bytes = encodeClusterStreamFrame(new Uint8Array([1, 2, 3]));
 * const { value, bytesRead } = decodeClusterStreamFrame(bytes);
 * // value       → Uint8Array([1, 2, 3])
 * // bytesRead   → bytes.byteLength
 * const rest = bytes.subarray(bytesRead); // remaining frames, if any
 * ```
 */
export function decodeClusterStreamFrame(bytes: Uint8Array): {
  value: Uint8Array;
  bytesRead: number;
} {
  if (bytes.byteLength < 4) throw new Error('truncated cluster WebTransport frame length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  const end = 4 + length;
  if (bytes.byteLength < end) throw new Error('truncated cluster WebTransport frame payload');
  return {
    value: bytes.subarray(4, end),
    bytesRead: end,
  };
}
/**
 * Incremental decoder for frames split across stream chunks.
 *
 * WebTransport reads arrive in arbitrary sizes, so a frame may be split
 * across chunks or several frames may share one chunk. The reader keeps an
 * internal buffer of not-yet-complete bytes: feed every chunk to `push` as
 * it arrives and it returns whatever complete frames became decodable,
 * holding any trailing partial frame until more bytes show up. Create one
 * reader per stream — the buffered state is stream-specific.
 *
 * ```ts no_run
 * import { ClusterStreamFrameReader } from 'internal:cluster/webtransport-framing';
 *
 * const frames = new ClusterStreamFrameReader();
 * for await (const chunk of stream.readable) {
 *   for (const value of frames.push(chunk)) {
 *     handleMessage(value);
 *   }
 * }
 * frames.assertComplete(); // stream must not end mid-frame
 * ```
 */
export class ClusterStreamFrameReader {
  #buffer = new Uint8Array(0);
  /**
   * Append a chunk and return every frame it completes, in stream order.
   *
   * Returns an empty array when the chunk is empty or no buffered frame is
   * complete yet. A merely incomplete frame is not an error here; it waits for
   * the next push.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.byteLength);
    this.#buffer = merged;
    const frames: Uint8Array[] = [];
    while (this.#buffer.byteLength >= 4) {
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        this.#buffer.byteLength,
      );
      const length = view.getUint32(0);
      const end = 4 + length;
      if (this.#buffer.byteLength < end) break;
      const decoded = decodeClusterStreamFrame(this.#buffer.subarray(0, end));
      frames.push(decoded.value);
      this.#buffer = this.#buffer.subarray(decoded.bytesRead);
    }
    return frames;
  }
  /**
   * Verify no partial frame remains buffered.
   *
   * Call after the stream's final chunk: a clean stream ends exactly on a
   * frame boundary. Throws if leftover bytes indicate the peer closed the
   * stream mid-frame.
   */
  assertComplete(): void {
    if (this.#buffer.byteLength !== 0)
      throw new Error('truncated cluster WebTransport frame at stream end');
  }
}
