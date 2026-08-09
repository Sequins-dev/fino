/**
 * Benchmarks for fino:ml/metrics
 *
 * Run with: cargo run -- bench benchmarks/ml/metrics.bench.ts
 */
import {
  accuracy,
  averagePrecision,
  calibrationCurve,
  ConfusionMatrix,
  cosineSimilarity,
  expectedCalibrationError,
  f1Score,
  logLoss,
  meanSquaredError,
  ndcgAtK,
  precisionRecallCurve,
  r2Score,
  rocAuc,
  rocCurve,
  StreamingAccuracy,
  StreamingConfusionMatrix,
  StreamingRegression,
  StreamingVariance,
} from 'fino:ml/metrics';
import { bench } from 'fino:bench';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function binaryLabels(n: number, seed = 7): number[] {
  const random = seeded(seed);
  return Array.from({ length: n }, () => (random() < 0.3 ? 1 : 0));
}

function noisyScores(labels: number[], seed = 11): number[] {
  const random = seeded(seed);
  return labels.map((label) => Math.min(1, Math.max(0, label * 0.6 + random() * 0.4)));
}

function multiclassLabels(n: number, classes: number, seed = 13): number[] {
  const random = seeded(seed);
  return Array.from({ length: n }, () => Math.floor(random() * classes));
}

function continuous(n: number, seed = 17): number[] {
  const random = seeded(seed);
  return Array.from({ length: n }, () => random() * 100);
}

const SMALL_TRUE = binaryLabels(1e3);
const SMALL_PRED = binaryLabels(1e3, 8);
const LARGE_TRUE = binaryLabels(1e5);
const LARGE_PRED = binaryLabels(1e5, 8);
const LARGE_SCORES = noisyScores(LARGE_TRUE);
const SMALL_SCORES = noisyScores(SMALL_TRUE);

const MULTI_TRUE = multiclassLabels(1e5, 10);
const MULTI_PRED = multiclassLabels(1e5, 10, 14);

const REG_TRUE = continuous(1e5);
const REG_PRED = continuous(1e5, 18);

const GAINS = Array.from({ length: 1000 }, (_unused, i) => (i % 5) as number);

const EMBEDDING_A = continuous(1536, 21);
const EMBEDDING_B = continuous(1536, 22);

bench('classification by size', (b) => {
  b.measure('accuracy — 1K', () => accuracy(SMALL_TRUE, SMALL_PRED));
  b.measure('accuracy — 100K', () => accuracy(LARGE_TRUE, LARGE_PRED));
  b.measure('f1 — 100K binary', () => f1Score(LARGE_TRUE, LARGE_PRED));
  b.measure('f1 macro — 100K × 10 classes', () =>
    f1Score(MULTI_TRUE, MULTI_PRED, { average: 'macro' }),
  );
});

bench('confusion matrix', (b) => {
  b.measure('build — 100K binary', () => ConfusionMatrix.from(LARGE_TRUE, LARGE_PRED));
  b.measure('build — 100K × 10 classes', () => ConfusionMatrix.from(MULTI_TRUE, MULTI_PRED));
  const cm = ConfusionMatrix.from(MULTI_TRUE, MULTI_PRED);
  b.measure('derive full report — 10 classes', () => cm.report());
  b.measure('macro F1 from a built matrix', () => cm.macroF1());
  b.measure('matthews correlation — 10 classes', () => cm.matthewsCorrCoef());
  const other = ConfusionMatrix.from(MULTI_TRUE, MULTI_PRED);
  b.measure('merge two 10-class matrices', () => cm.merge(other));
});

bench('threshold-free scores', (b) => {
  b.measure('rocAuc — 1K', () => rocAuc(SMALL_TRUE, SMALL_SCORES));
  b.measure('rocAuc — 100K', () => rocAuc(LARGE_TRUE, LARGE_SCORES));
  b.measure('rocCurve — 100K', () => rocCurve(LARGE_TRUE, LARGE_SCORES));
  b.measure('precisionRecallCurve — 100K', () => precisionRecallCurve(LARGE_TRUE, LARGE_SCORES));
  b.measure('averagePrecision — 100K', () => averagePrecision(LARGE_TRUE, LARGE_SCORES));
});

bench('probability quality', (b) => {
  b.measure('logLoss — 100K', () => logLoss(LARGE_TRUE, LARGE_SCORES));
  b.measure('calibrationCurve — 100K, 10 uniform bins', () =>
    calibrationCurve(LARGE_TRUE, LARGE_SCORES, { bins: 10 }),
  );
  b.measure('calibrationCurve — 100K, 10 quantile bins', () =>
    calibrationCurve(LARGE_TRUE, LARGE_SCORES, { bins: 10, strategy: 'quantile' }),
  );
  b.measure('expectedCalibrationError — 100K', () =>
    expectedCalibrationError(LARGE_TRUE, LARGE_SCORES, { bins: 10 }),
  );
});

bench('regression', (b) => {
  b.measure('meanSquaredError — 100K', () => meanSquaredError(REG_TRUE, REG_PRED));
  b.measure('r2Score — 100K', () => r2Score(REG_TRUE, REG_PRED));
});

bench('ranking', (b) => {
  b.measure('ndcg@10 — 1K candidates', () => ndcgAtK(GAINS, 10));
  b.measure('ndcg@1000 — 1K candidates', () => ndcgAtK(GAINS, 1000));
});

bench('vector similarity', (b) => {
  b.measure('cosine — 1536 dimensions', () => cosineSimilarity(EMBEDDING_A, EMBEDDING_B));
});

bench('streaming vs batch', (b) => {
  b.measure('batch accuracy — 100K', () => accuracy(LARGE_TRUE, LARGE_PRED));
  b.measure('streaming accuracy — 100K in one batch', () => {
    const running = new StreamingAccuracy();
    running.updateAll(LARGE_TRUE, LARGE_PRED);
    return running.value();
  });
  b.measure('streaming accuracy — 100K in 100 batches', () => {
    const running = new StreamingAccuracy();
    for (let offset = 0; offset < LARGE_TRUE.length; offset += 1000) {
      running.updateAll(
        LARGE_TRUE.slice(offset, offset + 1000),
        LARGE_PRED.slice(offset, offset + 1000),
      );
    }
    return running.value();
  });
  b.measure('streaming regression — 100K', () => {
    const running = new StreamingRegression();
    running.updateAll(REG_TRUE, REG_PRED);
    return running.value();
  });
  b.measure('streaming variance — 100K', () => {
    const running = new StreamingVariance();
    running.updateAll(REG_TRUE);
    return running.value();
  });
});

bench('shard merge', (b) => {
  const shards = Array.from({ length: 8 }, (_unused, i) => {
    const running = new StreamingConfusionMatrix();
    const start = i * 12500;
    running.updateAll(
      MULTI_TRUE.slice(start, start + 12500),
      MULTI_PRED.slice(start, start + 12500),
    );
    return running;
  });
  b.measure('reduce 8 shards — 10 classes', () =>
    shards
      .reduce((a, c) => a.merge(c))
      .value()
      .macroF1(),
  );
});
