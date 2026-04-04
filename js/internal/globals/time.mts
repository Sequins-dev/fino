/**
 * fino:time — Timer globals and performance.now().
 *
 * Implements the web-standard timer API:
 *   - `setTimeout(fn, ms, ...args)`  → integer id
 *   - `clearTimeout(id)`
 *   - `setInterval(fn, ms, ...args)` → integer id
 *   - `clearInterval(id)`
 *   - `queueMicrotask(fn)`
 *   - `performance.now()`            → milliseconds (float, monotonic)
 *
 * All timer functions are automatically installed on `globalThis` when this
 * module is first imported, so importing the module is sufficient:
 *
 *   import 'fino:time';
 *   setTimeout(() => console.log('hi'), 500);
 *
 *
 * ## Loop integration
 *
 * Timers are scheduled via `fino:loop`, which is a singleton. Timers keep
 * the process alive until they fire; cancelled timers still consume a slot
 * until they expire.
 *
 *
 * ## Cancellation
 *
 * `clearTimeout` / `clearInterval` mark the timer as cancelled. The
 * underlying kqueue/io_uring timer still fires (it cannot be removed from the
 * backend without a more complex API), but the callback is silently skipped.
 * The process exits as soon as all pending timers have fired and the script is
 * otherwise done — even cancelled ones count as "pending" until they fire.
 *
 *
 * ## performance.now()
 *
 * Returns the elapsed time in milliseconds since module load, with sub-
 * millisecond precision. Uses the same high-resolution monotonic clock as
 * `fino:bench`:
 *   - macOS: `mach_continuous_time()` (advances during sleep)
 *   - Linux: `clock_gettime(CLOCK_MONOTONIC)`
 */

import * as loop from '../../runtime/loop.mts';
import { os } from 'internal:process';
import { dlopen } from 'fino:ffi';

// ---------------------------------------------------------------------------
// High-resolution monotonic timer (nanoseconds) — mirrors bench.mjs
// ---------------------------------------------------------------------------

const _getNanos = (() => {
  if (os === 'darwin') {
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      mach_continuous_time: { parameters: [], result: 'u64' },
      mach_timebase_info:   { parameters: ['buffer'], result: 'i32' },
    });
    const tbiBuf = new ArrayBuffer(8);
    lib.symbols.mach_timebase_info(tbiBuf);
    const tbView = new DataView(tbiBuf);
    const numer = tbView.getUint32(0, true);
    const denom = tbView.getUint32(4, true);
    return function getMachNanos() { return Number(lib.symbols.mach_continuous_time()) * numer / denom; };
  } else {
    const CLOCK_MONOTONIC = 1;
    const lib = dlopen('libc.so.6', {
      clock_gettime: { parameters: ['i32', 'buffer'], result: 'i32' },
    });
    const tsBuf = new ArrayBuffer(16);
    return function getClockNanos() {
      lib.symbols.clock_gettime(CLOCK_MONOTONIC, tsBuf);
      const v = new DataView(tsBuf);
      const sec  = Number(v.getBigInt64(0, true));
      const nsec = Number(v.getBigInt64(8, true));
      return sec * 1e9 + nsec;
    };
  }
})();

const _startNs = _getNanos();

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

const _startMs = Date.now();

/**
 * Subset of the web Performance API.
 * - `performance.now()` — milliseconds elapsed since module load (monotonic, float)
 * - `performance.timeOrigin` — Unix timestamp (ms) of module load
 * - `performance.toJSON()` — serializable snapshot
 */
export const performance = {
  timeOrigin: _startMs,
  now() {
    return (_getNanos() - _startNs) / 1e6;
  },
  toJSON() {
    return { timeOrigin: this.timeOrigin };
  },
};

// ---------------------------------------------------------------------------
// Timer state
// ---------------------------------------------------------------------------

let _nextId = 1;

interface TimerState {
  cancelled: boolean;
  cancelCurrent: () => void;
}

const _timers = new Map<number, TimerState>();

// ---------------------------------------------------------------------------
// setTimeout / clearTimeout
// ---------------------------------------------------------------------------

/**
 * Schedule `fn(...args)` to run after at least `ms` milliseconds.
 *
 * @param {Function} fn
 * @param {number}   [ms=0]
 * @param {...*}     args  Passed to `fn` when it fires.
 * @returns {number} Opaque timer ID for `clearTimeout`.
 */
export function setTimeout(fn: (...args: any[]) => void, ms: number = 0, ...args: any[]): number {
  const id = _nextId++;
  const t = loop.timeout(Math.max(0, Number(ms)) || 0);
  const state: TimerState = { cancelled: false, cancelCurrent: () => t.cancel() };
  _timers.set(id, state);
  t.then(function fireTimeout() {
    _timers.delete(id);
    if (!state.cancelled) fn(...args);
  });
  return id;
}

/**
 * Cancel a pending `setTimeout`. No-op if `id` is unknown or already fired.
 *
 * @param {number} id
 */
export function clearTimeout(id: number): void {
  const state = _timers.get(id);
  if (state) {
    state.cancelled = true;
    state.cancelCurrent();
    _timers.delete(id);
  }
}

// ---------------------------------------------------------------------------
// setInterval / clearInterval
// ---------------------------------------------------------------------------

/**
 * Repeatedly call `fn(...args)` every `ms` milliseconds until cancelled.
 *
 * @param {Function} fn
 * @param {number}   [ms=0]
 * @param {...*}     args
 * @returns {number} Opaque timer ID for `clearInterval`.
 */
export function setInterval(fn: (...args: any[]) => void, ms: number = 0, ...args: any[]): number {
  const id = _nextId++;
  const delay = Math.max(0, Number(ms)) || 0;
  let currentTimer: loop.CancelablePromise | null = null;
  const state: TimerState = {
    cancelled: false,
    cancelCurrent: () => {
      if (currentTimer !== null) {
        currentTimer.cancel();
        currentTimer = null;
      }
    },
  };
  _timers.set(id, state);

  function schedule() {
    if (state.cancelled) return;
    currentTimer = loop.timeout(delay);
    currentTimer.then(function fireInterval() {
      currentTimer = null;
      if (!state.cancelled) {
        fn(...args);
        schedule();
      }
    });
  }
  schedule();
  return id;
}

/**
 * Cancel a repeating `setInterval`. No-op if `id` is unknown.
 *
 * @param {number} id
 */
export function clearInterval(id: number): void {
  clearTimeout(id);
}

// ---------------------------------------------------------------------------
// queueMicrotask
// ---------------------------------------------------------------------------

/**
 * Enqueue `fn` as a microtask — runs before any I/O callbacks but after the
 * current synchronous code completes. Equivalent to `Promise.resolve().then(fn)`.
 *
 * @param {Function} fn
 */
export function queueMicrotask(fn: () => void): void {
  if (typeof fn !== 'function') throw new TypeError('queueMicrotask: argument must be a function');
  Promise.resolve().then(fn);
}

