import { describe, it } from 'fino:test/test';
import { formatDurationMs, formatDurationNs } from 'internal:duration';

describe('internal duration formatting', () => {
  it('uses nanoseconds below one millisecond', (t) => {
    t.equal(formatDurationNs(42), '42ns');
    t.equal(formatDurationMs(0.5), '500000ns');
  });

  it('uses milliseconds, seconds, minutes, and hours at scale', (t) => {
    t.equal(formatDurationNs(1_500_000), '1.50ms');
    t.equal(formatDurationMs(2_500), '2.50s');
    t.equal(formatDurationMs(90_000), '1.50m');
    t.equal(formatDurationMs(7_200_000), '2.00h');
  });
});
