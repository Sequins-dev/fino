/**
* Tests for internal:jobs/cron — parsing and next-occurrence math (UTC).
*/
import { describe, it } from 'fino:test/test';
import { parseCron, nextOccurrence, type CronSpec } from 'internal:jobs/cron';
function at(iso: string): number {
  return Date.parse(iso);
}
describe('cron parsing', () => {
  it('accepts field syntax', (t) => {
    const spec = parseCron('*/15 2-4 1,15 * 1-5') as CronSpec;
    t.deepEqual(spec.minutes, [
      0,
      15,
      30,
      45
    ], 'star step expands');
    t.deepEqual(spec.hours, [
      2,
      3,
      4
    ], 'range expands');
    t.deepEqual(spec.daysOfMonth, [1, 15], 'comma list expands');
    t.equal(spec.months.length, 12, 'star month allows all');
    t.deepEqual(spec.daysOfWeek, [
      1,
      2,
      3,
      4,
      5
    ], 'weekday range expands');
    t.ok(spec.domRestricted && spec.dowRestricted, 'restriction flags set');
  });
  it('normalizes Sunday 7 to 0 and supports aliases', (t) => {
    t.deepEqual((parseCron('0 0 * * 7') as CronSpec).daysOfWeek, [0], '7 becomes 0');
    t.deepEqual((parseCron('@weekly') as CronSpec).daysOfWeek, [0], '@weekly is Sunday midnight');
    const every = parseCron('every:90s');
    t.equal(every.kind, 'every', 'every: parses as interval');
    t.equal((every as {
      intervalMs: number;
    }).intervalMs, 9e4, 'interval scales to ms');
  });
  it('rejects unsupported syntax with clear errors', (t) => {
    t.throws(() => parseCron('0 0 * * MON'), /numeric/, 'day names rejected');
    t.throws(() => parseCron('0 0 L * *'), /numeric/, 'L rejected');
    t.throws(() => parseCron('* * * *'), /5 fields/, 'four fields rejected');
    t.throws(() => parseCron('* * * * * *'), /5 fields/, 'six fields rejected');
    t.throws(() => parseCron('61 * * * *'), /out of range/, 'minute range enforced');
    t.throws(() => parseCron('*/0 * * * *'), /positive integer/, 'zero step rejected');
    t.throws(() => parseCron('@fortnightly'), /unknown cron alias/, 'unknown alias rejected');
    t.throws(() => parseCron('every:banana'), /must match/, 'bad duration rejected');
    t.throws(() => parseCron('5-1 * * * *'), /inverted/, 'inverted range rejected');
  });
});
describe('cron next occurrence', () => {
  it('advances within the hour and across step boundaries', (t) => {
    const spec = parseCron('*/15 * * * *');
    t.equal(nextOccurrence(spec, at('2026-03-10T12:00:00Z')), at('2026-03-10T12:15:00Z'), 'from an exact match, strictly after');
    t.equal(nextOccurrence(spec, at('2026-03-10T12:14:59Z')), at('2026-03-10T12:15:00Z'), 'rounds into the next slot');
    t.equal(nextOccurrence(spec, at('2026-03-10T12:46:00Z')), at('2026-03-10T13:00:00Z'), 'wraps to the next hour');
  });
  it('handles month rollover and specific day-of-month', (t) => {
    const spec = parseCron('0 0 1 * *');
    t.equal(nextOccurrence(spec, at('2026-03-15T09:00:00Z')), at('2026-04-01T00:00:00Z'), 'first of next month');
    t.equal(nextOccurrence(spec, at('2026-12-31T23:59:00Z')), at('2027-01-01T00:00:00Z'), 'year boundary');
  });
  it('finds leap day across years', (t) => {
    const spec = parseCron('0 0 29 2 *');
    t.equal(nextOccurrence(spec, at('2026-03-01T00:00:00Z')), at('2028-02-29T00:00:00Z'), 'jumps to the next leap year');
  });
  it('applies the vixie dom/dow OR rule', (t) => {
    const spec = parseCron('0 0 13 * 5');
    // From Mon 2026-03-02: Friday 2026-03-06 (dow match) precedes the 13th (dom match).
    t.equal(nextOccurrence(spec, at('2026-03-02T00:00:00Z')), at('2026-03-06T00:00:00Z'), 'dow match fires first');
    // From Sat 2026-03-07: the 13th is itself a Friday; both match on the same day.
    t.equal(nextOccurrence(spec, at('2026-03-07T00:00:00Z')), at('2026-03-13T00:00:00Z'), 'dom/dow coincide');
    // dom-only restriction ignores weekday.
    const domOnly = parseCron('0 0 13 * *');
    t.equal(nextOccurrence(domOnly, at('2026-03-07T00:00:00Z')), at('2026-03-13T00:00:00Z'), 'dom-only matches the 13th');
  });
  it('aligns every: intervals to the anchor', (t) => {
    const spec = parseCron('every:90s');
    t.equal(nextOccurrence(spec, 0), 9e4, 'first interval after the anchor');
    t.equal(nextOccurrence(spec, 9e4), 18e4, 'exact boundary advances strictly');
    t.equal(nextOccurrence(spec, 1e5), 18e4, 'mid-interval rounds up');
  });
  it('bails on unsatisfiable expressions', (t) => {
    const spec = parseCron('0 0 30 2 *');
    t.throws(() => nextOccurrence(spec, at('2026-01-01T00:00:00Z')), /five years/, 'Feb 30 never occurs');
  });
});
