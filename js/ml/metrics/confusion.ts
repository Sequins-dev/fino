/**
 * Confusion matrix and the per-class rates derived from it.
 */
import {
  compareLabels,
  formatLabels,
  MetricError,
  ratio,
  requireNonEmpty,
  requireSameLength,
  sortedLabelUnion,
  type Label,
} from './shared.ts';

/**
 * Counts of predicted versus true labels, and the metrics derived from them.
 *
 * A matrix owns a fixed label universe and a dense count grid indexed
 * `[trueLabel][predictedLabel]`. Build one from paired arrays with
 * `ConfusionMatrix.from`, or construct an empty one over a known label set and
 * accumulate with `observe`/`observeAll` — the latter is what makes this the
 * aggregation primitive behind `StreamingConfusionMatrix`, since `merge`
 * combines matrices computed independently over different shards.
 *
 * Every rate is derived, not stored, so a matrix is the cheapest way to report
 * accuracy, precision, recall, F-scores, kappa, and MCC together rather than
 * re-scanning the labels once per metric.
 *
 * Undefined rates are reported as `0`: a class with no predictions has zero
 * precision, and a class with no support has zero recall.
 *
 * ```ts
 * import { ConfusionMatrix } from 'fino:ml/metrics';
 *
 * const cm = ConfusionMatrix.from(
 *   ['cat', 'dog', 'cat', 'bird'],
 *   ['cat', 'dog', 'dog', 'bird'],
 * );
 * console.log(cm.accuracy()); // 0.75
 * console.log(cm.recall('cat')); // 0.5
 * console.log(cm.macroF1().toFixed(4)); // 0.7778
 * ```
 */
export class ConfusionMatrix {
  #labels: Label[];
  #index: Map<Label, number>;
  #counts: number[];
  #total = 0;

  /**
   * Create an empty matrix over a fixed label universe.
   *
   * Duplicate labels are rejected. Observing a label outside this set throws,
   * which is what keeps sharded accumulation honest about its schema.
   */
  constructor(labels: readonly Label[]) {
    requireNonEmpty(labels, 'labels');
    this.#labels = [...labels];
    this.#index = new Map();
    for (const [position, label] of this.#labels.entries()) {
      if (this.#index.has(label)) {
        throw new MetricError(`duplicate label ${JSON.stringify(label)} in the label set`);
      }
      this.#index.set(label, position);
    }
    this.#counts = new Array<number>(this.#labels.length * this.#labels.length).fill(0);
  }

  /**
   * Tabulate paired true and predicted labels.
   *
   * ```ts
   * import { ConfusionMatrix } from 'fino:ml/metrics';
   *
   * const cm = ConfusionMatrix.from([1, 0, 1, 1], [1, 0, 0, 1]);
   * console.log(cm.count(1, 0)); // 1
   * ```
   */
  static from(
    yTrue: ArrayLike<Label>,
    yPred: ArrayLike<Label>,
    options: {
      labels?: readonly Label[];
    } = {},
  ): ConfusionMatrix {
    requireSameLength(yTrue, yPred, 'yTrue', 'yPred');
    requireNonEmpty(yTrue, 'yTrue');
    const labels = options.labels ?? sortedLabelUnion(yTrue, yPred);
    const matrix = new ConfusionMatrix(labels);
    matrix.observeAll(yTrue, yPred);
    return matrix;
  }

  /**
   * The label universe, in report order.
   */
  get labels(): readonly Label[] {
    return this.#labels;
  }

  /**
   * Total number of observations tabulated.
   */
  get total(): number {
    return this.#total;
  }

  /**
   * Record one observation, optionally with a fractional weight.
   */
  observe(trueLabel: Label, predictedLabel: Label, weight = 1): void {
    const row = this.#require(trueLabel, 'true');
    const column = this.#require(predictedLabel, 'predicted');
    this.#counts[row * this.#labels.length + column]! += weight;
    this.#total += weight;
  }

  /**
   * Record a batch of paired observations.
   */
  observeAll(yTrue: ArrayLike<Label>, yPred: ArrayLike<Label>): void {
    requireSameLength(yTrue, yPred, 'yTrue', 'yPred');
    for (let i = 0; i < yTrue.length; i++) this.observe(yTrue[i]!, yPred[i]!);
  }

  /**
   * Combine with another matrix, unioning both label universes.
   *
   * Neither input is modified. Shards that only saw some of the classes merge
   * cleanly, which is why worker-parallel evaluation can tabulate locally and
   * reduce at the end.
   *
   * ```ts
   * import { ConfusionMatrix } from 'fino:ml/metrics';
   *
   * const shardA = ConfusionMatrix.from(['a', 'b'], ['a', 'a']);
   * const shardB = ConfusionMatrix.from(['c'], ['c']);
   * console.log(shardA.merge(shardB).labels); // ['a', 'b', 'c']
   * ```
   */
  merge(other: ConfusionMatrix): ConfusionMatrix {
    const labels = [...new Set([...this.#labels, ...other.#labels])].sort(compareLabels);
    const merged = new ConfusionMatrix(labels);
    for (const source of [this, other]) {
      for (const trueLabel of source.#labels) {
        for (const predictedLabel of source.#labels) {
          const count = source.count(trueLabel, predictedLabel);
          if (count !== 0) merged.observe(trueLabel, predictedLabel, count);
        }
      }
    }
    return merged;
  }

  /**
   * Count of observations with the given true and predicted labels.
   */
  count(trueLabel: Label, predictedLabel: Label): number {
    const row = this.#require(trueLabel, 'true');
    const column = this.#require(predictedLabel, 'predicted');
    return this.#counts[row * this.#labels.length + column]!;
  }

  /**
   * Dense count grid indexed `[trueLabel][predictedLabel]`, in label order.
   */
  toArray(): number[][] {
    const size = this.#labels.length;
    return Array.from({ length: size }, (_unused, row) =>
      this.#counts.slice(row * size, row * size + size),
    );
  }

  /**
   * Number of observations whose true label is `label`.
   */
  support(label: Label): number {
    const row = this.#require(label, 'true');
    const size = this.#labels.length;
    let total = 0;
    for (let column = 0; column < size; column++) total += this.#counts[row * size + column]!;
    return total;
  }

  /**
   * Number of observations predicted as `label`.
   */
  predictedCount(label: Label): number {
    const column = this.#require(label, 'predicted');
    const size = this.#labels.length;
    let total = 0;
    for (let row = 0; row < size; row++) total += this.#counts[row * size + column]!;
    return total;
  }

  /**
   * Correct predictions of `label`.
   */
  truePositives(label: Label): number {
    return this.count(label, label);
  }

  /**
   * Observations wrongly predicted as `label`.
   */
  falsePositives(label: Label): number {
    return this.predictedCount(label) - this.truePositives(label);
  }

  /**
   * Observations of `label` predicted as something else.
   */
  falseNegatives(label: Label): number {
    return this.support(label) - this.truePositives(label);
  }

  /**
   * Observations that are neither `label` nor predicted as `label`.
   */
  trueNegatives(label: Label): number {
    return (
      this.#total -
      this.truePositives(label) -
      this.falsePositives(label) -
      this.falseNegatives(label)
    );
  }

  /**
   * Fraction of observations predicted correctly.
   */
  accuracy(): number {
    let correct = 0;
    for (const label of this.#labels) correct += this.truePositives(label);
    return ratio(correct, this.#total);
  }

  /**
   * `TP / (TP + FP)` for `label` — how often a positive prediction is right.
   */
  precision(label: Label): number {
    return ratio(this.truePositives(label), this.predictedCount(label));
  }

  /**
   * `TP / (TP + FN)` for `label` — how much of the class was recovered.
   */
  recall(label: Label): number {
    return ratio(this.truePositives(label), this.support(label));
  }

  /**
   * `TN / (TN + FP)` for `label` — recall of the negative class.
   */
  specificity(label: Label): number {
    const trueNegatives = this.trueNegatives(label);
    return ratio(trueNegatives, trueNegatives + this.falsePositives(label));
  }

  /**
   * Harmonic mean of precision and recall for `label`.
   */
  f1(label: Label): number {
    return this.fBeta(label, 1);
  }

  /**
   * Weighted harmonic mean of precision and recall for `label`.
   *
   * `beta` sets how much more recall matters than precision: `beta < 1`
   * favors precision, `beta > 1` favors recall.
   */
  fBeta(label: Label, beta: number): number {
    if (!Number.isFinite(beta) || beta <= 0) {
      throw new MetricError(`beta must be a positive finite number (got ${beta})`);
    }
    const precision = this.precision(label);
    const recall = this.recall(label);
    const betaSquared = beta * beta;
    return ratio((1 + betaSquared) * precision * recall, betaSquared * precision + recall);
  }

  /**
   * Unweighted mean precision across classes.
   */
  macroPrecision(): number {
    return meanOverLabels(this.#labels, (label) => this.precision(label));
  }

  /**
   * Unweighted mean recall across classes.
   */
  macroRecall(): number {
    return meanOverLabels(this.#labels, (label) => this.recall(label));
  }

  /**
   * Unweighted mean F1 across classes.
   */
  macroF1(): number {
    return meanOverLabels(this.#labels, (label) => this.f1(label));
  }

  /**
   * Support-weighted mean precision across classes.
   */
  weightedPrecision(): number {
    return this.#weighted((label) => this.precision(label));
  }

  /**
   * Support-weighted mean recall across classes.
   */
  weightedRecall(): number {
    return this.#weighted((label) => this.recall(label));
  }

  /**
   * Support-weighted mean F1 across classes.
   */
  weightedF1(): number {
    return this.#weighted((label) => this.f1(label));
  }

  /**
   * Precision over pooled counts. Equals accuracy for single-label problems.
   */
  microPrecision(): number {
    const { truePositives, falsePositives } = this.#pooled();
    return ratio(truePositives, truePositives + falsePositives);
  }

  /**
   * Recall over pooled counts. Equals accuracy for single-label problems.
   */
  microRecall(): number {
    const { truePositives, falseNegatives } = this.#pooled();
    return ratio(truePositives, truePositives + falseNegatives);
  }

  /**
   * F1 over pooled counts. Equals accuracy for single-label problems.
   */
  microF1(): number {
    const precision = this.microPrecision();
    const recall = this.microRecall();
    return ratio(2 * precision * recall, precision + recall);
  }

  /**
   * Mean recall across classes that have support.
   *
   * Unlike `accuracy`, a majority-class predictor cannot score well here, so
   * this is the honest headline number for imbalanced data.
   */
  balancedAccuracy(): number {
    const present = this.#labels.filter((label) => this.support(label) > 0);
    return meanOverLabels(present, (label) => this.recall(label));
  }

  /**
   * Matthews correlation coefficient over all classes, in `[-1, 1]`.
   *
   * Reports `0` for a degenerate matrix where the coefficient is undefined.
   */
  matthewsCorrCoef(): number {
    let correct = 0;
    let agreement = 0;
    let predictedSquares = 0;
    let supportSquares = 0;
    for (const label of this.#labels) {
      const support = this.support(label);
      const predicted = this.predictedCount(label);
      correct += this.truePositives(label);
      agreement += support * predicted;
      predictedSquares += predicted * predicted;
      supportSquares += support * support;
    }
    const total = this.#total;
    const covariance = correct * total - agreement;
    const spread = Math.sqrt((total * total - predictedSquares) * (total * total - supportSquares));
    return spread === 0 ? 0 : covariance / spread;
  }

  /**
   * Cohen's kappa: accuracy corrected for agreement expected by chance.
   *
   * Reports `0` when chance agreement is total and the statistic is undefined.
   */
  cohenKappa(): number {
    const total = this.#total;
    if (total === 0) return 0;
    let expected = 0;
    for (const label of this.#labels) {
      expected += this.support(label) * this.predictedCount(label);
    }
    const chance = expected / (total * total);
    return chance === 1 ? 0 : (this.accuracy() - chance) / (1 - chance);
  }

  /**
   * Per-class precision, recall, F1, and support, in label order.
   */
  report(): Array<{
    label: Label;
    precision: number;
    recall: number;
    f1: number;
    support: number;
  }> {
    return this.#labels.map((label) => ({
      label,
      precision: this.precision(label),
      recall: this.recall(label),
      f1: this.f1(label),
      support: this.support(label),
    }));
  }

  /**
   * Render the count grid as an aligned text table, true labels down the rows.
   *
   * ```ts no_run
   * import { ConfusionMatrix } from 'fino:ml/metrics';
   *
   * console.log(ConfusionMatrix.from(['a', 'b'], ['a', 'a']).format());
   * ```
   */
  format(): string {
    const headers = this.#labels.map((label) => String(label));
    const rows = this.toArray().map((row) => row.map((count) => String(count)));
    const corner = 'true \\ pred';
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...rows.map((row) => row[column]!.length)),
    );
    const labelWidth = Math.max(corner.length, ...headers.map((header) => header.length));
    const lines = [
      [corner.padEnd(labelWidth), ...headers.map((h, i) => h.padStart(widths[i]!))].join('  '),
    ];
    for (const [row, cells] of rows.entries()) {
      lines.push(
        [
          headers[row]!.padEnd(labelWidth),
          ...cells.map((cell, column) => cell.padStart(widths[column]!)),
        ].join('  '),
      );
    }
    return lines.join('\n');
  }

  /**
   * Plain structure suitable for `JSON.stringify` and cross-realm transfer.
   */
  toJSON(): {
    labels: Label[];
    counts: number[][];
  } {
    return {
      labels: [...this.#labels],
      counts: this.toArray(),
    };
  }

  #pooled(): {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
  } {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const label of this.#labels) {
      truePositives += this.truePositives(label);
      falsePositives += this.falsePositives(label);
      falseNegatives += this.falseNegatives(label);
    }
    return { truePositives, falsePositives, falseNegatives };
  }

  #weighted(score: (label: Label) => number): number {
    let weighted = 0;
    for (const label of this.#labels) weighted += score(label) * this.support(label);
    return ratio(weighted, this.#total);
  }

  #require(label: Label, role: string): number {
    const position = this.#index.get(label);
    if (position === undefined) {
      throw new MetricError(
        `unknown ${role} label ${JSON.stringify(label)} (labels: ${formatLabels(this.#labels)})`,
      );
    }
    return position;
  }
}

function meanOverLabels(labels: readonly Label[], score: (label: Label) => number): number {
  let total = 0;
  for (const label of labels) total += score(label);
  return ratio(total, labels.length);
}
