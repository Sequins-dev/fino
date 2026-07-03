/**
* fino:io_uring — low-level io_uring backend via raw Linux syscalls.
*
* io_uring is Linux's high-performance asynchronous I/O interface, introduced
* in kernel 5.1. Unlike epoll (which is level-triggered and requires separate
* read/write syscalls), io_uring can submit async operations (open, read,
* close, timer) directly into a shared ring buffer and receive completions in
* another ring buffer — no extra syscalls needed to get the results.
*
* This module uses io_uring entirely from JS via FFI and raw syscalls. There
* is no dependency on liburing. This keeps the Rust layer thin and the Linux
* I/O behavior transparent.
*
*
* ## Ring buffer architecture
*
* io_uring uses three memory-mapped regions shared between user space and the
* kernel:
*
*   SQ ring  (IORING_OFF_SQ_RING  = 0x0000000):  Submission Queue metadata
*            head, tail, ring_mask, ring_entries, flags, array[]
*   CQ ring  (IORING_OFF_CQ_RING  = 0x8000000):  Completion Queue metadata
*            head, tail, ring_mask, cqes[]
*   SQEs     (IORING_OFF_SQES     = 0x10000000): Array of Submission Queue
*            Entries (64 bytes each), indexed indirectly via SQ array[]
*
* Submitting a request: write an SQE at `sqes[tail & mask]`, write its index
* into `sq_array[tail & mask]`, increment `sq_tail`, then call
* `io_uring_enter(ringFd, toSubmit, 0, 0)` to notify the kernel.
*
* Collecting completions: read CQEs from `cq_ring.cqes[head & mask]` while
* `head != tail`, then advance `cq_ring.head`.
*
* We maintain `sqTailLocal` as a shadow of the SQ tail because we write it
* to the ring only when submitting. This lets us batch multiple SQEs before
* notifying the kernel (though we currently submit one at a time).
*
*
* ## SQE layout (64 bytes per entry)
*
*   offset  0: opcode    (u8)   — IORING_OP_POLL_ADD, IORING_OP_TIMEOUT, etc.
*   offset  1: flags     (u8)   — SQE flags (unused here)
*   offset  2: ioprio    (u16)  — I/O priority (0 = default)
*   offset  4: fd        (i32)  — file descriptor (or AT_FDCWD for openat)
*   offset  8: off       (u64)  — file offset, or UINT64_MAX for current pos
*   offset 16: addr      (u64)  — pointer to buffer (for read/openat)
*   offset 24: len       (u32)  — buffer length or count
*   offset 28: union     (u32)  — poll_events (for POLL_ADD) or open_flags (for OPENAT)
*   offset 32: user_data (u64)  — caller-supplied ID, echoed in the CQE
*
*
* ## CQE layout (16 bytes per entry)
*
*   offset  0: user_data (u64)  — the user_data from the SQE
*   offset  8: res       (i32)  — syscall return value (negative = -errno)
*   offset 12: flags     (u32)  — CQE flags (unused here)
*
*
* ## Translating completions to kqueue-compatible events
*
* `fino:loop` uses kqueue filter constants (EVFILT_READ, EVFILT_WRITE,
* EVFILT_TIMER) as a unified event language across platforms. `drainCqes()`
* inspects each CQE's `user_data` to decide which filter constant to emit:
*
*   - If `user_data` is in `timerBufs`: this was an IORING_OP_TIMEOUT → EVFILT_TIMER
*   - If `user_data` is in `fileBufs`:  this was an async file op → EVFILT_COMPLETION
*   - Otherwise: this was an IORING_OP_POLL_ADD, `res` has the poll mask →
*     POLLIN → EVFILT_READ, POLLOUT → EVFILT_WRITE
*
* The EVFILT_COMPLETION filter is unique to this backend; `fino:loop` exposes
* it via `loop.submit()` for callers that need async file operations.
*
*
* ## IORING_OP_POLL_ADD is one-shot
*
* Unlike epoll with EPOLLET, an IORING_OP_POLL_ADD SQE fires exactly once when
* the fd becomes ready, then the watch is automatically removed by the kernel.
* This matches what `fino:loop` expects (each `readable()`/`writable()` call
* sets up a single-fire watch). We therefore have no-op implementations for
* `removeRead()` and `removeWrite()`.
*
*
* ## Buffer lifetime (timerBufs, fileBufs)
*
* io_uring accesses buffers asynchronously — the kernel reads or writes them
* after the JS `submit` call returns. If the GC frees the buffer before the
* kernel is done, we get memory corruption. We prevent this by keeping
* references in `timerBufs` and `fileBufs` Maps keyed on `user_data`. The
* Maps are cleaned up in `drainCqes()` when the CQE arrives, which is always
* after the kernel has finished accessing the buffer.
*
*
* ## No liburing dependency
*
* liburing is a helper library that wraps io_uring setup and submission, but
* it's an extra dependency and its abstractions don't match our needs well.
* We map the ring buffers directly via `mmap(2)` using the offsets documented
* in `linux/io_uring.h` and access them with `Pointer.*` from `fino:ffi`.
*
*
* ## Contributing
*
* - All syscall numbers (425, 426) are stable on x86_64 and arm64 Linux.
* - Pointer read/write helpers (`Pointer.readU32`, `Pointer.writeU8`, etc.)
*   from `fino:ffi` are used for all ring accesses. Do not use DataView on
*   mmap'd pointers — they aren't ArrayBuffers.
* - The `params` struct at `io_uring_setup` time is 120 bytes. We only read
*   the offsets we need (sq_entries, cq_entries, sq_off, cq_off).
* - If you add a new io_uring opcode, add its user_data to `fileBufs` (or a
*   new Map) so that `drainCqes()` can identify the completion type correctly.
*
* ## Example
*
* ```typescript no_run
* import * as io from 'internal:runtime/io_uring';
*
* const loop = io.create();
* io.addTimer(loop, 1, 10);
* const events = io.wait(loop, 50);
* io.destroy(loop);
*
* console.log(events.map(event => event.filter));
* ```
*
* @internal
*/
import { dlopen, Pointer } from 'fino:ffi';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** Offsets into the SQ ring mmap'd region, read from io_uring_params. */
interface SqRingOffsets {
  head: number;
  tail: number;
  ring_mask: number;
  ring_entries: number;
  array: number;
}
/** Offsets into the CQ ring mmap'd region, read from io_uring_params. */
interface CqRingOffsets {
  head: number;
  tail: number;
  ring_mask: number;
  cqes: number;
}
/** Opaque io_uring loop handle returned by create(). */
interface IoUringLoop {
  ringFd: number;
  sqRing: object;
  sqRingSize: number;
  cqRing: object;
  cqRingSize: number;
  sqes: object;
  sqesSize: number;
  sqOff: SqRingOffsets;
  cqOff: CqRingOffsets;
  sqEntries: number;
  cqEntries: number;
  sqTailLocal: number;
  sqSubmittedLocal: number;
  timerBufs: Map<number, ArrayBuffer>;
  waitTimerBufs: Map<number, ArrayBuffer>;
  canceledTimers: Set<number>;
  nextWaitTimerId: number;
  fileBufs: Map<number, ArrayBuffer[]>;
  persistentReads: Set<number>;
  signalFds: Map<number, number>;
  signalFdToSig: Map<number, number>;
}
/** kqueue-compatible event emitted by drainCqes(). */
interface CqeEvent {
  ident: number;
  filter: number;
  flags: number;
  res: number;
}
const USER_DATA_SHIFT = 48n;
const USER_DATA_MASK = (1n << USER_DATA_SHIFT) - 1n;
const USER_DATA_READ = 1n;
const USER_DATA_WRITE = 2n;
const USER_DATA_TIMER = 3n;
const USER_DATA_FILE = 4n;
const USER_DATA_SIGNAL = 5n;
const USER_DATA_TIMER_CANCEL = 6n;
const USER_DATA_WAIT_TIMER = 7n;
const lib = dlopen('libc.so.6', {
  syscall: {
    parameters: [
      'i64',
      'i64',
      'i64',
      'i64',
      'i64',
      'i64',
      'i64'
    ],
    result: 'i64'
  },
  mmap: {
    parameters: [
      'pointer',
      'usize',
      'i32',
      'i32',
      'i32',
      'i64'
    ],
    result: 'pointer'
  },
  munmap: {
    parameters: ['pointer', 'usize'],
    result: 'i32'
  },
  close: {
    parameters: ['i32'],
    result: 'i32'
  },
  read: {
    parameters: [
      'i32',
      'buffer',
      'usize'
    ],
    result: 'isize'
  },
  sigprocmask: {
    parameters: [
      'i32',
      'buffer',
      'pointer'
    ],
    result: 'i32'
  },
  signalfd: {
    parameters: [
      'i32',
      'buffer',
      'i32'
    ],
    result: 'i32'
  }
});
// ---------------------------------------------------------------------------
// Syscall numbers (same on x86_64 and arm64 Linux)
// ---------------------------------------------------------------------------
const SYS_IO_URING_SETUP = 425n;
const SYS_IO_URING_ENTER = 426n;
// io_uring_enter flags
const IORING_ENTER_GETEVENTS = 1n;
// mmap constants
const PROT_READ = 1;
const PROT_WRITE = 2;
const MAP_SHARED = 1;
const MAP_POPULATE = 32768;
// io_uring mmap offsets
const IORING_OFF_SQ_RING = 0n;
const IORING_OFF_CQ_RING = 134217728n;
const IORING_OFF_SQES = 268435456n;
// io_uring SQE opcodes
const IORING_OP_NOP = 0;
const IORING_OP_POLL_ADD = 6;
const IORING_OP_TIMEOUT = 11;
const IORING_OP_TIMEOUT_REMOVE = 12;
const IORING_OP_OPENAT = 18;
const IORING_OP_CLOSE = 19;
const IORING_OP_READ = 22;
// poll(2) event masks
const POLLIN = 1;
const POLLOUT = 4;
// AT_FDCWD: relative to current working directory
const AT_FDCWD = -100;
// Use current file position for IORING_OP_READ (equivalent to read(2) with no offset)
const IORING_READ_AT_CURPOS = 18446744073709551615n;
// Kqueue-compatible filter constants (same values as fino:kqueue exports).
// Exported so that fino:loop can use a single dispatch table on both platforms.
/**
* Kqueue-compatible read readiness filter emitted by io_uring poll completions.
*
* ```typescript no_run
* import { EVFILT_READ } from 'internal:runtime/io_uring';
* void EVFILT_READ;
* ```
*
* @internal
*/
export const EVFILT_READ = -1;
/**
* Kqueue-compatible write readiness filter emitted by io_uring poll completions.
*
* ```typescript no_run
* import { EVFILT_WRITE } from 'internal:runtime/io_uring';
* void EVFILT_WRITE;
* ```
*
* @internal
*/
export const EVFILT_WRITE = -2;
/**
* Kqueue-compatible timer filter emitted by timeout completions.
*
* ```typescript no_run
* import { EVFILT_TIMER } from 'internal:runtime/io_uring';
* void EVFILT_TIMER;
* ```
*
* @internal
*/
export const EVFILT_TIMER = -7;
/**
* Kqueue-compatible signal filter emitted by signalfd readiness.
*
* ```typescript no_run
* import { EVFILT_SIGNAL } from 'internal:runtime/io_uring';
* void EVFILT_SIGNAL;
* ```
*
* @internal
*/
export const EVFILT_SIGNAL = -6;
/**
* io_uring-only filter for async file operation completions.
*
* `internal:runtime/loop.submit` resolves operations that emit this filter.
*
* ```typescript no_run
* import { EVFILT_COMPLETION } from 'internal:runtime/io_uring';
* void EVFILT_COMPLETION;
* ```
*
* @internal
*/
export const EVFILT_COMPLETION = -10;
// Signal handling via signalfd(2)
const SIG_BLOCK = 0;
const SFD_NONBLOCK = 2048n;
const SFD_CLOEXEC = 524288n;
const GLIBC_SIGSET_SIZE = 128;
const SIGNALFD_SIGINFO_SIZE = 128;
// io_uring_params struct (120 bytes)
// sq_entries at  0  (u32)
// cq_entries at  4  (u32)
// flags      at  8  (u32)
// sq_off     at 40  (io_sqring_offsets, 40 bytes)
// cq_off     at 80  (io_cqring_offsets, 40 bytes)
// io_sqring_offsets (at params+40):
//   head=0, tail=4, ring_mask=8, ring_entries=12, flags=16, dropped=20, array=24
// io_cqring_offsets (at params+80):
//   head=0, tail=4, ring_mask=8, ring_entries=12, overflow=16, cqes=20
// SQE layout (64 bytes):
//   opcode at +0 (u8), flags at +1 (u8), ioprio at +2 (u16),
//   fd at +4 (i32), off at +8 (u64), addr at +16 (u64),
//   len at +24 (u32), union at +28 (u32), user_data at +32 (u64)
// CQE layout (16 bytes):
//   user_data at +0 (u64), res at +8 (i32), flags at +12 (u32)
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function syscall(nr: bigint, a1: bigint | number = 0n, a2: bigint | number = 0n, a3: bigint | number = 0n, a4: bigint | number = 0n, a5: bigint | number = 0n, a6: bigint | number = 0n): bigint {
  return lib.symbols.syscall(nr, BigInt(a1), BigInt(a2), BigInt(a3), BigInt(a4), BigInt(a5), BigInt(a6));
}
function bufPtr(ab: ArrayBuffer): bigint {
  return Pointer.addr(ab);
}
function packUserData(kind: bigint, ident: number): bigint {
  return kind << USER_DATA_SHIFT | BigInt(ident) & USER_DATA_MASK;
}
function unpackUserData(raw: bigint): {
  kind: bigint;
  ident: number;
} {
  return {
    kind: raw >> USER_DATA_SHIFT,
    ident: Number(raw & USER_DATA_MASK)
  };
}
// ---------------------------------------------------------------------------
// Ring setup
// ---------------------------------------------------------------------------
/**
* Create a new io_uring event loop handle.
* @param {number} [entries=256]
*
* The returned handle owns three mmap regions and a ring fd. Release it with
* `destroy`.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* const loop = uring.create(256);
* uring.destroy(loop);
* ```
*/
export function create(entries: number = 256): IoUringLoop {
  // Allocate io_uring_params (120 bytes, zero-filled)
  const params = new ArrayBuffer(120);
  const ringFd = Number(syscall(SYS_IO_URING_SETUP, BigInt(entries), bufPtr(params)));
  if (ringFd < 0) throw new Error(`io_uring_setup failed: ${ringFd}`);
  const pView = new DataView(params);
  // Read ring dimensions from params
  const sqEntries = pView.getUint32(0, true);
  const cqEntries = pView.getUint32(4, true);
  // io_sqring_offsets at params+40
  const sqOff = {
    head: pView.getUint32(40 + 0, true),
    tail: pView.getUint32(40 + 4, true),
    ring_mask: pView.getUint32(40 + 8, true),
    ring_entries: pView.getUint32(40 + 12, true),
    array: pView.getUint32(40 + 24, true)
  };
  // io_cqring_offsets at params+80
  const cqOff = {
    head: pView.getUint32(80 + 0, true),
    tail: pView.getUint32(80 + 4, true),
    ring_mask: pView.getUint32(80 + 8, true),
    cqes: pView.getUint32(80 + 20, true)
  };
  // mmap the three regions
  const sqRingSize = sqOff.array + sqEntries * 4;
  const cqRingSize = cqOff.cqes + cqEntries * 16;
  const sqesSize = sqEntries * 64;
  const sqRing = lib.symbols.mmap(Pointer.null(), sqRingSize, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, ringFd, IORING_OFF_SQ_RING);
  const cqRing = lib.symbols.mmap(Pointer.null(), cqRingSize, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, ringFd, IORING_OFF_CQ_RING);
  const sqes = lib.symbols.mmap(Pointer.null(), sqesSize, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, ringFd, IORING_OFF_SQES);
  if (sqRing === null || cqRing === null || sqes === null) {
    throw new Error('io_uring mmap failed');
  }
  return {
    ringFd,
    sqRing,
    sqRingSize,
    cqRing,
    cqRingSize,
    sqes,
    sqesSize,
    sqOff,
    cqOff,
    sqEntries,
    cqEntries,
    sqTailLocal: 0,
    sqSubmittedLocal: 0,
    timerBufs: new Map(),
    waitTimerBufs: new Map(),
    canceledTimers: new Set(),
    nextWaitTimerId: 1,
    fileBufs: new Map(),
    persistentReads: new Set(),
    signalFds: new Map(),
    signalFdToSig: new Map()
  };
}
// ---------------------------------------------------------------------------
// SQE submission
// ---------------------------------------------------------------------------
function submitSqe(loop: IoUringLoop, opcode: number, fd: number, addr: number | bigint, len: number, off: number | bigint, userData: bigint, pollEvents: number): void {
  if (loop.sqTailLocal - loop.sqSubmittedLocal >= loop.sqEntries) {
    submitPending(loop);
  }
  const mask = Pointer.readU32(loop.sqRing, loop.sqOff.ring_mask);
  const tail = loop.sqTailLocal;
  const index = tail & mask;
  const sqeBase = index * 64;
  // Zero the SQE slot first
  for (let i = 0; i < 64; i += 8) {
    Pointer.writeU64(loop.sqes, sqeBase + i, 0n);
  }
  Pointer.writeU8(loop.sqes, sqeBase + 0, opcode);
  Pointer.writeI32(loop.sqes, sqeBase + 4, fd);
  Pointer.writeU64(loop.sqes, sqeBase + 8, BigInt(off));
  Pointer.writeU64(loop.sqes, sqeBase + 16, BigInt(addr));
  Pointer.writeU32(loop.sqes, sqeBase + 24, len);
  Pointer.writeU32(loop.sqes, sqeBase + 28, pollEvents);
  Pointer.writeU64(loop.sqes, sqeBase + 32, userData);
  // Write the index into the SQ array
  const arrayOff = loop.sqOff.array + index * 4;
  Pointer.writeU32(loop.sqRing, arrayOff, index);
  loop.sqTailLocal = tail + 1;
  // Publish the new tail
  Pointer.writeU32(loop.sqRing, loop.sqOff.tail, loop.sqTailLocal);
}
function submitPending(loop: IoUringLoop): void {
  let toSubmit = loop.sqTailLocal - loop.sqSubmittedLocal;
  while (toSubmit > 0) {
    const ret = Number(syscall(SYS_IO_URING_ENTER, BigInt(loop.ringFd), BigInt(toSubmit), 0n, 0n));
    if (ret < 0) throw new Error(`io_uring_enter (submit) failed: ${ret}`);
    if (ret === 0) throw new Error('io_uring_enter (submit) made no progress');
    loop.sqSubmittedLocal += ret;
    toSubmit -= ret;
  }
}
// ---------------------------------------------------------------------------
// CQE consumption
// ---------------------------------------------------------------------------
function drainCqes(loop: IoUringLoop): CqeEvent[] {
  const events = [];
  const rearmPersistentReads: number[] = [];
  let head = Pointer.readU32(loop.cqRing, loop.cqOff.head);
  const tail = Pointer.readU32(loop.cqRing, loop.cqOff.tail);
  const mask = Pointer.readU32(loop.cqRing, loop.cqOff.ring_mask);
  while (head !== tail) {
    const cqeBase = loop.cqOff.cqes + (head & mask) * 16;
    const userData = unpackUserData(Pointer.readU64(loop.cqRing, cqeBase));
    const res = Pointer.readI32(loop.cqRing, cqeBase + 8);
    // Determine which kind of completion this is so loop.mjs can dispatch it
    // the same way as a kqueue event (using filter constants).
    let filter;
    let ident = userData.ident;
    if (userData.kind === USER_DATA_TIMER) {
      loop.timerBufs.delete(ident);
      if (loop.canceledTimers.delete(ident)) {
        head++;
        continue;
      }
      filter = EVFILT_TIMER;
    } else if (userData.kind === USER_DATA_TIMER_CANCEL) {
      if (!loop.timerBufs.has(ident)) loop.canceledTimers.delete(ident);
      head++;
      continue;
    } else if (userData.kind === USER_DATA_WAIT_TIMER) {
      loop.waitTimerBufs.delete(ident);
      head++;
      continue;
    } else if (userData.kind === USER_DATA_FILE) {
      loop.fileBufs.delete(ident);
      filter = EVFILT_COMPLETION;
    } else if (userData.kind === USER_DATA_SIGNAL && loop.signalFdToSig.has(ident)) {
      // IORING_OP_POLL_ADD fired on a signalfd — drain and re-arm.
      const signo = loop.signalFdToSig.get(ident);
      if (signo === undefined) {
        head++;
        continue;
      }
      const infoBuf = new ArrayBuffer(SIGNALFD_SIGINFO_SIZE);
      lib.symbols.read(ident, infoBuf, SIGNALFD_SIGINFO_SIZE);
      // Re-arm POLL_ADD on the signalfd so the next signal is also caught.
      if (loop.signalFdToSig.has(ident)) {
        submitSqe(loop, IORING_OP_POLL_ADD, ident, 0, 0, 0, packUserData(USER_DATA_SIGNAL, ident), POLLIN);
      }
      filter = EVFILT_SIGNAL;
      ident = signo;
    } else if (userData.kind === USER_DATA_READ) {
      if (loop.persistentReads.has(ident)) {
        rearmPersistentReads.push(ident);
      }
      filter = EVFILT_READ;
    } else if (userData.kind === USER_DATA_WRITE) {
      filter = EVFILT_WRITE;
    } else {
      // Legacy/unexpected POLL_ADD completion — fall back to the poll mask.
      filter = res & POLLIN ? EVFILT_READ : EVFILT_WRITE;
    }
    events.push({
      ident,
      filter,
      flags: 0,
      res
    });
    head++;
  }
  // Advance the CQ head
  Pointer.writeU32(loop.cqRing, loop.cqOff.head, head);
  for (const fd of rearmPersistentReads) {
    submitSqe(loop, IORING_OP_POLL_ADD, fd, 0, 0, 0, packUserData(USER_DATA_READ, fd), POLLIN);
  }
  if (rearmPersistentReads.length > 0) submitPending(loop);
  return events;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
* Submit a one-shot poll for read readiness.
*
* The completion emits `EVFILT_READ` and returns `userData` as the event
* identifier. No explicit removal is needed after delivery.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.addRead(loop, fd, fd);
* ```
*
* @internal
*/
export function addRead(loop: IoUringLoop, fd: number, userData: number): void {
  submitSqe(loop, IORING_OP_POLL_ADD, fd, 0, 0, 0, packUserData(USER_DATA_READ, userData), POLLIN);
}
/**
* Submit a persistent read readiness watch.
*
* io_uring `POLL_ADD` is one-shot, so this backend re-arms the watch after
* every completion. The runtime uses this for wake pipes that must interrupt
* `io_uring_enter(GETEVENTS)` without counting as live application I/O.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.addPersistentRead(loop, fd, fd);
* ```
*
* @internal
*/
export function addPersistentRead(loop: IoUringLoop, fd: number, userData: number): void {
  loop.persistentReads.add(userData);
  submitSqe(loop, IORING_OP_POLL_ADD, fd, 0, 0, 0, packUserData(USER_DATA_READ, userData), POLLIN);
  submitPending(loop);
}
/**
* Submit a one-shot poll for write readiness.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.addWrite(loop, fd, fd);
* ```
*
* @internal
*/
export function addWrite(loop: IoUringLoop, fd: number, userData: number): void {
  submitSqe(loop, IORING_OP_POLL_ADD, fd, 0, 0, 0, packUserData(USER_DATA_WRITE, userData), POLLOUT);
}
/**
* No-op cancellation hook for read readiness.
*
* `IORING_OP_POLL_ADD` is one-shot in this backend, so no persistent read watch
* exists to remove.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.removeRead(loop, fd);
* ```
*
* @internal
*/
export function removeRead(loop: IoUringLoop, _fd: number): void {
  // POLL_ADD is one-shot by default in io_uring — no explicit removal needed.
  // For persistent watches, IORING_OP_POLL_REMOVE would be used here.
  loop.persistentReads.delete(_fd);
}
/**
* No-op cancellation hook for write readiness.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.removeWrite(loop, fd);
* ```
*
* @internal
*/
export function removeWrite(loop: IoUringLoop, _fd: number): void {
  void loop;
}
/**
* Watch `signo` for delivery to this process (Linux only, via signalfd).
* Fires repeatedly; each delivery re-arms POLL_ADD on the signalfd.
*
* Blocks the signal with sigprocmask so the default action (e.g. termination)
* does not take effect. The signalfd becomes readable when the signal arrives.
*
* `signo` is returned as `ident` in events.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.addSignal(loop, 15);
* ```
*/
export function addSignal(loop: IoUringLoop, signo: number): void {
  if (loop.signalFds.has(signo)) return;
  // Build glibc sigset_t: bit (signo-1) set.
  const sigset = new ArrayBuffer(GLIBC_SIGSET_SIZE);
  const sigsetView = new DataView(sigset);
  sigsetView.setBigUint64(0, 1n << BigInt(signo - 1), true);
  // Block the signal so it does not kill the process
  const maskRc = lib.symbols.sigprocmask(SIG_BLOCK, sigset, Pointer.null()) as number;
  if (maskRc !== 0) throw new Error(`sigprocmask failed: ${maskRc}`);
  // Create a signalfd for this signal (non-blocking, close-on-exec). Use the
  // libc wrapper instead of raw syscall numbers; signalfd4 differs across Linux
  // architectures.
  const fd = Number(lib.symbols.signalfd(-1, sigset, Number(SFD_NONBLOCK | SFD_CLOEXEC)));
  if (fd < 0) throw new Error(`signalfd4 failed: ${fd}`);
  loop.signalFds.set(signo, fd);
  loop.signalFdToSig.set(fd, signo);
  // Register POLL_ADD on the signalfd; userData = fd (used as drainCqes lookup key)
  submitSqe(loop, IORING_OP_POLL_ADD, fd, 0, 0, 0, packUserData(USER_DATA_SIGNAL, fd), POLLIN);
}
/**
* Remove signal watch for `signo` and close the signalfd.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.removeSignal(loop, 15);
* ```
*/
export function removeSignal(loop: IoUringLoop, signo: number): void {
  const fd = loop.signalFds.get(signo);
  if (fd === undefined) return;
  loop.signalFds.delete(signo);
  loop.signalFdToSig.delete(fd);
  lib.symbols.close(fd);
}
/**
* Add a one-shot timer. Fires after `ms` milliseconds.
* Uses IORING_OP_TIMEOUT with a __kernel_timespec stored as a JS ArrayBuffer.
* The buffer must remain alive until the timeout fires.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.addTimer(loop, 1, 100);
* ```
*/
export function addTimer(loop: IoUringLoop, id: number, ms: number): void {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  const sec = Math.floor(ms / 1e3);
  const nsec = ms % 1e3 * 1e6;
  view.setBigInt64(0, BigInt(sec), true);
  view.setBigInt64(8, BigInt(nsec), true);
  loop.timerBufs.set(id, buf);
  submitSqe(loop, IORING_OP_TIMEOUT, -1, Number(bufPtr(buf)), 1, 0, packUserData(USER_DATA_TIMER, id), 0);
}
/**
* Cancel a pending one-shot timer by its public timer id.
*
* io_uring timeout removal targets the original timeout by its SQE
* `user_data`, passed in the remove SQE's `addr` field. The original timeout
* still completes, usually with `-ECANCELED`; drainCqes suppresses that
* completion for callers that already canceled the JS timer.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.removeTimer(loop, 1);
* ```
*
* @internal
*/
export function removeTimer(loop: IoUringLoop, id: number): void {
  if (!loop.timerBufs.has(id)) return;
  loop.canceledTimers.add(id);
  submitSqe(loop, IORING_OP_TIMEOUT_REMOVE, -1, packUserData(USER_DATA_TIMER, id), 0, 0, packUserData(USER_DATA_TIMER_CANCEL, id), 0);
}
/**
* Non-blocking poll — return any immediately available completions.
*
* Submits queued SQEs before draining CQEs. Returns an empty array when no
* completions are ready.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* const events = uring.poll(loop);
* ```
*/
export function poll(loop: IoUringLoop): CqeEvent[] {
  submitPending(loop);
  return drainCqes(loop);
}
/**
* Blocking wait — block until at least 1 CQE is available or timeout expires.
* `timeoutMs = null` → block indefinitely.
*
* A finite timeout is implemented by submitting an internal timeout SQE. The
* returned array may include that timeout event.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* const events = uring.wait(loop, 50);
* ```
*/
export function wait(loop: IoUringLoop, timeoutMs: number | null = null): CqeEvent[] {
  if (timeoutMs !== null && timeoutMs <= 0) {
    return poll(loop);
  }
  // For timed waits: submit a timeout SQE then enter with min_complete=1.
  // For infinite waits: just enter with min_complete=1.
  if (timeoutMs !== null) {
    const waitTimerId = loop.nextWaitTimerId++;
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    const sec = Math.floor(timeoutMs / 1e3);
    const nsec = timeoutMs % 1e3 * 1e6;
    view.setBigInt64(0, BigInt(sec), true);
    view.setBigInt64(8, BigInt(nsec), true);
    loop.waitTimerBufs.set(waitTimerId, buf);
    submitSqe(loop, IORING_OP_TIMEOUT, -1, Number(bufPtr(buf)), 1, 0, packUserData(USER_DATA_WAIT_TIMER, waitTimerId), 0);
  }
  submitPending(loop);
  const ret = Number(syscall(SYS_IO_URING_ENTER, BigInt(loop.ringFd), 0n, 1n, IORING_ENTER_GETEVENTS));
  if (ret < 0) throw new Error(`io_uring_enter (wait) failed: ${ret}`);
  return drainCqes(loop);
}
// ---------------------------------------------------------------------------
// Async file I/O — IORING_OP_OPENAT / IORING_OP_READ / IORING_OP_CLOSE
// ---------------------------------------------------------------------------
// Each function registers its userData in loop.fileBufs so that drainCqes()
// emits EVFILT_COMPLETION for these completions (instead of EVFILT_READ/WRITE).
// The caller (loop.submit) maps the completion back to a Promise resolver.
/**
* Submit an async openat(2) via IORING_OP_OPENAT.
* @param {object} loop  Raw io_uring handle from create().
* @param {Uint8Array} pathBuf  Null-terminated C string; kept alive until completion.
* @param {number} flags  O_RDONLY / O_WRONLY | O_CREAT | O_TRUNC etc.
* @param {number} mode   File creation permissions (e.g. 0o666).
* @param {number} userData  Completion identifier assigned by loop.submit().
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.asyncOpen(loop, pathBuf, flags, 0o666, id);
* ```
*/
export function asyncOpen(loop: IoUringLoop, pathBuf: ArrayBuffer, flags: number, mode: number, userData: number): void {
  const addr = Number(bufPtr(pathBuf));
  loop.fileBufs.set(userData, [pathBuf]);
  // sqe->fd = AT_FDCWD, sqe->addr = path, sqe->len = mode,
  // sqe->off = 0 (unused), sqe->open_flags (union@+28) = flags
  submitSqe(loop, IORING_OP_OPENAT, AT_FDCWD, addr, mode, 0, packUserData(USER_DATA_FILE, userData), flags);
}
/**
* Submit an async read(2) via IORING_OP_READ at the current file position.
* @param {object} loop  Raw io_uring handle from create().
* @param {number} fd
* @param {ArrayBuffer} buf  Destination buffer; kept alive until completion.
* @param {number} len  Maximum bytes to read.
* @param {number} userData  Completion identifier assigned by loop.submit().
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.asyncRead(loop, fd, new ArrayBuffer(4096), 4096, id);
* ```
*/
export function asyncRead(loop: IoUringLoop, fd: number, buf: ArrayBuffer, len: number, userData: number): void {
  const addr = Number(bufPtr(buf));
  loop.fileBufs.set(userData, [buf]);
  // sqe->off = UINT64_MAX means "use current file position" (same as read(2))
  submitSqe(loop, IORING_OP_READ, fd, addr, len, IORING_READ_AT_CURPOS, packUserData(USER_DATA_FILE, userData), 0);
}
/**
* Submit an async close(2) via IORING_OP_CLOSE.
* @param {object} loop  Raw io_uring handle from create().
* @param {number} fd  File descriptor to close.
* @param {number} userData  Completion identifier assigned by loop.submit().
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.asyncClose(loop, fd, id);
* ```
*/
export function asyncClose(loop: IoUringLoop, fd: number, userData: number): void {
  loop.fileBufs.set(userData, []);
  submitSqe(loop, IORING_OP_CLOSE, fd, 0, 0, 0, packUserData(USER_DATA_FILE, userData), 0);
}
/**
* Unmap rings and close the ring fd. Also closes any open signalFds.
*
* The handle must not be used after destruction.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* uring.destroy(loop);
* ```
*/
export function destroy(loop: IoUringLoop): void {
  for (const fd of loop.signalFds.values()) {
    lib.symbols.close(fd);
  }
  lib.symbols.munmap(loop.sqRing, loop.sqRingSize);
  lib.symbols.munmap(loop.cqRing, loop.cqRingSize);
  lib.symbols.munmap(loop.sqes, loop.sqesSize);
  lib.symbols.close(loop.ringFd);
}
/**
* The io_uring ring fd. It polls readable when completion-queue entries are
* pending, so a parent loop can watch it to wake on this loop's activity.
*
* ```typescript no_run
* import * as uring from 'internal:runtime/io_uring';
* void uring.pollFd(loop);
* ```
*
* @internal
*/
export function pollFd(loop: IoUringLoop): number {
  return loop.ringFd;
}
