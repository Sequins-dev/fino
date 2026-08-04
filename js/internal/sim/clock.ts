/**
 * internal:sim/clock — swappable time sources for a realm.
 *
 * Every realm reads wall and monotonic time through this module, so a
 * simulation can replace both without the rest of the runtime knowing. The real
 * source is registered by `js/globals/time.ts` during bootstrap rather than
 * being opened here: this module deliberately imports nothing, so installing a
 * virtual clock never depends on guest-visible I/O.
 *
 * The time origin behind `performance.now()` is captured here too. Installing a
 * virtual clock re-captures it, so a simulated realm starts its monotonic
 * timeline at zero instead of inheriting however long bootstrap took.
 *
 * ```ts no_run
 * import { setVirtualClock, wallMillis } from 'internal:sim/clock';
 *
 * let now = 1_700_000_000_000;
 * setVirtualClock({ monotonicNanos: () => now * 1e6, wallMillis: () => now });
 * console.log(wallMillis()); // 1700000000000
 * ```
 *
 * @internal
 */
/**
 * A pair of clocks: one monotonic, one wall.
 *
 * @internal
 */
export interface ClockSource {
  /** Monotonic nanoseconds from an arbitrary origin. Must never go backwards. */
  monotonicNanos(): number;
  /** Milliseconds since the Unix epoch. */
  wallMillis(): number;
}
let _real: ClockSource | null = null;
let _virtual: ClockSource | null = null;
let _originNs = 0;
let _originMs = 0;
function _active(): ClockSource {
  const source = _virtual ?? _real;
  if (source === null) throw new Error('sim/clock: no clock source installed');
  return source;
}
function _captureOrigin(): void {
  const source = _active();
  _originNs = source.monotonicNanos();
  _originMs = source.wallMillis();
}
/**
 * Register the platform clock. The first call wins; later calls are ignored.
 *
 * Called once by `js/globals/time.ts` with its FFI-backed monotonic clock and
 * the pristine `Date.now`, captured before any simulation override can replace
 * the `Date` global.
 *
 * @internal
 */
export function installRealClock(source: ClockSource): void {
  if (_real !== null) return;
  _real = source;
  _captureOrigin();
}
/**
 * Install or remove the virtual clock, re-capturing the monotonic origin.
 *
 * Passing `null` restores the platform clock.
 *
 * @internal
 */
export function setVirtualClock(source: ClockSource | null): void {
  _virtual = source;
  _captureOrigin();
}
/**
 * Milliseconds elapsed since the origin — the value behind `performance.now()`.
 *
 * @internal
 */
export function elapsedMillis(): number {
  return (_active().monotonicNanos() - _originNs) / 1e6;
}
/**
 * The wall-clock timestamp captured at the origin — `performance.timeOrigin`.
 *
 * @internal
 */
export function timeOriginMillis(): number {
  return _originMs;
}
/**
 * Current wall-clock milliseconds — the value behind `Date.now()`.
 *
 * @internal
 */
export function wallMillis(): number {
  return _active().wallMillis();
}
