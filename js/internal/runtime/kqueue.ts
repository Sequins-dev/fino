/**
* internal:runtime/kqueue — low-level kqueue bindings for macOS/BSD.
*
* kqueue is the kernel event notification interface on macOS (and other BSDs).
* A kqueue fd is a file descriptor that the kernel fills with events as they
* become ready. You register interest in events via `kevent()` changesets, then
* wait for them with another `kevent()` call that blocks until events arrive.
*
* This module wraps `kqueue(2)` and `kevent(2)` via FFI (`fino:ffi`) and
* implements the common backend interface that `internal:runtime/loop`
* expects. It is only loaded on macOS; Linux uses `internal:runtime/io_uring`
* instead.
*
*
* ## struct kevent layout
*
* kqueue events are described by `struct kevent` (32 bytes on macOS 64-bit):
*
*   offset  0: ident  (uint64)  — identifier: fd for read/write, timer id for timers, pid for proc
*   offset  8: filter (int16)   — event type: EVFILT_READ, EVFILT_WRITE, EVFILT_TIMER, EVFILT_PROC
*   offset 10: flags  (uint16)  — EV_ADD / EV_DELETE / EV_ONESHOT / EV_EOF / EV_ERROR etc.
*   offset 12: fflags (uint32)  — filter-specific flags (e.g. NOTE_EXIT for EVFILT_PROC)
*   offset 16: data   (int64)   — filter-specific data (e.g. bytes available, timer ms)
*   offset 24: udata  (uint64)  — user-supplied opaque value, returned as-is in events
*
* We use `udata` to store the same value as `ident` (the fd or id) so that
* `internal:runtime/loop`'s dispatch table can use a single field to look up
* the resolver.
*
*
* ## How kevent() is called
*
* `kevent(kqFd, changelist, nchanges, eventlist, nevents, timeout)` is a
* dual-purpose syscall:
*   - Pass a non-empty changelist to *register* new interests (EV_ADD/EV_DELETE).
*   - Pass a non-null eventlist to *wait* for events (blocks up to `timeout`).
*   - Both can be combined in one call, but we split them for clarity.
*
* When registering changes, we pass `nchanges > 0` and `nevents = 0` with a
* zero timeout. When waiting, we pass `nchanges = 0` and `nevents = MAX_EVENTS`
* with the desired timeout (or null for infinite block).
*
*
* ## EV_ONESHOT for timers
*
* Timer events use `EV_ONESHOT` so the kernel auto-removes the event after it
* fires once. Without this flag, the timer would fire repeatedly. We also use
* `EV_ONESHOT` for `EVFILT_PROC` (process exit) since we only want one
* notification when the process exits. Read/write watches do NOT use EV_ONESHOT
* — they remain registered until explicitly removed, which allows
* `internal:runtime/loop` to re-arm them on the next `readable()`/`writable()`
* call.
*
*
* ## addProc race condition
*
* There is a race between a process exiting and the `EVFILT_PROC` filter being
* registered. If the process exits between `fork()` returning and our
* `kevent()` call, the kernel rejects the filter (returns an error). We detect
* this by checking the `kevent()` return value in `addProc()`: a negative
* return means the process already exited, so `addProc()` returns `false` and
* `internal:runtime/loop`'s `proc()` resolves immediately so the caller can
* proceed to `waitpid()`.
*
*
* ## struct timespec for timeout
*
* `kevent()`'s timeout parameter is a pointer to `struct timespec`:
*   { int64 tv_sec; int64 tv_nsec; }  (16 bytes, little-endian on arm64/x86_64)
* We build this with a DataView over an ArrayBuffer. Passing `null` for the
* timeout pointer means "block indefinitely".
*
*
* ## EV_ERROR in returned events
*
* When a changelist entry fails (e.g. bad fd), kqueue returns the failed change
* as an event with `EV_ERROR` set in `flags` and `errno` in `data`. We check
* for this in `kevent()` and throw an error rather than silently dropping it.
*
*
* ## Contributing
*
* - All constants (EVFILT_*, EV_*, NOTE_*) match the macOS `<sys/event.h>` values.
* - The `udata` field is written with the same value as `ident` everywhere. If
*   you need to distinguish multiple registrations for the same fd, you'd change
*   this — but `internal:runtime/loop` currently uses the fd itself as the map
*   key.
* - `MAX_EVENTS = 256` is a tunable. Higher values reduce syscall overhead for
*   high-connection servers at the cost of a larger stack-allocated buffer.
*
* ## Example
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
*
* const loop = kqueue.create();
* kqueue.addTimer(loop, 1, 10);
* const events = kqueue.wait(loop, 50);
* kqueue.destroy(loop);
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
/** Raw struct kevent fields as returned by readKevent(). */
interface Kevent {
  ident: number;
  filter: number;
  flags: number;
  fflags: number;
  data: number;
  udata: number;
}
/** Opaque kqueue loop handle returned by create(). */
interface KqueueLoop {
  fd: number;
}
const lib = dlopen('/usr/lib/libSystem.B.dylib', {
  kqueue: {
    parameters: [],
    result: 'i32'
  },
  kevent: {
    parameters: [
      'i32',
      'usize',
      'i32',
      'usize',
      'i32',
      'usize'
    ],
    result: 'i32'
  },
  close: {
    parameters: ['i32'],
    result: 'i32'
  },
  signal: {
    parameters: ['i32', 'usize'],
    result: 'usize'
  },
  __error: {
    parameters: [],
    result: 'pointer'
  }
});
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Kqueue read readiness filter.
* ```typescript no_run
* import { EVFILT_READ } from 'internal:runtime/kqueue';
* void EVFILT_READ;
* ```
* @internal */
const EVFILT_READ = -1;
/** Kqueue write readiness filter.
* ```typescript no_run
* import { EVFILT_WRITE } from 'internal:runtime/kqueue';
* void EVFILT_WRITE;
* ```
* @internal */
const EVFILT_WRITE = -2;
/** Kqueue timer filter.
* ```typescript no_run
* import { EVFILT_TIMER } from 'internal:runtime/kqueue';
* void EVFILT_TIMER;
* ```
* @internal */
const EVFILT_TIMER = -7;
/** Kqueue process-exit filter.
* ```typescript no_run
* import { EVFILT_PROC } from 'internal:runtime/kqueue';
* void EVFILT_PROC;
* ```
* @internal */
const EVFILT_PROC = -5;
/** Kqueue vnode filesystem-event filter.
* ```typescript no_run
* import { EVFILT_VNODE } from 'internal:runtime/kqueue';
* void EVFILT_VNODE;
* ```
* @internal */
const EVFILT_VNODE = -4;
/** Kqueue signal filter.
* ```typescript no_run
* import { EVFILT_SIGNAL } from 'internal:runtime/kqueue';
* void EVFILT_SIGNAL;
* ```
* @internal */
const EVFILT_SIGNAL = -6;
const EV_ADD = 1;
const EV_DELETE = 2;
const EV_ENABLE = 4;
// const EV_DISABLE = 0x0008;
const EV_ONESHOT = 16;
const EV_CLEAR = 32;
/** Kqueue returned-event EOF flag.
* ```typescript no_run
* import { EV_EOF } from 'internal:runtime/kqueue';
* void EV_EOF;
* ```
* @internal */
const EV_EOF = 32768;
/** Kqueue returned-event error flag.
* ```typescript no_run
* import { EV_ERROR } from 'internal:runtime/kqueue';
* void EV_ERROR;
* ```
* @internal */
const EV_ERROR = 16384;
// POSIX errno values
const EINTR = 4;
const ENOENT = 2;
const EBADF = 9;
// EVFILT_TIMER fflags: treat `data` as milliseconds by default.
// NOTE_NSECONDS would give nanosecond precision; we use ms for simplicity.
const NOTE_MSECONDS = 1024;
// EVFILT_PROC fflags
const NOTE_EXIT = 2147483648;
// EVFILT_VNODE fflags — which filesystem events to watch for.
// Multiple flags can be OR'd together.
/**
* Vnode flag emitted when the watched file or directory is deleted.
*
* ```typescript no_run
* import { NOTE_DELETE } from 'internal:runtime/kqueue';
* void NOTE_DELETE;
* ```
*
* @internal
*/
export const NOTE_DELETE = 1;
/**
* Vnode flag emitted when file data changes or directory entries change.
*
* ```typescript no_run
* import { NOTE_WRITE } from 'internal:runtime/kqueue';
* void NOTE_WRITE;
* ```
*
* @internal
*/
export const NOTE_WRITE = 2;
/**
* Vnode flag emitted when file size increases.
*
* ```typescript no_run
* import { NOTE_EXTEND } from 'internal:runtime/kqueue';
* void NOTE_EXTEND;
* ```
*
* @internal
*/
export const NOTE_EXTEND = 4;
/**
* Vnode flag emitted when metadata changes.
*
* ```typescript no_run
* import { NOTE_ATTRIB } from 'internal:runtime/kqueue';
* void NOTE_ATTRIB;
* ```
*
* @internal
*/
export const NOTE_ATTRIB = 8;
/**
* Vnode flag emitted when link count changes.
*
* ```typescript no_run
* import { NOTE_LINK } from 'internal:runtime/kqueue';
* void NOTE_LINK;
* ```
*
* @internal
*/
export const NOTE_LINK = 16;
/**
* Vnode flag emitted when the watched path is renamed.
*
* ```typescript no_run
* import { NOTE_RENAME } from 'internal:runtime/kqueue';
* void NOTE_RENAME;
* ```
*
* @internal
*/
export const NOTE_RENAME = 32;
/**
* Vnode flag emitted when access is revoked, such as unmount.
*
* ```typescript no_run
* import { NOTE_REVOKE } from 'internal:runtime/kqueue';
* void NOTE_REVOKE;
* ```
*
* @internal
*/
export const NOTE_REVOKE = 64;
const KEVENT_SIZE = 32;
const MAX_EVENTS = 256;
const MAX_PENDING = 64;
// ---------------------------------------------------------------------------
// Pre-allocated shared buffers (safe: all kqueue calls are synchronous)
// ---------------------------------------------------------------------------
const _changeBuf = new ArrayBuffer(KEVENT_SIZE);
const _changeView = new DataView(_changeBuf);
const _pendingBuf = new ArrayBuffer(KEVENT_SIZE * MAX_PENDING);
const _pendingView = new DataView(_pendingBuf);
let _pendingCount = 0;
const _eventBuf = new ArrayBuffer(KEVENT_SIZE * MAX_EVENTS);
const _eventView = new DataView(_eventBuf);
const _zeroTs = new ArrayBuffer(16);
const _tsBuf = new ArrayBuffer(16);
const _tsView = new DataView(_tsBuf);
const _changePtr = Pointer.addr(_changeBuf);
const _pendingPtr = Pointer.addr(_pendingBuf);
const _eventPtr = Pointer.addr(_eventBuf);
const _zeroTsPtr = Pointer.addr(_zeroTs);
const _tsPtr = Pointer.addr(_tsBuf);
const _errnoPtr = lib.symbols.__error();
const U32_FACTOR = 4294967296;
// ---------------------------------------------------------------------------
// Struct helpers
// ---------------------------------------------------------------------------
/**
* Write one struct kevent at `index` in the given DataView.
*
* struct kevent layout (macOS 64-bit, 32 bytes total):
*   offset  0: ident  (uint64, 8 bytes)
*   offset  8: filter (int16,  2 bytes)
*   offset 10: flags  (uint16, 2 bytes)
*   offset 12: fflags (uint32, 4 bytes)
*   offset 16: data   (int64,  8 bytes)
*   offset 24: udata  (uint64, 8 bytes)  — we store our userData here as a number
*/
function writeKevent(view: DataView, index: number, ident: number, filter: number, flags: number, fflags: number, data: number, udata: number): void {
  const base = index * KEVENT_SIZE;
  writeU64(view, base + 0, ident);
  view.setInt16(base + 8, filter, true);
  view.setUint16(base + 10, flags, true);
  view.setUint32(base + 12, fflags, true);
  writeI64(view, base + 16, data);
  writeU64(view, base + 24, udata);
}
/**
* Read one struct kevent from `index` in the given DataView.
*/
function readKevent(view: DataView, index: number): Kevent {
  const base = index * KEVENT_SIZE;
  return {
    ident: readU64(view, base + 0),
    filter: view.getInt16(base + 8, true),
    flags: view.getUint16(base + 10, true),
    fflags: view.getUint32(base + 12, true),
    data: readI64(view, base + 16),
    udata: readU64(view, base + 24)
  };
}
function writeU64(view: DataView, offset: number, value: number): void {
  const lo = value >>> 0;
  const hi = Math.floor(value / U32_FACTOR) >>> 0;
  view.setUint32(offset, lo, true);
  view.setUint32(offset + 4, hi, true);
}
function writeI64(view: DataView, offset: number, value: number): void {
  const lo = value >>> 0;
  const hi = Math.floor(value / U32_FACTOR);
  view.setUint32(offset, lo, true);
  view.setInt32(offset + 4, hi, true);
}
function readU64(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * U32_FACTOR + lo;
}
function readI64(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getInt32(offset + 4, true);
  return hi * U32_FACTOR + lo;
}
/**
* Build a struct timespec ArrayBuffer from a millisecond timeout.
*
* Passing `null` returns `null` so the caller hands a null pointer to
* `kevent()`, meaning "block indefinitely". A zero timeout returns the shared
* pre-zeroed `_zeroTs` buffer for non-blocking polls. Any other value is split
* into whole seconds and remaining nanoseconds written into the reusable
* `_tsBuf`.
*/
function makeTimespec(ms: number | null): ArrayBuffer | null {
  if (ms === null) return null;
  if (ms === 0) return _zeroTs;
  const sec = Math.floor(ms / 1e3);
  const nsec = ms % 1e3 * 1e6;
  writeI64(_tsView, 0, sec);
  writeI64(_tsView, 8, nsec);
  return _tsBuf;
}
function errno(): number {
  return Pointer.readI32(_errnoPtr, 0);
}
// ---------------------------------------------------------------------------
// kevent wrapper — registers changes and/or waits for events
// ---------------------------------------------------------------------------
/**
* Call `kevent()` on `kqFd`, optionally registering changes and waiting for events.
*
* `changeBuf` is the changelist to register (or `null` for none) and `nChanges`
* its entry count; `timeoutBuf` is a struct timespec buffer (or `null` to block
* indefinitely). The reads always target the shared `_eventBuf`, so the returned
* array is a fresh decode of the triggered events.
*
* Retries transparently on `EINTR` — a signal that interrupts the wait before
* the timeout elapses. Entries flagged `EV_ERROR` are inspected: benign errno
* values (`ENOENT`, `EBADF` from an fd whose filter the kernel already removed)
* are skipped, while any other change error is thrown. Throws if the syscall
* itself fails with a non-`EINTR` errno.
*/
function kevent(kqFd: number, changeBuf: ArrayBuffer | null, nChanges: number, timeoutBuf: ArrayBuffer | null): Kevent[] {
  const changePtr = changeBuf === null ? 0n : changeBuf === _pendingBuf ? _pendingPtr : _changePtr;
  const timeoutPtr = timeoutBuf === null ? 0n : timeoutBuf === _zeroTs ? _zeroTsPtr : _tsPtr;
  let n: number;
  // Retry on EINTR — a signal interrupted the wait; the timeout has not elapsed.
  do {
    n = lib.symbols.kevent(kqFd, changePtr, nChanges, _eventPtr, MAX_EVENTS, timeoutPtr);
  } while (n < 0 && errno() === EINTR);
  if (n < 0) {
    throw new Error(`kevent failed: errno=${errno()}`);
  }
  const events = [];
  for (let i = 0; i < n; i++) {
    const ev = readKevent(_eventView, i);
    // EV_ERROR in flags means the change failed, not a real event.
    if (ev.flags & EV_ERROR) {
      // ENOENT: filter already removed (fd closed, kernel auto-removed it).
      // EBADF: fd closed before EV_DELETE was processed. Both are benign.
      if (ev.data === ENOENT || ev.data === EBADF) continue;
      throw new Error(`kevent change error: errno=${ev.data} for ident=${ev.ident}`);
    }
    events.push(ev);
  }
  return events;
}
/**
* Register one or more changes without waiting for events.
*/
function registerChanges(kqFd: number, changeBuf: ArrayBuffer, nChanges: number): void {
  const changePtr = changeBuf === _pendingBuf ? _pendingPtr : _changePtr;
  const n = lib.symbols.kevent(kqFd, changePtr, nChanges, 0n, 0, _zeroTsPtr);
  if (n < 0) {
    const err = errno();
    // ENOENT: filter was already removed (e.g. fd closed, kernel auto-removed it).
    // EBADF: fd already closed before EV_DELETE was issued. Both are benign.
    if (err !== ENOENT && err !== EBADF) {
      throw new Error(`kevent register failed: errno=${err}`);
    }
  }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
* Create a new kqueue event loop handle.
*
* The returned handle owns a kqueue fd and must be passed to `destroy` when the
* backend is torn down.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* const loop = kqueue.create();
* kqueue.destroy(loop);
* ```
*/
export function create(): KqueueLoop {
  const fd = lib.symbols.kqueue();
  if (fd < 0) throw new Error(`kqueue() failed: ${fd}`);
  return { fd };
}
/**
* The kqueue fd itself. A kqueue fd polls readable when it has pending
* events, so a parent loop can watch it to wake on this loop's I/O and
* timer activity.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* const loop = kqueue.create();
* void kqueue.pollFd(loop);
* ```
*
* @internal
*/
export function pollFd(loop: KqueueLoop): number {
  return loop.fd;
}
/**
* Queue a struct kevent into the pending-changes buffer.
* If the buffer is full, flush it immediately to the kqueue.
*/
function queueChange(loop: KqueueLoop, ident: number, filter: number, flags: number, fflags: number, data: number, udata: number): void {
  if (_pendingCount >= MAX_PENDING) {
    // Flush pending changes before adding more.
    registerChanges(loop.fd, _pendingBuf, _pendingCount);
    _pendingCount = 0;
  }
  writeKevent(_pendingView, _pendingCount++, ident, filter, flags, fflags, data, udata);
}
/**
* Watch `fd` for read readiness (one-shot — auto-removed after delivery).
* `userData` is a number returned with the event.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.addRead(loop, fd, fd);
* ```
*/
export function addRead(loop: KqueueLoop, fd: number, userData: number): void {
  queueChange(loop, fd, EVFILT_READ, EV_ADD | EV_ENABLE | EV_ONESHOT, 0, 0, userData);
}
/**
* Watch `fd` for write readiness (one-shot — auto-removed after delivery).
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.addWrite(loop, fd, fd);
* ```
*/
export function addWrite(loop: KqueueLoop, fd: number, userData: number): void {
  queueChange(loop, fd, EVFILT_WRITE, EV_ADD | EV_ENABLE | EV_ONESHOT, 0, 0, userData);
}
/**
* Watch `fd` for read readiness persistently (EV_CLEAR — not oneshot).
* Fires each time data arrives; does not auto-remove after delivery.
* Used for background wake sources that must not be counted as live I/O
* for the loop's `alive()` check.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.addPersistentRead(loop, fd, fd);
* ```
*/
export function addPersistentRead(loop: KqueueLoop, fd: number, userData: number): void {
  queueChange(loop, fd, EVFILT_READ, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, userData);
}
/**
* Explicitly cancel a read watch for `fd` (e.g. on connection close before event fires).
* Queued as a pending change so it batches with the next wait().
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.removeRead(loop, fd);
* ```
*/
export function removeRead(loop: KqueueLoop, fd: number): void {
  queueChange(loop, fd, EVFILT_READ, EV_DELETE, 0, 0, 0);
}
/**
* Explicitly cancel a write watch for `fd`.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.removeWrite(loop, fd);
* ```
*/
export function removeWrite(loop: KqueueLoop, fd: number): void {
  queueChange(loop, fd, EVFILT_WRITE, EV_DELETE, 0, 0, 0);
}
/**
* Add a one-shot timer. Fires after `ms` milliseconds.
* `id` is returned as `ident` in the event.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.addTimer(loop, 1, 100);
* ```
*/
export function addTimer(loop: KqueueLoop, id: number, ms: number): void {
  // data = ms when no NOTE_* fflag is set (default unit is milliseconds on macOS)
  queueChange(loop, id, EVFILT_TIMER, EV_ADD | EV_ENABLE | EV_ONESHOT, 0, ms, id);
}
/**
* Cancel a pending timer. Queued as a pending change so it batches with the next wait().
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.removeTimer(loop, 1);
* ```
*/
export function removeTimer(loop: KqueueLoop, id: number): void {
  queueChange(loop, id, EVFILT_TIMER, EV_DELETE, 0, 0, 0);
}
/**
* Watch `pid` for exit. Fires exactly once when the process exits.
* `userData` is returned as `ident` in the event.
*
* Returns `true` if the filter was registered successfully, `false` if the
* process has already exited (kevent returns an error in that case). The
* caller is responsible for handling the already-exited case.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* const watching = kqueue.addProc(loop, pid, pid);
* ```
*/
export function addProc(loop: KqueueLoop, pid: number, userData: number): boolean {
  writeKevent(_changeView, 0, pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, userData);
  const n = lib.symbols.kevent(loop.fd, _changePtr, 1, 0n, 0, _zeroTsPtr);
  return n >= 0;
}
/**
* Remove a process watch for `pid`.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.removeProc(loop, pid);
* ```
*/
export function removeProc(loop: KqueueLoop, pid: number): void {
  writeKevent(_changeView, 0, pid, EVFILT_PROC, EV_DELETE, 0, 0, 0);
  registerChanges(loop.fd, _changeBuf, 1);
}
/**
* Non-blocking poll — returns any events immediately available.
*
* Flushes no pending changes; use `wait` to combine pending changes with a
* blocking or timed wait.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* const events = kqueue.poll(loop);
* ```
*/
export function poll(loop: KqueueLoop): Kevent[] {
  return kevent(loop.fd, null, 0, makeTimespec(0));
}
/**
* Blocking wait — blocks until events arrive or `timeoutMs` elapses.
* Flushes any pending add/remove changes in the same syscall.
* Pass `null` to block indefinitely.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* const events = kqueue.wait(loop, 50);
* ```
*/
export function wait(loop: KqueueLoop, timeoutMs: number | null = null): Kevent[] {
  const changes = _pendingCount;
  const changeBuf = changes > 0 ? _pendingBuf : null;
  _pendingCount = 0;
  return kevent(loop.fd, changeBuf, changes, makeTimespec(timeoutMs));
}
/**
* Watch `fd` for filesystem events (EVFILT_VNODE). Fires repeatedly via EV_CLEAR.
*
* `fflags` is a bitmask of NOTE_* values indicating which events to watch:
*   NOTE_DELETE | NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB | NOTE_LINK | NOTE_RENAME | NOTE_REVOKE
*
* Unlike read/write/timer watches, vnode watches are *persistent* — they
* continue firing after each event because EV_CLEAR re-arms the filter.
* Call `removeVnode()` to explicitly stop watching.
*
* The `fd` must remain open for as long as the watch is active. Closing the
* fd automatically removes the filter from kqueue.
*
* `userData` is returned as `udata` in events (used by internal:runtime/loop
* to look up the callback via the fd).
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.addVnode(loop, fd, kqueue.NOTE_WRITE | kqueue.NOTE_RENAME, fd);
* ```
*/
export function addVnode(loop: KqueueLoop, fd: number, fflags: number, userData: number): void {
  writeKevent(_changeView, 0, fd, EVFILT_VNODE, EV_ADD | EV_ENABLE | EV_CLEAR, fflags, 0, userData);
  registerChanges(loop.fd, _changeBuf, 1);
}
/**
* Remove a vnode watch for `fd`.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.removeVnode(loop, fd);
* ```
*/
export function removeVnode(loop: KqueueLoop, fd: number): void {
  writeKevent(_changeView, 0, fd, EVFILT_VNODE, EV_DELETE, 0, 0, 0);
  // Ignore errors — the fd may already be closed or the filter removed.
  lib.symbols.kevent(loop.fd, _changePtr, 1, 0n, 0, _zeroTsPtr);
}
// SIG_IGN sentinel: override default signal disposition so the process is not
// killed and kqueue EVFILT_SIGNAL can deliver the event.
const SIG_IGN = 1;
const SIG_DFL = 0;
/**
* Watch `signo` for delivery to this process (macOS only, via EVFILT_SIGNAL).
* Fires repeatedly via EV_CLEAR each time the signal is received.
*
* Also overrides the signal's disposition to SIG_IGN so the default action
* (e.g. process termination for SIGTERM/SIGINT) does not take effect.
* The kqueue filter still fires even with SIG_IGN set.
*
* `signo` is returned as `ident` in events.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.addSignal(loop, 15);
* ```
*/
export function addSignal(loop: KqueueLoop, signo: number): void {
  // Suppress default disposition so the process is not killed.
  lib.symbols.signal(signo, SIG_IGN);
  writeKevent(_changeView, 0, signo, EVFILT_SIGNAL, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, signo);
  registerChanges(loop.fd, _changeBuf, 1);
}
/**
* Remove signal watch for `signo` and restore default disposition.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.removeSignal(loop, 15);
* ```
*/
export function removeSignal(loop: KqueueLoop, signo: number): void {
  lib.symbols.signal(signo, SIG_DFL);
  writeKevent(_changeView, 0, signo, EVFILT_SIGNAL, EV_DELETE, 0, 0, 0);
  // Ignore errors — if the filter was never registered this is a no-op.
  lib.symbols.kevent(loop.fd, _changePtr, 1, 0n, 0, _zeroTsPtr);
}
/**
* Close the kqueue file descriptor and release resources.
*
* The handle must not be used after destruction.
*
* ```typescript no_run
* import * as kqueue from 'internal:runtime/kqueue';
* kqueue.destroy(loop);
* ```
*/
export function destroy(loop: KqueueLoop): void {
  lib.symbols.close(loop.fd);
}
export { EV_EOF, EV_ERROR, EVFILT_READ, EVFILT_WRITE, EVFILT_TIMER, EVFILT_PROC, EVFILT_VNODE, EVFILT_SIGNAL };
