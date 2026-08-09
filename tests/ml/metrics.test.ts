import { describe, it } from 'fino:test/test';
import {
  accuracy,
  averagePrecision,
  averagePrecisionAtK,
  balancedAccuracy,
  brierScore,
  calibrationCurve,
  cohenKappa,
  ConfusionMatrix,
  cosineDistance,
  cosineSimilarity,
  dcgAtK,
  dotProduct,
  euclideanDistance,
  expectedCalibrationError,
  explainedVariance,
  f1Score,
  fBetaScore,
  hitRateAtK,
  l2Norm,
  logLoss,
  manhattanDistance,
  matthewsCorrCoef,
  maxError,
  maximumCalibrationError,
  meanAbsoluteError,
  meanAbsolutePercentageError,
  meanAveragePrecisionAtK,
  meanReciprocalRank,
  meanSquaredError,
  meanSquaredLogError,
  medianAbsoluteError,
  MetricError,
  ndcgAtK,
  pearsonCorrelation,
  precision,
  precisionAtK,
  precisionRecallCurve,
  r2Score,
  rankedRelevance,
  recall,
  recallAtK,
  reciprocalRank,
  rocAuc,
  rocCurve,
  rootMeanSquaredError,
  StreamingAccuracy,
  StreamingConfusionMatrix,
  StreamingMean,
  StreamingRegression,
  StreamingVariance,
} from 'fino:ml/metrics';

function close(
  t: { ok(value: unknown, message?: string): void },
  got: number,
  want: number,
  message: string,
): void {
  t.ok(Math.abs(got - want) < 1e-9, `${message} (got ${got}, want ${want})`);
}

describe('confusion matrix', () => {
  it('tabulates counts and derives per-class rates', async (t) => {
    const cm = ConfusionMatrix.from(['cat', 'dog', 'cat', 'bird'], ['cat', 'dog', 'dog', 'bird']);
    t.deepEqual([...cm.labels], ['bird', 'cat', 'dog'], 'labels are sorted');
    t.equal(cm.total, 4, 'counts every observation');
    t.equal(cm.count('cat', 'dog'), 1, 'one cat predicted as dog');
    t.deepEqual(
      cm.toArray(),
      [
        [1, 0, 0],
        [0, 1, 1],
        [0, 0, 1],
      ],
      'dense grid is indexed [true][pred]',
    );
    t.equal(cm.accuracy(), 0.75, 'three of four correct');
    t.equal(cm.recall('cat'), 0.5, 'half the cats recovered');
    t.equal(cm.precision('dog'), 0.5, 'half the dog predictions were dogs');
    t.equal(cm.support('cat'), 2, 'two true cats');
    t.equal(cm.predictedCount('dog'), 2, 'two dog predictions');
    close(t, cm.macroF1(), 7 / 9, 'macro F1 averages per-class F1');
  });

  it('counts true and false positives and negatives consistently', async (t) => {
    const cm = ConfusionMatrix.from([1, 1, 0, 0, 1], [1, 0, 0, 1, 1]);
    t.equal(cm.truePositives(1), 2, 'two true positives');
    t.equal(cm.falseNegatives(1), 1, 'one positive missed');
    t.equal(cm.falsePositives(1), 1, 'one negative flagged');
    t.equal(cm.trueNegatives(1), 1, 'one negative correctly left alone');
    t.equal(
      cm.truePositives(1) + cm.falsePositives(1) + cm.falseNegatives(1) + cm.trueNegatives(1),
      cm.total,
      'the four cells partition every observation',
    );
    t.equal(cm.specificity(1), 0.5, 'half the negatives were left alone');
  });

  it('reports zero rather than NaN for undefined rates', async (t) => {
    const cm = ConfusionMatrix.from(['a', 'b'], ['a', 'a'], { labels: ['a', 'b', 'c'] });
    t.equal(cm.precision('c'), 0, 'a never-predicted class has zero precision');
    t.equal(cm.recall('c'), 0, 'a never-present class has zero recall');
    t.equal(cm.f1('c'), 0, 'and zero F1');
    t.equal(cm.support('c'), 0, 'with no support');
  });

  it('keeps micro-averaged scores equal to accuracy for single-label data', async (t) => {
    const cm = ConfusionMatrix.from(['a', 'b', 'c', 'a'], ['a', 'c', 'c', 'b']);
    close(t, cm.microF1(), cm.accuracy(), 'micro F1 equals accuracy');
    close(t, cm.microPrecision(), cm.accuracy(), 'micro precision equals accuracy');
    close(t, cm.microRecall(), cm.accuracy(), 'micro recall equals accuracy');
  });

  it('merges shards by unioning label sets', async (t) => {
    const shardA = ConfusionMatrix.from(['a', 'b'], ['a', 'a']);
    const shardB = ConfusionMatrix.from(['c', 'c'], ['c', 'a']);
    const merged = shardA.merge(shardB);
    t.deepEqual([...merged.labels], ['a', 'b', 'c'], 'labels are unioned');
    t.equal(merged.total, 4, 'totals add');
    t.equal(merged.count('c', 'a'), 1, 'cross-shard cells survive the merge');
    t.equal(shardA.total, 2, 'the left operand is untouched');
    t.equal(shardB.total, 2, 'the right operand is untouched');

    const combined = ConfusionMatrix.from(['a', 'b', 'c', 'c'], ['a', 'a', 'c', 'a']);
    t.deepEqual(merged.toArray(), combined.toArray(), 'merging equals tabulating together');
  });

  it('rejects unknown labels and duplicate label sets', async (t) => {
    const cm = new ConfusionMatrix(['a', 'b']);
    t.throws(() => cm.observe('a', 'z'), /unknown predicted label/, 'unknown prediction throws');
    t.throws(() => cm.observe('z', 'a'), /unknown true label/, 'unknown truth throws');
    t.throws(() => new ConfusionMatrix(['a', 'a']), /duplicate label/, 'duplicates throw');
    t.throws(() => new ConfusionMatrix([]), /must not be empty/, 'an empty label set throws');
  });

  it('renders an aligned table', async (t) => {
    const text = ConfusionMatrix.from(['a', 'b'], ['a', 'a']).format();
    const lines = text.split('\n');
    t.equal(lines.length, 3, 'a header plus one row per label');
    t.ok(lines[0]!.includes('true \\ pred'), 'header names the axes');
    t.ok(
      lines.every((line) => line.length === lines[0]!.length),
      'every row is padded to the same width',
    );
  });
});

describe('classification metrics', () => {
  it('scores binary predictions', async (t) => {
    const yTrue = [1, 0, 1, 1];
    const yPred = [1, 1, 0, 1];
    t.equal(accuracy(yTrue, yPred), 0.5, 'two of four correct');
    close(t, precision(yTrue, yPred), 2 / 3, 'two of three positive calls were right');
    close(t, recall(yTrue, yPred), 2 / 3, 'two of three positives were found');
    close(t, f1Score(yTrue, yPred), 2 / 3, 'F1 sits between them');
  });

  it('weights recall against precision with beta', async (t) => {
    const yTrue = [1, 1, 1, 0];
    const yPred = [1, 0, 0, 0];
    const p = precision(yTrue, yPred);
    const r = recall(yTrue, yPred);
    t.equal(p, 1, 'the single positive call was right');
    close(t, r, 1 / 3, 'but it found only a third of the positives');
    t.ok(fBetaScore(yTrue, yPred, 2) < f1Score(yTrue, yPred), 'beta > 1 punishes poor recall');
    t.ok(fBetaScore(yTrue, yPred, 0.5) > f1Score(yTrue, yPred), 'beta < 1 rewards precision');
    t.throws(() => fBetaScore(yTrue, yPred, 0), /beta must be a positive/, 'beta must be positive');
  });

  it('supports every averaging mode', async (t) => {
    const yTrue = ['a', 'b', 'c'];
    const yPred = ['a', 'b', 'b'];
    close(t, precision(yTrue, yPred, { average: 'macro' }), 0.5, 'macro averages classes equally');
    close(
      t,
      precision(yTrue, yPred, { average: 'micro' }),
      2 / 3,
      'micro pools counts before dividing',
    );
    t.deepEqual(
      precision(yTrue, yPred, { average: 'none' }),
      [1, 0.5, 0],
      'none reports one score per class in label order',
    );
    close(t, precision(yTrue, yPred, { average: 'weighted' }), 0.5, 'weighted follows support');
  });

  it('needs an explicit positive label when it cannot be inferred', async (t) => {
    const yTrue = ['spam', 'ham'];
    const yPred = ['spam', 'spam'];
    t.throws(
      () => accuracy(yTrue, yPred) && precision(yTrue, yPred),
      /cannot infer the positive label/,
      'string labels are ambiguous',
    );
    t.equal(precision(yTrue, yPred, { positiveLabel: 'spam' }), 0.5, 'stating it resolves them');
    t.throws(
      () => precision(yTrue, yPred, { positiveLabel: 'nope' }),
      /does not appear in the data/,
      'a positive label absent from the data throws',
    );
  });

  it('infers the positive label for 0/1 and boolean labels', async (t) => {
    close(t, precision([1, 0], [1, 1]), 0.5, 'numeric labels infer 1');
    close(t, precision([true, false], [true, true]), 0.5, 'boolean labels infer true');
  });

  it('scores agreement beyond chance', async (t) => {
    close(t, cohenKappa([1, 1, 0, 0], [1, 0, 0, 0]), 0.5, 'kappa corrects for chance agreement');
    t.equal(matthewsCorrCoef([1, 1, 0, 0], [1, 1, 0, 0]), 1, 'perfect agreement is 1');
    t.equal(matthewsCorrCoef([1, 1, 0, 0], [0, 0, 1, 1]), -1, 'total disagreement is -1');
    t.equal(matthewsCorrCoef([1, 1, 1, 1], [1, 1, 1, 1]), 0, 'a degenerate matrix reports 0');
  });

  it('resists majority-class inflation with balanced accuracy', async (t) => {
    const yTrue = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const alwaysNegative = yTrue.map(() => 0);
    t.equal(accuracy(yTrue, alwaysNegative), 0.9, 'accuracy flatters the trivial model');
    t.equal(balancedAccuracy(yTrue, alwaysNegative), 0.5, 'balanced accuracy does not');
  });

  it('validates input shape', async (t) => {
    t.throws(() => accuracy([1, 0], [1]), /same length/, 'length mismatch throws');
    t.throws(() => accuracy([], []), /must not be empty/, 'empty input throws');
    t.ok(new MetricError('x') instanceof Error, 'MetricError is an Error');
  });
});

describe('score-based classification metrics', () => {
  const yTrue = [0, 0, 1, 1];
  const scores = [0.1, 0.4, 0.35, 0.8];

  it('computes ROC points and area', async (t) => {
    const curve = rocCurve(yTrue, scores);
    t.deepEqual(curve.truePositiveRate, [0, 0.5, 0.5, 1, 1], 'TPR climbs with each positive');
    t.deepEqual(curve.falsePositiveRate, [0, 0, 0.5, 0.5, 1], 'FPR climbs with each negative');
    t.equal(curve.thresholds[0], Number.POSITIVE_INFINITY, 'the curve starts above every score');
    t.equal(rocAuc(yTrue, scores), 0.75, 'area matches the swept curve');
  });

  it('is invariant to monotone score transforms', async (t) => {
    const stretched = scores.map((score) => score * 100 + 7);
    t.equal(rocAuc(yTrue, stretched), rocAuc(yTrue, scores), 'only the ranking matters');
  });

  it('handles ties with midpoint ranks', async (t) => {
    t.equal(rocAuc([0, 1], [0.5, 0.5]), 0.5, 'a total tie is coin-flip performance');
    t.equal(rocAuc([0, 0, 1, 1], [0.1, 0.1, 0.9, 0.9]), 1, 'ties within a class do not matter');
  });

  it('reports zero when a class is missing', async (t) => {
    t.equal(rocAuc([1, 1, 1], [0.2, 0.5, 0.9]), 0, 'AUC is undefined without both classes');
  });

  it('computes precision-recall points and average precision', async (t) => {
    const curve = precisionRecallCurve(yTrue, scores);
    t.deepEqual(curve.recall, [1, 1, 0.5, 0.5, 0], 'recall falls as the threshold rises');
    t.equal(curve.precision[curve.precision.length - 1], 1, 'the curve ends at precision 1');
    close(t, averagePrecision(yTrue, scores), 5 / 6, 'average precision weights each recall gain');
  });

  it('separates ranking quality from calibration', async (t) => {
    const confident = [0.99, 0.99, 0.01, 0.01];
    const timid = [0.6, 0.6, 0.4, 0.4];
    const labels = [1, 1, 0, 0];
    t.equal(rocAuc(labels, confident), rocAuc(labels, timid), 'both rank perfectly');
    t.ok(
      logLoss(labels, confident) < logLoss(labels, timid),
      'but confidence is rewarded by log loss',
    );
  });

  it('bounds log loss for confident mistakes', async (t) => {
    close(t, logLoss([1, 0, 1], [0.9, 0.1, 0.8]), 0.14462152754328741, 'known cross-entropy');
    t.ok(Number.isFinite(logLoss([1], [0])), 'a certain miss stays finite');
    t.throws(() => logLoss([1, 0], [0.5, 1.5]), /probability in \[0, 1\]/, 'range is enforced');
    t.throws(() => logLoss([1, 0], [0.5, 0.5], { eps: 0 }), /eps must be/, 'eps is validated');
  });

  it('scores a batch with no positives', async (t) => {
    t.equal(brierScore([0, 0], [0, 0]), 0, 'an all-negative shard is still scorable');
  });
});

describe('regression metrics', () => {
  const yTrue = [3, -0.5, 2, 7];
  const yPred = [2.5, 0, 2, 8];

  it('summarizes error several ways', async (t) => {
    close(t, meanSquaredError(yTrue, yPred), 0.375, 'mean squared error');
    close(t, rootMeanSquaredError(yTrue, yPred), Math.sqrt(0.375), 'root mean squared error');
    close(t, meanAbsoluteError(yTrue, yPred), 0.5, 'mean absolute error');
    close(t, medianAbsoluteError(yTrue, yPred), 0.5, 'median absolute error');
    close(t, maxError(yTrue, yPred), 1, 'worst single miss');
    close(t, r2Score(yTrue, yPred), 0.9486081370449679, 'coefficient of determination');
    close(t, explainedVariance(yTrue, yPred), 0.9571734475374732, 'explained variance');
  });

  it('separates squared from absolute error under an outlier', async (t) => {
    const clean = [1, 2, 3, 4];
    const withOutlier = [1, 2, 3, 40];
    const predicted = [1, 2, 3, 4];
    t.equal(meanAbsoluteError(clean, predicted), 0, 'a perfect fit has no error');
    t.ok(
      meanSquaredError(withOutlier, predicted) > 30 * meanAbsoluteError(withOutlier, predicted),
      'squaring lets one outlier dominate',
    );
    t.equal(medianAbsoluteError(withOutlier, predicted), 0, 'the median ignores it entirely');
  });

  it('scores the mean baseline at zero', async (t) => {
    const values = [1, 2, 3, 4, 5];
    const mean = values.map(() => 3);
    close(t, r2Score(values, mean), 0, 'predicting the mean earns R2 of zero');
    t.ok(r2Score(values, [5, 4, 3, 2, 1]) < 0, 'a worse-than-mean fit goes negative');
    t.equal(r2Score([2, 2, 2], [2, 2, 2]), 0, 'zero-variance targets report zero');
  });

  it('separates explained variance from R2 under constant bias', async (t) => {
    const values = [1, 2, 3, 4];
    const biased = values.map((value) => value + 10);
    close(t, explainedVariance(values, biased), 1, 'variance is fully explained');
    t.ok(r2Score(values, biased) < 0, 'but the constant offset destroys R2');
  });

  it('measures relative error', async (t) => {
    close(t, meanAbsolutePercentageError([100, 200], [110, 180]), 0.1, 'mean absolute percentage');
    t.throws(
      () => meanAbsolutePercentageError([0, 1], [1, 1]),
      /is zero/,
      'a zero target is rejected rather than divided by',
    );
    close(t, meanSquaredLogError([3, 5, 2.5, 7], [2.5, 5, 4, 8]), 0.03973012298459379, 'log error');
    t.throws(() => meanSquaredLogError([-2], [1]), /values >= -1/, 'domain is enforced');
  });

  it('correlates two vectors', async (t) => {
    close(t, pearsonCorrelation([1, 2, 3], [2, 4, 6]), 1, 'a linear relation correlates fully');
    close(t, pearsonCorrelation([1, 2, 3], [6, 4, 2]), -1, 'inverted is -1');
    t.equal(pearsonCorrelation([1, 1, 1], [1, 2, 3]), 0, 'a constant input reports zero');
  });

  it('rejects non-finite values', async (t) => {
    t.throws(() => meanSquaredError([1, NaN], [1, 1]), /finite number/, 'NaN throws');
    t.throws(() => meanSquaredError([1, Infinity], [1, 1]), /finite number/, 'Infinity throws');
  });
});

describe('ranking metrics', () => {
  it('scores the top k of a ranked list', async (t) => {
    const relevance = [1, 0, 1, 0];
    t.equal(precisionAtK(relevance, 2), 0.5, 'one of the top two is relevant');
    t.equal(recallAtK(relevance, 2), 0.5, 'one of the two relevant items is in the top two');
    t.equal(recallAtK(relevance, 2, { totalRelevant: 4 }), 0.25, 'a larger pool lowers recall');
    t.equal(hitRateAtK(relevance, 1), 1, 'the top result is relevant');
    t.equal(hitRateAtK([0, 0, 1], 2), 0, 'nothing relevant in the top two');
  });

  it('keeps k in the denominator for short lists', async (t) => {
    t.equal(precisionAtK([1], 4), 0.25, 'a short list is not flattered');
  });

  it('rewards ranking relevant results early', async (t) => {
    t.equal(reciprocalRank([0, 1, 1]), 0.5, 'first hit at rank two');
    t.equal(reciprocalRank([0, 0]), 0, 'no hit at all');
    t.equal(
      meanReciprocalRank([
        [0, 1],
        [1, 0],
      ]),
      0.75,
      'averaged across queries',
    );
    t.ok(
      averagePrecisionAtK([1, 0, 1, 0], 4) > averagePrecisionAtK([0, 1, 0, 1], 4),
      'earlier hits score higher at equal precision',
    );
    close(t, averagePrecisionAtK([1, 0, 1, 0], 4), 5 / 6, 'known average precision');
    t.equal(
      meanAveragePrecisionAtK(
        [
          [1, 0],
          [0, 1],
        ],
        2,
      ),
      0.75,
      'averaged across queries',
    );
  });

  it('discounts gains by rank', async (t) => {
    close(t, dcgAtK([3, 2, 3, 0], 4), 3 + 2 / Math.log2(3) + 3 / 2, 'log2 rank discount');
    close(t, ndcgAtK([3, 2, 3, 0], 4), 0.9777813616305049, 'normalized against the ideal order');
    t.equal(ndcgAtK([3, 2, 1], 3), 1, 'an already-ideal ranking scores 1');
    t.equal(ndcgAtK([0, 0, 0], 3), 0, 'no achievable gain reports zero');
    t.ok(
      dcgAtK([3, 0], 2, { gain: 'exponential' }) > dcgAtK([3, 0], 2, { gain: 'linear' }),
      'exponential gain widens the grade spread',
    );
  });

  it('normalizes against a supplied ideal ranking', async (t) => {
    t.ok(
      ndcgAtK([1, 1], 2, { idealGains: [3, 3, 1, 1] }) < 1,
      'a truncated result list cannot reach the full ideal',
    );
  });

  it('aligns ranked ids against a relevant set', async (t) => {
    t.deepEqual(rankedRelevance(['d3', 'd7', 'd1'], ['d1', 'd3']), [1, 0, 1], 'set membership');
    t.deepEqual(rankedRelevance([1, 2], new Set([2])), [0, 1], 'a Set works directly');
  });

  it('validates k', async (t) => {
    t.throws(() => precisionAtK([1, 0], 0), /positive integer/, 'k must be at least one');
    t.throws(() => precisionAtK([1, 0], 1.5), /positive integer/, 'k must be an integer');
  });
});

describe('calibration metrics', () => {
  it('scores probabilistic predictions', async (t) => {
    close(t, brierScore([1, 0, 1], [0.9, 0.1, 0.8]), 0.02, 'known Brier score');
    close(t, brierScore([1, 1], [1, 1]), 0, 'certainty that pays off costs nothing');
    close(t, brierScore([1, 1], [0, 0]), 1, 'certainty that fails costs the maximum');
    close(t, brierScore([1, 0], [0.5, 0.5]), 0.25, 'hedging always costs 0.25');
  });

  it('bins predictions against observed frequencies', async (t) => {
    const bins = calibrationCurve([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9], { bins: 2 });
    t.equal(bins.length, 2, 'two populated bins');
    t.deepEqual(
      bins.map((bin) => bin.fractionPositive),
      [0, 1],
      'the low bin never fires and the high bin always does',
    );
    close(t, bins[0]!.meanPredicted, 0.15, 'mean predicted probability of the low bin');
    t.equal(bins[0]!.count, 2, 'bin counts');
  });

  it('omits empty bins', async (t) => {
    const bins = calibrationCurve([0, 1], [0.05, 0.95], { bins: 10 });
    t.equal(bins.length, 2, 'only the two populated bins are reported');
  });

  it('detects overconfidence', async (t) => {
    const labels = [1, 0, 1, 0, 1, 0, 1, 0];
    const honest = labels.map(() => 0.5);
    const overconfident = labels.map(() => 0.95);
    close(
      t,
      expectedCalibrationError(labels, honest, { bins: 5 }),
      0,
      'a fair coin call is calibrated',
    );
    t.ok(
      expectedCalibrationError(labels, overconfident, { bins: 5 }) > 0.4,
      'claiming 95% on a coin flip is badly calibrated',
    );
    t.ok(
      maximumCalibrationError(labels, overconfident, { bins: 5 }) >=
        expectedCalibrationError(labels, overconfident, { bins: 5 }),
      'the worst bin is at least the weighted average',
    );
  });

  it('splits bins by quantile when predictions cluster', async (t) => {
    const probabilities = [0.80, 0.81, 0.82, 0.83];
    const uniform = calibrationCurve([0, 1, 0, 1], probabilities, { bins: 4 });
    const quantile = calibrationCurve([0, 1, 0, 1], probabilities, {
      bins: 4,
      strategy: 'quantile',
    });
    t.equal(uniform.length, 1, 'uniform bins collapse clustered predictions into one');
    t.ok(quantile.length > uniform.length, 'quantile bins spread them out');
  });

  it('validates probabilities and bin counts', async (t) => {
    t.throws(() => brierScore([1, 0], [0.5, 2]), /probability in \[0, 1\]/, 'range is enforced');
    t.throws(
      () => calibrationCurve([1, 0], [0.5, 0.5], { bins: 0 }),
      /positive integer/,
      'bins must be positive',
    );
  });
});

describe('vector similarity', () => {
  it('measures direction, not magnitude', async (t) => {
    t.equal(cosineSimilarity([1, 0], [1, 0]), 1, 'identical direction');
    t.equal(cosineSimilarity([1, 0], [0, 1]), 0, 'orthogonal');
    t.equal(cosineSimilarity([1, 0], [-1, 0]), -1, 'opposite');
    close(t, cosineSimilarity([1, 1], [10, 10]), 1, 'scaling does not change the angle');
    t.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'a zero vector has no direction');
    close(t, cosineDistance([1, 0], [0, 1]), 1, 'distance is one minus similarity');
  });

  it('computes the standard distances', async (t) => {
    t.equal(dotProduct([1, 2, 3], [4, 5, 6]), 32, 'dot product');
    t.equal(euclideanDistance([0, 0], [3, 4]), 5, 'euclidean distance');
    t.equal(manhattanDistance([0, 0], [3, 4]), 7, 'manhattan distance');
    t.equal(l2Norm([3, 4]), 5, 'vector length');
  });

  it('rejects mismatched and non-finite vectors', async (t) => {
    t.throws(() => cosineSimilarity([1, 2], [1]), /same length/, 'dimension mismatch throws');
    t.throws(() => cosineSimilarity([1, NaN], [1, 1]), /finite numbers/, 'NaN throws');
  });
});

describe('streaming metrics', () => {
  it('accumulates a mean without holding the values', async (t) => {
    const mean = new StreamingMean();
    t.equal(mean.value(), 0, 'an empty accumulator reports zero');
    mean.updateAll([1, 2, 3]);
    mean.update(4);
    t.equal(mean.value(), 2.5, 'mean of everything seen');
    t.equal(mean.count, 4, 'count tracks observations');
    mean.reset();
    t.equal(mean.count, 0, 'reset clears state');
  });

  it('keeps precision when small values follow a large total', async (t) => {
    const mean = new StreamingMean();
    mean.update(1e16);
    for (let i = 0; i < 1000; i++) mean.update(1);
    close(t, mean.value() * 1001, 1e16 + 1000, 'compensated summation keeps the small terms');
  });

  it('computes variance in one pass and merges shards', async (t) => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const all = new StreamingVariance();
    all.updateAll(values);
    t.equal(all.mean(), 5, 'mean');
    t.equal(all.variance(), 4, 'population variance');
    t.equal(all.standardDeviation(), 2, 'standard deviation');
    close(t, all.sampleVariance(), 32 / 7, 'sample variance applies Bessel correction');

    const left = new StreamingVariance();
    left.updateAll(values.slice(0, 3));
    const right = new StreamingVariance();
    right.updateAll(values.slice(3));
    const merged = left.merge(right);
    close(t, merged.mean(), all.mean(), 'merged mean matches the single pass');
    close(t, merged.variance(), all.variance(), 'merged variance matches the single pass');
  });

  it('tracks accuracy incrementally', async (t) => {
    const running = new StreamingAccuracy();
    running.updateAll([1, 0, 1], [1, 0, 0]);
    close(t, running.value(), 2 / 3, 'two of three correct');
    const other = new StreamingAccuracy();
    other.updateAll([1], [1]);
    close(t, running.merge(other).value(), 0.75, 'merging pools both shards');
    t.equal(running.count, 3, 'merge leaves the operands alone');
  });

  it('builds a confusion matrix from batches', async (t) => {
    const running = new StreamingConfusionMatrix();
    t.throws(() => running.value(), /no observations yet/, 'reporting too early throws');
    running.updateAll(['a', 'b'], ['a', 'a']);
    running.updateAll(['b'], ['b']);
    close(t, running.value().accuracy(), 2 / 3, 'accuracy across batches');
    t.deepEqual([...running.value().labels], ['a', 'b'], 'labels grow as classes appear');
    t.equal(running.count, 3, 'count tracks observations');
  });

  it('reports zero-support classes when the labels are fixed up front', async (t) => {
    const running = new StreamingConfusionMatrix(['a', 'b', 'c']);
    running.updateAll(['a'], ['a']);
    t.deepEqual([...running.value().labels], ['a', 'b', 'c'], 'the universe is preserved');
    t.throws(() => running.update('z', 'a'), /unknown true label/, 'a new class is an error');
  });

  it('matches the batch metrics it replaces', async (t) => {
    const yTrue = [1, 0, 1, 1, 0, 1, 0, 0];
    const yPred = [1, 0, 0, 1, 1, 1, 0, 0];
    const running = new StreamingConfusionMatrix();
    running.updateAll(yTrue.slice(0, 3), yPred.slice(0, 3));
    running.updateAll(yTrue.slice(3), yPred.slice(3));
    close(t, running.value().accuracy(), accuracy(yTrue, yPred), 'accuracy agrees');
    close(t, running.value().f1(1), f1Score(yTrue, yPred), 'F1 agrees');
    close(
      t,
      running.value().macroF1(),
      f1Score(yTrue, yPred, { average: 'macro' }),
      'macro agrees',
    );
  });

  it('summarizes regression error in one pass', async (t) => {
    const yTrue = [3, -0.5, 2, 7];
    const yPred = [2.5, 0, 2, 8];
    const running = new StreamingRegression();
    running.updateAll(yTrue, yPred);
    const summary = running.value();
    close(t, summary.meanSquaredError, meanSquaredError(yTrue, yPred), 'MSE agrees with batch');
    close(t, summary.rootMeanSquaredError, rootMeanSquaredError(yTrue, yPred), 'RMSE agrees');
    close(t, summary.meanAbsoluteError, meanAbsoluteError(yTrue, yPred), 'MAE agrees');
    close(t, summary.r2, r2Score(yTrue, yPred), 'R2 agrees without a second pass');
  });

  it('merges regression shards', async (t) => {
    const yTrue = [3, -0.5, 2, 7, 1, 4];
    const yPred = [2.5, 0, 2, 8, 1.5, 3];
    const left = new StreamingRegression();
    left.updateAll(yTrue.slice(0, 2), yPred.slice(0, 2));
    const right = new StreamingRegression();
    right.updateAll(yTrue.slice(2), yPred.slice(2));
    const merged = left.merge(right).value();
    close(t, merged.meanSquaredError, meanSquaredError(yTrue, yPred), 'merged MSE');
    close(t, merged.meanAbsoluteError, meanAbsoluteError(yTrue, yPred), 'merged MAE');
    close(t, merged.r2, r2Score(yTrue, yPred), 'merged R2');
  });

  it('rejects mismatched batches', async (t) => {
    const running = new StreamingAccuracy();
    t.throws(() => running.updateAll([1, 0], [1]), /same length/, 'length mismatch throws');
  });
});
