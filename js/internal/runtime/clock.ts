/**
 * internal:runtime/clock — replaceable wall and monotonic clocks for one Realm.
 *
 * Runtime consumers read time through this module. Ordinary execution uses the
 * platform source installed during global bootstrap; deterministic execution
 * may temporarily replace it without teaching those consumers about policy.
 *
 * @internal
 */

/** Paired monotonic and wall-clock readings. @internal */
export interface ClockSource {
  /** Return monotonic nanoseconds from an arbitrary stable origin. */
  monotonicNanos(): number;
  /** Return milliseconds since the Unix epoch. */
  wallMillis(): number;
}

let platformClock: ClockSource | null = null;
let clockOverride: ClockSource | null = null;
let platformOriginNanos = 0;
let platformOriginMillis = 0;
let overrideOriginNanos = 0;
let overrideOriginMillis = 0;

function activeClock(): ClockSource {
  const clock = clockOverride ?? platformClock;
  if (clock === null) throw new Error('runtime clock source is not installed');
  return clock;
}

/**
 * Install the platform clock if no platform source has been registered yet.
 *
 * The first call wins so later module evaluation cannot silently redefine the
 * ordinary Realm clock.
 *
 * @internal
 */
export function installPlatformClock(clock: ClockSource): void {
  if (platformClock !== null) return;
  platformClock = clock;
  platformOriginNanos = clock.monotonicNanos();
  platformOriginMillis = clock.wallMillis();
}

/**
 * Replace the active clock and capture a new elapsed-time origin.
 *
 * Passing `null` restores the platform clock. Callers own the override for the
 * lifetime of their Realm and must restore it if that Realm continues running.
 *
 * @internal
 */
export function setClockOverride(clock: ClockSource | null): void {
  clockOverride = clock;
  if (clock !== null) {
    overrideOriginNanos = clock.monotonicNanos();
    overrideOriginMillis = clock.wallMillis();
  }
}

/** Return milliseconds elapsed on the active monotonic clock. @internal */
export function elapsedMillis(): number {
  const origin = clockOverride === null ? platformOriginNanos : overrideOriginNanos;
  return (activeClock().monotonicNanos() - origin) / 1e6;
}

/** Return the wall-clock value captured for the current origin. @internal */
export function timeOriginMillis(): number {
  return clockOverride === null ? platformOriginMillis : overrideOriginMillis;
}

/** Return current wall-clock milliseconds. @internal */
export function wallMillis(): number {
  return activeClock().wallMillis();
}
