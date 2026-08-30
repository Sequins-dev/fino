/**
 * Sandbox launcher frame bounds and socket framing tests.
 */
import { describe, it } from 'fino:test/test';
import {
  encodeFrame,
  MAX_SANDBOX_FRAME_BYTES,
  readFrame,
  writeFrame,
} from 'internal:security/sandbox/frame';
import { AF_UNIX, libc, SOCK_STREAM } from 'internal:security/sandbox/ffi';

function socketpair(): [number, number] {
  const descriptors = new ArrayBuffer(8);
  const status = Number(libc.symbols.socketpair(AF_UNIX, SOCK_STREAM, 0, descriptors));
  if (status !== 0) throw new Error(`socketpair failed with status ${status}`);
  const view = new DataView(descriptors);
  return [view.getInt32(0, true), view.getInt32(4, true)];
}

function closePair(pair: [number, number]): void {
  libc.symbols.close(pair[0]);
  libc.symbols.close(pair[1]);
}

describe('sandbox launcher frames', () => {
  it('round-trips an ordinary frame', (t) => {
    const pair = socketpair();
    try {
      writeFrame(pair[0], { type: 'report', installed: [] });
      t.deepEqual(
        readFrame(pair[1]),
        { type: 'report', installed: [] },
        'frame payload survives the socket boundary',
      );
    } finally {
      closePair(pair);
    }
  });

  it('rejects oversized local payloads before allocating a frame', (t) => {
    t.throws(
      () => encodeFrame('x'.repeat(MAX_SANDBOX_FRAME_BYTES)),
      /sandbox frame payload exceeds/i,
      'JSON string overhead crosses the payload limit',
    );
  });

  it('rejects an oversized peer header before reading its payload', (t) => {
    const pair = socketpair();
    try {
      const header = new ArrayBuffer(4);
      new DataView(header).setUint32(0, MAX_SANDBOX_FRAME_BYTES + 1, true);
      t.equal(
        Number(libc.symbols.write(pair[0], header, 4)),
        4,
        'oversized header is written without a payload',
      );
      t.throws(
        () => readFrame(pair[1]),
        /sandbox frame payload exceeds/i,
        'declared length fails without waiting for or allocating a body',
      );
    } finally {
      closePair(pair);
    }
  });
});
