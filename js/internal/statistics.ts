/**
 * internal:statistics — bounded streaming statistics and distributions.
 *
 * Provides allocation-stable analytics primitives for runtime tools that must
 * summarize many observations without retaining every value. `RunningStatistics`
 * uses Welford's online algorithm for numerically stable population and sample
 * moments.
 * `LogHistogram` adds fixed-memory approximate quantiles using configurable
 * logarithmic buckets while retaining exact count, minimum, mean, and maximum.
 *
 * Both structures can merge compatible partial results. This lets benchmark,
 * load-generation, profiling, and future worker-sharded tools aggregate locally
 * before sending one bounded summary to a coordinator. Histograms ignore
 * non-finite observations and represent negative observations as zero because
 * their domain is elapsed time, sizes, and other non-negative measurements.
 *
 * The default histogram uses 64 buckets per power of two over exponents -32
 * through 32. That is about 1.1% relative bucket width and 32 KiB of bucket
 * storage. Choose a different exponent range when the input unit needs it;
 * merged histograms must use identical layouts.
 *
 * ```ts no_run
 * import { LogHistogram, RunningStatistics } from 'internal:statistics';
 *
 * const durations = new LogHistogram();
 * durations.record(1.2);
 * durations.record(3.4);
 * console.log(durations.mean, durations.quantile(0.99));
 *
 * const shard = new RunningStatistics();
 * shard.record(42);
 * const total = new RunningStatistics();
 * total.merge(shard);
 * ```
 *
 * @internal
 */

/**
 * Incrementally tracks count, total, range, mean, and population variance.
 *
 * Empty accumulators expose `null` for range and moment getters while `count`
 * and `total` remain zero. `merge()` combines another accumulator without
 * replaying its observations, and `reset()` clears the instance for reuse.
 * Values are recorded as supplied; a consumer whose domain excludes `NaN` or
 * infinities must validate them before calling `record()`.
 *
 * @internal
 */
export class RunningStatistics {
  #count = 0;
  #total = 0;
  #min = Infinity;
  #max = -Infinity;
  #mean = 0;
  #deviationSquares = 0;

  /** Number of observations recorded or merged. @internal */
  get count(): number {
    return this.#count;
  }

  /** Sum of all observations. Empty accumulators return zero. @internal */
  get total(): number {
    return this.#total;
  }

  /** Smallest observation, or `null` when empty. @internal */
  get min(): number | null {
    return this.#count === 0 ? null : this.#min;
  }

  /** Largest observation, or `null` when empty. @internal */
  get max(): number | null {
    return this.#count === 0 ? null : this.#max;
  }

  /** Arithmetic mean, or `null` when empty. @internal */
  get mean(): number | null {
    return this.#count === 0 ? null : this.#mean;
  }

  /** Population variance, or `null` when empty. @internal */
  get variance(): number | null {
    return this.#count === 0 ? null : Math.max(0, this.#deviationSquares / this.#count);
  }

  /** Sample variance with Bessel's correction, or `null` with fewer than two values. @internal */
  get sampleVariance(): number | null {
    return this.#count < 2 ? null : Math.max(0, this.#deviationSquares / (this.#count - 1));
  }

  /** Population standard deviation, or `null` when empty. @internal */
  get stddev(): number | null {
    const variance = this.variance;
    return variance === null ? null : Math.sqrt(variance);
  }

  /**
   * Record one observation using Welford's stable moment recurrence.
   *
   * Values are not validated. A non-finite value propagates through the
   * aggregates, allowing callers to choose whether to reject, ignore, or retain
   * invalid input before recording it.
   *
   * @internal
   */
  record(value: number): void {
    this.#count++;
    this.#total += value;
    this.#min = Math.min(this.#min, value);
    this.#max = Math.max(this.#max, value);
    const delta = value - this.#mean;
    this.#mean += delta / this.#count;
    this.#deviationSquares += delta * (value - this.#mean);
  }

  /**
   * Merge another accumulator into this one in constant time.
   *
   * The source is unchanged. Merging an empty source is a no-op.
   *
   * @internal
   */
  merge(other: RunningStatistics): void {
    if (other.#count === 0) return;
    if (this.#count === 0) {
      this.#count = other.#count;
      this.#total = other.#total;
      this.#min = other.#min;
      this.#max = other.#max;
      this.#mean = other.#mean;
      this.#deviationSquares = other.#deviationSquares;
      return;
    }
    const combinedCount = this.#count + other.#count;
    const delta = other.#mean - this.#mean;
    this.#deviationSquares +=
      other.#deviationSquares + (delta * delta * this.#count * other.#count) / combinedCount;
    this.#mean += (delta * other.#count) / combinedCount;
    this.#count = combinedCount;
    this.#total += other.#total;
    this.#min = Math.min(this.#min, other.#min);
    this.#max = Math.max(this.#max, other.#max);
  }

  /** Clear all observations so this allocation can be reused. @internal */
  reset(): void {
    this.#count = 0;
    this.#total = 0;
    this.#min = Infinity;
    this.#max = -Infinity;
    this.#mean = 0;
    this.#deviationSquares = 0;
  }
}

/** Logarithmic histogram bucket layout. @internal */
export interface LogHistogramOptions {
  /** Inclusive base-2 exponent at the bottom of the histogram. Defaults to `-32`. */
  minimumExponent?: number;
  /** Exclusive base-2 exponent at the top of the histogram. Defaults to `32`. */
  maximumExponent?: number;
  /** Buckets allocated per power of two. Defaults to `64`. */
  bucketsPerOctave?: number;
}

const DEFAULT_MINIMUM_EXPONENT = -32;
const DEFAULT_MAXIMUM_EXPONENT = 32;
const DEFAULT_BUCKETS_PER_OCTAVE = 64;
const MAX_BUCKETS = 1_048_576;

/**
 * Fixed-memory logarithmic histogram for non-negative observations.
 *
 * Exact running moments come from `RunningStatistics`; quantiles are estimated
 * from logarithmic buckets. Values outside the configured exponent range are
 * clamped into the first or last bucket, while `min` and `max` remain exact.
 * Zero has a dedicated bucket. Negative finite values are recorded as zero,
 * and non-finite values are ignored.
 *
 * `quantile()` accepts an inclusive fraction from `0` through `1`, returning
 * exact minimum/maximum values at the endpoints and `null` when empty. A
 * fraction outside that range throws `RangeError`.
 *
 * @internal
 */
export class LogHistogram {
  readonly #minimumExponent: number;
  readonly #maximumExponent: number;
  readonly #bucketsPerOctave: number;
  readonly #buckets: Float64Array;
  readonly #statistics = new RunningStatistics();
  #zeroCount = 0;

  /**
   * Allocate a histogram with the requested exponent range and precision.
   *
   * Exponents must be finite integers with `maximumExponent` greater than
   * `minimumExponent`; `bucketsPerOctave` must be a positive integer. Layouts
   * larger than 1,048,576 buckets are rejected to cap one allocation at 8 MiB.
   *
   * @internal
   */
  constructor(options: LogHistogramOptions = {}) {
    const minimumExponent = options.minimumExponent ?? DEFAULT_MINIMUM_EXPONENT;
    const maximumExponent = options.maximumExponent ?? DEFAULT_MAXIMUM_EXPONENT;
    const bucketsPerOctave = options.bucketsPerOctave ?? DEFAULT_BUCKETS_PER_OCTAVE;
    if (!Number.isInteger(minimumExponent) || !Number.isInteger(maximumExponent)) {
      throw new RangeError('histogram exponents must be finite integers');
    }
    if (maximumExponent <= minimumExponent) {
      throw new RangeError('histogram maximumExponent must exceed minimumExponent');
    }
    if (!Number.isInteger(bucketsPerOctave) || bucketsPerOctave <= 0) {
      throw new RangeError('histogram bucketsPerOctave must be a positive integer');
    }
    const bucketCount = (maximumExponent - minimumExponent) * bucketsPerOctave;
    if (!Number.isSafeInteger(bucketCount) || bucketCount > MAX_BUCKETS) {
      throw new RangeError('histogram bucket count is too large');
    }
    this.#minimumExponent = minimumExponent;
    this.#maximumExponent = maximumExponent;
    this.#bucketsPerOctave = bucketsPerOctave;
    this.#buckets = new Float64Array(bucketCount);
  }

  /** Number of finite observations recorded or merged. @internal */
  get count(): number {
    return this.#statistics.count;
  }

  /** Sum of all normalized observations. @internal */
  get total(): number {
    return this.#statistics.total;
  }

  /** Smallest normalized observation, or `null` when empty. @internal */
  get min(): number | null {
    return this.#statistics.min;
  }

  /** Largest normalized observation, or `null` when empty. @internal */
  get max(): number | null {
    return this.#statistics.max;
  }

  /** Arithmetic mean, or `null` when empty. @internal */
  get mean(): number | null {
    return this.#statistics.mean;
  }

  /** Population variance, or `null` when empty. @internal */
  get variance(): number | null {
    return this.#statistics.variance;
  }

  /** Population standard deviation, or `null` when empty. @internal */
  get stddev(): number | null {
    return this.#statistics.stddev;
  }

  /**
   * Record one observation, returning whether it was finite and accepted.
   *
   * Negative finite values are normalized to zero. `NaN` and infinities are
   * ignored and return `false`.
   *
   * @internal
   */
  record(value: number): boolean {
    if (!Number.isFinite(value)) return false;
    const safe = Math.max(0, value);
    this.#statistics.record(safe);
    if (safe === 0) {
      this.#zeroCount++;
      return true;
    }
    const raw = Math.floor((Math.log2(safe) - this.#minimumExponent) * this.#bucketsPerOctave);
    const index = Math.max(0, Math.min(this.#buckets.length - 1, raw));
    this.#buckets[index]!++;
    return true;
  }

  /**
   * Estimate the value at inclusive quantile `fraction`.
   *
   * Returns `null` when empty. Fractions `0` and `1` return the exact minimum
   * and maximum. Other results are bucket midpoints clamped to the exact range.
   *
   * @internal
   */
  quantile(fraction: number): number | null {
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new RangeError('histogram quantile must be between 0 and 1');
    }
    if (this.count === 0) return null;
    if (fraction === 0) return this.min;
    if (fraction === 1) return this.max;
    const rank = Math.max(1, Math.ceil(this.count * fraction));
    if (rank <= this.#zeroCount) return 0;
    let seen = this.#zeroCount;
    for (let index = 0; index < this.#buckets.length; index++) {
      seen += this.#buckets[index]!;
      if (seen >= rank) {
        const estimate = 2 ** (this.#minimumExponent + (index + 0.5) / this.#bucketsPerOctave);
        return Math.max(this.min!, Math.min(this.max!, estimate));
      }
    }
    return this.max;
  }

  /**
   * Merge a histogram with the same exponent range and bucket precision.
   *
   * Incompatible layouts throw `RangeError`; the source remains unchanged.
   *
   * @internal
   */
  merge(other: LogHistogram): void {
    if (
      this.#minimumExponent !== other.#minimumExponent ||
      this.#maximumExponent !== other.#maximumExponent ||
      this.#bucketsPerOctave !== other.#bucketsPerOctave
    ) {
      throw new RangeError('cannot merge histograms with different layouts');
    }
    this.#statistics.merge(other.#statistics);
    this.#zeroCount += other.#zeroCount;
    for (let index = 0; index < this.#buckets.length; index++) {
      this.#buckets[index]! += other.#buckets[index]!;
    }
  }
}
