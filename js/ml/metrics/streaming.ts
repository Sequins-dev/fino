/**
 * Streaming metric accumulators for batched and sharded evaluation.
 *
 * Every accumulator here holds constant memory regardless of how many
 * observations it sees, and every one supports `merge`, so a `DataLoader`
 * fan-out can score its shards in parallel realms and reduce the partial
 * results at the end. `merge` returns a new accumulator and leaves both
 * operands untouched.
 */
import { ConfusionMatrix } from './confusion.ts';
import { CompensatedSum, MetricError, ratio, requireSameLength, type Label } from './shared.ts';

/**
 * A metric that can be fed incrementally and combined across shards.
 */
export interface StreamingMetric<Value> {
  /**
   * Number of observations accumulated.
   */
  readonly count: number;
  /**
   * Current value of the metric.
   */
  value(): Value;
  /**
   * Discard all accumulated state.
   */
  reset(): void;
}

/**
 * Running mean over a stream of values.
 *
 * Uses compensated summation, so a long run of small values added to a large
 * total does not quietly lose precision.
 *
 * ```ts
 * import { StreamingMean } from 'fino:ml/metrics';
 *
 * const mean = new StreamingMean();
 * mean.updateAll([1, 2, 3]);
 * mean.update(4);
 * console.log(mean.value()); // 2.5
 * ```
 */
export class StreamingMean implements StreamingMetric<number> {
  #sum = new CompensatedSum();
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Accumulate one value.
   */
  update(value: number): void {
    this.#sum.add(value);
    this.#count++;
  }

  /**
   * Accumulate a batch of values.
   */
  updateAll(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.update(values[i]!);
  }

  /**
   * Mean of everything accumulated, or `0` before the first observation.
   */
  value(): number {
    return ratio(this.#sum.value, this.#count);
  }

  /**
   * Combine with another accumulator.
   */
  merge(other: StreamingMean): StreamingMean {
    const merged = new StreamingMean();
    merged.#sum.add(this.#sum.value);
    merged.#sum.add(other.#sum.value);
    merged.#count = this.#count + other.#count;
    return merged;
  }

  reset(): void {
    this.#sum.reset();
    this.#count = 0;
  }
}

/**
 * Running mean and variance in one pass.
 *
 * Uses Welford's algorithm and the pairwise merge that goes with it, so the
 * variance stays stable for large counts and for shards combined out of
 * order — a naive sum-of-squares would cancel catastrophically here.
 *
 * ```ts
 * import { StreamingVariance } from 'fino:ml/metrics';
 *
 * const stats = new StreamingVariance();
 * stats.updateAll([2, 4, 4, 4, 5, 5, 7, 9]);
 * console.log(stats.mean()); // 5
 * console.log(stats.variance()); // 4
 * ```
 */
export class StreamingVariance implements StreamingMetric<number> {
  #count = 0;
  #mean = 0;
  #m2 = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Accumulate one value.
   */
  update(value: number): void {
    this.#count++;
    const delta = value - this.#mean;
    this.#mean += delta / this.#count;
    this.#m2 += delta * (value - this.#mean);
  }

  /**
   * Accumulate a batch of values.
   */
  updateAll(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.update(values[i]!);
  }

  /**
   * Mean of everything accumulated.
   */
  mean(): number {
    return this.#count === 0 ? 0 : this.#mean;
  }

  /**
   * Population variance.
   */
  variance(): number {
    return ratio(this.#m2, this.#count);
  }

  /**
   * Sample variance, with Bessel's correction.
   */
  sampleVariance(): number {
    return ratio(this.#m2, this.#count - 1);
  }

  /**
   * Population standard deviation.
   */
  standardDeviation(): number {
    return Math.sqrt(this.variance());
  }

  /**
   * Population variance, matching `variance()`.
   */
  value(): number {
    return this.variance();
  }

  /**
   * Combine with another accumulator.
   */
  merge(other: StreamingVariance): StreamingVariance {
    const merged = new StreamingVariance();
    const total = this.#count + other.#count;
    if (total === 0) return merged;
    const delta = other.#mean - this.#mean;
    merged.#count = total;
    merged.#mean = this.#mean + (delta * other.#count) / total;
    merged.#m2 = this.#m2 + other.#m2 + (delta * delta * this.#count * other.#count) / total;
    return merged;
  }

  reset(): void {
    this.#count = 0;
    this.#mean = 0;
    this.#m2 = 0;
  }
}

/**
 * Running classification accuracy.
 *
 * ```ts
 * import { StreamingAccuracy } from 'fino:ml/metrics';
 *
 * const acc = new StreamingAccuracy();
 * acc.updateAll([1, 0, 1], [1, 0, 0]);
 * console.log(acc.value().toFixed(4)); // 0.6667
 * ```
 */
export class StreamingAccuracy implements StreamingMetric<number> {
  #correct = 0;
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Accumulate one prediction.
   */
  update(trueLabel: Label, predictedLabel: Label): void {
    if (trueLabel === predictedLabel) this.#correct++;
    this.#count++;
  }

  /**
   * Accumulate a batch of paired labels.
   */
  updateAll(yTrue: ArrayLike<Label>, yPred: ArrayLike<Label>): void {
    requireSameLength(yTrue, yPred, 'yTrue', 'yPred');
    for (let i = 0; i < yTrue.length; i++) this.update(yTrue[i]!, yPred[i]!);
  }

  /**
   * Fraction correct so far, or `0` before the first observation.
   */
  value(): number {
    return ratio(this.#correct, this.#count);
  }

  /**
   * Combine with another accumulator.
   */
  merge(other: StreamingAccuracy): StreamingAccuracy {
    const merged = new StreamingAccuracy();
    merged.#correct = this.#correct + other.#correct;
    merged.#count = this.#count + other.#count;
    return merged;
  }

  reset(): void {
    this.#correct = 0;
    this.#count = 0;
  }
}

/**
 * A confusion matrix built incrementally from batches.
 *
 * Wraps `ConfusionMatrix` so that the full per-class report — precision,
 * recall, F1, kappa, MCC — is available from a stream without holding the
 * labels themselves. Label universes grow as new classes appear, and `merge`
 * unions them.
 *
 * ```ts
 * import { StreamingConfusionMatrix } from 'fino:ml/metrics';
 *
 * const running = new StreamingConfusionMatrix();
 * running.updateAll(['a', 'b'], ['a', 'a']);
 * running.updateAll(['b'], ['b']);
 * console.log(running.value().accuracy().toFixed(4)); // 0.6667
 * ```
 */
export class StreamingConfusionMatrix implements StreamingMetric<ConfusionMatrix> {
  #matrix: ConfusionMatrix | null;
  #fixedLabels: boolean;
  #count = 0;

  /**
   * Create an accumulator, optionally over a known label universe.
   *
   * Fixing the labels up front makes an unexpected class an error instead of a
   * silent schema change, and keeps zero-support classes in the report.
   */
  constructor(labels?: readonly Label[]) {
    this.#matrix = labels ? new ConfusionMatrix(labels) : null;
    this.#fixedLabels = labels !== undefined;
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Accumulate one prediction.
   */
  update(trueLabel: Label, predictedLabel: Label): void {
    this.updateAll([trueLabel], [predictedLabel]);
  }

  /**
   * Accumulate a batch of paired labels.
   */
  updateAll(yTrue: ArrayLike<Label>, yPred: ArrayLike<Label>): void {
    requireSameLength(yTrue, yPred, 'yTrue', 'yPred');
    if (yTrue.length === 0) return;
    if (this.#fixedLabels) {
      this.#matrix!.observeAll(yTrue, yPred);
    } else {
      const batch = ConfusionMatrix.from(yTrue, yPred);
      this.#matrix = this.#matrix ? this.#matrix.merge(batch) : batch;
    }
    this.#count += yTrue.length;
  }

  /**
   * The matrix accumulated so far.
   *
   * Throws before the first observation, when there is no label universe to
   * report over.
   */
  value(): ConfusionMatrix {
    if (!this.#matrix) {
      throw new MetricError(
        'no observations yet; pass a label set to the constructor to report early',
      );
    }
    return this.#matrix;
  }

  /**
   * Combine with another accumulator.
   */
  merge(other: StreamingConfusionMatrix): StreamingConfusionMatrix {
    const merged = new StreamingConfusionMatrix();
    merged.#matrix =
      this.#matrix && other.#matrix
        ? this.#matrix.merge(other.#matrix)
        : (this.#matrix ?? other.#matrix);
    merged.#fixedLabels = this.#fixedLabels && other.#fixedLabels;
    merged.#count = this.#count + other.#count;
    return merged;
  }

  reset(): void {
    this.#matrix =
      this.#matrix && this.#fixedLabels ? new ConfusionMatrix(this.#matrix.labels) : null;
    this.#count = 0;
  }
}

/**
 * Regression error summary accumulated in one pass.
 */
export interface StreamingRegressionValue {
  /**
   * Mean squared error.
   */
  meanSquaredError: number;
  /**
   * Root mean squared error.
   */
  rootMeanSquaredError: number;
  /**
   * Mean absolute error.
   */
  meanAbsoluteError: number;
  /**
   * Coefficient of determination.
   */
  r2: number;
}

/**
 * Running regression errors over a stream of predictions.
 *
 * Reports MSE, RMSE, MAE, and R² together from a single pass, tracking the
 * target variance with Welford's algorithm so R² needs no second pass over
 * the data.
 *
 * ```ts
 * import { StreamingRegression } from 'fino:ml/metrics';
 *
 * const running = new StreamingRegression();
 * running.updateAll([3, -0.5, 2, 7], [2.5, 0, 2, 8]);
 * console.log(running.value().meanSquaredError); // 0.375
 * ```
 */
export class StreamingRegression implements StreamingMetric<StreamingRegressionValue> {
  #squaredError = new CompensatedSum();
  #absoluteError = new CompensatedSum();
  #targets = new StreamingVariance();

  get count(): number {
    return this.#targets.count;
  }

  /**
   * Accumulate one prediction.
   */
  update(trueValue: number, predicted: number): void {
    const error = trueValue - predicted;
    this.#squaredError.add(error * error);
    this.#absoluteError.add(Math.abs(error));
    this.#targets.update(trueValue);
  }

  /**
   * Accumulate a batch of predictions.
   */
  updateAll(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): void {
    requireSameLength(yTrue, yPred, 'yTrue', 'yPred');
    for (let i = 0; i < yTrue.length; i++) this.update(yTrue[i]!, yPred[i]!);
  }

  /**
   * Error summary so far. Every field is `0` before the first observation.
   */
  value(): StreamingRegressionValue {
    const count = this.#targets.count;
    const meanSquared = ratio(this.#squaredError.value, count);
    const totalVariance = this.#targets.variance() * count;
    return {
      meanSquaredError: meanSquared,
      rootMeanSquaredError: Math.sqrt(meanSquared),
      meanAbsoluteError: ratio(this.#absoluteError.value, count),
      r2: totalVariance === 0 ? 0 : 1 - this.#squaredError.value / totalVariance,
    };
  }

  /**
   * Combine with another accumulator.
   */
  merge(other: StreamingRegression): StreamingRegression {
    const merged = new StreamingRegression();
    merged.#squaredError.add(this.#squaredError.value);
    merged.#squaredError.add(other.#squaredError.value);
    merged.#absoluteError.add(this.#absoluteError.value);
    merged.#absoluteError.add(other.#absoluteError.value);
    merged.#targets = this.#targets.merge(other.#targets);
    return merged;
  }

  reset(): void {
    this.#squaredError.reset();
    this.#absoluteError.reset();
    this.#targets.reset();
  }
}
