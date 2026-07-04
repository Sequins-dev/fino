/**
* internal:security/sandbox/frame — length-prefixed JSON frames over a blocking
* Unix socket.
*
* The parent and launcher exchange policy, report, and error frames across the
* inherited socketpair. Each frame is a 4-byte little-endian length followed by
* that many bytes of UTF-8 JSON. Reads and writes are blocking libc loops: the
* launcher runs off the event loop, and the parent only exchanges a couple of
* small frames per spawn, so blocking here is intentional and bounded.
*
* @internal
*/
import { libc, errno } from './ffi.ts';
const EINTR = 4;
const EAGAIN = 11;
/** Write exactly `buf.length` bytes to `fd`, retrying short writes. */
function writeAll(fd: number, buf: Uint8Array): void {
  let offset = 0;
  while (offset < buf.length) {
    const chunk = buf.subarray(offset);
    const n = Number(libc.symbols.write(fd, chunk, chunk.length));
    if (n < 0) {
      const e = errno();
      if (e === EINTR || e === EAGAIN) continue;
      throw new Error(`sandbox frame write failed: errno ${e}`);
    }
    if (n === 0) throw new Error('sandbox frame write returned 0');
    offset += n;
  }
}
/**
* Read exactly `length` bytes from `fd`, retrying short reads.
*
* Returns `null` on a clean EOF before any byte of the requested run is read —
* the caller uses this to distinguish "peer closed" (execve succeeded) from a
* truncated frame.
*/
function readExactly(fd: number, length: number): Uint8Array | null {
  const out = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const chunk = new Uint8Array(length - offset);
    const n = Number(libc.symbols.read(fd, chunk, chunk.length));
    if (n < 0) {
      const e = errno();
      if (e === EINTR || e === EAGAIN) continue;
      throw new Error(`sandbox frame read failed: errno ${e}`);
    }
    if (n === 0) {
      if (offset === 0) return null;
      throw new Error('sandbox frame truncated by peer');
    }
    out.set(chunk.subarray(0, n), offset);
    offset += n;
  }
  return out;
}
/** Serialize `value` as a length-prefixed JSON frame and write it to `fd`. */
export function writeFrame(fd: number, value: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, payload.length, true);
  writeAll(fd, header);
  writeAll(fd, payload);
}
/**
* Read one length-prefixed JSON frame from `fd`.
*
* Returns `null` when the peer closed the connection before sending another
* frame (a clean EOF), which the parent reads as "the launcher execve'd".
*/
export function readFrame(fd: number): unknown | null {
  const header = readExactly(fd, 4);
  if (header === null) return null;
  const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, true);
  if (length === 0) return {};
  const payload = readExactly(fd, length);
  if (payload === null) throw new Error('sandbox frame header without body');
  return JSON.parse(new TextDecoder().decode(payload));
}
