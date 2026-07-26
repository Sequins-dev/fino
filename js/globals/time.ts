/**
 * Timer globals and the `performance` object.
 *
 * Implements the web-standard timer API:
 *   - `setTimeout(fn, ms, ...args)`  → integer id
 *   - `clearTimeout(id)`
 *   - `setInterval(fn, ms, ...args)` → integer id
 *   - `clearInterval(id)`
 *   - `setImmediate(fn, ...args)`    → integer id
 *   - `clearImmediate(id)`
 *   - `queueMicrotask(fn)`
 *   - `performance.now()`            → milliseconds (float, monotonic)
 *
 * All timer functions are automatically installed on `globalThis` before
 * user scripts run, so no import is needed:
 *
 * ```ts no_run
 *   setTimeout(() => console.log('hi'), 500);
 *   setImmediate(() => console.log('after this turn'));
 * ```
 *
 *
 * ## Loop integration
 *
 * Timers are scheduled via `internal:runtime/loop`, which is a singleton.
 * Pending timers keep the process alive until they fire: the process exits
 * only once all pending timers have fired (or been cancelled) and the script
 * is otherwise done.
 *
 *
 * ## Cancellation
 *
 * `clearTimeout` / `clearInterval` mark the timer as cancelled and remove it
 * from the event loop immediately, so a cancelled timer no longer keeps the
 * process alive. All timer APIs share one numeric id space, so ids from
 * `setTimeout`, `setInterval`, and `setImmediate` may be passed to any of the
 * clear functions interchangeably. Clearing an unknown or already-fired id is
 * a silent no-op.
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
 * This is intentionally a small Performance subset. Fino exposes EventTarget
 * dispatch plus `now()`, `timeOrigin`, and `toJSON()`; it does not implement
 * PerformanceEntry, mark(), measure(), observers, or a performance timeline.
 *
 * Learn more:
 * - HTML timers: https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#timers
 * - High Resolution Time: https://www.w3.org/TR/hr-time-3/
 */
import * as loop from 'internal:runtime/loop';
import { os } from 'internal:process';
import { dlopen } from 'fino:ffi';
import { EventTarget } from './eventtarget.ts';
// ---------------------------------------------------------------------------
// High-resolution monotonic timer (nanoseconds) — mirrors bench.mjs
// ---------------------------------------------------------------------------
const _getNanos = (() => {
  if (os === 'darwin') {
    const lib = dlopen('/usr/lib/libSystem.B.dylib', {
      mach_continuous_time: {
        parameters: [],
        result: 'u64',
      },
      mach_timebase_info: {
        parameters: ['buffer'],
        result: 'i32',
      },
    });
    const tbiBuf = new ArrayBuffer(8);
    lib.symbols.mach_timebase_info(tbiBuf);
    const tbView = new DataView(tbiBuf);
    const numer = tbView.getUint32(0, true);
    const denom = tbView.getUint32(4, true);
    return function getMachNanos() {
      return (Number(lib.symbols.mach_continuous_time()) * numer) / denom;
    };
  } else {
    const CLOCK_MONOTONIC = 1;
    const lib = dlopen('libc.so.6', {
      clock_gettime: {
        parameters: ['i32', 'buffer'],
        result: 'i32',
      },
    });
    const tsBuf = new ArrayBuffer(16);
    return function getClockNanos() {
      lib.symbols.clock_gettime(CLOCK_MONOTONIC, tsBuf);
      const v = new DataView(tsBuf);
      const sec = Number(v.getBigInt64(0, true));
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
const PERFORMANCE_CONSTRUCTOR_TOKEN = {};
const _performanceInstances = new WeakSet<Performance>();
/**
 * Subset of the web Performance API, exposed as the `Performance` global.
 *
 * Instances provide:
 * - `now()` — monotonic milliseconds elapsed since module load (float)
 * - `timeOrigin` — Unix timestamp (ms) captured at module load
 * - `toJSON()` — JSON-serializable snapshot
 * - EventTarget methods (`addEventListener`, `dispatchEvent`, ...) inherited
 *   from the EventTarget global implementation
 *
 * PerformanceEntry, `mark()`, `measure()`, observers, and the performance
 * timeline are not part of this runtime subset.
 *
 * The class exists so `performance instanceof Performance` and WebIDL-style
 * brand checks behave as on the web; it cannot be constructed directly.
 * Calling `now()`, `toJSON()`, or the `timeOrigin` getter with a `this` that
 * is not a genuine Performance instance throws a TypeError
 * (`Illegal invocation`).
 *
 * ```ts no_run
 * console.log(performance instanceof Performance); // true
 * const start = performance.now();
 * // ... work ...
 * console.log(`took ${performance.now() - start}ms`);
 * ```
 */
export class Performance extends EventTarget {
  /**
   * Unix timestamp in milliseconds captured when this module loaded.
   *
   * Combine with `now()` to convert a monotonic reading into an approximate
   * wall-clock time: `timeOrigin + now()`. Throws a TypeError if read from a
   * `this` that is not a Performance instance.
   *
   * ```ts no_run
   * performance.timeOrigin <= Date.now(); // true
   * ```
   */
  get timeOrigin() {
    if (!_performanceInstances.has(this)) throw new TypeError('Illegal invocation');
    return _startMs;
  }
  /** Brands instances as `[object Performance]` for `Object.prototype.toString`. */
  get [Symbol.toStringTag]() {
    return 'Performance';
  }
  /**
   * Not user-constructible: throws a TypeError (`Illegal constructor`) unless
   * invoked with the module-private token. Use the shared `performance`
   * instance instead.
   */
  constructor(token?: object) {
    if (token !== PERFORMANCE_CONSTRUCTOR_TOKEN) throw new TypeError('Illegal constructor');
    super();
    _performanceInstances.add(this);
  }
  /**
   * Return monotonic milliseconds elapsed since module load, with
   * sub-millisecond precision.
   *
   * The clock is not affected by system clock adjustments, so it is suitable
   * for measuring durations — not for wall-clock timestamps (use `Date.now()`
   * or `timeOrigin + now()` for those). Throws a TypeError if called on a
   * `this` that is not a Performance instance.
   *
   * ```ts no_run
   * const start = performance.now();
   * const elapsed = performance.now() - start;
   * ```
   */
  now() {
    if (!_performanceInstances.has(this)) throw new TypeError('Illegal invocation');
    return (_getNanos() - _startNs) / 1e6;
  }
  /**
   * Return a JSON-serializable performance snapshot.
   *
   * Only `timeOrigin` is included in this subset. Throws a TypeError if
   * called on a `this` that is not a Performance instance.
   *
   * ```ts no_run
   * JSON.stringify(performance.toJSON()); // {"timeOrigin":...}
   * ```
   */
  toJSON() {
    if (!_performanceInstances.has(this)) throw new TypeError('Illegal invocation');
    return { timeOrigin: this.timeOrigin };
  }
}
Object.defineProperty(Performance, 'length', {
  value: 0,
  configurable: true,
});
for (const method of ['now', 'toJSON'] as const) {
  Object.defineProperty(Performance.prototype[method], 'length', {
    value: 0,
    configurable: true,
  });
  Object.defineProperty(Performance.prototype, method, {
    ...Object.getOwnPropertyDescriptor(Performance.prototype, method)!,
    enumerable: true,
  });
}
Object.defineProperty(Performance.prototype, 'timeOrigin', {
  ...Object.getOwnPropertyDescriptor(Performance.prototype, 'timeOrigin')!,
  enumerable: true,
});
/**
 * The shared Performance instance, installed as `globalThis.performance`.
 *
 * This is the only Performance instance in a realm — the constructor is not
 * user-callable. Its `timeOrigin` marks when the runtime loaded this module.
 *
 * ```ts no_run
 * const start = performance.now();
 * await new Promise((resolve) => setTimeout(resolve, 50));
 * console.log(performance.now() - start); // ≈50 (fractional)
 * ```
 */
export const performance = new Performance(PERFORMANCE_CONSTRUCTOR_TOKEN);
// ---------------------------------------------------------------------------
// Timer state
// ---------------------------------------------------------------------------
let _nextId = 1;
/** Per-timer bookkeeping shared by all timer APIs: a cancelled flag plus a hook that removes the currently scheduled loop timer. */
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
 * Negative, NaN, and falsy delays are normalized to 0; a 0 delay fires on the
 * next loop turn, after the current synchronous code and any pending
 * microtasks. Extra arguments are forwarded to `fn` when it fires. The
 * returned numeric id can be passed to `clearTimeout()` to cancel the timer
 * before it fires. Pending timers keep the process alive.
 *
 * ```ts no_run
 * const id = setTimeout((name) => console.log(name), 10, 'timer');
 * clearTimeout(id);
 * ```
 */
export function setTimeout(fn: (...args: any[]) => void, ms: number = 0, ...args: any[]): number {
  const id = _nextId++;
  const t = loop.timeout(Math.max(0, Number(ms)) || 0);
  const state: TimerState = {
    cancelled: false,
    cancelCurrent: () => t.cancel(),
  };
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
 * Cancellation removes the timer from the event loop immediately, so it no
 * longer keeps the process alive. Clearing the same id more than once is
 * safe, and non-numeric values like `undefined` or `null` are ignored.
 *
 * ```ts no_run
 * const id = setTimeout(() => console.log('late'), 1000);
 * clearTimeout(id);
 * ```
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
 * The next timeout is scheduled only after the callback returns, so slow
 * callbacks stretch the effective period rather than piling up. Delay
 * normalization matches `setTimeout`: negative, NaN, and falsy delays become
 * 0, which schedules each tick as soon as the loop can run it. The returned
 * id can be passed to `clearInterval()`; an interval keeps the process alive
 * until it is cleared.
 *
 * ```ts no_run
 * let ticks = 0;
 * const id = setInterval(() => {
 *   if (++ticks === 3) clearInterval(id);
 * }, 1000);
 * ```
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
 * Shares the same timer state as `clearTimeout()`, so ids from either API
 * can be cleared through either function without throwing. Cancellation is
 * safe from inside the interval callback itself.
 *
 * ```ts no_run
 * const id = setInterval(() => console.log('tick'), 1000);
 * clearInterval(id);
 * ```
 */
export function clearInterval(id: number): void {
  clearTimeout(id);
}
// ---------------------------------------------------------------------------
// setImmediate / clearImmediate
// ---------------------------------------------------------------------------
/**
 * Schedule `fn(...args)` to run after the current synchronous turn completes.
 *
 * Equivalent to `setTimeout(fn, 0, ...args)`: immediate callbacks use the
 * same runtime loop and numeric id space as timers, and run after pending
 * microtasks. Extra arguments are forwarded to `fn`. The returned id can be
 * passed to `clearImmediate()` before the callback runs.
 *
 * ```ts no_run
 * const id = setImmediate((name) => console.log(name), 'immediate');
 * clearImmediate(id);
 * ```
 */
export function setImmediate(fn: (...args: any[]) => void, ...args: any[]): number {
  return setTimeout(fn, 0, ...args);
}
/**
 * Cancel a pending `setImmediate`. No-op if `id` is unknown or already fired.
 *
 * Alias for `clearTimeout()` — immediates share the timer id space.
 *
 * ```ts no_run
 * const id = setImmediate(() => console.log('later'));
 * clearImmediate(id);
 * ```
 */
export function clearImmediate(id: number): void {
  clearTimeout(id);
}
// ---------------------------------------------------------------------------
// queueMicrotask
// ---------------------------------------------------------------------------
/**
 * Enqueue `fn` as a microtask — runs before any I/O or timer callbacks but
 * after the current synchronous code completes.
 *
 * Equivalent to `Promise.resolve().then(fn)`. Microtasks run in registration
 * order, and the callback receives no arguments. Throws a TypeError if `fn`
 * is not a function.
 *
 * ```ts no_run
 * setTimeout(() => console.log('timer'), 0);
 * queueMicrotask(() => console.log('microtask')); // logs first
 * ```
 */
export function queueMicrotask(fn: () => void): void {
  if (typeof fn !== 'function') throw new TypeError('queueMicrotask: argument must be a function');
  Promise.resolve().then(() => fn());
}
