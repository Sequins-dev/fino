/**
 * Classification metrics over discrete labels and over ranked scores.
 */
import { ConfusionMatrix } from './confusion.ts';
import {
  descendingOrder,
  MetricError,
  ratio,
  requireNonEmpty,
  requireProbabilities,
  requireSameLength,
  resolvePositiveLabel,
  resolveScoreLabel,
  sortedLabelUnion,
  type Label,
} from './shared.ts';

/**
 * How per-class scores are combined into a single number.
 *
 * `binary` reports the positive class alone. `macro` is the unweighted mean
 * over classes, treating rare classes as equal to common ones. `weighted`
 * takes the same per-class scores weighted by true-class support. `micro`
 * pools every class's counts before dividing, which for single-label problems
 * equals accuracy. `none` returns one score per class, in label order.
 */
export type Average = 'binary' | 'macro' | 'micro' | 'weighted' | 'none';

/**
 * Options shared by the averaged classification metrics.
 */
export interface AverageOptions {
  /**
   * Averaging mode. Defaults to `binary`.
   */
  average?: Average;
  /**
   * Which label counts as positive under `binary` averaging. Inferred as `1`
   * when the labels are `{0, 1}` and `true` when they are `{false, true}`;
   * otherwise it must be given.
   */
  positiveLabel?: Label;
  /**
   * Label universe, in report order. Defaults to the sorted union of the
   * observed true and predicted labels. Pass this to keep a class present in
   * the report even when a batch never observes it.
   */
  labels?: readonly Label[];
}

/**
 * Fraction of predictions that match the true label.
 *
 * ```ts
 * import { accuracy } from 'fino:ml/metrics';
 *
 * console.log(accuracy([1, 0, 1, 1], [1, 0, 0, 1])); // 0.75
 * ```
 */
export function accuracy(yTrue: ArrayLike<Label>, yPred: ArrayLike<Label>): number {
  requireSameLength(yTrue, yPred, 'yTrue', 'yPred');
  requireNonEmpty(yTrue, 'yTrue');
  let correct = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] === yPred[i]) correct++;
  }
  return correct / yTrue.length;
}

/**
 * Precision: of everything predicted positive, how much really was.
 *
 * ```ts
 * import { precision } from 'fino:ml/metrics';
 *
 * console.log(precision([1, 0, 1, 1], [1, 1, 0, 1])); // 0.6666666666666666
 * console.log(precision(['a', 'b', 'c'], ['a', 'b', 'b'], { average: 'macro' }));
 * ```
 */
export function precision(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options?: AverageOptions & { average?: Exclude<Average, 'none'> },
): number;
export function precision(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options: AverageOptions & { average: 'none' },
): number[];
export function precision(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options: AverageOptions = {},
): number | number[] {
  return averaged(yTrue, yPred, options, {
    perClass: (cm, label) => cm.precision(label),
    macro: (cm) => cm.macroPrecision(),
    micro: (cm) => cm.microPrecision(),
    weighted: (cm) => cm.weightedPrecision(),
  });
}

/**
 * Recall: of everything that really was positive, how much was found.
 *
 * ```ts
 * import { recall } from 'fino:ml/metrics';
 *
 * console.log(recall([1, 0, 1, 1], [1, 1, 0, 1])); // 0.6666666666666666
 * ```
 */
export function recall(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options?: AverageOptions & { average?: Exclude<Average, 'none'> },
): number;
export function recall(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options: AverageOptions & { average: 'none' },
): number[];
export function recall(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options: AverageOptions = {},
): number | number[] {
  return averaged(yTrue, yPred, options, {
    perClass: (cm, label) => cm.recall(label),
    macro: (cm) => cm.macroRecall(),
    micro: (cm) => cm.microRecall(),
    weighted: (cm) => cm.weightedRecall(),
  });
}

/**
 * Harmonic mean of precision and recall.
 *
 * ```ts
 * import { f1Score } from 'fino:ml/metrics';
 *
 * console.log(f1Score([1, 0, 1, 1], [1, 1, 0, 1])); // 0.6666666666666666
 * ```
 */
export function f1Score(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options?: AverageOptions & { average?: Exclude<Average, 'none'> },
): number;
export function f1Score(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options: AverageOptions & { average: 'none' },
): number[];
export function f1Score(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options: AverageOptions = {},
): number | number[] {
  return averaged(yTrue, yPred, options, {
    perClass: (cm, label) => cm.f1(label),
    macro: (cm) => cm.macroF1(),
    micro: (cm) => cm.microF1(),
    weighted: (cm) => cm.weightedF1(),
  });
}

/**
 * F-score with `beta` weighting recall against precision.
 *
 * `beta` below `1` favors precision, above `1` favors recall. `beta = 2` is
 * the usual choice when a miss costs more than a false alarm.
 *
 * ```ts
 * import { fBetaScore } from 'fino:ml/metrics';
 *
 * console.log(fBetaScore([1, 0, 1, 1], [1, 1, 0, 1], 2));
 * ```
 */
export function fBetaScore(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  beta: number,
  options?: AverageOptions & { average?: Exclude<Average, 'none'> },
): number;
export function fBetaScore(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  beta: number,
  options: AverageOptions & { average: 'none' },
): number[];
export function fBetaScore(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  beta: number,
  options: AverageOptions = {},
): number | number[] {
  return averaged(yTrue, yPred, options, {
    perClass: (cm, label) => cm.fBeta(label, beta),
    macro: (cm) => meanOver(cm, (label) => cm.fBeta(label, beta)),
    micro: (cm) => {
      const microPrecision = cm.microPrecision();
      const microRecall = cm.microRecall();
      const betaSquared = beta * beta;
      return ratio(
        (1 + betaSquared) * microPrecision * microRecall,
        betaSquared * microPrecision + microRecall,
      );
    },
    weighted: (cm) => {
      let weighted = 0;
      for (const label of cm.labels) weighted += cm.fBeta(label, beta) * cm.support(label);
      return ratio(weighted, cm.total);
    },
  });
}

/**
 * Mean per-class recall, the imbalance-resistant counterpart to `accuracy`.
 *
 * ```ts
 * import { balancedAccuracy } from 'fino:ml/metrics';
 *
 * console.log(balancedAccuracy([0, 0, 0, 1], [0, 0, 0, 0])); // 0.5
 * ```
 */
export function balancedAccuracy(yTrue: ArrayLike<Label>, yPred: ArrayLike<Label>): number {
  return ConfusionMatrix.from(yTrue, yPred).balancedAccuracy();
}

/**
 * Matthews correlation coefficient, in `[-1, 1]`.
 *
 * `1` is perfect agreement, `0` is chance, `-1` is total disagreement. Unlike
 * F1 it accounts for true negatives, so it does not flatter a model that only
 * ever predicts the majority class.
 *
 * ```ts
 * import { matthewsCorrCoef } from 'fino:ml/metrics';
 *
 * console.log(matthewsCorrCoef([1, 1, 0, 0], [1, 1, 0, 0])); // 1
 * ```
 */
export function matthewsCorrCoef(yTrue: ArrayLike<Label>, yPred: ArrayLike<Label>): number {
  return ConfusionMatrix.from(yTrue, yPred).matthewsCorrCoef();
}

/**
 * Cohen's kappa: agreement corrected for what chance would produce.
 *
 * ```ts
 * import { cohenKappa } from 'fino:ml/metrics';
 *
 * console.log(cohenKappa([1, 1, 0, 0], [1, 0, 0, 0]).toFixed(4)); // 0.5000
 * ```
 */
export function cohenKappa(yTrue: ArrayLike<Label>, yPred: ArrayLike<Label>): number {
  return ConfusionMatrix.from(yTrue, yPred).cohenKappa();
}

/**
 * Options for probability-scored classification metrics.
 */
export interface ProbabilityOptions {
  /**
   * Which label the probabilities refer to. Inferred as `1` or `true` when
   * the labels allow it.
   */
  positiveLabel?: Label;
}

/**
 * Cross-entropy of predicted probabilities against true labels.
 *
 * Lower is better and `0` is perfect. Probabilities are clamped away from the
 * exact endpoints by `eps` so that a confident mistake costs a large finite
 * amount rather than infinity.
 *
 * ```ts
 * import { logLoss } from 'fino:ml/metrics';
 *
 * console.log(logLoss([1, 0, 1], [0.9, 0.1, 0.8]).toFixed(4)); // 0.1446
 * ```
 */
export function logLoss(
  yTrue: ArrayLike<Label>,
  probabilities: ArrayLike<number>,
  options: ProbabilityOptions & {
    /**
     * Clamp applied to both ends of the probability range. Defaults to `1e-15`.
     */
    eps?: number;
  } = {},
): number {
  const positive = binaryPositive(yTrue, probabilities, options.positiveLabel);
  requireProbabilities(probabilities, 'probabilities');
  const eps = options.eps ?? 1e-15;
  if (!Number.isFinite(eps) || eps <= 0 || eps >= 0.5) {
    throw new MetricError(`eps must be in (0, 0.5) (got ${eps})`);
  }
  let total = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = Math.min(Math.max(probabilities[i]!, eps), 1 - eps);
    total += yTrue[i] === positive ? -Math.log(p) : -Math.log(1 - p);
  }
  return total / probabilities.length;
}

/**
 * A receiver-operating-characteristic curve.
 */
export interface RocCurve {
  /**
   * Score thresholds, descending. The first entry is above every score, which
   * is the origin point where nothing is predicted positive.
   */
  thresholds: number[];
  /**
   * False-positive rate at each threshold.
   */
  falsePositiveRate: number[];
  /**
   * True-positive rate at each threshold.
   */
  truePositiveRate: number[];
}

/**
 * Sweep every threshold and report the false/true positive rate at each.
 *
 * Points are emitted once per distinct score, so tied scores collapse into a
 * single point and the curve stays independent of input order.
 *
 * ```ts
 * import { rocCurve } from 'fino:ml/metrics';
 *
 * const curve = rocCurve([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]);
 * console.log(curve.truePositiveRate); // [0, 0.5, 0.5, 1, 1]
 * ```
 */
export function rocCurve(
  yTrue: ArrayLike<Label>,
  scores: ArrayLike<number>,
  options: ProbabilityOptions = {},
): RocCurve {
  const positive = binaryPositive(yTrue, scores, options.positiveLabel);
  const order = descendingOrder(scores);
  const positives = countMatching(yTrue, positive);
  const negatives = yTrue.length - positives;
  const thresholds = [Number.POSITIVE_INFINITY];
  const falsePositiveRate = [0];
  const truePositiveRate = [0];
  let truePositives = 0;
  let falsePositives = 0;
  for (let i = 0; i < order.length; i++) {
    const index = order[i]!;
    if (yTrue[index] === positive) truePositives++;
    else falsePositives++;
    const next = order[i + 1];
    if (next !== undefined && scores[next] === scores[index]) continue;
    thresholds.push(scores[index]!);
    falsePositiveRate.push(ratio(falsePositives, negatives));
    truePositiveRate.push(ratio(truePositives, positives));
  }
  return { thresholds, falsePositiveRate, truePositiveRate };
}

/**
 * Area under the ROC curve: the chance a random positive outranks a random
 * negative.
 *
 * `0.5` is coin-flip performance and `1` is a perfect ranking. Computed from
 * tie-corrected ranks, so it is exact rather than trapezoid-approximated, and
 * unlike threshold metrics it does not depend on a decision cutoff.
 *
 * Reports `0` when the labels are all positive or all negative, where the
 * statistic is undefined.
 *
 * ```ts
 * import { rocAuc } from 'fino:ml/metrics';
 *
 * console.log(rocAuc([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8])); // 0.75
 * ```
 */
export function rocAuc(
  yTrue: ArrayLike<Label>,
  scores: ArrayLike<number>,
  options: ProbabilityOptions = {},
): number {
  const positive = binaryPositive(yTrue, scores, options.positiveLabel);
  const positives = countMatching(yTrue, positive);
  const negatives = yTrue.length - positives;
  if (positives === 0 || negatives === 0) return 0;
  const ranks = averageRanks(scores);
  let positiveRankSum = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] === positive) positiveRankSum += ranks[i]!;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * A precision-recall curve.
 */
export interface PrecisionRecallCurve {
  /**
   * Score thresholds, ascending, one per curve point except the final
   * `(recall 0, precision 1)` endpoint.
   */
  thresholds: number[];
  /**
   * Precision at each threshold, ending at `1`.
   */
  precision: number[];
  /**
   * Recall at each threshold, ending at `0`.
   */
  recall: number[];
}

/**
 * Precision and recall at every distinct threshold.
 *
 * Prefer this over `rocCurve` when positives are rare: it ignores true
 * negatives, so a large easy negative class cannot inflate the picture.
 *
 * ```ts
 * import { precisionRecallCurve } from 'fino:ml/metrics';
 *
 * const curve = precisionRecallCurve([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8]);
 * console.log(curve.recall); // [1, 1, 0.5, 0.5, 0]
 * ```
 */
export function precisionRecallCurve(
  yTrue: ArrayLike<Label>,
  scores: ArrayLike<number>,
  options: ProbabilityOptions = {},
): PrecisionRecallCurve {
  const positive = binaryPositive(yTrue, scores, options.positiveLabel);
  const order = descendingOrder(scores);
  const positives = countMatching(yTrue, positive);
  const points: Array<{ threshold: number; precision: number; recall: number }> = [];
  let truePositives = 0;
  let predicted = 0;
  for (let i = 0; i < order.length; i++) {
    const index = order[i]!;
    if (yTrue[index] === positive) truePositives++;
    predicted++;
    const next = order[i + 1];
    if (next !== undefined && scores[next] === scores[index]) continue;
    points.push({
      threshold: scores[index]!,
      precision: ratio(truePositives, predicted),
      recall: ratio(truePositives, positives),
    });
  }
  points.reverse();
  return {
    thresholds: points.map((point) => point.threshold),
    precision: [...points.map((point) => point.precision), 1],
    recall: [...points.map((point) => point.recall), 0],
  };
}

/**
 * Average precision: the precision-recall curve summarized as one number.
 *
 * Each threshold's precision is weighted by the recall it gains, which avoids
 * the optimistic interpolation that trapezoid area under the same curve would
 * introduce.
 *
 * ```ts
 * import { averagePrecision } from 'fino:ml/metrics';
 *
 * console.log(averagePrecision([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8])); // 0.8333333333333333
 * ```
 */
export function averagePrecision(
  yTrue: ArrayLike<Label>,
  scores: ArrayLike<number>,
  options: ProbabilityOptions = {},
): number {
  const curve = precisionRecallCurve(yTrue, scores, options);
  let area = 0;
  for (let i = 0; i < curve.thresholds.length; i++) {
    const previousRecall = i + 1 < curve.recall.length ? curve.recall[i + 1]! : 0;
    area += (curve.recall[i]! - previousRecall) * curve.precision[i]!;
  }
  return area;
}

function averaged(
  yTrue: ArrayLike<Label>,
  yPred: ArrayLike<Label>,
  options: AverageOptions,
  score: {
    perClass: (cm: ConfusionMatrix, label: Label) => number;
    macro: (cm: ConfusionMatrix) => number;
    micro: (cm: ConfusionMatrix) => number;
    weighted: (cm: ConfusionMatrix) => number;
  },
): number | number[] {
  const labels = options.labels ?? sortedLabelUnion(yTrue, yPred);
  const cm = ConfusionMatrix.from(yTrue, yPred, { labels });
  const average = options.average ?? 'binary';
  switch (average) {
    case 'binary':
      return score.perClass(cm, resolvePositiveLabel(labels, options.positiveLabel));
    case 'macro':
      return score.macro(cm);
    case 'micro':
      return score.micro(cm);
    case 'weighted':
      return score.weighted(cm);
    case 'none':
      return labels.map((label) => score.perClass(cm, label));
    default:
      throw new MetricError(`unknown average mode ${JSON.stringify(average)}`);
  }
}

function meanOver(cm: ConfusionMatrix, score: (label: Label) => number): number {
  let total = 0;
  for (const label of cm.labels) total += score(label);
  return ratio(total, cm.labels.length);
}

function binaryPositive(
  yTrue: ArrayLike<Label>,
  scores: ArrayLike<number>,
  positiveLabel?: Label,
): Label {
  requireSameLength(yTrue, scores, 'yTrue', 'scores');
  requireNonEmpty(yTrue, 'yTrue');
  return resolveScoreLabel(sortedLabelUnion(yTrue), positiveLabel);
}

function countMatching(labels: ArrayLike<Label>, target: Label): number {
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === target) count++;
  }
  return count;
}

/**
 * Midpoint ranks, so tied scores share the average of the ranks they span.
 */
function averageRanks(scores: ArrayLike<number>): number[] {
  const order = Array.from({ length: scores.length }, (_unused, i) => i);
  order.sort((a, b) => {
    const diff = scores[a]! - scores[b]!;
    return diff !== 0 ? diff : a - b;
  });
  const ranks = new Array<number>(scores.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && scores[order[end + 1]!] === scores[order[start]!]) end++;
    const shared = (start + end) / 2 + 1;
    for (let i = start; i <= end; i++) ranks[order[i]!] = shared;
    start = end + 1;
  }
  return ranks;
}
