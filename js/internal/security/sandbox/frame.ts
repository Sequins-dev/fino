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
* This wire format is the handshake channel between the two ends of a sandbox
* spawn. The parent sends the resolved policy as one frame; the freshly-forked
* launcher reads it, applies each restriction, and reports back with a `report`
* frame on success or an `error` frame if a stage failed. A clean EOF (the peer
* closing its socket) is a first-class signal, not an error: it means the
* launcher reached `execve` and the inherited fd was closed by exec, so
* `readFrame` returns `null` rather than throwing. This is why the two entry
* points here deal in blocking libc `read`/`write` directly instead of going
* through the event loop — the launcher has no loop yet, and the parent only
* trades a handful of tiny frames per spawn.
*
* Use this module only from the sandbox launcher/parent pair; it is not a
* general-purpose IPC layer. There is no framing for partial JSON, no
* backpressure, and no support for concurrent readers on one fd.
*
* ```ts no_run
*   import { writeFrame, readFrame } from 'internal:security/sandbox/frame';
*
*   // Parent side: hand the resolved policy to the launcher, then wait for
*   // its acknowledgement.
*   writeFrame(parentSock, { type: 'policy', rlimits: [], landlock: null });
*
*   const reply = readFrame(parentSock);
*   if (reply === null) {
*     // Launcher execve'd without a report — the child is now running.
*   } else if ((reply as { type: string }).type === 'error') {
*     throw new Error('sandbox setup failed');
*   }
* ```
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
/**
* Serialize `value` as a length-prefixed JSON frame and write it to `fd`.
*
* The value is `JSON.stringify`'d to UTF-8, prefixed with its 4-byte
* little-endian byte length, and written in full with short writes retried.
* `value` must therefore be JSON-serializable — functions, `undefined`
* properties, and `BigInt` values will be dropped or throw the way
* `JSON.stringify` normally handles them.
*
* Throws if the underlying `write` fails with an unrecoverable errno, or if the
* peer accepts zero bytes (a closed or broken socket). `EINTR` and `EAGAIN` are
* retried transparently.
*
* ```ts no_run
*   import { writeFrame } from 'internal:security/sandbox/frame';
*
*   // Launcher reports which restrictions it installed before exec'ing.
*   writeFrame(fd, {
*     type: 'report',
*     installed: ['rlimit', 'landlock', 'seccomp'],
*     cgroupPath: '/sys/fs/cgroup/fino.sandbox.1234',
*     descendantCleanup: true,
*   });
* ```
*/
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
* Reads the 4-byte little-endian length header, then exactly that many bytes of
* UTF-8 JSON, and returns the parsed value. A zero-length payload is returned as
* an empty object `{}` rather than `undefined`, so callers can always branch on
* the parsed frame's shape.
*
* Returns `null` when the peer closed the connection before sending another
* frame (a clean EOF), which the parent reads as "the launcher execve'd". This
* is the normal success path for a spawn: once the child image replaces the
* launcher, the inherited socket is closed by exec and the next `readFrame`
* observes EOF.
*
* Throws if the peer closes mid-frame — a header with no body, or a body
* truncated before the declared length — and propagates any unrecoverable
* `read` errno. Malformed JSON in a complete frame surfaces as a `JSON.parse`
* error.
*
* ```ts no_run
*   import { readFrame } from 'internal:security/sandbox/frame';
*
*   const frame = readFrame(fd);
*   if (frame === null) {
*     // Peer execve'd — no report is coming; the child is running.
*   } else {
*     const msg = frame as { type: string };
*     if (msg.type === 'error') throw new Error('launcher failed a setup stage');
*   }
* ```
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
