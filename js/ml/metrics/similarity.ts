/**
 * Vector similarity and distance, shared by embedding consumers.
 */
import { MetricError, requireNonEmpty, requireSameLength } from './shared.ts';

/**
 * Cosine of the angle between two vectors, in `[-1, 1]`.
 *
 * Measures direction only, so vector magnitude is irrelevant — which is what
 * makes it the right default for comparing embeddings. Reports `0` when
 * either vector is all zeros and the angle is undefined.
 *
 * ```ts
 * import { cosineSimilarity } from 'fino:ml/metrics';
 *
 * console.log(cosineSimilarity([1, 0], [1, 0])); // 1
 * console.log(cosineSimilarity([1, 0], [0, 1])); // 0
 * console.log(cosineSimilarity([1, 0], [-1, 0])); // -1
 * ```
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  checkVectors(a, b);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

/**
 * Cosine distance, `1 - cosineSimilarity`.
 *
 * ```ts
 * import { cosineDistance } from 'fino:ml/metrics';
 *
 * console.log(cosineDistance([1, 0], [0, 1])); // 1
 * ```
 */
export function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Sum of elementwise products.
 *
 * ```ts
 * import { dotProduct } from 'fino:ml/metrics';
 *
 * console.log(dotProduct([1, 2, 3], [4, 5, 6])); // 32
 * ```
 */
export function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>): number {
  checkVectors(a, b);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i]! * b[i]!;
  return total;
}

/**
 * Straight-line distance between two vectors.
 *
 * ```ts
 * import { euclideanDistance } from 'fino:ml/metrics';
 *
 * console.log(euclideanDistance([0, 0], [3, 4])); // 5
 * ```
 */
export function euclideanDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  checkVectors(a, b);
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = a[i]! - b[i]!;
    total += delta * delta;
  }
  return Math.sqrt(total);
}

/**
 * Sum of absolute differences between two vectors.
 *
 * ```ts
 * import { manhattanDistance } from 'fino:ml/metrics';
 *
 * console.log(manhattanDistance([0, 0], [3, 4])); // 7
 * ```
 */
export function manhattanDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  checkVectors(a, b);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - b[i]!);
  return total;
}

/**
 * Euclidean length of a vector.
 *
 * ```ts
 * import { l2Norm } from 'fino:ml/metrics';
 *
 * console.log(l2Norm([3, 4])); // 5
 * ```
 */
export function l2Norm(vector: ArrayLike<number>): number {
  requireNonEmpty(vector, 'vector');
  let total = 0;
  for (let i = 0; i < vector.length; i++) total += vector[i]! * vector[i]!;
  return Math.sqrt(total);
}

function checkVectors(a: ArrayLike<number>, b: ArrayLike<number>): void {
  requireSameLength(a, b, 'a', 'b');
  requireNonEmpty(a, 'a');
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]!) || !Number.isFinite(b[i]!)) {
      throw new MetricError(`vectors must contain only finite numbers (index ${i})`);
    }
  }
}
