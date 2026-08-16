/**
 * internal:runtime/loop — global event loop singleton.
 *
 * Ordinary realms on one OS thread attach to a thread backend. Process-pool
 * workloads instead send scalar registrations to the main TypeScript
 * orchestration realm, which owns the process backend. Each task captures its
 * realm owner in scalar user data. Native routing returns readiness to that
 * owner, then this module resolves the realm-local promise and leaves actual
 * reads, writes, and buffer ownership in the workload's TypeScript.
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
import {
  currentWorkloadOwner,
  registerProcessReadiness,
  takeSharedLoopEvents,
  usesProcessReadiness,
} from 'internal:scheduler-native';
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
  udata?: number;
  routed?: boolean;
  installed?: boolean;
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
const _removeProc = backend.removeProc as ((raw: object, pid: number) => void) | undefined;
const _addVnode = backend.addVnode as
  | ((raw: object, fd: number, fflags: number, ident?: number) => void)
  | undefined;
const _addSignal = backend.addSignal as
  | ((raw: object, signo: number, ident?: number) => void)
  | undefined;
const _suppressSignalDefault = backend.suppressSignalDefault as
  | ((signo: number) => void)
  | undefined;
const _addPersistentRead = backend.addPersistentRead as
  | ((raw: object, fd: number, ident?: number) => void)
  | undefined;
const _wait = backend.wait as (raw: object, timeoutMs: number | null) => LoopEvent[];
const _pollFd = backend.pollFd as ((raw: object) => number) | undefined;
// ---------------------------------------------------------------------------
// Singleton state — one local backend, omitted for delegated readiness
// ---------------------------------------------------------------------------
const _processReadiness = usesProcessReadiness();
let _raw: object | undefined = _processReadiness ? undefined : (backend.create() as object);
function rawBackend(): object {
  return (_raw ??= backend.create() as object);
}
const _reads: Map<number, (avail: number) => void> = new Map();
const _writes: Map<number, () => void> = new Map();
const _timers: Map<number, () => void> = new Map();
const _procs: Map<number, () => void> = new Map();
const _completions: Map<number, (result: { res: number }) => void> = new Map();
const _vnodes: Map<number, (event: { fflags: number }) => void> = new Map();
const _signals: Map<number, () => void> = new Map();
// Resolvers for persistent watches whose installation on the process backend
// has been requested but not yet confirmed, keyed by `${filter}:${token}`.
// Vnode and signal idents live in different namespaces (a descriptor and a
// signal number) and can collide, so the filter has to be part of the key.
const _installs: Map<string, () => void> = new Map();
// Wake sources: persistent-read fds that fire when written to, used to
// interrupt the kqueue sleep without counting as live I/O for alive().
const _wakeSources: Set<number> = new Set();
const _wakeSourceCallbacks: Map<number, () => void> = new Map();
let _nextTimerId = 1;
let _nextCompletionId = 1;
let _atomicsWaiters = 0;
const TASK_TOKEN_BASE = 4294967296;
/**
 * Scalars per routed readiness completion, matching the native layout:
 * ident, filter, flags, fflags, data, udata, installed.
 */
const COMPLETION_SLOTS = 7;
const _workloadOwner = currentWorkloadOwner();
const EV_ADD_ENABLE_ONESHOT = 1 | 4 | 16;
const EV_ADD_ENABLE_CLEAR = 1 | 4 | 32;
const EV_DELETE = 2;
/**
 * Register interest in a persistent watch's installation acknowledgement.
 *
 * The main realm confirms installation as an ordinary routed completion, so
 * this is an ordinary promise resolution like every other readiness signal —
 * the calling realm parks instead of blocking its reactor thread.
 */
function _awaitInstall(filter: number, token: number): Promise<void> {
  return new Promise<void>((resolve) => _installs.set(`${filter}:${token}`, resolve));
}
/**
 * Settle a pending install acknowledgement that is never going to arrive.
 *
 * Removing a watch before the main realm confirms it means the arming its
 * caller is waiting on will never happen. Resolving is the honest answer to
 * "am I still waiting?" — the wait is over, and the watch being asked about no
 * longer exists. Leaving the promise pending instead strands whoever awaited
 * `vnode()` or `signal()` forever, and `alive()` counts the abandoned entry as
 * outstanding work, so the realm cannot exit either.
 */
function _cancelInstall(filter: number, token: number): void {
  const key = `${filter}:${token}`;
  const install = _installs.get(key);
  if (install === undefined) return;
  _installs.delete(key);
  install();
}
function taskToken(fd: number): number {
  return _workloadOwner === 0 ? fd : _workloadOwner * TASK_TOKEN_BASE + (fd >>> 0);
}
function taskOwner(token: number): number {
  return Math.floor(token / TASK_TOKEN_BASE);
}
function taskLocalId(token: number): number {
  const unsigned = token % TASK_TOKEN_BASE;
  return unsigned > 2147483647 ? unsigned - TASK_TOKEN_BASE : unsigned;
}
// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
function _dispatch(ev: LoopEvent): void {
  // Resolvers are keyed by the token the watch was registered with, never by
  // the bare descriptor. The main realm installs watches on behalf of every
  // workload realm, so two owners routinely wait on the same descriptor number;
  // keying by fd would let one registration silently replace the other and
  // strand the loser forever.
  const token = ev.udata ?? ev.ident;
  const localId = taskOwner(token) === 0 ? ev.ident : taskLocalId(token);
  if (ev.installed === true) {
    const key = `${ev.filter}:${token}`;
    const installed = _installs.get(key);
    if (installed) {
      _installs.delete(key);
      installed();
    }
    return;
  }
  if (ev.filter === EVFILT_READ) {
    // Check _reads first: a specific resolver takes priority over a generic
    // wake source even if the fd numbers happen to collide (e.g. due to OS
    // fd recycling between tests).
    const resolve = _reads.get(token);
    if (resolve) {
      _reads.delete(token);
      // EV_ONESHOT: kernel already removed the filter after delivery.
      // Pass ev.data (bytes available on kqueue; 0 on io_uring) to the resolver.
      resolve(ev.data ?? 0);
    } else if (_wakeSources.has(token)) {
      // Pure wake source — fires to interrupt the kqueue sleep so the Rust
      // layer can drain async completions on the next pump_and_checkpoint.
      _wakeSourceCallbacks.get(token)?.();
      if (ev.routed && _addPersistentRead) {
        _addPersistentRead(rawBackend(), localId, token);
      }
      return;
    }
  } else if (ev.filter === EVFILT_WRITE) {
    const resolve = _writes.get(token);
    if (resolve) {
      _writes.delete(token);
      // EV_ONESHOT: kernel already removed the filter after delivery.
      resolve();
    }
  } else if (ev.filter === EVFILT_TIMER) {
    const resolve = _timers.get(token);
    if (resolve) {
      _timers.delete(token);
      resolve();
    }
  } else if (EVFILT_PROC !== null && ev.filter === EVFILT_PROC) {
    const resolve = _procs.get(token);
    if (resolve) {
      _procs.delete(token);
      resolve();
    }
  } else if (EVFILT_COMPLETION !== null && ev.filter === EVFILT_COMPLETION) {
    const resolve = _completions.get(token);
    if (resolve) {
      _completions.delete(token);
      resolve({ res: ev.res ?? 0 });
    }
  } else if (EVFILT_VNODE !== null && ev.filter === EVFILT_VNODE) {
    const cb = _vnodes.get(token);
    if (cb) {
      // Do NOT delete — vnode watches are persistent (EV_CLEAR re-arms them).
      cb({ fflags: ev.fflags ?? 0 });
    }
  } else if (EVFILT_SIGNAL !== null && ev.filter === EVFILT_SIGNAL) {
    const cb = _signals.get(token);
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
export function tick(timeoutMs: number | null): number {
  // Routed completions arrive as one flat Float64Array — `COMPLETION_SLOTS`
  // scalars per event — rather than a structured clone per event.
  const batch = takeSharedLoopEvents(_workloadOwner);
  const routed = batch.length / COMPLETION_SLOTS;
  for (let index = 0; index < routed; index++) {
    const base = index * COMPLETION_SLOTS;
    _dispatch({
      ident: batch[base]!,
      filter: batch[base + 1]!,
      flags: batch[base + 2]!,
      fflags: batch[base + 3]!,
      data: batch[base + 4]!,
      udata: batch[base + 5]!,
      routed: true,
      installed: batch[base + 6] === 1,
    });
  }
  const events = _processReadiness ? [] : _wait(rawBackend(), routed > 0 ? 0 : timeoutMs);
  for (const ev of events) _dispatch(ev);
  return routed + events.length;
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
    // A persistent watch that has been requested but not yet confirmed is
    // outstanding work: the realm must not exit between asking for it and the
    // main realm arming it, or the awaiting caller would never settle.
    _installs.size > 0 ||
    hasPendingV8Tasks() ||
    _atomicsWaiters > 0
  );
}
/**
 * Report whether a scheduled realm needs occasional foreground-task polling.
 *
 * Readiness-backed handles wake their owner through the process reactor.
 * V8 background tasks and `Atomics.waitAsync` have no pollable descriptor, so
 * a reactor thread uses this bit to timed-wait and re-pump the same entered
 * isolate without making unrelated I/O realms spin.
 *
 * @internal
 */
export function _schedulerPollingRequired(): boolean {
  return hasPendingV8Tasks() || _atomicsWaiters > 0;
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
  pendingInstalls: number;
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
    pendingInstalls: _installs.size,
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
 * second watch for the same descriptor replaces the earlier resolver, whose
 * promise is then left unsettled forever. That is deliberate — it is what keeps
 * a watch on a closed descriptor from waking once the kernel hands its number
 * to something else — so **one owner per descriptor**: a caller that could have
 * two reads in flight has to serialize them itself, or the earlier one hangs.
 * The thread reactor receives only the descriptor, interest, owner, and promise
 * token. The subsequent read and all buffer ownership remain in this realm.
 * Use `removeRead()` to abandon a pending watch.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * const available = await loop.readable(fd);
 * // read up to `available` bytes from fd here
 * ```
 */
export function readable(fd: number, forToken?: number): Promise<number> {
  return new Promise(function onReadable(resolve) {
    const token = forToken ?? taskToken(fd);
    _reads.set(token, resolve);
    if (_processReadiness) {
      registerProcessReadiness(fd, EVFILT_READ, EV_ADD_ENABLE_ONESHOT, 0, 0, token);
    } else {
      _addRead(rawBackend(), fd, token);
    }
  });
}
/**
 * Resolve the next time `fd` becomes writable.
 *
 * Like `readable()`, the watch is one-shot, a second watch for the same
 * descriptor replaces the first and strands it, and the descriptor therefore
 * belongs to one waiter at a time — `BufferedBytesWriter` serializes its
 * emissions for exactly this reason. Scheduler-hosted isolates delegate only
 * this readiness wait; they still retry and perform the write themselves. It is
 * typically used to wait out `EAGAIN`/`EWOULDBLOCK` on a non-blocking socket.
 * Use `removeWrite()` to abandon a pending watch.
 *
 * ```ts no_run
 * import * as loop from 'internal:runtime/loop';
 *
 * await loop.writable(fd); // fd now has room in its send buffer
 * ```
 */
export function writable(fd: number, forToken?: number): Promise<void> {
  return new Promise(function onWritable(resolve) {
    const token = forToken ?? taskToken(fd);
    _writes.set(token, resolve);
    if (_processReadiness) {
      registerProcessReadiness(fd, EVFILT_WRITE, EV_ADD_ENABLE_ONESHOT, 0, 0, token);
    } else {
      _addWrite(rawBackend(), fd, token);
    }
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
  const token = taskToken(id);
  const p = new Promise<void>(function onTimeout(resolve) {
    _timers.set(token, resolve);
    if (_processReadiness) {
      registerProcessReadiness(id, EVFILT_TIMER, EV_ADD_ENABLE_ONESHOT, 0, ms, token);
    } else {
      _addTimer(rawBackend(), token, ms);
    }
  }) as CancelablePromise;
  p.cancel = function cancelTimeout() {
    if (!_timers.has(token)) return;
    _timers.delete(token);
    if (_processReadiness) {
      registerProcessReadiness(id, EVFILT_TIMER, EV_DELETE, 0, 0, token);
    } else if (_removeTimer) {
      _removeTimer(rawBackend(), token);
    }
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
export function proc(pid: number, forToken?: number): Promise<void> {
  if (_addProc === undefined) throw new Error('proc() is not supported on this platform');
  const token = forToken ?? taskToken(pid);
  return new Promise(function onProc(resolve) {
    // Register before calling addProc so the event can never be missed.
    _procs.set(token, resolve);
    if (_processReadiness) {
      registerProcessReadiness(pid, EVFILT_PROC!, EV_ADD_ENABLE_ONESHOT, 0, 0, token);
      return;
    }
    const registered = _addProc(rawBackend(), pid, token);
    if (registered === false) {
      // Process already exited — kevent rejected the filter.
      // Resolve immediately so the caller can reap the zombie with waitpid.
      _procs.delete(token);
      resolve();
    }
  });
}
/** Cancel a pending process-exit watch without settling its promise. */
export function removeProc(pid: number, forToken?: number): void {
  const token = forToken ?? taskToken(pid);
  if (!_procs.has(token)) return;
  _procs.delete(token);
  if (_processReadiness) {
    registerProcessReadiness(pid, EVFILT_PROC!, EV_DELETE, 0, 0, token);
  } else if (_removeProc) {
    _removeProc(rawBackend(), pid);
  }
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
  if (_processReadiness) {
    throw new Error('submit() is unavailable when the process reactor owns readiness');
  }
  if (EVFILT_COMPLETION === null) throw new Error('submit() is not supported on this platform');
  const id = _nextCompletionId++;
  const token = taskToken(id);
  return new Promise(function onSubmit(resolve) {
    _completions.set(token, resolve);
    submitter(rawBackend(), token);
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
 * loop.registerWakeSource(fd, drainCompletions);
 * ```
 */
export function registerWakeSource(fd: number, onWake?: () => void): void {
  // The scheduler already watches this isolate's async-runtime wake fd and
  // re-pumps the isolate when it fires. Registering it locally would create an
  // unused second backend inside the parked isolate.
  if (_processReadiness) return;
  const token = taskToken(fd);
  _wakeSources.add(token);
  if (onWake) _wakeSourceCallbacks.set(token, onWake);
  else _wakeSourceCallbacks.delete(token);
  if (_addPersistentRead) {
    _addPersistentRead(rawBackend(), fd, token);
  }
}
/**
 * Stop treating `fd` as a non-live persistent wake source.
 *
 * Removes both its optional callback and its backend read watch. Calls are
 * idempotent, including when the realm delegates readiness and registration
 * was therefore a no-op.
 *
 * @internal
 */
export function unregisterWakeSource(fd: number): void {
  const token = taskToken(fd);
  _wakeSources.delete(token);
  _wakeSourceCallbacks.delete(token);
  if (_processReadiness || _raw === undefined) return;
  backend.removeRead(rawBackend(), fd);
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
export function removeRead(fd: number, forToken?: number): void {
  const token = forToken ?? taskToken(fd);
  _reads.delete(token);
  if (_processReadiness) {
    registerProcessReadiness(fd, EVFILT_READ, EV_DELETE, 0, 0, token);
  } else if (!_reads.has(taskToken(fd)) && !_wakeSources.has(taskToken(fd))) {
    // Only drop the kernel filter once no other owner is still waiting on this
    // descriptor through the main realm's backend.
    backend.removeRead(rawBackend(), fd);
  }
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
export function removeWrite(fd: number, forToken?: number): void {
  const token = forToken ?? taskToken(fd);
  _writes.delete(token);
  if (_processReadiness) {
    registerProcessReadiness(fd, EVFILT_WRITE, EV_DELETE, 0, 0, token);
  } else if (!_writes.has(taskToken(fd))) {
    backend.removeWrite(rawBackend(), fd);
  }
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
 * Returns a promise that resolves once the watch is actually armed on the
 * process backend. Await it when events between the call and the installation
 * would matter; the watch itself is registered synchronously either way.
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
  forToken?: number,
): Promise<void> {
  if (_addVnode === undefined) throw new Error('vnode() is not supported on this platform');
  const token = forToken ?? taskToken(fd);
  _vnodes.set(token, callback);
  if (_processReadiness && EVFILT_VNODE !== null) {
    const installed = _awaitInstall(EVFILT_VNODE, token);
    registerProcessReadiness(fd, EVFILT_VNODE, EV_ADD_ENABLE_CLEAR, fflags, 0, token);
    return installed;
  }
  _addVnode(rawBackend(), fd, fflags, token);
  return Promise.resolve();
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
export function removeVnode(fd: number, forToken?: number): void {
  const token = forToken ?? taskToken(fd);
  if (!_vnodes.has(token)) return;
  _vnodes.delete(token);
  if (_processReadiness && EVFILT_VNODE !== null) {
    _cancelInstall(EVFILT_VNODE, token);
    registerProcessReadiness(fd, EVFILT_VNODE, EV_DELETE, 0, 0, token);
  } else if (backend.removeVnode && !_vnodes.has(taskToken(fd))) {
    backend.removeVnode(rawBackend(), fd);
  }
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
 * Returns a promise that resolves once the watch is armed on the process
 * backend. Await it when a signal delivered between the call and the
 * installation would matter.
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
export function signal(signo: number, callback: () => void, forToken?: number): Promise<void> {
  if (_addSignal === undefined) throw new Error('signal() is not supported on this platform');
  const token = forToken ?? taskToken(signo);
  _signals.set(token, callback);
  if (_processReadiness && EVFILT_SIGNAL !== null) {
    // Stop the default action here, synchronously, before handing the watch to
    // the main realm. Arming is asynchronous, and a signal that arrives in the
    // gap would otherwise run its default disposition and kill the process.
    _suppressSignalDefault?.(signo);
    const installed = _awaitInstall(EVFILT_SIGNAL, token);
    registerProcessReadiness(signo, EVFILT_SIGNAL, EV_ADD_ENABLE_CLEAR, 0, 0, token);
    return installed;
  }
  _addSignal(rawBackend(), signo, token);
  return Promise.resolve();
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
export function removeSignal(signo: number, forToken?: number): void {
  const token = forToken ?? taskToken(signo);
  if (!_signals.has(token)) return;
  _signals.delete(token);
  if (_processReadiness && EVFILT_SIGNAL !== null) {
    _cancelInstall(EVFILT_SIGNAL, token);
    registerProcessReadiness(signo, EVFILT_SIGNAL, EV_DELETE, 0, 0, token);
  } else if (backend.removeSignal && !_signals.has(taskToken(signo))) {
    backend.removeSignal(rawBackend(), signo);
  }
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
      const count = tick(timeout);
      // 3. Drain microtasks produced by I/O dispatch.
      drainMicrotasks();
      if (settled) break;
      emptyTicks = count === 0 ? emptyTicks + 1 : 0;
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
