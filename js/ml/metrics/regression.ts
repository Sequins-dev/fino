/**
 * Regression error and goodness-of-fit metrics over continuous targets.
 */
import {
  CompensatedSum,
  MetricError,
  ratio,
  requireFinite,
  requireNonEmpty,
  requireSameLength,
} from './shared.ts';

/**
 * Mean of the squared residuals.
 *
 * Squaring makes large misses dominate, so this is the metric to optimize when
 * one big error is worse than several small ones.
 *
 * ```ts
 * import { meanSquaredError } from 'fino:ml/metrics';
 *
 * console.log(meanSquaredError([3, -0.5, 2, 7], [2.5, 0, 2, 8])); // 0.375
 * ```
 */
export function meanSquaredError(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  const residuals = checkPair(yTrue, yPred);
  const total = new CompensatedSum();
  for (let i = 0; i < residuals; i++) {
    const error = yTrue[i]! - yPred[i]!;
    total.add(error * error);
  }
  return total.value / residuals;
}

/**
 * Square root of the mean squared error, back in the target's own units.
 *
 * ```ts
 * import { rootMeanSquaredError } from 'fino:ml/metrics';
 *
 * console.log(rootMeanSquaredError([3, -0.5, 2, 7], [2.5, 0, 2, 8]).toFixed(4)); // 0.6124
 * ```
 */
export function rootMeanSquaredError(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  return Math.sqrt(meanSquaredError(yTrue, yPred));
}

/**
 * Mean of the absolute residuals.
 *
 * Every error counts in proportion to its size, which makes this far less
 * sensitive to outliers than `meanSquaredError`.
 *
 * ```ts
 * import { meanAbsoluteError } from 'fino:ml/metrics';
 *
 * console.log(meanAbsoluteError([3, -0.5, 2, 7], [2.5, 0, 2, 8])); // 0.5
 * ```
 */
export function meanAbsoluteError(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  const count = checkPair(yTrue, yPred);
  const total = new CompensatedSum();
  for (let i = 0; i < count; i++) total.add(Math.abs(yTrue[i]! - yPred[i]!));
  return total.value / count;
}

/**
 * Median of the absolute residuals — the outlier-proof error summary.
 *
 * ```ts
 * import { medianAbsoluteError } from 'fino:ml/metrics';
 *
 * console.log(medianAbsoluteError([3, -0.5, 2, 7], [2.5, 0, 2, 8])); // 0.5
 * ```
 */
export function medianAbsoluteError(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  const count = checkPair(yTrue, yPred);
  const errors = new Array<number>(count);
  for (let i = 0; i < count; i++) errors[i] = Math.abs(yTrue[i]! - yPred[i]!);
  errors.sort((a, b) => a - b);
  const middle = count >> 1;
  return count % 2 === 1 ? errors[middle]! : (errors[middle - 1]! + errors[middle]!) / 2;
}

/**
 * Largest absolute residual — the worst case rather than the typical one.
 *
 * ```ts
 * import { maxError } from 'fino:ml/metrics';
 *
 * console.log(maxError([3, 2, 7], [3, 2, 8])); // 1
 * ```
 */
export function maxError(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  const count = checkPair(yTrue, yPred);
  let worst = 0;
  for (let i = 0; i < count; i++) worst = Math.max(worst, Math.abs(yTrue[i]! - yPred[i]!));
  return worst;
}

/**
 * Mean absolute error as a fraction of the true value.
 *
 * Scale-free, so it compares targets of different magnitudes — but it is
 * undefined at zero and biased against under-prediction, so it throws rather
 * than silently dividing by a zero target.
 *
 * ```ts
 * import { meanAbsolutePercentageError } from 'fino:ml/metrics';
 *
 * console.log(meanAbsolutePercentageError([100, 200], [110, 180])); // 0.1
 * ```
 */
export function meanAbsolutePercentageError(
  yTrue: ArrayLike<number>,
  yPred: ArrayLike<number>,
): number {
  const count = checkPair(yTrue, yPred);
  const total = new CompensatedSum();
  for (let i = 0; i < count; i++) {
    const actual = yTrue[i]!;
    if (actual === 0) {
      throw new MetricError(
        `yTrue[${i}] is zero, which makes the percentage error undefined; use meanAbsoluteError instead`,
      );
    }
    total.add(Math.abs((actual - yPred[i]!) / actual));
  }
  return total.value / count;
}

/**
 * Mean squared error between `log1p` of the targets and predictions.
 *
 * Penalizes relative error, so it suits targets spanning orders of magnitude.
 * Both inputs must be at least `-1`.
 *
 * ```ts
 * import { meanSquaredLogError } from 'fino:ml/metrics';
 *
 * console.log(meanSquaredLogError([3, 5, 2.5, 7], [2.5, 5, 4, 8]).toFixed(4)); // 0.0397
 * ```
 */
export function meanSquaredLogError(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  const count = checkPair(yTrue, yPred);
  const total = new CompensatedSum();
  for (let i = 0; i < count; i++) {
    if (yTrue[i]! < -1 || yPred[i]! < -1) {
      throw new MetricError(`meanSquaredLogError requires values >= -1 (index ${i})`);
    }
    const error = Math.log1p(yTrue[i]!) - Math.log1p(yPred[i]!);
    total.add(error * error);
  }
  return total.value / count;
}

/**
 * Coefficient of determination: the share of variance the model explains.
 *
 * `1` is exact, `0` matches always predicting the mean, and negative values
 * mean the model does worse than that baseline. Reports `0` when the targets
 * have no variance and the statistic is undefined.
 *
 * ```ts
 * import { r2Score } from 'fino:ml/metrics';
 *
 * console.log(r2Score([3, -0.5, 2, 7], [2.5, 0, 2, 8]).toFixed(4)); // 0.9486
 * ```
 */
export function r2Score(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  const count = checkPair(yTrue, yPred);
  const mean = meanOfArray(yTrue, count);
  const residualSum = new CompensatedSum();
  const totalSum = new CompensatedSum();
  for (let i = 0; i < count; i++) {
    const residual = yTrue[i]! - yPred[i]!;
    const deviation = yTrue[i]! - mean;
    residualSum.add(residual * residual);
    totalSum.add(deviation * deviation);
  }
  return totalSum.value === 0 ? 0 : 1 - residualSum.value / totalSum.value;
}

/**
 * Share of variance explained, ignoring any constant offset in the residuals.
 *
 * Differs from `r2Score` only when predictions are systematically biased: a
 * gap between the two is the signal that the model is off by a constant.
 *
 * ```ts
 * import { explainedVariance } from 'fino:ml/metrics';
 *
 * console.log(explainedVariance([3, -0.5, 2, 7], [2.5, 0, 2, 8]).toFixed(4)); // 0.9572
 * ```
 */
export function explainedVariance(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  const count = checkPair(yTrue, yPred);
  const trueMean = meanOfArray(yTrue, count);
  let residualMean = 0;
  for (let i = 0; i < count; i++) residualMean += yTrue[i]! - yPred[i]!;
  residualMean /= count;
  const residualVariance = new CompensatedSum();
  const totalVariance = new CompensatedSum();
  for (let i = 0; i < count; i++) {
    const centeredResidual = yTrue[i]! - yPred[i]! - residualMean;
    const deviation = yTrue[i]! - trueMean;
    residualVariance.add(centeredResidual * centeredResidual);
    totalVariance.add(deviation * deviation);
  }
  return totalVariance.value === 0 ? 0 : 1 - residualVariance.value / totalVariance.value;
}

/**
 * Pearson correlation between two numeric vectors, in `[-1, 1]`.
 *
 * Reports `0` when either input is constant and the statistic is undefined.
 *
 * ```ts
 * import { pearsonCorrelation } from 'fino:ml/metrics';
 *
 * console.log(pearsonCorrelation([1, 2, 3], [2, 4, 6])); // 1
 * ```
 */
export function pearsonCorrelation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const count = checkPair(a, b);
  const meanA = meanOfArray(a, count);
  const meanB = meanOfArray(b, count);
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < count; i++) {
    const deltaA = a[i]! - meanA;
    const deltaB = b[i]! - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }
  return ratio(covariance, Math.sqrt(varianceA * varianceB));
}

function checkPair(yTrue: ArrayLike<number>, yPred: ArrayLike<number>): number {
  requireSameLength(yTrue, yPred, 'yTrue', 'yPred');
  requireNonEmpty(yTrue, 'yTrue');
  requireFinite(yTrue, 'yTrue');
  requireFinite(yPred, 'yPred');
  return yTrue.length;
}

function meanOfArray(values: ArrayLike<number>, count: number): number {
  const total = new CompensatedSum();
  for (let i = 0; i < count; i++) total.add(values[i]!);
  return total.value / count;
}
