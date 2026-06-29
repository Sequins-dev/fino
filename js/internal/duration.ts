/**
* internal:duration — shared duration formatting helpers.
*
* @internal
*/
const NS_PER_MS = 1e6;
const NS_PER_S = NS_PER_MS * 1e3;
const NS_PER_M = NS_PER_S * 60;
const NS_PER_H = NS_PER_M * 60;
function fixed(value: number): string {
  return value.toFixed(2);
}
/**
* Format a nanosecond duration using the largest readable unit.
*
* Durations below one millisecond stay in nanoseconds. Larger values scale to
* milliseconds, seconds, minutes, or hours.
*/
export function formatDurationNs(ns: number): string {
  const abs = Math.abs(ns);
  if (abs < NS_PER_MS) return Math.round(ns) + 'ns';
  if (abs < NS_PER_S) return fixed(ns / NS_PER_MS) + 'ms';
  if (abs < NS_PER_M) return fixed(ns / NS_PER_S) + 's';
  if (abs < NS_PER_H) return fixed(ns / NS_PER_M) + 'm';
  return fixed(ns / NS_PER_H) + 'h';
}
/**
* Format a millisecond duration using the shared adaptive duration units.
*/
export function formatDurationMs(ms: number): string {
  return formatDurationNs(ms * NS_PER_MS);
}
