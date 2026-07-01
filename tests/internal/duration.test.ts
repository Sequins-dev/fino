import { describe, it } from 'fino:test/test';
import { formatDurationMs, formatDurationNs } from 'internal:duration';
describe('internal duration formatting', () => {
  it('uses nanoseconds below one microsecond', (t) => {
    t.equal(formatDurationNs(42), '42ns');
  });
  it('uses microseconds between nanoseconds and milliseconds', (t) => {
    t.equal(formatDurationNs(1500), '1.50us');
    t.equal(formatDurationMs(.5), '500.00us');
  });
  it('uses milliseconds, seconds, minutes, and hours at scale', (t) => {
    t.equal(formatDurationNs(15e5), '1.50ms');
    t.equal(formatDurationMs(2500), '2.50s');
    t.equal(formatDurationMs(9e4), '1.50m');
    t.equal(formatDurationMs(72e5), '2.00h');
  });
});
