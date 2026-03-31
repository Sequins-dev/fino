/**
 * boats:loop — promise-based event loop API with structured concurrency.
 *
 * This module is the heart of Boats's concurrency model. It wraps the
 * platform-specific I/O polling backend (kqueue on macOS, io_uring on Linux)
 * and exposes a simple, unified Promise API for async I/O. All higher-level
 * modules — `boats:stream`, `boats:socket`, `boats:file`, `boats:dns`,
 * `boats:process` — build on this foundation.
 *
 *
 * ## Structured concurrency — parent-child loop tree
 *
 * Every loop created via `create()` is automatically bound to `current()` as
 * its parent. The parent polls its children's I/O via `_tickChildren()` when
 * it has no events of its own. `__boatsTick__` (driven by `_main.mjs`) calls
 * `_tickChildren` for each root loop, so the entire tree is covered.
 *
 * Root loops are those created with no current loop in scope (i.e., outside
 * any `run()` / `runWith()` call). They are tracked in `_active` and driven
 * by `_main.mjs` via the exported `tick()` / `alive()` functions.
 *
 * Child loops are not in `_active`; they are polled by their parent.
 *
 *
 * ## Per-loop microtask isolation
 *
 * Every promise continuation is tagged with the loop ID active when it was
 * enqueued (via `internal:async-context`). `spin()` drains only the current
 * loop's microtasks via `drainLoopMicrotasks(id)`, leaving other loops' jobs
 * untouched in the queue. This ensures that spinning loop A does not
 * accidentally run loop B's continuations.
 *
 * `_main.mjs` uses a global drain (`drainMicrotasks()`), which is safe
 * because the global loop never runs concurrently with a `spin()` call.
 *
 *
 * ## Architecture: LoopHandle and private state
 *
 * Each call to `create()` returns an opaque `LoopHandle` object. The actual
 * state (the raw backend handle, the pending-read/write/timer Maps, etc.) is
 * stored in a module-level `WeakMap` keyed on the handle. This is the standard
 * ES2022 private-state-via-WeakMap pattern.
 *
 * **Why WeakMap instead of `#privateField`?** The loop's internal state needs
 * to be accessible to module-level functions like `readable()`, `writable()`,
 * `timeout()`, etc. Private class fields are only accessible inside the class
 * body, so they'd force everything to be a method on the class. The WeakMap
 * pattern keeps the public API as plain exported functions while still
 * encapsulating state.
 *
 *
 * ## Why Array instead of Set for _active
 *
 * The list of live root loop handles is stored as an Array rather than a Set
 * because of a known Boa GC bug: iterating over a Set while the GC is
 * also visiting it causes a panic in Boa's finalizer code. Array iteration
 * in `__boatsTick__` doesn't trigger the same issue.
 *
 *
 * ## Platform abstraction
 *
 * kqueue (macOS) and io_uring (Linux) share the same backend interface:
 *   `create()`, `addRead()`, `addWrite()`, `removeRead()`, `removeWrite()`,
 *   `addTimer()`, `wait()`, `destroy()`
 * Each returns events as `{ ident, filter, flags, res }` objects using the
 * kqueue filter constants (EVFILT_READ, EVFILT_WRITE, etc.) as a common
 * language. io_uring maps its CQE completions to these same constants in
 * `drainCqes()`.
 *
 * Two extra capabilities exist on specific platforms:
 *   - `proc(loop, pid)` — macOS only; uses EVFILT_PROC to await child exit.
 *     On Linux, use `pidfd_open(2)` + `readable()` instead.
 *   - `submit(loop, fn)` — Linux only; submits a raw io_uring SQE and awaits
 *     its CQE. Used by `boats:file` for async open/read/close.
 *
 *
 * ## Usage
 *
 *   import * as loop from 'boats:runtime/loop';
 *
 *   const lp = loop.create();
 *
 *   await loop.readable(lp, fd);   // resolves when fd is readable
 *   await loop.writable(lp, fd);   // resolves when fd is writable
 *   await loop.timeout(lp, 500);   // resolves after 500 ms
 *
 *   loop.destroy(lp);              // process exits when all loops gone
 *
 *
 * ## Synchronous spinning — spin(), run(), current()
 *
 * For contexts that need to drive an event loop synchronously (e.g. benchmark
 * harnesses), `spin(lp, promise)` blocks the current call stack, polling `lp`
 * until the promise settles:
 *
 *   const result = loop.spin(lp, someAsyncFn());
 *
 * `run(fn)` is a convenience that creates a loop, sets it as the current loop
 * (via `boats:context`), runs `fn`, spins to completion, and destroys it:
 *
 *   const result = loop.run(async () => {
 *     const lp = loop.current();      // the loop created by run()
 *     const fs = new DiskFileSystem(lp);
 *     return await fs.readFile('/etc/hosts');
 *   });
 *
 * `loop.current()` returns the loop set by the nearest enclosing `run()` or
 * `runWith()` call in the current async scope. The value propagates through
 * `await` and `.then()` automatically via `boats:context`.
 *
 *
 * ## AbortSignal support
 *
 * `spin(lp, promise, { signal })` and `run(fn, { signal })` both accept an
 * `AbortSignal`. If the signal fires, the spin exits early with the signal's
 * abort reason as the thrown value. A pre-aborted signal is detected before
 * any I/O is polled.
 *
 *
 * ## Contributing
 *
 * - Each pending read/write/timer is stored as a single `resolve` function in
 *   a Map (fd → resolve). Re-registering for the same fd replaces the previous
 *   resolver. This is intentional: a caller that re-registers is implicitly
 *   abandoning the previous wait.
 * - `removeRead`/`removeWrite` drop the pending resolver without resolving it.
 *   The caller is responsible for ensuring the dropped Promise doesn't leak.
 * - Don't use `Set` anywhere in the hot path (the exported `tick()` function)
 *   due to the Boa GC issue described above.
 */

import { os } from 'internal:process';
import { Context, createLoopId, enterLoop, exitLoop, drainLoopMicrotasks, hasLoopWork } from 'boats:runtime/context';

// boats:loop-backend is resolved by the Rust loader to boats:kqueue (macOS)
// or boats:io_uring (Linux) at compile time — a static import avoids
// top-level `await`, which would make this an async module and trigger a
// Boa 0.21.1 panic on module teardown.
import * as backend from 'internal:runtime/loop-backend';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** kqueue/io_uring event shape dispatched to the loop. */
interface LoopEvent {
  ident:   number;
  filter:  number;
  flags:   number;
  fflags?: number;
  res?:    number;
}

/** Private state stored in the _priv WeakMap for each LoopHandle. */
interface LoopPrivate {
  raw:              object;
  loopId:           number;
  parent:           LoopHandle | null;
  children:         LoopHandle[];
  reads:            Map<number, () => void>;
  writes:           Map<number, () => void>;
  timers:           Map<number, () => void>;
  procs:            Map<number, () => void>;
  completions:      Map<number, (result: { res: number }) => void>;
  vnodes:           Map<number, (event: { fflags: number }) => void>;
  signals:          Map<number, () => void>;
  nextTimerId:      number;
  nextCompletionId: number;
}

/** Options accepted by spin() and run(). */
interface SpinOptions {
  signal?: AbortSignal;
}

const { EVFILT_READ, EVFILT_WRITE, EVFILT_TIMER } = backend;

// Context slot tracking the "current" loop — propagates through await via
// BoatsJobExecutor. Used by spin(), run(), runWith(), and current().
const currentLoop = new Context('currentLoop');
// EVFILT_PROC is kqueue-only (macOS). EVFILT_COMPLETION is io_uring-only (Linux).
// EVFILT_VNODE is kqueue-only (macOS) — used for file/directory watching.
// EVFILT_SIGNAL is available on both platforms (kqueue native, io_uring via signalfd).
const EVFILT_PROC       = backend.EVFILT_PROC       ?? null;
const EVFILT_COMPLETION = backend.EVFILT_COMPLETION ?? null;
const EVFILT_VNODE      = backend.EVFILT_VNODE      ?? null;
const EVFILT_SIGNAL     = backend.EVFILT_SIGNAL     ?? null;

// Array of root loop handles (those created with no parent in scope).
// Using Array instead of Set to avoid a Boa GC bug where Set iterator
// finalizers panic when the Set is already borrowed during __boatsTick__.
const _active = [];

// WeakMap storing private state for each LoopHandle.
const _priv = new WeakMap();

/** Opaque handle returned by create(). Internal state stored in _priv. */
export class LoopHandle {}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function _dispatch(handle: LoopHandle, ev: LoopEvent): void {
  const p = _priv.get(handle);
  if (ev.filter === EVFILT_READ) {
    const resolve = p.reads.get(ev.ident);
    if (resolve) {
      p.reads.delete(ev.ident);
      backend.removeRead(p.raw, ev.ident);
      resolve();
    }
  } else if (ev.filter === EVFILT_WRITE) {
    const resolve = p.writes.get(ev.ident);
    if (resolve) {
      p.writes.delete(ev.ident);
      backend.removeWrite(p.raw, ev.ident);
      resolve();
    }
  } else if (ev.filter === EVFILT_TIMER) {
    const resolve = p.timers.get(ev.ident);
    if (resolve) {
      p.timers.delete(ev.ident);
      resolve();
    }
  } else if (EVFILT_PROC !== null && ev.filter === EVFILT_PROC) {
    const resolve = p.procs.get(ev.ident);
    if (resolve) {
      p.procs.delete(ev.ident);
      resolve();
    }
  } else if (EVFILT_COMPLETION !== null && ev.filter === EVFILT_COMPLETION) {
    const resolve = p.completions.get(ev.ident);
    if (resolve) {
      p.completions.delete(ev.ident);
      resolve({ res: ev.res });
    }
  } else if (EVFILT_VNODE !== null && ev.filter === EVFILT_VNODE) {
    const cb = p.vnodes.get(ev.ident);
    if (cb) {
      // Do NOT delete — vnode watches are persistent (EV_CLEAR re-arms them).
      cb({ fflags: ev.fflags });
    }
  } else if (EVFILT_SIGNAL !== null && ev.filter === EVFILT_SIGNAL) {
    const cb = p.signals.get(ev.ident);
    if (cb) {
      // Do NOT delete — signal watches are persistent until removeSignal() is called.
      cb();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — structured concurrency
// ---------------------------------------------------------------------------

/**
 * Non-blocking poll of all children (and grandchildren) of `handle`.
 * Dispatches any ready events and drains the child loop's microtasks.
 * Returns the total number of events dispatched.
 */
function _tickChildren(handle: LoopHandle): number {
  const p = _priv.get(handle);
  let total = 0;
  for (const child of p.children) {
    const cp = _priv.get(child);
    const events = backend.wait(cp.raw, 0);
    for (let i = 0; i < events.length; i++) {
      _dispatch(child, events[i]);
      total++;
    }
    if (events.length > 0) {
      const prevId = enterLoop(cp.loopId);
      drainLoopMicrotasks(cp.loopId);
      exitLoop(prevId);
    }
    total += _tickChildren(child);
  }
  return total;
}

/**
 * Returns true if `handle` or any of its descendants have pending work:
 * I/O registrations, pending microtasks, or living children.
 */
function _isAlive(handle: LoopHandle): boolean {
  const p = _priv.get(handle);
  if (p.reads.size > 0 || p.writes.size > 0 || p.timers.size > 0) return true;
  if (p.procs.size > 0) return true;
  if (p.completions.size > 0) return true;
  if (p.vnodes.size > 0) return true;
  if (p.signals.size > 0) return true;
  if (hasLoopWork(p.loopId)) return true;
  for (const child of p.children) {
    if (_isAlive(child)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Runtime hooks — exported for js/_main.mjs to drive the event loop
// ---------------------------------------------------------------------------

/**
 * Poll all root loops for I/O events and dispatch them. Called by `_main.mjs`
 * on every iteration of the outer run loop.
 *
 * @param {number} timeoutMs  How long to block waiting for events (0 = non-blocking).
 * @returns {number} Total number of events dispatched.
 */
export function tick(timeoutMs: number): number {
  let total = 0;
  for (const handle of _active) {
    const p = _priv.get(handle);
    const events = backend.wait(p.raw, timeoutMs);
    for (const ev of events) {
      _dispatch(handle, ev);
      total++;
    }
    // When this root loop has no own I/O, tick its children.
    if (events.length === 0) {
      total += _tickChildren(handle);
    }
  }
  return total;
}

/**
 * Returns true if any root loop (or its descendants) has pending I/O work.
 * `_main.mjs` uses this to decide whether to exit the run loop.
 */
export function alive(): boolean {
  return _active.some(_isAlive);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new event loop handle.
 *
 * The handle is automatically bound to `current()` as its parent. When the
 * parent loop is idle, it polls this loop's I/O via `_tickChildren()`. If
 * there is no current loop, this handle is a root loop — it is added to
 * `_active` and driven by `_main.mjs` via the exported `tick()` function.
 *
 * The process stays alive until all root loops and their descendants are
 * destroyed (`loop.destroy(lp)`).
 */
export function create(): LoopHandle {
  const handle = new LoopHandle();
  const loopId = createLoopId();
  // Guard against stale context: if the propagated handle was already destroyed
  // (no longer in _priv), treat this as a root loop rather than crashing.
  const parentCandidate = currentLoop.get();
  const parent = (parentCandidate != null && _priv.has(parentCandidate)) ? parentCandidate : null;

  _priv.set(handle, {
    raw:              backend.create() as object,
    loopId,
    parent,
    children:         [],
    reads:            new Map(), // fd → resolve
    writes:           new Map(), // fd → resolve
    timers:           new Map(), // id → resolve
    procs:            new Map(), // pid → resolve  (macOS EVFILT_PROC)
    completions:      new Map(), // id → resolve({ res })  (Linux io_uring async ops)
    vnodes:           new Map(), // fd → callback({ fflags })  (macOS EVFILT_VNODE)
    signals:          new Map(), // signo → callback()  (EVFILT_SIGNAL on both platforms)
    nextTimerId:      1,
    nextCompletionId: 1,
  });

  if (parent) {
    const pp = _priv.get(parent);
    pp.children.push(handle);
  } else {
    // Root loop — tracked so _main.mjs can drive it via tick().
    _active.push(handle);
  }

  return handle;
}

/**
 * Returns a Promise that resolves the next time `fd` becomes readable.
 * Calling `readable()` for a fd that already has a pending read replaces
 * the previous resolver.
 */
export function readable(loop: LoopHandle, fd: number): Promise<void> {
  const p = _priv.get(loop);
  return new Promise((resolve) => {
    p.reads.set(fd, resolve);
    backend.addRead(p.raw, fd, fd);
  });
}

/**
 * Returns a Promise that resolves the next time `fd` becomes writable.
 */
export function writable(loop: LoopHandle, fd: number): Promise<void> {
  const p = _priv.get(loop);
  return new Promise((resolve) => {
    p.writes.set(fd, resolve);
    backend.addWrite(p.raw, fd, fd);
  });
}

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 */
export function timeout(loop: LoopHandle, ms: number): Promise<void> {
  const p = _priv.get(loop);
  const id = p.nextTimerId++;
  return new Promise((resolve) => {
    p.timers.set(id, resolve);
    backend.addTimer(p.raw, id, ms);
  });
}

/**
 * Returns a Promise that resolves when `pid` exits (macOS only, via EVFILT_PROC).
 * On Linux, obtain a pidfd via pidfd_open(2) and use readable() instead.
 *
 * Handles the race where the process exits before EVFILT_PROC is registered:
 * addProc() returns false in that case, and we resolve immediately so the
 * caller can proceed to waitpid().
 */
export function proc(loop: LoopHandle, pid: number): Promise<void> {
  if (!backend.addProc) throw new Error('proc() is not supported on this platform');
  const p = _priv.get(loop);
  return new Promise((resolve) => {
    // Register before calling addProc so the event can never be missed.
    p.procs.set(pid, resolve);
    const registered = backend.addProc(p.raw, pid, pid);
    if (!registered) {
      // Process already exited — kevent rejected the filter.
      // Resolve immediately so the caller can reap the zombie with waitpid.
      p.procs.delete(pid);
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
 * @example
 * const { res } = await loop.submit(lp, (raw, id) => uring.asyncRead(raw, fd, buf, len, id));
 * if (res < 0) throw new Error(`read failed: errno ${-res}`);
 */
export function submit(loop: LoopHandle, submitter: (raw: object, id: number) => void): Promise<{ res: number }> {
  if (EVFILT_COMPLETION === null) throw new Error('submit() is not supported on this platform');
  const p = _priv.get(loop);
  const id = p.nextCompletionId++;
  return new Promise((resolve) => {
    p.completions.set(id, resolve);
    submitter(p.raw, id);
  });
}

/**
 * Cancel a pending read watch for `fd` (rejects any pending promise silently).
 */
export function removeRead(loop: LoopHandle, fd: number): void {
  const p = _priv.get(loop);
  p.reads.delete(fd);
  backend.removeRead(p.raw, fd);
}

/**
 * Cancel a pending write watch for `fd`.
 */
export function removeWrite(loop: LoopHandle, fd: number): void {
  const p = _priv.get(loop);
  p.writes.delete(fd);
  backend.removeWrite(p.raw, fd);
}

/**
 * Register a persistent vnode watch on `fd` (macOS only, via EVFILT_VNODE).
 *
 * `fflags` is a bitmask of NOTE_* constants (NOTE_DELETE | NOTE_WRITE | ...).
 * `callback` is called with `{ fflags }` on every event — it may be called
 * multiple times as events accumulate. Unlike readable()/writable(), this watch
 * persists until `removeVnode()` is called; it does NOT auto-remove on delivery.
 *
 * The fd must remain open for the lifetime of the watch.
 *
 * @throws {Error} If vnode watching is not supported on this platform.
 */
export function vnode(loop: LoopHandle, fd: number, fflags: number, callback: (event: { fflags: number }) => void): void {
  if (!backend.addVnode) throw new Error('vnode() is not supported on this platform');
  const p = _priv.get(loop);
  p.vnodes.set(fd, callback);
  backend.addVnode(p.raw, fd, fflags, fd);
}

/**
 * Remove a vnode watch for `fd`.
 */
export function removeVnode(loop: LoopHandle, fd: number): void {
  const p = _priv.get(loop);
  if (!p.vnodes.has(fd)) return;
  p.vnodes.delete(fd);
  if (backend.removeVnode) backend.removeVnode(p.raw, fd);
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
 */
export function signal(loop: LoopHandle, signo: number, callback: () => void): void {
  if (!backend.addSignal) throw new Error('signal() is not supported on this platform');
  const p = _priv.get(loop);
  p.signals.set(signo, callback);
  backend.addSignal(p.raw, signo);
}

/**
 * Remove a signal watch for `signo` and restore the default OS signal action.
 */
export function removeSignal(loop: LoopHandle, signo: number): void {
  const p = _priv.get(loop);
  if (!p.signals.has(signo)) return;
  p.signals.delete(signo);
  if (backend.removeSignal) backend.removeSignal(p.raw, signo);
}

/**
 * Destroy the loop handle and release the underlying kqueue/io_uring fd.
 * Unlinks from the parent's children list (if a child loop), or removes from
 * `_active` (if a root loop). The process exits when all root loops and their
 * descendants are destroyed.
 */
export function destroy(loop: LoopHandle): void {
  const p = _priv.get(loop);
  backend.destroy(p.raw);
  if (p.parent) {
    const pp = _priv.get(p.parent);
    const idx = pp.children.indexOf(loop);
    if (idx >= 0) pp.children.splice(idx, 1);
  } else {
    const idx = _active.indexOf(loop);
    if (idx >= 0) _active.splice(idx, 1);
    // Clear the current loop context if this loop was it, so that
    // loop.current() correctly returns undefined after the loop is gone.
    if (currentLoop.get() === loop) currentLoop.exit();
  }
  _priv.delete(loop);
}

/**
 * Synchronously drive `loop` until `promise` settles, then return the
 * resolved value (or re-throw the rejection reason).
 *
 * Each iteration:
 *   1. Drains this loop's microtasks via `drainLoopMicrotasks(loopId)`.
 *      Only jobs tagged with this loop's ID are run — other loops' jobs
 *      remain queued, providing per-loop microtask isolation.
 *   2. Polls this loop's I/O (non-blocking on busy ticks, blocking up to
 *      50 ms after 3 consecutive idle ticks to avoid busy-spinning).
 *   3. Drains microtasks again after I/O dispatch.
 *   4. When this loop has no I/O, ticks child loops' I/O recursively.
 *
 * While `spin()` is executing, `_main.mjs`'s outer `runLoop` is blocked on
 * the call stack, so there is no concurrent global drain or `tick()` call.
 *
 * @param {LoopHandle}  loop       The loop to drive.
 * @param {Promise}     promise    The promise to await synchronously.
 * @param {object}      [options]
 * @param {AbortSignal} [options.signal]  Abort the spin when this signal fires.
 * @returns The resolved value of `promise`.
 * @throws  The rejection reason, or the abort signal's reason.
 */
export function spin<T>(loop: LoopHandle, promise: Promise<T>, options?: SpinOptions): T {
  const p = _priv.get(loop);
  const signal = options?.signal;

  if (signal?.aborted) throw signal.reason;

  let settled = false;
  let result: T | undefined, error: unknown;
  let hasError = false;

  promise.then(
    (v) => { result = v; settled = true; },
    (e) => { error = e; hasError = true; settled = true; },
  );

  let onAbort;
  if (signal) {
    onAbort = () => { error = signal.reason; hasError = true; settled = true; };
    signal.addEventListener('abort', onAbort);
  }

  const prev = enterLoop(p.loopId);
  try {
    let emptyTicks = 0;
    while (!settled) {
      // 1. Drain this loop's microtasks.
      drainLoopMicrotasks(p.loopId);
      if (settled) break;

      // 2. Poll this loop's I/O. Block up to 50 ms when idle to avoid
      //    busy-spinning; 10 ms when a signal could fire.
      const timeout = emptyTicks >= 3 ? (signal ? 10 : 50) : 0;
      const events = backend.wait(p.raw, timeout);
      for (let i = 0; i < events.length; i++) _dispatch(loop, events[i]);

      // 3. Drain microtasks produced by I/O dispatch.
      drainLoopMicrotasks(p.loopId);
      if (settled) break;

      // 4. When this loop has no I/O, tick child loops' I/O.
      let childEvents = 0;
      if (events.length === 0) {
        childEvents = _tickChildren(loop);
      }

      emptyTicks = (events.length === 0 && childEvents === 0) ? emptyTicks + 1 : 0;
    }
  } finally {
    exitLoop(prev);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }

  if (hasError) throw error;
  return result as T;
}

/**
 * Return the loop handle set as current in the nearest enclosing `run()` or
 * `runWith()` call in the current async scope, or `undefined` if no loop is
 * currently active.
 *
 * The value propagates through `await` and `.then()` automatically because it
 * is stored in a `boats:context` Context backed by `BoatsJobExecutor`.
 *
 * @returns {LoopHandle | undefined}
 */
export function current(): LoopHandle | undefined {
  return currentLoop.get();
}

/**
 * Set `loop` as the current loop for the duration of `fn`, then restore the
 * previous value. Also sets the Rust-level current loop ID so that jobs
 * enqueued inside `fn` are tagged with this loop's ID and drained by
 * `drainLoopMicrotasks` when this loop spins.
 *
 * Does not create or destroy the loop — the caller is responsible for its
 * lifecycle. Useful when you need to reuse one loop across multiple calls
 * (e.g. a benchmark measurement loop) while still having `loop.current()`
 * work inside each call.
 *
 * @param {LoopHandle} loop  The loop to set as current.
 * @param {function}   fn    Called with the loop set as current.
 * @returns The return value of `fn()`.
 */
export function runWith<T>(loop: LoopHandle, fn: () => T): T {
  const p = _priv.get(loop);
  const prev = enterLoop(p.loopId);
  try {
    return currentLoop.runWithValue(loop, fn);
  } finally {
    exitLoop(prev);
  }
}

/**
 * Create a loop, set it as the current loop for the duration of `fn`, drive
 * it synchronously until `fn`'s returned promise settles, then destroy it.
 *
 * Equivalent to:
 *   const lp = loop.create();
 *   loop.runWith(lp, () => loop.spin(lp, fn()));
 *   loop.destroy(lp);
 *
 * Useful for running an async task that needs a dedicated event loop without
 * exposing the loop lifecycle to the caller.
 *
 * @param {function} fn       Sync or async function. May call `loop.current()`
 *                            to obtain the created loop handle.
 * @param {object}   [options]
 * @param {AbortSignal} [options.signal]  Forwarded to `spin()`.
 * @returns The settled value of `fn()`.
 */
export function run<T>(fn: () => T | Promise<T>, options?: SpinOptions): T {
  const lp = create();
  let result;
  try {
    result = runWith(lp, () => {
      const ret = fn();
      if (ret && typeof ret.then === 'function') {
        return spin(lp, ret, options);
      }
      return ret;
    });
  } finally {
    destroy(lp);
  }
  return result;
}
