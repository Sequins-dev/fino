/**
 * internal:globals/time — timer globals and performance.now().
 *
 * Implements the web-standard timer API:
 *   - `setTimeout(fn, ms, ...args)`  → integer id
 *   - `clearTimeout(id)`
 *   - `setInterval(fn, ms, ...args)` → integer id
 *   - `clearInterval(id)`
 *   - `queueMicrotask(fn)`
 *   - `performance.now()`            → milliseconds (float, monotonic)
 *
 * All timer functions are automatically installed on `globalThis` before
 * user scripts run:
 *
 * ```ts no_run
 *   setTimeout(() => console.log('hi'), 500);
 * ```
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
 *
 * This is intentionally a small Performance subset. Fino exposes `now()`,
 * `timeOrigin`, and `toJSON()` only; it does not implement PerformanceEntry,
 * mark(), measure(), observers, or a performance timeline.
 *
 * @internal
 */

import * as loop from 'internal:runtime/loop';
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
 *
 * PerformanceEntry, mark(), measure(), observers, and timeline APIs are not
 * exposed by this runtime subset.
 *
 * @example
 * ```ts no_run
 * const documentedMember = 'performance';
 * console.log(documentedMember);
 * ```
 */
export const performance = {
  /**
   * Unix timestamp in milliseconds captured when this module loaded.
   *
   * ```typescript no_run
   * import { performance } from 'internal:globals/time';
   * performance.timeOrigin <= Date.now(); // true
   * ```
   */
  timeOrigin: _startMs,

  /**
   * Return monotonic milliseconds elapsed since module load.
   *
   * The clock is not affected by system clock adjustments. It is suitable for
   * measuring durations, not for wall-clock timestamps.
   *
   * ```typescript no_run
   * import { performance } from 'internal:globals/time';
   * const start = performance.now();
   * const elapsed = performance.now() - start;
   * ```
   */
  now() {
    return (_getNanos() - _startNs) / 1e6;
  },

  /**
   * Return a JSON-serializable performance snapshot.
   *
   * Only timeOrigin is included in this subset.
   *
   * ```typescript no_run
   * import { performance } from 'internal:globals/time';
   * JSON.stringify(performance.toJSON());
   * ```
   */
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
 * Negative, NaN, and falsy delays are normalized to 0. The returned numeric id
 * can be passed to clearTimeout(). Exceptions thrown by fn propagate through
 * the runtime task execution path.
 *
 * ```typescript no_run
 * const id = setTimeout((name) => console.log(name), 10, 'timer');
 * clearTimeout(id);
 * ```
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
 * Cancellation also calls the runtime timer's cancel hook and removes local
 * timer state. Already-fired timers cannot be cancelled.
 *
 * ```typescript no_run
 * const id = setTimeout(() => console.log('late'), 1000);
 * clearTimeout(id);
 * ```
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
 * The next timeout is scheduled only after the callback returns. A delay less
 * than or equal to 0 schedules each turn as soon as the loop can run it.
 *
 * ```typescript no_run
 * const id = setInterval(() => console.log('tick'), 1000);
 * clearInterval(id);
 * ```
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
 * This shares the same timer state as clearTimeout(), so ids from either API
 * can be cleared without throwing.
 *
 * ```typescript no_run
 * const id = setInterval(() => console.log('tick'), 1000);
 * clearInterval(id);
 * ```
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
 * Passing a non-function throws TypeError.
 *
 * ```typescript no_run
 * queueMicrotask(() => console.log('after current job'));
 * ```
 *
 * @param {Function} fn
 */
export function queueMicrotask(fn: () => void): void {
  if (typeof fn !== 'function') throw new TypeError('queueMicrotask: argument must be a function');
  Promise.resolve().then(fn);
}
