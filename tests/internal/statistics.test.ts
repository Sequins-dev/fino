import { describe, it } from 'fino:test/test';
import { LogHistogram, RunningStatistics } from 'internal:statistics';

describe('RunningStatistics', () => {
  it('tracks stable streaming population moments', (t) => {
    const statistics = new RunningStatistics();
    for (const value of [1e12 + 1, 1e12 + 2, 1e12 + 3]) statistics.record(value);

    t.equal(statistics.count, 3);
    t.equal(statistics.total, 3e12 + 6);
    t.equal(statistics.min, 1e12 + 1);
    t.equal(statistics.max, 1e12 + 3);
    t.equal(statistics.mean, 1e12 + 2);
    t.equal(statistics.variance, 2 / 3);
    t.equal(statistics.sampleVariance, 1);
    t.ok(Math.abs(statistics.stddev! - Math.sqrt(2 / 3)) < 1e-12);
  });

  it('exposes null empty moments and can be reset for reuse', (t) => {
    const statistics = new RunningStatistics();
    t.equal(statistics.count, 0);
    t.equal(statistics.total, 0);
    t.equal(statistics.min, null);
    t.equal(statistics.max, null);
    t.equal(statistics.mean, null);
    t.equal(statistics.variance, null);
    t.equal(statistics.sampleVariance, null);
    t.equal(statistics.stddev, null);
    statistics.record(42);
    statistics.reset();
    t.equal(statistics.count, 0);
    t.equal(statistics.mean, null);
  });

  it('merges partial accumulators without replaying observations', (t) => {
    const left = new RunningStatistics();
    const right = new RunningStatistics();
    for (const value of [1, 2]) left.record(value);
    for (const value of [3, 4]) right.record(value);
    left.merge(right);

    t.equal(left.count, 4);
    t.equal(left.total, 10);
    t.equal(left.min, 1);
    t.equal(left.max, 4);
    t.equal(left.mean, 2.5);
    t.equal(left.variance, 1.25);
    t.equal(right.count, 2, 'merge leaves the source unchanged');
  });
});

describe('LogHistogram', () => {
  it('keeps exact moments and bounded approximate quantiles', (t) => {
    const histogram = new LogHistogram();
    for (let value = 1; value <= 100; value++) histogram.record(value);

    t.equal(histogram.count, 100);
    t.equal(histogram.min, 1);
    t.equal(histogram.mean, 50.5);
    t.equal(histogram.quantile(0), 1);
    t.ok(histogram.quantile(0.5)! >= 49 && histogram.quantile(0.5)! <= 52);
    t.ok(histogram.quantile(0.99)! >= 97 && histogram.quantile(0.99)! <= 101);
    t.equal(histogram.quantile(1), 100);
    t.equal(histogram.max, 100);
  });

  it('normalizes negatives, ignores non-finite values, and validates quantiles', (t) => {
    const histogram = new LogHistogram();
    t.equal(histogram.record(-1), true);
    t.equal(histogram.record(Number.NaN), false);
    t.equal(histogram.record(Infinity), false);
    t.equal(histogram.count, 1);
    t.equal(histogram.quantile(0.5), 0);
    t.throws(() => histogram.quantile(-0.1), RangeError);
    t.throws(() => histogram.quantile(1.1), RangeError);
    t.throws(() => histogram.quantile(Number.NaN), RangeError);
  });

  it('merges compatible layouts and rejects incompatible layouts', (t) => {
    const left = new LogHistogram();
    const right = new LogHistogram();
    left.record(1);
    right.record(4);
    left.merge(right);

    t.equal(left.count, 2);
    t.equal(left.min, 1);
    t.equal(left.max, 4);
    t.equal(left.mean, 2.5);
    t.equal(right.count, 1, 'merge leaves the source unchanged');
    t.throws(() => left.merge(new LogHistogram({ bucketsPerOctave: 32 })), RangeError);
  });

  it('rejects invalid or excessive bucket layouts', (t) => {
    t.throws(() => new LogHistogram({ minimumExponent: 1, maximumExponent: 1 }), RangeError);
    t.throws(() => new LogHistogram({ bucketsPerOctave: 0 }), RangeError);
    t.throws(
      () =>
        new LogHistogram({ minimumExponent: -1000, maximumExponent: 1000, bucketsPerOctave: 1000 }),
      RangeError,
    );
  });
});
