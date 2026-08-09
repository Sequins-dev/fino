/**
 * fino:ml/metrics — shared scoring for classification, ranking, regression,
 * calibration, and vector similarity.
 *
 * One implementation of every standard metric, so that evaluation harnesses,
 * classical estimators, and inference pipelines all report the same number for
 * the same data instead of each growing a private scorer. Everything here is
 * pure TypeScript over `ArrayLike<number>` and primitive labels — no tensors,
 * no native dependencies, and safe to call from `DataLoader` workers.
 *
 * ## Choosing a metric
 *
 * `accuracy` answers "how often is it right", but on imbalanced data it
 * flatters a model that only predicts the majority class — reach for
 * `balancedAccuracy`, `f1Score`, or `matthewsCorrCoef` instead. `precision`
 * and `recall` split the two ways a classifier fails, and `fBetaScore` weights
 * one against the other when a miss and a false alarm cost different amounts.
 *
 * Metrics over *scores* rather than hard predictions need no decision
 * threshold: `rocAuc` summarizes ranking quality across all of them, and
 * `averagePrecision` does the same while ignoring true negatives, which is the
 * honest choice when positives are rare. `logLoss` and the calibration family
 * ask a different question again — not whether the ranking is right, but
 * whether a predicted `0.9` actually happens 90% of the time.
 *
 * `ConfusionMatrix` underpins the classification metrics and is worth using
 * directly whenever more than one of them is needed, since it derives them all
 * from a single pass.
 *
 * ```ts
 * import { ConfusionMatrix, f1Score, rocAuc } from 'fino:ml/metrics';
 *
 * const yTrue = [1, 0, 1, 1, 0, 1];
 * const yPred = [1, 0, 0, 1, 0, 1];
 * console.log(f1Score(yTrue, yPred).toFixed(4)); // 0.8571
 * console.log(ConfusionMatrix.from(yTrue, yPred).accuracy().toFixed(4)); // 0.8333
 * console.log(rocAuc(yTrue, [0.9, 0.1, 0.4, 0.8, 0.2, 0.7])); // 1
 * ```
 *
 * ## Streaming and sharding
 *
 * Batch functions need the whole dataset in memory. The `Streaming*`
 * accumulators do not: they hold constant memory, take one batch at a time,
 * and `merge` across shards, so a metric computed by parallel realm workers
 * equals the one computed serially.
 *
 * ```ts
 * import { StreamingConfusionMatrix } from 'fino:ml/metrics';
 *
 * const shardA = new StreamingConfusionMatrix();
 * shardA.updateAll([1, 0], [1, 0]);
 * const shardB = new StreamingConfusionMatrix();
 * shardB.updateAll([1, 1], [0, 1]);
 * console.log(shardA.merge(shardB).value().accuracy()); // 0.75
 * ```
 *
 * Malformed input — mismatched lengths, empty arrays, probabilities outside
 * `[0, 1]`, an unresolvable positive label — throws `MetricError`. Genuinely
 * undefined values, such as the precision of a class that was never predicted,
 * are reported as `0` rather than `NaN`.
 */
export {
  accuracy,
  averagePrecision,
  balancedAccuracy,
  cohenKappa,
  f1Score,
  fBetaScore,
  logLoss,
  matthewsCorrCoef,
  precision,
  precisionRecallCurve,
  recall,
  rocAuc,
  rocCurve,
  type Average,
  type AverageOptions,
  type PrecisionRecallCurve,
  type ProbabilityOptions,
  type RocCurve,
} from './classification.ts';

export { ConfusionMatrix } from './confusion.ts';

export {
  brierScore,
  calibrationCurve,
  expectedCalibrationError,
  maximumCalibrationError,
  type BinStrategy,
  type CalibrationBin,
  type CalibrationOptions,
} from './calibration.ts';

export {
  averagePrecisionAtK,
  dcgAtK,
  hitRateAtK,
  meanAveragePrecisionAtK,
  meanReciprocalRank,
  ndcgAtK,
  precisionAtK,
  rankedRelevance,
  recallAtK,
  reciprocalRank,
  type GainFunction,
  type GainOptions,
} from './ranking.ts';

export {
  explainedVariance,
  maxError,
  meanAbsoluteError,
  meanAbsolutePercentageError,
  meanSquaredError,
  meanSquaredLogError,
  medianAbsoluteError,
  pearsonCorrelation,
  r2Score,
  rootMeanSquaredError,
} from './regression.ts';

export {
  cosineDistance,
  cosineSimilarity,
  dotProduct,
  euclideanDistance,
  l2Norm,
  manhattanDistance,
} from './similarity.ts';

export {
  StreamingAccuracy,
  StreamingConfusionMatrix,
  StreamingMean,
  StreamingRegression,
  StreamingVariance,
  type StreamingMetric,
  type StreamingRegressionValue,
} from './streaming.ts';

export { MetricError, type Label } from './shared.ts';
