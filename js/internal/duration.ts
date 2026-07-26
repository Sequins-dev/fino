/**
 * internal:duration — shared duration formatting helpers.
 *
 * Renders elapsed-time measurements as compact human-readable strings with an
 * adaptive unit: nanoseconds, microseconds, milliseconds, seconds, minutes, or
 * hours, chosen so the printed magnitude stays small. Sub-microsecond values
 * are rounded to whole nanoseconds; everything larger is shown with two
 * decimal places. Hours are the largest unit — long durations are never
 * rolled over into days.
 *
 * This module exists so every part of the runtime that reports timing (the
 * test reporter's per-run duration, the benchmark harness's per-iteration
 * statistics) formats it identically. Prefer these helpers over ad-hoc
 * `toFixed` formatting whenever a duration is printed for humans.
 *
 * Both entry points share the same unit ladder; they differ only in the unit
 * of the input number. Use `formatDurationNs` for high-resolution timers and
 * `formatDurationMs` for wall-clock deltas taken in milliseconds.
 *
 * ```ts no_run
 * import { formatDurationNs, formatDurationMs } from 'internal:duration';
 *
 * formatDurationNs(42);      // '42ns'
 * formatDurationNs(1500);    // '1.50us'
 * formatDurationMs(2500);    // '2.50s'
 * formatDurationMs(72e5);    // '2.00h'
 * ```
 *
 * @internal
 */
const NS_PER_MS = 1e6;
const NS_PER_US = 1e3;
const NS_PER_S = NS_PER_MS * 1e3;
const NS_PER_M = NS_PER_S * 60;
const NS_PER_H = NS_PER_M * 60;
function fixed(value: number): string {
  return value.toFixed(2);
}
/**
 * Format a nanosecond duration using the largest readable unit.
 *
 * Durations below one microsecond are rounded to whole nanoseconds
 * (`'42ns'`). Larger values scale up through microseconds, milliseconds,
 * seconds, and minutes to hours, each rendered with two decimal places and a
 * short unit suffix (`us`, `ms`, `s`, `m`, `h`). Hours are the ceiling of the
 * ladder, so a two-day duration renders as `'48.00h'`.
 *
 * Unit selection uses the absolute value, so a negative duration picks the
 * same unit as its magnitude and keeps its sign (`'-1.50ms'`). Non-finite
 * inputs are not treated specially.
 *
 * ```ts no_run
 * import { formatDurationNs } from 'internal:duration';
 *
 * const start = performance.now();
 * doWork();
 * const elapsedNs = (performance.now() - start) * 1e6;
 * console.log(`work took ${formatDurationNs(elapsedNs)}`);
 *
 * formatDurationNs(900);   // '900ns'
 * formatDurationNs(15e5);  // '1.50ms'
 * formatDurationNs(9e10);  // '1.50m'
 * ```
 */
export function formatDurationNs(ns: number): string {
  const abs = Math.abs(ns);
  if (abs < NS_PER_US) return Math.round(ns) + 'ns';
  if (abs < NS_PER_MS) return fixed(ns / NS_PER_US) + 'us';
  if (abs < NS_PER_S) return fixed(ns / NS_PER_MS) + 'ms';
  if (abs < NS_PER_M) return fixed(ns / NS_PER_S) + 's';
  if (abs < NS_PER_H) return fixed(ns / NS_PER_M) + 'm';
  return fixed(ns / NS_PER_H) + 'h';
}
/**
 * Format a millisecond duration using the shared adaptive duration units.
 *
 * A thin wrapper over `formatDurationNs`: the input is scaled from
 * milliseconds to nanoseconds and rendered by the same unit ladder, so
 * sub-microsecond, negative, and multi-hour cases behave exactly as they do
 * there. Use this for wall-clock deltas measured in milliseconds — the kind
 * returned by `Date.now()` or a millisecond-resolution timer — where the raw
 * number would otherwise be printed with `toFixed`.
 *
 * Because a millisecond is a whole number of nanoseconds, small inputs still
 * resolve below the microsecond boundary and render as microseconds or
 * nanoseconds rather than a fractional `ms` value.
 *
 * ```ts no_run
 * import { formatDurationMs } from 'internal:duration';
 *
 * const startMs = Date.now();
 * await runSuite();
 * console.log(`suite finished in ${formatDurationMs(Date.now() - startMs)}`);
 *
 * formatDurationMs(0.5);   // '500.00us'
 * formatDurationMs(2500);  // '2.50s'
 * formatDurationMs(72e5);  // '2.00h'
 * ```
 */
export function formatDurationMs(ms: number): string {
  return formatDurationNs(ms * NS_PER_MS);
}
