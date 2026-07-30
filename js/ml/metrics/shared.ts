/**
 * Shared validation, ordering, and summation helpers for `fino:ml/metrics`.
 */

/**
 * A class label. Metrics compare labels by value, so any primitive works.
 */
export type Label = string | number | boolean;

/**
 * Error thrown when metric inputs are malformed.
 *
 * Covers length mismatches, empty inputs, non-finite values, probabilities
 * outside `[0, 1]`, unknown labels, and averaging modes that cannot be
 * resolved from the data.
 */
export class MetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricError';
  }
}

export function requireSameLength(
  a: ArrayLike<unknown>,
  b: ArrayLike<unknown>,
  aName: string,
  bName: string,
): void {
  if (a.length !== b.length) {
    throw new MetricError(
      `${aName} and ${bName} must have the same length (got ${a.length} and ${b.length})`,
    );
  }
}

export function requireNonEmpty(values: ArrayLike<unknown>, name: string): void {
  if (values.length === 0) throw new MetricError(`${name} must not be empty`);
}

export function requireFinite(values: ArrayLike<number>, name: string): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value)) {
      throw new MetricError(`${name}[${i}] must be a finite number (got ${value})`);
    }
  }
}

export function requireProbabilities(values: ArrayLike<number>, name: string): void {
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new MetricError(`${name}[${i}] must be a probability in [0, 1] (got ${value})`);
    }
  }
}

export function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new MetricError(`${name} must be a positive integer (got ${value})`);
  }
}

/**
 * Total ordering over labels: numbers numerically, booleans false-first,
 * strings lexicographically, and mixed types grouped by type name so the
 * ordering stays stable regardless of insertion order.
 */
export function compareLabels(a: Label, b: Label): number {
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === 'number') return (a as number) - (b as number);
  if (ta === 'boolean') return Number(a) - Number(b);
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

export function sortedLabelUnion(...sources: ReadonlyArray<ArrayLike<Label>>): Label[] {
  const seen = new Set<Label>();
  for (const source of sources) {
    for (let i = 0; i < source.length; i++) seen.add(source[i]!);
  }
  return [...seen].sort(compareLabels);
}

/**
 * Resolve which label counts as positive for a binary metric.
 *
 * An explicit choice always wins. Otherwise `{0, 1}` resolves to `1` and
 * `{false, true}` to `true`; anything else is ambiguous and must be stated.
 */
export function resolvePositiveLabel(labels: readonly Label[], explicit?: Label): Label {
  if (explicit !== undefined) {
    if (!labels.includes(explicit)) {
      throw new MetricError(
        `positiveLabel ${JSON.stringify(explicit)} does not appear in the data (labels: ${formatLabels(labels)})`,
      );
    }
    return explicit;
  }
  if (labels.length > 2) {
    throw new MetricError(
      `binary averaging needs at most two labels, got ${labels.length} (${formatLabels(labels)}); pass average or positiveLabel`,
    );
  }
  const asSet = new Set(labels);
  if (asSet.has(1)) return 1;
  if (asSet.has(true)) return true;
  throw new MetricError(
    `cannot infer the positive label from ${formatLabels(labels)}; pass positiveLabel explicitly`,
  );
}

/**
 * Resolve the positive label for a probability- or score-based metric.
 *
 * Unlike `resolvePositiveLabel` this does not require the positive class to
 * actually appear: a batch can legitimately be all negatives, and refusing to
 * score it would make streaming evaluation fail on unlucky shard boundaries.
 */
export function resolveScoreLabel(labels: readonly Label[], explicit?: Label): Label {
  if (explicit !== undefined) return explicit;
  if (labels.length > 2) {
    throw new MetricError(
      `score metrics are binary, got ${labels.length} labels (${formatLabels(labels)}); pass positiveLabel`,
    );
  }
  if (labels.every((label) => label === 0 || label === 1)) return 1;
  if (labels.every((label) => label === false || label === true)) return true;
  throw new MetricError(
    `cannot infer the positive label from ${formatLabels(labels)}; pass positiveLabel explicitly`,
  );
}

export function formatLabels(labels: readonly Label[]): string {
  return labels.map((label) => JSON.stringify(label)).join(', ');
}

/**
 * `numerator / denominator`, or `0` when the denominator is zero.
 *
 * Undefined metric values are reported as zero throughout this module rather
 * than as `NaN`, matching the convention established by scikit-learn.
 */
export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Neumaier compensated summation.
 *
 * Streaming metrics accumulate over arbitrarily many batches, where naive
 * addition drifts once the running total dwarfs individual terms.
 */
export class CompensatedSum {
  #sum = 0;
  #compensation = 0;

  add(value: number): void {
    const next = this.#sum + value;
    this.#compensation +=
      Math.abs(this.#sum) >= Math.abs(value) ? this.#sum - next + value : value - next + this.#sum;
    this.#sum = next;
  }

  get value(): number {
    return this.#sum + this.#compensation;
  }

  reset(): void {
    this.#sum = 0;
    this.#compensation = 0;
  }
}

/**
 * Ranks values best-first, breaking ties by original position so that equal
 * scores keep input order and every derived curve is deterministic.
 */
export function descendingOrder(scores: ArrayLike<number>): number[] {
  const order = Array.from({ length: scores.length }, (_unused, i) => i);
  order.sort((a, b) => {
    const diff = scores[b]! - scores[a]!;
    return diff !== 0 ? diff : a - b;
  });
  return order;
}
