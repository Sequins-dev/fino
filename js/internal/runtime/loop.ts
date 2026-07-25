/**
 * internal:runtime/loop — global event loop singleton.
 *
 * An ordinary realm creates one kqueue/io_uring backend handle when this module
 * loads and keeps it for the realm lifetime. Scheduler-hosted isolates instead
 * omit that private backend and delegate descriptor readiness to their host
 * loop, so they never need a second poller merely to await `EAGAIN`.
 *
 *
 * ## API
 *
 * ```ts no_run
 *   import * as loop from 'internal:runtime/loop';
 *
 *   await loop.readable(fd);   // resolves when fd is readable
 *   await loop.writable(fd);   // resolves when fd is writable
 *   await loop.timeout(500);   // resolves after 500 ms
 * ```
 *
 *
 * ## Synchronous spinning — spin() and run()
 *
 * `spin(promise)` blocks the current call stack, polling the loop until the
 * promise settles:
 *
 * ```ts no_run
 *   const result = loop.spin(someAsyncFn());
 * ```
 *
 * `run(fn)` is a convenience that calls `fn`, and if it returns a promise,
 * spins to completion:
 *
 * ```ts no_run
 *   const result = loop.run(async () => {
 *     return await fetch('https://example.com');
 *   });
 * ```
 *
 *
 * ## Backend release contract
 *
 * The common contract across supported backends is readiness watches,
 * timers, wake sources, signal delivery where available, and synchronous
 * `spin()` / `run()` driving. The selected backend is intentionally internal:
 *
 * - macOS uses kqueue, including `proc()` and `vnode()` support. Generic
 *   `submit()` completions are not available there.
 * - Linux first tries io_uring for readiness, timers, signals, and completion
 *   events. If `io_uring_setup(2)` is denied by the kernel or sandbox, the
 *   selector falls back to poll(2).
 * - The Linux poll fallback preserves the loop contract for readiness, timers,
 *   signals, and completion events, but file completions are queued
 *   synchronously rather than performed by kernel async I/O.
 *
 * Platform-only APIs fail explicitly when their backend cannot provide them:
 * `proc()` and `vnode()` are macOS-only, while `submit()` requires a completion
 * backend.
 *
 *
 * ## AbortSignal support
 *
 * `spin(promise, { signal })` and `run(fn, { signal })` both accept an
 * AbortSignal. If the signal fires, the spin exits early with the signal's
 * abort reason as the thrown value.
 *
 * @internal
 */
import { drainMicrotasks, hasPendingV8Tasks } from 'internal:async-context';
import * as backend from 'internal:runtime/loop-backend';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** kqueue/io_uring event shape dispatched to the loop. */
interface LoopEvent {
  ident: number;
  filter: number;
  flags: number;
  fflags?: number;
  data?: number;
  res?: number;
}
/** Options accepted by spin() and run(). */
interface SpinOptions {
  signal?: AbortSignal;
}
/**
 * A `Promise<void>` returned by `timeout()` that carries a `cancel()` method
 * for tearing down the pending timer before it fires.
 *
 * The promise resolves once the timer elapses. Calling `cancel()` first removes
 * the timer from the loop — so it no longer keeps the process alive via
 * `alive()` — and, on backends that support timer removal, cancels the
 * underlying kernel event. A cancelled timer is deliberately left pending
 * forever: it never resolves and never rejects. Code that races a timeout
 * against other work should drop the reference after cancelling rather than
 * awaiting the bare promise expecting it to settle.
 *
 * ```ts no_run
 * import { timeout } from 'internal:runtime/loop';
 *
 * const timer = timeout(1000);
 * // ...another operation completed first...
 * timer.cancel(); // the timer stops holding the loop open
 * ```
 *
 * @internal
 */
export interface CancelablePromise extends Promise<void> {
  /**
   * Remove the pending timer from the loop without settling the promise.
   *
   * Safe to call more than once and safe to call after the timer has already
   * fired; redundant calls are no-ops. Once cancelled, the promise stays
   * unsettled for the lifetime of the process.
   *
   * ```ts no_run
   * import { timeout } from 'internal:runtime/loop';
   *
   * const timer = timeout(1000);
   * timer.cancel();
   * ```
   */
  cancel(): void;
}
const { EVFILT_READ, EVFILT_WRITE, EVFILT_TIMER } = backend;
// EVFILT_PROC is kqueue-only (macOS). EVFILT_COMPLETION is io_uring-only (Linux).
// EVFILT_VNODE is kqueue-only (macOS) — used for file/directory watching.
// EVFILT_SIGNAL is available on both platforms (kqueue native, io_uring via signalfd).
const EVFILT_PROC = backend.EVFILT_PROC ?? null;
const EVFILT_COMPLETION = backend.EVFILT_COMPLETION ?? null;
const EVFILT_VNODE = backend.EVFILT_VNODE ?? null;
const EVFILT_SIGNAL = backend.EVFILT_SIGNAL ?? null;
const _addRead = backend.addRead as (raw: object, fd: number, ident?: number) => void;
const _addWrite = backend.addWrite as (raw: object, fd: number, ident?: number) => void;
const _addTimer = backend.addTimer as (raw: object, id: number, ms: number) => void;
const _removeTimer = backend.removeTimer as ((raw: object, id: number) => void) | undefined;
const _addProc = backend.addProc as
  | ((raw: object, pid: number, ident?: number) => boolean)
  | undefined;
const _addVnode = backend.addVnode as
  | ((raw: object, fd: number, fflags: number, ident?: number) => void)
  | undefined;
const _addSignal = backend.addSignal as
  | ((raw: object, signo: number, ident?: number) => void)
  | undefined;
const _addPersistentRead = backend.addPersistentRead as
  | ((raw: object, fd: number, ident?: number) => void)
  | undefined;
const _wait = backend.wait as (raw: object, timeoutMs: number) => LoopEvent[];
const _pollFd = backend.pollFd as ((raw: object) => number) | undefined;
// ---------------------------------------------------------------------------
// Singleton state — one local backend, omitted for delegated readiness
// ---------------------------------------------------------------------------
const _delegatesReadiness =
  (
    globalThis as {
      __finoSchedulerDelegatesReadiness?: boolean;
    }
  ).__finoSchedulerDelegatesReadiness === true;
let _raw: object | undefined = _delegatesReadiness ? undefined : (backend.create() as object);
function rawBackend(): object {
  return (_raw ??= backend.create() as object);
}
type SchedulerHostOperation = (
  operation: 'readable' | 'writable' | 'removeRead' | 'removeWrite',
  args: {
    fd: number;
  },
) => Promise<unknown>;
function schedulerHostOperation(): SchedulerHostOperation | undefined {
  return (
    globalThis as {
      __finoSchedulerHostOp?: SchedulerHostOperation;
    }
  ).__finoSchedulerHostOp;
}
const _reads: Map<number, (avail: number) => void> = new Map();
const _writes: Map<number, () => void> = new Map();
const _timers: Map<number, () => void> = new Map();
const _procs: Map<number, () => void> = new Map();
const _completions: Map<number, (result: { res: number }) => void> = new Map();
const _vnodes: Map<number, (event: { fflags: number }) => void> = new Map();
const _signals: Map<number, () => void> = new Map();
// Wake sources: persistent-read fds that fire when written to, used to
// interrupt the kqueue sleep without counting as live I/O for alive().
const _wakeSources: Set<number> = new Set();
let _nextTimerId = 1;
let _nextCompletionId = 1;
let _atomicsWaiters = 0;
// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
function _dispatch(ev: LoopEvent): void {
  if (ev.filter === EVFILT_READ) {
    // Check _reads first: a specific resolver takes priority over a generic
    // wake source even if the fd numbers happen to collide (e.g. due to OS
    // fd recycling between tests).
    const resolve = _reads.get(ev.ident);
    if (resolve) {
      _reads.delete(ev.ident);
      // EV_ONESHOT: kernel already removed the filter after delivery.
      // Pass ev.data (bytes available on kqueue; 0 on io_uring) to the resolver.
      resolve(ev.data ?? 0);
    } else if (_wakeSources.has(ev.ident)) {
      // Pure wake source — fires to interrupt the kqueue sleep so the Rust
      // layer can drain async completions on the next pump_and_checkpoint.
      return;
    }
  } else if (ev.filter === EVFILT_WRITE) {
    const resolve = _writes.get(ev.ident);
    if (resolve) {
      _writes.delete(ev.ident);
      // EV_ONESHOT: kernel already removed the filter after delivery.
      resolve();
    }
  } else if (ev.filter === EVFILT_TIMER) {
    const resolve = _timers.get(ev.ident);
    if (resolve) {
      _timers.delete(ev.ident);
      resolve();
    }
  } else if (EVFILT_PROC !== null && ev.filter === EVFILT_PROC) {
    const resolve = _procs.get(ev.ident);
    if (resolve) {
      _procs.delete(ev.ident);
      resolve();
    }
  } else if (EVFILT_COMPLETION !== null && ev.filter === EVFILT_COMPLETION) {
    const resolve = _completions.get(ev.ident);
    if (resolve) {
      _completions.delete(ev.ident);
      resolve({ res: ev.res ?? 0 });
    }
  } else if (EVFILT_VNODE !== null && ev.filter === EVFILT_VNODE) {
    const cb = _vnodes.get(ev.ident);
    if (cb) {
      // Do NOT delete — vnode watches are persistent (EV_CLEAR re-arms them).
      cb({ fflags: ev.fflags ?? 0 });
    }
  } else if (EVFILT_SIGNAL !== null && ev.filter === EVFILT_SIGNAL) {
    const cb = _signals.get(ev.ident);
    if (cb) {
      // Do NOT delete — signal watches are persistent until removeSignal() is called.
      cb();
    }
  }
}
// ---------------------------------------------------------------------------
// Runtime hooks — exported for internal/main.ts to drive the event loop
// ---------------------------------------------------------------------------
/**
 * Poll the backend for ready events, dispatch each to its registered resolver,
 * and return the number of events processed.
 *
 * `internal/main.ts` calls this on every iteration of the outer run loop.
 * `timeoutMs` is the maximum time, in milliseconds, to block waiting for
 * events; pass `0` for a non-blocking poll of whatever is currently ready.
 * Read, write, timer, proc, and completion resolvers are one-shot and removed
 * as they fire, while vnode and signal watches persist and may be dispatched
 * repeatedly until explicitly removed.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * // Drain whatever is ready right now without blocking.
 * const dispatched = loop.tick(0);
 * ```
 */
export function tick(timeoutMs: number): number {
  const events = _wait(rawBackend(), timeoutMs);
  for (const ev of events) _dispatch(ev);
  return events.length;
}
/**
 * The pollable fd of this loop's backend, or `-1` when the backend has none.
 *
 * A kqueue fd (macOS) or io_uring ring fd (Linux) polls readable when the
 * loop has pending events, so a parent realm can watch this fd to wake
 * immediately on an embedded child's I/O and timer activity.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const fd = loop.loopFd();
 * if (fd !== -1) await loop.readable(fd);
 * ```
 *
 * @internal
 */
export function loopFd(): number {
  return _raw === undefined ? -1 : (_pollFd?.(_raw) ?? -1);
}
/**
 * Reports whether the loop still has work that could settle, so the outer run
 * loop knows to keep iterating.
 *
 * Returns true while any read, write, timer, proc, completion, or vnode watch
 * is registered, while V8 has pending background tasks, or while an
 * `Atomics.waitAsync` waiter is outstanding. Signal watches and registered
 * wake sources deliberately do NOT count as live work: they can keep firing
 * but should never on their own prevent the process from exiting. `internal/
 * main.ts` uses this to decide when to leave the run loop.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * while (loop.alive()) loop.tick(50);
 * ```
 */
export function alive(): boolean {
  return (
    _reads.size > 0 ||
    _writes.size > 0 ||
    _timers.size > 0 ||
    _procs.size > 0 ||
    _completions.size > 0 ||
    _vnodes.size > 0 ||
    hasPendingV8Tasks() ||
    _atomicsWaiters > 0
  );
}
/**
 * Return a snapshot of the loop's live handle counts for diagnostics and tests.
 *
 * Unlike `alive()`, which collapses everything into a single boolean, this
 * breaks out each registered-resolver map size individually and reports the
 * V8 background-task flag separately from native handles. Cleanup and
 * resource-leak tests use it to assert that the specific handle type they own
 * (for example, timers or reads) has actually drained to zero.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const before = loop._activeHandleCounts();
 * if (before.timers !== 0) throw new Error('leaked timer');
 * ```
 *
 * @internal
 */
export function _activeHandleCounts(): {
  reads: number;
  writes: number;
  timers: number;
  procs: number;
  completions: number;
  vnodes: number;
  atomicsWaiters: number;
  pendingV8Tasks: boolean;
} {
  return {
    reads: _reads.size,
    writes: _writes.size,
    timers: _timers.size,
    procs: _procs.size,
    completions: _completions.size,
    vnodes: _vnodes.size,
    atomicsWaiters: _atomicsWaiters,
    pendingV8Tasks: hasPendingV8Tasks(),
  };
}
/**
 * Track one pending `Atomics.waitAsync` waiter.
 *
 * `Atomics.waitAsync` settles from another thread rather than through the
 * backend, so it registers no read/write/timer handle of its own. Tracking a
 * waiter keeps `alive()` true so the run loop does not exit while the waiter
 * can still be woken. Every call must be paired with a later
 * `_untrackAtomicsWaiter()` once the waiter settles or is abandoned.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * loop._trackAtomicsWaiter();
 * try {
 *   await somethingBackedByAtomicsWaitAsync();
 * } finally {
 *   loop._untrackAtomicsWaiter();
 * }
 * ```
 *
 * @internal
 */
export function _trackAtomicsWaiter(): void {
  _atomicsWaiters++;
}
/**
 * Stop tracking one pending `Atomics.waitAsync` waiter previously registered
 * with `_trackAtomicsWaiter()`.
 *
 * Decrements the waiter count so the loop can once again exit if nothing else
 * is live. Each call must correspond to exactly one prior
 * `_trackAtomicsWaiter()`; over-calling would let the loop exit while a waiter
 * is still outstanding.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * loop._trackAtomicsWaiter();
 * // ...waiter settled...
 * loop._untrackAtomicsWaiter();
 * ```
 *
 * @internal
 */
export function _untrackAtomicsWaiter(): void {
  _atomicsWaiters--;
}
// ---------------------------------------------------------------------------
// Public I/O API
// ---------------------------------------------------------------------------
/**
 * Resolve the next time `fd` becomes readable, with the number of bytes
 * estimated to be available.
 *
 * The watch is one-shot: call `readable()` again for each read. Registering a
 * second watch for the same descriptor replaces the earlier resolver. In an
 * ordinary realm it registers on the realm-local backend. In a
 * scheduler-hosted isolate it sends only the descriptor number to the scheduler,
 * whose shared backend resolves this promise; the subsequent read and all
 * buffer ownership remain in this realm. Use `removeRead()` to abandon a pending
 * watch.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const available = await loop.readable(fd);
 * // read up to `available` bytes from fd here
 * ```
 */
export function readable(fd: number): Promise<number> {
  const host = schedulerHostOperation();
  if (host !== undefined) {
    return host('readable', { fd }) as Promise<number>;
  }
  return new Promise(function onReadable(resolve) {
    _reads.set(fd, resolve);
    _addRead(rawBackend(), fd, fd);
  });
}
/**
 * Resolve the next time `fd` becomes writable.
 *
 * Like `readable()`, the watch is one-shot and a second watch for the same
 * descriptor replaces the first. Scheduler-hosted isolates delegate only this
 * readiness wait; they still retry and perform the write themselves. It is
 * typically used to wait out `EAGAIN`/`EWOULDBLOCK` on a non-blocking socket.
 * Use `removeWrite()` to abandon a pending watch.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * await loop.writable(fd); // fd now has room in its send buffer
 * ```
 */
export function writable(fd: number): Promise<void> {
  const host = schedulerHostOperation();
  if (host !== undefined) {
    return host('writable', { fd }) as Promise<void>;
  }
  return new Promise(function onWritable(resolve) {
    _writes.set(fd, resolve);
    _addWrite(rawBackend(), fd, fd);
  });
}
/**
 * Resolve after at least `ms` milliseconds, returning a `CancelablePromise`.
 *
 * Each call allocates a fresh timer id, so timeouts are independent and may
 * overlap freely. The returned promise carries a `cancel()` method: calling it
 * before the timer fires removes the timer from the loop immediately — so it
 * no longer counts toward `alive()` — and cancels the underlying kernel event
 * on backends that support timer removal. A cancelled timer is left unsettled
 * forever. The delay is a floor, not a guarantee: a busy loop or a blocking
 * `tick()` can push actual delivery later.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const timer = loop.timeout(50);
 * await timer;         // resolves after ~50ms
 *
 * const other = loop.timeout(1000);
 * other.cancel();      // never fires, never settles
 * ```
 */
export function timeout(ms: number): CancelablePromise {
  const id = _nextTimerId++;
  const p = new Promise<void>(function onTimeout(resolve) {
    _timers.set(id, resolve);
    _addTimer(rawBackend(), id, ms);
  }) as CancelablePromise;
  p.cancel = function cancelTimeout() {
    if (!_timers.has(id)) return;
    _timers.delete(id);
    if (_removeTimer) _removeTimer(rawBackend(), id);
  };
  return p;
}
/**
 * Resolve when the process `pid` exits (macOS only, via `EVFILT_PROC`).
 *
 * This is a kqueue-only capability. On Linux there is no `EVFILT_PROC`; obtain
 * a pidfd with `pidfd_open(2)` and wait on it with `readable()` instead. The
 * watch is one-shot and does not reap the zombie — the caller still has to
 * call `waitpid()`/`wait4()` afterwards.
 *
 * The exit-before-registration race is handled: if the process has already
 * exited by the time the filter is added, the backend rejects it and this
 * resolves immediately, so the caller can proceed straight to reaping.
 *
 * Throws if called on a platform without `EVFILT_PROC` support.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * await loop.proc(pid); // returns once the child has exited
 * // now reap it with waitpid(pid, ...)
 * ```
 */
export function proc(pid: number): Promise<void> {
  if (_addProc === undefined) throw new Error('proc() is not supported on this platform');
  return new Promise(function onProc(resolve) {
    // Register before calling addProc so the event can never be missed.
    _procs.set(pid, resolve);
    const registered = _addProc(rawBackend(), pid, pid);
    if (registered === false) {
      // Process already exited — kevent rejected the filter.
      // Resolve immediately so the caller can reap the zombie with waitpid.
      _procs.delete(pid);
      resolve();
    }
  });
}
/**
 * Submit a generic io_uring async operation and resolve when it completes
 * (Linux io_uring only).
 *
 * The loop allocates a fresh completion id and invokes `submitter(raw, id)`
 * synchronously; the submitter is responsible for building the SQE against the
 * opaque backend handle `raw` and tagging it with `id`. The returned promise
 * resolves with `{ res }` when the matching CQE fires, where `res` is the raw
 * syscall return value — negative values are `-errno`, so callers must check
 * for errors themselves.
 *
 * Throws if called on a platform without a completion backend (for example
 * macOS kqueue, or Linux when io_uring is unavailable and the loop fell back
 * to poll). Guard with a capability check when writing cross-platform code.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 * import * as uring from 'internal:runtime/io_uring';
 *
 * const { res } = await loop.submit((raw, id) => uring.asyncRead(raw, fd, buf, len, id));
 * if (res < 0) throw new Error(`read failed: errno ${-res}`);
 * ```
 */
export function submit(submitter: (raw: object, id: number) => void): Promise<{
  res: number;
}> {
  if (EVFILT_COMPLETION === null) throw new Error('submit() is not supported on this platform');
  const id = _nextCompletionId++;
  return new Promise(function onSubmit(resolve) {
    _completions.set(id, resolve);
    submitter(rawBackend(), id);
  });
}
/**
 * Register `fd` as a persistent wake source. When background threads write to
 * `fd`, kqueue fires and interrupts any sleeping `tick()` call. The fd does NOT
 * count toward `alive()` — the loop can exit while a wake source is registered.
 * On platforms that don't support persistent reads the call is a no-op; the
 * Rust layer falls back to the per-iteration drain path with ≤50ms latency.
 *
 * A wake source is a persistent read watch that, unlike `readable()`, never
 * settles a promise and never counts toward `alive()` — its only job is to
 * break a blocking `tick()`/`spin()` sleep when a background thread signals
 * that async completions are ready to drain.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * // `fd` is the read end of a self-pipe written by a background thread.
 * loop.registerWakeSource(fd);
 * ```
 */
export function registerWakeSource(fd: number): void {
  // The scheduler already watches this isolate's async-runtime wake fd and
  // re-pumps the isolate when it fires. Registering it locally would create an
  // unused second backend inside the parked isolate.
  if (_delegatesReadiness) return;
  _wakeSources.add(fd);
  if (_addPersistentRead) {
    _addPersistentRead(rawBackend(), fd, fd);
  }
}
/**
 * Abandon a pending `readable()` watch for `fd`.
 *
 * Drops the registered resolver and unregisters the read filter from the
 * backend. The pending promise is neither resolved nor rejected — it is simply
 * left unsettled — so this is for teardown paths (closing an fd, cancelling a
 * read) rather than normal completion. Safe to call when no watch is pending.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * loop.removeRead(fd); // stop watching before closing fd
 * ```
 */
export function removeRead(fd: number): void {
  const host = schedulerHostOperation();
  if (host !== undefined) {
    void host('removeRead', { fd }).catch(() => {});
    return;
  }
  _reads.delete(fd);
  backend.removeRead(rawBackend(), fd);
}
/**
 * Abandon a pending `writable()` watch for `fd`.
 *
 * Mirror of `removeRead()` for the write side: drops the resolver, unregisters
 * the write filter, and leaves the pending promise unsettled. Safe to call
 * when no watch is pending.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * loop.removeWrite(fd);
 * ```
 */
export function removeWrite(fd: number): void {
  const host = schedulerHostOperation();
  if (host !== undefined) {
    void host('removeWrite', { fd }).catch(() => {});
    return;
  }
  _writes.delete(fd);
  backend.removeWrite(rawBackend(), fd);
}
/**
 * Register a persistent file/directory watch on `fd` (macOS only, via
 * `EVFILT_VNODE`).
 *
 * `fflags` is a bitmask of `NOTE_*` constants (`NOTE_DELETE`, `NOTE_WRITE`,
 * `NOTE_RENAME`, ...) selecting which filesystem changes to observe. The
 * callback receives `{ fflags }` describing which of those notes fired, and —
 * unlike `readable()`/`writable()` — the watch is persistent: it re-arms after
 * every delivery and keeps invoking the callback until `removeVnode()` is
 * called. Registering a second watch for the same fd replaces the callback.
 *
 * Throws if vnode watching is not supported on this platform (any non-kqueue
 * backend, i.e. Linux).
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const NOTE_WRITE = 0x0002;
 * loop.vnode(fd, NOTE_WRITE, (event) => {
 *   if (event.fflags & NOTE_WRITE) console.log('file changed');
 * });
 * ```
 */
export function vnode(
  fd: number,
  fflags: number,
  callback: (event: { fflags: number }) => void,
): void {
  if (_addVnode === undefined) throw new Error('vnode() is not supported on this platform');
  _vnodes.set(fd, callback);
  _addVnode(rawBackend(), fd, fflags, fd);
}
/**
 * Remove a persistent vnode watch previously registered with `vnode()`.
 *
 * Drops the callback and unregisters the filter from the backend. A no-op if
 * no watch is registered for `fd`, so it is safe to call unconditionally on a
 * teardown path.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * loop.removeVnode(fd);
 * ```
 */
export function removeVnode(fd: number): void {
  if (!_vnodes.has(fd)) return;
  _vnodes.delete(fd);
  if (backend.removeVnode) backend.removeVnode(rawBackend(), fd);
}
/**
 * Register a persistent watch for OS signal `signo` (kqueue native on macOS,
 * signalfd-backed on Linux).
 *
 * The callback is invoked with no arguments each time the signal is delivered
 * and, unlike `readable()`/`writable()`, the watch persists until
 * `removeSignal()` is called. Registering a signal also suppresses its default
 * OS disposition — so watching `SIGTERM` or `SIGINT` prevents the signal from
 * terminating the process, leaving the callback fully responsible for the
 * response. Registering a second watch for the same `signo` replaces the
 * callback. Signal watches do NOT keep the loop alive on their own (they are
 * excluded from `alive()`).
 *
 * Throws if signal watching is not supported on this platform.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const SIGTERM = 15;
 * loop.signal(SIGTERM, () => {
 *   // graceful shutdown; the process is not killed automatically
 * });
 * ```
 */
export function signal(signo: number, callback: () => void): void {
  if (_addSignal === undefined) throw new Error('signal() is not supported on this platform');
  _signals.set(signo, callback);
  _addSignal(rawBackend(), signo);
}
/**
 * Remove a signal watch previously registered with `signal()` and restore the
 * signal's default OS disposition.
 *
 * After this returns, the signal once again triggers its normal OS action (for
 * example terminating the process on `SIGTERM`). A no-op when no watch is
 * registered for `signo`, so it is safe to call unconditionally.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const SIGTERM = 15;
 * loop.removeSignal(SIGTERM); // default termination behavior restored
 * ```
 */
export function removeSignal(signo: number): void {
  if (!_signals.has(signo)) return;
  _signals.delete(signo);
  if (backend.removeSignal) backend.removeSignal(rawBackend(), signo);
}
// ---------------------------------------------------------------------------
// Synchronous spinning
// ---------------------------------------------------------------------------
/**
 * Synchronously drive the event loop until `promise` settles, then return its
 * resolved value or re-throw its rejection reason.
 *
 * This is the bridge from a synchronous call stack into async work: it blocks
 * the caller and pumps the loop in place instead of yielding to the outer run
 * loop. Each iteration drains all pending microtasks, polls I/O, then drains
 * microtasks again so resolutions produced by dispatch are observed. Polling is
 * non-blocking while events keep arriving; after three consecutive idle ticks
 * it blocks for up to 50 ms (10 ms when an abort signal is attached, so the
 * signal is noticed promptly) to avoid busy-spinning.
 *
 * Pass `options.signal` to make the spin abortable: if the `AbortSignal` fires
 * (or is already aborted on entry), the spin stops and throws the signal's
 * abort reason instead of the promise's value. Note that aborting only stops
 * the spinning — it does not cancel the underlying `promise`.
 *
 * Throws the promise's rejection reason if it rejects, or the signal's reason
 * if aborted.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * // Block until an async read finishes, from synchronous code.
 * const bytes = loop.spin(readChunk(fd));
 *
 * // With a deadline:
 * const value = loop.spin(fetchThing(), { signal: AbortSignal.timeout(1000) });
 * ```
 */
export function spin<T>(promise: Promise<T>, options?: SpinOptions): T {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;
  let settled = false;
  let result: T | undefined, error: unknown;
  let hasError = false;
  promise.then(
    function onSpinResolved(v) {
      result = v;
      settled = true;
    },
    function onSpinRejected(e) {
      error = e;
      hasError = true;
      settled = true;
    },
  );
  let onAbort: (() => void) | undefined;
  if (signal) {
    onAbort = function onSpinAborted() {
      error = signal.reason;
      hasError = true;
      settled = true;
    };
    signal.addEventListener('abort', onAbort);
  }
  try {
    let emptyTicks = 0;
    while (!settled) {
      // 1. Drain all microtasks.
      drainMicrotasks();
      if (settled) break;
      // 2. Poll I/O. Block up to 50 ms when idle to avoid busy-spinning;
      //    10 ms when an abort signal could fire.
      const timeout = emptyTicks >= 3 ? (signal ? 10 : 50) : 0;
      const events = _wait(rawBackend(), timeout);
      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event !== undefined) _dispatch(event);
      }
      // 3. Drain microtasks produced by I/O dispatch.
      drainMicrotasks();
      if (settled) break;
      emptyTicks = events.length === 0 ? emptyTicks + 1 : 0;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  if (hasError) throw error;
  return result as T;
}
/**
 * Invoke `fn` and, if it returns a Promise, `spin()` the loop until that
 * promise settles; otherwise return the plain value directly.
 *
 * A convenience wrapper for entry points that may be written either
 * synchronously or asynchronously. A synchronous `fn` returns without ever
 * touching the loop, so there is no spinning cost when it isn't needed. When
 * `fn` returns a thenable, `options` (including an abort `signal`) is forwarded
 * to `spin()`, and the rejection reason or abort reason propagates the same way.
 *
 * Throws whatever `fn()` throws synchronously, the rejection reason of a
 * returned promise, or the signal's abort reason.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * // Works whether the callback is sync or async.
 * const a = loop.run(() => 41 + 1);
 * const b = loop.run(async () => await fetchThing());
 * ```
 */
export function run<T>(fn: () => T | Promise<T>, options?: SpinOptions): T {
  const ret = fn();
  if (ret && typeof (ret as any).then === 'function') {
    return spin(ret as Promise<T>, options);
  }
  return ret as T;
}
