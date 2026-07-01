/**
* internal:runtime/loop — global event loop singleton.
*
* A single kqueue/io_uring backend handle is created when this module is
* loaded and lives for the process lifetime. All I/O and timer operations
* register on that single handle.
*
*
* ## API
*
* ```ts no_run
*   import * as loop from './loop.ts';
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
/** A Promise<void> with an additional cancel() method to cancel the pending timer. */
/**
* Generated-doc-visible interface `CancelablePromise`.
*
* This implementation detail is included when documentation is built with
* `--include-private`. It describes state or helper behavior used by the
* owning module rather than a stable application-facing contract. Prefer the
* public API around the owning type unless you are maintaining this runtime.
*
* @example
* ```ts no_run
* const documentedType = 'CancelablePromise';
* console.log(documentedType);
* ```
*
* @internal
*/
export interface CancelablePromise extends Promise<void> {
  /**
  * Cancel the pending timer without settling the promise.
  *
  * ```typescript no_run
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
const _addProc = backend.addProc as ((raw: object, pid: number, ident?: number) => boolean) | undefined;
const _addVnode = backend.addVnode as ((raw: object, fd: number, fflags: number, ident?: number) => void) | undefined;
const _addSignal = backend.addSignal as ((raw: object, signo: number, ident?: number) => void) | undefined;
const _addPersistentRead = backend.addPersistentRead as ((raw: object, fd: number, ident?: number) => void) | undefined;
const _wait = backend.wait as (raw: object, timeoutMs: number) => LoopEvent[];
// ---------------------------------------------------------------------------
// Singleton state — created at module load, lives for the process lifetime
// ---------------------------------------------------------------------------
const _raw = backend.create() as object;
const _reads: Map<number, (avail: number) => void> = new Map();
const _writes: Map<number, () => void> = new Map();
const _timers: Map<number, () => void> = new Map();
const _procs: Map<number, () => void> = new Map();
const _completions: Map<number, (result: {
  res: number;
}) => void> = new Map();
const _vnodes: Map<number, (event: {
  fflags: number;
}) => void> = new Map();
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
* Poll the event loop for I/O events and dispatch them. Called by `internal/main.ts`
* on every iteration of the outer run loop.
*
* @param {number} timeoutMs  How long to block waiting for events (0 = non-blocking).
* @returns {number} Total number of events dispatched.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* const dispatched = loop.tick(0);
* ```
*/
export function tick(timeoutMs: number): number {
  const events = _wait(_raw, timeoutMs);
  for (const ev of events) _dispatch(ev);
  return events.length;
}
/**
* Returns true if the loop has any pending I/O work.
* `internal/main.ts` uses this to decide whether to exit the run loop.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* if (loop.alive()) loop.tick(0);
* ```
*/
export function alive(): boolean {
  return _reads.size > 0 || _writes.size > 0 || _timers.size > 0 || _procs.size > 0 || _completions.size > 0 || _vnodes.size > 0 || hasPendingV8Tasks() || _atomicsWaiters > 0;
}
/**
* Return active runtime loop handle counts for diagnostics and tests.
*
* Unlike `alive()`, this separates native loop handles from V8 background-task
* liveness so cleanup tests can assert the resource they actually own.
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
    pendingV8Tasks: hasPendingV8Tasks()
  };
}
/**
* Track one pending `Atomics.waitAsync` waiter.
*
* This keeps the runtime alive while the waiter can still settle.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop._trackAtomicsWaiter();
* loop._untrackAtomicsWaiter();
* ```
*
* @internal
*/
export function _trackAtomicsWaiter(): void {
  _atomicsWaiters++;
}
/**
* Stop tracking one pending `Atomics.waitAsync` waiter.
*
* Must be paired with a previous `_trackAtomicsWaiter` call.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
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
* Returns a Promise that resolves the next time `fd` becomes readable.
* Calling `readable()` for a fd that already has a pending read replaces
* the previous resolver.
*
* Resolves with the number of bytes available to read (from kqueue's ev.data
* on macOS; 0 on io_uring/Linux where the count is not available).
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* const available = await loop.readable(fd);
* ```
*/
export function readable(fd: number): Promise<number> {
  return new Promise(function onReadable(resolve) {
    _reads.set(fd, resolve);
    _addRead(_raw, fd, fd);
  });
}
/**
* Returns a Promise that resolves the next time `fd` becomes writable.
*
* Replaces any previous pending write resolver for the same fd.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* await loop.writable(fd);
* ```
*/
export function writable(fd: number): Promise<void> {
  return new Promise(function onWritable(resolve) {
    _writes.set(fd, resolve);
    _addWrite(_raw, fd, fd);
  });
}
/**
* Returns a Promise that resolves after `ms` milliseconds.
*
* The returned Promise has an additional `cancel()` method. Calling it before
* the timer fires removes the timer from the event loop immediately (so it no
* longer counts toward `alive()`) and cancels the kqueue/io_uring event if the
* backend supports it. The promise is left unsettled after cancellation.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* const timer = loop.timeout(50);
* timer.cancel();
* ```
*/
export function timeout(ms: number): CancelablePromise {
  const id = _nextTimerId++;
  const p = new Promise<void>(function onTimeout(resolve) {
    _timers.set(id, resolve);
    _addTimer(_raw, id, ms);
  }) as CancelablePromise;
  p.cancel = function cancelTimeout() {
    if (!_timers.has(id)) return;
    _timers.delete(id);
    if (_removeTimer) _removeTimer(_raw, id);
  };
  return p;
}
/**
* Returns a Promise that resolves when `pid` exits (macOS only, via EVFILT_PROC).
* On Linux, obtain a pidfd via pidfd_open(2) and use readable() instead.
*
* Handles the race where the process exits before EVFILT_PROC is registered:
* addProc() returns false in that case, and we resolve immediately so the
* caller can proceed to waitpid().
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* await loop.proc(pid);
* ```
*/
export function proc(pid: number): Promise<void> {
  if (_addProc === undefined) throw new Error('proc() is not supported on this platform');
  return new Promise(function onProc(resolve) {
    // Register before calling addProc so the event can never be missed.
    _procs.set(pid, resolve);
    const registered = _addProc(_raw, pid, pid);
    if (registered === false) {
      // Process already exited — kevent rejected the filter.
      // Resolve immediately so the caller can reap the zombie with waitpid.
      _procs.delete(pid);
      resolve();
    }
  });
}
/**
* Submit a generic io_uring async operation (Linux only).
*
* `submitter(raw, id)` is called synchronously to register the SQE with the
* given completion id. Returns a Promise that resolves with `{ res }` when
* the CQE fires (res is the syscall return value, negative on error).
*
* ```ts no_run
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
    submitter(_raw, id);
  });
}
/**
* Register `fd` as a persistent wake source. When background threads write to
* `fd`, kqueue fires and interrupts any sleeping `tick()` call. The fd does NOT
* count toward `alive()` — the loop can exit while a wake source is registered.
* On platforms that don't support persistent reads the call is a no-op; the
* Rust layer falls back to the per-iteration drain path with ≤50ms latency.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop.registerWakeSource(fd);
* ```
*/
export function registerWakeSource(fd: number): void {
  _wakeSources.add(fd);
  if (_addPersistentRead) {
    _addPersistentRead(_raw, fd, fd);
  }
}
/**
* Cancel a pending read watch for `fd` (rejects any pending promise silently).
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop.removeRead(fd);
* ```
*/
export function removeRead(fd: number): void {
  _reads.delete(fd);
  backend.removeRead(_raw, fd);
}
/**
* Cancel a pending write watch for `fd`.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop.removeWrite(fd);
* ```
*/
export function removeWrite(fd: number): void {
  _writes.delete(fd);
  backend.removeWrite(_raw, fd);
}
/**
* Register a persistent vnode watch on `fd` (macOS only, via EVFILT_VNODE).
*
* `fflags` is a bitmask of NOTE_* constants (NOTE_DELETE | NOTE_WRITE | ...).
* `callback` is called with `{ fflags }` on every event — it may be called
* multiple times as events accumulate. Unlike readable()/writable(), this watch
* persists until `removeVnode()` is called; it does NOT auto-remove on delivery.
*
* @throws {Error} If vnode watching is not supported on this platform.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop.vnode(fd, NOTE_WRITE, (event) => void event.fflags);
* ```
*/
export function vnode(fd: number, fflags: number, callback: (event: {
  fflags: number;
}) => void): void {
  if (_addVnode === undefined) throw new Error('vnode() is not supported on this platform');
  _vnodes.set(fd, callback);
  _addVnode(_raw, fd, fflags, fd);
}
/**
* Remove a vnode watch for `fd`.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop.removeVnode(fd);
* ```
*/
export function removeVnode(fd: number): void {
  if (!_vnodes.has(fd)) return;
  _vnodes.delete(fd);
  if (backend.removeVnode) backend.removeVnode(_raw, fd);
}
/**
* Register a persistent signal watch for `signo`.
*
* `callback` is called (with no arguments) each time the signal is delivered.
* Unlike readable()/writable(), the watch persists until `removeSignal()` is
* called; the callback may be invoked multiple times.
*
* Also suppresses the signal's default OS action (e.g. process termination
* for SIGTERM/SIGINT) so the process is not killed on delivery.
*
* @throws {Error} If signal watching is not supported on this platform.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop.signal(15, () => {});
* ```
*/
export function signal(signo: number, callback: () => void): void {
  if (_addSignal === undefined) throw new Error('signal() is not supported on this platform');
  _signals.set(signo, callback);
  _addSignal(_raw, signo);
}
/**
* Remove a signal watch for `signo` and restore the default OS signal action.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* loop.removeSignal(15);
* ```
*/
export function removeSignal(signo: number): void {
  if (!_signals.has(signo)) return;
  _signals.delete(signo);
  if (backend.removeSignal) backend.removeSignal(_raw, signo);
}
// ---------------------------------------------------------------------------
// Synchronous spinning
// ---------------------------------------------------------------------------
/**
* Synchronously drive the event loop until `promise` settles, then return
* the resolved value (or re-throw the rejection reason).
*
* Each iteration:
*   1. Drains all pending microtasks.
*   2. Polls the loop's I/O (non-blocking on busy ticks, blocking up to
*      50 ms after 3 consecutive idle ticks to avoid busy-spinning).
*   3. Drains microtasks again after I/O dispatch.
*
* @param {Promise}     promise    The promise to await synchronously.
* @param {object}      [options]
* @param {AbortSignal} [options.signal]  Abort the spin when this signal fires.
* @returns The resolved value of `promise`.
* @throws  The rejection reason, or the abort signal's reason.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* const value = loop.spin(Promise.resolve(1));
* ```
*/
export function spin<T>(promise: Promise<T>, options?: SpinOptions): T {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason;
  let settled = false;
  let result: T | undefined, error: unknown;
  let hasError = false;
  promise.then(function onSpinResolved(v) {
    result = v;
    settled = true;
  }, function onSpinRejected(e) {
    error = e;
    hasError = true;
    settled = true;
  });
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
      const timeout = emptyTicks >= 3 ? signal ? 10 : 50 : 0;
      const events = _wait(_raw, timeout);
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
* Run `fn` and, if it returns a Promise, spin the event loop until it
* settles. Returns the settled value (or re-throws the rejection reason).
*
* @param {function} fn       Sync or async function.
* @param {object}   [options]
* @param {AbortSignal} [options.signal]  Forwarded to `spin()`.
* @returns The settled value of `fn()`.
*
* ```typescript no_run
* import * as loop from 'internal:runtime/loop';
* const value = loop.run(async () => 1);
* ```
*/
export function run<T>(fn: () => T | Promise<T>, options?: SpinOptions): T {
  const ret = fn();
  if (ret && typeof (ret as any).then === 'function') {
    return spin(ret as Promise<T>, options);
  }
  return ret as T;
}
