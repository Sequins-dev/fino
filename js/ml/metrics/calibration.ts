/**
 * Calibration metrics: whether predicted probabilities mean what they claim.
 *
 * A model can rank perfectly and still be badly calibrated — if everything it
 * calls "90% likely" happens 60% of the time, `rocAuc` will not notice but
 * every downstream decision built on that number will be wrong.
 */
import {
  MetricError,
  ratio,
  requireNonEmpty,
  requireProbabilities,
  requireSameLength,
  resolveScoreLabel,
  sortedLabelUnion,
  type Label,
} from './shared.ts';

/**
 * How predictions are grouped into calibration bins.
 *
 * `uniform` splits `[0, 1]` into equal-width bins, which keeps the bin edges
 * interpretable. `quantile` splits into bins holding equal numbers of
 * predictions, which keeps each estimate equally reliable when predictions
 * cluster.
 */
export type BinStrategy = 'uniform' | 'quantile';

/**
 * Options for binned calibration measurements.
 */
export interface CalibrationOptions {
  /**
   * Number of bins. Defaults to `10`.
   */
  bins?: number;
  /**
   * Binning strategy. Defaults to `uniform`.
   */
  strategy?: BinStrategy;
  /**
   * Which label the probabilities refer to. Inferred as `1` or `true` when
   * the labels allow it.
   */
  positiveLabel?: Label;
}

/**
 * One bin of a calibration curve.
 */
export interface CalibrationBin {
  /**
   * Inclusive lower edge of the bin's predicted-probability range.
   */
  lowerEdge: number;
  /**
   * Upper edge, exclusive except in the final bin.
   */
  upperEdge: number;
  /**
   * Number of predictions that fell in the bin.
   */
  count: number;
  /**
   * Mean predicted probability among them.
   */
  meanPredicted: number;
  /**
   * Observed fraction that were actually positive.
   */
  fractionPositive: number;
}

/**
 * Mean squared error between predicted probabilities and outcomes.
 *
 * `0` is perfect and `0.25` is what always guessing `0.5` earns. Unlike
 * `logLoss` it stays finite for a confidently wrong prediction, so a single
 * bad call cannot dominate the average.
 *
 * ```ts
 * import { brierScore } from 'fino:ml/metrics';
 *
 * console.log(brierScore([1, 0, 1], [0.9, 0.1, 0.8]).toFixed(4)); // 0.0200
 * ```
 */
export function brierScore(
  yTrue: ArrayLike<Label>,
  probabilities: ArrayLike<number>,
  options: {
    positiveLabel?: Label;
  } = {},
): number {
  const positive = checkInputs(yTrue, probabilities, options.positiveLabel);
  let total = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const outcome = yTrue[i] === positive ? 1 : 0;
    const error = probabilities[i]! - outcome;
    total += error * error;
  }
  return total / probabilities.length;
}

/**
 * Group predictions into bins and report predicted versus observed rates.
 *
 * A well-calibrated model produces bins where `meanPredicted` tracks
 * `fractionPositive`. Empty bins are omitted.
 *
 * ```ts
 * import { calibrationCurve } from 'fino:ml/metrics';
 *
 * const bins = calibrationCurve([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9], { bins: 2 });
 * console.log(bins.map((bin) => bin.fractionPositive)); // [0, 1]
 * ```
 */
export function calibrationCurve(
  yTrue: ArrayLike<Label>,
  probabilities: ArrayLike<number>,
  options: CalibrationOptions = {},
): CalibrationBin[] {
  const positive = checkInputs(yTrue, probabilities, options.positiveLabel);
  const binCount = options.bins ?? 10;
  if (!Number.isInteger(binCount) || binCount < 1) {
    throw new MetricError(`bins must be a positive integer (got ${binCount})`);
  }
  const edges =
    (options.strategy ?? 'uniform') === 'uniform'
      ? uniformEdges(binCount)
      : quantileEdges(probabilities, binCount);
  const totals = edges.slice(0, -1).map((lowerEdge, i) => ({
    lowerEdge,
    upperEdge: edges[i + 1]!,
    count: 0,
    predictedSum: 0,
    positives: 0,
  }));
  for (let i = 0; i < probabilities.length; i++) {
    const bin = totals[binOf(edges, probabilities[i]!)]!;
    bin.count++;
    bin.predictedSum += probabilities[i]!;
    if (yTrue[i] === positive) bin.positives++;
  }
  return totals
    .filter((bin) => bin.count > 0)
    .map((bin) => ({
      lowerEdge: bin.lowerEdge,
      upperEdge: bin.upperEdge,
      count: bin.count,
      meanPredicted: bin.predictedSum / bin.count,
      fractionPositive: bin.positives / bin.count,
    }));
}

/**
 * Expected calibration error: mean gap between confidence and reality,
 * weighted by how many predictions land in each bin.
 *
 * `0` is perfectly calibrated. This is the single number to watch when a
 * downstream system thresholds on the probability itself.
 *
 * ```ts
 * import { expectedCalibrationError } from 'fino:ml/metrics';
 *
 * console.log(expectedCalibrationError([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9], { bins: 2 }));
 * ```
 */
export function expectedCalibrationError(
  yTrue: ArrayLike<Label>,
  probabilities: ArrayLike<number>,
  options: CalibrationOptions = {},
): number {
  const bins = calibrationCurve(yTrue, probabilities, options);
  let weighted = 0;
  let total = 0;
  for (const bin of bins) {
    weighted += bin.count * Math.abs(bin.meanPredicted - bin.fractionPositive);
    total += bin.count;
  }
  return ratio(weighted, total);
}

/**
 * Largest calibration gap in any populated bin — the worst case rather than
 * the average.
 *
 * ```ts
 * import { maximumCalibrationError } from 'fino:ml/metrics';
 *
 * console.log(maximumCalibrationError([0, 1], [0.5, 0.5], { bins: 2 })); // 0
 * ```
 */
export function maximumCalibrationError(
  yTrue: ArrayLike<Label>,
  probabilities: ArrayLike<number>,
  options: CalibrationOptions = {},
): number {
  const bins = calibrationCurve(yTrue, probabilities, options);
  let worst = 0;
  for (const bin of bins) {
    worst = Math.max(worst, Math.abs(bin.meanPredicted - bin.fractionPositive));
  }
  return worst;
}

function checkInputs(
  yTrue: ArrayLike<Label>,
  probabilities: ArrayLike<number>,
  positiveLabel?: Label,
): Label {
  requireSameLength(yTrue, probabilities, 'yTrue', 'probabilities');
  requireNonEmpty(yTrue, 'yTrue');
  requireProbabilities(probabilities, 'probabilities');
  return resolveScoreLabel(sortedLabelUnion(yTrue), positiveLabel);
}

function uniformEdges(binCount: number): number[] {
  return Array.from({ length: binCount + 1 }, (_unused, i) => i / binCount);
}

/**
 * Quantile edges, deduplicated so that heavily tied probabilities collapse
 * into one bin instead of producing empty zero-width bins.
 */
function quantileEdges(probabilities: ArrayLike<number>, binCount: number): number[] {
  const sorted = Array.from(
    { length: probabilities.length },
    (_unused, i) => probabilities[i]!,
  ).sort((a, b) => a - b);
  const edges = [0];
  for (let i = 1; i < binCount; i++) {
    const position = (i / binCount) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, sorted.length - 1);
    const value = sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
    if (value > edges[edges.length - 1]!) edges.push(value);
  }
  edges.push(1);
  return edges;
}

function binOf(edges: number[], probability: number): number {
  for (let i = 1; i < edges.length - 1; i++) {
    if (probability < edges[i]!) return i - 1;
  }
  return edges.length - 2;
}
