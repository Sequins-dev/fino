/**
 * internal:cluster/webtransport-framing - stream frame helpers for cluster WebTransport.
 *
 * Cluster WebTransport sessions use reliable bidirectional streams. Each
 * stream starts with a JSON metadata frame that identifies whether the stream
 * carries control-plane messages or `PORT_MSG` data for a single logical port
 * pair. Frames are UTF-8 JSON prefixed by a four-byte big-endian length.
 *
 * @internal
 */

import { encodeUtf8, decodeUtf8 } from '../../globals/encoding.mts';

/** Metadata frame sent first on every cluster WebTransport stream. */
export type ClusterStreamMetadata =
  | { v: 1; kind: 'control' }
  | { v: 1; kind: 'port'; pair: string; a: string; b: string };

/** Build a stable key for both directions of a logical port pair. */
export function canonicalPortPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Encode one JSON value as a length-prefixed cluster stream frame. */
export function encodeClusterStreamFrame(value: unknown): Uint8Array {
  const payload = encodeUtf8(JSON.stringify(value));
  const out = new Uint8Array(4 + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, payload.byteLength);
  out.set(payload, 4);
  return out;
}

/** Decode one complete cluster stream frame from the front of `bytes`. */
export function decodeClusterStreamFrame(bytes: Uint8Array): { value: unknown; bytesRead: number } {
  if (bytes.byteLength < 4) throw new Error('truncated cluster WebTransport frame length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  const end = 4 + length;
  if (bytes.byteLength < end) throw new Error('truncated cluster WebTransport frame payload');
  try {
    return {
      value: JSON.parse(decodeUtf8(bytes.subarray(4, end))),
      bytesRead: end,
    };
  } catch (err: unknown) {
    throw new Error(`invalid cluster WebTransport frame JSON: ${err}`);
  }
}

/** Incremental decoder for frames split across stream chunks. */
export class ClusterStreamFrameReader {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.byteLength);
    this.#buffer = merged;

    const frames: unknown[] = [];
    while (this.#buffer.byteLength >= 4) {
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, this.#buffer.byteLength);
      const length = view.getUint32(0);
      const end = 4 + length;
      if (this.#buffer.byteLength < end) break;
      const decoded = decodeClusterStreamFrame(this.#buffer.subarray(0, end));
      frames.push(decoded.value);
      this.#buffer = this.#buffer.subarray(decoded.bytesRead);
    }
    return frames;
  }

  assertComplete(): void {
    if (this.#buffer.byteLength !== 0) throw new Error('truncated cluster WebTransport frame at stream end');
  }
}
