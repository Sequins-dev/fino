/**
 * Ranking metrics over a result list ordered best-first.
 *
 * Every function here takes relevance already aligned to rank position: entry
 * `0` is the top result. Use `rankedRelevance` to turn a ranked list of ids
 * and a set of known-relevant ids into that shape.
 */
import {
  MetricError,
  ratio,
  requireFinite,
  requireNonEmpty,
  requirePositiveInteger,
} from './shared.ts';

/**
 * How a graded relevance value converts into a discounted gain.
 *
 * `linear` uses the grade as-is. `exponential` uses `2^grade - 1`, which is
 * the web-search convention and pulls highly relevant results further ahead of
 * merely acceptable ones.
 */
export type GainFunction = 'linear' | 'exponential';

/**
 * Options for the discounted-cumulative-gain family.
 */
export interface GainOptions {
  /**
   * Gain transform applied to each grade. Defaults to `linear`.
   */
  gain?: GainFunction;
}

/**
 * Align a ranked list of ids with a set of relevant ids.
 *
 * ```ts
 * import { rankedRelevance, precisionAtK } from 'fino:ml/metrics';
 *
 * const relevance = rankedRelevance(['d3', 'd7', 'd1'], ['d1', 'd3']);
 * console.log(relevance); // [1, 0, 1]
 * console.log(precisionAtK(relevance, 2)); // 0.5
 * ```
 */
export function rankedRelevance<T>(ranked: ArrayLike<T>, relevant: Iterable<T>): number[] {
  const relevantSet = relevant instanceof Set ? relevant : new Set(relevant);
  const out = new Array<number>(ranked.length);
  for (let i = 0; i < ranked.length; i++) out[i] = relevantSet.has(ranked[i]!) ? 1 : 0;
  return out;
}

/**
 * Fraction of the top `k` results that are relevant.
 *
 * When fewer than `k` results were returned the denominator stays `k`, so a
 * short list is penalized rather than flattered.
 *
 * ```ts
 * import { precisionAtK } from 'fino:ml/metrics';
 *
 * console.log(precisionAtK([1, 0, 1, 0], 2)); // 0.5
 * ```
 */
export function precisionAtK(relevance: ArrayLike<number>, k: number): number {
  checkRelevance(relevance, k);
  let hits = 0;
  for (let i = 0; i < Math.min(k, relevance.length); i++) {
    if (relevance[i]! > 0) hits++;
  }
  return hits / k;
}

/**
 * Fraction of all relevant items that appear in the top `k`.
 *
 * ```ts
 * import { recallAtK } from 'fino:ml/metrics';
 *
 * console.log(recallAtK([1, 0, 1, 0], 2)); // 0.5
 * console.log(recallAtK([1, 0, 1, 0], 2, { totalRelevant: 4 })); // 0.25
 * ```
 */
export function recallAtK(
  relevance: ArrayLike<number>,
  k: number,
  options: {
    /**
     * Number of relevant items in the whole collection. Defaults to the count
     * present in `relevance`, which is only correct when the ranked list
     * covers every relevant item.
     */
    totalRelevant?: number;
  } = {},
): number {
  checkRelevance(relevance, k);
  let retrieved = 0;
  let total = 0;
  for (let i = 0; i < relevance.length; i++) {
    if (relevance[i]! > 0) {
      total++;
      if (i < k) retrieved++;
    }
  }
  const denominator = options.totalRelevant ?? total;
  if (denominator < 0) throw new MetricError(`totalRelevant must not be negative`);
  return ratio(retrieved, denominator);
}

/**
 * Whether any relevant item made the top `k`, as `1` or `0`.
 *
 * Averaged over queries this is the "did we show them anything useful at all"
 * rate, which is often the metric a product actually cares about.
 *
 * ```ts
 * import { hitRateAtK } from 'fino:ml/metrics';
 *
 * console.log(hitRateAtK([0, 0, 1], 2)); // 0
 * ```
 */
export function hitRateAtK(relevance: ArrayLike<number>, k: number): number {
  checkRelevance(relevance, k);
  for (let i = 0; i < Math.min(k, relevance.length); i++) {
    if (relevance[i]! > 0) return 1;
  }
  return 0;
}

/**
 * Reciprocal of the rank of the first relevant result, or `0` if there is none.
 *
 * ```ts
 * import { reciprocalRank } from 'fino:ml/metrics';
 *
 * console.log(reciprocalRank([0, 1, 1])); // 0.5
 * ```
 */
export function reciprocalRank(relevance: ArrayLike<number>): number {
  requireNonEmpty(relevance, 'relevance');
  for (let i = 0; i < relevance.length; i++) {
    if (relevance[i]! > 0) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Mean reciprocal rank across queries.
 *
 * ```ts
 * import { meanReciprocalRank } from 'fino:ml/metrics';
 *
 * console.log(meanReciprocalRank([[0, 1], [1, 0]])); // 0.75
 * ```
 */
export function meanReciprocalRank(relevances: ReadonlyArray<ArrayLike<number>>): number {
  requireNonEmpty(relevances, 'relevances');
  let total = 0;
  for (const relevance of relevances) total += reciprocalRank(relevance);
  return total / relevances.length;
}

/**
 * Discounted cumulative gain over the top `k`.
 *
 * Each grade is discounted by `log2(rank + 1)`, so a relevant result found at
 * position 1 is worth more than the same result at position 10.
 *
 * ```ts
 * import { dcgAtK } from 'fino:ml/metrics';
 *
 * console.log(dcgAtK([3, 2, 3, 0], 4).toFixed(4)); // 5.7619
 * ```
 */
export function dcgAtK(gains: ArrayLike<number>, k: number, options: GainOptions = {}): number {
  checkRelevance(gains, k);
  const transform = gainTransform(options.gain ?? 'linear');
  let total = 0;
  for (let i = 0; i < Math.min(k, gains.length); i++) {
    total += transform(gains[i]!) / Math.log2(i + 2);
  }
  return total;
}

/**
 * Discounted cumulative gain normalized by the best achievable ordering.
 *
 * The result is in `[0, 1]` regardless of how many results a query has or how
 * generous its grades are, which is what makes it comparable across queries.
 * Reports `0` when no ordering could score above zero.
 *
 * ```ts
 * import { ndcgAtK } from 'fino:ml/metrics';
 *
 * console.log(ndcgAtK([3, 2, 3, 0], 4).toFixed(4)); // 0.9778
 * ```
 */
export function ndcgAtK(
  gains: ArrayLike<number>,
  k: number,
  options: GainOptions & {
    /**
     * Grades of the ideal ranking, when the ranked list does not contain every
     * relevant item. Defaults to `gains` sorted descending.
     */
    idealGains?: ArrayLike<number>;
  } = {},
): number {
  const actual = dcgAtK(gains, k, options);
  const source = options.idealGains ?? gains;
  const ideal = Array.from({ length: source.length }, (_unused, i) => source[i]!).sort(
    (a, b) => b - a,
  );
  return ratio(actual, dcgAtK(ideal, k, options));
}

/**
 * Average precision over the top `k`: precision measured at every hit.
 *
 * Rewards putting relevant results early rather than merely including them,
 * which `precisionAtK` alone cannot distinguish.
 *
 * ```ts
 * import { averagePrecisionAtK } from 'fino:ml/metrics';
 *
 * console.log(averagePrecisionAtK([1, 0, 1, 0], 4)); // 0.8333333333333333
 * ```
 */
export function averagePrecisionAtK(
  relevance: ArrayLike<number>,
  k: number,
  options: {
    /**
     * Number of relevant items in the whole collection, used as the divisor.
     * Defaults to the number of relevant items within the top `k`.
     */
    totalRelevant?: number;
  } = {},
): number {
  checkRelevance(relevance, k);
  const limit = Math.min(k, relevance.length);
  let hits = 0;
  let total = 0;
  for (let i = 0; i < limit; i++) {
    if (relevance[i]! > 0) {
      hits++;
      total += hits / (i + 1);
    }
  }
  return ratio(total, options.totalRelevant ?? hits);
}

/**
 * Mean average precision across queries.
 *
 * ```ts
 * import { meanAveragePrecisionAtK } from 'fino:ml/metrics';
 *
 * console.log(meanAveragePrecisionAtK([[1, 0], [0, 1]], 2)); // 0.75
 * ```
 */
export function meanAveragePrecisionAtK(
  relevances: ReadonlyArray<ArrayLike<number>>,
  k: number,
): number {
  requireNonEmpty(relevances, 'relevances');
  let total = 0;
  for (const relevance of relevances) total += averagePrecisionAtK(relevance, k);
  return total / relevances.length;
}

function gainTransform(gain: GainFunction): (grade: number) => number {
  if (gain === 'linear') return (grade) => grade;
  if (gain === 'exponential') return (grade) => Math.pow(2, grade) - 1;
  throw new MetricError(`unknown gain function ${JSON.stringify(gain)}`);
}

function checkRelevance(relevance: ArrayLike<number>, k: number): void {
  requireNonEmpty(relevance, 'relevance');
  requireFinite(relevance, 'relevance');
  requirePositiveInteger(k, 'k');
}
