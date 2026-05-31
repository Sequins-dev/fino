/**
 * fino:kqueue — low-level kqueue bindings for macOS/BSD.
 *
 * kqueue is the kernel event notification interface on macOS (and other BSDs).
 * A kqueue fd is a file descriptor that the kernel fills with events as they
 * become ready. You register interest in events via `kevent()` changesets, then
 * wait for them with another `kevent()` call that blocks until events arrive.
 *
 * This module wraps `kqueue(2)` and `kevent(2)` via FFI (`fino:ffi`) and
 * implements the common backend interface that `fino:loop` expects. It is
 * only loaded on macOS; Linux uses `fino:io_uring` instead.
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
 * `fino:loop`'s dispatch table can use a single field to look up the resolver.
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
 * — they remain registered until explicitly removed, which allows `fino:loop`
 * to re-arm them on the next `readable()`/`writable()` call.
 *
 *
 * ## addProc race condition
 *
 * There is a race between a process exiting and the `EVFILT_PROC` filter being
 * registered. If the process exits between `fork()` returning and our
 * `kevent()` call, the kernel rejects the filter (returns an error). We detect
 * this by checking the `kevent()` return value in `addProc()`: a negative
 * return means the process already exited, so `addProc()` returns `false` and
 * `fino:loop`'s `proc()` resolves immediately so the caller can proceed to
 * `waitpid()`.
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
 *   this — but `fino:loop` currently uses the fd itself as the map key.
 * - `MAX_EVENTS = 256` is a tunable. Higher values reduce syscall overhead for
 *   high-connection servers at the cost of a larger stack-allocated buffer.
 *
 * @internal
 */

import { dlopen, Pointer } from 'fino:ffi';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw struct kevent fields as returned by readKevent(). */
interface Kevent {
  ident:  number;
  filter: number;
  flags:  number;
  fflags: number;
  data:   number;
  udata:  number;
}

/** Opaque kqueue loop handle returned by create(). */
interface KqueueLoop {
  fd: number;
}

const lib = dlopen('/usr/lib/libSystem.B.dylib', {
  kqueue:   { parameters: [], result: 'i32' },
  kevent:   { parameters: ['i32', 'usize', 'i32', 'usize', 'i32', 'usize'], result: 'i32' },
  close:    { parameters: ['i32'], result: 'i32' },
  // signal(int signo, void (*func)(int)) — treat func as usize for SIG_IGN (1) / SIG_DFL (0)
  signal:   { parameters: ['i32', 'usize'], result: 'usize' },
  // __error() returns a pointer to the thread-local errno value (macOS).
  __error:  { parameters: [], result: 'pointer' },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVFILT_READ   = -1;
const EVFILT_WRITE  = -2;
const EVFILT_TIMER  = -7;
const EVFILT_PROC   = -5;
const EVFILT_VNODE  = -4;
const EVFILT_SIGNAL = -6;

const EV_ADD     = 0x0001;
const EV_DELETE  = 0x0002;
const EV_ENABLE  = 0x0004;
// const EV_DISABLE = 0x0008;
const EV_ONESHOT = 0x0010;
const EV_CLEAR   = 0x0020; // auto-re-arm after delivery (used for EVFILT_VNODE)
const EV_EOF     = 0x8000;
const EV_ERROR   = 0x4000;

// POSIX errno values
const EINTR  = 4;   // Interrupted by signal — retry
const ENOENT = 2;   // No such file or directory — e.g. EV_DELETE on already-removed filter
const EBADF  = 9;   // Bad file descriptor — e.g. fd already closed

// EVFILT_TIMER fflags: treat `data` as milliseconds by default.
// NOTE_NSECONDS would give nanosecond precision; we use ms for simplicity.
const NOTE_MSECONDS = 0x00000400; // macOS 10.12+

// EVFILT_PROC fflags
const NOTE_EXIT = 0x80000000;

// EVFILT_VNODE fflags — which filesystem events to watch for.
// Multiple flags can be OR'd together.
export const NOTE_DELETE = 0x00000001; // file/dir was deleted (unlink/rmdir)
export const NOTE_WRITE  = 0x00000002; // file was written; for dirs: an entry was added/removed
export const NOTE_EXTEND = 0x00000004; // file size increased
export const NOTE_ATTRIB = 0x00000008; // file attributes changed (permissions, timestamps)
export const NOTE_LINK   = 0x00000010; // link count changed
export const NOTE_RENAME = 0x00000020; // file/dir was renamed
export const NOTE_REVOKE = 0x00000040; // access was revoked (e.g. unmount)

const KEVENT_SIZE    = 32;   // sizeof(struct kevent) on macOS 64-bit
const MAX_EVENTS     = 256;  // max events returned per kevent() call
const MAX_PENDING    = 64;   // max changes batched into a single wait() call

// ---------------------------------------------------------------------------
// Pre-allocated shared buffers (safe: all kqueue calls are synchronous)
// ---------------------------------------------------------------------------

const _changeBuf  = new ArrayBuffer(KEVENT_SIZE);                    // single-change for immediate registrations
const _changeView = new DataView(_changeBuf);
const _pendingBuf  = new ArrayBuffer(KEVENT_SIZE * MAX_PENDING);     // batched changes for wait()
const _pendingView = new DataView(_pendingBuf);
let   _pendingCount = 0;                                             // number of entries queued in _pendingBuf
const _eventBuf   = new ArrayBuffer(KEVENT_SIZE * MAX_EVENTS);       // event wait output
const _eventView  = new DataView(_eventBuf);
const _zeroTs     = new ArrayBuffer(16);                        // timespec{0,0} — zero-timeout
const _tsBuf      = new ArrayBuffer(16);                        // reusable timespec for non-zero timeouts
const _tsView     = new DataView(_tsBuf);
const _changePtr  = Pointer.addr(_changeBuf);
const _pendingPtr = Pointer.addr(_pendingBuf);
const _eventPtr   = Pointer.addr(_eventBuf);
const _zeroTsPtr  = Pointer.addr(_zeroTs);
const _tsPtr      = Pointer.addr(_tsBuf);
const _errnoPtr   = lib.symbols.__error();

const U32_FACTOR = 0x1_0000_0000;

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
  view.setInt16   (base + 8,  filter,          true);
  view.setUint16  (base + 10, flags,           true);
  view.setUint32  (base + 12, fflags,          true);
  writeI64(view, base + 16, data);
  writeU64(view, base + 24, udata);
}

/**
 * Read one struct kevent from `index` in the given DataView.
 */
function readKevent(view: DataView, index: number): Kevent {
  const base = index * KEVENT_SIZE;
  return {
    ident:  readU64(view, base + 0),
    filter: view.getInt16(base + 8,  true),
    flags:  view.getUint16(base + 10, true),
    fflags: view.getUint32(base + 12, true),
    data:   readI64(view, base + 16),
    udata:  readU64(view, base + 24),
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
 * Build a struct timespec ArrayBuffer.
 * @param {number|null} ms  null → pass as null to kevent (infinite block)
 */
function makeTimespec(ms: number | null): ArrayBuffer | null {
  if (ms === null) return null;
  if (ms === 0) return _zeroTs;
  const sec  = Math.floor(ms / 1000);
  const nsec = (ms % 1000) * 1_000_000;
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
 * Call kevent(). Returns array of triggered events.
 *
 * @param {number}      kqFd        kqueue file descriptor
 * @param {ArrayBuffer|null} changeBuf   changelist buffer (or null)
 * @param {number}      nChanges    number of entries in changeBuf
 * @param {ArrayBuffer|null} timeoutBuf  struct timespec (or null for infinite)
 * @returns {Array<{ident,filter,flags,fflags,data,udata}>}
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
 */
export function create(): KqueueLoop {
  const fd = lib.symbols.kqueue();
  if (fd < 0) throw new Error(`kqueue() failed: ${fd}`);
  return { fd };
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
 */
export function addRead(loop: KqueueLoop, fd: number, userData: number): void {
  queueChange(loop, fd, EVFILT_READ, EV_ADD | EV_ENABLE | EV_ONESHOT, 0, 0, userData);
}

/**
 * Watch `fd` for write readiness (one-shot — auto-removed after delivery).
 */
export function addWrite(loop: KqueueLoop, fd: number, userData: number): void {
  queueChange(loop, fd, EVFILT_WRITE, EV_ADD | EV_ENABLE | EV_ONESHOT, 0, 0, userData);
}

/**
 * Watch `fd` for read readiness persistently (EV_CLEAR — not oneshot).
 * Fires each time data arrives; does not auto-remove after delivery.
 * Used for background wake sources that must not be counted as live I/O
 * for the loop's `alive()` check.
 */
export function addPersistentRead(loop: KqueueLoop, fd: number, userData: number): void {
  queueChange(loop, fd, EVFILT_READ, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, userData);
}

/**
 * Explicitly cancel a read watch for `fd` (e.g. on connection close before event fires).
 * Queued as a pending change so it batches with the next wait().
 */
export function removeRead(loop: KqueueLoop, fd: number): void {
  queueChange(loop, fd, EVFILT_READ, EV_DELETE, 0, 0, 0);
}

/**
 * Explicitly cancel a write watch for `fd`.
 */
export function removeWrite(loop: KqueueLoop, fd: number): void {
  queueChange(loop, fd, EVFILT_WRITE, EV_DELETE, 0, 0, 0);
}

/**
 * Add a one-shot timer. Fires after `ms` milliseconds.
 * `id` is returned as `ident` in the event.
 */
export function addTimer(loop: KqueueLoop, id: number, ms: number): void {
  // data = ms when no NOTE_* fflag is set (default unit is milliseconds on macOS)
  queueChange(loop, id, EVFILT_TIMER, EV_ADD | EV_ENABLE | EV_ONESHOT, 0, ms, id);
}

/**
 * Cancel a pending timer. Queued as a pending change so it batches with the next wait().
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
 */
export function addProc(loop: KqueueLoop, pid: number, userData: number): boolean {
  writeKevent(_changeView, 0, pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, userData);
  const n = lib.symbols.kevent(loop.fd, _changePtr, 1, 0n, 0, _zeroTsPtr);
  return n >= 0;
}

/**
 * Remove a process watch for `pid`.
 */
export function removeProc(loop: KqueueLoop, pid: number): void {
  writeKevent(_changeView, 0, pid, EVFILT_PROC, EV_DELETE, 0, 0, 0);
  registerChanges(loop.fd, _changeBuf, 1);
}

/**
 * Non-blocking poll — returns any events immediately available.
 */
export function poll(loop: KqueueLoop): Kevent[] {
  return kevent(loop.fd, null, 0, makeTimespec(0));
}

/**
 * Blocking wait — blocks until events arrive or `timeoutMs` elapses.
 * Flushes any pending add/remove changes in the same syscall.
 * Pass `null` to block indefinitely.
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
 * `userData` is returned as `udata` in events (used by fino:loop to look
 * up the callback via the fd).
 */
export function addVnode(loop: KqueueLoop, fd: number, fflags: number, userData: number): void {
  writeKevent(_changeView, 0, fd, EVFILT_VNODE, EV_ADD | EV_ENABLE | EV_CLEAR, fflags, 0, userData);
  registerChanges(loop.fd, _changeBuf, 1);
}

/**
 * Remove a vnode watch for `fd`.
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
 */
export function addSignal(loop: KqueueLoop, signo: number): void {
  // Suppress default disposition so the process is not killed.
  lib.symbols.signal(signo, SIG_IGN);
  writeKevent(_changeView, 0, signo, EVFILT_SIGNAL, EV_ADD | EV_ENABLE | EV_CLEAR, 0, 0, signo);
  registerChanges(loop.fd, _changeBuf, 1);
}

/**
 * Remove signal watch for `signo` and restore default disposition.
 */
export function removeSignal(loop: KqueueLoop, signo: number): void {
  lib.symbols.signal(signo, SIG_DFL);
  writeKevent(_changeView, 0, signo, EVFILT_SIGNAL, EV_DELETE, 0, 0, 0);
  // Ignore errors — if the filter was never registered this is a no-op.
  lib.symbols.kevent(loop.fd, _changePtr, 1, 0n, 0, _zeroTsPtr);
}

/**
 * Close the kqueue file descriptor and release resources.
 */
export function destroy(loop: KqueueLoop): void {
  lib.symbols.close(loop.fd);
}

export { EV_EOF, EV_ERROR, EVFILT_READ, EVFILT_WRITE, EVFILT_TIMER, EVFILT_PROC, EVFILT_VNODE, EVFILT_SIGNAL };
